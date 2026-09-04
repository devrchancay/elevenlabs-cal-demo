/**
 * The thing you look at while you talk.
 *
 * Its only job is to answer, without words, the question a voice interface
 * always raises: is it hearing me, or is it talking? Silence with no feedback
 * reads as a broken page, and a caller who thinks the page is broken starts
 * talking over the agent.
 *
 * So: the ring tracks the microphone while the agent listens, and the agent's
 * own output while it speaks. Amplitude only — a spectrum would be prettier and
 * would say nothing more.
 */

export interface OrbSource {
  /** 0..1. Whatever should be driving the ring right now. */
  level(): number;
  /** Drives the colour, not the size. */
  mode(): 'idle' | 'listening' | 'speaking' | 'connecting';
}

const RING_COUNT = 3;

export function mountOrb(canvas: HTMLCanvasElement, source: OrbSource): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};

  let frame = 0;
  // The raw level is jumpy enough to look like a glitch; this trails it.
  let smoothed = 0;
  let phase = 0;

  function resize(): void {
    // Backing store in device pixels, layout in CSS pixels: on a retina screen
    // the untouched default is a visibly soft circle.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const size = canvas.clientWidth;
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function palette(mode: ReturnType<OrbSource['mode']>): { core: string; ring: string } {
    switch (mode) {
      case 'speaking':
        return { core: '#2792dc', ring: '39, 146, 220' };
      case 'listening':
        return { core: '#9ce6e6', ring: '156, 230, 230' };
      case 'connecting':
        return { core: '#a3a3a3', ring: '163, 163, 163' };
      default:
        return { core: '#525252', ring: '82, 82, 82' };
    }
  }

  function draw(): void {
    const size = canvas.clientWidth;
    if (size === 0) {
      frame = requestAnimationFrame(draw);
      return;
    }
    if (canvas.width !== size * Math.min(window.devicePixelRatio || 1, 2)) resize();

    const mode = source.mode();
    const target = Math.min(Math.max(source.level(), 0), 1);
    smoothed += (target - smoothed) * 0.18;
    phase += 0.02;

    const center = size / 2;
    const base = size * 0.17;
    const { core, ring } = palette(mode);

    context!.clearRect(0, 0, size, size);

    // Rings first, so the solid core sits on top of them.
    for (let index = 0; index < RING_COUNT; index += 1) {
      const spread = (index + 1) / RING_COUNT;
      // The idle breath keeps the orb alive while nobody is making noise.
      const breath = mode === 'idle' ? 0 : Math.sin(phase - index * 0.6) * 0.02;
      const radius = base * (1 + spread * (0.55 + smoothed * 1.5) + breath);
      const alpha = (1 - spread) * 0.28 * (0.35 + smoothed * 1.4);

      context!.beginPath();
      context!.arc(center, center, radius, 0, Math.PI * 2);
      context!.strokeStyle = `rgba(${ring}, ${Math.min(alpha, 0.5).toFixed(3)})`;
      context!.lineWidth = Math.max(size * 0.005, 1);
      context!.stroke();
    }

    context!.beginPath();
    context!.arc(center, center, base * (1 + smoothed * 0.22), 0, Math.PI * 2);
    context!.fillStyle = core;
    context!.fill();

    frame = requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener('resize', resize);
  frame = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
  };
}
