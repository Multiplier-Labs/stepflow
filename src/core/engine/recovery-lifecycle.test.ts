import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../engine';
import { MemoryStorageAdapter } from '../../storage/memory';
import { MemoryEventTransport } from '../../events/memory';
import { SilentLogger } from '../../utils/logger';
import { sleep } from '../../utils/retry';
import { ConcurrencyManager } from './concurrency';

const logger = new SilentLogger();
const engines: WorkflowEngine[] = [];
function makeEngine(config: ConstructorParameters<typeof WorkflowEngine>[0] = {}) {
  const engine = new WorkflowEngine({ logger, ...config });
  engines.push(engine);
  return engine;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const queued = { kind: 'test', status: 'queued' as const, input: {}, metadata: {}, context: {} };

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(engines.splice(0).map(engine => engine.shutdown()));
});

describe('workflow recovery and lifecycle regressions', () => {
  it('enforces the engine timeout and permits a workflow override', async () => {
    const engine = makeEngine({ settings: { defaultTimeout: 5 } });
    const steps = [{ key: 'step', name: 'Step', handler: async (ctx: any) => {
      await sleep(40, ctx.signal);
      return 'done';
    } }];
    engine.registerWorkflow({ kind: 'default', name: 'Default', steps });
    engine.registerWorkflow({ kind: 'override', name: 'Override', timeout: 500, steps });
    const timedOut = await engine.waitForRun(await engine.startRun({ kind: 'default' }));
    expect(timedOut.status).toBe('failed');
    expect(timedOut.error?.code).toBe('WORKFLOW_TIMEOUT');
    expect((await engine.waitForRun(await engine.startRun({ kind: 'override' }))).status).toBe('succeeded');
  });

  it('does not launch or duplicate a run already waiting in the queue', async () => {
    const engine = makeEngine({ settings: { maxConcurrency: 1 } });
    const hold = gate();
    const handler = vi.fn(async (ctx: any) => {
      if (ctx.input.hold) await hold.promise;
      return true;
    });
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [{ key: 'step', name: 'Step', handler }] });
    const first = await engine.startRun({ kind: 'test', input: { hold: true } });
    const second = await engine.startRun({ kind: 'test' });
    await Promise.all([engine.resumeRun(second), engine.resumeRun(second)]);
    expect(engine.getActiveRunCount()).toBe(1);
    expect(engine.getQueuedRunCount()).toBe(1);
    hold.resolve();
    await Promise.all([engine.waitForRun(first), engine.waitForRun(second)]);
    await vi.waitFor(() => expect(engine.getActiveRunCount()).toBe(0));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('queues recovered checkpoints without losing their results or completed keys', async () => {
    const storage = new MemoryStorageAdapter();
    const engine = makeEngine({ storage, settings: { maxConcurrency: 1 } });
    const hold = gate();
    engine.registerWorkflow({ kind: 'hold', name: 'Hold', steps: [{ key: 'hold', name: 'Hold', handler: () => hold.promise }] });
    const repeated = vi.fn(async () => 'incorrect');
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [
      { key: 'charged', name: 'Charge', handler: repeated },
      { key: 'receipt', name: 'Receipt', handler: async ctx => ctx.results.charged },
    ] });
    const first = await engine.startRun({ kind: 'hold' });
    const run = await storage.createRun({ ...queued, context: { charged: 'transaction' }, completedSteps: ['charged'] });
    await engine.resumeRun(run.id);
    expect(engine.getActiveRunCount()).toBe(1);
    expect(engine.getQueuedRunCount()).toBe(1);
    hold.resolve();
    await engine.waitForRun(first);
    const result = await engine.waitForRun(run.id);
    expect(repeated).not.toHaveBeenCalled();
    expect(result.context.receipt).toBe('transaction');
  });

  it('recovers every page while respecting capacity', async () => {
    const storage = new MemoryStorageAdapter();
    for (let i = 0; i < 205; i++) await storage.createRun(queued);
    const engine = makeEngine({ storage, settings: { maxConcurrency: 3 } });
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [] });
    const ids = await engine.resumeAllInterrupted();
    expect(ids).toHaveLength(205);
    expect(new Set(ids).size).toBe(205);
    expect(engine.getActiveRunCount()).toBeLessThanOrEqual(3);
    await Promise.all(ids.map(id => engine.waitForRun(id)));
    expect((await storage.listRuns({ status: ['queued', 'running'] })).total).toBe(0);
  });

  it('retains the original eligibility time when capacity forces a delayed run to queue', async () => {
    vi.useFakeTimers();
    const engine = makeEngine({ settings: { maxConcurrency: 1 } });
    const executed: number[] = [];
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [{ key: 'step', name: 'Step', handler: async () => {
      executed.push(Date.now());
    } }] });
    await engine.startRun({ kind: 'test' });
    const start = Date.now();
    const second = await engine.startRun({ kind: 'test', delay: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(executed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(executed).toEqual([start, start + 1000]);
    expect((await engine.getRunStatus(second))?.status).toBe('succeeded');
  });

  it('awaits cancellation persistence before closing and leaves queued work resumable', async () => {
    class ClosingStorage extends MemoryStorageAdapter {
      closed = false;
      close = vi.fn(async () => { this.closed = true; });
      async updateRun(id: string, updates: any) {
        expect(this.closed).toBe(false);
        await Promise.resolve();
        return super.updateRun(id, updates);
      }
      async updateStep(id: string, updates: any) {
        expect(this.closed).toBe(false);
        return super.updateStep(id, updates);
      }
    }
    const storage = new ClosingStorage();
    const engine = makeEngine({ storage, settings: { maxConcurrency: 1 } });
    const entered = gate();
    const handler = vi.fn(async () => { entered.resolve(); await new Promise(() => {}); });
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [{ key: 'step', name: 'Step', handler }] });
    const active = await engine.startRun({ kind: 'test' });
    const waiting = await engine.startRun({ kind: 'test' });
    await entered.promise;
    await Promise.all([engine.shutdown(), engine.shutdown()]);
    expect((await storage.getRun(active))?.status).toBe('canceled');
    expect((await storage.getRun(waiting))?.status).toBe('queued');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(storage.close).toHaveBeenCalledTimes(1);
    expect(engine.getActiveRunCount()).toBe(0);
    await expect(engine.startRun({ kind: 'test' })).rejects.toThrow('shutting down');
    await expect(engine.resumeRun(waiting)).rejects.toThrow('shutting down');
  });

  it('waits for in-progress admission I/O before closing storage', async () => {
    const admission = gate();
    const entered = gate();
    class SlowStorage extends MemoryStorageAdapter {
      close = vi.fn();
      async createRun(input: any) {
        entered.resolve();
        await admission.promise;
        return super.createRun(input);
      }
    }
    const storage = new SlowStorage();
    const engine = makeEngine({ storage });
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [] });
    const starting = engine.startRun({ kind: 'test' });
    const rejected = expect(starting).rejects.toThrow('shutting down');
    await entered.promise;
    const shutdown = engine.shutdown();
    expect(storage.close).not.toHaveBeenCalled();
    admission.resolve();
    await rejected;
    await shutdown;
    expect(storage.close).toHaveBeenCalledTimes(1);
  });

  it.each(['afterStep', 'afterRun'] as const)('does not report success after cancellation during %s', async hook => {
    const engine = makeEngine();
    const entered = gate();
    const release = gate();
    const callback = vi.fn(async () => { entered.resolve(); await release.promise; });
    const events: string[] = [];
    engine.subscribeToAll(event => events.push(event.eventType));
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [{ key: 'step', name: 'Step', handler: async () => true }], hooks: { [hook]: callback } });
    const id = await engine.startRun({ kind: 'test' });
    await entered.promise;
    try {
      await engine.cancelRun(id);
    } finally {
      release.resolve();
    }
    await vi.waitFor(() => expect(engine.getActiveRunCount()).toBe(0));
    expect((await engine.getRunStatus(id))?.status).toBe('canceled');
    expect(events).not.toContain('run.completed');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('returns the run ID and executes despite a throwing creation subscriber', async () => {
    const events = new MemoryEventTransport();
    const engine = makeEngine({ events });
    engine.registerWorkflow({ kind: 'test', name: 'Test', steps: [] });
    events.subscribeAll(event => { if (event.eventType === 'run.created') throw new Error('observer'); });
    const id = await engine.startRun({ kind: 'test' });
    expect((await engine.waitForRun(id)).status).toBe('succeeded');
  });
});

describe('launch timer ownership', () => {
  it('cancels both immediate and delayed launches', async () => {
    vi.useFakeTimers();
    const manager = new ConcurrencyManager({ storage: new MemoryStorageAdapter(), events: new MemoryEventTransport(), logger });
    const launch = vi.fn();
    manager.scheduleLaunch(launch);
    manager.scheduleLaunch(launch, 1000);
    manager.clearTimers();
    await vi.runAllTimersAsync();
    expect(launch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases completed immediate and delayed timer handles', async () => {
    vi.useFakeTimers();
    const manager = new ConcurrencyManager({ storage: new MemoryStorageAdapter(), events: new MemoryEventTransport(), logger });
    const launch = vi.fn();
    for (let i = 0; i < 20; i++) manager.scheduleLaunch(launch, i);
    await vi.runAllTimersAsync();
    expect(launch).toHaveBeenCalledTimes(20);
    expect((manager as any).timerHandles.size).toBe(0);
  });
});
