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
  type Color,
  BW,
  LH,
  normalizeSelection,
} from './state.ts';

/** Terminal palette (spec §7): pastel red/blue bars on a stark editor pane. */
export const COLORS = {
  bg: '#070a0e', // stark terminal backdrop, around the frame
  panel: '#0c1018', // the editor pane interior
  frame: '#3a485e', // hard frame stroke
  hudRule: '#1a2230', // thin separator under the HUD band
  hudDim: '#5d6b80', // HUD labels
  text: '#d4dceb', // HUD values / bright text
  gutter: '#46566e', // line-number column
  currentLine: 'rgba(255,255,255,0.04)', // caret-row highlight
  red: '#f5a0a0',
  redStroke: '#cf8181',
  blue: '#7fb8f0',
  blueStroke: '#5e8fc4',
  caret: '#b2bdcd',
  selection: 'rgba(150,178,255,0.32)', // translucent overlay on top of bars
  selectionEdge: '#aebfff', // crisp bright outline so bounds are obvious
  strikeOn: '#f5a0a0',
  strikeOff: '#2d3748',
  cleared: '#9be08a', // stage-clear celebration accent (green)
} as const;

// ── layout ───────────────────────────────────────────────────────────────
const FRAME_PAD = 24; // margin from canvas edge to editor frame
const HUD_H = 44; // HUD band height above the frame
const FIELD_PAD = 14; // inset from pane top to first block
const GUTTER_W = 42; // line-number column width
const GUTTER_GAP = 10; // gap between gutter and first block

/** How many blocks fit on one line for a given canvas width — stage generation reads this. */
export function playfieldCols(canvasWidth: number): number {
  const usable = canvasWidth - FRAME_PAD * 2 - GUTTER_W - GUTTER_GAP;
  return Math.max(8, Math.floor(usable / BW));
}

/** How many lines fit vertically for a given canvas height — stage generation reads this. */
export function playfieldRows(canvasHeight: number): number {
  const usable = canvasHeight - HUD_H - FRAME_PAD * 2 - FIELD_PAD;
  return Math.max(3, Math.floor(usable / LH));
}
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// effect timings (ms)
const FLASH_MS = 180; // cleared-block snap-out
const CARET_SOLID_MS = 500; // caret stays solid this long after input
const CARET_BLINK_MS = 260; // then blinks with this half-period
const COMBO_PULSE_MS = 260;
const STRIKE_FLASH_MS = 320;
const CLEARED_BACKDROP_DELAY_MS = 700; // hold on the board before the text (KDA-48)
const GO_FLASH_MS = 420; // "GO" pop after the countdown (KDA-49)

/** One cleared block snapping out, spawned by a delete (KDA-42). */
export interface Flash {
  line: number;
  col: number;
  color: Color;
  startMs: number;
}

/** Transient visual state, timed against the animation clock (not the frozen game clock). */
export interface Fx {
  flashes: Flash[];
  comboLevel: number; // 0 hides the combo readout; else shows ×2^level
  comboPulseMs: number; // when the combo last incremented
  strikeFlashMs: number; // when the last strike landed
  clearedFlashMs: number; // when the current stage was cleared
  lastInputMs: number; // when the caret last moved (drives blink)
  goFlashMs: number; // when the countdown ended → flash "GO" over the board
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Top-of-HUD model fed each frame (spec §1 HUD). */
export interface HudModel {
  score: number;
  timeMs: number;
  stage: number; // 1-based for display
  strikes: number;
  maxStrikes: number;
  muted: boolean; // audio mute state (KDA-46)
}

export type Phase = 'start' | 'countdown' | 'playing' | 'cleared' | 'over' | 'won';

export interface Scene {
  field: FieldState;
  hud: HudModel;
  fx: Fx;
  phase: Phase;
  best: number; // best score ever (localStorage), shown on start/over screens
  isNewBest: boolean; // this run beat the stored best
  countdownNum: number; // 3→2→1, shown while phase === 'countdown' (KDA-49)
}

interface FieldGeom {
  ox: number;
  oy: number;
}

interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function frameRect(width: number, height: number): FrameRect {
  const y = FRAME_PAD + HUD_H;
  return { x: FRAME_PAD, y, w: width - FRAME_PAD * 2, h: height - FRAME_PAD - y };
}

function fieldOrigin(): FieldGeom {
  return {
    ox: FRAME_PAD + GUTTER_W + GUTTER_GAP, // text starts after the line-number gutter
    oy: FRAME_PAD + HUD_H + FIELD_PAD,
  };
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
  nowMs: number,
): void {
  const frame = frameRect(width, height);
  const geom = fieldOrigin();

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  drawHud(ctx, width, scene.hud, scene.fx, nowMs);

  // editor pane: filled interior, current-line band, then the hard frame stroke
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);

  // The countdown keeps the board fully hidden — only the empty editor shows.
  const hidden = scene.phase === 'countdown';
  if (!hidden) {
    drawCurrentLine(ctx, scene.field, geom, frame);
    drawGutter(ctx, scene.field, geom, frame);
  }
  drawFrame(ctx, frame);

  if (!hidden) {
    drawBlocks(ctx, scene.field, geom);
    // selection drawn AFTER blocks so the highlight reads clearly over the bars
    if (scene.field.select) drawSelection(ctx, scene.field, scene.field.select, geom);
    drawFlashes(ctx, scene.fx, geom, nowMs);
    drawCaret(ctx, scene.field, scene.fx, nowMs, geom);
  }

  drawStrikeFlash(ctx, width, height, scene.fx, nowMs);
  drawClearedFlash(ctx, width, height, scene.fx, nowMs);
  drawGoFlash(ctx, width, height, scene.fx, nowMs);

  if (scene.phase === 'start') drawStartScreen(ctx, width, height, scene.best);
  else if (scene.phase === 'countdown') drawCountdown(ctx, width, height, scene.countdownNum);
  // Hold on the cleared board briefly before the text backdrop pops in (KDA-48).
  else if (scene.phase === 'cleared' && nowMs - scene.fx.clearedFlashMs >= CLEARED_BACKDROP_DELAY_MS)
    drawStageCleared(ctx, width, height, scene, nowMs);
  else if (scene.phase === 'over') drawGameOver(ctx, width, height, scene);
  else if (scene.phase === 'won') drawWinScreen(ctx, width, height, scene);
}

/** Big centered 3-2-1 over the hidden board (KDA-49). */
function drawCountdown(ctx: CanvasRenderingContext2D, width: number, height: number, num: number): void {
  const cx = width / 2;
  const cy = height / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `13px ${MONO}`;
  ctx.fillText('GET READY', cx, cy - 70);
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 120px ${MONO}`;
  ctx.fillText(String(num), cx, cy + 8);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/** "GO" flashes over the revealed board the instant the countdown ends. */
function drawGoFlash(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fx: Fx,
  nowMs: number,
): void {
  const p = (nowMs - fx.goFlashMs) / GO_FLASH_MS;
  if (p < 0 || p >= 1) return;
  ctx.save();
  ctx.globalAlpha = 1 - p;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.cleared;
  ctx.font = `bold ${72 + p * 36}px ${MONO}`; // swell out as it fades
  ctx.fillText('GO', width / 2, height / 2);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/** Gentle green full-frame flash when a stage is cleared. */
function drawClearedFlash(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fx: Fx,
  nowMs: number,
): void {
  const p = (nowMs - fx.clearedFlashMs) / 420;
  if (p < 0 || p >= 1) return;
  ctx.globalAlpha = (1 - p) * 0.3;
  ctx.fillStyle = COLORS.cleared;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;
}

/** Faint full-width band behind the caret's row — classic editor current-line. */
function drawCurrentLine(
  ctx: CanvasRenderingContext2D,
  field: FieldState,
  geom: FieldGeom,
  frame: FrameRect,
): void {
  if (field.lines.length === 0) return;
  const y = geom.oy + field.caret.line * LH;
  ctx.fillStyle = COLORS.currentLine;
  ctx.fillRect(frame.x + 1, y - 1, frame.w - 2, LH);
}

/** Right-aligned line numbers in a dim gutter — sells the code-editor look. */
function drawGutter(
  ctx: CanvasRenderingContext2D,
  field: FieldState,
  geom: FieldGeom,
  frame: FrameRect,
): void {
  const gutterRight = FRAME_PAD + GUTTER_W;
  // hairline divider between gutter and text
  ctx.strokeStyle = COLORS.hudRule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gutterRight + 0.5, frame.y + 1);
  ctx.lineTo(gutterRight + 0.5, frame.y + frame.h - 1);
  ctx.stroke();

  ctx.fillStyle = COLORS.gutter;
  ctx.font = `12px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r < field.lines.length; r++) {
    const y = geom.oy + r * LH + (LH - 6) / 2 + 2;
    ctx.fillText(String(r + 1), gutterRight - 6, y);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/** Cleared blocks expand and fade out with a bright core — the satisfying snap. */
function drawFlashes(ctx: CanvasRenderingContext2D, fx: Fx, geom: FieldGeom, nowMs: number): void {
  for (const f of fx.flashes) {
    const p = (nowMs - f.startMs) / FLASH_MS;
    if (p < 0 || p >= 1) continue;
    const bw = BW - 2;
    const bh = LH - 6;
    const cx = geom.ox + f.col * BW + 1 + bw / 2;
    const cy = geom.oy + f.line * LH + 2 + bh / 2;
    const scale = 1 + 0.8 * p;
    const w = bw * scale;
    const h = bh * scale;

    ctx.globalAlpha = 1 - p;
    ctx.fillStyle = f.color === 'red' ? COLORS.red : COLORS.blue;
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);

    ctx.globalAlpha = (1 - p) * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - w / 4, cy - h / 4, w / 2, h / 2);
  }
  ctx.globalAlpha = 1;
}

/** Red full-frame flash on a strike, decaying quickly. */
function drawStrikeFlash(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fx: Fx,
  nowMs: number,
): void {
  const p = (nowMs - fx.strikeFlashMs) / STRIKE_FLASH_MS;
  if (p < 0 || p >= 1) return;
  ctx.globalAlpha = (1 - p) * 0.45;
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;
}

/** Centered helper: draws one stat row "LABEL  value" and returns next y. */
function statRow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  label: string,
  value: string,
  valueColor: string,
): void {
  ctx.font = `13px ${MONO}`;
  ctx.fillStyle = COLORS.hudDim;
  ctx.textAlign = 'right';
  ctx.fillText(label, cx - 10, y);
  ctx.fillStyle = valueColor;
  ctx.font = `16px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(value, cx + 10, y);
}

/** Start screen: title, the rules, controls, and the best score so far. */
function drawStartScreen(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  best: number,
): void {
  ctx.fillStyle = 'rgba(7,10,14,0.86)';
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 56px ${MONO}`;
  ctx.fillText('REDLINE', cx, height / 2 - 96);

  ctx.font = `14px ${MONO}`;
  ctx.fillStyle = COLORS.red;
  ctx.fillText('RED = DELETE', cx - 70, height / 2 - 52);
  ctx.fillStyle = COLORS.blue;
  ctx.fillText('BLUE = KEEP', cx + 70, height / 2 - 52);

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `12px ${MONO}`;
  const lines = [
    'move  ← →   ·  word  ⌥← ⌥→   ·  line  ⌘← ⌘→   ·  ↑ ↓',
    'delete left  ⌫  ⌥⌫  ⌘⌫     ·     delete right  ⌦  ⌥⌦  ⌘⌦',
    'select  ⇧ + move    ·    move row  ⌥↑ ⌥↓    ·    mute  M',
    'clear every red to advance · two mistakes ends the run',
  ];
  lines.forEach((t, i) => ctx.fillText(t, cx, height / 2 - 8 + i * 22));

  if (best > 0) {
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `13px ${MONO}`;
    ctx.fillText(`BEST  ${best}`, cx, height / 2 + 66);
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 14px ${MONO}`;
  ctx.fillText('PRESS ENTER TO START', cx, height / 2 + 104);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/** Stage-clear celebration: cleared banner, running totals, advance prompt. */
function drawStageCleared(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: Scene,
  nowMs: number,
): void {
  ctx.fillStyle = 'rgba(7,12,10,0.82)';
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // title scales in for a little pop
  const grow = clamp01((nowMs - scene.fx.clearedFlashMs) / 260);
  const size = 30 + grow * 18;
  ctx.fillStyle = COLORS.cleared;
  ctx.font = `bold ${size}px ${MONO}`;
  ctx.fillText('✓ STAGE CLEARED', cx, height / 2 - 84);

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(`STAGE ${scene.hud.stage} DONE`, cx, height / 2 - 48);

  let y = height / 2 - 14;
  statRow(ctx, cx, y, 'SCORE', String(scene.hud.score), COLORS.text);
  y += 26;
  statRow(ctx, cx, y, 'TIME', formatTime(scene.hud.timeMs), COLORS.text);

  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 14px ${MONO}`;
  ctx.fillText('PRESS ENTER FOR NEXT STAGE', cx, height / 2 + 80);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/** Game-over screen: stage reached, final score, total time, best, restart. */
function drawGameOver(ctx: CanvasRenderingContext2D, width: number, height: number, scene: Scene): void {
  ctx.fillStyle = 'rgba(7,10,14,0.86)';
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.red;
  ctx.font = `bold 46px ${MONO}`;
  ctx.fillText('GAME OVER', cx, height / 2 - 92);

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `12px ${MONO}`;
  ctx.fillText('TWO MISTAKES', cx, height / 2 - 58);

  // stat rows, centered around cx
  let y = height / 2 - 22;
  statRow(ctx, cx, y, 'STAGE', String(scene.hud.stage), COLORS.text);
  y += 26;
  statRow(ctx, cx, y, 'SCORE', String(scene.hud.score), COLORS.text);
  y += 26;
  statRow(ctx, cx, y, 'TIME', formatTime(scene.hud.timeMs), COLORS.text);
  y += 26;
  statRow(ctx, cx, y, 'BEST', String(scene.best), scene.isNewBest ? COLORS.blue : COLORS.hudDim);

  ctx.textAlign = 'center';
  if (scene.isNewBest) {
    ctx.fillStyle = COLORS.blue;
    ctx.font = `bold 13px ${MONO}`;
    ctx.fillText('★ NEW BEST ★', cx, y + 24);
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 14px ${MONO}`;
  ctx.fillText('PRESS ENTER TO RESTART', cx, height / 2 + 104);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

function drawWinScreen(ctx: CanvasRenderingContext2D, width: number, height: number, scene: Scene): void {
  ctx.fillStyle = 'rgba(7,10,14,0.86)';
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.blue;
  ctx.font = `bold 46px ${MONO}`;
  ctx.fillText('YOU WIN', cx, height / 2 - 92);

  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `12px ${MONO}`;
  ctx.fillText('STAGE 50 CLEARED', cx, height / 2 - 58);

  let y = height / 2 - 22;
  statRow(ctx, cx, y, 'STAGE', String(scene.hud.stage), COLORS.text);
  y += 26;
  statRow(ctx, cx, y, 'SCORE', String(scene.hud.score), COLORS.text);
  y += 26;
  statRow(ctx, cx, y, 'TIME', formatTime(scene.hud.timeMs), COLORS.text);
  y += 26;
  statRow(ctx, cx, y, 'BEST', String(scene.best), scene.isNewBest ? COLORS.blue : COLORS.hudDim);

  ctx.textAlign = 'center';
  if (scene.isNewBest) {
    ctx.fillStyle = COLORS.blue;
    ctx.font = `bold 13px ${MONO}`;
    ctx.fillText('★ NEW BEST ★', cx, y + 24);
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 14px ${MONO}`;
  ctx.fillText('PRESS ENTER TO RESTART', cx, height / 2 + 104);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

// ── HUD ──────────────────────────────────────────────────────────────────
function drawHud(
  ctx: CanvasRenderingContext2D,
  width: number,
  hud: HudModel,
  fx: Fx,
  nowMs: number,
): void {
  const y = FRAME_PAD + 8;
  ctx.textBaseline = 'top';

  // thin separator rule along the bottom of the HUD band
  ctx.strokeStyle = COLORS.hudRule;
  ctx.lineWidth = 1;
  const ruleY = FRAME_PAD + HUD_H - 6;
  ctx.beginPath();
  ctx.moveTo(FRAME_PAD, ruleY + 0.5);
  ctx.lineTo(width - FRAME_PAD, ruleY + 0.5);
  ctx.stroke();

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

  // COMBO (only while a combo is alive) — pulses bigger right after a clean delete
  if (fx.comboLevel >= 1) {
    const cxp = FRAME_PAD + 250;
    ctx.fillStyle = COLORS.hudDim;
    ctx.font = `11px ${MONO}`;
    ctx.fillText('COMBO', cxp, y);
    const pulse = clamp01((nowMs - fx.comboPulseMs) / COMBO_PULSE_MS);
    const size = 18 + (1 - pulse) * 9; // swell on increment, settle to 18
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold ${size}px ${MONO}`;
    ctx.fillText(`×${2 ** fx.comboLevel}`, cxp, y + 14 - (size - 18) / 2);
  }

  // SOUND (mute indicator, KDA-46) — sits in the open space before STRIKES
  const sndX = FRAME_PAD + 360;
  ctx.fillStyle = COLORS.hudDim;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('SOUND', sndX, y);
  ctx.fillStyle = hud.muted ? COLORS.hudDim : COLORS.text;
  ctx.font = `18px ${MONO}`;
  ctx.fillText(hud.muted ? '✕ MUTED' : '♪ ON', sndX, y + 14);

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
function drawFrame(ctx: CanvasRenderingContext2D, frame: FrameRect): void {
  ctx.strokeStyle = COLORS.frame;
  ctx.lineWidth = 2;
  // +0.5 keeps the 2px stroke crisp on the pixel grid (no rounding ever)
  ctx.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1);
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

function drawCaret(
  ctx: CanvasRenderingContext2D,
  field: FieldState,
  fx: Fx,
  nowMs: number,
  geom: FieldGeom,
): void {
  // Solid right after input, then blink — feels responsive while moving.
  const t = nowMs - fx.lastInputMs;
  const visible = t < CARET_SOLID_MS || Math.floor((t - CARET_SOLID_MS) / CARET_BLINK_MS) % 2 === 0;
  if (!visible) return;

  const { line, col } = field.caret;
  const x = geom.ox + col * BW;
  const y = geom.oy + line * LH;
  // sharp grey bar, one line tall
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
  for (let r = start.line; r <= end.line; r++) {
    const len = field.lines[r]?.length ?? 0;
    const from = r === start.line ? start.col : 0;
    const to = r === end.line ? end.col : len;
    if (to <= from) continue;
    const x = geom.ox + from * BW;
    const y = geom.oy + r * LH;
    const w = (to - from) * BW;
    const h = LH - 2;
    // translucent overlay tints the bars, bright outline pins the bounds
    ctx.fillStyle = COLORS.selection;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.selectionEdge;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
  }
}
