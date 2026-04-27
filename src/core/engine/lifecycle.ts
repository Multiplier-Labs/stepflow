/**
 * Lifecycle and resume orchestration for the WorkflowEngine.
 *
 * Owns the cross-cutting "engine itself" lifecycle:
 *   - `initialize()` — bring up storage adapters that need explicit init
 *     (e.g., PostgresStorageAdapter)
 *   - `shutdown()` — drain timers, abort in-flight runs, close transports
 *   - `resumeRun()` / `getResumableRuns()` / `resumeAllInterrupted()` —
 *     restart interrupted runs from their persisted checkpoints
 *
 * NOT responsible for:
 *   - per-step execution (that lives in `orchestrator.ts`)
 *   - queue/active/timer bookkeeping (that lives in `engine/concurrency.ts`;
 *     this module delegates to a `ConcurrencyManager`)
 *   - building the `executeWorkflow` invocation (the engine still owns that
 *     so the orchestrator/spawnChild wiring stays in one place; this module
 *     calls it via the injected `launchRun` callback)
 */

import type { StorageAdapter, WorkflowRunRecord } from '../../storage/types';
import type { EventTransport } from '../../events/types';
import type { Logger, WorkflowDefinition, WorkflowKind } from '../types';
import { RunNotFoundError, WorkflowNotFoundError } from '../../utils/errors';
import type { ConcurrencyManager } from './concurrency';

/**
 * Callback the engine provides for actually launching a run. Lifecycle uses
 * it to start a resumed run with its checkpoint; the engine's implementation
 * registers the abort controller, schedules the launch via the concurrency
 * manager, and invokes the orchestrator.
 */
export type LaunchRunFn = (
  runId: string,
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  delay?: number,
  checkpoint?: { completedStepKeys: Set<string>; results: Record<string, unknown> }
) => void;

export interface LifecycleManagerDeps {
  storage: StorageAdapter;
  events: EventTransport;
  logger: Logger;
  registry: Map<WorkflowKind, WorkflowDefinition>;
  concurrency: ConcurrencyManager;
  launchRun: LaunchRunFn;
}

export class LifecycleManager {
  private readonly storage: StorageAdapter;
  private readonly events: EventTransport;
  private readonly logger: Logger;
  private readonly registry: Map<WorkflowKind, WorkflowDefinition>;
  private readonly concurrency: ConcurrencyManager;
  private readonly launchRun: LaunchRunFn;

  constructor(deps: LifecycleManagerDeps) {
    this.storage = deps.storage;
    this.events = deps.events;
    this.logger = deps.logger;
    this.registry = deps.registry;
    this.concurrency = deps.concurrency;
    this.launchRun = deps.launchRun;
  }

  /**
   * Initialize the engine's storage adapter if it requires it.
   * Safe to call when the adapter has no `initialize` hook.
   */
  async initialize(): Promise<void> {
    if (this.storage.initialize) {
      await this.storage.initialize();
    }
  }

  /**
   * Shutdown the engine gracefully:
   *   1. clear pending timer handles (so no further launches fire)
   *   2. abort all in-flight runs
   *   3. close the event transport
   *   4. close the storage adapter
   *   5. drop active-run bookkeeping
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down workflow engine...');

    this.concurrency.clearTimers();

    this.concurrency.abortAllActive((runId) => {
      this.logger.debug(`Canceling active run: ${runId}`);
    });

    if (this.events.close) {
      this.events.close();
    }

    if (this.storage.close) {
      await this.storage.close();
    }

    this.concurrency.clearActive();
    this.logger.info('Workflow engine shutdown complete');
  }

  /**
   * Resume an interrupted workflow run from its checkpoint.
   * The run must be in 'queued' or 'running' status.
   */
  async resumeRun(runId: string): Promise<string> {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }

    if (!['queued', 'running'].includes(run.status)) {
      throw new Error(`Cannot resume run ${runId}: status is "${run.status}"`);
    }

    const definition = this.registry.get(run.kind);
    if (!definition) {
      throw new WorkflowNotFoundError(run.kind);
    }

    if (this.concurrency.isActive(runId)) {
      this.logger.warn(`Run ${runId} is already active, skipping resume`);
      return runId;
    }

    this.logger.info(`Resuming run ${runId} from checkpoint`);

    const completedStepKeys = new Set(run.completedSteps ?? []);

    this.launchRun(runId, definition, run.input, run.metadata, undefined, {
      completedStepKeys,
      results: run.context,
    });

    return runId;
  }

  /**
   * Get all runs that were interrupted and can be resumed.
   * Returns runs with status 'queued' or 'running'.
   */
  async getResumableRuns(): Promise<WorkflowRunRecord[]> {
    const result = await this.storage.listRuns({
      status: ['queued', 'running'],
    });
    return result.items;
  }

  /**
   * Resume every interrupted run whose workflow kind is currently registered.
   * Useful for recovering after a server restart.
   */
  async resumeAllInterrupted(): Promise<string[]> {
    const resumableRuns = await this.getResumableRuns();
    const resumedIds: string[] = [];

    for (const run of resumableRuns) {
      if (this.registry.has(run.kind)) {
        try {
          await this.resumeRun(run.id);
          resumedIds.push(run.id);
        } catch (error) {
          this.logger.error(`Failed to resume run ${run.id}:`, error);
        }
      } else {
        this.logger.warn(`Cannot resume run ${run.id}: workflow "${run.kind}" not registered`);
      }
    }

    return resumedIds;
  }
}
