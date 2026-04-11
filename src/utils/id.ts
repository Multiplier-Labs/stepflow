/**
 * ID generation utilities for the workflow engine.
 */

/**
 * Generate a unique ID for database records.
 * Uses a ULID-like format: base36 timestamp + random suffix.
 * This provides:
 * - Rough time-ordering (useful for debugging)
 * - High collision resistance
 * - URL-safe characters
 *
 * @returns A unique identifier string (approx 16 characters)
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${randomPart}`;
}
