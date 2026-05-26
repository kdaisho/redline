/**
 * Synthesized audio (KDA-46/47). No asset files — every cue is built from
 * oscillators + gain envelopes through the Web Audio API. One shared
 * AudioContext, one master gain that doubles as the mute switch.
 *
 * Browser autoplay policy: a context created before a user gesture starts
 * suspended. `initAudio()` is called from the first Enter/Space (the start
 * screen) to create-or-resume it. Every play helper degrades to a no-op if the
 * context is unavailable (blocked, or pre-gesture).
 */

const MUTE_KEY = 'redline.muted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = loadMuted();

export function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(m: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    // ignore persistence failures (private mode etc.)
  }
}

/** Create or resume the AudioContext. Safe to call repeatedly; needs a gesture. */
export function initAudio(): void {
  try {
    if (!ctx) {
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    void ctx.resume();
  } catch {
    ctx = null;
    master = null;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  saveMuted(m);
  if (ctx && master) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.01);
}

/** Flip mute and return the new state (for the HUD). */
export function toggleMute(): boolean {
  setMuted(!muted);
  return muted;
}

// ── synth primitives ────────────────────────────────────────────────────────
interface Blip {
  type: OscillatorType;
  freq: number;
  freqEnd?: number; // glide target (exponential) if set
  dur: number; // seconds
  peak: number; // envelope peak gain
  attack?: number; // seconds to peak (default tiny)
  delay?: number; // seconds from now before it sounds
}

/** Schedule a single enveloped oscillator on the master bus. */
function blip(b: Blip): void {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + (b.delay ?? 0);
  const attack = b.attack ?? 0.002;

  const osc = ctx.createOscillator();
  osc.type = b.type;
  osc.frequency.setValueAtTime(b.freq, t0);
  if (b.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, b.freqEnd), t0 + b.dur);
  }

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(b.peak, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + b.dur);

  osc.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + b.dur + 0.02);
}

// ── cues ─────────────────────────────────────────────────────────────────────
/** Red deleted: a tight, high balloon-pop — fast attack, fast decay, slight drop. */
export function playRedPop(): void {
  initAudio();
  blip({ type: 'triangle', freq: 1900, freqEnd: 1150, dur: 0.075, peak: 0.5 });
}

/** Blue deleted (a mistake): a short low dissonant buzz, sweeping down. */
export function playBlueError(): void {
  initAudio();
  blip({ type: 'sawtooth', freq: 180, freqEnd: 80, dur: 0.2, peak: 0.32 });
  blip({ type: 'square', freq: 174, freqEnd: 78, dur: 0.2, peak: 0.14 }); // detuned for buzz
}

/** Stage cleared: a short rising arpeggio (~0.55s total). Snappy, not orchestral. */
export function playFanfare(): void {
  initAudio();
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((freq, i) =>
    blip({ type: 'triangle', freq, dur: 0.16, peak: 0.34, attack: 0.004, delay: i * 0.1 }),
  );
}
