/**
 * Tests for safeCompileRegex (audit finding L4 — regex pattern length cap).
 */

import { describe, it, expect } from 'vitest';
import { safeCompileRegex, MAX_REGEX_PATTERN_LENGTH } from './regex-utils';

describe('safeCompileRegex', () => {
  it('compiles short, valid patterns', () => {
    const re = safeCompileRegex('^foo-\\d+$');
    expect(re).not.toBeNull();
    expect(re!.test('foo-123')).toBe(true);
    expect(re!.test('bar')).toBe(false);
  });

  it('returns null for invalid patterns', () => {
    expect(safeCompileRegex('[unclosed')).toBeNull();
  });

  it('compiles patterns at exactly the size limit', () => {
    // A repeated literal character — valid and exactly MAX chars long.
    const pattern = 'a'.repeat(MAX_REGEX_PATTERN_LENGTH);
    const re = safeCompileRegex(pattern);
    expect(re).not.toBeNull();
  });

  it('rejects patterns above the size limit without compiling', () => {
    const pattern = 'a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1);
    expect(safeCompileRegex(pattern)).toBeNull();
  });

  it('rejects extremely long patterns regardless of validity', () => {
    // A would-be valid pattern that is well past the cap.
    const pattern = '(' + 'a|'.repeat(10_000) + 'a)';
    expect(safeCompileRegex(pattern)).toBeNull();
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error — verifying defensive runtime check
    expect(safeCompileRegex(undefined)).toBeNull();
    // @ts-expect-error — verifying defensive runtime check
    expect(safeCompileRegex(null)).toBeNull();
  });
});
