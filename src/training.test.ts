import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createField, redsRemaining, isMistake, applyMove, applySelect, standardDelete, moveRows, type FieldState } from './state.ts';
import { Vim } from './vim.ts';
import { createStandardKeymap } from './keymaps/standard.ts';
import {
  LESSONS,
  lessonBoard,
  parseRow,
  keys,
  chords,
  chordEvent,
  loadProgress,
  recordLesson,
  type Lesson,
} from './training.ts';

function field(lesson: Lesson): FieldState {
  const f = createField(lessonBoard(lesson));
  if (lesson.caret) f.caret = { ...lesson.caret };
  return f;
}

/** Play a Vim lesson's solution: the deletes it took, any mistakes, and what is left. */
function playVim(lesson: Lesson) {
  const f = field(lesson);
  const vim = new Vim();
  let deletes = 0;
  let mistakes = 0;
  const trace: string[] = [];
  for (const k of lesson.solution) {
    if (k === '<Esc>') {
      // the game's rule (game.ts onVimKey): Esc with nothing to cancel opens the pause menu
      const st = vim.status();
      if (st.mode === 'normal' && st.pending === '' && !st.operator && st.prompt === null && st.flash === null)
        throw new Error(`${lesson.id}: <Esc> here would open the menu, not reach Vim`);
    }
    const out = vim.key(f, k);
    if (out.deleted && (out.deleted.red > 0 || out.deleted.blue > 0)) {
      deletes++;
      if (isMistake(out.deleted)) mistakes++;
      trace.push(`${k}: -${out.deleted.red}r -${out.deleted.blue}b`);
    }
  }
  const rows = f.lines.map((ln) => ln.map((b) => b.ch).join(''));
  return { deletes, mistakes, reds: redsRemaining(f), rows, trace };
}

/** Play a Standard lesson's chords through the real keymap and the same field actions as the game. */
function playStandard(lesson: Lesson) {
  const f = field(lesson);
  let goal = f.caret.col;
  let deletes = 0;
  let mistakes = 0;
  const trace: string[] = [];
  const keymap = createStandardKeymap({
    move: (a) => (goal = applyMove(f, goal, a)),
    select: (a) => (goal = applySelect(f, goal, a)),
    delete: (a) => {
      const r = standardDelete(f, a);
      goal = f.caret.col;
      if (r.red > 0 || r.blue > 0) {
        deletes++;
        if (isMistake(r)) mistakes++;
        trace.push(`${a}: -${r.red}r -${r.blue}b`);
      }
    },
    moveRow: (d) => {
      if (moveRows(f, d)) goal = f.caret.col;
    },
    undo: () => {},
  });
  for (const c of lesson.solution) {
    const action = keymap.resolve(chordEvent(c) as KeyboardEvent);
    if (!action) throw new Error(`${lesson.id}: ${c} does nothing`);
    action.fire();
  }
  const rows = f.lines.map((ln) => ln.map((b) => b.ch).join(''));
  return { deletes, mistakes, reds: redsRemaining(f), rows, trace };
}

describe('lesson markup', () => {
  it('reads red text, «blue» text and spaces', () => {
    const row = parseRow('ab «c d»e');
    expect(row.map((b) => b.color)).toEqual(['red', 'red', null, 'blue', null, 'blue', 'red']);
    expect(row.map((b) => b.ch).join('')).toBe('ab c de');
  });

  it('expands Standard chords', () => {
    expect(chords('→×3 ⇧⌘→ ⌫')).toEqual(['→', '→', '→', '⇧⌘→', '⌫']);
    expect(chordEvent('⇧⌥←')).toMatchObject({ key: 'ArrowLeft', shiftKey: true, altKey: true, metaKey: false });
  });

  it('splits engine key names', () => {
    expect(keys('d/foo<CR><C-v>j')).toEqual(['d', '/', 'f', 'o', 'o', '<CR>', '<C-v>', 'j']);
  });
});

describe('Vim lessons (#44)', () => {
  const lessons = LESSONS.vim;

  it('has unique ids and a board with red on it', () => {
    expect(new Set(lessons.map((l) => l.id)).size).toBe(lessons.length);
    for (const l of lessons) expect(redsRemaining(field(l)), l.id).toBeGreaterThan(0);
  });

  for (const lesson of LESSONS.vim) {
    it(`${lesson.id}: the intended keys clear it on target, with no mistake`, () => {
      const r = playVim(lesson);
      const info = JSON.stringify(r);
      expect(r.mistakes, info).toBe(0);
      expect(r.reds, info).toBe(0);
      expect(r.deletes, info).toBeLessThanOrEqual(lesson.target);
    });

    it(`${lesson.id}: the target is not met by accident (it takes a delete per target)`, () => {
      // the target equals what the intended solution needs — not a loose upper bound
      expect(playVim(lesson).deletes).toBe(lesson.target);
    });
  }
});

describe('Standard lessons (#45)', () => {
  const lessons = LESSONS.standard;

  it('has unique ids and a board with red on it', () => {
    expect(lessons.length).toBeGreaterThan(0);
    expect(new Set(lessons.map((l) => l.id)).size).toBe(lessons.length);
    for (const l of lessons) expect(redsRemaining(field(l)), l.id).toBeGreaterThan(0);
  });

  for (const lesson of LESSONS.standard) {
    it(`${lesson.id}: the intended chords clear it on exactly its target, with no mistake`, () => {
      const r = playStandard(lesson);
      const info = JSON.stringify(r);
      expect(r.mistakes, info).toBe(0);
      expect(r.reds, info).toBe(0);
      expect(r.deletes, info).toBe(lesson.target);
    });
  }

  it('the glued lesson really is a trap for the word chord', () => {
    const glued = lessons.find((l) => l.id === 'std-glued')!;
    const r = playStandard({ ...glued, solution: chords('⌘→ ⌥⌫') });
    expect(r.mistakes).toBe(1);
  });
});

describe('lesson progress', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it('records passes and stars per mode, and never downgrades a star', () => {
    recordLesson('vim', 'vim-x', false);
    expect(loadProgress('vim')).toEqual({ 'vim-x': 'pass' });
    recordLesson('vim', 'vim-x', true);
    recordLesson('vim', 'vim-x', false);
    expect(loadProgress('vim')).toEqual({ 'vim-x': 'star' });
    expect(loadProgress('standard')).toEqual({});
  });
});
