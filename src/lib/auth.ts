/**
 * Verification of inbound credentials.
 *
 * The tool endpoints are public on the internet, so they are protected by a
 * bearer secret shared with ElevenLabs. The post-call webhook carries no bearer:
 * it is verified by HMAC signature, because ElevenLabs signs the body with its
 * own secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison that tolerates differing lengths. */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Compared against itself so the length is not leaked through timing.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Extracts the token from an `Authorization` header.
 *
 * Both `Bearer <token>` and a bare token are accepted. Reason: in ElevenLabs the
 * whole header value is replaced by the secret from the Secrets Manager, and
 * there is no documented way to prepend the "Bearer " prefix to it. Accepting
 * both forms removes that failure mode without weakening anything: the secret is
 * the same and it is still compared in constant time.
 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (match?.[1]) return match[1].trim();

  // Bare token. Any other known auth scheme is rejected.
  if (/^\S+\s/.test(trimmed)) return null;
  return trimmed;
}

export function isValidBearer(header: string | undefined, expected: string): boolean {
  const token = extractBearer(header);
  if (!token) return false;
  return safeCompare(token, expected);
}

/* -------------------------------------------------------------------------- */
/* Post-call webhook HMAC                                                      */
/* -------------------------------------------------------------------------- */

export interface SignatureParts {
  timestamp: number;
  hash: string;
}

/**
 * Parses the signature header, formatted as `t=1719000000,v0=abc123…`.
 * Returns null if it does not look like anything valid.
 */
export function parseSignatureHeader(header: string | undefined): SignatureParts | null {
  if (!header) return null;

  let timestamp: number | null = null;
  let hash: string | null = null;

  for (const chunk of header.split(',')) {
    const trimmed = chunk.trim();
    // Split on the first '=' and keep the rest intact: `split('=', 2)` would
    // truncate a value that happens to contain another '='.
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!value) continue;

    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v0') {
      hash = value;
    }
  }

  if (timestamp === null || hash === null) return null;
  return { timestamp, hash };
}

export interface VerifyWebhookInput {
  /** Raw body, byte for byte. Re-serializing the JSON invalidates the signature. */
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string;
  /** Tolerance window against replays. */
  toleranceSeconds?: number;
  now?: Date;
}

export type WebhookVerification =
  | { valid: true }
  | { valid: false; reason: 'missing_signature' | 'stale_timestamp' | 'bad_signature' };

/**
 * Verifies the HMAC-SHA256 signature from ElevenLabs.
 * The signed string is `${timestamp}.${rawBody}`.
 */
export function verifyWebhookSignature(input: VerifyWebhookInput): WebhookVerification {
  const parts = parseSignatureHeader(input.signatureHeader);
  if (!parts) return { valid: false, reason: 'missing_signature' };

  const tolerance = input.toleranceSeconds ?? 30 * 60;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - parts.timestamp) > tolerance) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const expected = createHmac('sha256', input.secret)
    .update(`${parts.timestamp}.${input.rawBody}`)
    .digest('hex');

  const received = parts.hash.startsWith('v0=') ? parts.hash.slice(3) : parts.hash;

  return safeCompare(expected, received)
    ? { valid: true }
    : { valid: false, reason: 'bad_signature' };
}

/** Produces a signature in the same format. Used by tests and scripts. */
export function signWebhookPayload(rawBody: string, secret: string, timestamp: number): string {
  const hash = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v0=${hash}`;
}
