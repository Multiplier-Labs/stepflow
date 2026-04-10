/**
 * Event system types for the workflow engine.
 */

import type { WorkflowKind } from "../core/types";

// ============================================================================
// Event Types
// ============================================================================

/**
 * Built-in event types emitted by the workflow engine.
 */
export type BuiltInEventType =
  | "run.created"
  | "run.queued"
  | "run.dequeued"
  | "run.started"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.canceled"
  | "run.timeout"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.skipped"
  | "step.retry";

/**
 * Event types emitted by the workflow engine.
 * Includes built-in types and allows custom events via string.
 */
export type WorkflowEventType = BuiltInEventType | (string & {});

// ============================================================================
// Event Payload
// ============================================================================

/**
 * Workflow event payload structure.
 */
export interface WorkflowEvent {
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

// ============================================================================
// Event Callback Types
// ============================================================================

/**
 * Callback function for handling workflow events.
 */
export type EventCallback = (event: WorkflowEvent) => void;

/**
 * Unsubscribe function returned when subscribing to events.
 */
export type Unsubscribe = () => void;

// ============================================================================
// Event Transport Interface
// ============================================================================

/**
 * Event transport interface.
 * Implement this to customize how events are delivered.
 */
export interface EventTransport {
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
  subscribeToType?(
    eventType: WorkflowEventType,
    callback: EventCallback,
  ): Unsubscribe;

  /**
   * Optional: Persist event for later retrieval.
   */
  persist?(event: WorkflowEvent): Promise<void>;

  /**
   * Optional: Close/cleanup the transport.
   */
  close?(): void;
}
