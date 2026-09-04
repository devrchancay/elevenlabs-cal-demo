import { describe, expect, it } from 'vitest';

import bookingFixture from '../test/fixtures/cal-booking.json' with { type: 'json' };
import emptyFixture from '../test/fixtures/cal-slots-empty.json' with { type: 'json' };
import slotsFixture from '../test/fixtures/cal-slots.json' with { type: 'json' };
import { fakeFetch, queryOf } from '../test/helpers.js';
import {
  CAL_API_VERSION_BOOKINGS,
  CAL_API_VERSION_SLOTS,
  CalApiError,
  createCalClient,
} from './cal.js';

const TZ = 'America/Guayaquil';

function clientWith(responder: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(responder);
  const client = createCalClient({
    apiKey: 'cal_test_key',
    eventTypeId: 123456,
    baseUrl: 'https://api.cal.com/v2',
    fetchImpl: fake.fn,
  });
  return { client, fake };
}

describe('getSlots', () => {
  it('asks for the UTC range that covers the whole local day', async () => {
    const { client, fake } = clientWith(() => ({ body: slotsFixture }));

    await client.getSlots({ date: '2026-09-08', timeZone: TZ });

    const call = fake.calls[0]!;
    const query = queryOf(call.url);

    expect(call.method).toBe('GET');
    // start and end go in UTC even though timeZone is something else: that is
    // what the API requires.
    expect(query.start).toBe('2026-09-08T05:00:00.000Z');
    expect(query.end).toBe('2026-09-09T04:59:59.999Z');
    expect(query.timeZone).toBe(TZ);
    expect(query.eventTypeId).toBe('123456');
  });

  it('sends the slots API version and the bearer', async () => {
    const { client, fake } = clientWith(() => ({ body: slotsFixture }));

    await client.getSlots({ date: '2026-09-08', timeZone: TZ });

    expect(fake.calls[0]!.headers['cal-api-version']).toBe(CAL_API_VERSION_SLOTS);
    expect(fake.calls[0]!.headers.authorization).toBe('Bearer cal_test_key');
  });

  /**
   * Node's fetch sends no User-Agent, and the Cloudflare layer in front of
   * api.cal.com answers an anonymous request with a 403 challenge page even
   * when the key is valid. Without this header the calendar simply stops
   * working, and the error reads like an auth failure, so it is pinned here
   * before someone deletes it as decoration.
   */
  it('identifies itself, or Cloudflare answers 403 instead of Cal.com', async () => {
    const { client, fake } = clientWith(() => ({ body: slotsFixture }));

    await client.getSlots({ date: '2026-09-08', timeZone: TZ });

    expect(fake.calls[0]!.headers['user-agent']).toMatch(/^elevenlabs-agent-backend\//);
  });

  it('returns only the requested day, not the neighbouring one', async () => {
    const { client } = clientWith(() => ({ body: slotsFixture }));

    const slots = await client.getSlots({ date: '2026-09-08', timeZone: TZ });

    expect(slots).toHaveLength(12);
    expect(slots[0]!.start.toISOString()).toBe('2026-09-08T14:00:00.000Z');
    expect(slots.at(-1)!.start.toISOString()).toBe('2026-09-08T21:30:00.000Z');
  });

  it('returns an empty list when there is no availability', async () => {
    const { client } = clientWith(() => ({ body: emptyFixture }));

    await expect(client.getSlots({ date: '2026-09-08', timeZone: TZ })).resolves.toEqual([]);
  });

  it('rejects an unexpected response shape instead of inventing fields', async () => {
    const { client } = clientWith(() => ({ body: { status: 'success', data: 'nope' } }));

    await expect(client.getSlots({ date: '2026-09-08', timeZone: TZ })).rejects.toThrow(
      /expected shape/i,
    );
  });
});

describe('createBooking', () => {
  const input = {
    start: new Date('2026-09-08T15:00:00.000Z'),
    attendeeName: 'Ramón Chancay',
    attendeeEmail: 'ramon@example.com',
    timeZone: TZ,
    bookingKey: 'conv_abc123',
  };

  it('sends the time in UTC and the bookings API version', async () => {
    const { client, fake } = clientWith(() => ({ status: 201, body: bookingFixture }));

    await client.createBooking(input);

    const call = fake.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['cal-api-version']).toBe(CAL_API_VERSION_BOOKINGS);
    expect(call.body).toMatchObject({
      start: '2026-09-08T15:00:00.000Z',
      eventTypeId: 123456,
      attendee: {
        name: 'Ramón Chancay',
        email: 'ramon@example.com',
        timeZone: TZ,
        language: 'es',
      },
      metadata: { bookingKey: 'conv_abc123' },
    });
  });

  it('returns the booking uid and status', async () => {
    const { client } = clientWith(() => ({ status: 201, body: bookingFixture }));

    const booking = await client.createBooking(input);

    expect(booking.uid).toBe('rW8kZ3qP2mNvY7bLxT4dCe');
    expect(booking.status).toBe('accepted');
  });

  it('maps the 409 for a taken slot to a conflict error', async () => {
    const { client } = clientWith(() => ({
      status: 409,
      body: {
        status: 'error',
        error: {
          code: 'ConflictException',
          message: 'User either already has booking at this time or is not available',
        },
      },
    }));

    await expect(client.createBooking(input)).rejects.toMatchObject({
      name: 'CalApiError',
      kind: 'conflict',
      httpStatus: 409,
    });
  });

  it('maps a 401 to unauthorized', async () => {
    const { client } = clientWith(() => ({
      status: 401,
      body: { error: { code: 'UnauthorizedException', message: 'Invalid API Key' } },
    }));

    const error = await client.createBooking(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CalApiError);
    expect((error as CalApiError).kind).toBe('unauthorized');
  });

  it('maps a 400 to bad_request', async () => {
    const { client } = clientWith(() => ({
      status: 400,
      body: { error: { code: 'BadRequestException', message: 'start property is wrong' } },
    }));

    await expect(client.createBooking(input)).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('omits metadata when there is no bookingKey', async () => {
    const { client, fake } = clientWith(() => ({ status: 201, body: bookingFixture }));

    await client.createBooking({ ...input, bookingKey: undefined });

    expect(fake.calls[0]!.body).not.toHaveProperty('metadata');
  });
});
