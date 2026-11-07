// src/events/memory.ts
import { EventEmitter } from "events";
var MemoryEventTransport = class {
  emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  /**
   * Emit an event to all subscribers.
   * Each channel is isolated so a failing listener on one channel
   * cannot prevent delivery to the others.
   */
  emit(event) {
    this.emitter.emit(`run:${event.runId}`, event);
    this.emitter.emit(`type:${event.eventType}`, event);
    this.emitter.emit("event", event);
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
import { isIPv4, isIPv6 } from "net";

// src/utils/pinned-fetch.ts
import * as http from "http";
import * as https from "https";
import { isIP } from "net";
function pinnedFetch(url, init, address, family = 4) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
  const lookup = (_hostname, options, cb) => {
    if (options && options.all === true) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname,
        port,
        path: `${parsed.pathname || "/"}${parsed.search}`,
        method: init.method ?? "GET",
        headers: init.headers,
        lookup,
        servername: isIP(hostname) ? "" : hostname,
        signal: init.signal
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? ""
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (init.body !== void 0) {
      req.write(init.body);
    }
    req.end();
  });
}

// src/events/webhook.ts
var WebhookEventTransport = class _WebhookEventTransport {
  endpoints = /* @__PURE__ */ new Map();
  defaultTimeout;
  defaultRetries;
  retryDelay;
  fetchFn;
  /**
   * Whether `fetchFn` was caller-supplied. When `false` the default fetch is
   * replaced with `pinnedFetch` so the TCP connection can target the IP that
   * was just validated (closes the DNS-rebinding TOCTOU window). When `true`
   * the custom fetch is used as-is so test injection still works.
   */
  hasCustomFetch;
  allowInsecureUrls;
  maxPayloadBytes;
  maxConcurrentRequests;
  maxQueueDepth;
  queueDropRetryAfterMs;
  activeRequests = 0;
  requestQueue = [];
  droppedRequests = 0;
  logger;
  // DNS resolution cache with TTL — stores `family` so the pin can reuse it
  // without a second lookup.
  dnsCache = /* @__PURE__ */ new Map();
  static DNS_CACHE_TTL_MS = 3e4;
  // 30 seconds
  static DNS_TIMEOUT_MS = 5e3;
  // 5 seconds
  // Local subscribers for server-side subscriptions
  runSubscribers = /* @__PURE__ */ new Map();
  globalSubscribers = /* @__PURE__ */ new Set();
  constructor(config = {}) {
    this.defaultTimeout = config.defaultTimeout ?? 5e3;
    this.defaultRetries = config.defaultRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1e3;
    this.hasCustomFetch = config.fetchFn !== void 0;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.allowInsecureUrls = config.allowInsecureUrls ?? false;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 1048576;
    this.maxConcurrentRequests = config.maxConcurrentRequests ?? 50;
    if (this.maxConcurrentRequests <= 0) {
      throw new Error("maxConcurrentRequests must be greater than 0");
    }
    this.maxQueueDepth = resolveMaxQueueDepth(config.maxQueueDepth);
    if (this.maxQueueDepth < 0) {
      throw new Error("maxQueueDepth must be >= 0 (0 disables the cap)");
    }
    this.queueDropRetryAfterMs = config.queueDropRetryAfterMs ?? 1e3;
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
      const accepted = this.enqueueRequest(
        () => this.sendWebhook(endpoint, event).catch((error) => {
          this.logger.error(`Webhook ${endpoint.id} failed:`, error);
        }),
        endpoint.id
      );
      if (!accepted) {
        this.droppedRequests++;
        this.logger.warn(
          `Webhook ${endpoint.id} delivery dropped: queue full (depth ${this.requestQueue.length}/${this.maxQueueDepth}, active ${this.activeRequests}/${this.maxConcurrentRequests}, total drops ${this.droppedRequests}, retryAfterMs ${this.queueDropRetryAfterMs})`
        );
      }
    }
  }
  /**
   * Number of webhook deliveries dropped due to queue overflow since startup.
   * Useful for surfacing back-pressure to operators (metrics/health checks).
   */
  getDroppedRequestCount() {
    return this.droppedRequests;
  }
  /**
   * Current depth of the pending request queue.
   */
  getQueueDepth() {
    return this.requestQueue.length;
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
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > this.maxPayloadBytes) {
      throw new Error(
        `Webhook payload exceeds maximum size (${bodyBytes} bytes > ${this.maxPayloadBytes} bytes)`
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
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const pinned = await this.validateResolvedHost(endpoint.url);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        let response;
        try {
          response = this.hasCustomFetch ? await this.fetchFn(endpoint.url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
            redirect: "error"
          }) : await pinnedFetch(
            endpoint.url,
            { method: "POST", headers, body, signal: controller.signal },
            pinned.address,
            pinned.family
          );
        } finally {
          clearTimeout(timeoutId);
        }
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
  async validateResolvedHost(url) {
    this.validateWebhookUrl(url);
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const stripped = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    if (isIPv4(stripped) || isIPv6(stripped)) {
      return { address: stripped, family: isIPv6(stripped) ? 6 : 4 };
    }
    const cached = this.dnsCache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) {
      if (isBlockedIp(cached.address)) {
        throw new Error(
          `Webhook URL hostname "${hostname}" resolves to blocked IP ${cached.address}`
        );
      }
      return { address: cached.address, family: cached.family };
    }
    try {
      let timeoutId;
      let address;
      let family;
      try {
        const result = await Promise.race([
          dns.lookup(hostname),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(
              `DNS lookup for webhook URL hostname "${hostname}" timed out`
            )), _WebhookEventTransport.DNS_TIMEOUT_MS);
          })
        ]);
        address = result.address;
        family = result.family === 6 ? 6 : 4;
      } finally {
        clearTimeout(timeoutId);
      }
      this.dnsCache.set(hostname, {
        address,
        family,
        expiresAt: Date.now() + _WebhookEventTransport.DNS_CACHE_TTL_MS
      });
      if (isBlockedIp(address)) {
        throw new Error(
          `Webhook URL hostname "${hostname}" resolves to blocked IP ${address}`
        );
      }
      return { address, family };
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
   * Enqueue a webhook request with concurrency limiting and a queue-depth cap.
   * Returns `true` if the request was accepted (executed or queued), or
   * `false` if the queue is full and the request was rejected. The caller is
   * responsible for logging the drop and incrementing any drop metrics, since
   * it has the endpoint context.
   */
  enqueueRequest(fn, _endpointId) {
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
};
function resolveMaxQueueDepth(configured) {
  if (typeof configured === "number") return configured;
  const env = typeof process !== "undefined" ? process.env?.STEPFLOW_WEBHOOK_MAX_QUEUE_DEPTH : void 0;
  if (env !== void 0 && env !== "") {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 1e3;
}
function isBlockedHost(hostname) {
  if (hostname === "localhost") return true;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const bare = hostname.slice(1, -1);
    return isIPv6(bare) ? isBlockedIPv6(bare) : true;
  }
  if (isIPv6(hostname)) {
    return isBlockedIPv6(hostname);
  }
  if (isIPv4(hostname)) {
    return isBlockedIPv4(hostname);
  }
  return false;
}
function isBlockedIp(ip) {
  if (isIPv4(ip)) return isBlockedIPv4(ip);
  if (isIPv6(ip)) return isBlockedIPv6(ip);
  return false;
}
function isBlockedIPv4(ip) {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [, a, b] = match.map(Number);
  return isBlockedIPv4Octets(a, b);
}
function isBlockedIPv4Octets(a, b) {
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}
function isBlockedIPv6(ip) {
  const groups = expandIPv6(ip);
  if (!groups) return false;
  const allButLastZero = groups.slice(0, 7).every((g) => g === 0);
  if (allButLastZero && groups[7] === 1) return true;
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 65535) {
    return isBlockedIPv4Octets(groups[6] >> 8 & 255, groups[6] & 255);
  }
  if (groups[0] === 100 && groups[1] === 65435 && groups.slice(2, 6).every((g) => g === 0)) {
    return isBlockedIPv4Octets(groups[6] >> 8 & 255, groups[6] & 255);
  }
  if (groups[0] === 8194) {
    return isBlockedIPv4Octets(groups[1] >> 8 & 255, groups[1] & 255);
  }
  if (groups[0] === 8193 && groups[1] === 0) return true;
  if (groups[0] === 256 && groups.slice(1, 4).every((g) => g === 0)) return true;
  if ((groups[0] & 65024) === 64512) return true;
  if ((groups[0] & 65472) === 65152) return true;
  if ((groups[0] & 65280) === 65280) return true;
  return false;
}
function expandIPv6(addr) {
  const noZone = addr.split("%")[0];
  if (!isIPv6(noZone)) return null;
  let normalized = noZone.toLowerCase();
  const v4Tail = normalized.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Tail) {
    const a = parseInt(v4Tail[2], 10);
    const b = parseInt(v4Tail[3], 10);
    const c = parseInt(v4Tail[4], 10);
    const d = parseInt(v4Tail[5], 10);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    const hi = (a << 8 | b).toString(16);
    const lo = (c << 8 | d).toString(16);
    normalized = `${v4Tail[1]}${hi}:${lo}`;
  }
  const halves = normalized.split("::");
  let parts;
  if (halves.length === 1) {
    parts = halves[0].split(":");
    if (parts.length !== 8) return null;
  } else if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    parts = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    return null;
  }
  const groups = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

export {
  MemoryEventTransport,
  SocketIOEventTransport,
  WebhookEventTransport
};
//# sourceMappingURL=chunk-ASXSVHWT.js.map