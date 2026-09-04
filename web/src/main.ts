/**
 * Wiring. Everything interesting is in the modules this pulls together.
 */

import { fetchAgentContext } from './agent-context.js';
import { readConfig } from './config.js';
import type * as ConversationModule from './conversation.js';
import type { BookingSummary, VoiceSession } from './conversation.js';
import { mountOrb } from './orb.js';
import type { SessionWatcher } from './session.js';
import { EMPTY_SESSION, watchSession } from './session.js';
import type { AppState } from './ui.js';
import { render } from './ui.js';
import './style.css';

const config = readConfig();

const state: AppState = {
  phase: config.configured ? 'idle' : 'unconfigured',
  // Replaced by whatever the backend reports the moment a conversation starts.
  timeZone: 'America/Guayaquil',
  mode: 'listening',
  muted: false,
  error: null,
  transcript: [],
  session: EMPTY_SESSION,
  summary: null,
};

let session: VoiceSession | null = null;
let watcher: SessionWatcher | null = null;

/**
 * The ElevenLabs SDK carries a WebRTC stack and is by far the heaviest thing
 * on this page — many times the weight of everything else combined. Nothing
 * needs it until someone decides to talk, so it is imported on demand and
 * warmed up once the page is idle. The result is a landing page that paints in
 * a few kilobytes and a button that still responds instantly.
 */
let sdk: Promise<typeof ConversationModule> | null = null;

function loadSdk(): Promise<typeof ConversationModule> {
  sdk ??= import('./conversation.js');
  return sdk;
}

function update(changes: Partial<AppState>): void {
  Object.assign(state, changes);
  render(state);
}

/* -------------------------------------------------------------------------- */
/* The orb                                                                     */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('orb');
if (canvas instanceof HTMLCanvasElement) {
  mountOrb(canvas, {
    level: () => {
      if (!session || state.phase !== 'active') return 0;
      // A muted microphone should look muted, not quiet.
      if (state.muted && state.mode === 'listening') return 0;
      return session.level(state.mode);
    },
    mode: () => {
      if (state.phase === 'connecting') return 'connecting';
      if (state.phase !== 'active') return 'idle';
      return state.mode;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Starting and stopping                                                       */
/* -------------------------------------------------------------------------- */

function stopWatching(): void {
  watcher?.stop();
  watcher = null;
}

/** Ends the watch with one last read, so a just-made booking still lands. */
function finishWatching(): void {
  const current = watcher;
  watcher = null;
  void current?.finish();
}

async function start(): Promise<void> {
  if (!config.configured || state.phase === 'connecting' || state.phase === 'active') return;

  // A second conversation starts clean: last call's slots would be a lie.
  update({
    phase: 'connecting',
    error: null,
    transcript: [],
    session: EMPTY_SESSION,
    summary: null,
    muted: false,
  });

  try {
    // Both are on the critical path to the first word, so they run together.
    const [{ startVoiceSession }, context] = await Promise.all([
      loadSdk(),
      fetchAgentContext(config.backendUrl),
    ]);
    update({ timeZone: context.timeZone });

    session = await startVoiceSession({
      agentId: config.agentId,
      currentDateTime: context.currentDateTime,
      handlers: {
        onStatus: (status) => {
          if (status === 'connected') update({ phase: 'active' });
          if (status === 'disconnected') {
            finishWatching();
            session = null;
            // An error already on screen is the more useful message of the two.
            update({ phase: state.error ? 'error' : 'ended' });
          }
        },
        onMode: (mode) => update({ mode }),
        onTranscript: (entry) => update({ transcript: [...state.transcript, entry] }),
        onSummary: (summary: BookingSummary) => update({ summary }),
        onError: (message) => {
          console.error('ElevenLabs reported an error.', message);
          update({ error: 'Se cortó la conexión con el asistente. Puedes intentarlo de nuevo.' });
        },
      },
    });

    // The conversation id is the same key the backend files everything under,
    // so watching it needs nothing more than this.
    if (config.backendUrl.length > 0) {
      watcher = watchSession(config.backendUrl, session.id, (next) => update({ session: next }));
    }
  } catch (error) {
    session = null;
    stopWatching();

    const { MicrophoneDeniedError } = await loadSdk();
    if (error instanceof MicrophoneDeniedError) {
      update({
        phase: 'error',
        error:
          'Necesito permiso para usar el micrófono. Actívalo en tu navegador y vuelve a intentarlo.',
      });
      return;
    }

    console.error('The conversation could not be started.', error);
    update({
      phase: 'error',
      error: 'No se pudo iniciar la conversación. Revisa tu conexión e intenta de nuevo.',
    });
  }
}

async function hangUp(): Promise<void> {
  finishWatching();
  try {
    await session?.end();
  } catch (error) {
    console.warn('The session did not close cleanly.', error);
  }
  session = null;
  update({ phase: 'ended' });
}

document.getElementById('start')?.addEventListener('click', () => void start());
document.getElementById('hangup')?.addEventListener('click', () => void hangUp());
document.getElementById('mute')?.addEventListener('click', () => {
  if (!session) return;
  const muted = !state.muted;
  session.setMuted(muted);
  update({ muted });
});

// Closing the tab mid-call should release the microphone and let the agent's
// post-call webhook fire, rather than waiting for a timeout.
window.addEventListener('pagehide', () => {
  void session?.end();
});

render(state);

// Fetched while nobody is waiting on it, so the first click does not pay for it.
if (config.configured) {
  const warmUp = (): void => void loadSdk().catch(() => {
    // Not worth reporting: clicking the button retries and reports properly.
  });
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warmUp);
  else window.setTimeout(warmUp, 1500);
}
