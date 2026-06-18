/**
 * Stage boards + procedural generator (spec §6).
 *
 * Stages 1–3 are hand-authored — a deliberate intro ramp. After that, stages
 * are built procedurally with two layers of structure so rows don't all look
 * alike:
 *
 *   1. **Run widths** come from a bucketed mixture (tiny → huge) whose weights
 *      shift with stage index, instead of a flat min/max range.
 *   2. **Row archetypes** (solid-red, pepper, cluster, …) shape each row's run
 *      sequence. Archetype weights also shift with stage index — early stages
 *      lean classic-mixed, later stages lean chaotic.
 *
 * Zero-space adjacency (red touching blue) becomes more likely as difficulty
 * climbs, forcing more precise selection. Generation is deterministic per
 * `(index, runSeed)`. `loadStage` always returns a fresh, independent field —
 * deletion ops mutate blocks, so presets must never be shared between runs.
 */
import {
  type Line,
  type FieldState,
  type Color,
  word,
  spaces,
  line,
  createField,
} from './state.ts';

/** A stage board = its preset lines. */
export type Stage = Line[];

// ── viewport-aware line budget ───────────────────────────────────────────
/**
 * Max blocks a generated line may span. Wired from main.ts once the canvas
 * size is known (`render.playfieldCols`). The default keeps headless/test
 * contexts working without setup.
 */
let MAX_LINE_COLS = 78;
let MAX_LINE_ROWS = 25;

export function setMaxStageCols(cols: number): void {
  MAX_LINE_COLS = Math.max(8, Math.floor(cols));
}

export function setMaxStageRows(rows: number): void {
  MAX_LINE_ROWS = Math.max(3, Math.floor(rows));
}

// ── authored intro ───────────────────────────────────────────────────────
const AUTHORED: Stage[] = [
  // Stage 1 — short, mostly red, one easy blue to leave alone.
  [
    line(word('red', 6)),
    line(word('red', 5), spaces(2), word('blue', 4)),
  ],
  // Stage 2 — a blue trap wedged between reds; three rows.
  [
    line(word('red', 6), spaces(1), word('blue', 4)),
    line(word('blue', 4), spaces(1), word('red', 7)),
    line(word('red', 5), spaces(1), word('blue', 4), spaces(1), word('red', 5)),
  ],
  // Stage 3 — denser, wider reds, traps on both sides.
  [
    line(word('red', 8), spaces(1), word('blue', 4), spaces(1), word('red', 6)),
    line(word('blue', 5), spaces(1), word('red', 7), spaces(1), word('blue', 4)),
    line(word('red', 6), spaces(1), word('red', 5), spaces(1), word('blue', 4)),
    line(word('blue', 4), spaces(1), word('red', 9)),
  ],
];

export const AUTHORED_COUNT = AUTHORED.length;

/** Hard cap: beating this stage wins the run (spec §6). */
export const MAX_STAGE_INDEX = 49;

/**
 * Build a fresh, independent field for stage `index` (0-based).
 *
 * Authored stages (1–3) are fixed. Generated stages mix `runSeed` into the
 * RNG so boards vary between runs while the difficulty curve (a function of
 * `index`) stays ordered. `runSeed = 0` is the stable legacy stream.
 */
export function loadStage(index: number, runSeed = 0): FieldState {
  const board = index < AUTHORED.length ? cloneStage(AUTHORED[index]) : generateStage(index, runSeed);
  return createField(board);
}

// ── per-stage time budget (KDA-59) ─────────────────────────────────────────
/**
 * Estimate a competent player's time to clear a board, derived deterministically
 * from the board itself — the board is the ground truth of required work, so the
 * budget is fair and reproducible (paired with the fixed RUN_SEED, every player
 * faces the same boards with the same clock). Tuned by playtest; the constants
 * are named for easy adjustment.
 *
 *   redRuns   — count of maximal red runs across all lines (navigate + delete)
 *   redBlocks — total red blocks (width/precision of each delete)
 *   rows      — number of lines (vertical travel)
 *   traps     — blue runs wedged directly between reds (extra precision cost)
 */
const BUDGET_SETUP_S = 2; // orienting on a fresh board
const BUDGET_PER_RUN_S = 0.6; // navigate to + issue a delete per red run
const BUDGET_PER_BLOCK_S = 0.07; // width/precision of each red block
const BUDGET_PER_ROW_S = 0.3; // vertical travel per line
const BUDGET_PER_TRAP_S = 0.4; // a blue run pinned between reds (no slack to grab it)
const BUDGET_SLACK = 0.8; // overall tightness (<1 = less than the raw estimate) — hard

export function stageBudgetMs(lines: Line[]): number {
  let redRuns = 0;
  let redBlocks = 0;
  let traps = 0;

  for (const ln of lines) {
    // Walk this line as a sequence of maximal same-color runs.
    const runColors: (Color | null)[] = [];
    let i = 0;
    while (i < ln.length) {
      const color = ln[i].color;
      let j = i;
      while (j < ln.length && ln[j].color === color) j++;
      if (color === 'red') {
        redRuns++;
        redBlocks += j - i;
      }
      runColors.push(color);
      i = j;
    }
    // A blue run with red on both sides (zero-space adjacency) is a precision trap.
    for (let k = 1; k < runColors.length - 1; k++) {
      if (runColors[k] === 'blue' && runColors[k - 1] === 'red' && runColors[k + 1] === 'red') traps++;
    }
  }

  const estSeconds =
    BUDGET_SETUP_S +
    redRuns * BUDGET_PER_RUN_S +
    redBlocks * BUDGET_PER_BLOCK_S +
    lines.length * BUDGET_PER_ROW_S +
    traps * BUDGET_PER_TRAP_S;
  return Math.round(estSeconds * BUDGET_SLACK * 1000);
}

// ── generation ───────────────────────────────────────────────────────────
type Run = { color: Color; width: number };
type Archetype = 'solid-red' | 'mixed-classic' | 'trap-sandwich' | 'pepper' | 'cluster' | 'chaos';

/** Width buckets. Weights interpolate `early → late` along `t = d / MAX`. */
const WIDTH_BUCKETS: { range: [number, number]; early: number; late: number }[] = [
  { range: [1, 2],    early: 0.05, late: 0.20 },
  { range: [3, 6],    early: 0.35, late: 0.20 },
  { range: [7, 14],   early: 0.45, late: 0.25 },
  { range: [15, 35],  early: 0.13, late: 0.20 },
  { range: [36, 100], early: 0.02, late: 0.15 },
];

/** Row archetype weights. Same `early → late` interpolation. */
const ARCHETYPES: { kind: Archetype; early: number; late: number }[] = [
  { kind: 'solid-red',     early: 0.15, late: 0.05 },
  { kind: 'mixed-classic', early: 0.45, late: 0.15 },
  { kind: 'trap-sandwich', early: 0.20, late: 0.20 },
  { kind: 'pepper',        early: 0.10, late: 0.25 },
  { kind: 'cluster',       early: 0.10, late: 0.20 },
  { kind: 'chaos',         early: 0.00, late: 0.15 },
];

function generateStage(index: number, runSeed: number): Stage {
  const baseSeed = ((index + 1) * 0x9e3779b1) ^ Math.imul(runSeed | 0, 0x85ebca6b);
  const d = Math.min(index, MAX_STAGE_INDEX);
  const t = d / MAX_STAGE_INDEX;

  // Block counts ramp hard with depth — more blocks per row AND more rows of
  // blocks as stages climb, filling the field in both directions.
  const rowCount  = Math.min(MAX_LINE_ROWS, clamp(Math.round(4 + d * 0.9), 3, MAX_LINE_ROWS));
  const maxCols   = Math.min(MAX_LINE_COLS, Math.round(36 + d * 2.4));
  const pAdjacent = clamp(d * 0.015, 0, 0.55);

  // Resample on invariant failure (rare — most archetypes satisfy them).
  for (let attempt = 0; attempt < 4; attempt++) {
    const rand = mulberry32(baseSeed ^ Math.imul(attempt + 1, 0x27d4eb2d));
    const board: Line[] = [];
    for (let r = 0; r < rowCount; r++) {
      const archetype = pickArchetype(rand(), t);
      const runs = buildRow(archetype, maxCols, t, rand);
      board.push(linify(runs, pAdjacent, rand, maxCols));
    }
    if (validate(board)) return board;
  }
  // Fallback (should not trigger in practice): a minimal solvable line.
  return [line(word('red', Math.min(10, MAX_LINE_COLS)))];
}

function buildRow(arch: Archetype, maxCols: number, t: number, rand: () => number): Run[] {
  switch (arch) {
    case 'solid-red': {
      const w = clamp(Math.floor(maxCols * (0.7 + rand() * 0.3)), 1, maxCols);
      return [{ color: 'red', width: w }];
    }
    case 'mixed-classic': {
      const n = 2 + Math.floor(rand() * 3);
      const runs: Run[] = [];
      let budget = maxCols - (n - 1); // reserve ≥1 gap per join
      for (let i = 0; i < n && budget > 0; i++) {
        const isBlue = rand() < 0.30;
        const w = clamp(sampleWidth(t, rand, isBlue ? 'blue' : 'red'), 1, budget);
        runs.push({ color: isBlue ? 'blue' : 'red', width: w });
        budget -= w;
      }
      return runs;
    }
    case 'trap-sandwich': {
      const blueMax = Math.max(1, Math.floor(maxCols * 0.4));
      const blueW = clamp(sampleWidth(t, rand, 'blue'), 1, blueMax);
      const remaining = Math.max(2, maxCols - blueW);
      const leftW = clamp(Math.floor(remaining * (0.3 + rand() * 0.4)), 1, remaining - 1);
      const rightW = Math.max(1, remaining - leftW);
      return [
        { color: 'red', width: leftW },
        { color: 'blue', width: blueW },
        { color: 'red', width: rightW },
      ];
    }
    case 'pepper': {
      const runs: Run[] = [];
      let budget = maxCols;
      let blue = rand() < 0.5;
      while (budget > 0) {
        const w = 1 + Math.floor(rand() * Math.min(3, budget));
        runs.push({ color: blue ? 'blue' : 'red', width: w });
        budget -= w;
        blue = !blue;
      }
      return runs;
    }
    case 'cluster': {
      const redCap = Math.max(1, Math.floor(maxCols * 0.5));
      const redW = clamp(sampleWidth(t, rand, 'red'), 1, redCap);
      const blueCap = Math.max(1, maxCols - redW - 2);
      const blueW = clamp(sampleWidth(t, rand, 'blue'), 1, blueCap);
      return rand() < 0.5
        ? [{ color: 'red',  width: redW },  { color: 'blue', width: blueW }]
        : [{ color: 'blue', width: blueW }, { color: 'red',  width: redW }];
    }
    case 'chaos': {
      const runs: Run[] = [];
      let budget = maxCols;
      while (budget > 0) {
        const isBlue = rand() < 0.45;
        const w = clamp(sampleWidth(t, rand, isBlue ? 'blue' : 'red'), 1, budget);
        runs.push({ color: isBlue ? 'blue' : 'red', width: w });
        budget -= w;
      }
      return runs;
    }
  }
}

/**
 * Join runs into a Line, inserting per-gap spacing. With probability
 * `pAdjacent` a gap is zero (runs touch); otherwise it's 1 or 2 spaces. The
 * total never exceeds `maxCols`; if budget runs out, trailing runs drop.
 */
function linify(runs: Run[], pAdjacent: number, rand: () => number, maxCols: number): Line {
  if (runs.length === 0) return line(word('red', 1));
  const chunks: Line[] = [];
  let used = 0;
  for (let i = 0; i < runs.length; i++) {
    if (i > 0) {
      const gap = rand() < pAdjacent ? 0 : 1 + Math.floor(rand() * 2);
      if (gap > 0 && used + gap < maxCols) {
        chunks.push(spaces(gap));
        used += gap;
      }
    }
    const w = Math.min(runs[i].width, maxCols - used);
    if (w <= 0) break;
    chunks.push(word(runs[i].color, w));
    used += w;
    if (used >= maxCols) break;
  }
  return line(...chunks);
}

function sampleWidth(t: number, rand: () => number, color: Color): number {
  const weights = WIDTH_BUCKETS.map((b) => b.early + (b.late - b.early) * t);
  let idx = weightedPick(weights, rand());
  // Slight bias: reds trend wider, blues trend narrower (40% bump per call).
  if (color === 'red' && rand() < 0.4 && idx < WIDTH_BUCKETS.length - 1) idx += 1;
  else if (color === 'blue' && rand() < 0.4 && idx > 0) idx -= 1;
  const [lo, hi] = WIDTH_BUCKETS[idx].range;
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function pickArchetype(r: number, t: number): Archetype {
  const weights = ARCHETYPES.map((a) => a.early + (a.late - a.early) * t);
  return ARCHETYPES[weightedPick(weights, r)].kind;
}

function weightedPick(weights: number[], r: number): number {
  const total = weights.reduce((s, w) => s + w, 0);
  const target = r * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (target < acc) return i;
  }
  return weights.length - 1;
}

/** Stage is valid iff ≥1 red exists overall AND the first row has a red. */
function validate(board: Line[]): boolean {
  let anyRed = false;
  let firstRowRed = false;
  for (let i = 0; i < board.length; i++) {
    for (const b of board[i]) {
      if (b.color === 'red') {
        anyRed = true;
        if (i === 0) firstRowRed = true;
      }
    }
  }
  return anyRed && firstRowRed;
}

// ── helpers ──────────────────────────────────────────────────────────────
function cloneStage(stage: Stage): Line[] {
  return stage.map((ln) => ln.map((b): { color: Color | null } => ({ color: b.color })));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
