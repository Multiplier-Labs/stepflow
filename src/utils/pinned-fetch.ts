/**
 * DNS-pinned fetch helper.
 *
 * Performs an HTTP(S) request that connects to a caller-supplied IP address
 * instead of re-resolving the URL hostname. Used by the webhook transport to
 * close the SSRF DNS-rebinding TOCTOU window between SSRF validation and the
 * actual request: the hostname is resolved exactly once (by the caller), the
 * resolved IP is validated, and the resolved IP is then pinned for the
 * connection so the request cannot be rerouted by a hostile DNS server.
 *
 * The original hostname is preserved for TLS SNI / certificate verification
 * and for the HTTP `Host` header.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupAddress, LookupOptions } from 'node:dns';

/** Minimal fetch-compatible Response surface used by the webhook transport. */
export interface PinnedFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
}

/** Subset of `RequestInit` accepted by `pinnedFetch`. */
export interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Make an HTTP(S) request that connects to `address` instead of resolving
 * `url`'s hostname. Returns a minimal `Response`-shaped object compatible
 * with the webhook transport's status/ok checks.
 *
 * @throws Error on network/transport failure or abort
 */
export function pinnedFetch(
  url: string,
  init: PinnedFetchInit,
  address: string,
  family: 4 | 6 = 4
): Promise<PinnedFetchResponse> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = parsed.port
    ? Number(parsed.port)
    : isHttps
      ? 443
      : 80;

  // `lookup` is invoked by the agent's socket-create path. By returning the
  // pre-validated address here we guarantee the TCP connection target matches
  // the IP whose safety the caller already verified.
  //
  // Node may invoke this with `{ all: true }` (expects an array result) or
  // single-address mode (expects positional address/family). Handle both so
  // the pin works across Node versions.
  const lookup = (
    _hostname: string,
    options: LookupOptions,
    cb: (err: NodeJS.ErrnoException | null, addr: string | LookupAddress[], fam?: number) => void
  ): void => {
    if (options && options.all === true) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  };

  return new Promise<PinnedFetchResponse>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname || '/'}${parsed.search}`,
        method: init.method ?? 'GET',
        headers: init.headers,
        lookup,
        servername: parsed.hostname,
      },
      (res) => {
        // Drain the body — we only inspect status, but leaving the socket in
        // a half-read state would leak it.
        res.resume();
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? '',
          });
        });
        res.on('error', reject);
      }
    );

    req.on('error', reject);

    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy(new Error('Request aborted'));
      } else {
        init.signal.addEventListener(
          'abort',
          () => req.destroy(new Error('Request aborted')),
          { once: true }
        );
      }
    }

    if (init.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
}
