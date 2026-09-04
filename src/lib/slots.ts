/**
 * Picking and phrasing the time options we offer.
 *
 * Cal.com returns dozens of slots. The agent cannot read dozens of times out
 * loud, so at most 3 are chosen, spread across the day, and formatted as text
 * that is ready to be spoken. The model never sees a timestamp.
 */

import type { PartOfDay } from './time.js';
import { partOfDayOf, spokenLabel, toIsoWithOffset } from './time.js';

/** A raw slot, already normalized by the Cal.com client. */
export interface RawSlot {
  /** Start instant. */
  start: Date;
}

export interface SlotOption {
  /** Short, opaque id the agent hands back when booking. */
  id: string;
  /** Spanish text to read out loud: "el martes 8 de septiembre a las diez de la mañana". */
  spokenLabel: string;
  /** ISO with an explicit offset: "2026-09-08T10:00:00-05:00". */
  startsAt: string;
}

export interface SelectOptionsInput {
  slots: RawSlot[];
  partOfDay: PartOfDay;
  timeZone: string;
  /** Current moment, injectable so tests can freeze it. */
  now?: Date;
  /** How many options to offer at most. */
  max?: number;
  /** Minimum notice, in minutes, before a slot can be booked. */
  leadTimeMinutes?: number;
}

export const DEFAULT_MAX_OPTIONS = 3;
export const DEFAULT_LEAD_TIME_MINUTES = 60;

/**
 * Spreads n picks as evenly as possible over an ordered list.
 * With 12 slots and n=3 it returns indices 0, 5 and 11: early, midday and late.
 * That way the caller hears genuinely different options, not three in a row.
 */
export function spreadIndices(length: number, n: number): number[] {
  if (length <= 0 || n <= 0) return [];
  if (length <= n) return Array.from({ length }, (_, index) => index);
  if (n === 1) return [0];

  const picked = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    picked.add(Math.round((i * (length - 1)) / (n - 1)));
  }
  return [...picked].sort((a, b) => a - b);
}

/** Sorts, deduplicates, and drops anything already past or too soon. */
function usableSlots(input: SelectOptionsInput): Date[] {
  const now = input.now ?? new Date();
  const leadMinutes = input.leadTimeMinutes ?? DEFAULT_LEAD_TIME_MINUTES;
  const earliest = now.getTime() + leadMinutes * 60_000;

  const seen = new Set<number>();
  const kept: Date[] = [];

  for (const slot of input.slots) {
    const timestamp = slot.start.getTime();
    if (Number.isNaN(timestamp)) continue;
    if (timestamp < earliest) continue;
    if (seen.has(timestamp)) continue;

    if (input.partOfDay !== 'any') {
      if (partOfDayOf(slot.start, input.timeZone) !== input.partOfDay) continue;
    }

    seen.add(timestamp);
    kept.push(slot.start);
  }

  return kept.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Selects up to `max` options and formats them for speech.
 *
 * If a specific part of the day was requested and nothing fits, this returns an
 * empty list: the caller decides whether to retry with 'any'. Offering
 * alternatives is the endpoint's decision, not this function's.
 */
export function selectOptions(input: SelectOptionsInput): SlotOption[] {
  const now = input.now ?? new Date();
  const max = input.max ?? DEFAULT_MAX_OPTIONS;
  const candidates = usableSlots(input);

  return spreadIndices(candidates.length, max).map((index, position) => {
    const start = candidates[index] as Date;
    return {
      id: `opt_${position + 1}`,
      spokenLabel: spokenLabel(start, input.timeZone, now),
      startsAt: toIsoWithOffset(start, input.timeZone),
    };
  });
}

/**
 * Joins the labels into a natural sentence.
 * Three bare options sound like a robot reading a list; an "o" before the last
 * one sounds like a person.
 */
export function joinSpokenOptions(options: SlotOption[]): string {
  const labels = options.map((option) => option.spokenLabel);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(', ')} o ${labels.at(-1)}`;
}
