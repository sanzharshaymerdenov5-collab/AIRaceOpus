import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine } from '../src/audio/AudioEngine';
import { loadSave, writeSave } from '../src/gameplay/Save';

describe('Audio Settings & AudioEngine', () => {
  it('initializes AudioEngine with default volumes', () => {
    const audio = new AudioEngine();
    expect(audio.masterVolume).toBeCloseTo(0.85);
    expect(audio.musicVolume).toBeCloseTo(0.70);
    expect(audio.vehicleVolume).toBeCloseTo(0.85);
    expect(audio.sfxVolume).toBeCloseTo(0.85);
    expect(audio.musicEnabled).toBe(true);
    expect(audio.sfxEnabled).toBe(true);
  });

  it('clamps volumes within [0, 1] range', () => {
    const audio = new AudioEngine();
    audio.setVolumes(1.5, -0.5, 2.0, -1.0);
    expect(audio.masterVolume).toBe(1.0);
    expect(audio.musicVolume).toBe(0.0);
    expect(audio.vehicleVolume).toBe(1.0);
    expect(audio.sfxVolume).toBe(0.0);
  });

  it('correctly updates musicEnabled and sfxEnabled state', () => {
    const audio = new AudioEngine();
    audio.musicEnabled = false;
    expect(audio.musicVolume).toBe(0);
    expect(audio.musicEnabled).toBe(false);

    audio.musicEnabled = true;
    expect(audio.musicVolume).toBeCloseTo(0.70);
    expect(audio.musicEnabled).toBe(true);

    audio.sfxEnabled = false;
    expect(audio.vehicleVolume).toBe(0);
    expect(audio.sfxVolume).toBe(0);
    expect(audio.sfxEnabled).toBe(false);

    audio.sfxEnabled = true;
    expect(audio.vehicleVolume).toBeCloseTo(0.85);
    expect(audio.sfxVolume).toBeCloseTo(0.85);
    expect(audio.sfxEnabled).toBe(true);
  });
});

describe('SaveData Audio Persistence & Backward Compatibility', () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    (globalThis as any).localStorage = {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, val: string) => { mockStorage[key] = val; },
      removeItem: (key: string) => { delete mockStorage[key]; },
      clear: () => { mockStorage = {}; },
    };
  });

  it('loads defaults with master, soundtrack, vehicle and sfx volumes when empty', () => {
    const save = loadSave();
    expect(save.masterVolume).toBeCloseTo(0.85);
    expect(save.musicVolume).toBeCloseTo(0.70);
    expect(save.vehicleVolume).toBeCloseTo(0.85);
    expect(save.sfxVolume).toBeCloseTo(0.85);
    expect(save.music).toBe(true);
    expect(save.sfx).toBe(true);
  });

  it('migrates legacy save format (boolean music/sfx) seamlessly', () => {
    mockStorage['neon_district_save_v1'] = JSON.stringify({
      cash: 5000,
      music: false,
      sfx: true,
      carId: 'raptor',
    });

    const save = loadSave();
    expect(save.cash).toBe(5000);
    expect(save.carId).toBe('raptor');
    expect(save.masterVolume).toBeCloseTo(0.85);
    expect(save.musicVolume).toBe(0);
    expect(save.vehicleVolume).toBeCloseTo(0.85);
    expect(save.sfxVolume).toBeCloseTo(0.85);
    expect(save.music).toBe(false);
    expect(save.sfx).toBe(true);
  });

  it('persists and retrieves custom volume slider values', () => {
    const initial = loadSave();
    initial.masterVolume = 0.50;
    initial.musicVolume = 0.35;
    initial.vehicleVolume = 0.90;
    initial.sfxVolume = 0.60;

    writeSave(initial);

    const reloaded = loadSave();
    expect(reloaded.masterVolume).toBeCloseTo(0.50);
    expect(reloaded.musicVolume).toBeCloseTo(0.35);
    expect(reloaded.vehicleVolume).toBeCloseTo(0.90);
    expect(reloaded.sfxVolume).toBeCloseTo(0.60);
    expect(reloaded.music).toBe(true);
    expect(reloaded.sfx).toBe(true);
  });
});
