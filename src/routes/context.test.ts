import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadEnv } from '../lib/env.js';
import { fakeCalClient } from '../test/helpers.js';

let app: FastifyInstance;

beforeEach(async () => {
  const built = await buildApp({
    env: loadEnv(),
    cal: fakeCalClient().client,
    now: () => new Date('2026-09-04T15:00:00.000Z'),
  });
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /agent/context', () => {
  it('returns the date in the business timezone, not in UTC', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/context' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      timeZone: 'America/Guayaquil',
      today: '2026-09-04',
      currentDateTime:
        'viernes 4 de septiembre de 2026 (2026-09-04), 10:00 hora de America/Guayaquil',
    });
  });

  it('is public: the landing page reads it without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/context' });
    expect(res.statusCode).not.toBe(401);
  });

  it('allows CORS, because the landing page lives on another origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/context' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('is never cached: a stale answer would make the agent think it is yesterday', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/context' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
