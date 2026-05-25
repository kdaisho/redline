/**
 * All drawing (spec §7). REDLINE is deliberately sharp: hard rectangles, thin
 * high-contrast strokes, a monospace HUD, no shadows or rounding anywhere.
 *
 * Layout (top → bottom): HUD band, then a hard editor frame that holds the
 * field grid. The model gives logical positions; this module owns the only
 * mapping from grid coords (line, col) to pixels, using BW/LH from state.
 */
import {
  type FieldState,
  type Selection,
  BW,
  LH,
  normalizeSelection,
} from './state.ts';

/** Terminal palette — refined further in the visual theme pass (KDA-43). */
export const COLORS = {
  bg: '#0a0c10',
  frame: '#2a3340',
  hudDim: '#5b6b80',
  text: '#c8d2e0',
  red: '#f5a0a0',
  redStroke: '#c66',
  blue: '#7fb8f0',
  blueStroke: '#5a87bd',
  caret: '#9aa6b6',
  selection: 'rgba(154,166,182,0.22)',
  strikeOn: '#f5a0a0',
  strikeOff: '#34404f',
} as const;

// ── layout ───────────────────────────────────────────────────────────────
const FRAME_PAD = 24; // margin from canvas edge to editor frame
const HUD_H = 44; // HUD band height above the frame
const FIELD_PAD = 16; // inset from frame edge to first block
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Top-of-HUD model fed each frame (spec §1 HUD). */
export interface HudModel {
  score: number;
  timeMs: number;
  stage: number; // 1-based for display
  strikes: number;
  maxStrikes: number;
}

export interface Scene {
  field: FieldState;
  hud: HudModel;
}

interface FieldGeom {
  ox: number;
  oy: number;
}

function fieldOrigin(): FieldGeom {
  return { ox: FRAME_PAD + FIELD_PAD, oy: FRAME_PAD + HUD_H + FIELD_PAD };
}

function formatTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

// ── entry point ────────────────────────────────────────────────────────────
export function render(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: Scene,
): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  drawHud(ctx, width, scene.hud);
  drawFrame(ctx, width, height);

  const geom = fieldOrigin();
  if (scene.field.select) drawSelection(ctx, scene.field, scene.field.select, geom);
  drawBlocks(ctx, scene.field, geom);
  drawCaret(ctx, scene.field, geom);
}

// ── HUD ──────────────────────────────────────────────────────────────────
function drawHud(ctx: CanvasRenderingContext2D, width: number, hud: HudModel): void {
  const y = FRAME_PAD + 8;
  ctx.textBaseline = 'top';

  // labels in dim, values in bright — monospace throughout
  const label = (s: string) => {
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `11px ${MONO}`;
    return ctx.measureText(s).width;
  };
  const value = (s: string) => {
    ctx.fillStyle = COLORS.text;
    ctx.font = `18px ${MONO}`;
    return ctx.measureText(s).width;
  };

  // SCORE (left)
  let x = FRAME_PAD;
  label('SCORE');
  ctx.fillText('SCORE', x, y);
  value(String(hud.score));
  ctx.fillText(String(hud.score), x, y + 14);

  // STAGE (left of center)
  x = FRAME_PAD + 140;
  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('STAGE', x, y);
  ctx.fillStyle = COLORS.text;
  ctx.font = `18px ${MONO}`;
  ctx.fillText(String(hud.stage), x, y + 14);

  // TIME (right-aligned)
  const timeStr = formatTime(hud.timeMs);
  ctx.font = `18px ${MONO}`;
  const tw = ctx.measureText(timeStr).width;
  const tx = width - FRAME_PAD - tw;
  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('TIME', tx, y);
  ctx.fillStyle = COLORS.text;
  ctx.font = `18px ${MONO}`;
  ctx.fillText(timeStr, tx, y + 14);

  // STRIKES (left of TIME): filled ✕ for used, dim for remaining
  ctx.font = `18px ${MONO}`;
  const marks = '✕ '.repeat(hud.maxStrikes).trimEnd();
  const sw = ctx.measureText(marks).width;
  const sx = tx - 40 - sw;
  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('STRIKES', sx, y);
  ctx.font = `18px ${MONO}`;
  let cx = sx;
  for (let i = 0; i < hud.maxStrikes; i++) {
    ctx.fillStyle = i < hud.strikes ? COLORS.strikeOn : COLORS.strikeOff;
    ctx.fillText('✕', cx, y + 14);
    cx += ctx.measureText('✕ ').width;
  }
}

// ── editor frame ───────────────────────────────────────────────────────────
function drawFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const x = FRAME_PAD;
  const yTop = FRAME_PAD + HUD_H;
  const w = width - FRAME_PAD * 2;
  const h = height - FRAME_PAD - yTop;

  ctx.strokeStyle = COLORS.frame;
  ctx.lineWidth = 2;
  // +0.5 keeps the 2px stroke crisp on the pixel grid (no rounding ever)
  ctx.strokeRect(x + 0.5, yTop + 0.5, w - 1, h - 1);
}

// ── field ────────────────────────────────────────────────────────────────
function drawBlocks(ctx: CanvasRenderingContext2D, field: FieldState, geom: FieldGeom): void {
  for (let r = 0; r < field.lines.length; r++) {
    const ln = field.lines[r];
    for (let c = 0; c < ln.length; c++) {
      const color = ln[c].color;
      if (color === null) continue; // spaces draw nothing
      const x = geom.ox + c * BW;
      const y = geom.oy + r * LH;
      // hard mini-block with a 1px gutter; thin high-contrast stroke
      ctx.fillStyle = color === 'red' ? COLORS.red : COLORS.blue;
      ctx.fillRect(x + 1, y + 2, BW - 2, LH - 6);
      ctx.strokeStyle = color === 'red' ? COLORS.redStroke : COLORS.blueStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1.5, y + 2.5, BW - 3, LH - 7);
    }
  }
}

function drawCaret(ctx: CanvasRenderingContext2D, field: FieldState, geom: FieldGeom): void {
  const { line, col } = field.caret;
  const x = geom.ox + col * BW;
  const y = geom.oy + line * LH;
  // sharp grey bar, one line tall (blink lands in KDA-42)
  ctx.fillStyle = COLORS.caret;
  ctx.fillRect(x - 1, y, 2, LH - 2);
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  field: FieldState,
  sel: Selection,
  geom: FieldGeom,
): void {
  const { start, end } = normalizeSelection(sel);
  ctx.fillStyle = COLORS.selection;
  for (let r = start.line; r <= end.line; r++) {
    const len = field.lines[r]?.length ?? 0;
    const from = r === start.line ? start.col : 0;
    const to = r === end.line ? end.col : len;
    if (to <= from) continue;
    const x = geom.ox + from * BW;
    const y = geom.oy + r * LH;
    ctx.fillRect(x, y, (to - from) * BW, LH - 2);
  }
}
