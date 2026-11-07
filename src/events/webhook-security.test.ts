import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as dns } from 'node:dns';
import { WebhookEventTransport } from './webhook';
import { pinnedFetch } from '../utils/pinned-fetch';

vi.mock('node:dns', () => ({ promises: { lookup: vi.fn() } }));
vi.mock('../utils/pinned-fetch', () => ({ pinnedFetch: vi.fn() }));
const event = { runId: 'run', kind: 'test', eventType: 'run.created', timestamp: new Date() };

beforeEach(() => {
  vi.mocked(dns.lookup).mockReset();
  vi.mocked(pinnedFetch).mockReset().mockResolvedValue({ ok: true, status: 204, statusText: 'No Content' });
});
afterEach(() => vi.useRealTimers());

describe('webhook destination and deadline protection', () => {
  it.each([
    ['https://8.8.8.8/hook', '8.8.8.8', 4],
    ['https://[2606:4700:4700::1111]/hook', '2606:4700:4700::1111', 6],
  ])('pins public IP URL %s without using global fetch', async (url, address, family) => {
    const fallback = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not use fetch'));
    const transport = new WebhookEventTransport({ endpoints: [{ id: 'test', url }], defaultRetries: 0 });
    try {
      transport.emit(event);
      await vi.waitFor(() => expect(pinnedFetch).toHaveBeenCalledWith(
        url, expect.objectContaining({ method: 'POST' }), address, family,
      ));
      expect(fallback).not.toHaveBeenCalled();
      expect(dns.lookup).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
      transport.close();
    }
  });

  it('requires custom fetch clients to reject redirects too', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const transport = new WebhookEventTransport({ fetchFn, endpoints: [{ id: 'test', url: 'https://8.8.8.8' }] });
    transport.emit(event);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledWith(
      'https://8.8.8.8', expect.objectContaining({ redirect: 'error' }),
    ));
    transport.close();
  });

  it('releases the delivery slot on DNS timeout and ignores a late answer', async () => {
    vi.useFakeTimers();
    let resolveLookup!: (value: any) => void;
    vi.mocked(dns.lookup).mockImplementationOnce(() => new Promise(resolve => { resolveLookup = resolve; }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new WebhookEventTransport({
      endpoints: [
        { id: 'slow', url: 'https://slow.example.test' },
        { id: 'ready', url: 'https://8.8.8.8' },
      ], maxConcurrentRequests: 1, defaultRetries: 0, logger,
    });
    transport.emit(event);
    expect(transport.getQueueDepth()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('slow'), expect.objectContaining({ message: expect.stringContaining('timed out') }));
    expect(transport.getQueueDepth()).toBe(0);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
    resolveLookup({ address: '93.184.216.34', family: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    transport.close();
  });

  it('releases request timers when the HTTP client rejects', async () => {
    vi.useFakeTimers();
    vi.mocked(pinnedFetch).mockRejectedValue(new Error('connection refused'));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new WebhookEventTransport({ endpoints: [{ id: 'test', url: 'https://8.8.8.8' }], defaultRetries: 0, logger });
    transport.emit(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    transport.close();
  });

  it('applies payload limits to UTF-8 bytes rather than JavaScript characters', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new WebhookEventTransport({
      endpoints: [{ id: 'test', url: 'https://8.8.8.8' }],
      maxPayloadBytes: 1000, defaultRetries: 0, logger,
    });
    transport.emit({ ...event, payload: '界'.repeat(400) });
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ message: expect.stringContaining('exceeds maximum size') }),
    ));
    expect(pinnedFetch).not.toHaveBeenCalled();
    transport.close();
  });
});
