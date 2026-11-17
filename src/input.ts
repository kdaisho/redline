/**
 * Keyboard input (spec §2). This module is the shared controller: it owns the
 * window listeners, the hold-to-repeat clock, and the global keys (start / mute /
 * help / mode picker). What a key *does* on
 * the field is decided by the active mode's keymap (#8) — `keymaps/standard.ts`
 * and friends — each of which maps keys onto the same shared field actions.
 *
 * We run our own repeat clock (not the OS key-repeat) so the cadence is
 * consistent regardless of system settings.
 */
import { type MoveAction, type DeleteAction } from './state.ts';

export type { DeleteAction };

const REPEAT_DELAY = 280; // ms held before auto-repeat begins
const REPEAT_RATE = 45; // ms between repeats once it kicks in

/** The field actions every mode's keymap is built over. */
export interface FieldActions {
  move(action: MoveAction): void;
  /** Extend the selection by the same motion. */
  select(action: MoveAction): void;
  delete(action: DeleteAction): void;
  /** Move the caret's row (or selected rows) up (-1) / down (+1). */
  moveRow(dir: -1 | 1): void;
  /** ⌘Z: undo the last change to the board — free practice only (#43); a real run ignores it. */
  undo(): void;
}

/** What a key does in the active mode. */
export interface KeyAction {
  /** Run it. Return true when it may auto-repeat while the key stays held. */
  fire(): boolean;
  /** Leave another key's running auto-repeat alone (a tap that is not itself held). */
  passive?: boolean;
}

/** One mode's key bindings: resolve a keydown into an action, or null if the mode doesn't use the key. */
export interface Keymap {
  resolve(e: KeyboardEvent): KeyAction | null;
}

export interface InputHandlers {
  /** The active mode's keymap. Asked on every keydown, so a mode switch applies at once. */
  keymap(): Keymap;
  /** Enter/Space — start or restart a run (start & game-over screens). */
  confirm(): void;
  /** M or F2 — toggle mute (KDA-46). F2 works in every mode; a mode may claim M. */
  mute(): void;
  /** F1 — open / close the help screen for the active mode. */
  help(): void;
  /** F3 / F4 (music) and F6 / F7 (SFX) — one volume step down (-1) / up (+1). Repeats while held. */
  volume?(bus: 'music' | 'sfx', delta: -1 | 1): void;
  /** Shift + a volume key — mute / un-mute that bus only. */
  busMute?(bus: 'music' | 'sfx'): void;
  /**
   * Escape — the game's menu key (#33): opens the pause menu while playing (in a
   * mode whose keymap does not claim Esc) or on the start screen, and goes back
   * to the start screen from an end screen.
   */
  menu(): void;
  /**
   * A menu is open: it gets every key first (function keys aside). Return true
   * when the key was the menu's, which also swallows it.
   */
  overlayKey?(e: KeyboardEvent): boolean;
  /** A digit key on a screen: pick the mode at this 0-based picker index. */
  pickMode(index: number): void;
  /** Caps Lock turned on / off, as read off the latest key event (#51). */
  capsLock?(on: boolean): void;
  /** Tab on a screen: step to the next mode. */
  cycleMode(): void;
  /** S on a screen: open the soundtrack page (#31). The game decides which screens allow it. */
  soundtrack?(): void;
  /** T on a screen: open training (#43). The game decides which screens allow it. */
  training?(): void;
  /** R on a screen: retry the board just cleared in practice (#43). */
  retry?(): void;
  /**
   * Whether gameplay input is currently accepted. False during the countdown,
   * stage-clear, start, and game-over screens — gating here (not just in the
   * handlers) stops held keys from arming the auto-repeat and leaking into the
   * board the instant play begins.
   */
  isActive(): boolean;
}

/** The volume keys: function keys, so they work in every mode and phase (#14). F5 is left to the browser. */
const VOLUME_KEYS: Record<string, [bus: 'music' | 'sfx', delta: -1 | 1]> = {
  F3: ['music', -1],
  F4: ['music', 1],
  F6: ['sfx', -1],
  F7: ['sfx', 1],
};

/**
 * Fires an action once on press, then repeats while the key is held (if the
 * action allows it). Tracks a single active physical key (e.code); a new key
 * overrides the old.
 */
class Repeater {
  private activeKey: string | null = null;
  private delayId = 0;
  private rateId = 0;

  /** `fire` returns whether it may keep repeating; a false return ends the hold. */
  start(key: string, fire: () => boolean): void {
    if (this.activeKey === key) return; // already repeating this key
    this.stop();
    if (!fire()) return;
    this.activeKey = key;
    const tick = () => {
      if (!fire()) this.stop();
    };
    this.delayId = window.setTimeout(() => {
      this.rateId = window.setInterval(tick, REPEAT_RATE);
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
  /** Keys that belong to the game itself, not to a mode. Returns true when handled. */
  const globalKey = (e: KeyboardEvent, active: boolean): boolean => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) handlers.confirm();
      return true;
    }
    if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (!e.repeat) handlers.mute();
      return true;
    }
    if (e.key === 'Escape') {
      if (!e.repeat) handlers.menu();
      return true;
    }
    if (active) return false; // the keys below only mean something on a screen
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); // keep focus on the game
      if (!e.repeat) handlers.cycleMode();
      return true;
    }
    if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (!e.repeat) handlers.soundtrack?.();
      return true;
    }
    if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (!e.repeat) handlers.training?.();
      return true;
    }
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (!e.repeat) handlers.retry?.();
      return true;
    }
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (!e.repeat) handlers.pickMode(Number(e.key) - 1);
      return true;
    }
    return false;
  };

  // Caps Lock state (#51), read off every key event. The Caps Lock key's own
  // events are not reliable on macOS, so any key will do.
  let capsLock = false;
  const trackCapsLock = (e: KeyboardEvent) => {
    const on = e.getModifierState?.('CapsLock') ?? false;
    if (on === capsLock) return;
    capsLock = on;
    handlers.capsLock?.(on);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    trackCapsLock(e);
    // Function keys are the game's own in every mode and every phase — no mode
    // can claim them, so help, mute and the volumes are always reachable.
    if (e.key === 'F1' || e.key === 'F2') {
      e.preventDefault();
      if (!e.repeat) {
        if (e.key === 'F1') handlers.help();
        else handlers.mute();
      }
      return;
    }
    const vol = VOLUME_KEYS[e.key];
    if (vol) {
      e.preventDefault();
      if (e.shiftKey) {
        if (!e.repeat) handlers.busMute?.(vol[0]);
      } else handlers.volume?.(vol[0], vol[1]);
      return;
    }

    if (handlers.overlayKey?.(e)) {
      e.preventDefault();
      repeater.stop();
      return;
    }

    const keymap = handlers.keymap();

    // Not playing: disarm any repeat. A key pressed/held during the countdown
    // must never carry into the revealed board — its press is dropped here, and
    // the OS key-repeats that keep arriving once play begins are ignored below.
    if (!handlers.isActive()) {
      repeater.stop();
      if (globalKey(e, false)) return;
      // A gameplay key on a screen does nothing, but still must not scroll the
      // page (arrows) or navigate back (Backspace).
      if (keymap.resolve(e)) e.preventDefault();
      return;
    }

    // Playing: the mode's keymap gets first refusal, so a mode may claim a key
    // that is otherwise global.
    const action = keymap.resolve(e);
    if (!action) {
      if (globalKey(e, true)) return;
      // Keys the mode leaves unused must not take focus off the game mid-stage (#35):
      // Tab would move to the browser's toolbar, and / or ' opens Firefox's Quick Find.
      if (e.key === 'Tab' || ((e.key === '/' || e.key === "'") && !e.metaKey && !e.ctrlKey)) e.preventDefault();
      return;
    }
    e.preventDefault();
    // One action per physical press: the OS key-repeat is ignored (our own clock
    // repeats), so a key still down from before play began waits for a real
    // release + press.
    if (e.repeat) return;

    // Guard each fire: if play stopped (stage clear, countdown, etc.), self-cancel
    // so the timer can't leak into the next stage once play resumes.
    const fire = (): boolean => {
      if (!handlers.isActive()) return false;
      return action.fire();
    };
    if (action.passive) fire();
    else repeater.start(e.code, fire);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    trackCapsLock(e);
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
