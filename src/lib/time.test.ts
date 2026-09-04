import { describe, expect, it } from 'vitest';

import {
  addDaysIso,
  currentDateTimeForPrompt,
  dayBoundsUtc,
  formatOffset,
  getOffsetMinutes,
  getZonedParts,
  normalizeDateInput,
  parseIsoDate,
  partOfDayOf,
  spokenDate,
  spokenLabel,
  spokenTime,
  toIsoDate,
  toIsoWithOffset,
  zonedTimeToUtc,
} from './time.js';

const TZ = 'America/Guayaquil';

/** Frozen date: Friday 4 September 2026, 10:00 in Guayaquil. */
const NOW = new Date('2026-09-04T15:00:00.000Z');

describe('timezone offsets', () => {
  it('keeps Guayaquil at GMT-5 all year round', () => {
    const january = new Date('2026-01-15T12:00:00Z');
    const july = new Date('2026-07-15T12:00:00Z');

    expect(getOffsetMinutes(january, TZ)).toBe(-300);
    expect(getOffsetMinutes(july, TZ)).toBe(-300);
  });

  it('formats the offset in ISO form', () => {
    expect(formatOffset(-300)).toBe('-05:00');
    expect(formatOffset(0)).toBe('+00:00');
    expect(formatOffset(330)).toBe('+05:30');
    expect(formatOffset(-210)).toBe('-03:30');
  });

  it('detects daylight saving in zones that observe it', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');

    expect(getOffsetMinutes(winter, 'America/New_York')).toBe(-300);
    expect(getOffsetMinutes(summer, 'America/New_York')).toBe(-240);
  });
});

describe('wall clock to UTC conversion', () => {
  it('maps 10:00 in Guayaquil to 15:00 UTC', () => {
    const utc = zonedTimeToUtc({ year: 2026, month: 9, day: 8, hour: 10 }, TZ);
    expect(utc.toISOString()).toBe('2026-09-08T15:00:00.000Z');
  });

  it('survives the daylight saving jump in zones that have one', () => {
    // 2026-03-08 02:30 does not exist in New York; this must neither throw nor
    // produce NaN.
    const utc = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 12 }, 'America/New_York');
    expect(utc.toISOString()).toBe('2026-03-08T16:00:00.000Z');
  });

  it('round trips: parts to UTC and back to parts', () => {
    const utc = zonedTimeToUtc({ year: 2026, month: 9, day: 8, hour: 14, minute: 30 }, TZ);
    const parts = getZonedParts(utc, TZ);

    expect(parts).toMatchObject({ year: 2026, month: 9, day: 8, hour: 14, minute: 30 });
  });
});

describe('day boundaries', () => {
  it('covers the whole day in local time', () => {
    const { start, end } = dayBoundsUtc('2026-09-08', TZ);

    expect(start.toISOString()).toBe('2026-09-08T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-09T04:59:59.999Z');
  });

  it('works on the last day of the month', () => {
    const { start, end } = dayBoundsUtc('2026-09-30', TZ);

    expect(start.toISOString()).toBe('2026-09-30T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T04:59:59.999Z');
  });

  it('works on the last day of the year', () => {
    const { start } = dayBoundsUtc('2026-12-31', TZ);
    expect(start.toISOString()).toBe('2026-12-31T05:00:00.000Z');
  });
});

describe('ISO output with an explicit offset', () => {
  it('never emits implicit UTC', () => {
    const utc = zonedTimeToUtc({ year: 2026, month: 9, day: 8, hour: 10 }, TZ);
    expect(toIsoWithOffset(utc, TZ)).toBe('2026-09-08T10:00:00-05:00');
  });

  it('maps a UTC instant to the right local date', () => {
    // 03:00 UTC on the 9th is still 22:00 on the 8th in Guayaquil.
    const utc = new Date('2026-09-09T03:00:00Z');
    expect(toIsoDate(utc, TZ)).toBe('2026-09-08');
    expect(toIsoWithOffset(utc, TZ)).toBe('2026-09-08T22:00:00-05:00');
  });
});

describe('date parsing and validation', () => {
  it('accepts a valid ISO date', () => {
    expect(parseIsoDate('2026-09-08')).toEqual({ year: 2026, month: 9, day: 8 });
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(() => parseIsoDate('08/09/2026')).toThrow(/format/i);
    expect(() => parseIsoDate('2026-9-8')).toThrow(/format/i);
  });

  it('rejects dates that do not exist on the calendar', () => {
    expect(() => parseIsoDate('2026-02-31')).toThrow(/no such date/i);
    expect(() => parseIsoDate('2026-13-01')).toThrow();
  });

  it('accepts 29 February on a leap year', () => {
    expect(parseIsoDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
  });
});

describe('day arithmetic', () => {
  it('crosses a month boundary', () => {
    expect(addDaysIso('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDaysIso('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('crosses a year boundary', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('subtracts days', () => {
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('normalizing the date the agent sends', () => {
  it('lets an ISO date through', () => {
    expect(normalizeDateInput('2026-09-08', TZ, NOW)).toBe('2026-09-08');
  });

  it('resolves relative shortcuts in case the model sends them', () => {
    expect(normalizeDateInput('hoy', TZ, NOW)).toBe('2026-09-04');
    expect(normalizeDateInput('mañana', TZ, NOW)).toBe('2026-09-05');
    expect(normalizeDateInput('MAÑANA', TZ, NOW)).toBe('2026-09-05');
    expect(normalizeDateInput('pasado mañana', TZ, NOW)).toBe('2026-09-06');
  });

  it('rejects anything else instead of guessing', () => {
    expect(() => normalizeDateInput('la próxima semana', TZ, NOW)).toThrow(/invalid date/i);
  });
});

describe('part of day', () => {
  it('splits morning from afternoon at 12:00 local', () => {
    const eleven = zonedTimeToUtc({ year: 2026, month: 9, day: 8, hour: 11, minute: 59 }, TZ);
    const noon = zonedTimeToUtc({ year: 2026, month: 9, day: 8, hour: 12 }, TZ);

    expect(partOfDayOf(eleven, TZ)).toBe('morning');
    expect(partOfDayOf(noon, TZ)).toBe('afternoon');
  });
});

describe('spoken output', () => {
  const at = (hour: number, minute = 0, day = 8) =>
    zonedTimeToUtc({ year: 2026, month: 9, day, hour, minute }, TZ);

  it('spells the hour out in words', () => {
    expect(spokenTime(at(10), TZ)).toBe('las diez de la mañana');
    expect(spokenTime(at(14), TZ)).toBe('las dos de la tarde');
    expect(spokenTime(at(13), TZ)).toBe('la una de la tarde');
    expect(spokenTime(at(20), TZ)).toBe('las ocho de la noche');
    expect(spokenTime(at(9, 30), TZ)).toBe('las nueve y media de la mañana');
    expect(spokenTime(at(9, 15), TZ)).toBe('las nueve y cuarto de la mañana');
  });

  it('treats noon and midnight as their own part of the day', () => {
    // "las doce de la tarde" is not what a Spanish speaker says.
    expect(spokenTime(at(12), TZ)).toBe('las doce del mediodía');
    expect(spokenTime(at(12, 30), TZ)).toBe('las doce y media del mediodía');
    expect(spokenTime(at(13), TZ)).toBe('la una de la tarde');
    expect(spokenTime(at(0), TZ)).toBe('las doce de la noche');
    expect(spokenTime(at(11, 30), TZ)).toBe('las once y media de la mañana');
  });

  it('says today and tomorrow rather than the day number', () => {
    expect(spokenLabel(at(15, 0, 4), TZ, NOW)).toBe('hoy a las tres de la tarde');
    expect(spokenLabel(at(9, 0, 5), TZ, NOW)).toBe('mañana a las nueve de la mañana');
  });

  it('names the weekday and month for more distant days', () => {
    expect(spokenLabel(at(10, 0, 8), TZ, NOW)).toBe(
      'el martes 8 de septiembre a las diez de la mañana',
    );
  });

  it('names the month correctly when crossing from September into October', () => {
    const october = zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour: 16 }, TZ);
    expect(spokenLabel(october, TZ, NOW)).toBe(
      'el jueves 1 de octubre a las cuatro de la tarde',
    );
  });

  it('formats dates without a time', () => {
    expect(spokenDate('2026-09-04', TZ, NOW)).toBe('hoy');
    expect(spokenDate('2026-09-05', TZ, NOW)).toBe('mañana');
    expect(spokenDate('2026-09-08', TZ, NOW)).toBe('el martes 8 de septiembre');
    expect(spokenDate('2026-10-01', TZ, NOW)).toBe('el jueves 1 de octubre');
  });
});

describe('current date dynamic variable', () => {
  it('describes today in plain language for the prompt', () => {
    const text = currentDateTimeForPrompt(TZ, NOW);

    expect(text).toContain('viernes 4 de septiembre de 2026');
    expect(text).toContain('2026-09-04');
    expect(text).toContain('10:00');
  });
});
