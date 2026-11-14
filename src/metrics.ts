/**
 * Board metrics (#15) — how much *work* a board is, measured in delete actions
 * rather than in characters. Pure; depends only on the field model.
 *
 * Used twice: `stageBudgetMs` (stages.ts) prices a board's time budget from it,
 * and `scripts/measure-stages.ts` reports the difficulty curve with it.
 *
 * ## The play model ("good play", Standard-mode chords)
 *
 * A **segment** is a maximal stretch of one row that contains no blue (spaces
 * inside are fine) and at least one red. Any segment can be removed by a single
 * delete, so *segments are the unit of work*. Each costs one action, of a kind:
 *
 *   rows    — the segment is the whole row (a solid-red row). Vertically
 *             adjacent solid-red rows merge into ONE action (one multi-row
 *             selection, or a line delete when it is a single row).
 *   edge    — touches the row's start or end and the colour boundary falls on
 *             whitespace: put the caret on the boundary, delete to line edge.
 *   word    — exactly one whitespace-bounded word, mid-row: one word delete.
 *   span    — several whole words, mid-row, bounded by whitespace: a word-wise
 *             selection, then delete.
 *   precise — the segment touches blue with no space between (the colour changes
 *             inside a whitespace-bounded word), so no word/line chord is safe:
 *             the selection has to be placed by character. `charSteps` estimates
 *             the single-character moves that takes (per touching side: the
 *             shorter of the red and the blue part of the shared word).
 *
 * The model deliberately does NOT merge segments across rows other than whole
 * solid rows (a selection from one row's red tail into the next row's red head
 * is legal and sometimes better, but it is not what "obvious good play" does),
 * so the action count is a slight over-estimate of the true optimum.
 *
 * ## Traps
 *
 * A trap is a blue placed so that the obvious big chord is a mistake:
 *
 *   glued  — a whitespace-bounded word holding both colours (word delete is wrong)
 *   inline — a blue stretch with red on both sides in its row (line delete is wrong)
 *   row    — a row holding blue, directly above or below a solid-red row, that is
 *            either all blue or mostly (≥60%) red — sweeping a multi-row
 *            selection across it is wrong
 */
import type { Line } from './state.ts';

export type ActionKind = 'rows' | 'edge' | 'word' | 'span' | 'precise';

export interface DeleteAction {
  kind: ActionKind;
  /** Red characters this action removes. */
  red: number;
  /** Rows covered (>1 only for `rows`). */
  rows: number;
  /** Whitespace-bounded words (or word parts) inside the segment. */
  words: number;
  /** Estimated single-character caret moves needed to place the selection. */
  charSteps: number;
}

export interface BoardMetrics {
  rows: number;
  redChars: number;
  blueChars: number;
  /** Maximal same-colour red stretches (a space or a blue ends a run). */
  redRuns: number;
  /** Red runs of 1–2 characters. */
  tinyRedRuns: number;
  actions: DeleteAction[];
  /** Actions that remove only 1–2 red characters. */
  tinyActions: number;
  traps: { glued: number; inline: number; row: number; total: number };
  /** Rough keypress estimate for the whole board (navigation + selection + delete). */
  keys: number;
}

interface Segment {
  start: number;
  end: number; // exclusive
  red: number;
  words: number;
  atStart: boolean;
  atEnd: boolean;
  touchLeft: boolean;
  touchRight: boolean;
  charSteps: number;
}

/** Length of the same-colour stretch ending just before `col` (walking left) / starting at `col` (walking right). */
function stretch(ln: Line, col: number, dir: -1 | 1): number {
  const first = dir === 1 ? col : col - 1;
  const color = ln[first]?.color;
  if (color == null) return 0;
  let n = 0;
  for (let i = first; i >= 0 && i < ln.length && ln[i].color === color; i += dir) n++;
  return n;
}

function segmentsOf(ln: Line): Segment[] {
  const out: Segment[] = [];
  let firstColored = -1;
  let lastColored = -1;
  for (let i = 0; i < ln.length; i++) {
    if (ln[i].color !== null) {
      if (firstColored < 0) firstColored = i;
      lastColored = i;
    }
  }
  let i = 0;
  while (i < ln.length) {
    if (ln[i].color !== 'red') {
      i++;
      continue;
    }
    // Extend over reds and spaces until a blue or the line end; trim trailing spaces.
    let j = i;
    let end = i;
    let red = 0;
    let words = 0;
    while (j < ln.length && ln[j].color !== 'blue') {
      if (ln[j].color === 'red') {
        red++;
        if (j === i || ln[j - 1].color !== 'red') words++;
        end = j + 1;
      }
      j++;
    }
    const touchLeft = i > 0 && ln[i - 1].color === 'blue';
    const touchRight = end < ln.length && ln[end].color === 'blue';
    let charSteps = 0;
    if (touchLeft) charSteps += Math.min(stretch(ln, i, 1), stretch(ln, i, -1));
    if (touchRight) charSteps += Math.min(stretch(ln, end, -1), stretch(ln, end, 1));
    out.push({
      start: i,
      end,
      red,
      words,
      atStart: i === firstColored,
      atEnd: end - 1 === lastColored,
      touchLeft,
      touchRight,
      charSteps,
    });
    i = j;
  }
  return out;
}

const hasBlue = (ln: Line): boolean => ln.some((b) => b.color === 'blue');
const hasRed = (ln: Line): boolean => ln.some((b) => b.color === 'red');
const isSolidRed = (ln: Line): boolean => hasRed(ln) && !hasBlue(ln);

/** Rough keypresses for one action: get there, shape the selection, delete. */
function keysFor(a: DeleteAction): number {
  const NAV = 2;
  switch (a.kind) {
    case 'rows':
      return NAV + a.rows + 1;
    case 'edge':
    case 'word':
      return NAV + 1;
    case 'span':
      return NAV + a.words + 1;
    case 'precise':
      return NAV + a.words + a.charSteps + 1;
  }
}

export function analyzeBoard(lines: Line[]): BoardMetrics {
  let redChars = 0;
  let blueChars = 0;
  let redRuns = 0;
  let tinyRedRuns = 0;
  let glued = 0;
  let inline = 0;
  let rowTraps = 0;
  const actions: DeleteAction[] = [];

  let slab: DeleteAction | null = null; // the run of solid-red rows being merged
  for (let r = 0; r < lines.length; r++) {
    const ln = lines[r];

    // Colour runs + glued words.
    let wordRed = false;
    let wordBlue = false;
    for (let c = 0; c <= ln.length; c++) {
      const color = c < ln.length ? ln[c].color : null;
      if (color === null) {
        if (wordRed && wordBlue) glued++;
        wordRed = wordBlue = false;
        continue;
      }
      if (color === 'red') {
        redChars++;
        wordRed = true;
        if (c === 0 || ln[c - 1].color !== 'red') {
          redRuns++;
          if (stretch(ln, c, 1) <= 2) tinyRedRuns++;
        }
      } else {
        blueChars++;
        wordBlue = true;
      }
    }

    const segs = segmentsOf(ln);
    // Every blue stretch between two segments of the same row is an inline trap.
    if (segs.length > 1) inline += segs.length - 1;

    if (isSolidRed(ln)) {
      const seg = segs[0];
      if (slab) {
        slab.red += seg.red;
        slab.rows++;
        slab.words += seg.words;
      } else {
        slab = { kind: 'rows', red: seg.red, rows: 1, words: seg.words, charSteps: 0 };
        actions.push(slab);
      }
      continue;
    }
    slab = null;

    // Row trap: a blue-bearing row next to a solid-red row, all blue or mostly red.
    if (hasBlue(ln)) {
      const nextToSolid =
        (r > 0 && isSolidRed(lines[r - 1])) || (r < lines.length - 1 && isSolidRed(lines[r + 1]));
      if (nextToSolid) {
        const rowRed = ln.filter((b) => b.color === 'red').length;
        const rowBlue = ln.filter((b) => b.color === 'blue').length;
        if (rowRed === 0 || rowRed >= 0.6 * (rowRed + rowBlue)) rowTraps++;
      }
    }

    for (const s of segs) {
      let kind: ActionKind;
      if (s.touchLeft || s.touchRight) {
        // A touching side only matters if the delete has to stop there.
        const needLeft = s.touchLeft && !s.atStart;
        const needRight = s.touchRight && !s.atEnd;
        kind = needLeft || needRight ? 'precise' : 'edge';
      } else if (s.atStart || s.atEnd) kind = 'edge';
      else kind = s.words === 1 ? 'word' : 'span';
      actions.push({
        kind,
        red: s.red,
        rows: 1,
        words: s.words,
        charSteps: kind === 'precise' ? s.charSteps : 0,
      });
    }
  }

  return {
    rows: lines.length,
    redChars,
    blueChars,
    redRuns,
    tinyRedRuns,
    actions,
    tinyActions: actions.filter((a) => a.red <= 2).length,
    traps: { glued, inline, row: rowTraps, total: glued + inline + rowTraps },
    keys: actions.reduce((s, a) => s + keysFor(a), 0),
  };
}
