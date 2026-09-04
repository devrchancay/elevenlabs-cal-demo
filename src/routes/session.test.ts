import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadEnv } from '../lib/env.js';
import type { SessionState } from '../lib/session.js';
import type { FakeCal } from '../test/helpers.js';
import { fakeCalClient } from '../test/helpers.js';

const TOKEN = process.env.TOOLS_SHARED_SECRET as string;

/** Friday 4 September 2026, 10:00 in Guayaquil. */
const NOW = new Date('2026-09-04T15:00:00.000Z');

const SCHEDULE: Record<string, string[]> = {
  '2026-09-08': ['09:00', '11:00', '15:00'],
};

let app: FastifyInstance;
let cal: FakeCal;

beforeEach(async () => {
  cal = fakeCalClient({ slotsByDate: SCHEDULE });
  const built = await buildApp({
    env: loadEnv(),
    cal: cal.client,
    now: () => NOW,
    conversationLog: {
      append: async () => ({ stored: true, duplicate: false }),
      all: async () => [],
      stats: async () => ({
        conversations: 0,
        booked: 0,
        successful: 0,
        averageDurationSeconds: 0,
      }),
    },
  });
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function readSession(bookingKey: string): Promise<SessionState> {
  const response = await app.inject({ method: 'GET', url: `/agent/session/${bookingKey}` });
  expect(response.statusCode).toBe(200);
  return response.json() as SessionState;
}

async function lookUpAvailability(bookingKey: string, date = '2026-09-08'): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/tools/availability',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { date, partOfDay: 'any', bookingKey },
  });
  expect(response.statusCode).toBe(200);
}

describe('GET /agent/session/:bookingKey', () => {
  it('is public: the page holds no secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/agent/session/conv_public' });
    expect(response.statusCode).toBe(200);
  });

  it('allows cross-origin reads, since the landing lives elsewhere', async () => {
    const response = await app.inject({ method: 'GET', url: '/agent/session/conv_cors' });
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers an empty state for a conversation that has not looked anything up', async () => {
    const state = await readSession('conv_unknown');
    expect(state).toEqual({
      options: [],
      searchedDate: '',
      isAlternativeDate: false,
      booking: null,
      revision: 0,
    });
  });

  it('rejects a malformed key instead of treating it as a miss', async () => {
    const response = await app.inject({ method: 'GET', url: '/agent/session/has%20a%20space' });
    expect(response.statusCode).toBe(400);
  });

  it('exposes the options the agent was just offered', async () => {
    await lookUpAvailability('conv_offer');

    const state = await readSession('conv_offer');
    expect(state.options).toHaveLength(3);
    expect(state.options[0]).toMatchObject({ id: 'opt_1' });
    expect(state.options[0]?.spokenLabel).toContain('nueve de la mañana');
    expect(state.searchedDate).toBe('2026-09-08');
    expect(state.booking).toBeNull();
  });

  it('bumps the revision on every write, so polling can compare one integer', async () => {
    await lookUpAvailability('conv_rev');
    const first = await readSession('conv_rev');

    await lookUpAvailability('conv_rev', '2026-09-08');
    const second = await readSession('conv_rev');

    expect(second.revision).toBe(first.revision + 1);
  });

  it('does not leak between conversations', async () => {
    await lookUpAvailability('conv_a');

    const other = await readSession('conv_b');
    expect(other.options).toHaveLength(0);
  });

  it('reports the appointment once it exists', async () => {
    await lookUpAvailability('conv_booked');

    const booking = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        optionId: 'opt_2',
        name: 'Ana Pérez',
        email: 'ana@gmail.com',
        bookingKey: 'conv_booked',
      },
    });
    expect(booking.json()).toMatchObject({ booked: true });

    const state = await readSession('conv_booked');
    expect(state.booking).toMatchObject({
      optionId: 'opt_2',
      status: 'booked',
      bookingUid: 'uid_1',
    });
    // The options stay on screen so the chosen one can be highlighted.
    expect(state.options).toHaveLength(3);
  });

  it('never returns the caller name or email, on any path', async () => {
    await lookUpAvailability('conv_pii');
    await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        optionId: 'opt_1',
        name: 'Ana Pérez',
        email: 'ana@gmail.com',
        bookingKey: 'conv_pii',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/agent/session/conv_pii' });
    const body = response.body;

    expect(body).not.toContain('Ana');
    expect(body).not.toContain('Pérez');
    expect(body).not.toContain('ana@gmail.com');
    expect(body).not.toContain('gmail');
  });

  it('says pending when Cal.com needs the owner to confirm', async () => {
    await app.close();
    cal = fakeCalClient({ slotsByDate: SCHEDULE, bookingStatus: 'pending' });
    const built = await buildApp({
      env: loadEnv(),
      cal: cal.client,
      now: () => NOW,
      conversationLog: {
        append: async () => ({ stored: true, duplicate: false }),
        all: async () => [],
        stats: async () => ({
          conversations: 0,
          booked: 0,
          successful: 0,
          averageDurationSeconds: 0,
        }),
      },
    });
    app = built.app;
    await app.ready();

    await lookUpAvailability('conv_pending');
    await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        optionId: 'opt_1',
        name: 'Ana Pérez',
        email: 'ana@gmail.com',
        bookingKey: 'conv_pending',
      },
    });

    const state = await readSession('conv_pending');
    expect(state.booking?.status).toBe('pending');
  });

  it('keeps nothing for a lookup made without a bookingKey', async () => {
    await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { date: '2026-09-08' },
    });

    const state = await readSession('__global__');
    expect(state.options).toHaveLength(0);
  });
});
