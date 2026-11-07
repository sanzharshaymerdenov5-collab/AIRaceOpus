import { Rng } from '../core/rng';

/** World-scale constants for the 1.5 km × 1.5 km city. */
export const CITY = {
  N: 16, // blocks per side -> 16 * 94m = 1504m (~1.5 km × 1.5 km)
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
  curve?: boolean;
}

export interface Segment {
  id: number;
  a: number; // intersection id
  b: number;
  axis: Axis;
  removed: boolean;
  ring: boolean;
  curve?: boolean;
  curveId?: number;
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
  curved?: boolean;
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

export interface CurvedRoad {
  id: number;
  name: string;
  style: 'arc' | 'scurve';
  i0: number;
  j0: number;
  points: { x: number; z: number }[];
  nodeIds: number[];
}

export interface OfficialRaceDef {
  id: string;
  name: string;
  kind: 'circuit' | 'sprint';
  laps: number;
  startX: number;
  startZ: number;
  startYaw: number;
  prizes: [number, number, number];
  checkpoints: { x: number; z: number }[];
}

export interface CityLayout {
  seed: number;
  intersections: Intersection[];
  segments: Segment[];
  curvedRoads: CurvedRoad[];
  blocks: Block[];
  buildings: Building[];
  props: PropSpec[];
  graph: RoadGraph;
  jobSpots: { x: number; z: number; type: 'getaway' | 'sprint' | 'smash' }[];
  raceSpots: OfficialRaceDef[];
  spawn: { x: number; z: number; yaw: number };
}

export const interId = (i: number, j: number) => j * (CITY.N + 1) + i;
export const lineCoord = (i: number) => (i - CITY.N / 2) * CITY.SPACING;

function cubicBezier(
  p0: { x: number; z: number },
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  p3: { x: number; z: number },
  t: number,
): { x: number; z: number } {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    z: b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z,
  };
}

function distToSegmentSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq < 1e-6) return (px - ax) * (px - ax) + (pz - az) * (pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / lenSq));
  const qx = ax + t * vx;
  const qz = az + t * vz;
  return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

interface CurveZoneSpec {
  id: number;
  name: string;
  style: 'arc' | 'scurve';
  i0: number;
  j0: number;
  start: [number, number];
  end: [number, number];
  corner?: [number, number];
}

export const CURVE_ZONES: CurveZoneSpec[] = [
  // 4 outer orbital beltway curves rounding the 4 quadrants of the 1.5 km city
  { id: 0, name: 'CANYON ESSES', style: 'scurve', i0: 1, j0: 2, start: [1, 4], end: [3, 2] },
  { id: 1, name: 'BAYVIEW SWEEPER', style: 'arc', i0: 13, j0: 2, start: [13, 2], end: [15, 4], corner: [15, 2] },
  { id: 2, name: 'HARBOR HAIRPIN', style: 'arc', i0: 13, j0: 12, start: [15, 12], end: [13, 14], corner: [15, 14] },
  { id: 3, name: 'SUNSET PARABOLICA', style: 'arc', i0: 1, j0: 12, start: [3, 14], end: [1, 12], corner: [1, 14] },
  // 2 inner technical S-curves through park & midtown corridors
  { id: 4, name: 'EMERALD PARK BEND', style: 'scurve', i0: 3, j0: 9, start: [3, 11], end: [5, 9] },
  { id: 5, name: 'EASTSIDE CHICANE', style: 'scurve', i0: 10, j0: 4, start: [10, 6], end: [12, 4] },
];

/** Directed lane graph over the street grid and curved road segments. Pure data, unit-testable. */
export class RoadGraph {
  readonly lanes: Lane[] = [];
  readonly outgoing: Lane[][] = [];
  readonly incoming: Lane[][] = [];
  private segLookup = new Map<string, Segment>();
  private curveSegments: Segment[] = [];
  private curveIntersections: Intersection[] = [];

  constructor(
    readonly intersections: Intersection[],
    readonly segments: Segment[],
  ) {
    for (let k = 0; k < intersections.length; k++) {
      this.outgoing.push([]);
      this.incoming.push([]);
    }
    for (const I of intersections) {
      if (I.curve) this.curveIntersections.push(I);
    }
    for (const s of segments) {
      this.segLookup.set(s.a < s.b ? `${s.a}-${s.b}` : `${s.b}-${s.a}`, s);
      if (s.removed) continue;
      if (s.curve) this.curveSegments.push(s);
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
      limit: s.ring || s.curve ? CITY.HIGHWAY_LIMIT : CITY.STREET_LIMIT,
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
    let best = this.intersections[interId(i, j)] ?? this.intersections[0];
    let bestD = Math.hypot(best.x - x, best.z - z);
    for (const c of this.curveIntersections) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * Endpoints of the road segment a point is on, ordered by heading (fx, fz).
   * `ahead` is the intersection the car is driving towards, `behind` the one it came from.
   */
  aheadIntersection(x: number, z: number, fx: number, fz: number): { ahead: number; behind: number } {
    const I = this.nearestIntersection(x, z);
    const h = CITY.ROAD / 2 + 1;
    if (Math.abs(x - I.x) <= h && Math.abs(z - I.z) <= h) return { ahead: I.id, behind: I.id };

    const near = this.nearestLane(x, z, fx, fz);
    if (this.segments[near.lane.seg]?.curve && near.dist <= CITY.ROAD) {
      return { ahead: near.lane.to, behind: near.lane.from };
    }

    const S = CITY.SPACING;
    const N = CITY.N;
    const gx = x / S + N / 2;
    const gz = z / S + N / 2;
    const ix = Math.max(0, Math.min(N, Math.round(gx)));
    const jz = Math.max(0, Math.min(N, Math.round(gz)));
    const offX = Math.abs(x - lineCoord(ix));
    const offZ = Math.abs(z - lineCoord(jz));
    if (offX <= offZ) {
      const j0 = Math.max(0, Math.min(N - 1, Math.floor(gz)));
      const a = interId(ix, j0);
      const b = interId(ix, j0 + 1);
      return fz >= 0 ? { ahead: b, behind: a } : { ahead: a, behind: b };
    }
    const i0 = Math.max(0, Math.min(N - 1, Math.floor(gx)));
    const a = interId(i0, jz);
    const b = interId(i0 + 1, jz);
    return fx >= 0 ? { ahead: b, behind: a } : { ahead: a, behind: b };
  }

  /** Intersection whose box contains the point, or -1. */
  intersectionAt(x: number, z: number): number {
    const I = this.nearestIntersection(x, z);
    const h = CITY.ROAD / 2;
    return Math.abs(x - I.x) <= h && Math.abs(z - I.z) <= h ? I.id : -1;
  }

  /** True if point lies on drivable asphalt (grid roads, curved roads, or intersections, excluding plazas). */
  onRoad(x: number, z: number): boolean {
    const S = CITY.SPACING;
    const h = CITY.ROAD / 2;
    const hSq = h * h;

    // 1. Check curved road segments first
    for (const s of this.curveSegments) {
      const A = this.intersections[s.a];
      const B = this.intersections[s.b];
      if (distToSegmentSq(x, z, A.x, A.z, B.x, B.z) <= hSq) return true;
    }

    // If inside the interior of a 2x2 curve zone, straight cross lines are replaced by the curve
    for (const cz of CURVE_ZONES) {
      const xMin = lineCoord(cz.i0) + h;
      const xMax = lineCoord(cz.i0 + 2) - h;
      const zMin = lineCoord(cz.j0) + h;
      const zMax = lineCoord(cz.j0 + 2) - h;
      if (x > xMin && x < xMax && z > zMin && z < zMax) return false;
    }

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

/** Build the full 1.5 km × 1.5 km city layout with curved roads and official race tracks from a seed. */
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

  // Identify interior nodes of the 6 2x2 curved road corridors
  const curveInteriorNodes = new Set<number>();
  const curveProtectedNodes = new Set<number>();
  for (const cz of CURVE_ZONES) {
    curveInteriorNodes.add(interId(cz.i0 + 1, cz.j0 + 1));
    for (let di = 0; di <= 2; di++)
      for (let dj = 0; dj <= 2; dj++) curveProtectedNodes.add(interId(cz.i0 + di, cz.j0 + dj));
  }

  const segments: Segment[] = [];
  const isRing = (i: number, j: number, axis: Axis) =>
    axis === 'x' ? j === 0 || j === N : i === 0 || i === N;
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      if (i < N) {
        const a = interId(i, j);
        const b = interId(i + 1, j);
        // Skip interior axis-aligned cross-segments replaced by a curved road
        if (!curveInteriorNodes.has(a) && !curveInteriorNodes.has(b)) {
          segments.push({ id: segments.length, a, b, axis: 'x', removed: false, ring: isRing(i, j, 'x') });
        }
      }
      if (j < N) {
        const a = interId(i, j);
        const b = interId(i, j + 1);
        if (!curveInteriorNodes.has(a) && !curveInteriorNodes.has(b)) {
          segments.push({ id: segments.length, a, b, axis: 'z', removed: false, ring: isRing(i, j, 'z') });
        }
      }
    }

  // Construct the 6 curved roads (each 6 segments across a 2x2 block corridor)
  const curvedRoads: CurvedRoad[] = [];
  for (const cz of CURVE_ZONES) {
    const startId = interId(cz.start[0], cz.start[1]);
    const endId = interId(cz.end[0], cz.end[1]);
    const midId = interId(cz.i0 + 1, cz.j0 + 1);
    const p0 = { x: intersections[startId].x, z: intersections[startId].z };
    const p3 = { x: intersections[endId].x, z: intersections[endId].z };

    let p1: { x: number; z: number };
    let p2: { x: number; z: number };
    if (cz.style === 'arc' && cz.corner) {
      const cx = lineCoord(cz.corner[0]);
      const czCoord = lineCoord(cz.corner[1]);
      p1 = { x: p0.x + (cx - p0.x) * 0.56, z: p0.z + (czCoord - p0.z) * 0.56 };
      p2 = { x: p3.x + (cx - p3.x) * 0.56, z: p3.z + (czCoord - p3.z) * 0.56 };
    } else {
      const dx = p3.x - p0.x;
      const dz = p3.z - p0.z;
      const len = Math.hypot(dx, dz);
      const nx = -dz / len;
      const nz = dx / len;
      const bow = 58;
      p1 = { x: p0.x + dx * 0.33 + nx * bow, z: p0.z + dz * 0.33 + nz * bow };
      p2 = { x: p0.x + dx * 0.67 - nx * bow, z: p0.z + dz * 0.67 - nz * bow };
    }

    // 6 graph segments along the curve: t = 0, 1/6, 2/6, 3/6 (midId), 4/6, 5/6, 1
    const steps = 6;
    const nodeIds: number[] = [startId];
    intersections[startId].curve = true;
    intersections[endId].curve = true;
    for (let s = 1; s < steps; s++) {
      const pt = cubicBezier(p0, p1, p2, p3, s / steps);
      if (s === 3) {
        const M = intersections[midId];
        M.x = pt.x;
        M.z = pt.z;
        M.curve = true;
        nodeIds.push(midId);
      } else {
        const id = intersections.length;
        intersections.push({
          id,
          i: cz.i0 + 1,
          j: cz.j0 + 1,
          x: pt.x,
          z: pt.z,
          degree: 0,
          hasLights: false,
          lightOffset: 0,
          curve: true,
        });
        nodeIds.push(id);
      }
    }
    nodeIds.push(endId);

    for (let k = 0; k < nodeIds.length - 1; k++) {
      const A = intersections[nodeIds[k]];
      const B = intersections[nodeIds[k + 1]];
      const axis: Axis = Math.abs(B.x - A.x) >= Math.abs(B.z - A.z) ? 'x' : 'z';
      segments.push({
        id: segments.length,
        a: A.id,
        b: B.id,
        axis,
        removed: false,
        ring: false,
        curve: true,
        curveId: cz.id,
      });
    }

    // High-res polyline for rendering smooth curved asphalt, kerbs, and markings
    const points: { x: number; z: number }[] = [];
    const visSteps = 24;
    for (let v = 0; v <= visSteps; v++) {
      points.push(cubicBezier(p0, p1, p2, p3, v / visSteps));
    }
    curvedRoads.push({ id: cz.id, name: cz.name, style: cz.style, i0: cz.i0, j0: cz.j0, points, nodeIds });
  }

  // Degree count, then remove a few interior straight segments to make pedestrian plazas.
  const deg = new Array(intersections.length).fill(0);
  for (const s of segments) {
    deg[s.a]++;
    deg[s.b]++;
  }
  let toRemove = 12;
  let guard = 0;
  while (toRemove > 0 && guard++ < 600) {
    const s = rng.pick(segments);
    if (s.removed || s.ring || s.curve) continue;
    if (curveProtectedNodes.has(s.a) || curveProtectedNodes.has(s.b)) continue;
    const A = intersections[s.a];
    const B = intersections[s.b];
    // keep clear main avenue crosses through the centre and inner 6th avenue
    if ((A.i === N / 2 && B.i === N / 2) || (A.i === 6 && B.i === 6)) continue;
    if ((A.j === N / 2 && B.j === N / 2) || (A.j === 6 && B.j === 6)) continue;
    if (deg[s.a] < 4 || deg[s.b] < 4) continue;
    s.removed = true;
    deg[s.a]--;
    deg[s.b]--;
    toRemove--;
  }
  for (const I of intersections) {
    I.degree = deg[I.id];
    I.hasLights = !I.curve && I.degree >= 3 && !(I.i === 0 || I.i === N || I.j === 0 || I.j === N);
  }

  const graph = new RoadGraph(intersections, segments);

  // Helper to check if a candidate building or prop is too close to any curved road
  const nearCurvedRoad = (x: number, z: number, margin: number): boolean => {
    const rSq = (CITY.ROAD / 2 + margin) * (CITY.ROAD / 2 + margin);
    for (const s of segments) {
      if (!s.curve) continue;
      const A = intersections[s.a];
      const B = intersections[s.b];
      if (distToSegmentSq(x, z, A.x, A.z, B.x, B.z) <= rSq) return true;
    }
    return false;
  };

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
      const isCurvedBlock = CURVE_ZONES.some((z) => bi >= z.i0 && bi <= z.i0 + 1 && bj >= z.j0 && bj <= z.j0 + 1);
      const dc = Math.max(Math.abs(bi + 0.5 - N / 2), Math.abs(bj + 0.5 - N / 2));
      let district: District;
      if (isCurvedBlock) district = 'park';
      else if (dc <= 2.5) district = 'downtown';
      else if (bi >= N - 3) district = 'industrial';
      else district = 'suburbs';
      if (!isCurvedBlock && district !== 'downtown' && rng.chance(district === 'suburbs' ? 0.1 : 0.04)) district = 'park';
      blocks.push({ bi, bj, cx, cz, district, curved: isCurvedBlock });

      if (isCurvedBlock) {
        // Scenic trees in the safe outer corners of the curved road corridor
        for (let k = 0; k < 10; k++) {
          const tx = cx + rng.range(-32, 32);
          const tz = cz + rng.range(-32, 32);
          if (!nearCurvedRoad(tx, tz, 6.5) && !graph.onRoad(tx, tz)) {
            props.push({ type: 'tree', x: tx, z: tz, rot: 0 });
          }
        }
        continue;
      }

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

  // Place street lamps along both sides of each curved road
  for (const cr of curvedRoads) {
    const pts = cr.points;
    for (let idx = 3; idx < pts.length - 3; idx += 4) {
      const pPrev = pts[idx - 1];
      const pNext = pts[idx + 1];
      const p = pts[idx];
      const tx = pNext.x - pPrev.x;
      const tz = pNext.z - pPrev.z;
      const len = Math.hypot(tx, tz) || 1;
      const rx = -tz / len;
      const rz = tx / len;
      const off = CITY.ROAD / 2 + 2.2;
      for (const side of [-1, 1]) {
        const lx = p.x + rx * off * side;
        const lz = p.z + rz * off * side;
        if (!graph.onRoad(lx, lz)) {
          props.push({ type: 'lamp', x: lx, z: lz, rot: Math.atan2(-rx * side, -rz * side) });
        }
      }
    }
  }

  // Speed cameras on random interior segments
  const live = segments.filter((s) => !s.removed && !s.curve);
  for (let k = 0; k < 16; k++) {
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

  // Night Outlaw Job spots spread around the city
  const jobSpots: CityLayout['jobSpots'] = [];
  const types: ('getaway' | 'sprint' | 'smash')[] = ['getaway', 'sprint', 'smash', 'getaway', 'sprint', 'smash'];
  const anchors = [
    [4, 4],
    [12, 4],
    [4, 12],
    [12, 12],
    [8, 3],
    [3, 8],
  ];
  anchors.forEach(([i, j], k) => {
    jobSpots.push({ x: lineCoord(i) + CITY.SPACING / 2, z: lineCoord(j), type: types[k] });
  });

  // Official Speedhunter Showdown Sanctioned Races (Day Mode)
  const ptAt = (i: number, j: number) => ({ x: lineCoord(i), z: lineCoord(j) });
  const curveMid = (id: number) => {
    const c = curvedRoads[id];
    return c.points[Math.floor(c.points.length / 2)];
  };
  const raceSpots: OfficialRaceDef[] = [
    {
      id: 'palm_gp',
      name: 'PALM CITY GRAND PRIX',
      kind: 'circuit',
      laps: 2,
      startX: lineCoord(8) + CITY.LANE_OFFSET,
      startZ: lineCoord(8) - 28,
      startYaw: Math.PI, // heading North (-Z)
      prizes: [6000, 3200, 1500],
      checkpoints: [
        ptAt(8, 4),
        ptAt(10, 6),
        curveMid(5), // Eastside Chicane curve
        ptAt(12, 4),
        ptAt(12, 8),
        ptAt(8, 8),
      ],
    },
    {
      id: 'canyon_sprint',
      name: 'CANYON S-CURVE SHOWDOWN',
      kind: 'sprint',
      laps: 1,
      startX: lineCoord(6),
      startZ: lineCoord(2) - CITY.LANE_OFFSET,
      startYaw: -Math.PI / 2, // heading West (-X)
      prizes: [4800, 2500, 1200],
      checkpoints: [
        ptAt(3, 2),
        curveMid(0), // NW Canyon Esses curve
        ptAt(1, 4),
        ptAt(1, 8),
        ptAt(3, 11),
        curveMid(4), // Emerald Park Serpentine curve
        ptAt(5, 9),
        ptAt(8, 9),
      ],
    },
    {
      id: 'bayview_circuit',
      name: 'BAYVIEW COASTAL DASH',
      kind: 'circuit',
      laps: 2,
      startX: lineCoord(11),
      startZ: lineCoord(2) + CITY.LANE_OFFSET,
      startYaw: Math.PI / 2, // heading East (+X)
      prizes: [5400, 2800, 1400],
      checkpoints: [
        ptAt(13, 2),
        curveMid(1), // NE Bayview Sweeper curve
        ptAt(15, 4),
        ptAt(15, 8),
        ptAt(12, 8),
        ptAt(10, 6),
        curveMid(5), // Eastside Chicane curve
        ptAt(12, 4),
      ],
    },
    {
      id: 'sunset_parabolica',
      name: 'SUNSET PARABOLICA SPRINT',
      kind: 'sprint',
      laps: 1,
      startX: lineCoord(8),
      startZ: lineCoord(14) - CITY.LANE_OFFSET,
      startYaw: -Math.PI / 2, // heading West (-X)
      prizes: [4500, 2400, 1100],
      checkpoints: [
        ptAt(3, 14),
        curveMid(3), // SW Sunset Parabolica curve
        ptAt(1, 12),
        ptAt(1, 8),
        ptAt(3, 11),
        curveMid(4), // Emerald Park Serpentine curve
        ptAt(5, 9),
        ptAt(8, 8),
      ],
    },
    {
      id: 'harbor_ring',
      name: 'HARBOR ORBITAL TOUR',
      kind: 'circuit',
      laps: 2,
      startX: lineCoord(15) - CITY.LANE_OFFSET,
      startZ: lineCoord(8),
      startYaw: 0, // heading South (+Z)
      prizes: [6500, 3500, 1700],
      checkpoints: [
        ptAt(15, 12),
        curveMid(2), // SE Harbor Hairpin curve
        ptAt(13, 14),
        ptAt(9, 14),
        ptAt(9, 8),
        ptAt(15, 8),
      ],
    },
  ];

  // Player spawn: right lane heading north just south of the centre
  const spawnLane = graph.outgoing[interId(N / 2, N / 2 + 1)].find((l) => l.to === interId(N / 2, N / 2))!;
  const spawn = {
    x: spawnLane.sx + spawnLane.dx * 10,
    z: spawnLane.sz + spawnLane.dz * 10,
    yaw: Math.atan2(spawnLane.dx, spawnLane.dz),
  };

  return { seed, intersections, segments, curvedRoads, blocks, buildings, props, graph, jobSpots, raceSpots, spawn };
}
