import { a as WorkflowKind } from '../types-V-4dhiZA.js';

/**
 * Event system types for the workflow engine.
 */

/**
 * Built-in event types emitted by the workflow engine.
 */
type BuiltInEventType = 'run.created' | 'run.queued' | 'run.dequeued' | 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed' | 'run.canceled' | 'run.timeout' | 'step.started' | 'step.completed' | 'step.failed' | 'step.skipped' | 'step.retry';
/**
 * Event types emitted by the workflow engine.
 * Includes built-in types and allows custom events via string.
 */
type WorkflowEventType = BuiltInEventType | (string & {});
/**
 * Workflow event payload structure.
 */
interface WorkflowEvent {
    /** Unique run identifier */
    runId: string;
    /** Workflow type */
    kind: WorkflowKind;
    /** Type of event */
    eventType: WorkflowEventType;
    /** Step key (for step-related events) */
    stepKey?: string;
    /** When the event occurred */
    timestamp: Date;
    /** Event-specific data */
    payload?: unknown;
}
/**
 * Callback function for handling workflow events.
 */
type EventCallback = (event: WorkflowEvent) => void;
/**
 * Unsubscribe function returned when subscribing to events.
 */
type Unsubscribe = () => void;
/**
 * Event transport interface.
 * Implement this to customize how events are delivered.
 */
interface EventTransport {
    /**
     * Emit an event to all subscribers.
     */
    emit(event: WorkflowEvent): void;
    /**
     * Subscribe to events for a specific run.
     * @returns Unsubscribe function
     */
    subscribe(runId: string, callback: EventCallback): Unsubscribe;
    /**
     * Subscribe to all events.
     * @returns Unsubscribe function
     */
    subscribeAll(callback: EventCallback): Unsubscribe;
    /**
     * Optional: Filter events by type.
     * @returns Unsubscribe function
     */
    subscribeToType?(eventType: WorkflowEventType, callback: EventCallback): Unsubscribe;
    /**
     * Optional: Persist event for later retrieval.
     */
    persist?(event: WorkflowEvent): Promise<void>;
    /**
     * Optional: Close/cleanup the transport.
     */
    close?(): void;
}

/**
 * In-memory event transport using Node.js EventEmitter.
 * Default transport for development and single-process deployments.
 */

/**
 * In-memory event transport implementation using EventEmitter.
 * Events are emitted to subscribers in the same process.
 */
declare class MemoryEventTransport implements EventTransport {
    private emitter;
    constructor();
    /**
     * Emit an event to all subscribers.
     */
    emit(event: WorkflowEvent): void;
    /**
     * Subscribe to events for a specific run.
     */
    subscribe(runId: string, callback: EventCallback): Unsubscribe;
    /**
     * Subscribe to all events.
     */
    subscribeAll(callback: EventCallback): Unsubscribe;
    /**
     * Subscribe to events of a specific type.
     */
    subscribeToType(eventType: WorkflowEventType, callback: EventCallback): Unsubscribe;
    /**
     * Close the transport and remove all listeners.
     */
    close(): void;
    /**
     * Get the number of listeners for a channel (for testing).
     */
    getListenerCount(channel?: string): number;
}

/**
 * Socket.IO Event Transport
 *
 * Broadcasts workflow events to connected clients via Socket.IO.
 * Clients can subscribe to specific run IDs or receive all events.
 */

/**
 * Minimal Socket.IO Server interface.
 * This allows using the adapter without a direct dependency on socket.io.
 */
interface SocketIOServer {
    to(room: string): {
        emit(event: string, ...args: unknown[]): void;
    };
    emit(event: string, ...args: unknown[]): void;
}
/**
 * Minimal Socket.IO Socket interface.
 */
interface SocketIOSocket {
    join(room: string): void;
    leave(room: string): void;
    on(event: string, callback: (...args: unknown[]) => void): void;
}
/**
 * Configuration for SocketIOEventTransport.
 */
interface SocketIOEventTransportConfig {
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
declare class SocketIOEventTransport implements EventTransport {
    private io;
    private eventName;
    private roomPrefix;
    private broadcastGlobal;
    private globalRoom;
    private runSubscribers;
    private globalSubscribers;
    constructor(config: SocketIOEventTransportConfig);
    /**
     * Emit an event to Socket.IO clients and local subscribers.
     */
    emit(event: WorkflowEvent): void;
    /**
     * Subscribe to events for a specific run (server-side).
     */
    subscribe(runId: string, callback: EventCallback): Unsubscribe;
    /**
     * Subscribe to all events (server-side).
     */
    subscribeAll(callback: EventCallback): Unsubscribe;
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
    setupClientHandlers(socket: SocketIOSocket): void;
    /**
     * Close the transport (no-op for Socket.IO, managed externally).
     */
    close(): void;
}

/**
 * Webhook Event Transport
 *
 * Posts workflow events to HTTP endpoints via webhooks.
 * Supports multiple webhooks with optional filtering by event type.
 */

/**
 * Webhook endpoint configuration.
 */
interface WebhookEndpoint {
    /** Unique identifier for this endpoint */
    id: string;
    /** URL to POST events to */
    url: string;
    /** Optional secret for signing payloads (HMAC-SHA256) */
    secret?: string;
    /** Optional filter for specific event types (empty = all events) */
    eventTypes?: WorkflowEventType[];
    /** Optional filter for specific workflow kinds (empty = all kinds) */
    workflowKinds?: string[];
    /** Optional custom headers to include */
    headers?: Record<string, string>;
    /** Whether this endpoint is enabled (default: true) */
    enabled?: boolean;
    /** Timeout in milliseconds (default: 5000) */
    timeout?: number;
    /** Number of retry attempts on failure (default: 3) */
    retries?: number;
}
/**
 * Configuration for WebhookEventTransport.
 */
interface WebhookEventTransportConfig {
    /** Initial webhook endpoints */
    endpoints?: WebhookEndpoint[];
    /** Default timeout for all webhooks in ms (default: 5000) */
    defaultTimeout?: number;
    /** Default retry attempts (default: 3) */
    defaultRetries?: number;
    /** Retry delay in ms (default: 1000) */
    retryDelay?: number;
    /** Custom fetch function (for testing or custom HTTP clients) */
    fetchFn?: typeof fetch;
}
/**
 * Webhook payload structure.
 */
interface WebhookPayload {
    event: Omit<WorkflowEvent, 'timestamp'> & {
        timestamp: string;
    };
    deliveredAt: string;
    webhookId: string;
}
/**
 * Webhook-based event transport for integrating with external systems.
 *
 * @example
 * ```typescript
 * const webhookTransport = new WebhookEventTransport({
 *   endpoints: [
 *     {
 *       id: 'slack-notifications',
 *       url: 'https://hooks.slack.com/...',
 *       eventTypes: ['run.completed', 'run.failed'],
 *     },
 *     {
 *       id: 'analytics',
 *       url: 'https://api.analytics.com/events',
 *       secret: 'webhook-secret-123',
 *     },
 *   ],
 * });
 *
 * const engine = new WorkflowEngine({
 *   storage,
 *   events: webhookTransport,
 * });
 * ```
 */
declare class WebhookEventTransport implements EventTransport {
    private endpoints;
    private defaultTimeout;
    private defaultRetries;
    private retryDelay;
    private fetchFn;
    private runSubscribers;
    private globalSubscribers;
    constructor(config?: WebhookEventTransportConfig);
    /**
     * Add a webhook endpoint.
     */
    addEndpoint(endpoint: WebhookEndpoint): void;
    /**
     * Remove a webhook endpoint.
     */
    removeEndpoint(id: string): boolean;
    /**
     * Get all registered endpoints.
     */
    getEndpoints(): WebhookEndpoint[];
    /**
     * Enable or disable an endpoint.
     */
    setEndpointEnabled(id: string, enabled: boolean): void;
    /**
     * Emit an event to all matching webhook endpoints.
     */
    emit(event: WorkflowEvent): void;
    /**
     * Subscribe to events for a specific run (server-side).
     */
    subscribe(runId: string, callback: EventCallback): Unsubscribe;
    /**
     * Subscribe to all events (server-side).
     */
    subscribeAll(callback: EventCallback): Unsubscribe;
    /**
     * Close the transport.
     */
    close(): void;
    /**
     * Check if an event matches an endpoint's filters.
     */
    private matchesFilter;
    /**
     * Send a webhook with retry support.
     */
    private sendWebhook;
    /**
     * Sign a payload using HMAC-SHA256.
     */
    private signPayload;
    /**
     * Sleep helper.
     */
    private sleep;
}

export { type BuiltInEventType, type EventCallback, type EventTransport, MemoryEventTransport, SocketIOEventTransport, type SocketIOEventTransportConfig, type SocketIOServer, type SocketIOSocket, type Unsubscribe, type WebhookEndpoint, WebhookEventTransport, type WebhookEventTransportConfig, type WebhookPayload, type WorkflowEvent, type WorkflowEventType };
