/**
 * Logger utilities for the workflow engine.
 */

import type { Logger } from '../core/types';

/**
 * Console-based logger implementation.
 * Uses console.log with prefixes for different levels.
 */
export class ConsoleLogger implements Logger {
  private prefix: string;

  constructor(prefix = '[workflow]') {
    this.prefix = prefix;
  }

  debug(message: string, ...args: unknown[]): void {
    console.debug(`${this.prefix} [DEBUG]`, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    console.info(`${this.prefix} [INFO]`, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`${this.prefix} [WARN]`, message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`${this.prefix} [ERROR]`, message, ...args);
  }
}

/**
 * Silent logger that does nothing.
 * Useful for testing or when logs are not wanted.
 */
export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/**
 * Create a scoped logger that includes run/step context.
 */
export function createScopedLogger(
  logger: Logger,
  runId: string,
  stepKey?: string
): Logger {
  const prefix = stepKey ? `[run:${runId}][step:${stepKey}]` : `[run:${runId}]`;

  return {
    debug: (message: string, ...args: unknown[]) =>
      logger.debug(`${prefix} ${message}`, ...args),
    info: (message: string, ...args: unknown[]) =>
      logger.info(`${prefix} ${message}`, ...args),
    warn: (message: string, ...args: unknown[]) =>
      logger.warn(`${prefix} ${message}`, ...args),
    error: (message: string, ...args: unknown[]) =>
      logger.error(`${prefix} ${message}`, ...args),
  };
}
