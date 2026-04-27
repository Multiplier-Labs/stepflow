/**
 * Webhook Event Transport
 *
 * Posts workflow events to HTTP endpoints via webhooks.
 * Supports multiple webhooks with optional filtering by event type.
 */

import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';
import type { EventTransport, EventCallback, Unsubscribe, WorkflowEvent, WorkflowEventType } from './types';
import type { Logger } from '../core/types';

/**
 * Webhook endpoint configuration.
 */
export interface WebhookEndpoint {
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
export interface WebhookEventTransportConfig {
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
  logger?: import('../core/types').Logger;
}

/**
 * Webhook payload structure sent to external endpoints.
 */
export interface WebhookPayload {
  /**
   * The workflow event with `timestamp` serialized as an ISO 8601 string.
   * The `Date` is converted to a string before delivery so that JSON consumers
   * receive a portable, timezone-aware representation without needing Date parsing.
   */
  event: Omit<WorkflowEvent, 'timestamp'> & { timestamp: string };
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
export class WebhookEventTransport implements EventTransport {
  private endpoints = new Map<string, WebhookEndpoint>();
  private defaultTimeout: number;
  private defaultRetries: number;
  private retryDelay: number;
  private fetchFn: typeof fetch;
  private allowInsecureUrls: boolean;
  private maxPayloadBytes: number;
  private maxConcurrentRequests: number;
  private maxQueueDepth: number;
  private queueDropRetryAfterMs: number;
  private activeRequests = 0;
  private requestQueue: Array<() => void> = [];
  private droppedRequests = 0;
  private logger: Logger;

  // Local subscribers for server-side subscriptions
  private runSubscribers = new Map<string, Set<EventCallback>>();
  private globalSubscribers = new Set<EventCallback>();

  constructor(config: WebhookEventTransportConfig = {}) {
    this.defaultTimeout = config.defaultTimeout ?? 5000;
    this.defaultRetries = config.defaultRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.allowInsecureUrls = config.allowInsecureUrls ?? false;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 1_048_576; // 1 MB
    this.maxConcurrentRequests = config.maxConcurrentRequests ?? 50;
    if (this.maxConcurrentRequests <= 0) {
      throw new Error('maxConcurrentRequests must be greater than 0');
    }
    this.maxQueueDepth = resolveMaxQueueDepth(config.maxQueueDepth);
    if (this.maxQueueDepth < 0) {
      throw new Error('maxQueueDepth must be >= 0 (0 disables the cap)');
    }
    this.queueDropRetryAfterMs = config.queueDropRetryAfterMs ?? 1000;
    this.logger = config.logger ?? {
      debug() {},
      info() {},
      warn() {},
      error(message: string, ...args: unknown[]) { console.error(message, ...args); },
    };

    if (this.allowInsecureUrls) {
      this.logger.warn('WebhookEventTransport: allowInsecureUrls is enabled. Webhook payloads will be sent over HTTP. Do not use this setting in production.');
    }

    // Register initial endpoints (validates URLs)
    if (config.endpoints) {
      for (const endpoint of config.endpoints) {
        this.addEndpoint(endpoint);
      }
    }
  }

  /**
   * Add a webhook endpoint.
   * Validates the URL to prevent SSRF attacks.
   * @throws Error if the URL scheme is not allowed
   */
  addEndpoint(endpoint: WebhookEndpoint): void {
    this.validateWebhookUrl(endpoint.url);
    this.endpoints.set(endpoint.id, { enabled: true, ...endpoint });
  }

  /**
   * Remove a webhook endpoint.
   */
  removeEndpoint(id: string): boolean {
    return this.endpoints.delete(id);
  }

  /**
   * Get all registered endpoints.
   */
  getEndpoints(): WebhookEndpoint[] {
    return Array.from(this.endpoints.values());
  }

  /**
   * Enable or disable an endpoint.
   */
  setEndpointEnabled(id: string, enabled: boolean): void {
    const endpoint = this.endpoints.get(id);
    if (endpoint) {
      endpoint.enabled = enabled;
    }
  }

  /**
   * Emit an event to all matching webhook endpoints.
   */
  emit(event: WorkflowEvent): void {
    // Notify local subscribers first (synchronously)
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
        this.logger.error('Event callback error:', error);
      }
    }

    // Send to webhooks asynchronously with concurrency control
    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.enabled) continue;
      if (!this.matchesFilter(event, endpoint)) continue;

      const accepted = this.enqueueRequest(
        () =>
          this.sendWebhook(endpoint, event).catch((error) => {
            this.logger.error(`Webhook ${endpoint.id} failed:`, error);
          }),
        endpoint.id
      );

      if (!accepted) {
        // Queue overflow — equivalent to a server returning 429 with Retry-After.
        // The delivery is dropped to protect the process from memory exhaustion.
        this.droppedRequests++;
        this.logger.warn(
          `Webhook ${endpoint.id} delivery dropped: queue full ` +
            `(depth ${this.requestQueue.length}/${this.maxQueueDepth}, ` +
            `active ${this.activeRequests}/${this.maxConcurrentRequests}, ` +
            `total drops ${this.droppedRequests}, retryAfterMs ${this.queueDropRetryAfterMs})`
        );
      }
    }
  }

  /**
   * Number of webhook deliveries dropped due to queue overflow since startup.
   * Useful for surfacing back-pressure to operators (metrics/health checks).
   */
  getDroppedRequestCount(): number {
    return this.droppedRequests;
  }

  /**
   * Current depth of the pending request queue.
   */
  getQueueDepth(): number {
    return this.requestQueue.length;
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
   * Close the transport.
   */
  close(): void {
    this.runSubscribers.clear();
    this.globalSubscribers.clear();
    this.endpoints.clear();
  }

  /**
   * Check if an event matches an endpoint's filters.
   */
  private matchesFilter(event: WorkflowEvent, endpoint: WebhookEndpoint): boolean {
    // Check event type filter
    if (endpoint.eventTypes && endpoint.eventTypes.length > 0) {
      if (!endpoint.eventTypes.includes(event.eventType)) {
        return false;
      }
    }

    // Check workflow kind filter
    if (endpoint.workflowKinds && endpoint.workflowKinds.length > 0) {
      if (!endpoint.workflowKinds.includes(event.kind)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Send a webhook with retry support.
   */
  private async sendWebhook(endpoint: WebhookEndpoint, event: WorkflowEvent): Promise<void> {
    const timeout = endpoint.timeout ?? this.defaultTimeout;
    const maxRetries = endpoint.retries ?? this.defaultRetries;

    const payload: WebhookPayload = {
      event: {
        ...event,
        timestamp: event.timestamp.toISOString(),
      },
      deliveredAt: new Date().toISOString(),
      webhookId: endpoint.id,
    };

    const body = JSON.stringify(payload);

    // Enforce payload size limit to prevent excessive memory use and network abuse
    if (body.length > this.maxPayloadBytes) {
      throw new Error(
        `Webhook payload exceeds maximum size (${body.length} bytes > ${this.maxPayloadBytes} bytes)`
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...endpoint.headers,
    };

    // Sign payload if secret is provided
    if (endpoint.secret) {
      const signature = await this.signPayload(body, endpoint.secret);
      headers['X-Webhook-Signature'] = signature;
    }

    // Resolve hostname and validate the resolved IP is not private/reserved (SSRF protection).
    // This prevents DNS rebinding attacks where a hostname initially resolves to a public IP
    // but later resolves to a private IP.
    await this.validateResolvedHost(endpoint.url);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await this.fetchFn(endpoint.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return; // Success
        }

        lastError = new Error(`Webhook returned ${response.status}: ${response.statusText}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Wait before retrying (except on last attempt)
      if (attempt < maxRetries) {
        await this.sleep(this.retryDelay * Math.pow(2, attempt));
      }
    }

    throw lastError;
  }

  /**
   * Sign a payload using HMAC-SHA256.
   */
  private async signPayload(payload: string, secret: string): Promise<string> {
    // Use Web Crypto API for HMAC-SHA256
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const data = encoder.encode(payload);

    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, data);
    const hashArray = Array.from(new Uint8Array(signature));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return `sha256=${hashHex}`;
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve the hostname from a URL and verify the resolved IP is not private/reserved.
   * Prevents DNS rebinding attacks where a public hostname resolves to a private IP at send time.
   */
  private async validateResolvedHost(url: string): Promise<void> {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Skip DNS resolution for raw IP literals — already checked by isBlockedHost in validateWebhookUrl.
    // Node's URL parser wraps IPv6 literals in brackets (e.g., "[2001:db8::1]").
    const stripped = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    if (isIPv4(stripped) || isIPv6(stripped)) {
      return;
    }

    try {
      const { address } = await dns.lookup(hostname);
      if (isBlockedIp(address)) {
        throw new Error(
          `Webhook URL hostname "${hostname}" resolves to blocked IP ${address}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('resolves to blocked IP')) {
        throw error;
      }
      throw new Error(`Failed to resolve webhook URL hostname "${hostname}": ${error}`);
    }
  }

  /**
   * Validate a webhook URL to prevent SSRF attacks.
   * Blocks non-HTTPS schemes (unless allowInsecureUrls is set),
   * and rejects private/reserved IP ranges and cloud metadata endpoints.
   */
  private validateWebhookUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid webhook URL: ${url}`);
    }

    // Scheme check
    if (!this.allowInsecureUrls && parsed.protocol !== 'https:') {
      throw new Error(
        `Webhook URL must use HTTPS (got ${parsed.protocol}). Set allowInsecureUrls for development.`
      );
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Webhook URL must use HTTP(S) scheme (got ${parsed.protocol})`);
    }

    // Block dangerous hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (isBlockedHost(hostname)) {
      throw new Error(`Webhook URL hostname is blocked (private/reserved): ${hostname}`);
    }
  }

  /**
   * Enqueue a webhook request with concurrency limiting and a queue-depth cap.
   * Returns `true` if the request was accepted (executed or queued), or
   * `false` if the queue is full and the request was rejected. The caller is
   * responsible for logging the drop and incrementing any drop metrics, since
   * it has the endpoint context.
   */
  private enqueueRequest(fn: () => Promise<void>, _endpointId: string): boolean {
    const execute = () => {
      this.activeRequests++;
      fn().finally(() => {
        this.activeRequests--;
        const next = this.requestQueue.shift();
        if (next) next();
      });
    };

    if (this.activeRequests < this.maxConcurrentRequests) {
      execute();
      return true;
    }

    if (this.maxQueueDepth > 0 && this.requestQueue.length >= this.maxQueueDepth) {
      return false;
    }

    this.requestQueue.push(execute);
    return true;
  }
}

/**
 * Resolve the effective `maxQueueDepth` from explicit config and the
 * `STEPFLOW_WEBHOOK_MAX_QUEUE_DEPTH` environment variable.
 *
 * Precedence: explicit config value > env var > default (1000).
 */
function resolveMaxQueueDepth(configured: number | undefined): number {
  if (typeof configured === 'number') return configured;
  const env = typeof process !== 'undefined' ? process.env?.STEPFLOW_WEBHOOK_MAX_QUEUE_DEPTH : undefined;
  if (env !== undefined && env !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 1000;
}

/**
 * Check if a hostname (as it appears in a URL) is blocked.
 * Handles bare hostnames, IPv4 literals, and bracketed IPv6 literals.
 */
function isBlockedHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;

  // IPv6 literals are wrapped in brackets by Node's URL parser, e.g. "[::1]".
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const bare = hostname.slice(1, -1);
    return isIPv6(bare) ? isBlockedIPv6(bare) : true;
  }

  // Some callers (or legacy code paths) may pass an unwrapped IPv6 literal.
  if (isIPv6(hostname)) {
    return isBlockedIPv6(hostname);
  }

  if (isIPv4(hostname)) {
    return isBlockedIPv4(hostname);
  }

  return false;
}

/**
 * Check if a resolved IP address falls within a private/reserved range.
 * Used for runtime DNS resolution validation to prevent SSRF via DNS rebinding.
 */
function isBlockedIp(ip: string): boolean {
  if (isIPv4(ip)) return isBlockedIPv4(ip);
  if (isIPv6(ip)) return isBlockedIPv6(ip);
  return false;
}

/**
 * Block IPv4 addresses in private, loopback, link-local, and cloud-metadata ranges.
 */
function isBlockedIPv4(ip: string): boolean {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [, a, b] = match.map(Number);
  return isBlockedIPv4Octets(a, b);
}

function isBlockedIPv4Octets(a: number, b: number): boolean {
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC 1918 private
  if (a === 10) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (covers cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC 1918 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC 1918 private
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255 broadcast)
  if (a >= 224) return true;
  return false;
}

/**
 * Block IPv6 addresses in reserved, private, loopback, link-local, IPv4-mapped,
 * IPv4-translated, 6to4, and Teredo ranges. For mapped/embedded IPv4 forms,
 * the embedded IPv4 is decoded and rechecked against the IPv4 blocklist.
 */
function isBlockedIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) return false;

  // ::1 loopback and :: unspecified
  const allButLastZero = groups.slice(0, 7).every(g => g === 0);
  if (allButLastZero && groups[7] === 1) return true;
  if (groups.every(g => g === 0)) return true;

  // ::ffff:0:0/96 — IPv4-mapped IPv6 (decode embedded IPv4)
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    return isBlockedIPv4Octets((groups[6] >> 8) & 0xff, groups[6] & 0xff);
  }

  // 64:ff9b::/96 — IPv4/IPv6 translation (RFC 6052) and 64:ff9b:1::/48 (RFC 8215)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) {
    return isBlockedIPv4Octets((groups[6] >> 8) & 0xff, groups[6] & 0xff);
  }

  // 2002::/16 — 6to4 (next 32 bits are the embedded IPv4)
  if (groups[0] === 0x2002) {
    return isBlockedIPv4Octets((groups[1] >> 8) & 0xff, groups[1] & 0xff);
  }

  // 2001::/32 — Teredo. Block conservatively; embedded server/client v4 fields
  // can mask private destinations and Teredo isn't a normal webhook target.
  if (groups[0] === 0x2001 && groups[1] === 0) return true;

  // 100::/64 — RFC 6666 Discard prefix
  if (groups[0] === 0x0100 && groups.slice(1, 4).every(g => g === 0)) return true;

  // fc00::/7 — Unique Local Addresses (fc00:: through fdff::)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // fe80::/10 — Link-local (fe80:: through febf::)
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // ff00::/8 — Multicast
  if ((groups[0] & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Expand an IPv6 string into an array of 8 numeric hextets (0–0xffff).
 * Handles "::" abbreviation, embedded IPv4 dotted-quad, and zone IDs.
 * Returns null if the input is not a valid IPv6 address.
 */
function expandIPv6(addr: string): number[] | null {
  // Strip zone identifier (e.g., "fe80::1%eth0")
  const noZone = addr.split('%')[0];
  if (!isIPv6(noZone)) return null;

  let normalized = noZone.toLowerCase();

  // Convert trailing dotted-quad (e.g., "::ffff:192.168.0.1") into two hextets.
  const v4Tail = normalized.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Tail) {
    const a = parseInt(v4Tail[2], 10);
    const b = parseInt(v4Tail[3], 10);
    const c = parseInt(v4Tail[4], 10);
    const d = parseInt(v4Tail[5], 10);
    if ([a, b, c, d].some(n => n > 255)) return null;
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    normalized = `${v4Tail[1]}${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  let parts: string[];
  if (halves.length === 1) {
    parts = halves[0].split(':');
    if (parts.length !== 8) return null;
  } else if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    parts = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    return null;
  }

  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}
