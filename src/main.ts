import './style.css';
import { Game } from './game.ts';
import { playfieldCols, playfieldRows } from './render.ts';
import { setMaxStageCols, setMaxStageRows } from './stages.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('REDLINE: #game canvas not found');

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('REDLINE: 2D context unavailable');

// Logical render size; device-pixel-ratio scaling keeps strokes crisp.
// Sane field size; the page scrolls if it overflows the viewport (KDA-59).
const WIDTH = 1500;
const HEIGHT = 1100;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas!.width = WIDTH * dpr;
  canvas!.height = HEIGHT * dpr;
  canvas!.style.width = `${WIDTH}px`;
  canvas!.style.height = `${HEIGHT}px`;
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', resize);

// Tell the stage generator how many blocks/rows fit at this canvas size.
setMaxStageCols(playfieldCols(WIDTH));
setMaxStageRows(playfieldRows(HEIGHT));

const game = new Game(ctx, WIDTH, HEIGHT);
game.start();
