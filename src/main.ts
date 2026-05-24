import './style.css';
import { Game } from './game.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('REDLINE: #game canvas not found');

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('REDLINE: 2D context unavailable');

// Logical render size; device-pixel-ratio scaling keeps strokes crisp.
const WIDTH = 800;
const HEIGHT = 600;

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

const game = new Game(ctx, WIDTH, HEIGHT);
game.start();
