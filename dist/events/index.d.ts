import { a as EventTransport, W as WorkflowEvent, E as EventCallback, U as Unsubscribe, b as WorkflowEventType } from '../types-DZUdWmCc.js';
export { B as BuiltInEventType } from '../types-DZUdWmCc.js';
import { Logger } from '../index.js';

/**
 * In-memory event transport using Node.js EventEmitter.
 * Default transport for development and single-process deployments.
 *
 * NOTE: This adapter is intended for development and testing only. It stores
 * all state in-process with no persistence or multi-process safety guarantees.
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
     * Each channel is isolated so a failing listener on one channel
     * cannot prevent delivery to the others.
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
     * An `authorize` callback is required to prevent unauthorized access to run events.
     * The callback receives the run ID (or `'*'` for global subscriptions) and the socket,
     * and must return `true` to allow or `false` to deny the subscription.
     *
     * @param socket - The Socket.IO socket to set up handlers on
     * @param authorize - Callback to check if a socket can access a run.
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
    setupClientHandlers(socket: SocketIOSocket, authorize: SocketIOAuthorizeFn): void;
    /**
     * Clear all in-process server-side subscribers.
     * The underlying Socket.IO server socket is not closed here — manage its lifecycle externally.
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
    /**
     * Maximum number of queued webhook deliveries waiting for a concurrency slot
     * (default: 1000, env override: `STEPFLOW_WEBHOOK_MAX_QUEUE_DEPTH`).
     *
     * When the queue is full, incoming `emit()` deliveries are dropped to
     * protect the process from memory exhaustion under burst traffic. Drops
     * are logged via `logger.warn` with the endpoint id, current queue depth,
     * and a recommended `retryAfterMs`. A value of `0` disables the cap (not
     * recommended in production).
     */
    maxQueueDepth?: number;
    /**
     * Suggested back-off in milliseconds reported on dropped deliveries
     * (default: 1000). Surfaced in the warning log so external orchestrators
     * (sidecars, sweeper jobs) can respect it like an HTTP `Retry-After`.
     */
    queueDropRetryAfterMs?: number;
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
    /**
     * Whether `fetchFn` was caller-supplied. When `false` the default fetch is
     * replaced with `pinnedFetch` so the TCP connection can target the IP that
     * was just validated (closes the DNS-rebinding TOCTOU window). When `true`
     * the custom fetch is used as-is so test injection still works.
     */
    private hasCustomFetch;
    private allowInsecureUrls;
    private maxPayloadBytes;
    private maxConcurrentRequests;
    private maxQueueDepth;
    private queueDropRetryAfterMs;
    private activeRequests;
    private requestQueue;
    private droppedRequests;
    private logger;
    private dnsCache;
    private static readonly DNS_CACHE_TTL_MS;
    private static readonly DNS_TIMEOUT_MS;
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
     * Number of webhook deliveries dropped due to queue overflow since startup.
     * Useful for surfacing back-pressure to operators (metrics/health checks).
     */
    getDroppedRequestCount(): number;
    /**
     * Current depth of the pending request queue.
     */
    getQueueDepth(): number;
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
     * Resolve a webhook URL's hostname exactly once, verify the resolved IP is
     * not private/reserved, and return the address + family so the caller can
     * pin the connection to it.
     *
     * Raw-IP URLs are validated and pinned too; they must not fall back to a
     * redirect-following HTTP client.
     *
     * Pinning the resolved IP closes the DNS rebinding TOCTOU window (audit M1):
     * with the original implementation `fetch()` re-resolved the hostname,
     * giving a hostile DNS server a chance to flip the answer to an internal
     * address between SSRF validation and connect.
     *
     * Uses a short-TTL cache and per-call timeout to avoid blocking the event loop.
     */
    private validateResolvedHost;
    /**
     * Validate a webhook URL to prevent SSRF attacks.
     * Blocks non-HTTPS schemes (unless allowInsecureUrls is set),
     * and rejects private/reserved IP ranges and cloud metadata endpoints.
     */
    private validateWebhookUrl;
    /**
     * Enqueue a webhook request with concurrency limiting and a queue-depth cap.
     * Returns `true` if the request was accepted (executed or queued), or
     * `false` if the queue is full and the request was rejected. The caller is
     * responsible for logging the drop and incrementing any drop metrics, since
     * it has the endpoint context.
     */
    private enqueueRequest;
}

export { EventCallback, EventTransport, MemoryEventTransport, SocketIOEventTransport, Unsubscribe, WebhookEventTransport, WorkflowEvent, WorkflowEventType };
export type { SocketIOAuthorizeFn, SocketIOEventTransportConfig, SocketIOServer, SocketIOSocket, WebhookEndpoint, WebhookEventTransportConfig, WebhookPayload };
