import { a as EventTransport, W as WorkflowEvent, E as EventCallback, U as Unsubscribe, b as WorkflowEventType } from '../types-DmQ102bp.js';
export { B as BuiltInEventType } from '../types-DmQ102bp.js';
import { L as Logger } from '../types-CYTuMmf-.js';

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
 * Authorization callback for Socket.IO run subscriptions.
 * Return true to allow the subscription, false to deny it.
 */
type SocketIOAuthorizeFn = (runId: string, socket: SocketIOSocket) => boolean | Promise<boolean>;
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
declare class SocketIOEventTransport implements EventTransport {
    private io;
    private eventName;
    private roomPrefix;
    private broadcastGlobal;
    private globalRoom;
    private logger;
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
    setupClientHandlers(socket: SocketIOSocket, authorize?: SocketIOAuthorizeFn): void;
    /**
     * Close the transport (no-op for Socket.IO, managed externally).
     */
    close(): void;
}

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
    /**
     * Whether to allow non-HTTPS URLs (default: false).
     * Set to true only in development environments.
     */
    allowInsecureUrls?: boolean;
    /**
     * Maximum payload size in bytes (default: 1048576 = 1 MB).
     * Payloads exceeding this limit will be rejected.
     */
    maxPayloadBytes?: number;
    /**
     * Maximum concurrent webhook requests across all endpoints (default: 50).
     * Requests beyond this limit are queued.
     */
    maxConcurrentRequests?: number;
    /** Logger for webhook transport errors (default: console-based) */
    logger?: Logger;
}
/**
 * Webhook payload structure sent to external endpoints.
 */
interface WebhookPayload {
    /**
     * The workflow event with `timestamp` serialized as an ISO 8601 string.
     * The `Date` is converted to a string before delivery so that JSON consumers
     * receive a portable, timezone-aware representation without needing Date parsing.
     */
    event: Omit<WorkflowEvent, 'timestamp'> & {
        timestamp: string;
    };
    /** ISO 8601 timestamp of when this payload was delivered. */
    deliveredAt: string;
    /** ID of the webhook endpoint that received this delivery. */
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
 *       secret: process.env.WEBHOOK_SECRET, // Use a cryptographically random secret (≥ 32 bytes)
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
    private allowInsecureUrls;
    private maxPayloadBytes;
    private maxConcurrentRequests;
    private activeRequests;
    private requestQueue;
    private logger;
    private runSubscribers;
    private globalSubscribers;
    constructor(config?: WebhookEventTransportConfig);
    /**
     * Add a webhook endpoint.
     * Validates the URL to prevent SSRF attacks.
     * @throws Error if the URL scheme is not allowed
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
    /**
     * Validate a webhook URL to prevent SSRF attacks.
     * Blocks non-HTTPS schemes (unless allowInsecureUrls is set),
     * and rejects private/reserved IP ranges and cloud metadata endpoints.
     */
    private validateWebhookUrl;
    /**
     * Enqueue a webhook request with concurrency limiting.
     */
    private enqueueRequest;
}

export { EventCallback, EventTransport, MemoryEventTransport, type SocketIOAuthorizeFn, SocketIOEventTransport, type SocketIOEventTransportConfig, type SocketIOServer, type SocketIOSocket, Unsubscribe, type WebhookEndpoint, WebhookEventTransport, type WebhookEventTransportConfig, type WebhookPayload, WorkflowEvent, WorkflowEventType };
