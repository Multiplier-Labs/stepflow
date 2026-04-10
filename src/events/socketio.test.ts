import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SocketIOEventTransport,
  SocketIOServer,
  SocketIOSocket,
} from "./socketio";
import type { WorkflowEvent } from "./types";

// Mock Socket.IO server
function createMockServer(): SocketIOServer & {
  _rooms: Map<string, { emit: ReturnType<typeof vi.fn> }>;
  _emitCalls: Array<{ event: string; args: unknown[] }>;
} {
  const rooms = new Map<string, { emit: ReturnType<typeof vi.fn> }>();
  const emitCalls: Array<{ event: string; args: unknown[] }> = [];

  return {
    _rooms: rooms,
    _emitCalls: emitCalls,
    to(room: string) {
      if (!rooms.has(room)) {
        rooms.set(room, { emit: vi.fn() });
      }
      return rooms.get(room)!;
    },
    emit(event: string, ...args: unknown[]) {
      emitCalls.push({ event, args });
    },
  };
}

// Mock Socket.IO socket
function createMockSocket(): SocketIOSocket & {
  _joinedRooms: Set<string>;
  _handlers: Map<string, (...args: unknown[]) => void>;
} {
  const joinedRooms = new Set<string>();
  const handlers = new Map<string, (...args: unknown[]) => void>();

  return {
    _joinedRooms: joinedRooms,
    _handlers: handlers,
    join(room: string) {
      joinedRooms.add(room);
    },
    leave(room: string) {
      joinedRooms.delete(room);
    },
    on(event: string, callback: (...args: unknown[]) => void) {
      handlers.set(event, callback);
    },
  };
}

function createTestEvent(
  overrides: Partial<WorkflowEvent> = {},
): WorkflowEvent {
  return {
    eventType: "run.started",
    runId: "run-123",
    kind: "test.workflow",
    timestamp: new Date("2024-01-01T12:00:00Z"),
    ...overrides,
  };
}

describe("SocketIOEventTransport", () => {
  let io: ReturnType<typeof createMockServer>;
  let transport: SocketIOEventTransport;

  beforeEach(() => {
    io = createMockServer();
    transport = new SocketIOEventTransport({ io });
  });

  describe("emit", () => {
    it("should emit event to run-specific room", () => {
      const event = createTestEvent({ runId: "run-456" });
      transport.emit(event);

      const roomEmit = io._rooms.get("run:run-456");
      expect(roomEmit).toBeDefined();
      expect(roomEmit!.emit).toHaveBeenCalledWith("workflow:event", {
        ...event,
        timestamp: "2024-01-01T12:00:00.000Z",
      });
    });

    it("should emit event to global room by default", () => {
      const event = createTestEvent();
      transport.emit(event);

      const globalRoomEmit = io._rooms.get("workflow:all");
      expect(globalRoomEmit).toBeDefined();
      expect(globalRoomEmit!.emit).toHaveBeenCalled();
    });

    it("should not emit to global room when broadcastGlobal is false", () => {
      transport = new SocketIOEventTransport({ io, broadcastGlobal: false });
      const event = createTestEvent();
      transport.emit(event);

      // Should only have run-specific room, not global
      expect(io._rooms.size).toBe(1);
      expect(io._rooms.has("run:run-123")).toBe(true);
      expect(io._rooms.has("workflow:all")).toBe(false);
    });

    it("should use custom event name", () => {
      transport = new SocketIOEventTransport({ io, eventName: "custom:event" });
      const event = createTestEvent();
      transport.emit(event);

      const roomEmit = io._rooms.get("run:run-123");
      expect(roomEmit!.emit).toHaveBeenCalledWith(
        "custom:event",
        expect.any(Object),
      );
    });

    it("should use custom room prefix", () => {
      transport = new SocketIOEventTransport({ io, roomPrefix: "workflow:" });
      const event = createTestEvent({ runId: "xyz" });
      transport.emit(event);

      expect(io._rooms.has("workflow:xyz")).toBe(true);
    });

    it("should serialize timestamp to ISO string", () => {
      const event = createTestEvent({
        timestamp: new Date("2024-06-15T10:30:00Z"),
      });
      transport.emit(event);

      const roomEmit = io._rooms.get("run:run-123");
      const emittedEvent = roomEmit!.emit.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(emittedEvent.timestamp).toBe("2024-06-15T10:30:00.000Z");
    });
  });

  describe("subscribe", () => {
    it("should call callback when event matches runId", () => {
      const callback = vi.fn();
      transport.subscribe("run-123", callback);

      const event = createTestEvent({ runId: "run-123" });
      transport.emit(event);

      expect(callback).toHaveBeenCalledWith(event);
    });

    it("should not call callback for different runId", () => {
      const callback = vi.fn();
      transport.subscribe("run-123", callback);

      const event = createTestEvent({ runId: "run-456" });
      transport.emit(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it("should allow multiple subscribers for same runId", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      transport.subscribe("run-123", callback1);
      transport.subscribe("run-123", callback2);

      const event = createTestEvent({ runId: "run-123" });
      transport.emit(event);

      expect(callback1).toHaveBeenCalledWith(event);
      expect(callback2).toHaveBeenCalledWith(event);
    });

    it("should unsubscribe when calling returned function", () => {
      const callback = vi.fn();
      const unsubscribe = transport.subscribe("run-123", callback);

      unsubscribe();

      const event = createTestEvent({ runId: "run-123" });
      transport.emit(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it("should handle callback errors gracefully", () => {
      const errorCallback = vi.fn().mockImplementation(() => {
        throw new Error("Callback error");
      });
      const normalCallback = vi.fn();

      transport.subscribe("run-123", errorCallback);
      transport.subscribe("run-123", normalCallback);

      const event = createTestEvent({ runId: "run-123" });
      transport.emit(event);

      // Both callbacks should have been called despite error
      expect(errorCallback).toHaveBeenCalled();
      expect(normalCallback).toHaveBeenCalled();
    });
  });

  describe("subscribeAll", () => {
    it("should call callback for all events", () => {
      const callback = vi.fn();
      transport.subscribeAll(callback);

      const event1 = createTestEvent({ runId: "run-1" });
      const event2 = createTestEvent({ runId: "run-2" });
      transport.emit(event1);
      transport.emit(event2);

      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledWith(event1);
      expect(callback).toHaveBeenCalledWith(event2);
    });

    it("should unsubscribe when calling returned function", () => {
      const callback = vi.fn();
      const unsubscribe = transport.subscribeAll(callback);

      unsubscribe();

      const event = createTestEvent();
      transport.emit(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("setupClientHandlers", () => {
    const allowAll = vi.fn().mockResolvedValue(true);

    it("should register subscription handlers on socket", () => {
      const socket = createMockSocket();
      transport.setupClientHandlers(socket, allowAll);

      expect(socket._handlers.has("workflow:subscribe")).toBe(true);
      expect(socket._handlers.has("workflow:unsubscribe")).toBe(true);
      expect(socket._handlers.has("workflow:subscribe:all")).toBe(true);
      expect(socket._handlers.has("workflow:unsubscribe:all")).toBe(true);
    });

    it("should join run-specific room on subscribe when authorized", async () => {
      const socket = createMockSocket();
      transport.setupClientHandlers(socket, allowAll);

      const subscribeHandler = socket._handlers.get("workflow:subscribe")!;
      await subscribeHandler("run-123");

      expect(socket._joinedRooms.has("run:run-123")).toBe(true);
    });

    it("should leave run-specific room on unsubscribe", async () => {
      const socket = createMockSocket();
      transport.setupClientHandlers(socket, allowAll);

      // First subscribe
      const subscribeHandler = socket._handlers.get("workflow:subscribe")!;
      await subscribeHandler("run-123");

      // Then unsubscribe
      const unsubscribeHandler = socket._handlers.get("workflow:unsubscribe")!;
      unsubscribeHandler("run-123");

      expect(socket._joinedRooms.has("run:run-123")).toBe(false);
    });

    it("should join global room on subscribe:all when authorized", async () => {
      const socket = createMockSocket();
      transport.setupClientHandlers(socket, allowAll);

      const subscribeAllHandler = socket._handlers.get(
        "workflow:subscribe:all",
      )!;
      await subscribeAllHandler();

      expect(socket._joinedRooms.has("workflow:all")).toBe(true);
    });

    it("should leave global room on unsubscribe:all", async () => {
      const socket = createMockSocket();
      transport.setupClientHandlers(socket, allowAll);

      // First subscribe
      const subscribeAllHandler = socket._handlers.get(
        "workflow:subscribe:all",
      )!;
      await subscribeAllHandler();

      // Then unsubscribe
      const unsubscribeAllHandler = socket._handlers.get(
        "workflow:unsubscribe:all",
      )!;
      unsubscribeAllHandler();

      expect(socket._joinedRooms.has("workflow:all")).toBe(false);
    });

    it("should ignore non-string runId on subscribe", async () => {
      const socket = createMockSocket();
      transport.setupClientHandlers(socket, allowAll);

      const subscribeHandler = socket._handlers.get("workflow:subscribe")!;
      await subscribeHandler(123); // Not a string
      await subscribeHandler(null);
      await subscribeHandler(undefined);

      expect(socket._joinedRooms.size).toBe(0);
    });

    it("should deny run subscription when authorize returns false", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      transport = new SocketIOEventTransport({ io, logger });

      const socket = createMockSocket();
      const authorize = vi.fn().mockResolvedValue(false);
      transport.setupClientHandlers(socket, authorize);

      const subscribeHandler = socket._handlers.get("workflow:subscribe")!;
      await subscribeHandler("run-secret");

      expect(authorize).toHaveBeenCalledWith("run-secret", socket);
      expect(socket._joinedRooms.has("run:run-secret")).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("run-secret"),
      );
    });

    it("should deny run subscription when authorize throws", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      transport = new SocketIOEventTransport({ io, logger });

      const socket = createMockSocket();
      const authorize = vi.fn().mockRejectedValue(new Error("auth error"));
      transport.setupClientHandlers(socket, authorize);

      const subscribeHandler = socket._handlers.get("workflow:subscribe")!;
      await subscribeHandler("run-123");

      expect(socket._joinedRooms.has("run:run-123")).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        "Authorization check failed:",
        expect.any(Error),
      );
    });

    it("should deny global subscription when authorize returns false", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      transport = new SocketIOEventTransport({ io, logger });

      const socket = createMockSocket();
      const authorize = vi.fn().mockResolvedValue(false);
      transport.setupClientHandlers(socket, authorize);

      const subscribeAllHandler = socket._handlers.get(
        "workflow:subscribe:all",
      )!;
      await subscribeAllHandler();

      expect(authorize).toHaveBeenCalledWith("*", socket);
      expect(socket._joinedRooms.has("workflow:all")).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith("Global subscription denied");
    });

    it("should deny global subscription when authorize throws", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      transport = new SocketIOEventTransport({ io, logger });

      const socket = createMockSocket();
      const authorize = vi.fn().mockRejectedValue(new Error("auth down"));
      transport.setupClientHandlers(socket, authorize);

      const subscribeAllHandler = socket._handlers.get(
        "workflow:subscribe:all",
      )!;
      await subscribeAllHandler();

      expect(socket._joinedRooms.has("workflow:all")).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        "Authorization check failed:",
        expect.any(Error),
      );
    });
  });

  describe("close", () => {
    it("should clear all subscribers", () => {
      const runCallback = vi.fn();
      const globalCallback = vi.fn();
      transport.subscribe("run-123", runCallback);
      transport.subscribeAll(globalCallback);

      transport.close();

      const event = createTestEvent({ runId: "run-123" });
      transport.emit(event);

      expect(runCallback).not.toHaveBeenCalled();
      expect(globalCallback).not.toHaveBeenCalled();
    });
  });
});
