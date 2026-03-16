/**
 * Webhook Event Transport
 *
 * Posts workflow events to HTTP endpoints via webhooks.
 * Supports multiple webhooks with optional filtering by event type.
 */

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
  private activeRequests = 0;
  private requestQueue: Array<() => void> = [];
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
    this.logger = config.logger ?? {
      debug() {},
      info() {},
      warn() {},
      error(message: string, ...args: unknown[]) { console.error(message, ...args); },
    };

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

      this.enqueueRequest(() =>
        this.sendWebhook(endpoint, event).catch((error) => {
          this.logger.error(`Webhook ${endpoint.id} failed:`, error);
        })
      );
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

    // Enforce payload size limit (L-4)
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
   * Enqueue a webhook request with concurrency limiting.
   */
  private enqueueRequest(fn: () => Promise<void>): void {
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
    } else {
      this.requestQueue.push(execute);
    }
  }
}

/**
 * Check if a hostname resolves to a blocked (private/reserved) address.
 * Blocks loopback, RFC 1918 private ranges, link-local, and cloud metadata IPs.
 */
function isBlockedHost(hostname: string): boolean {
  // Loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // Cloud metadata endpoint
  if (hostname === '169.254.169.254') {
    return true;
  }

  // Check for IP addresses in private/reserved ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0
    if (a === 0 && b === 0) return true;
  }

  // IPv6 link-local (fe80::)
  if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
    return true;
  }

  return false;
}
