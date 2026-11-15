/**
 * Stage boards + procedural generator (spec §6).
 *
 * Stages 1–5 are hand-authored — a deliberate intro ramp that also teaches the
 * trap vocabulary. After that, boards are generated.
 *
 * ## Design (#15): big deletes, hard choices
 *
 * The fun is deleting a lot at once; the difficulty is *choosing the chord*.
 * So a board is never a pile of tiny pieces. It is composed of **sections** —
 * small row patterns — in which red comes in big stretches (whole lines, slabs
 * of several lines, long phrases) and blue is placed where the obvious big
 * chord would hit it:
 *
 *   slab      2–4 solid-red rows            → one multi-row selection
 *   solid     one solid-red row             → one line delete
 *   keeper    one all-blue row              → leave it (a trap next to a slab)
 *   split     slab · blue row · slab        → sweeping all rows at once is wrong
 *   decoy     a slab where one row hides a small blue word
 *   blue-word red · blue word · red         → line delete is wrong, two edge deletes are right
 *   edge      red then blue (or blue then red), space between
 *   glued     red touching blue inside one word → word delete is wrong, select precisely
 *   mixed     3–5 medium words of both colours
 *   spike     one row with a short burst of 1–2 character reds/blues — at most
 *             one per board, never on early stages (the only place tiny reds exist)
 *
 * With depth the mix shifts from slabs/solids/mixed toward the trap sections,
 * and the time budget tightens (see `stageBudgetMs`). Boards grow only mildly
 * (6 → 15 rows) — size is not the difficulty lever.
 *
 * Each red/blue stretch is spelled as code-like text of exactly its width (#6,
 * `codetext.ts`); long stretches become several space-separated words of one
 * colour. Where two colours touch they always meet at an identifier/punctuation
 * boundary, so every word-token is a single colour. Generation is deterministic
 * per `(index, runSeed)`. `loadStage` always returns a fresh, independent field —
 * deletion ops mutate blocks, so presets must never be shared between runs.
 */
import { type Line, type FieldState, type Color, type Block, createField } from './state.ts';
import { codeText, codePhrase, charClass, type CharClass } from './codetext.ts';
import { analyzeBoard, type DeleteAction } from './metrics.ts';

/** A stage board = its preset lines. */
export type Stage = Line[];

// ── viewport-aware line budget ───────────────────────────────────────────
/**
 * Max blocks a generated line may span / max rows a board may have. Wired from
 * main.ts once the canvas size is known (`render.playfieldCols/Rows`). The
 * defaults keep headless/test contexts working without setup.
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
/** Blocks for `str` in one colour; spaces in `str` become space blocks. */
function code(color: Color, str: string): Block[] {
  return Array.from(str, (ch): Block => (ch === ' ' ? { color: null, ch } : { color, ch }));
}
const red = (str: string): Block[] => code('red', str);
const blue = (str: string): Block[] => code('blue', str);
/** One row: chunks separated by a single space. */
const row = (...chunks: Block[][]): Line =>
  chunks.flatMap((c, i) => (i === 0 ? c : [...code('red', ' '), ...c]));
/** Chunks touching, no space between — the colour changes inside one word. */
const glue = (...chunks: Block[][]): Block[] => chunks.flat();

const AUTHORED: Stage[] = [
  // Stage 1 — short, mostly red, one easy blue to leave alone.
  [
    row(red('debugger;')),
    row(red('crash() '), blue('main()')),
  ],
  // Stage 2 — a blue wedged between reds; three rows.
  [
    row(red('leak()'), blue('init()')),
    row(blue('load()'), red('explode()')),
    row(red('hack()'), blue('save()'), red('panic()')),
  ],
  // Stage 3 — wider reds, blues on both sides.
  [
    row(red('goto(fail)'), blue('sync()'), red('eval(x)')),
    row(blue('open()'), red('corrupt()'), blue('done;')),
    row(red('throw bomb()'), blue('exit;')),
    row(blue('test()'), red('segfault()')),
  ],
  // Stage 4 — slabs: whole red lines go in one selection, but a blue line sits
  // between them, and the last "red line" ends in a blue word.
  [
    row(red('tmp = legacy.load(path)')),
    row(red('tmp.patch(unsafe) retry(tmp)')),
    row(blue('user = session.user')),
    row(red('debug.dump(user)')),
    row(red('console.log(tmp, user)')),
    row(red('eval(tmp.script)'), blue('return;')),
  ],
  // Stage 5 — a blue word inside a red line, and red glued onto blue: the word
  // chord would take `render` (or the `;`) with it.
  [
    row(red('trace(state) spam(log)'), blue('commit()'), red('exit(1)')),
    row(glue(blue('render'), red('.hack(dom)')), red('alert(msg)')),
    row(red('for(;;) fork()')),
    row(red('while(1) leak(buf)')),
    row(blue('save(state)'), glue(red('drop(db)'), blue(';'))),
  ],
];

export const AUTHORED_COUNT = AUTHORED.length;

/** Hard cap: beating this stage wins the run (spec §6). */
export const MAX_STAGE_INDEX = 49;

/** Which stage a board was built for — lets `stageBudgetMs(lines)` find its tightness. */
const STAGE_OF = new WeakMap<Line[], number>();

/**
 * Build a fresh, independent field for stage `index` (0-based).
 *
 * Authored stages are fixed. Generated stages mix `runSeed` into the RNG so
 * boards vary between runs while the difficulty curve (a function of `index`)
 * stays ordered. `runSeed = 0` is the stream the game ships.
 */
export function loadStage(index: number, runSeed = 0): FieldState {
  const board = index < AUTHORED.length ? cloneStage(AUTHORED[index]) : generateStage(index, runSeed);
  STAGE_OF.set(board, index);
  return createField(board);
}

// ── per-stage time budget (KDA-59, reworked in #15) ─────────────────────────
/**
 * Time budget for a board = (a competent player's estimated clear time) ×
 * (a slack factor that tightens with depth).
 *
 * The estimate is built from the same play model the balance script reports
 * (`metrics.ts`): one delete action per blue-free red segment, adjacent solid
 * red rows merged into one. Each action is priced by the chord it needs — a
 * line or slab delete is cheap, a character-precise selection next to a touching
 * blue is dear — plus time to read every row (blue has to be *found* before a
 * big chord is safe) and a little extra per trap.
 *
 * ASSUMPTIONS (not play-tested — tune here):
 *   - "competent" = knows the chords: ~1 s to move to a target and fire a
 *     simple chord, ~0.25 s to read a row;
 *   - at slack 1.0 that player clears a board with nothing to spare. The first
 *     playable build (slack 1.7 → 1.05, no floor) gave stage 1 only 6.6 s and
 *     ended runs on the clock almost at once (#25), so the curve now runs
 *     3.0 → 1.4 with a floor of `BUDGET_FLOOR_S`.
 */
const BUDGET_SETUP_S = 1.5; // orienting on a fresh board
const BUDGET_PER_ROW_S = 0.25; // reading a row for blue
const BUDGET_PER_TRAP_S = 0.35; // noticing a trap and re-planning the chord
const ACT_ROWS_S = 0.9; // line delete / start a multi-row selection
const ACT_ROWS_EXTRA_S = 0.2; // each further row of a slab
const ACT_EDGE_S = 1.0; // caret to a whitespace boundary + delete to line edge
const ACT_WORD_S = 0.9; // one word delete
const ACT_SPAN_S = 1.1; // word-wise selection mid-row…
const ACT_SPAN_WORD_S = 0.12; // …per word (capped)
const ACT_PRECISE_S = 1.4; // selection placed by character…
const ACT_PRECISE_STEP_S = 0.1; // …per single-character step (capped)
const SLACK_EARLY = 3.0; // stage 1: roomy — a newcomer is still finding the keys
const SLACK_LATE = 1.4; // stage 50: tight, but a competent player keeps a margin
const BUDGET_FLOOR_S = 15; // no stage is shorter than this, however small the board (#25)

function actionSeconds(a: DeleteAction): number {
  const words = Math.min(a.words, 8) * ACT_SPAN_WORD_S;
  switch (a.kind) {
    case 'rows':
      return ACT_ROWS_S + (a.rows - 1) * ACT_ROWS_EXTRA_S;
    case 'edge':
      return ACT_EDGE_S;
    case 'word':
      return ACT_WORD_S;
    case 'span':
      return ACT_SPAN_S + words;
    case 'precise':
      return ACT_PRECISE_S + words + Math.min(a.charSteps, 12) * ACT_PRECISE_STEP_S;
  }
}

/** Slack multiplier for a stage (0-based): tightens linearly from roomy to tight. */
export function stageSlack(stageIndex: number): number {
  const t = clamp(stageIndex / MAX_STAGE_INDEX, 0, 1);
  return SLACK_EARLY + (SLACK_LATE - SLACK_EARLY) * t;
}

/**
 * Budget in ms. `stageIndex` defaults to the stage the board was loaded for
 * (boards from `loadStage` remember it); an unknown board gets stage-1 slack.
 */
export function stageBudgetMs(lines: Line[], stageIndex: number = STAGE_OF.get(lines) ?? 0): number {
  const m = analyzeBoard(lines);
  const estSeconds =
    BUDGET_SETUP_S +
    m.rows * BUDGET_PER_ROW_S +
    m.traps.total * BUDGET_PER_TRAP_S +
    m.actions.reduce((s, a) => s + actionSeconds(a), 0);
  return Math.round(Math.max(BUDGET_FLOOR_S, estSeconds * stageSlack(stageIndex)) * 1000);
}

// ── generation ───────────────────────────────────────────────────────────
/** A stretch of one colour, `gap` spaces after the previous piece (0 = touching it). */
type Piece = { color: Color; width: number; gap: number };
type RowSpec = Piece[];
type Section = 'slab' | 'solid' | 'keeper' | 'split' | 'decoy' | 'blue-word' | 'edge' | 'glued' | 'mixed';

/** Section weights, interpolated `early → late` along the generated stages. */
const SECTIONS: { kind: Section; early: number; late: number }[] = [
  { kind: 'slab',      early: 0.14, late: 0.06 },
  { kind: 'solid',     early: 0.10, late: 0.03 },
  { kind: 'mixed',     early: 0.24, late: 0.12 },
  { kind: 'edge',      early: 0.22, late: 0.10 },
  { kind: 'keeper',    early: 0.04, late: 0.08 },
  { kind: 'blue-word', early: 0.12, late: 0.19 },
  { kind: 'split',     early: 0.06, late: 0.12 },
  { kind: 'decoy',     early: 0.06, late: 0.14 },
  { kind: 'glued',     early: 0.02, late: 0.16 },
];
/** Sections that are exactly one row — used to fill the last rows of a board. */
const ONE_ROW: Section[] = ['solid', 'mixed', 'edge', 'blue-word', 'glued'];

const MIN_RED = 4; // no red piece narrower than this outside a spike
const SPIKE_FROM_STAGE = 8; // 1-based stage where a spike may first appear

function generateStage(index: number, runSeed: number): Stage {
  const baseSeed = ((index + 1) * 0x9e3779b1) ^ Math.imul(runSeed | 0, 0x85ebca6b);
  const d = Math.min(index, MAX_STAGE_INDEX);
  // 0 at the first generated stage → 1 at the last stage.
  const t = clamp((d - AUTHORED.length) / (MAX_STAGE_INDEX - AUTHORED.length), 0, 1);

  // Mild growth only — depth adds traps and time pressure, not bulk (#15).
  const rowCount = Math.min(MAX_LINE_ROWS, Math.round(6 + 9 * t));
  const maxCols = Math.min(MAX_LINE_COLS, Math.round(44 + 52 * t));

  // Resample on invariant failure (uncommon). The later attempts drop the
  // spike — the only source of tiny reds — so they pass the tedium guard.
  for (let attempt = 0; attempt < 6; attempt++) {
    const rand = mulberry32(baseSeed ^ Math.imul(attempt + 1, 0x27d4eb2d));
    const spikeOk = index + 1 >= SPIKE_FROM_STAGE && attempt < 3;
    const specs = compose(rowCount, maxCols, t, spikeOk, rand);
    const board = specs.map((spec) => spell(spec, maxCols, rand));
    if (validate(board)) return board;
  }
  // Fallback (should not trigger in practice): a minimal solvable line.
  return [code('red', codeText(Math.min(10, MAX_LINE_COLS), mulberry32(baseSeed)))];
}

/**
 * Lay out a board as a shuffled list of sections. Every board gets at least one
 * slab (a guaranteed big delete), and at most one spike row.
 */
function compose(rowCount: number, maxCols: number, t: number, spikeOk: boolean, rand: () => number): RowSpec[] {
  const sections: RowSpec[][] = [];
  let used = 0;
  const add = (rows: RowSpec[]): void => {
    sections.push(rows);
    used += rows.length;
  };

  add(slab(Math.min(rowCount, 2 + Math.floor(rand() * 2)), maxCols, rand));
  if (spikeOk && used < rowCount && rand() < 0.1 + 0.15 * t) add([spikeRow(maxCols, t, rand)]);

  const weights = SECTIONS.map((s) => s.early + (s.late - s.early) * t);
  const oneRowWeights = SECTIONS.map((s, i) => (ONE_ROW.includes(s.kind) ? weights[i] : 0));
  while (used < rowCount) {
    let rows = buildSection(SECTIONS[weightedPick(weights, rand())].kind, maxCols, t, rand);
    if (used + rows.length > rowCount) {
      // Doesn't fit whole — a truncated pattern would lose its point, so fill with a one-row section.
      rows = buildSection(SECTIONS[weightedPick(oneRowWeights, rand())].kind, maxCols, t, rand);
    }
    add(rows);
  }

  // Shuffle section order (Fisher–Yates)…
  for (let i = sections.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sections[i], sections[j]] = [sections[j], sections[i]];
  }
  // …then lay them out greedily: open on a row that has red, and where possible
  // don't stack the solid-red rows of two sections on each other — they would
  // fuse into one giant slab and the board would collapse into a couple of deletes.
  const isSolid = (spec: RowSpec): boolean => spec.every((p) => p.color === 'red');
  const out: RowSpec[] = [];
  while (sections.length > 0) {
    const prev = out[out.length - 1];
    let pick = sections.findIndex((s) =>
      prev ? !(isSolid(prev) && isSolid(s[0])) : s[0].some((p) => p.color === 'red'),
    );
    if (pick < 0) pick = 0;
    out.push(...sections.splice(pick, 1)[0]);
  }
  return out;
}

const redPiece = (width: number, gap = 0): Piece => ({ color: 'red', width, gap });
const bluePiece = (width: number, gap = 0): Piece => ({ color: 'blue', width, gap });
/** Integer in [lo, hi]. */
const between = (lo: number, hi: number, rand: () => number): number =>
  lo + Math.floor(rand() * (Math.max(lo, hi) - lo + 1));
/** A line-ish width: 40–100% of the column budget. */
const lineWidth = (maxCols: number, rand: () => number): number =>
  clamp(Math.round(maxCols * (0.4 + rand() * 0.6)), MIN_RED, maxCols);

function slab(n: number, maxCols: number, rand: () => number): RowSpec[] {
  return Array.from({ length: n }, () => [redPiece(lineWidth(maxCols, rand))]);
}

/** red · blue · red on one row, about `total` columns; `g1`/`g2` are the gaps around the blue. */
function sandwich(total: number, blueW: number, g1: number, g2: number, rand: () => number): RowSpec {
  const reds = Math.max(2 * MIN_RED, total - blueW - g1 - g2);
  const left = clamp(Math.round(reds * (0.25 + rand() * 0.5)), MIN_RED, reds - MIN_RED);
  return [redPiece(left), bluePiece(blueW, g1), redPiece(reds - left, g2)];
}

function buildSection(kind: Section, maxCols: number, t: number, rand: () => number): RowSpec[] {
  switch (kind) {
    case 'slab':
      return slab(2 + Math.floor(rand() * 3), maxCols, rand);

    case 'solid':
      return slab(1, maxCols, rand);

    case 'keeper':
      return [[bluePiece(clamp(Math.round(maxCols * (0.3 + rand() * 0.5)), 4, maxCols))]];

    case 'split': {
      // Red rows above and below a blue row: one sweep across all of them is a mistake.
      const above = slab(between(1, 2, rand), maxCols, rand);
      const keeper: RowSpec = [bluePiece(lineWidth(maxCols, rand))];
      return [...above, keeper, ...slab(between(1, 2, rand), maxCols, rand)];
    }

    case 'decoy': {
      // A slab in which one row hides a small blue word — in the middle or at the end.
      const rows = slab(between(2, 3, rand), maxCols, rand);
      const at = Math.floor(rand() * rows.length);
      const total = Math.max(lineWidth(maxCols, rand), 3 * MIN_RED + 6);
      const blueW = between(3, 8, rand);
      const touch = rand() < 0.4 * t; // deeper: the blue is glued on, so the row reads as one solid line
      if (rand() < 0.4) {
        const g = touch ? 0 : 1;
        rows[at] = [redPiece(Math.max(MIN_RED, total - blueW - g)), bluePiece(blueW, g)];
      } else {
        rows[at] = sandwich(total, blueW, touch ? 0 : 1, 1, rand);
      }
      return rows;
    }

    case 'blue-word': {
      // Line delete is wrong; "to line start" + "to line end" from either side of the blue is right.
      const total = Math.max(Math.round(maxCols * (0.5 + rand() * 0.5)), 3 * MIN_RED + 6);
      return [sandwich(total, between(3, 10, rand), 1, 1, rand)];
    }

    case 'edge': {
      // One colour boundary on whitespace: delete to the line edge from it.
      const redW = clamp(Math.round(maxCols * (0.3 + rand() * 0.4)), MIN_RED, maxCols);
      const blueW = between(4, Math.min(maxCols - redW - 2, Math.round(maxCols * 0.3)), rand);
      const gap = between(1, 2, rand);
      return [rand() < 0.5 ? [redPiece(redW), bluePiece(blueW, gap)] : [bluePiece(blueW), redPiece(redW, gap)]];
    }

    case 'glued': {
      // Red touches blue inside one whitespace-bounded word: the word chord takes both.
      const redW = clamp(Math.round(maxCols * (0.25 + rand() * 0.4)), MIN_RED + 2, maxCols);
      const blueW = between(2, 9, rand);
      const form = Math.floor(rand() * 4);
      if (form === 0) return [[redPiece(redW), bluePiece(blueW, 0)]];
      if (form === 1) return [[bluePiece(blueW), redPiece(redW, 0)]];
      const total = Math.min(maxCols, Math.max(redW + blueW + 2 * MIN_RED, 3 * MIN_RED + 6));
      // Glued on one side, or (rarer) on both.
      if (form === 2) return [sandwich(total, blueW, 0, rand() < 0.3 ? 0 : 1, rand)];
      return [sandwich(total, blueW, 1, 0, rand)];
    }

    case 'mixed': {
      // 3–5 medium words of both colours — the classic row. Colours mostly
      // alternate; some neighbours touch on deeper stages.
      const n = between(3, 5, rand);
      const pTouch = 0.3 * t;
      const pieces: RowSpec = [];
      let budget = maxCols;
      let color: Color = rand() < 0.6 ? 'red' : 'blue';
      for (let i = 0; i < n; i++) {
        const touch = i > 0 && pieces[i - 1].color !== color && rand() < pTouch;
        const gap = i === 0 || touch ? 0 : between(1, 2, rand);
        const w = color === 'red' ? between(5, 22, rand) : between(3, 14, rand);
        if (budget - gap - w < 0) break;
        pieces.push({ color, width: w, gap });
        budget -= gap + w;
        if (rand() < 0.75) color = color === 'red' ? 'blue' : 'red';
      }
      if (!pieces.some((p) => p.color === 'red')) pieces[0] = redPiece(pieces[0].width);
      return [pieces];
    }
  }
}

/**
 * The rare spike (#15): one row where a short burst of 1–2 character pieces
 * alternates red/blue between two ordinary stretches. Two tiny reds, up to
 * three deep in the run — a moment of fiddly precision, never a whole board.
 */
function spikeRow(maxCols: number, t: number, rand: () => number): RowSpec {
  const leadRed = rand() < 0.5;
  const leadW = clamp(Math.round(maxCols * (0.25 + rand() * 0.2)), MIN_RED, maxCols);
  const pieces: RowSpec = [{ color: leadRed ? 'red' : 'blue', width: leadW, gap: 0 }];
  const tinyReds = t > 0.5 && rand() < 0.5 ? 3 : 2;
  // The burst alternates, opening on the colour the lead isn't, and ends on a red.
  let color: Color = leadRed ? 'blue' : 'red';
  let reds = 0;
  let first = true;
  while (reds < tinyReds) {
    pieces.push({ color, width: between(1, 2, rand), gap: first || rand() < 0.5 ? 1 : 0 });
    if (color === 'red') reds++;
    color = color === 'red' ? 'blue' : 'red';
    first = false;
  }
  // Close on blue so the last tiny red stays its own piece.
  pieces.push(bluePiece(clamp(Math.round(maxCols * (0.12 + rand() * 0.15)), 4, maxCols), 1));
  return pieces;
}

/**
 * Spell a row spec as a Line of code-like text. A piece that touches its left
 * neighbour starts in the opposite character class from where the neighbour
 * ended, so the colour always changes on an identifier/punctuation boundary —
 * every word-token is a single colour. The total never exceeds `maxCols`; if
 * the budget runs out, trailing pieces drop.
 */
function spell(pieces: RowSpec, maxCols: number, rand: () => number): Line {
  const out: Block[] = [];
  let prevEnd: CharClass | null = null; // class of the last char placed; null after a gap
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const gap = i === 0 ? 0 : p.gap;
    if (out.length + gap >= maxCols) break;
    if (gap > 0) {
      out.push(...code(p.color, ' '.repeat(gap)));
      prevEnd = null;
    }
    const w = Math.min(p.width, maxCols - out.length);
    const startClass: CharClass = prevEnd === 'word' ? 'punct' : 'word';
    const str = codePhrase(w, rand, startClass);
    out.push(...code(p.color, str));
    prevEnd = charClass(str[str.length - 1]);
  }
  if (out.length === 0) return code('red', codeText(1, rand));
  return out;
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

/** Tedium guard (#15): at most this share of a board's delete actions may remove ≤2 characters. */
const MAX_TINY_ACTION_SHARE = 0.25;
/** …and a board must average at least this many red characters per delete action. */
const MIN_CHARS_PER_ACTION = 14;

/**
 * Stage is valid iff ≥1 red exists overall AND the first row has a red, AND it
 * passes the tedium guard: tiny deletes never dominate, deletes stay big.
 */
function validate(board: Line[]): boolean {
  const m = analyzeBoard(board);
  if (m.tinyActions > m.actions.length * MAX_TINY_ACTION_SHARE) return false;
  if (m.redChars < m.actions.length * MIN_CHARS_PER_ACTION) return false;
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
  return stage.map((ln) => ln.map((b) => ({ color: b.color, ch: b.ch })));
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
