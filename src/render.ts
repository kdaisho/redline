/**
 * All drawing (spec §7). The theme is "Phosphor" (#11): an amber CRT terminal
 * in VT323 under scanlines and a vignette. Red text burns hot — it glows and is
 * double-struck — while blue sits cool and dim, so the two never rely on hue
 * alone. Deleted text collapses like a tube switching off; a strike makes the
 * rows lose horizontal sync.
 *
 * Layout (top → bottom): two HUD rows, a rule, the field grid with its
 * line-number gutter, a rule, the footer status line. The model gives logical
 * positions; this module owns the only mapping from grid coords (line, col) to
 * pixels, using BW/LH from state.
 *
 * Cost: the field redraws every frame and canvas shadows are expensive, so no
 * glyph is drawn with `shadowBlur` per frame. Glowing glyphs are rendered once
 * into per-style atlases (offscreen canvases) and blitted; the scanlines and the
 * vignette are one pre-rendered overlay. Only a handful of one-off shapes (the
 * caret, big titles, the limit gauge as a single path) use a live shadow.
 */
import {
  type FieldState,
  type Block,
  type Color,
  BW,
  LH,
  normalizeSelection,
} from './state.ts';
import { type Mode, type HelpSection, MODES, modeInfo } from './modes.ts';
import { type VimStatus, type Span, type FlashView } from './vim.ts';

/** Phosphor palette (spec §7). */
export const COLORS = {
  bg: '#060a07', // the tube, switched on but dark
  amber: '#ffb000', // chrome: readouts, caret, prompts
  dim: '#8a6200', // labels, line numbers, rules, unlit gauge dots
  red: '#ff5a3c', // delete — also glows and is double-struck
  blue: '#3fb4c0', // keep — dim cyan, never glows
  white: '#fff4e0', // white-hot phosphor: delete bloom, pulses, flash labels
} as const;
const C = COLORS;

// ── layout ───────────────────────────────────────────────────────────────
const PAD = 28; // side margin of the HUD, the rules and the footer
const HUD_Y1 = 36; // centre of HUD row 1 (readouts)
const HUD_Y2 = 74; // centre of HUD row 2 (limit gauge)
const RULE_TOP = 100; // rule under the HUD
const FIELD_OX = 50; // first text column — after the `>` marker and the line numbers
const FIELD_RIGHT = 10; // margin right of the last column
// First row's top. ≡ 1 (mod 3) so every text baseline lands on a multiple of 3:
// the overlay's scanlines (every 3 px) then fall in the gaps VT323 leaves between
// its own pixel rows instead of cutting through them.
const FIELD_OY = 115;
const FOOT_H = 66; // footer band: rule + status line

/** How many blocks fit on one line for a given canvas width — stage generation reads this. */
export function playfieldCols(canvasWidth: number): number {
  const usable = canvasWidth - FIELD_OX - FIELD_RIGHT;
  return Math.max(8, Math.floor(usable / BW));
}

/** How many lines fit vertically for a given canvas height — stage generation reads this. */
export function playfieldRows(canvasHeight: number): number {
  const usable = canvasHeight - FIELD_OY - FOOT_H - 8;
  return Math.max(3, Math.floor(usable / LH));
}

// ── type ─────────────────────────────────────────────────────────────────
// VT323 is a pixel face: every glyph advances 0.4 em and a pixel row is 0.08 em.
// Sizes are picked so a row is a whole (or half) pixel — 37.5 px → 3 px rows and
// an advance of exactly BW (15), so field glyphs fill their cell and stay crisp.
const FAMILY = '"VT323", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const ADV = 0.4; // advance / em
const F_FIELD = BW / ADV; // 37.5 — the board
const F_HUD = 31.25; // readouts, footer, prompts (2.5 px rows)
const F_SM = 25; // line numbers, hints, body copy (2 px rows)
const F_HELP = 22; // help screen — the widest Vim rows need ≤ 8.8 px per character
const F_TITLE = 100; // REDLINE / GAME OVER / YOU WIN
const F_BANNER = 75; // STAGE CLEARED
const F_COUNT = 250; // 3-2-1

// A cell is LH tall; glyphs sit on a baseline CELL_BASE below its top, and the
// solid blocks (cursor, inverse-video selection) cover the ink from CELL_TOP.
const CELL_TOP = 4;
const CELL_H = LH - 7;
const CELL_BASE = LH - 10;

/** Canvas shadowBlur ignores the transform; this is CSS px of blur per unit of the mock's glow. */
const GLOW = 0.6;

// effect timings (ms)
const DEL_MS = 420; // tube switch-off: bloom → squash to a scanline → shrink to a dot
const CLOSE_MS = 120; // then the row slides shut
const CARET_SOLID_MS = 500; // caret stays solid this long after input
const CARET_BLINK_MS = 380; // then blinks with this half-period
const COMBO_PULSE_MS = 260;
const DELTA_MS = 1100; // "+gain" beside the score
const STRIKE_JITTER_MS = 380; // rows out of sync + red tint
const STRIKE_BANNER_MS = 900; // inverse banner blinking in the footer
const CLEARED_BACKDROP_DELAY_MS = 700; // hold on the board before the text (KDA-48)
const GO_FLASH_MS = 420; // "GO" pop after the countdown (KDA-49)
const FONT_WAIT_MS = 4000; // give the web font this long before settling for the fallback

/** One cleared block, spawned by a delete at its pre-collapse position (KDA-42). */
export interface Flash {
  line: number;
  col: number;
  color: Color;
  ch: string;
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
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const pad2 = (n: number) => String(n).padStart(2, '0');
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Top-of-HUD model fed each frame (spec §1 HUD). */
export interface HudModel {
  score: number;
  timeMs: number;
  stage: number; // 1-based for display
  strikes: number;
  maxStrikes: number;
  muted: boolean; // audio mute state (KDA-46)
  soundText?: string; // volume readout when not muted, e.g. `♪ M6 S7` (#14); shown as `SND M6 S7`
  stageLimitMs: number; // per-stage time budget (KDA-59); 0 before a run starts
  stageRemainingMs: number; // time left on the current stage's countdown
}

export type Phase = 'start' | 'countdown' | 'playing' | 'cleared' | 'over' | 'won';

export interface Scene {
  field: FieldState;
  hud: HudModel;
  fx: Fx;
  phase: Phase;
  mode: Mode; // active control mode (#8) → HUD label, start-screen picker + key help
  vim: VimView | null; // Vim mode's statusline + Visual selection (#7); null in other modes
  helpOpen: boolean; // F1 help screen is up (covers everything but the HUD)
  overReason: 'strikes' | 'timeout'; // why the run ended → game-over subtitle (KDA-59)
  best: number; // best score ever (localStorage), shown on start/over screens
  isNewBest: boolean; // this run beat the stored best
  countdownNum: number; // 3→2→1, shown while phase === 'countdown' (KDA-49)
}

/** What Vim mode adds to the picture: the statusline and the Visual selection. */
export interface VimView extends VimStatus {
  spans: Span[];
}

function formatTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

/** mm:ss for the per-stage countdown — ceil so it reads 0:01 until truly spent. */
function formatCountdown(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/** Blend two #rrggbb theme tokens — drives the countdown gauge from calm to alarm. */
function lerpHex(a: string, b: string, t: number): string {
  const ai = parseInt(a.slice(1), 16);
  const bi = parseInt(b.slice(1), 16);
  const k = clamp01(t);
  const mix = (shift: number) => {
    const ca = (ai >> shift) & 0xff;
    const cb = (bi >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * k);
  };
  return `rgb(${mix(16)},${mix(8)},${mix(0)})`;
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${clamp01(alpha)})`;
}

// ── web font ─────────────────────────────────────────────────────────────
// Canvas text falls back silently while a web font is still loading, so nothing
// is drawn until VT323 is in (the tube just shows its scanlines). If it never
// arrives the system monospace takes over, scaled to keep the same 0.4 em grid.
type FontState = 'pending' | 'ready' | 'fallback';
const FONT_PROBE = `${F_FIELD}px "VT323"`;
let fontState: FontState = 'ready';
let fontScale = 1;

function setFontState(next: FontState): void {
  if (next === fontState) return;
  fontState = next;
  fontScale = next === 'fallback' ? ADV / 0.6 : 1;
  atlases.clear(); // glyphs were baked in the other face
}

function watchFont(): void {
  if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.load !== 'function') return;
  const fonts = document.fonts;
  const have = () => {
    try {
      return fonts.check(FONT_PROBE);
    } catch {
      return false;
    }
  };
  fontState = 'pending';
  fonts.load(FONT_PROBE).then(
    (faces) => setFontState(faces.length > 0 ? 'ready' : 'fallback'),
    () => setFontState('fallback'),
  );
  setTimeout(() => {
    if (fontState === 'pending') setFontState('fallback');
  }, FONT_WAIT_MS);
  // a slow network can still deliver it after we gave up
  fonts.addEventListener?.('loadingdone', () => {
    if (fontState !== 'ready' && have()) setFontState('ready');
  });
}

const fontCss = (px: number): string => `${+(px * fontScale).toFixed(2)}px ${FAMILY}`;
const adv = (px: number): number => px * ADV;
/** Baseline that centres capitals of size `px` on `cy` — whole pixels keep the rows crisp. */
const baseOf = (cy: number, px: number): number => Math.round(cy + px * 0.28);

// ── offscreen canvases ───────────────────────────────────────────────────
type Ctx = CanvasRenderingContext2D;
let dpr = 1;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; g: Ctx } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  return g ? { canvas, g } : null;
}

/** How one kind of glyph is painted — one atlas per style. */
interface Style {
  px: number;
  fill: string;
  glow: string | null; // shadow colour, or null for none
  blur: number; // in the mock's units (× GLOW × dpr device px)
  strike: boolean; // double-struck: drawn again a pixel to the right
  key: string;
}
const style = (px: number, fill: string, glow: string | null = null, blur = 0, strike = false): Style => ({
  px,
  fill,
  glow,
  blur: glow ? blur : 0,
  strike,
  key: `${px}|${fill}|${glow}|${blur}|${strike}`,
});

const S_RED = style(F_FIELD, C.red, C.red, 10, true); // the non-colour cue: glow + double-strike
const S_BLUE = style(F_FIELD, C.blue);
const S_INVERSE = style(F_FIELD, C.bg); // dark glyph on a lit cell
const S_BLOOM = style(F_FIELD, C.white, C.white, 18); // a deleted glyph, white-hot
const S_HUD = style(F_HUD, C.amber, C.amber, 7);
const S_HUD_DIM = style(F_HUD, C.dim, C.amber, 7);
const S_HUD_RED = style(F_HUD, C.red, C.amber, 7);
const S_HUD_WHITE = style(F_HUD, C.white, C.amber, 7);
const S_PROMPT = style(F_HUD, C.amber, C.amber, 10);

const ATLAS_COLS = 16;
const ATLAS_ROWS = 8;

/** A grid of pre-rendered glyphs in one style, each in a slot padded for its glow. */
interface Atlas {
  canvas: HTMLCanvasElement;
  g: Ctx;
  style: Style;
  slots: Map<string, number>;
  dw: number; // slot size, device px
  dh: number;
  w: number; // slot size, CSS px
  h: number;
  m: number; // glow margin around the cell, CSS px
  asc: number; // baseline below the cell top, CSS px
}
const atlases = new Map<string, Atlas | null>();

function getAtlas(s: Style): Atlas | null {
  const hit = atlases.get(s.key);
  if (hit !== undefined) return hit;
  const m = s.blur > 0 ? Math.ceil(s.blur * GLOW * 1.5) + 2 : 2;
  const asc = Math.round(s.px * 0.84);
  const dw = Math.ceil((Math.ceil(adv(s.px)) + m * 2) * dpr);
  const dh = Math.ceil((asc + Math.ceil(s.px * 0.26) + m * 2) * dpr);
  const made = makeCanvas(dw * ATLAS_COLS, dh * ATLAS_ROWS);
  const atlas: Atlas | null = made
    ? { canvas: made.canvas, g: made.g, style: s, slots: new Map(), dw, dh, w: dw / dpr, h: dh / dpr, m, asc }
    : null;
  atlases.set(s.key, atlas);
  if (atlas) for (let code = 33; code < 127; code++) slotOf(atlas, String.fromCharCode(code));
  return atlas;
}

/** The slot holding `ch`, painting it on first use; -1 when the atlas is full. */
function slotOf(a: Atlas, ch: string): number {
  const known = a.slots.get(ch);
  if (known !== undefined) return known;
  const slot = a.slots.size;
  if (slot >= ATLAS_COLS * ATLAS_ROWS) return -1;
  a.slots.set(ch, slot);
  const g = a.g;
  const s = a.style;
  const sx = (slot % ATLAS_COLS) * a.dw;
  const sy = Math.floor(slot / ATLAS_COLS) * a.dh;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.beginPath();
  g.rect(sx, sy, a.dw, a.dh);
  g.clip(); // a glow never bleeds into the neighbouring slot
  g.setTransform(dpr, 0, 0, dpr, sx, sy);
  paintGlyph(g, s, ch, a.m, a.m + a.asc);
  g.restore();
  return slot;
}

/** Paint one glyph in a style with live canvas state — atlas building and the no-atlas path. */
function paintGlyph(g: Ctx, s: Style, ch: string, x: number, baseline: number): void {
  const cx = x + adv(s.px) / 2;
  g.font = fontCss(s.px);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = s.fill;
  if (s.glow) {
    g.shadowColor = s.glow;
    g.shadowBlur = s.blur * GLOW * dpr;
  }
  g.fillText(ch, cx, baseline);
  g.shadowBlur = 0;
  if (s.strike) g.fillText(ch, cx + 1, baseline);
}

const snap = (v: number): number => Math.round(v * dpr) / dpr;

/**
 * Draw one glyph with its cell's left edge at `x`. `sy` squashes it vertically
 * about `pivot` (the tube switch-off).
 */
function blit(ctx: Ctx, a: Atlas | null, s: Style, ch: string, x: number, baseline: number, sy = 1, pivot = 0): void {
  const slot = a ? slotOf(a, ch) : -1;
  if (!a || slot < 0) {
    if (sy !== 1) {
      ctx.save();
      ctx.translate(0, pivot);
      ctx.scale(1, sy);
      ctx.translate(0, -pivot);
      paintGlyph(ctx, s, ch, x, baseline);
      ctx.restore();
    } else paintGlyph(ctx, s, ch, x, baseline);
    return;
  }
  const top = baseline - a.asc - a.m;
  ctx.drawImage(
    a.canvas,
    (slot % ATLAS_COLS) * a.dw,
    Math.floor(slot / ATLAS_COLS) * a.dh,
    a.dw,
    a.dh,
    snap(x) - a.m,
    sy === 1 ? top : pivot + (top - pivot) * sy,
    a.w,
    a.h * sy,
  );
}

type Align = 'left' | 'center' | 'right';
const charCount = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const alignX = (x: number, w: number, align: Align): number =>
  align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;

/** Glowing text from an atlas, one glyph per 0.4 em cell, centred vertically on `cy`. Returns its width. */
function gtext(ctx: Ctx, str: string, x: number, cy: number, s: Style, align: Align = 'left'): number {
  const step = adv(s.px);
  const w = charCount(str) * step;
  const a = getAtlas(s);
  const baseline = baseOf(cy, s.px);
  let cx = alignX(x, w, align);
  for (const ch of str) {
    if (ch !== ' ') blit(ctx, a, s, ch, cx, baseline);
    cx += step;
  }
  return w;
}

/** Plain text (optionally with a live glow — keep those to a few per frame). Returns its width. */
function text(
  ctx: Ctx,
  str: string,
  x: number,
  cy: number,
  color: string,
  px: number,
  align: Align = 'left',
  glow: string | null = null,
  blur = 0,
): number {
  ctx.font = fontCss(px);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = blur * GLOW * dpr;
  }
  ctx.fillText(str, x, baseOf(cy, px));
  ctx.shadowBlur = 0;
  return charCount(str) * adv(px);
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** A filled shape with a live glow: build the path in `trace`, one shadow for all of it. */
function glowFill(ctx: Ctx, color: string, glow: string, blur: number, trace: () => void): void {
  ctx.beginPath();
  trace();
  ctx.fillStyle = color;
  ctx.shadowColor = glow;
  ctx.shadowBlur = blur * GLOW * dpr;
  ctx.fill();
  ctx.shadowBlur = 0;
}

// ── CRT overlay: scanlines + vignette, rendered once ───────────────────────
let crt: { canvas: HTMLCanvasElement; w: number; h: number; dpr: number } | null = null;

function paintCrt(g: Ctx, w: number, h: number): void {
  g.fillStyle = 'rgba(0,0,0,0.3)';
  for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
  const gr = g.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.72);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(0,0,0,0.62)');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
}

function drawCrt(ctx: Ctx, w: number, h: number): void {
  if (!crt || crt.w !== w || crt.h !== h || crt.dpr !== dpr) {
    const made = makeCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
    if (!made) {
      paintCrt(ctx, w, h); // no offscreen canvas available: paint it live
      return;
    }
    made.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintCrt(made.g, w, h);
    crt = { canvas: made.canvas, w, h, dpr };
  }
  ctx.drawImage(crt.canvas, 0, 0, w, h);
}

// ── delete animation: the tube switch-off ──────────────────────────────────
// The model collapses a row the instant a delete lands. The picture holds the
// gap open while the removed run blooms, squashes and shrinks, then slides the
// rest of the row shut. That needs the row as it was, so the renderer keeps a
// one-frame-old copy of the board and its own list of running deletes.
interface Gap {
  line: number;
  from: number; // first removed column
  n: number; // removed cells
  row: Block[]; // the row this gap belongs to — gone or replaced → drop the hold
}
interface Burst {
  startMs: number;
  cells: Flash[];
  spans: { line: number; from: number; to: number; red: boolean }[]; // per row, [from, to)
  gaps: Gap[];
  hold: boolean; // rows kept their place → the gap can be held open
  lineCount: number;
}
let bursts: Burst[] = [];
let seenFlashes = new WeakSet<Flash>();
let prevField: FieldState | null = null;
let prevRows: Block[][] = [];

function trackDeletes(scene: Scene, nowMs: number): void {
  const field = scene.field;
  const lines = field.lines;
  if (field !== prevField || scene.phase === 'start' || scene.phase === 'countdown') bursts = [];

  let fresh: Flash[] | null = null;
  for (const f of scene.fx.flashes) {
    if (seenFlashes.has(f)) continue;
    seenFlashes.add(f);
    if (nowMs - f.startMs < DEL_MS) (fresh ??= []).push(f);
  }
  if (fresh) {
    // Same rows as last frame → find what each row lost; rows joined or removed
    // → positions shifted vertically, so just play the effect where it was.
    const hold = field === prevField && prevRows.length === lines.length;
    const gaps: Gap[] = [];
    if (hold) {
      for (let r = 0; r < lines.length; r++) {
        const was = prevRows[r];
        const is = lines[r];
        if (was.length <= is.length) continue;
        let k = 0;
        while (k < is.length && was[k].ch === is[k].ch && was[k].color === is[k].color) k++;
        gaps.push({ line: r, from: k, n: was.length - is.length, row: is });
      }
    }
    const byLine = new Map<number, { line: number; from: number; to: number; red: boolean }>();
    for (const f of fresh) {
      const s = byLine.get(f.line);
      if (!s) byLine.set(f.line, { line: f.line, from: f.col, to: f.col + 1, red: f.color === 'red' });
      else {
        s.from = Math.min(s.from, f.col);
        s.to = Math.max(s.to, f.col + 1);
        s.red ||= f.color === 'red';
      }
    }
    const touched = new Set<number>([...byLine.keys(), ...gaps.map((g) => g.line)]);
    bursts = hold ? bursts.filter((b) => !b.spans.some((s) => touched.has(s.line))) : [];
    bursts.push({ startMs: fresh[0].startMs, cells: fresh, spans: [...byLine.values()], gaps, hold, lineCount: lines.length });
  }

  bursts = bursts.filter(
    (b) =>
      nowMs - b.startMs < DEL_MS + CLOSE_MS &&
      b.lineCount === lines.length &&
      b.gaps.every((g) => lines[g.line] === g.row),
  );
}

function rememberBoard(field: FieldState): void {
  prevField = field;
  prevRows = field.lines.map((ln) => ln.slice());
}

/** Where things sit this frame: per-row sync jitter and held-open delete gaps. */
interface Layout {
  jitter: number[]; // px, per row
  gapFrom: number[]; // column where the row's gap opens (Infinity: none)
  gapShift: number[]; // cells the rest of the row is still pushed right
}

function layoutOf(scene: Scene, nowMs: number): Layout {
  const rows = scene.field.lines.length;
  const jitter = new Array<number>(rows).fill(0);
  const gapFrom = new Array<number>(rows).fill(Infinity);
  const gapShift = new Array<number>(rows).fill(0);

  // strike: the picture loses horizontal sync, settling over STRIKE_JITTER_MS
  const strikeAge = nowMs - scene.fx.strikeFlashMs;
  if (strikeAge >= 0 && strikeAge < STRIKE_JITTER_MS) {
    const step = Math.floor(strikeAge / 45);
    for (let r = 0; r < rows; r++) {
      const n = Math.sin(r * 12.99 + step * 78.2) * 43758.5;
      jitter[r] = (n - Math.floor(n) - 0.5) * 30 * (1 - strikeAge / STRIKE_JITTER_MS);
    }
  }

  for (const b of bursts) {
    const close = easeOut(clamp01((nowMs - b.startMs - DEL_MS) / CLOSE_MS));
    for (const g of b.gaps) {
      if (g.line >= rows) continue;
      gapFrom[g.line] = g.from;
      gapShift[g.line] = g.n * (1 - close);
    }
  }
  return { jitter, gapFrom, gapShift };
}

/** Left edge of cell (line, col). */
function cellX(lay: Layout, line: number, col: number): number {
  const shift = col >= (lay.gapFrom[line] ?? Infinity) ? lay.gapShift[line] : 0;
  return FIELD_OX + (col + shift) * BW + (lay.jitter[line] ?? 0);
}
/** The caret sits before `col`: at a gap it stays on the gap's left edge. */
function caretX(lay: Layout, line: number, col: number): number {
  const shift = col > (lay.gapFrom[line] ?? Infinity) ? lay.gapShift[line] : 0;
  return FIELD_OX + (col + shift) * BW + (lay.jitter[line] ?? 0);
}
const rowY = (line: number): number => FIELD_OY + line * LH;

function drawDeletes(ctx: Ctx, lay: Layout, nowMs: number): void {
  if (bursts.length === 0) return;
  const bloom = getAtlas(S_BLOOM);
  const red = getAtlas(S_RED);
  for (const b of bursts) {
    const age = nowMs - b.startMs;
    if (age < 0 || age >= DEL_MS) continue;
    const p = age / DEL_MS;
    const ox = (line: number, col: number) => FIELD_OX + col * BW + (lay.jitter[line] ?? 0);

    // Rows moved under the effect: clear its patch of the tube first.
    if (!b.hold) for (const s of b.spans) rect(ctx, ox(s.line, s.from), rowY(s.line), (s.to - s.from) * BW, LH, C.bg);

    const blueOn = Math.floor(age / 60) % 2 === 0; // a kept run flickers out in red
    for (const f of b.cells) {
      const x = ox(f.line, f.col);
      const y = rowY(f.line);
      if (f.color === 'blue') {
        if (blueOn) blit(ctx, red, S_RED, f.ch, x, y + CELL_BASE);
      } else if (p < 0.2) blit(ctx, bloom, S_BLOOM, f.ch, x, y + CELL_BASE);
      else if (p < 0.6) blit(ctx, bloom, S_BLOOM, f.ch, x, y + CELL_BASE, 1 - ((p - 0.2) / 0.4) * 0.93, y + LH / 2);
    }
    if (p >= 0.6) {
      // one bright scanline per row, shrinking to a dot
      const q = (p - 0.6) / 0.4;
      glowFill(ctx, C.white, C.white, 18, () => {
        for (const s of b.spans) {
          if (!s.red) continue;
          const w = (s.to - s.from) * BW;
          const lw = Math.max(4, w * (1 - easeOut(q)));
          ctx.rect(ox(s.line, s.from) + w / 2 - lw / 2, rowY(s.line) + LH / 2 - 1.5, lw, 3);
        }
      });
    }
  }
}

// ── score delta ("+128" beside the score) ──────────────────────────────────
let lastScore = 0;
let delta: { gain: number; startMs: number } | null = null;

function trackScore(scene: Scene, nowMs: number): void {
  const score = scene.hud.score;
  if (score > lastScore && scene.phase !== 'start') delta = { gain: score - lastScore, startMs: nowMs };
  else if (score < lastScore) delta = null;
  lastScore = score;
}

// ── entry point ────────────────────────────────────────────────────────────
let fontWatched = false;

export function render(ctx: Ctx, width: number, height: number, scene: Scene, nowMs: number): void {
  if (!fontWatched) {
    fontWatched = true;
    watchFont();
  }
  const scale = typeof ctx.getTransform === 'function' ? ctx.getTransform().a : 1;
  const nextDpr = scale > 0 && Number.isFinite(scale) ? scale : 1;
  if (nextDpr !== dpr) {
    dpr = nextDpr;
    atlases.clear();
  }

  rect(ctx, 0, 0, width, height, C.bg);
  if (fontState === 'pending') {
    drawCrt(ctx, width, height); // tube warming up: no text in a stand-in face
    return;
  }

  trackDeletes(scene, nowMs);
  trackScore(scene, nowMs);
  const lay = layoutOf(scene, nowMs);
  const phase = scene.phase;
  const strikeAge = nowMs - scene.fx.strikeFlashMs;

  drawHud(ctx, width, scene.hud, scene.fx, scene.mode, nowMs);
  rect(ctx, PAD, RULE_TOP, width - PAD * 2, 1, C.dim);
  rect(ctx, PAD, height - FOOT_H, width - PAD * 2, 1, C.dim);

  // The countdown keeps the board hidden; the menu and end screens replace it.
  const boardShown = phase === 'playing' || phase === 'cleared';
  if (boardShown) {
    drawField(ctx, scene, lay);
    if (scene.vim?.flash) drawFlash(ctx, scene.field, scene.vim.flash, lay, width, height);
    drawDeletes(ctx, lay, nowMs);
    if (scene.vim) drawBlockCursor(ctx, scene.field, scene.vim, lay);
    else drawCaret(ctx, scene.field, scene.fx, nowMs, lay);
  }
  drawFootline(ctx, width, height, scene, strikeAge);

  drawClearedFlash(ctx, width, height, scene.fx, nowMs);
  drawGoFlash(ctx, width, height, scene.fx, nowMs);

  if (phase === 'start') drawStartScreen(ctx, width, height, scene.best, scene.mode, nowMs);
  else if (phase === 'countdown') drawCountdown(ctx, width, height, scene.countdownNum);
  // Hold on the cleared board briefly before the text backdrop pops in (KDA-48).
  else if (phase === 'cleared' && nowMs - scene.fx.clearedFlashMs >= CLEARED_BACKDROP_DELAY_MS)
    drawStageCleared(ctx, width, height, scene, nowMs);
  else if (phase === 'over') drawEndScreen(ctx, width, height, scene, nowMs, false);
  else if (phase === 'won') drawEndScreen(ctx, width, height, scene, nowMs, true);

  if (scene.helpOpen) drawHelp(ctx, width, height, scene.mode);

  // strike: red tint while the rows are out of sync
  if (strikeAge >= 0 && strikeAge < STRIKE_JITTER_MS)
    rect(ctx, 0, 0, width, height, rgba(C.red, 0.2 * (1 - strikeAge / STRIKE_JITTER_MS)));
  drawCrt(ctx, width, height);

  rememberBoard(scene.field);
}

// ── HUD ──────────────────────────────────────────────────────────────────
/**
 * Two amber rows. Row 1: REDLINE, stage, score (+ the last gain), combo on the
 * left; mode, sound, strikes and the run clock on the right. Row 2: the stage
 * limit and its gauge of blocks, which empties and reddens as time runs out.
 */
function drawHud(ctx: Ctx, width: number, hud: HudModel, fx: Fx, mode: Mode, nowMs: number): void {
  const GAP = 28; // between readouts
  const KV = 10; // between a label and its value
  const y = HUD_Y1;

  let x = PAD;
  const kv = (label: string, value: string, s: Style = S_HUD) => {
    x += gtext(ctx, label, x, y, S_HUD_DIM) + KV;
    x += gtext(ctx, value, x, y, s) + GAP;
  };
  x += gtext(ctx, 'REDLINE', x, y, S_HUD) + GAP;
  kv('STAGE', pad2(hud.stage));
  kv('SCORE', String(hud.score).padStart(6, '0'));
  if (delta) {
    const p = (nowMs - delta.startMs) / DELTA_MS;
    if (p >= 0 && p < 1) {
      x -= GAP - KV;
      x += text(ctx, `+${delta.gain}`, x, y, rgba(C.white, 1 - p), F_HUD, 'left', C.amber, 7) + GAP;
    }
  }
  // COMBO (only while a combo is alive) — flashes white-hot right after a clean delete
  if (fx.comboLevel >= 1) {
    const pulsing = nowMs - fx.comboPulseMs < COMBO_PULSE_MS;
    kv('COMBO', `X${2 ** fx.comboLevel}`, pulsing ? S_HUD_WHITE : S_HUD);
  }

  // right group, laid out from the edge inwards
  let rx = width - PAD;
  rx -= gtext(ctx, `T+${formatTime(hud.timeMs)}`, rx, y, S_HUD, 'right') + GAP;
  for (let i = hud.maxStrikes - 1; i >= 0; i--) {
    const used = i < hud.strikes;
    rx -= gtext(ctx, used ? '[X]' : '[ ]', rx, y, used ? S_HUD_RED : S_HUD, 'right');
  }
  rx -= KV;
  rx -= gtext(ctx, 'STRIKES', rx, y, S_HUD_DIM, 'right') + GAP;
  rx -= gtext(ctx, hud.muted ? 'SND OFF' : hud.soundText ? `SND ${hud.soundText.replace(/^♪\s*/, '')}` : 'SND ON', rx, y, hud.muted ? S_HUD_DIM : S_HUD, 'right') + GAP;
  rx -= gtext(ctx, modeInfo(mode).label.toUpperCase(), rx, y, S_HUD, 'right') + KV;
  gtext(ctx, 'MODE', rx, y, S_HUD_DIM, 'right');

  // row 2: LIMIT m:ss + gauge (KDA-59). Before a run there is no budget: all dots.
  const y2 = HUD_Y2;
  const live = hud.stageLimitMs > 0;
  const ratio = live ? clamp01(hud.stageRemainingMs / hud.stageLimitMs) : 0;
  const gaugeColor = lerpHex(C.amber, C.red, 1 - ratio * 2); // calm → alarm over the last half
  let gx = PAD;
  gx += gtext(ctx, 'LIMIT', gx, y2, S_HUD_DIM) + KV;
  if (live) gx += text(ctx, formatCountdown(hud.stageRemainingMs), gx, y2, gaugeColor, F_HUD, 'left', C.amber, 7);
  else gx += gtext(ctx, '-:--', gx, y2, S_HUD_DIM);
  gx += 16;
  const STEP = 16;
  const count = Math.max(0, Math.floor((width - PAD - gx) / STEP));
  const on = Math.ceil(ratio * count);
  ctx.fillStyle = C.dim;
  for (let i = on; i < count; i++) ctx.fillRect(gx + i * STEP + 5, y2 - 1, 2, 2);
  if (on > 0)
    glowFill(ctx, gaugeColor, C.amber, 7, () => {
      for (let i = 0; i < on; i++) ctx.rect(gx + i * STEP, y2 - 9, 12, 18);
    });
}

// ── footer ───────────────────────────────────────────────────────────────
/**
 * The status line under the field. Standard: READY. or the size of the
 * selection. Vim: the mode (or the search prompt, a message, the flash text)
 * followed by the half-typed command. Right: the caret's line and column.
 * A strike takes the whole line over with a blinking inverse banner.
 */
function drawFootline(ctx: Ctx, width: number, height: number, scene: Scene, strikeAge: number): void {
  const phase = scene.phase;
  if (phase !== 'playing' && phase !== 'countdown' && phase !== 'cleared') return;
  const y = height - FOOT_H / 2 - 1;

  if (strikeAge >= 0 && strikeAge < STRIKE_BANNER_MS) {
    if (Math.floor(strikeAge / 150) % 2 === 0) {
      rect(ctx, PAD, y - 19, width - PAD * 2, 38, C.red);
      const msg = `!! STRIKE ${scene.hud.strikes}/${scene.hud.maxStrikes} -- BLUE IS KEEP !!`;
      text(ctx, msg, width / 2, y, C.bg, F_HUD, 'center');
      return;
    }
  }

  const field = scene.field;
  const vim = scene.vim;
  let x = PAD;
  if (vim) {
    if (vim.flash) x += gtext(ctx, `FLASH: ${vim.flash.pattern}_`, x, y, S_HUD_WHITE);
    else if (vim.prompt !== null) x += gtext(ctx, `${vim.prompt}_`, x, y, S_HUD);
    else if (vim.message) x += gtext(ctx, vim.message, x, y, S_HUD_RED);
    else {
      const label =
        vim.mode === 'normal'
          ? '-- NORMAL --'
          : vim.mode === 'visual'
            ? '-- VISUAL --'
            : vim.mode === 'visual-line'
              ? '-- VISUAL LINE --'
              : '-- VISUAL BLOCK --';
      x += gtext(ctx, label, x, y, S_HUD);
    }
    // pending keys (Vim's showcmd), right after the mode
    if (vim.pending) gtext(ctx, vim.pending, x + adv(F_HUD) * 2, y, S_HUD);
  } else if (field.select) {
    const { start, end } = normalizeSelection(field.select);
    let n = 0;
    for (let r = start.line; r <= end.line; r++) {
      const len = field.lines[r]?.length ?? 0;
      n += (r === end.line ? end.col : len) - (r === start.line ? start.col : 0);
    }
    gtext(ctx, `SELECT ${pad2(Math.max(0, n))}`, x, y, S_HUD);
  } else gtext(ctx, 'READY.', x, y, S_HUD);

  text(ctx, 'F1 HELP  ·  F2 MUTE', width / 2, y, C.dim, F_SM, 'center');
  if (field.lines.length > 0)
    gtext(ctx, `L${pad2(field.caret.line + 1)} C${pad2(field.caret.col + 1)}`, width - PAD, y, S_HUD_DIM, 'right');
}

// ── field ────────────────────────────────────────────────────────────────
type Ranges = [from: number, to: number][];

/** Selected cells per row — Standard's selection and Vim's Visual spans alike. */
function selectedRanges(scene: Scene): Map<number, Ranges> {
  const out = new Map<number, Ranges>();
  const add = (line: number, from: number, to: number) => {
    if (to <= from) return;
    const list = out.get(line);
    if (list) list.push([from, to]);
    else out.set(line, [[from, to]]);
  };
  const field = scene.field;
  if (field.select) {
    const { start, end } = normalizeSelection(field.select);
    for (let r = start.line; r <= end.line; r++) {
      const len = field.lines[r]?.length ?? 0;
      // a row the selection runs through also takes its line break: one cell past the end
      add(r, r === start.line ? start.col : 0, r === end.line ? end.col : len + 1);
    }
  }
  if (scene.vim) for (const s of scene.vim.spans) add(s.line, s.from, s.to);
  return out;
}

const inRanges = (ranges: Ranges | undefined, col: number): boolean => {
  if (!ranges) return false;
  for (const [from, to] of ranges) if (col >= from && col < to) return true;
  return false;
};

/**
 * The board: zero-padded line numbers, a `>` on the caret's row, then one glyph
 * per cell. Red glows and is double-struck, blue is bare. A selected cell is
 * true inverse video — a lit block in the cell's own colour, the glyph dark.
 */
function drawField(ctx: Ctx, scene: Scene, lay: Layout): void {
  const field = scene.field;
  const lines = field.lines;
  for (let r = 0; r < lines.length; r++) {
    const current = r === field.caret.line;
    const cy = rowY(r) + LH / 2;
    text(ctx, pad2(r + 1), FIELD_OX - 10, cy, current ? C.amber : C.dim, F_SM, 'right');
    if (current) text(ctx, '>', 6, cy, C.amber, F_SM);
  }

  const selected = selectedRanges(scene);
  const red = getAtlas(S_RED);
  const blue = getAtlas(S_BLUE);
  const inverse = getAtlas(S_INVERSE);
  for (let r = 0; r < lines.length; r++) {
    const ln = lines[r];
    const y = rowY(r);
    const base = y + CELL_BASE;
    const ranges = selected.get(r);
    for (let c = 0; c < ln.length; c++) {
      const b = ln[c];
      const sel = ranges !== undefined && inRanges(ranges, c);
      if (b.color === null && !sel) continue; // spaces draw nothing
      const x = cellX(lay, r, c);
      if (sel) {
        rect(ctx, snap(x), y + CELL_TOP, BW + 0.5, CELL_H, b.color === 'red' ? C.red : b.color === 'blue' ? C.blue : C.dim);
        if (b.color !== null) blit(ctx, inverse, S_INVERSE, b.ch, x, base);
      } else if (b.color === 'red') blit(ctx, red, S_RED, b.ch, x, base);
      else blit(ctx, blue, S_BLUE, b.ch, x, base);
    }
    // selected cells past the text: the line break, or a Visual block wider than the row
    if (ranges)
      for (const [from, to] of ranges) {
        const a = Math.max(from, ln.length);
        if (to > a) rect(ctx, snap(cellX(lay, r, a)), y + CELL_TOP, (to - a) * BW, CELL_H, C.dim);
      }
  }
}

/** Standard's caret: a glowing amber bar before the character. Solid after input, then it blinks. */
function drawCaret(ctx: Ctx, field: FieldState, fx: Fx, nowMs: number, lay: Layout): void {
  if (field.lines.length === 0) return;
  const idle = nowMs - fx.lastInputMs;
  const visible = idle < CARET_SOLID_MS || Math.floor((idle - CARET_SOLID_MS) / CARET_BLINK_MS) % 2 === 1;
  if (!visible) return;
  const { line, col } = field.caret;
  const x = snap(caretX(lay, line, col));
  glowFill(ctx, C.amber, C.amber, 10, () => ctx.rect(x - 1.5, rowY(line) + CELL_TOP, 3, CELL_H));
}

/**
 * Vim's cursor (#7): a glowing amber block ON the character at `caret.col`, the
 * character redrawn dark on top. While an operator waits for its motion (`d…`)
 * it shrinks to the lower half, as in Vim.
 */
function drawBlockCursor(ctx: Ctx, field: FieldState, vim: VimView, lay: Layout): void {
  if (field.lines.length === 0) return;
  const { line, col } = field.caret;
  // On a delete gap that is still held open the cursor stays at the gap's left
  // edge, over the collapsing run, rather than riding the text that will slide in.
  const onGap = lay.gapFrom[line] === col && lay.gapShift[line] > 0;
  const x = snap(caretX(lay, line, col));
  const y = rowY(line) + CELL_TOP;
  if (vim.operator) {
    glowFill(ctx, C.amber, C.amber, 12, () => ctx.rect(x, y + CELL_H / 2, BW, CELL_H / 2));
    return;
  }
  glowFill(ctx, C.amber, C.amber, 12, () => ctx.rect(x, y, BW, CELL_H));
  const b = field.lines[line]?.[col];
  if (!onGap && b && b.color !== null) blit(ctx, getAtlas(S_INVERSE), S_INVERSE, b.ch, x, rowY(line) + CELL_BASE);
}

/**
 * A flash jump in progress (#9): the board fades back, every match of the typed
 * text is lifted out again in its own colour over an amber underline, and the
 * label of each match sits on the cell right after it — where flash.nvim puts
 * it — as a white-hot inverse cell (neither red, blue nor amber).
 */
function drawFlash(ctx: Ctx, field: FieldState, flash: FlashView, lay: Layout, width: number, height: number): void {
  rect(ctx, 0, RULE_TOP + 1, width, height - FOOT_H - RULE_TOP - 1, rgba(C.bg, 0.66));

  const red = getAtlas(S_RED);
  const blue = getAtlas(S_BLUE);
  for (const m of flash.matches) {
    const y = rowY(m.line);
    rect(ctx, snap(cellX(lay, m.line, m.col)), y + CELL_TOP + CELL_H - 1, flash.len * BW, 2, C.amber);
    for (let c = m.col; c < m.col + flash.len; c++) {
      const b = field.lines[m.line]?.[c];
      if (!b || b.color === null) continue;
      if (b.color === 'red') blit(ctx, red, S_RED, b.ch, cellX(lay, m.line, c), y + CELL_BASE);
      else blit(ctx, blue, S_BLUE, b.ch, cellX(lay, m.line, c), y + CELL_BASE);
    }
  }
  if (flash.labels.length === 0) return;
  glowFill(ctx, C.white, C.white, 12, () => {
    for (const l of flash.labels) ctx.rect(snap(cellX(lay, l.line, l.col)), rowY(l.line) + CELL_TOP, BW, CELL_H);
  });
  const inverse = getAtlas(S_INVERSE);
  for (const l of flash.labels) blit(ctx, inverse, S_INVERSE, l.label, cellX(lay, l.line, l.col), rowY(l.line) + CELL_BASE);
}

// ── overlays ─────────────────────────────────────────────────────────────
/** Vertical centre of the band between the two rules — where the screens are composed. */
const midY = (height: number): number => (RULE_TOP + height - FOOT_H) / 2;

/** Blank the band between the rules (the menu and the end screens replace the board). */
function clearBand(ctx: Ctx, width: number, height: number, alpha = 1): void {
  rect(ctx, 0, RULE_TOP + 1, width, height - FOOT_H - RULE_TOP - 1, alpha >= 1 ? C.bg : rgba(C.bg, alpha));
}

/** `> PRESS ENTER _` — a shell prompt whose cursor blinks. */
function prompt(ctx: Ctx, str: string, cx: number, y: number, nowMs: number): void {
  const cursor = Math.floor(nowMs / 530) % 2 === 0 ? '_' : ' ';
  gtext(ctx, `> ${str} ${cursor}`, cx, y, S_PROMPT, 'center');
}

/** Centred stat row: dim label right of centre-left, amber value left of centre-right. */
function statRow(ctx: Ctx, cx: number, y: number, label: string, value: string, valueColor: string = C.amber): void {
  text(ctx, label, cx - 12, y, C.dim, F_SM, 'right');
  text(ctx, value, cx + 12, y, valueColor, F_SM, 'left');
}

/** Big centred 3-2-1 over the hidden board (KDA-49). */
function drawCountdown(ctx: Ctx, width: number, height: number, num: number): void {
  const cx = width / 2;
  const cy = midY(height);
  gtext(ctx, 'GET READY', cx, cy - 150, S_HUD_DIM, 'center');
  text(ctx, String(num), cx, cy + 10, C.amber, F_COUNT, 'center', C.amber, 22);
}

/** "GO" blooms white over the revealed board the instant the countdown ends, swelling as it fades. */
function drawGoFlash(ctx: Ctx, width: number, height: number, fx: Fx, nowMs: number): void {
  const p = (nowMs - fx.goFlashMs) / GO_FLASH_MS;
  if (!(p >= 0 && p < 1)) return;
  ctx.globalAlpha = 1 - p;
  text(ctx, 'GO', width / 2, midY(height), C.white, 150 + p * 60, 'center', C.amber, 22);
  ctx.globalAlpha = 1;
}

/** The whole tube brightens for a moment when a stage is cleared. */
function drawClearedFlash(ctx: Ctx, width: number, height: number, fx: Fx, nowMs: number): void {
  const p = (nowMs - fx.clearedFlashMs) / 420;
  if (!(p >= 0 && p < 1)) return;
  rect(ctx, 0, 0, width, height, rgba(C.amber, (1 - p) * 0.28));
}

/** Start screen: title, the rule, the mode picker, that mode's keys, its best score, the prompt. */
function drawStartScreen(ctx: Ctx, width: number, height: number, best: number, mode: Mode, nowMs: number): void {
  clearBand(ctx, width, height);
  const cx = width / 2;
  let y = midY(height) - 235;

  text(ctx, 'REDLINE', cx, y, C.amber, F_TITLE, 'center', C.amber, 22);
  y += 84;

  // the one rule of the game, written in the board's own red and blue
  const rule: [Style | null, string][] = [
    [S_RED, 'RED = DELETE'],
    [null, '   '],
    [S_BLUE, 'BLUE = KEEP'],
  ];
  let x = cx - (rule.reduce((n, [, s]) => n + s.length, 0) * BW) / 2;
  for (const [s, str] of rule) {
    if (s) gtext(ctx, str, x, y, s);
    x += str.length * BW;
  }
  y += 74;

  drawModePicker(ctx, cx, y, mode);
  y += 98;

  // Key help for the selected mode, then the rules common to every mode.
  const lines = [...modeInfo(mode).startHelp, 'clear every red to advance · two mistakes or the clock ends the run'];
  for (const line of lines) {
    text(ctx, line, cx, y, C.dim, F_SM, 'center');
    y += 38;
  }
  y += 10;
  if (best > 0) text(ctx, `${modeInfo(mode).label.toUpperCase()} BEST  ${thousands(best)}`, cx, y, C.dim, F_SM, 'center');
  y += 58;
  prompt(ctx, 'PRESS ENTER TO START', cx, y, nowMs);
  text(ctx, 'S FOR SOUNDTRACK', cx, y + 44, C.dim, F_SM, 'center');
}

/**
 * The mode picker row (#8): one entry per mode, labelled with the digit that
 * picks it. The selected mode is a lit inverse-video block; the others are dim,
 * and a mode that is listed but not playable yet is tagged.
 */
function drawModePicker(ctx: Ctx, cx: number, y: number, mode: Mode): void {
  const step = adv(F_HUD);
  const GAP = 16;
  const H = 38;
  const labels = MODES.map((m, i) => ` ${i + 1} ${m.label.toUpperCase()}${m.available ? '' : ' (SOON)'} `);
  const widths = labels.map((l) => charCount(l) * step);
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (MODES.length - 1);

  let x = Math.round(cx - total / 2);
  MODES.forEach((m, i) => {
    if (m.id === mode) {
      const bx = x;
      glowFill(ctx, C.amber, C.amber, 10, () => ctx.rect(bx, y - H / 2, widths[i], H));
      text(ctx, labels[i], x, y, C.bg, F_HUD);
    } else text(ctx, labels[i], x, y, C.dim, F_HUD);
    x += widths[i] + GAP;
  });
  text(ctx, 'MODE -- PRESS THE NUMBER, OR TAB, TO SWITCH', cx, y + 42, C.dim, F_SM, 'center');
}

/** Stage-clear celebration over the dimmed board: banner, running totals, advance prompt. */
function drawStageCleared(ctx: Ctx, width: number, height: number, scene: Scene, nowMs: number): void {
  clearBand(ctx, width, height, 0.86);
  const cx = width / 2;
  const cy = midY(height);

  // the banner snaps up to size for a little pop
  const grow = clamp01((nowMs - scene.fx.clearedFlashMs - CLEARED_BACKDROP_DELAY_MS) / 200);
  text(ctx, 'STAGE CLEARED', cx, cy - 110, C.white, F_BANNER * (0.8 + 0.2 * easeOut(grow)), 'center', C.amber, 22);
  text(ctx, `STAGE ${pad2(scene.hud.stage)} DONE`, cx, cy - 46, C.dim, F_SM, 'center');

  statRow(ctx, cx, cy + 4, 'SCORE', thousands(scene.hud.score));
  statRow(ctx, cx, cy + 38, 'TIME', formatTime(scene.hud.timeMs));
  prompt(ctx, 'PRESS ENTER FOR NEXT STAGE', cx, cy + 110, nowMs);
}

/** Game over / win: title, why, stage reached, final score, total time, best, restart. */
function drawEndScreen(ctx: Ctx, width: number, height: number, scene: Scene, nowMs: number, won: boolean): void {
  clearBand(ctx, width, height);
  const cx = width / 2;
  let y = midY(height) - 190;

  const color = won ? C.amber : C.red;
  text(ctx, won ? 'YOU WIN' : 'GAME OVER', cx, y, color, F_TITLE, 'center', color, 22);
  y += 78;
  const why = won ? 'STAGE 50 CLEARED' : scene.overReason === 'timeout' ? 'TIME UP' : 'TWO MISTAKES';
  text(ctx, why, cx, y, C.dim, F_SM, 'center');
  y += 52;

  const rows: [string, string, string][] = [
    ['STAGE', String(scene.hud.stage), C.amber],
    ['SCORE', thousands(scene.hud.score), C.amber],
    ['TIME', formatTime(scene.hud.timeMs), C.amber],
    [`${modeInfo(scene.mode).label.toUpperCase()} BEST`, thousands(scene.best), scene.isNewBest ? C.white : C.amber],
  ];
  for (const [label, value, col] of rows) {
    statRow(ctx, cx, y, label, value, col);
    y += 34;
  }
  if (scene.isNewBest) text(ctx, '** NEW BEST **', cx, y + 6, C.white, F_SM, 'center', C.amber, 10);
  y += 62;
  prompt(ctx, 'PRESS ENTER TO RESTART', cx, y, nowMs);
  text(ctx, 'ESC FOR MENU', cx, y + 44, C.dim, F_SM, 'center');
}

// Help screen geometry — `vim-lazyvim.test.ts` checks every key list against these numbers.
const HELP_TOP = RULE_TOP + 62; // first section title
// (the columns may run to 20 px above the canvas bottom)
const HELP_ROW_H = 21;
const HELP_TITLE_H = 26;
const HELP_GAP = 14; // between sections
const HELP_KEYS_W = 276; // width of the keys column inside a help column

/**
 * Help screen (F1): every key of the active mode, in two columns of titled
 * sections. Opaque below the HUD — while it is up the board is not readable.
 */
function drawHelp(ctx: Ctx, width: number, height: number, mode: Mode): void {
  rect(ctx, 0, RULE_TOP + 1, width, height - RULE_TOP - 1, C.bg);

  const info = modeInfo(mode);
  gtext(ctx, `${info.label.toUpperCase()} MODE -- KEYS`, PAD, RULE_TOP + 28, S_HUD);
  text(ctx, 'F1 / ESC / ENTER -- CLOSE', width - PAD, RULE_TOP + 28, C.dim, F_SM, 'right');

  const heightOf = (s: HelpSection) => HELP_TITLE_H + s.rows.length * HELP_ROW_H + HELP_GAP;

  // Fill the left column to about half the total height, then the right.
  const total = info.help.reduce((h, s) => h + heightOf(s), 0);
  const colW = (width - PAD * 2) / 2;
  let col = 0;
  let y = HELP_TOP;
  let used = 0;
  for (const section of info.help) {
    if (col === 0 && used > 0 && used + heightOf(section) / 2 > total / 2) {
      col = 1;
      y = HELP_TOP;
    }
    used += heightOf(section);
    const x = PAD + col * colW;

    text(ctx, section.title, x, y, C.amber, F_HELP);
    rect(ctx, x, Math.round(y + 11), colW - 32, 1, C.dim);
    y += HELP_TITLE_H;

    for (const [keys, what] of section.rows) {
      text(ctx, keys, x, y, C.amber, F_HELP);
      text(ctx, what, x + HELP_KEYS_W, y, C.dim, F_HELP);
      y += HELP_ROW_H;
    }
    y += HELP_GAP;
  }
}
