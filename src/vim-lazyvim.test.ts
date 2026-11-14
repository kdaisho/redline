/**
 * LazyVim keybindings in Vim mode (#9) — headless, on small hand-built fields:
 * flash.nvim's jump and character finds, mini.ai's text objects, the Alt-j /
 * Alt-k row moves, and the default remaps (`n` / `N`, `j` / `k`).
 *
 * Expected results follow the plugins' documented behaviour and source (flash's
 * labeler and char mode, mini.ai's span search); unlike `vim.test.ts` they were
 * not run against a Neovim with the plugins installed.
 */
import { describe, it, expect } from 'vitest';
import { type FieldState, type Line, type DeleteResult, createField } from './state.ts';
import { Vim } from './vim.ts';
import { vimKeyName } from './keymaps/vim.ts';
import { MODES } from './modes.ts';
import { loadStage } from './stages.ts';

function mk(rows: string[], blue: string[] = []): FieldState {
  const lines: Line[] = rows.map((row, r) =>
    Array.from(row, (ch, c) => ({
      ch,
      color: ch === ' ' ? null : blue[r]?.[c] === 'b' ? ('blue' as const) : ('red' as const),
    })),
  );
  return createField(lines);
}

const rowsOf = (f: FieldState): string[] => f.lines.map((ln) => ln.map((b) => b.ch).join(''));
const at = (f: FieldState): [number, number] => [f.caret.line, f.caret.col];

/** Split a key string into engine keys: `<Esc>`, `<CR>`, `<A-j>`, … are single keys. */
function keysOf(s: string): string[] {
  return s.match(/<[^>]+>|./g) ?? [];
}

function feed(vim: Vim, f: FieldState, keys: string): DeleteResult[] {
  const out: DeleteResult[] = [];
  for (const k of keysOf(keys)) {
    const r = vim.key(f, k);
    if (r.deleted) out.push(r.deleted);
  }
  return out;
}

function run(rows: string[], keys: string, start: [number, number] = [0, 0]) {
  const f = mk(rows);
  f.caret = { line: start[0], col: start[1] };
  const vim = new Vim();
  const deletes = feed(vim, f, keys);
  return { f, vim, deletes, rows: rowsOf(f), at: at(f) };
}

/** The labels on screen, as `label → [row, col of the match it jumps to]`. */
function labelsOf(vim: Vim): Record<string, [number, number]> {
  const fl = vim.status().flash!;
  return Object.fromEntries(fl.labels.map((l) => [l.label, [l.line, l.col - fl.len]]));
}

describe('flash jump (s)', () => {
  it('labels every match of the typed text, nearest first, and a label jumps to its match', () => {
    const r = run(['foo bar', 'baz foo'], 'sf');
    const fl = r.vim.status().flash!;
    expect(fl.pattern).toBe('f');
    expect(fl.matches).toEqual([{ line: 0, col: 0 }, { line: 1, col: 4 }]);
    // the label sits on the cell after the match
    expect(fl.labels).toEqual([
      { line: 0, col: 1, label: 'a' },
      { line: 1, col: 5, label: 's' },
    ]);
    expect(r.at).toEqual([0, 0]); // nothing moves until a label is pressed
    feed(r.vim, r.f, 's');
    expect(at(r.f)).toEqual([1, 4]);
    expect(r.vim.status().flash).toBeNull();
    expect(r.rows).toEqual(['foo bar', 'baz foo']); // s deletes nothing
  });

  it('a label is never a character that could continue the text', () => {
    const r = run(['ab as ad'], 'sa');
    // b, s and d follow a match, so they are not labels
    expect(Object.keys(labelsOf(r.vim)).sort()).toEqual(['a', 'f', 'g']);
    feed(r.vim, r.f, 's'); // so this narrows the text to "as" instead of jumping
    expect(r.vim.status().flash!.pattern).toBe('as');
    expect(r.vim.status().flash!.matches).toEqual([{ line: 0, col: 3 }]);
  });

  it('a match keeps its label while the text grows', () => {
    const r = run(['xa xb xc'], 'sx', [0, 7]);
    const before = labelsOf(r.vim);
    const label = Object.keys(before).find((l) => before[l][1] === 3)!;
    feed(r.vim, r.f, 'b');
    expect(labelsOf(r.vim)).toEqual({ [label]: [0, 3] });
    feed(r.vim, r.f, label);
    expect(at(r.f)).toEqual([0, 3]);
  });

  it('is smartcase: lowercase text ignores case, a capital does not', () => {
    expect(run(['Foo foo'], 'sf').vim.status().flash!.matches).toHaveLength(2);
    expect(run(['Foo foo'], 'sF').vim.status().flash!.matches).toEqual([{ line: 0, col: 0 }]);
  });

  it('uses capital labels when the lowercase ones run out', () => {
    const r = run([Array(30).fill('x').join(' ')], 'sx');
    const labels = Object.keys(labelsOf(r.vim));
    expect(labels).toHaveLength(30);
    expect(labels.filter((l) => l === l.toUpperCase())).toHaveLength(4);
  });

  it('Enter jumps to the next match; Backspace edits; Esc cancels', () => {
    expect(run(['foo bar', 'baz foo'], 'sfo<CR>').at).toEqual([1, 4]);
    expect(run(['foo bar', 'baz foo'], 'sfo<CR>', [1, 5]).at).toEqual([0, 0]); // wraps
    const r = run(['foo bar'], 'sbx');
    expect(r.vim.status().flash).toBeNull(); // "bx" matches nothing: cancelled
    expect(r.vim.status().message).toBe('No match: bx');
    const b = run(['foo bar'], 'sbz<BS>');
    expect(b.vim.status().flash).toBeNull(); // (cancelled by the z)
    const e = run(['foo bar baz'], 'sba<BS>');
    expect(e.vim.status().flash!.pattern).toBe('b');
    feed(e.vim, e.f, '<Esc>');
    expect(e.vim.status().flash).toBeNull();
    expect(at(e.f)).toEqual([0, 0]);
    expect(run(['foo bar'], 's<Esc>x').rows).toEqual(['oo bar']); // back to plain Normal mode
  });

  it('shows in the statusline as a pending command', () => {
    const r = run(['foo bar'], 'ds');
    expect(r.vim.status().pending).toBe('ds');
    expect(r.vim.status().operator).toBe(true);
    expect(r.vim.status().flash).toEqual({ pattern: '', len: 0, matches: [], labels: [] });
  });

  it('ds deletes from the cursor through the first character of the match', () => {
    const r = run(['foo bar baz'], 'dsb');
    expect(labelsOf(r.vim)).toEqual({ s: [0, 4], d: [0, 8] }); // "a" follows both matches
    const d = feed(r.vim, r.f, 's');
    expect(rowsOf(r.f)).toEqual(['ar baz']);
    expect(d).toHaveLength(1); // one command = one action
    expect(d[0].chord).toBe('word');
    // backward: from the match through the cursor
    expect(run(['foo bar'], 'dsfa', [0, 5]).rows).toEqual(['r']);
    // across rows: a characterwise delete that joins them
    expect(run(['ab cd', 'ef gh'], 'dsga', [0, 3]).rows).toEqual(['ab h']);
  });

  it('extends the selection in Visual mode', () => {
    const r = run(['foo bar baz'], 'vsbs');
    expect(r.vim.mode).toBe('visual');
    expect(r.vim.selection(r.f)).toEqual([{ line: 0, from: 0, to: 5 }]);
    feed(r.vim, r.f, 'd');
    expect(rowsOf(r.f)).toEqual(['ar baz']);
    // Esc inside flash only cancels the jump
    const e = run(['foo bar'], 'vls<Esc>');
    expect(e.vim.mode).toBe('visual');
  });

  it('dr runs the delete at the target and brings the cursor back', () => {
    const r = run(['foo bar', 'baz qux'], 'drq');
    expect(labelsOf(r.vim)).toEqual({ a: [1, 4] });
    feed(r.vim, r.f, 'a');
    expect(at(r.f)).toEqual([1, 4]); // over there, operator still waiting
    expect(r.vim.status().pending).toBe('dr');
    expect(r.vim.status().operator).toBe(true);
    const d = feed(r.vim, r.f, 'iw');
    expect(d).toHaveLength(1);
    expect(rowsOf(r.f)).toEqual(['foo bar', 'baz ']);
    expect(at(r.f)).toEqual([0, 0]);
  });

  it('dr comes back to the same character even when rows above it went away', () => {
    const r = run(['foo', 'bar', 'baz'], 'drfad', [2, 1]); // dd on row 0, typed from row 2
    expect(r.rows).toEqual(['bar', 'baz']);
    expect(r.at).toEqual([1, 1]);
    // cancelled half-way: the cursor still returns
    expect(run(['foo', 'bar'], 'drfa<Esc>', [1, 2]).at).toEqual([1, 2]);
  });

  it('S, R and Ctrl-Space (flash treesitter) do nothing', () => {
    expect(run(['a', 'b'], 'S').rows).toEqual(['a', 'b']);
    expect(run(['a', 'b'], 'VS').rows).toEqual(['a', 'b']);
    expect(run(['a', 'b'], 'VR').rows).toEqual(['a', 'b']);
    expect(run(['a', 'b'], 'VR').vim.mode).toBe('visual-line');
    expect(run(['a b'], 'dSw').rows).toEqual(['a b']); // cancels the operator
  });
});

describe('flash character finds (f F t T)', () => {
  it('search across rows, without wrapping', () => {
    expect(run(['abc', 'xyz'], 'fy').at).toEqual([1, 1]);
    expect(run(['abc', '', 'xyz'], 'tz').at).toEqual([2, 1]);
    expect(run(['abc', 'xyz'], 'Fb', [1, 2]).at).toEqual([0, 1]);
    expect(run(['abc', 'xyz'], 'Ta', [1, 2]).at).toEqual([0, 1]);
    expect(run(['abc', 'xyz'], 'fa', [1, 0]).at).toEqual([1, 0]); // nothing after the cursor
    expect(run(['a.b', 'c.d', 'e.f'], '3f.').at).toEqual([2, 1]);
  });

  it('the same key repeats the find: lowercase onward, capital back', () => {
    const r = run(['a.b.c', 'd.e'], 'f.');
    expect(r.at).toEqual([0, 1]);
    feed(r.vim, r.f, 'f');
    expect(at(r.f)).toEqual([0, 3]);
    feed(r.vim, r.f, 'f');
    expect(at(r.f)).toEqual([1, 1]);
    feed(r.vim, r.f, 'F');
    expect(at(r.f)).toEqual([0, 3]);
    feed(r.vim, r.f, '2F');
    expect(at(r.f)).toEqual([0, 3]); // only one match left that way: a count that cannot be met fails
    // after F, f keeps going the way F went and F turns around
    const b = run(['a.b.c.d'], 'F.f', [0, 6]);
    expect(b.at).toEqual([0, 3]);
    feed(b.vim, b.f, 'F');
    expect(at(b.f)).toEqual([0, 5]);
  });

  it('any other key ends the repeat, so f asks for a character again', () => {
    const r = run(['a.b.c'], 'f.lf');
    expect(r.at).toEqual([0, 2]);
    expect(r.vim.status().pending).toBe('f');
    feed(r.vim, r.f, 'c');
    expect(at(r.f)).toEqual([0, 4]);
    // a different find key also asks
    expect(run(['a.b.c'], 'f.t').vim.status().pending).toBe('t');
    // and after an operator f always takes a character
    expect(run(['a.b.c'], 'f.df').vim.status().pending).toBe('df');
  });

  it('; and , repeat too, and , walks the same targets backward', () => {
    expect(run(['a.b.c', 'd.e'], 'f.;;').at).toEqual([1, 1]);
    expect(run(['a.b.c', 'd.e'], 'f.;;,').at).toEqual([0, 3]);
    expect(run(['a.b.c'], 't.').at).toEqual([0, 0]); // already right before one
    expect(run(['a.b.c'], 't.;').at).toEqual([0, 2]);
    expect(run(['a.b.c'], 't.t').at).toEqual([0, 2]);
    expect(run(['a.b.c'], 't.;,').at).toEqual([0, 0]); // flash: the cell before the previous "."
  });

  it('a lowercase character also finds its capital (ignorecase + smartcase)', () => {
    expect(run(['aXbx'], 'fx').at).toEqual([0, 1]);
    expect(run(['axbX'], 'fX').at).toEqual([0, 3]);
  });

  it('work as operator targets across rows', () => {
    expect(run(['ab', 'cde'], 'dfd').rows).toEqual(['e']);
    expect(run(['ab', 'cde'], 'dtd').rows).toEqual(['de']);
    expect(run(['abc', 'de'], 'dFb', [1, 1]).rows).toEqual(['ae']);
    const r = run(['a.b.c.d'], 'df.');
    feed(r.vim, r.f, '.');
    expect(rowsOf(r.f)).toEqual(['c.d']);
  });

  it('a held repeat key keeps going', () => {
    const r = run(['a.b.c.d'], 'f.');
    expect(r.vim.key(r.f, 'f').repeatable).toBe(true);
    expect(r.vim.key(r.f, ';').repeatable).toBe(true);
  });
});

describe('mini.ai text objects', () => {
  it('open brackets trim the inner whitespace, close brackets keep it', () => {
    expect(run(['f( a, b )'], 'di(', [0, 4]).rows).toEqual(['f(  )']);
    expect(run(['f( a, b )'], 'di)', [0, 4]).rows).toEqual(['f()']);
    expect(run(['f( a, b )'], 'da(', [0, 4]).rows).toEqual(['f']);
    expect(run(['x[ 1 ]'], 'di[', [0, 3]).rows).toEqual(['x[  ]']);
    expect(run(['x{ k }'], 'di}', [0, 3]).rows).toEqual(['x{}']);
    expect(run(['a< b >'], 'di<', [0, 3]).rows).toEqual(['a<  >']);
    expect(run(['f(', '  a', ')'], 'di)', [1, 2]).rows).toEqual(['f()']);
  });

  it('a count steps outward', () => {
    expect(run(['(( a (bb) ))'], 'da(', [0, 3]).rows).toEqual(['()']);
    expect(run(['(( a (bb) ))'], 'd2a(', [0, 3]).rows).toEqual(['']);
    expect(run(['(( a (bb) ))'], 'd2i)', [0, 3]).rows).toEqual(['()']);
    expect(run(['(( a (bb) ))'], 'd3a(', [0, 3]).deletes).toEqual([]);
  });

  it('an object on the cursor row wins over one that spans rows', () => {
    expect(run(['{', 'a (b)', '}'], 'dib', [1, 0]).rows).toEqual(['{', 'a ()', '}']);
    expect(run(['{', 'a b', '}'], 'dib', [1, 0]).rows).toEqual(['{}']);
  });

  it('b is any of ( [ { and q any quote', () => {
    expect(run(['f([a], {b})'], 'dib', [0, 3]).rows).toEqual(['f([], {b})']);
    expect(run(['f([a], {b})'], 'd2ib', [0, 3]).rows).toEqual(['f()']);
    expect(run(['f([a], {b})'], 'dab', [0, 8]).rows).toEqual(['f([a], )']);
    expect(run(['x \'a\' "b"'], 'diq', [0, 7]).rows).toEqual(['x \'a\' ""']);
    expect(run(['x \'a\' "b"'], 'daq', [0, 3]).rows).toEqual(['x  "b"']);
    expect(run(['x `a`'], 'diq').rows).toEqual(['x ``']); // the next one on the row
  });

  it('quotes pair up from the left of the row', () => {
    // between two strings is not "inside quotes": the next string is used
    expect(run(['"a" b "c"'], 'di"', [0, 4]).rows).toEqual(['"a" b ""']);
    expect(run(['"a" b "c"'], 'da"', [0, 1]).rows).toEqual([' b "c"']);
  });

  it('next and last variants: in( il( an( al(', () => {
    const rows = ['(a) (b) (c)'];
    expect(run(rows, 'din(', [0, 5]).rows).toEqual(['(a) (b) ()']);
    expect(run(rows, 'dil(', [0, 5]).rows).toEqual(['() (b) (c)']);
    expect(run(rows, 'dan(', [0, 5]).rows).toEqual(['(a) (b) ']);
    expect(run(rows, 'dal(', [0, 5]).rows).toEqual([' (b) (c)']);
    expect(run(rows, 'd2in(').rows).toEqual(['(a) (b) ()']);
    expect(run(rows, 'din(', [0, 9]).deletes).toEqual([]); // nothing after the last one
    expect(run(['"a" "b"'], 'dinq').rows).toEqual(['"a" ""']);
    expect(run(['f(a, b)'], 'dana', [0, 2]).rows).toEqual(['f(a)']);
    expect(run(rows, 'din').vim.status().pending).toBe('din');
  });

  it('argument: ia is the argument, aa takes one comma with it', () => {
    const rows = ['f(aa, bb, cc)'];
    expect(run(rows, 'dia', [0, 6]).rows).toEqual(['f(aa, , cc)']);
    expect(run(rows, 'daa', [0, 2]).rows).toEqual(['f( bb, cc)']); // first: the comma after it
    expect(run(rows, 'daa', [0, 6]).rows).toEqual(['f(aa, cc)']); // middle: the comma before it
    expect(run(rows, 'daa', [0, 10]).rows).toEqual(['f(aa, bb)']); // last: likewise
    expect(run(rows, 'daa').rows).toEqual(['f( bb, cc)']); // before the call: the next argument
    expect(run(['f( a )'], 'dia', [0, 3]).rows).toEqual(['f(  )']);
    expect(run(['f( a )'], 'daa', [0, 3]).rows).toEqual(['f()']);
    expect(run(['f()'], 'daa').deletes).toEqual([]);
  });

  it('argument: commas inside nested brackets or quotes do not split', () => {
    expect(run(['f(g(a, b), c)'], 'daa', [0, 2]).rows).toEqual(['f( c)']);
    expect(run(['f(g(a, b), c)'], 'daa', [0, 4]).rows).toEqual(['f(g( b), c)']);
    expect(run(['f("a,b", c)'], 'dia', [0, 3]).rows).toEqual(['f(, c)']);
    expect(run(['x[1, 2]'], 'daa', [0, 5]).rows).toEqual(['x[1]']);
  });

  it('u is a function call, U one without dots in its name', () => {
    const rows = ['x = a.b(c, d) + 1'];
    expect(run(rows, 'diu', [0, 9]).rows).toEqual(['x = a.b() + 1']);
    expect(run(rows, 'dau', [0, 9]).rows).toEqual(['x =  + 1']);
    expect(run(rows, 'daU', [0, 9]).rows).toEqual(['x = a. + 1']);
    expect(run(['a (b)'], 'dau').deletes).toEqual([]); // no name right before the bracket
  });

  it('d is a run of digits, e one part of a camelCase / snake_case name', () => {
    expect(run(['abc 123 x'], 'did').rows).toEqual(['abc  x']);
    expect(run(['fooBarBaz x'], 'die', [0, 4]).rows).toEqual(['fooBaz x']);
    expect(run(['fooBarBaz x'], 'die').rows).toEqual(['BarBaz x']);
    expect(run(['foo_bar'], 'die', [0, 5]).rows).toEqual(['foo_']);
  });

  it('g is the whole field; ig leaves out blank rows at its ends', () => {
    const d = run(['a', 'b'], 'dag').deletes;
    expect(d).toHaveLength(1);
    expect(d[0].chord).toBe('line');
    expect(run(['a', 'b'], 'dag').rows).toEqual(['']);
    expect(run(['', 'a', 'b', ''], 'dig', [1, 0]).rows).toEqual(['', '', '']);
  });

  it('any other punctuation is a separator: i_ between two, a_ with the closing one', () => {
    expect(run(['aa_bb_cc'], 'di_', [0, 4]).rows).toEqual(['aa__cc']);
    expect(run(['aa_bb_cc'], 'da_', [0, 4]).rows).toEqual(['aa_cc']);
    expect(run(['a.b.c'], 'di.', [0, 2]).rows).toEqual(['a..c']);
  });

  it('p (paragraph) is Vim\'s own: rows up to a blank row', () => {
    expect(run(['a', 'b', '', 'c'], 'dip').rows).toEqual(['', 'c']);
    expect(run(['a', 'b', '', 'c'], 'dap').rows).toEqual(['c']);
    expect(run(['a', 'b', '', 'c'], 'dap', [3, 0]).rows).toEqual(['a', 'b']); // no blank after: the one before
    expect(run(['a', 'b', '', 'c'], 'dip')!.deletes[0].chord).toBe('line');
    const v = run(['a', 'b', '', 'c'], 'vip');
    expect(v.vim.mode).toBe('visual-line');
    expect(v.vim.selection(v.f).map((s) => s.line)).toEqual([0, 1]);
  });

  it('objects that need a syntax tree, a tag or a prompt are not there', () => {
    const rows = ['f(a) <b>c</b>'];
    for (const keys of ['dif', 'dac', 'dio', 'dit', 'di?', 'dis']) {
      const r = run(rows, keys, [0, 2]);
      expect(r.rows, keys).toEqual(rows);
      expect(r.vim.status().operator, keys).toBe(false); // the operator is dropped
    }
  });

  it('select in Visual mode, and the same object again steps outward', () => {
    const r = run(['((a b))'], 'va(', [0, 3]);
    expect(r.vim.selection(r.f)).toEqual([{ line: 0, from: 1, to: 6 }]);
    feed(r.vim, r.f, 'a(');
    expect(r.vim.selection(r.f)).toEqual([{ line: 0, from: 0, to: 7 }]);
    expect(run(['f(aa, bb)'], 'viad', [0, 6]).rows).toEqual(['f(aa, )']);
    expect(run(['(a) (b)'], 'vin(d').rows).toEqual(['(a) ()']);
    // no such object: mini.ai leaves Visual mode
    expect(run(['abc'], 'vi(').vim.mode).toBe('normal');
  });

  it('repeat with .', () => {
    const r = run(['(a) (b) (c)'], 'din(');
    feed(r.vim, r.f, '.');
    expect(rowsOf(r.f)).toEqual(['(a) () ()']);
  });

  it('g[ and g] go to the edges of an object', () => {
    expect(run(['f(a, b)'], 'g[(', [0, 3]).at).toEqual([0, 1]);
    expect(run(['f(a, b)'], 'g](', [0, 3]).at).toEqual([0, 6]);
    expect(run(['f(a, b)'], 'g]a', [0, 2]).at).toEqual([0, 3]);
    expect(run(['((a))'], 'g[(', [0, 1]).at).toEqual([0, 0]); // already on the edge: the next one out
    expect(run(['a "b" c'], 'g]"').at).toEqual([0, 4]); // nothing around the cursor: the next string
    expect(run(['f(a, b)'], 'g[').vim.status().pending).toBe('g[');
  });
});

describe('row moves (Alt-j / Alt-k)', () => {
  it('move the cursor row down / up without deleting', () => {
    const r = run(['a', 'b', 'c'], '<A-j>');
    expect(r.rows).toEqual(['b', 'a', 'c']);
    expect(r.at).toEqual([1, 0]);
    expect(r.deletes).toEqual([]);
    expect(run(['a', 'b', 'c'], '<A-k>', [2, 0]).rows).toEqual(['a', 'c', 'b']);
    expect(run(['a', 'b', 'c'], '<A-k>').rows).toEqual(['a', 'b', 'c']); // already at the top
    expect(run(['a', 'b', 'c'], '<A-j>', [2, 0]).rows).toEqual(['a', 'b', 'c']);
  });

  it('take a count, and repeat while held', () => {
    expect(run(['a', 'b', 'c', 'd'], '2<A-j>').rows).toEqual(['b', 'c', 'a', 'd']);
    expect(run(['a', 'b', 'c'], '9<A-j>').rows).toEqual(['b', 'c', 'a']); // as far as it goes
    const f = mk(['a', 'b', 'c']);
    const vim = new Vim();
    expect(vim.key(f, '<A-j>').repeatable).toBe(true);
    expect(vim.key(f, '<A-j>').repeatable).toBe(true);
    expect(vim.key(f, '<A-j>').repeatable).toBe(false); // hit the bottom
  });

  it('move every selected row in Visual mode and keep the selection', () => {
    const r = run(['a', 'b', 'c', 'd'], 'Vj<A-j>');
    expect(r.rows).toEqual(['c', 'a', 'b', 'd']);
    expect(r.vim.mode).toBe('visual-line');
    expect(r.vim.selection(r.f).map((s) => s.line)).toEqual([1, 2]);
    feed(r.vim, r.f, '<A-k>d');
    expect(rowsOf(r.f)).toEqual(['c', 'd']);
    // charwise Visual moves whole rows too
    const v = run(['ab', 'cd', 'ef'], 'vj<A-j>', [0, 1]);
    expect(v.rows).toEqual(['ef', 'ab', 'cd']);
    expect(v.vim.selection(v.f)).toEqual([
      { line: 1, from: 1, to: 3 },
      { line: 2, from: 0, to: 2 },
    ]);
  });

  it('cancel a pending operator instead of moving', () => {
    const r = run(['a b', 'c'], 'd<A-j>');
    expect(r.rows).toEqual(['a b', 'c']);
    expect(r.vim.status().operator).toBe(false);
  });

  it('Alt-j / Alt-k are named from the letter, including what macOS Option types', () => {
    const name = (key: string, mods = {}) =>
      vimKeyName({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent);
    expect(name('j', { altKey: true })).toBe('<A-j>');
    expect(name('k', { altKey: true })).toBe('<A-k>');
    expect(name('∆', { altKey: true })).toBe('<A-j>');
    expect(name('˚', { altKey: true })).toBe('<A-k>');
    expect(name('j')).toBe('j');
    expect(name('j', { altKey: true, ctrlKey: true })).toBe('j'); // AltGr typing stays typing
  });
});

describe('LazyVim default remaps and extra motions', () => {
  it('n always searches forward and N backward', () => {
    const rows = ['foo', 'x foo', 'foo'];
    expect(run(rows, '?foo<CR>', [1, 2]).at).toEqual([0, 0]);
    expect(run(rows, '?foo<CR>n', [1, 2]).at).toEqual([1, 2]);
    expect(run(rows, '?foo<CR>N', [1, 2]).at).toEqual([2, 0]);
    expect(run(rows, '#n', [1, 2]).at).toEqual([1, 2]); // # went up to row 0, n comes back down
    expect(run(['x foo y foo z'], '?foo<CR>dn', [0, 6]).rows).toEqual(['x foo z']); // also as an operator target
  });

  it('gj / gk move like j / k (no wrapped rows here)', () => {
    expect(run(['abc', 'def'], 'gj', [0, 1]).at).toEqual([1, 1]);
    expect(run(['abc', 'def'], 'gk', [1, 2]).at).toEqual([0, 2]);
    expect(run(['abc', 'def', 'ghi'], '2gj', [0, 1]).at).toEqual([2, 1]);
  });

  it('_ - + Enter | g_', () => {
    const rows = ['  ab  ', '  cd', 'ef'];
    expect(run(rows, '_', [0, 5]).at).toEqual([0, 2]);
    expect(run(rows, '+').at).toEqual([1, 2]);
    expect(run(rows, '<CR>').at).toEqual([1, 2]);
    expect(run(rows, '-', [2, 1]).at).toEqual([1, 2]);
    expect(run(rows, '-').at).toEqual([0, 0]); // no row above
    expect(run(rows, '4|').at).toEqual([0, 3]);
    expect(run(rows, 'g_').at).toEqual([0, 3]);
    expect(run(rows, 'd_', [1, 3]).rows).toEqual(['  ab  ', 'ef']); // linewise
    expect(run(rows, 'dg_', [0, 2]).rows).toEqual(['    ', '  cd', 'ef']);
  });

  it('LazyVim\'s [ ] prefixed keys swallow their second key', () => {
    expect(run(['foo bar'], ']dw').rows).toEqual(['foo bar']); // not "d w"
    expect(run(['foo bar'], '[b').at).toEqual([0, 0]);
  });
});

describe('robustness', () => {
  it('random LazyVim key sequences never throw or leave the cursor off the field', () => {
    const pool = [
      ...'sSrRfFtT;,dcxvViangl[]()"\'`{}bqauUdeg_.,0123wWeEjkhl$^%/?*#-+|',
      '<Esc>', '<CR>', '<BS>', '<A-j>', '<A-k>', '<C-v>', '<Del>',
    ];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 150; round++) {
      const f = loadStage(round % 12, 99);
      const vim = new Vim();
      for (let i = 0; i < 80; i++) {
        const key = pool[Math.floor(rand() * pool.length)];
        vim.key(f, key);
        expect(f.lines.length, key).toBeGreaterThan(0);
        expect(f.caret.line).toBeGreaterThanOrEqual(0);
        expect(f.caret.line).toBeLessThan(f.lines.length);
        expect(f.caret.col).toBeGreaterThanOrEqual(0);
        expect(f.caret.col).toBeLessThanOrEqual(f.lines[f.caret.line].length);
        expect(f.select).toBeNull();
        vim.status();
        vim.selection(f);
      }
    }
  });
});

describe('help screen', () => {
  // The help screen is two fixed-width columns in 22px VT323, whose advance is 0.4 em (render.ts `drawHelp`).
  const CHAR_W = 22 * 0.4;
  const KEYS_W = 276;
  const COL_W = (1500 - 28 * 2) / 2;

  it('every line fits its column', () => {
    for (const mode of MODES) {
      for (const section of mode.help) {
        expect(section.title.length * CHAR_W, section.title).toBeLessThan(COL_W - 32);
        for (const [keys, what] of section.rows) {
          expect(keys.length * CHAR_W, keys).toBeLessThan(KEYS_W);
          expect(what.length * CHAR_W, what).toBeLessThan(COL_W - KEYS_W);
        }
      }
    }
  });

  it('both columns fit the canvas height', () => {
    // the same fill as `drawHelp`: left column to about half the total, then the right
    const heightOf = (rows: number) => 26 + rows * 21 + 14;
    const room = 1100 - (100 + 62) - 20;
    for (const mode of MODES) {
      const total = mode.help.reduce((h, s) => h + heightOf(s.rows.length), 0);
      const cols = [0, 0];
      let col = 0;
      let used = 0;
      for (const s of mode.help) {
        const h = heightOf(s.rows.length);
        if (col === 0 && used > 0 && used + h / 2 > total / 2) col = 1;
        used += h;
        cols[col] += h;
      }
      expect(Math.max(...cols), mode.id).toBeLessThanOrEqual(room);
    }
  });

  it('lists the LazyVim keys', () => {
    const vim = MODES.find((m) => m.id === 'vim')!;
    const keys = vim.help.flatMap((s) => s.rows.map((r) => r[0])).join('  ');
    for (const k of ['s{text}', 'dr{text}', 'Alt-j', 'ia aa', 'in(', 'iq aq', 'g[(']) expect(keys).toContain(k);
  });
});
