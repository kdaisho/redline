/**
 * Standard mode keymap (spec §2): macOS editor chords over the shared field
 * actions. Stateless — every keydown resolves on its own.
 */
import { type MoveAction } from '../state.ts';
import { type Keymap, type KeyAction, type FieldActions, type DeleteAction } from '../input.ts';

/** Resolve a keydown into a movement action, honoring Cmd/Alt chords. */
function movementFor(e: KeyboardEvent): MoveAction | null {
  switch (e.key) {
    case 'ArrowLeft':
      return e.metaKey ? 'line-start' : e.altKey ? 'word-left' : 'char-left';
    case 'ArrowRight':
      return e.metaKey ? 'line-end' : e.altKey ? 'word-right' : 'char-right';
    case 'ArrowUp':
      return e.metaKey ? 'doc-start' : 'line-up';
    case 'ArrowDown':
      return e.metaKey ? 'doc-end' : 'line-down';
    default:
      return null;
  }
}

export function createStandardKeymap(actions: FieldActions): Keymap {
  /** Movement / selection / row moves repeat while held. */
  const held = (run: () => void): KeyAction => ({
    fire: () => {
      run();
      return true;
    },
  });
  /**
   * Deletes are one action per press (spec §2) and `passive`: tapping ⌫ while an
   * arrow is held leaves the arrow's repeat running.
   */
  const once = (action: DeleteAction): KeyAction => ({
    fire: () => {
      actions.delete(action);
      return false;
    },
    passive: true,
  });

  return {
    resolve(e: KeyboardEvent): KeyAction | null {
      // ⌘Z: undo, which only free practice acts on (#43). ⇧⌘Z (redo) is not ours.
      if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        return {
          fire: () => {
            actions.undo();
            return false;
          },
          passive: true,
        };
      }
      // Backspace family — also stops the browser's back-navigation.
      if (e.key === 'Backspace') {
        return once(e.metaKey ? 'to-line-start' : e.altKey ? 'word-left' : 'backward');
      }
      // Forward-delete (fn+Delete, or the dedicated Delete key) — mirrors Backspace.
      if (e.key === 'Delete') {
        return once(e.metaKey ? 'to-line-end' : e.altKey ? 'word-right' : 'forward');
      }

      // Alt(Option) + ↑/↓ → move the row(s) up/down (KDA-60). Plain Alt only —
      // Cmd falls through to doc-start/end, Shift to line-selection.
      if (e.altKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        return held(() => actions.moveRow(dir));
      }

      const move = movementFor(e);
      if (!move) return null;
      // Same chords; Shift extends the selection instead of moving (both repeat).
      return held(e.shiftKey ? () => actions.select(move) : () => actions.move(move));
    },
  };
}
