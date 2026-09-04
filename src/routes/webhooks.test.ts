import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { signWebhookPayload } from '../lib/auth.js';
import type { ConversationLog } from '../lib/conversations.js';
import { createConversationLog } from '../lib/conversations.js';
import { loadEnv } from '../lib/env.js';
import { fakeCalClient } from '../test/helpers.js';
import { extractBooking, toRecord } from './webhooks.js';

const SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET as string;
const TOKEN = process.env.TOOLS_SHARED_SECRET as string;

let app: FastifyInstance;
let log: ConversationLog;
let dir: string;

/** Realistic post_call_transcription payload. */
function payloadFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { data: dataOverrides, ...topLevel } = overrides;

  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: 'agent_123',
      conversation_id: 'conv_abc',
      status: 'done',
      transcript: [
        { role: 'agent', message: 'Hola, soy el asistente. ¿En qué te ayudo?' },
        { role: 'user', message: 'Quiero una cita el martes.' },
        {
          role: 'agent',
          message: null,
          tool_results: [
            {
              type: 'webhook',
              tool_name: 'book_appointment',
              result_value: '{"booked":true,"bookingUid":"uid_9"}',
              is_error: false,
            },
          ],
        },
      ],
      metadata: { start_time_unix_secs: 1789000000, call_duration_secs: 97 },
      analysis: { call_successful: 'success', transcript_summary: 'Agendó una cita.' },
      ...(dataOverrides as Record<string, unknown> | undefined),
    },
    ...topLevel,
  };
}

async function post(body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/post-call',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'elevenlabs-signature': signature } : {}),
    },
    payload: raw,
  });
}

function sign(body: unknown): string {
  return signWebhookPayload(JSON.stringify(body), SECRET, Math.floor(Date.now() / 1000));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'convlog-'));
  log = createConversationLog(join(dir, 'conversations.json'));

  const built = await buildApp({
    env: loadEnv(),
    cal: fakeCalClient().client,
    conversationLog: log,
  });
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /webhooks/post-call', () => {
  it('rejects a request with no signature', async () => {
    const res = await post(payloadFor());

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: 'invalid_signature',
      reason: 'missing_signature',
    });
    expect(await log.all()).toEqual([]);
  });

  it('rejects a signature made with a different secret', async () => {
    const body = payloadFor();
    const bad = signWebhookPayload(
      JSON.stringify(body),
      'the-wrong-secret',
      Math.floor(Date.now() / 1000),
    );

    const res = await post(body, bad);

    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('bad_signature');
  });

  it('rejects a stale signature', async () => {
    const body = payloadFor();
    const stale = signWebhookPayload(
      JSON.stringify(body),
      SECRET,
      Math.floor(Date.now() / 1000) - 45 * 60,
    );

    const res = await post(body, stale);

    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('stale_timestamp');
  });

  it('rejects a body altered after it was signed', async () => {
    const original = payloadFor();
    const signature = sign(original);

    const altered = payloadFor({ data: { conversation_id: 'conv_other' } });
    const res = await post(altered, signature);

    expect(res.statusCode).toBe(401);
  });

  it('records the conversation when the signature is valid', async () => {
    const body = payloadFor();
    const res = await post(body, sign(body));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, stored: true, duplicate: false });

    const records = await log.all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      conversationId: 'conv_abc',
      agentId: 'agent_123',
      durationSeconds: 97,
      callSuccessful: 'success',
      booked: true,
      bookingUid: 'uid_9',
      summary: 'Agendó una cita.',
    });
    expect(records[0]!.transcript).toHaveLength(3);
  });

  it('does not duplicate when ElevenLabs retries the same event', async () => {
    const body = payloadFor();
    const signature = sign(body);

    await post(body, signature);
    const second = await post(body, signature);

    expect(second.json()).toMatchObject({ stored: false, duplicate: true });
    expect(await log.all()).toHaveLength(1);
  });

  it('ignores events that are not transcriptions', async () => {
    const body = payloadFor({ type: 'post_call_audio' });
    const res = await post(body, sign(body));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: false, reason: 'ignored_type' });
  });

  it('answers 200 to an odd payload, so the webhook is not disabled', async () => {
    const body = { type: 'post_call_transcription', event_timestamp: 1 };
    const res = await post(body, sign(body));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: false, reason: 'unexpected_payload' });
  });
});

describe('GET /webhooks/stats', () => {
  it('requires the bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/webhooks/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('counts conversations and appointments', async () => {
    const withOutcome = (id: string, booked: boolean) =>
      payloadFor({
        data: {
          conversation_id: id,
          transcript: booked
            ? [
                {
                  role: 'agent',
                  tool_results: [
                    {
                      tool_name: 'book_appointment',
                      result_value: '{"booked":true,"bookingUid":"u"}',
                      is_error: false,
                    },
                  ],
                },
              ]
            : [{ role: 'agent', message: 'No agendamos nada.' }],
        },
      });

    for (const [id, booked] of [
      ['conv_1', true],
      ['conv_2', true],
      ['conv_3', false],
    ] as const) {
      const body = withOutcome(id, booked);
      await post(body, sign(body));
    }

    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/stats',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.json()).toMatchObject({ conversations: 3, booked: 2, successful: 3 });
  });
});

describe('extractBooking', () => {
  it('trusts the tool result, not what the agent said', () => {
    const transcript = [
      { role: 'agent', message: 'Listo, tu cita quedó agendada.' },
      {
        role: 'agent',
        tool_results: [
          { tool_name: 'book_appointment', result_value: '{"booked":false}', is_error: false },
        ],
      },
    ];

    expect(extractBooking(transcript)).toEqual({ booked: false });
  });

  it('ignores results flagged as errors', () => {
    const transcript = [
      {
        role: 'agent',
        tool_results: [
          { tool_name: 'book_appointment', result_value: '{"booked":true}', is_error: true },
        ],
      },
    ];

    expect(extractBooking(transcript)).toEqual({ booked: false });
  });

  it('ignores other tools', () => {
    const transcript = [
      {
        role: 'agent',
        tool_results: [
          { tool_name: 'check_availability', result_value: '{"booked":true}', is_error: false },
        ],
      },
    ];

    expect(extractBooking(transcript)).toEqual({ booked: false });
  });

  it('does not fall over when the tool returned something that is not JSON', () => {
    const transcript = [
      {
        role: 'agent',
        tool_results: [
          { tool_name: 'book_appointment', result_value: 'Tool Called.', is_error: false },
        ],
      },
    ];

    expect(extractBooking(transcript)).toEqual({ booked: false });
  });

  it('finds the booking uid', () => {
    const transcript = [
      {
        role: 'agent',
        tool_results: [
          {
            tool_name: 'book_appointment',
            result_value: '{"booked":true,"bookingUid":"uid_42"}',
            is_error: false,
          },
        ],
      },
    ];

    expect(extractBooking(transcript)).toEqual({ booked: true, bookingUid: 'uid_42' });
  });
});

describe('toRecord', () => {
  it('converts the unix timestamp to ISO', () => {
    const record = toRecord(
      {
        type: 'post_call_transcription',
        event_timestamp: 1789000100,
        data: {
          conversation_id: 'conv_x',
          transcript: [],
          metadata: { start_time_unix_secs: 1789000000, call_duration_secs: 42 },
        },
      },
      new Date('2026-09-04T15:00:00.000Z'),
    );

    expect(record.startedAt).toBe(new Date(1789000000 * 1000).toISOString());
    expect(record.durationSeconds).toBe(42);
    expect(record.callSuccessful).toBe('unknown');
    expect(record.receivedAt).toBe('2026-09-04T15:00:00.000Z');
  });
});
