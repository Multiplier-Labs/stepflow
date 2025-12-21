import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebhookEventTransport, WebhookEndpoint } from './webhook';
import type { WorkflowEvent } from './types';

function createTestEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    eventType: 'run.started',
    runId: 'run-123',
    kind: 'test.workflow',
    timestamp: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

describe('WebhookEventTransport', () => {
  let transport: WebhookEventTransport;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    transport = new WebhookEventTransport({
      fetchFn: mockFetch,
      defaultTimeout: 1000,
      defaultRetries: 0, // Disable retries for faster tests
    });
  });

  afterEach(() => {
    transport.close();
  });

  describe('addEndpoint / removeEndpoint', () => {
    it('should add an endpoint', () => {
      const endpoint: WebhookEndpoint = {
        id: 'test-1',
        url: 'https://example.com/webhook',
      };

      transport.addEndpoint(endpoint);

      expect(transport.getEndpoints()).toHaveLength(1);
      expect(transport.getEndpoints()[0].id).toBe('test-1');
    });

    it('should add endpoint with enabled=true by default', () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      expect(transport.getEndpoints()[0].enabled).toBe(true);
    });

    it('should remove an endpoint', () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      const removed = transport.removeEndpoint('test-1');

      expect(removed).toBe(true);
      expect(transport.getEndpoints()).toHaveLength(0);
    });

    it('should return false when removing non-existent endpoint', () => {
      const removed = transport.removeEndpoint('nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('setEndpointEnabled', () => {
    it('should enable/disable an endpoint', () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
        enabled: true,
      });

      transport.setEndpointEnabled('test-1', false);
      expect(transport.getEndpoints()[0].enabled).toBe(false);

      transport.setEndpointEnabled('test-1', true);
      expect(transport.getEndpoints()[0].enabled).toBe(true);
    });

    it('should do nothing for non-existent endpoint', () => {
      transport.setEndpointEnabled('nonexistent', false);
      // Should not throw
    });
  });

  describe('emit', () => {
    it('should send event to enabled endpoints', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      const event = createTestEvent();
      transport.emit(event);

      // Wait for async webhook
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should not send to disabled endpoints', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
        enabled: false,
      });

      const event = createTestEvent();
      transport.emit(event);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should include custom headers', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
        headers: { 'X-Custom-Header': 'custom-value' },
      });

      transport.emit(createTestEvent());

      await new Promise((r) => setTimeout(r, 50));

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers['X-Custom-Header']).toBe('custom-value');
    });

    it('should serialize payload correctly', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      const event = createTestEvent({
        runId: 'run-456',
        kind: 'my.workflow',
      });
      transport.emit(event);

      await new Promise((r) => setTimeout(r, 50));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.event.runId).toBe('run-456');
      expect(body.event.kind).toBe('my.workflow');
      expect(body.event.timestamp).toBe('2024-01-01T12:00:00.000Z');
      expect(body.webhookId).toBe('test-1');
      expect(body.deliveredAt).toBeDefined();
    });
  });

  describe('event filtering', () => {
    it('should filter by event type', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
        eventTypes: ['run.completed', 'run.failed'],
      });

      // Should be filtered out
      transport.emit(createTestEvent({ eventType: 'run.started' }));

      // Should be sent
      transport.emit(createTestEvent({ eventType: 'run.completed' }));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should filter by workflow kind', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
        workflowKinds: ['order.process', 'order.ship'],
      });

      // Should be filtered out
      transport.emit(createTestEvent({ kind: 'user.notify' }));

      // Should be sent
      transport.emit(createTestEvent({ kind: 'order.process' }));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should apply both filters (AND logic)', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
        eventTypes: ['run.completed'],
        workflowKinds: ['order.process'],
      });

      // Wrong event type
      transport.emit(
        createTestEvent({
          eventType: 'run.started',
          kind: 'order.process',
        })
      );

      // Wrong workflow kind
      transport.emit(
        createTestEvent({
          eventType: 'run.completed',
          kind: 'user.notify',
        })
      );

      // Both match
      transport.emit(
        createTestEvent({
          eventType: 'run.completed',
          kind: 'order.process',
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should send to all endpoints when no filters', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook1',
      });
      transport.addEndpoint({
        id: 'test-2',
        url: 'https://example.com/webhook2',
      });

      transport.emit(createTestEvent());

      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('HMAC signing', () => {
    it('should sign payload when secret is provided', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
        secret: 'my-secret-key',
      });

      transport.emit(createTestEvent());

      await new Promise((r) => setTimeout(r, 50));

      const callArgs = mockFetch.mock.calls[0];
      const signature = callArgs[1].headers['X-Webhook-Signature'];

      expect(signature).toBeDefined();
      expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('should not include signature header when no secret', async () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      transport.emit(createTestEvent());

      await new Promise((r) => setTimeout(r, 50));

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers['X-Webhook-Signature']).toBeUndefined();
    });
  });

  describe('retries', () => {
    it('should retry on failure', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ ok: true });

      transport = new WebhookEventTransport({
        fetchFn: mockFetch,
        defaultTimeout: 1000,
        defaultRetries: 3,
        retryDelay: 10, // Fast retries for tests
      });

      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      transport.emit(createTestEvent());

      // Wait for retries
      await new Promise((r) => setTimeout(r, 200));

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should retry on non-ok response', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
        .mockResolvedValueOnce({ ok: true });

      transport = new WebhookEventTransport({
        fetchFn: mockFetch,
        defaultTimeout: 1000,
        defaultRetries: 3,
        retryDelay: 10,
      });

      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      transport.emit(createTestEvent());

      await new Promise((r) => setTimeout(r, 200));

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscribe / subscribeAll', () => {
    it('should call local subscribers on emit', () => {
      const callback = vi.fn();
      transport.subscribe('run-123', callback);

      const event = createTestEvent({ runId: 'run-123' });
      transport.emit(event);

      expect(callback).toHaveBeenCalledWith(event);
    });

    it('should not call subscriber for different runId', () => {
      const callback = vi.fn();
      transport.subscribe('run-123', callback);

      const event = createTestEvent({ runId: 'run-456' });
      transport.emit(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should call global subscribers for all events', () => {
      const callback = vi.fn();
      transport.subscribeAll(callback);

      transport.emit(createTestEvent({ runId: 'run-1' }));
      transport.emit(createTestEvent({ runId: 'run-2' }));

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should unsubscribe correctly', () => {
      const callback = vi.fn();
      const unsubscribe = transport.subscribe('run-123', callback);

      unsubscribe();

      transport.emit(createTestEvent({ runId: 'run-123' }));
      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle callback errors gracefully', () => {
      const errorCallback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      const normalCallback = vi.fn();

      transport.subscribe('run-123', errorCallback);
      transport.subscribe('run-123', normalCallback);

      transport.emit(createTestEvent({ runId: 'run-123' }));

      expect(errorCallback).toHaveBeenCalled();
      expect(normalCallback).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should clear all endpoints and subscribers', () => {
      transport.addEndpoint({
        id: 'test-1',
        url: 'https://example.com/webhook',
      });

      const callback = vi.fn();
      transport.subscribe('run-123', callback);
      transport.subscribeAll(vi.fn());

      transport.close();

      expect(transport.getEndpoints()).toHaveLength(0);

      // Callback should not be called after close
      transport.emit(createTestEvent({ runId: 'run-123' }));
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('constructor with initial endpoints', () => {
    it('should register initial endpoints', () => {
      transport = new WebhookEventTransport({
        fetchFn: mockFetch,
        endpoints: [
          { id: 'ep-1', url: 'https://example.com/1' },
          { id: 'ep-2', url: 'https://example.com/2' },
        ],
      });

      expect(transport.getEndpoints()).toHaveLength(2);
    });
  });
});
