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
| **Vim** | modal, delete-only Vim with LazyVim's keybindings (below) |

- The start screen has a mode picker: press the mode's number (`1`, `2`, …) or
  `Tab` to switch. The choice is remembered (localStorage `redline.mode`).
- The start screen's key help describes the selected mode; the HUD shows the
  active mode during a run.
- A run is played in one mode. `Esc` on the game-over / win screen returns to the
  start screen, where the mode can be changed.
- **Best scores are per mode** (§6).

Global keys (every mode): `Enter` / `Space` start, advance, restart · `M` or `F2`
mute · `F1` help · `F3` / `F4` music volume down / up · `F6` / `F7` SFX volume
down / up (`Shift` + one of them: that bus off / on) — see §9. A mode may claim a
global typing key while playing (Vim claims `M`, `Enter`, `Space`, `Esc`); the
function keys can never be claimed.

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

### Vim mode — modal, delete-only, LazyVim keys

Real Vim semantics over the same field, limited to what the game needs: moving
and deleting. The engine (`vim.ts`) is a pure module; its word motions and
operator ranges follow Vim's own algorithms and were checked against the `vim`
binary. Where LazyVim's defaults differ from stock Vim, LazyVim wins (see
"LazyVim keybindings" below, and `docs/lazyvim-keymap-audit.md` for every
binding).

- **Modes:** Normal, Visual (`v`), Visual Line (`V`), Visual Block (`Ctrl-v`).
  `Esc` / `Ctrl-[` / `Ctrl-c` return to Normal and cancel a half-typed command.
- **Cursor:** a block ON a character (column 0..len-1). In Visual it may also rest
  on the end-of-row position, which selects the row break. Half-height while an
  operator waits for its motion.
- **Statusline** (under the editor frame): the mode, or the search prompt, or the
  flash text (`flash: fo█`), or a message, on the left; the half-typed command
  (`d2`, `df`, `ds`) on the right.
- **Words:** identifier characters (`A-Z a-z 0-9 _`) vs punctuation, separated by
  whitespace — `charClass`, the same classes the board generator uses, so each
  Vim word is a single color. WORDS (`W B E`) are split by whitespace only.

| Keys | Action |
|---|---|
| `h j k l` (arrows) · `gj gk` | left / down / up / right; `j k` keep the column |
| `w b e ge` · `W B E gE` | word / WORD motions |
| `0 ^ $` · `_ g_` · `{n}\|` | row start / first non-blank / row end · first / last non-blank · column n |
| `gg G {n}G` · `H M L` · `- + Enter` | first / last / n-th row · top / middle / bottom row of the field · first non-blank of the row above / below |
| `{ }` | previous / next blank row |
| `f F t T {char}` · `; ,` | find a character (flash: across rows, see below) · repeat / reverse |
| `s{text}{label}` | flash jump (see below) |
| `Alt-j` `Alt-k` | move the row — in Visual, the selected rows — down / up (takes a count) |
| `%` | matching `( ) [ ] { }` |
| `/text` `?text` `Enter` · `n N` · `* #` | search (plain text, wraps) · next forward / backward · word under cursor |
| `x X Del` · `D` · `dd` | delete character / to row end / whole row |
| `d{motion}` · `d{text object}` | delete over a motion or object |
| `iw aw iW aW ip ap iB aB` | Vim's own text objects: word, WORD, paragraph, `{ }` block |
| `i( a( i[ a[ i{ a{ i< a<` (and `) ] } >`) · `ib ab` · `i" a" i' a'` `` i` a` `` · `iq aq` · `ia aa` · `iu au iU aU` · `id` · `ie` · `ig ag` · `i_ a_` … | mini.ai text objects (see below) |
| `in( il( an( al(` … · `g[(` `g](` … | the next / last object · jump to an object's left / right edge |
| counts | `3w` `5dd` `d2w` `2d3w` `4x` `3.` |
| `.` | repeat the last delete command |
| Visual: `d x Del` · `X` · `D` · `o O` · `s` | delete selection · selected rows · rows / block to row ends · other end · flash jump extends it |

Rules that follow Vim: `dw` on the last word of a row stops at the row end; `de`
is inclusive, `dw` / `db` exclusive; `dd`, `dj`, `dG` … are linewise and **remove
the rows**; a charwise delete across rows joins them; `daw` takes the trailing
space (or the leading one at the end of a row). A command that fails deletes
nothing.

#### LazyVim keybindings (#9)

Vim mode follows LazyVim's default keymaps and the editing plugins it ships
(flash.nvim, mini.ai) wherever they make sense in a single-buffer, delete-only
game. `docs/lazyvim-keymap-audit.md` lists every LazyVim binding as supported,
not applicable or deferred.

**flash.nvim — `s` jump.** `s` then some text: every match of the text on the
board gets a one-letter label on the cell right after it (the board dims, matches
stay lit). Pressing a label moves the cursor to the start of that match. The text
can keep growing — a label is never a character that could continue it — and a
match keeps its label while it does. Search is plain text and smartcase.
`Enter` jumps to the next match, `Backspace` edits, `Esc` cancels; text with no
match cancels too. Labels: `asdfghjklqwertyuiopzxcvbnm` nearest-first, then
capitals.
- After an operator the jump is its target: `ds{text}{label}` deletes from the
  cursor **through the first character of the match** (flash's default is
  inclusive), in either direction.
- `dr{text}{label}` is *remote*: the cursor goes to the match, the operator waits
  there for a motion or object (`driw`-style: `dr` · text · label · `iw`), and
  the cursor then returns to the character it was on.
- In Visual mode `s` extends the selection to the match.
- Because `s` is flash, it is **not** a delete (`x` is). `S`, `R` and
  `Ctrl-Space` are flash's treesitter pickers in LazyVim — the field has no syntax
  tree, so they do nothing (and `S` is no longer `dd`).

**flash.nvim — `f F t T`.** They search across rows (no wrap-around), and a
lowercase character also finds its capital (LazyVim sets `ignorecase` +
`smartcase`). While a find is *live* — until any other key is pressed — the same
key repeats it: `f` (or `t`) goes on to the next match, `F` (or `T`) back to the
previous one. So `fa` `fb` is "next `a`, then `b`": press another key (or `Esc`)
before finding a different character. `;` and `,` repeat as well; `,` walks the
same targets backward. After an operator `f` always takes a character.

**mini.ai text objects.** Every `i` / `a` object except `w W p B` is mini.ai's,
with mini.ai's rules rather than Vim's:

| Object | `a` | `i` |
|---|---|---|
| `( [ { <` | the brackets and everything between | between them, without the padding spaces |
| `) ] } >` | same | everything between them |
| `b` | any of `( )` `[ ]` `{ }` | everything between |
| `" '` `` ` `` · `q` (any quote) | the quotes and the text — no surrounding space | the text |
| `a` argument | the argument and one comma (the one after the first argument, else the one before) | the argument |
| `u` call · `U` call without dots in the name | `name(…)` | inside the `( )` |
| `d` digits · `e` camelCase / snake_case part | the run | the same |
| `g` field | every row | without blank rows at the top and bottom |
| any other non-letter (`_ , . ; : =` …) | from after one to the end of the next run of them | the text between two of them |

- **Which one:** the narrowest object covering the cursor; if none covers it, the
  first one that starts after it. The cursor's row is searched before the rest of
  the field, so `dib` on a row with `(…)` ahead takes that pair rather than a
  `{ }` enclosing several rows. Quotes pair up from the left of their row.
- **Next / last:** `in(` `an(` take the next object after the cursor, `il(` `al(`
  the last one before it — for every object above.
- **Counts** step outward (`d2a(` = the pair around the pair), or onward for
  next / last (`d2in(`).
- **Visual:** the selection becomes the object; the same object again takes the
  next one out. With no such object, Visual mode ends (as in mini.ai).
- **Edges:** `g[` / `g]` + an object move to the left / right edge of its `a`
  form; already there, to the next one out.
- Not available: LazyVim's treesitter objects `o` (block / loop / conditional),
  `f` (function), `c` (class), the tag `t`, the prompt `?`, and snacks' indent
  scope `ii` / `ai`.

**Row moves.** `Alt-j` / `Alt-k` move the cursor's row down / up; in any Visual
mode they move every selected row and keep the selection. A count moves that many
rows. Layout only — nothing is deleted or scored. (On macOS, Option-j / Option-k.)

**Remaps.** `n` always searches forward and `N` backward, whichever of `/` `?`
`*` `#` started the search. `j` / `k` are LazyVim's `gj` / `gk` without a count —
the same movement here, since rows never wrap. LazyVim's `[x` / `]x` pairs
(`]d`, `[b`, `]f` …) have nothing to act on; they swallow their second key so it
cannot run as a command. Leader (`Space`) chords do nothing.

**Delete-only:** there is no Insert mode — `i a o O I A r R J ~` do nothing
(`i` / `a` only start a text object after `d` or in Visual). `c` `C` delete
exactly like `d` `D` (`s` / `S` are flash's — see above). **No undo** (`u`), no yank / put, registers,
macros, marks, or `:` command line. Search is plain text, not regex.

**Hold-to-repeat:** a motion typed as a single key repeats while held (`j`, `w`,
`;`, `n`, a repeating `f`, `Alt-j` …). Deletes never auto-repeat, and neither does a motion with a count,
an operator or a prefix.

**Game keys in Vim mode:** while playing, Vim owns every typing key, including
`M` (a motion), `Enter`, `Space` and `Esc`. Mute is `F2` and help is `F1` — both
work in every mode and phase. On the start / clear / end screens `Enter`, `M`,
`Esc`, `Tab` and the number keys are the game's again.

**One delete command = one action** for scoring and mistakes, whatever its count
or shape (`3dd`, a Visual Block, `.`). Chord for the big-chord multiplier (§4):

| Command | Chord |
|---|---|
| `x X Del`, `dh dl` | char ×1 |
| `d` + `w b e ge W B E gE`, `f F t T ; ,`, `%`, `/ ? n N * #`, `gj gk`, `g[ g]`; `ds…` (flash jump); `d` + any text object but `p` / `g` | word ×1.5 |
| `dd cc`, `D C`, `d$ d0 d^ d_ dg_ d\|`, `dj dk d- d+ dgg dG dH dM dL`, `d{ d}`, `dip dap dig dag` | line ×2 |
| any Visual-mode delete | selection ×2 |

`.` scores with the chord of the command it repeats. A remote delete (`dr…`)
scores as the command that runs at the target (`dr…iw` word, `dr…d` line).


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
  trap) × a slack factor that tightens linearly from 3.0 (stage 1) to 1.4 (stage 50),
  and never less than 15 seconds.
- `node scripts/measure-stages.ts` prints the measured curve (delete actions, characters
  per action, tiny-run share, traps, budget per action) for stages 1–50; `--check`
  fails if a balance target or a board invariant is missed. The play model is
  documented in `src/metrics.ts`.
- A run ends at **stage 50** (win condition) or after **2 mistakes** (lose condition).
- End screen: stage reached, final score, total time, best (localStorage). Restart key.
- **Best is stored per mode**: Standard in `redline.best` (the key used before modes
  existed, so an older best carries over), other modes in `redline.best.<mode>`.

## 7. Rendering / theme
The theme is **Phosphor** (chosen in #10, built in #11): an amber CRT terminal.

- **Palette:** tube `#060A07`, amber `#FFB000` (chrome, caret, prompts), dim amber `#8A6200`
  (labels, line numbers, rules), red `#FF5A3C`, blue `#3FB4C0`, white-hot `#FFF4E0`
  (delete bloom, pulses, flash labels).
- **Font:** VT323 (bundled with the game via `@fontsource/vt323`, imported in `main.ts`), all-caps readouts. Nothing is drawn
  until it has loaded; if it never does, the system monospace stands in on the same grid.
  VT323 advances 0.4 em with 0.08 em pixel rows, so the grid is `BW` 15 × `LH` 39 and field
  glyphs are 37.5 px: exactly one cell wide, with 3 px pixel rows. The 1500×1100 canvas holds
  96 × 23 cells — the generator's own maximum is 96 × 15, so boards are unchanged.
  The canvas is scaled down to fit the window (never above 1:1) and the page does not scroll.
- **Red vs blue never rely on hue alone:** red glows and is double-struck; blue is dim cyan
  and bare.
- **CRT:** scanlines every 3 px and a vignette over everything. Row baselines sit on
  multiples of 3 so the scanlines fall between the font's pixel rows.
- **Field:** zero-padded line numbers, `>` on the caret's row. Caret: Standard is a glowing
  amber bar before the character (solid after input, then blinking); Vim is a steady glowing
  amber block on the character, the lower half while an operator waits for its motion.
- **Selection** (Standard's and Vim's Visual modes): true inverse video — a lit block in the
  cell's own colour with the glyph dark; selected spaces and line breaks are dim amber.
- **HUD:** two amber rows. Row 1: `REDLINE`, `STAGE 07`, `SCORE 001240` (+ the last gain,
  fading), `COMBO X8` while a combo is alive (white-hot for a moment when it grows); on the
  right `MODE`, `SND ON/OFF`, `STRIKES [ ][X]`, `T+mm:ss.cc`. Row 2: `LIMIT m:ss` and a gauge
  of blocks that empties and turns from amber to red over the last half of the budget.
- **Footer status line:** Standard shows `READY.` or `SELECT nn`; Vim shows `-- NORMAL --` etc.
  (or the search prompt, a message, the flash text) followed by the pending keys; the right
  side shows the caret as `L03 C17`.
- **Delete** (the satisfying core): the gap is held open while the removed run blooms white,
  squashes into one bright scanline and shrinks to a dot — a tube switching off (420 ms) —
  then the row slides shut (120 ms). The model has already collapsed; only the picture lags.
- **Strike:** the picture loses sync — rows jitter sideways under a red tint (380 ms), the
  deleted blue flickers out in red, and an inverse `!! STRIKE 1/2 -- BLUE IS KEEP !!` banner
  blinks in the footer (900 ms).
- **Flash jump** (Vim `s`): the board dims, matches are lifted out again in their own colour
  over an amber underline, labels are white-hot inverse cells.
- **Screens:** start, game over and win replace the board with a 100 px glowing title
  (amber; red for GAME OVER), dim copy and a `> PRESS ENTER … _` prompt with a blinking
  cursor; the selected mode in the picker is an inverse amber block. The 3-2-1 countdown is a
  250 px glowing digit, `GO` blooms white and swells as it fades, and a cleared stage
  brightens the tube before `STAGE CLEARED` appears over the dimmed board. Help (F1) is two
  columns of amber keys and dim descriptions.
- **Cost:** no per-glyph `shadowBlur` at frame time. Glowing glyphs are rendered once into
  per-style atlases and blitted; scanlines and vignette are one pre-rendered overlay.

## 8. Tech stack
- **TypeScript + HTML5 Canvas**, **Vite**, **pnpm**. Single `requestAnimationFrame` loop.
- Modules: `state.ts` (model + caret/selection/delete ops), `modes.ts` (mode registry,
  remembered choice), `input.ts` (shared key controller: listeners, repeat handling,
  global keys), `keymaps/<mode>.ts` (one keymap per mode over the shared field actions),
  `vim.ts` (the Vim engine — pure, no DOM), `flash.ts` (flash jump matching and
  labels), `miniai.ts` (mini.ai text objects), `render.ts`, `game.ts` (loop, stages,
  scoring, strikes), `stages.ts` (board definitions), `audio.ts` + `audio/` (§9),
  `main.ts`.
- Tests: **vitest** (`pnpm test`), headless — `vim.test.ts` (engine),
  `vim-lazyvim.test.ts` (flash, mini.ai, row moves, LazyVim remaps, help-screen
  fit), `vim-play.test.ts` (key controller wiring, and a bot clearing all 50
  stages with Vim keys) and `audio/audio.test.ts` (§9).

## 9. Audio (#12, #13, #14)
All sound is synthesised with the Web Audio API — no asset files. The sets were
picked by ear from two prototype pages; the note data, synthesis parameters and
gains in `audio/tracks.ts`, `audio/bgm.ts` and `audio/sfx.ts` are ports of those
pages and must not be retuned by eye.

**Music** — eight original tracks, one per slot:

| Slot | Track | Tempo | Loop |
|---|---|---|---|
| Title / start screen | Cold Boot | 138 | 27.8 s |
| Stages 1–10 | Green Diff | 150 | 38.4 s |
| Stages 11–20 | Hot Path | 156 | 36.9 s |
| Stages 21–30 | Race Condition | 164 | 46.8 s |
| Stages 31–40 | Stack Overflow | 172 | 44.7 s |
| Stages 41–50 | Redline | 180 | 42.7 s |
| Game over | Core Dump | 108 | 17.8 s |
| Win | Ship It | 160 | 36.0 s |

- A tier's track plays on through the countdown and the stage-cleared screen; it
  changes (short fade out, then the next track) only when the tier does, during
  the countdown of stages 11, 21, 31, 41. The help screen does not stop it.
- Game over and win let their SFX cue play first; the theme comes in under its
  tail. `Esc` back to the menu returns to the title theme.
- Tracks always fade in and out — never a hard cut. A track restarts from its top.
- Autoplay: a browser only lets audio start after a key or pointer press, so the
  title theme begins with the first key pressed on the page.
- While the tab is hidden the audio is ducked and the context suspended (a
  background tab's timers are too slow for the sequencer); it resumes in place.
- Music that cannot be heard (muted, or volume 0) is not sequenced; turned back
  on, the current screen's track starts from its top.

**Sound effects** — the "Halo" set, one sound per action (31):

| Action | Fires when |
|---|---|
| `moveChar` `moveWord` `moveLineEdge` `moveLine` | the caret moves: one character · a word (or any longer hop on a row) · to a row's start / end, or the first / last row (direction = which end) · to another row (direction = up / down). A move that hits a wall is silent in Standard |
| `selExtend` · `selClear` | the selection grows or shrinks (Standard `⇧` + move; Vim: a move in a Visual mode) · a selection is dropped by a plain move or collapsed onto its anchor (Vim: `Esc` cancels a half-typed command) |
| `delChar` `delWord` `delLine` `delSelection` | a delete that removes characters from one row, by its chord (§4); word / line / selection scale with the characters removed (spaces included) |
| `delBig` | a delete that takes characters from two or more rows (multi-row selection, `3dd`, `dj`, a Visual Block …), scaled the same way |
| `rowCollapse` | a row closes up: alone when two rows are joined without removing a character (`⌫` at column 0), just after the delete sound when one row is deleted whole (`dd`) |
| `rowMove` | the row (or the selected rows) moved up / down |
| `comboUp` | a clean red delete, just behind the delete sound; its pitch climbs with the combo level. Not played on the delete that clears the stage |
| `comboBreak` | a running combo is lost: the 1.5 s window lapses (heard at that moment), or a mistake that is not the final strike |
| `mistake` → `strike` | a delete removed a blue block: the mistake replaces the delete sound, the strike follows 0.14 s later |
| `gameOver` | the run ends: 0.45 s after the final strike's `mistake`, or 0.7 s after `timeUp` |
| `timeWarning` · `timeUp` | once per second over a stage's last five seconds (at 5, 4, 3, 2, 1 s left) · the stage limit runs out |
| `countdownTick` · `countdownGo` | each countdown digit (3, 2, 1) · the board is revealed |
| `stageStart` | a stage's countdown begins (a beat after `menuConfirm` on a fresh run) |
| `stageClear` · `runWin` | the last red of a stage is deleted · stage 50's clear is confirmed |
| `menuMove` · `menuConfirm` | mode picker change, help open / close, `Esc` back to the menu, a volume step · `Enter` starting a run |
| `muteToggle` | master mute, on both edges (the mute cue is heard before the silence) |
| `vimMode` | Vim changed mode without deleting (to Normal, or to any Visual mode) |
| `vimPending` | a Vim command is half-typed: operator, count, prefix (`g` `f` `i` …), flash or search text |
| `vimInvalid` | a Vim key did nothing: not part of this Vim, a motion that cannot move, no match / pattern not found |

- The Vim engine stays pure: the game compares its status before and after each
  key and derives the sound from that (`audio/cues.ts`).
- **Held keys:** movement, selection, row-move, menu and Vim key sounds share one
  lane — a sound may not start until the previous one has had its length
  (35–110 ms). One arriving up to 20 ms early is moved onto the slot, anything
  earlier is dropped; so a held key (45 ms repeat) plays every repeat, evenly,
  and nothing stacks. Other sounds only refuse to retrigger themselves within
  30 ms. At most 96 voices are alive at once (the lane stops at 32).

**Mix** — one AudioContext, one chain:
`music (its own limiter + soft clip) → music volume` and
`SFX (its own gain + limiter) → SFX volume`, both into `master (mute) → final
limiter → soft clip → output`. Each bus keeps the dynamics it was approved with;
nothing bypasses the final limiter.

- `M` (Standard) / `F2`: master mute. `F3` `F4`: music volume, `F6` `F7`: SFX
  volume, steps 0–10 (defaults: music 6, SFX 7; step 0 is off). `Shift` + a volume
  key turns that bus off / on without losing its step. The HUD's SOUND readout
  shows both (`♪ M6 S7`, `-` for a bus that is off, `✕ MUTED`).
- Remembered in localStorage: `redline.muted` (master), `redline.music.volume`,
  `redline.music.muted`, `redline.sfx.volume`, `redline.sfx.muted`.
- Tests (`audio/audio.test.ts`, headless against a checking stub AudioContext):
  every track compiles to whole bars with finite pitches and the loop lengths
  above; the stage → track mapping and the music transitions; all 31 sounds
  schedule with no non-finite or past time and no exponential ramp to ≤ 0; the
  held-key lane; the action → sound mappings; the settings.

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

## Soundtrack page (#31)

`soundtrack.html` is a music-player view of the eight BGM tracks: a library, a themed
view per track (its own palette and code-drawn cover art, a live meter, the bar-by-bar
chord structure) and a player bar. It plays the game's own track data through the game's
own music engine, so it always matches the game. A track counts as two passes of its
loop, then the next one starts unless Repeat is on. `S` on the title screen opens it;
`Esc` there returns to the game.
