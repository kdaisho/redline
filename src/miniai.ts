/**
 * mini.ai text objects (#9), as LazyVim configures them — a port of the parts of
 * mini.ai that work without a syntax tree. Pure: reads the field's rows, returns
 * a region.
 *
 * Like mini.ai, the field is treated as one string (rows joined by `\n`), every
 * object is a list of candidate spans in it, and the best candidate is chosen by
 * the search method:
 *  - `cover_or_next` (`a(` / `i(`): the narrowest span covering the cursor (or the
 *    Visual selection), else the first span starting after it;
 *  - `next` (`an(` / `in(`) and `prev` (`al(` / `il(`): the nearest span after /
 *    before, never a covering one.
 * The search runs on the cursor's row first and only then on the whole field, so
 * a later object on the row wins over an enclosing one that spans rows. A count
 * (`2a(`) repeats the search from the span just found, which steps outward.
 *
 * Objects: `( ) [ ] { } < >` (open bracket: `i` trims the inner whitespace; close
 * bracket: it keeps it), `b` (any of `) ] }`), `" ' \`` and `q` (any quote; quotes
 * pair up from the left), `a` (argument between commas), `u` / `U` (function call,
 * with / without dots in the name), `d` (digits), `e` (camelCase / snake_case
 * part), `g` (the whole field), and any other non-letter as mini.ai's default
 * object (`a_` = up to and including the next run of `_`).
 */
import { type Line, type Pos } from './state.ts';

export type AiMethod = 'cover_or_next' | 'next' | 'prev';

/** `[start, end)` in reading order, or — for an object that exists but covers no text — where it sits. */
export type AiRegion = { start: Pos; end: Pos } | { empty: Pos };

/** A half-open stretch of the flat string. */
interface Span {
  from: number;
  to: number;
}

/** A candidate: the span that is matched against the cursor, and what `a` / `i` take from it. */
interface Cand extends Span {
  a: Span;
  i: Span;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
const CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };
const QUOTES = ['"', "'", '`'];

const isWs = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\t';
const isLetter = (ch: string): boolean => /^[A-Za-z]$/.test(ch);

/** True when `id` names a mini.ai object this port implements. */
export function aiSupports(id: string): boolean {
  if (id.length !== 1) return false;
  if (!isLetter(id)) return id !== '?'; // brackets, quotes, and the default object; `?` needs a prompt
  return 'bqauUdeg'.includes(id);
}

// ── candidate generators (all positions are offsets into the flat string) ────
/** Every balanced `open … close` pair inside `[lo, hi)`, by start. */
function balanced(s: string, lo: number, hi: number, open: string, close: string): Span[] {
  const stack: number[] = [];
  const out: Span[] = [];
  for (let i = lo; i < hi; i++) {
    if (s[i] === open) stack.push(i);
    else if (s[i] === close && stack.length) out.push({ from: stack.pop()!, to: i + 1 });
  }
  return out.sort((x, y) => x.from - y.from);
}

/** Quotes pair up from the left: 1st with 2nd, 3rd with 4th … */
function quoted(s: string, lo: number, hi: number, q: string): Span[] {
  const out: Span[] = [];
  let open = -1;
  for (let i = lo; i < hi; i++) {
    if (s[i] !== q) continue;
    if (open < 0) open = i;
    else {
      out.push({ from: open, to: i + 1 });
      open = -1;
    }
  }
  return out;
}

/** `[from, to)` without the whitespace at either end (empty, at its end, when it is all whitespace). */
function trim(s: string, from: number, to: number): Span {
  let f = from;
  while (f < to && isWs(s[f])) f++;
  let t = to;
  while (t > f && isWs(s[t - 1])) t--;
  return { from: f, to: t };
}

const whole = (sp: Span): Cand => ({ ...sp, a: sp, i: sp });
/** A pair whose `i` is everything between its two edge characters. */
const pairStrict = (sp: Span): Cand => ({ ...sp, a: sp, i: { from: sp.from + 1, to: sp.to - 1 } });
/** A pair whose `i` also drops the whitespace just inside the edges. */
const pairTrimmed = (s: string, sp: Span): Cand => ({ ...sp, a: sp, i: trim(s, sp.from + 1, sp.to - 1) });

/** `a`: the arguments of every `()` `[]` `{}` pair, split at top-level commas. */
function argumentCands(s: string, lo: number, hi: number): Cand[] {
  const out: Cand[] = [];
  for (const open of ['(', '[', '{']) {
    for (const pair of balanced(s, lo, hi, open, OPEN[open])) {
      if (pair.to - pair.from <= 2) continue; // `()` has no arguments
      const inLo = pair.from + 1;
      const inHi = pair.to - 1;
      // commas inside nested brackets or quotes do not separate
      const skip: Span[] = [
        ...quoted(s, inLo, inHi, '"'),
        ...quoted(s, inLo, inHi, "'"),
        ...balanced(s, inLo, inHi, '(', ')'),
        ...balanced(s, inLo, inHi, '[', ']'),
        ...balanced(s, inLo, inHi, '{', '}'),
      ];
      const seps = [pair.from];
      for (let i = inLo; i < inHi; i++) {
        if (s[i] === ',' && !skip.some((r) => r.from <= i && i < r.to)) seps.push(i);
      }
      seps.push(inHi);
      for (let k = 0; k + 1 < seps.length; k++) {
        const left = seps[k];
        const right = seps[k + 1];
        const first = k === 0;
        const last = k + 2 === seps.length;
        if (first && last) {
          // the only argument: `a` is everything inside, `i` drops the padding
          const sp = { from: left + 1, to: right };
          out.push({ ...sp, a: sp, i: trim(s, sp.from, sp.to) });
        } else if (first) {
          // first: takes the comma after it, not the padding before it
          const inner = trim(s, left + 1, right);
          out.push({ from: left + 1, to: right + 1, a: { from: inner.from, to: right + 1 }, i: inner });
        } else {
          // middle / last: takes the comma before it, not the padding after it
          const inner = trim(s, left + 1, right);
          out.push({ from: left, to: right, a: { from: left, to: inner.to }, i: inner });
        }
      }
    }
  }
  return out;
}

/** `u` / `U`: a name directly followed by a balanced `( … )`. */
function callCands(s: string, lo: number, hi: number, dots: boolean): Cand[] {
  const nameCh = dots ? /[A-Za-z0-9_.]/ : /[A-Za-z0-9_]/;
  const out: Cand[] = [];
  for (const pair of balanced(s, lo, hi, '(', ')')) {
    let start = pair.from;
    while (start > lo && nameCh.test(s[start - 1])) start--;
    if (start === pair.from) continue;
    out.push({ from: start, to: pair.to, a: { from: start, to: pair.to }, i: { from: pair.from + 1, to: pair.to - 1 } });
  }
  return out;
}

/** Maximal runs of characters matching `re`. */
function runs(s: string, lo: number, hi: number, re: RegExp): Span[] {
  const out: Span[] = [];
  for (let i = lo; i < hi; ) {
    if (!re.test(s[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < hi && re.test(s[j])) j++;
    out.push({ from: i, to: j });
    i = j;
  }
  return out;
}

/** `e`: one part of a camelCase / snake_case name — a lowercase+digit run, with the capital before it. */
function subwordCands(s: string, lo: number, hi: number): Cand[] {
  return runs(s, lo, hi, /[a-z0-9]/).map((r) =>
    whole(r.from > lo && /[A-Z]/.test(s[r.from - 1]) ? { from: r.from - 1, to: r.to } : r),
  );
}

/**
 * mini.ai's default object for a non-letter `x`: from one `x` to the next run of
 * `x`. `i` is the text between; `a` also takes the run that ends it.
 */
function separatorCands(s: string, lo: number, hi: number, x: string): Cand[] {
  const out: Cand[] = [];
  for (let p = lo; p < hi; p++) {
    if (s[p] !== x) continue;
    let q = p + 1;
    while (q < hi && s[q] !== x) q++;
    if (q >= hi) break;
    let r = q;
    while (r < hi && s[r] === x) r++;
    out.push({ from: p, to: r, a: { from: p + 1, to: r }, i: { from: p + 1, to: q } });
  }
  return out;
}

function candidates(s: string, lo: number, hi: number, id: string): Cand[] {
  if (OPEN[id]) return balanced(s, lo, hi, id, OPEN[id]).map((sp) => pairTrimmed(s, sp));
  if (CLOSE[id]) return balanced(s, lo, hi, CLOSE[id], id).map(pairStrict);
  if (QUOTES.includes(id)) return quoted(s, lo, hi, id).map(pairStrict);
  switch (id) {
    case 'b':
      return ['(', '[', '{'].flatMap((o) => balanced(s, lo, hi, o, OPEN[o]).map(pairStrict));
    case 'q':
      return ["'", '"', '`'].flatMap((q) => quoted(s, lo, hi, q).map(pairStrict));
    case 'a':
      return argumentCands(s, lo, hi);
    case 'u':
      return callCands(s, lo, hi, true);
    case 'U':
      return callCands(s, lo, hi, false);
    case 'd':
      return runs(s, lo, hi, /[0-9]/).map(whole);
    case 'e':
      return subwordCands(s, lo, hi);
  }
  return separatorCands(s, lo, hi, id);
}

// ── choosing the best candidate (mini.ai's span comparison) ──────────────────
function covers(span: Span | null, other: Span): boolean {
  if (!span || span.from === span.to) return false;
  if (other.from === other.to) return span.from <= other.from && other.to < span.to;
  return span.from <= other.from && other.to <= span.to;
}

const onLeft = (x: Span, y: Span): boolean => x.from <= y.from && x.to <= y.to;

function better(cand: Cand, cur: Cand | null, ref: Span, method: AiMethod): boolean {
  // never the reference itself, or something inside it
  if (covers(ref, cand) || (cand.from === ref.from && cand.to === ref.to)) return false;

  if (method === 'cover_or_next') {
    const candCovers = covers(cand, ref);
    const curCovers = covers(cur, ref);
    if (candCovers && curCovers) return cand.to - cand.from < cur!.to - cur!.from;
    if (candCovers) return true;
    if (curCovers) return false;
  } else if (covers(cand, ref)) {
    return false;
  }

  if (method === 'prev') {
    if (!onLeft(cand, ref)) return false;
    return !cur || Math.abs(cand.to - ref.to) < Math.abs(cur.to - ref.to);
  }
  if (!onLeft(ref, cand)) return false;
  return !cur || Math.abs(cand.from - ref.from) < Math.abs(cur.from - ref.from);
}

function best(cands: Cand[], ref: Span, method: AiMethod): Cand | null {
  let cur: Cand | null = null;
  for (const c of cands) if (better(c, cur, ref, method)) cur = c;
  return cur;
}

// ── the public search ────────────────────────────────────────────────────────
/**
 * Find a text object. The reference is the cursor (`refEnd` null), or a Visual
 * selection `refStart..refEnd` (inclusive). Returns null when there is none.
 */
export function findAi(
  lines: Line[],
  refStart: Pos,
  refEnd: Pos | null,
  ai: 'a' | 'i',
  id: string,
  count: number,
  method: AiMethod,
): AiRegion | null {
  if (!aiSupports(id)) return null;

  // `g`: the whole field; `ig` leaves out blank rows at the top and bottom.
  if (id === 'g') {
    let top = 0;
    let bottom = lines.length - 1;
    if (ai === 'i') {
      const blank = (ln: Line) => ln.every((b) => b.color === null);
      while (top <= bottom && blank(lines[top])) top++;
      while (bottom >= top && blank(lines[bottom])) bottom--;
      if (top > bottom) return { empty: { line: 0, col: 0 } };
    }
    const end = { line: bottom, col: lines[bottom].length };
    return top === bottom && end.col === 0 ? { empty: { line: top, col: 0 } } : { start: { line: top, col: 0 }, end };
  }

  // flatten: every row ends in a `\n`
  const starts: number[] = [];
  let s = '';
  for (const ln of lines) {
    starts.push(s.length);
    for (const b of ln) s += b.color === null ? ' ' : b.ch;
    s += '\n';
  }
  const offset = (p: Pos): number => starts[p.line] + Math.min(p.col, lines[p.line].length);
  const posOf = (o: number): Pos => {
    let line = starts.length - 1;
    while (line > 0 && starts[line] > o) line--;
    return { line, col: Math.min(o - starts[line], lines[line].length) };
  };

  const from = offset(refStart);
  const ref: Span = { from, to: refEnd ? offset(refEnd) + 1 : from };

  // First the reference's own rows, then the whole field.
  const rowLo = starts[refStart.line];
  const lastRow = (refEnd ?? refStart).line;
  const rowHi = lastRow + 1 < starts.length ? starts[lastRow + 1] : s.length;
  const onRows = candidates(s, rowLo, rowHi, id);
  let everywhere: Cand[] | null = null;
  let widened = false;
  const findNext = (cur: Span): Cand | null => {
    if (!widened) {
      const hit = best(onRows, cur, method);
      if (hit) return hit;
      widened = true;
    }
    everywhere ??= candidates(s, 0, s.length, id);
    return best(everywhere, cur, method);
  };

  let found: Cand | null = null;
  let cur = ref;
  for (let n = 0; n < Math.max(1, count); n++) {
    found = findNext(cur);
    if (!found) return null;
    cur = found;
  }
  let final = found![ai];
  // The result must differ from the reference (a selection that already is the object grows).
  if (covers(ref, final)) {
    found = findNext(found!);
    if (!found) return null;
    final = found[ai];
    if (covers(ref, final)) return null;
  }

  if (final.from >= final.to) return { empty: posOf(final.from) };
  // An end just past a row's `\n` is the start of the next row; past the last one, the end of the field.
  const endLine = lines.length - 1;
  const end = final.to >= s.length ? { line: endLine, col: lines[endLine].length } : posOf(final.to);
  return { start: posOf(final.from), end };
}
