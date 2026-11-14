# REDLINE — Game Spec

A browser game styled as a harsh code editor. Lines hold code-like text in two
colors. **Red = enemy, delete it. Blue = friend, keep it.** Move a text caret
with macOS keyboard chords and clear every red as fast and cleanly as possible.
Sharp, edgy aesthetic. Faster + fewer mistakes = better.

## 1. Field model
- Canvas, **hard rectangular** editor frame (no rounded corners anywhere). HUD above:
  `score`, `time`, `stage`, and a strike indicator.
- Monospace grid: fixed block width `BW`, line height `LH`. One block = one character.
- **Line** = row; holds 1–N **runs**, optionally separated by space blocks.
- **Run** = stretch of same-color characters, 1–100 wide, color ∈ {red, blue}, spelled as
  space-free code-like text (`cache.get(key)`, `items[0]`). Lines may mix colors and runs
  may sit directly adjacent (no space between them).
- **Each word is a single color.** Where two runs touch, the color changes on an
  identifier/punctuation boundary (`render` + `(props)`), never inside an identifier.
- Spaces are empty blocks; caret can rest on them, nothing to delete.

```
block  = { color: 'red' | 'blue' | null, ch }   // null = space, ch = its character
line   = block[]
caret  = { line, col }                        // sits before block[col]
select = { anchor:{line,col}, head:{line,col} } | null
```

## 2. Controls — full macOS chords + shift-selection

Movement (hold-to-repeat ENABLED):
| Key | Action |
|---|---|
| ← / → | 1 block |
| Alt + ← / → | word boundary |
| Cmd + ← / → | line start / end |
| ↑ / ↓ | line up / down (keep column) |
| Cmd + ↑ / ↓ | first / last line |
| Alt + ↑ / ↓ | move row (or selected rows) up / down |

Selection (same chords + Shift, hold-to-repeat ENABLED, multi-line allowed):
| Key | Action |
|---|---|
| Shift + ← / → | extend by block |
| Shift + Alt + ← / → | extend by word |
| Shift + Cmd + ← / → | extend to line edge |
| Shift + ↑ / ↓ | extend by line |

Deletion (NO hold-to-repeat — one action per keypress):
| Key | Action |
|---|---|
| Backspace | selection → delete selection; else delete 1 block left |
| Alt + Backspace | delete word left |
| Cmd + Backspace | delete caret → line start |

Deletion collapses the gap like a real code editor. A delete that crosses a row
boundary removes that boundary: the start row's prefix joins the end row's suffix
and the rows below shift up (Backspace at column 0 joins onto the previous row;
forward-delete at line end pulls the next row up). **Deleting a space merges
adjacent words.** Deleting every block *within* a row leaves a blank row — a row
only disappears when a delete joins across it. A pure join removes no blocks, so
it never scores and never counts as a mistake.

Rows can also be reordered with **Alt + ↑/↓** (move the caret's row, or all
selected rows, up/down) — layout only, deletes nothing.

For Alt-movement / Alt-selection / Alt-deletion, a **"word boundary"** is whitespace, not color — a contiguous red+blue run (no space between them) counts as one word. Color-touching deletes may therefore cross into blue and count as a mistake (spec §3).

## 3. Mistakes (game-over model)
- A **mistake** = any single delete action that removes one or more **blue** blocks.
  (One reckless `Cmd+Backspace` through three blues = **1** mistake, not three.)
- **2 mistakes → game over.** Mistakes do NOT affect score or time — separate strike
  counter in HUD (e.g. `✕ ✕`).
- A mistake resets the combo multiplier to ×1.

## 4. Scoring (combo + big-chord)
- Base **+10 per red character** deleted.
- **Big-chord bonus:** per-block multiplier by chord — char ×1, word ×1.5, line ×2.
- **Combo multiplier:** consecutive clean deletes with no pause >1.5s build ×1→×2→×4…;
  mistake or timeout resets to ×1.
- Per-delete = `redBlocksDeleted × 10 × chordMult × comboMult`. Blue blocks score nothing.

## 5. Time
- **Counts up** from 0, no limit. Pure elapsed clock. **Lower final time = better.**
- No time penalties. Time is the speedrun metric; score is the reward metric.

## 6. Stages & end condition
- Stage-based speedrun. Each stage = a fixed board of preset lines. Clear every red
  (keeping blues) → advance to next stage.
- **Big deletes at every stage; difficulty is choosing the chord, not labor** (#15).
  Red comes in large stretches — whole lines, slabs of several solid-red lines, long
  phrases — never as a board of 1–3 character pieces. Stages 1–5 are hand-authored;
  the rest are generated deterministically per `(stage, seed)` from row patterns:
  - *slab / solid* — solid-red lines: one multi-line selection or one line delete.
  - *keeper* — an all-blue line; *split* — a blue line between red lines, so one sweep
    across all of them is a mistake.
  - *decoy* — a slab in which one line hides a small blue word.
  - *blue-word* — red · blue word · red: line delete is wrong, two deletes-to-line-edge
    are right.
  - *edge* — red then blue (or blue then red) with a space between.
  - *glued* — red touching blue inside one whitespace-bounded word: the word chord
    takes both, so the selection has to be placed by character.
  - *mixed* — 3–5 medium words of both colors.
  - *spike* — one line with a short burst of 1–2 character reds and blues. At most one
    per board, from stage 8, on a minority of boards. The only place tiny reds exist.
- **Later stages get harder through blue traps and time, not size.** The trap patterns
  (split, decoy, blue-word, glued) take a growing share of the board; boards grow only
  mildly (6 → 15 rows, 44 → 96 columns).
- **Tedium guard:** a generated board is rejected and resampled if more than 25% of its
  delete actions would remove ≤2 characters, or if it averages under 14 red characters
  per delete action.
- **Per-stage time limit.** Each stage has a budget; running out ends the run. The
  budget is a competent player's estimated clear time for *that board* (time to read
  each row, plus a cost per delete action by the chord it needs, plus a little per
  trap) × a slack factor that tightens linearly from 1.7 (stage 1) to 1.05 (stage 50).
- `node scripts/measure-stages.ts` prints the measured curve (delete actions, characters
  per action, tiny-run share, traps, budget per action) for stages 1–50; `--check`
  fails if a balance target or a board invariant is missed. The play model is
  documented in `src/metrics.ts`.
- A run ends at **stage 50** (win condition) or after **2 mistakes** (lose condition).
- End screen: stage reached, final score, total time, best (localStorage). Restart key.

## 7. Rendering / theme
- **Edgy/sharp:** hard rectangles, thin high-contrast strokes, monospace HUD, no
  shadows/rounding. Red `#F5A0A0`-ish, blue `#7FB8F0`-ish, on a stark/terminal background (TBD).
- Caret: sharp blinking grey block, one line tall.
- Selection: hard-edged translucent highlight.
- Field text: bold monospace glyphs in red/blue over a faint same-color cell backing.
- Delete feedback (the satisfying core): cleared characters flash/snap out before the row
  collapses; combo counter pulses; strike flashes red.

## 8. Tech stack
- **TypeScript + HTML5 Canvas**, **Vite**, **pnpm**. Single `requestAnimationFrame` loop.
- Modules: `state.ts` (model + caret/selection/delete ops), `input.ts` (keymap → actions,
  repeat handling), `render.ts`, `game.ts` (loop, stages, scoring, strikes),
  `stages.ts` (board definitions), `main.ts`.

---

## Linear issues (REDLINE project, team kdaisho)

Setup
1. Scaffold Vite + TS + Canvas project (pnpm), base requestAnimationFrame loop
2. HUD layout + sharp/edgy theme foundation (score, time, stage, strikes)

Core model
3. Block/line/caret data model + field grid (state.ts)
4. Stage definitions + loader (stages.ts) — board presets, row count grows per stage

Input
5. Caret movement: char/word/line chords with hold-to-repeat (input.ts)
6. Shift-selection incl. multi-line (extend by char/word/line)
7. Deletion actions: char/word/line/selection — gap collapse, space-merge, line removal

Game rules
8. Mistake detection (delete touching blue) + 2-strike game over
9. Scoring: base + big-chord multiplier + combo multiplier
10. Count-up timer (no limit)
11. Stage progression: clear all reds → advance, denser/taller later stages

Juice & meta
12. Delete feedback animations (snap/flash), combo pulse, strike flash, caret blink
13. Visual theme pass (terminal palette, contrast)
14. Game-over + start screens, restart, best-score in localStorage
