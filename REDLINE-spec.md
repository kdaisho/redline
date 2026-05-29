# REDLINE — Game Spec

A browser game styled as a harsh code editor. Lines hold colored "words" (bars of
mini-blocks). **Red = enemy, delete it. Blue = friend, keep it.** Move a text caret
with macOS keyboard chords and clear every red as fast and cleanly as possible.
No real letters. Sharp, edgy aesthetic. Faster + fewer mistakes = better.

## 1. Field model
- Canvas, **hard rectangular** editor frame (no rounded corners anywhere). HUD above:
  `score`, `time`, `stage`, and a strike indicator.
- Grid of blocks: fixed block width `BW`, line height `LH`.
- **Line** = row; holds 1–N **words**, optionally separated by space blocks.
- **Word (bar)** = run of same-color blocks, 1–100 wide, color ∈ {red, blue}. Lines may mix colors and runs may sit directly adjacent (no space between them).
- Spaces are empty blocks; caret can rest on them, nothing to delete.

```
block  = { color: 'red' | 'blue' | null }   // null = space
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

Deletion collapses the gap and shifts following blocks/lines. **Deleting a space merges
adjacent words.** Emptying a line removes it and shifts lines up.

## 3. Mistakes (game-over model)
- A **mistake** = any single delete action that removes one or more **blue** blocks.
  (One reckless `Cmd+Backspace` through three blues = **1** mistake, not three.)
- **2 mistakes → game over.** Mistakes do NOT affect score or time — separate strike
  counter in HUD (e.g. `✕ ✕`).
- A mistake resets the combo multiplier to ×1.

## 4. Scoring (combo + big-chord)
- Base **+10 per red block** deleted.
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
- **Later stages have more rows** (taller field / denser board) and harder mixes
  (more blue traps between reds, wider reds, more touching red/blue runs).
- A run ends at **stage 50** (win condition) or after **2 mistakes** (lose condition).
- End screen: stage reached, final score, total time, best (localStorage). Restart key.

## 7. Rendering / theme
- **Edgy/sharp:** hard rectangles, thin high-contrast strokes, monospace HUD, no
  shadows/rounding. Red `#F5A0A0`-ish, blue `#7FB8F0`-ish, on a stark/terminal background (TBD).
- Caret: sharp blinking grey block, one line tall.
- Selection: hard-edged translucent highlight.
- Delete feedback (the satisfying core): cleared blocks flash/snap out before the row
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
