/**
 * Tests for verifyWebhookSignature / signWebhookPayload (audit finding L2).
 *
 * Round-trips against the WebCrypto-based signer used by WebhookEventTransport
 * to confirm both implementations agree on the wire format.
 */

import { describe, it, expect } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './webhook-signature';

async function signWithWebCrypto(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

describe('signWebhookPayload', () => {
  it('produces a sha256= prefixed lowercase hex digest', () => {
    const sig = signWebhookPayload('hello', 'shhh');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('matches the WebCrypto signer used by WebhookEventTransport', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'run.completed' });
    const secret = 'whsec_test';
    const fromHelper = signWebhookPayload(payload, secret);
    const fromWebCrypto = await signWithWebCrypto(payload, secret);
    expect(fromHelper).toBe(fromWebCrypto);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test';
  const payload = '{"event":"ping"}';

  it('verifies a signature produced by the helper', () => {
    const sig = signWebhookPayload(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it('verifies a signature produced by WebCrypto signer (cross-impl)', async () => {
    const sig = await signWithWebCrypto(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it('accepts the digest with or without the sha256= prefix', () => {
    const sig = signWebhookPayload(payload, secret);
    const bare = sig.slice('sha256='.length);
    expect(verifyWebhookSignature(payload, bare, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signWebhookPayload(payload, secret);
    expect(verifyWebhookSignature(payload + 'X', sig, secret)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const sig = signWebhookPayload(payload, secret);
    const flipped = `sha256=${'0'.repeat(64)}`;
    expect(verifyWebhookSignature(payload, flipped, secret)).toBe(false);
    // last char tweak still rejects (timingSafeEqual on non-equal hashes)
    const tweaked = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
    expect(verifyWebhookSignature(payload, tweaked, secret)).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    const sig = signWebhookPayload(payload, secret);
    expect(verifyWebhookSignature(payload, sig, 'other-secret')).toBe(false);
  });

  it('rejects empty / missing inputs', () => {
    const sig = signWebhookPayload(payload, secret);
    expect(verifyWebhookSignature(payload, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, null, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, '', secret)).toBe(false);
    expect(verifyWebhookSignature(payload, sig, '')).toBe(false);
  });

  it('rejects non-hex signature strings without throwing', () => {
    expect(verifyWebhookSignature(payload, 'sha256=not-hex-content', secret)).toBe(false);
    expect(verifyWebhookSignature(payload, 'sha256=zzzz', secret)).toBe(false);
  });

  it('rejects digests of the wrong length without throwing', () => {
    expect(verifyWebhookSignature(payload, 'sha256=abcd', secret)).toBe(false);
    expect(verifyWebhookSignature(payload, `sha256=${'a'.repeat(63)}`, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, `sha256=${'a'.repeat(65)}`, secret)).toBe(false);
  });

  it('treats the digest case-insensitively', () => {
    const sig = signWebhookPayload(payload, secret);
    const upper = `sha256=${sig.slice('sha256='.length).toUpperCase()}`;
    expect(verifyWebhookSignature(payload, upper, secret)).toBe(true);
  });

  it('handles Uint8Array bodies', () => {
    const body = new TextEncoder().encode(payload);
    const sig = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    // string and Uint8Array of identical bytes should agree
    expect(signWebhookPayload(body, secret)).toBe(signWebhookPayload(payload, secret));
  });
});
