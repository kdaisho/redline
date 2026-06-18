import { render, type Scene, type Flash } from './render.ts';
import {
  type FieldState,
  type MoveAction,
  type DeleteResult,
  type Chord,
  moveCaret,
  deleteBackward,
  deleteWordLeft,
  deleteToLineStart,
  deleteForward,
  deleteWordRight,
  deleteToLineEnd,
  moveRows,
  isMistake,
  redsRemaining,
  posEqual,
} from './state.ts';
import { attachInput, type DeleteAction } from './input.ts';
import { loadStage, stageBudgetMs, MAX_STAGE_INDEX } from './stages.ts';
import { initAudio, loadMuted, toggleMute, playRedPop, playBlueError, playFanfare } from './audio.ts';

const MAX_STRIKES = 2; // spec §3
const FLASH_LIFETIME_MS = 220; // prune snap-out flashes after they finish drawing

// Pre-stage 3-2-1 countdown (KDA-49): board hidden, clock/input gated until it ends.
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 650; // per number; total = FROM × STEP
const COUNTDOWN_MS = COUNTDOWN_FROM * COUNTDOWN_STEP_MS;

// Deterministic boards (KDA-59): a fixed seed makes stages 1–50 identical on
// every run for every player, so the per-stage time limit and leaderboard are
// fair. This intentionally reverts the per-run board variety from KDA-50 — the
// generator's stable stream lives at this seed.
const RUN_SEED = 0;

// ── best score persistence (spec §6) ────────────────────────────────────────
const BEST_KEY = 'redline.best';

export interface Best {
  score: number;
  stage: number;
  timeMs: number;
}

export function loadBest(): Best {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (raw) {
      const b = JSON.parse(raw) as Partial<Best>;
      if (typeof b.score === 'number') {
        return { score: b.score, stage: b.stage ?? 0, timeMs: b.timeMs ?? 0 };
      }
    }
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to default
  }
  return { score: 0, stage: 0, timeMs: 0 };
}

export function saveBest(b: Best): void {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    // ignore persistence failures
  }
}

// ── Timer (spec §5) ─────────────────────────────────────────────────────────
/**
 * A monotonic count-up clock: no limit, no penalties, pure elapsed time. Driven
 * by injected timestamps (rAF / performance.now) so it's deterministic and
 * testable. Freezing captures the final time exactly at the game-over instant —
 * the run's speedrun metric (lower is better).
 */
export class Clock {
  private accumMs = 0; // time banked from finished segments
  private segStart = 0; // start of the current running segment
  private running = false;
  private frozenMs: number | null = null;

  start(now: number): void {
    this.accumMs = 0;
    this.segStart = now;
    this.running = true;
    this.frozenMs = null;
  }

  /** Stopped at zero — for the pre-run countdown so the HUD reads 00:00 (not a stale frozen time). */
  reset(): void {
    this.accumMs = 0;
    this.running = false;
    this.frozenMs = null;
  }

  /** Pause between stages so the clock doesn't count while reading the screen. */
  pause(now: number): void {
    if (!this.running || this.frozenMs !== null) return;
    this.accumMs += now - this.segStart;
    this.running = false;
  }

  resume(now: number): void {
    if (this.running || this.frozenMs !== null) return;
    this.segStart = now;
    this.running = true;
  }

  freeze(now: number): void {
    if (this.frozenMs !== null) return;
    this.frozenMs = this.elapsed(now);
    this.running = false;
  }

  /** Elapsed ms: frozen value once stopped, else banked + live segment. */
  elapsed(now: number): number {
    if (this.frozenMs !== null) return this.frozenMs;
    return this.running ? this.accumMs + (now - this.segStart) : this.accumMs;
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
  private readonly clock = new Clock(); // total count-up time — the speedrun/score metric
  private elapsedMs = 0; // cached each frame for scene + combo timing

  // Per-stage countdown (KDA-59): a separate clock that resets each stage and
  // mirrors the main clock's pauses (countdown / cleared don't burn the budget).
  private readonly stageClock = new Clock();
  private stageLimitMs = 0; // time budget for the current stage, set on load
  private stageRemainingMs = 0; // cached each frame: max(0, limit − stage elapsed)

  private field: FieldState;
  private scoreState = initialScore();
  private stageIndex = 0; // 0-based
  private strikes = 0;
  private goalCol = 0; // sticky column for vertical movement
  private phase: 'start' | 'countdown' | 'playing' | 'cleared' | 'over' | 'won' = 'start';
  private overReason: 'strikes' | 'timeout' = 'strikes'; // why the run ended (game-over subtitle)
  private best: Best = { score: 0, stage: 0, timeMs: 0 };
  private isNewBest = false;
  private detachInput: (() => void) | null = null;
  private muted = false; // KDA-46: HUD reflection of the audio mute state

  // ── pre-stage countdown (KDA-49) ──
  private countdownStartMs = 0; // performance.now() when the countdown began
  private countdownFresh = false; // true → start the clock on finish; false → resume
  private goFlashMs = -Infinity; // when "GO" should flash over the revealed board

  // ── transient visual effects (KDA-42), timed on the animation clock ──
  private flashes: Flash[] = [];
  private lastInputMs = 0;
  private comboPulseMs = -Infinity;
  private strikeFlashMs = -Infinity;
  private clearedFlashMs = -Infinity;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.field = loadStage(this.stageIndex);
  }

  start(): void {
    this.detachInput = attachInput({
      move: (a) => this.onMove(a),
      select: (a) => this.onSelect(a),
      delete: (a) => this.onDelete(a),
      moveRow: (d) => this.onMoveRow(d),
      confirm: () => this.onConfirm(),
      mute: () => this.onMute(),
      isActive: () => this.phase === 'playing',
    });
    this.best = loadBest();
    this.muted = loadMuted();
    // The run waits on the start screen; the clock starts only on beginRun().
    const loop = (now: number) => {
      this.elapsedMs = this.clock.elapsed(now);
      this.update(now);
      render(this.ctx, this.width, this.height, this.scene(), now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Enter/Space: start a run, advance from a cleared stage, or restart from game over. */
  private onConfirm(): void {
    initAudio(); // unlock/resume the AudioContext on this user gesture (autoplay policy)
    if (this.phase === 'playing' || this.phase === 'countdown') return;
    if (this.phase === 'cleared') {
      this.advanceStage();
      return;
    }
    this.beginRun(); // from 'start' or 'over'
  }

  /** M: toggle mute and mirror it for the HUD. */
  private onMute(): void {
    this.muted = toggleMute();
  }

  /** Reset all run state to a fresh stage 1, then run the pre-stage countdown. */
  private beginRun(): void {
    this.stageIndex = 0;
    this.field = loadStage(0, RUN_SEED); // fixed seed → identical boards every run (KDA-59)
    this.stageLimitMs = stageBudgetMs(this.field.lines);
    this.stageClock.reset();
    this.scoreState = initialScore();
    this.strikes = 0;
    this.goalCol = 0;
    this.flashes = [];
    this.comboPulseMs = -Infinity;
    this.strikeFlashMs = -Infinity;
    this.clearedFlashMs = -Infinity;
    this.isNewBest = false;
    this.clock.reset(); // HUD reads 00:00 during the countdown, not last run's frozen time
    this.enterCountdown(true);
  }

  /**
   * Begin the 3-2-1 countdown for the current stage (KDA-49). The board is
   * hidden and the clock is left alone until `finishCountdown` — `fresh` decides
   * whether that's a clock start (new run) or resume (stage advance).
   */
  private enterCountdown(fresh: boolean): void {
    this.phase = 'countdown';
    this.countdownFresh = fresh;
    this.countdownStartMs = performance.now();
  }

  /** Countdown elapsed: reveal the board, flash "GO", and let the clock run. */
  private finishCountdown(): void {
    this.phase = 'playing';
    this.field.select = null; // a stage always begins with nothing selected
    const now = performance.now();
    this.lastInputMs = now;
    this.goFlashMs = now;
    if (this.countdownFresh) this.clock.start(now);
    else this.clock.resume(now);
    this.stageClock.start(now); // each stage's budget starts counting only now (KDA-59)
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.detachInput?.();
    this.detachInput = null;
  }

  private markInput(): void {
    this.lastInputMs = performance.now(); // keeps the caret solid while active
  }

  private onMove(action: MoveAction): void {
    if (this.phase !== 'playing') return;
    const next = moveCaret(this.field, this.field.caret, this.goalCol, action);
    this.field.caret = next.caret;
    this.goalCol = next.goalCol;
    this.field.select = null; // plain movement collapses any selection
    this.markInput();
  }

  private onSelect(action: MoveAction): void {
    if (this.phase !== 'playing') return;
    // Anchor stays put from the first extend; the head moves like a caret.
    const anchor = this.field.select ? this.field.select.anchor : { ...this.field.caret };
    const moved = moveCaret(this.field, this.field.caret, this.goalCol, action);
    this.field.caret = moved.caret;
    this.goalCol = moved.goalCol;
    const head = moved.caret;
    // Collapsing back onto the anchor clears the selection.
    this.field.select = posEqual(anchor, head) ? null : { anchor, head };
    this.markInput();
  }

  /** Alt+↑/↓: reorder rows. Pure layout — no blocks removed, so no score, mistake, or clear check. */
  private onMoveRow(dir: -1 | 1): void {
    if (this.phase !== 'playing') return;
    if (moveRows(this.field, dir)) {
      this.goalCol = this.field.caret.col;
      this.markInput();
    }
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
      case 'forward':
        result = deleteForward(this.field);
        break;
      case 'word-right':
        result = deleteWordRight(this.field);
        break;
      case 'to-line-end':
        result = deleteToLineEnd(this.field);
        break;
    }
    this.goalCol = this.field.caret.col;
    this.markInput();

    // Audio (KDA-46): a mistake (any blue) takes the negative cue; a clean red
    // delete pops; spaces-only deletes are silent.
    if (isMistake(result)) playBlueError();
    else if (result.red > 0) playRedPop();

    // Snap-out flash for each cleared block (at its pre-collapse position).
    const now = performance.now();
    for (const cell of result.cells) {
      this.flashes.push({ line: cell.line, col: cell.col, color: cell.color, startMs: now });
    }

    // Score the delete (combo reset on mistake/timeout handled inside).
    const prevLevel = this.scoreState.comboLevel;
    this.scoreState = applyScore(this.scoreState, result, this.elapsedMs);
    if (this.scoreState.comboLevel > prevLevel) this.comboPulseMs = now; // pulse on build
    if (isMistake(result)) this.registerMistake();

    // Game over wins over clearing (a delete can clear the last red AND be a
    // second-strike mistake at once).
    if (this.phase !== 'playing') return;
    if (redsRemaining(this.field) === 0) this.stageCleared();
  }

  /** Cleared every red → celebrate and wait for Enter; pause the clock meanwhile. */
  private stageCleared(): void {
    this.phase = 'cleared';
    const now = performance.now();
    this.clock.pause(now); // time stops while the celebration is up
    this.stageClock.pause(now); // the stage budget freezes too — no penalty for reading the screen
    this.clearedFlashMs = now; // also gates the backdrop delay in render (KDA-48)
    playFanfare(); // KDA-47: short cue at the moment of clear, before the text
  }

  /** Advance to the next (denser/taller) stage; score/strikes/time carry forward. */
  private advanceStage(): void {
    if (this.stageIndex >= MAX_STAGE_INDEX) {
      // Cleared the final stage — run ends in a win (spec §6).
      this.phase = 'won';
      const now = performance.now();
      this.clock.freeze(now);
      this.stageClock.freeze(now);
      this.finalizeRun();
      return;
    }
    this.stageIndex++;
    this.field = loadStage(this.stageIndex, RUN_SEED);
    this.stageLimitMs = stageBudgetMs(this.field.lines);
    // Reset the stage budget now (not at finishCountdown) so the LIMIT readout
    // and gauge show the fresh full budget during the countdown instead of the
    // previous stage's leftover time.
    this.stageClock.reset();
    this.goalCol = 0;
    this.flashes = [];
    this.clearedFlashMs = -Infinity;
    // Countdown gates the reveal; the clock resumes when it finishes.
    // Combo carries across the boundary; its window applies as usual.
    this.enterCountdown(false);
  }

  /** A blue-touching delete = one strike; two strikes ends the run (spec §3). */
  private registerMistake(): void {
    this.strikes++;
    this.strikeFlashMs = performance.now(); // red flash
    if (this.strikes >= MAX_STRIKES) this.endRun('strikes');
  }

  /** End the run in game over, freezing both clocks at the exact instant (KDA-59). */
  private endRun(reason: 'strikes' | 'timeout'): void {
    this.phase = 'over';
    this.overReason = reason;
    const now = performance.now();
    this.clock.freeze(now); // capture the final time precisely
    this.stageClock.freeze(now);
    this.finalizeRun();
  }

  /** On game over, record a new best score (higher wins) to localStorage. */
  private finalizeRun(): void {
    const final: Best = {
      score: this.scoreState.score,
      stage: this.stageIndex + 1,
      timeMs: this.clock.elapsed(performance.now()),
    };
    this.elapsedMs = final.timeMs;
    if (final.score > this.best.score) {
      this.best = final;
      this.isNewBest = true;
      saveBest(this.best);
    }
  }

  private update(now: number): void {
    // Drop finished snap-out flashes so the list can't grow unbounded.
    if (this.flashes.length > 0) {
      this.flashes = this.flashes.filter((f) => now - f.startMs < FLASH_LIFETIME_MS);
    }

    // Countdown over → reveal the board and let the clock run (KDA-49).
    if (this.phase === 'countdown' && now - this.countdownStartMs >= COUNTDOWN_MS) {
      this.finishCountdown();
    }

    // Per-stage countdown (KDA-59): frozen once the run ends, paused during
    // cleared/countdown. Hitting zero while playing ends the run like a strike.
    this.stageRemainingMs = Math.max(0, this.stageLimitMs - this.stageClock.elapsed(now));
    if (this.phase === 'playing' && this.stageRemainingMs <= 0) this.endRun('timeout');
  }

  private scene(): Scene {
    return {
      field: this.field,
      phase: this.phase,
      overReason: this.overReason,
      best: this.best.score,
      isNewBest: this.isNewBest,
      countdownNum: this.countdownDigit(),
      hud: {
        score: this.scoreState.score,
        timeMs: this.elapsedMs,
        stage: this.stageIndex + 1,
        strikes: this.strikes,
        maxStrikes: MAX_STRIKES,
        muted: this.muted,
        stageLimitMs: this.stageLimitMs,
        stageRemainingMs: this.stageRemainingMs,
      },
      fx: {
        flashes: this.flashes,
        comboLevel: this.scoreState.comboLevel,
        comboPulseMs: this.comboPulseMs,
        strikeFlashMs: this.strikeFlashMs,
        clearedFlashMs: this.clearedFlashMs,
        lastInputMs: this.lastInputMs,
        goFlashMs: this.goFlashMs,
      },
    };
  }

  /** Current countdown digit (3→2→1) for rendering; only meaningful in 'countdown'. */
  private countdownDigit(): number {
    const elapsed = performance.now() - this.countdownStartMs;
    const n = COUNTDOWN_FROM - Math.floor(elapsed / COUNTDOWN_STEP_MS);
    return n < 1 ? 1 : n > COUNTDOWN_FROM ? COUNTDOWN_FROM : n;
  }
}
