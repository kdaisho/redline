/**
 * Vim mode keymap (#7). Unlike Standard, Vim is modal and stateful, so this
 * keymap does no interpreting of its own: it names each keydown the way the
 * engine (`vim.ts`) expects and feeds it in. The engine decides what the key
 * means in the current mode / pending command.
 *
 * Key names: a printable key is its own character (`d`, `G`, `$`, ` `); the rest
 * are `<Esc>`, `<CR>`, `<BS>`, `<Del>`, `<C-v>`, `<Left>` `<Right>` `<Up>` `<Down>`,
 * and LazyVim's row moves `<A-j>` `<A-k>` (#9).
 *
 * While playing, Vim claims every key it names — including Enter, Space, Esc and
 * `M`, which are global keys in Standard mode. Mute and help therefore live on
 * function keys (F2 / F1), which work in every mode.
 */
import { type Keymap, type KeyAction } from '../input.ts';

const SPECIAL: Record<string, string> = {
  Escape: '<Esc>',
  Enter: '<CR>',
  Backspace: '<BS>',
  Delete: '<Del>',
  ArrowLeft: '<Left>',
  ArrowRight: '<Right>',
  ArrowUp: '<Up>',
  ArrowDown: '<Down>',
};

/** The engine's name for a keydown, or null when Vim mode does not use it. */
export function vimKeyName(e: KeyboardEvent): string | null {
  if (e.metaKey) return null; // leave browser / OS shortcuts alone
  // Ctrl+Alt is AltGr on some layouts (how `{` `[` `@` are typed) — treat that as plain typing.
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'v') return '<C-v>';
    if (k === '[' || k === 'c') return '<Esc>'; // Vim's other ways to press Escape
    return null;
  }
  if (e.altKey && !e.ctrlKey) {
    // LazyVim's Alt-j / Alt-k. On macOS Option turns the letters into `∆` and `˚`.
    if (e.key === 'j' || e.key === 'J' || e.key === '∆') return '<A-j>';
    if (e.key === 'k' || e.key === 'K' || e.key === '˚') return '<A-k>';
  }
  const special = SPECIAL[e.key];
  if (special) return special;
  // One printable character. Named keys (Shift, F1, Tab, Dead, …) are longer.
  return e.key.length === 1 ? e.key : null;
}

/**
 * `feed` hands one key to the engine and returns whether it was a complete
 * motion on its own — only those auto-repeat while held; deletes never do.
 */
export function createVimKeymap(feed: (key: string) => boolean): Keymap {
  return {
    resolve(e: KeyboardEvent): KeyAction | null {
      const key = vimKeyName(e);
      return key === null ? null : { fire: () => feed(key) };
    },
  };
}
