/**
 * Code-like text for the field (#6).
 *
 * Stage generation decides the *shape* of a board — which runs are red or blue
 * and how wide each is. This module spells a run: it returns exactly `width`
 * characters of space-free, code-looking text (`cache.get(key)`, `items[0]`,
 * `user::name`, `on("close")`), built from identifiers joined by punctuation.
 *
 * Runs never contain spaces, so a whitespace-bounded word is still made of whole
 * runs. Where two runs touch with no space between them, the caller asks the
 * right-hand run to start in the opposite character class (identifier vs
 * punctuation) from where the left-hand run ended, so a colour never changes in
 * the middle of an identifier — each word is a single colour.
 */

export type CharClass = 'word' | 'punct';

/** Class of a non-space character: identifier characters vs everything else. */
export function charClass(ch: string): CharClass {
  return /[A-Za-z0-9_]/.test(ch) ? 'word' : 'punct';
}

// Identifiers by length (index = length). Index 0 is unused.
const IDENTS: string[][] = [
  [],
  ['x', 'y', 'i', 'n', 'a', 'b', 'k', 'v', 'e', 't'],
  ['id', 'fn', 'ok', 'db', 'io', 'ui', 'el', 'fs', 'to', 'on'],
  ['key', 'val', 'err', 'msg', 'url', 'map', 'get', 'set', 'row', 'col', 'buf', 'len', 'max', 'min', 'sum'],
  ['user', 'data', 'item', 'list', 'node', 'next', 'prev', 'head', 'tail', 'size', 'name', 'type', 'path', 'port', 'host', 'line', 'word', 'char'],
  ['index', 'count', 'value', 'state', 'cache', 'query', 'token', 'input', 'event', 'error', 'start', 'close', 'fetch', 'parse', 'merge'],
  ['render', 'buffer', 'cursor', 'delete', 'insert', 'select', 'length', 'handle', 'stream', 'socket', 'config', 'result', 'filter', 'reduce'],
  ['payload', 'request', 'context', 'session', 'message', 'timeout', 'promise', 'handler', 'channel'],
  ['response', 'callback', 'listener', 'selector', 'template', 'instance', 'iterator'],
];
const MAX_IDENT = IDENTS.length - 1;

const pick = <T>(xs: readonly T[], rand: () => number): T => xs[Math.floor(rand() * xs.length)];

/** An identifier of at most `limit` characters (≥1), leaning toward 3–7. */
function ident(limit: number, rand: () => number): string {
  const want = 2 + Math.floor(rand() * 6); // 2..7
  const len = Math.max(1, Math.min(want, limit, MAX_IDENT));
  return pick(IDENTS[len], rand);
}

/**
 * A punctuation-led piece of at most `r` characters (r ≥ 2) that can follow an
 * identifier or a closing bracket: `.name`, `(arg)`, `[0]`, `::type`, `=value`,
 * `=>next`, `,item`, `("key")`, `{id}`.
 */
function connector(r: number, rand: () => number): string {
  const options: (() => string)[] = [
    () => '.' + ident(r - 1, rand),
    () => '.' + ident(r - 1, rand), // member access is the most common join
    () => '(' + (r > 2 && rand() < 0.8 ? ident(r - 2, rand) : '') + ')',
    () => ',' + ident(r - 1, rand),
    () => '=' + (rand() < 0.3 ? String(Math.floor(rand() * 10)) : ident(r - 1, rand)),
  ];
  if (r >= 3) {
    options.push(
      () => '[' + (rand() < 0.5 ? String(Math.floor(rand() * 10)) : ident(Math.min(r - 2, 3), rand)) + ']',
      () => '::' + ident(r - 2, rand),
      () => '=>' + ident(r - 2, rand),
      () => '{' + ident(r - 2, rand) + '}',
    );
  }
  if (r >= 5) options.push(() => '("' + ident(r - 4, rand) + '")');
  return pick(options, rand)();
}

/**
 * Spell a run: exactly `width` space-free characters of code-like text.
 * `startClass` forces the class of the first character (used when the run
 * touches its left neighbour); omit it for a free-standing run.
 */
export function codeText(width: number, rand: () => number, startClass: CharClass = 'word'): string {
  if (width <= 0) return '';
  let s = '';
  if (startClass === 'word') s = ident(width, rand);

  while (s.length < width) {
    const r = width - s.length;
    if (r === 1) {
      s += pick([';', ';', ',', ':'], rand);
    } else {
      s += connector(r, rand);
    }
  }
  return s;
}
