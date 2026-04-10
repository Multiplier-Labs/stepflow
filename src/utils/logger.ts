/**
 * Logger utilities for the workflow engine.
 */

import type { Logger, WorkflowError } from "../core/types";

/** Log level for ConsoleLogger. Levels are ordered: debug < info < warn < error. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Console-based logger implementation.
 * Uses console.log with prefixes for different levels.
 * Supports a configurable minimum log level (default: 'info').
 */
export class ConsoleLogger implements Logger {
  private prefix: string;
  private minLevel: number;

  constructor(prefix = "[workflow]", level: LogLevel = "info") {
    this.prefix = prefix;
    this.minLevel = LOG_LEVEL_PRIORITY[level];
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.debug) {
      console.debug(`${this.prefix} [DEBUG]`, message, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.info) {
      console.info(`${this.prefix} [INFO]`, message, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.warn) {
      console.warn(`${this.prefix} [WARN]`, message, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.error) {
      console.error(`${this.prefix} [ERROR]`, message, ...args);
    }
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
 * Strip stack traces from a WorkflowError before persisting to storage.
 * Stack traces expose internal file paths and should be kept in logs only.
 */
export function sanitizeErrorForStorage(error: WorkflowError): WorkflowError {
  const { stack: _stack, ...rest } = error;
  return rest;
}

/**
 * Create a scoped logger that includes run/step context.
 */
export function createScopedLogger(
  logger: Logger,
  runId: string,
  stepKey?: string,
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
