/**
 * Keyboard input (spec §2): macOS movement chords mapped to actions, with
 * hold-to-repeat. We run our own repeat clock (not the OS key-repeat) so the
 * cadence is consistent regardless of system settings. Selection (KDA-36) and
 * deletion (KDA-37) attach more handlers onto this same controller later.
 */
import { type MoveAction } from './state.ts';

const REPEAT_DELAY = 280; // ms held before auto-repeat begins
const REPEAT_RATE = 45; // ms between repeats once it kicks in

/**
 * Which delete chord was pressed. Backward = Backspace family (spec §2);
 * forward = macOS fn+Delete family (KDA-51), mirrored rightward.
 */
export type DeleteAction =
  | 'backward'
  | 'word-left'
  | 'to-line-start'
  | 'forward'
  | 'word-right'
  | 'to-line-end';

export interface InputHandlers {
  move(action: MoveAction): void;
  /** Extend the selection by the same chord (Shift held). */
  select(action: MoveAction): void;
  delete(action: DeleteAction): void;
  /** Alt(Option) + ↑/↓ — move the caret's row (or selected rows) up (-1) / down (+1). */
  moveRow(dir: -1 | 1): void;
  /** Enter/Space — start or restart a run (start & game-over screens). */
  confirm(): void;
  /** M — toggle mute (KDA-46). */
  mute(): void;
  /**
   * Whether gameplay input (movement/selection/deletion) is currently accepted.
   * False during the countdown, stage-clear, start, and game-over screens —
   * gating here (not just in the handlers) stops held keys from arming the
   * auto-repeat and leaking into the board the instant play begins.
   */
  isActive(): boolean;
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
  // Movement keys seen while input is inactive (countdown / clear / over) — incl.
  // a key held down from a prior stage, whose OS key-repeat keeps arriving. They
  // stay neutralized until physically released, so a held key can't fire the
  // instant play begins (which otherwise selects/moves row 0 on stage start).
  const heldOver = new Set<string>();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) handlers.confirm();
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault(); // also stops the browser's back-navigation
      if (e.repeat || !handlers.isActive()) return; // one action per press; only while playing
      const action: DeleteAction = e.metaKey ? 'to-line-start' : e.altKey ? 'word-left' : 'backward';
      handlers.delete(action);
      return;
    }

    // Forward-delete (fn+Delete, or the dedicated Delete key) — mirrors Backspace.
    if (e.key === 'Delete') {
      e.preventDefault();
      if (e.repeat || !handlers.isActive()) return;
      const action: DeleteAction = e.metaKey ? 'to-line-end' : e.altKey ? 'word-right' : 'forward';
      handlers.delete(action);
      return;
    }

    if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (!e.repeat) handlers.mute();
      return;
    }

    // Alt(Option) + ↑/↓ → move the row(s) up/down (KDA-60). Plain Alt only —
    // Cmd falls through to doc-start/end, Shift to line-selection. Repeats while
    // held, gated by the same held-over/active rules as movement below.
    if (e.altKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (!handlers.isActive()) {
        heldOver.add(e.code);
        repeater.stop();
        return;
      }
      if (heldOver.has(e.code)) return;
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      repeater.start(e.code, () => {
        if (!handlers.isActive()) {
          repeater.stop();
          return;
        }
        handlers.moveRow(dir);
      });
      return;
    }

    const action = movementFor(e);
    if (!action) return;
    e.preventDefault(); // arrows would otherwise scroll the page
    // Not playing: remember the key as held-over and disarm any repeat. A key
    // pressed/held during the countdown must never carry into the revealed board.
    if (!handlers.isActive()) {
      heldOver.add(e.code);
      repeater.stop();
      return;
    }
    // A key still down from before play began: wait for a real release+press.
    if (heldOver.has(e.code)) return;
    // Same chords; Shift extends the selection instead of moving (both repeat).
    const action$ = e.shiftKey
      ? () => handlers.select(action)
      : () => handlers.move(action);
    // Guard each repeat fire: if play stopped (stage clear, countdown, etc.),
    // self-cancel so the timer can't leak into the next stage and silently
    // extend a selection from caret (0,0) once play resumes.
    const fire = () => {
      if (!handlers.isActive()) {
        repeater.stop();
        return;
      }
      action$();
    };
    repeater.start(e.code, fire);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    heldOver.delete(e.code); // released → a fresh press is honored again
    repeater.release(e.code);
  };
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
