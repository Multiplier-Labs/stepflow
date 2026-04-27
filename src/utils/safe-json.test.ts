import { describe, it, expect, vi } from 'vitest';
import { safeJsonParse } from './safe-json';
import type { Logger } from '../core/types';

function createLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('safeJsonParse', () => {
  it('parses valid JSON without invoking the logger or counter', () => {
    const logger = createLogger();
    const onCorruption = vi.fn();

    const result = safeJsonParse('{"a":1}', {}, {
      logger,
      component: 'TestAdapter',
      onCorruption,
    });

    expect(result).toEqual({ a: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(onCorruption).not.toHaveBeenCalled();
  });

  it('returns the fallback and logs a structured warning on SyntaxError', () => {
    const logger = createLogger();
    const onCorruption = vi.fn();

    const result = safeJsonParse('not-json', { fallback: true }, {
      logger,
      component: 'TestAdapter',
      rowId: 'run-123',
      onCorruption,
    });

    expect(result).toEqual({ fallback: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(onCorruption).toHaveBeenCalledTimes(1);

    const [message, payload] = logger.warn.mock.calls[0];
    expect(message).toBe(
      '[TestAdapter] Corrupted JSON in database row, using fallback'
    );
    expect(payload).toMatchObject({
      component: 'TestAdapter',
      rowId: 'run-123',
      inputType: 'string',
      inputLength: 'not-json'.length,
    });
  });

  it('does not include the raw value or parser error message in log payload', () => {
    const logger = createLogger();
    const secret = '{"password":"hunter2"';

    safeJsonParse(secret, {}, {
      logger,
      component: 'TestAdapter',
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const callArgs = logger.warn.mock.calls[0];
    const serialized = JSON.stringify(callArgs);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('password');
  });

  it('falls back to console.warn when no logger is configured', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onCorruption = vi.fn();

    try {
      const result = safeJsonParse('not-json', null, {
        component: 'TestAdapter',
        onCorruption,
      });

      expect(result).toBeNull();
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(onCorruption).toHaveBeenCalledTimes(1);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('rethrows non-SyntaxError exceptions instead of swallowing them', () => {
    const logger = createLogger();
    const onCorruption = vi.fn();

    // Force a non-SyntaxError by passing a value whose toString throws.
    const badInput = {
      toString() {
        throw new Error('boom');
      },
    } as unknown as string;

    expect(() =>
      safeJsonParse(badInput, {}, {
        logger,
        component: 'TestAdapter',
        onCorruption,
      })
    ).toThrow('boom');

    expect(logger.warn).not.toHaveBeenCalled();
    expect(onCorruption).not.toHaveBeenCalled();
  });
});
