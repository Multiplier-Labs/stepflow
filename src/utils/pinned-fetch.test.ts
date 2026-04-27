/**
 * pinnedFetch is the linchpin of the M1 (DNS rebinding TOCTOU) fix: by
 * passing a `lookup` function that returns a caller-supplied IP, the TCP
 * connection cannot be re-resolved to a different address. We test it
 * against a real loopback HTTP server because ESM forbids spying on the
 * `http` module's exports and we want to exercise the real request path
 * end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { pinnedFetch } from './pinned-fetch';

describe('pinnedFetch', () => {
  let server: http.Server;
  let port: number;
  let lastRequest: { hostHeader?: string; method?: string; path?: string; body: string } = {
    body: '',
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastRequest = {
          hostHeader: req.headers.host,
          method: req.method,
          path: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(204, 'No Content');
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects to the pinned IP even when the URL hostname is unrelated', async () => {
    // The URL hostname is one that would never resolve to 127.0.0.1 via DNS.
    // pinnedFetch must ignore the URL's would-be DNS answer and connect to
    // the pinned address. If pinning is broken, the connection will fail
    // or hit a different host.
    const response = await pinnedFetch(
      `http://rebind.invalid:${port}/hook`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ok":1}' },
      '127.0.0.1',
      4,
    );

    expect(response.ok).toBe(true);
    expect(response.status).toBe(204);
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.path).toBe('/hook');
    expect(lastRequest.body).toBe('{"ok":1}');
  });

  it('preserves the original hostname in the Host header (vhost / TLS SNI)', async () => {
    await pinnedFetch(
      `http://example.test:${port}/`,
      { method: 'GET' },
      '127.0.0.1',
      4,
    );

    // The Host header must reflect the URL hostname, not the pinned IP, so
    // that virtual-host routing and TLS certificate validation work.
    expect(lastRequest.hostHeader).toContain('example.test');
  });

  it('rejects when the connection cannot be established', async () => {
    // Pin to a non-listening port on loopback.
    await expect(
      pinnedFetch(`http://example.test:1/`, { method: 'GET' }, '127.0.0.1', 4),
    ).rejects.toThrow();
  });
});
