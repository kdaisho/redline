/**
 * Soundtrack page (#31): one visual theme per BGM track — a small palette and a
 * piece of cover art drawn as inline SVG from code (no image files), so each
 * track's view has its own colour and picture. The art takes its subject from
 * the track's name: a boot log, a diff, a flame graph, two racing threads, a
 * call stack running off the top, a tachometer in the red, a hex dump, a sunrise.
 */
import type { TrackId } from './audio/tracks.ts';

export interface TrackTheme {
  /** Main colour: buttons, progress, highlights. */
  accent: string;
  /** Second colour for the art and the live meter. */
  accent2: string;
  /** Cover background, and the tint washed over the top of the track view. */
  ink: string;
  /** Text drawn on top of `accent`. */
  onAccent: string;
}

export const THEMES: Record<TrackId, TrackTheme> = {
  'cold-boot': { accent: '#7fd6ff', accent2: '#c9f1ff', ink: '#0a2a44', onAccent: '#04121d' },
  'green-diff': { accent: '#3ddc84', accent2: '#ff6b57', ink: '#0b3a22', onAccent: '#03170c' },
  'hot-path': { accent: '#ff9a1f', accent2: '#ffd84a', ink: '#4a1f04', onAccent: '#1f0c00' },
  'race-condition': { accent: '#e36bff', accent2: '#3fe3ff', ink: '#33104a', onAccent: '#16041f' },
  'stack-overflow': { accent: '#9d8bff', accent2: '#ff66a8', ink: '#1f1560', onAccent: '#0b0626' },
  redline: { accent: '#ff4a3a', accent2: '#ffb000', ink: '#4d0906', onAccent: '#1c0201' },
  'core-dump': { accent: '#9fb7ba', accent2: '#e0736a', ink: '#22303a', onAccent: '#0a1013' },
  'ship-it': { accent: '#ffcf40', accent2: '#ff7ab8', ink: '#4a3206', onAccent: '#1d1300' },
};

/** Small deterministic generator so a cover looks the same on every load. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const n = (v: number): string => (+v.toFixed(2)).toString();
const rect = (x: number, y: number, w: number, h: number, fill: string, o = 1, extra = ''): string =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"${o < 1 ? ` opacity="${n(o)}"` : ''}${extra}/>`;

type Painter = (t: TrackTheme) => string;

const ART: Record<TrackId, Painter> = {
  // a boot log scrolling up, and the cursor waiting
  'cold-boot': (t) => {
    const r = seeded(11);
    let s = '';
    for (let i = 0; i < 9; i++) {
      const y = 34 + i * 13;
      const w = 30 + r() * 90;
      s += rect(22, y, 10, 5, t.accent, 0.25 + i * 0.05);
      s += rect(38, y, w, 5, t.accent, 0.12 + i * 0.07);
    }
    s += rect(22, 152, 16, 5, t.accent2);
    s +=
      `<rect x="44" y="148" width="12" height="14" fill="${t.accent2}">` +
      `<animate attributeName="opacity" values="1;1;0;0" dur="1.1s" repeatCount="indefinite"/></rect>`;
    return s;
  },

  // a diff: mostly additions, a few lines gone
  'green-diff': (t) => {
    const r = seeded(7);
    const minus = new Set([2, 6]);
    let s = '';
    for (let i = 0; i < 10; i++) {
      const y = 30 + i * 13.5;
      const del = minus.has(i);
      const c = del ? t.accent2 : t.accent;
      const w = 50 + r() * 96;
      s += rect(16, y - 3, 168, 11, c, del ? 0.16 : 0.1);
      s += del ? rect(22, y + 1.5, 8, 2.5, c) : rect(22, y + 1.5, 8, 2.5, c) + rect(24.75, y - 1.25, 2.5, 8, c);
      s += rect(38, y, w, 5, c, del ? 0.75 : 0.9);
    }
    return s;
  },

  // a flame graph: wide at the base, one hot tower
  'hot-path': (t) => {
    // [x, width] per row, bottom row first; the tower on the left is the hot path
    const rows: [number, number][][] = [
      [[14, 172]],
      [[14, 104], [122, 64]],
      [[14, 80], [98, 20], [122, 40], [166, 20]],
      [[14, 62], [80, 14], [122, 26]],
      [[14, 50], [68, 8], [122, 14]],
      [[18, 40]],
      [[18, 30]],
      [[22, 22]],
      [[22, 14]],
    ];
    let s = '';
    rows.forEach((spans, row) => {
      const heat = row / (rows.length - 1);
      spans.forEach(([x, w], k) => {
        const hot = k === 0;
        s += rect(x, 160 - row * 15, w - 2, 12, hot && heat > 0.45 ? t.accent2 : t.accent, hot ? 0.6 + heat * 0.4 : 0.38, ' rx="1.5"');
      });
    });
    return s;
  },

  // two threads crossing over the same ground
  'race-condition': (t) => {
    const path = (phase: number, amp: number): string => {
      let d = '';
      for (let x = 10; x <= 190; x += 4) {
        const y = 100 + Math.sin((x / 180) * Math.PI * 3 + phase) * amp;
        d += `${d ? 'L' : 'M'}${n(x)} ${n(y)}`;
      }
      return d;
    };
    let s = '';
    for (let i = 0; i < 9; i++) s += rect(10, 28 + i * 18, 180, 1, t.accent, 0.12);
    s += `<path d="${path(0, 44)}" fill="none" stroke="${t.accent}" stroke-width="5" stroke-linecap="round"/>`;
    s += `<path d="${path(Math.PI, 44)}" fill="none" stroke="${t.accent2}" stroke-width="5" stroke-linecap="round"/>`;
    for (const x of [10 + 60, 10 + 120]) {
      s += `<circle cx="${x}" cy="100" r="13" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.55"/>`;
      s += `<circle cx="${x}" cy="100" r="5" fill="#fff"/>`;
    }
    return s;
  },

  // call frames piled up until they leave the picture
  'stack-overflow': (t) => {
    let s = '';
    for (let i = 0; i < 11; i++) {
      const y = 174 - i * 14;
      const hot = i / 10;
      const x = 34 + Math.sin(i * 0.9) * 10 + i * 1.5;
      s += rect(x, y, 118, 11, hot > 0.6 ? t.accent2 : t.accent, 0.3 + hot * 0.7, ' rx="2"');
      s += rect(x + 6, y + 3.5, 26 + ((i * 37) % 40), 4, '#000', 0.35);
    }
    s += `<path d="M178 76 L178 38 M170 48 L178 38 L186 48" fill="none" stroke="${t.accent2}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    return s;
  },

  // a tachometer with the needle past the line
  redline: (t) => {
    const cx = 100;
    const cy = 122;
    const R = 78;
    const pt = (deg: number, r: number): [number, number] => [cx + Math.cos((deg * Math.PI) / 180) * r, cy + Math.sin((deg * Math.PI) / 180) * r];
    const arc = (a0: number, a1: number, r: number): string => {
      const [x0, y0] = pt(a0, r);
      const [x1, y1] = pt(a1, r);
      return `M${n(x0)} ${n(y0)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${n(x1)} ${n(y1)}`;
    };
    let s = `<path d="${arc(160, 318, R)}" fill="none" stroke="${t.accent2}" stroke-width="5" opacity="0.8"/>`;
    s += `<path d="${arc(318, 380, R)}" fill="none" stroke="${t.accent}" stroke-width="9"/>`;
    for (let i = 0; i <= 11; i++) {
      const a = 160 + i * 20;
      const [x0, y0] = pt(a, R - 8);
      const [x1, y1] = pt(a, R - (i % 2 ? 15 : 22));
      s += `<path d="M${n(x0)} ${n(y0)} L${n(x1)} ${n(y1)}" stroke="${a >= 318 ? t.accent : t.accent2}" stroke-width="3" opacity="${a >= 318 ? 1 : 0.7}"/>`;
    }
    const [nx, ny] = pt(352, R - 14);
    s += `<path d="M${cx} ${cy} L${n(nx)} ${n(ny)}" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="8" fill="#fff"/>`;
    return s;
  },

  // a hex dump with holes in it
  'core-dump': (t) => {
    const r = seeded(404);
    let s = '';
    for (let row = 0; row < 11; row++) {
      s += rect(16, 30 + row * 12.5, 16, 5, t.accent, 0.3);
      for (let col = 0; col < 12; col++) {
        const v = r();
        if (v < 0.14) continue;
        const bad = v > 0.93;
        s += rect(40 + col * 12 + (col >= 6 ? 6 : 0), 30 + row * 12.5, 9, 5, bad ? t.accent2 : t.accent, bad ? 1 : 0.2 + v * 0.6);
      }
    }
    return s;
  },

  // sunrise, and the way up
  'ship-it': (t) => {
    let s = '';
    for (let i = 0; i < 9; i++) {
      const a = (Math.PI * (i + 0.5)) / 9;
      const x0 = 100 - Math.cos(a) * 62;
      const y0 = 150 - Math.sin(a) * 62;
      const x1 = 100 - Math.cos(a) * 92;
      const y1 = 150 - Math.sin(a) * 92;
      s += `<path d="M${n(x0)} ${n(y0)} L${n(x1)} ${n(y1)}" stroke="${t.accent}" stroke-width="4" stroke-linecap="round" opacity="0.75"/>`;
    }
    s += `<path d="M48 150 A52 52 0 0 1 152 150 Z" fill="${t.accent}"/>`;
    s += `<path d="M48 150 A52 52 0 0 1 152 150 Z" fill="${t.accent2}" opacity="0.35"/>`;
    for (let i = 0; i < 4; i++) s += rect(20 + i * 6, 156 + i * 7, 160 - i * 12, 3, t.accent2, 0.9 - i * 0.2);
    s += `<path d="M100 132 L100 96 M88 108 L100 96 L112 108" fill="none" stroke="${t.onAccent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    return s;
  },
};

/** The cover for a track as an SVG string (square, scales to its box). */
export function coverSvg(id: TrackId, index: number): string {
  const t = THEMES[id];
  const g = `g-${id}`;
  const no = String(index + 1).padStart(2, '0');
  return (
    `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid slice">` +
    `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0.6" y2="1">` +
    `<stop offset="0" stop-color="${t.ink}"/><stop offset="1" stop-color="#050607"/></linearGradient></defs>` +
    `<rect width="200" height="200" fill="url(#${g})"/>` +
    ART[id](t) +
    `<text x="16" y="20" fill="${t.accent}" opacity="0.8" font-family="VT323, ui-monospace, monospace" font-size="13" letter-spacing="1.5">REDLINE OST</text>` +
    `<text x="184" y="20" text-anchor="end" fill="${t.accent}" opacity="0.8" font-family="VT323, ui-monospace, monospace" font-size="13" letter-spacing="1.5">${no}</text>` +
    `</svg>`
  );
}
