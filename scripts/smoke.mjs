import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://localhost:5173';
const OUT = process.env.SMOKE_OUT ?? 'screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.game && window.game.player));
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/01-title.png` });

// Retro / Audio Options screen (verify Motion Blur slider)
await page.click('#btn-settings');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/05-settings.png` });
await page.click('#o-back');
await page.waitForTimeout(200);

// Garage screen
await page.click('#btn-garage');
await page.waitForTimeout(400);
await page.click('#g-next');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-garage.png` });

// Start free roam and drive forward with nitro + a drift turn
await page.click('#g-drive');
await page.keyboard.down('KeyW');
await page.waitForTimeout(2200);
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/03-driving.png` });
await page.keyboard.up('ShiftLeft');

// Trigger a ★3 police pursuit and bring cruisers into close formation
await page.evaluate(() => {
  const g = window.game;
  g.heat.forceStars(3);
  g.police.lastKnown = { x: g.player.x, z: g.player.z, vx: 0, vz: 20 };
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  const g = window.game;
  const p = g.player;
  const fx = p.fwdX, fz = p.fwdZ, rx = -fz, rz = fx;
  const offsets = [
    [fx * 11 - rx * 2.4, fz * 11 - rz * 2.4],
    [fx * 7 + rx * 2.6, fz * 7 + rz * 2.6],
  ];
  offsets.forEach(([ox, oz], i) => {
    const u = g.police.units[i];
    if (u) {
      u.car.teleport(p.x + ox, p.z + oz, p.yaw);
      u.car.setForwardSpeed(p.speed);
    }
  });
});
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/04-pursuit.png` });
await page.keyboard.up('KeyW');

const stats = await page.evaluate(() => {
  const g = window.game;
  return {
    state: g.state,
    speed: g.player.speed,
    z: g.player.z,
    traffic: g.traffic.units.length,
    cops: g.police.units.length,
    stars: g.heat.stars,
    fps: g.loop.fps,
  };
});
console.log('Smoke stats:', JSON.stringify(stats));
await browser.close();

if (errors.length) {
  console.error('Errors during smoke run:\n' + errors.join('\n'));
  process.exit(1);
}
if (stats.traffic < 5 || stats.cops < 3 || stats.stars !== 3) {
  console.error('Unexpected game state:', stats);
  process.exit(1);
}
