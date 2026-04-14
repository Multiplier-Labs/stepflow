// src/events/memory.ts
import { EventEmitter } from "events";
var MemoryEventTransport = class {
  emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  /**
   * Emit an event to all subscribers.
   */
  emit(event) {
    this.emitter.emit("event", event);
    this.emitter.emit(`run:${event.runId}`, event);
    this.emitter.emit(`type:${event.eventType}`, event);
  }
  /**
   * Subscribe to events for a specific run.
   */
  subscribe(runId, callback) {
    const channel = `run:${runId}`;
    this.emitter.on(channel, callback);
    return () => {
      this.emitter.off(channel, callback);
    };
  }
  /**
   * Subscribe to all events.
   */
  subscribeAll(callback) {
    this.emitter.on("event", callback);
    return () => {
      this.emitter.off("event", callback);
    };
  }
  /**
   * Subscribe to events of a specific type.
   */
  subscribeToType(eventType, callback) {
    const channel = `type:${eventType}`;
    this.emitter.on(channel, callback);
    return () => {
      this.emitter.off(channel, callback);
    };
  }
  /**
   * Close the transport and remove all listeners.
   */
  close() {
    this.emitter.removeAllListeners();
  }
  /**
   * Get the number of listeners for a channel (for testing).
   */
  getListenerCount(channel) {
    if (channel) {
      return this.emitter.listenerCount(channel);
    }
    return this.emitter.listenerCount("event");
  }
};

// src/events/socketio.ts
var SocketIOEventTransport = class {
  io;
  eventName;
  roomPrefix;
  broadcastGlobal;
  globalRoom;
  logger;
  // Local subscribers for server-side subscriptions
  runSubscribers = /* @__PURE__ */ new Map();
  globalSubscribers = /* @__PURE__ */ new Set();
  constructor(config) {
    this.io = config.io;
    this.eventName = config.eventName ?? "workflow:event";
    this.roomPrefix = config.roomPrefix ?? "run:";
    this.broadcastGlobal = config.broadcastGlobal ?? true;
    this.globalRoom = config.globalRoom ?? "workflow:all";
    this.logger = config.logger ?? {
      debug() {
      },
      info() {
      },
      warn() {
      },
      error(message, ...args) {
        console.error(message, ...args);
      }
    };
  }
  /**
   * Emit an event to Socket.IO clients and local subscribers.
   */
  emit(event) {
    const serializedEvent = {
      ...event,
      timestamp: event.timestamp.toISOString()
    };
    const room = `${this.roomPrefix}${event.runId}`;
    this.io.to(room).emit(this.eventName, serializedEvent);
    if (this.broadcastGlobal) {
      this.io.to(this.globalRoom).emit(this.eventName, serializedEvent);
    }
    const runSubs = this.runSubscribers.get(event.runId);
    if (runSubs) {
      for (const callback of runSubs) {
        try {
          callback(event);
        } catch (error) {
          this.logger.error("Event callback error:", error);
        }
      }
    }
    for (const callback of this.globalSubscribers) {
      try {
        callback(event);
      } catch (error) {
        this.logger.error("Event callback error:", error);
      }
    }
  }
  /**
   * Subscribe to events for a specific run (server-side).
   */
  subscribe(runId, callback) {
    let subs = this.runSubscribers.get(runId);
    if (!subs) {
      subs = /* @__PURE__ */ new Set();
      this.runSubscribers.set(runId, subs);
    }
    subs.add(callback);
    return () => {
      subs.delete(callback);
      if (subs.size === 0) {
        this.runSubscribers.delete(runId);
      }
    };
  }
  /**
   * Subscribe to all events (server-side).
   */
  subscribeAll(callback) {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }
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
  setupClientHandlers(socket, authorize) {
    socket.on("workflow:subscribe", async (...args) => {
      const runId = args[0];
      if (typeof runId !== "string") return;
      try {
        const allowed = await authorize(runId, socket);
        if (!allowed) {
          this.logger.warn(`Subscription denied for run ${runId}`);
          return;
        }
      } catch (error) {
        this.logger.error("Authorization check failed:", error);
        return;
      }
      socket.join(`${this.roomPrefix}${runId}`);
    });
    socket.on("workflow:unsubscribe", (...args) => {
      const runId = args[0];
      if (typeof runId === "string") {
        socket.leave(`${this.roomPrefix}${runId}`);
      }
    });
    socket.on("workflow:subscribe:all", async () => {
      try {
        const allowed = await authorize("*", socket);
        if (!allowed) {
          this.logger.warn("Global subscription denied");
          return;
        }
      } catch (error) {
        this.logger.error("Authorization check failed:", error);
        return;
      }
      socket.join(this.globalRoom);
    });
    socket.on("workflow:unsubscribe:all", () => {
      socket.leave(this.globalRoom);
    });
  }
  /**
   * Clear all in-process server-side subscribers.
   * The underlying Socket.IO server socket is not closed here — manage its lifecycle externally.
   */
  close() {
    this.runSubscribers.clear();
    this.globalSubscribers.clear();
  }
};

// src/events/webhook.ts
import { promises as dns } from "dns";
var WebhookEventTransport = class {
  endpoints = /* @__PURE__ */ new Map();
  defaultTimeout;
  defaultRetries;
  retryDelay;
  fetchFn;
  allowInsecureUrls;
  maxPayloadBytes;
  maxConcurrentRequests;
  activeRequests = 0;
  requestQueue = [];
  logger;
  // Local subscribers for server-side subscriptions
  runSubscribers = /* @__PURE__ */ new Map();
  globalSubscribers = /* @__PURE__ */ new Set();
  constructor(config = {}) {
    this.defaultTimeout = config.defaultTimeout ?? 5e3;
    this.defaultRetries = config.defaultRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1e3;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.allowInsecureUrls = config.allowInsecureUrls ?? false;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 1048576;
    this.maxConcurrentRequests = config.maxConcurrentRequests ?? 50;
    if (this.maxConcurrentRequests <= 0) {
      throw new Error("maxConcurrentRequests must be greater than 0");
    }
    this.logger = config.logger ?? {
      debug() {
      },
      info() {
      },
      warn() {
      },
      error(message, ...args) {
        console.error(message, ...args);
      }
    };
    if (this.allowInsecureUrls) {
      this.logger.warn("WebhookEventTransport: allowInsecureUrls is enabled. Webhook payloads will be sent over HTTP. Do not use this setting in production.");
    }
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
  addEndpoint(endpoint) {
    this.validateWebhookUrl(endpoint.url);
    this.endpoints.set(endpoint.id, { enabled: true, ...endpoint });
  }
  /**
   * Remove a webhook endpoint.
   */
  removeEndpoint(id) {
    return this.endpoints.delete(id);
  }
  /**
   * Get all registered endpoints.
   */
  getEndpoints() {
    return Array.from(this.endpoints.values());
  }
  /**
   * Enable or disable an endpoint.
   */
  setEndpointEnabled(id, enabled) {
    const endpoint = this.endpoints.get(id);
    if (endpoint) {
      endpoint.enabled = enabled;
    }
  }
  /**
   * Emit an event to all matching webhook endpoints.
   */
  emit(event) {
    const runSubs = this.runSubscribers.get(event.runId);
    if (runSubs) {
      for (const callback of runSubs) {
        try {
          callback(event);
        } catch (error) {
          this.logger.error("Event callback error:", error);
        }
      }
    }
    for (const callback of this.globalSubscribers) {
      try {
        callback(event);
      } catch (error) {
        this.logger.error("Event callback error:", error);
      }
    }
    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.enabled) continue;
      if (!this.matchesFilter(event, endpoint)) continue;
      this.enqueueRequest(
        () => this.sendWebhook(endpoint, event).catch((error) => {
          this.logger.error(`Webhook ${endpoint.id} failed:`, error);
        })
      );
    }
  }
  /**
   * Subscribe to events for a specific run (server-side).
   */
  subscribe(runId, callback) {
    let subs = this.runSubscribers.get(runId);
    if (!subs) {
      subs = /* @__PURE__ */ new Set();
      this.runSubscribers.set(runId, subs);
    }
    subs.add(callback);
    return () => {
      subs.delete(callback);
      if (subs.size === 0) {
        this.runSubscribers.delete(runId);
      }
    };
  }
  /**
   * Subscribe to all events (server-side).
   */
  subscribeAll(callback) {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }
  /**
   * Close the transport.
   */
  close() {
    this.runSubscribers.clear();
    this.globalSubscribers.clear();
    this.endpoints.clear();
  }
  /**
   * Check if an event matches an endpoint's filters.
   */
  matchesFilter(event, endpoint) {
    if (endpoint.eventTypes && endpoint.eventTypes.length > 0) {
      if (!endpoint.eventTypes.includes(event.eventType)) {
        return false;
      }
    }
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
  async sendWebhook(endpoint, event) {
    const timeout = endpoint.timeout ?? this.defaultTimeout;
    const maxRetries = endpoint.retries ?? this.defaultRetries;
    const payload = {
      event: {
        ...event,
        timestamp: event.timestamp.toISOString()
      },
      deliveredAt: (/* @__PURE__ */ new Date()).toISOString(),
      webhookId: endpoint.id
    };
    const body = JSON.stringify(payload);
    if (body.length > this.maxPayloadBytes) {
      throw new Error(
        `Webhook payload exceeds maximum size (${body.length} bytes > ${this.maxPayloadBytes} bytes)`
      );
    }
    const headers = {
      "Content-Type": "application/json",
      ...endpoint.headers
    };
    if (endpoint.secret) {
      const signature = await this.signPayload(body, endpoint.secret);
      headers["X-Webhook-Signature"] = signature;
    }
    await this.validateResolvedHost(endpoint.url);
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        const response = await this.fetchFn(endpoint.url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (response.ok) {
          return;
        }
        lastError = new Error(`Webhook returned ${response.status}: ${response.statusText}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < maxRetries) {
        await this.sleep(this.retryDelay * Math.pow(2, attempt));
      }
    }
    throw lastError;
  }
  /**
   * Sign a payload using HMAC-SHA256.
   */
  async signPayload(payload, secret) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const data = encoder.encode(payload);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, data);
    const hashArray = Array.from(new Uint8Array(signature));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return `sha256=${hashHex}`;
  }
  /**
   * Sleep helper.
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /**
   * Resolve the hostname from a URL and verify the resolved IP is not private/reserved.
   * Prevents DNS rebinding attacks where a public hostname resolves to a private IP at send time.
   */
  async validateResolvedHost(url) {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
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
      if (error instanceof Error && error.message.includes("resolves to blocked IP")) {
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
  validateWebhookUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid webhook URL: ${url}`);
    }
    if (!this.allowInsecureUrls && parsed.protocol !== "https:") {
      throw new Error(
        `Webhook URL must use HTTPS (got ${parsed.protocol}). Set allowInsecureUrls for development.`
      );
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Webhook URL must use HTTP(S) scheme (got ${parsed.protocol})`);
    }
    const hostname = parsed.hostname.toLowerCase();
    if (isBlockedHost(hostname)) {
      throw new Error(`Webhook URL hostname is blocked (private/reserved): ${hostname}`);
    }
  }
  /**
   * Enqueue a webhook request with concurrency limiting.
   */
  enqueueRequest(fn) {
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
};
function isBlockedHost(hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  if (hostname.startsWith("[")) {
    return true;
  }
  if (hostname === "169.254.169.254") {
    return true;
  }
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0 && b === 0) return true;
  }
  if (hostname.startsWith("fe80:") || hostname.startsWith("[fe80:")) {
    return true;
  }
  return false;
}
function isBlockedIp(ip) {
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0 && b === 0) return true;
  }
  if (ip === "::1") return true;
  if (ip.startsWith("fe80:")) return true;
  return false;
}

export {
  MemoryEventTransport,
  SocketIOEventTransport,
  WebhookEventTransport
};
//# sourceMappingURL=chunk-GYPNJBDP.js.map