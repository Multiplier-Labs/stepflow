/**
 * Socket.IO Event Transport
 *
 * Broadcasts workflow events to connected clients via Socket.IO.
 * Clients can subscribe to specific run IDs or receive all events.
 */

import type { EventTransport, EventCallback, Unsubscribe, WorkflowEvent } from './types';
import type { Logger } from '../core/types';

/**
 * Minimal Socket.IO Server interface.
 * This allows using the adapter without a direct dependency on socket.io.
 */
export interface SocketIOServer {
  to(room: string): {
    emit(event: string, ...args: unknown[]): void;
  };
  emit(event: string, ...args: unknown[]): void;
}

/**
 * Minimal Socket.IO Socket interface.
 */
export interface SocketIOSocket {
  join(room: string): void;
  leave(room: string): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
}

/**
 * Authorization callback for Socket.IO run subscriptions.
 * Return true to allow the subscription, false to deny it.
 */
export type SocketIOAuthorizeFn = (
  runId: string,
  socket: SocketIOSocket
) => boolean | Promise<boolean>;

/**
 * Configuration for SocketIOEventTransport.
 */
export interface SocketIOEventTransportConfig {
  /** Socket.IO server instance */
  io: SocketIOServer;

  /** Event name to use for workflow events (default: 'workflow:event') */
  eventName?: string;

  /** Room prefix for run-specific subscriptions (default: 'run:') */
  roomPrefix?: string;

  /** Whether to also broadcast to a global room (default: true) */
  broadcastGlobal?: boolean;

  /** Global room name (default: 'workflow:all') */
  globalRoom?: string;

  /** Logger for transport errors (default: console-based) */
  logger?: Logger;
}

/**
 * Socket.IO-based event transport for real-time workflow events.
 *
 * @example
 * ```typescript
 * import { Server } from 'socket.io';
 * import { SocketIOEventTransport } from 'stepflow';
 *
 * const io = new Server(httpServer);
 * const eventTransport = new SocketIOEventTransport({ io });
 *
 * const engine = new WorkflowEngine({
 *   storage,
 *   events: eventTransport,
 * });
 *
 * // Client-side:
 * // socket.emit('workflow:subscribe', runId);
 * // socket.on('workflow:event', (event) => console.log(event));
 * ```
 */
export class SocketIOEventTransport implements EventTransport {
  private io: SocketIOServer;
  private eventName: string;
  private roomPrefix: string;
  private broadcastGlobal: boolean;
  private globalRoom: string;
  private logger: Logger;

  // Local subscribers for server-side subscriptions
  private runSubscribers = new Map<string, Set<EventCallback>>();
  private globalSubscribers = new Set<EventCallback>();

  constructor(config: SocketIOEventTransportConfig) {
    this.io = config.io;
    this.eventName = config.eventName ?? 'workflow:event';
    this.roomPrefix = config.roomPrefix ?? 'run:';
    this.broadcastGlobal = config.broadcastGlobal ?? true;
    this.globalRoom = config.globalRoom ?? 'workflow:all';
    this.logger = config.logger ?? {
      debug() {},
      info() {},
      warn() {},
      error(message: string, ...args: unknown[]) { console.error(message, ...args); },
    };
  }

  /**
   * Emit an event to Socket.IO clients and local subscribers.
   */
  emit(event: WorkflowEvent): void {
    // Serialize the event (convert Date to ISO string for transport)
    const serializedEvent = {
      ...event,
      timestamp: event.timestamp.toISOString(),
    };

    // Emit to run-specific room
    const room = `${this.roomPrefix}${event.runId}`;
    this.io.to(room).emit(this.eventName, serializedEvent);

    // Emit to global room
    if (this.broadcastGlobal) {
      this.io.to(this.globalRoom).emit(this.eventName, serializedEvent);
    }

    // Notify local subscribers
    const runSubs = this.runSubscribers.get(event.runId);
    if (runSubs) {
      for (const callback of runSubs) {
        try {
          callback(event);
        } catch (error) {
          this.logger.error('Event callback error:', error);
        }
      }
    }

    for (const callback of this.globalSubscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error('Event callback error:', error);
      }
    }
  }

  /**
   * Subscribe to events for a specific run (server-side).
   */
  subscribe(runId: string, callback: EventCallback): Unsubscribe {
    let subs = this.runSubscribers.get(runId);
    if (!subs) {
      subs = new Set();
      this.runSubscribers.set(runId, subs);
    }
    subs.add(callback);

    return () => {
      subs!.delete(callback);
      if (subs!.size === 0) {
        this.runSubscribers.delete(runId);
      }
    };
  }

  /**
   * Subscribe to all events (server-side).
   */
  subscribeAll(callback: EventCallback): Unsubscribe {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  /**
   * Set up client subscription handlers on a socket.
   * Call this when a client connects to enable subscription commands.
   *
   * **Security note:** Without an `authorize` callback, any connected client can
   * subscribe to any run's events. Always provide authorization in production.
   *
   * @param socket - The Socket.IO socket to set up handlers on
   * @param authorize - Optional callback to check if a socket can access a run.
   *   If omitted, all subscriptions are allowed (open access).
   *
   * @example
   * ```typescript
   * io.on('connection', (socket) => {
   *   eventTransport.setupClientHandlers(socket, async (runId, sock) => {
   *     // Check if the authenticated user owns this run
   *     const userId = sock.data?.userId;
   *     return userId ? await canUserAccessRun(userId, runId) : false;
   *   });
   * });
   * ```
   */
  setupClientHandlers(
    socket: SocketIOSocket,
    authorize?: SocketIOAuthorizeFn
  ): void {
    // Subscribe to a specific run
    socket.on('workflow:subscribe', async (...args: unknown[]) => {
      const runId = args[0];
      if (typeof runId !== 'string') return;

      if (authorize) {
        try {
          const allowed = await authorize(runId, socket);
          if (!allowed) {
            this.logger.warn(`Subscription denied for run ${runId}`);
            return;
          }
        } catch (error) {
          this.logger.error('Authorization check failed:', error);
          return;
        }
      }

      socket.join(`${this.roomPrefix}${runId}`);
    });

    // Unsubscribe from a specific run
    socket.on('workflow:unsubscribe', (...args: unknown[]) => {
      const runId = args[0];
      if (typeof runId === 'string') {
        socket.leave(`${this.roomPrefix}${runId}`);
      }
    });

    // Subscribe to all events (requires authorization to pass with '*' as runId)
    socket.on('workflow:subscribe:all', async () => {
      if (authorize) {
        try {
          const allowed = await authorize('*', socket);
          if (!allowed) {
            this.logger.warn('Global subscription denied');
            return;
          }
        } catch (error) {
          this.logger.error('Authorization check failed:', error);
          return;
        }
      }

      socket.join(this.globalRoom);
    });

    // Unsubscribe from all events
    socket.on('workflow:unsubscribe:all', () => {
      socket.leave(this.globalRoom);
    });
  }

  /**
   * Close the transport (no-op for Socket.IO, managed externally).
   */
  close(): void {
    this.runSubscribers.clear();
    this.globalSubscribers.clear();
  }
}
