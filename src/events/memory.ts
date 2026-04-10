/**
 * In-memory event transport using Node.js EventEmitter.
 * Default transport for development and single-process deployments.
 *
 * NOTE: This adapter is intended for development and testing only. It stores
 * all state in-process with no persistence or multi-process safety guarantees.
 */

import { EventEmitter } from "events";
import type {
  EventTransport,
  WorkflowEvent,
  WorkflowEventType,
  EventCallback,
  Unsubscribe,
} from "./types";

/**
 * In-memory event transport implementation using EventEmitter.
 * Events are emitted to subscribers in the same process.
 */
export class MemoryEventTransport implements EventTransport {
  private emitter = new EventEmitter();

  constructor() {
    // Increase max listeners to avoid warnings in workflows with many steps
    this.emitter.setMaxListeners(100);
  }

  /**
   * Emit an event to all subscribers.
   */
  emit(event: WorkflowEvent): void {
    // Emit to global subscribers
    this.emitter.emit("event", event);

    // Emit to run-specific subscribers
    this.emitter.emit(`run:${event.runId}`, event);

    // Emit to event-type subscribers
    this.emitter.emit(`type:${event.eventType}`, event);
  }

  /**
   * Subscribe to events for a specific run.
   */
  subscribe(runId: string, callback: EventCallback): Unsubscribe {
    const channel = `run:${runId}`;
    this.emitter.on(channel, callback);
    return () => {
      this.emitter.off(channel, callback);
    };
  }

  /**
   * Subscribe to all events.
   */
  subscribeAll(callback: EventCallback): Unsubscribe {
    this.emitter.on("event", callback);
    return () => {
      this.emitter.off("event", callback);
    };
  }

  /**
   * Subscribe to events of a specific type.
   */
  subscribeToType(
    eventType: WorkflowEventType,
    callback: EventCallback,
  ): Unsubscribe {
    const channel = `type:${eventType}`;
    this.emitter.on(channel, callback);
    return () => {
      this.emitter.off(channel, callback);
    };
  }

  /**
   * Close the transport and remove all listeners.
   */
  close(): void {
    this.emitter.removeAllListeners();
  }

  /**
   * Get the number of listeners for a channel (for testing).
   */
  getListenerCount(channel?: string): number {
    if (channel) {
      return this.emitter.listenerCount(channel);
    }
    return this.emitter.listenerCount("event");
  }
}
