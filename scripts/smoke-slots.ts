/**
 * Checks against the real Cal.com API that availability comes back and is
 * phrased correctly. It books nothing, so it is safe to run as often as needed.
 *
 *   pnpm smoke:slots                # tomorrow
 *   pnpm smoke:slots 2026-09-08     # a specific date
 *   pnpm smoke:slots 2026-09-08 morning
 */

import { createCalClient } from '../src/lib/cal.js';
import { loadEnv } from '../src/lib/env.js';
import { joinSpokenOptions, selectOptions } from '../src/lib/slots.js';
import { addDaysIso, todayIso } from '../src/lib/time.js';
import { colors, loadDotEnv } from './lib/config.js';

loadDotEnv();

const env = loadEnv();
const cal = createCalClient({
  apiKey: env.CAL_API_KEY,
  eventTypeId: env.CAL_EVENT_TYPE_ID,
  baseUrl: env.CAL_API_BASE_URL,
});

const date = process.argv[2] ?? addDaysIso(todayIso(env.BUSINESS_TIMEZONE), 1);
const partOfDay = (process.argv[3] ?? 'any') as 'morning' | 'afternoon' | 'any';

console.log(colors.bold('\nQuerying Cal.com'));
console.log(`  event type  : ${env.CAL_EVENT_TYPE_ID}`);
console.log(`  date        : ${date}`);
console.log(`  part of day : ${partOfDay}`);
console.log(`  timezone    : ${env.BUSINESS_TIMEZONE}\n`);

const slots = await cal.getSlots({
  date,
  timeZone: env.BUSINESS_TIMEZONE,
  durationMinutes: env.APPOINTMENT_DURATION_MINUTES,
});

console.log(colors.dim(`Cal.com returned ${slots.length} raw slot(s).`));

if (slots.length > 0) {
  const preview = slots
    .slice(0, 6)
    .map((slot) => slot.start.toISOString())
    .join('\n  ');
  console.log(colors.dim(`  ${preview}${slots.length > 6 ? '\n  …' : ''}\n`));
}

const options = selectOptions({ slots, partOfDay, timeZone: env.BUSINESS_TIMEZONE });

if (options.length === 0) {
  console.log(colors.warn('No options for that date and part of day.\n'));
  process.exit(0);
}

console.log(colors.bold('Options the agent would receive:\n'));
for (const option of options) {
  console.log(`  ${colors.ok(option.id)}  ${option.spokenLabel}`);
  console.log(`  ${colors.dim(`      ${option.startsAt}`)}`);
}

console.log(colors.bold('\nWhat it would say out loud:\n'));
console.log(`  "Para esa fecha tengo ${joinSpokenOptions(options)}. ¿Cuál te sirve?"\n`);
