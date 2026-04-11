import { describe, it, expect } from 'vitest';
import {
  WorkflowEngineError,
  WorkflowNotFoundError,
  WorkflowAlreadyRegisteredError,
  RunNotFoundError,
  StepError,
  StepTimeoutError,
  WorkflowCanceledError,
  WorkflowTimeoutError,
} from './errors';

describe('WorkflowEngineError', () => {
  it('should store code, message, and details', () => {
    const err = new WorkflowEngineError('TEST_CODE', 'test message', { key: 'val' });

    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.details).toEqual({ key: 'val' });
    expect(err.name).toBe('WorkflowEngineError');
    expect(err).toBeInstanceOf(Error);
  });

  it('should convert to record', () => {
    const err = new WorkflowEngineError('CODE', 'msg', { x: 1 });
    const record = err.toRecord();

    expect(record.code).toBe('CODE');
    expect(record.message).toBe('msg');
    expect(record.details).toEqual({ x: 1 });
    expect(record.stack).toBeUndefined();
  });

  describe('fromError', () => {
    it('should convert WorkflowEngineError to record', () => {
      const err = new WorkflowEngineError('MY_CODE', 'my msg');
      const record = WorkflowEngineError.fromError(err);

      expect(record.code).toBe('MY_CODE');
      expect(record.message).toBe('my msg');
    });

    it('should convert regular Error to record with default code', () => {
      const err = new Error('regular error');
      const record = WorkflowEngineError.fromError(err);

      expect(record.code).toBe('UNKNOWN_ERROR');
      expect(record.message).toBe('regular error');
      expect(record.stack).toBeUndefined();
    });

    it('should convert regular Error with custom code', () => {
      const err = new Error('oops');
      const record = WorkflowEngineError.fromError(err, 'CUSTOM_CODE');

      expect(record.code).toBe('CUSTOM_CODE');
    });

    it('should convert non-Error value to record', () => {
      const record = WorkflowEngineError.fromError('string error');

      expect(record.code).toBe('UNKNOWN_ERROR');
      expect(record.message).toBe('string error');
      expect(record.stack).toBeUndefined();
    });

    it('should convert number to record', () => {
      const record = WorkflowEngineError.fromError(42);

      expect(record.message).toBe('42');
    });
  });
});

describe('WorkflowNotFoundError', () => {
  it('should have correct code and message', () => {
    const err = new WorkflowNotFoundError('my.workflow');

    expect(err.code).toBe('WORKFLOW_NOT_FOUND');
    expect(err.message).toBe('Workflow "my.workflow" is not registered');
    expect(err.name).toBe('WorkflowNotFoundError');
    expect(err.details).toEqual({ kind: 'my.workflow' });
  });
});

describe('WorkflowAlreadyRegisteredError', () => {
  it('should have correct code and message', () => {
    const err = new WorkflowAlreadyRegisteredError('dup.workflow');

    expect(err.code).toBe('WORKFLOW_ALREADY_REGISTERED');
    expect(err.message).toContain('dup.workflow');
    expect(err.name).toBe('WorkflowAlreadyRegisteredError');
  });
});

describe('RunNotFoundError', () => {
  it('should have correct code and message', () => {
    const err = new RunNotFoundError('run-123');

    expect(err.code).toBe('RUN_NOT_FOUND');
    expect(err.message).toContain('run-123');
    expect(err.name).toBe('RunNotFoundError');
  });
});

describe('StepError', () => {
  it('should store step key, attempt, and cause', () => {
    const cause = new Error('root cause');
    const err = new StepError('step1', 'step failed', 3, cause);

    expect(err.code).toBe('STEP_ERROR');
    expect(err.stepKey).toBe('step1');
    expect(err.attempt).toBe(3);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('StepError');
  });
});

describe('StepTimeoutError', () => {
  it('should store step key and timeout', () => {
    const err = new StepTimeoutError('slow_step', 5000);

    expect(err.code).toBe('STEP_TIMEOUT');
    expect(err.stepKey).toBe('slow_step');
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toContain('5000ms');
    expect(err.name).toBe('StepTimeoutError');
  });
});

describe('WorkflowCanceledError', () => {
  it('should have correct code and message', () => {
    const err = new WorkflowCanceledError('run-456');

    expect(err.code).toBe('WORKFLOW_CANCELED');
    expect(err.message).toContain('run-456');
    expect(err.name).toBe('WorkflowCanceledError');
  });
});

describe('WorkflowTimeoutError', () => {
  it('should store timeout value', () => {
    const err = new WorkflowTimeoutError('run-789', 30000);

    expect(err.code).toBe('WORKFLOW_TIMEOUT');
    expect(err.timeoutMs).toBe(30000);
    expect(err.message).toContain('30000ms');
    expect(err.name).toBe('WorkflowTimeoutError');
  });
});
