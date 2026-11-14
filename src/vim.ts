/**
 * Vim engine (#7): modal, delete-only Vim over the field model.
 *
 * Pure — no DOM, no timers, no game rules. `Vim.key(field, key)` consumes one
 * key (see `keymaps/vim.ts` for the key names), moves `field.caret` / mutates
 * `field.lines`, and reports whether a delete command completed. The game folds
 * that delete into score and strikes exactly like a Standard-mode delete: one
 * delete command is one action, whatever its count or shape.
 *
 * What "delete-only" means: Normal, Visual (`v`), Visual Line (`V`) and Visual
 * Block (`Ctrl-v`). There is no Insert mode, no undo, no yank/put, no registers,
 * macros or marks. `c`/`s`/`C`/`S` delete like `d`/`x`/`D`/`dd`.
 *
 * In this mode the caret is a block cursor that sits ON a character: in Normal
 * mode `caret.col` is 0..len-1 (0 on an empty row), never len. In Visual mode it
 * may also rest on the end-of-row position (col = len), which selects the row
 * break — as in Vim. `field.select` is unused — the Visual selection lives here
 * (`selection()`).
 *
 * The motions follow Vim's own algorithms (word motions are ports of
 * `fwd_word` / `bck_word` / `end_word` / `bckend_word`, with a cursor that may
 * rest on the end-of-line position while scanning), as do the operator rules:
 * exclusive vs inclusive vs linewise, `dw` stopping at the end of the line, and
 * the two "becomes linewise" special cases of `:help exclusive` / `:help d`.
 *
 * Known differences from Vim (all in rarely-typed corners):
 *  - a counted `aw` / `aW` (`d3aw`) that runs across a row break or an empty row
 *    can cover slightly different text;
 *  - the closing bracket of `i(` / `a(` / `%` is found by plain nesting — Vim
 *    also skips brackets inside quotes there;
 *  - in Visual mode, a quote or bracket object over a selection that already
 *    spans several characters grows it to cover both, where Vim has its own
 *    extend-to-the-next-level rules;
 *  - search is plain text (no regex), and `{count}%` is not supported.
 */
import {
  type FieldState,
  type Line,
  type Pos,
  type Chord,
  type DeleteResult,
  comparePos,
  deleteRange,
  deleteRows,
  deleteColumns,
} from './state.ts';
import { charClass } from './codetext.ts';

export type VimMode = 'normal' | 'visual' | 'visual-line' | 'visual-block';

/** What one key did. */
export interface VimOutcome {
  /** Set when the key completed a delete command (even one that removed only spaces). */
  deleted: DeleteResult | null;
  /** True when the key was a complete motion on its own, so holding it may auto-repeat it. */
  repeatable: boolean;
}

/** A highlighted stretch of one row, `[from, to)`, for drawing the Visual selection. */
export interface Span {
  line: number;
  from: number;
  to: number;
}

/** What the statusline shows. */
export interface VimStatus {
  mode: VimMode;
  /** Keys typed so far in an unfinished command (`d2`, `g`, `df`). */
  pending: string;
  /** An operator is waiting for its motion (Vim shows a half-height cursor). */
  operator: boolean;
  /** The search prompt while typing a pattern (`/foo`), else null. */
  prompt: string | null;
  /** One-shot message from the last key (`Pattern not found: x`), else ''. */
  message: string;
}

// ── internal types ───────────────────────────────────────────────────────────
interface SearchPattern {
  text: string;
  /** Match whole identifiers only (set by `*` / `#` on a keyword). */
  whole: boolean;
  dir: 1 | -1;
}

interface MotionCmd {
  key: string;
  /** The character argument of f/F/t/T. */
  arg?: string;
  /** The pattern of a `/` `?` motion (frozen so `.` repeats the same search). */
  search?: SearchPattern;
}

type MotionKind = 'excl' | 'incl' | 'line';

interface Target {
  pos: Pos;
  kind: MotionKind;
  /**
   * The motion ran out of text part-way (`5e` with two words left). Like Vim, the
   * cursor still goes as far as it got, but a pending operator is cancelled.
   */
  failed?: boolean;
  /** Sticky column to set (`$` sets Infinity). */
  goal?: number;
  /** Vertical motion: leave the sticky column alone. */
  keepGoal?: boolean;
}

/**
 * A text object with nothing to operate on, where Vim still moves the cursor to `at`:
 * `empty` = it exists but covers no text (`i(` on `()`), and the command counts as run;
 * `failed` = it ran out of text (`5aw` with two words left), and the command is dropped.
 */
interface EmptyObject {
  kind: 'empty' | 'failed';
  at: Pos;
}

type Range =
  | { kind: 'char'; start: Pos; end: Pos } // [start, end) in reading order, joins rows it crosses
  | { kind: 'line'; from: number; to: number } // whole rows, inclusive
  | { kind: 'block'; top: number; bottom: number; left: number; right: number }; // cols [left, right)

/** The last delete command, for `.`. */
type Change =
  | { t: 'motion'; m: MotionCmd; count: number | null }
  | { t: 'lines'; count: number }
  | { t: 'object'; around: boolean; obj: string; count: number }
  | { t: 'visual'; shape: 'char' | 'line' | 'block'; lines: number; width: number; eol: boolean };

const NONE: VimOutcome = { deleted: null, repeatable: false };
const MAX_COUNT = 9999;

const ARROWS: Record<string, string> = { '<Left>': 'h', '<Down>': 'j', '<Up>': 'k', '<Right>': 'l' };

/** Motions that complete with a single key (two-key ones — gg ge gE f F t T / ? — are handled apart). */
const MOTION_KEYS = new Set([
  'h', 'j', 'k', 'l', 'w', 'W', 'b', 'B', 'e', 'E', '0', '^', '$', 'G', '{', '}', ';', ',', '%', 'H', 'M', 'L',
  'n', 'N', '*', '#',
]);

/** Normal-mode commands that take one more character in Vim; we swallow it so it can't act as a command. */
const SWALLOW_KEYS = new Set(['r', 'm', "'", '`', '"', '@', 'z', 'Z']);

/**
 * Scoring chord for `d{motion}` (the game's big-chord multiplier):
 * one-character motions are `char`, line-sized motions `line`, the rest `word`.
 */
const CHAR_MOTIONS = new Set(['h', 'l']);
const LINE_MOTIONS = new Set(['j', 'k', 'gg', 'G', 'H', 'M', 'L', '0', '^', '$', '{', '}']);
export function chordForMotion(key: string): Chord {
  return CHAR_MOTIONS.has(key) ? 'char' : LINE_MOTIONS.has(key) ? 'line' : 'word';
}

// ── text helpers ─────────────────────────────────────────────────────────────
const isBlank = (ln: Line, col: number): boolean => !ln[col] || ln[col].color === null;

/** Vim character class at a column: 0 blank / end of line, 1 punctuation, 2 identifier. WORD mode: 0 or 1. */
function clsAt(ln: Line, col: number, big: boolean): number {
  if (isBlank(ln, col)) return 0;
  if (big) return 1;
  return charClass(ln[col].ch) === 'word' ? 2 : 1;
}

function firstNonBlank(ln: Line): number {
  let c = 0;
  while (c < ln.length && isBlank(ln, c)) c++;
  return c < ln.length ? c : Math.max(0, ln.length - 1);
}

/** Last column the Normal-mode cursor may rest on. */
const maxCol = (ln: Line): number => Math.max(0, ln.length - 1);

/** True when everything left of `col` is blank (the cursor is in the indent). */
function inIndent(ln: Line, col: number): boolean {
  for (let c = 0; c < col && c < ln.length; c++) if (!isBlank(ln, c)) return false;
  return true;
}

/** True when everything from `col` on is blank. */
function restBlank(ln: Line, col: number): boolean {
  for (let c = col; c < ln.length; c++) if (!isBlank(ln, c)) return false;
  return true;
}

// ── scanning cursor (ports of Vim's inc_cursor / dec_cursor / cls) ───────────
// `p.col` may equal the row length here: that is Vim's NUL, the end-of-line
// position, which has class 0.
type Lines = Line[];

/** Step forward. 0 = moved within the row, 2 = onto end-of-line, 1 = to the next row, -1 = at the end. */
function inc(lines: Lines, p: Pos): number {
  const len = lines[p.line].length;
  if (p.col < len) {
    p.col++;
    return p.col < len ? 0 : 2;
  }
  if (p.line < lines.length - 1) {
    p.line++;
    p.col = 0;
    return 1;
  }
  return -1;
}

/** Step backward. 0 = moved within the row, 1 = onto the previous row's end-of-line, -1 = at the start. */
function dec(lines: Lines, p: Pos): number {
  if (p.col > 0) {
    p.col--;
    return 0;
  }
  if (p.line > 0) {
    p.line--;
    p.col = lines[p.line].length;
    return 1;
  }
  return -1;
}

const cls = (lines: Lines, p: Pos, big: boolean): number => clsAt(lines[p.line], p.col, big);
const onEmptyRow = (lines: Lines, p: Pos): boolean => p.col === 0 && lines[p.line].length === 0;

/** Vim's `incl`: step forward, skipping the end-of-row position of a non-empty row. */
function incl(lines: Lines, p: Pos): number {
  let r = inc(lines, p);
  if (r >= 1 && p.col) r = inc(lines, p);
  return r;
}

/** Vim's `decl`: step backward, skipping the end-of-row position of a non-empty row. */
function decl(lines: Lines, p: Pos): number {
  let r = dec(lines, p);
  if (r === 1 && p.col) r = dec(lines, p);
  return r;
}

/** Vim's `back_in_line`: to the start of the word (or blanks) under the cursor, staying on the row. */
function backInLine(lines: Lines, p: Pos, big: boolean): void {
  const sclass = cls(lines, p, big);
  while (p.col > 0) {
    p.col--;
    if (cls(lines, p, big) !== sclass) {
      p.col++;
      break;
    }
  }
}

/**
 * `w` / `W`. With `eol` (operator pending) the last word stops at the end of its
 * row instead of wrapping. Returns false when it started on the field's last character.
 */
function fwdWord(lines: Lines, p: Pos, count: number, big: boolean, eol: boolean): boolean {
  while (--count >= 0) {
    const sclass = cls(lines, p, big);
    const lastLine = p.line === lines.length - 1;
    let i = inc(lines, p);
    if (i >= 1 && eol && count === 0) return true; // started on the last character of the row
    if (i === -1 || (i >= 1 && lastLine)) return false; // started on the last character of the field
    // go one past the end of the current word
    if (sclass !== 0) {
      while (cls(lines, p, big) === sclass) {
        i = inc(lines, p);
        if (i === -1 || (i >= 1 && eol && count === 0)) return true;
      }
    }
    // go to the next non-blank; an empty row counts as a word
    while (cls(lines, p, big) === 0) {
      if (onEmptyRow(lines, p)) break;
      i = inc(lines, p);
      if (i === -1 || (i >= 1 && eol && count === 0)) return true;
    }
  }
  return true;
}

/** `b` / `B`. Returns false when it ran into the start of the field. `stop`: stay put when already on a word start. */
function bckWord(lines: Lines, p: Pos, count: number, big: boolean, stop = false): boolean {
  while (--count >= 0) {
    const sclass = cls(lines, p, big);
    if (dec(lines, p) === -1) return false;
    let onEmpty = false;
    if (!stop || sclass === cls(lines, p, big) || sclass === 0) {
      while (cls(lines, p, big) === 0) {
        if (onEmptyRow(lines, p)) {
          onEmpty = true;
          break;
        }
        if (dec(lines, p) === -1) return true;
      }
      if (!onEmpty) {
        // back to the start of this word
        const c = cls(lines, p, big);
        while (cls(lines, p, big) === c) if (dec(lines, p) === -1) return true;
      }
    }
    if (!onEmpty) inc(lines, p); // overshot — forward one
    stop = false;
  }
  return true;
}

/**
 * `e` / `E`. Returns false when there is no next word end. `stop`: stay put when
 * already on a word end; `empty`: an empty row counts as a word.
 */
function endWord(lines: Lines, p: Pos, count: number, big: boolean, stop = false, empty = false): boolean {
  while (--count >= 0) {
    const sclass = cls(lines, p, big);
    if (inc(lines, p) === -1) return false;
    let onEmpty = false;
    if (cls(lines, p, big) === sclass && sclass !== 0) {
      // in the middle of a word: just run to its end
      while (cls(lines, p, big) === sclass) if (inc(lines, p) === -1) return false;
    } else if (!stop || sclass === 0) {
      // at the end of a word: skip blanks, then run to the end of the next word
      while (cls(lines, p, big) === 0) {
        if (empty && onEmptyRow(lines, p)) {
          onEmpty = true;
          break;
        }
        if (inc(lines, p) === -1) return false;
      }
      if (!onEmpty) {
        const c = cls(lines, p, big);
        while (cls(lines, p, big) === c) if (inc(lines, p) === -1) return false;
      }
    }
    if (!onEmpty) dec(lines, p); // overshot — back one
    stop = false;
  }
  return true;
}

/** `ge` / `gE`. Returns false when it ran into the start of the field. `eol`: stop at a row break. */
function bckendWord(lines: Lines, p: Pos, count: number, big: boolean, eol = false): boolean {
  while (--count >= 0) {
    const sclass = cls(lines, p, big);
    let i = dec(lines, p);
    if (i === -1) return false;
    if (eol && i === 1) return true;
    // back to before the start of this word
    if (sclass !== 0) {
      while (cls(lines, p, big) === sclass) {
        i = dec(lines, p);
        if (i === -1 || (eol && i === 1)) return true;
      }
    }
    // back to the end of the previous word; an empty row counts as a word
    while (cls(lines, p, big) === 0) {
      if (onEmptyRow(lines, p)) break;
      i = dec(lines, p);
      if (i === -1 || (eol && i === 1)) return true;
    }
  }
  return true;
}

// ── brackets ─────────────────────────────────────────────────────────────────
const BRACKET_PAIRS: Record<string, [string, string]> = {
  '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
  '[': ['[', ']'], ']': ['[', ']'],
  '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
  '<': ['<', '>'], '>': ['<', '>'],
};
const PERCENT_CHARS = '()[]{}';

/** Scan backward from (line, col) inclusive for the unmatched `open`. */
function scanBack(lines: Lines, line: number, col: number, open: string, close: string): Pos | null {
  let depth = 0;
  for (let l = line; l >= 0; l--) {
    const ln = lines[l];
    for (let c = l === line ? Math.min(col, ln.length - 1) : ln.length - 1; c >= 0; c--) {
      const ch = ln[c].ch;
      if (ch === close) depth++;
      else if (ch === open) {
        if (depth === 0) return { line: l, col: c };
        depth--;
      }
    }
  }
  return null;
}

/** Scan forward from (line, col) inclusive for the unmatched `close`. */
function scanFwd(lines: Lines, line: number, col: number, open: string, close: string): Pos | null {
  let depth = 0;
  for (let l = line; l < lines.length; l++) {
    const ln = lines[l];
    for (let c = l === line ? Math.max(col, 0) : 0; c < ln.length; c++) {
      const ch = ln[c].ch;
      if (ch === open) depth++;
      else if (ch === close) {
        if (depth === 0) return { line: l, col: c };
        depth--;
      }
    }
  }
  return null;
}

// ── text objects ─────────────────────────────────────────────────────────────
/** A word object as a motion: the text from `start` to `end` (inclusive unless `inclusive` is false). */
interface WordSpan {
  start: Pos;
  end: Pos;
  inclusive: boolean;
  /** Ran out of text before `count` objects: there is no object, but the cursor went this far. */
  failed?: boolean;
}

/**
 * `iw` `aw` `iW` `aW` — a port of Vim's `current_word`. `extend` = a Visual
 * selection already covers more than one character (`anchor` is its other end),
 * so the object grows it from the cursor instead of starting afresh.
 */
function wordObject(
  lines: Lines,
  pos: Pos,
  around: boolean,
  big: boolean,
  count: number,
  anchor: Pos | null = null,
): WordSpan {
  const p = { ...pos };
  let start = anchor ? { ...anchor } : { ...pos };
  let inclusive = true;
  let includeBlank = false;
  const fail = (): WordSpan => ({ start, end: p, inclusive, failed: true });

  if (!anchor) {
    backInLine(lines, p, big);
    start = { ...p };
    if ((cls(lines, p, big) === 0) === around) {
      // blanks + the word after them (aw on a blank), or just the word (iw on a word)
      if (!endWord(lines, p, 1, big, true, true)) return fail();
    } else {
      // the word + the blanks after it (aw on a word), or just the blanks (iw on a blank)
      fwdWord(lines, p, 1, big, true);
      if (p.col === 0) decl(lines, p);
      else p.col--;
      if (around) includeBlank = true;
    }
    count--;
  }

  const backward = anchor !== null && comparePos(pos, anchor) < 0;
  while (count > 0) {
    inclusive = true;
    if (backward) {
      if (decl(lines, p) === -1) return fail();
      if (around !== (cls(lines, p, big) !== 0)) {
        if (!bckWord(lines, p, 1, big, true)) return fail();
      } else {
        if (!bckendWord(lines, p, 1, big, true)) return fail();
        incl(lines, p);
      }
    } else {
      if (incl(lines, p) === -1) return fail();
      if (around) {
        if (!fwdWord(lines, p, 1, big, true)) return fail();
        // just past a row break: don't take the break
        if (p.col > 0) p.col--;
        else inclusive = false;
      } else {
        // `iw` counts a stretch of blanks as a word of its own: run to the end of whichever this is
        const c = cls(lines, p, big);
        if (c === 0 && onEmptyRow(lines, p)) {
          count--;
          continue;
        }
        while (cls(lines, p, big) === c && p.col < lines[p.line].length) p.col++;
        p.col--;
      }
    }
    count--;
  }

  // `aw` that found no blanks after the word takes the blanks before it instead —
  // unless those are the row's indent.
  if (includeBlank && (cls(lines, p, big) !== 0 || (p.col === 0 && !inclusive))) {
    const q = { ...start };
    if (q.col > 0) {
      q.col--;
      backInLine(lines, q, big);
      if (cls(lines, q, big) === 0 && q.col > 0) start = q;
    }
  }
  return { start, end: p, inclusive };
}

/** `i"` `a"` (and `'`, `` ` ``), within the cursor's row. Follows Vim's `current_quote`. */
function quoteObject(ln: Line, col: number, around: boolean, q: string): Range | EmptyObject | null {
  const next = (from: number): number => {
    for (let c = Math.max(from, 0); c < ln.length; c++) if (ln[c].ch === q) return c;
    return -1;
  };
  let open: number;
  let close: number;
  if (ln[col]?.ch === q) {
    // On a quote: pair the row's quotes from the left to learn if this one opens or closes.
    let first = 0;
    for (;;) {
      open = next(first);
      if (open < 0) return null;
      close = next(open + 1);
      if (close < 0) return null;
      if (open <= col && col <= close) break;
      first = close + 1;
    }
  } else {
    // The quote before the cursor opens the string; with none, take the next string on the row.
    open = -1;
    for (let c = col - 1; c >= 0; c--) {
      if (ln[c].ch === q) {
        open = c;
        break;
      }
    }
    if (open < 0) open = next(col);
    if (open < 0) return null;
    close = next(open + 1);
    if (close < 0) return null;
  }

  let from = open + 1;
  let to = close;
  if (around) {
    from = open;
    to = close + 1;
    // trailing blanks, else leading blanks
    if (to < ln.length && isBlank(ln, to)) while (to < ln.length && isBlank(ln, to)) to++;
    else while (from > 0 && isBlank(ln, from - 1)) from--;
  }
  if (to <= from) return { kind: 'empty', at: { line: 0, col: close } };
  return { kind: 'char', start: { line: 0, col: from }, end: { line: 0, col: to } };
}

/**
 * The next block after (line, col): the first `open` that is not owed to an
 * earlier stray `close` (Vim pairs them up while scanning forward).
 */
function nextOpen(lines: Lines, line: number, col: number, open: string, close: string): Pos | null {
  let owed = 0;
  for (let l = line; l < lines.length; l++) {
    const ln = lines[l];
    for (let c = l === line ? col + 1 : 0; c < ln.length; c++) {
      if (ln[c].ch === close) owed++;
      else if (ln[c].ch === open) {
        if (owed === 0) return { line: l, col: c };
        owed--;
      }
    }
  }
  return null;
}

/**
 * `i(` `a(` and friends: the `count`-th bracket pair enclosing the cursor; may
 * span rows. When the cursor is not inside a pair, the next pair after it is
 * used (Vim 9.1).
 */
function bracketObject(
  lines: Lines,
  pos: Pos,
  around: boolean,
  open: string,
  close: string,
  count: number,
): Range | EmptyObject | null {
  const ch = lines[pos.line][pos.col]?.ch;
  let o: Pos | null =
    ch === open
      ? { ...pos }
      : scanBack(lines, pos.line, ch === close ? pos.col - 1 : pos.col, open, close);
  if (o) {
    for (let i = 1; o && i < count; i++) o = scanBack(lines, o.line, o.col - 1, open, close);
  } else {
    // not inside a pair: take the next one (a count steps on to the block after / inside it)
    o = pos;
    for (let i = 0; o && i < count; i++) o = nextOpen(lines, o.line, o.col, open, close);
  }
  const c = o && scanFwd(lines, o.line, o.col + 1, open, close);
  if (!o || !c) return null;
  const empty: EmptyObject = { kind: 'empty', at: c };

  if (around) return { kind: 'char', start: o, end: { line: c.line, col: c.col + 1 } };

  // Inner: skip the row break right after the open bracket, and — when the close
  // bracket is the first non-blank of its row — stop at the end of the row above.
  let s: Pos = { line: o.line, col: o.col + 1 };
  if (s.col >= lines[s.line].length && s.line < c.line) s = { line: s.line + 1, col: 0 };
  let e: Pos = { ...c };
  if (e.line > s.line && inIndent(lines[e.line], e.col)) {
    e = { line: e.line - 1, col: lines[e.line - 1].length };
    if (s.col === 0) return e.line >= s.line ? { kind: 'line', from: s.line, to: e.line } : empty;
  }
  return comparePos(s, e) < 0 ? { kind: 'char', start: s, end: e } : empty;
}

function textObject(
  lines: Lines,
  pos: Pos,
  around: boolean,
  obj: string,
  count: number,
): Range | EmptyObject | null {
  const onRow = (r: Range | EmptyObject | null): Range | EmptyObject | null => {
    if (r && r.kind === 'char') {
      r.start.line = pos.line;
      r.end.line = pos.line;
    } else if (r && (r.kind === 'empty' || r.kind === 'failed')) {
      r.at.line = pos.line;
    }
    return r;
  };
  if (obj === 'w' || obj === 'W') {
    // a word object is a motion from its start to its end, with the usual operator rules
    const w = wordObject(lines, pos, around, obj === 'W', count);
    if (w.failed) return { kind: 'failed', at: w.end };
    return opRange(lines, w.start, { pos: w.end, kind: w.inclusive ? 'incl' : 'excl' }) ?? { kind: 'empty', at: w.start };
  }
  if (obj === '"' || obj === "'" || obj === '`') return onRow(quoteObject(lines[pos.line], pos.col, around, obj));
  const pair = BRACKET_PAIRS[obj];
  if (pair) return bracketObject(lines, pos, around, pair[0], pair[1], count);
  return null;
}

// ── search ───────────────────────────────────────────────────────────────────
/** Every match of a literal pattern, in reading order. Matches never span rows. */
function allMatches(lines: Lines, pat: SearchPattern): Pos[] {
  const out: Pos[] = [];
  const n = pat.text.length;
  if (n === 0) return out;
  const isWordCh = (ln: Line, c: number) => c >= 0 && c < ln.length && clsAt(ln, c, false) === 2;
  for (let l = 0; l < lines.length; l++) {
    const ln = lines[l];
    for (let c = 0; c + n <= ln.length; c++) {
      let ok = true;
      for (let i = 0; i < n && ok; i++) ok = ln[c + i].ch === pat.text[i];
      if (ok && pat.whole && (isWordCh(ln, c - 1) || isWordCh(ln, c + n))) ok = false;
      if (ok) out.push({ line: l, col: c });
    }
  }
  return out;
}

/** The `count`-th match after (dir 1) or before (dir -1) `from`, wrapping around the field. */
function findMatch(lines: Lines, from: Pos, pat: SearchPattern, dir: 1 | -1, count: number): Pos | null {
  const all = allMatches(lines, pat);
  if (all.length === 0) return null;
  let idx: number;
  if (dir === 1) {
    idx = all.findIndex((m) => comparePos(m, from) > 0);
    if (idx < 0) idx = 0; // wrap to the top
    idx = (idx + count - 1) % all.length;
  } else {
    idx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (comparePos(all[i], from) < 0) {
        idx = i;
        break;
      }
    }
    if (idx < 0) idx = all.length - 1; // wrap to the bottom
    idx = (((idx - (count - 1)) % all.length) + all.length) % all.length;
  }
  return all[idx];
}

/**
 * The word `*` / `#` search for: the identifier under or after the cursor, else
 * the non-blank string there (which starts after any identifier before it).
 */
function wordUnderCursor(ln: Line, col: number): { start: number; text: string; whole: boolean } | null {
  const isIdent = (c: number) => clsAt(ln, c, false) === 2;
  const textOf = (s: number, e: number) => ln.slice(s, e).map((b) => b.ch).join('');

  let c = col;
  while (c < ln.length && !isIdent(c)) c++;
  if (c < ln.length) {
    let s = c;
    while (s > 0 && isIdent(s - 1)) s--;
    let e = c;
    while (e < ln.length && isIdent(e)) e++;
    return { start: s, text: textOf(s, e), whole: true };
  }

  c = col;
  while (c < ln.length && isBlank(ln, c)) c++;
  if (c >= ln.length) return null;
  let s = c;
  while (s > 0 && !isBlank(ln, s - 1) && !isIdent(s - 1)) s--;
  let e = c;
  while (e < ln.length && !isBlank(ln, e)) e++;
  return { start: s, text: textOf(s, e), whole: false };
}

// ── operator ranges ──────────────────────────────────────────────────────────
/**
 * The text an operator covers for a motion from `from` to target `t`
 * (`:help exclusive`, `:help d`): order the ends, apply inclusive/exclusive, and
 * the two special cases that turn a multi-row charwise delete linewise.
 */
function opRange(lines: Lines, from: Pos, t: Target): Range | null {
  if (t.kind === 'line') {
    return { kind: 'line', from: Math.min(from.line, t.pos.line), to: Math.max(from.line, t.pos.line) };
  }
  const forward = comparePos(from, t.pos) <= 0;
  const s: Pos = { ...(forward ? from : t.pos) };
  let e: Pos = { ...(forward ? t.pos : from) };

  if (t.kind === 'incl') {
    e.col = Math.min(e.col + 1, lines[e.line].length);
  } else if (e.col === 0 && e.line > s.line) {
    // Exclusive motion ending in column 0: stop at the end of the row above …
    e = { line: e.line - 1, col: lines[e.line - 1].length };
    // … and if the start is in the indent, the whole rows go.
    if (inIndent(lines[s.line], s.col)) return { kind: 'line', from: s.line, to: e.line };
  }
  // A multi-row delete with only blanks before its start and after its end is linewise.
  if (e.line > s.line && inIndent(lines[s.line], s.col) && restBlank(lines[e.line], e.col)) {
    return { kind: 'line', from: s.line, to: e.line };
  }
  return comparePos(s, e) < 0 ? { kind: 'char', start: s, end: e } : null;
}

// ── the engine ───────────────────────────────────────────────────────────────
export class Vim {
  mode: VimMode = 'normal';

  private anchor: Pos = { line: 0, col: 0 }; // where the Visual selection started
  private goal = 0; // sticky column for j / k; Infinity after `$`

  // the command being typed
  private count1 = ''; // count before the operator
  private count2 = ''; // count after the operator
  private op: string | null = null; // pending operator key: 'd' or 'c'
  private wait: 'g' | 'find' | 'object' | 'swallow' | null = null; // a key that needs one more key
  private waitKey = ''; // which find (f F t T) / which object prefix (i a)
  private keys = ''; // everything typed so far, for the statusline
  private prompt: { dir: 1 | -1; text: string } | null = null; // `/` `?` pattern being typed

  // memory across commands
  private lastSearch: SearchPattern | null = null;
  private lastFind: { key: string; ch: string } | null = null;
  private lastChange: Change | null = null;
  private message = '';
  /** Where the last key left the cursor — a cursor moved from outside (a new board) resets the sticky column. */
  private seen: Pos | null = null;

  /** Back to a clean Normal mode for a new board. Search / find / `.` memory is kept. */
  reset(): void {
    this.mode = 'normal';
    this.goal = 0;
    this.message = '';
    this.clearPending();
  }

  status(): VimStatus {
    return {
      mode: this.mode,
      pending: this.keys,
      operator: this.op !== null,
      prompt: this.prompt ? (this.prompt.dir === 1 ? '/' : '?') + this.prompt.text : null,
      message: this.message,
    };
  }

  /** The Visual selection as row spans (empty in Normal mode). Empty rows get one cell so they show. */
  selection(field: FieldState): Span[] {
    if (this.mode === 'normal') return [];
    const a = this.anchor;
    const h = field.caret;
    const top = Math.min(a.line, h.line);
    const bottom = Math.max(a.line, h.line);
    const spans: Span[] = [];
    for (let l = top; l <= bottom; l++) {
      if (!field.lines[l]) continue; // a selection left over from another board
      const len = field.lines[l].length;
      const full = Math.max(len, 1);
      if (this.mode === 'visual-line') {
        spans.push({ line: l, from: 0, to: full });
      } else if (this.mode === 'visual-block') {
        const left = Math.min(a.col, h.col);
        const right = this.goal === Infinity ? len : Math.min(Math.max(a.col, h.col) + 1, len);
        if (right > left) spans.push({ line: l, from: left, to: right });
      } else {
        const [s, e] = comparePos(a, h) <= 0 ? [a, h] : [h, a];
        const from = l === s.line ? s.col : 0;
        // a row whose break is selected shows one cell past its end
        const to = l < e.line ? len + 1 : Math.min(e.col + 1, len + 1);
        if (to > from) spans.push({ line: l, from, to });
      }
    }
    return spans;
  }

  /** Feed one key. Mutates `field` (cursor, and the text on a delete). */
  key(field: FieldState, key: string): VimOutcome {
    if (!this.seen || comparePos(this.seen, field.caret) !== 0) {
      this.clampCaret(field);
      this.goal = field.caret.col;
    }
    const outcome = this.handle(field, key);
    this.seen = { ...field.caret };
    return outcome;
  }

  private handle(field: FieldState, key: string): VimOutcome {
    this.message = '';
    if (this.prompt) return this.promptKey(field, key);

    if (key === '<Esc>') {
      this.clearPending();
      if (this.mode !== 'normal') this.exitVisual(field);
      return NONE;
    }

    // ── the second key of a two-key command ──
    if (this.wait) {
      const wait = this.wait;
      this.wait = null;
      if (key.length !== 1 || wait === 'swallow') {
        this.clearPending();
        return NONE;
      }
      this.keys += key;
      if (wait === 'find') return this.runMotion(field, { key: this.waitKey, arg: key }, false);
      if (wait === 'object') return this.runObject(field, this.waitKey === 'a', key);
      // wait === 'g'
      if (key === 'g') return this.runMotion(field, { key: 'gg' }, false);
      if (key === 'e') return this.runMotion(field, { key: 'ge' }, false);
      if (key === 'E') return this.runMotion(field, { key: 'gE' }, false);
      this.clearPending();
      return NONE;
    }

    // ── counts ── (`0` is a count digit only after another digit)
    const digits = this.op ? this.count2 : this.count1;
    if (/^[1-9]$/.test(key) || (key === '0' && digits !== '')) {
      if (this.op) this.count2 += key;
      else this.count1 += key;
      this.keys += key;
      return NONE;
    }

    const k = ARROWS[key] ?? key;
    const single = this.keys === ''; // nothing typed before this key
    const visual = this.mode !== 'normal';

    if (visual) {
      switch (k) {
        case 'd':
        case 'x':
        case 'c':
        case 's':
        case '<Del>':
          return this.deleteVisual(field, 'plain');
        case 'X': // linewise, except in a block, where it deletes the block
          return this.deleteVisual(field, this.mode === 'visual-block' ? 'plain' : 'lines');
        case 'S':
        case 'R':
          return this.deleteVisual(field, 'lines');
        case 'D':
        case 'C':
          return this.deleteVisual(field, this.mode === 'visual-block' ? 'eol' : 'lines');
        case 'o':
        case 'O': {
          // jump to the other end of the selection (`O` in a block: the other corner of the row)
          const a = this.anchor;
          const h = field.caret;
          if (k === 'O' && this.mode === 'visual-block') {
            this.anchor = { line: a.line, col: h.col };
            field.caret = { line: h.line, col: a.col };
          } else {
            this.anchor = { ...h };
            field.caret = { ...a };
          }
          this.goal = field.caret.col;
          this.clearPending();
          return NONE;
        }
        case 'v':
        case 'V':
        case '<C-v>': {
          const want: VimMode = k === 'v' ? 'visual' : k === 'V' ? 'visual-line' : 'visual-block';
          this.clearPending();
          if (this.mode === want) this.exitVisual(field);
          else this.mode = want;
          return NONE;
        }
        case 'i':
        case 'a':
          this.wait = 'object';
          this.waitKey = k;
          this.keys += k;
          return NONE;
      }
    } else if (!this.op) {
      switch (k) {
        case 'x':
        case 's':
        case '<Del>':
          return this.finish(this.opMotion(field, { key: 'l' }, this.takeCount()));
        case 'X':
          return this.finish(this.opMotion(field, { key: 'h' }, this.takeCount()));
        case 'D':
        case 'C':
          return this.finish(this.opMotion(field, { key: '$' }, this.takeCount()));
        case 'S':
          return this.finish(this.opLines(field, this.takeCount() ?? 1));
        case 'd':
        case 'c':
          this.op = k;
          this.keys += k;
          return NONE;
        case 'v':
        case 'V':
        case '<C-v>':
          this.clearPending();
          this.mode = k === 'v' ? 'visual' : k === 'V' ? 'visual-line' : 'visual-block';
          this.anchor = { ...field.caret };
          return NONE;
        case '.':
          return this.finish(this.repeat(field, this.takeCount()));
      }
    } else {
      // operator pending
      if (k === this.op) return this.finish(this.opLines(field, this.takeCount() ?? 1)); // dd / cc
      if (k === 'i' || k === 'a') {
        this.wait = 'object';
        this.waitKey = k;
        this.keys += k;
        return NONE;
      }
    }

    // ── keys shared by Normal, Visual and operator-pending ──
    if (k === 'g') {
      this.wait = 'g';
      this.keys += k;
      return NONE;
    }
    if (k === 'f' || k === 'F' || k === 't' || k === 'T') {
      this.wait = 'find';
      this.waitKey = k;
      this.keys += k;
      return NONE;
    }
    if (k === '/' || k === '?') {
      this.prompt = { dir: k === '/' ? 1 : -1, text: '' };
      return NONE;
    }
    if (MOTION_KEYS.has(k)) return this.runMotion(field, { key: k }, single);
    if (!this.op && SWALLOW_KEYS.has(k)) {
      this.clearPending();
      this.wait = 'swallow';
      this.keys = k;
      return NONE;
    }

    // Anything else (i a o u p y J …) is not part of delete-only Vim: drop the command.
    this.clearPending();
    return NONE;
  }

  // ── pending-command plumbing ───────────────────────────────────────────────
  private clearPending(): void {
    this.count1 = '';
    this.count2 = '';
    this.op = null;
    this.wait = null;
    this.waitKey = '';
    this.keys = '';
    this.prompt = null;
  }

  /** The command's count (counts before and after the operator multiply), or null when none was typed. */
  private takeCount(): number | null {
    if (this.count1 === '' && this.count2 === '') return null;
    const a = this.count1 === '' ? 1 : parseInt(this.count1, 10);
    const b = this.count2 === '' ? 1 : parseInt(this.count2, 10);
    return Math.min(a * b, MAX_COUNT);
  }

  private finish(deleted: DeleteResult | null): VimOutcome {
    this.clearPending();
    return deleted ? { deleted, repeatable: false } : NONE;
  }

  private exitVisual(field: FieldState): void {
    this.mode = 'normal';
    this.clampCaret(field);
    if (this.goal !== Infinity) this.goal = field.caret.col;
  }

  /** Last column the cursor may rest on: the last character, or — in Visual — the end-of-row position. */
  private lastCol(ln: Line): number {
    return this.mode === 'normal' ? maxCol(ln) : ln.length;
  }

  private clampCaret(field: FieldState): void {
    const line = Math.min(Math.max(field.caret.line, 0), field.lines.length - 1);
    const col = Math.min(Math.max(field.caret.col, 0), this.lastCol(field.lines[line]));
    field.caret = { line, col };
  }

  // ── search prompt ──────────────────────────────────────────────────────────
  private promptKey(field: FieldState, key: string): VimOutcome {
    const p = this.prompt!;
    if (key === '<CR>') {
      let pat: SearchPattern;
      if (p.text === '') {
        // empty pattern: search again for the last one, in this prompt's direction
        if (!this.lastSearch) {
          this.clearPending();
          this.message = 'No previous search';
          return NONE;
        }
        pat = { ...this.lastSearch, dir: p.dir };
      } else {
        pat = { text: p.text, whole: false, dir: p.dir };
      }
      this.lastSearch = pat;
      this.prompt = null;
      return this.runMotion(field, { key: '/', search: { ...pat } }, false);
    }
    if (key === '<Esc>' || (key === '<BS>' && p.text === '')) {
      this.clearPending();
      return NONE;
    }
    if (key === '<BS>') p.text = p.text.slice(0, -1);
    else if (key.length === 1) p.text += key;
    return NONE;
  }

  // ── motions ────────────────────────────────────────────────────────────────
  /** A motion key completed: move (Normal / Visual) or delete over it (operator pending). */
  private runMotion(field: FieldState, m: MotionCmd, single: boolean): VimOutcome {
    const count = this.takeCount();
    const pendingOp = this.op !== null;
    if (m.arg !== undefined) this.lastFind = { key: m.key, ch: m.arg };
    if (pendingOp) return this.finish(this.opMotion(field, m, count));

    this.clearPending();
    const t = this.motion(field, m, count, false);
    if (!t) return NONE;
    this.moveTo(field, t);
    return { deleted: null, repeatable: single && count === null && !t.failed };
  }

  private moveTo(field: FieldState, t: Target): void {
    const ln = field.lines[t.pos.line];
    field.caret = { line: t.pos.line, col: Math.min(Math.max(t.pos.col, 0), this.lastCol(ln)) };
    if (t.goal !== undefined) this.goal = t.goal;
    else if (!t.keepGoal) this.goal = field.caret.col;
  }

  /**
   * Where a motion lands from the cursor, or null when it fails. `op` = an
   * operator is pending, which lets a few motions reach the end-of-row position
   * (as Visual mode does).
   */
  private motion(field: FieldState, m: MotionCmd, count: number | null, op: boolean): Target | null {
    const lines = field.lines;
    const cur = field.caret;
    const n = count ?? 1;
    const last = lines.length - 1;
    const ln = lines[cur.line];
    const at = (line: number, col: number, kind: MotionKind): Target => ({ pos: { line, col }, kind });
    const visual = this.mode !== 'normal';
    const toRow = (line: number): Target => at(line, firstNonBlank(lines[line]), 'line');

    switch (m.key) {
      // h / l that cannot move fail as plain motions, but an operator still runs on them (over nothing).
      case 'h':
        return cur.col === 0 && !op ? null : at(cur.line, Math.max(0, cur.col - n), 'excl');
      case 'l': {
        const max = op || visual ? ln.length : maxCol(ln); // `dl` on the last character deletes it
        return cur.col >= max && !op ? null : at(cur.line, Math.min(max, cur.col + n), 'excl');
      }
      case 'j':
      case 'k': {
        const line = m.key === 'j' ? Math.min(last, cur.line + n) : Math.max(0, cur.line - n);
        if (line === cur.line) return null;
        const col = Math.min(this.goal, this.lastCol(lines[line]));
        return { pos: { line, col }, kind: 'line', keepGoal: true };
      }
      case '0':
        return at(cur.line, 0, 'excl');
      case '^':
        return at(cur.line, firstNonBlank(ln), 'excl');
      case '$': {
        // a count on the last row fails: the cursor stays, but the column still sticks to the row end
        if (n > 1 && cur.line === last) return { pos: { ...cur }, kind: 'incl', goal: Infinity, failed: true };
        const line = Math.min(last, cur.line + n - 1);
        return { pos: { line, col: this.lastCol(lines[line]) }, kind: 'incl', goal: Infinity };
      }
      case 'gg':
        return toRow(count === null ? 0 : Math.min(count - 1, last));
      case 'G':
        return toRow(count === null ? last : Math.min(count - 1, last));
      // The whole field is on screen, so H / M / L are its top, middle and bottom rows.
      case 'H':
        return toRow(Math.min(last, n - 1));
      case 'L':
        return toRow(Math.max(0, last - (n - 1)));
      case 'M':
        return toRow(Math.floor(last / 2));

      case 'w':
      case 'W': {
        const p = { ...cur };
        fwdWord(lines, p, n, m.key === 'W', op);
        return { pos: p, kind: 'excl' };
      }
      case 'b':
      case 'B': {
        const p = { ...cur };
        const ok = bckWord(lines, p, n, m.key === 'B');
        return { pos: p, kind: 'excl', failed: !ok };
      }
      case 'e':
      case 'E': {
        const p = { ...cur };
        const ok = endWord(lines, p, n, m.key === 'E');
        // unlike b / ge, an operator still acts on a `e` that ran out of words
        return { pos: p, kind: 'incl', failed: !ok && !op };
      }
      case 'ge':
      case 'gE': {
        const p = { ...cur };
        const ok = bckendWord(lines, p, n, m.key === 'gE');
        return { pos: p, kind: 'incl', failed: !ok };
      }

      case '{':
      case '}': {
        // To the next blank row (paragraph boundary); `}` past the last one lands on the field's last character.
        const dir = m.key === '}' ? 1 : -1;
        let row = cur.line;
        let left = n;
        while (left-- > 0) {
          let skipped = false;
          for (let first = true; ; first = false) {
            if (lines[row].length !== 0) skipped = true;
            if (!first && skipped && lines[row].length === 0) break;
            row += dir;
            if (row < 0 || row > last) {
              if (left > 0) return null;
              row -= dir;
              break;
            }
          }
        }
        if (dir === 1 && row === last && lines[row].length > 0) return at(row, lines[row].length - 1, 'incl');
        return at(row, 0, 'excl');
      }

      case 'f':
      case 'F':
      case 't':
      case 'T':
        return m.arg === undefined ? null : this.findChar(cur, ln, m.key, m.arg, n, false);
      case ';':
      case ',': {
        if (!this.lastFind) return null;
        let key = this.lastFind.key;
        if (m.key === ',') key = key === key.toLowerCase() ? key.toUpperCase() : key.toLowerCase();
        return this.findChar(cur, ln, key, this.lastFind.ch, n, true);
      }

      case '%': {
        if (count !== null) return null; // N% (go to percentage) is not supported
        let c = cur.col;
        while (c < ln.length && !PERCENT_CHARS.includes(ln[c].ch)) c++;
        if (c >= ln.length) return null;
        const [open, close] = BRACKET_PAIRS[ln[c].ch];
        const hit =
          ln[c].ch === open
            ? scanFwd(lines, cur.line, c + 1, open, close)
            : scanBack(lines, cur.line, c - 1, open, close);
        return hit ? { pos: hit, kind: 'incl' } : null;
      }

      case '/':
      case 'n':
      case 'N': {
        const pat = m.search ?? this.lastSearch;
        if (!pat) {
          this.message = 'No previous search';
          return null;
        }
        if (m.search) this.lastSearch = { ...m.search }; // `.` re-running `d/foo` makes it the last search again
        const dir = m.key === 'N' ? (pat.dir === 1 ? -1 : 1) : pat.dir;
        const hit = findMatch(lines, cur, pat, dir, n);
        if (!hit) {
          this.message = `Pattern not found: ${pat.text}`;
          return null;
        }
        return { pos: hit, kind: 'excl' };
      }
      case '*':
      case '#': {
        const word = wordUnderCursor(ln, cur.col);
        if (!word) return null;
        const pat: SearchPattern = { text: word.text, whole: word.whole, dir: m.key === '*' ? 1 : -1 };
        this.lastSearch = pat;
        // search from the start of the word, so the word itself is not the first hit
        const hit = findMatch(lines, { line: cur.line, col: word.start }, pat, pat.dir, n);
        return hit ? { pos: hit, kind: 'excl' } : null;
      }
    }
    return null;
  }

  /** f / F / t / T on the cursor's row. `again` = a `;` / `,` repeat, where t / T step past an adjacent match. */
  private findChar(cur: Pos, ln: Line, key: string, ch: string, n: number, again: boolean): Target | null {
    const dir = key === 'f' || key === 't' ? 1 : -1;
    const till = key === 't' || key === 'T';
    let c = cur.col;
    if (again && till && n === 1) c += dir;
    for (let i = 0; i < n; i++) {
      do c += dir;
      while (c >= 0 && c < ln.length && ln[c].ch !== ch);
      if (c < 0 || c >= ln.length) return null;
    }
    if (till) c -= dir;
    return { pos: { line: cur.line, col: c }, kind: dir === 1 ? 'incl' : 'excl' };
  }

  // ── deletes ────────────────────────────────────────────────────────────────
  /** `d{motion}` (and x X D, which are `dl` `dh` `d$`). */
  private opMotion(field: FieldState, m: MotionCmd, count: number | null): DeleteResult | null {
    const t = this.motion(field, m, count, true);
    if (!t) return null;
    if (t.failed) {
      this.moveTo(field, t); // the operator is cancelled, but the cursor went as far as it could
      return null;
    }
    // The command ran, so `.` repeats it — even when, here, it covered no text.
    this.lastChange = { t: 'motion', m: { ...m }, count };
    const range = opRange(field.lines, field.caret, t);
    return range && this.remove(field, range, chordForMotion(m.key));
  }

  /** `dd` / `cc` / `S`: `count` whole rows from the cursor's row. */
  private opLines(field: FieldState, count: number): DeleteResult | null {
    const last = field.lines.length - 1;
    const from = field.caret.line;
    if (count > 1 && from === last) return null; // nothing below to count into
    this.lastChange = { t: 'lines', count };
    return this.remove(field, { kind: 'line', from, to: Math.min(last, from + count - 1) }, 'line');
  }

  /** `i` / `a` + object key completed: delete it (operator pending) or select it (Visual). */
  private runObject(field: FieldState, around: boolean, obj: string): VimOutcome {
    const count = this.takeCount() ?? 1;
    const pendingOp = this.op !== null;
    this.clearPending();
    if (pendingOp) {
      const deleted = this.opObject(field, around, obj, count);
      return deleted ? { deleted, repeatable: false } : NONE;
    }

    // Visual: select the object, or grow the selection to cover it.
    const lines = field.lines;
    const empty = comparePos(this.anchor, field.caret) === 0;
    if (obj === 'w' || obj === 'W') {
      const w = wordObject(lines, field.caret, around, obj === 'W', count, empty ? null : this.anchor);
      field.caret = { ...w.end };
      if (!w.failed) this.anchor = { ...w.start };
      if (this.mode === 'visual-line') this.mode = 'visual';
    } else {
      const range = textObject(lines, field.caret, around, obj, count);
      if (!range || range.kind === 'empty' || range.kind === 'failed') return NONE;
      let s: Pos;
      let e: Pos; // inclusive
      if (range.kind === 'char') {
        s = range.start;
        e =
          range.end.col > 0
            ? { line: range.end.line, col: range.end.col - 1 }
            : { line: range.end.line - 1, col: lines[range.end.line - 1].length };
      } else if (range.kind === 'line') {
        s = { line: range.from, col: 0 };
        e = { line: range.to, col: lines[range.to].length };
      } else {
        return NONE;
      }
      if (!empty) {
        const [a, h] = comparePos(this.anchor, field.caret) <= 0 ? [this.anchor, field.caret] : [field.caret, this.anchor];
        if (comparePos(a, s) < 0) s = a;
        if (comparePos(h, e) > 0) e = h;
      }
      const bracket = obj !== '"' && obj !== "'" && obj !== '`';
      if (bracket || this.mode === 'visual-line') this.mode = 'visual';
      this.anchor = { ...s };
      field.caret = { ...e };
    }
    this.clampCaret(field);
    this.goal = field.caret.col;
    return NONE;
  }

  private opObject(field: FieldState, around: boolean, obj: string, count: number): DeleteResult | null {
    const range = textObject(field.lines, field.caret, around, obj, count);
    if (!range) return null;
    if (range.kind !== 'failed') this.lastChange = { t: 'object', around, obj, count };
    if (range.kind === 'empty' || range.kind === 'failed') {
      // nothing to delete — like Vim, the cursor still goes there
      field.caret = { ...range.at };
      this.clampCaret(field);
      this.goal = field.caret.col;
      return null;
    }
    return this.remove(field, range as Range, 'word');
  }

  /** Delete the Visual selection. `lines` = whole rows (X), `eol` = block to the end of every row (block D). */
  private deleteVisual(field: FieldState, how: 'plain' | 'lines' | 'eol'): VimOutcome {
    const lines = field.lines;
    const a = this.anchor;
    const h = field.caret;
    const top = Math.min(a.line, h.line);
    const bottom = Math.max(a.line, h.line);
    const rows = bottom - top + 1;
    const toEol = this.goal === Infinity; // `$` was the last horizontal motion

    let range: Range;
    let change: Change;
    if (this.mode === 'visual-line' || how === 'lines') {
      range = { kind: 'line', from: top, to: bottom };
      change = { t: 'visual', shape: 'line', lines: rows, width: 0, eol: false };
    } else if (this.mode === 'visual-block') {
      const left = Math.min(a.col, h.col);
      const eol = toEol || how === 'eol';
      const width = Math.max(a.col, h.col) + 1 - left;
      range = { kind: 'block', top, bottom, left, right: eol ? Infinity : left + width };
      change = { t: 'visual', shape: 'block', lines: rows, width, eol };
    } else {
      const [s, e] = comparePos(a, h) <= 0 ? [a, h] : [h, a];
      range = charSpan(lines, s, e);
      change = { t: 'visual', shape: 'char', lines: rows, width: rows === 1 ? e.col - s.col + 1 : e.col + 1, eol: toEol };
    }
    this.mode = 'normal';
    this.clearPending();
    this.lastChange = change;
    return { deleted: this.remove(field, range, 'selection'), repeatable: false };
  }

  /** `.` — run the last delete command again at the cursor. A count replaces the original one. */
  private repeat(field: FieldState, count: number | null): DeleteResult | null {
    const c = this.lastChange;
    if (!c) return null;
    switch (c.t) {
      case 'motion':
        return this.opMotion(field, c.m, count ?? c.count);
      case 'lines':
        return this.opLines(field, count ?? c.count);
      case 'object':
        return this.opObject(field, c.around, c.obj, count ?? c.count);
      case 'visual': {
        // The same amount of text as the selection had, measured from the cursor.
        const lines = field.lines;
        const cur = field.caret;
        const bottom = Math.min(lines.length - 1, cur.line + c.lines - 1);
        let range: Range;
        if (c.shape === 'line') {
          range = { kind: 'line', from: cur.line, to: bottom };
        } else if (c.shape === 'block') {
          range = { kind: 'block', top: cur.line, bottom, left: cur.col, right: c.eol ? Infinity : cur.col + c.width };
        } else {
          // a span that runs past the end of its last row takes the row break, like the selection would
          const endCol = c.eol ? Infinity : (c.lines === 1 ? cur.col : 0) + c.width - 1;
          range = charSpan(lines, { ...cur }, { line: bottom, col: endCol });
        }
        return this.remove(field, range, 'selection');
      }
    }
  }

  /** Remove a range, then put the cursor where Vim leaves it. */
  private remove(field: FieldState, range: Range, chord: Chord): DeleteResult {
    let result: DeleteResult;
    if (range.kind === 'char') {
      result = deleteRange(field, range.start, range.end, chord);
    } else if (range.kind === 'line') {
      result = deleteRows(field, range.from, range.to, chord);
      field.caret.col = firstNonBlank(field.lines[field.caret.line]);
    } else {
      result = deleteColumns(field, range.top, range.bottom, range.left, range.right, chord);
    }
    field.select = null;
    this.clampCaret(field);
    this.goal = field.caret.col;
    return result;
  }
}

/**
 * A charwise Visual selection `s..e` (inclusive) as a half-open range. An end on
 * the end-of-row position (an empty row, or past the last character) takes the
 * row break too, so the next row joins — as in Vim.
 */
function charSpan(lines: Lines, s: Pos, e: Pos): Range {
  const len = lines[e.line].length;
  let end: Pos;
  if (e.col >= len) end = e.line < lines.length - 1 ? { line: e.line + 1, col: 0 } : { line: e.line, col: len };
  else end = { line: e.line, col: e.col + 1 };
  return { kind: 'char', start: { ...s }, end };
}
