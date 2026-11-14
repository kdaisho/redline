# LazyVim keymap audit (#9)

Which of LazyVim's default keybindings work in Redline's Vim mode.

Sources, read on 2026-11-14: the LazyVim keymaps page (lazyvim.org/keymaps),
LazyVim's `lua/lazyvim/config/keymaps.lua`, `plugins/editor.lua`,
`plugins/coding.lua`, `plugins/treesitter.lua` and `util/mini.lua` on `main`;
flash.nvim's `config.lua`, `jump.lua`, `labeler.lua` and `plugins/char.lua`;
mini.ai's `doc/mini-ai.txt` and `lua/mini/ai.lua`.

Status:

- **supported** — works in the game, covered by a test in `src/vim-lazyvim.test.ts`
  (or `src/vim.test.ts`).
- **n/a** — not applicable: it acts on something the game does not have (windows,
  buffers, tabs, LSP, pickers, terminal, git, UI toggles), or it needs Insert
  mode, undo or yank / put, which the owner ruled out (#7).
- **deferred** — it could mean something here, but is not implemented. The reason
  says what is missing.

Keys marked n/a or deferred do nothing. Where a key would otherwise fall apart
into a dangerous command (`]d` → `d`), the prefix swallows it: `g`, `[`, `]`,
`z`, `"`, `'`, `` ` ``, `m`, `@`, `r` each take the next key with them. `Space`
(the leader) does nothing, but the keys after it are read as ordinary keys — do
not type leader chords during a run.

One row is one binding, or a group of bindings that share a description in
LazyVim's own table. Totals: **38 supported · 79 n/a · 18 deferred** (135 rows).

## 1. General keymaps (`config/keymaps.lua`)

| Keys (mode) | LazyVim | Status | Reason |
|---|---|---|---|
| `j` `k` `<Down>` `<Up>` (n, x) | down / up — `gj` / `gk` without a count | supported | Rows never wrap, so it is the same movement; `gj` / `gk` exist too. |
| `<C-h>` `<C-j>` `<C-k>` `<C-l>` | go to left / lower / upper / right window | n/a | One window. |
| `<C-Up>` `<C-Down>` `<C-Left>` `<C-Right>` | resize window | n/a | One window. |
| `<A-j>` `<A-k>` (n) | move line down / up | supported | Takes a count; repeats while held. No re-indent (`==`): there is none to do. |
| `<A-j>` `<A-k>` (v) | move selected lines down / up | supported | Any Visual mode; the selection stays. |
| `<A-j>` `<A-k>` (i) | move line from Insert mode | n/a | No Insert mode. |
| `<S-h>` `<S-l>` | previous / next buffer | n/a | One buffer. `H` / `L` keep Vim's meaning (top / bottom row). |
| `[b` `]b` | previous / next buffer | n/a | One buffer. |
| `<leader>bb` `` <leader>` `` | switch to other buffer | n/a | One buffer. |
| `<leader>bd` `<leader>bo` `<leader>bi` `<leader>bD` | delete buffer(s) | n/a | One buffer. |
| `<esc>` (i, n, s) | escape and clear hlsearch | supported | Esc cancels a half-typed command and leaves Visual; there is no search highlight to clear. |
| `<leader>ur` | redraw / clear hlsearch / diff update | n/a | UI. |
| `n` `N` (n, x, o) | next / previous search result, direction fixed | supported | `n` always forward, `N` always backward, also after `?` and `#`. |
| `,` `.` `;` (i) | undo break-points | n/a | No Insert mode, no undo. |
| `<C-s>` | save file | n/a | No file. |
| `<leader>K` | keywordprg | n/a | No help lookup. |
| `<` `>` (x) | indent and keep the selection | n/a | Changes text without deleting; the game only deletes. |
| `gco` `gcO` | add comment below / above | n/a | Inserts text. |
| `<leader>l` | Lazy | n/a | Plugin manager. |
| `<leader>fn` | new file | n/a | No files. |
| `<leader>xl` `<leader>xq` | location / quickfix list | n/a | No lists. |
| `[q` `]q` | previous / next quickfix | n/a | No lists. |
| `<leader>cf` | format | n/a | No formatter. |
| `<leader>cd` | line diagnostics | n/a | LSP. |
| `]d` `[d` `]e` `[e` `]w` `[w` | next / previous diagnostic, error, warning | n/a | LSP. |
| `<leader>uf` `uF` `us` `uw` `uL` `ud` `ul` `uc` `uA` `uT` `ub` `uD` `ua` `ug` `uS` `uh` | option toggles | n/a | UI toggles. |
| `<leader>dpp` `<leader>dph` | profiler | n/a | Tooling. |
| `<leader>gg` `gG` `gL` `gb` `gf` `gl` `gB` `gY` | lazygit, git log / blame / browse | n/a | Git. |
| `<leader>qq` | quit all | n/a | `Esc` on an end screen goes back to the menu. |
| `<leader>ui` `<leader>uI` | inspect position / tree | n/a | Treesitter tooling. |
| `<leader>L` | LazyVim changelog | n/a | — |
| `<leader>fT` `<leader>ft` `<c-/>` `<c-_>` | terminal | n/a | No terminal. |
| `<leader>-` `<leader>\|` `<leader>wd` | split / delete window | n/a | One window. |
| `<leader>wm` `<leader>uZ` `<leader>uz` | zoom / zen | n/a | UI. |
| `<leader><tab>l` `o` `f` `<tab>` `]` `d` `[` | tabs | n/a | No tabs. |
| `<localleader>r` | run Lua | n/a | — |

## 2. flash.nvim (default plugin)

LazyVim's keys (`plugins/editor.lua`) plus flash's own defaults (`opts = {}`):
labels `asdfghjklqwertyuiopzxcvbnm`, exact search with the editor's
`ignorecase` + `smartcase` (both on in LazyVim), labels after the match, uppercase
labels allowed, labels sorted by distance, lowercase labels reused, no autojump,
character mode on with `multi_line = true`.

| Keys (mode) | LazyVim | Status | Reason |
|---|---|---|---|
| `s` (n) | Flash: type text, press a label, jump | supported | Labels after each match, nearest first; a label is never a possible next character; a match keeps its label as the text grows. `Enter` = next match, `Backspace`, `Esc`. |
| `s` (x) | Flash, extending the selection | supported | — |
| `s` (o) | Flash as the operator's target | supported | `ds{text}{label}` deletes through the first character of the match (flash's operator jumps are inclusive), in either direction. One scored action, ×1.5. |
| `r` (o) | Remote Flash | supported | `dr{text}{label}` moves to the match, the operator waits there for a motion or object, then the cursor returns to the character it was on. |
| Flash labels, backdrop and prompt | labels overlaid after each match, dimmed backdrop, `⚡` prompt | supported | Drawn on the canvas: dimmed board, lit matches, yellow label cells; the statusline shows `flash: text█`. Colours are Redline's, not a colorscheme's. |
| `s` in place of Vim's `s` | `s` is no longer "substitute" | supported | `s` used to delete like `x` (delete-only stand-in). Flash wins; `x` deletes. |
| `S` (n, x, o) | Flash Treesitter: label the syntax nodes around the cursor | deferred | The field has no syntax tree. `S` does nothing (it used to be `dd`). It could later label the enclosing bracket pairs instead. |
| `R` (o, x) | Treesitter Search | deferred | No syntax tree. Does nothing. |
| `<c-space>` / `<BS>` (n, o, x) | Treesitter incremental selection | deferred | No syntax tree. In Visual, repeating a mini.ai object (`a(` `a(`) grows the selection instead. |
| `<c-s>` (c) | toggle Flash labels inside `/` search | deferred | The `/` prompt is plain; flash's search integration is also off by default. |
| `f` `F` `t` `T` (n, x, o) | flash character mode: across lines | supported | No wrap-around. A lowercase character also matches its capital (smartcase). `f` / `t` inclusive, `F` / `T` exclusive, as in flash. |
| `f` `F` `t` `T` again | repeat the find with the same key | supported | Lowercase key = onward in the find's direction, capital = back. Live until any other key is pressed. |
| `f` after an operator while a find is live | may repeat instead of asking for a character | deferred | Not verified in flash; here `df` always takes a character, which cannot delete by surprise. |
| `;` `,` (n, x, o) | next / previous match of the last find | supported | `,` walks the same targets backward (so after `t` it stops before the previous match). |
| character-mode highlight | all matches of the find stay highlighted, backdrop dimmed | deferred | Cosmetic. Only the `s` jump is drawn. |
| `.` after a flash jump | flash can repeat its last jump | deferred | A label is one-off; `.` does nothing after `ds…`. After `dr…` it repeats the motion that ran. |

## 3. mini.ai (default plugin)

LazyVim's `custom_textobjects` plus mini.ai's built-ins, with mini.ai's default
`search_method = 'cover_or_next'`. All in operator-pending and Visual mode.

| Keys | LazyVim / mini.ai | Status | Reason |
|---|---|---|---|
| `i(` `a(` `i[` `a[` `i{` `a{` `i<` `a<` | balanced brackets; `i` without the inner edge whitespace | supported | Pairs may span rows. |
| `i)` `a)` `i]` `a]` `i}` `a}` `i>` `a>` | balanced brackets; `i` keeps the whitespace | supported | — |
| `ib` `ab` | alias for `)`, `]` or `}` | supported | — |
| `i"` `a"` `i'` `a'` `` i` `` `` a` `` | balanced quotes | supported | `a"` takes the quotes only (Vim's also takes a space). Quotes pair up from the left of a row. |
| quotes spanning rows | mini.ai falls back to pairing over the whole neighbourhood | deferred | Strings on the boards never span rows; pairing stays within a row. |
| `iq` `aq` | alias for any quote | supported | — |
| `ia` `aa` | argument | supported | Inside `()` `[]` `{}`, split at commas outside nested brackets / quotes; `aa` takes one comma, as mini.ai does. |
| `iu` `au` | function call ("usage") | supported | `name(…)`, dots allowed in the name. |
| `iU` `aU` | function call without dots in the name | supported | — |
| `id` `ad` | digits | supported | — |
| `ie` `ae` | word with case (camelCase / snake_case part) | supported | — |
| `ig` `ag` | entire buffer | supported | The whole field; `ig` without blank rows at its ends. Scores as a line chord (×2). |
| `i_` `a_`, `i,` `a,` … (any non-letter) | mini.ai's default separator object | supported | `a` includes only the right-hand separator run, as in mini.ai. |
| `in…` `an…` | next object (`search_method = 'next'`) | supported | For every object above. |
| `il…` `al…` | last object (`search_method = 'prev'`) | supported | For every object above. |
| `{count}i…` / `{count}a…` | repeat the search from the object found | supported | Steps outward (`d2a(`), or onward with `n` / `l`. |
| Visual: the same object again | consecutive application grows the selection | supported | A failed search leaves Visual mode, as in mini.ai. |
| `g[` `g]` + object (n, x, o) | move to the left / right edge of the `a` object | supported | Already on the edge: the next one out. |
| `io` `ao` | block / conditional / loop (treesitter) | deferred | No syntax tree. |
| `if` `af` | function definition (treesitter) | deferred | No syntax tree. For a call, use `iu` / `au`. |
| `ic` `ac` | class (treesitter) | deferred | No syntax tree. |
| `it` `at` | tag | deferred | No markup on the boards. |
| `i?` `a?` | user prompt (type the two edges) | deferred | Needs a text prompt for each edge. |
| `iw` `aw` `iW` `aW` | not mini.ai's: Neovim's built-in word objects | supported | Unchanged from #7 (ports of Vim's `current_word`). |
| `ip` `ap` | built-in paragraph | supported | Rows up to a blank row; linewise, ×2. |
| `iB` `aB` | built-in `{ }` block | supported | Vim's rules (inner block linewise). |
| `is` `as` | built-in sentence | deferred | Boards are code, not prose. |

## 4. Other default plugins

| Keys | Plugin | Status | Reason |
|---|---|---|---|
| `]f` `[f` `]F` `[F` `]c` `[c` `]C` `[C` `]a` `[a` `]A` `[A` | nvim-treesitter-textobjects: next / previous function, class, parameter | deferred | No syntax tree. Swallowed. |
| `ii` `ai` (o, x), `[i` `]i` | snacks.scope: indent scope and its edges | deferred | Boards are not indented. |
| `]]` `[[` `<a-n>` `<a-p>` | snacks.words: next / previous reference | n/a | LSP references. |
| `ih` (o, x) | gitsigns: select hunk | n/a | Git. |
| `]h` `[h` `]H` `[H` | gitsigns: next / previous / last / first hunk | n/a | Git. |
| `<leader>ghs` `ghr` `ghS` `ghu` `ghR` `ghp` `ghb` `ghB` `ghd` `ghD` `<leader>uG` | gitsigns: stage, reset, preview, blame, diff, toggle | n/a | Git. |
| `gc{motion}` `gcc` (n), `gc` (x, o) | commenting (Neovim built-in, ts-comments.nvim) | n/a | Changes text without deleting. |
| auto-pairs in Insert mode, `<leader>up` | mini.pairs | n/a | No Insert mode. |
| completion keys (`<C-space>` `<C-n>` `<C-p>` `<C-y>` `<CR>` `<Tab>`) | blink.cmp | n/a | No Insert mode. |
| `gd` `gr` `gI` `gy` `gD` | LSP: go to definition, references, implementation, type, declaration | n/a | LSP. |
| `K` `gK` `<c-k>` (i) | LSP: hover, signature help | n/a | LSP. |
| `<leader>ca` `cc` `cC` `cR` `cr` `cA` `co` `cl` | LSP: code action, codelens, rename, source action, organize imports, info | n/a | LSP. |
| `<leader>ss` `<leader>sS` `gai` `gao` | LSP: symbols, incoming / outgoing calls | n/a | LSP. |
| `<leader>bj` `bl` `bp` `bP` `br` `[B` `]B` | bufferline: pick, close, pin, move buffers | n/a | One buffer. |
| `<leader>cF` | conform: format injected languages | n/a | No formatter. |
| `<leader>sr` | grug-far: search and replace | n/a | No replace. |
| `<leader>cm` | mason | n/a | Tooling. |
| `<c-f>` `<c-b>` | noice: scroll LSP docs forward / backward | n/a | LSP. The whole field is on screen, so Vim's page scrolls have nothing to do either. |
| `<leader>sn` `sna` `snd` `snh` `snl` `snt` `<S-Enter>` | noice: messages, redirect cmdline | n/a | No message history, no command line. |
| `<leader>qd` `ql` `qs` `qS` | persistence: sessions | n/a | No sessions. |
| `[t` `]t` `<leader>st` `sT` `xt` `xT` | todo-comments | n/a | Pickers / lists. |
| `<leader>cs` `cS` `xL` `xQ` `xx` `xX` | trouble | n/a | Lists. |
| `<c-w><space>` `<leader>?` | which-key | n/a | F1 is the key help. |
| `<leader><space>` `<leader>,` `<leader>/` `<leader>:` `<leader>n` | snacks picker: files, buffers, grep, command history, notifications | n/a | Pickers. |
| `<leader>e` `E` `fe` `fE` | snacks explorer | n/a | No files. |
| `<leader>fb` `fB` `fc` `ff` `fF` `fg` `fp` `fr` `fR` | snacks picker: find files / buffers / projects / recent | n/a | Pickers. |
| `<leader>gd` `gD` `gi` `gI` `gp` `gP` `gs` `gS` | snacks picker: git diff, status, stash, GitHub issues / PRs | n/a | Git. |
| `<leader>s"` `s/` `sa` `sb` `sB` `sc` `sC` `sd` `sD` `sg` `sG` `sh` `sH` `si` `sj` `sk` `sl` `sm` `sM` `sp` `sq` `sR` `su` `sw` `sW` | snacks picker: search everything | n/a | Pickers. |
| `<leader>.` `<leader>S` `<leader>dps` | snacks scratch buffers | n/a | One buffer. |
| `<leader>uC` `<leader>un` | colorschemes, dismiss notifications | n/a | UI. |

## 5. LazyVim extras (off by default)

Listed on the keymaps page, but only active when the extra is enabled.

| Keys | Extra | Status | Reason |
|---|---|---|---|
| `gsd` | mini.surround: delete surrounding | deferred | An extra, not a default — and LazyVim's `gs` prefix differs from mini.surround's own `sd`. It is a pure delete, so it would fit the game; `da(` / `di(` cover the nearby cases meanwhile. |
| `gsa` `gsr` | mini.surround: add / replace surrounding | n/a | Inserts text. |
| `gsf` `gsF` `gsh` `gsn` | mini.surround: find, highlight, update `n_lines` | deferred | Would only make sense together with `gsd`. |
| `y` `p` `P` `gp` `gP` `[p` `]p` `[P` `]P` `>p` `<p` `>P` `<P` `=p` `=P` `[y` `]y` `<leader>p` | yanky | n/a | No yank / put (#7). |
| `<C-a>` `<C-x>` `g<C-a>` `g<C-x>` | dial: increment / decrement | n/a | Changes text without deleting. |
| `s` `S` `gs` | leap (replaces flash when enabled) | n/a | Flash is the default; a second jump plugin is not modelled. |
| `gz…` | mini.surround with leap enabled | n/a | See leap. |
| `<leader>1`–`9` `<leader>h` `<leader>H` | harpoon | n/a | Files. |
| `<leader>d…` `<leader>td` | nvim-dap, dap-ui, dap-python | n/a | Debugger. |
| `<leader>t…` | neotest | n/a | Test runner. |
| `<leader>r…` | refactoring | n/a | Refactoring tools. |
| `<leader>a…` `<c-.>` | avante, claudecode, CopilotChat, sidekick | n/a | AI assistants. |
| `<leader>cs` `<leader>ss` | aerial, outline | n/a | Symbol outlines. |
| `<leader>go` | mini.diff | n/a | Git. |
| `<leader>fm` `<leader>fM` | mini.files | n/a | Files. |
| `<leader>o…` | overseer | n/a | Task runner. |
| `<leader>cn` | neogen | n/a | Inserts text. |
| `<leader>ue` `<leader>uE` | edgy | n/a | Windows. |
| `<leader>G…` `<leader>gi` `gI` `gp` `gP` `gr` `gS` `<localleader>…` | gh.nvim, octo | n/a | GitHub. |
| `<leader>R…` | kulala | n/a | HTTP client. |
| `<leader>sz` `<leader>fp` | chezmoi, project pickers | n/a | Files. |
| `<leader>cp` `<leader>cv` `<leader>D` `<leader>m…` `<leader>ta` `<localleader>…` | language extras (markdown / typst preview, venv-selector, dadbod, metals, ansible, haskell, vimtex) | n/a | Language tooling. |

## 6. Stock Vim keys added alongside

Not LazyVim remaps, but part of "almost all Vim key bindings" and cheap once the
engine was open:

| Keys | Vim | Status | Reason |
|---|---|---|---|
| `gj` `gk` | down / up by display line | supported | What LazyVim's `j` / `k` run; characterwise after an operator. |
| `_` `g_` | first / last non-blank of the row | supported | — |
| `-` `+` `<CR>` | first non-blank of the row above / below | supported | `Enter` while playing; on a screen it still starts / advances. |
| `{n}\|` | column n | supported | — |

Still missing from stock Vim, apart from what the owner ruled out (#7: Insert
mode, undo, yank / put, registers, macros, marks, `:`): sentence motions `(` `)`,
`[(` `[{` `])` `]}`, `gv`, `gn`, `{count}%`, regex search, `J`, `~`, and the
scroll keys (`Ctrl-d` `Ctrl-u` `Ctrl-f` `Ctrl-b` `zz` …, which have nothing to
scroll: the whole field is on screen).
