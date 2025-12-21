/**
 * Webhook Event Transport
 *
 * Posts workflow events to HTTP endpoints via webhooks.
 * Supports multiple webhooks with optional filtering by event type.
 */

import type { EventTransport, EventCallback, Unsubscribe, WorkflowEvent, WorkflowEventType } from './types';

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
}

/**
 * Webhook payload structure.
 */
export interface WebhookPayload {
  event: Omit<WorkflowEvent, 'timestamp'> & { timestamp: string };
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
export class WebhookEventTransport implements EventTransport {
  private endpoints = new Map<string, WebhookEndpoint>();
  private defaultTimeout: number;
  private defaultRetries: number;
  private retryDelay: number;
  private fetchFn: typeof fetch;

  // Local subscribers for server-side subscriptions
  private runSubscribers = new Map<string, Set<EventCallback>>();
  private globalSubscribers = new Set<EventCallback>();

  constructor(config: WebhookEventTransportConfig = {}) {
    this.defaultTimeout = config.defaultTimeout ?? 5000;
    this.defaultRetries = config.defaultRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;

    // Register initial endpoints
    if (config.endpoints) {
      for (const endpoint of config.endpoints) {
        this.endpoints.set(endpoint.id, { enabled: true, ...endpoint });
      }
    }
  }

  /**
   * Add a webhook endpoint.
   */
  addEndpoint(endpoint: WebhookEndpoint): void {
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

    // Send to webhooks asynchronously (fire and forget)
    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.enabled) continue;
      if (!this.matchesFilter(event, endpoint)) continue;

      this.sendWebhook(endpoint, event).catch((error) => {
        console.error(`Webhook ${endpoint.id} failed:`, error);
      });
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...endpoint.headers,
    };

    // Sign payload if secret is provided
    if (endpoint.secret) {
      const signature = await this.signPayload(JSON.stringify(payload), endpoint.secret);
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
          body: JSON.stringify(payload),
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
}
