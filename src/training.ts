/**
 * Lessons (#44, #45): short drills that each teach one technique on a small
 * hand-built board. A lesson plays like free practice (#43) — no clock, mistakes
 * are counted, undo and the readout are on — with a header that explains the
 * technique and a **target**: clear the board in at most that many delete
 * commands with no mistake to earn a ★. The target never blocks passing.
 *
 * Every lesson carries the intended solution (`solution`, engine key names);
 * `training.test.ts` plays it and checks it clears the board on target.
 */
import { type Line, type Block, type Pos } from './state.ts';
import { type Mode } from './modes.ts';

export interface Lesson {
  id: string;
  title: string;
  /** One or two short lines under the title. */
  explain: string[];
  /** The keys the lesson is about, as a hint. */
  keys: string;
  /** Rows in a tiny markup: text is red, «text» is blue, a space is a space. */
  board: string[];
  /** Where the cursor starts (default: the first character). */
  caret?: Pos;
  /** Delete commands for a ★ (with no mistake). */
  target: number;
  /** The intended keys — Vim engine key names (`<CR>`, `<C-v>`, `<A-j>`), or Standard actions. */
  solution: string[];
}

/** Build a lesson row from the markup: red text, «blue text», spaces. */
export function parseRow(src: string): Line {
  const out: Block[] = [];
  let blue = false;
  for (const ch of src) {
    if (ch === '«') blue = true;
    else if (ch === '»') blue = false;
    else out.push(ch === ' ' ? { color: null, ch } : { color: blue ? 'blue' : 'red', ch });
  }
  return out;
}

export function lessonBoard(lesson: Lesson): Line[] {
  return lesson.board.map(parseRow);
}

/** Split a key string into engine keys: `d/foo<CR>` → d / f o o <CR>. */
export function keys(str: string): string[] {
  return str.match(/<[^>]+>|./gu) ?? [];
}

const VIM: Lesson[] = [
  {
    id: 'vim-x',
    title: 'ONE CHARACTER',
    explain: ['x deletes the character under the cursor.', 'h j k l move left, down, up, right.'],
    keys: 'x   h j k l',
    board: ['«user»#«.name»', '«x = »%«y»'],
    target: 2,
    solution: keys('llllxjx'),
  },
  {
    id: 'vim-words',
    title: 'WORDS',
    explain: ['w jumps to the next word, b back to the last one, e to its end.', 'dw deletes up to the next word; de stops at the end of this one.'],
    keys: 'w b e   dw de',
    board: ['«keep» crash «ok»', '«go» panic'],
    target: 2,
    solution: keys('wdwjbde'),
  },
  {
    id: 'vim-iw',
    title: 'INSIDE A WORD',
    explain: ['diw deletes the word under the cursor, from anywhere in it.', 'daw takes the word and a space with it.'],
    keys: 'diw  daw',
    board: ['«a» oops «b»', '«x(»junk«)»'],
    caret: { line: 0, col: 3 },
    target: 2,
    solution: keys('dawjdiw'),
  },
  {
    id: 'vim-rows',
    title: 'ROWS',
    explain: ['dd deletes the whole row, wherever the cursor is.', 'D deletes from the cursor to the end of the row (so does d$).'],
    keys: 'dd   D  d$',
    board: ['junk.dump(all)', '«keep()» oops.drop(x)', 'kill(0); exit(1)'],
    target: 3,
    solution: keys('ddwwDjdd'),
  },
  {
    id: 'vim-counts',
    title: 'COUNTS',
    explain: ['A number in front repeats: 3x, d2w, 2dd.', 'One command, however big — it still counts as one delete.'],
    keys: '3x  d2w  2dd',
    board: ['«ab»xyz«cd»', '«go» one two «end»', 'trash(1)', 'trash(2)'],
    caret: { line: 0, col: 2 },
    target: 3,
    solution: keys('3xjwd2wj2dd'),
  },
  {
    id: 'vim-find',
    title: 'FIND A CHARACTER',
    explain: ['f{char} jumps onto the next {char}, t{char} to just before it.', 'df, deletes through a comma; dt) up to a bracket.'],
    keys: 'f t  ; ,   df,  dt)',
    board: ['«call(»junk, «a)»', '«f(»bad.code«)»'],
    target: 2,
    solution: keys('fjdf,<Esc>fbdt)'),
  },
  {
    id: 'vim-percent',
    title: 'MATCHING BRACKETS',
    explain: ['% jumps between a bracket and its partner.', 'd% on a bracket deletes the whole group.'],
    keys: '%   d%',
    board: ['«run»(stuff, more) «ok»', '«arr»[1, 2, 3]«;»'],
    caret: { line: 0, col: 3 },
    target: 2,
    solution: keys('d%jd%'),
  },
  {
    id: 'vim-brackets',
    title: 'INSIDE BRACKETS AND QUOTES',
    explain: ['di( deletes inside the brackets; da( takes the brackets too.', 'Works for [ { < " \' ` as well, from anywhere on the row.'],
    keys: 'di(  da"  da[',
    board: ['«f(»a, b«)»', '«say »"hello there"', '«x = »[junk]'],
    target: 3,
    solution: keys('di(jda"jda['),
  },
  {
    id: 'vim-miniai',
    title: 'ARGUMENTS AND CALLS',
    explain: ['daa deletes an argument and its comma.', 'dau deletes a whole call name(...); diu just what is inside.'],
    keys: 'daa  dau  diu',
    board: ['«f(»junk, «b)»', '«print(»noise(1)«)»', '«run(»stuff«)»'],
    caret: { line: 0, col: 2 },
    target: 3,
    solution: keys('daajwwdaujdiu'),
  },
  {
    id: 'vim-visual',
    title: 'VISUAL MODE',
    explain: ['v starts a selection, motions grow it, d deletes it.', 'V selects whole rows.'],
    keys: 'v  V  then d',
    board: ['«keep» bad stuff here «ok»', 'junk(1)', 'junk(2)', 'junk(3)'],
    target: 2,
    solution: keys('wveeedjVjjd'),
  },
  {
    id: 'vim-block',
    title: 'VISUAL BLOCK',
    explain: ['Ctrl-v selects a rectangle: the same columns on every row.'],
    keys: 'Ctrl-v  then d',
    board: ['xx«=a;»', 'xx«=b;»', 'xx«=c;»'],
    target: 1,
    solution: keys('<C-v>jjld'),
  },
  {
    id: 'vim-search',
    title: 'SEARCH',
    explain: ['/text Enter jumps to the next match; n goes on to the one after.', 'd/text Enter deletes up to the match.'],
    keys: '/text  n  N   d/text',
    board: ['«one» bug «two»', '«three» bug «four»', 'trash trash trash «end»'],
    target: 3,
    solution: keys('/bug<CR>dawndawj0d/end<CR>'),
  },
  {
    id: 'vim-flash',
    title: 'FLASH JUMP',
    explain: ['s then a few letters: every match gets a label; press it to jump.', 'ds{text}{label} deletes through the first character of the match.'],
    keys: 's{text}{label}   ds',
    board: ['«keep keep keep» zap «keep»', 'junk junk;«ok»'],
    target: 2,
    solution: keys('szsdawj0ds;a'),
  },
  {
    id: 'vim-repeat',
    title: 'REPEAT AND MOVE ROWS',
    explain: ['. repeats the last delete. Alt-j / Alt-k move the row down / up:', 'move the blue row out of the way, then one 3dd.'],
    keys: '.   Alt-j  Alt-k',
    board: ['«a» bad1 bad2 bad3 «b»', 'junk(1)', '«keep()»', 'junk(2)', 'junk(3)'],
    target: 4,
    solution: keys('wdw..jj<A-j><A-j>kkk3dd'),
  },
];

export const LESSONS: Record<Mode, Lesson[]> = {
  standard: [],
  vim: VIM,
};

// ── progress ────────────────────────────────────────────────────────────────
/** Per lesson: passed, or passed on target (★). */
export type Mark = 'pass' | 'star';
export type Progress = Record<string, Mark>;

const progressKey = (mode: Mode): string => `redline.training.${mode}`;

export function loadProgress(mode: Mode): Progress {
  try {
    const raw = localStorage.getItem(progressKey(mode));
    if (raw) {
      const p = JSON.parse(raw) as unknown;
      if (p && typeof p === 'object') return p as Progress;
    }
  } catch {
    // localStorage unavailable — no marks
  }
  return {};
}

/** Record a cleared lesson. A ★ is never downgraded to a plain pass. */
export function recordLesson(mode: Mode, id: string, star: boolean): Progress {
  const p = loadProgress(mode);
  if (star) p[id] = 'star';
  else if (p[id] !== 'star') p[id] = 'pass';
  try {
    localStorage.setItem(progressKey(mode), JSON.stringify(p));
  } catch {
    // ignore persistence failures
  }
  return p;
}
