/**
 * Tests for safeJsonParse — audit findings L3 + M2.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  safeJsonParse,
  safeParseField,
  safeParseOptionalField,
  getJsonParseCorruptionCount,
  resetJsonParseCorruptionCount,
} from './safe-json';

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('safeJsonParse', () => {
  beforeEach(() => {
    resetJsonParseCorruptionCount();
  });

  it('returns parsed value for valid JSON without logging', () => {
    const logger = makeLogger();
    const result = safeJsonParse('{"a":1}', null, { component: 'X', logger });
    expect(result).toEqual({ a: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(getJsonParseCorruptionCount()).toBe(0);
  });

  it('returns fallback on SyntaxError and increments the corruption counter', () => {
    const logger = makeLogger();
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

  it('emits row id, column, length, type — but never the raw value', () => {
    const logger = makeLogger();
    const sensitive = '{"sensitive":"PII-DATA-IN-DATABASE"]';
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
    // Critical: do not leak raw payload via message OR metadata.
    const serialized = JSON.stringify([message, meta]);
    expect(serialized).not.toContain('PII-DATA-IN-DATABASE');

    expect(meta).toMatchObject({
      rowId: 'run-456',
      column: 'metadata_json',
      length: sensitive.length,
      type: 'string',
    });
    expect(meta.error).toEqual(expect.any(String));
    expect(meta.corruptionCount).toBe(1);
  });

  it('does not call console.warn or console.error directly', () => {
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

  it('rethrows non-syntax errors', () => {
    // SyntaxError-only catch — make JSON.parse throw something else and
    // confirm it propagates instead of being swallowed.
    const original = JSON.parse;
    (JSON as any).parse = () => {
      throw new TypeError('boom');
    };
    try {
      expect(() =>
        safeJsonParse('{}', null, { component: 'X' })
      ).toThrowError(TypeError);
    } finally {
      (JSON as any).parse = original;
    }
    expect(getJsonParseCorruptionCount()).toBe(0);
  });

  it('counts corruption events across multiple calls', () => {
    safeJsonParse('bad-1{', null, { component: 'A' });
    safeJsonParse('bad-2{', null, { component: 'B' });
    safeJsonParse('{"ok":1}', null, { component: 'C' });
    expect(getJsonParseCorruptionCount()).toBe(2);
  });
});

describe('safeParseField', () => {
  beforeEach(() => {
    resetJsonParseCorruptionCount();
  });

  it('parses string values', () => {
    const result = safeParseField('{"x":1}', {}, { component: 'X' });
    expect(result).toEqual({ x: 1 });
  });

  it('passes non-string values through unchanged', () => {
    const obj = { x: 1 };
    expect(safeParseField(obj, {}, { component: 'X' })).toBe(obj);
    expect(safeParseField(42, {}, { component: 'X' })).toBe(42);
  });

  it('returns fallback on syntax error', () => {
    const result = safeParseField('garbage{', { fallback: 1 }, { component: 'X' });
    expect(result).toEqual({ fallback: 1 });
    expect(getJsonParseCorruptionCount()).toBe(1);
  });
});

describe('safeParseOptionalField', () => {
  beforeEach(() => {
    resetJsonParseCorruptionCount();
  });

  it('returns undefined for falsy values', () => {
    expect(safeParseOptionalField(null, { component: 'X' })).toBeUndefined();
    expect(safeParseOptionalField(undefined, { component: 'X' })).toBeUndefined();
    expect(safeParseOptionalField('', { component: 'X' })).toBeUndefined();
    expect(safeParseOptionalField(0, { component: 'X' })).toBeUndefined();
  });

  it('parses string values', () => {
    expect(
      safeParseOptionalField('{"a":1}', { component: 'X' })
    ).toEqual({ a: 1 });
  });

  it('passes non-string truthy values through unchanged', () => {
    const obj = { a: 1 };
    expect(safeParseOptionalField(obj, { component: 'X' })).toBe(obj);
  });

  it('returns undefined on syntax error and increments counter', () => {
    const result = safeParseOptionalField('garbage{', { component: 'X' });
    expect(result).toBeUndefined();
    expect(getJsonParseCorruptionCount()).toBe(1);
  });
});
