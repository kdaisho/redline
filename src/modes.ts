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
    ['F2', 'mute / unmute everything'],
    ['F3 F4 · F6 F7', 'volume down / up: music · sound effects'],
    ['⇧F3 · ⇧F6', 'music off / on · sound effects off / on'],
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
      ['0  ^  $  _  g_  {n}|', 'row start · non-blank · end · column n'],
      ['gg  G  {n}G', 'first row · last row · row n'],
      ['-  +  Enter', 'first non-blank of the row above / below'],
      ['H  M  L', 'top · middle · bottom row of the field'],
      ['{  }', 'previous / next blank row'],
      ['f F t T {char}', 'onto / before a character, across rows'],
      [';  ,   or  f  F  again', 'its next · previous match (t T likewise)'],
      ['%', 'matching ( ) [ ] { }'],
      ['Alt-j  Alt-k', 'move the row (Visual: the rows) down / up'],
    ],
  },
  {
    title: 'FLASH  (LazyVim s)',
    rows: [
      ['s{text}', 'a label appears after every match'],
      ['{label}   Enter', 'jump to that match · to the next one'],
      ['Backspace  Esc', 'edit the text · cancel'],
      ['ds{text}{label}', '×1.5  delete through the match\'s 1st char'],
      ['dr{text}{label}{motion}', '×1.5  delete over there, cursor returns'],
    ],
  },
  {
    title: 'SEARCH',
    rows: [
      ['/text  ?text  Enter', 'search forward / backward (plain text, wraps)'],
      ['n  N', 'next match forward · backward (always)'],
      ['*  #', 'next / previous match of the word at cursor'],
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
      ['c  C', 'delete only: same as d  D'],
    ],
  },
  {
    title: 'TEXT OBJECTS  (after d, or in Visual · mini.ai)',
    rows: [
      ['iw aw  iW aW  ip ap', 'word · WORD · paragraph (to a blank row)'],
      ['i( a(  i[ a[  i{ a{  i< a<', 'brackets: i( trims spaces, i) keeps them'],
      ['ib ab   iq aq', 'any ( [ { pair  ·  any " \' ` quotes'],
      ['i" a"  i\' a\'  i` a`', 'inside quotes / with the quotes'],
      ['ia aa', 'argument / with its comma'],
      ['iu au  iU aU', 'call f(…): inside ( ) / all (U: no dots)'],
      ['id  ie  ig ag', 'digits · camelCase part · whole field'],
      ['i_ a_  i, a,  …', 'between two of any punctuation mark'],
      ['in( il(  an( al(  …', 'the next / last one, for any object'],
      ['g[(  g](  …', 'to the left / right edge of an object'],
    ],
  },
  {
    title: 'COUNTS',
    rows: [['3w  5dd  d2w  2d3w  4x  3.', 'a number repeats the motion or the command']],
  },
  {
    title: 'VISUAL  (v  V  Ctrl-v)',
    rows: [
      ['motions · objects · search · s', 'grow the selection'],
      ['d  x  Del  (c  s)', '×2    delete the selection'],
      ['X', '×2    delete the selected rows (block: X = d)'],
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
      ['S  R  Ctrl-Space  if ic io it', 'treesitter objects: no syntax tree here'],
      ['Space…  ]d  gd  K  Ctrl-w', 'LazyVim leader / LSP / window keys'],
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
      'move  h j k l  ·  w b e  ·  0 ^ $  ·  gg G  ·  f t ; ,  ·  %  ·  / n *  ·  s flash',
      'delete  x  ·  dw  diw  di(  dia  ·  dd  D  ·  counts  3x  d2w  ·  repeat  .',
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
