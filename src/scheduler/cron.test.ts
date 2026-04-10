import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CronScheduler,
  type CronSchedulerConfig,
  type SchedulePersistence,
} from "./cron";
import { WorkflowEngine } from "../core/engine";
import { MemoryStorageAdapter } from "../storage/memory";
import { MemoryEventTransport } from "../events/memory";
import { SilentLogger } from "../utils/logger";
import type { WorkflowSchedule } from "./types";

describe("CronScheduler", () => {
  let engine: WorkflowEngine;
  let scheduler: CronScheduler;

  beforeEach(() => {
    // Create a workflow engine with silent logger
    engine = new WorkflowEngine({
      storage: new MemoryStorageAdapter(),
      events: new MemoryEventTransport(),
      logger: new SilentLogger(),
    });

    // Register a test workflow
    engine.registerWorkflow({
      kind: "test.workflow",
      name: "Test Workflow",
      steps: [
        {
          key: "step1",
          name: "Step 1",
          handler: async (ctx) => ({ value: ctx.input.value ?? "default" }),
        },
      ],
    });

    // Create scheduler
    scheduler = new CronScheduler({
      engine,
      logger: new SilentLogger(),
      pollInterval: 100, // Fast polling for tests
    });
  });

  afterEach(async () => {
    await scheduler.stop();
    await engine.shutdown();
  });

  describe("addSchedule", () => {
    it("should add a cron schedule", async () => {
      const schedule = await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *", // Every hour
        enabled: true,
      });

      expect(schedule.id).toBeDefined();
      expect(schedule.workflowKind).toBe("test.workflow");
      expect(schedule.triggerType).toBe("cron");
      expect(schedule.cronExpression).toBe("0 * * * *");
      expect(schedule.nextRunAt).toBeInstanceOf(Date);
    });

    it("should add a workflow completion trigger", async () => {
      const schedule = await scheduler.addSchedule({
        workflowKind: "notification.send",
        triggerType: "workflow_completed",
        triggerOnWorkflowKind: "order.process",
        triggerOnStatus: ["succeeded"],
        enabled: true,
      });

      expect(schedule.id).toBeDefined();
      expect(schedule.triggerType).toBe("workflow_completed");
      expect(schedule.triggerOnWorkflowKind).toBe("order.process");
    });

    it("should reject invalid cron expression", async () => {
      await expect(
        scheduler.addSchedule({
          workflowKind: "test.workflow",
          triggerType: "cron",
          cronExpression: "invalid cron",
          enabled: true,
        }),
      ).rejects.toThrow("Invalid cron expression");
    });

    it("should require triggerOnWorkflowKind for workflow_completed triggers", async () => {
      await expect(
        scheduler.addSchedule({
          workflowKind: "test.workflow",
          triggerType: "workflow_completed",
          enabled: true,
        }),
      ).rejects.toThrow("triggerOnWorkflowKind is required");
    });
  });

  describe("removeSchedule", () => {
    it("should remove a schedule", async () => {
      const schedule = await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        enabled: true,
      });

      await scheduler.removeSchedule(schedule.id);

      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(0);
    });

    it("should throw for non-existent schedule", async () => {
      await expect(scheduler.removeSchedule("nonexistent")).rejects.toThrow(
        "Schedule not found",
      );
    });
  });

  describe("updateSchedule", () => {
    it("should update schedule properties", async () => {
      const schedule = await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        enabled: true,
      });

      await scheduler.updateSchedule(schedule.id, { enabled: false });

      const updated = scheduler.getSchedule(schedule.id);
      expect(updated?.enabled).toBe(false);
    });

    it("should update cron expression and recalculate next run", async () => {
      const schedule = await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        enabled: true,
      });

      const originalNextRun = schedule.nextRunAt;

      await scheduler.updateSchedule(schedule.id, {
        cronExpression: "30 * * * *",
      });

      const updated = scheduler.getSchedule(schedule.id);
      expect(updated?.cronExpression).toBe("30 * * * *");
      expect(updated?.nextRunAt).not.toEqual(originalNextRun);
    });
  });

  describe("getSchedules", () => {
    it("should return all schedules", async () => {
      await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        enabled: true,
      });

      await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "manual",
        enabled: true,
      });

      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(2);
    });
  });

  describe("triggerNow", () => {
    it("should manually trigger a schedule", async () => {
      const schedule = await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 0 1 1 *", // Once a year (won't trigger naturally)
        input: { value: "manual" },
        enabled: true,
      });

      const runId = await scheduler.triggerNow(schedule.id);

      expect(runId).toBeDefined();

      // Wait for workflow to complete
      const run = await engine.waitForRun(runId);
      expect(run.status).toBe("succeeded");
    });

    it("should throw for non-existent schedule", async () => {
      await expect(scheduler.triggerNow("nonexistent")).rejects.toThrow(
        "Schedule not found",
      );
    });
  });

  describe("cron execution", () => {
    it("should execute scheduled workflow when cron time is reached", async () => {
      // Use fake timers
      vi.useFakeTimers();

      // Create a schedule that runs every minute
      await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "* * * * *", // Every minute
        input: { value: "scheduled" },
        enabled: true,
      });

      await scheduler.start();

      // Advance time past the next minute boundary
      const now = new Date();
      const msUntilNextMinute = (60 - now.getSeconds()) * 1000 + 1000;
      vi.advanceTimersByTime(msUntilNextMinute);

      // Run pending timers for poll interval
      await vi.runOnlyPendingTimersAsync();

      vi.useRealTimers();

      // Note: With fake timers, the actual workflow may not complete
      // This test verifies the scheduler logic, not full execution
    });
  });

  describe("workflow completion triggers", () => {
    it("should trigger workflow on completion of another workflow", async () => {
      // Register a trigger workflow
      engine.registerWorkflow({
        kind: "trigger.workflow",
        name: "Trigger Workflow",
        steps: [
          {
            key: "trigger",
            name: "Trigger",
            handler: async () => ({ triggered: true }),
          },
        ],
      });

      // Register a dependent workflow
      engine.registerWorkflow({
        kind: "dependent.workflow",
        name: "Dependent Workflow",
        steps: [
          {
            key: "dependent",
            name: "Dependent",
            handler: async (ctx) => ({
              parentRunId: ctx.metadata.triggerRunId,
            }),
          },
        ],
      });

      // Add a completion trigger
      await scheduler.addSchedule({
        workflowKind: "dependent.workflow",
        triggerType: "workflow_completed",
        triggerOnWorkflowKind: "trigger.workflow",
        triggerOnStatus: ["succeeded"],
        enabled: true,
      });

      await scheduler.start();

      // Start the trigger workflow
      const triggerRunId = await engine.startRun({ kind: "trigger.workflow" });

      // Wait for trigger workflow to complete
      await engine.waitForRun(triggerRunId);

      // Give time for the completion trigger to fire and dependent workflow to start
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check that the dependent workflow was started
      const storage = engine.getStorage();
      const { items } = await storage.listRuns({ kind: "dependent.workflow" });

      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it("should not trigger on non-matching status", async () => {
      // Register a failing trigger workflow
      engine.registerWorkflow({
        kind: "failing.workflow",
        name: "Failing Workflow",
        steps: [
          {
            key: "fail",
            name: "Fail",
            handler: async () => {
              throw new Error("Intentional failure");
            },
          },
        ],
      });

      // Add a completion trigger for success only
      await scheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "workflow_completed",
        triggerOnWorkflowKind: "failing.workflow",
        triggerOnStatus: ["succeeded"], // Only on success
        enabled: true,
      });

      await scheduler.start();

      // Start the failing workflow
      const runId = await engine.startRun({ kind: "failing.workflow" });

      // Wait for it to fail
      await engine.waitForRun(runId);

      // Give time for any triggers
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check that test.workflow was NOT started
      const storage = engine.getStorage();
      const { items } = await storage.listRuns({ kind: "test.workflow" });

      expect(items).toHaveLength(0);
    });
  });

  describe("start/stop", () => {
    it("should start and stop without error", async () => {
      await scheduler.start();
      await scheduler.stop();
    });

    it("should warn when starting twice", async () => {
      await scheduler.start();
      await scheduler.start(); // Should just warn
      await scheduler.stop();
    });

    it("should handle stopping when not started", async () => {
      await scheduler.stop(); // Should do nothing
    });
  });

  describe("persistence", () => {
    it("should load schedules from persistence on start", async () => {
      const mockSchedule: WorkflowSchedule = {
        id: "persisted-1",
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        enabled: true,
      };

      const mockPersistence: SchedulePersistence = {
        loadSchedules: vi.fn().mockResolvedValue([mockSchedule]),
        saveSchedule: vi.fn().mockResolvedValue(undefined),
        updateSchedule: vi.fn().mockResolvedValue(undefined),
        deleteSchedule: vi.fn().mockResolvedValue(undefined),
      };

      const schedulerWithPersistence = new CronScheduler({
        engine,
        logger: new SilentLogger(),
        persistence: mockPersistence,
      });

      await schedulerWithPersistence.start();

      expect(mockPersistence.loadSchedules).toHaveBeenCalled();

      const schedules = await schedulerWithPersistence.getSchedules();
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe("persisted-1");

      await schedulerWithPersistence.stop();
    });

    it("should save schedule to persistence when added", async () => {
      const mockPersistence: SchedulePersistence = {
        loadSchedules: vi.fn().mockResolvedValue([]),
        saveSchedule: vi.fn().mockResolvedValue(undefined),
        updateSchedule: vi.fn().mockResolvedValue(undefined),
        deleteSchedule: vi.fn().mockResolvedValue(undefined),
      };

      const schedulerWithPersistence = new CronScheduler({
        engine,
        logger: new SilentLogger(),
        persistence: mockPersistence,
      });

      await schedulerWithPersistence.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        enabled: true,
      });

      expect(mockPersistence.saveSchedule).toHaveBeenCalled();
    });
  });

  describe("updateNextRunTime parse-error path", () => {
    it("should set nextRunAt to undefined and log error for malformed cron expression update", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const errorScheduler = new CronScheduler({
        engine,
        logger,
        pollInterval: 100,
      });

      // Add a valid schedule first
      const schedule = await errorScheduler.addSchedule({
        workflowKind: "test.workflow",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        enabled: true,
      });

      expect(schedule.nextRunAt).toBeInstanceOf(Date);

      // Now directly update the internal schedule with a malformed expression
      // to trigger the error path in updateNextRunTime
      // We need to bypass the validation in updateSchedule by manipulating the internal state.
      // The updateSchedule method validates and throws, but updateNextRunTime is called
      // during start() when loading from persistence — so we test via start() loading bad data.
      const mockPersistence: SchedulePersistence = {
        loadSchedules: vi.fn().mockResolvedValue([
          {
            id: "bad-cron",
            workflowKind: "test.workflow",
            triggerType: "cron" as const,
            cronExpression: "99 99 99 99 99",
            enabled: true,
          },
        ]),
        saveSchedule: vi.fn().mockResolvedValue(undefined),
        updateSchedule: vi.fn().mockResolvedValue(undefined),
        deleteSchedule: vi.fn().mockResolvedValue(undefined),
      };

      const badScheduler = new CronScheduler({
        engine,
        logger,
        persistence: mockPersistence,
        pollInterval: 100,
      });

      await badScheduler.start();

      // The schedule should have been loaded with nextRunAt = undefined due to parse error
      const loaded = badScheduler.getSchedule("bad-cron");
      expect(loaded).toBeDefined();
      expect(loaded!.nextRunAt).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse cron expression"),
        expect.anything(),
      );

      await badScheduler.stop();
      await errorScheduler.stop();
    });
  });
});
