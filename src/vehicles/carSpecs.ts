/** Physics + presentation data for every vehicle in the game. */
export type BodyStyle =
  | 'sports'
  | 'muscle'
  | 'tuner'
  | 'super'
  | 'suv'
  | 'taxi'
  | 'police'
  | 'policeSuv'
  | 'sedan'
  | 'hatch'
  | 'van'
  | 'pickup';

export interface VehicleSpec {
  id: string;
  name: string;
  style: BodyStyle;
  topSpeed: number; // m/s
  accel: number; // m/s^2 at standstill
  brake: number; // m/s^2
  grip: number; // lateral velocity damping rate (1/s)
  turnRate: number; // max yaw rate (rad/s)
  mass: number; // kg
  width: number;
  length: number;
  height: number;
  nitroAccel: number;
  engineBase: number; // audio: base engine pitch (Hz)
  engineTone: 'v8' | 'i4' | 'v12' | 'diesel' | 'v6';
}

export interface PlayerCarDef {
  spec: VehicleSpec;
  price: number;
  blurb: string;
  stars: { speed: number; accel: number; handling: number; weight: number };
  minorCrimeImmune?: boolean;
  colors: number[];
}

const base = { nitroAccel: 13, height: 1.35 };

export const PLAYER_CARS: PlayerCarDef[] = [
  {
    spec: { ...base, id: 'kestrel', name: 'Kestrel GT', style: 'sports', topSpeed: 60, accel: 14, brake: 28, grip: 9, turnRate: 2.35, mass: 1300, width: 1.9, length: 4.3, engineBase: 46, engineTone: 'v6' },
    price: 0,
    blurb: 'Balanced sports coupe. The street racer’s starter.',
    stars: { speed: 4, accel: 4, handling: 3, weight: 3 },
    colors: [0xe8352b, 0x1f6fe0, 0xf2f2f2, 0x111111, 0xffc21a],
  },
  {
    spec: { ...base, id: 'raptor', name: 'Raptor V8', style: 'muscle', topSpeed: 62, accel: 17, brake: 25, grip: 6, turnRate: 2.15, mass: 1650, width: 2.0, length: 4.7, engineBase: 32, engineTone: 'v8' },
    price: 0,
    blurb: 'Big-block muscle. Loves to drift, rams like a truck.',
    stars: { speed: 4, accel: 5, handling: 2, weight: 4 },
    colors: [0xff7a00, 0x1b1b1b, 0x2e8b57, 0xb0001e, 0x6aa9ff],
  },
  {
    spec: { ...base, id: 'nova', name: 'Nova RS', style: 'tuner', topSpeed: 54, accel: 14.5, brake: 30, grip: 12.5, turnRate: 2.65, mass: 1100, width: 1.8, length: 4.1, engineBase: 58, engineTone: 'i4' },
    price: 0,
    blurb: 'Lightweight JDM tuner. Corners on rails.',
    stars: { speed: 3, accel: 4, handling: 5, weight: 2 },
    colors: [0x9cff2e, 0x00d0ff, 0xff2fa0, 0xffffff, 0x2a2a2a],
  },
  {
    spec: { ...base, id: 'cabbie', name: 'Cabbie', style: 'taxi', topSpeed: 43, accel: 9, brake: 22, grip: 8, turnRate: 2.15, mass: 1500, width: 1.9, length: 4.6, engineBase: 40, engineTone: 'v6' },
    price: 0,
    blurb: 'City taxi. Nobody looks twice — cops ignore minor offences.',
    stars: { speed: 2, accel: 2, handling: 3, weight: 3 },
    minorCrimeImmune: true,
    colors: [0xffc800],
  },
  {
    spec: { ...base, id: 'brute', name: 'Brute 4x4', style: 'suv', topSpeed: 45, accel: 11, brake: 22, grip: 6.5, turnRate: 1.95, mass: 2600, width: 2.2, length: 4.9, height: 1.9, engineBase: 28, engineTone: 'diesel' },
    price: 2500,
    blurb: 'Armoured SUV. Bulldozes traffic and roadblocks.',
    stars: { speed: 2, accel: 3, handling: 2, weight: 5 },
    colors: [0x3b4a2f, 0x111111, 0xd9d9d9, 0x7a1f1f],
  },
  {
    spec: { ...base, id: 'phantom', name: 'Phantom X', style: 'super', topSpeed: 74, accel: 16.5, brake: 32, grip: 9.5, turnRate: 2.35, mass: 1350, width: 2.0, length: 4.5, height: 1.2, engineBase: 52, engineTone: 'v12' },
    price: 8000,
    blurb: 'Hypercar. Top speed nobody can catch.',
    stars: { speed: 5, accel: 4, handling: 3, weight: 3 },
    colors: [0xf0f0f0, 0x0a0a0a, 0xff3b1f, 0x00c2a8, 0x8a5cff],
  },
];

const traffic = (id: string, style: BodyStyle, extra: Partial<VehicleSpec> = {}): VehicleSpec => ({
  ...base,
  id,
  name: id,
  style,
  topSpeed: 32,
  accel: 7,
  brake: 20,
  grip: 9,
  turnRate: 1.9,
  mass: 1400,
  width: 1.9,
  length: 4.4,
  engineBase: 38,
  engineTone: 'i4',
  ...extra,
});

export const TRAFFIC_SPECS: VehicleSpec[] = [
  traffic('sedan', 'sedan'),
  traffic('hatch', 'hatch', { length: 3.9, mass: 1100 }),
  traffic('van', 'van', { length: 5.0, width: 2.1, height: 2.3, mass: 2200 }),
  traffic('pickup', 'pickup', { length: 5.0, width: 2.0, height: 1.7, mass: 2000 }),
  traffic('taxi', 'taxi', { length: 4.6 }),
];

export const TRAFFIC_COLORS = [0xb8c0c8, 0x2b3a55, 0x8a1c1c, 0x2f4f2f, 0xd8d0b8, 0x444444, 0x5a3d2b, 0x1f5e7a, 0xe0e0e0, 0x7a6a1f];

export const COP_SPEC: VehicleSpec = {
  ...base,
  id: 'police',
  name: 'Interceptor',
  style: 'police',
  topSpeed: 60,
  accel: 15,
  brake: 30,
  grip: 10,
  turnRate: 2.4,
  mass: 1700,
  width: 1.95,
  length: 4.8,
  engineBase: 34,
  engineTone: 'v8',
};

export const COP_SUV_SPEC: VehicleSpec = {
  ...COP_SPEC,
  id: 'policeSuv',
  name: 'Heavy SUV',
  style: 'policeSuv',
  topSpeed: 55,
  accel: 13,
  mass: 2800,
  width: 2.2,
  length: 5.0,
  height: 1.9,
};
