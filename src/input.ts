/**
 * Keyboard input (spec §2): macOS movement chords mapped to actions, with
 * hold-to-repeat. We run our own repeat clock (not the OS key-repeat) so the
 * cadence is consistent regardless of system settings. Selection (KDA-36) and
 * deletion (KDA-37) attach more handlers onto this same controller later.
 */
import { type MoveAction } from './state.ts';

const REPEAT_DELAY = 280; // ms held before auto-repeat begins
const REPEAT_RATE = 45; // ms between repeats once it kicks in

/** Which delete chord was pressed (spec §2). */
export type DeleteAction = 'backward' | 'word-left' | 'to-line-start';

export interface InputHandlers {
  move(action: MoveAction): void;
  /** Extend the selection by the same chord (Shift held). */
  select(action: MoveAction): void;
  delete(action: DeleteAction): void;
  /** Enter/Space — start or restart a run (start & game-over screens). */
  confirm(): void;
}

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

/**
 * Fires an action once on press, then repeats while the key is held. Tracks a
 * single active physical key (e.code); a new movement key overrides the old.
 */
class Repeater {
  private activeKey: string | null = null;
  private delayId = 0;
  private rateId = 0;

  start(key: string, fire: () => void): void {
    if (this.activeKey === key) return; // already repeating this key
    this.stop();
    this.activeKey = key;
    fire();
    this.delayId = window.setTimeout(() => {
      this.rateId = window.setInterval(fire, REPEAT_RATE);
    }, REPEAT_DELAY);
  }

  release(key: string): void {
    if (this.activeKey === key) this.stop();
  }

  stop(): void {
    window.clearTimeout(this.delayId);
    window.clearInterval(this.rateId);
    this.activeKey = null;
  }
}

/** Wire input handlers to the window. Returns a teardown function. */
export function attachInput(handlers: InputHandlers, target: Window = window): () => void {
  const repeater = new Repeater();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) handlers.confirm();
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault(); // also stops the browser's back-navigation
      if (e.repeat) return; // deletion is one action per keypress — no hold-to-repeat
      const action: DeleteAction = e.metaKey ? 'to-line-start' : e.altKey ? 'word-left' : 'backward';
      handlers.delete(action);
      return;
    }

    const action = movementFor(e);
    if (!action) return;
    e.preventDefault(); // arrows would otherwise scroll the page
    // Same chords; Shift extends the selection instead of moving (both repeat).
    const fire = e.shiftKey
      ? () => handlers.select(action)
      : () => handlers.move(action);
    repeater.start(e.code, fire);
  };

  const onKeyUp = (e: KeyboardEvent) => repeater.release(e.code);
  const onBlur = () => repeater.stop();

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', onBlur);
    repeater.stop();
  };
}
