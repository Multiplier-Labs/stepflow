import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryEventTransport } from './memory';
import type { WorkflowEvent, WorkflowEventType } from './types';

function createTestEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    eventType: 'run.started',
    runId: 'run-123',
    kind: 'test.workflow',
    timestamp: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

describe('MemoryEventTransport', () => {
  let transport: MemoryEventTransport;

  beforeEach(() => {
    transport = new MemoryEventTransport();
  });

  describe('subscribeToType', () => {
    it('should call callback when event of matching type is emitted', () => {
      const callback = vi.fn();
      transport.subscribeToType('run.completed', callback);

      const event = createTestEvent({ eventType: 'run.completed' });
      transport.emit(event);

      expect(callback).toHaveBeenCalledWith(event);
    });

    it('should not call callback for events of a different type', () => {
      const callback = vi.fn();
      transport.subscribeToType('run.completed', callback);

      transport.emit(createTestEvent({ eventType: 'run.started' }));

      expect(callback).not.toHaveBeenCalled();
    });

    it('should unsubscribe when calling the returned function', () => {
      const callback = vi.fn();
      const unsubscribe = transport.subscribeToType('run.completed', callback);

      // Emit once before unsubscribe
      transport.emit(createTestEvent({ eventType: 'run.completed' }));
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      // Emit again after unsubscribe
      transport.emit(createTestEvent({ eventType: 'run.completed' }));
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should support multiple type subscriptions independently', () => {
      const completedCb = vi.fn();
      const failedCb = vi.fn();
      transport.subscribeToType('run.completed', completedCb);
      transport.subscribeToType('run.failed', failedCb);

      transport.emit(createTestEvent({ eventType: 'run.completed' }));

      expect(completedCb).toHaveBeenCalledTimes(1);
      expect(failedCb).not.toHaveBeenCalled();
    });
  });

  describe('getListenerCount', () => {
    it('should return 0 when no listeners are registered', () => {
      expect(transport.getListenerCount()).toBe(0);
    });

    it('should return global listener count when called without channel', () => {
      transport.subscribeAll(vi.fn());
      transport.subscribeAll(vi.fn());

      expect(transport.getListenerCount()).toBe(2);
    });

    it('should return channel-specific listener count when called with channel', () => {
      transport.subscribe('run-1', vi.fn());
      transport.subscribe('run-1', vi.fn());
      transport.subscribe('run-2', vi.fn());

      expect(transport.getListenerCount('run:run-1')).toBe(2);
      expect(transport.getListenerCount('run:run-2')).toBe(1);
    });

    it('should update count after subscribe and unsubscribe', () => {
      const unsub = transport.subscribeAll(vi.fn());
      expect(transport.getListenerCount()).toBe(1);

      unsub();
      expect(transport.getListenerCount()).toBe(0);
    });

    it('should return count for type-based channels', () => {
      transport.subscribeToType('step.completed', vi.fn());
      transport.subscribeToType('step.completed', vi.fn());

      expect(transport.getListenerCount('type:step.completed')).toBe(2);
      expect(transport.getListenerCount('type:step.failed')).toBe(0);
    });
  });
});
