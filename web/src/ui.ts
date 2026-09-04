/**
 * State in, DOM out.
 *
 * One `render` over the whole state, called on every change. The state is a
 * handful of fields and the DOM a handful of nodes, so there is nothing here a
 * framework would make faster — only heavier.
 *
 * Every user-facing string in this file is Spanish on purpose: it is read by
 * the caller, not by a developer.
 */

import type { BookingSummary } from './conversation.js';
import type { SessionState } from './session.js';

export type Phase = 'unconfigured' | 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export interface AppState {
  phase: Phase;
  /** Business timezone. Slots are shown in it, never in the visitor's own. */
  timeZone: string;
  /** Only meaningful while `phase` is `active`. */
  mode: 'listening' | 'speaking';
  muted: boolean;
  error: string | null;
  transcript: { role: 'user' | 'agent'; text: string }[];
  session: SessionState;
  summary: BookingSummary | null;
}

/** The last few lines only. This is a subtitle track, not a chat log. */
const TRANSCRIPT_LINES = 4;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const nodes = {
  configWarning: () => el('config-warning'),
  callState: () => el('call-state'),
  start: () => el<HTMLButtonElement>('start'),
  mute: () => el<HTMLButtonElement>('mute'),
  hangup: () => el<HTMLButtonElement>('hangup'),
  error: () => el('error'),
  transcriptWrap: () => el('transcript-wrap'),
  transcript: () => el('transcript'),
  panel: () => el('panel'),
  slotsBlock: () => el('slots-block'),
  slotsNote: () => el('slots-note'),
  slots: () => el<HTMLUListElement>('slots'),
  summaryBlock: () => el('summary-block'),
  summaryName: () => el('summary-name'),
  summaryEmail: () => el('summary-email'),
  summaryHint: () => el('summary-hint'),
  confirmation: () => el('confirmation'),
  confirmationTitle: () => el('confirmation-title'),
  confirmationDetail: () => el('confirmation-detail'),
};

const CALL_STATE: Record<Phase, string> = {
  unconfigured: 'Sin configurar.',
  idle: 'Listo. Toca el botón para empezar a hablar.',
  connecting: 'Conectando…',
  active: '',
  ended: 'La conversación terminó.',
  error: '',
};

function activeLabel(state: AppState): string {
  if (state.muted) return 'Micrófono silenciado.';
  return state.mode === 'speaking' ? 'El asistente está hablando…' : 'Escuchando…';
}

/**
 * Two lines out of one instant.
 *
 * From `startsAt` rather than by taking the spoken label apart: that label is
 * Spanish prose written to be heard ("a la una y media de la tarde"), and
 * regexing it back into fields would be string surgery on a moving target. The
 * instant is unambiguous, and `Intl` already knows how to say it.
 */
function formatSlot(startsAt: string, timeZone: string): { day: string; time: string } {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return { day: '', time: '' };

  return {
    day: new Intl.DateTimeFormat('es-EC', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(date),
    time: new Intl.DateTimeFormat('es-EC', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(date),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderSlots(state: AppState): void {
  const { options, booking, isAlternativeDate } = state.session;
  const block = nodes.slotsBlock();

  if (options.length === 0) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const note = nodes.slotsNote();
  // Only worth saying while the choice is still open.
  const showNote = isAlternativeDate && !booking;
  note.hidden = !showNote;
  if (showNote) note.textContent = 'La fecha que pediste estaba llena. Estos son los días siguientes.';

  // The chosen one wins over the merely-selected one: once booked, that is the
  // only card that still means anything.
  const chosenId = booking?.optionId ?? state.summary?.optionId ?? null;

  const list = nodes.slots();
  list.replaceChildren(
    ...options.map((option) => {
      const chosen = option.id === chosenId;
      const { day, time } = formatSlot(option.startsAt, state.timeZone);

      const item = document.createElement('li');
      item.className = [
        'flex items-baseline justify-between gap-3 rounded-xl border px-4 py-3 text-sm transition',
        chosen
          ? 'border-brand-500 bg-brand-500/10'
          : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900',
        chosenId && !chosen ? 'opacity-40' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const text = document.createElement('div');
      const dayLine = document.createElement('p');
      dayLine.className = 'text-xs text-neutral-500 dark:text-neutral-400';
      dayLine.textContent = capitalize(day);
      const timeLine = document.createElement('p');
      timeLine.className = 'font-medium tabular-nums';
      timeLine.textContent = time;
      text.append(dayLine, timeLine);

      item.append(text);

      if (chosen) {
        const mark = document.createElement('span');
        mark.className = 'shrink-0 text-brand-500';
        mark.setAttribute('aria-label', 'Horario elegido');
        mark.textContent = '✓';
        item.append(mark);
      }

      return item;
    }),
  );
}

function renderSummary(state: AppState): void {
  const block = nodes.summaryBlock();
  if (!state.summary) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  nodes.summaryName().textContent = state.summary.name;
  nodes.summaryEmail().textContent = state.summary.email;
  // Asking someone to check their details is only useful while they can still
  // be corrected. Once the appointment exists it is just noise.
  nodes.summaryHint().hidden = state.session.booking !== null;
}

function renderConfirmation(state: AppState): void {
  const block = nodes.confirmation();
  const booking = state.session.booking;

  if (!booking) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const { day, time } = formatSlot(booking.startsAt, state.timeZone);
  // A middot, not a full stop: Spanish formats the hour as "1:30 p. m." — with
  // a trailing period of its own — and a sentence break here would double it.
  const when = `${capitalize(day)}, ${time}`;

  if (booking.status === 'pending') {
    nodes.confirmationTitle().textContent = 'Cita solicitada';
    nodes.confirmationDetail().textContent = `${when} · Queda pendiente de confirmación y te llega un correo.`;
    return;
  }

  nodes.confirmationTitle().textContent = 'Cita agendada';
  nodes.confirmationDetail().textContent = `${when} · Te enviamos la confirmación por correo.`;
}

function renderTranscript(state: AppState): void {
  const wrap = nodes.transcriptWrap();
  if (state.transcript.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const recent = state.transcript.slice(-TRANSCRIPT_LINES);
  nodes.transcript().replaceChildren(
    ...recent.map((entry, index) => {
      const line = document.createElement('p');
      const isLast = index === recent.length - 1;
      line.className = isLast
        ? 'text-neutral-800 dark:text-neutral-200'
        : 'text-neutral-400 dark:text-neutral-500';

      const who = document.createElement('span');
      who.className = 'mr-2 text-xs text-neutral-400 dark:text-neutral-600';
      who.textContent = entry.role === 'user' ? 'tú' : 'asistente';

      line.append(who, document.createTextNode(entry.text));
      return line;
    }),
  );
}

export function render(state: AppState): void {
  const active = state.phase === 'active';

  nodes.configWarning().hidden = state.phase !== 'unconfigured';

  nodes.callState().textContent = active ? activeLabel(state) : CALL_STATE[state.phase];

  const start = nodes.start();
  start.hidden = !(state.phase === 'idle' || state.phase === 'ended' || state.phase === 'error');
  start.textContent =
    state.phase === 'ended' || state.phase === 'error'
      ? 'Volver a hablar'
      : 'Hablar con el asistente';
  start.disabled = false;

  nodes.mute().hidden = !active;
  nodes.mute().textContent = state.muted ? 'Activar micrófono' : 'Silenciar';
  nodes.mute().setAttribute('aria-pressed', String(state.muted));
  nodes.hangup().hidden = !active;

  const error = nodes.error();
  error.hidden = state.error === null;
  error.textContent = state.error ?? '';

  renderTranscript(state);
  renderSlots(state);
  renderSummary(state);
  renderConfirmation(state);

  // The panel is only worth its space once it has something in it.
  nodes.panel().hidden =
    nodes.slotsBlock().hidden && nodes.summaryBlock().hidden && nodes.confirmation().hidden;
}
