/** Terminal palette — refined in the visual theme pass (KDA-43). */
export const COLORS = {
  bg: '#0a0c10',
  frame: '#2a3340',
  text: '#c8d2e0',
  red: '#f5a0a0',
  blue: '#7fb8f0',
  caret: '#9aa6b6',
} as const;

const FRAME_PAD = 24;

function formatTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.floor((ms % 1000) / 10);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * Draws the current frame. Right now: stark background, hard editor frame, and
 * a live clock proving the rAF loop ticks. HUD + field rendering arrive in
 * KDA-32 and onward.
 */
export function render(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  elapsedMs: number,
): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  // Hard rectangular editor frame — no rounding, thin high-contrast stroke.
  ctx.strokeStyle = COLORS.frame;
  ctx.lineWidth = 2;
  ctx.strokeRect(
    FRAME_PAD + 0.5,
    FRAME_PAD + 0.5,
    width - FRAME_PAD * 2 - 1,
    height - FRAME_PAD * 2 - 1,
  );

  ctx.fillStyle = COLORS.text;
  ctx.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('REDLINE', FRAME_PAD + 16, FRAME_PAD + 16);
  ctx.fillText(formatTime(elapsedMs), FRAME_PAD + 16, FRAME_PAD + 40);
}
