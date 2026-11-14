/**
 * Control modes (#8). A mode is a control scheme: its own keymap over the
 * shared field actions, its own best score, and its own help text. The field,
 * the rules and the scoring are the same in every mode.
 *
 * This module is the registry: names, availability, the start-screen key help,
 * the full key list for the in-game help screen (F1), and the remembered choice
 * (localStorage).
 */

export type Mode = 'standard' | 'vim';

/** One titled block of the help screen: `[keys, what they do]` rows. */
export interface HelpSection {
  title: string;
  rows: [keys: string, what: string][];
}

export interface ModeInfo {
  id: Mode;
  /** Name shown on the start screen and in the HUD. */
  label: string;
  /** False while a mode is listed but not playable yet. */
  available: boolean;
  /** Start-screen key help for this mode, one centred row per entry. */
  startHelp: string[];
  /** Every key the mode supports, for the help screen (F1). */
  help: HelpSection[];
}

/** Keys that belong to the game rather than to a mode — listed on every help screen. */
const GAME_KEYS: HelpSection = {
  title: 'GAME',
  rows: [
    ['Enter', 'start · next stage · restart'],
    ['F1', 'this help (pauses the clock, hides the board)'],
    ['F2', 'mute / unmute'],
    ['Esc', 'end screen: back to the menu (change mode)'],
    ['1  2  Tab', 'start screen: pick the mode'],
  ],
};

const STANDARD_HELP: HelpSection[] = [
  {
    title: 'MOVE  (hold to repeat)',
    rows: [
      ['← →', 'one character'],
      ['⌥← ⌥→', 'word boundary (whitespace)'],
      ['⌘← ⌘→', 'line start / end'],
      ['↑ ↓', 'line up / down, keeping the column'],
      ['⌘↑ ⌘↓', 'first / last line'],
    ],
  },
  {
    title: 'SELECT  (hold to repeat)',
    rows: [
      ['⇧ + any move', 'extend the selection'],
      ['⌥↑ ⌥↓', 'move the row (or the selected rows) up / down'],
    ],
  },
  {
    title: 'DELETE  (one per press)',
    rows: [
      ['⌫   ⌦', '×1    one character left / right'],
      ['⌥⌫  ⌥⌦', '×1.5  word left / right'],
      ['⌘⌫  ⌘⌦', '×2    to line start / end'],
      ['any of them', '×2    with a selection: delete the selection'],
    ],
  },
  {
    title: 'GAME',
    rows: [...GAME_KEYS.rows, ['M', 'mute / unmute (same as F2)'], ['Space', 'same as Enter']],
  },
];

const VIM_HELP: HelpSection[] = [
  {
    title: 'MODES',
    rows: [
      ['v', 'Visual (characters)'],
      ['V', 'Visual Line'],
      ['Ctrl-v', 'Visual Block'],
      ['Esc  Ctrl-[  Ctrl-c', 'back to Normal · cancel a half-typed command'],
    ],
  },
  {
    title: 'MOVE  (hold to repeat · all take a count)',
    rows: [
      ['h j k l  ← ↓ ↑ →', 'left · down · up · right'],
      ['w b e ge', 'word: next start · last start · end · last end'],
      ['W B E gE', 'the same for WORDS (anything between spaces)'],
      ['0  ^  $', 'row start · first non-blank · row end'],
      ['gg  G  {n}G', 'first row · last row · row n'],
      ['H  M  L', 'top · middle · bottom row of the field'],
      ['{  }', 'previous / next blank row'],
      ['f F t T {char}', 'onto / before a character in the row'],
      [';  ,', 'repeat the last f F t T · the other way'],
      ['%', 'matching ( ) [ ] { }'],
    ],
  },
  {
    title: 'SEARCH',
    rows: [
      ['/text  ?text  Enter', 'search forward / backward (plain text, wraps)'],
      ['n  N', 'next match · the other way'],
      ['*  #', 'next / previous occurrence of the word under the cursor'],
    ],
  },
  {
    title: 'DELETE  (one command = one action · × = score multiplier)',
    rows: [
      ['x  X  Del  dh  dl', '×1    character under / before the cursor'],
      ['d{motion}', '×1.5  dw  de  db  dt)  d;  d%  d/foo  dn …'],
      ['d{object}', '×1.5  diw  daw  di(  da"  …'],
      ['dd  D', '×2    whole row · to the row end'],
      ['d$ d0 d^ dj dk dG dgg d{ d}', '×2    line-sized motions (also dH dM dL)'],
      ['.', 'repeat the last delete (same multiplier)'],
      ['c  s  C  S', 'delete only: same as d  x  D  dd'],
    ],
  },
  {
    title: 'TEXT OBJECTS  (after d, or in Visual)',
    rows: [
      ['iw aw  iW aW', 'inner word / a word with its space'],
      ['i" a"  i\' a\'  i` a`', 'inside / around quotes'],
      ['i( a(  i[ a[  i{ a{  i< a<', 'inside / around brackets (also ) ] } > b B)'],
    ],
  },
  {
    title: 'COUNTS',
    rows: [['3w  5dd  d2w  2d3w  4x  3.', 'a number repeats the motion or the command']],
  },
  {
    title: 'VISUAL  (v  V  Ctrl-v)',
    rows: [
      ['motions · objects · search', 'grow the selection'],
      ['d  x  Del  (c  s)', '×2    delete the selection'],
      ['X  (S  R)', '×2    delete the selected rows (block: X = d)'],
      ['D  (C)', '×2    rows — in a block, to the end of each row'],
      ['o  O', 'jump to the other end / corner'],
    ],
  },
  {
    title: 'GAME',
    rows: [
      ...GAME_KEYS.rows,
      ['M  Enter  Space', 'belong to Vim while playing — mute is F2'],
    ],
  },
  {
    title: 'NOT IN THIS VIM',
    rows: [
      ['i a o r J ~ …', 'no Insert mode: typing keys do nothing'],
      ['u  Ctrl-r', 'no undo'],
      ['y p " q @ m \'', 'no yank / put, registers, macros, marks'],
      [':', 'no command line · search is plain text, not regex'],
    ],
  },
];

/** Every mode, in picker order — the start screen picks them with 1, 2, … */
export const MODES: readonly ModeInfo[] = [
  {
    id: 'standard',
    label: 'STANDARD',
    available: true,
    startHelp: [
      'move  ← →   ·  word  ⌥← ⌥→   ·  line  ⌘← ⌘→   ·  ↑ ↓',
      'delete left  ⌫  ⌥⌫  ⌘⌫     ·     delete right  ⌦  ⌥⌦  ⌘⌦',
      'select  ⇧ + move    ·    move row  ⌥↑ ⌥↓    ·    mute  M    ·    all keys  F1',
    ],
    help: STANDARD_HELP,
  },
  {
    id: 'vim',
    label: 'VIM',
    available: true,
    startHelp: [
      'move  h j k l  ·  w b e  ·  0 ^ $  ·  gg G  ·  f t ; ,  ·  %  ·  / n *',
      'delete  x  ·  dw  diw  di(  ·  dd  D  ·  counts  3x  d2w  ·  repeat  .',
      'select  v  V  Ctrl-v  then  d    ·    no insert, no undo    ·    mute  F2    ·    all keys  F1',
    ],
    help: VIM_HELP,
  },
];

export const DEFAULT_MODE: Mode = 'standard';

export function modeInfo(mode: Mode): ModeInfo {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

// ── remembered choice ───────────────────────────────────────────────────────
const MODE_KEY = 'redline.mode';

/** The mode picked last time, or the default when none is stored / it is not playable. */
export function loadMode(): Mode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    const found = MODES.find((m) => m.id === raw);
    if (found?.available) return found.id;
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to default
  }
  return DEFAULT_MODE;
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore persistence failures
  }
}
