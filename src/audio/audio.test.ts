/**
 * Audio (#14), headless: the BGM compile step, the music's track choice and
 * transitions, the 31 Halo sounds against a checking stub AudioContext, the
 * held-key gate, the action → sound mappings, and the persisted settings.
 * Nothing here can hear — it checks structure, timing and scheduling safety.
 */
import { describe, it, expect } from 'vitest';
import { TRACKS, trackById, type TrackId } from './tracks.ts';
import { STEPS, compile, loopSeconds, mtof, createBgmEngine, softClipCurve } from './bgm.ts';
import {
  MusicDirector,
  type MusicPlayer,
  TIER_TRACKS,
  tierOfStage,
  trackForStage,
  trackForScene,
  transitionTo,
} from './music.ts';
import { SFX_IDS, type SfxId, type SfxParams, playSfx, createSfxBus } from './sfx.ts';
import { SfxGate, LANE_HOLD, HARD_VOICE_CAP } from './gate.ts';
import { moveCue, deleteCues, vimCue, lowTimeTick, secondsLeft, type VimSnapshot, type Cue } from './cues.ts';
import {
  type KeyValueStore,
  DEFAULT_VOLUME,
  MAX_VOLUME,
  STORAGE_KEYS,
  busAudible,
  busGain,
  loadSettings,
  saveSettings,
  soundLabel,
} from './settings.ts';
import { StubContext } from './stub-context.ts';
import { type FieldState, createField, text, spaces, line } from '../state.ts';
import { Vim } from '../vim.ts';
import { MAX_STAGE_INDEX } from '../stages.ts';

// ── BGM: compile ─────────────────────────────────────────────────────────────
/** Loop lengths from the table on issue #12, seconds to one decimal. */
const LOOP_SECONDS: Record<TrackId, number> = {
  'cold-boot': 27.8,
  'green-diff': 38.4,
  'hot-path': 36.9,
  'race-condition': 46.8,
  'stack-overflow': 44.7,
  redline: 42.7,
  'core-dump': 17.8,
  'ship-it': 36.0,
};

describe('bgm compile', () => {
  it('has the eight tracks, in slot order', () => {
    expect(TRACKS.map((t) => t.id)).toEqual(Object.keys(LOOP_SECONDS));
    expect(new Set(TRACKS.map((t) => t.name)).size).toBe(8);
  });

  for (const track of TRACKS) {
    describe(track.name, () => {
      const c = compile(track);

      it('is whole bars of 16 steps', () => {
        expect(c.steps).toBe(c.bars.length * STEPS);
        expect(c.bars.length % 8).toBe(0); // every section is eight bars
        expect(c.bars.length).toBeGreaterThan(0);
      });

      it(`loops in ${LOOP_SECONDS[track.id].toFixed(1)} s`, () => {
        expect(Math.abs(loopSeconds(track, c) - LOOP_SECONDS[track.id])).toBeLessThan(0.05);
      });

      it('every event is inside the loop, with a finite pitch and level', () => {
        const pitched = new Set(['lead', 'harm', 'arp', 'chord', 'bass', 'tom']);
        let prev = 0;
        for (const e of c.events) {
          expect(Number.isInteger(e.t) && e.t >= 0 && e.t < c.steps, `start ${e.t}`).toBe(true);
          expect(Number.isInteger(e.d) && e.d > 0, `length ${e.d}`).toBe(true);
          expect(e.t + e.d, 'ends inside the loop').toBeLessThanOrEqual(c.steps);
          expect(e.t).toBeGreaterThanOrEqual(prev); // time-sorted
          prev = e.t;
          expect(e.v > 0 && e.v <= 1, `velocity ${e.v}`).toBe(true);
          if (pitched.has(e.ch)) {
            const f = mtof(e.m);
            expect(Number.isFinite(f), `${e.ch} midi ${e.m}`).toBe(true);
            expect(f).toBeGreaterThan(25); // audible …
            expect(f).toBeLessThan(4200); // … and not a typo three octaves up
          }
        }
      });

      it('every bar has a downbeat and something on every channel it should', () => {
        const starts = new Set(c.events.map((e) => Math.floor(e.t / STEPS)));
        for (let b = 0; b < c.bars.length; b++) expect(starts.has(b), `bar ${b + 1} is empty`).toBe(true);
        const channels = new Set(c.events.map((e) => e.ch));
        for (const ch of ['lead', 'bass', 'chord', 'kick', 'snare', 'hat', 'crash']) expect(channels.has(ch as never), ch).toBe(true);
      });

      it('schedules a whole loop on a context without a bad time or value', () => {
        const stub = new StubContext(3.5);
        const engine = createBgmEngine(stub.asContext(), stub.node());
        const done = engine.scheduleAll(track, 1, stub.currentTime + 0.06);
        expect(stub.problems).toEqual([]);
        expect(done.events).toBe(c.events.length);
        expect(done.seconds).toBeCloseTo(loopSeconds(track, c), 9);
        expect(stub.sources).toBeGreaterThan(c.events.length); // ≥ one source per event (+ the LFO)
        expect(Number.isFinite(stub.lastStop)).toBe(true);
      });
    });
  }

  it('can start a track part-way through (#37 seek)', () => {
    const t = trackById('green-diff');
    const c = compile(t);
    const stub = new StubContext(2);
    const engine = createBgmEngine(stub.asContext(), stub.node());
    const from = c.steps + 5 * STEPS + 3; // second pass, bar 6, step 3
    engine.play(t, { from });
    stub.currentTime += 0.06; // START_LEAD: the first note is due now
    const pos = engine.position()!;
    expect(pos.loop).toBe(1);
    expect(pos.bar).toBe(5);
    expect(pos.step).toBe(5 * STEPS + 3);
    expect(stub.problems).toEqual([]); // nothing scheduled in the past
    engine.stop();
  });

  it('compiling is pure and repeatable', () => {
    const t = trackById('redline');
    expect(compile(t)).toEqual(compile(t));
  });

  it('rejects broken notation instead of playing it wrong', () => {
    const base = trackById('core-dump');
    const broken = (lead: string) => ({ ...base, sections: [{ ...base.sections[0], lead }] });
    expect(() => compile(broken('e5:4 | e5:16'))).toThrow(/bars/);
    expect(() => compile(broken(base.sections[0].lead!.replace('r:4 b4:2', 'r:4 b4:3')))).toThrow(/adds up to 17/);
    expect(() => compile(broken(base.sections[0].lead!.replace('b4:2', 'h4:2')))).toThrow(/bad note/);
  });

  it('the soft clipper is transparent below its knee and never reaches full scale', () => {
    for (const [knee, room] of [
      [0.7, 0.25],
      [0.85, 0.13],
    ]) {
      const c = softClipCurve(knee, room);
      const at = (x: number) => c[Math.round(((x + 1) / 2) * (c.length - 1))];
      expect(at(0)).toBeCloseTo(0, 6);
      expect(at(0.5)).toBeCloseTo(0.5, 3);
      expect(at(-0.5)).toBeCloseTo(-0.5, 3);
      expect(Math.max(...c)).toBeLessThan(1);
      expect(Math.min(...c)).toBeGreaterThan(-1);
      for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]); // monotonic
    }
  });
});

// ── music: track choice + transitions ────────────────────────────────────────
describe('music slots', () => {
  it('maps every stage to its tier track', () => {
    const expected: [from: number, to: number, id: TrackId][] = [
      [1, 10, 'green-diff'],
      [11, 20, 'hot-path'],
      [21, 30, 'race-condition'],
      [31, 40, 'stack-overflow'],
      [41, 50, 'redline'],
    ];
    for (const [from, to, id] of expected) {
      for (let stage = from; stage <= to; stage++) expect(trackForStage(stage - 1), `stage ${stage}`).toBe(id);
    }
    expect(MAX_STAGE_INDEX).toBe(49); // five tiers of ten cover the whole run
    expect(TIER_TRACKS.length).toBe(5);
    expect(tierOfStage(999)).toBe(4); // clamped, never undefined
    expect(tierOfStage(-1)).toBe(0);
  });

  it('maps the screens', () => {
    expect(trackForScene({ kind: 'title' })).toBe('cold-boot');
    expect(trackForScene({ kind: 'stage', stageIndex: 0 })).toBe('green-diff');
    expect(trackForScene({ kind: 'over' })).toBe('core-dump');
    expect(trackForScene({ kind: 'won' })).toBe('ship-it');
  });

  it('uses each of the eight tracks exactly once', () => {
    const used = [trackForScene({ kind: 'title' }), ...TIER_TRACKS, trackForScene({ kind: 'over' }), trackForScene({ kind: 'won' })];
    expect([...used].sort()).toEqual(TRACKS.map((t) => t.id).sort());
  });

  it('every transition fades (never a hard cut)', () => {
    const scenes = [{ kind: 'title' }, { kind: 'stage', stageIndex: 10 }, { kind: 'over' }, { kind: 'won' }] as const;
    for (const scene of scenes) {
      for (const from of [null, 'cold-boot', 'green-diff'] as const) {
        const tr = transitionTo(scene, from);
        expect(tr.fadeTc).toBeGreaterThan(0);
        expect(tr.delay).toBeGreaterThan(0);
      }
    }
  });
});

describe('music director', () => {
  function rig() {
    const log: string[] = [];
    const player: MusicPlayer = {
      play: (id, opts) => log.push(`play ${id}${opts.delay > 1 ? ' (after the cue)' : ''}`),
      stop: () => log.push('stop'),
    };
    const take = (): string[] => log.splice(0);
    return { director: new MusicDirector(), player, take };
  }

  it('waits for audio, then starts the title theme', () => {
    const { director, player, take } = rig();
    director.setScene({ kind: 'title' }); // page load: no gesture yet, nothing can play
    expect(director.playing()).toBeNull();
    director.attach(player); // first key press unlocked audio
    expect(take()).toEqual(['play cold-boot']);
    expect(director.playing()).toBe('cold-boot');
  });

  it('starts the right track when the unlocking key already changed the screen', () => {
    const { director, player, take } = rig();
    director.setScene({ kind: 'title' });
    director.setScene({ kind: 'stage', stageIndex: 0 }); // Enter both unlocked audio and began the run
    director.attach(player);
    expect(take()).toEqual(['play green-diff']); // the title theme never blips
  });

  it('plays a full run: title → tiers → win → title', () => {
    const { director, player, take } = rig();
    director.attach(player);
    expect(take()).toEqual(['play cold-boot']);

    const switches: string[] = [];
    for (let stage = 0; stage <= MAX_STAGE_INDEX; stage++) {
      director.setScene({ kind: 'stage', stageIndex: stage }); // countdown
      director.setScene({ kind: 'stage', stageIndex: stage }); // playing / cleared: same scene again
      const did = take();
      if (did.length > 0) switches.push(`${stage + 1}: ${did.join(', ')}`);
    }
    // the track changes only when the tier does — it plays on through countdown and stage clear
    expect(switches).toEqual([
      '1: stop, play green-diff',
      '11: stop, play hot-path',
      '21: stop, play race-condition',
      '31: stop, play stack-overflow',
      '41: stop, play redline',
    ]);

    director.setScene({ kind: 'won' });
    expect(take()).toEqual(['stop', 'play ship-it (after the cue)']);
    director.setScene({ kind: 'title' }); // Esc: back to the menu
    expect(take()).toEqual(['stop', 'play cold-boot']);
  });

  it('game over, then straight into a new run', () => {
    const { director, player, take } = rig();
    director.attach(player);
    director.setScene({ kind: 'stage', stageIndex: 14 });
    take();
    director.setScene({ kind: 'over' });
    expect(take()).toEqual(['stop', 'play core-dump (after the cue)']);
    director.setScene({ kind: 'over' });
    expect(take()).toEqual([]); // still the same screen
    director.setScene({ kind: 'stage', stageIndex: 0 }); // Enter: restart
    expect(take()).toEqual(['stop', 'play green-diff']);
  });

  it('stops while the music cannot be heard and restarts the current scene after', () => {
    const { director, player, take } = rig();
    director.attach(player);
    director.setScene({ kind: 'stage', stageIndex: 25 });
    take();
    director.setEnabled(false); // muted
    expect(take()).toEqual(['stop']);
    expect(director.playing()).toBeNull();
    director.setScene({ kind: 'stage', stageIndex: 30 }); // the game moves on in silence
    expect(take()).toEqual([]);
    director.setEnabled(true);
    expect(take()).toEqual(['play stack-overflow']);
    director.setEnabled(true); // no change → nothing
    expect(take()).toEqual([]);
  });
});

// ── SFX: the Halo set ────────────────────────────────────────────────────────
describe('sfx', () => {
  it('has exactly the 31 actions', () => {
    expect(SFX_IDS).toEqual([
      'moveChar', 'moveWord', 'moveLineEdge', 'moveLine', 'selExtend', 'selClear',
      'delChar', 'delWord', 'delLine', 'delSelection', 'delBig', 'rowCollapse', 'rowMove',
      'comboUp', 'comboBreak', 'mistake', 'strike', 'gameOver',
      'countdownTick', 'countdownGo', 'stageStart', 'stageClear', 'runWin', 'timeWarning', 'timeUp',
      'menuMove', 'menuConfirm', 'muteToggle', 'vimMode', 'vimPending', 'vimInvalid',
    ]);
    expect(new Set(SFX_IDS).size).toBe(31);
  });

  /** Every parameter a sound reads, at its edges (and beyond them). */
  const VARIANTS: SfxParams[] = [
    {},
    { dir: -1 },
    { dir: 1 },
    { size: 0 },
    { size: 1 },
    { size: 5 },
    { size: 60 },
    { size: 5000 },
    { level: 0 },
    { level: 1 },
    { level: 5 },
    { level: 12 },
    { level: 99 },
    { muted: true },
    { muted: false },
    { mode: 'normal' },
    { mode: 'insert' },
    { mode: 'visual' },
  ];

  for (const id of SFX_IDS) {
    it(`${id} schedules cleanly`, () => {
      for (const now of [0, 12.34]) {
        for (const delay of [undefined, 0.5]) {
          for (const params of [undefined, ...VARIANTS]) {
            const stub = new StubContext(now);
            const bus = createSfxBus(stub.asContext());
            const at = delay === undefined ? undefined : now + delay;
            const done = playSfx(stub.asContext(), bus.input, id, params, at);
            const what = `${id} ${JSON.stringify(params)} now=${now} delay=${delay}`;
            expect(stub.problems, what).toEqual([]);
            expect(done.voices, what).toBeGreaterThan(0);
            expect(stub.sources, what).toBe(done.voices);
            expect(stub.lastStart, what).toBeGreaterThanOrEqual(now + (delay ?? 0) - 1e-9);
            expect(done.end, what).toBeGreaterThan(now);
            expect(done.end - now, `${what}: longer than any cue should be`).toBeLessThan(4);
          }
        }
      }
    });
  }

  it('a start time already in the past is pulled up to now', () => {
    const stub = new StubContext(5);
    playSfx(stub.asContext(), stub.node(), 'delChar', undefined, 4.2);
    expect(stub.problems).toEqual([]);
    expect(stub.lastStart).toBeGreaterThanOrEqual(5);
  });

  it('the movement sounds are short enough for a held key (45 ms repeat)', () => {
    for (const id of ['moveChar', 'moveWord', 'moveLine', 'selExtend'] as const) {
      const stub = new StubContext(1);
      const done = playSfx(stub.asContext(), stub.node(), id);
      expect(done.end - 1, id).toBeLessThan(0.09); // incl. the 30 ms release tail
      expect(done.voices, id).toBe(1); // one voice each — nothing to stack
    }
  });
});

// ── held keys ────────────────────────────────────────────────────────────────
describe('sfx gate', () => {
  /** Fire `id` every `everyMs` for `forMs`; returns the start times admitted. */
  function hold(gate: SfxGate, id: SfxId, everyMs: number, forMs: number, jitterMs = 0): number[] {
    const starts: number[] = [];
    let n = 0;
    for (let ms = 0; ms < forMs; ms += everyMs) {
      const now = (ms + (n++ % 2 ? jitterMs : -jitterMs)) / 1000;
      const at = gate.admit(id, Math.max(0, now));
      if (at !== null) {
        starts.push(at);
        gate.started(1, at + 0.06);
      }
    }
    return starts;
  }
  const gaps = (starts: number[]): number[] => starts.slice(1).map((t, i) => t - starts[i]);

  it('a held key at the game repeat rate plays every repeat, evenly', () => {
    for (const id of ['moveChar', 'moveWord', 'moveLine', 'selExtend'] as const) {
      const starts = hold(new SfxGate(), id, 45, 2000);
      expect(starts.length, id).toBe(Math.ceil(2000 / 45));
      for (const g of gaps(starts)) expect(g, id).toBeCloseTo(0.045, 6);
    }
  });

  it('timer jitter is smoothed, never doubled up', () => {
    const starts = hold(new SfxGate(), 'moveChar', 45, 2000, 12); // repeats land 21 ms / 69 ms apart
    const hold_ = LANE_HOLD.moveChar!;
    for (const g of gaps(starts)) expect(g).toBeGreaterThanOrEqual(hold_ - 1e-9);
    expect(starts.length).toBeGreaterThan(30); // most repeats are still heard
  });

  it('a burst far faster than the sound is thinned to its length', () => {
    const gate = new SfxGate();
    const starts = hold(gate, 'moveChar', 5, 1000); // 200 triggers in a second
    const hold_ = LANE_HOLD.moveChar!;
    for (const g of gaps(starts)) expect(g).toBeGreaterThanOrEqual(hold_ - 1e-9);
    expect(starts.length).toBeLessThanOrEqual(Math.ceil(1 / hold_) + 1);
    expect(gate.activeVoices(1)).toBeLessThanOrEqual(3); // ≤ 60 ms of overlap at any instant
  });

  it('the small sounds share one lane', () => {
    const gate = new SfxGate();
    expect(gate.admit('moveLineEdge', 1)).toBe(1); // an 80 ms sweep …
    expect(gate.admit('moveChar', 1.03)).toBeNull(); // … is not talked over
    expect(gate.admit('moveChar', 1.07)).toBeCloseTo(1.08, 9); // nearly free: nudged to the slot
    expect(gate.admit('menuMove', 1.2)).toBe(1.2);
  });

  it('event sounds are not rate-limited against each other, only against themselves', () => {
    const gate = new SfxGate();
    expect(gate.admit('delChar', 1)).toBe(1);
    expect(gate.admit('comboUp', 1, 1.05)).toBe(1.05); // delayed cue keeps its time
    expect(gate.admit('delChar', 1.01)).toBeNull(); // the same sound 10 ms later
    expect(gate.admit('delChar', 1.1)).toBe(1.1);
    expect(gate.admit('mistake', 1.1)).toBe(1.1);
  });

  it('has a ceiling on live voices', () => {
    const gate = new SfxGate();
    gate.started(HARD_VOICE_CAP, 10);
    expect(gate.admit('stageClear', 1)).toBeNull();
    expect(gate.admit('moveChar', 1)).toBeNull();
    expect(gate.admit('stageClear', 10.01)).toBe(10.01); // they ended
  });
});

// ── action → sound ───────────────────────────────────────────────────────────
describe('cues', () => {
  it('caret moves by kind', () => {
    expect(moveCue('char-left').id).toBe('moveChar');
    expect(moveCue('word-right').id).toBe('moveWord');
    expect(moveCue('line-start')).toEqual({ id: 'moveLineEdge', params: { dir: -1 } });
    expect(moveCue('line-end')).toEqual({ id: 'moveLineEdge', params: { dir: 1 } });
    expect(moveCue('line-up')).toEqual({ id: 'moveLine', params: { dir: -1 } });
    expect(moveCue('line-down')).toEqual({ id: 'moveLine', params: { dir: 1 } });
    expect(moveCue('doc-end')).toEqual({ id: 'moveLineEdge', params: { dir: 1 } });
  });

  it('deletes by chord, sized by the characters removed', () => {
    const one = { rowsRemoved: 0, rowsTouched: 1 };
    expect(deleteCues({ chord: 'char', removed: 1, ...one })).toEqual([{ id: 'delChar' }]);
    expect(deleteCues({ chord: 'word', removed: 7, ...one })).toEqual([{ id: 'delWord', params: { size: 7 } }]);
    expect(deleteCues({ chord: 'line', removed: 30, ...one })).toEqual([{ id: 'delLine', params: { size: 30 } }]);
    expect(deleteCues({ chord: 'selection', removed: 12, ...one })).toEqual([{ id: 'delSelection', params: { size: 12 } }]);
  });

  it('several rows are the big chord; a row closing up is the collapse', () => {
    // a selection over three rows
    expect(deleteCues({ chord: 'selection', removed: 80, rowsRemoved: 2, rowsTouched: 3 })).toEqual([{ id: 'delBig', params: { size: 80 } }]);
    // a Visual Block: no row vanishes, but several lose characters
    expect(deleteCues({ chord: 'selection', removed: 9, rowsRemoved: 0, rowsTouched: 3 })).toEqual([{ id: 'delBig', params: { size: 9 } }]);
    // `dd`: one row deleted whole
    const dd = deleteCues({ chord: 'line', removed: 20, rowsRemoved: 1, rowsTouched: 1 });
    expect(dd.map((c) => c.id)).toEqual(['delLine', 'rowCollapse']);
    expect(dd[1].delay).toBeGreaterThan(0);
    // Backspace at column 0: two rows join, no character goes
    expect(deleteCues({ chord: 'char', removed: 0, rowsRemoved: 1, rowsTouched: 0 })).toEqual([{ id: 'rowCollapse' }]);
    // a delete that found nothing is silent
    expect(deleteCues({ chord: 'char', removed: 0, rowsRemoved: 0, rowsTouched: 0 })).toEqual([]);
  });

  it('low time: one warning per second over the last five, none at zero', () => {
    const ticks: number[] = [];
    let prev = secondsLeft(12_000);
    for (let ms = 12_000; ms >= 0; ms -= 16) {
      const left = secondsLeft(ms);
      if (lowTimeTick(prev, left)) ticks.push(left);
      prev = left;
    }
    expect(ticks).toEqual([5, 4, 3, 2, 1]);
    expect(lowTimeTick(secondsLeft(3000), secondsLeft(3000))).toBe(false); // a 3 s stage does not warn at its start
    expect(lowTimeTick(3, 2)).toBe(true);
  });
});

describe('vim cues', () => {
  const field = (): FieldState =>
    createField([
      line(text('red', 'alpha'), spaces(1), text('blue', 'beta'), spaces(1), text('red', 'gamma')),
      line(text('blue', 'delta'), spaces(1), text('red', 'eps')),
      line(text('red', 'zeta')),
    ]);

  /** Feed keys through the real engine; returns the cue of each key that did not delete. */
  function cues(keys: string[], f: FieldState = field(), vim = new Vim()): (Cue | null | 'delete')[] {
    const snap = (): VimSnapshot => {
      const st = vim.status();
      return { mode: st.mode, pending: st.pending, prompt: st.prompt, flash: st.flash ? st.flash.pattern : null, message: st.message, caret: { ...f.caret } };
    };
    return keys.map((key) => {
      const before = snap();
      const outcome = vim.key(f, key);
      return outcome.deleted ? 'delete' : vimCue(before, snap(), key);
    });
  }
  const ids = (keys: string[], f?: FieldState): (string | null)[] => cues(keys, f).map((c) => (c === 'delete' ? 'delete' : c ? c.id : null));

  it('moves sound by the distance they cover', () => {
    expect(cues(['l', 'w', '$', '0', 'j', 'k'])).toEqual([
      { id: 'moveChar' },
      { id: 'moveWord' },
      { id: 'moveLineEdge', params: { dir: 1 } },
      { id: 'moveLineEdge', params: { dir: -1 } },
      { id: 'moveLine', params: { dir: 1 } },
      { id: 'moveLine', params: { dir: -1 } },
    ]);
  });

  it('a mode change carries the mode', () => {
    expect(cues(['v', 'V', '<C-v>', '<Esc>'])).toEqual([
      { id: 'vimMode', params: { mode: 'visual' } },
      { id: 'vimMode', params: { mode: 'visual' } },
      { id: 'vimMode', params: { mode: 'visual' } },
      { id: 'vimMode', params: { mode: 'normal' } },
    ]);
  });

  it('moving in Visual extends the selection', () => {
    expect(ids(['v', 'l', 'j'])).toEqual(['vimMode', 'selExtend', 'selExtend']);
  });

  it('a half-typed command is pending until it lands', () => {
    expect(ids(['d', 'w'])).toEqual(['vimPending', 'delete']);
    expect(ids(['3', 'l'])).toEqual(['vimPending', 'moveWord']);
    expect(ids(['g', 'g'], Object.assign(field(), { caret: { line: 2, col: 0 } }))).toEqual(['vimPending', 'moveLine']);
    expect(ids(['f', 'a'])).toEqual(['vimPending', 'moveWord']);
    expect(ids(['d', 'i', 'w'])).toEqual(['vimPending', 'vimPending', 'delete']);
  });

  it('flash and search: typing is pending, a miss is invalid', () => {
    expect(ids(['s', 'e'])).toEqual(['vimPending', 'vimPending']); // flash start, then its text
    expect(ids(['s', 'Q'])).toEqual(['vimPending', 'vimInvalid']); // no match
    expect(ids(['/', 'x', 'q', '<CR>'])).toEqual(['vimPending', 'vimPending', 'vimPending', 'vimInvalid']); // pattern not found
    expect(ids(['/', 'e', 'p', 's', '<CR>'])).toEqual(['vimPending', 'vimPending', 'vimPending', 'vimPending', 'moveLine']);
  });

  it('keys that do nothing are invalid; Esc is quiet', () => {
    expect(ids(['h'])).toEqual(['vimInvalid']); // already at column 0
    expect(ids(['i'])).toEqual(['vimInvalid']); // no Insert mode
    expect(ids(['u'])).toEqual(['vimInvalid']); // no undo
    expect(ids(['<Esc>'])).toEqual([null]); // nothing to cancel
    expect(ids(['d', '<Esc>'])).toEqual(['vimPending', 'selClear']); // cancelled a command
  });

  it('row moves', () => {
    expect(ids(['<A-j>', '<A-k>', '<A-k>'])).toEqual(['rowMove', 'rowMove', 'vimInvalid']); // the last one is at the top
  });
});

// ── settings ─────────────────────────────────────────────────────────────────
describe('audio settings', () => {
  function memory(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
    const data = { ...initial };
    return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) };
  }

  it('defaults when nothing is stored, or storage is missing', () => {
    for (const s of [loadSettings(memory()), loadSettings(null)]) {
      expect(s).toEqual({
        muted: false,
        music: { volume: DEFAULT_VOLUME.music, muted: false },
        sfx: { volume: DEFAULT_VOLUME.sfx, muted: false },
      });
    }
  });

  it('round-trips through storage, one key per value', () => {
    const store = memory();
    saveSettings({ muted: true, music: { volume: 3, muted: true }, sfx: { volume: 10, muted: false } }, store);
    expect(store.data).toEqual({
      [STORAGE_KEYS.muted]: '1',
      [STORAGE_KEYS.musicVolume]: '3',
      [STORAGE_KEYS.musicMuted]: '1',
      [STORAGE_KEYS.sfxVolume]: '10',
      [STORAGE_KEYS.sfxMuted]: '0',
    });
    expect(loadSettings(store)).toEqual({ muted: true, music: { volume: 3, muted: true }, sfx: { volume: 10, muted: false } });
  });

  it('keeps the mute saved before the buses existed', () => {
    expect(STORAGE_KEYS.muted).toBe('redline.muted');
    expect(loadSettings(memory({ 'redline.muted': '1' })).muted).toBe(true);
  });

  it('survives junk and a throwing store', () => {
    const s = loadSettings(memory({ [STORAGE_KEYS.musicVolume]: 'loud', [STORAGE_KEYS.sfxVolume]: '99' }));
    expect(s.music.volume).toBe(DEFAULT_VOLUME.music);
    expect(s.sfx.volume).toBe(MAX_VOLUME);
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadSettings(broken).sfx.volume).toBe(DEFAULT_VOLUME.sfx);
    expect(() => saveSettings(loadSettings(null), broken)).not.toThrow();
  });

  it('bus gain: silent at zero or muted, the approved level at the reference step, rising monotonically', () => {
    expect(busGain('sfx', { volume: 7, muted: false })).toBeCloseTo(1, 9);
    expect(busGain('music', { volume: 8, muted: false })).toBeCloseTo(0.64, 9);
    for (const bus of ['music', 'sfx'] as const) {
      expect(busGain(bus, { volume: 0, muted: false })).toBe(0);
      expect(busGain(bus, { volume: 9, muted: true })).toBe(0);
      let prev = -1;
      for (let v = 0; v <= MAX_VOLUME; v++) {
        const g = busGain(bus, { volume: v, muted: false });
        expect(g).toBeGreaterThan(prev);
        expect(Number.isFinite(g)).toBe(true);
        prev = g;
      }
    }
  });

  it('labels the HUD and knows what is audible', () => {
    const s = loadSettings(null);
    expect(soundLabel(s)).toBe('♪ M6 S7');
    expect(soundLabel({ ...s, music: { volume: 0, muted: false } })).toBe('♪ M- S7');
    expect(soundLabel({ ...s, sfx: { volume: 7, muted: true } })).toBe('♪ M6 S-');
    expect(soundLabel({ ...s, muted: true })).toBe('✕ MUTED');
    expect(busAudible(s, 'music')).toBe(true);
    expect(busAudible({ ...s, muted: true }, 'music')).toBe(false);
    expect(busAudible({ ...s, music: { volume: 0, muted: false } }, 'music')).toBe(false);
    expect(busAudible({ ...s, music: { volume: 0, muted: false } }, 'sfx')).toBe(true);
  });
});
