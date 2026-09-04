import { describe, expect, it } from 'vitest';

import {
  extractBearer,
  isValidBearer,
  parseSignatureHeader,
  safeCompare,
  signWebhookPayload,
  verifyWebhookSignature,
} from './auth.js';

const SECRET = 'wsec_a_test_secret';
const BODY = '{"type":"post_call_transcription","event_timestamp":1789000000}';

describe('safeCompare', () => {
  it('compares without leaking the length', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abd')).toBe(false);
    expect(safeCompare('abc', 'abcdef')).toBe(false);
    expect(safeCompare('', '')).toBe(true);
  });
});

describe('extractBearer', () => {
  it('accepts the standard format', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
    expect(extractBearer('bearer abc123')).toBe('abc123');
    expect(extractBearer('  Bearer   abc123  ')).toBe('abc123');
  });

  it('accepts a bare token, because ElevenLabs replaces the whole header', () => {
    expect(extractBearer('abc123')).toBe('abc123');
  });

  it('rejects other authentication schemes', () => {
    expect(extractBearer('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
  });
});

describe('isValidBearer', () => {
  it('accepts the right secret in both formats', () => {
    expect(isValidBearer('Bearer s3cr3t', 's3cr3t')).toBe(true);
    expect(isValidBearer('s3cr3t', 's3cr3t')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidBearer('Bearer other', 's3cr3t')).toBe(false);
    expect(isValidBearer(undefined, 's3cr3t')).toBe(false);
  });
});

describe('parseSignatureHeader', () => {
  it('parses the t=...,v0=... format', () => {
    expect(parseSignatureHeader('t=1789000000,v0=deadbeef')).toEqual({
      timestamp: 1789000000,
      hash: 'deadbeef',
    });
  });

  it('does not depend on the order of the parts', () => {
    expect(parseSignatureHeader('v0=deadbeef,t=1789000000')).toEqual({
      timestamp: 1789000000,
      hash: 'deadbeef',
    });
  });

  it('returns null when a part is missing', () => {
    expect(parseSignatureHeader('t=1789000000')).toBeNull();
    expect(parseSignatureHeader('v0=deadbeef')).toBeNull();
    expect(parseSignatureHeader('anything at all')).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
  });
});

describe('verifyWebhookSignature', () => {
  const now = new Date('2026-09-04T15:00:00.000Z');
  const timestamp = Math.floor(now.getTime() / 1000);

  it('accepts a valid signature', () => {
    const header = signWebhookPayload(BODY, SECRET, timestamp);

    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: header, secret: SECRET, now }),
    ).toEqual({ valid: true });
  });

  it('rejects a missing signature', () => {
    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: undefined, secret: SECRET, now }),
    ).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('rejects a signature made with a different secret', () => {
    const header = signWebhookPayload(BODY, 'the_wrong_secret', timestamp);

    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: header, secret: SECRET, now }),
    ).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a body that changed by even one byte', () => {
    const header = signWebhookPayload(BODY, SECRET, timestamp);

    expect(
      verifyWebhookSignature({
        rawBody: `${BODY} `,
        signatureHeader: header,
        secret: SECRET,
        now,
      }),
    ).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a stale signature, guarding against replays', () => {
    const stale = timestamp - 31 * 60;
    const header = signWebhookPayload(BODY, SECRET, stale);

    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: header, secret: SECRET, now }),
    ).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('accepts within the 30 minute window', () => {
    const almostStale = timestamp - 29 * 60;
    const header = signWebhookPayload(BODY, SECRET, almostStale);

    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: header, secret: SECRET, now }),
    ).toEqual({ valid: true });
  });

  it('accepts a hash carrying a repeated v0= prefix', () => {
    const header = signWebhookPayload(BODY, SECRET, timestamp);
    const hash = header.split('v0=')[1] as string;

    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `t=${timestamp},v0=v0=${hash}`,
        secret: SECRET,
        now,
      }),
    ).toEqual({ valid: true });
  });
});
