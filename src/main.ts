// VT323, the Phosphor theme's face, ships with the game: a third-party font host that
// stalls would block the first paint and leave the page blank (#27).
import '@fontsource/vt323/latin-400.css';
import './style.css';
import { Game } from './game.ts';
import { playfieldCols, playfieldRows } from './render.ts';
import { setMaxStageCols, setMaxStageRows } from './stages.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('REDLINE: #game canvas not found');

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('REDLINE: 2D context unavailable');

// Logical render size. The canvas is scaled to fit the window (never above 1:1) so
// the whole game is always on screen and the page never scrolls (#29); the backing
// store follows the scaled size × device-pixel-ratio so glyphs stay crisp.
// WIDTH × HEIGHT is the minimum frame. A window wider than its shape widens the
// frame — HUD, rules, footer, overlays — to fill it (#53); the board itself is
// always sized from WIDTH, so a stage has the same shape on every screen.
const WIDTH = 1500;
const HEIGHT = 1100;
const MIN_FIT = 0.3; // a tiny window still gets a drawable canvas

let frameWidth = WIDTH;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const fit = Math.max(MIN_FIT, Math.min(1, window.innerWidth / WIDTH, window.innerHeight / HEIGHT));
  frameWidth = Math.max(WIDTH, Math.floor(window.innerWidth / fit));
  const scale = fit * dpr;
  canvas!.width = Math.round(frameWidth * scale);
  canvas!.height = Math.round(HEIGHT * scale);
  canvas!.style.width = `${frameWidth * fit}px`;
  canvas!.style.height = `${HEIGHT * fit}px`;
  ctx!.setTransform(scale, 0, 0, scale, 0, 0);
  game.setWidth(frameWidth);
}

// Moving the window to a display with another pixel ratio fires no resize (#35).
// A resolution query matches only the current ratio, so re-arm it after each change.
function watchPixelRatio(): void {
  if (typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  mq.addEventListener?.(
    'change',
    () => {
      resize();
      watchPixelRatio();
    },
    { once: true },
  );
}

// Tell the stage generator how many blocks/rows fit — always at the minimum frame,
// never the window's, so boards don't depend on the screen.
setMaxStageCols(playfieldCols(WIDTH));
setMaxStageRows(playfieldRows(HEIGHT));

const game = new Game(ctx, WIDTH, HEIGHT);
resize();
window.addEventListener('resize', resize);
watchPixelRatio();
game.start();
