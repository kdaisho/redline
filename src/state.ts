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
 * color run. Shared by Alt-movement (KDA-35) and word-deletion (KDA-37) so
 * "word" means the same thing everywhere.
 */
export function wordLeftCol(blocks: Line, col: number): number {
  let i = clamp(col, 0, blocks.length);
  while (i > 0 && blocks[i - 1].color === null) i--;
  if (i > 0) {
    const kind = blocks[i - 1].color;
    while (i > 0 && blocks[i - 1].color === kind) i--;
  }
  return i;
}

/** Column of the next word boundary to the right: skip spaces, then the run. */
export function wordRightCol(blocks: Line, col: number): number {
  let i = clamp(col, 0, blocks.length);
  while (i < blocks.length && blocks[i].color === null) i++;
  if (i < blocks.length) {
    const kind = blocks[i].color;
    while (i < blocks.length && blocks[i].color === kind) i++;
  }
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

/** What a delete removed; `red`/`blue` feed scoring (KDA-39) and mistakes (KDA-38). */
export interface DeleteResult {
  red: number;
  blue: number;
  chord: Chord;
}

function countRange(lines: Line[], start: Pos, end: Pos): { red: number; blue: number } {
  let red = 0;
  let blue = 0;
  const tally = (b: Block) => {
    if (b.color === 'red') red++;
    else if (b.color === 'blue') blue++;
  };
  if (start.line === end.line) {
    const ln = lines[start.line];
    for (let c = start.col; c < end.col; c++) tally(ln[c]);
  } else {
    const first = lines[start.line];
    for (let c = start.col; c < first.length; c++) tally(first[c]);
    for (let l = start.line + 1; l < end.line; l++) for (const b of lines[l]) tally(b);
    const lastLn = lines[end.line];
    for (let c = 0; c < end.col; c++) tally(lastLn[c]);
  }
  return { red, blue };
}

/**
 * Remove blocks in [start, end) (reading order), collapse the gap, and merge
 * the partial start/end lines into one. A range that merely spans a line edge
 * (e.g. {l-1,end}→{l,0}) joins the two lines. If the result is empty the line
 * is dropped and lines shift up (spec §1). Mutates `state`; returns the tally.
 */
export function deleteRange(
  state: FieldState,
  start: Pos,
  end: Pos,
  chord: Chord,
): DeleteResult {
  const { red, blue } = countRange(state.lines, start, end);

  const head = state.lines[start.line].slice(0, start.col);
  const tail = state.lines[end.line].slice(end.col);
  const merged = head.concat(tail);
  const before = state.lines.slice(0, start.line);
  const after = state.lines.slice(end.line + 1);

  let newLines: Line[];
  let caret: Pos;
  if (merged.length === 0) {
    // emptied line is removed entirely; following lines shift up
    newLines = [...before, ...after];
    if (newLines.length === 0) caret = { line: 0, col: 0 };
    else if (start.line < newLines.length) caret = { line: start.line, col: 0 };
    else caret = { line: newLines.length - 1, col: newLines[newLines.length - 1].length };
  } else {
    newLines = [...before, merged, ...after];
    caret = { line: start.line, col: start.col };
  }

  state.lines = newLines;
  state.caret = caret;
  state.select = null;
  return { red, blue, chord };
}

function noop(chord: Chord): DeleteResult {
  return { red: 0, blue: 0, chord };
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

/** Backspace: delete selection, else one block left (joining the line at col 0). */
export function deleteBackward(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col > 0) return deleteRange(state, { line, col: col - 1 }, { line, col }, 'char');
  if (line > 0) {
    return deleteRange(state, { line: line - 1, col: lineLength(state, line - 1) }, { line, col: 0 }, 'char');
  }
  return noop('char');
}

/** Alt+Backspace: delete the word to the left (or join the line at col 0). */
export function deleteWordLeft(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col > 0) {
    return deleteRange(state, { line, col: wordLeftCol(state.lines[line], col) }, { line, col }, 'word');
  }
  if (line > 0) {
    return deleteRange(state, { line: line - 1, col: lineLength(state, line - 1) }, { line, col: 0 }, 'word');
  }
  return noop('word');
}

/** Cmd+Backspace: delete from caret to line start (or join the line at col 0). */
export function deleteToLineStart(state: FieldState): DeleteResult {
  const sel = deleteSelectionIfAny(state);
  if (sel) return sel;
  const { line, col } = state.caret;
  if (col > 0) return deleteRange(state, { line, col: 0 }, { line, col }, 'line');
  if (line > 0) {
    return deleteRange(state, { line: line - 1, col: lineLength(state, line - 1) }, { line, col: 0 }, 'line');
  }
  return noop('line');
}

// ── internal ───────────────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
