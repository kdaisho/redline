/**
 * Difficulty-curve measurement (#15).
 *
 *   node scripts/measure-stages.ts              # table for stages 1–50, 8 seeds
 *   node scripts/measure-stages.ts --seeds 20   # more seeds
 *   node scripts/measure-stages.ts --md         # GitHub-flavoured markdown table
 *   node scripts/measure-stages.ts --show 12    # print stage 12's board (seed 0)
 *   node scripts/measure-stages.ts --check      # exit 1 if a balance target is missed
 *
 * Node ≥ 22.18 / 24 runs TypeScript directly; no build step.
 *
 * Every column is a mean over the seeds (seed 0 is the board the game ships —
 * `RUN_SEED = 0` in game.ts). The play model behind `acts` is documented in
 * `src/metrics.ts`: one delete action per blue-free red segment of a row, with
 * vertically adjacent solid-red rows merged into a single multi-row delete.
 *
 * Columns
 *   rows     rows on the board
 *   red      red characters to delete
 *   runs     red runs (maximal same-colour stretches)
 *   acts     delete actions needed with good play
 *   ch/act   red characters per delete action           (higher = more satisfying)
 *   tiny%    share of red runs that are 1–2 characters  (lower = less tedious)
 *   tinyA%   share of delete actions removing ≤2 chars
 *   big%     share of red characters removed by `rows` actions (whole lines / slabs)
 *   prec     actions that need a character-precise selection
 *   traps    blue traps (glued + inline + row, see metrics.ts)
 *   keys     rough keypress estimate for the board
 *   budget   stage time budget, seconds
 *   s/act    budget per delete action
 */
import { loadStage, stageBudgetMs, setMaxStageCols, setMaxStageRows } from '../src/stages.ts';
import { analyzeBoard } from '../src/metrics.ts';

// The shipped canvas is 1500×1100 (main.ts) → render.playfieldCols/Rows give:
const COLS = 96;
const ROWS = 23;
const STAGES = 50;

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const opt = (name: string, dflt: number): number => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};

setMaxStageCols(COLS);
setMaxStageRows(ROWS);

if (flag('--show')) {
  const stage = opt('--show', 1);
  const seed = opt('--seed', 0);
  const field = loadStage(stage - 1, seed);
  const RED = '\x1b[31m';
  const BLUE = '\x1b[34m';
  const OFF = '\x1b[0m';
  const plain = flag('--plain'); // red as-is, blue UPPERCASED in ‹› — for logs without colour
  for (const ln of field.lines) {
    let out = '';
    for (const b of ln) {
      if (b.color === null) out += ' ';
      else if (plain) out += b.color === 'blue' ? b.ch.toUpperCase() : b.ch;
      else out += (b.color === 'red' ? RED : BLUE) + b.ch + OFF;
    }
    console.log(out);
  }
  const m = analyzeBoard(field.lines);
  console.log(
    `\nstage ${stage} seed ${seed}: ${m.rows} rows, ${m.redChars} red, ${m.actions.length} actions ` +
      `[${m.actions.map((a) => `${a.kind}:${a.red}`).join(' ')}], traps ${JSON.stringify(m.traps)}, ` +
      `budget ${(stageBudgetMs(field.lines) / 1000).toFixed(1)}s`,
  );
  process.exit(0);
}

const seeds = opt('--seeds', 8);
const md = flag('--md');

interface Row {
  stage: number;
  rows: number;
  red: number;
  runs: number;
  acts: number;
  chPerAct: number;
  tinyPct: number;
  tinyActPct: number;
  bigPct: number;
  prec: number;
  traps: number;
  keys: number;
  budget: number;
  sPerAct: number;
  /** Worst single board (over seeds) for the two tedium measures. */
  worstTinyActPct: number;
  worstChPerAct: number;
}

const table: Row[] = [];
for (let s = 0; s < STAGES; s++) {
  const acc = { rows: 0, red: 0, runs: 0, acts: 0, tiny: 0, tinyActs: 0, bigRed: 0, prec: 0, traps: 0, keys: 0, budget: 0 };
  let worstTinyActPct = 0;
  let worstChPerAct = Infinity;
  for (let seed = 0; seed < seeds; seed++) {
    const { lines } = loadStage(s, seed);
    const m = analyzeBoard(lines);
    acc.rows += m.rows;
    acc.red += m.redChars;
    acc.runs += m.redRuns;
    acc.acts += m.actions.length;
    acc.tiny += m.tinyRedRuns;
    acc.tinyActs += m.tinyActions;
    acc.bigRed += m.actions.filter((a) => a.kind === 'rows').reduce((n, a) => n + a.red, 0);
    acc.prec += m.actions.filter((a) => a.kind === 'precise').length;
    acc.traps += m.traps.total;
    acc.keys += m.keys;
    acc.budget += stageBudgetMs(lines) / 1000;
    worstTinyActPct = Math.max(worstTinyActPct, (100 * m.tinyActions) / m.actions.length);
    worstChPerAct = Math.min(worstChPerAct, m.redChars / m.actions.length);
  }
  table.push({
    stage: s + 1,
    rows: acc.rows / seeds,
    red: acc.red / seeds,
    runs: acc.runs / seeds,
    acts: acc.acts / seeds,
    chPerAct: acc.red / acc.acts,
    tinyPct: (100 * acc.tiny) / acc.runs,
    tinyActPct: (100 * acc.tinyActs) / acc.acts,
    bigPct: (100 * acc.bigRed) / acc.red,
    prec: acc.prec / seeds,
    traps: acc.traps / seeds,
    keys: acc.keys / seeds,
    budget: acc.budget / seeds,
    sPerAct: acc.budget / acc.acts,
    worstTinyActPct,
    worstChPerAct,
  });
}

const cols: { head: string; get: (r: Row) => string }[] = [
  { head: 'stage', get: (r) => String(r.stage) },
  { head: 'rows', get: (r) => r.rows.toFixed(1) },
  { head: 'red', get: (r) => r.red.toFixed(0) },
  { head: 'runs', get: (r) => r.runs.toFixed(1) },
  { head: 'acts', get: (r) => r.acts.toFixed(1) },
  { head: 'ch/act', get: (r) => r.chPerAct.toFixed(1) },
  { head: 'tiny%', get: (r) => r.tinyPct.toFixed(0) },
  { head: 'tinyA%', get: (r) => r.tinyActPct.toFixed(0) },
  { head: 'big%', get: (r) => r.bigPct.toFixed(0) },
  { head: 'prec', get: (r) => r.prec.toFixed(1) },
  { head: 'traps', get: (r) => r.traps.toFixed(1) },
  { head: 'keys', get: (r) => r.keys.toFixed(0) },
  { head: 'budget', get: (r) => r.budget.toFixed(1) },
  { head: 's/act', get: (r) => r.sPerAct.toFixed(2) },
];

if (md) {
  console.log('| ' + cols.map((c) => c.head).join(' | ') + ' |');
  console.log('|' + cols.map(() => '---:').join('|') + '|');
  for (const r of table) console.log('| ' + cols.map((c) => c.get(r)).join(' | ') + ' |');
} else {
  const cells = table.map((r) => cols.map((c) => c.get(r)));
  const widths = cols.map((c, i) => Math.max(c.head.length, ...cells.map((row) => row[i].length)));
  const fmt = (row: string[]): string => row.map((v, i) => v.padStart(widths[i])).join('  ');
  console.log(`${seeds} seeds, ${COLS}×${ROWS} playfield`);
  console.log(fmt(cols.map((c) => c.head)));
  for (const row of cells) console.log(fmt(row));
}

if (flag('--check')) {
  // Balance targets (#15). Worst-case over every seed, not the mean.
  const failures: string[] = [];
  for (const r of table) {
    if (r.stage <= 3) continue; // the hand-authored word-delete tutorial boards
    if (r.worstTinyActPct > 25) failures.push(`stage ${r.stage}: a board has ${r.worstTinyActPct.toFixed(0)}% tiny (≤2 char) actions`);
    if (r.worstChPerAct < 12) failures.push(`stage ${r.stage}: a board averages only ${r.worstChPerAct.toFixed(1)} chars per action`);
    if (r.bigPct < 25) failures.push(`stage ${r.stage}: only ${r.bigPct.toFixed(0)}% of red is in whole-line deletes`);
  }
  // Board invariants, every stage × seed.
  const isWord = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const dump = (s: number, seed: number): string =>
    loadStage(s, seed).lines.map((ln) => ln.map((b) => (b.color?.[0] ?? '_') + b.ch).join('')).join('\n');
  for (let s = 0; s < STAGES; s++) {
    for (let seed = 0; seed < seeds; seed++) {
      const { lines } = loadStage(s, seed);
      const where = `stage ${s + 1} seed ${seed}`;
      if (dump(s, seed) !== dump(s, seed)) failures.push(`${where}: not deterministic`);
      if (lines.length > ROWS) failures.push(`${where}: ${lines.length} rows`);
      if (!lines[0].some((b) => b.color === 'red')) failures.push(`${where}: first row has no red`);
      for (const ln of lines) {
        if (ln.length > COLS) failures.push(`${where}: line of ${ln.length} cols`);
        if (ln.length === 0 || ln[0].color === null || ln[ln.length - 1].color === null)
          failures.push(`${where}: empty line or leading/trailing space`);
        for (let c = 1; c < ln.length; c++) {
          const a = ln[c - 1];
          const b = ln[c];
          // A colour change with no space must sit on an identifier/punctuation boundary.
          if (a.color && b.color && a.color !== b.color && isWord(a.ch) && isWord(b.ch))
            failures.push(`${where}: colour changes inside an identifier`);
        }
      }
    }
  }
  if (failures.length) {
    console.error(`\n${failures.length} balance target(s) missed:\n  ` + failures.join('\n  '));
    process.exit(1);
  }
  console.error('\nbalance targets met');
}
