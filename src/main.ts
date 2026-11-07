import './ui/styles.css';
import { initPhysics } from './physics/PhysicsWorld';
import { Game } from './core/Game';

async function boot() {
  await initPhysics();
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const ui = document.getElementById('ui-root') as HTMLElement;
  const game = new Game(canvas, ui);
  (window as unknown as { game: Game }).game = game;
}

boot();
