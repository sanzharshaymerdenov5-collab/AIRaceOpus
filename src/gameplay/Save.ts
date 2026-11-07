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
  masterVolume: number;
  musicVolume: number;
  vehicleVolume: number;
  sfxVolume: number;
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
  masterVolume: 0.85,
  musicVolume: 0.70,
  vehicleVolume: 0.85,
  sfxVolume: 0.85,
});

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const p = JSON.parse(raw);
    const d = defaults();
    return {
      ...d,
      ...p,
      retro: { ...defaultRetro(), ...(p.retro ?? {}) },
      masterVolume: typeof p.masterVolume === 'number' ? p.masterVolume : d.masterVolume,
      musicVolume: typeof p.musicVolume === 'number' ? p.musicVolume : (p.music === false ? 0 : d.musicVolume),
      vehicleVolume: typeof p.vehicleVolume === 'number' ? p.vehicleVolume : (p.sfx === false ? 0 : d.vehicleVolume),
      sfxVolume: typeof p.sfxVolume === 'number' ? p.sfxVolume : (p.sfx === false ? 0 : d.sfxVolume),
      music: typeof p.musicVolume === 'number' ? p.musicVolume > 0 : (p.music ?? true),
      sfx: typeof p.sfxVolume === 'number' ? p.sfxVolume > 0 : (p.sfx ?? true),
    };
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
