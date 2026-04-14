import { W as WorkflowKind } from './types-K5Gjk3H_.js';

/**
 * Event system types for the workflow engine.
 */

/**
 * Built-in event types emitted by the workflow engine.
 */
type BuiltInEventType = 'run.created' | 'run.queued' | 'run.dequeued' | 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed' | 'run.canceled' | 'run.timeout' | 'step.started' | 'step.completed' | 'step.failed' | 'step.skipped' | 'step.retry';
/**
 * Event types emitted by the workflow engine.
 * Includes built-in types and allows custom events via string.
 */
type WorkflowEventType = BuiltInEventType | (string & {});
/**
 * Workflow event payload structure.
 */
interface WorkflowEvent {
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
/**
 * Callback function for handling workflow events.
 */
type EventCallback = (event: WorkflowEvent) => void;
/**
 * Unsubscribe function returned when subscribing to events.
 */
type Unsubscribe = () => void;
/**
 * Event transport interface.
 * Implement this to customize how events are delivered.
 */
interface EventTransport {
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
    subscribeToType?(eventType: WorkflowEventType, callback: EventCallback): Unsubscribe;
    /**
     * Optional: Persist event for later retrieval.
     */
    persist?(event: WorkflowEvent): Promise<void>;
    /**
     * Optional: Close/cleanup the transport.
     */
    close?(): void;
}

export type { BuiltInEventType as B, EventCallback as E, Unsubscribe as U, WorkflowEvent as W, EventTransport as a, WorkflowEventType as b };
