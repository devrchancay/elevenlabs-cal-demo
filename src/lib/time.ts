/**
 * ALL date and timezone arithmetic in this project lives here.
 * No other file builds offsets, parses ISO by hand, or assumes UTC.
 *
 * Default business zone: America/Guayaquil (GMT-5, no daylight saving).
 * Even so, nothing here hardcodes -05:00: offsets are derived through Intl, so
 * moving the business to a zone that observes DST does not break anything.
 *
 * Note on language: the word tables below are Spanish on purpose. They are the
 * data the agent reads out loud, not identifiers.
 */

export type PartOfDay = 'morning' | 'afternoon' | 'any';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
}

/** Thrown when the agent sends a date we refuse to guess at. */
export class InvalidDateError extends Error {
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(message);
    this.name = 'InvalidDateError';
  }
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Spoken content, not identifiers: these strings are read out loud. */
const WEEKDAYS_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

/** Numbers 1..31 spelled out, so they are unambiguous when spoken. */
const NUMBERS_ES = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
  'treinta',
  'treinta y uno',
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Breaks an instant into the wall-clock components of a given zone. */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: WEEKDAY_INDEX[lookup.weekday ?? 'Sun'] ?? 0,
  };
}

/** Zone offset in minutes for that instant. America/Guayaquil → -300. */
export function getOffsetMinutes(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // formatToParts drops milliseconds, so they are discarded on both sides.
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** Offset in ISO form: -300 → "-05:00". */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const rest = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${rest}`;
}

/**
 * Converts a wall-clock time in a zone to the matching UTC instant.
 * Two passes, because the offset depends on the very instant being computed.
 */
export function zonedTimeToUtc(
  parts: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
  },
  timeZone: string,
): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );

  let timestamp = naive - getOffsetMinutes(new Date(naive), timeZone) * 60_000;
  // Second pass corrects DST transitions: irrelevant in Guayaquil, correct in general.
  timestamp = naive - getOffsetMinutes(new Date(timestamp), timeZone) * 60_000;
  return new Date(timestamp);
}

/** "2026-09-08" in a zone → the UTC instants of 00:00:00 and 23:59:59.999. */
export function dayBoundsUtc(
  isoDate: string,
  timeZone: string,
): { start: Date; end: Date } {
  const { year, month, day } = parseIsoDate(isoDate);
  const start = zonedTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
  const endExclusive = zonedTimeToUtc(
    { year, month, day: day + 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  return { start, end: new Date(endExclusive.getTime() - 1) };
}

/** Parses "2026-09-08" without going through Date, which would read it as UTC. */
export function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  if (!ISO_DATE_RE.test(isoDate)) {
    throw new InvalidDateError(
      `Invalid date: "${isoDate}". Expected the format YYYY-MM-DD.`,
      isoDate,
    );
  }
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  // Real calendar validation: 2026-02-31 must be rejected.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new InvalidDateError(`No such date on the calendar: "${isoDate}".`, isoDate);
  }
  return { year, month, day };
}

/** Instant → "2026-09-08" in the given zone. */
export function toIsoDate(date: Date, timeZone: string): string {
  const parts = getZonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Instant → "2026-09-08T10:00:00-05:00". Never implicit UTC. */
export function toIsoWithOffset(date: Date, timeZone: string): string {
  const parts = getZonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = formatOffset(getOffsetMinutes(date, timeZone));
  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offset}`
  );
}

/** Today's date in the business zone. */
export function todayIso(timeZone: string, now: Date = new Date()): string {
  return toIsoDate(now, timeZone);
}

/** Adds days to an ISO date, respecting the calendar. */
export function addDaysIso(isoDate: string, days: number): string {
  const { year, month, day } = parseIsoDate(isoDate);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Relative words the model might send instead of a proper ISO date. */
const RELATIVE_DAYS: Record<string, number> = {
  hoy: 0,
  today: 0,
  mañana: 1,
  manana: 1,
  tomorrow: 1,
  'pasado mañana': 2,
  'pasado manana': 2,
};

/**
 * Normalizes whatever the agent sends into an ISO date.
 * Accepts "2026-09-08" and also a few relative shortcuts, in case the model
 * invents them rather than doing the arithmetic itself.
 */
export function normalizeDateInput(
  input: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const raw = input.trim().toLowerCase();

  if (ISO_DATE_RE.test(raw)) {
    parseIsoDate(raw); // validates against the calendar
    return raw;
  }

  const offset = RELATIVE_DAYS[raw];
  if (offset !== undefined) return addDaysIso(todayIso(timeZone, now), offset);

  throw new InvalidDateError(
    `Invalid date: "${input}". Expected YYYY-MM-DD (for example 2026-09-08).`,
    input,
  );
}

/** Morning or afternoon? The cutoff is 12:00 local time. */
export function partOfDayOf(date: Date, timeZone: string): 'morning' | 'afternoon' {
  return getZonedParts(date, timeZone).hour < 12 ? 'morning' : 'afternoon';
}

/** A spoken time split into its two halves, so callers can drop the repetition. */
export interface SpokenTimeParts {
  /** "las nueve y media" */
  time: string;
  /** "de la mañana" */
  partOfDay: string;
}

/** 14 → { time: "las dos", partOfDay: "de la tarde" }. */
function hourInWords(hour24: number, minute: number): SpokenTimeParts {
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  // Noon is its own thing in Spanish. "las doce de la tarde" is not what a
  // person says; midnight is "las doce de la noche", and 12:00 is "del mediodía".
  const partOfDay =
    hour24 === 0
      ? 'de la noche'
      : hour24 < 12
        ? 'de la mañana'
        : hour24 === 12
          ? 'del mediodía'
          : hour24 < 19
            ? 'de la tarde'
            : 'de la noche';

  // "la una", not "la uno": in Spanish the number one is feminine next to "hora".
  const article = hour12 === 1 ? 'la' : 'las';
  const number = hour12 === 1 ? 'una' : (NUMBERS_ES[hour12] ?? String(hour12));

  let minutes = '';
  if (minute === 15) minutes = ' y cuarto';
  else if (minute === 30) minutes = ' y media';
  else if (minute === 45) minutes = ' y cuarenta y cinco';
  else if (minute !== 0) minutes = ` y ${NUMBERS_ES[minute] ?? String(minute)}`;

  return { time: `${article} ${number}${minutes}`, partOfDay };
}

/** Just the spoken time: "las diez de la mañana". */
export function spokenTime(date: Date, timeZone: string): string {
  const { time, partOfDay } = spokenTimeParts(date, timeZone);
  return `${time} ${partOfDay}`;
}

/**
 * The spoken time split in two, so a list of times on the same day can say the
 * part of day once instead of after every entry.
 */
export function spokenTimeParts(date: Date, timeZone: string): SpokenTimeParts {
  const parts = getZonedParts(date, timeZone);
  return hourInWords(parts.hour, parts.minute);
}

/**
 * Full label, ready to be read out loud.
 * Today and tomorrow are named as such rather than by their day number: it
 * sounds human and removes a chance to be misheard.
 *
 *   "hoy a las diez de la mañana"
 *   "mañana a las tres de la tarde"
 *   "el martes 8 de septiembre a las diez de la mañana"
 */
export function spokenLabel(date: Date, timeZone: string, now: Date = new Date()): string {
  const parts = getZonedParts(date, timeZone);
  const iso = toIsoDate(date, timeZone);
  const today = todayIso(timeZone, now);

  const { time: clock, partOfDay } = hourInWords(parts.hour, parts.minute);
  const time = `${clock} ${partOfDay}`;

  if (iso === today) return `hoy a ${time}`;
  if (iso === addDaysIso(today, 1)) return `mañana a ${time}`;

  const weekday = WEEKDAYS_ES[parts.weekday] ?? '';
  const month = MONTHS_ES[parts.month - 1] ?? '';
  return `el ${weekday} ${parts.day} de ${month} a ${time}`;
}

/** Spoken date without a time: "el martes 8 de septiembre". */
export function spokenDate(isoDate: string, timeZone: string, now: Date = new Date()): string {
  const { year, month, day } = parseIsoDate(isoDate);
  const noon = zonedTimeToUtc({ year, month, day, hour: 12 }, timeZone);
  const today = todayIso(timeZone, now);

  if (isoDate === today) return 'hoy';
  if (isoDate === addDaysIso(today, 1)) return 'mañana';

  const parts = getZonedParts(noon, timeZone);
  return `el ${WEEKDAYS_ES[parts.weekday] ?? ''} ${day} de ${MONTHS_ES[month - 1] ?? ''}`;
}

/**
 * Current date and time, phrased for injection as a dynamic variable.
 * The model has no idea what day it is unless we tell it.
 */
export function currentDateTimeForPrompt(timeZone: string, now: Date = new Date()): string {
  const parts = getZonedParts(now, timeZone);
  const iso = toIsoDate(now, timeZone);
  const weekday = WEEKDAYS_ES[parts.weekday] ?? '';
  const month = MONTHS_ES[parts.month - 1] ?? '';
  const time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return `${weekday} ${parts.day} de ${month} de ${parts.year} (${iso}), ${time} hora de ${timeZone}`;
}
