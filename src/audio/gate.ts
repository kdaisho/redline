/**
 * Keeps fast, repeated sounds from stacking (#14). Held keys repeat every 45 ms
 * and the Halo movement sounds are 28–80 ms long, so the rule is simple: the
 * small "editor" sounds share one lane, and a sound in the lane may not start
 * before the previous one has had its length. A sound that arrives a little
 * early is nudged onto the next free slot (smoothing timer jitter); one that
 * arrives far too early is dropped. Everything else only has a short
 * same-sound retrigger guard, plus a ceiling on how many voices may be alive.
 *
 * Pure: times are in seconds on whatever clock the caller uses (the audio clock).
 */
import { type SfxId } from './sfx.ts';

/**
 * The shared lane: caret moves, selection, row moves, menu ticks and the Vim
 * key feedback. Value = seconds this sound holds the lane (about its length).
 */
export const LANE_HOLD: Partial<Record<SfxId, number>> = {
  moveChar: 0.035,
  moveWord: 0.04,
  moveLine: 0.038,
  moveLineEdge: 0.08,
  selExtend: 0.04,
  selClear: 0.08,
  rowMove: 0.11,
  menuMove: 0.04,
  vimPending: 0.06,
  vimInvalid: 0.09,
};

/** A lane sound up to this early is delayed to its slot rather than dropped. */
export const LANE_NUDGE = 0.02;
/** Any other sound: the same id may not retrigger faster than this. */
export const RETRIGGER_GAP = 0.03;
/** Lane sounds are dropped while this many voices are alive; everything is dropped at the hard cap. */
export const SOFT_VOICE_CAP = 32;
export const HARD_VOICE_CAP = 96;

export class SfxGate {
  private laneFreeAt = -Infinity;
  private lastStart = new Map<SfxId, number>();
  /** End times of the voices started so far (pruned as the clock passes them). */
  private alive: number[] = [];

  /** Voices still sounding at `now`. */
  activeVoices(now: number): number {
    if (this.alive.length > 0) this.alive = this.alive.filter((end) => end > now);
    return this.alive.length;
  }

  /**
   * May `id` play, wanted at time `at` (`now` = the clock right now)? Returns
   * the time to start it at, or null to drop it.
   */
  admit(id: SfxId, now: number, at: number = now): number | null {
    const voices = this.activeVoices(now);
    if (voices >= HARD_VOICE_CAP) return null;
    const hold = LANE_HOLD[id];
    if (hold !== undefined) {
      if (voices >= SOFT_VOICE_CAP) return null;
      let start = at;
      if (start < this.laneFreeAt) {
        if (this.laneFreeAt - start > LANE_NUDGE) return null;
        start = this.laneFreeAt;
      }
      this.laneFreeAt = start + hold;
      return start;
    }
    const last = this.lastStart.get(id);
    if (last !== undefined && at - last < RETRIGGER_GAP) return null;
    this.lastStart.set(id, at);
    return at;
  }

  /** Record what an admitted sound started, so the voice ceiling can count it. */
  started(voices: number, end: number): void {
    for (let i = 0; i < voices; i++) this.alive.push(end);
  }
}
