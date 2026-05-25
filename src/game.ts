import { render, type Scene } from './render.ts';
import {
  type FieldState,
  type MoveAction,
  type DeleteResult,
  moveCaret,
  deleteBackward,
  deleteWordLeft,
  deleteToLineStart,
  isMistake,
} from './state.ts';
import { attachInput, type DeleteAction } from './input.ts';
import { loadStage } from './stages.ts';

const MAX_STRIKES = 2; // spec §3

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
  private startTime = 0;
  private elapsedMs = 0;

  private field: FieldState;
  private score = 0;
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
    this.startTime = performance.now();
    const loop = (now: number) => {
      // Time freezes at game over — the final clock is the run's metric (spec §5).
      if (this.phase === 'playing') this.elapsedMs = now - this.startTime;
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

    // Scoring on clean (red-only) deletes lands in KDA-39.
    if (isMistake(result)) this.registerMistake();
  }

  /** A blue-touching delete = one strike; two strikes ends the run (spec §3). */
  private registerMistake(): void {
    this.strikes++;
    // A mistake resets the combo multiplier to ×1 — wired with scoring (KDA-39).
    if (this.strikes >= MAX_STRIKES) this.phase = 'over';
  }

  private update(): void {
    // Input application, scoring, strikes, and stage progression land here.
  }

  private scene(): Scene {
    return {
      field: this.field,
      gameOver: this.phase === 'over',
      hud: {
        score: this.score,
        timeMs: this.elapsedMs,
        stage: this.stageIndex + 1,
        strikes: this.strikes,
        maxStrikes: MAX_STRIKES,
      },
    };
  }
}
