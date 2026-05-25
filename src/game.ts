import { render, type Scene } from './render.ts';
import { type FieldState, type MoveAction, moveCaret } from './state.ts';
import { attachInput } from './input.ts';
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
  private detachInput: (() => void) | null = null;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.field = loadStage(this.stageIndex);
  }

  start(): void {
    this.detachInput = attachInput({ move: (a) => this.onMove(a) });
    this.startTime = performance.now();
    const loop = (now: number) => {
      this.elapsedMs = now - this.startTime;
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
    const next = moveCaret(this.field, this.field.caret, this.goalCol, action);
    this.field.caret = next.caret;
    this.goalCol = next.goalCol;
    this.field.select = null; // plain movement collapses any selection
  }

  private update(): void {
    // Input application, scoring, strikes, and stage progression land here.
  }

  private scene(): Scene {
    return {
      field: this.field,
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
