/**
 * Sound effects (#13 → #14): the "Halo" set — rounded sines, pitch glides and
 * filtered air. Plain Web Audio, no samples, no libraries.
 *
 * Every sound is a small function built from two helpers (`tone`, `noise`). The
 * frequencies, envelopes and gains are a faithful port of the set the owner
 * approved by ear on issue #13 — keep the numbers as they are.
 *
 * This module only synthesises. Who may play what, and how often (held keys),
 * is `gate.ts`; the buses and volumes are `../audio.ts`.
 */

export const SFX_IDS = [
  'moveChar',
  'moveWord',
  'moveLineEdge',
  'moveLine',
  'selExtend',
  'selClear',
  'delChar',
  'delWord',
  'delLine',
  'delSelection',
  'delBig',
  'rowCollapse',
  'rowMove',
  'comboUp',
  'comboBreak',
  'mistake',
  'strike',
  'gameOver',
  'countdownTick',
  'countdownGo',
  'stageStart',
  'stageClear',
  'runWin',
  'timeWarning',
  'timeUp',
  'menuMove',
  'menuConfirm',
  'muteToggle',
  'vimMode',
  'vimPending',
  'vimInvalid',
] as const;

export type SfxId = (typeof SFX_IDS)[number];

/** What a sound may vary on. Each sound reads only the fields it cares about. */
export interface SfxParams {
  /** moveLineEdge: -1 line start, +1 line end. moveLine: -1 up, +1 down. */
  dir?: number;
  /** Deletes: characters removed. */
  size?: number;
  /** comboUp: the combo level reached (1, 2, …) — the pitch climbs with it. */
  level?: number;
  /** muteToggle: the new state (true = just muted). */
  muted?: boolean;
  /** vimMode: the mode entered. */
  mode?: 'normal' | 'insert' | 'visual';
}

/**
 * Where and when one sound is rendered: the context, the time its "now" is, and
 * a tally the caller reads back (voices started, when the last one ends).
 */
export interface SfxTarget {
  ctx: BaseAudioContext;
  t0: number;
  voices: number;
  end: number;
}

type Sound = (c: SfxTarget, d: AudioNode, p?: SfxParams) => void;

const EPS = 1e-4;

/** Attack (linear) → optional hold → exponential decay to silence. Returns end time. */
function adsr(param: AudioParam, t0: number, g: number, a: number, h: number, d: number): number {
  const peak = Math.max(g, EPS * 2);
  param.value = EPS;
  param.setValueAtTime(EPS, t0);
  param.linearRampToValueAtTime(peak, t0 + a);
  if (h > 0) param.setValueAtTime(peak, t0 + a + h);
  param.exponentialRampToValueAtTime(EPS, t0 + a + h + d);
  return t0 + a + h + d;
}

interface Timed {
  /** Start offset in seconds. */
  t?: number;
  /** Attack. */
  a?: number;
  /** Hold. */
  h?: number;
  /** Decay. */
  d?: number;
  /** Peak gain. */
  g?: number;
}

function times(c: SfxTarget, o: Timed): { t0: number; a: number; h: number; d: number } {
  return {
    t0: c.t0 + (o.t || 0),
    a: Math.max(o.a ?? 0.003, 0.001),
    h: Math.max(o.h || 0, 0),
    d: Math.max(o.d ?? 0.08, 0.005),
  };
}

const noiseBufs = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuf(c: BaseAudioContext): AudioBuffer {
  let b = noiseBufs.get(c);
  if (!b) {
    b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const ch = b.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    noiseBufs.set(c, b);
  }
  return b;
}

interface ToneOpts extends Timed {
  type?: OscillatorType;
  /** Frequency, and an optional glide target reached after `gl` seconds (default: the whole note). */
  f: number;
  f2?: number;
  gl?: number;
  /** Optional lowpass / highpass on the oscillator. */
  lp?: number;
  hp?: number;
  q?: number;
}

/** One enveloped oscillator. */
function tone(c: SfxTarget, dest: AudioNode, o: ToneOpts): void {
  const { t0, a, h, d } = times(c, o);
  const osc = c.ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f, t0);
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(o.f2, 1), t0 + (o.gl ?? a + h + d));
  const amp = c.ctx.createGain();
  const end = adsr(amp.gain, t0, o.g ?? 0.1, a, h, d);
  let head: AudioNode = osc;
  if (o.lp || o.hp) {
    const flt = c.ctx.createBiquadFilter();
    flt.type = o.lp ? 'lowpass' : 'highpass';
    flt.frequency.value = (o.lp || o.hp)!;
    flt.Q.value = o.q ?? 0.7;
    osc.connect(flt);
    head = flt;
  }
  head.connect(amp);
  amp.connect(dest);
  osc.start(t0);
  osc.stop(end + 0.03);
  osc.onended = () => amp.disconnect();
  c.voices++;
  c.end = Math.max(c.end, end + 0.03);
}

interface NoiseOpts extends Timed {
  type?: BiquadFilterType;
  /** Filter frequency, and an optional sweep target reached at the end of the burst. */
  f: number;
  f2?: number;
  q?: number;
}

/** Filtered white-noise burst. */
function noise(c: SfxTarget, dest: AudioNode, o: NoiseOpts): void {
  const { t0, a, h, d } = times(c, o);
  const src = c.ctx.createBufferSource();
  src.buffer = noiseBuf(c.ctx);
  src.loop = true;
  const flt = c.ctx.createBiquadFilter();
  flt.type = o.type || 'bandpass';
  flt.frequency.setValueAtTime(o.f, t0);
  if (o.f2) flt.frequency.exponentialRampToValueAtTime(Math.max(o.f2, 20), t0 + a + h + d);
  flt.Q.value = o.q ?? 1;
  const amp = c.ctx.createGain();
  const end = adsr(amp.gain, t0, o.g ?? 0.1, a, h, d);
  src.connect(flt);
  flt.connect(amp);
  amp.connect(dest);
  src.start(t0, Math.random() * 1.5);
  src.stop(end + 0.03);
  src.onended = () => amp.disconnect();
  c.voices++;
  c.end = Math.max(c.end, end + 0.03);
}

// ── shared musical helpers ───────────────────────────────────────────────────
const st = (f: number, semis: number): number => f * Math.pow(2, semis / 12);
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
/** combo level 1..5 (clamped to 1..10) → semitones above the base note */
const comboSemi = (p?: SfxParams): number => PENTA[Math.max(0, Math.min(PENTA.length - 1, ((p && p.level) || 1) - 1))];
/** deleted character count → 0..1 on a log curve (1→.14, 5→.37, 20→.63, 60→.85, 127→1) */
const amt = (p: SfxParams | undefined, def: number): number => Math.min(1, Math.log2(Math.max(1, (p && p.size) || def) + 1) / 7);
const dirOf = (p?: SfxParams): number => (((p && p.dir) ?? 1) > 0 ? 1 : -1);

// ═══ HALO — rounded sines, pitch glides, filtered air: soft sci-fi UI ═════════
// prettier-ignore
const halo: Record<SfxId, Sound> = {
  moveChar: (c, d) => tone(c, d, { f: 740, a: 0.004, d: 0.024, g: 0.07 }),
  moveWord: (c, d) => tone(c, d, { f: 660, f2: 880, a: 0.004, d: 0.04, g: 0.07 }),
  moveLineEdge: (c, d, p) => {
    const e = dirOf(p) > 0;
    noise(c, d, { type: 'bandpass', f: e ? 900 : 2600, f2: e ? 2600 : 900, q: 1.2, a: 0.008, d: 0.07, g: 0.16 });
    tone(c, d, { f: e ? 520 : 1040, f2: e ? 1040 : 520, a: 0.006, d: 0.07, g: 0.05 });
  },
  moveLine: (c, d, p) => tone(c, d, { f: dirOf(p) > 0 ? 587 : 784, a: 0.004, d: 0.03, g: 0.07 }),
  selExtend: (c, d) => tone(c, d, { type: 'triangle', f: 523, lp: 1400, a: 0.004, d: 0.045, g: 0.09 }),
  selClear: (c, d) => { noise(c, d, { type: 'highpass', f: 4500, a: 0.01, d: 0.07, g: 0.05 }); tone(c, d, { f: 523, f2: 392, a: 0.006, d: 0.08, g: 0.06 }); },
  delChar: (c, d) => { tone(c, d, { f: 494, f2: 740, gl: 0.05, a: 0.005, d: 0.09, g: 0.2 }); tone(c, d, { f: 124, a: 0.004, d: 0.06, g: 0.15 }); },
  delWord: (c, d, p) => {
    const k = amt(p, 5);
    tone(c, d, { f: 494, f2: 740, gl: 0.05, a: 0.005, d: 0.1, g: 0.18 });
    tone(c, d, { f: 740, f2: 1110, t: 0.05, gl: 0.05, a: 0.006, d: 0.12 + 0.1 * k, g: 0.14 });
    tone(c, d, { f: 110, a: 0.004, d: 0.07, g: 0.16 });
  },
  delLine: (c, d, p) => {
    const k = amt(p, 20);
    noise(c, d, { type: 'bandpass', f: 600, f2: 3200, q: 1, a: 0.02, d: 0.12 + 0.16 * k, g: 0.26 });
    tone(c, d, { f: 392, f2: 784, gl: 0.1, a: 0.008, d: 0.16 + 0.15 * k, g: 0.17 });
    tone(c, d, { f: 98, a: 0.004, d: 0.09, g: 0.17 });
  },
  delSelection: (c, d, p) => {
    const k = amt(p, 20), n = 1 + Math.round(k * 5);
    for (let i = 0; i < n; i++) {
      const f = st(440, PENTA[i]);
      tone(c, d, { f, f2: f * 1.25, t: i * 0.035, gl: 0.04, a: 0.005, d: i === n - 1 ? 0.12 + 0.2 * k : 0.08, g: 0.14 });
    }
    tone(c, d, { f: 110 - 30 * k, a: 0.004, d: 0.08 + 0.1 * k, g: 0.16 + 0.06 * k });
  },
  delBig: (c, d, p) => {
    const k = amt(p, 60);
    tone(c, d, { f: 82, f2: 55, a: 0.008, d: 0.4 + 0.3 * k, g: 0.3 });
    [392, 494, 587, 784].forEach((f) => tone(c, d, { type: 'triangle', f, lp: 2200, a: 0.02, d: 0.5 + 0.5 * k, g: 0.075 }));
    noise(c, d, { type: 'bandpass', f: 500, f2: 4000, q: 0.8, a: 0.03, d: 0.3 + 0.2 * k, g: 0.2 });
    tone(c, d, { f: 784, f2: 1568, t: 0.03, gl: 0.2, a: 0.01, d: 0.3, g: 0.06 });
  },
  rowCollapse: (c, d) => { tone(c, d, { f: 440, f2: 220, a: 0.006, d: 0.13, g: 0.11 }); noise(c, d, { type: 'lowpass', f: 900, a: 0.005, d: 0.1, g: 0.16 }); },
  rowMove: (c, d) => { tone(c, d, { f: 392, f2: 494, a: 0.005, d: 0.05, g: 0.09 }); tone(c, d, { f: 494, f2: 587, t: 0.055, a: 0.005, d: 0.06, g: 0.08 }); },
  comboUp: (c, d, p) => {
    const f = st(523, comboSemi(p));
    tone(c, d, { f, f2: f * 1.06, a: 0.006, d: 0.2, g: 0.14 });
    tone(c, d, { f: f * 1.5, t: 0.04, a: 0.008, d: 0.26, g: 0.1 });
    tone(c, d, { f: f * 2, t: 0.08, a: 0.01, d: 0.3, g: 0.05 });
  },
  comboBreak: (c, d) => {
    tone(c, d, { type: 'triangle', f: 523, f2: 262, lp: 1500, a: 0.01, d: 0.32, g: 0.14 });
    noise(c, d, { type: 'lowpass', f: 1200, f2: 200, a: 0.01, d: 0.25, g: 0.14 });
  },
  mistake: (c, d) => {
    tone(c, d, { type: 'triangle', f: 155, lp: 1100, a: 0.006, d: 0.3, g: 0.27 });
    tone(c, d, { type: 'triangle', f: 165, lp: 1100, a: 0.006, d: 0.3, g: 0.21 });
    noise(c, d, { type: 'lowpass', f: 500, a: 0.003, d: 0.08, g: 0.3 });
  },
  strike: (c, d) => {
    tone(c, d, { f: 95, f2: 45, a: 0.004, d: 0.25, g: 0.28 });
    tone(c, d, { type: 'triangle', f: 233, lp: 1300, a: 0.008, d: 0.3, g: 0.17 });
    tone(c, d, { type: 'triangle', f: 247, lp: 1300, a: 0.008, d: 0.3, g: 0.14 });
  },
  gameOver: (c, d) => {
    ([[0, [392, 466, 587], 0.5], [0.35, [349, 415, 523], 0.5], [0.7, [262, 311, 392], 1.0]] as [number, number[], number][]).forEach(([t, fs, len]) =>
      fs.forEach((f) => tone(c, d, { type: 'triangle', f, lp: 1400, t, a: 0.03, d: len, g: 0.085 })));
    tone(c, d, { f: 65, t: 0.7, a: 0.02, d: 1.0, g: 0.22 });
  },
  countdownTick: (c, d) => { tone(c, d, { f: 587, a: 0.005, d: 0.15, g: 0.17 }); tone(c, d, { f: 1174, a: 0.004, d: 0.05, g: 0.03 }); },
  countdownGo: (c, d) => {
    tone(c, d, { f: 880, a: 0.008, d: 0.5, g: 0.12 }); tone(c, d, { f: 1174, a: 0.008, d: 0.5, g: 0.09 }); tone(c, d, { f: 1760, a: 0.008, d: 0.4, g: 0.04 });
    noise(c, d, { type: 'bandpass', f: 800, f2: 5000, a: 0.02, d: 0.3, g: 0.14 });
  },
  stageStart: (c, d) => {
    tone(c, d, { f: 294, f2: 880, gl: 0.22, a: 0.02, d: 0.3, g: 0.14 });
    noise(c, d, { type: 'bandpass', f: 500, f2: 3500, q: 1, a: 0.03, d: 0.25, g: 0.16 });
  },
  stageClear: (c, d) => {
    [523, 659, 784, 988].forEach((f, i) => tone(c, d, { type: 'triangle', f, lp: 2500, t: i * 0.11, a: 0.01, d: 0.5, g: 0.11 }));
    [523, 784, 1047].forEach((f) => tone(c, d, { f, t: 0.44, a: 0.03, d: 0.8, g: 0.06 }));
  },
  runWin: (c, d) => {
    [262, 392, 523, 659, 784, 988, 1175].forEach((f, i) => tone(c, d, { type: 'triangle', f, lp: 2500, t: i * 0.12, a: 0.012, d: 0.55, g: 0.1 }));
    noise(c, d, { type: 'bandpass', f: 500, f2: 5000, q: 0.8, t: 0.6, a: 0.08, d: 0.4, g: 0.12 });
    [523, 659, 784, 988, 1319].forEach((f) => tone(c, d, { f, t: 0.84, a: 0.04, d: 1.3, g: 0.055 }));
    tone(c, d, { f: 131, t: 0.84, a: 0.03, d: 1.1, g: 0.15 });
  },
  timeWarning: (c, d) => { tone(c, d, { f: 523, a: 0.006, d: 0.09, g: 0.17 }); tone(c, d, { f: 523, t: 0.13, a: 0.006, d: 0.09, g: 0.14 }); },
  timeUp: (c, d) => {
    tone(c, d, { f: 660, f2: 165, gl: 0.45, a: 0.01, d: 0.55, g: 0.16 });
    noise(c, d, { type: 'bandpass', f: 3000, f2: 300, a: 0.02, d: 0.45, g: 0.16 });
    tone(c, d, { f: 82, t: 0.3, a: 0.02, d: 0.5, g: 0.18 });
  },
  menuMove: (c, d) => tone(c, d, { f: 587, a: 0.004, d: 0.03, g: 0.08 }),
  menuConfirm: (c, d) => { tone(c, d, { f: 587, f2: 880, gl: 0.05, a: 0.005, d: 0.1, g: 0.13 }); tone(c, d, { f: 1174, t: 0.06, a: 0.008, d: 0.22, g: 0.08 }); },
  muteToggle: (c, d, p) => {
    const off = !!(p && p.muted);
    tone(c, d, { f: off ? 660 : 440, f2: off ? 440 : 660, gl: 0.08, a: 0.006, d: 0.12, g: 0.11 });
  },
  vimMode: (c, d, p) => {
    const f = ({ normal: 392, insert: 587, visual: 784 } as Record<string, number>)[(p && p.mode) || ''] || 392;
    tone(c, d, { type: 'triangle', f, lp: 1600, a: 0.005, d: 0.09, g: 0.12 });
  },
  vimPending: (c, d) => tone(c, d, { f: 880, a: 0.01, h: 0.02, d: 0.14, g: 0.035 }),
  vimInvalid: (c, d) => { tone(c, d, { f: 196, f2: 165, a: 0.004, d: 0.07, g: 0.2 }); noise(c, d, { type: 'lowpass', f: 500, a: 0.003, d: 0.04, g: 0.32 }); },
};

/**
 * Level of the SFX going into their limiter — the prototype page's volume slider
 * at its default (70 → (0.7)² × 1.6), the level the set was approved at.
 */
export const SFX_INPUT_GAIN = 0.7 * 0.7 * 1.6;

/**
 * The SFX bus's own dynamics, as on the prototype page: gain → limiter. Returns
 * the node to play into and the node to connect onward.
 */
export function createSfxBus(ctx: BaseAudioContext): { input: GainNode; output: AudioNode } {
  const gain = ctx.createGain();
  gain.gain.value = SFX_INPUT_GAIN;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 8;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  gain.connect(limiter);
  return { input: gain, output: limiter };
}

export interface SfxRender {
  /** Oscillators / noise bursts started. */
  voices: number;
  /** Context time when the last of them stops. */
  end: number;
}

/**
 * Render one sound into `dest`, starting at context time `at` (default: now; a
 * time already past is pulled up to now).
 */
export function playSfx(ctx: BaseAudioContext, dest: AudioNode, id: SfxId, params?: SfxParams, at?: number): SfxRender {
  const t0 = Math.max(at ?? ctx.currentTime, ctx.currentTime);
  const target: SfxTarget = { ctx, t0, voices: 0, end: t0 };
  halo[id](target, dest, params);
  return { voices: target.voices, end: target.end };
}
