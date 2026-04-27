/**
 * Tests for safeJsonParse (audit findings L3 + M2).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  safeJsonParse,
  getJsonParseCorruptionCount,
  resetJsonParseCorruptionCount,
} from './safe-json';

describe('safeJsonParse', () => {
  beforeEach(() => {
    resetJsonParseCorruptionCount();
  });

  it('parses valid JSON without logging', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const result = safeJsonParse('{"a":1}', null, { component: 'X', logger });
    expect(result).toEqual({ a: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(getJsonParseCorruptionCount()).toBe(0);
  });

  it('returns fallback on syntax error and increments corruption counter', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const result = safeJsonParse('not-json', { fallback: true }, {
      component: 'TestAdapter',
      rowId: 'run-123',
      column: 'input_json',
      logger,
    });
    expect(result).toEqual({ fallback: true });
    expect(getJsonParseCorruptionCount()).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs row id and column in metadata, but never the raw value', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const sensitive = '{"sensitive": "PII-data-in-database"]';
    safeJsonParse(sensitive, undefined, {
      component: 'TestAdapter',
      rowId: 'run-456',
      column: 'metadata_json',
      logger,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.warn.mock.calls[0];
    expect(message).toContain('TestAdapter');
    expect(message).toContain('Corrupted JSON');
    // Critical: do not leak raw payload
    const serialized = JSON.stringify([message, meta]);
    expect(serialized).not.toContain('PII-data-in-database');

    expect(meta).toMatchObject({
      rowId: 'run-456',
      column: 'metadata_json',
      length: sensitive.length,
      type: 'string',
    });
    expect(meta.error).toEqual(expect.any(String));
  });

  it('does not call console.error or console.warn directly', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      safeJsonParse('garbage{', null, { component: 'TestAdapter' });
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('counts corruption events across multiple calls', () => {
    safeJsonParse('bad-1{', null, { component: 'A' });
    safeJsonParse('bad-2{', null, { component: 'B' });
    safeJsonParse('{"ok":1}', null, { component: 'C' });
    expect(getJsonParseCorruptionCount()).toBe(2);
  });
});
