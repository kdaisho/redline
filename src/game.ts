import { render, type Scene } from './render.ts';
import {
  type FieldState,
  type MoveAction,
  type DeleteResult,
  type Chord,
  moveCaret,
  deleteBackward,
  deleteWordLeft,
  deleteToLineStart,
  isMistake,
} from './state.ts';
import { attachInput, type DeleteAction } from './input.ts';
import { loadStage } from './stages.ts';

const MAX_STRIKES = 2; // spec §3

// ── Timer (spec §5) ─────────────────────────────────────────────────────────
/**
 * A monotonic count-up clock: no limit, no penalties, pure elapsed time. Driven
 * by injected timestamps (rAF / performance.now) so it's deterministic and
 * testable. Freezing captures the final time exactly at the game-over instant —
 * the run's speedrun metric (lower is better).
 */
export class Clock {
  private startMs = 0;
  private frozenMs: number | null = null;
  private running = false;

  start(now: number): void {
    this.startMs = now;
    this.frozenMs = null;
    this.running = true;
  }

  freeze(now: number): void {
    if (!this.running) return;
    this.frozenMs = now - this.startMs;
    this.running = false;
  }

  /** Elapsed ms: the frozen value once stopped, else live, else 0 before start. */
  elapsed(now: number): number {
    if (this.frozenMs !== null) return this.frozenMs;
    return this.running ? now - this.startMs : 0;
  }
}

// ── Scoring (spec §4) ───────────────────────────────────────────────────────
const BASE_PER_RED = 10;

/**
 * Big-chord multiplier: bigger deliberate deletes pay more per block. The spec
 * lists char/word/line; selection isn't specified, so we treat it like line
 * (×2) since it's an equally deliberate, large delete.
 */
export const CHORD_MULT: Record<Chord, number> = {
  char: 1,
  word: 1.5,
  line: 2,
  selection: 2,
};

const COMBO_TIMEOUT_MS = 1500; // a pause longer than this breaks the combo (§4)
const COMBO_MAX_LEVEL = 12; // cap the ×2^level growth

/** Multiplier for a clean delete at a given combo level: ×1, ×2, ×4, … */
export function comboMultiplier(level: number): number {
  return 2 ** level;
}

export interface ScoreState {
  score: number;
  comboLevel: number; // 0 → ×1, 1 → ×2, …; multiplier for the NEXT clean delete
  lastDeleteMs: number;
}

export function initialScore(): ScoreState {
  return { score: 0, comboLevel: 0, lastDeleteMs: 0 };
}

/**
 * Fold one delete into the score (spec §4). Blue scores nothing. A clean
 * red-only delete earns `red × 10 × chordMult × comboMult` and builds the
 * combo; a mistake (any blue) earns its reds at ×1 and resets the combo; a
 * pause beyond the timeout resets the combo before scoring. Pure.
 */
export function applyScore(s: ScoreState, result: DeleteResult, nowMs: number): ScoreState {
  // combo lapses after a long pause between deletes
  let level = nowMs - s.lastDeleteMs > COMBO_TIMEOUT_MS ? 0 : s.comboLevel;
  const chordMult = CHORD_MULT[result.chord];

  if (isMistake(result)) {
    // reds still count, but at ×1; the combo breaks
    const gained = result.red * BASE_PER_RED * chordMult;
    return { score: s.score + gained, comboLevel: 0, lastDeleteMs: nowMs };
  }

  if (result.red === 0) {
    // neutral delete (spaces only / line-join): no score, combo untouched
    return s;
  }

  const gained = result.red * BASE_PER_RED * chordMult * comboMultiplier(level);
  level = Math.min(level + 1, COMBO_MAX_LEVEL);
  return { score: s.score + gained, comboLevel: level, lastDeleteMs: nowMs };
}

/**
 * Owns the single requestAnimationFrame loop, the elapsed clock, and the
 * mutable run state (current field, score, stage, strikes). Input application
 * (KDA-35+), scoring (KDA-39), strikes (KDA-38), and progression (KDA-41) hook
 * into `update`; for now it just advances the clock and renders the board.
 */
export class Game {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width: number;
  private readonly height: number;

  private rafId = 0;
  private readonly clock = new Clock();
  private elapsedMs = 0; // cached each frame for scene + combo timing

  private field: FieldState;
  private scoreState = initialScore();
  private stageIndex = 0; // 0-based
  private strikes = 0;
  private goalCol = 0; // sticky column for vertical movement
  private phase: 'playing' | 'over' = 'playing';
  private detachInput: (() => void) | null = null;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.field = loadStage(this.stageIndex);
  }

  start(): void {
    this.detachInput = attachInput({
      move: (a) => this.onMove(a),
      delete: (a) => this.onDelete(a),
    });
    this.clock.start(performance.now());
    const loop = (now: number) => {
      // Clock freezes itself at game over — the final time is the metric (§5).
      this.elapsedMs = this.clock.elapsed(now);
      this.update();
      render(this.ctx, this.width, this.height, this.scene());
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.detachInput?.();
    this.detachInput = null;
  }

  private onMove(action: MoveAction): void {
    if (this.phase !== 'playing') return;
    const next = moveCaret(this.field, this.field.caret, this.goalCol, action);
    this.field.caret = next.caret;
    this.goalCol = next.goalCol;
    this.field.select = null; // plain movement collapses any selection
  }

  private onDelete(action: DeleteAction): void {
    if (this.phase !== 'playing') return;
    let result: DeleteResult;
    switch (action) {
      case 'backward':
        result = deleteBackward(this.field);
        break;
      case 'word-left':
        result = deleteWordLeft(this.field);
        break;
      case 'to-line-start':
        result = deleteToLineStart(this.field);
        break;
    }
    this.goalCol = this.field.caret.col;

    // Score the delete (combo reset on mistake/timeout handled inside).
    this.scoreState = applyScore(this.scoreState, result, this.elapsedMs);
    if (isMistake(result)) this.registerMistake();
  }

  /** A blue-touching delete = one strike; two strikes ends the run (spec §3). */
  private registerMistake(): void {
    this.strikes++;
    if (this.strikes >= MAX_STRIKES) {
      this.phase = 'over';
      this.clock.freeze(performance.now()); // capture the final time precisely
    }
  }

  private update(): void {
    // Input application, scoring, strikes, and stage progression land here.
  }

  private scene(): Scene {
    return {
      field: this.field,
      gameOver: this.phase === 'over',
      hud: {
        score: this.scoreState.score,
        timeMs: this.elapsedMs,
        stage: this.stageIndex + 1,
        strikes: this.strikes,
        maxStrikes: MAX_STRIKES,
      },
    };
  }
}
