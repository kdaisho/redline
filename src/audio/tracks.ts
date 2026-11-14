/**
 * BGM track data (#12 → #14). Eight original tracks, written in the small
 * notation that `bgm.ts` compiles. The note data, patterns, voices and gains are
 * exactly the set approved on issue #12 — do not edit them by eye.
 *
 * Notation (one step = a 16th note, 16 steps per bar):
 *   lead   "e5:4 g5:2 r:2 ~:8 | ..."  note:steps, r = rest, ~ = tie. Bars split by |.
 *   prog   "Em C,D G/B"               one chord per bar; "C,D" = half a bar each; /X = bass note.
 *   bass   16 chars per bar: r root, R root+8va, 5 fifth, f fifth below, 7 seventh,
 *          3 chord third, l whole step below, - hold previous, . rest.
 *   arp    16 chars: digit n = n-th chord tone climbing from the root, - hold, . rest.
 *   chord  16 chars: x = strike the whole chord, - hold, . rest.
 *   drums  {k, s, h, p}: kick x · snare x / g (ghost) · hat x / o (open) · perc h m l (toms).
 * Sections pick a pattern per bar with one key letter per bar ("aaab aaaf"), "." = silent bar.
 */

export type TrackId =
  | 'cold-boot'
  | 'green-diff'
  | 'hot-path'
  | 'race-condition'
  | 'stack-overflow'
  | 'redline'
  | 'core-dump'
  | 'ship-it';

/** A pitched synth voice (lead, harmony, arpeggio, chord stabs). */
export interface ToneVoice {
  wave: 'pulse25' | 'pulse12' | 'saw2' | OscillatorType;
  level: number;
  a: number;
  dec: number;
  sus: number;
  rel: number;
  gate: number;
  vib: number;
  send: number;
  lp: number;
}

export interface BassVoice {
  type: 'fm' | 'saw';
  level: number;
  index: number;
  ratio: number;
  gate: number;
}

export interface DrumPattern {
  k: string;
  s: string;
  h: string;
  p?: string;
}

export interface Section {
  name: string;
  /** Start from another section's fields, then override. */
  like?: string;
  prog?: string;
  /** Truthy → a harmony line a diatonic third under the lead. */
  harm?: number;
  bass?: string;
  arp?: string;
  chord?: string;
  drums?: string;
  lead?: string;
  crash?: boolean;
}

export interface Track {
  id: TrackId;
  name: string;
  use: string;
  feel: string;
  bpm: number;
  key: string;
  scale: string;
  gain: number;
  leadTr?: number;
  bassLow?: number;
  arpLow?: number;
  chordLow?: number;
  voices: {
    lead?: Partial<ToneVoice>;
    harm?: Partial<ToneVoice>;
    arp?: Partial<ToneVoice>;
    chord?: Partial<ToneVoice>;
    bass?: Partial<BassVoice>;
  };
  form: string[];
  pats: {
    bass: Record<string, string>;
    arp: Record<string, string>;
    chord: Record<string, string>;
    drums: Record<string, DrumPattern>;
  };
  sections: Section[];
}

// prettier-ignore
export const TRACKS: readonly Track[] = [
  {
    id: 'cold-boot', name: 'Cold Boot', use: 'Title screen', feel: 'Pedal bass and a slow lead that keeps climbing without resolving. Waiting for the start key.',
    bpm: 138, key: 'B minor', scale: 'b c# d e f# g a', gain: 1.05,
    voices: { lead: { wave: 'square', level: 0.12, vib: 14 }, harm: { wave: 'square' }, bass: { type: 'saw', level: 0.26 }, chord: { level: 0.032 } },
    form: ['A', 'B'],
    pats: {
      bass: { a: 'r.r.r.r.r.r.r.r.', b: 'r.r.r.r.r.r.R.R.', c: 'r.rRr.rRr.rRr.rR', d: 'r.rRr.rRr.r.R.R.' },
      arp: { a: '0213021302130213', b: '0123210123210123' },
      chord: { a: 'x---------------', b: 'x..x..x...x..x..' },
      drums: {
        a: { k: 'x...x...x...x...', s: '................', h: '..x...x...x...x.' },
        f: { k: 'x...x...x...x...', s: '........x.x.xxxx', h: '..x...x.........' },
        b: { k: 'x.....x.x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.o.' },
        g: { k: 'x.....x.x.......', s: '....x.....xx....', h: 'x.x.x.x.........', p: '............hhml' }
      }
    },
    sections: [
      { name: 'A', prog: 'Bm Bm G/B G/B Em/B Em/B F#sus4 F#', bass: 'aaaaaabb', arp: 'aaaaaaaa', chord: 'aaaaaaaa', drums: 'aaaaaaaf',
        lead: 'b4:2 d5:2 f#5:8 e5:4 | d5:12 r:4 | b4:2 d5:2 g5:8 f#5:4 | d5:8 e5:4 d5:4 | b4:2 e5:2 g5:8 a5:4 | g5:6 f#5:2 e5:8 | f#5:6 e5:2 f#5:4 b5:4 | a#5:12 r:4' },
      { name: 'B', prog: 'G A Bm Bm G A F#sus4 F#', harm: 3, bass: 'cccccccd', arp: 'bbbbbbbb', chord: 'bbbbbbbb', drums: 'bbbbbbbg',
        lead: 'b5:4 a5:2 g5:2 d5:4 g5:4 | a5:4 g5:2 e5:2 c#5:4 e5:4 | f#5:6 d5:2 f#5:4 b5:4 | b5:2 a5:2 f#5:4 d5:8 | g5:4 b5:2 d6:2 b5:4 g5:4 | a5:4 c#6:2 e6:2 c#6:4 a5:4 | b5:6 c#6:2 b5:4 f#5:4 | a#5:4 c#6:4 f#6:8' }
    ]
  },
  {
    id: 'green-diff', name: 'Green Diff', use: 'Stages 1-10', feel: 'Bright and breezy. Bouncing octave bass, off-beat stabs, a sing-along pulse lead.',
    bpm: 150, key: 'E major', scale: 'e f# g# a b c# d#', gain: 1,
    voices: { lead: { wave: 'pulse25' }, harm: { wave: 'pulse12' }, bass: { type: 'fm', index: 3.4 } },
    form: ['A', 'A2', 'B'],
    pats: {
      bass: { a: 'r.rR.rR.r.rR.r5R', b: 'r.rR.rR.r.r.5.7.', c: 'rrRrrrRrrrRrr5R5' },
      arp: { a: '0.2.4.2.0.2.4.2.', b: '0243024302430243' },
      chord: { a: '..x...x...x...x.', b: 'x-----x-----x---' },
      drums: {
        a: { k: 'x.....x...x.x...', s: '....x.......x...', h: 'x.xxx.xxx.xxx.xx' },
        f: { k: 'x.....x...x.....', s: '....x.....x.x...', h: 'x.xxx.xxx.......', p: '.............hml' },
        b: { k: 'x..x..x...x..x..', s: '....x.......x...', h: 'x.x.x.x.x.x.x.o.' },
        g: { k: 'x..x..x...x.....', s: '....x...x.x.xxxx', h: 'x.x.x.x.........' }
      }
    },
    sections: [
      { name: 'A', prog: 'Emaj7 C#m7 Amaj7 B E C#m F#m B', bass: 'aaaaaaab', chord: 'aaaaaaaa', drums: 'aaaaaaaf',
        lead: 'g#5:3 b5:3 e5:2 g#5:4 f#5:2 e5:2 | e5:3 g#5:3 c#5:2 e5:8 | c#5:2 e5:2 a5:4 g#5:2 f#5:2 e5:4 | f#5:6 d#5:2 f#5:4 b5:4 | g#5:3 b5:3 e6:2 d#6:4 b5:4 | c#6:3 b5:3 g#5:2 e5:4 g#5:4 | a5:2 g#5:2 f#5:2 a5:2 c#6:4 b5:2 a5:2 | b5:8 r:2 f#5:2 b5:2 d#6:2' },
      { name: 'A2', like: 'A', harm: 3, arp: 'aaaaaaaa' },
      { name: 'B', prog: 'C D E E C D Bsus4 B', harm: 3, bass: 'cccccccb', arp: 'bbbbbbbb', chord: 'bbbbbbbb', drums: 'bbbbbbbg',
        lead: 'e6:4 c6:2 g5:2 c6:4 e6:4 | d6:4 a5:2 f#5:2 a5:4 d6:4 | e6:6 b5:2 g#5:4 b5:4 | e5:2 g#5:2 b5:2 e6:2 g#6:8 | g6:4 e6:2 c6:2 e6:4 g5:4 | f#6:4 d6:2 a5:2 d6:4 f#5:4 | e6:6 f#6:2 e6:4 b5:4 | d#6:4 f#6:4 b5:2 c#6:2 d#6:2 f#6:2' }
    ]
  },
  {
    id: 'hot-path', name: 'Hot Path', use: 'Stages 11-20', feel: 'Funkier. Syncopated slap bass with gaps in it, ghost snares, a brassy saw lead.',
    bpm: 156, key: 'A dorian', scale: 'a b c d e f# g', gain: 1.08,
    voices: { lead: { wave: 'sawtooth', level: 0.13, lp: 3600 }, harm: { wave: 'sawtooth', lp: 3200 }, bass: { type: 'fm', index: 4.2 }, chord: { wave: 'pulse25', level: 0.034 } },
    form: ['A', 'A2', 'B'],
    pats: {
      bass: { a: 'r..r.rR...r.R.7R', b: 'r.rR..r.R.r.5.7.', c: 'r.r.R.r.r.rR.r5.' },
      arp: { a: '..0...2...1...2.', b: '0123012301230123' },
      chord: { a: '...x..x......x..', b: 'x.....x..x......' },
      drums: {
        a: { k: 'x..x......x..x..', s: '....x..g....x...', h: 'xxx.xxx.xxx.xxo.' },
        f: { k: 'x..x......x.....', s: '....x..g..x.xx.x', h: 'xxx.xxx.x.......' },
        b: { k: 'x.x...x.x.x...x.', s: '....x.......x..g', h: 'x.xxx.xxx.xxx.xx' },
        g: { k: 'x.x...x.x.......', s: '....x.....x.x...', h: 'x.xxx.xxx.......', p: '...........h.mll' }
      }
    },
    sections: [
      { name: 'A', prog: 'Am7 Am7 D7 D7 Fmaj7 G Am7 E7', bass: 'aaaaaaab', arp: 'aaaaaaaa', chord: 'aaaaaaaa', drums: 'aaaaaaaf',
        lead: 'r:2 a4:2 c5:2 e5:2 g5:3 e5:3 d5:2 | e5:6 d5:2 c5:2 a4:2 c5:4 | r:2 a4:2 d5:2 f#5:2 a5:3 f#5:3 e5:2 | f#5:6 e5:2 d5:2 c5:2 d5:4 | r:2 c5:2 f5:2 a5:2 c6:3 a5:3 g5:2 | b5:4 g5:2 d5:2 g5:4 b5:4 | c6:3 b5:3 a5:2 g5:3 e5:3 g5:2 | g#5:8 b5:4 e6:4' },
      { name: 'A2', like: 'A', harm: 3 },
      { name: 'B', prog: 'Fmaj7 G Em7 Am7 Fmaj7 G Dm7 E7', harm: 3, bass: 'cccccccb', arp: 'bbbbbbbb', chord: 'bbbbbbbb', drums: 'bbbbbbbg',
        lead: 'a5:6 c6:2 a5:2 f5:2 a5:4 | b5:6 d6:2 b5:2 g5:2 b5:4 | g5:2 b5:2 e6:4 d6:2 b5:2 g5:4 | a5:2 c6:2 e6:4 c6:8 | f6:4 e6:2 c6:2 a5:4 c6:4 | g6:4 d6:2 b5:2 g5:4 b5:4 | a5:2 d6:2 f6:4 e6:2 d6:2 c6:4 | b5:4 g#5:4 b5:2 d6:2 e6:4' }
    ]
  },
  {
    id: 'race-condition', name: 'Race Condition', use: 'Stages 21-30', feel: 'Minor key, galloping bass, a thick detuned lead. The first one that feels like pressure.',
    bpm: 164, key: 'D minor', scale: 'd e f g a bb c', gain: 1, leadTr: -12,
    voices: { lead: { wave: 'saw2', level: 0.13, lp: 4200 }, harm: { wave: 'pulse25' }, bass: { type: 'saw', level: 0.27 }, arp: { wave: 'pulse25', level: 0.042 } },
    form: ['A', 'A2', 'B', 'B2'],
    pats: {
      bass: { a: 'r.rrr.rrr.rrr.rr', b: 'r.rrr.rrR.rr5.7.', c: 'rrRrrr5rrrRrrr5r', d: 'rrRrrr5rR.R.5.R.' },
      arp: { a: '0.1.2.1.0.1.2.1.', b: '0213021302130213' },
      chord: { a: 'x.....x.....x...', b: 'x---------------' },
      drums: {
        a: { k: 'x..x..x.x..x..x.', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
        f: { k: 'x..x..x.x.......', s: '....x.....xxxxxx', h: 'x.x.x.x.x.......' },
        b: { k: 'x.x...x.x.x...x.', s: '....x.......x...', h: 'xxxxxxxxxxxxxxxo' },
        g: { k: 'x.x...x.........', s: '....x...xx......', h: 'xxxxxxxx........', p: '..........hhmmll' }
      }
    },
    sections: [
      { name: 'A', prog: 'Dm Bb Gm A Dm Bb C Dm', bass: 'aaaaaaab', chord: 'aaaaaaaa', drums: 'aaaaaaaf',
        lead: 'd5:2 f5:2 a5:2 d6:6 c6:2 a5:2 | bb5:4 a5:2 f5:2 d5:4 f5:4 | g5:2 bb5:2 d6:2 g6:6 f6:2 d6:2 | e6:4 c#6:2 a5:2 c#6:4 e6:4 | f6:3 e6:3 d6:2 a5:4 d6:4 | d6:3 c6:3 bb5:2 f5:4 bb5:4 | c6:2 e6:2 g6:4 e6:2 c6:2 e6:4 | d6:10 r:2 a5:2 d6:2' },
      { name: 'A2', like: 'A', harm: 3, arp: 'aaaaaaaa' },
      { name: 'B', prog: 'F C Gm Dm Bb C Asus4 A', bass: 'cccccccd', arp: 'bbbbbbbb', chord: 'bbbbbbbb', drums: 'bbbbbbbg',
        lead: 'a5:4 c6:4 f6:6 e6:2 | e6:4 c6:4 g5:6 c6:2 | bb5:4 d6:4 g6:6 f6:2 | f6:4 d6:4 a5:8 | bb5:2 d6:2 f6:2 bb5:2 d6:2 f6:2 d6:2 f6:2 | c6:2 e6:2 g6:2 c6:2 e6:2 g6:2 e6:2 g6:2 | a6:6 g6:2 e6:4 d6:4 | c#6:6 e6:2 a6:8' },
      { name: 'B2', like: 'B', harm: 3 }
    ]
  },
  {
    id: 'stack-overflow', name: 'Stack Overflow', use: 'Stages 31-40', feel: 'Twin leads in thirds over a three-against-four arpeggio. Fast runs, double kicks.',
    bpm: 172, key: 'F# minor', scale: 'f# g# a b c# d e', gain: 0.9, leadTr: -12,
    voices: { lead: { wave: 'pulse25', level: 0.14 }, harm: { wave: 'pulse25', level: 0.1 }, bass: { type: 'fm', index: 3.6, ratio: 2, level: 0.28 }, arp: { wave: 'pulse12', level: 0.046 } },
    form: ['A', 'A2', 'B', 'B2'],
    pats: {
      bass: { a: 'r.RrR.r.RrR.r.5R', b: 'r.RrR.r.R.R.5.7.', c: 'rrrRrrrRrrrR5557', d: 'rrrRrrrRR.R.5.5.' },
      arp: { a: '0240240240240241', b: '4202420242024202' },
      chord: { a: 'x.....x...x.....', b: 'x--x--x--x--x-x-' },
      drums: {
        a: { k: 'x.x...x.x.x...x.', s: '....x.......x...', h: 'xxxxxxxxxxxxxxxx' },
        f: { k: 'x.x...x.xx......', s: '....x.....x.xxxx', h: 'xxxxxxxxxx......' },
        b: { k: 'x..xx.x.x..xx.x.', s: '....x.......x..x', h: 'xxxxxxxoxxxxxxxo' },
        g: { k: 'x..xx.x.........', s: '....x...x.xx....', h: 'xxxxxxxx........', p: '............hmll' }
      }
    },
    sections: [
      { name: 'A', prog: 'F#m D E C#m F#m D E C#7', bass: 'aaaaaaab', arp: 'aaaaaaaa', chord: 'aaaaaaaa', drums: 'aaaaaaaf',
        lead: 'c#6:2 f#5:1 a5:1 c#6:2 b5:2 a5:2 f#5:2 a5:4 | a5:2 d5:1 f#5:1 a5:2 b5:2 a5:2 f#5:2 d6:4 | b5:2 e5:1 g#5:1 b5:2 c#6:2 b5:2 g#5:2 e6:4 | e6:4 c#6:2 g#5:2 c#6:8 | f#6:2 c#6:1 e6:1 f#6:2 e6:2 c#6:2 a5:2 c#6:4 | d6:2 a5:1 c#6:1 d6:2 e6:2 d6:2 a5:2 f#6:4 | e6:2 b5:2 g#5:2 b5:2 e6:2 g#6:2 e6:4 | e#6:6 g#6:2 c#6:4 e#5:4' },
      { name: 'A2', like: 'A', harm: 3 },
      { name: 'B', prog: 'D E F#m A D E C#sus4 C#', harm: 3, bass: 'cccccccd', arp: 'bbbbbbbb', chord: 'bbbbbbbb', drums: 'bbbbbbbg',
        lead: 'f#6:6 e6:2 d6:4 a5:4 | g#6:6 f#6:2 e6:4 b5:4 | a6:4 f#6:2 c#6:2 f#6:4 a6:4 | e6:2 a5:2 c#6:2 e6:2 a6:8 | f#6:3 e6:3 d6:2 f#6:3 e6:3 d6:2 | g#6:3 f#6:3 e6:2 g#6:3 f#6:3 e6:2 | f#6:4 g#6:4 c#6:4 f#6:4 | e#6:2 c#6:2 g#5:2 c#6:2 e#6:4 g#6:4' },
      { name: 'B2', like: 'B' }
    ]
  },
  {
    id: 'redline', name: 'Redline', use: 'Stages 41-50', feel: 'The fastest and darkest. Relentless 16th bass, a stabbing two-note hook, a half-step chord that keeps leaning on you.',
    bpm: 180, key: 'C minor', scale: 'c d eb f g ab bb', gain: 1, leadTr: -12,
    voices: { lead: { wave: 'saw2', level: 0.135, lp: 4800 }, harm: { wave: 'square', level: 0.075 }, bass: { type: 'saw', level: 0.26 }, arp: { wave: 'pulse12', level: 0.044 }, chord: { wave: 'pulse25', level: 0.034 } },
    form: ['A', 'A2', 'B', 'B2'],
    pats: {
      bass: { a: 'rrrrrrRrrrrrrR5R', b: 'rrrrrrRrR.R.5.7.', c: 'rRrRrRrRrRrR5R7R', d: 'rRrRrRrRr.r.r.r.' },
      arp: { a: '0123210123210123', b: '3210321032103210' },
      chord: { a: 'x..x..x..x..x.x.', b: 'x.....x.....x.x.' },
      drums: {
        a: { k: 'x..x.x..x..x.x..', s: '....x.......x...', h: 'xxxxxxxxxxxxxxxo' },
        f: { k: 'x..x.x..x.......', s: '....x...x.x.xxxx', h: 'xxxxxxxx........' },
        b: { k: 'x.xx..x.x.xx..x.', s: '....x..x....x..x', h: 'xxxoxxxoxxxoxxxo' },
        g: { k: 'x.xx..x.x.......', s: '....x..x..xx....', h: 'xxxoxxxo........', p: '............hmll' }
      }
    },
    sections: [
      { name: 'A', prog: 'Cm Db Cm Bb Cm Db Eb G7', bass: 'aaaaaaab', chord: 'bbbbbbbb', drums: 'aaaaaaaf',
        lead: 'c6:1 r:1 c6:1 eb6:1 g6:2 f6:1 eb6:1 d6:2 c6:2 g5:2 c6:2 | db6:1 r:1 db6:1 f6:1 ab6:2 f6:1 db6:1 ab5:2 db6:2 f6:4 | g6:3 eb6:3 c6:2 eb6:3 g6:3 c6:2 | f6:3 d6:3 bb5:2 d6:4 f6:4 | c6:1 r:1 c6:1 eb6:1 g6:2 f6:1 eb6:1 d6:2 c6:2 g5:2 c6:2 | db6:1 r:1 db6:1 f6:1 ab6:2 f6:1 db6:1 f6:2 ab6:6 | g6:2 bb6:2 g6:2 eb6:2 bb5:2 eb6:2 g6:4 | f6:2 d6:2 b5:2 g5:2 b5:2 d6:2 f6:2 g6:2' },
      { name: 'A2', like: 'A', harm: 3, arp: 'aaaaaaaa', chord: 'aaaaaaaa' },
      { name: 'B', prog: 'Fm G Ab Bb Fm G Ab,Bb G', bass: 'cccccccd', arp: 'bbbbbbbb', chord: 'aaaaaaaa', drums: 'bbbbbbbg',
        lead: 'ab6:6 g6:2 f6:4 c6:4 | g6:6 f6:2 d6:4 b5:4 | c6:2 eb6:2 ab6:4 g6:2 eb6:2 c6:4 | d6:2 f6:2 bb6:4 ab6:2 f6:2 d6:4 | ab6:2 f6:2 c6:2 f6:2 ab6:2 f6:2 c6:2 ab5:2 | g6:2 d6:2 b5:2 d6:2 g6:2 d6:2 b5:2 g5:2 | ab5:2 c6:2 eb6:2 ab6:2 bb5:2 d6:2 f6:2 bb6:2 | b5:2 d6:2 g6:4 r:2 g6:2 g6:2 g6:2' },
      { name: 'B2', like: 'B', harm: 3 }
    ]
  },
  {
    id: 'core-dump', name: 'Core Dump', use: 'Game over', feel: 'Half the speed. A laid-back dorian groove with a shrug of a melody. Try again, no drama.',
    bpm: 108, key: 'E dorian', scale: 'e f# g a b c# d', gain: 1.18,
    voices: { lead: { wave: 'square', level: 0.12, vib: 13, send: 0.4 }, bass: { type: 'fm', index: 1.8, level: 0.32 }, arp: { wave: 'triangle', level: 0.07, send: 0.45 }, chord: { level: 0.036, lp: 1800 } },
    form: ['A'],
    pats: {
      bass: { a: 'r.....r..r5...7.', b: 'r.....r..rR.5.7.', c: 'r.....r...r.....' },
      arp: { a: '0.2.3.2.1.2.3.2.' },
      chord: { a: 'x---------------' },
      drums: {
        a: { k: 'x.....x...x.....', s: '....x..g....x...', h: 'x.x.x.x.x.x.x.o.' },
        b: { k: 'x.....x...x..x..', s: '....x..g....x.g.', h: 'x.x.x.x.x.x.x.o.' },
        f: { k: 'x.....x...x.....', s: '....x.......x.xx', h: 'x.x.x.x.x.x.....' }
      }
    },
    sections: [
      { name: 'A', prog: 'Em7 A7 Em7 A7 Cmaj7 Bm7 Em7 Em7', bass: 'abababac', arp: 'aaaaaaaa', chord: 'aaaaaaaa', drums: 'abababaf',
        lead: 'r:4 b4:2 d5:2 e5:3 g5:3 e5:2 | c#5:6 b4:2 a4:4 r:4 | r:4 b4:2 d5:2 e5:3 g5:3 a5:2 | g5:6 e5:2 c#5:4 r:4 | e5:3 g5:3 b5:2 g5:4 e5:4 | d5:3 f#5:3 a5:2 f#5:4 d5:4 | e5:2 g5:2 b5:4 a5:2 g5:2 e5:4 | e5:8 r:8' }
    ]
  },
  {
    id: 'ship-it', name: 'Ship It', use: 'Win (all 50 stages cleared)', feel: 'Major key victory lap. Rising three-bar sequences, a four-on-the-floor chorus, and a borrowed-chord climb home.',
    bpm: 160, key: 'G major', scale: 'g a b c d e f#', gain: 1,
    voices: { lead: { wave: 'pulse25', level: 0.14 }, harm: { wave: 'sawtooth', level: 0.07, lp: 3400 }, bass: { type: 'fm', index: 3 }, arp: { wave: 'pulse12' } },
    form: ['A', 'A2', 'B'],
    pats: {
      bass: { a: 'r.r.RrR.r.r.RrR5', b: 'r.r.RrR.R.R.5.5.', c: 'r.RRr.RRr.RRr.R5' },
      arp: { a: '0241024102410241', b: '0.2.4.2.0.2.4.2.' },
      chord: { a: 'x..x..x.x..x..x.', b: 'x-----x---x-----' },
      drums: {
        a: { k: 'x.....x.x.....x.', s: '....x.......x...', h: 'x.xxx.xxx.xxx.xx' },
        f: { k: 'x.....x.x.......', s: '....x.....x.xx..', h: 'x.xxx.xxx.......', p: '..............ml' },
        b: { k: 'x...x...x...x...', s: '....x.......x...', h: 'x.o.x.o.x.o.x.o.' },
        g: { k: 'x...x...x...x...', s: '....x...x.x.xxxx', h: 'x.o.x.o.........' }
      }
    },
    sections: [
      { name: 'A', prog: 'G D/F# Em C G D/F# C D', bass: 'aaaaaaab', arp: 'bbbbbbbb', chord: 'aaaaaaaa', drums: 'aaaaaaaf',
        lead: 'd5:2 g5:2 b5:4 a5:2 g5:2 d6:4 | a5:2 d6:2 f#6:4 e6:2 d6:2 a5:4 | g5:2 b5:2 e6:4 d6:2 b5:2 g5:4 | e6:3 d6:3 c6:2 g5:8 | d5:2 g5:2 b5:4 a5:2 g5:2 d6:4 | a5:2 d6:2 f#6:4 g6:2 f#6:2 d6:4 | e6:3 g6:3 e6:2 c6:3 e6:3 g6:2 | f#6:6 e6:2 d6:8' },
      { name: 'A2', like: 'A', harm: 3, arp: 'aaaaaaaa' },
      { name: 'B', prog: 'C D Bm Em C D Eb,F G', harm: 3, bass: 'cccccccb', arp: 'aaaaaaaa', chord: 'bbbbbbbb', drums: 'bbbbbbbg',
        lead: 'g6:4 e6:4 c6:4 e6:4 | f#6:4 d6:4 a5:4 d6:4 | d6:2 b5:2 f#5:2 b5:2 d6:2 f#6:2 d6:4 | e6:2 b5:2 g5:2 b5:2 e6:2 g6:2 e6:4 | g6:4 e6:4 c6:2 e6:2 g6:4 | a6:4 f#6:4 d6:2 f#6:2 a6:4 | g6:2 eb6:2 bb5:2 eb6:2 a6:2 f6:2 c6:2 f6:2 | g6:6 d6:2 b5:2 d6:2 g6:4' }
    ]
  }
];

export function trackById(id: TrackId): Track {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown track ${id}`);
  return t;
}
