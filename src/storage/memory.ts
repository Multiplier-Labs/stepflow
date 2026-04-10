/**
 * In-memory storage adapter for development and testing.
 * All data is lost when the process exits.
 *
 * NOTE: This adapter is intended for development and testing only. It stores
 * all state in-process with no persistence or multi-process safety guarantees.
 */

import { generateId } from "../utils/id";
import type {
  StorageAdapter,
  WorkflowRunRecord,
  WorkflowRunStepRecord,
  WorkflowEventRecord,
  ListRunsOptions,
  ListEventsOptions,
  PaginatedResult,
} from "./types";

/**
 * In-memory implementation of StorageAdapter.
 * Useful for development, testing, and lightweight deployments.
 *
 * @example
 * ```typescript
 * import { WorkflowEngine } from 'stepflow';
 * import { MemoryStorageAdapter } from 'stepflow/storage';
 *
 * const storage = new MemoryStorageAdapter();
 * const engine = new WorkflowEngine({ storage });
 * ```
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private runs = new Map<string, WorkflowRunRecord>();
  private steps = new Map<string, WorkflowRunStepRecord>();
  private events = new Map<string, WorkflowEventRecord>();

  // ============================================================================
  // Run Operations
  // ============================================================================

  /** Create and persist a new workflow run record. */
  async createRun(
    run: Omit<WorkflowRunRecord, "id" | "createdAt">,
  ): Promise<WorkflowRunRecord> {
    const record: WorkflowRunRecord = {
      ...run,
      id: generateId(),
      createdAt: new Date(),
    };
    this.runs.set(record.id, record);
    return record;
  }

  /** Retrieve a workflow run by ID, or null if not found. */
  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  /** Apply partial updates to an existing workflow run. No-op if the run does not exist. */
  async updateRun(
    runId: string,
    updates: Partial<WorkflowRunRecord>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      Object.assign(run, updates);
    }
  }

  /** List workflow runs with optional filtering, sorting, and pagination. */
  async listRuns(
    options: ListRunsOptions = {},
  ): Promise<PaginatedResult<WorkflowRunRecord>> {
    let items = Array.from(this.runs.values());

    // Filter by kind
    if (options.kind) {
      items = items.filter((r) => r.kind === options.kind);
    }

    // Filter by status
    if (options.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      items = items.filter((r) => statuses.includes(r.status));
    }

    // Filter by parentRunId
    if (options.parentRunId !== undefined) {
      items = items.filter((r) => r.parentRunId === options.parentRunId);
    }

    // Sort
    const orderBy = options.orderBy ?? "createdAt";
    const direction = options.orderDirection ?? "desc";
    items.sort((a, b) => {
      const aVal = a[orderBy]?.getTime() ?? 0;
      const bVal = b[orderBy]?.getTime() ?? 0;
      return direction === "asc" ? aVal - bVal : bVal - aVal;
    });

    const total = items.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;

    items = items.slice(offset, offset + limit);

    return { items, total, limit, offset };
  }

  // ============================================================================
  // Step Operations
  // ============================================================================

  /** Create and persist a new step execution record. */
  async createStep(
    step: Omit<WorkflowRunStepRecord, "id">,
  ): Promise<WorkflowRunStepRecord> {
    const record: WorkflowRunStepRecord = {
      ...step,
      id: generateId(),
    };
    this.steps.set(record.id, record);
    return record;
  }

  /** Retrieve a step record by ID, or null if not found. */
  async getStep(stepId: string): Promise<WorkflowRunStepRecord | null> {
    return this.steps.get(stepId) ?? null;
  }

  /** Apply partial updates to an existing step record. No-op if the step does not exist. */
  async updateStep(
    stepId: string,
    updates: Partial<WorkflowRunStepRecord>,
  ): Promise<void> {
    const step = this.steps.get(stepId);
    if (step) {
      Object.assign(step, updates);
    }
  }

  /** Retrieve all step records for a workflow run, ordered by start time ascending. */
  async getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]> {
    return Array.from(this.steps.values())
      .filter((s) => s.runId === runId)
      .sort(
        (a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0),
      );
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  /** Persist a workflow event record. */
  async saveEvent(event: Omit<WorkflowEventRecord, "id">): Promise<void> {
    const record: WorkflowEventRecord = {
      ...event,
      id: generateId(),
    };
    this.events.set(record.id, record);
  }

  /** Retrieve events for a workflow run with optional filtering and pagination. */
  async getEventsForRun(
    runId: string,
    options: ListEventsOptions = {},
  ): Promise<WorkflowEventRecord[]> {
    let items = Array.from(this.events.values()).filter(
      (e) => e.runId === runId,
    );

    // Filter by step
    if (options.stepKey) {
      items = items.filter((e) => e.stepKey === options.stepKey);
    }

    // Filter by level
    if (options.level) {
      items = items.filter((e) => e.level === options.level);
    }

    // Sort by timestamp
    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;

    return items.slice(offset, offset + limit);
  }

  // ============================================================================
  // Optional Operations
  // ============================================================================

  /** Delete runs (and their associated steps and events) created before the given date. Returns the number of deleted runs. */
  async deleteOldRuns(olderThan: Date): Promise<number> {
    let deleted = 0;
    for (const [id, run] of this.runs) {
      if (run.createdAt < olderThan) {
        // Delete associated steps
        for (const [stepId, step] of this.steps) {
          if (step.runId === id) {
            this.steps.delete(stepId);
          }
        }
        // Delete associated events
        for (const [eventId, event] of this.events) {
          if (event.runId === id) {
            this.events.delete(eventId);
          }
        }
        // Delete run
        this.runs.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  // ============================================================================
  // Testing Utilities
  // ============================================================================

  /**
   * Clear all stored data. Useful for testing.
   */
  clear(): void {
    this.runs.clear();
    this.steps.clear();
    this.events.clear();
  }

  /**
   * Get counts of stored records. Useful for testing.
   */
  getStats(): { runs: number; steps: number; events: number } {
    return {
      runs: this.runs.size,
      steps: this.steps.size,
      events: this.events.size,
    };
  }
}
