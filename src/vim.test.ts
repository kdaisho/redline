/**
 * Vim engine tests (#7) — headless, on small hand-built fields. Expected results
 * are what real Vim (9.1) does with the same text and keys; the engine was also
 * checked against the `vim` binary with a differential fuzzer during development.
 *
 * Since #9 the keys are LazyVim's: quote and bracket objects follow mini.ai, `s`
 * is flash, and `n` / `N` have a fixed direction — those expectations follow the
 * plugins, not stock Vim. The LazyVim-only features are in `vim-lazyvim.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { type FieldState, type Line, type DeleteResult, createField } from './state.ts';
import { Vim } from './vim.ts';

/**
 * Build a field from text rows. Every character is red unless `blue` marks its
 * column with a `b` in the matching mask row.
 */
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

/** Split a key string into engine keys: `<Esc>`, `<CR>`, `<C-v>`, … are single keys. */
function keysOf(s: string): string[] {
  return s.match(/<[^>]+>|./g) ?? [];
}

/** Feed keys; returns every delete result, in order. */
function feed(vim: Vim, f: FieldState, keys: string): DeleteResult[] {
  const out: DeleteResult[] = [];
  for (const k of keysOf(keys)) {
    const r = vim.key(f, k);
    if (r.deleted) out.push(r.deleted);
  }
  return out;
}

/** Fresh engine + field, cursor placed, keys fed. */
function run(rows: string[], keys: string, start: [number, number] = [0, 0], blue: string[] = []) {
  const f = mk(rows, blue);
  f.caret = { line: start[0], col: start[1] };
  const vim = new Vim();
  const deletes = feed(vim, f, keys);
  return { f, vim, deletes, rows: rowsOf(f), at: at(f) };
}

describe('motions', () => {
  it('h l stay on the row and stop at its ends', () => {
    expect(run(['abc'], 'll').at).toEqual([0, 2]);
    expect(run(['abc'], 'lllll').at).toEqual([0, 2]); // cursor sits ON the last character
    expect(run(['abc'], 'h').at).toEqual([0, 0]);
    expect(run(['abcdef'], '3l').at).toEqual([0, 3]);
    expect(run(['abcdef'], '2h', [0, 5]).at).toEqual([0, 3]);
  });

  it('arrow keys are h j k l', () => {
    expect(run(['abc', 'def'], '<Right><Down>').at).toEqual([1, 1]);
    expect(run(['abc', 'def'], '<Left><Up>', [1, 2]).at).toEqual([0, 1]);
  });

  it('j k keep the sticky column across short rows', () => {
    const r = run(['abcdef', 'ab', 'abcdef'], 'j', [0, 4]);
    expect(r.at).toEqual([1, 1]);
    feed(r.vim, r.f, 'j');
    expect(at(r.f)).toEqual([2, 4]);
    expect(run(['a', 'b', 'c', 'd'], '2j').at).toEqual([2, 0]);
    expect(run(['a', 'b', 'c', 'd'], '9j').at).toEqual([3, 0]); // as far as it goes
    expect(run(['a', 'b'], 'k').at).toEqual([0, 0]);
  });

  it('$ sticks to the row end through j / k', () => {
    const r = run(['abc', 'abcdef', 'a'], '$');
    expect(r.at).toEqual([0, 2]);
    feed(r.vim, r.f, 'j');
    expect(at(r.f)).toEqual([1, 5]);
    feed(r.vim, r.f, 'j');
    expect(at(r.f)).toEqual([2, 0]);
  });

  it('0 ^ $', () => {
    expect(run(['  foo bar'], '0', [0, 5]).at).toEqual([0, 0]);
    expect(run(['  foo bar'], '^', [0, 7]).at).toEqual([0, 2]);
    expect(run(['  foo bar'], '$').at).toEqual([0, 8]);
    expect(run(['ab', 'cdef'], '2$').at).toEqual([1, 3]);
  });

  it('w treats identifiers and punctuation as separate words', () => {
    const rows = ['foo.bar(baz) qux'];
    expect(run(rows, 'w').at).toEqual([0, 3]); // .
    expect(run(rows, 'ww').at).toEqual([0, 4]); // bar
    expect(run(rows, '3w').at).toEqual([0, 7]); // (
    expect(run(rows, '6w').at).toEqual([0, 13]); // qux
  });

  it('W only stops after whitespace', () => {
    expect(run(['foo.bar(baz) qux'], 'W').at).toEqual([0, 13]);
  });

  it('w wraps to the next row and stops on an empty row', () => {
    expect(run(['foo', '  bar'], 'w').at).toEqual([1, 2]);
    expect(run(['foo', '', 'bar'], 'w').at).toEqual([1, 0]);
    expect(run(['foo', '', 'bar'], 'ww').at).toEqual([2, 0]);
    expect(run(['foo bar'], 'ww').at).toEqual([0, 6]); // last word of the field: to its last character
  });

  it('b B', () => {
    const rows = ['foo.bar(baz) qux'];
    expect(run(rows, 'b', [0, 15]).at).toEqual([0, 13]);
    expect(run(rows, 'bb', [0, 15]).at).toEqual([0, 11]); // )
    expect(run(rows, '3b', [0, 15]).at).toEqual([0, 8]); // baz
    expect(run(rows, 'B', [0, 11]).at).toEqual([0, 0]);
    expect(run(['foo', 'bar'], 'b', [1, 0]).at).toEqual([0, 0]);
    expect(run(['foo'], 'b').at).toEqual([0, 0]);
  });

  it('e E', () => {
    const rows = ['foo.bar(baz) qux'];
    expect(run(rows, 'e').at).toEqual([0, 2]);
    expect(run(rows, 'ee').at).toEqual([0, 3]);
    expect(run(rows, '3e').at).toEqual([0, 6]);
    expect(run(rows, 'E').at).toEqual([0, 11]);
    expect(run(['foo', 'bar'], 'e', [0, 2]).at).toEqual([1, 2]);
  });

  it('ge gE', () => {
    const rows = ['foo.bar(baz) qux'];
    expect(run(rows, 'ge', [0, 14]).at).toEqual([0, 11]);
    expect(run(rows, 'ge', [0, 5]).at).toEqual([0, 3]);
    expect(run(rows, '2ge', [0, 5]).at).toEqual([0, 2]);
    expect(run(rows, 'gE', [0, 14]).at).toEqual([0, 11]);
    expect(run(rows, 'gE', [0, 10]).at).toEqual([0, 0]); // no WORD end before: start of the field
    expect(run(['foo', 'bar'], 'ge', [1, 1]).at).toEqual([0, 2]);
  });

  it('gg G and counts go to the first non-blank of the row', () => {
    const rows = ['one', '  two', 'three', '  four'];
    expect(run(rows, 'G').at).toEqual([3, 2]);
    expect(run(rows, 'gg', [3, 4]).at).toEqual([0, 0]);
    expect(run(rows, '2G').at).toEqual([1, 2]);
    expect(run(rows, '3gg').at).toEqual([2, 0]);
    expect(run(rows, '99G').at).toEqual([3, 2]);
  });

  it('H M L are the top, middle and bottom rows of the field', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'];
    expect(run(rows, 'L').at).toEqual([4, 0]);
    expect(run(rows, 'M').at).toEqual([2, 0]);
    expect(run(rows, 'H', [4, 0]).at).toEqual([0, 0]);
    expect(run(rows, '2H', [4, 0]).at).toEqual([1, 0]);
    expect(run(rows, '2L').at).toEqual([3, 0]);
  });

  it('{ } move between blank rows', () => {
    const rows = ['a1', 'a2', '', 'b1', 'b2', '', 'c1'];
    expect(run(rows, '}').at).toEqual([2, 0]);
    expect(run(rows, '}}').at).toEqual([5, 0]);
    expect(run(rows, '3}').at).toEqual([6, 1]); // past the last paragraph: last character
    expect(run(rows, '{', [6, 0]).at).toEqual([5, 0]);
    expect(run(rows, '2{', [6, 0]).at).toEqual([2, 0]);
    expect(run(rows, '{', [1, 1]).at).toEqual([0, 0]);
  });

  it('f F t T and ; ,', () => {
    const rows = ['a(b,c,d)'];
    expect(run(rows, 'f,').at).toEqual([0, 3]);
    expect(run(rows, '2f,').at).toEqual([0, 5]);
    expect(run(rows, 't,').at).toEqual([0, 2]);
    expect(run(rows, 'F(', [0, 7]).at).toEqual([0, 1]);
    expect(run(rows, 'T(', [0, 7]).at).toEqual([0, 2]);
    expect(run(rows, 'f,;').at).toEqual([0, 5]);
    expect(run(rows, 'f,;,').at).toEqual([0, 3]);
    expect(run(rows, 't,;').at).toEqual([0, 4]); // ; after t jumps to before the NEXT match
    expect(run(rows, 'fz').at).toEqual([0, 0]); // not found: no move
    expect(run(rows, 'f)').at).toEqual([0, 7]);
  });

  it('% jumps between matching brackets, from the next bracket on the row', () => {
    const rows = ['fn(a[0], {b})'];
    expect(run(rows, '%').at).toEqual([0, 12]);
    expect(run(rows, '%%').at).toEqual([0, 2]);
    expect(run(rows, '%', [0, 4]).at).toEqual([0, 6]);
    expect(run(rows, '%', [0, 7]).at).toEqual([0, 11]);
    expect(run(['if (x) {', '  y', '}'], '%', [0, 7]).at).toEqual([2, 0]);
  });

  it('only a lone motion key is repeatable when held', () => {
    const f = mk(['abc def', 'ghi']);
    const vim = new Vim();
    expect(vim.key(f, 'l').repeatable).toBe(true);
    expect(vim.key(f, 'w').repeatable).toBe(true);
    expect(vim.key(f, '2').repeatable).toBe(false);
    expect(vim.key(f, 'h').repeatable).toBe(false); // had a count
    expect(vim.key(f, 'x').repeatable).toBe(false); // deletes never repeat
    expect(vim.key(f, 'f').repeatable).toBe(false);
    expect(vim.key(f, 'e').repeatable).toBe(false); // the argument of f, not a motion
  });
});

describe('operators', () => {
  it('x X delete characters, with counts, clamped to the row', () => {
    expect(run(['abcdef'], 'x').rows).toEqual(['bcdef']);
    expect(run(['abcdef'], '3x', [0, 1]).rows).toEqual(['aef']);
    expect(run(['abcdef'], '9x', [0, 4]).rows).toEqual(['abcd']);
    expect(run(['abcdef'], '9x', [0, 4]).at).toEqual([0, 3]); // cursor back onto the last character
    expect(run(['abcdef'], 'X', [0, 3]).rows).toEqual(['abdef']);
    expect(run(['abcdef'], '2X', [0, 3]).rows).toEqual(['adef']);
    expect(run(['abcdef'], 'X').deletes).toEqual([]); // nothing left of column 0
    expect(run([''], 'x').deletes).toEqual([]);
    expect(run(['ab', 'cd'], '5x').rows).toEqual(['', 'cd']); // never joins rows
  });

  it('x reports a char chord and counts as one delete', () => {
    const r = run(['abcdef'], '3x');
    expect(r.deletes).toHaveLength(1);
    expect(r.deletes[0]).toMatchObject({ red: 3, blue: 0, chord: 'char' });
  });

  it('dw de db follow exclusive / inclusive rules', () => {
    expect(run(['foo bar baz'], 'dw').rows).toEqual(['bar baz']);
    expect(run(['foo bar baz'], 'de').rows).toEqual([' bar baz']);
    expect(run(['foo bar baz'], 'db', [0, 8]).rows).toEqual(['foo baz']);
    expect(run(['foo bar baz'], 'dw', [0, 5]).rows).toEqual(['foo bbaz']);
    expect(run(['foo.bar'], 'dw').rows).toEqual(['.bar']);
    expect(run(['foo.bar'], 'dW').rows).toEqual(['']);
    expect(run(['foo bar baz'], 'dge', [0, 5]).rows).toEqual(['for baz']);
    expect(run(['foo bar'], 'dw').deletes[0].chord).toBe('word');
  });

  it('dw on the last word of a row stops at the row end', () => {
    const r = run(['foo bar', 'baz'], 'dw', [0, 4]);
    expect(r.rows).toEqual(['foo ', 'baz']);
    expect(r.at).toEqual([0, 3]);
  });

  it('counts: d2w, 2dw and 2d3w multiply', () => {
    expect(run(['a b c d e f g'], 'd2w').rows).toEqual(['c d e f g']);
    expect(run(['a b c d e f g'], '2dw').rows).toEqual(['c d e f g']);
    expect(run(['a b c d e f g'], '2d3w').rows).toEqual(['g']);
    expect(run(['a b c d e f g'], '2d3w').deletes).toHaveLength(1);
  });

  it('d2w across a row break', () => {
    // a word on the next row is a word like any other: the rows join
    expect(run(['foo bar', 'baz qux'], 'd2w', [0, 4]).rows).toEqual(['foo qux']);
    // a motion that ends in column 0 of a later row stops at the end of the row above …
    expect(run(['foo bar', '', 'baz'], 'd2w', [0, 4]).rows).toEqual(['foo ', 'baz']);
    // … and when it started in the indent, it is linewise
    expect(run(['foo', '', 'baz'], 'd2w').rows).toEqual(['baz']);
  });

  it('dd removes whole rows', () => {
    expect(run(['a', 'b', 'c'], 'dd', [1, 0]).rows).toEqual(['a', 'c']);
    expect(run(['a', 'b', 'c'], '2dd').rows).toEqual(['c']);
    expect(run(['a', 'b', 'c'], 'd2d').rows).toEqual(['c']);
    expect(run(['a', 'b', 'c'], '5dd', [1, 0]).rows).toEqual(['a']); // as many as there are
    expect(run(['a', 'b', 'c'], 'dd', [2, 0]).at).toEqual([1, 0]);
    expect(run(['only'], 'dd').rows).toEqual(['']); // the field keeps one row
    expect(run(['a', '  b'], 'dd').at).toEqual([0, 2]); // first non-blank of the row that moved up
    const r = run(['ab', 'cd', 'ef'], '2dd');
    expect(r.deletes).toHaveLength(1);
    expect(r.deletes[0]).toMatchObject({ red: 4, chord: 'line' });
  });

  it('D d$ d0 d^', () => {
    expect(run(['foo bar baz'], 'D', [0, 4]).rows).toEqual(['foo ']);
    expect(run(['foo bar baz'], 'D', [0, 4]).at).toEqual([0, 3]);
    expect(run(['foo bar baz'], 'd$', [0, 4]).rows).toEqual(['foo ']);
    expect(run(['foo bar baz'], 'd0', [0, 4]).rows).toEqual(['bar baz']);
    expect(run(['  foo bar'], 'd^', [0, 6]).rows).toEqual(['  bar']);
    expect(run(['foo', 'bar', 'baz'], '2D', [0, 1]).rows).toEqual(['f', 'baz']);
    expect(run(['foo bar'], 'D', [0, 4]).deletes[0].chord).toBe('line');
  });

  it('linewise motions: dj dk dG dgg', () => {
    const rows = ['a', 'b', 'c', 'd'];
    expect(run(rows, 'dj', [1, 0]).rows).toEqual(['a', 'd']);
    expect(run(rows, 'dk', [1, 0]).rows).toEqual(['c', 'd']);
    expect(run(rows, 'dG', [2, 0]).rows).toEqual(['a', 'b']);
    expect(run(rows, 'dgg', [1, 0]).rows).toEqual(['c', 'd']);
    expect(run(rows, 'd2j').rows).toEqual(['d']);
    expect(run(rows, 'dj', [3, 0]).deletes).toEqual([]); // no row below: the command fails
  });

  it('df dt dF dT and d;', () => {
    expect(run(['a(b,c,d)'], 'df,').rows).toEqual(['c,d)']);
    expect(run(['a(b,c,d)'], 'dt,').rows).toEqual([',c,d)']);
    expect(run(['a(b,c,d)'], 'd2f,').rows).toEqual(['d)']);
    expect(run(['a(b,c,d)'], 'dF(', [0, 4]).rows).toEqual(['ac,d)']);
    expect(run(['a(b,c,d)'], 'dT(', [0, 4]).rows).toEqual(['a(c,d)']);
    expect(run(['a(b,c,d)'], 'f,d;').rows).toEqual(['a(bd)']);
    expect(run(['a(b,c,d)'], 'dfz').deletes).toEqual([]);
  });

  it('d% deletes through the matching bracket', () => {
    expect(run(['fn(a, b).c'], 'd%', [0, 2]).rows).toEqual(['fn.c']);
    expect(run(['fn(a, b).c'], 'd%', [0, 7]).rows).toEqual(['fn.c']);
  });

  it('d} and d{', () => {
    expect(run(['a b', 'c', '', 'd'], 'd}', [0, 2]).rows).toEqual(['a ', '', 'd']);
    expect(run(['a', 'b', '', 'c'], 'd}').rows).toEqual(['', 'c']); // from column 0: linewise
    expect(run(['', 'a', 'bc'], 'd{', [2, 1]).rows).toEqual(['c']);
  });

  it('c C delete like d D; s and S belong to flash (LazyVim) and delete nothing', () => {
    expect(run(['foo bar'], 'cw').rows).toEqual(['bar']);
    expect(run(['foo bar'], 'C', [0, 3]).rows).toEqual(['foo']);
    expect(run(['a', 'b'], 'cc').rows).toEqual(['b']);
    expect(run(['foo bar'], 's').rows).toEqual(['foo bar']);
    expect(run(['a', 'b'], 'S').rows).toEqual(['a', 'b']);
    expect(run(['a', 'b'], 'dc').rows).toEqual(['a', 'b']); // mixed operators cancel
  });

  it('a motion that runs out of text goes as far as it can', () => {
    expect(run(['a b', 'c d'], '9e').at).toEqual([1, 2]);
    expect(run(['a b', 'c d'], '9b', [1, 2]).at).toEqual([0, 0]);
    expect(run(['a b', 'c d'], 'd9e', [0, 2]).rows).toEqual(['a ']); // d still acts on a short e …
    expect(run(['a b', 'c d'], 'd9b', [1, 2]).rows).toEqual(['d']); // … and on a b that reaches the top
    expect(run(['a b', 'c d'], 'd9b').deletes).toEqual([]); // but b at the very start fails
  });

  it('insert-ish and unsupported keys do nothing', () => {
    const rows = ['foo bar', 'baz'];
    for (const keys of ['i', 'a', 'o', 'O', 'I', 'A', 'u', 'p', 'P', 'y', 'J', '~', '<BS>', ' ', 'K']) {
      const r = run(rows, keys, [0, 2]);
      expect(r.rows, keys).toEqual(rows);
      expect(r.at, keys).toEqual([0, 2]);
    }
    // keys that take a character in Vim swallow it, so it cannot fire as a command
    expect(run(rows, 'rx').rows).toEqual(rows);
    expect(run(rows, 'mx').rows).toEqual(rows);
    expect(run(rows, '"x').rows).toEqual(rows);
    // an unsupported key drops the pending command
    expect(run(rows, 'dux').rows).toEqual(['oo bar', 'baz']);
  });

  it('Esc cancels a pending command', () => {
    expect(run(['foo bar'], 'd<Esc>w').rows).toEqual(['foo bar']);
    expect(run(['foo bar'], 'd<Esc>w').at).toEqual([0, 4]);
    expect(run(['foo bar'], '3<Esc>x').rows).toEqual(['oo bar']);
  });

  it('a delete that touches blue reports it', () => {
    const r = run(['foo bar'], 'dd', [0, 0], ['    bbb']);
    expect(r.deletes[0]).toMatchObject({ red: 3, blue: 3 });
    expect(r.deletes[0].cells).toHaveLength(6);
    expect(run(['foo bar'], 'dw', [0, 0], ['    bbb']).deletes[0]).toMatchObject({ red: 3, blue: 0 });
  });
});

describe('text objects', () => {
  it('diw daw', () => {
    expect(run(['foo bar baz'], 'diw', [0, 5]).rows).toEqual(['foo  baz']);
    expect(run(['foo bar baz'], 'daw', [0, 5]).rows).toEqual(['foo baz']);
    expect(run(['foo bar baz'], 'daw', [0, 9]).rows).toEqual(['foo bar']); // last word: takes the space before
    expect(run(['foo bar baz'], 'diw', [0, 3]).rows).toEqual(['foobar baz']); // on the space: the space
    expect(run(['foo bar baz'], 'daw', [0, 3]).rows).toEqual(['foo baz']); // on the space: space + next word
    expect(run(['foo.bar baz'], 'diw', [0, 5]).rows).toEqual(['foo. baz']);
    expect(run(['foo.bar baz'], 'diw', [0, 3]).rows).toEqual(['foobar baz']);
    expect(run(['  foo'], 'daw', [0, 3]).rows).toEqual(['  ']); // the indent is not taken
    expect(run(['foo bar baz'], 'diw', [0, 5]).deletes[0].chord).toBe('word');
  });

  it('diW daW', () => {
    expect(run(['a foo.bar(x) b'], 'diW', [0, 5]).rows).toEqual(['a  b']);
    expect(run(['a foo.bar(x) b'], 'daW', [0, 5]).rows).toEqual(['a b']);
  });

  it('counts on word objects', () => {
    expect(run(['a b c d'], 'd2aw').rows).toEqual(['c d']);
    expect(run(['a b c d'], 'd3iw').rows).toEqual([' c d']); // word, space, word
  });

  it('quotes', () => {
    const rows = ['on("close", fn)'];
    expect(run(rows, 'di"', [0, 6]).rows).toEqual(['on("", fn)']);
    expect(run(rows, 'da"', [0, 6]).rows).toEqual(['on(, fn)']);
    expect(run(rows, 'di"', [0, 3]).rows).toEqual(['on("", fn)']); // on the opening quote
    expect(run(rows, 'di"', [0, 9]).rows).toEqual(['on("", fn)']); // on the closing quote
    expect(run(rows, 'di"').rows).toEqual(['on("", fn)']); // before it: the next string on the row
    expect(run(["a 'b' c"], "da'", [0, 3]).rows).toEqual(['a  c']); // mini.ai: just the quotes, no space
    expect(run(["a 'b'"], "da'", [0, 3]).rows).toEqual(['a ']);
    expect(run(['a `b` c'], 'di`', [0, 3]).rows).toEqual(['a `` c']);
    expect(run(['no quotes'], 'di"').deletes).toEqual([]);
  });

  it('brackets', () => {
    const rows = ['f(a, g[1], {k})'];
    expect(run(rows, 'di(', [0, 3]).rows).toEqual(['f()']);
    expect(run(rows, 'da(', [0, 3]).rows).toEqual(['f']);
    expect(run(rows, 'dib', [0, 3]).rows).toEqual(['f()']);
    expect(run(rows, 'di)', [0, 1]).rows).toEqual(['f()']); // on the bracket itself
    expect(run(rows, 'di[', [0, 7]).rows).toEqual(['f(a, g[], {k})']);
    expect(run(rows, 'da]', [0, 7]).rows).toEqual(['f(a, g, {k})']);
    expect(run(rows, 'di{', [0, 12]).rows).toEqual(['f(a, g[1], {})']);
    expect(run(rows, 'daB', [0, 12]).rows).toEqual(['f(a, g[1], )']);
    expect(run(rows, 'd2i[', [0, 7]).deletes).toEqual([]); // no second [ ] level
    expect(run(['a () b'], 'di(', [0, 2]).deletes).toEqual([]); // nothing inside…
    expect(run(['a () b'], 'di(', [0, 2]).at).toEqual([0, 3]); // …but the cursor moves in
    expect(run(rows, 'di(', [0, 7]).rows).toEqual(['f()']); // from inside the nested [ ]
    expect(run(['a<b, c>d'], 'di<', [0, 3]).rows).toEqual(['a<>d']);
    expect(run(['((a) b)'], 'di(', [0, 2]).rows).toEqual(['(() b)']);
    expect(run(['((a) b)'], 'd2i(', [0, 2]).rows).toEqual(['()']);
    expect(run(['no brackets'], 'di(').deletes).toEqual([]);
  });

  it('brackets: outside any pair, the next pair is used', () => {
    expect(run(['a (b) c'], 'di(').rows).toEqual(['a () c']);
    expect(run(['a (b) c'], 'da(').rows).toEqual(['a  c']);
    expect(run(['a [b] {c}'], 'di{').rows).toEqual(['a [b] {}']);
    expect(run(['a b', 'c (d) e'], 'da(').rows).toEqual(['a b', 'c  e']); // also on a later row
    expect(run(['(a) b (c)'], 'di(', [0, 4]).rows).toEqual(['(a) b ()']);
    expect(run(['(a) b'], 'di(', [0, 4]).deletes).toEqual([]); // nothing after the cursor
    expect(run(['a ) b (c)'], 'di(').rows).toEqual(['a ) b ()']); // a stray ) is not part of any pair
    expect(run(['a (b', 'c'], 'di(', [1, 0]).deletes).toEqual([]); // inside an unclosed (: no fallback
  });

  it('brackets across rows', () => {
    expect(run(['f(a,', 'b)'], 'di(', [1, 0]).rows).toEqual(['f()']);
    // mini.ai: i{ is the text without the whitespace around it; i} is everything between the brackets
    expect(run(['fn {', '  a', '  b', '}'], 'di{', [1, 2]).rows).toEqual(['fn {', '  ', '}']);
    expect(run(['fn {', '  a', '  b', '}'], 'di}', [1, 2]).rows).toEqual(['fn {}']);
    // Vim's own iB is still linewise here
    expect(run(['fn {', '  a', '  b', '}'], 'diB', [1, 2]).rows).toEqual(['fn {', '}']);
    expect(run(['fn {', '  a', '}', 'x'], 'da{', [1, 2]).rows).toEqual(['fn ', 'x']);
  });

  it('i and a alone (no operator) do nothing', () => {
    expect(run(['foo bar'], 'iw').rows).toEqual(['foo bar']);
    expect(run(['foo bar'], 'iw').at).toEqual([0, 4]); // i is ignored, w still moves
  });
});

describe('visual modes', () => {
  it('v selects inclusively and d deletes the selection', () => {
    const r = run(['foo bar baz'], 'vee', [0, 0]);
    expect(r.vim.mode).toBe('visual');
    expect(r.vim.selection(r.f)).toEqual([{ line: 0, from: 0, to: 7 }]);
    const d = feed(r.vim, r.f, 'd');
    expect(rowsOf(r.f)).toEqual([' baz']);
    expect(r.vim.mode).toBe('normal');
    expect(d[0].chord).toBe('selection');
  });

  it('v works backwards and across rows (joining them)', () => {
    expect(run(['foo bar'], 'vbd', [0, 5]).rows).toEqual(['foo r']);
    expect(run(['abc', 'def', 'ghi'], 'vjd', [0, 1]).rows).toEqual(['af', 'ghi']);
    expect(run(['abc', 'def', 'ghi'], 'vjjx', [0, 1]).rows).toEqual(['ai']);
  });

  it('v with $ takes the row break', () => {
    expect(run(['abc', 'def'], 'v$d', [0, 1]).rows).toEqual(['adef']);
    expect(run(['abc', 'def'], '$vd').rows).toEqual(['ab', 'def']); // $ before v does not
    expect(run(['abc', 'def'], 'v$hd', [0, 1]).rows).toEqual(['a', 'def']); // h steps back onto the "c"
    expect(run(['abc', 'def'], 'vlld', [0, 1]).rows).toEqual(['adef']); // l can step onto the row break too
    expect(run(['abcdef', 'ab', 'x'], 'vjd', [0, 4]).rows).toEqual(['abcdx']); // so can j onto a shorter row
    const r = run(['abc', 'def'], 'v$', [0, 1]);
    expect(r.at).toEqual([0, 3]); // the cursor rests past the last character
    expect(r.vim.selection(r.f)).toEqual([{ line: 0, from: 1, to: 4 }]);
    feed(r.vim, r.f, '<Esc>');
    expect(at(r.f)).toEqual([0, 2]); // back onto a character in Normal mode
  });

  it('Esc and v leave Visual mode without deleting', () => {
    const r = run(['foo bar'], 'vw<Esc>');
    expect(r.vim.mode).toBe('normal');
    expect(r.rows).toEqual(['foo bar']);
    expect(r.at).toEqual([0, 4]);
    expect(run(['foo bar'], 'vwv').vim.mode).toBe('normal');
    expect(run(['foo bar'], 'vV').vim.mode).toBe('visual-line');
    expect(run(['foo bar'], 'V<C-v>').vim.mode).toBe('visual-block');
  });

  it('o jumps to the other end of the selection', () => {
    const r = run(['foo bar baz'], 'vwo', [0, 4]);
    expect(r.at).toEqual([0, 4]);
    feed(r.vim, r.f, 'bd');
    expect(rowsOf(r.f)).toEqual(['az']);
  });

  it('V deletes whole rows', () => {
    expect(run(['a', 'b', 'c', 'd'], 'Vjd', [1, 0]).rows).toEqual(['a', 'd']);
    expect(run(['a', 'b', 'c', 'd'], 'Vkd', [1, 0]).rows).toEqual(['c', 'd']);
    expect(run(['abc', 'def'], 'Vd', [0, 2]).rows).toEqual(['def']);
    const r = run(['abc', 'def'], 'V', [0, 2]);
    expect(r.vim.selection(r.f)).toEqual([{ line: 0, from: 0, to: 3 }]);
  });

  it('X and D in Visual delete the selected rows', () => {
    expect(run(['abc', 'def', 'ghi'], 'vjX', [0, 1]).rows).toEqual(['ghi']);
    expect(run(['abc', 'def', 'ghi'], 'vD', [1, 1]).rows).toEqual(['abc', 'ghi']);
  });

  it('Ctrl-v deletes a rectangle', () => {
    const rows = ['abcdef', 'ghijkl', 'mnopqr'];
    const r = run(rows, '<C-v>jl', [0, 1]);
    expect(r.vim.mode).toBe('visual-block');
    expect(r.vim.selection(r.f)).toEqual([
      { line: 0, from: 1, to: 3 },
      { line: 1, from: 1, to: 3 },
    ]);
    const d = feed(r.vim, r.f, 'd');
    expect(rowsOf(r.f)).toEqual(['adef', 'gjkl', 'mnopqr']);
    expect(at(r.f)).toEqual([0, 1]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ red: 4, chord: 'selection' });
  });

  it('Ctrl-v clips to short rows; $ and D reach every row end', () => {
    expect(run(['abcdef', 'gh', 'mnopqr'], '<C-v>jjlld', [0, 1]).rows).toEqual(['aef', 'g', 'mqr']);
    expect(run(['abcdef', 'gh', 'mnopqr'], '<C-v>jj$d', [0, 1]).rows).toEqual(['a', 'g', 'm']);
    expect(run(['abcdef', 'gh', 'mnopqr'], '<C-v>jjD', [0, 3]).rows).toEqual(['abc', 'gh', 'mno']);
  });

  it('text objects select in Visual mode', () => {
    expect(run(['foo bar baz'], 'viwd', [0, 5]).rows).toEqual(['foo  baz']);
    expect(run(['foo bar baz'], 'vawd', [0, 5]).rows).toEqual(['foo baz']);
    expect(run(['f(a, b) c'], 'vi(d', [0, 3]).rows).toEqual(['f() c']);
    expect(run(['f(a, b) c'], 'va(d', [0, 3]).rows).toEqual(['f c']);
    expect(run(['x "yy" z'], 'vi"d').rows).toEqual(['x "" z']);
  });

  it('counts and searches extend the selection', () => {
    expect(run(['a b c d e'], 'v2wd').rows).toEqual([' d e']);
    expect(run(['a b c d e'], 'v/d<CR>d').rows).toEqual([' e']);
    expect(run(['a(b)c'], 'vf)d').rows).toEqual(['c']);
  });
});

describe('dot repeat', () => {
  it('repeats x, dw, dd and text objects', () => {
    expect(run(['abcdef'], 'x..').rows).toEqual(['def']);
    expect(run(['a b c d'], 'dw.').rows).toEqual(['c d']);
    expect(run(['a', 'b', 'c', 'd'], 'dd.').rows).toEqual(['c', 'd']);
    expect(run(['f(a) g(b)'], 'di(').rows).toEqual(['f() g(b)']);
    const r = run(['f(a) g(b)'], 'di(', [0, 2]);
    feed(r.vim, r.f, 'f(.');
    expect(rowsOf(r.f)).toEqual(['f() g()']);
  });

  it('keeps the count, and a new count replaces it', () => {
    expect(run(['abcdefgh'], '2x.').rows).toEqual(['efgh']);
    expect(run(['abcdefgh'], '2x3.').rows).toEqual(['fgh']);
    expect(run(['abcdefgh'], '2x3..').rows).toEqual(['']); // the new count sticks… and clamps
    expect(run(['a', 'b', 'c', 'd', 'e'], '2dd.').rows).toEqual(['e']);
  });

  it('repeats df with its character and D', () => {
    expect(run(['a,b,c,d'], 'df,.').rows).toEqual(['c,d']);
    const r = run(['abc', 'def'], 'D', [0, 1]);
    feed(r.vim, r.f, 'jl.'); // cursor is on 'a' → down, right → 'e'
    expect(rowsOf(r.f)).toEqual(['a', 'd']);
  });

  it('each repeat is its own delete with the original chord', () => {
    const r = run(['a b c d'], 'dw..');
    expect(r.deletes.map((d) => d.chord)).toEqual(['word', 'word', 'word']);
  });

  it('repeats a Visual delete over the same amount of text', () => {
    expect(run(['abcdefgh'], 'vlld.').rows).toEqual(['gh']);
    expect(run(['a', 'b', 'c', 'd', 'e'], 'Vjd.').rows).toEqual(['e']);
    const r = run(['abcd', 'efgh', 'ijkl', 'mnop'], '<C-v>jld');
    expect(rowsOf(r.f)).toEqual(['cd', 'gh', 'ijkl', 'mnop']);
    feed(r.vim, r.f, 'jj.');
    expect(rowsOf(r.f)).toEqual(['cd', 'gh', 'kl', 'op']);
  });

  it('remembers a command that ran over nothing', () => {
    // X at column 0 deletes nothing, but it is still the last command
    expect(run(['abc def'], 'dwX$.').rows).toEqual(['df']);
  });

  it('does nothing before any delete', () => {
    expect(run(['abc'], '.').deletes).toEqual([]);
  });
});

describe('search', () => {
  const rows = ['foo bar', 'baz foo', 'foobar foo'];

  it('/ jumps to the next match and wraps', () => {
    expect(run(rows, '/foo<CR>').at).toEqual([1, 4]);
    expect(run(rows, '/foo<CR>n').at).toEqual([2, 0]);
    expect(run(rows, '/foo<CR>nn').at).toEqual([2, 7]);
    expect(run(rows, '/foo<CR>nnn').at).toEqual([0, 0]); // wrapped
    expect(run(rows, '/foo<CR>N').at).toEqual([0, 0]);
    expect(run(rows, '2/foo<CR>').at).toEqual([2, 0]);
  });

  it('? searches backward; n still goes forward and N backward (LazyVim)', () => {
    expect(run(rows, '?foo<CR>').at).toEqual([2, 7]); // wrapped to the bottom
    expect(run(rows, '?foo<CR>n').at).toEqual([0, 0]); // forward, wrapping to the top
    expect(run(rows, '?foo<CR>N').at).toEqual([2, 0]);
  });

  it('shows the prompt while typing; Backspace edits; Esc cancels', () => {
    const f = mk(rows);
    const vim = new Vim();
    feed(vim, f, '/fox');
    expect(vim.status().prompt).toBe('/fox');
    feed(vim, f, '<BS>o');
    expect(vim.status().prompt).toBe('/foo');
    feed(vim, f, '<Esc>');
    expect(vim.status().prompt).toBeNull();
    expect(at(f)).toEqual([0, 0]);
    feed(vim, f, '/x<BS><BS>'); // Backspace on an empty pattern leaves the prompt
    expect(vim.status().prompt).toBeNull();
  });

  it('keys typed in the prompt are pattern text, not commands', () => {
    const r = run(['a dd x', 'b dd y'], '/dd<CR>');
    expect(r.rows).toEqual(['a dd x', 'b dd y']);
    expect(r.at).toEqual([0, 2]);
    expect(run(['a b', 'c a b'], '/a b<CR>').at).toEqual([1, 2]); // spaces are literal
  });

  it('a missing pattern does not move and leaves a message', () => {
    const r = run(rows, '/nope<CR>');
    expect(r.at).toEqual([0, 0]);
    expect(r.vim.status().message).toBe('Pattern not found: nope');
    feed(r.vim, r.f, 'l');
    expect(r.vim.status().message).toBe('');
  });

  it('an empty pattern reuses the last one', () => {
    expect(run(rows, '/foo<CR>/<CR>').at).toEqual([2, 0]);
    expect(run(rows, '/foo<CR>?<CR>').at).toEqual([0, 0]);
    expect(run(rows, 'n').vim.status().message).toBe('No previous search');
  });

  it('* and # search for the whole identifier under the cursor', () => {
    expect(run(rows, '*').at).toEqual([1, 4]); // not the "foo" inside "foobar"
    expect(run(rows, '**').at).toEqual([2, 7]);
    expect(run(rows, '***').at).toEqual([0, 0]);
    expect(run(rows, '#').at).toEqual([2, 7]);
    expect(run(rows, '*', [0, 2]).at).toEqual([1, 4]); // from the middle of the word
    expect(run(rows, '*n').at).toEqual([2, 7]); // n continues the * search
    expect(run(['a.b a.b'], '*', [0, 1]).at).toEqual([0, 6]); // on punctuation: the next identifier on the row
  });

  it('search is an exclusive motion for d', () => {
    expect(run(['a b c d'], 'd/c<CR>').rows).toEqual(['c d']);
    expect(run(['a b c d'], 'd/c<CR>').deletes[0].chord).toBe('word');
    expect(run(['a b c d'], '/c<CR>0dn').rows).toEqual(['c d']);
    expect(run(['a b c d', 'x c'], 'd/c<CR>.').rows).toEqual(['c']);
  });
});

describe('status line', () => {
  it('shows the pending keys of an unfinished command', () => {
    const f = mk(['foo bar baz']);
    const vim = new Vim();
    feed(vim, f, '2d');
    expect(vim.status().pending).toBe('2d');
    feed(vim, f, '3');
    expect(vim.status().pending).toBe('2d3');
    feed(vim, f, 'w');
    expect(vim.status().pending).toBe('');
    feed(vim, f, 'g');
    expect(vim.status().pending).toBe('g');
    feed(vim, f, 'g');
    feed(vim, f, 'df');
    expect(vim.status().pending).toBe('df');
    feed(vim, f, '<Esc>');
    expect(vim.status().pending).toBe('');
  });

  it('reports the mode', () => {
    const f = mk(['foo']);
    const vim = new Vim();
    expect(vim.status().mode).toBe('normal');
    feed(vim, f, 'v');
    expect(vim.status().mode).toBe('visual');
    vim.reset();
    expect(vim.status().mode).toBe('normal');
  });
});
