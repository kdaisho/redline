import { render } from './render.ts';

/**
 * Owns the single requestAnimationFrame loop, the elapsed clock, and (later)
 * stages, scoring, and strikes. For now it just ticks and hands the elapsed
 * time to the renderer so we can confirm the loop is alive.
 */
export class Game {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width: number;
  private readonly height: number;

  private rafId = 0;
  private startTime = 0;
  private elapsedMs = 0;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
  }

  start(): void {
    this.startTime = performance.now();
    const loop = (now: number) => {
      this.elapsedMs = now - this.startTime;
      this.update();
      render(this.ctx, this.width, this.height, this.elapsedMs);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  private update(): void {
    // Stages, input application, scoring, and strikes land here in later issues.
  }
}
