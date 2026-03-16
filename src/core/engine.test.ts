import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { MemoryStorageAdapter } from '../storage/memory';
import { MemoryEventTransport } from '../events/memory';
import { SilentLogger } from '../utils/logger';
import type { WorkflowDefinition, WorkflowEvent } from '../index';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;
  let storage: MemoryStorageAdapter;
  let events: MemoryEventTransport;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    events = new MemoryEventTransport();
    engine = new WorkflowEngine({
      storage,
      events,
      logger: new SilentLogger(),
    });
  });

  describe('registerWorkflow', () => {
    it('should register a workflow definition', () => {
      const workflow: WorkflowDefinition = {
        kind: 'test.workflow',
        name: 'Test Workflow',
        steps: [],
      };

      engine.registerWorkflow(workflow);

      expect(engine.getWorkflow('test.workflow')).toBeDefined();
      expect(engine.getRegisteredWorkflows()).toContain('test.workflow');
    });

    it('should throw if workflow is already registered', () => {
      const workflow: WorkflowDefinition = {
        kind: 'test.workflow',
        name: 'Test Workflow',
        steps: [],
      };

      engine.registerWorkflow(workflow);

      expect(() => engine.registerWorkflow(workflow)).toThrow(
        'Workflow "test.workflow" is already registered'
      );
    });
  });

  describe('unregisterWorkflow', () => {
    it('should unregister a workflow', () => {
      const workflow: WorkflowDefinition = {
        kind: 'test.workflow',
        name: 'Test Workflow',
        steps: [],
      };

      engine.registerWorkflow(workflow);
      expect(engine.unregisterWorkflow('test.workflow')).toBe(true);
      expect(engine.getWorkflow('test.workflow')).toBeUndefined();
    });

    it('should return false if workflow not found', () => {
      expect(engine.unregisterWorkflow('nonexistent')).toBe(false);
    });
  });

  describe('startRun', () => {
    it('should throw if workflow is not registered', async () => {
      await expect(engine.startRun({ kind: 'nonexistent' })).rejects.toThrow(
        'Workflow "nonexistent" is not registered'
      );
    });

    it('should start a workflow run and return run ID', async () => {
      engine.registerWorkflow({
        kind: 'test.workflow',
        name: 'Test Workflow',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => 'result1',
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.workflow' });

      expect(runId).toBeDefined();
      expect(typeof runId).toBe('string');
    });

    it('should execute steps in order', async () => {
      const executionOrder: string[] = [];

      engine.registerWorkflow({
        kind: 'test.order',
        name: 'Test Order',
        steps: [
          {
            key: 'first',
            name: 'First',
            handler: async () => {
              executionOrder.push('first');
              return 'first';
            },
          },
          {
            key: 'second',
            name: 'Second',
            handler: async () => {
              executionOrder.push('second');
              return 'second';
            },
          },
          {
            key: 'third',
            name: 'Third',
            handler: async () => {
              executionOrder.push('third');
              return 'third';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.order' });
      const run = await engine.waitForRun(runId);

      expect(run.status).toBe('succeeded');
      expect(executionOrder).toEqual(['first', 'second', 'third']);
    });

    it('should pass accumulated results to steps via context', async () => {
      let step2Input: unknown;

      engine.registerWorkflow({
        kind: 'test.results',
        name: 'Test Results',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => ({ value: 42 }),
          },
          {
            key: 'step2',
            name: 'Step 2',
            handler: async (ctx) => {
              step2Input = ctx.results.step1;
              return { doubled: (ctx.results.step1 as { value: number }).value * 2 };
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.results' });
      const run = await engine.waitForRun(runId);

      expect(run.status).toBe('succeeded');
      expect(step2Input).toEqual({ value: 42 });
      expect(run.context).toEqual({
        step1: { value: 42 },
        step2: { doubled: 84 },
      });
    });

    it('should pass input to context', async () => {
      let receivedInput: unknown;

      engine.registerWorkflow({
        kind: 'test.input',
        name: 'Test Input',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async (ctx) => {
              receivedInput = ctx.input;
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({
        kind: 'test.input',
        input: { foo: 'bar', num: 123 },
      });
      await engine.waitForRun(runId);

      expect(receivedInput).toEqual({ foo: 'bar', num: 123 });
    });

    it('should pass metadata to context', async () => {
      let receivedMetadata: unknown;

      engine.registerWorkflow({
        kind: 'test.metadata',
        name: 'Test Metadata',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async (ctx) => {
              receivedMetadata = ctx.metadata;
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({
        kind: 'test.metadata',
        metadata: { userId: 'user123', topicId: 'topic456' },
      });
      await engine.waitForRun(runId);

      expect(receivedMetadata).toEqual({ userId: 'user123', topicId: 'topic456' });
    });
  });

  describe('error handling', () => {
    it('should fail the run when a step throws (default strategy)', async () => {
      engine.registerWorkflow({
        kind: 'test.fail',
        name: 'Test Fail',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              throw new Error('Step failed!');
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.fail' });
      const run = await engine.waitForRun(runId);

      expect(run.status).toBe('failed');
      expect(run.error?.message).toContain('Step failed!');
    });

    it('should skip step when onError is "skip"', async () => {
      const executionOrder: string[] = [];

      engine.registerWorkflow({
        kind: 'test.skip',
        name: 'Test Skip',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              executionOrder.push('step1');
              throw new Error('This will be skipped');
            },
            onError: 'skip',
          },
          {
            key: 'step2',
            name: 'Step 2',
            handler: async () => {
              executionOrder.push('step2');
              return 'step2';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.skip' });
      const run = await engine.waitForRun(runId);

      expect(run.status).toBe('succeeded');
      expect(executionOrder).toEqual(['step1', 'step2']);
    });

    it('should retry step when onError is "retry"', async () => {
      let attempts = 0;

      engine.registerWorkflow({
        kind: 'test.retry',
        name: 'Test Retry',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              attempts++;
              if (attempts < 3) {
                throw new Error(`Attempt ${attempts} failed`);
              }
              return 'success';
            },
            onError: 'retry',
            maxRetries: 5,
            retryDelay: 10,
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.retry' });
      const run = await engine.waitForRun(runId);

      expect(run.status).toBe('succeeded');
      expect(attempts).toBe(3);
    });

    it('should fail after exhausting retries', async () => {
      let attempts = 0;

      engine.registerWorkflow({
        kind: 'test.retry.exhaust',
        name: 'Test Retry Exhaust',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              attempts++;
              throw new Error(`Attempt ${attempts} failed`);
            },
            onError: 'retry',
            maxRetries: 2,
            retryDelay: 10,
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.retry.exhaust' });
      const run = await engine.waitForRun(runId);

      expect(run.status).toBe('failed');
      expect(attempts).toBe(3); // 1 initial + 2 retries
    });
  });

  describe('skipIf condition', () => {
    it('should skip step when skipIf returns true', async () => {
      const executionOrder: string[] = [];

      engine.registerWorkflow({
        kind: 'test.skipif',
        name: 'Test SkipIf',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              executionOrder.push('step1');
              return { skip: true };
            },
          },
          {
            key: 'step2',
            name: 'Step 2',
            handler: async () => {
              executionOrder.push('step2');
              return 'step2';
            },
            skipIf: async (ctx) => (ctx.results.step1 as { skip: boolean }).skip,
          },
          {
            key: 'step3',
            name: 'Step 3',
            handler: async () => {
              executionOrder.push('step3');
              return 'step3';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.skipif' });
      const run = await engine.waitForRun(runId);

      expect(run.status).toBe('succeeded');
      expect(executionOrder).toEqual(['step1', 'step3']);
    });
  });

  describe('events', () => {
    it('should emit events during workflow execution', async () => {
      const receivedEvents: WorkflowEvent[] = [];

      engine.registerWorkflow({
        kind: 'test.events',
        name: 'Test Events',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => 'result',
          },
        ],
      });

      const unsubscribe = engine.subscribeToAll((event) => {
        receivedEvents.push(event);
      });

      const runId = await engine.startRun({ kind: 'test.events' });
      await engine.waitForRun(runId);
      unsubscribe();

      const eventTypes = receivedEvents.map(e => e.eventType);
      expect(eventTypes).toContain('run.created');
      expect(eventTypes).toContain('run.started');
      expect(eventTypes).toContain('step.started');
      expect(eventTypes).toContain('step.completed');
      expect(eventTypes).toContain('run.completed');
    });

    it('should emit custom events via context.emit', async () => {
      const receivedEvents: WorkflowEvent[] = [];

      engine.registerWorkflow({
        kind: 'test.custom.events',
        name: 'Test Custom Events',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async (ctx) => {
              ctx.emit('custom.progress', { percent: 50 });
              ctx.emit('custom.progress', { percent: 100 });
              return 'done';
            },
          },
        ],
      });

      const unsubscribe = engine.subscribeToAll((event) => {
        receivedEvents.push(event);
      });

      const runId = await engine.startRun({ kind: 'test.custom.events' });
      await engine.waitForRun(runId);
      unsubscribe();

      const customEvents = receivedEvents.filter(e => e.eventType === 'custom.progress');
      expect(customEvents).toHaveLength(2);
      expect(customEvents[0].payload).toEqual({ percent: 50 });
      expect(customEvents[1].payload).toEqual({ percent: 100 });
    });
  });

  describe('cancelRun', () => {
    it('should cancel a running workflow', async () => {
      engine.registerWorkflow({
        kind: 'test.cancel',
        name: 'Test Cancel',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              // Simulate long-running step
              await new Promise(resolve => setTimeout(resolve, 1000));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.cancel' });

      // Cancel after a short delay
      await new Promise(resolve => setTimeout(resolve, 50));
      await engine.cancelRun(runId);

      const run = await engine.waitForRun(runId, { timeout: 2000 });
      expect(run.status).toBe('canceled');
    });
  });

  describe('hooks', () => {
    it('should call beforeRun and afterRun hooks', async () => {
      const hookCalls: string[] = [];

      engine.registerWorkflow({
        kind: 'test.hooks',
        name: 'Test Hooks',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              hookCalls.push('step1');
              return 'done';
            },
          },
        ],
        hooks: {
          beforeRun: async () => {
            hookCalls.push('beforeRun');
          },
          afterRun: async (_, result) => {
            hookCalls.push(`afterRun:${result.status}`);
          },
        },
      });

      const runId = await engine.startRun({ kind: 'test.hooks' });
      await engine.waitForRun(runId);

      expect(hookCalls).toEqual(['beforeRun', 'step1', 'afterRun:succeeded']);
    });

    it('should call beforeStep and afterStep hooks', async () => {
      const hookCalls: string[] = [];

      engine.registerWorkflow({
        kind: 'test.step.hooks',
        name: 'Test Step Hooks',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => 'result1',
          },
          {
            key: 'step2',
            name: 'Step 2',
            handler: async () => 'result2',
          },
        ],
        hooks: {
          beforeStep: async (_, step) => {
            hookCalls.push(`before:${step.key}`);
          },
          afterStep: async (_, step) => {
            hookCalls.push(`after:${step.key}`);
          },
        },
      });

      const runId = await engine.startRun({ kind: 'test.step.hooks' });
      await engine.waitForRun(runId);

      expect(hookCalls).toEqual([
        'before:step1',
        'after:step1',
        'before:step2',
        'after:step2',
      ]);
    });
  });

  describe('storage', () => {
    it('should persist run records', async () => {
      engine.registerWorkflow({
        kind: 'test.storage',
        name: 'Test Storage',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => 'result',
          },
        ],
      });

      const runId = await engine.startRun({
        kind: 'test.storage',
        input: { foo: 'bar' },
        metadata: { userId: 'user1' },
      });
      await engine.waitForRun(runId);

      const run = await storage.getRun(runId);
      expect(run).toBeDefined();
      expect(run?.kind).toBe('test.storage');
      expect(run?.status).toBe('succeeded');
      expect(run?.input).toEqual({ foo: 'bar' });
      expect(run?.metadata).toEqual({ userId: 'user1' });
    });

    it('should persist step records', async () => {
      engine.registerWorkflow({
        kind: 'test.step.storage',
        name: 'Test Step Storage',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => 'result1',
          },
          {
            key: 'step2',
            name: 'Step 2',
            handler: async () => 'result2',
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.step.storage' });
      await engine.waitForRun(runId);

      const steps = await storage.getStepsForRun(runId);
      expect(steps).toHaveLength(2);
      expect(steps[0].stepKey).toBe('step1');
      expect(steps[0].status).toBe('succeeded');
      expect(steps[1].stepKey).toBe('step2');
      expect(steps[1].status).toBe('succeeded');
    });
  });

  describe('workflow timeout', () => {
    it('should timeout a long-running workflow', async () => {
      engine.registerWorkflow({
        kind: 'test.timeout',
        name: 'Test Timeout',
        timeout: 100, // 100ms timeout
        steps: [
          {
            key: 'slow_step',
            name: 'Slow Step',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 500));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.timeout' });
      const run = await engine.waitForRun(runId, { timeout: 2000 });

      expect(run.status).toBe('failed');
      expect(run.error?.code).toBe('WORKFLOW_TIMEOUT');
    });

    it('should complete before timeout if fast enough', async () => {
      engine.registerWorkflow({
        kind: 'test.fast',
        name: 'Test Fast',
        timeout: 1000, // 1s timeout
        steps: [
          {
            key: 'fast_step',
            name: 'Fast Step',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 10));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.fast' });
      const run = await engine.waitForRun(runId, { timeout: 2000 });

      expect(run.status).toBe('succeeded');
    });

    it('should emit run.timeout event', async () => {
      const receivedEvents: WorkflowEvent[] = [];

      engine.registerWorkflow({
        kind: 'test.timeout.event',
        name: 'Test Timeout Event',
        timeout: 50,
        steps: [
          {
            key: 'slow_step',
            name: 'Slow Step',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 500));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.timeout.event' });
      engine.subscribeToRun(runId, (event) => {
        receivedEvents.push(event);
      });

      await engine.waitForRun(runId, { timeout: 2000 });

      expect(receivedEvents.some(e => e.eventType === 'run.timeout')).toBe(true);
    });
  });

  describe('concurrency control', () => {
    it('should limit concurrent runs with maxConcurrency', async () => {
      const concurrentEngine = new WorkflowEngine({
        storage: new MemoryStorageAdapter(),
        events: new MemoryEventTransport(),
        logger: new SilentLogger(),
        settings: {
          maxConcurrency: 2,
        },
      });

      concurrentEngine.registerWorkflow({
        kind: 'test.concurrent',
        name: 'Test Concurrent',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 100));
              return 'done';
            },
          },
        ],
      });

      // Start 4 runs
      const runIds = await Promise.all([
        concurrentEngine.startRun({ kind: 'test.concurrent' }),
        concurrentEngine.startRun({ kind: 'test.concurrent' }),
        concurrentEngine.startRun({ kind: 'test.concurrent' }),
        concurrentEngine.startRun({ kind: 'test.concurrent' }),
      ]);

      // Check that only 2 are active and 2 are queued
      expect(concurrentEngine.getActiveRunCount()).toBe(2);
      expect(concurrentEngine.getQueuedRunCount()).toBe(2);

      // Wait for all to complete
      await Promise.all(runIds.map(id => concurrentEngine.waitForRun(id, { timeout: 2000 })));

      expect(concurrentEngine.getActiveRunCount()).toBe(0);
      expect(concurrentEngine.getQueuedRunCount()).toBe(0);

      await concurrentEngine.shutdown();
    });

    it('should process queue in order when runs complete', async () => {
      const completionOrder: string[] = [];

      const concurrentEngine = new WorkflowEngine({
        storage: new MemoryStorageAdapter(),
        events: new MemoryEventTransport(),
        logger: new SilentLogger(),
        settings: {
          maxConcurrency: 1,
        },
      });

      concurrentEngine.registerWorkflow({
        kind: 'test.queue.order',
        name: 'Test Queue Order',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async (ctx) => {
              completionOrder.push(ctx.input.id as string);
              return 'done';
            },
          },
        ],
      });

      // Start 3 runs in order
      const runIds = await Promise.all([
        concurrentEngine.startRun({ kind: 'test.queue.order', input: { id: 'first' } }),
        concurrentEngine.startRun({ kind: 'test.queue.order', input: { id: 'second' } }),
        concurrentEngine.startRun({ kind: 'test.queue.order', input: { id: 'third' } }),
      ]);

      // Wait for all to complete
      await Promise.all(runIds.map(id => concurrentEngine.waitForRun(id, { timeout: 2000 })));

      // Should complete in order (FIFO)
      expect(completionOrder).toEqual(['first', 'second', 'third']);

      await concurrentEngine.shutdown();
    });
  });

  describe('initialize', () => {
    it('should call storage.initialize if available', async () => {
      const initFn = vi.fn();
      const customStorage = new MemoryStorageAdapter();
      (customStorage as any).initialize = initFn;

      const eng = new WorkflowEngine({
        storage: customStorage,
        events,
        logger: new SilentLogger(),
      });

      await eng.initialize();
      expect(initFn).toHaveBeenCalledTimes(1);
    });

    it('should not throw if storage has no initialize', async () => {
      await expect(engine.initialize()).resolves.not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should cancel active runs and close resources', async () => {
      engine.registerWorkflow({
        kind: 'test.shutdown',
        name: 'Test Shutdown',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 5000));
              return 'done';
            },
          },
        ],
      });

      await engine.startRun({ kind: 'test.shutdown' });
      expect(engine.getActiveRunCount()).toBe(1);

      await engine.shutdown();
      expect(engine.getActiveRunCount()).toBe(0);
    });

    it('should call events.close and storage.close if available', async () => {
      const closeFn = vi.fn();
      const storageCloseFn = vi.fn();
      const customEvents = new MemoryEventTransport();
      (customEvents as any).close = closeFn;
      const customStorage = new MemoryStorageAdapter();
      (customStorage as any).close = storageCloseFn;

      const eng = new WorkflowEngine({
        storage: customStorage,
        events: customEvents,
        logger: new SilentLogger(),
      });

      await eng.shutdown();
      expect(closeFn).toHaveBeenCalled();
      expect(storageCloseFn).toHaveBeenCalled();
    });
  });

  describe('waitForRun', () => {
    it('should throw RunNotFoundError if run does not exist', async () => {
      await expect(engine.waitForRun('nonexistent')).rejects.toThrow('not found');
    });

    it('should timeout if run never completes', async () => {
      engine.registerWorkflow({
        kind: 'test.wait.timeout',
        name: 'Test Wait Timeout',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 10000));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.wait.timeout' });

      await expect(
        engine.waitForRun(runId, { timeout: 100, pollInterval: 20 })
      ).rejects.toThrow('Timeout waiting for run');

      await engine.cancelRun(runId);
    });
  });

  describe('cancelRun', () => {
    it('should throw RunNotFoundError for non-existent run', async () => {
      await expect(engine.cancelRun('nonexistent')).rejects.toThrow('not found');
    });

    it('should update status even if run is not actively running', async () => {
      engine.registerWorkflow({
        kind: 'test.cancel.inactive',
        name: 'Test Cancel Inactive',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => 'done',
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.cancel.inactive' });
      await engine.waitForRun(runId);

      // Run is already complete — cancelRun is a no-op for terminal statuses
      await engine.cancelRun(runId);
      const run = await engine.getRunStatus(runId);
      expect(run?.status).toBe('succeeded');
    });
  });

  describe('resumeRun', () => {
    it('should throw RunNotFoundError for non-existent run', async () => {
      await expect(engine.resumeRun('nonexistent')).rejects.toThrow('not found');
    });

    it('should throw if run status is not resumable', async () => {
      engine.registerWorkflow({
        kind: 'test.resume.completed',
        name: 'Test',
        steps: [
          { key: 's1', name: 'S1', handler: async () => 'done' },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.resume.completed' });
      await engine.waitForRun(runId);

      await expect(engine.resumeRun(runId)).rejects.toThrow('Cannot resume run');
    });

    it('should throw if workflow is not registered', async () => {
      // Create a run directly in storage with a kind that is not registered
      const run = await storage.createRun({
        kind: 'unregistered.workflow',
        status: 'running',
        input: {},
        metadata: {},
        context: {},
      });

      await expect(engine.resumeRun(run.id)).rejects.toThrow('is not registered');
    });

    it('should skip resume if run is already active', async () => {
      engine.registerWorkflow({
        kind: 'test.resume.active',
        name: 'Test',
        steps: [
          {
            key: 's1',
            name: 'S1',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 500));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.resume.active' });
      // Manually set status to running for resume check
      await storage.updateRun(runId, { status: 'running' });

      // Attempt resume while the run is still active
      const result = await engine.resumeRun(runId);
      expect(result).toBe(runId);

      await engine.waitForRun(runId, { timeout: 2000 });
    });

    it('should resume from checkpoint', async () => {
      const executionOrder: string[] = [];

      engine.registerWorkflow({
        kind: 'test.resume.checkpoint',
        name: 'Test Resume',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              executionOrder.push('step1');
              return 'r1';
            },
          },
          {
            key: 'step2',
            name: 'Step 2',
            handler: async () => {
              executionOrder.push('step2');
              return 'r2';
            },
          },
        ],
      });

      // Create a run that looks interrupted with step1 already done
      const run = await storage.createRun({
        kind: 'test.resume.checkpoint',
        status: 'running',
        input: {},
        metadata: {},
        context: { step1: 'r1' },
      });

      const resumedId = await engine.resumeRun(run.id);
      expect(resumedId).toBe(run.id);

      const result = await engine.waitForRun(run.id, { timeout: 2000 });
      expect(result.status).toBe('succeeded');

      // Only step2 should have executed
      expect(executionOrder).toEqual(['step2']);
    });
  });

  describe('resumeAllInterrupted', () => {
    it('should resume all resumable runs', async () => {
      engine.registerWorkflow({
        kind: 'test.resumeAll',
        name: 'Test',
        steps: [
          { key: 's1', name: 'S1', handler: async () => 'done' },
        ],
      });

      // Create two interrupted runs
      await storage.createRun({
        kind: 'test.resumeAll',
        status: 'running',
        input: {},
        metadata: {},
        context: {},
      });
      await storage.createRun({
        kind: 'test.resumeAll',
        status: 'queued',
        input: {},
        metadata: {},
        context: {},
      });
      // One completed run (should be skipped)
      await storage.createRun({
        kind: 'test.resumeAll',
        status: 'succeeded',
        input: {},
        metadata: {},
        context: {},
      });

      const resumed = await engine.resumeAllInterrupted();
      expect(resumed).toHaveLength(2);

      // Wait for them to complete
      for (const id of resumed) {
        await engine.waitForRun(id, { timeout: 2000 });
      }
    });

    it('should skip runs for unregistered workflows', async () => {
      await storage.createRun({
        kind: 'unregistered.workflow',
        status: 'running',
        input: {},
        metadata: {},
        context: {},
      });

      const resumed = await engine.resumeAllInterrupted();
      expect(resumed).toHaveLength(0);
    });
  });

  describe('getResumableRuns', () => {
    it('should return only queued and running runs', async () => {
      await storage.createRun({ kind: 'a', status: 'queued', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'a', status: 'running', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'a', status: 'succeeded', input: {}, metadata: {}, context: {} });
      await storage.createRun({ kind: 'a', status: 'failed', input: {}, metadata: {}, context: {} });

      const resumable = await engine.getResumableRuns();
      expect(resumable).toHaveLength(2);
      expect(resumable.every(r => ['queued', 'running'].includes(r.status))).toBe(true);
    });
  });

  describe('delayed execution', () => {
    it('should delay workflow start', async () => {
      engine.registerWorkflow({
        kind: 'test.delay',
        name: 'Test Delay',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => 'done',
          },
        ],
      });

      const start = Date.now();
      const runId = await engine.startRun({ kind: 'test.delay', delay: 100 });
      const run = await engine.waitForRun(runId, { timeout: 2000 });

      expect(run.status).toBe('succeeded');
      expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    });
  });

  describe('getStorage / getEvents', () => {
    it('should return storage and events adapters', () => {
      expect(engine.getStorage()).toBe(storage);
      expect(engine.getEvents()).toBe(events);
    });
  });

  describe('subscribeToRun', () => {
    it('should receive events for specific run', async () => {
      const receivedEvents: WorkflowEvent[] = [];

      engine.registerWorkflow({
        kind: 'test.sub',
        name: 'Test',
        steps: [
          { key: 's1', name: 'S1', handler: async () => 'done' },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.sub' });
      const unsub = engine.subscribeToRun(runId, (event) => {
        receivedEvents.push(event);
      });

      await engine.waitForRun(runId);
      unsub();

      expect(receivedEvents.length).toBeGreaterThan(0);
      expect(receivedEvents.every(e => e.runId === runId)).toBe(true);
    });
  });

  describe('default constructor', () => {
    it('should use defaults when no config is provided', () => {
      const defaultEngine = new WorkflowEngine();
      expect(defaultEngine.getStorage()).toBeInstanceOf(MemoryStorageAdapter);
    });
  });

  describe('priority queues', () => {
    it('should process high priority runs first', async () => {
      const completionOrder: string[] = [];

      const priorityEngine = new WorkflowEngine({
        storage: new MemoryStorageAdapter(),
        events: new MemoryEventTransport(),
        logger: new SilentLogger(),
        settings: {
          maxConcurrency: 1,
        },
      });

      priorityEngine.registerWorkflow({
        kind: 'test.priority',
        name: 'Test Priority',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async (ctx) => {
              completionOrder.push(ctx.input.id as string);
              return 'done';
            },
          },
        ],
      });

      // Start first run (occupies the single slot)
      const firstId = await priorityEngine.startRun({
        kind: 'test.priority',
        input: { id: 'first' },
        priority: 0,
      });

      // Queue 3 runs with different priorities
      // Low priority first, then high priority
      const lowId = await priorityEngine.startRun({
        kind: 'test.priority',
        input: { id: 'low' },
        priority: 0,
      });

      const highId = await priorityEngine.startRun({
        kind: 'test.priority',
        input: { id: 'high' },
        priority: 10,
      });

      const mediumId = await priorityEngine.startRun({
        kind: 'test.priority',
        input: { id: 'medium' },
        priority: 5,
      });

      // Wait for all to complete
      await Promise.all([
        priorityEngine.waitForRun(firstId, { timeout: 2000 }),
        priorityEngine.waitForRun(lowId, { timeout: 2000 }),
        priorityEngine.waitForRun(highId, { timeout: 2000 }),
        priorityEngine.waitForRun(mediumId, { timeout: 2000 }),
      ]);

      // First should complete first (already running)
      // Then high priority, medium, low
      expect(completionOrder).toEqual(['first', 'high', 'medium', 'low']);

      await priorityEngine.shutdown();
    });

    it('should emit run.queued and run.dequeued events', async () => {
      const queuedEvents: WorkflowEvent[] = [];
      const dequeuedEvents: WorkflowEvent[] = [];

      const priorityEngine = new WorkflowEngine({
        storage: new MemoryStorageAdapter(),
        events: new MemoryEventTransport(),
        logger: new SilentLogger(),
        settings: {
          maxConcurrency: 1,
        },
      });

      priorityEngine.registerWorkflow({
        kind: 'test.queue.events',
        name: 'Test Queue Events',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 50));
              return 'done';
            },
          },
        ],
      });

      // Subscribe to all events
      priorityEngine.subscribeToAll((event) => {
        if (event.eventType === 'run.queued') {
          queuedEvents.push(event);
        }
        if (event.eventType === 'run.dequeued') {
          dequeuedEvents.push(event);
        }
      });

      // Start 2 runs (first will run, second will queue)
      const firstId = await priorityEngine.startRun({ kind: 'test.queue.events' });
      const secondId = await priorityEngine.startRun({ kind: 'test.queue.events' });

      // Wait for both to complete
      await Promise.all([
        priorityEngine.waitForRun(firstId, { timeout: 2000 }),
        priorityEngine.waitForRun(secondId, { timeout: 2000 }),
      ]);

      expect(queuedEvents).toHaveLength(1);
      expect(queuedEvents[0].runId).toBe(secondId);

      expect(dequeuedEvents).toHaveLength(1);
      expect(dequeuedEvents[0].runId).toBe(secondId);

      await priorityEngine.shutdown();
    });
  });

  describe('orchestrator: raceWithAbort pre-aborted signal', () => {
    it('should throw WorkflowCanceledError immediately when signal is already aborted', async () => {
      engine.registerWorkflow({
        kind: 'test.preabort',
        name: 'Test Pre-Abort',
        steps: [
          {
            key: 'step1',
            name: 'Step 1',
            handler: async () => {
              await new Promise(resolve => setTimeout(resolve, 50));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.preabort' });

      // Cancel immediately (before step starts executing in the microtask)
      engine.cancelRun(runId);

      const run = await engine.waitForRun(runId, { timeout: 2000 });
      expect(run.status).toBe('canceled');
    });
  });

  describe('orchestrator: afterRun hook error swallowing', () => {
    it('should swallow afterRun hook error on failure path and still return failed result', async () => {
      engine.registerWorkflow({
        kind: 'test.hook.afterrun.error',
        name: 'Test afterRun Hook Error',
        steps: [
          {
            key: 'fail-step',
            name: 'Failing Step',
            handler: async () => {
              throw new Error('Step failure');
            },
          },
        ],
        hooks: {
          afterRun: async () => {
            throw new Error('afterRun hook exploded');
          },
        },
      });

      const runId = await engine.startRun({ kind: 'test.hook.afterrun.error' });
      const run = await engine.waitForRun(runId, { timeout: 2000 });

      // The workflow should fail with the original step error, not the hook error
      expect(run.status).toBe('failed');
      expect(run.error?.message).toContain('Step failure');
    });
  });

  describe('orchestrator: executeWithTimeout abort-during-step', () => {
    it('should cancel a step with per-step timeout when workflow-level abort fires', async () => {
      let stepStarted = false;

      engine.registerWorkflow({
        kind: 'test.timeout.abort',
        name: 'Test Timeout Abort',
        steps: [
          {
            key: 'long-step',
            name: 'Long Step',
            timeout: 60000, // 60s per-step timeout
            handler: async () => {
              stepStarted = true;
              // This step takes a long time
              await new Promise(resolve => setTimeout(resolve, 10000));
              return 'done';
            },
          },
        ],
      });

      const runId = await engine.startRun({ kind: 'test.timeout.abort' });

      // Wait until the step has started, then cancel
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(stepStarted).toBe(true);

      engine.cancelRun(runId);

      const run = await engine.waitForRun(runId, { timeout: 2000 });
      expect(run.status).toBe('canceled');
    });
  });
});
