/**
 * Free practice (#43): the pure parts. A practice board has no clock limit and
 * mistakes never end it; the player can undo, and a readout under the HUD says
 * what the last command did. This module holds the board snapshots behind undo,
 * the readout text, and which board comes next.
 */
import { type FieldState, type DeleteResult, type Chord } from './state.ts';
import { type DeleteAction } from './input.ts';
import { MAX_STAGE_INDEX } from './stages.ts';

// ── undo ────────────────────────────────────────────────────────────────────
/** A field frozen in time: deep copies, so later deletes (which mutate blocks) can't reach it. */
export type Snapshot = FieldState;

export function snapshot(field: FieldState): Snapshot {
  return {
    lines: field.lines.map((ln) => ln.map((b) => ({ ...b }))),
    caret: { ...field.caret },
    select: field.select ? { anchor: { ...field.select.anchor }, head: { ...field.select.head } } : null,
  };
}

/** Put `snap` back into `field` in place (the game keeps one field object per board). */
export function restore(field: FieldState, snap: Snapshot): void {
  const copy = snapshot(snap); // the stack entry stays reusable
  field.lines = copy.lines;
  field.caret = copy.caret;
  field.select = copy.select;
}

/** The board's text and colours as one string — two fields with the same key look the same. */
export function boardKey(field: FieldState): string {
  return field.lines.map((ln) => ln.map((b) => (b.color === 'red' ? 'r' : b.color === 'blue' ? 'b' : '_') + b.ch).join('')).join('\n');
}

/** Undo history for one board. Unbounded: a practice board is small. */
export class UndoStack {
  private stack: Snapshot[] = [];

  /** Run `change` on the field; if it changed the board, remember the board as it was before. */
  record<T>(field: FieldState, change: () => T): T {
    const before = snapshot(field);
    const key = boardKey(field);
    const out = change();
    if (boardKey(field) !== key) this.stack.push(before);
    return out;
  }

  /** Restore the board before the last change. False when there is nothing to undo. */
  undo(field: FieldState): boolean {
    const snap = this.stack.pop();
    if (!snap) return false;
    restore(field, snap);
    return true;
  }

  get size(): number {
    return this.stack.length;
  }

  clear(): void {
    this.stack = [];
  }
}

// ── readout ─────────────────────────────────────────────────────────────────
const CHORD_LABEL: Record<Chord, string> = {
  char: 'CHAR X1',
  word: 'WORD X1.5',
  line: 'LINE X2',
  selection: 'SELECTION X2',
};

/** What one delete did, e.g. `14 RED · WORD X1.5` or `3 RED + 2 BLUE -- MISTAKE`. */
export function describeDelete(result: DeleteResult): string {
  if (result.blue > 0) {
    const red = result.red > 0 ? `${result.red} RED + ` : '';
    return `${red}${result.blue} BLUE -- MISTAKE`;
  }
  if (result.red === 0) return 'NOTHING RED';
  return `${result.red} RED · ${CHORD_LABEL[result.chord]}`;
}

/** Standard mode's delete keys as the player pressed them. */
const STANDARD_KEYS: Record<DeleteAction, string> = {
  backward: '⌫',
  'word-left': '⌥⌫',
  'to-line-start': '⌘⌫',
  forward: '⌦',
  'word-right': '⌥⌦',
  'to-line-end': '⌘⌦',
};

export function standardKeys(action: DeleteAction, hadSelection: boolean): string {
  return hadSelection ? `${STANDARD_KEYS[action]} ON SELECTION` : STANDARD_KEYS[action];
}

/** One Vim engine key name as it reads in the readout: `<CR>` → `⏎`, space → `␣`. */
export function vimKeyLabel(key: string): string {
  switch (key) {
    case ' ':
      return '␣';
    case '<CR>':
      return '⏎';
    case '<BS>':
      return '⌫';
    case '<Esc>':
      return '⎋';
    case '<C-v>':
      return '^V';
    case '<A-j>':
      return '⌥j';
    case '<A-k>':
      return '⌥k';
    case '<Left>':
      return '←';
    case '<Right>':
      return '→';
    case '<Up>':
      return '↑';
    case '<Down>':
      return '↓';
    case '<Del>':
      return '⌦';
    default:
      return key;
  }
}

// ── boards ──────────────────────────────────────────────────────────────────
/** A practice board: which stage's layout, and the generator seed (0 = the shipped board). */
export interface PracticeBoard {
  index: number;
  seed: number;
}

/** The stage after `index`, wrapping from stage 50 back to stage 1. */
export function nextIndex(index: number, dir: 1 | -1): number {
  const n = MAX_STAGE_INDEX + 1;
  return (((index + dir) % n) + n) % n;
}

/** A fresh generated board: a stage past the hand-built intro, with a seed no run uses. */
export function randomBoard(rand: () => number = Math.random): PracticeBoard {
  const first = 5; // stages 1–5 are hand-authored and never vary
  return {
    index: first + Math.floor(rand() * (MAX_STAGE_INDEX + 1 - first)),
    seed: 1 + Math.floor(rand() * 0x7ffffffe),
  };
}
