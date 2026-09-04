/**
 * The voice session itself.
 *
 * This is the whole reason the embedded widget is gone: `@elevenlabs/client` is
 * transport only — WebRTC, microphone, callbacks — and ships no interface of its
 * own, so everything the caller sees is ours.
 */

import { Conversation } from '@elevenlabs/client';
import type { Mode, Status } from '@elevenlabs/client';

/**
 * What the agent puts on screen just before asking "¿está todo correcto?".
 *
 * It arrives as a client tool rather than through the backend, and that is the
 * point: the name and the email never leave the browser they were dictated
 * into. It also means the caller *reads* the address while the agent spells it
 * out loud, which is the moment a mistranscribed email gets caught.
 */
export interface BookingSummary {
  optionId: string;
  name: string;
  email: string;
}

export interface VoiceSessionHandlers {
  onStatus(status: Status): void;
  onMode(mode: Mode): void;
  onTranscript(entry: { role: 'user' | 'agent'; text: string }): void;
  onSummary(summary: BookingSummary): void;
  onError(message: string): void;
}

export interface VoiceSession {
  id: string;
  end(): Promise<void>;
  setMuted(muted: boolean): void;
  /** 0..1, whichever side is making noise. Never throws. */
  level(mode: Mode): number;
}

/** Thrown when the browser refuses the microphone, which needs its own message. */
export class MicrophoneDeniedError extends Error {
  constructor() {
    super('microphone denied');
    this.name = 'MicrophoneDeniedError';
  }
}

export interface StartOptions {
  agentId: string;
  currentDateTime: string;
  handlers: VoiceSessionHandlers;
}

export async function startVoiceSession(options: StartOptions): Promise<VoiceSession> {
  // Asked for before connecting: a permission prompt in the middle of a live
  // session would be answered while the agent is already talking.
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new MicrophoneDeniedError();
  }

  const conversation = await Conversation.startSession({
    agentId: options.agentId,
    connectionType: 'webrtc',
    // The agent is told what day it is. It never works this out itself.
    dynamicVariables: { fecha_actual: options.currentDateTime },
    clientTools: {
      // The name has to match agent/tool_configs/show_booking_summary.json
      // exactly, including case.
      show_booking_summary: (parameters: unknown) => {
        const input = parameters as Partial<BookingSummary>;
        if (
          typeof input?.optionId === 'string' &&
          typeof input?.name === 'string' &&
          typeof input?.email === 'string'
        ) {
          options.handlers.onSummary({
            optionId: input.optionId,
            name: input.name,
            email: input.email,
          });
        }
      },
    },
    onStatusChange: ({ status }) => options.handlers.onStatus(status),
    onModeChange: ({ mode }) => options.handlers.onMode(mode),
    onMessage: ({ message, role }) => {
      if (typeof message === 'string' && message.trim().length > 0) {
        options.handlers.onTranscript({ role, text: message });
      }
    },
    onError: (message) => options.handlers.onError(message),
  });

  return {
    id: conversation.getId(),

    async end() {
      await conversation.endSession();
    },

    setMuted(muted) {
      conversation.setMicMuted(muted);
    },

    level(mode) {
      try {
        const raw = mode === 'speaking' ? conversation.getOutputVolume() : conversation.getInputVolume();
        return Number.isFinite(raw) ? raw : 0;
      } catch {
        // These read from audio nodes that briefly do not exist around
        // connect and disconnect. A dead orb beats a thrown frame.
        return 0;
      }
    },
  };
}
