/**
 * Concurrency control for the WorkflowEngine.
 *
 * Owns:
 *   - the priority-ordered queue of pending runs (`runQueue`)
 *   - the set of in-flight run abort controllers (`activeRuns`)
 *   - the timer handles used to defer launches via setTimeout/setImmediate
 *
 * Responsibilities:
 *   - `hasCapacity()` against the configured `maxConcurrency` ceiling
 *   - priority-ordered enqueue (higher priority first, FIFO within a priority)
 *   - dispatch loop that drains the queue while capacity exists, with a
 *     try/catch around each dispatch so a single bad run cannot tear down
 *     the loop and strand the rest of the queue (preserves the audit
 *     2026-04-27 C3 fix in `processQueue`).
 *   - dispatch-failure telemetry: log + emit `run.failed` + best-effort
 *     storage update with `QUEUE_DISPATCH_FAILED`.
 *
 * NOT responsible for:
 *   - building the `executeWorkflow` invocation (that lives in WorkflowEngine
 *     so the orchestrator/spawnChild wiring stays where it is)
 *   - storage initialization / shutdown sequencing (see `lifecycle.ts`)
 */

import type { StorageAdapter } from '../../storage/types';
import type { EventTransport } from '../../events/types';
import type { Logger, WorkflowDefinition } from '../types';

/**
 * Queued run waiting to be executed when capacity is available.
 */
export interface QueuedRun {
  runId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority: number;
  queuedAt: Date;
}

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate>;

export interface ConcurrencyManagerDeps {
  storage: StorageAdapter;
  events: EventTransport;
  logger: Logger;
  /** Maximum concurrent runs; undefined or <=0 means unlimited. */
  maxConcurrency?: number;
}

export class ConcurrencyManager {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly runQueue: QueuedRun[] = [];
  private readonly timerHandles = new Set<TimerHandle>();
  private readonly storage: StorageAdapter;
  private readonly events: EventTransport;
  private readonly logger: Logger;
  private readonly maxConcurrency: number | undefined;

  constructor(deps: ConcurrencyManagerDeps) {
    this.storage = deps.storage;
    this.events = deps.events;
    this.logger = deps.logger;
    this.maxConcurrency = deps.maxConcurrency;
  }

  hasCapacity(): boolean {
    if (this.maxConcurrency === undefined || this.maxConcurrency <= 0) {
      return true;
    }
    return this.activeRuns.size < this.maxConcurrency;
  }

  getActiveCount(): number {
    return this.activeRuns.size;
  }

  getQueuedCount(): number {
    return this.runQueue.length;
  }

  isActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  /** Insert a run in priority order (higher priority first, FIFO within same). */
  enqueue(run: QueuedRun): void {
    let inserted = false;
    for (let i = 0; i < this.runQueue.length; i++) {
      if (run.priority > this.runQueue[i].priority) {
        this.runQueue.splice(i, 0, run);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.runQueue.push(run);
    }
  }

  /** Remove a run from the queue if present. Returns true if it was queued. */
  removeFromQueue(runId: string): boolean {
    const idx = this.runQueue.findIndex((q) => q.runId === runId);
    if (idx === -1) return false;
    this.runQueue.splice(idx, 1);
    return true;
  }

  registerActive(runId: string, controller: AbortController): void {
    this.activeRuns.set(runId, controller);
  }

  unregisterActive(runId: string): void {
    this.activeRuns.delete(runId);
  }

  abortActive(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Abort every in-flight run. `onAbort` is called for each run id before its
   * controller is signaled (so callers can log, emit, etc.).
   */
  abortAllActive(onAbort?: (runId: string) => void): void {
    for (const [runId, controller] of this.activeRuns) {
      if (onAbort) onAbort(runId);
      controller.abort();
    }
  }

  /** Forget all active-run bookkeeping without aborting (used during shutdown). */
  clearActive(): void {
    this.activeRuns.clear();
  }

  /**
   * Schedule a launch via setTimeout (when `delay` is truthy) or setImmediate
   * (otherwise). Tracks the handle so it can be cleared during shutdown.
   */
  scheduleLaunch(fn: () => void, delay?: number): void {
    if (delay) {
      const handle = setTimeout(fn, delay);
      this.timerHandles.add(handle);
    } else {
      const handle = setImmediate(fn);
      this.timerHandles.add(handle);
    }
  }

  clearTimers(): void {
    for (const handle of this.timerHandles) {
      if (typeof handle === 'object' && 'ref' in handle) {
        clearImmediate(handle as ReturnType<typeof setImmediate>);
      } else {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    }
    this.timerHandles.clear();
  }

  /**
   * Drain the queue while capacity is available, dispatching each item via
   * `dispatch(run)`. Each iteration is wrapped in try/catch so that a failure
   * dispatching one queued item (e.g., an event-transport that throws) cannot
   * tear down the loop and leave remaining items stuck in the queue. Failed
   * dispatches are logged, the run is marked as failed in storage as
   * best-effort telemetry, and the loop advances to the next item.
   *
   * Emits `run.dequeued` for each dispatched run (this is what the C3
   * resilience test exercises by having the emit throw).
   */
  processQueue(dispatch: (run: QueuedRun) => void): void {
    while (this.hasCapacity() && this.runQueue.length > 0) {
      const next = this.runQueue.shift()!;

      try {
        this.logger.debug(`Starting queued run ${next.runId}`);

        this.events.emit({
          runId: next.runId,
          kind: next.definition.kind,
          eventType: 'run.dequeued',
          timestamp: new Date(),
        });

        dispatch(next);
      } catch (err) {
        this.recordQueueDispatchFailure(next, err);
      }
    }
  }

  /**
   * Record a queue-dispatch failure: log it, emit a failure event, and
   * best-effort mark the run as failed in storage. All side-effects are
   * defensively wrapped so this method itself never throws.
   */
  private recordQueueDispatchFailure(queued: QueuedRun, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Failed to dispatch queued run ${queued.runId}`, err);

    try {
      this.events.emit({
        runId: queued.runId,
        kind: queued.definition.kind,
        eventType: 'run.failed',
        timestamp: new Date(),
        payload: { error: { code: 'QUEUE_DISPATCH_FAILED', message } },
      });
    } catch (emitErr) {
      this.logger.error(`Failed to emit dispatch-failure event for ${queued.runId}`, emitErr);
    }

    // Fire-and-forget; we don't want to block the queue loop on storage I/O.
    this.storage
      .updateRun(queued.runId, {
        status: 'failed',
        finishedAt: new Date(),
        error: { code: 'QUEUE_DISPATCH_FAILED', message },
      })
      .catch((updateErr) => {
        this.logger.error(`Failed to record dispatch failure for ${queued.runId}`, updateErr);
      });
  }
}
