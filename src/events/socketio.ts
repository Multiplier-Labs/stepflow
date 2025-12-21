/**
 * Socket.IO Event Transport
 *
 * Broadcasts workflow events to connected clients via Socket.IO.
 * Clients can subscribe to specific run IDs or receive all events.
 */

import type { EventTransport, EventCallback, Unsubscribe, WorkflowEvent } from './types';

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

  // Local subscribers for server-side subscriptions
  private runSubscribers = new Map<string, Set<EventCallback>>();
  private globalSubscribers = new Set<EventCallback>();

  constructor(config: SocketIOEventTransportConfig) {
    this.io = config.io;
    this.eventName = config.eventName ?? 'workflow:event';
    this.roomPrefix = config.roomPrefix ?? 'run:';
    this.broadcastGlobal = config.broadcastGlobal ?? true;
    this.globalRoom = config.globalRoom ?? 'workflow:all';
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
          console.error('Event callback error:', error);
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
   * @example
   * ```typescript
   * io.on('connection', (socket) => {
   *   eventTransport.setupClientHandlers(socket);
   * });
   * ```
   */
  setupClientHandlers(socket: SocketIOSocket): void {
    // Subscribe to a specific run
    socket.on('workflow:subscribe', (...args: unknown[]) => {
      const runId = args[0];
      if (typeof runId === 'string') {
        socket.join(`${this.roomPrefix}${runId}`);
      }
    });

    // Unsubscribe from a specific run
    socket.on('workflow:unsubscribe', (...args: unknown[]) => {
      const runId = args[0];
      if (typeof runId === 'string') {
        socket.leave(`${this.roomPrefix}${runId}`);
      }
    });

    // Subscribe to all events
    socket.on('workflow:subscribe:all', () => {
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
