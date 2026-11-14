# REDLINE — Game Spec

A browser game styled as a harsh code editor. Lines hold code-like text in two
colors. **Red = enemy, delete it. Blue = friend, keep it.** Move a text caret
with the keys of the chosen **mode** (§2) and clear every red as fast and cleanly
as possible. Sharp, edgy aesthetic. Faster + fewer mistakes = better.

## 1. Field model
- Canvas, **hard rectangular** editor frame (no rounded corners anywhere). HUD above:
  `score`, `time`, `stage`, the active `mode`, and a strike indicator.
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

## 2. Controls

### Modes
A **mode** is a control scheme. The field, rules, scoring and boards are the same
in every mode; only the keys differ.

| Mode | Keys |
|---|---|
| **Standard** | macOS editor chords + shift-selection (below) |
| **Vim** | modal, delete-only Vim (below) |

- The start screen has a mode picker: press the mode's number (`1`, `2`, …) or
  `Tab` to switch. The choice is remembered (localStorage `redline.mode`).
- The start screen's key help describes the selected mode; the HUD shows the
  active mode during a run.
- A run is played in one mode. `Esc` on the game-over / win screen returns to the
  start screen, where the mode can be changed.
- **Best scores are per mode** (§6).

Global keys (every mode): `Enter` / `Space` start, advance, restart · `M` or `F2`
mute · `F1` help. A mode may claim a global typing key while playing (Vim claims
`M`, `Enter`, `Space`, `Esc`); `F1` / `F2` can never be claimed.

**Help screen (`F1`)**, on the start screen or mid-stage: every key of the active
mode. Mid-stage it is a pause — both clocks stop and the board is hidden.

### Standard mode — full macOS chords + shift-selection

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

### Vim mode — modal, delete-only

Real Vim semantics over the same field, limited to what the game needs: moving
and deleting. The engine (`vim.ts`) is a pure module; its word motions, operator
ranges and text objects follow Vim's own algorithms and were checked against the
`vim` binary.

- **Modes:** Normal, Visual (`v`), Visual Line (`V`), Visual Block (`Ctrl-v`).
  `Esc` / `Ctrl-[` / `Ctrl-c` return to Normal and cancel a half-typed command.
- **Cursor:** a block ON a character (column 0..len-1). In Visual it may also rest
  on the end-of-row position, which selects the row break. Half-height while an
  operator waits for its motion.
- **Statusline** (under the editor frame): the mode, or the search prompt, or a
  message, on the left; the half-typed command (`d2`, `df`) on the right.
- **Words:** identifier characters (`A-Z a-z 0-9 _`) vs punctuation, separated by
  whitespace — `charClass`, the same classes the board generator uses, so each
  Vim word is a single color. WORDS (`W B E`) are split by whitespace only.

| Keys | Action |
|---|---|
| `h j k l` (arrows) | left / down / up / right; `j k` keep the column |
| `w b e ge` · `W B E gE` | word / WORD motions |
| `0 ^ $` | row start / first non-blank / row end |
| `gg G {n}G` · `H M L` | first / last / n-th row · top / middle / bottom row of the field |
| `{ }` | previous / next blank row |
| `f F t T {char}` · `; ,` | find in row · repeat / reverse |
| `%` | matching `( ) [ ] { }` |
| `/text` `?text` `Enter` · `n N` · `* #` | search (plain text, wraps) · next / previous · word under cursor |
| `x X Del` · `D` · `dd` | delete character / to row end / whole row |
| `d{motion}` · `d{text object}` | delete over a motion or object |
| `iw aw iW aW` · `i" a" i' a'` `` i` a` `` · `i( a( i[ a[ i{ a{ i< a<` | text objects (also `) ] } > b B`) |
| counts | `3w` `5dd` `d2w` `2d3w` `4x` `3.` |
| `.` | repeat the last delete command |
| Visual: `d x Del` · `X` · `D` · `o O` | delete selection · selected rows · rows / block to row ends · other end |

Rules that follow Vim: `dw` on the last word of a row stops at the row end; `de`
is inclusive, `dw` / `db` exclusive; `dd`, `dj`, `dG` … are linewise and **remove
the rows**; a charwise delete across rows joins them; `daw` takes the trailing
space (or the leading one at the end of a row); bracket objects outside any pair
use the next pair (Vim 9.1). A command that fails deletes nothing.

**Delete-only:** there is no Insert mode — `i a o O I A r R J ~` do nothing
(`i` / `a` only start a text object after `d` or in Visual). `c` `s` `C` `S`
delete exactly like `d` `x` `D` `dd`. **No undo** (`u`), no yank / put, registers,
macros, marks, or `:` command line. Search is plain text, not regex.

**Hold-to-repeat:** a motion typed as a single key repeats while held (`j`, `w`,
`;`, `n` …). Deletes never auto-repeat, and neither does a motion with a count,
an operator or a prefix.

**Game keys in Vim mode:** while playing, Vim owns every typing key, including
`M` (a motion), `Enter`, `Space` and `Esc`. Mute is `F2` and help is `F1` — both
work in every mode and phase. On the start / clear / end screens `Enter`, `M`,
`Esc`, `Tab` and the number keys are the game's again.

**One delete command = one action** for scoring and mistakes, whatever its count
or shape (`3dd`, a Visual Block, `.`). Chord for the big-chord multiplier (§4):

| Command | Chord |
|---|---|
| `x X Del s`, `dh dl` | char ×1 |
| `d` + `w b e ge W B E gE`, `f F t T ; ,`, `%`, `/ ? n N * #`; `d` + any text object | word ×1.5 |
| `dd cc S`, `D C`, `d$ d0 d^`, `dj dk dgg dG dH dM dL`, `d{ d}` | line ×2 |
| any Visual-mode delete | selection ×2 |

`.` scores with the chord of the command it repeats.


## 3. Mistakes (game-over model)
- A **mistake** = any single delete action that removes one or more **blue** blocks.
  (One reckless `Cmd+Backspace` through three blues = **1** mistake, not three.)
- **2 mistakes → game over.** Mistakes do NOT affect score or time — separate strike
  counter in HUD (e.g. `✕ ✕`).
- A mistake resets the combo multiplier to ×1.

## 4. Scoring (combo + big-chord)
- Base **+10 per red character** deleted.
- **Big-chord bonus:** per-block multiplier by chord — char ×1, word ×1.5, line ×2,
  selection ×2. Each mode maps its delete commands onto these chords (Vim: §2).
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
- **Best is stored per mode**: Standard in `redline.best` (the key used before modes
  existed, so an older best carries over), other modes in `redline.best.<mode>`.

## 7. Rendering / theme
- **Edgy/sharp:** hard rectangles, thin high-contrast strokes, monospace HUD, no
  shadows/rounding. Red `#F5A0A0`-ish, blue `#7FB8F0`-ish, on a stark/terminal background (TBD).
- Caret: sharp blinking grey block, one line tall (Standard: a bar before the
  character; Vim: a block on the character).
- Selection: hard-edged translucent highlight.
- Field text: bold monospace glyphs in red/blue over a faint same-color cell backing.
- Delete feedback (the satisfying core): cleared characters flash/snap out before the row
  collapses; combo counter pulses; strike flashes red.

## 8. Tech stack
- **TypeScript + HTML5 Canvas**, **Vite**, **pnpm**. Single `requestAnimationFrame` loop.
- Modules: `state.ts` (model + caret/selection/delete ops), `modes.ts` (mode registry,
  remembered choice), `input.ts` (shared key controller: listeners, repeat handling,
  global keys), `keymaps/<mode>.ts` (one keymap per mode over the shared field actions),
  `vim.ts` (the Vim engine — pure, no DOM), `render.ts`, `game.ts` (loop, stages,
  scoring, strikes), `stages.ts` (board definitions), `main.ts`.
- Tests: **vitest** (`pnpm test`), headless — `vim.test.ts` (engine) and
  `vim-play.test.ts` (key controller wiring, and a bot clearing all 50 stages with
  Vim keys).

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
