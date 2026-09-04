import { describe, expect, it } from 'vitest';

import monthChangeFixture from '../test/fixtures/cal-slots-month-change.json' with { type: 'json' };
import morningOnlyFixture from '../test/fixtures/cal-slots-morning-only.json' with { type: 'json' };
import slotsFixture from '../test/fixtures/cal-slots.json' with { type: 'json' };
import type { RawSlot } from './slots.js';
import { joinSpokenOptions, selectOptions, spreadIndices } from './slots.js';

const TZ = 'America/Guayaquil';

/** Friday 4 September 2026, 10:00 in Guayaquil. */
const NOW = new Date('2026-09-04T15:00:00.000Z');

/** Turns a Cal.com fixture into raw slots, the way the client would. */
function fromFixture(
  fixture: { data: Record<string, { start: string }[]> },
  date: string,
): RawSlot[] {
  return (fixture.data[date] ?? []).map((slot) => ({ start: new Date(slot.start) }));
}

describe('spreadIndices', () => {
  it('returns every index when there are few elements', () => {
    expect(spreadIndices(2, 3)).toEqual([0, 1]);
    expect(spreadIndices(3, 3)).toEqual([0, 1, 2]);
  });

  it('spreads end to end instead of taking the first few', () => {
    expect(spreadIndices(12, 3)).toEqual([0, 6, 11]);
    expect(spreadIndices(5, 3)).toEqual([0, 2, 4]);
  });

  it('does not break on empty lists', () => {
    expect(spreadIndices(0, 3)).toEqual([]);
  });
});

describe('selectOptions', () => {
  const slots = fromFixture(slotsFixture, '2026-09-08');

  it('returns at most 3 options', () => {
    const options = selectOptions({ slots, partOfDay: 'any', timeZone: TZ, now: NOW });
    expect(options).toHaveLength(3);
  });

  it('spreads the options across the day instead of offering three in a row', () => {
    const options = selectOptions({ slots, partOfDay: 'any', timeZone: TZ, now: NOW });

    expect(options.map((option) => option.startsAt)).toEqual([
      '2026-09-08T09:00:00-05:00',
      '2026-09-08T14:00:00-05:00',
      '2026-09-08T16:30:00-05:00',
    ]);
  });

  it('filters by morning', () => {
    const options = selectOptions({ slots, partOfDay: 'morning', timeZone: TZ, now: NOW });

    expect(options).toHaveLength(3);
    for (const option of options) {
      expect(option.spokenLabel).toContain('de la mañana');
    }
    expect(options[0]!.startsAt).toBe('2026-09-08T09:00:00-05:00');
    expect(options.at(-1)!.startsAt).toBe('2026-09-08T11:30:00-05:00');
  });

  it('filters by afternoon', () => {
    const options = selectOptions({ slots, partOfDay: 'afternoon', timeZone: TZ, now: NOW });

    expect(options).toHaveLength(3);
    for (const option of options) {
      expect(option.spokenLabel).toContain('de la tarde');
    }
    expect(options[0]!.startsAt).toBe('2026-09-08T14:00:00-05:00');
  });

  it('returns nothing when the day has no availability', () => {
    const options = selectOptions({ slots: [], partOfDay: 'any', timeZone: TZ, now: NOW });
    expect(options).toEqual([]);
  });

  it('returns nothing when the requested part of day is full, even if the day is not', () => {
    const morningOnly = fromFixture(morningOnlyFixture, '2026-09-08');

    expect(
      selectOptions({ slots: morningOnly, partOfDay: 'afternoon', timeZone: TZ, now: NOW }),
    ).toEqual([]);
    expect(
      selectOptions({ slots: morningOnly, partOfDay: 'morning', timeZone: TZ, now: NOW }),
    ).toHaveLength(3);
  });

  it('drops what is already past and what is too soon', () => {
    // It is 10:00. With one hour of minimum notice, 10:30 does not qualify.
    const today: RawSlot[] = [
      { start: new Date('2026-09-04T14:30:00.000Z') }, // 09:30 local, already gone
      { start: new Date('2026-09-04T15:30:00.000Z') }, // 10:30 local, too soon
      { start: new Date('2026-09-04T16:00:00.000Z') }, // 11:00 local, right at the edge
      { start: new Date('2026-09-04T20:00:00.000Z') }, // 15:00 local
    ];

    const options = selectOptions({ slots: today, partOfDay: 'any', timeZone: TZ, now: NOW });

    expect(options.map((option) => option.startsAt)).toEqual([
      '2026-09-04T11:00:00-05:00',
      '2026-09-04T15:00:00-05:00',
    ]);
  });

  it('honours a custom lead time', () => {
    const today: RawSlot[] = [{ start: new Date('2026-09-04T15:15:00.000Z') }]; // 10:15 local

    expect(
      selectOptions({
        slots: today,
        partOfDay: 'any',
        timeZone: TZ,
        now: NOW,
        leadTimeMinutes: 60,
      }),
    ).toEqual([]);
    expect(
      selectOptions({
        slots: today,
        partOfDay: 'any',
        timeZone: TZ,
        now: NOW,
        leadTimeMinutes: 5,
      }),
    ).toHaveLength(1);
  });

  it('deduplicates and sorts', () => {
    const repeated: RawSlot[] = [
      { start: new Date('2026-09-08T20:00:00.000Z') },
      { start: new Date('2026-09-08T14:00:00.000Z') },
      { start: new Date('2026-09-08T20:00:00.000Z') },
    ];

    const options = selectOptions({ slots: repeated, partOfDay: 'any', timeZone: TZ, now: NOW });

    expect(options).toHaveLength(2);
    expect(options[0]!.startsAt).toBe('2026-09-08T09:00:00-05:00');
  });

  it('numbers the options starting at opt_1', () => {
    const options = selectOptions({ slots, partOfDay: 'any', timeZone: TZ, now: NOW });
    expect(options.map((option) => option.id)).toEqual(['opt_1', 'opt_2', 'opt_3']);
  });

  it('formats the labels for speech', () => {
    const options = selectOptions({ slots, partOfDay: 'morning', timeZone: TZ, now: NOW });

    expect(options[0]!.spokenLabel).toBe('el martes 8 de septiembre a las nueve de la mañana');
    expect(options[1]!.spokenLabel).toBe(
      'el martes 8 de septiembre a las diez y media de la mañana',
    );
  });

  it('names the month correctly when crossing from September into October', () => {
    const september = fromFixture(monthChangeFixture, '2026-09-30');
    const october = fromFixture(monthChangeFixture, '2026-10-01');

    expect(
      selectOptions({ slots: september, partOfDay: 'any', timeZone: TZ, now: NOW })[0]!
        .spokenLabel,
    ).toBe('el miércoles 30 de septiembre a las cuatro de la tarde');

    expect(
      selectOptions({ slots: october, partOfDay: 'any', timeZone: TZ, now: NOW })[0]!.spokenLabel,
    ).toBe('el jueves 1 de octubre a las nueve de la mañana');
  });

  it('says today and tomorrow where appropriate', () => {
    const tomorrow: RawSlot[] = [{ start: new Date('2026-09-05T15:00:00.000Z') }];

    expect(
      selectOptions({ slots: tomorrow, partOfDay: 'any', timeZone: TZ, now: NOW })[0]!
        .spokenLabel,
    ).toBe('mañana a las diez de la mañana');
  });
});

describe('joinSpokenOptions', () => {
  it('joins with "o" before the last one so it sounds natural', () => {
    const options = selectOptions({
      slots: fromFixture(slotsFixture, '2026-09-08'),
      partOfDay: 'morning',
      timeZone: TZ,
      now: NOW,
    });

    expect(joinSpokenOptions(options)).toBe(
      'el martes 8 de septiembre a las nueve de la mañana, ' +
        'el martes 8 de septiembre a las diez y media de la mañana o ' +
        'el martes 8 de septiembre a las once y media de la mañana',
    );
  });

  it('adds no connectors for a single option', () => {
    expect(
      joinSpokenOptions([{ id: 'opt_1', spokenLabel: 'mañana a las diez', startsAt: 'x' }]),
    ).toBe('mañana a las diez');
  });

  it('returns an empty string for no options', () => {
    expect(joinSpokenOptions([])).toBe('');
  });
});
