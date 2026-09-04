/**
 * Creates a REAL booking in Cal.com, which then shows up in Google Calendar.
 *
 * It demands --yes on purpose: this is the only operation among these scripts
 * that leaves a trace and has to be cancelled by hand if run by accident.
 *
 *   pnpm smoke:book -- --yes
 *   pnpm smoke:book -- --yes --date 2026-09-08 --part morning
 */

import { createCalClient } from '../src/lib/cal.js';
import { loadEnv } from '../src/lib/env.js';
import { selectOptions } from '../src/lib/slots.js';
import { addDaysIso, spokenLabel, todayIso } from '../src/lib/time.js';
import { colors, loadDotEnv } from './lib/config.js';

loadDotEnv();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (!process.argv.includes('--yes')) {
  console.log(
    colors.warn(
      '\nThis creates a real appointment in Cal.com and Google Calendar.\n' +
        'If that is what you want, run it again with --yes:\n\n' +
        '  pnpm smoke:book -- --yes\n',
    ),
  );
  process.exit(0);
}

const env = loadEnv();
const cal = createCalClient({
  apiKey: env.CAL_API_KEY,
  eventTypeId: env.CAL_EVENT_TYPE_ID,
  baseUrl: env.CAL_API_BASE_URL,
});

const date = flag('date') ?? addDaysIso(todayIso(env.BUSINESS_TIMEZONE), 1);
const partOfDay = (flag('part') ?? 'any') as 'morning' | 'afternoon' | 'any';
const name = flag('name') ?? 'Smoke test';
const email = flag('email') ?? 'prueba+smoke@example.com';

const slots = await cal.getSlots({
  date,
  timeZone: env.BUSINESS_TIMEZONE,
  durationMinutes: env.APPOINTMENT_DURATION_MINUTES,
});
const options = selectOptions({ slots, partOfDay, timeZone: env.BUSINESS_TIMEZONE });

if (options.length === 0) {
  console.error(colors.err(`\n[x] No availability on ${date} (${partOfDay}).\n`));
  process.exit(1);
}

const chosen = options[0]!;
const start = new Date(chosen.startsAt);

console.log(colors.bold('\nBooking'));
console.log(`  ${chosen.spokenLabel}`);
console.log(colors.dim(`  ${chosen.startsAt}  ->  ${start.toISOString()} (what goes to Cal.com)`));
console.log(`  for ${name} <${email}>\n`);

const booking = await cal.createBooking({
  start,
  attendeeName: name,
  attendeeEmail: email,
  timeZone: env.BUSINESS_TIMEZONE,
  bookingKey: `smoke_${Date.now()}`,
  language: 'es',
});

console.log(colors.ok('[ok] Booking created'));
console.log(`  uid    : ${booking.uid}`);
console.log(`  id     : ${booking.id}`);
console.log(`  status : ${booking.status}`);
console.log(`  start  : ${booking.start}`);
console.log(
  colors.dim(
    `\n  Read back: ${spokenLabel(new Date(booking.start), env.BUSINESS_TIMEZONE)}`,
  ),
);
console.log(
  colors.warn('\n  Check Google Calendar. Cancel it from Cal.com once you have verified it.\n'),
);
