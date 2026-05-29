/**
 * Stage boards + loader (spec §6).
 *
 * A run is an endless ladder of stages. The first few are hand-authored for a
 * deliberate intro ramp; beyond that, stages are generated procedurally and
 * get taller (more rows) and denser (wider reds, more blue traps between them)
 * as the index climbs. Generation is deterministic per index, so a given stage
 * always looks the same.
 *
 * `loadStage` always returns a *fresh, independent* field — deletion ops mutate
 * blocks, so presets must never be shared between runs.
 */
import {
  type Line,
  type FieldState,
  type Color,
  word,
  spaces,
  line,
  createField,
  MIN_WORD,
  MAX_WORD,
} from './state.ts';

/** A stage board = its preset lines. */
export type Stage = Line[];

/** Hand-authored intro stages — a tuned difficulty ramp. */
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

/** How many stages are hand-authored before generation takes over. */
export const AUTHORED_COUNT = AUTHORED.length;

/**
 * Build a fresh, independent field for stage `index` (0-based).
 *
 * Hand-authored stages (1–3) are fixed — the deliberate intro ramp. Generated
 * stages mix in a per-run `runSeed` so the board differs each playthrough while
 * the difficulty curve (a function of `index`) stays ordered. A `runSeed` of 0
 * reproduces the legacy deterministic-per-index boards.
 */
export function loadStage(index: number, runSeed = 0): FieldState {
  const board = index < AUTHORED.length ? cloneStage(AUTHORED[index]) : generateStage(index, runSeed);
  return createField(board);
}

// ── generation ───────────────────────────────────────────────────────────
/**
 * Procedurally build stage `index`. As difficulty rises: more rows, a bigger
 * per-line column budget (denser), wider reds, and more frequent blue traps —
 * all functions of `index`, so later stages stay harder. The `runSeed` only
 * perturbs the RNG stream, varying the board between runs without touching the
 * difficulty curve. The first word of every line is red so there's always a
 * clear path.
 */
function generateStage(index: number, runSeed: number): Stage {
  const rand = mulberry32(((index + 1) * 0x9e3779b1) ^ Math.imul(runSeed | 0, 0x85ebca6b));
  const d = index;

  const rows = clamp(4 + Math.floor(d * 0.7), 4, 14);
  const cols = clamp(10 + d, 10, 30); // blocks of horizontal budget per line
  const pBlue = clamp(0.28 + d * 0.03, 0.28, 0.5);

  const board: Line[] = [];
  for (let r = 0; r < rows; r++) {
    const chunks: Line[] = [];
    let used = 0;
    let first = true;

    // Fill the line word-by-word until the column budget can't fit another.
    while (cols - used >= MIN_WORD) {
      if (!first) {
        if (cols - used < MIN_WORD + 1) break; // no room for a space + word
        chunks.push(spaces(1));
        used += 1;
      }
      const remaining = cols - used;
      const blue = !first && rand() < pBlue;
      const n = blue
        ? clamp(MIN_WORD + Math.floor(rand() * 2), MIN_WORD, Math.min(MAX_WORD, remaining))
        : clamp(MIN_WORD + 2 + Math.floor(rand() * (3 + d)), MIN_WORD, Math.min(MAX_WORD, remaining));
      chunks.push(word(blue ? 'blue' : 'red', n));
      used += n;
      first = false;
    }

    board.push(line(...chunks));
  }
  return board;
}

// ── helpers ──────────────────────────────────────────────────────────────
/** Deep-copy a stage so the shared preset is never mutated by gameplay. */
function cloneStage(stage: Stage): Line[] {
  return stage.map((ln) => ln.map((b): { color: Color | null } => ({ color: b.color })));
}

/** Small, fast, seedable PRNG — deterministic boards per stage index. */
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
