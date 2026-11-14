/**
 * Control modes (#8). A mode is a control scheme: its own keymap over the
 * shared field actions, its own best score, and its own help text. The field,
 * the rules and the scoring are the same in every mode.
 *
 * This module is the registry: names, availability, the start-screen key help,
 * and the remembered choice (localStorage).
 */

export type Mode = 'standard' | 'vim';

export interface ModeInfo {
  id: Mode;
  /** Name shown on the start screen and in the HUD. */
  label: string;
  /** False while a mode is listed but not playable yet. */
  available: boolean;
  /** Start-screen key help for this mode, one centred row per entry. */
  startHelp: string[];
}

/** Every mode, in picker order — the start screen picks them with 1, 2, … */
export const MODES: readonly ModeInfo[] = [
  {
    id: 'standard',
    label: 'STANDARD',
    available: true,
    startHelp: [
      'move  ← →   ·  word  ⌥← ⌥→   ·  line  ⌘← ⌘→   ·  ↑ ↓',
      'delete left  ⌫  ⌥⌫  ⌘⌫     ·     delete right  ⌦  ⌥⌦  ⌘⌦',
      'select  ⇧ + move    ·    move row  ⌥↑ ⌥↓    ·    mute  M',
    ],
  },
  {
    id: 'vim',
    label: 'VIM',
    available: false, // lands with the Vim engine (#7)
    startHelp: [],
  },
];

export const DEFAULT_MODE: Mode = 'standard';

export function modeInfo(mode: Mode): ModeInfo {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

// ── remembered choice ───────────────────────────────────────────────────────
const MODE_KEY = 'redline.mode';

/** The mode picked last time, or the default when none is stored / it is not playable. */
export function loadMode(): Mode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    const found = MODES.find((m) => m.id === raw);
    if (found?.available) return found.id;
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to default
  }
  return DEFAULT_MODE;
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore persistence failures
  }
}
