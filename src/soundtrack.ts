/**
 * Soundtrack page (#31): a music-player view of the game's eight BGM tracks.
 *
 * It plays the game's own track data through the game's own music engine
 * (`audio/tracks.ts`, `audio/bgm.ts`), so what you hear here is what the game
 * plays. Layout: a library on the left, a themed view of the selected track in
 * the middle (cover art, live meter, bar-by-bar structure), a player bar below.
 *
 * A track is a loop; as a "song" it is two passes of that loop, after which the
 * player moves to the next track unless Repeat is on.
 */
import '@fontsource/vt323/latin-400.css';
import './soundtrack.css';
import { TRACKS, type Track } from './audio/tracks.ts';
import { compile, createBgmEngine, secondsPerStep, softClipCurve, type BgmEngine, type CompiledTrack } from './audio/bgm.ts';
import { THEMES, coverSvg } from './soundtrack-art.ts';

const PASSES = 2; // loop passes that make one "song"
const LOOKAHEAD_S = 3; // schedule this far ahead so a background tab keeps playing
const VOLUME_KEY = 'redline.soundtrack.volume';

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h2.5v14H5zM20 5v14L9 12z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 5H19v14h-2.5zM4 5v14l11-7z" fill="currentColor"/></svg>',
  repeat:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h9.5l-2-2 1.4-1.4L20.3 8l-4.4 4.4-1.4-1.4 2-2H7a2 2 0 0 0-2 2v1H3v-1a4 4 0 0 1 4-4zm10 10H7.5l2 2-1.4 1.4L3.7 16l4.4-4.4 1.4 1.4-2 2H17a2 2 0 0 0 2-2v-1h2v1a4 4 0 0 1-4 4z" fill="currentColor"/></svg>',
  volume:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5h4l5-4.5v14l-5-4.5H3zM15 8.2a5 5 0 0 1 0 7.6v-2.3a3 3 0 0 0 0-3zM15 4.3a9 9 0 0 1 0 15.4v-2.2a7 7 0 0 0 0-11z" fill="currentColor"/></svg>',
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`soundtrack: #${id} missing`);
  return el as T;
};

interface Entry {
  track: Track;
  comp: CompiledTrack;
  /** Seconds per 16th-note step. */
  sps: number;
  /** Length of the song (PASSES loops), seconds. */
  seconds: number;
}

const ENTRIES: Entry[] = TRACKS.map((track) => {
  const comp = compile(track);
  const sps = secondsPerStep(track.bpm);
  return { track, comp, sps, seconds: comp.steps * sps * PASSES };
});

const mmss = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

// ── state ────────────────────────────────────────────────────────────────────
let selected = Math.max(0, ENTRIES.findIndex((e) => e.track.id === location.hash.slice(1)));
let repeat = false;
let audio: { ctx: AudioContext; engine: BgmEngine; vol: GainNode; analyser: AnalyserNode; bins: Uint8Array<ArrayBuffer> } | null = null;
let volume = 70;
try {
  const v = Number(localStorage.getItem(VOLUME_KEY));
  if (localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v)) volume = Math.min(100, Math.max(0, Math.round(v)));
} catch {
  // storage unavailable — keep the default
}

const volumeGain = (v: number): number => Math.pow(v / 100, 1.7);

/** The track the engine is sounding (playing or paused), or -1. */
function loadedIndex(): number {
  const id = audio?.engine.playingId();
  return id ? ENTRIES.findIndex((e) => e.track.id === id) : -1;
}
const isPlaying = (): boolean => !!audio && audio.ctx.state === 'running' && loadedIndex() >= 0;

function ensureAudio(): NonNullable<typeof audio> | null {
  if (audio) return audio;
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const vol = ctx.createGain();
    vol.gain.value = volumeGain(volume);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve(0.85, 0.13);
    vol.connect(analyser);
    analyser.connect(clip);
    clip.connect(ctx.destination);
    const engine = createBgmEngine(ctx, vol, { lookahead: LOOKAHEAD_S });
    audio = { ctx, engine, vol, analyser, bins: new Uint8Array(analyser.frequencyBinCount) };
    ctx.addEventListener('statechange', paintTransport);
    return audio;
  } catch {
    return null;
  }
}

// ── actions ──────────────────────────────────────────────────────────────────
function play(index: number, fromStep = 0): void {
  const a = ensureAudio();
  if (index !== selected) select(index);
  if (!a) {
    $('hint').textContent = 'This browser has no Web Audio, so the tracks cannot be played here.';
    return;
  }
  a.engine.play(ENTRIES[index].track, { from: fromStep });
  songStart = 0;
  void a.ctx.resume().catch(() => undefined);
  paintTransport();
}

/**
 * Jump to a point in the track in the player bar (#37), `frac` of the way through
 * its two passes. A paused track stays paused at the new point; with nothing
 * loaded, the shown track starts playing from there.
 */
function seek(frac: number): void {
  const loaded = loadedIndex();
  const index = loaded >= 0 ? loaded : selected;
  const e = ENTRIES[index];
  const total = e.comp.steps * PASSES;
  const step = Math.min(total - 1, Math.max(0, Math.round(frac * total)));
  const wasPaused = !!audio && loaded >= 0 && audio.ctx.state !== 'running';
  const a = ensureAudio();
  if (!a) return play(index);
  a.engine.play(e.track, { from: step });
  songStart = 0;
  if (!wasPaused) void a.ctx.resume().catch(() => undefined);
  paintTransport();
  paintPosition();
}

function toggle(): void {
  if (!audio || loadedIndex() !== selected) return play(selected);
  if (audio.ctx.state === 'running') void audio.ctx.suspend().then(paintTransport);
  else void audio.ctx.resume().then(paintTransport);
}

function step(delta: number): void {
  const next = (selected + delta + ENTRIES.length) % ENTRIES.length;
  if (loadedIndex() >= 0) play(next);
  else select(next);
}

function setRepeat(on: boolean): void {
  repeat = on;
  for (const id of ['repeat', 'repeat-chip']) {
    const b = $(id);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
  }
}

function setVolume(v: number): void {
  volume = Math.min(100, Math.max(0, Math.round(v)));
  const input = $<HTMLInputElement>('vol');
  input.value = String(volume);
  input.style.setProperty('--fill', `${volume}%`);
  if (audio) audio.vol.gain.setTargetAtTime(volumeGain(volume), audio.ctx.currentTime, 0.02);
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // ignore persistence failures
  }
}

// ── painting ─────────────────────────────────────────────────────────────────
let barCells: HTMLElement[] = [];

/** Show a track in the main view and re-colour the page for it. Does not start it. */
function select(index: number): void {
  selected = index;
  const e = ENTRIES[index];
  const t = e.track;
  const theme = THEMES[t.id];
  const app = $('app');
  app.style.setProperty('--accent', theme.accent);
  app.style.setProperty('--accent2', theme.accent2);
  app.style.setProperty('--ink', theme.ink);
  app.style.setProperty('--on-accent', theme.onAccent);

  $('hero-cover').innerHTML = coverSvg(t.id, index);
  $('hero-use').textContent = `Track ${index + 1} · ${t.use}`;
  $('hero-name').textContent = t.name;
  $('hero-feel').textContent = t.feel;
  $('hero-facts').textContent = `${t.bpm} BPM · ${t.key} · ${e.comp.bars.length}-bar loop · ${mmss(e.seconds)}`;
  document.title = `${t.name} — REDLINE Soundtrack`;
  history.replaceState(null, '', `#${t.id}`);

  // structure: one row per section, one cell per bar
  const bars = $('bars');
  bars.textContent = '';
  barCells = [];
  let row: HTMLElement | null = null;
  let last = '';
  e.comp.bars.forEach((b, i) => {
    if (b.section !== last || !row) {
      last = b.section;
      const line = document.createElement('div');
      line.className = 'bars-row';
      const tag = document.createElement('span');
      tag.className = 'bars-tag';
      tag.textContent = b.section;
      row = document.createElement('div');
      row.className = 'bars-cells';
      line.append(tag, row);
      bars.append(line);
    }
    const cell = document.createElement('span');
    cell.className = 'bar-cell';
    cell.textContent = b.chords.replace(/,/g, ' ');
    cell.title = `Bar ${i + 1}`;
    row.append(cell);
    barCells.push(cell);
  });
  $('structure-side').textContent = [...new Set(e.comp.bars.map((b) => b.section))].join(' → ');

  $('main').scrollTo?.({ top: 0 });
  paintTransport();
}

/** Everything that depends on what is loaded and whether it is sounding. */
function paintTransport(): void {
  const loaded = loadedIndex();
  const playing = isPlaying();
  const shown = loaded >= 0 ? loaded : selected;
  const e = ENTRIES[shown];

  $('p-cover').innerHTML = coverSvg(e.track.id, shown);
  $('p-name').textContent = e.track.name;
  $('p-use').textContent = e.track.use;
  $('t-total').textContent = mmss(e.seconds);
  const theme = THEMES[e.track.id];
  const player = document.querySelector<HTMLElement>('.player')!;
  player.style.setProperty('--accent', theme.accent);
  player.style.setProperty('--on-accent', theme.onAccent);

  const toggleBtn = $('toggle');
  toggleBtn.innerHTML = playing ? ICON.pause : ICON.play;
  toggleBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const heroPlaying = playing && loaded === selected;
  const hero = $('hero-play');
  hero.innerHTML = heroPlaying ? ICON.pause : ICON.play;
  hero.setAttribute('aria-label', heroPlaying ? 'Pause' : `Play ${ENTRIES[selected].track.name}`);

  document.querySelectorAll<HTMLElement>('.lib-item').forEach((li, i) => {
    li.classList.toggle('selected', i === selected);
    li.classList.toggle('loaded', i === loaded);
    li.classList.toggle('playing', i === loaded && playing);
    li.querySelector('button')?.setAttribute('aria-current', i === selected ? 'true' : 'false');
  });
  $('app').classList.toggle('is-playing', heroPlaying);
}

let lastBar = -1;
/**
 * Engine step where the current pass of the song began (#39). The engine counts
 * from the moment a track started; each time Repeat carries the song round again
 * this moves on by one song length, so turning Repeat off finishes *this* pass.
 */
let songStart = 0;
/** 0..1 while the progress bar is being dragged, else null. */
let dragFrac: number | null = null;
/** Progress, current bar and chord. Returns true when the song has run its passes. */
function paintPosition(): boolean {
  const pos = audio?.engine.position();
  const loaded = loadedIndex();
  const bar = $('bar');
  if (dragFrac !== null) {
    // while dragging, the bar follows the pointer and the time shows the target
    const e = ENTRIES[loaded >= 0 ? loaded : selected];
    bar.style.setProperty('--pos', `${(dragFrac * 100).toFixed(2)}%`);
    $('t-now').textContent = mmss(dragFrac * e.seconds);
    return false;
  }
  if (!pos || loaded < 0) {
    bar.style.setProperty('--pos', '0%');
    bar.setAttribute('aria-valuenow', '0');
    bar.setAttribute('aria-valuetext', '0:00');
    $('t-now').textContent = '0:00';
    $('live-chord').textContent = '';
    if (lastBar >= 0) barCells[lastBar]?.classList.remove('on');
    lastBar = -1;
    return false;
  }
  const e = ENTRIES[loaded];
  const total = e.comp.steps * PASSES;
  const at = pos.loop * e.comp.steps + pos.step;
  if (repeat) while (at - songStart >= total) songStart += total; // a new pass of the song
  const finished = !repeat && at - songStart >= total;
  const done = Math.min(total - 1, Math.max(0, at - songStart));
  const frac = done / total;
  bar.style.setProperty('--pos', `${(frac * 100).toFixed(2)}%`);
  bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  bar.setAttribute('aria-valuetext', mmss(done * e.sps));
  $('t-now').textContent = mmss(done * e.sps);

  if (loaded === selected) {
    if (pos.bar !== lastBar) {
      if (lastBar >= 0) barCells[lastBar]?.classList.remove('on');
      barCells[pos.bar]?.classList.add('on');
      lastBar = pos.bar;
    }
    const b = e.comp.bars[pos.bar];
    $('live-chord').textContent = b ? `${b.section} · bar ${pos.bar + 1} · ${b.chords.replace(/,/g, ' ')}` : '';
  } else {
    if (lastBar >= 0) barCells[lastBar]?.classList.remove('on');
    lastBar = -1;
    $('live-chord').textContent = '';
  }
  return finished;
}

// ── live meter ───────────────────────────────────────────────────────────────
const scope = $<HTMLCanvasElement>('scope');
const sctx = scope.getContext('2d');
const BARS = 48;
const levels = new Float32Array(BARS);

function paintScope(): void {
  if (!sctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = scope.clientWidth;
  const h = scope.clientHeight;
  if (w === 0 || h === 0) return;
  if (scope.width !== Math.round(w * dpr) || scope.height !== Math.round(h * dpr)) {
    scope.width = Math.round(w * dpr);
    scope.height = Math.round(h * dpr);
  }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, w, h);

  const live = isPlaying() && loadedIndex() === selected && audio;
  if (live) audio!.analyser.getByteFrequencyData(audio!.bins);
  const theme = THEMES[ENTRIES[selected].track.id];
  const gap = 3;
  const bw = (w - gap * (BARS - 1)) / BARS;
  const cell = 5; // each column is a stack of small blocks, like the game's gauge
  for (let i = 0; i < BARS; i++) {
    let target = 0;
    if (live) {
      // log-spaced bins: the top of the spectrum is nearly empty for chip-style voices
      const lo = Math.floor(Math.pow(i / BARS, 1.9) * 96);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / BARS, 1.9) * 96));
      let peak = 0;
      for (let k = lo; k < hi; k++) peak = Math.max(peak, audio!.bins[k]);
      target = peak / 255;
    }
    levels[i] = target > levels[i] ? target : levels[i] * 0.9 + target * 0.1;
    const blocks = Math.max(1, Math.round((levels[i] * (h - 4)) / cell));
    const x = i * (bw + gap);
    for (let b = 0; b < blocks; b++) {
      const top = b / ((h - 4) / cell);
      sctx.globalAlpha = blocks === 1 && !live ? 0.25 : 0.35 + top * 0.65;
      sctx.fillStyle = top > 0.72 ? theme.accent2 : theme.accent;
      sctx.fillRect(x, h - (b + 1) * cell, bw, cell - 1.5);
    }
  }
  sctx.globalAlpha = 1;
}

// ── build ────────────────────────────────────────────────────────────────────
function buildLibrary(): void {
  const list = $('library');
  ENTRIES.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'lib-item';
    const theme = THEMES[e.track.id];
    li.style.setProperty('--accent', theme.accent);
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML =
      `<span class="cover cover-xs">${coverSvg(e.track.id, i)}</span>` +
      `<span class="lib-text"><span class="lib-name"></span><span class="lib-use"></span></span>` +
      `<span class="lib-eq" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="lib-len">${mmss(e.seconds)}</span>`;
    b.querySelector('.lib-name')!.textContent = e.track.name;
    b.querySelector('.lib-use')!.textContent = e.track.use;
    b.addEventListener('click', () => (i === loadedIndex() ? toggle() : play(i)));
    li.append(b);
    list.append(li);
  });
}

function advanceIfDone(): void {
  if (paintPosition() && isPlaying()) play((loadedIndex() + 1) % ENTRIES.length);
}

function frame(): void {
  advanceIfDone();
  paintScope();
  requestAnimationFrame(frame);
}

buildLibrary();
$('prev').innerHTML = ICON.prev;
$('next').innerHTML = ICON.next;
$('repeat').innerHTML = ICON.repeat;
document.querySelector('.vol-icon')!.innerHTML = ICON.volume;
$('toggle').addEventListener('click', toggle);
$('hero-play').addEventListener('click', toggle);
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
// The bar's own keydown runs first and stops arrow keys from also changing track.
$('repeat').addEventListener('click', () => setRepeat(!repeat));
$('repeat-chip').addEventListener('click', () => setRepeat(!repeat));
// ── seeking (#37): click or drag the progress bar; arrows when it has focus ──
{
  const bar = $('bar');
  const fracAt = (clientX: number): number => {
    const r = bar.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  bar.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); // no text selection or focus ring from a mouse seek
    bar.setPointerCapture(ev.pointerId);
    bar.classList.add('dragging');
    dragFrac = fracAt(ev.clientX);
    paintPosition();
  });
  bar.addEventListener('pointermove', (ev) => {
    if (dragFrac === null) return;
    dragFrac = fracAt(ev.clientX);
    paintPosition();
  });
  const finish = (ev: PointerEvent, commit: boolean): void => {
    if (dragFrac === null) return;
    const frac = commit ? fracAt(ev.clientX) : null;
    dragFrac = null;
    bar.classList.remove('dragging');
    if (frac !== null) seek(frac);
    else paintPosition();
  };
  bar.addEventListener('pointerup', (ev) => finish(ev, true));
  bar.addEventListener('pointercancel', (ev) => finish(ev, false));
  bar.addEventListener('keydown', (ev) => {
    const e = ENTRIES[loadedIndex() >= 0 ? loadedIndex() : selected];
    const now = Number(bar.getAttribute('aria-valuenow') ?? 0) / 100;
    const stepFrac = 5 / e.seconds; // five seconds per arrow press
    let to: number | null = null;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') to = now + stepFrac;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') to = now - stepFrac;
    else if (ev.key === 'Home') to = 0;
    else if (ev.key === 'End') to = 0.999;
    if (to === null) return;
    ev.preventDefault();
    ev.stopPropagation(); // the page's own arrow keys change track / volume
    seek(Math.min(0.999, Math.max(0, to)));
  });
}

$<HTMLInputElement>('vol').addEventListener('input', (ev) => setVolume(Number((ev.target as HTMLInputElement).value)));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const inRange = e.target instanceof HTMLInputElement;
  if (e.key === ' ' || e.key === 'k') {
    if (e.target instanceof HTMLButtonElement && e.key === ' ') return; // the button handles its own Space
    e.preventDefault();
    toggle();
  } else if (e.key === 'ArrowRight' && !inRange) step(1);
  else if (e.key === 'ArrowLeft' && !inRange) step(-1);
  else if (e.key === 'ArrowUp' && !inRange) {
    e.preventDefault();
    setVolume(volume + 5);
  } else if (e.key === 'ArrowDown' && !inRange) {
    e.preventDefault();
    setVolume(volume - 5);
  } else if (e.key === 'l' || e.key === 'L' || e.key === 'r' || e.key === 'R') setRepeat(!repeat);
  else if (/^[1-8]$/.test(e.key)) play(Number(e.key) - 1);
  else if (e.key === 'Escape') location.assign('./');
});

// A hidden tab gets no animation frames; keep the track change on time anyway.
setInterval(() => {
  if (document.visibilityState === 'hidden') advanceIfDone();
}, 500);

setVolume(volume);
setRepeat(false);
select(selected);
requestAnimationFrame(frame);
