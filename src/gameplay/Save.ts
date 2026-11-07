import { defaultRetro, type RetroSettings } from '../render/RenderPipeline';

const KEY = 'neon_district_save_v1';

export interface SaveData {
  cash: number;
  bestHeat: number;
  unlocked: string[];
  carId: string;
  colorIdx: number;
  music: boolean;
  sfx: boolean;
  trafficDensity: number;
  retro: RetroSettings;
}

const defaults = (): SaveData => ({
  cash: 1000,
  bestHeat: 0,
  unlocked: ['kestrel', 'raptor', 'nova', 'cabbie'],
  carId: 'kestrel',
  colorIdx: 0,
  music: true,
  sfx: true,
  trafficDensity: 34,
  retro: defaultRetro(),
});

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const p = JSON.parse(raw);
    return { ...defaults(), ...p, retro: { ...defaultRetro(), ...(p.retro ?? {}) } };
  } catch {
    return defaults();
  }
}

export function writeSave(s: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore quota errors */
  }
}
