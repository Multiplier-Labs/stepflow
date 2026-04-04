/**
 * ID generation utilities for the workflow engine.
 */

import { randomBytes } from 'crypto';

/**
 * Generate a unique ID for database records.
 * Uses a ULID-like format: base36 timestamp + random suffix.
 * This provides:
 * - Rough time-ordering (useful for debugging)
 * - High collision resistance
 * - URL-safe characters
 * - Cryptographically secure random component
 *
 * @returns A unique identifier string (approx 16 characters)
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = randomBytes(6).toString('hex').substring(0, 8);
  return `${timestamp}${randomPart}`;
}
