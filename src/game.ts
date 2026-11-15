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
import { attachInput, type DeleteAction, type Keymap } from './input.ts';
import { createStandardKeymap } from './keymaps/standard.ts';
import { createVimKeymap } from './keymaps/vim.ts';
import { Vim } from './vim.ts';
import { type Mode, MODES, loadMode, saveMode } from './modes.ts';
import { loadStage, stageBudgetMs, MAX_STAGE_INDEX } from './stages.ts';
import {
  installAudio,
  isMuted,
  toggleMute,
  adjustVolume,
  toggleBusMute,
  audioLabel,
  setMusicScene,
  sfx,
  playCues,
} from './audio.ts';
import {
  type VimSnapshot,
  moveCue,
  deleteCues,
  vimCue,
  secondsLeft,
  lowTimeTick,
} from './audio/cues.ts';

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
// One best per mode (#8). Standard keeps the original un-suffixed key, so the
// best recorded before modes existed carries over as Standard's.
const BEST_KEY = 'redline.best';
const bestKey = (mode: Mode): string => (mode === 'standard' ? BEST_KEY : `${BEST_KEY}.${mode}`);

export interface Best {
  score: number;
  stage: number;
  timeMs: number;
}

export function loadBest(mode: Mode): Best {
  try {
    const raw = localStorage.getItem(bestKey(mode));
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

export function saveBest(mode: Mode, b: Best): void {
  try {
    localStorage.setItem(bestKey(mode), JSON.stringify(b));
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

// ── SFX timing (#14): where several cues answer one event, they are staggered ──
const SFX_STRIKE_DELAY = 0.14; // the strike lands just after the mistake
const SFX_COMBO_BREAK_DELAY = 0.34; // …and the lost combo after the strike
const SFX_GAME_OVER_AFTER_STRIKE = 0.45; // game over follows the final strike
const SFX_GAME_OVER_AFTER_TIME_UP = 0.7; // …or the time-up sweep
const SFX_COMBO_UP_DELAY = 0.05; // the combo note rides just behind the delete
const SFX_STAGE_CLEAR_DELAY = 0.12; // the last delete is heard before the clear
const SFX_STAGE_START_AFTER_CONFIRM = 0.12; // menu confirm first, then the stage sweep
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
  private detachAudio: (() => void) | null = null;
  private muted = false; // KDA-46: HUD reflection of the audio mute state
  private soundText = ''; // HUD SOUND readout: the two volumes (#14)

  // ── SFX bookkeeping (#14) ──
  private comboAlive = false; // a combo is running and its break has not been sounded yet
  private countdownTicks = 0; // countdown digits already ticked this countdown
  private warnSeconds = Infinity; // last whole-second value the low-time warning looked at

  // ── control mode (#8): picked on the start screen, fixed for the run ──
  private mode: Mode = loadMode();
  private readonly keymaps: Record<Mode, Keymap>;
  private vim = new Vim(); // Vim mode's modal state (#7); fresh per run, reset per stage

  // ── help screen (F1): covers the board and stops the clocks while open ──
  private helpOpen = false;

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
    // Each mode is its own keymap over the same field actions.
    const standard = createStandardKeymap({
      move: (a) => this.onMove(a),
      select: (a) => this.onSelect(a),
      delete: (a) => this.onDelete(a),
      moveRow: (d) => this.onMoveRow(d),
    });
    const vim = createVimKeymap((key) => this.onVimKey(key));
    this.keymaps = { standard, vim };
  }

  start(): void {
    // Before the input: audio's capture listener unlocks the context on the first
    // key, so the same key's handler can already play.
    this.detachAudio = installAudio();
    this.detachInput = attachInput({
      keymap: () => this.keymaps[this.mode],
      confirm: () => this.onConfirm(),
      mute: () => this.onMute(),
      volume: (bus, delta) => {
        adjustVolume(bus, delta);
        this.soundText = audioLabel();
      },
      busMute: (bus) => {
        toggleBusMute(bus);
        this.soundText = audioLabel();
      },
      help: () => this.onHelp(),
      menu: () => this.onMenu(),
      pickMode: (i) => this.onPickMode(i),
      cycleMode: () => this.onCycleMode(),
      soundtrack: () => {
        // only from the title screen — never mid-run or on a result screen
        if (this.phase === 'start' && !this.helpOpen) window.location.assign('soundtrack.html');
      },
      isActive: () => this.phase === 'playing' && !this.helpOpen,
    });
    this.best = loadBest(this.mode);
    this.muted = isMuted();
    this.soundText = audioLabel();
    setMusicScene({ kind: 'title' }); // starts with the first key press (autoplay policy)
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
    if (this.helpOpen) {
      this.closeHelp();
      return;
    }
    if (this.phase === 'playing' || this.phase === 'countdown') return;
    if (this.phase === 'cleared') {
      this.advanceStage();
      return;
    }
    sfx('menuConfirm');
    this.beginRun(); // from 'start', 'over' or 'won'
  }

  /** M / F2: toggle mute and mirror it for the HUD. */
  private onMute(): void {
    this.muted = toggleMute(); // plays the mute cue on both edges
  }

  /**
   * F1: toggle the help screen — on the start screen, or mid-stage. Mid-stage it
   * is a pause: both clocks stop and the board is hidden behind the help, so it
   * cannot be used to study the field for free.
   */
  private onHelp(): void {
    if (this.helpOpen) {
      this.closeHelp();
      return;
    }
    if (this.phase !== 'start' && this.phase !== 'playing') return;
    this.helpOpen = true;
    sfx('menuMove');
    if (this.phase === 'playing') {
      const now = performance.now();
      this.clock.pause(now);
      this.stageClock.pause(now);
    }
  }

  private closeHelp(): void {
    if (!this.helpOpen) return;
    this.helpOpen = false;
    sfx('menuMove');
    if (this.phase === 'playing') {
      const now = performance.now();
      this.clock.resume(now);
      this.stageClock.resume(now);
      this.lastInputMs = now;
    }
  }

  /** 1, 2, … on the start screen: pick a mode by its picker position. */
  private onPickMode(index: number): void {
    const info = MODES[index];
    if (info) this.setMode(info.id);
  }

  /** Tab on the start screen: step to the next playable mode. */
  private onCycleMode(): void {
    const playable = MODES.filter((m) => m.available);
    const at = playable.findIndex((m) => m.id === this.mode);
    this.setMode(playable[(at + 1) % playable.length].id);
  }

  /** Switch mode (start screen only — a run is played in one mode) and remember it. */
  private setMode(mode: Mode): void {
    if (this.phase !== 'start' || this.helpOpen || mode === this.mode) return;
    if (!MODES.find((m) => m.id === mode)?.available) return;
    this.mode = mode;
    sfx('menuMove');
    saveMode(mode);
    this.best = loadBest(mode); // each mode has its own best
  }

  /** Escape on an end screen: back to the start screen, where the mode can be changed. */
  private onMenu(): void {
    if (this.helpOpen) {
      this.closeHelp(); // Esc also closes the help screen
      return;
    }
    if (this.phase !== 'over' && this.phase !== 'won') return;
    this.phase = 'start';
    sfx('menuMove');
    setMusicScene({ kind: 'title' });
    this.stageIndex = 0;
    this.field = loadStage(0, RUN_SEED);
    this.vim = new Vim();
    this.stageLimitMs = 0; // hides the LIMIT readout until a run starts
    this.stageClock.reset();
    this.clock.reset();
    this.scoreState = initialScore();
    this.strikes = 0;
    this.flashes = [];
    this.isNewBest = false;
  }

  /** Reset all run state to a fresh stage 1, then run the pre-stage countdown. */
  private beginRun(): void {
    this.stageIndex = 0;
    this.field = loadStage(0, RUN_SEED); // fixed seed → identical boards every run (KDA-59)
    this.vim = new Vim(); // no search / repeat memory carried over from the last run
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
    this.comboAlive = false;
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
    // The tier's track: unchanged within a tier (it plays on through countdown
    // and stage clear), a short fade to the next one at stages 11, 21, 31, 41.
    setMusicScene({ kind: 'stage', stageIndex: this.stageIndex });
    // A fresh run was started with a menu confirm, so the sweep waits a beat.
    sfx('stageStart', undefined, fresh ? SFX_STAGE_START_AFTER_CONFIRM : 0);
    sfx('countdownTick'); // "3" — the later digits tick from update()
    this.countdownTicks = 1;
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
    this.warnSeconds = secondsLeft(this.stageLimitMs);
    sfx('countdownGo');
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.detachInput?.();
    this.detachInput = null;
    this.detachAudio?.();
    this.detachAudio = null;
  }

  /** Total characters and rows on the field — measured around a delete to size its sound. */
  private fieldSize(): { chars: number; rows: number } {
    let chars = 0;
    for (const ln of this.field.lines) chars += ln.length;
    return { chars, rows: this.field.lines.length };
  }

  private markInput(): void {
    this.lastInputMs = performance.now(); // keeps the caret solid while active
  }

  private onMove(action: MoveAction): void {
    if (this.phase !== 'playing') return;
    const next = moveCaret(this.field, this.field.caret, this.goalCol, action);
    const moved = !posEqual(next.caret, this.field.caret);
    const hadSelection = this.field.select !== null;
    this.field.caret = next.caret;
    this.goalCol = next.goalCol;
    this.field.select = null; // plain movement collapses any selection
    this.markInput();
    // A move that drops a selection sounds as the clear; one that hits a wall is silent.
    if (hadSelection) sfx('selClear');
    else if (moved) playCues([moveCue(action)]);
  }

  private onSelect(action: MoveAction): void {
    if (this.phase !== 'playing') return;
    // Anchor stays put from the first extend; the head moves like a caret.
    const anchor = this.field.select ? this.field.select.anchor : { ...this.field.caret };
    const moved = moveCaret(this.field, this.field.caret, this.goalCol, action);
    const changed = !posEqual(moved.caret, this.field.caret);
    const hadSelection = this.field.select !== null;
    this.field.caret = moved.caret;
    this.goalCol = moved.goalCol;
    const head = moved.caret;
    // Collapsing back onto the anchor clears the selection.
    this.field.select = posEqual(anchor, head) ? null : { anchor, head };
    this.markInput();
    if (this.field.select === null) {
      if (hadSelection) sfx('selClear');
    } else if (changed) sfx('selExtend');
  }

  /** Alt+↑/↓: reorder rows. Pure layout — no blocks removed, so no score, mistake, or clear check. */
  private onMoveRow(dir: -1 | 1): void {
    if (this.phase !== 'playing') return;
    if (moveRows(this.field, dir)) {
      this.goalCol = this.field.caret.col;
      this.markInput();
      sfx('rowMove');
    }
  }

  /** The Vim engine's visible state, for telling what a key did (`vimCue`). */
  private vimSnapshot(): VimSnapshot {
    const st = this.vim.status();
    return {
      mode: st.mode,
      pending: st.pending,
      prompt: st.prompt,
      flash: st.flash ? st.flash.pattern : null,
      message: st.message,
      caret: { ...this.field.caret },
    };
  }

  /**
   * Vim mode: hand one key to the engine. A key that completes a delete command
   * goes through the same `applyDelete` as a Standard delete. Returns whether the
   * key may auto-repeat while held (plain motions only).
   */
  private onVimKey(key: string): boolean {
    if (this.phase !== 'playing') return false;
    const size = this.fieldSize();
    const before = this.vimSnapshot();
    const outcome = this.vim.key(this.field, key);
    this.markInput();
    if (outcome.deleted) {
      this.applyDelete(outcome.deleted, size);
    } else {
      // Mode change, half-typed command, move, or a key that did nothing — the
      // engine stays pure; the sound is read off its state before and after.
      const cue = vimCue(before, this.vimSnapshot(), key);
      if (cue) playCues([cue]);
    }
    return outcome.repeatable;
  }

  private onDelete(action: DeleteAction): void {
    if (this.phase !== 'playing') return;
    const size = this.fieldSize();
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
    this.applyDelete(result, size);
  }

  /**
   * Fold one delete into the run — feedback, score, strikes, clear check. Shared
   * by every mode: however the keys were pressed, one delete command is one
   * action for scoring and mistakes. `before` is the field's size before the
   * delete ran (the result only lists the coloured blocks it removed).
   */
  private applyDelete(result: DeleteResult, before: { chars: number; rows: number }): void {
    this.goalCol = this.field.caret.col;
    this.markInput();

    // Snap-out flash for each cleared block (at its pre-collapse position).
    const now = performance.now();
    for (const cell of result.cells) {
      this.flashes.push({ line: cell.line, col: cell.col, color: cell.color, ch: cell.ch, startMs: now });
    }

    // Score the delete (combo reset on mistake/timeout handled inside).
    const prevScore = this.scoreState;
    const prevLevel = prevScore.comboLevel;
    const comboWasAlive = prevLevel > 0 && this.comboAlive;
    this.scoreState = applyScore(prevScore, result, this.elapsedMs);
    if (this.scoreState.comboLevel > prevLevel) this.comboPulseMs = now; // pulse on build
    // (a neutral delete leaves the score state — and a combo already heard breaking — alone)
    if (this.scoreState !== prevScore) this.comboAlive = this.scoreState.comboLevel > 0;

    if (isMistake(result)) {
      // Audio (#14): a mistake (any blue) takes the negative cue instead of the
      // delete's own sound, then the strike it costs. A second strike goes on to
      // game over (endRun); otherwise a running combo is heard breaking.
      sfx('mistake');
      sfx('strike', undefined, SFX_STRIKE_DELAY);
      this.registerMistake();
      if (this.phase === 'playing' && comboWasAlive) sfx('comboBreak', undefined, SFX_COMBO_BREAK_DELAY);
    } else {
      // The delete's own sound, by chord and size (several rows → the big chord).
      const after = this.fieldSize();
      playCues(
        deleteCues({
          chord: result.chord,
          removed: before.chars - after.chars,
          rowsRemoved: before.rows - after.rows,
          rowsTouched: new Set(result.cells.map((c) => c.line)).size,
        }),
      );
    }

    // Game over wins over clearing (a delete can clear the last red AND be a
    // second-strike mistake at once).
    if (this.phase !== 'playing') return;
    if (redsRemaining(this.field) === 0) {
      this.stageCleared();
    } else if (!isMistake(result) && result.red > 0) {
      // A clean red delete steps the combo up; the note climbs with the level.
      sfx('comboUp', { level: this.scoreState.comboLevel }, SFX_COMBO_UP_DELAY);
    }
  }

  /** Cleared every red → celebrate and wait for Enter; pause the clock meanwhile. */
  private stageCleared(): void {
    this.phase = 'cleared';
    const now = performance.now();
    this.clock.pause(now); // time stops while the celebration is up
    this.stageClock.pause(now); // the stage budget freezes too — no penalty for reading the screen
    this.clearedFlashMs = now; // also gates the backdrop delay in render (KDA-48)
    sfx('stageClear', undefined, SFX_STAGE_CLEAR_DELAY); // at the moment of clear, before the text (KDA-47)
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
      sfx('runWin');
      setMusicScene({ kind: 'won' }); // the win theme comes in after the cue
      return;
    }
    this.stageIndex++;
    this.field = loadStage(this.stageIndex, RUN_SEED);
    this.vim.reset(); // Normal mode, nothing pending; `.` / search memory carries across stages
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
    if (reason === 'timeout') {
      sfx('timeUp');
      sfx('gameOver', undefined, SFX_GAME_OVER_AFTER_TIME_UP);
    } else {
      sfx('gameOver', undefined, SFX_GAME_OVER_AFTER_STRIKE); // after the mistake + strike cues
    }
    setMusicScene({ kind: 'over' }); // the game-over theme comes in after the cue
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
      saveBest(this.mode, this.best);
    }
  }

  private update(now: number): void {
    // Drop finished snap-out flashes so the list can't grow unbounded.
    if (this.flashes.length > 0) {
      this.flashes = this.flashes.filter((f) => now - f.startMs < FLASH_LIFETIME_MS);
    }

    // Countdown over → reveal the board and let the clock run (KDA-49).
    if (this.phase === 'countdown') {
      if (now - this.countdownStartMs >= COUNTDOWN_MS) {
        this.finishCountdown();
      } else {
        // one tick per digit as it appears ("3" ticked when the countdown began)
        const shown = Math.floor((now - this.countdownStartMs) / COUNTDOWN_STEP_MS) + 1;
        if (shown > this.countdownTicks) {
          this.countdownTicks = shown;
          sfx('countdownTick');
        }
      }
    }

    // Per-stage countdown (KDA-59): frozen once the run ends, paused during
    // cleared/countdown. Hitting zero while playing ends the run like a strike.
    this.stageRemainingMs = Math.max(0, this.stageLimitMs - this.stageClock.elapsed(now));
    if (this.phase === 'playing' && this.stageRemainingMs <= 0) this.endRun('timeout');

    if (this.phase === 'playing' && !this.helpOpen) {
      // Low time (#14): one warning per second over the stage's last five seconds.
      const left = secondsLeft(this.stageRemainingMs);
      if (lowTimeTick(this.warnSeconds, left)) sfx('timeWarning');
      this.warnSeconds = left;

      // A combo that lapses is heard when it lapses, not at the next delete.
      if (
        this.comboAlive &&
        this.scoreState.comboLevel > 0 &&
        this.elapsedMs - this.scoreState.lastDeleteMs > COMBO_TIMEOUT_MS
      ) {
        this.comboAlive = false;
        sfx('comboBreak');
      }
    }
  }

  private scene(): Scene {
    return {
      field: this.field,
      phase: this.phase,
      mode: this.mode,
      vim:
        this.mode === 'vim' ? { ...this.vim.status(), spans: this.vim.selection(this.field) } : null,
      helpOpen: this.helpOpen,
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
        soundText: this.soundText,
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
