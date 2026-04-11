import { describe, it, expect, vi } from 'vitest';
import { ConsoleLogger, SilentLogger, createScopedLogger } from './logger';

describe('ConsoleLogger', () => {
  it('should log debug messages with prefix', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = new ConsoleLogger('[test]', 'debug');

    logger.debug('hello', { extra: true });

    expect(spy).toHaveBeenCalledWith('[test] [DEBUG]', 'hello', { extra: true });
    spy.mockRestore();
  });

  it('should log info messages with prefix', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logger = new ConsoleLogger('[test]');

    logger.info('info msg');

    expect(spy).toHaveBeenCalledWith('[test] [INFO]', 'info msg');
    spy.mockRestore();
  });

  it('should log warn messages with prefix', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = new ConsoleLogger('[test]');

    logger.warn('warning');

    expect(spy).toHaveBeenCalledWith('[test] [WARN]', 'warning');
    spy.mockRestore();
  });

  it('should log error messages with prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsoleLogger('[test]');

    logger.error('error msg', new Error('boom'));

    expect(spy).toHaveBeenCalledWith('[test] [ERROR]', 'error msg', expect.any(Error));
    spy.mockRestore();
  });

  it('should use default prefix when none provided', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info('test');

    expect(spy).toHaveBeenCalledWith('[workflow] [INFO]', 'test');
    spy.mockRestore();
  });
});

describe('SilentLogger', () => {
  it('should not throw on any log level', () => {
    const logger = new SilentLogger();

    expect(() => logger.debug('test')).not.toThrow();
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });
});

describe('createScopedLogger', () => {
  it('should prefix messages with run ID', () => {
    const calls: string[] = [];
    const baseLogger = {
      debug: (msg: string) => calls.push(`debug:${msg}`),
      info: (msg: string) => calls.push(`info:${msg}`),
      warn: (msg: string) => calls.push(`warn:${msg}`),
      error: (msg: string) => calls.push(`error:${msg}`),
    };

    const scoped = createScopedLogger(baseLogger, 'run-123');

    scoped.debug('d');
    scoped.info('i');
    scoped.warn('w');
    scoped.error('e');

    expect(calls).toEqual([
      'debug:[run:run-123] d',
      'info:[run:run-123] i',
      'warn:[run:run-123] w',
      'error:[run:run-123] e',
    ]);
  });

  it('should include step key when provided', () => {
    const calls: string[] = [];
    const baseLogger = {
      debug: (msg: string) => calls.push(msg),
      info: (msg: string) => calls.push(msg),
      warn: (msg: string) => calls.push(msg),
      error: (msg: string) => calls.push(msg),
    };

    const scoped = createScopedLogger(baseLogger, 'run-1', 'step-a');
    scoped.info('hello');

    expect(calls[0]).toBe('[run:run-1][step:step-a] hello');
  });

  it('should forward extra arguments', () => {
    const captured: unknown[][] = [];
    const baseLogger = {
      debug: (...args: unknown[]) => captured.push(args),
      info: (...args: unknown[]) => captured.push(args),
      warn: (...args: unknown[]) => captured.push(args),
      error: (...args: unknown[]) => captured.push(args),
    };

    const scoped = createScopedLogger(baseLogger, 'r1');
    scoped.info('msg', { data: 1 }, 42);

    expect(captured[0]).toEqual(['[run:r1] msg', { data: 1 }, 42]);
  });
});
