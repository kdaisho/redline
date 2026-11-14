/**
 * Which track plays when (#14). The game reports the screen it is on; the
 * director turns that into a track and, when the track changes, a fade-out and
 * a (possibly delayed) start. Pure over a small `MusicPlayer` interface, so the
 * transitions are testable without Web Audio.
 *
 * Slots (decided on issue #12):
 *   title screen → Cold Boot · stages 1–10 Green Diff · 11–20 Hot Path ·
 *   21–30 Race Condition · 31–40 Stack Overflow · 41–50 Redline ·
 *   game over → Core Dump · win → Ship It
 */
import { type TrackId } from './tracks.ts';

export type MusicScene =
  | { kind: 'title' }
  /** Countdown, playing and stage-cleared all belong to the stage. `stageIndex` is 0-based. */
  | { kind: 'stage'; stageIndex: number }
  | { kind: 'over' }
  | { kind: 'won' };

export const STAGES_PER_TIER = 10;

/** One in-game track per tier of ten stages, in order. */
export const TIER_TRACKS: readonly TrackId[] = ['green-diff', 'hot-path', 'race-condition', 'stack-overflow', 'redline'];

export const TITLE_TRACK: TrackId = 'cold-boot';
export const GAME_OVER_TRACK: TrackId = 'core-dump';
export const WIN_TRACK: TrackId = 'ship-it';

/** 0-based stage index → 0-based tier (stages 1–10 → 0, 11–20 → 1, …), clamped to the last tier. */
export function tierOfStage(stageIndex: number): number {
  const tier = Math.floor(Math.max(0, stageIndex) / STAGES_PER_TIER);
  return Math.min(tier, TIER_TRACKS.length - 1);
}

export function trackForStage(stageIndex: number): TrackId {
  return TIER_TRACKS[tierOfStage(stageIndex)];
}

export function trackForScene(scene: MusicScene): TrackId {
  switch (scene.kind) {
    case 'title':
      return TITLE_TRACK;
    case 'stage':
      return trackForStage(scene.stageIndex);
    case 'over':
      return GAME_OVER_TRACK;
    case 'won':
      return WIN_TRACK;
  }
}

/** How a track change is made: the old track's fade, and the pause before the new one. */
export interface Transition {
  /** Fade-out time constant in seconds (inaudible after about five). */
  fadeTc: number;
  /** Seconds before the new track's first note. */
  delay: number;
}

/**
 * Fades by destination. Never a hard cut: the shortest fade is ~0.25 s to
 * silence. The end screens let their SFX cue play (game over ≈ 1.7 s, run win
 * ≈ 2.1 s) before the theme comes in under its tail.
 */
export function transitionTo(scene: MusicScene, from: TrackId | null): Transition {
  if (from === null) return { fadeTc: 0.02, delay: scene.kind === 'over' ? 1.8 : scene.kind === 'won' ? 1.9 : 0.05 };
  switch (scene.kind) {
    case 'title':
      return { fadeTc: 0.08, delay: 0.3 };
    case 'stage':
      // a tier change (or the run starting): a short cross-over during the countdown
      return { fadeTc: 0.09, delay: 0.35 };
    case 'over':
      return { fadeTc: 0.05, delay: 1.8 };
    case 'won':
      return { fadeTc: 0.08, delay: 1.9 };
  }
}

/** The part of the BGM engine the director drives. */
export interface MusicPlayer {
  play(id: TrackId, opts: { delay: number }): void;
  stop(fadeTc: number): void;
}

export class MusicDirector {
  private player: MusicPlayer | null = null;
  private scene: MusicScene = { kind: 'title' };
  private enabled = true;
  /** The track currently sounding (or fading in), null when silent. */
  private current: TrackId | null = null;

  /** The track the current scene calls for. */
  wanted(): TrackId {
    return trackForScene(this.scene);
  }

  playing(): TrackId | null {
    return this.current;
  }

  /**
   * Audio became available (the first user gesture unlocked it). Until then the
   * director only remembers the scene; now it starts that scene's track.
   */
  attach(player: MusicPlayer): void {
    this.player = player;
    this.current = null;
    this.sync();
  }

  /** The game moved to another screen / stage. Same track → nothing happens (it keeps playing). */
  setScene(scene: MusicScene): void {
    this.scene = scene;
    this.sync();
  }

  /**
   * Music off (muted, or volume at zero) stops the sequencer instead of running
   * it silently; back on, the scene's track starts from its top.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.sync();
  }

  private sync(): void {
    const player = this.player;
    if (!player) return;
    if (!this.enabled) {
      if (this.current !== null) {
        player.stop(0.03);
        this.current = null;
      }
      return;
    }
    const want = this.wanted();
    if (want === this.current) return;
    const tr = transitionTo(this.scene, this.current);
    if (this.current !== null) player.stop(tr.fadeTc);
    player.play(want, { delay: tr.delay });
    this.current = want;
  }
}
