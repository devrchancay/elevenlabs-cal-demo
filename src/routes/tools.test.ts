import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { CalApiError } from '../lib/cal.js';
import { loadEnv } from '../lib/env.js';
import type { FakeCal, FakeCalOptions } from '../test/helpers.js';
import { fakeCalClient } from '../test/helpers.js';

const TOKEN = process.env.TOOLS_SHARED_SECRET as string;

/** Friday 4 September 2026, 10:00 in Guayaquil. */
const NOW = new Date('2026-09-04T15:00:00.000Z');

const SCHEDULE: Record<string, string[]> = {
  '2026-09-08': ['09:00', '09:30', '10:00', '11:00', '14:00', '15:00', '16:30'],
  '2026-09-09': ['10:00'],
};

let app: FastifyInstance;
let cal: FakeCal;

async function start(options: FakeCalOptions = { slotsByDate: SCHEDULE }): Promise<void> {
  cal = fakeCalClient(options);
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
}

const auth = { authorization: `Bearer ${TOKEN}` };

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await app.close();
});

describe('authentication', () => {
  it('rejects /tools/availability without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      payload: { date: '2026-09-08' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects /tools/book without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/tools/book', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects the wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { date: '2026-09-08' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('accepts the token without the Bearer prefix', async () => {
    // ElevenLabs replaces the whole header value with the stored secret, so the
    // token can arrive bare.
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: { authorization: TOKEN },
      payload: { date: '2026-09-08' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('leaves /health open', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('POST /tools/availability', () => {
  it('returns up to 3 options already phrased', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'any' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.found).toBe(true);
    expect(body.options).toHaveLength(3);
    expect(body.searchedDate).toBe('2026-09-08');
    expect(body.isAlternativeDate).toBe(false);
    expect(body.options[0].id).toBe('opt_1');
    expect(body.options[0].spokenLabel).toBe(
      'el martes 8 de septiembre a las nueve de la mañana',
    );
    expect(body.options[0].startsAt).toBe('2026-09-08T09:00:00-05:00');
    expect(body.spokenSummary).toContain('¿Cuál te sirve?');
  });

  it('says the date once instead of repeating it per option', async () => {
    // Read out loud, "el martes 8 a las nueve, el martes 8 a las diez y media,
    // el martes 8 a las once y media" is unbearable. The date belongs in the
    // sentence once, and the part of day at the end when they all share it.
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'morning' },
    });

    const { spokenSummary } = res.json();

    expect(spokenSummary).toBe(
      'Para el martes 8 de septiembre tengo a las nueve, a las diez ' +
        'o a las once de la mañana. ¿Cuál te sirve?',
    );
  });

  it('keeps the part of day per option when they differ', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'any' },
    });

    const { spokenSummary } = res.json();

    expect(spokenSummary).toContain('de la mañana');
    expect(spokenSummary).toContain('de la tarde');
    // The full date still appears exactly once.
    expect(spokenSummary.match(/de septiembre/g)).toHaveLength(1);
  });

  it('filters by part of day', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'afternoon' },
    });

    for (const option of res.json().options) {
      expect(option.spokenLabel).toContain('de la tarde');
    }
  });

  it('offers the rest of the day when the requested part is full', async () => {
    await app.close();
    await start({ slotsByDate: { '2026-09-08': ['09:00', '10:00', '11:00'] } });

    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'afternoon' },
    });

    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.isAlternativeDate).toBe(false);
    expect(body.spokenSummary).toContain('no me queda nada en la tarde');
  });

  it('scans the following days when the whole day is full', async () => {
    await app.close();
    await start({ slotsByDate: { '2026-09-10': ['10:00', '15:00'] } });

    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'any' },
    });

    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.isAlternativeDate).toBe(true);
    expect(body.searchedDate).toBe('2026-09-10');
    expect(body.spokenSummary).toContain('no me queda nada');
    expect(body.spokenSummary).toContain('jueves 10 de septiembre');
  });

  it('says there is nothing when the whole week is full', async () => {
    await app.close();
    await start({ slotsByDate: {} });

    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08' },
    });

    const body = res.json();
    expect(body.found).toBe(false);
    expect(body.options).toEqual([]);
    expect(body.spokenSummary).toContain('No tengo horarios disponibles');
  });

  it('rejects a payload without a date', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { partOfDay: 'morning' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('does not fall over when the model invents a part of day', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'mediodía' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
  });

  it('asks for the date again when it cannot interpret what arrived', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: 'la próxima semana' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(false);
    expect(res.json().spokenSummary).toContain('¿Me repites la fecha');
  });

  it('resolves "mañana" against the server clock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: 'mañana' },
    });

    // Tomorrow is the 5th, which is empty; the 8th is found as an alternative.
    expect(cal.slotCalls[0]!.date).toBe('2026-09-05');
    expect(res.json().searchedDate).toBe('2026-09-08');
  });
});

describe('POST /tools/book', () => {
  async function offerOptions(bookingKey = 'conv_test_1'): Promise<void> {
    await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', partOfDay: 'any', bookingKey },
    });
  }

  it('books using only the optionId', async () => {
    await offerOptions();

    const res = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: {
        optionId: 'opt_1',
        name: 'Ramón Chancay',
        email: 'Ramon@Example.com',
        bookingKey: 'conv_test_1',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.booked).toBe(true);
    expect(body.bookingUid).toBe('uid_1');
    expect(body.spokenConfirmation).toContain('martes 8 de septiembre a las nueve de la mañana');

    // The backend builds the time, not the model.
    expect(cal.bookingCalls).toHaveLength(1);
    expect(cal.bookingCalls[0]!.start.toISOString()).toBe('2026-09-08T14:00:00.000Z');
    expect(cal.bookingCalls[0]!.attendeeEmail).toBe('ramon@example.com');
    expect(cal.bookingCalls[0]!.timeZone).toBe('America/Guayaquil');
  });

  it('is idempotent per bookingKey', async () => {
    await offerOptions();

    const payload = {
      optionId: 'opt_1',
      name: 'Ramón Chancay',
      email: 'ramon@example.com',
      bookingKey: 'conv_test_1',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload,
    });

    expect(first.json().booked).toBe(true);
    expect(first.json().duplicate).toBeUndefined();

    expect(second.json().booked).toBe(true);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().bookingUid).toBe(first.json().bookingUid);

    // The point: exactly one appointment in Cal.com.
    expect(cal.bookingCalls).toHaveLength(1);
  });

  it('does not mix up the options of two different conversations', async () => {
    await app.close();
    await start({
      slotsByDate: {
        '2026-09-08': ['09:00', '10:00', '11:00'],
        '2026-09-09': ['15:00', '16:00', '17:00'],
      },
    });

    await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-08', bookingKey: 'conv_a' },
    });
    await app.inject({
      method: 'POST',
      url: '/tools/availability',
      headers: auth,
      payload: { date: '2026-09-09', bookingKey: 'conv_b' },
    });

    await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: {
        optionId: 'opt_1',
        name: 'Ana Ruiz',
        email: 'ana@example.com',
        bookingKey: 'conv_a',
      },
    });

    // conv_a picked opt_1 from its own list: the 8th at 09:00, not the 9th.
    expect(cal.bookingCalls[0]!.start.toISOString()).toBe('2026-09-08T14:00:00.000Z');
  });

  it('asks to re-check when the optionId is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: {
        optionId: 'opt_9',
        name: 'Ramón Chancay',
        email: 'ramon@example.com',
        bookingKey: 'conv_unknown',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ booked: false, reason: 'option_expired' });
    expect(cal.bookingCalls).toHaveLength(0);
  });

  it('rejects an invalid email before calling Cal.com', async () => {
    await offerOptions();

    const res = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: {
        optionId: 'opt_1',
        name: 'Ramón',
        email: 'not-an-email',
        bookingKey: 'conv_test_1',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe('email');
    expect(cal.bookingCalls).toHaveLength(0);
  });

  it('rejects a payload without a bookingKey', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: { optionId: 'opt_1', name: 'Ramón', email: 'ramon@example.com' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('says the slot was just taken', async () => {
    await app.close();
    await start({
      slotsByDate: SCHEDULE,
      bookingError: new CalApiError('conflict', 409, 'already booked'),
    });
    await offerOptions();

    const res = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: {
        optionId: 'opt_1',
        name: 'Ramón Chancay',
        email: 'ramon@example.com',
        bookingKey: 'conv_test_1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ booked: false, reason: 'slot_taken' });
    expect(res.json().spokenConfirmation).toContain('otras opciones');
  });

  it('does not claim "agendada" when Cal.com leaves the booking pending', async () => {
    await app.close();
    await start({ slotsByDate: SCHEDULE, bookingStatus: 'pending' });
    await offerOptions();

    const res = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: {
        optionId: 'opt_1',
        name: 'Ramón Chancay',
        email: 'ramon@example.com',
        bookingKey: 'conv_test_1',
      },
    });

    expect(res.json().booked).toBe(true);
    expect(res.json().spokenConfirmation).toContain('pendiente de confirmación');
  });

  it('answers with a speakable sentence when Cal.com is down', async () => {
    await app.close();
    await start({
      slotsByDate: SCHEDULE,
      bookingError: new CalApiError('unavailable', 0, 'timeout'),
    });
    await offerOptions();

    const res = await app.inject({
      method: 'POST',
      url: '/tools/book',
      headers: auth,
      payload: {
        optionId: 'opt_1',
        name: 'Ramón Chancay',
        email: 'ramon@example.com',
        bookingKey: 'conv_test_1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ booked: false, reason: 'cal_error' });
    expect(res.json().spokenConfirmation.length).toBeGreaterThan(10);
  });
});
