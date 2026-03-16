/**
 * Retry utilities for the workflow engine.
 */

import { WorkflowCanceledError } from './errors';

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Initial delay between retries in ms (default: 1000) */
  delay: number;
  /** Backoff multiplier (default: 2) */
  backoff: number;
  /** Optional abort signal to cancel retries */
  signal?: AbortSignal;
  /** Optional callback before each retry */
  onRetry?: (attempt: number, error: Error, nextDelay: number) => void;
}

/**
 * Default retry options.
 */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  delay: 1000,
  backoff: 2,
};

/**
 * Sleep for a given number of milliseconds.
 * Can be canceled via AbortSignal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WorkflowCanceledError('run'));
      return;
    }

    let onAbort: (() => void) | undefined;

    const timeoutId = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        clearTimeout(timeoutId);
        reject(new WorkflowCanceledError('run'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Execute a function with retry logic.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;
  let currentDelay = opts.delay;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    // Check if aborted before attempting
    if (opts.signal?.aborted) {
      throw new Error('Aborted');
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If this was the last attempt, throw
      if (attempt > opts.maxRetries) {
        throw lastError;
      }

      // Call onRetry callback if provided
      opts.onRetry?.(attempt, lastError, currentDelay);

      // Wait before next attempt
      await sleep(currentDelay, opts.signal);

      // Apply backoff multiplier
      currentDelay = Math.round(currentDelay * opts.backoff);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error('Retry failed');
}

/**
 * Calculate the delay for a specific retry attempt.
 */
export function calculateRetryDelay(
  attempt: number,
  baseDelay: number,
  backoff: number
): number {
  return Math.round(baseDelay * Math.pow(backoff, attempt - 1));
}
