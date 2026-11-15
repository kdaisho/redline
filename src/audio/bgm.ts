/**
 * BGM engine (#12 → #14): a step sequencer over Web Audio, no asset files.
 *
 * Two halves:
 *  - `compile(track)` expands a track's notation (see `tracks.ts`) into a flat,
 *    time-sorted event list. Pure — no AudioContext.
 *  - `createBgmEngine(ctx, destination)` plays compiled tracks with a lookahead
 *    scheduler: a timer wakes every 40 ms and schedules the next 200 ms of notes
 *    on the audio clock, so timing never depends on the timer's own jitter.
 *
 * The synthesis (voices, levels, bus trims, the limiter + soft clipper on the
 * music's own output) is a faithful port of the prototype the owner approved by
 * ear on issue #12. Keep the numbers as they are.
 */
import { type Track, type TrackId, type ToneVoice, type BassVoice, type Section } from './tracks.ts';

export const STEPS = 16; // steps (16th notes) per bar

const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const QUAL: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
  dim: [0, 3, 6],
  '5': [0, 7],
};

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function noteToMidi(s: string): number {
  const m = /^([a-g])(#|b)?(\d)$/.exec(s);
  if (!m) throw new Error(`bad note "${s}"`);
  return 12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

function pcOf(letter: string, acc: string | undefined): number {
  return mod(PC[letter.toLowerCase()] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0), 12);
}

interface Chord {
  name: string;
  root: number;
  tones: number[];
  bass: number;
  slash: boolean;
}

function parseChord(s: string): Chord {
  const m = /^([A-G])(#|b)?(maj7|m7|sus4|sus2|dim|m|7|5)?(?:\/([A-G])(#|b)?)?$/.exec(s);
  if (!m) throw new Error(`bad chord "${s}"`);
  const rootPc = pcOf(m[1], m[2]);
  return { name: s, root: rootPc, tones: QUAL[m[3] || ''], bass: m[4] ? pcOf(m[4], m[5]) : rootPc, slash: !!m[4] };
}

/** Lowest MIDI note >= low with pitch class pc. */
function atOrAbove(pc: number, low: number): number {
  return low + mod(pc - low, 12);
}

interface MelodyNote {
  t: number;
  d: number;
  m: number;
}

function parseMelody(src: string, nBars: number, where: string): MelodyNote[] {
  const out: MelodyNote[] = [];
  const bars = src.split('|');
  if (bars.length !== nBars) throw new Error(`${where}: lead has ${bars.length} bars, prog has ${nBars}`);
  bars.forEach((bar, b) => {
    let pos = 0;
    bar
      .trim()
      .split(/\s+/)
      .forEach((tok) => {
        const p = tok.split(':');
        const d = +p[1];
        if (p.length !== 2 || !(d > 0) || d !== Math.floor(d)) throw new Error(`${where} bar ${b + 1}: bad token "${tok}"`);
        if (p[0] === '~') {
          if (!out.length) throw new Error(`${where}: tie with nothing before it`);
          out[out.length - 1].d += d;
        } else if (p[0] !== 'r') {
          out.push({ t: b * STEPS + pos, d, m: noteToMidi(p[0]) });
        }
        pos += d;
      });
    if (pos !== STEPS) throw new Error(`${where} bar ${b + 1}: adds up to ${pos} steps, not ${STEPS}`);
  });
  return out;
}

interface Hit {
  i: number;
  len: number;
  c: string;
}

/** "x.-" style 16-char bar -> [{i, len, c}] */
function parsePattern(src: string, where: string): Hit[] {
  const s = src.replace(/\s+/g, '');
  const out: Hit[] = [];
  if (s.length !== STEPS) throw new Error(`${where}: pattern "${src}" is ${s.length} steps, not ${STEPS}`);
  for (let i = 0; i < STEPS; i++) {
    const c = s[i];
    if (c === '.') continue;
    if (c === '-') {
      if (!out.length || out[out.length - 1].i + out[out.length - 1].len !== i) throw new Error(`${where}: stray hold in "${src}"`);
      out[out.length - 1].len++;
      continue;
    }
    out.push({ i, len: 1, c });
  }
  return out;
}

type ScaleSet = Record<number, boolean>;

/** A harmony line a diatonic third under the lead, nudged onto a chord tone when the chord leaves the scale. */
export function harmonize(m: number, chord: Pick<Chord, 'root' | 'tones'>, scale: ScaleSet): number {
  let p = m;
  let n = 0;
  while (n < 2 || m - p < 3) {
    p--;
    if (scale[mod(p, 12)]) n++;
  }
  const isCT = (x: number): boolean => chord.tones.some((t) => mod(chord.root + t, 12) === mod(x, 12));
  if (!isCT(p) && (isCT(p + 1) || isCT(p - 1))) {
    for (let q = m - 3; q >= m - 9; q--)
      if (isCT(q)) {
        p = q;
        break;
      }
  }
  return p;
}

const BASS_DEG: Record<string, number> = { r: 0, R: 12, '5': 7, f: -5, l: -2 };
const TOM_MIDI: Record<string, number> = { h: 57, m: 52, l: 47 };

export type Channel = 'lead' | 'harm' | 'arp' | 'chord' | 'bass' | 'kick' | 'snare' | 'hat' | 'ohat' | 'tom' | 'crash';

export interface BgmEvent {
  /** Start, in steps from the top of the loop. */
  t: number;
  /** Length in steps. */
  d: number;
  ch: Channel;
  /** MIDI note (0 for unpitched drums). */
  m: number;
  /** Velocity 0..1. */
  v: number;
}

export interface CompiledTrack {
  events: BgmEvent[];
  bars: { section: string; chords: string }[];
  /** Loop length in steps. */
  steps: number;
}

/** Seconds per step (16th note) at a tempo. */
export function secondsPerStep(bpm: number): number {
  return 60 / bpm / 4;
}

/** One pass of the loop, in seconds. */
export function loopSeconds(track: Track, compiled: CompiledTrack = compile(track)): number {
  return compiled.steps * secondsPerStep(track.bpm);
}

type PatternChannel = 'bass' | 'arp' | 'chord' | 'drums';

/** Expand a track into a flat, time-sorted event list. Pure: no AudioContext needed. */
export function compile(track: Track): CompiledTrack {
  const secs: Record<string, Section> = {};
  const events: BgmEvent[] = [];
  const bars: { section: string; chords: string }[] = [];
  let bar0 = 0;
  track.sections.forEach((s) => {
    const base = s.like ? secs[s.like] : {};
    if (s.like && !base) throw new Error(`${track.id}: section ${s.name} is like unknown ${s.like}`);
    secs[s.name] = { ...base, ...s };
  });
  const scale: ScaleSet = {};
  track.scale.split(/\s+/).forEach((n) => {
    scale[noteToMidi(n + '4') % 12] = true;
  });
  const bassLow = track.bassLow || 31;
  const arpLow = track.arpLow || 60;
  const chordLow = track.chordLow || 55;
  const P = track.pats;

  track.form.forEach((name) => {
    const s = secs[name];
    const where = `${track.id}/${name}`;
    if (!s) throw new Error(`${track.id}: form names unknown section ${name}`);
    if (!s.prog) throw new Error(`${where}: no prog`);
    const prog = s.prog
      .trim()
      .split(/\s+/)
      .map((b) => b.split(',').map(parseChord));
    const n = prog.length;
    const t0 = bar0 * STEPS;
    const chordAt = (step: number): Chord => {
      const b = prog[Math.floor(step / STEPS)];
      return b[Math.floor(((step % STEPS) * b.length) / STEPS)];
    };
    const keys = (ch: PatternChannel): string => {
      let k = (s[ch] || '').replace(/\s+/g, '');
      if (!k) k = '.'.repeat(n);
      if (k.length !== n) throw new Error(`${where}: ${ch} has ${k.length} bar keys, prog has ${n}`);
      return k;
    };

    if (s.lead)
      parseMelody(s.lead, n, where).forEach((e) => {
        const m = e.m + (track.leadTr || 0);
        events.push({ t: t0 + e.t, d: e.d, ch: 'lead', m, v: 1 });
        if (s.harm) events.push({ t: t0 + e.t, d: e.d, ch: 'harm', m: harmonize(m, chordAt(e.t), scale), v: 1 });
      });
    if (s.crash !== false) events.push({ t: t0, d: 8, ch: 'crash', m: 0, v: 1 });

    const kb = keys('bass');
    const ka = keys('arp');
    const kc = keys('chord');
    const kd = keys('drums');
    for (let b = 0; b < n; b++) {
      const bt = t0 + b * STEPS;
      bars.push({ section: name, chords: prog[b].map((c) => c.name).join(' ') });
      const pat = <K extends PatternChannel>(kind: K, key: string): Track['pats'][K][string] => {
        const p = P[kind] && P[kind][key];
        if (!p) throw new Error(`${where}: no ${kind} pattern "${key}"`);
        return p as Track['pats'][K][string];
      };
      if (kb[b] !== '.')
        parsePattern(pat('bass', kb[b]), `${where} bass`).forEach((h) => {
          const c = chordAt(b * STEPS + h.i);
          const rootM = atOrAbove(c.bass, bassLow);
          let off = 0;
          if (h.c === '3') off = c.slash ? 0 : c.tones[1];
          else if (h.c === '7')
            off = c.tones.length > 3 ? c.tones[3] : scale[mod(rootM + 10, 12)] ? 10 : 9; // chord 7th, else b7 if diatonic, else the 6th
          else if (h.c in BASS_DEG) off = BASS_DEG[h.c];
          else throw new Error(`${where}: bad bass char "${h.c}"`);
          if (c.slash && (h.c === '5' || h.c === '7' || h.c === '3' || h.c === 'f' || h.c === 'l')) {
            // over a slash chord, colour notes become the next chord tone above the bass note
            for (off = 1; off < 12; off++) {
              const o = off;
              if (c.tones.some((t) => mod(c.root + t, 12) === mod(rootM + o, 12))) break;
            }
          }
          events.push({ t: bt + h.i, d: h.len, ch: 'bass', m: rootM + off, v: h.c === 'R' ? 0.9 : 1 });
        });
      if (ka[b] !== '.')
        parsePattern(pat('arp', ka[b]), `${where} arp`).forEach((h) => {
          const c = chordAt(b * STEPS + h.i);
          const i = +h.c;
          if (!(i >= 0 && i <= 9)) throw new Error(`${where}: bad arp char "${h.c}"`);
          const m = atOrAbove(c.root, arpLow) + c.tones[i % c.tones.length] + 12 * Math.floor(i / c.tones.length);
          events.push({ t: bt + h.i, d: h.len, ch: 'arp', m, v: h.i % 4 === 0 ? 1 : 0.8 });
        });
      if (kc[b] !== '.')
        parsePattern(pat('chord', kc[b]), `${where} chord`).forEach((h) => {
          if (h.c !== 'x') throw new Error(`${where}: bad chord char "${h.c}"`);
          const c = chordAt(b * STEPS + h.i);
          c.tones.forEach((t) => {
            events.push({ t: bt + h.i, d: h.len, ch: 'chord', m: atOrAbove(mod(c.root + t, 12), chordLow), v: 1 });
          });
        });
      if (kd[b] !== '.') {
        const d = pat('drums', kd[b]);
        parsePattern(d.k, `${where} kick`).forEach((h) => {
          if (h.c !== 'x') throw new Error(`${where}: bad kick char`);
          events.push({ t: bt + h.i, d: 1, ch: 'kick', m: 0, v: h.i % 4 === 0 ? 1 : 0.85 });
        });
        parsePattern(d.s, `${where} snare`).forEach((h) => {
          if (h.c !== 'x' && h.c !== 'g') throw new Error(`${where}: bad snare char`);
          events.push({ t: bt + h.i, d: 1, ch: 'snare', m: 0, v: h.c === 'g' ? 0.3 : h.i % 4 === 0 ? 1 : 0.8 });
        });
        parsePattern(d.h, `${where} hat`).forEach((h) => {
          if (h.c !== 'x' && h.c !== 'o') throw new Error(`${where}: bad hat char`);
          events.push({ t: bt + h.i, d: 1, ch: h.c === 'o' ? 'ohat' : 'hat', m: 0, v: h.i % 4 === 0 ? 1 : h.i % 2 === 0 ? 0.7 : 0.45 });
        });
        if (d.p)
          parsePattern(d.p, `${where} perc`).forEach((h) => {
            const tm = TOM_MIDI[h.c];
            if (!tm) throw new Error(`${where}: bad perc char "${h.c}"`);
            events.push({ t: bt + h.i, d: 1, ch: 'tom', m: tm, v: 1 });
          });
      }
    }
    bar0 += n;
  });
  events.sort((a, b) => a.t - b.t);
  if (!events.length) throw new Error(`${track.id}: no events`);
  return { events, bars, steps: bar0 * STEPS };
}

// ── Voices ───────────────────────────────────────────────────────────────────
type ToneChannel = 'lead' | 'harm' | 'arp' | 'chord';
const TONE_CHANNELS: readonly ToneChannel[] = ['lead', 'harm', 'arp', 'chord'];

const VOICE_DEFAULTS: Record<ToneChannel, ToneVoice> & { bass: BassVoice } = {
  lead: { wave: 'pulse25', level: 0.15, a: 0.006, dec: 0.09, sus: 0.72, rel: 0.028, gate: 0.93, vib: 11, send: 0.3, lp: 5200 },
  harm: { wave: 'pulse25', level: 0.085, a: 0.006, dec: 0.09, sus: 0.72, rel: 0.028, gate: 0.93, vib: 8, send: 0.22, lp: 4200 },
  arp: { wave: 'pulse12', level: 0.05, a: 0.003, dec: 0.05, sus: 0.35, rel: 0.02, gate: 0.75, vib: 0, send: 0.35, lp: 6000 },
  chord: { wave: 'sawtooth', level: 0.038, a: 0.006, dec: 0.12, sus: 0.6, rel: 0.03, gate: 0.85, vib: 0, send: 0.15, lp: 2600 },
  bass: { type: 'fm', level: 0.3, index: 3.2, ratio: 1, gate: 0.82 },
};
const DRUM_LEVEL = { kick: 0.55, snare: 0.36, hat: 0.2, ohat: 0.17, tom: 0.34, crash: 0.16 };
// mix-bus trims, set from offline renders so the channels sit at sensible relative levels
const BUS_TRIM: Record<string, number> = { lead: 1, harm: 1.3, arp: 2.4, chord: 1.45, bass: 0.67 };

function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  const N = 40;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let n = 1; n < N; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  return ctx.createPeriodicWave(re, im);
}

/**
 * Soft-clip transfer curve: linear up to `knee`, then a smooth bend that tops
 * out at `knee + room`, below full scale. The defaults are the music's own
 * clipper (linear to 0.7, ceiling 0.95).
 */
export function softClipCurve(knee = 0.7, room = 0.25): Float32Array<ArrayBuffer> {
  const n = 2049;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = (x < 0 ? -1 : 1) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  return c;
}

// ── Engine: lookahead sequencer + synth ──────────────────────────────────────
const LOOKAHEAD = 0.2; // seconds of audio scheduled ahead of the clock
const TICK_MS = 40; // how often the scheduler wakes
const MASTER_TRIM = 0.8; // level of every track going into the limiter
const POST_GAIN = 0.6; // level after the limiter
const START_LEAD = 0.06; // a new track's first note is this far ahead of "now"
const FADE_IN = 0.02; // linear fade-in of a starting track (its notes have their own envelopes)
/** Default fade-out time constant; the level is inaudible after about five of them. */
export const DEFAULT_FADE_TC = 0.02;

interface Rig {
  track: Track;
  comp: CompiledTrack;
  spb: number;
  chan: Record<string, AudioNode>;
  voice: Record<ToneChannel, ToneVoice> & { bass: BassVoice };
  out: GainNode;
  echoIn: GainNode;
  delay: DelayNode;
  echoLp: BiquadFilterNode;
  fb: GainNode;
  lfo: OscillatorNode;
  t0: number;
  idx: number;
  loop: number;
  timer: ReturnType<typeof setInterval> | null;
}

export interface PlayOptions {
  /** Extra seconds of silence before the first note (lets a fade-out or a cue finish). */
  delay?: number;
  /**
   * Start this many steps into the track instead of at its top (#37: seeking on the
   * soundtrack page). May run past one loop. Notes that began before this point are
   * not resumed mid-note; everything from it on plays as usual.
   */
  from?: number;
}

export interface BgmPosition {
  id: TrackId;
  loop: number;
  step: number;
  bar: number;
  beat: number;
}

export interface BgmEngine {
  /** Start a track from its top, replacing whatever is playing (which fades out). */
  play(track: Track, opts?: PlayOptions): void;
  /** Fade the current track out (`fadeTc` = time constant in seconds) and release it. */
  stop(fadeTc?: number): void;
  position(): BgmPosition | null;
  playingId(): TrackId | null;
  /** Offline use: schedule `loops` whole passes up front (OfflineAudioContext renders / tests). */
  scheduleAll(track: Track, loops: number, at: number, only?: (e: BgmEvent) => boolean): { seconds: number; events: number };
}

/**
 * Build the music engine on `ctx`, feeding `destination`. The engine owns the
 * music's own limiter and soft clipper (part of the approved sound); the game's
 * mixer adds the music volume and the shared final limiter after it.
 */
export interface BgmEngineOptions {
  /**
   * Seconds of audio scheduled ahead of the clock (default 0.2). The soundtrack
   * page asks for a few seconds so music survives a background tab, whose timers
   * wake only about once a second. Timing and sound are unchanged either way.
   */
  lookahead?: number;
}

export function createBgmEngine(ctx: BaseAudioContext, destination: AudioNode, options: BgmEngineOptions = {}): BgmEngine {
  const lookahead = Math.max(LOOKAHEAD, options.lookahead ?? LOOKAHEAD);
  const cache: Partial<Record<TrackId, CompiledTrack>> = {};
  let rig: Rig | null = null;
  const waves: Record<string, PeriodicWave> = { pulse25: pulseWave(ctx, 0.25), pulse12: pulseWave(ctx, 0.125) };
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  {
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // master: limiter, then a soft clipper so the output can never reach full scale
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -9;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.14;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  // the compressor adds automatic make-up gain; `post` takes it back out so the clipper only ever sees strays
  const post = ctx.createGain();
  post.gain.value = POST_GAIN;
  limiter.connect(post);
  post.connect(clip);
  clip.connect(destination);

  const compiled = (track: Track): CompiledTrack => cache[track.id] || (cache[track.id] = compile(track));
  const setWave = (o: OscillatorNode, w: string): void => {
    if (waves[w]) o.setPeriodicWave(waves[w]);
    else o.type = w as OscillatorType;
  };

  function buildRig(track: Track, at: number): Rig {
    const spb = secondsPerStep(track.bpm);
    const voice = {
      lead: { ...VOICE_DEFAULTS.lead, ...track.voices.lead },
      harm: { ...VOICE_DEFAULTS.harm, ...track.voices.harm },
      arp: { ...VOICE_DEFAULTS.arp, ...track.voices.arp },
      chord: { ...VOICE_DEFAULTS.chord, ...track.voices.chord },
      bass: { ...VOICE_DEFAULTS.bass, ...track.voices.bass },
    };
    const out = ctx.createGain();
    out.gain.value = 0; // silent until `at`, even if the fade-in is cancelled by an early stop
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime((track.gain || 1) * MASTER_TRIM, at + FADE_IN);
    out.connect(limiter);
    // short tempo-synced echo (dotted 8th), darkened in the feedback path
    const echoIn = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = spb * 3;
    const echoLp = ctx.createBiquadFilter();
    echoLp.type = 'lowpass';
    echoLp.frequency.value = 2600;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    echoIn.connect(delay);
    delay.connect(echoLp);
    echoLp.connect(fb);
    fb.connect(delay);
    echoLp.connect(out);
    // one bus per channel: [filter] -> out, plus an echo send
    const chan: Record<string, AudioNode> = {};
    const bus = (name: string, filterType?: BiquadFilterType, freq?: number, send?: number): void => {
      const g = ctx.createGain();
      let head: AudioNode = g;
      g.gain.value = BUS_TRIM[name] || 1;
      if (filterType && freq !== undefined) {
        const f = ctx.createBiquadFilter();
        f.type = filterType;
        f.frequency.value = freq;
        f.Q.value = 0.7;
        f.connect(g);
        head = f;
      }
      g.connect(out);
      if (send) {
        const s = ctx.createGain();
        s.gain.value = send;
        g.connect(s);
        s.connect(echoIn);
      }
      chan[name] = head;
    };
    TONE_CHANNELS.forEach((k) => bus(k, 'lowpass', voice[k].lp, voice[k].send));
    bus('bass');
    bus('kick');
    bus('tom');
    bus('snare', 'highpass', 900, 0.06);
    bus('hat', 'highpass', 7500);
    bus('crash', 'highpass', 5000, 0.1);
    // one shared vibrato LFO; each long note taps it through its own depth gain
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.8;
    lfo.start(at);
    return { track, comp: compiled(track), spb, chan, voice, out, echoIn, delay, echoLp, fb, lfo, t0: at, idx: 0, loop: 0, timer: null };
  }

  function tone(r: Rig, ch: ToneChannel, t: number, durSec: number, midi: number, vel: number): void {
    const sp = r.voice[ch];
    const f = mtof(midi);
    const g = ctx.createGain();
    const peak = vel * sp.level;
    const tOff = t + Math.max(durSec * sp.gate, sp.a + 0.02);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + sp.a);
    g.gain.setTargetAtTime(peak * sp.sus, t + sp.a, sp.dec);
    g.gain.setTargetAtTime(0, tOff, sp.rel);
    const tEnd = tOff + sp.rel * 8;
    const oscs: OscillatorNode[] = [];
    let vg: GainNode | null = null;
    const dual = sp.wave === 'saw2';
    (dual ? [-8, 8] : [0]).forEach((cents) => {
      const o = ctx.createOscillator();
      setWave(o, dual ? 'sawtooth' : sp.wave);
      o.frequency.setValueAtTime(f, t);
      o.detune.setValueAtTime(cents, t);
      if (dual) {
        const h = ctx.createGain();
        h.gain.value = 0.6;
        o.connect(h);
        h.connect(g);
      } else o.connect(g);
      o.start(t);
      o.stop(tEnd);
      oscs.push(o);
    });
    if (sp.vib && durSec > 0.24) {
      // delayed vibrato on held notes only
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(0, t + 0.12);
      depth.gain.linearRampToValueAtTime(sp.vib, t + 0.3);
      r.lfo.connect(depth);
      oscs.forEach((o) => depth.connect(o.detune));
      vg = depth;
    }
    g.connect(r.chan[ch]);
    oscs[0].onended = () => {
      g.disconnect();
      if (vg) {
        try {
          r.lfo.disconnect(vg);
        } catch {
          // the rig was already disposed
        }
        vg.disconnect();
      }
    };
  }

  function bass(r: Rig, t: number, durSec: number, midi: number, vel: number): void {
    const sp = r.voice.bass;
    const f = mtof(midi);
    const g = ctx.createGain();
    const peak = vel * sp.level;
    const tOff = t + Math.max(durSec * sp.gate, 0.03);
    const tEnd = tOff + 0.16;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.setTargetAtTime(peak * 0.7, t + 0.004, 0.09);
    g.gain.setTargetAtTime(0, tOff, 0.02);
    const car = ctx.createOscillator();
    let extra: AudioNode;
    if (sp.type === 'fm') {
      // 2-operator FM pluck: bright attack that decays to a round tone
      const mo = ctx.createOscillator();
      const mg = ctx.createGain();
      car.type = 'sine';
      mo.type = 'sine';
      car.frequency.setValueAtTime(f, t);
      mo.frequency.setValueAtTime(f * sp.ratio, t);
      mg.gain.setValueAtTime(f * sp.index, t);
      mg.gain.setTargetAtTime(f * sp.index * 0.22, t, 0.07);
      mo.connect(mg);
      mg.connect(car.frequency);
      car.connect(g);
      mo.start(t);
      mo.stop(tEnd);
      extra = mg;
    } else {
      // filtered saw with a closing filter
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(Math.min(f * 14, 3200), t);
      lp.frequency.setTargetAtTime(f * 3, t, 0.06);
      car.type = 'sawtooth';
      car.frequency.setValueAtTime(f, t);
      car.connect(lp);
      lp.connect(g);
      extra = lp;
    }
    g.connect(r.chan.bass);
    car.start(t);
    car.stop(tEnd);
    car.onended = () => {
      g.disconnect();
      extra.disconnect();
    };
  }

  function sineDrop(r: Rig, ch: string, t: number, f0: number, f1: number, sweep: number, decay: number, level: number): void {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.002, decay);
    o.connect(g);
    g.connect(r.chan[ch]);
    o.start(t);
    o.stop(t + decay * 8 + 0.01);
    o.onended = () => g.disconnect();
  }

  function burst(r: Rig, ch: string, t: number, decay: number, level: number): void {
    const s = ctx.createBufferSource();
    const g = ctx.createGain();
    s.buffer = noise;
    s.loop = true;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.002, decay);
    s.connect(g);
    g.connect(r.chan[ch]);
    s.start(t, Math.random() * 1.5);
    s.stop(t + decay * 8 + 0.01);
    s.onended = () => g.disconnect();
  }

  function playEvent(r: Rig, ev: BgmEvent, t: number): void {
    const dur = ev.d * r.spb;
    const v = ev.v;
    switch (ev.ch) {
      case 'lead':
      case 'harm':
      case 'arp':
      case 'chord':
        tone(r, ev.ch, t, dur, ev.m, v);
        break;
      case 'bass':
        bass(r, t, dur, ev.m, v);
        break;
      case 'kick':
        sineDrop(r, 'kick', t, 165, 46, 0.075, 0.05, DRUM_LEVEL.kick * v);
        burst(r, 'hat', t, 0.004, 0.05 * v);
        break;
      case 'snare':
        burst(r, 'snare', t, 0.055, DRUM_LEVEL.snare * v);
        sineDrop(r, 'tom', t, 215, 150, 0.05, 0.028, 0.2 * v);
        break;
      case 'hat':
        burst(r, 'hat', t, 0.011, DRUM_LEVEL.hat * v);
        break;
      case 'ohat':
        burst(r, 'hat', t, 0.06, DRUM_LEVEL.ohat * Math.max(v, 0.7));
        break;
      case 'tom':
        sineDrop(r, 'tom', t, mtof(ev.m), mtof(ev.m) * 0.62, 0.12, 0.06, DRUM_LEVEL.tom * v);
        break;
      case 'crash':
        burst(r, 'crash', t, 0.3, DRUM_LEVEL.crash * v);
        break;
    }
  }

  function tick(r: Rig): void {
    const now = ctx.currentTime;
    const horizon = now + lookahead;
    const ev = r.comp.events;
    const loopDur = r.comp.steps * r.spb;
    for (;;) {
      const e = ev[r.idx];
      const t = r.t0 + r.loop * loopDur + e.t * r.spb;
      if (t > horizon) break;
      if (t >= now - 0.02) playEvent(r, e, Math.max(t, now)); // drop anything the timer missed instead of bunching it up
      if (++r.idx >= ev.length) {
        r.idx = 0;
        r.loop++;
      }
    }
  }

  function dispose(r: Rig): void {
    if (r.timer !== null) clearInterval(r.timer);
    r.timer = null;
    try {
      r.lfo.stop();
    } catch {
      // never started / already stopped
    }
    r.lfo.disconnect();
    r.fb.disconnect();
    r.echoLp.disconnect();
    r.out.disconnect();
  }

  function stop(fadeTc: number = DEFAULT_FADE_TC): void {
    const r = rig;
    if (!r) return;
    rig = null;
    const tc = Math.max(fadeTc, 0.005);
    const now = ctx.currentTime;
    r.out.gain.cancelScheduledValues(now);
    r.out.gain.setTargetAtTime(0, now, tc);
    // The rig keeps sequencing under the fade (so a long fade does not run out
    // of notes) and is released once it is inaudible.
    setTimeout(() => dispose(r), Math.max(500, tc * 8 * 1000));
  }

  function play(track: Track, opts: PlayOptions = {}): void {
    stop();
    const at = ctx.currentTime + START_LEAD + Math.max(0, opts.delay ?? 0);
    const r = buildRig(track, at);
    const from = Math.max(0, Math.floor(opts.from ?? 0));
    if (from > 0) {
      // Pretend the track started `from` steps before `at`: the next event due is the
      // first one at or after that point, and position() counts from the real top.
      const steps = r.comp.steps;
      const inLoop = from % steps;
      r.t0 = at - from * r.spb;
      r.loop = Math.floor(from / steps);
      r.idx = r.comp.events.findIndex((e) => e.t >= inLoop);
      if (r.idx < 0) {
        r.idx = 0;
        r.loop++;
      }
    }
    rig = r;
    tick(r);
    r.timer = setInterval(() => tick(r), TICK_MS);
  }

  function scheduleAll(track: Track, loops: number, at: number, only?: (e: BgmEvent) => boolean): { seconds: number; events: number } {
    const r = buildRig(track, at);
    const loopDur = r.comp.steps * r.spb;
    let n = 0;
    for (let l = 0; l < loops; l++)
      r.comp.events.forEach((e) => {
        if (only && !only(e)) return;
        playEvent(r, e, at + l * loopDur + e.t * r.spb);
        n++;
      });
    return { seconds: loops * loopDur, events: n };
  }

  function position(): BgmPosition | null {
    const r = rig;
    if (!r) return null;
    const el = Math.max(0, ctx.currentTime - r.t0);
    const s = Math.floor(el / r.spb);
    return {
      id: r.track.id,
      loop: Math.floor(s / r.comp.steps),
      step: s % r.comp.steps,
      bar: Math.floor((s % r.comp.steps) / STEPS),
      beat: Math.floor((s % STEPS) / 4),
    };
  }

  return { play, stop, position, scheduleAll, playingId: () => (rig ? rig.track.id : null) };
}
