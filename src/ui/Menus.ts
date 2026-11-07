import { PLAYER_CARS, type PlayerCarDef } from '../vehicles/carSpecs';
import type { SaveData } from '../gameplay/Save';

export interface MenuCallbacks {
  onStartDrive: () => void;
  onOpenGarage: () => void;
  onSelectCar: (id: string, colorIdx: number) => void;
  onBuyCar: (def: PlayerCarDef) => boolean;
  onResume: () => void;
  onSettingsChanged: () => void;
  onSplashContinue: () => void;
  onToggleTimeOfDay?: () => void;
  onPreviewSound?: (kind: 'master' | 'soundtrack' | 'vehicle' | 'sfx') => void;
}

const starsBar = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
const hexCss = (n: number) => '#' + n.toString(16).padStart(6, '0');

/**
 * Full-screen PS2-style menu overlays:
 * Title screen, Garage (car/paint picker + buy + Day/Night switch), Pause + Retro/Audio settings, and Busted/Escaped/Wrecked splash.
 */
export class Menus {
  readonly root: HTMLElement;
  private garageIdx = 0;

  constructor(
    container: HTMLElement,
    private save: SaveData,
    private cb: MenuCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'menus';
    container.appendChild(this.root);
    this.garageIdx = Math.max(0, PLAYER_CARS.findIndex((c) => c.spec.id === save.carId));
  }

  hide() {
    this.root.innerHTML = '';
    this.root.style.pointerEvents = 'none';
  }

  showTitle() {
    this.root.style.pointerEvents = 'auto';
    const isDay = this.save.timeOfDay === 'day';
    const modeLabel = isDay ? '☀ MODE: DAY (OFFICIAL RACES)' : '☾ MODE: NIGHT (OUTLAW HEAT)';
    this.root.innerHTML = `
      <div class="menu-screen title-screen">
        <div class="ps2-badge">PLAYSTATION 2 ARCADE EDITION · 1.5×1.5 KM PALM DISTRICT</div>
        <h1 class="game-logo">NEON<span>DISTRICT</span></h1>
        <div class="subtitle">${isDay ? 'SPEEDHUNTER SHOWDOWN · OFFICIAL RACES' : 'MOST WANTED · STREET PURSUIT'}</div>
        <div class="menu-buttons">
          <button id="btn-drive" class="btn primary">${isDay ? 'ENTER DAY SHOWDOWN' : 'HIT THE NIGHT STREETS'}</button>
          <button id="btn-mode" class="btn">${modeLabel}</button>
          <button id="btn-garage" class="btn">GARAGE &amp; CARS</button>
          <button id="btn-settings" class="btn">RETRO / AUDIO OPTIONS</button>
        </div>
        <div class="title-stats">BANK: $${this.save.cash.toLocaleString()} · CARS UNLOCKED: ${this.save.unlocked.length}/${PLAYER_CARS.length}</div>
        <div class="press-start">PRESS [ENTER] OR CLICK TO START</div>
      </div>
    `;
    this.root.querySelector('#btn-drive')!.addEventListener('click', () => this.cb.onStartDrive());
    this.root.querySelector('#btn-mode')!.addEventListener('click', () => {
      this.cb.onToggleTimeOfDay?.();
      this.showTitle();
    });
    this.root.querySelector('#btn-garage')!.addEventListener('click', () => this.cb.onOpenGarage());
    this.root.querySelector('#btn-settings')!.addEventListener('click', () => this.showSettings(() => this.showTitle()));
  }

  showGarage() {
    this.root.style.pointerEvents = 'auto';
    const def = PLAYER_CARS[this.garageIdx];
    const owned = this.save.unlocked.includes(def.spec.id);
    const selected = this.save.carId === def.spec.id;
    const isDay = this.save.timeOfDay === 'day';
    const swatches = def.colors
      .map(
        (c, i) =>
          `<button class="swatch ${i === this.save.colorIdx ? 'sel' : ''}" data-i="${i}" style="background:${hexCss(c)}" aria-label="Paint ${i + 1}"></button>`,
      )
      .join('');

    this.root.innerHTML = `
      <div class="menu-screen garage-screen">
        <div class="garage-header">
          <h2>SPEEDHUNTER GARAGE</h2>
          <div class="bank">BANK: $${this.save.cash.toLocaleString()}</div>
        </div>
        <div class="garage-card">
          <div class="car-picker">
            <button id="g-prev" class="btn small">◀</button>
            <div class="car-title">${def.spec.name} <span class="tag">${owned ? (selected ? 'EQUIPPED' : 'OWNED') : '$' + def.price}</span></div>
            <button id="g-next" class="btn small">▶</button>
          </div>
          <p class="car-blurb">${def.blurb}</p>
          <div class="stat-grid">
            <div>TOP SPEED</div><div class="st">${starsBar(def.stars.speed)}</div>
            <div>ACCEL</div><div class="st">${starsBar(def.stars.accel)}</div>
            <div>HANDLING</div><div class="st">${starsBar(def.stars.handling)}</div>
            <div>HEFT / RAM</div><div class="st">${starsBar(def.stars.weight)}</div>
          </div>
          <div class="swatch-row"><span>PAINT:</span>${swatches}</div>
          <div class="menu-buttons horiz">
            ${
              owned
                ? `<button id="g-drive" class="btn primary">DRIVE (${isDay ? 'DAY' : 'NIGHT'})</button>`
                : `<button id="g-buy" class="btn primary" ${this.save.cash < def.price ? 'disabled' : ''}>BUY FOR $${def.price.toLocaleString()}</button>`
            }
            <button id="g-mode" class="btn small">${isDay ? '☀ DAY' : '☾ NIGHT'}</button>
            <button id="g-back" class="btn">BACK</button>
          </div>
        </div>
      </div>
    `;
    const preview = (cIdx: number) => this.cb.onSelectCar(def.spec.id, cIdx);
    preview(Math.min(this.save.colorIdx, def.colors.length - 1));

    this.root.querySelector('#g-prev')!.addEventListener('click', () => {
      this.garageIdx = (this.garageIdx - 1 + PLAYER_CARS.length) % PLAYER_CARS.length;
      this.save.colorIdx = 0;
      this.showGarage();
    });
    this.root.querySelector('#g-next')!.addEventListener('click', () => {
      this.garageIdx = (this.garageIdx + 1) % PLAYER_CARS.length;
      this.save.colorIdx = 0;
      this.showGarage();
    });
    this.root.querySelectorAll('.swatch').forEach((el) =>
      el.addEventListener('click', () => {
        this.save.colorIdx = Number((el as HTMLElement).dataset.i);
        this.showGarage();
      }),
    );
    this.root.querySelector('#g-drive')?.addEventListener('click', () => {
      this.save.carId = def.spec.id;
      this.cb.onStartDrive();
    });
    this.root.querySelector('#g-buy')?.addEventListener('click', () => {
      if (this.cb.onBuyCar(def)) this.showGarage();
    });
    this.root.querySelector('#g-mode')!.addEventListener('click', () => {
      this.cb.onToggleTimeOfDay?.();
      this.showGarage();
    });
    this.root.querySelector('#g-back')!.addEventListener('click', () => {
      if (!this.save.unlocked.includes(def.spec.id)) this.cb.onSelectCar(this.save.carId, this.save.colorIdx);
      this.showTitle();
    });
  }

  showPause() {
    this.root.style.pointerEvents = 'auto';
    const isDay = this.save.timeOfDay === 'day';
    this.root.innerHTML = `
      <div class="menu-screen pause-screen">
        <h2>PAUSED</h2>
        <div class="menu-buttons">
          <button id="p-resume" class="btn primary">RESUME</button>
          <button id="p-mode" class="btn">SWITCH TO ${isDay ? '☾ NIGHT (OUTLAW HEAT)' : '☀ DAY (OFFICIAL RACES)'}</button>
          <button id="p-garage" class="btn">CHANGE CAR (GARAGE)</button>
          <button id="p-settings" class="btn">RETRO / AUDIO OPTIONS</button>
          <button id="p-title" class="btn">QUIT TO TITLE</button>
        </div>
      </div>
    `;
    this.root.querySelector('#p-resume')!.addEventListener('click', () => this.cb.onResume());
    this.root.querySelector('#p-mode')!.addEventListener('click', () => {
      this.cb.onToggleTimeOfDay?.();
      this.showPause();
    });
    this.root.querySelector('#p-garage')!.addEventListener('click', () => this.cb.onOpenGarage());
    this.root.querySelector('#p-settings')!.addEventListener('click', () => this.showSettings(() => this.showPause()));
    this.root.querySelector('#p-title')!.addEventListener('click', () => this.showTitle());
  }

  showSettings(onBack: () => void) {
    this.root.style.pointerEvents = 'auto';
    const r = this.save.retro;
    const blurPct = Math.round((r.motionBlur ?? 1) * 100);
    const masterPct = Math.round((this.save.masterVolume ?? 0.85) * 100);
    const musicPct = Math.round((this.save.musicVolume ?? 0.70) * 100);
    const vehPct = Math.round((this.save.vehicleVolume ?? 0.85) * 100);
    const sfxPct = Math.round((this.save.sfxVolume ?? 0.85) * 100);

    this.root.innerHTML = `
      <div class="menu-screen pause-screen">
        <h2>OPTIONS &amp; AUDIO</h2>
        <div class="opt-list">
          <div class="opt-group-header">AUDIO SETTINGS</div>
          <label><span>MASTER VOLUME (<span id="o-vol-master-val">${masterPct === 0 ? 'MUTED' : masterPct + '%'}</span>)</span>
            <input type="range" id="o-vol-master" min="0" max="100" step="5" value="${masterPct}"/>
          </label>
          <label><span>SOUNDTRACK / MUSIC (<span id="o-vol-mus-val">${musicPct === 0 ? 'MUTED' : musicPct + '%'}</span>)</span>
            <input type="range" id="o-vol-mus" min="0" max="100" step="5" value="${musicPct}"/>
          </label>
          <label><span>VEHICLE SOUNDS (<span id="o-vol-veh-val">${vehPct === 0 ? 'MUTED' : vehPct + '%'}</span>)</span>
            <input type="range" id="o-vol-veh" min="0" max="100" step="5" value="${vehPct}"/>
          </label>
          <label><span>SFX &amp; SIRENS (<span id="o-vol-sfx-val">${sfxPct === 0 ? 'MUTED' : sfxPct + '%'}</span>)</span>
            <input type="range" id="o-vol-sfx" min="0" max="100" step="5" value="${sfxPct}"/>
          </label>

          <div class="opt-group-header">GRAPHICS &amp; RETRO</div>
          <label>INTERNAL RESOLUTION
            <select id="o-res">
              <option value="240" ${r.resHeight === 240 ? 'selected' : ''}>320×240 (PS1 / Ultra Crunchy)</option>
              <option value="448" ${r.resHeight === 448 ? 'selected' : ''}>640×448 (PS2 NTSC Default)</option>
              <option value="720" ${r.resHeight === 720 ? 'selected' : ''}>1280×720 (HD Remaster)</option>
            </select>
          </label>
          <label><span>MOTION BLUR (<span id="o-blur-val">${blurPct}%</span>)</span>
            <input type="range" id="o-blur" min="0" max="200" step="10" value="${blurPct}"/>
          </label>
          <label><input type="checkbox" id="o-dither" ${r.dither ? 'checked' : ''}/> ORDERED BAYER DITHER + 15-BIT COLOUR</label>
          <label><input type="checkbox" id="o-bloom" ${r.bloom ? 'checked' : ''}/> NEON BLOOM GLOW</label>
          <label><input type="checkbox" id="o-scan" ${r.scanlines ? 'checked' : ''}/> CRT SCANLINES &amp; VIGNETTE</label>
          <label><input type="checkbox" id="o-ps1" ${r.ps1 ? 'checked' : ''}/> PS1 VERTEX WOBBLE (BONUS)</label>

          <div class="opt-group-header">GAMEPLAY</div>
          <label>TIME OF DAY
            <select id="o-tod">
              <option value="day" ${this.save.timeOfDay === 'day' ? 'selected' : ''}>☀ DAY (Speedhunter Official Races)</option>
              <option value="night" ${this.save.timeOfDay === 'night' ? 'selected' : ''}>☾ NIGHT (Outlaw Police Pursuits)</option>
            </select>
          </label>
          <label>TRAFFIC DENSITY <input type="range" id="o-traf" min="10" max="55" value="${this.save.trafficDensity}"/></label>
        </div>
        <div class="menu-buttons"><button id="o-back" class="btn primary">APPLY &amp; BACK</button></div>
      </div>
    `;

    const masterValEl = this.root.querySelector('#o-vol-master-val') as HTMLElement;
    const musValEl = this.root.querySelector('#o-vol-mus-val') as HTMLElement;
    const vehValEl = this.root.querySelector('#o-vol-veh-val') as HTMLElement;
    const sfxValEl = this.root.querySelector('#o-vol-sfx-val') as HTMLElement;
    const blurValEl = this.root.querySelector('#o-blur-val') as HTMLElement;

    const apply = () => {
      const mVal = Number((this.root.querySelector('#o-vol-master') as HTMLInputElement).value);
      const musVal = Number((this.root.querySelector('#o-vol-mus') as HTMLInputElement).value);
      const vehVal = Number((this.root.querySelector('#o-vol-veh') as HTMLInputElement).value);
      const sfxVal = Number((this.root.querySelector('#o-vol-sfx') as HTMLInputElement).value);

      this.save.masterVolume = mVal / 100;
      this.save.musicVolume = musVal / 100;
      this.save.vehicleVolume = vehVal / 100;
      this.save.sfxVolume = sfxVal / 100;
      this.save.music = musVal > 0;
      this.save.sfx = sfxVal > 0 || vehVal > 0;

      if (masterValEl) masterValEl.textContent = mVal === 0 ? 'MUTED' : `${mVal}%`;
      if (musValEl) musValEl.textContent = musVal === 0 ? 'MUTED' : `${musVal}%`;
      if (vehValEl) vehValEl.textContent = vehVal === 0 ? 'MUTED' : `${vehVal}%`;
      if (sfxValEl) sfxValEl.textContent = sfxVal === 0 ? 'MUTED' : `${sfxVal}%`;

      r.resHeight = Number((this.root.querySelector('#o-res') as HTMLSelectElement).value);
      const bp = Number((this.root.querySelector('#o-blur') as HTMLInputElement).value);
      r.motionBlur = bp / 100;
      if (blurValEl) blurValEl.textContent = `${bp}%`;
      r.dither = (this.root.querySelector('#o-dither') as HTMLInputElement).checked;
      r.bloom = (this.root.querySelector('#o-bloom') as HTMLInputElement).checked;
      r.scanlines = (this.root.querySelector('#o-scan') as HTMLInputElement).checked;
      r.ps1 = (this.root.querySelector('#o-ps1') as HTMLInputElement).checked;
      const tod = (this.root.querySelector('#o-tod') as HTMLSelectElement).value;
      this.save.timeOfDay = tod === 'night' ? 'night' : 'day';
      this.save.trafficDensity = Number((this.root.querySelector('#o-traf') as HTMLInputElement).value);
      this.cb.onSettingsChanged();
    };

    this.root.querySelectorAll('input,select').forEach((el) => {
      el.addEventListener('change', apply);
      el.addEventListener('input', apply);
    });

    this.root.querySelector('#o-vol-master')!.addEventListener('change', () => this.cb.onPreviewSound?.('master'));
    this.root.querySelector('#o-vol-mus')!.addEventListener('change', () => this.cb.onPreviewSound?.('soundtrack'));
    this.root.querySelector('#o-vol-veh')!.addEventListener('change', () => this.cb.onPreviewSound?.('vehicle'));
    this.root.querySelector('#o-vol-sfx')!.addEventListener('change', () => this.cb.onPreviewSound?.('sfx'));

    this.root.querySelector('#o-back')!.addEventListener('click', () => {
      apply();
      onBack();
    });
  }

  showSplash(title: string, sub: string, color: string) {
    this.root.style.pointerEvents = 'auto';
    this.root.innerHTML = `
      <div class="menu-screen splash-screen">
        <h1 style="color:${color}">${title}</h1>
        <p>${sub}</p>
        <button id="s-cont" class="btn primary">BACK ON THE STREETS [ENTER]</button>
      </div>
    `;
    this.root.querySelector('#s-cont')!.addEventListener('click', () => this.cb.onSplashContinue());
  }
}
