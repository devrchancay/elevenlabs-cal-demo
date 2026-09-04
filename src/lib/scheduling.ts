/**
 * The booking flow, kept separate from Fastify so it can be tested without HTTP.
 *
 * This is where the work we take off the model lives: normalizing the date,
 * finding alternatives when the requested day is full, writing the sentence the
 * agent will say, and guaranteeing that two calls with the same `bookingKey`
 * never create two appointments.
 */

import type { CalClient } from './cal.js';
import { CalApiError } from './cal.js';
import type { SessionTracker } from './session.js';
import type { SlotOption } from './slots.js';
import { selectOptions } from './slots.js';
import type { TtlStore } from './store.js';
import { addDaysIso, normalizeDateInput, spokenDate, spokenLabel, spokenTimeParts } from './time.js';
import type {
  AvailabilityRequest,
  AvailabilityResponse,
  BookRequest,
  BookResponse,
} from '../schemas/tools.js';

/** How many days ahead to scan when the requested day has nothing. */
export const ALTERNATIVE_DAYS_TO_SCAN = 7;

/** Default scope when the agent sends no `bookingKey` (curl, manual probing). */
const GLOBAL_SCOPE = '__global__';

export interface StoredOption extends SlotOption {
  /** The real instant, so booking does not re-parse the string. */
  startsAtMs: number;
}

export interface StoredBooking {
  bookingUid: string;
  spokenConfirmation: string;
}

export interface SchedulingDeps {
  cal: CalClient;
  optionStore: TtlStore<StoredOption>;
  bookingStore: TtlStore<StoredBooking>;
  /**
   * Mirrors the flow for the landing page. Optional on purpose: nothing about
   * booking correctness depends on it, so a test that only cares about the
   * booking logic does not have to wire it up.
   */
  sessionTracker?: SessionTracker;
  timeZone: string;
  durationMinutes?: number;
  now?: () => Date;
}

function optionKey(scope: string, optionId: string): string {
  return `${scope}:${optionId}`;
}

export function createSchedulingService(deps: SchedulingDeps) {
  const now = deps.now ?? (() => new Date());

  /** Queries Cal.com for one day and returns the formatted options. */
  async function optionsForDate(
    date: string,
    partOfDay: AvailabilityRequest['partOfDay'],
  ): Promise<SlotOption[]> {
    const slots = await deps.cal.getSlots({
      date,
      timeZone: deps.timeZone,
      ...(deps.durationMinutes ? { durationMinutes: deps.durationMinutes } : {}),
    });

    return selectOptions({
      slots,
      partOfDay,
      timeZone: deps.timeZone,
      now: now(),
    });
  }

  async function checkAvailability(input: AvailabilityRequest): Promise<AvailabilityResponse> {
    const reference = now();
    const requestedDate = normalizeDateInput(input.date, deps.timeZone, reference);
    const scope = input.bookingKey ?? GLOBAL_SCOPE;

    let searchedDate = requestedDate;
    let options = await optionsForDate(requestedDate, input.partOfDay);
    let relaxedPartOfDay = false;

    // 1) If a specific part of the day was asked for and it is full, look at the
    //    whole day before sending the caller to another date. Changing the hour
    //    is less disruptive than changing the day.
    if (options.length === 0 && input.partOfDay !== 'any') {
      options = await optionsForDate(requestedDate, 'any');
      relaxedPartOfDay = options.length > 0;
    }

    // 2) If the whole day is full, scan the following days. The agent gets
    //    concrete alternatives instead of a dead-end "nothing available".
    //
    //    The days are queried in parallel and the nearest one with an opening
    //    wins. Done sequentially this would be up to 7 chained round trips to
    //    Cal.com, and that silence is audible on a voice call.
    if (options.length === 0) {
      const candidates = Array.from({ length: ALTERNATIVE_DAYS_TO_SCAN }, (_, index) =>
        addDaysIso(requestedDate, index + 1),
      );

      const results = await Promise.all(
        candidates.map(async (candidate) => ({
          date: candidate,
          options: await optionsForDate(candidate, input.partOfDay),
        })),
      );

      const firstFree = results.find((result) => result.options.length > 0);
      if (firstFree) {
        options = firstFree.options;
        searchedDate = firstFree.date;
      }
    }

    // Options are stored so that booking needs nothing but the `optionId`.
    for (const option of options) {
      deps.optionStore.set(optionKey(scope, option.id), {
        ...option,
        startsAtMs: new Date(option.startsAt).getTime(),
      });
    }

    const isAlternativeDate = searchedDate !== requestedDate;

    // Only when the conversation identified itself. Without a `bookingKey`
    // there is no page waiting on the other side — this is curl, or a probe.
    if (input.bookingKey) {
      deps.sessionTracker?.recordAvailability(input.bookingKey, {
        options,
        searchedDate,
        isAlternativeDate,
      });
    }

    return {
      options,
      found: options.length > 0,
      searchedDate,
      isAlternativeDate,
      spokenSummary: buildSummary({
        options,
        requestedDate,
        searchedDate,
        isAlternativeDate,
        relaxedPartOfDay,
        partOfDay: input.partOfDay,
        timeZone: deps.timeZone,
        reference,
      }),
    };
  }

  async function book(input: BookRequest): Promise<BookResponse> {
    // Idempotency: one conversation does not book twice even if the agent calls
    // the tool more than once.
    const existing = deps.bookingStore.get(input.bookingKey);
    if (existing) {
      return {
        booked: true,
        duplicate: true,
        bookingUid: existing.bookingUid,
        spokenConfirmation: existing.spokenConfirmation,
      };
    }

    const scoped = deps.optionStore.get(optionKey(input.bookingKey, input.optionId));
    const stored = scoped ?? deps.optionStore.get(optionKey(GLOBAL_SCOPE, input.optionId));

    if (!stored) {
      return {
        booked: false,
        reason: 'option_expired',
        spokenConfirmation:
          'Ese horario ya no lo tengo a la mano. Déjame consultar la disponibilidad otra vez.',
      };
    }

    const start = new Date(stored.startsAtMs);

    if (start.getTime() <= now().getTime()) {
      return {
        booked: false,
        reason: 'option_expired',
        spokenConfirmation: 'Ese horario ya pasó. Déjame buscarte otra opción disponible.',
      };
    }

    let booking;
    try {
      booking = await deps.cal.createBooking({
        start,
        attendeeName: input.name,
        attendeeEmail: input.email,
        timeZone: deps.timeZone,
        bookingKey: input.bookingKey,
        language: 'es',
      });
    } catch (error) {
      if (error instanceof CalApiError && error.kind === 'conflict') {
        return {
          booked: false,
          reason: 'slot_taken',
          spokenConfirmation:
            'Justo acaban de tomar ese horario. Déjame ofrecerte otras opciones.',
        };
      }
      if (error instanceof CalApiError && error.kind === 'bad_request') {
        return {
          booked: false,
          reason: 'invalid_input',
          spokenConfirmation:
            'No pude registrar la cita con esos datos. ¿Me confirmas tu nombre y tu correo?',
        };
      }
      throw error;
    }

    const label = spokenLabel(start, deps.timeZone, now());
    // Cal.com returns "pending" when the event type requires the owner to
    // confirm. Saying "confirmada" in that case would be lying to the caller.
    const spokenConfirmation =
      booking.status === 'pending'
        ? `Listo, dejé solicitada tu cita para ${label} a nombre de ${input.name}. ` +
          `Queda pendiente de confirmación y te llega un correo a ${input.email}.`
        : `Listo, tu cita quedó agendada para ${label} a nombre de ${input.name}. ` +
          `Te acabo de enviar la confirmación a ${input.email}.`;

    deps.bookingStore.set(input.bookingKey, { bookingUid: booking.uid, spokenConfirmation });

    // The page is told the appointment exists, and told it from the booking
    // result rather than from anything the agent said. Name and email are left
    // out on purpose: see the note at the top of session.ts.
    deps.sessionTracker?.recordBooking(input.bookingKey, {
      optionId: input.optionId,
      spokenLabel: stored.spokenLabel,
      startsAt: stored.startsAt,
      status: booking.status === 'pending' ? 'pending' : 'booked',
      bookingUid: booking.uid,
    });

    return { booked: true, bookingUid: booking.uid, spokenConfirmation };
  }

  return { checkAvailability, book };
}

export type SchedulingService = ReturnType<typeof createSchedulingService>;

/* -------------------------------------------------------------------------- */
/* Phrasing                                                                    */
/* -------------------------------------------------------------------------- */

interface SummaryInput {
  options: SlotOption[];
  requestedDate: string;
  searchedDate: string;
  isAlternativeDate: boolean;
  relaxedPartOfDay: boolean;
  partOfDay: AvailabilityRequest['partOfDay'];
  timeZone: string;
  reference: Date;
}

const PART_OF_DAY_ES: Record<'morning' | 'afternoon', string> = {
  morning: 'en la mañana',
  afternoon: 'en la tarde',
};

/**
 * Reads a list of times the way a receptionist would.
 *
 * Every option here belongs to the same day, and the summary already named that
 * day, so repeating the full label per option would say the date three times in
 * one breath. The part of day is likewise said once at the end whenever all the
 * options share it.
 *
 *   "a las nueve, a las diez y media o a las once y media de la mañana"
 *   "a las once y media de la mañana o a las cuatro de la tarde"
 */
export function joinSpokenTimes(options: SlotOption[], timeZone: string): string {
  const parts = options.map((option) => spokenTimeParts(new Date(option.startsAt), timeZone));
  if (parts.length === 0) return '';

  const first = parts[0] as { time: string; partOfDay: string };
  const sharePartOfDay = parts.every((part) => part.partOfDay === first.partOfDay);

  const labels = parts.map((part, index) => {
    const isLast = index === parts.length - 1;
    return sharePartOfDay && !isLast ? `a ${part.time}` : `a ${part.time} ${part.partOfDay}`;
  });

  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(', ')} o ${labels.at(-1)}`;
}

/**
 * Writes the sentence the agent will read. The model has to build nothing: its
 * job is to say this verbatim and wait for an answer.
 *
 * The output is Spanish because it is spoken to the caller.
 */
export function buildSummary(input: SummaryInput): string {
  const requested = spokenDate(input.requestedDate, input.timeZone, input.reference);

  if (input.options.length === 0) {
    return (
      `No tengo horarios disponibles ${requested} ni en los días siguientes. ` +
      '¿Quieres que busque en otra fecha?'
    );
  }

  const times = joinSpokenTimes(input.options, input.timeZone);

  if (input.isAlternativeDate) {
    const alternative = spokenDate(input.searchedDate, input.timeZone, input.reference);
    return `Para ${requested} no me queda nada, pero ${alternative} tengo ${times}. ¿Cuál te sirve?`;
  }

  if (input.relaxedPartOfDay && input.partOfDay !== 'any') {
    return (
      `${capitalize(requested)} no me queda nada ${PART_OF_DAY_ES[input.partOfDay]}, ` +
      `pero sí tengo ${times}. ¿Cuál te sirve?`
    );
  }

  return `Para ${requested} tengo ${times}. ¿Cuál te sirve?`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
