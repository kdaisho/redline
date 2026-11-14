/**
 * The game's audio (#14): music + sound effects, all synthesised — no asset
 * files. This module is the mixer and the public surface; the parts live in
 * `audio/`:
 *
 *   tracks.ts   the eight BGM tracks (data)          bgm.ts   sequencer + synth
 *   sfx.ts      the "Halo" SFX set (31 actions)      gate.ts  held-key / voice limiting
 *   music.ts    which track plays on which screen    cues.ts  game action → sound
 *   settings.ts volumes + mutes, persisted
 *
 * One AudioContext, one chain:
 *
 *   music engine (its own limiter + soft clip) → music volume ┐
 *   SFX voices → SFX bus (its own gain + limiter) → SFX volume ┴→ master (mute)
 *       → final limiter → soft clip → speakers
 *
 * Each bus keeps the dynamics it was approved with; the final limiter is shared,
 * so neither bus can bypass it.
 *
 * Browser autoplay policy: a context may only start after a user gesture.
 * `installAudio()` listens for the first key / pointer press, creates (or
 * resumes) the context there, and only then starts the music. Until then — and
 * wherever Web Audio is missing — every call here is a silent no-op.
 */
import { createBgmEngine, softClipCurve, type BgmEngine } from './audio/bgm.ts';
import { trackById } from './audio/tracks.ts';
import { MusicDirector, type MusicScene } from './audio/music.ts';
import { createSfxBus, playSfx, type SfxId, type SfxParams } from './audio/sfx.ts';
import { SfxGate } from './audio/gate.ts';
import { type Cue } from './audio/cues.ts';
import {
  type AudioSettings,
  type Bus,
  MAX_VOLUME,
  busAudible,
  busGain,
  clampVolume,
  loadSettings,
  saveSettings,
  soundLabel,
} from './audio/settings.ts';

export type { MusicScene } from './audio/music.ts';
export type { SfxId, SfxParams } from './audio/sfx.ts';
export type { Bus } from './audio/settings.ts';

const RAMP = 0.015; // time constant of volume / mute changes — fast, but never a click
/** Muting waits this long so the mute cue itself is heard ("mute plays just before silence"). */
const MUTE_CUE_S = 0.16;

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  musicVol: GainNode;
  sfxVol: GainNode;
  sfxIn: GainNode;
  engine: BgmEngine;
}

let graph: Graph | null = null;
let settings: AudioSettings = loadSettings();
const director = new MusicDirector();
const gate = new SfxGate();
let attachTimer: ReturnType<typeof setTimeout> | null = null;
let suspendTimer: ReturnType<typeof setTimeout> | null = null;
let hidden = false;
let resumeAskedMs = -Infinity; // performance.now() of the last resume() request
/** A sound may be scheduled on a context that is still resuming for this long after the request. */
const RESUME_GRACE_MS = 300;

function buildGraph(): Graph | null {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = w.AudioContext ?? w.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();

  // final stage: a safety limiter both buses share, then a soft clip so the output never reaches full scale
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  const post = ctx.createGain();
  post.gain.value = 0.85; // takes the compressor's automatic make-up gain back out
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve(0.85, 0.13); // transparent below 0.85, tops out at 0.98
  limiter.connect(post);
  post.connect(clip);
  clip.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = settings.muted ? 0 : 1;
  master.connect(limiter);

  const musicVol = ctx.createGain();
  musicVol.gain.value = busGain('music', settings.music);
  musicVol.connect(master);
  const engine = createBgmEngine(ctx, musicVol);

  const sfxBus = createSfxBus(ctx);
  const sfxVol = ctx.createGain();
  sfxVol.gain.value = busGain('sfx', settings.sfx);
  sfxBus.output.connect(sfxVol);
  sfxVol.connect(master);

  return { ctx, master, musicVol, sfxVol, sfxIn: sfxBus.input, engine };
}

/**
 * Create or resume the AudioContext. Safe to call repeatedly; only effective
 * from a user gesture. The music starts a tick later, so the key that unlocked
 * audio is handled first (Enter on the start screen goes straight to the stage
 * track instead of starting the title theme for one frame).
 */
export function initAudio(): void {
  try {
    if (!graph) {
      graph = buildGraph();
      if (!graph) return;
      const g = graph;
      attachTimer = setTimeout(() => {
        attachTimer = null;
        director.setEnabled(busAudible(settings, 'music'));
        director.attach({
          play: (id, opts) => g.engine.play(trackById(id), opts),
          stop: (fadeTc) => g.engine.stop(fadeTc),
        });
      }, 0);
    }
    if (!hidden && graph.ctx.state !== 'running') {
      resumeAskedMs = performance.now();
      void graph.ctx.resume().catch(() => undefined);
    }
  } catch {
    graph = null; // audio unavailable — stay silent
  }
}

/**
 * Wire audio to the page: unlock on the first key / pointer press, and pause
 * while the tab is hidden (a background tab's timers are throttled to about one
 * a second, which would make the sequencer drop or bunch notes; suspending the
 * context freezes the audio clock, so the music picks up exactly where it was).
 * Returns a teardown function.
 */
export function installAudio(target: Window = window): () => void {
  const unlock = (): void => initAudio();
  const onVisibility = (): void => {
    hidden = document.visibilityState === 'hidden';
    const g = graph;
    if (!g) return;
    if (suspendTimer !== null) clearTimeout(suspendTimer);
    suspendTimer = null;
    const now = g.ctx.currentTime;
    if (hidden) {
      // duck first, then suspend — never cut a waveform mid-cycle
      g.master.gain.cancelScheduledValues(now);
      g.master.gain.setTargetAtTime(0, now, RAMP);
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        void g.ctx.suspend().catch(() => undefined);
      }, 90);
    } else {
      void g.ctx
        .resume()
        .then(() => applyMaster())
        .catch(() => undefined);
    }
  };
  // capture: the context exists before the game handles the same key
  target.addEventListener('keydown', unlock, true);
  target.addEventListener('pointerdown', unlock, true);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    target.removeEventListener('keydown', unlock, true);
    target.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('visibilitychange', onVisibility);
    if (attachTimer !== null) clearTimeout(attachTimer);
    if (suspendTimer !== null) clearTimeout(suspendTimer);
  };
}

// ── settings ─────────────────────────────────────────────────────────────────
function applyMaster(delay = 0): void {
  const g = graph;
  if (!g) return;
  const at = g.ctx.currentTime + delay;
  g.master.gain.cancelScheduledValues(g.ctx.currentTime);
  g.master.gain.setTargetAtTime(settings.muted ? 0 : 1, at, RAMP);
}

function applyBus(bus: Bus): void {
  const g = graph;
  if (g) {
    const node = bus === 'music' ? g.musicVol : g.sfxVol;
    node.gain.setTargetAtTime(busGain(bus, settings[bus]), g.ctx.currentTime, RAMP);
  }
  // music that cannot be heard is not sequenced at all
  director.setEnabled(busAudible(settings, 'music'));
}

function commit(): void {
  saveSettings(settings);
}

/** A copy of the current settings (for the HUD / tests). */
export function audioSettings(): AudioSettings {
  return { muted: settings.muted, music: { ...settings.music }, sfx: { ...settings.sfx } };
}

/** The HUD's SOUND readout. */
export function audioLabel(): string {
  return soundLabel(settings);
}

export function isMuted(): boolean {
  return settings.muted;
}

/** Master mute. The toggle cue is heard on both edges: before the silence, and after it lifts. */
export function setMuted(m: boolean): void {
  if (settings.muted === m) return;
  if (m) {
    sfx('muteToggle', { muted: true });
    settings.muted = true;
    applyMaster(MUTE_CUE_S);
  } else {
    settings.muted = false;
    applyMaster();
    sfx('muteToggle', { muted: false });
  }
  commit();
  applyBus('music');
}

/** Flip the master mute and return the new state. */
export function toggleMute(): boolean {
  setMuted(!settings.muted);
  return settings.muted;
}

/** Step a bus's volume by `delta` (clamped to 0..10); stepping also un-mutes that bus. Returns the new step. */
export function adjustVolume(bus: Bus, delta: number): number {
  const next = clampVolume(settings[bus].volume + delta);
  settings[bus] = { volume: next, muted: false };
  commit();
  applyBus(bus);
  sfx('menuMove'); // feedback at the new SFX level (the music is its own feedback)
  return next;
}

/** Mute / un-mute one bus, leaving its volume step alone. Returns the new state. */
export function toggleBusMute(bus: Bus): boolean {
  const muted = !settings[bus].muted;
  settings[bus] = { ...settings[bus], muted };
  commit();
  applyBus(bus);
  sfx('menuMove');
  return muted;
}

export { MAX_VOLUME };

// ── music ────────────────────────────────────────────────────────────────────
/** Tell the music which screen / stage the game is on. Cheap; call on every change. */
export function setMusicScene(scene: MusicScene): void {
  director.setScene(scene);
}

// ── sound effects ────────────────────────────────────────────────────────────
/**
 * Play one SFX, `delay` seconds from now. Dropped silently when audio is not
 * running, the SFX cannot be heard, or the gate says it would only add noise
 * (held keys — see `audio/gate.ts`).
 */
export function sfx(id: SfxId, params?: SfxParams, delay = 0): void {
  const g = graph;
  if (!g || hidden || !busAudible(settings, 'sfx')) return;
  // resume() is asynchronous: the key press that unlocks audio finds the context
  // still suspended. Its sounds are scheduled anyway (the clock starts when the
  // context does); a context that stays suspended gets nothing queued on it.
  if (g.ctx.state !== 'running' && performance.now() - resumeAskedMs > RESUME_GRACE_MS) return;
  try {
    const now = g.ctx.currentTime;
    const at = gate.admit(id, now, now + Math.max(0, delay));
    if (at === null) return;
    const done = playSfx(g.ctx, g.sfxIn, id, params, at);
    gate.started(done.voices, done.end);
  } catch {
    // a failed cue must never break the game
  }
}

/** Play a list of cues (see `audio/cues.ts`), each shifted by `offset` seconds. */
export function playCues(cues: readonly Cue[], offset = 0): void {
  for (const c of cues) sfx(c.id, c.params, (c.delay ?? 0) + offset);
}
