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
export const BW = 14;
export const LH = 26;

// Word width bounds from the spec (§1). Board authoring should stay in range;
// not hard-enforced so stages keep their freedom.
export const MIN_WORD = 1;
export const MAX_WORD = 100;

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

// ── Caret movement (spec §2) ────────────────────────────────────────────────
export type MoveAction =
  | 'char-left'
  | 'char-right'
  | 'word-left'
  | 'word-right'
  | 'line-start'
  | 'line-end'
  | 'line-up'
  | 'line-down'
  | 'doc-start'
  | 'doc-end';

export interface CaretMove {
  caret: Pos;
  /** Sticky target column carried across vertical moves (keep-column). */
  goalCol: number;
}

/**
 * Column of the next word boundary to the left: skip any spaces, then skip the
 * full non-space run regardless of color. Text-editor semantics — a "word" for
 * Alt-movement is bounded by whitespace, not by color changes (red and blue
 * runs may touch). Shared by Alt-movement (KDA-35) and word-deletion (KDA-37).
 */
export function wordLeftCol(blocks: Line, col: number): number {
  let i = clamp(col, 0, blocks.length);
  while (i > 0 && blocks[i - 1].color === null) i--;
  while (i > 0 && blocks[i - 1].color !== null) i--;
  return i;
}

/** Column of the next word boundary to the right: skip spaces, then the run (color-agnostic). */
export function wordRightCol(blocks: Line, col: number): number {
  let i = clamp(col, 0, blocks.length);
  while (i < blocks.length && blocks[i].color === null) i++;
  while (i < blocks.length && blocks[i].color !== null) i++;
  return i;
}

/**
 * Pure caret movement: given the current caret and sticky goal column, return
 * the new caret + goal column for an action. Horizontal moves reset the goal
 * column to where they land; vertical moves preserve it and clamp into the
 * target line (keep-column behavior). Char/word moves wrap across line edges.
 */
export function moveCaret(
  state: FieldState,
  caret: Pos,
  goalCol: number,
  action: MoveAction,
): CaretMove {
  const last = Math.max(0, state.lines.length - 1);
  const len = (i: number) => lineLength(state, i);
  const at = (line: number, col: number): CaretMove => ({ caret: { line, col }, goalCol: col });

  switch (action) {
    case 'char-left':
      if (caret.col > 0) return at(caret.line, caret.col - 1);
      if (caret.line > 0) return at(caret.line - 1, len(caret.line - 1));
      return at(caret.line, caret.col);

    case 'char-right':
      if (caret.col < len(caret.line)) return at(caret.line, caret.col + 1);
      if (caret.line < last) return at(caret.line + 1, 0);
      return at(caret.line, caret.col);

    case 'word-left':
      if (caret.col === 0) {
        return caret.line > 0 ? at(caret.line - 1, len(caret.line - 1)) : at(caret.line, 0);
      }
      return at(caret.line, wordLeftCol(state.lines[caret.line], caret.col));

    case 'word-right':
      if (caret.col >= len(caret.line)) {
        return caret.line < last ? at(caret.line + 1, 0) : at(caret.line, caret.col);
      }
      return at(caret.line, wordRightCol(state.lines[caret.line], caret.col));

    case 'line-start':
      return at(caret.line, 0);

    case 'line-end':
      return at(caret.line, len(caret.line));

    case 'line-up':
      if (caret.line > 0) {
        const line = caret.line - 1;
        return { caret: { line, col: Math.min(goalCol, len(line)) }, goalCol };
      }
      return at(0, 0);

    case 'line-down':
      if (caret.line < last) {
        const line = caret.line + 1;
        return { caret: { line, col: Math.min(goalCol, len(line)) }, goalCol };
      }
      return at(last, len(last));

    case 'doc-start':
      return at(0, 0);

    case 'doc-end':
      return at(last, len(last));
  }
}

// ── Deletion (spec §1, §2) ───────────────────────────────────────────────────
/** Which chord drove a delete — feeds the big-chord scoring multiplier (KDA-39). */
export type Chord = 'char' | 'word' | 'line' | 'selection';

/** A removed colored block at its pre-collapse grid position (for snap-out juice). */
export interface RemovedCell {
  line: number;
  col: number;
  color: Color;
}

/** What a delete removed; `red`/`blue` feed scoring (KDA-39) and mistakes (KDA-38). */
export interface DeleteResult {
  red: number;
  blue: number;
  chord: Chord;
  /** Colored cells removed, at their original positions — drives delete feedback (KDA-42). */
  cells: RemovedCell[];
}

function collectRemoved(
  lines: Line[],
  start: Pos,
  end: Pos,
): { red: number; blue: number; cells: RemovedCell[] } {
  let red = 0;
  let blue = 0;
  const cells: RemovedCell[] = [];
  const tally = (line: number, col: number, b: Block) => {
    if (b.color === 'red') {
      red++;
      cells.push({ line, col, color: 'red' });
    } else if (b.color === 'blue') {
      blue++;
      cells.push({ line, col, color: 'blue' });
    }
  };
  if (start.line === end.line) {
    const ln = lines[start.line];
    for (let c = start.col; c < end.col; c++) tally(start.line, c, ln[c]);
  } else {
    const first = lines[start.line];
    for (let c = start.col; c < first.length; c++) tally(start.line, c, first[c]);
    for (let l = start.line + 1; l < end.line; l++) {
      const mid = lines[l];
      for (let c = 0; c < mid.length; c++) tally(l, c, mid[c]);
    }
    const lastLn = lines[end.line];
    for (let c = 0; c < end.col; c++) tally(end.line, c, lastLn[c]);
  }
  return { red, blue, cells };
}

/**
 * Remove blocks in [start, end) (reading order), collapsing the gap like a real
 * code editor (VS Code). The start row's prefix joins the end row's suffix into
 * one row, and any rows fully spanned in between vanish — everything below
 * shifts up. A range that crosses a row boundary therefore removes that boundary
 * (a "newline"); deleting a space still merges adjacent words. The caret lands
 * at the join point. Mutates `state`; returns the tally + removed cells.
 *
 * Note: deleting all blocks *within* one row (start.line === end.line) leaves a
 * blank row in place — a row only disappears when a delete joins across it.
 */
export function deleteRange(
  state: FieldState,
  start: Pos,
  end: Pos,
  chord: Chord,
): DeleteResult {
  const { red, blue, cells } = collectRemoved(state.lines, start, end);

  const head = state.lines[start.line].slice(0, start.col);
  const tail = state.lines[end.line].slice(end.col);
  // Replace the spanned rows [start.line..end.line] with the single joined row.
  state.lines.splice(start.line, end.line - start.line + 1, [...head, ...tail]);

  state.caret = { line: start.line, col: start.col };
  state.select = null;
  return { red, blue, chord, cells };
}

function noop(chord: Chord): DeleteResult {
  return { red: 0, blue: 0, chord, cells: [] };
}

/**
 * A mistake (spec §3) is any single delete that removes ≥1 blue block — so one
 * reckless chord through three blues is one mistake, not three (the result
 * already aggregates the whole action).
 */
export function isMistake(result: DeleteResult): boolean {
  return result.blue > 0;
}

/** A non-empty selection takes priority for every delete key (editor convention). */
function deleteSelectionIfAny(state: FieldState): DeleteResult | null {
  if (state.select && !isSelectionEmpty(state.select)) {
    const { start, end } = normalizeSelection(state.select);
    return deleteRange(state, start, end, 'selection');
  }
  return null;
}

/** Start of the previous row (its end col), or null at the first row — the join target for backward deletes at col 0. */
function prevRowEnd(state: FieldState, line: number): Pos | null {
  return line > 0 ? { line: line - 1, col: state.lines[line - 1].length } : null;
}

/** Start of the next row (col 0), or null at the last row — the join target for forward deletes at line end. */
function nextRowStart(state: FieldState, line: number): Pos | null {
  return line < state.lines.length - 1 ? { line: line + 1, col: 0 } : null;
}

/** Backspace: delete selection, else one block left; at column 0, join onto the previous row. No-op at doc start. */
export function deleteBackward(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col > 0) return deleteRange(state, { line, col: col - 1 }, { line, col }, 'char');
  const prev = prevRowEnd(state, line);
  if (prev) return deleteRange(state, prev, { line, col }, 'char');
  return noop('char');
}

/** Alt+Backspace: delete the word to the left; at column 0, join onto the previous row. No-op at doc start. */
export function deleteWordLeft(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col > 0) {
    return deleteRange(state, { line, col: wordLeftCol(state.lines[line], col) }, { line, col }, 'word');
  }
  const prev = prevRowEnd(state, line);
  if (prev) return deleteRange(state, prev, { line, col }, 'word');
  return noop('word');
}

/** Cmd+Backspace: delete from caret to line start; at column 0, join onto the previous row. No-op at doc start. */
export function deleteToLineStart(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col > 0) return deleteRange(state, { line, col: 0 }, { line, col }, 'line');
  const prev = prevRowEnd(state, line);
  if (prev) return deleteRange(state, prev, { line, col }, 'line');
  return noop('line');
}

// ── Forward deletion (macOS fn+Delete / forward-delete) — mirrors of the ──────
// backward trio but rightward. The caret stays put (deletion is to the right);
// at the line end each joins the next row up, and each is a no-op at doc end.

/** Delete (fn+Delete): delete selection, else one block right; at line end, join the next row up. No-op at doc end. */
export function deleteForward(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col < lineLength(state, line)) return deleteRange(state, { line, col }, { line, col: col + 1 }, 'char');
  const next = nextRowStart(state, line);
  if (next) return deleteRange(state, { line, col }, next, 'char');
  return noop('char');
}

/** Alt+Delete: delete the word to the right; at line end, join the next row up. No-op at doc end. */
export function deleteWordRight(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col < lineLength(state, line)) {
    return deleteRange(state, { line, col }, { line, col: wordRightCol(state.lines[line], col) }, 'word');
  }
  const next = nextRowStart(state, line);
  if (next) return deleteRange(state, { line, col }, next, 'word');
  return noop('word');
}

/** Cmd+Delete: delete from caret to line end; at line end, join the next row up. No-op at doc end. */
export function deleteToLineEnd(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  const len = lineLength(state, line);
  if (col < len) return deleteRange(state, { line, col }, { line, col: len }, 'line');
  const next = nextRowStart(state, line);
  if (next) return deleteRange(state, { line, col }, next, 'line');
  return noop('line');
}

// ── Row reordering (move line up/down, spec §2) ──────────────────────────────
/**
 * Move a row up (`dir = -1`) or down (`dir = +1`) like a code editor's
 * Move-Line. The moved span is the caret's row, or — when a selection is active
 * — every row the selection touches (its rows travel together). The caret and
 * selection ride along so the same content stays under them. No-op (returns
 * `false`) at the field edge; reorders only, removing nothing. Mutates `state`.
 */
export function moveRows(state: FieldState, dir: -1 | 1): boolean {
  const sel = state.select && !isSelectionEmpty(state.select) ? normalizeSelection(state.select) : null;
  const top = sel ? sel.start.line : state.caret.line;
  const bottom = sel ? sel.end.line : state.caret.line;
  const last = state.lines.length - 1;

  if (dir === -1) {
    if (top <= 0) return false;
    // Lift the row above the span and drop it just below the span.
    const [above] = state.lines.splice(top - 1, 1);
    state.lines.splice(bottom, 0, above);
  } else {
    if (bottom >= last) return false;
    // Lift the row below the span and drop it just above the span.
    const [below] = state.lines.splice(bottom + 1, 1);
    state.lines.splice(top, 0, below);
  }

  state.caret = { ...state.caret, line: state.caret.line + dir };
  if (state.select) {
    state.select = {
      anchor: { ...state.select.anchor, line: state.select.anchor.line + dir },
      head: { ...state.select.head, line: state.select.head.line + dir },
    };
  }
  return true;
}

// ── internal ───────────────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
