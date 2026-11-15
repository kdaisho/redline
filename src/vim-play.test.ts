/**
 * Vim mode end to end, headless (#7): the key controller + Vim keymap wiring,
 * and a bot that clears real stages with nothing but Vim keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type FieldState, countColor, redsRemaining, isMistake, createField, text, spaces, line } from './state.ts';
import { attachInput, type InputHandlers } from './input.ts';
import { createVimKeymap, vimKeyName } from './keymaps/vim.ts';
import { createStandardKeymap } from './keymaps/standard.ts';
import { loadStage, MAX_STAGE_INDEX } from './stages.ts';
import { Vim } from './vim.ts';
import { applyScore, initialScore, CHORD_MULT } from './game.ts';

/** A keydown-shaped event good enough for the controller (Node has no KeyboardEvent). */
function keyEvent(type: string, key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat', boolean>> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    key,
    code: `Key:${key.toLowerCase()}`,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...mods,
  });
}

describe('vim key names', () => {
  const name = (key: string, mods = {}) => vimKeyName(keyEvent('keydown', key, mods) as unknown as KeyboardEvent);

  it('names printable and special keys', () => {
    expect(name('d')).toBe('d');
    expect(name('G', { shiftKey: true })).toBe('G');
    expect(name('$', { shiftKey: true })).toBe('$');
    expect(name(' ')).toBe(' ');
    expect(name('Escape')).toBe('<Esc>');
    expect(name('Enter')).toBe('<CR>');
    expect(name('Backspace')).toBe('<BS>');
    expect(name('ArrowDown')).toBe('<Down>');
  });

  it('maps the Ctrl chords Vim uses and leaves the rest to the browser', () => {
    expect(name('v', { ctrlKey: true })).toBe('<C-v>');
    expect(name('[', { ctrlKey: true })).toBe('<Esc>');
    expect(name('c', { ctrlKey: true })).toBe('<Esc>');
    expect(name('r', { ctrlKey: true })).toBeNull();
    expect(name('r', { metaKey: true })).toBeNull(); // Cmd-R still reloads
    expect(name('{', { ctrlKey: true, altKey: true })).toBe('{'); // AltGr typing
    expect(name('Shift')).toBeNull();
    expect(name('F1')).toBeNull();
    expect(name('Tab')).toBeNull();
  });
});

describe('controller + vim keymap', () => {
  let target: EventTarget;
  let field: FieldState;
  let vim: Vim;
  let active: boolean;
  let calls: string[];
  let detach: () => void;

  const press = (key: string, mods = {}) => target.dispatchEvent(keyEvent('keydown', key, mods));
  const release = (key: string) => target.dispatchEvent(keyEvent('keyup', key));
  const rows = () => field.lines.map((ln) => ln.map((b) => b.ch).join(''));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis); // the repeat clock uses window.setTimeout / setInterval
    target = new EventTarget();
    field = createField([line(text('red', 'foo'), spaces(), text('blue', 'bar')), line(text('red', 'baz'))]);
    vim = new Vim();
    active = true;
    calls = [];
    const keymap = createVimKeymap((key) => vim.key(field, key).repeatable);
    const handlers: InputHandlers = {
      keymap: () => keymap,
      confirm: () => calls.push('confirm'),
      mute: () => calls.push('mute'),
      help: () => calls.push('help'),
      volume: (bus, delta) => calls.push(`${bus}${delta > 0 ? '+' : '-'}`),
      busMute: (bus) => calls.push(`${bus} off/on`),
      menu: () => calls.push('menu'),
      pickMode: (i) => calls.push(`pick${i}`),
      cycleMode: () => calls.push('cycle'),
      isActive: () => active,
    };
    detach = attachInput(handlers, target as unknown as Window);
  });

  afterEach(() => {
    detach();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('feeds keys to the engine while playing', () => {
    press('d');
    press('w');
    expect(rows()).toEqual(['bar', 'baz']);
  });

  it('a held motion auto-repeats; a held delete does not', () => {
    press('l');
    expect(field.caret.col).toBe(1);
    vi.advanceTimersByTime(280 + 45 * 3 + 5);
    expect(field.caret.col).toBeGreaterThanOrEqual(4);
    release('l');
    const col = field.caret.col;
    vi.advanceTimersByTime(500);
    expect(field.caret.col).toBe(col);

    press('0');
    release('0');
    press('x');
    vi.advanceTimersByTime(1000);
    expect(rows()[0]).toBe('oo bar'); // exactly one character gone
  });

  it('OS key-repeat events are ignored', () => {
    press('x');
    press('x', { repeat: true });
    press('x', { repeat: true });
    expect(rows()[0]).toBe('oo bar');
  });

  it('a new key stops a running repeat, so it cannot finish someone else\'s command', () => {
    press('j'); // held
    press('d'); // operator typed while j is still down
    vi.advanceTimersByTime(1000); // j must not repeat into "dj"
    expect(rows()).toEqual(['foo bar', 'baz']);
    expect(vim.status().pending).toBe('d');
  });

  it('M, Enter, Space and Esc belong to Vim while playing', () => {
    press('M', { shiftKey: true });
    press('Enter');
    press(' ');
    press('Escape');
    expect(calls).toEqual([]);
  });

  it('…and are the game\'s keys on a screen', () => {
    active = false;
    press('m');
    press('Enter');
    press('Escape');
    press('2');
    press('Tab');
    expect(calls).toEqual(['mute', 'confirm', 'menu', 'pick1', 'cycle']);
    press('x'); // gameplay keys do nothing on a screen
    expect(rows()[0]).toBe('foo bar');
  });

  it('F1 and F2 are help and mute in every state', () => {
    press('F1');
    press('F2');
    active = false;
    press('F1');
    press('F2');
    expect(calls).toEqual(['help', 'mute', 'help', 'mute']);
  });

  it('F3 F4 / F6 F7 are the music / SFX volume in every state, and never reach Vim (#14)', () => {
    const before = rows();
    for (const playing of [true, false]) {
      active = playing;
      calls = [];
      for (const key of ['F3', 'F4', 'F6', 'F7']) press(key);
      expect(calls).toEqual(['music-', 'music+', 'sfx-', 'sfx+']);
    }
    calls = [];
    press('F4', { repeat: true }); // holding a volume key keeps stepping
    press('F3', { shiftKey: true });
    press('F6', { shiftKey: true });
    press('F6', { shiftKey: true, repeat: true }); // a held toggle does not flap
    expect(calls).toEqual(['music+', 'music off/on', 'sfx off/on']);
    expect(press('F5')).toBe(true); // F5 (reload) is left to the browser: not cancelled
    expect(rows()).toEqual(before);
    expect(vim.status().pending).toBe('');
  });

  it('a key held through a screen does not fire when play resumes', () => {
    active = false;
    press('x');
    active = true;
    press('x', { repeat: true }); // the OS keeps repeating the held key
    expect(rows()[0]).toBe('foo bar');
    release('x');
    press('x');
    expect(rows()[0]).toBe('oo bar');
  });
});

describe('controller + standard keymap', () => {
  it('still moves, selects and deletes; M and Enter stay global while playing', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const target = new EventTarget();
    const calls: string[] = [];
    const keymap = createStandardKeymap({
      move: (a) => calls.push(`move:${a}`),
      select: (a) => calls.push(`select:${a}`),
      delete: (a) => calls.push(`delete:${a}`),
      moveRow: (d) => calls.push(`row:${d}`),
    });
    const detach = attachInput(
      {
        keymap: () => keymap,
        confirm: () => calls.push('confirm'),
        mute: () => calls.push('mute'),
        help: () => calls.push('help'),
        menu: () => calls.push('menu'),
        pickMode: () => {},
        cycleMode: () => {},
        isActive: () => true,
      },
      target as unknown as Window,
    );
    const press = (key: string, mods = {}) => target.dispatchEvent(keyEvent('keydown', key, mods));
    press('ArrowRight');
    press('Backspace', { altKey: true }); // a tap while → is held leaves → repeating
    vi.advanceTimersByTime(280 + 45 + 5);
    press('ArrowLeft', { shiftKey: true, metaKey: true });
    press('ArrowUp', { altKey: true });
    press('m');
    press('Enter');
    press('Escape'); // not a Standard key: it is the game's menu key (#33)
    expect(calls).toEqual([
      'move:char-right',
      'delete:word-left',
      'move:char-right',
      'select:line-start',
      'row:-1',
      'mute',
      'confirm',
      'menu',
    ]);
    detach();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe('a run can be cleared with Vim keys only', () => {
  /** Feed a key string (`<Esc>`-style names allowed); returns the delete results. */
  function feed(vim: Vim, f: FieldState, keys: string) {
    const out = [];
    for (const k of keys.match(/<[^>]+>|./g) ?? []) {
      const r = vim.key(f, k);
      if (r.deleted) out.push(r.deleted);
    }
    return out;
  }

  /** First red run in reading order: its row, start column and length. */
  function firstRed(f: FieldState): { row: number; col: number; len: number } | null {
    for (let r = 0; r < f.lines.length; r++) {
      const ln = f.lines[r];
      const col = ln.findIndex((b) => b.color === 'red');
      if (col < 0) continue;
      let len = 0;
      while (ln[col + len]?.color === 'red') len++;
      return { row: r, col, len };
    }
    return null;
  }

  it('every stage: go to each red run and delete exactly it, never touching blue', () => {
    for (let stage = 0; stage <= MAX_STAGE_INDEX; stage++) {
      const f = loadStage(stage, 0);
      const vim = new Vim();
      const blues = countColor(f, 'blue');
      let score = initialScore();
      let guard = 0;
      for (let red = firstRed(f); red; red = firstRed(f)) {
        if (++guard > 5000) throw new Error(`stage ${stage + 1}: bot is stuck`);
        // {row}G, to column 0, right to the run, delete its characters: e.g. `3G07l4x`
        const keys = `${red.row + 1}G0${red.col > 0 ? `${red.col}l` : ''}${red.len}x`;
        const deletes = feed(vim, f, keys);
        expect(deletes, `stage ${stage + 1}: ${keys}`).toHaveLength(1); // one command = one action
        expect(isMistake(deletes[0])).toBe(false);
        expect(deletes[0].red).toBe(red.len);
        score = applyScore(score, deletes[0], guard * 100);
      }
      expect(redsRemaining(f)).toBe(0);
      expect(countColor(f, 'blue')).toBe(blues);
      expect(score.score).toBeGreaterThan(0);
    }
  });

  it('delete commands carry the scoring chord: x char, word motions word, dd / D line, visual selection', () => {
    const fresh = () =>
      createField([
        line(text('red', 'foo'), spaces(), text('red', 'bar'), spaces(), text('blue', 'keep')),
        line(text('red', 'baz'), spaces(), text('red', 'qux')),
        line(text('red', 'last')),
      ]);
    const chordOf = (keys: string) => feed(new Vim(), fresh(), keys)[0].chord;
    expect(chordOf('x')).toBe('char');
    expect(chordOf('3x')).toBe('char');
    expect(chordOf('dl')).toBe('char');
    expect(chordOf('dw')).toBe('word');
    expect(chordOf('de')).toBe('word');
    expect(chordOf('diw')).toBe('word');
    expect(chordOf('dfo')).toBe('word');
    expect(chordOf('d/bar<CR>')).toBe('word');
    expect(chordOf('jD')).toBe('line');
    expect(chordOf('jd$')).toBe('line');
    expect(chordOf('jdd')).toBe('line');
    expect(chordOf('jdj')).toBe('line');
    expect(chordOf('ved')).toBe('selection');
    expect(chordOf('jVd')).toBe('selection');
    expect(chordOf('j<C-v>jld')).toBe('selection');
    expect(CHORD_MULT).toEqual({ char: 1, word: 1.5, line: 2, selection: 2 });
  });
});
