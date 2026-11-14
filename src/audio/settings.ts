/**
 * Audio settings (#14): a master mute plus, per bus (music / SFX), a volume
 * step and a mute — all remembered in localStorage. Pure over a tiny storage
 * interface so it can be tested without a browser.
 */

export type Bus = 'music' | 'sfx';

export const MAX_VOLUME = 10;

/** Default steps. SFX 7 and music 8 are the levels the two sets were approved at; music starts lower to sit under the SFX. */
export const DEFAULT_VOLUME: Record<Bus, number> = { music: 6, sfx: 7 };

/** The step at which a bus plays at the level it was approved at. */
const REFERENCE_STEP: Record<Bus, number> = { music: 8, sfx: 7 };
/** Bus gain at the reference step: music's prototype slider at 80 → 0.8²; the SFX reference level is baked into the SFX bus itself. */
const REFERENCE_GAIN: Record<Bus, number> = { music: 0.64, sfx: 1 };

export interface BusSettings {
  volume: number; // 0..MAX_VOLUME
  muted: boolean;
}

export interface AudioSettings {
  /** Master mute (`M` / `F2`). */
  muted: boolean;
  music: BusSettings;
  sfx: BusSettings;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `redline.muted` predates the buses (KDA-46) and stays the master mute. */
export const STORAGE_KEYS = {
  muted: 'redline.muted',
  musicVolume: 'redline.music.volume',
  musicMuted: 'redline.music.muted',
  sfxVolume: 'redline.sfx.volume',
  sfxMuted: 'redline.sfx.muted',
} as const;

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

function read(store: KeyValueStore | null, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(store: KeyValueStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // ignore persistence failures (private mode etc.)
  }
}

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_VOLUME, Math.max(0, Math.round(v)));
}

function readVolume(store: KeyValueStore | null, key: string, fallback: number): number {
  const raw = read(store, key);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clampVolume(n) : fallback;
}

export function loadSettings(store: KeyValueStore | null = browserStore()): AudioSettings {
  return {
    muted: read(store, STORAGE_KEYS.muted) === '1',
    music: {
      volume: readVolume(store, STORAGE_KEYS.musicVolume, DEFAULT_VOLUME.music),
      muted: read(store, STORAGE_KEYS.musicMuted) === '1',
    },
    sfx: {
      volume: readVolume(store, STORAGE_KEYS.sfxVolume, DEFAULT_VOLUME.sfx),
      muted: read(store, STORAGE_KEYS.sfxMuted) === '1',
    },
  };
}

export function saveSettings(s: AudioSettings, store: KeyValueStore | null = browserStore()): void {
  write(store, STORAGE_KEYS.muted, s.muted ? '1' : '0');
  write(store, STORAGE_KEYS.musicVolume, String(s.music.volume));
  write(store, STORAGE_KEYS.musicMuted, s.music.muted ? '1' : '0');
  write(store, STORAGE_KEYS.sfxVolume, String(s.sfx.volume));
  write(store, STORAGE_KEYS.sfxMuted, s.sfx.muted ? '1' : '0');
}

/** Gain of a bus's volume node: a square law (as on both prototype pages), zero when the bus is muted. */
export function busGain(bus: Bus, s: BusSettings): number {
  if (s.muted) return 0;
  const x = clampVolume(s.volume) / REFERENCE_STEP[bus];
  return REFERENCE_GAIN[bus] * x * x;
}

/** Whether anything on this bus can be heard. */
export function busAudible(s: AudioSettings, bus: Bus): boolean {
  return !s.muted && !s[bus].muted && s[bus].volume > 0;
}

/** The HUD's SOUND readout: `♪ M6 S7`, a bus that is off shows `-`, master mute shows `✕ MUTED`. */
export function soundLabel(s: AudioSettings): string {
  if (s.muted) return '✕ MUTED';
  const part = (b: BusSettings): string => (b.muted || b.volume === 0 ? '-' : String(b.volume));
  return `♪ M${part(s.music)} S${part(s.sfx)}`;
}
