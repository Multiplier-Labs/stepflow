/**
 * Helpers for signing and verifying inbound/outbound webhook payloads.
 *
 * Both sides use HMAC-SHA256 with the prefix `sha256=` followed by a lowercase
 * hex digest — the same shape produced by `WebhookEventTransport.signPayload`,
 * matching common third-party providers (Stripe, GitHub, etc.).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the canonical signature header for a request body.
 *
 * Returns a string of the form `sha256=<lowercase-hex>`.
 */
export function signWebhookPayload(body: string | Uint8Array, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Constant-time verification of an inbound webhook signature.
 *
 * @param body      The raw request body that was signed.
 * @param signature The header value sent by the producer (e.g. `sha256=…`).
 * @param secret    The shared HMAC secret.
 * @returns `true` only if the computed digest matches the supplied signature.
 *
 * Properties:
 *  - Accepts an optional `sha256=` prefix on the signature, but does not
 *    require it (mirrors common third-party header conventions).
 *  - Uses `timingSafeEqual` so an attacker cannot probe digit-by-digit.
 *  - Returns `false` for missing/empty values, non-hex input, and length
 *    mismatches without throwing.
 *  - Returns `false` if the secret is empty — an empty secret is almost
 *    always a misconfiguration we do not want to silently accept.
 */
export function verifyWebhookSignature(
  body: string | Uint8Array,
  signature: string | undefined | null,
  secret: string
): boolean {
  if (!secret || typeof signature !== 'string' || signature.length === 0) {
    return false;
  }

  const provided = signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;

  // Hex-encoded SHA-256 is always exactly 64 characters; reject anything
  // else so we don't mistake other algorithms for ours.
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return false;
  }

  const expectedHex = signWebhookPayload(body, secret).slice('sha256='.length);

  // Length mismatch: timingSafeEqual would throw, and exposing the digest
  // length is fine — it's a public property of the algorithm.
  if (provided.length !== expectedHex.length) {
    return false;
  }

  const a = Buffer.from(provided.toLowerCase(), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
