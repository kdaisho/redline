/**
 * flash.nvim's jump (#9): matching and labelling, pure. The engine (`vim.ts`)
 * owns the key handling; this module answers "where does the pattern match" and
 * "which label does each match get".
 *
 * Follows flash's defaults as LazyVim ships them:
 *  - plain-text search, smartcase (a pattern with no capital ignores case);
 *  - labels come from `asdfghjklqwertyuiopzxcvbnm`, then the same in capitals;
 *  - a label is never a character that could continue the pattern (the character
 *    right after any match), so typing on never jumps by accident;
 *  - matches nearest the cursor get the first labels, and a match keeps its
 *    lowercase label while the pattern grows.
 */
import { type Line, type Pos } from './state.ts';

const LABELS = 'asdfghjklqwertyuiopzxcvbnm';
/** Stand-in for the screen width in flash's distance measure: rows count for more than columns. */
const ROW_WEIGHT = 200;

const cellText = (ln: Line, c: number): string => (ln[c].color === null ? ' ' : ln[c].ch);

/** Every match of a pattern, in reading order. Matches never span rows. */
export function flashMatches(lines: Line[], pattern: string): Pos[] {
  const out: Pos[] = [];
  const n = pattern.length;
  if (n === 0) return out;
  const fold = pattern === pattern.toLowerCase();
  for (let l = 0; l < lines.length; l++) {
    const ln = lines[l];
    for (let c = 0; c + n <= ln.length; c++) {
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        const ch = cellText(ln, c + i);
        ok = (fold ? ch.toLowerCase() : ch) === pattern[i];
      }
      if (ok) out.push({ line: l, col: c });
    }
  }
  return out;
}

const idOf = (p: Pos): string => `${p.line}:${p.col}`;

/**
 * Label the matches. `used` remembers which lowercase label a position had, so
 * labels stay put while the pattern grows; it is updated in place. Returns
 * label → match; matches left over when the labels run out get none.
 */
export function flashLabels(
  lines: Line[],
  matches: Pos[],
  patternLen: number,
  cursor: Pos,
  used: Map<string, string>,
): Map<string, Pos> {
  // Drop every label that is the next character after some match.
  const next = new Set<string>();
  for (const m of matches) {
    const ln = lines[m.line];
    if (m.col + patternLen < ln.length) next.add(cellText(ln, m.col + patternLen).toLowerCase());
  }
  let free = [...LABELS, ...LABELS.toUpperCase()].filter((l) => !next.has(l.toLowerCase()));

  const dist = (p: Pos) => Math.abs((p.line - cursor.line) * ROW_WEIGHT + (p.col - cursor.col));
  const sorted = [...matches].sort((x, y) => dist(x) - dist(y));

  const out = new Map<string, Pos>();
  const done = new Set<string>();
  const give = (m: Pos, label: string) => {
    free = free.filter((l) => l !== label);
    out.set(label, m);
    done.add(idOf(m));
    if (label === label.toLowerCase()) used.set(idOf(m), label);
  };
  // first the labels these positions had before, then the rest in order of distance
  for (const m of sorted) {
    const label = used.get(idOf(m));
    if (label !== undefined && free.includes(label)) give(m, label);
  }
  for (const m of sorted) {
    if (free.length === 0) break;
    if (!done.has(idOf(m))) give(m, free[0]);
  }
  return out;
}
