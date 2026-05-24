/**
 * REDLINE field model — the single source of truth for the board (spec §1).
 *
 * The field is a grid of fixed-size blocks. Each line is a row of blocks; a
 * block is red, blue, or a space (null). A "word" (bar) is a maximal run of
 * same-color blocks. The caret sits *before* `block[col]`, so a line of N
 * blocks has N+1 caret columns (0..N).
 *
 * This module is pure data + pure queries. Caret movement (KDA-35),
 * selection (KDA-36), and deletion (KDA-37) build their actions on these
 * primitives; nothing here mutates state in place.
 */

// ── Grid geometry ──────────────────────────────────────────────────────────
// Fixed block width and line height (px). Render and input hit-testing read
// these so the model and the picture agree on one grid.
export const BW = 18;
export const LH = 26;

// Word width bounds from the spec (§1). Board authoring should stay in range;
// not hard-enforced so stages keep their freedom.
export const MIN_WORD = 4;
export const MAX_WORD = 20;

// ── Types ──────────────────────────────────────────────────────────────────
export type Color = 'red' | 'blue';

/** A single grid cell. `null` color = space (caret can rest, nothing to delete). */
export interface Block {
  color: Color | null;
}

export type Line = Block[];

/** Caret/selection coordinate. `col` ranges 0..line.length (before block[col]). */
export interface Pos {
  line: number;
  col: number;
}

export interface Selection {
  anchor: Pos;
  head: Pos;
}

export interface FieldState {
  lines: Line[];
  caret: Pos;
  select: Selection | null;
}

// ── Board builders (authoring helpers for stages.ts / tests) ─────────────────
/** A run of `n` blocks of one color — a "word" (bar). */
export function word(color: Color, n: number): Line {
  return Array.from({ length: n }, () => ({ color }));
}

/** `n` space blocks (≥1 separates words). */
export function spaces(n = 1): Line {
  return Array.from({ length: n }, () => ({ color: null }));
}

/** Concatenate runs/spaces into one line, e.g. `line(word('red',5), spaces(), word('blue',4))`. */
export function line(...chunks: Line[]): Line {
  return chunks.flat();
}

/** Build a fresh field from preset lines, caret at the start, no selection. */
export function createField(lines: Line[]): FieldState {
  return { lines, caret: { line: 0, col: 0 }, select: null };
}

// ── Basic queries ──────────────────────────────────────────────────────────
export function isSpace(block: Block | undefined): boolean {
  return !block || block.color === null;
}

export function lineCount(state: FieldState): number {
  return state.lines.length;
}

/** Number of blocks in a line (also the max caret col for that line). */
export function lineLength(state: FieldState, lineIdx: number): number {
  return state.lines[lineIdx]?.length ?? 0;
}

/** Block immediately right of a caret position, or undefined at line end. */
export function blockAt(state: FieldState, pos: Pos): Block | undefined {
  return state.lines[pos.line]?.[pos.col];
}

// ── Position helpers ───────────────────────────────────────────────────────
export function posEqual(a: Pos, b: Pos): boolean {
  return a.line === b.line && a.col === b.col;
}

/** Reading-order compare: <0 if a before b, 0 if equal, >0 if a after b. */
export function comparePos(a: Pos, b: Pos): number {
  return a.line - b.line || a.col - b.col;
}

/** Clamp a position into the field's valid range (line in 0..N-1, col in 0..len). */
export function clampPos(state: FieldState, pos: Pos): Pos {
  if (state.lines.length === 0) return { line: 0, col: 0 };
  const lineIdx = clamp(pos.line, 0, state.lines.length - 1);
  const col = clamp(pos.col, 0, state.lines[lineIdx].length);
  return { line: lineIdx, col };
}

// ── Selection helpers ──────────────────────────────────────────────────────
/** Order a selection's endpoints into reading order: `{ start, end }`, start ≤ end. */
export function normalizeSelection(sel: Selection): { start: Pos; end: Pos } {
  return comparePos(sel.anchor, sel.head) <= 0
    ? { start: sel.anchor, end: sel.head }
    : { start: sel.head, end: sel.anchor };
}

/** True when a selection covers no blocks (both endpoints coincide). */
export function isSelectionEmpty(sel: Selection): boolean {
  return posEqual(sel.anchor, sel.head);
}

// ── Word-run boundaries (the "word" model primitive) ─────────────────────────
// A word is a maximal run of same-color blocks; spaces are their own runs.
// These power Alt-movement (KDA-35) and word-deletion (KDA-37) from one place.

/** Start col (inclusive) of the run that block[col] belongs to. */
export function runStart(lineBlocks: Line, col: number): number {
  if (col <= 0 || col >= lineBlocks.length) return clamp(col, 0, lineBlocks.length);
  const kind = lineBlocks[col].color;
  let i = col;
  while (i > 0 && lineBlocks[i - 1].color === kind) i--;
  return i;
}

/** End col (exclusive) of the run that block[col] belongs to. */
export function runEnd(lineBlocks: Line, col: number): number {
  if (col >= lineBlocks.length) return lineBlocks.length;
  if (col < 0) return 0;
  const kind = lineBlocks[col].color;
  let i = col;
  while (i < lineBlocks.length && lineBlocks[i].color === kind) i++;
  return i;
}

// ── Color counting (win-check + scoring support) ─────────────────────────────
/** Count blocks of a color across the whole field. */
export function countColor(state: FieldState, color: Color): number {
  let total = 0;
  for (const ln of state.lines) {
    for (const b of ln) if (b.color === color) total++;
  }
  return total;
}

/** A stage is cleared when no red blocks remain (spec §6). */
export function redsRemaining(state: FieldState): number {
  return countColor(state, 'red');
}

// ── internal ───────────────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
