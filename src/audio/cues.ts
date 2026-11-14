/**
 * What happened → which sound (#14). Pure mappings from the game's actions to
 * SFX cues, shared by both control modes, so the wiring is testable without
 * audio. The game decides *when*; this decides *what*.
 */
import { type Chord, type MoveAction, type Pos } from '../state.ts';
import { type VimMode } from '../vim.ts';
import { type SfxId, type SfxParams } from './sfx.ts';

export interface Cue {
  id: SfxId;
  params?: SfxParams;
  /** Seconds after "now". */
  delay?: number;
}

// ── caret ────────────────────────────────────────────────────────────────────
/** Standard mode: the sound of a caret move, by its kind. */
export function moveCue(action: MoveAction): Cue {
  switch (action) {
    case 'char-left':
    case 'char-right':
      return { id: 'moveChar' };
    case 'word-left':
    case 'word-right':
      return { id: 'moveWord' };
    case 'line-start':
    case 'doc-start':
      return { id: 'moveLineEdge', params: { dir: -1 } };
    case 'line-end':
    case 'doc-end':
      return { id: 'moveLineEdge', params: { dir: 1 } };
    case 'line-up':
      return { id: 'moveLine', params: { dir: -1 } };
    case 'line-down':
      return { id: 'moveLine', params: { dir: 1 } };
  }
}

// ── deletes ──────────────────────────────────────────────────────────────────
export interface DeleteFacts {
  chord: Chord;
  /** Characters removed, spaces included. */
  removed: number;
  /** Rows that vanished (joined away or deleted). */
  rowsRemoved: number;
  /** Distinct rows that lost a coloured block. */
  rowsTouched: number;
}

/** A row closing up is heard just after the delete that emptied it. */
export const ROW_COLLAPSE_DELAY = 0.09;

/**
 * The sound of a delete. One that takes characters from several rows is the big
 * chord; otherwise it is the chord's own sound, scaled by the characters
 * removed. A row closing up adds the collapse — on its own when the delete
 * removed no characters at all (joining two rows).
 */
export function deleteCues(f: DeleteFacts): Cue[] {
  if (f.removed <= 0) return f.rowsRemoved > 0 ? [{ id: 'rowCollapse' }] : [];
  const size = { size: f.removed };
  if (f.rowsRemoved >= 2 || f.rowsTouched >= 2) return [{ id: 'delBig', params: size }];
  const cues: Cue[] = [];
  switch (f.chord) {
    case 'char':
      cues.push({ id: 'delChar' });
      break;
    case 'word':
      cues.push({ id: 'delWord', params: size });
      break;
    case 'line':
      cues.push({ id: 'delLine', params: size });
      break;
    case 'selection':
      cues.push({ id: 'delSelection', params: size });
      break;
  }
  if (f.rowsRemoved === 1) cues.push({ id: 'rowCollapse', delay: ROW_COLLAPSE_DELAY });
  return cues;
}

// ── Vim ──────────────────────────────────────────────────────────────────────
/** What the Vim engine looked like before / after one key (from `Vim.status()` and the field). */
export interface VimSnapshot {
  mode: VimMode;
  /** Keys of the unfinished command. */
  pending: string;
  /** Search prompt text, or null. */
  prompt: string | null;
  /** Flash pattern being typed, or null. */
  flash: string | null;
  /** One-shot message from the last key (`Pattern not found: x`), else ''. */
  message: string;
  caret: Pos;
}

const isPending = (s: VimSnapshot): boolean => s.pending !== '' || s.prompt !== null || s.flash !== null;
const LINE_EDGE_KEYS = new Set(['0', '^', '$', '_', '|']);

/**
 * The sound of one Vim key that did not delete (a delete has its own sound),
 * read off the engine's state before and after it:
 *  - the mode changed → vimMode (Visual, Visual Line and Visual Block all sound as "visual")
 *  - the engine reported a failure (no match, pattern not found) → vimInvalid
 *  - a command is now half-typed (operator, count, prefix, flash / search text) → vimPending
 *  - the rows moved (Alt-j / Alt-k) → rowMove
 *  - the cursor moved → selExtend in a Visual mode, else the move sound for the distance
 *  - Esc that cancelled a half-typed command → selClear; Esc with nothing to cancel is silent
 *  - anything else did nothing: an ignored key or a motion that could not move → vimInvalid
 */
export function vimCue(before: VimSnapshot, after: VimSnapshot, key: string): Cue | null {
  if (after.mode !== before.mode) {
    return { id: 'vimMode', params: { mode: after.mode === 'normal' ? 'normal' : 'visual' } };
  }
  if (after.message !== '') return { id: 'vimInvalid' };
  if (
    isPending(after) &&
    (after.pending !== before.pending || after.prompt !== before.prompt || after.flash !== before.flash)
  ) {
    return { id: 'vimPending' };
  }
  const dLine = after.caret.line - before.caret.line;
  const dCol = after.caret.col - before.caret.col;
  if (dLine !== 0 || dCol !== 0) {
    if (key === '<A-j>' || key === '<A-k>') return { id: 'rowMove' };
    if (after.mode !== 'normal') return { id: 'selExtend' };
    if (dLine !== 0) return { id: 'moveLine', params: { dir: dLine > 0 ? 1 : -1 } };
    if (LINE_EDGE_KEYS.has(key)) return { id: 'moveLineEdge', params: { dir: dCol > 0 ? 1 : -1 } };
    return { id: Math.abs(dCol) === 1 ? 'moveChar' : 'moveWord' };
  }
  if (key === '<Esc>') return isPending(before) ? { id: 'selClear' } : null;
  return { id: 'vimInvalid' };
}

// ── clock ────────────────────────────────────────────────────────────────────
/** The low-time warning sounds once per second over the last five seconds of a stage. */
export const LOW_TIME_SECONDS = 5;

/** Whole seconds left, rounded up (4.2 s → 5). */
export function secondsLeft(remainingMs: number): number {
  return Math.ceil(Math.max(0, remainingMs) / 1000);
}

/**
 * Whether the warning should sound now: the countdown just crossed into a new
 * whole second (`prev` → `now`, both from `secondsLeft`) inside the last five.
 * Zero is "time up", which has its own sound.
 */
export function lowTimeTick(prevSeconds: number, nowSeconds: number): boolean {
  return nowSeconds < prevSeconds && nowSeconds >= 1 && nowSeconds <= LOW_TIME_SECONDS;
}
