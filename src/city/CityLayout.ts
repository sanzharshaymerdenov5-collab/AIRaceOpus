import { Rng } from '../core/rng';

/** World-scale constants for the grid city. */
export const CITY = {
  N: 12, // blocks per side
  BLOCK: 80, // block interior size (m)
  ROAD: 14, // road width (m)
  LANE_OFFSET: 3.5, // lane centre offset from road centre (m)
  SIDEWALK: 4, // sidewalk depth inside a block (m)
  get SPACING() {
    return this.BLOCK + this.ROAD;
  },
  get HALF() {
    return (this.N * this.SPACING) / 2;
  },
  STREET_LIMIT: 15, // m/s (~54 km/h)
  HIGHWAY_LIMIT: 26, // m/s (~94 km/h)
};

export type Axis = 'x' | 'z';
export type District = 'downtown' | 'industrial' | 'suburbs' | 'park';

export interface Intersection {
  id: number;
  i: number;
  j: number;
  x: number;
  z: number;
  degree: number;
  hasLights: boolean;
  lightOffset: number;
}

export interface Segment {
  id: number;
  a: number; // intersection id
  b: number;
  axis: Axis;
  removed: boolean;
  ring: boolean;
}

export interface Lane {
  id: number;
  seg: number;
  from: number;
  to: number;
  sx: number;
  sz: number;
  ex: number;
  ez: number;
  dx: number;
  dz: number;
  len: number;
  limit: number;
  axis: Axis;
}

export interface Block {
  bi: number;
  bj: number;
  cx: number;
  cz: number;
  district: District;
}

export interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  district: District;
  tint: number; // 0..1 palette selector
  neon: boolean;
}

export type PropType = 'lamp' | 'hydrant' | 'bench' | 'bin' | 'newsstand' | 'cone' | 'tree' | 'camera';

export interface PropSpec {
  type: PropType;
  x: number;
  z: number;
  rot: number;
}

export interface CityLayout {
  seed: number;
  intersections: Intersection[];
  segments: Segment[];
  blocks: Block[];
  buildings: Building[];
  props: PropSpec[];
  graph: RoadGraph;
  jobSpots: { x: number; z: number; type: 'getaway' | 'sprint' | 'smash' }[];
  spawn: { x: number; z: number; yaw: number };
}

export const interId = (i: number, j: number) => j * (CITY.N + 1) + i;
export const lineCoord = (i: number) => (i - CITY.N / 2) * CITY.SPACING;

/** Directed lane graph over the street grid. Pure data, unit-testable. */
export class RoadGraph {
  readonly lanes: Lane[] = [];
  readonly outgoing: Lane[][] = [];
  readonly incoming: Lane[][] = [];
  private segLookup = new Map<string, Segment>();

  constructor(
    readonly intersections: Intersection[],
    readonly segments: Segment[],
  ) {
    for (let k = 0; k < intersections.length; k++) {
      this.outgoing.push([]);
      this.incoming.push([]);
    }
    for (const s of segments) {
      this.segLookup.set(s.a < s.b ? `${s.a}-${s.b}` : `${s.b}-${s.a}`, s);
      if (s.removed) continue;
      this.addLane(s, s.a, s.b);
      this.addLane(s, s.b, s.a);
    }
  }

  private addLane(s: Segment, from: number, to: number) {
    const A = this.intersections[from];
    const B = this.intersections[to];
    const len0 = Math.hypot(B.x - A.x, B.z - A.z);
    const dx = (B.x - A.x) / len0;
    const dz = (B.z - A.z) / len0;
    // right-hand traffic: right vector = (-dz, dx)
    const rx = -dz;
    const rz = dx;
    const h = CITY.ROAD / 2;
    const o = CITY.LANE_OFFSET;
    const lane: Lane = {
      id: this.lanes.length,
      seg: s.id,
      from,
      to,
      sx: A.x + dx * h + rx * o,
      sz: A.z + dz * h + rz * o,
      ex: B.x - dx * h + rx * o,
      ez: B.z - dz * h + rz * o,
      dx,
      dz,
      len: len0 - CITY.ROAD,
      limit: s.ring ? CITY.HIGHWAY_LIMIT : CITY.STREET_LIMIT,
      axis: s.axis,
    };
    this.lanes.push(lane);
    this.outgoing[from].push(lane);
    this.incoming[to].push(lane);
  }

  segmentBetween(a: number, b: number): Segment | undefined {
    return this.segLookup.get(a < b ? `${a}-${b}` : `${b}-${a}`);
  }

  /** Lanes a car can take after finishing `lane` (no U-turns unless dead end). */
  successors(lane: Lane): Lane[] {
    const out = this.outgoing[lane.to];
    const noU = out.filter((l) => l.to !== lane.from);
    return noU.length ? noU : out;
  }

  /** Closest lane to a point, with projected distance along it. */
  nearestLane(x: number, z: number, dirX = 0, dirZ = 0): { lane: Lane; t: number; dist: number } {
    let best: Lane = this.lanes[0];
    let bestT = 0;
    let bestScore = Infinity;
    let bestDist = Infinity;
    for (const l of this.lanes) {
      let t = (x - l.sx) * l.dx + (z - l.sz) * l.dz;
      if (t < 0) t = 0;
      else if (t > l.len) t = l.len;
      const px = l.sx + l.dx * t;
      const pz = l.sz + l.dz * t;
      const d = Math.hypot(x - px, z - pz);
      // Prefer lanes aligned with the supplied heading (if any).
      const align = dirX || dirZ ? (1 - (l.dx * dirX + l.dz * dirZ)) * 10 : 0;
      const score = d + align;
      if (score < bestScore) {
        bestScore = score;
        best = l;
        bestT = t;
        bestDist = d;
      }
    }
    return { lane: best, t: bestT, dist: bestDist };
  }

  nearestIntersection(x: number, z: number): Intersection {
    const S = CITY.SPACING;
    const i = Math.max(0, Math.min(CITY.N, Math.round(x / S + CITY.N / 2)));
    const j = Math.max(0, Math.min(CITY.N, Math.round(z / S + CITY.N / 2)));
    return this.intersections[interId(i, j)];
  }

  /** Intersection whose box contains the point, or -1. */
  intersectionAt(x: number, z: number): number {
    const I = this.nearestIntersection(x, z);
    const h = CITY.ROAD / 2;
    return Math.abs(x - I.x) <= h && Math.abs(z - I.z) <= h ? I.id : -1;
  }

  /** True if point lies on drivable asphalt (roads + intersections, excluding plazas). */
  onRoad(x: number, z: number): boolean {
    const S = CITY.SPACING;
    const h = CITY.ROAD / 2;
    const gx = x / S + CITY.N / 2;
    const gz = z / S + CITY.N / 2;
    const ix = Math.round(gx);
    const jz = Math.round(gz);
    const nearX = Math.abs(x - lineCoord(ix)) <= h && ix >= 0 && ix <= CITY.N;
    const nearZ = Math.abs(z - lineCoord(jz)) <= h && jz >= 0 && jz <= CITY.N;
    if (nearX && nearZ) return true;
    if (nearX) {
      const j0 = Math.floor(gz);
      if (j0 < 0 || j0 >= CITY.N) return false;
      const s = this.segmentBetween(interId(ix, j0), interId(ix, j0 + 1));
      return !!s && !s.removed;
    }
    if (nearZ) {
      const i0 = Math.floor(gx);
      if (i0 < 0 || i0 >= CITY.N) return false;
      const s = this.segmentBetween(interId(i0, jz), interId(i0 + 1, jz));
      return !!s && !s.removed;
    }
    return false;
  }

  neighbors(id: number): number[] {
    return this.outgoing[id].map((l) => l.to);
  }
}

/** Build the full city layout from a seed. Deterministic, no rendering. */
export function generateCity(seed = 1337): CityLayout {
  const rng = new Rng(seed);
  const N = CITY.N;
  const intersections: Intersection[] = [];
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++)
      intersections.push({
        id: interId(i, j),
        i,
        j,
        x: lineCoord(i),
        z: lineCoord(j),
        degree: 0,
        hasLights: false,
        lightOffset: rng.range(0, 24),
      });

  const segments: Segment[] = [];
  const isRing = (i: number, j: number, axis: Axis) =>
    axis === 'x' ? j === 0 || j === N : i === 0 || i === N;
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      if (i < N)
        segments.push({ id: segments.length, a: interId(i, j), b: interId(i + 1, j), axis: 'x', removed: false, ring: isRing(i, j, 'x') });
      if (j < N)
        segments.push({ id: segments.length, a: interId(i, j), b: interId(i, j + 1), axis: 'z', removed: false, ring: isRing(i, j, 'z') });
    }

  // Degree count, then remove a few interior segments to make plazas.
  const deg = new Array(intersections.length).fill(0);
  for (const s of segments) {
    deg[s.a]++;
    deg[s.b]++;
  }
  let toRemove = 9;
  let guard = 0;
  while (toRemove > 0 && guard++ < 500) {
    const s = rng.pick(segments);
    if (s.removed || s.ring) continue;
    const A = intersections[s.a];
    const B = intersections[s.b];
    // keep a clear "main avenue" cross through the centre
    if (A.i === N / 2 && B.i === N / 2) continue;
    if (A.j === N / 2 && B.j === N / 2) continue;
    if (deg[s.a] < 4 || deg[s.b] < 4) continue;
    s.removed = true;
    deg[s.a]--;
    deg[s.b]--;
    toRemove--;
  }
  for (const I of intersections) {
    I.degree = deg[I.id];
    I.hasLights = I.degree >= 3 && !(I.i === 0 || I.i === N || I.j === 0 || I.j === N);
  }

  const graph = new RoadGraph(intersections, segments);

  // Blocks & districts
  const blocks: Block[] = [];
  const buildings: Building[] = [];
  const props: PropSpec[] = [];
  const S = CITY.SPACING;
  const B = CITY.BLOCK;
  const SW = CITY.SIDEWALK;
  for (let bj = 0; bj < N; bj++)
    for (let bi = 0; bi < N; bi++) {
      const cx = (bi + 0.5 - N / 2) * S;
      const cz = (bj + 0.5 - N / 2) * S;
      const dc = Math.max(Math.abs(bi + 0.5 - N / 2), Math.abs(bj + 0.5 - N / 2));
      let district: District;
      if (dc <= 2) district = 'downtown';
      else if (bi >= N - 3) district = 'industrial';
      else district = 'suburbs';
      if (district !== 'downtown' && rng.chance(district === 'suburbs' ? 0.1 : 0.04)) district = 'park';
      blocks.push({ bi, bj, cx, cz, district });

      const inner = B - SW * 2; // usable lot area
      const x0 = cx - inner / 2;
      const z0 = cz - inner / 2;
      if (district === 'downtown') {
        if (rng.chance(0.25)) {
          const w = inner - 6;
          buildings.push({ x: cx, z: cz, w, d: w, h: rng.range(90, 150), district, tint: rng.next(), neon: true });
        } else {
          const n = 2;
          const cell = inner / n;
          for (let a = 0; a < n; a++)
            for (let b = 0; b < n; b++) {
              const w = cell - rng.range(3, 7);
              const d = cell - rng.range(3, 7);
              buildings.push({
                x: x0 + cell * (a + 0.5),
                z: z0 + cell * (b + 0.5),
                w,
                d,
                h: rng.range(30, 110),
                district,
                tint: rng.next(),
                neon: rng.chance(0.6),
              });
            }
        }
      } else if (district === 'industrial') {
        const n = rng.chance(0.5) ? 1 : 2;
        const cell = inner / n;
        for (let a = 0; a < n; a++) {
          const w = n === 1 ? inner - 6 : cell - 5;
          buildings.push({
            x: n === 1 ? cx : x0 + cell * (a + 0.5),
            z: cz + rng.range(-4, 4),
            w,
            d: inner - rng.range(8, 20),
            h: rng.range(9, 20),
            district,
            tint: rng.next(),
            neon: rng.chance(0.15),
          });
        }
      } else if (district === 'suburbs') {
        const n = 3;
        const cell = inner / n;
        for (let a = 0; a < n; a++)
          for (let b = 0; b < n; b++) {
            if (a === 1 && b === 1) {
              // backyard trees in the middle lot
              props.push({ type: 'tree', x: x0 + cell * 1.5, z: z0 + cell * 1.5, rot: 0 });
              continue;
            }
            if (rng.chance(0.12)) {
              props.push({ type: 'tree', x: x0 + cell * (a + 0.5), z: z0 + cell * (b + 0.5), rot: 0 });
              continue;
            }
            const w = cell - rng.range(6, 10);
            const d = cell - rng.range(6, 10);
            buildings.push({
              x: x0 + cell * (a + 0.5),
              z: z0 + cell * (b + 0.5),
              w,
              d,
              h: rng.range(6, 14),
              district,
              tint: rng.next(),
              neon: false,
            });
          }
      } else {
        // park: scattered trees + benches
        for (let k = 0; k < 14; k++)
          props.push({ type: 'tree', x: cx + rng.range(-30, 30), z: cz + rng.range(-30, 30), rot: 0 });
        for (let k = 0; k < 4; k++)
          props.push({ type: 'bench', x: cx + rng.range(-25, 25), z: cz + rng.range(-25, 25), rot: rng.range(0, Math.PI) });
      }

      // Street furniture on sidewalks around the block (1.4 m in from the curb)
      const edge = B / 2 - 1.4;
      const sides: [number, number, number, number, number][] = [
        // [startX, startZ, dirX, dirZ, rotation]
        [cx - B / 2 + 8, cz - edge, 1, 0, 0],
        [cx - B / 2 + 8, cz + edge, 1, 0, Math.PI],
        [cx - edge, cz - B / 2 + 8, 0, 1, Math.PI / 2],
        [cx + edge, cz - B / 2 + 8, 0, 1, -Math.PI / 2],
      ];
      for (const [sx, sz, dx, dz, rot] of sides) {
        for (let k = 0; k < 3; k++) {
          const t = k * 32;
          props.push({ type: 'lamp', x: sx + dx * t, z: sz + dz * t, rot });
        }
        const extras = district === 'downtown' ? 3 : district === 'park' ? 1 : 2;
        for (let k = 0; k < extras; k++) {
          const t = rng.range(10, 58);
          const type: PropType =
            district === 'downtown'
              ? rng.pick(['hydrant', 'bench', 'bin', 'newsstand', 'bin'] as const)
              : district === 'industrial'
                ? rng.pick(['cone', 'bin', 'hydrant', 'cone'] as const)
                : rng.pick(['hydrant', 'bin', 'bench'] as const);
          props.push({ type, x: sx + dx * t, z: sz + dz * t, rot });
        }
      }
    }

  // Speed cameras on random interior segments
  const live = segments.filter((s) => !s.removed);
  for (let k = 0; k < 12; k++) {
    const s = rng.pick(live);
    const A = intersections[s.a];
    const Bi = intersections[s.b];
    const mx = (A.x + Bi.x) / 2;
    const mz = (A.z + Bi.z) / 2;
    const off = CITY.ROAD / 2 + 1.2;
    props.push(
      s.axis === 'x'
        ? { type: 'camera', x: mx, z: mz + off, rot: 0 }
        : { type: 'camera', x: mx + off, z: mz, rot: Math.PI / 2 },
    );
  }

  // Job spots: placed on road segments mid-points spread around the city
  const jobSpots: CityLayout['jobSpots'] = [];
  const types: ('getaway' | 'sprint' | 'smash')[] = ['getaway', 'sprint', 'smash', 'getaway', 'sprint', 'smash'];
  const anchors = [
    [3, 3],
    [9, 3],
    [3, 9],
    [9, 9],
    [6, 2],
    [2, 6],
  ];
  anchors.forEach(([i, j], k) => {
    const s = graph.segmentBetween(interId(i, j), interId(i + 1, j));
    const ii = s && !s.removed ? i : i;
    jobSpots.push({ x: lineCoord(ii) + CITY.SPACING / 2, z: lineCoord(j), type: types[k] });
  });

  // Player spawn: right lane heading north just south of the centre
  const spawnLane = graph.outgoing[interId(N / 2, N / 2 + 1)].find((l) => l.to === interId(N / 2, N / 2))!;
  const spawn = {
    x: spawnLane.sx + spawnLane.dx * 10,
    z: spawnLane.sz + spawnLane.dz * 10,
    yaw: Math.atan2(spawnLane.dx, spawnLane.dz),
  };

  return { seed, intersections, segments, blocks, buildings, props, graph, jobSpots, spawn };
}
