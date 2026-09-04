import { describe, expect, it } from 'vitest';

import { loadEnv } from './env.js';

const BASE = {
  CAL_API_KEY: 'cal_live_x',
  CAL_EVENT_TYPE_ID: '123456',
  TOOLS_SHARED_SECRET: 'a-secret-that-is-long-enough',
};

describe('loadEnv', () => {
  it('applies the project defaults', () => {
    const env = loadEnv({ ...BASE } as NodeJS.ProcessEnv);

    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.BUSINESS_TIMEZONE).toBe('America/Guayaquil');
    expect(env.CAL_API_BASE_URL).toBe('https://api.cal.com/v2');
  });

  it('reads the PORT Railway injects', () => {
    const env = loadEnv({ ...BASE, PORT: '8080' } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(8080);
  });

  it('dies with a clear message when the Cal.com API key is missing', () => {
    const { CAL_API_KEY: _omitted, ...withoutKey } = BASE;

    expect(() => loadEnv(withoutKey as NodeJS.ProcessEnv)).toThrow(/CAL_API_KEY/);
  });

  it('requires a tools secret that is not trivial', () => {
    expect(() => loadEnv({ ...BASE, TOOLS_SHARED_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(
      /at least 16 characters/,
    );
  });

  it('rejects a non-numeric event type id', () => {
    expect(() =>
      loadEnv({ ...BASE, CAL_EVENT_TYPE_ID: 'consulta-30' } as NodeJS.ProcessEnv),
    ).toThrow(/CAL_EVENT_TYPE_ID/);
  });

  it('rejects impossible business hours', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        BUSINESS_HOURS_START: '18',
        BUSINESS_HOURS_END: '9',
      } as NodeJS.ProcessEnv),
    ).toThrow(/BUSINESS_HOURS_END/);
  });

  it('treats an empty value as absent, so .env.example placeholders work', () => {
    // .env.example ships every key empty for the developer to fill in, and
    // docker compose forwards those as empty strings rather than omitting them.
    const env = loadEnv({
      ...BASE,
      ELEVENLABS_WEBHOOK_SECRET: '',
      BUSINESS_TIMEZONE: '',
      LOG_LEVEL: '   ',
    } as NodeJS.ProcessEnv);

    expect(env.ELEVENLABS_WEBHOOK_SECRET).toBeUndefined();
    // Falls back to the default rather than failing validation.
    expect(env.BUSINESS_TIMEZONE).toBe('America/Guayaquil');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('still reports a required variable left empty, by name', () => {
    const error = (() => {
      try {
        loadEnv({ ...BASE, CAL_API_KEY: '' } as NodeJS.ProcessEnv);
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error?.message).toContain('CAL_API_KEY is required');
  });

  it('lists every problem at once', () => {
    const error = (() => {
      try {
        loadEnv({} as NodeJS.ProcessEnv);
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error?.message).toContain('CAL_API_KEY');
    expect(error?.message).toContain('CAL_EVENT_TYPE_ID');
    expect(error?.message).toContain('TOOLS_SHARED_SECRET');
  });
});
