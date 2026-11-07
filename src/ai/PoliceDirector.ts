import { CITY, type RoadGraph } from '../city/CityLayout';
import { clamp } from '../core/rng';

export type TacticalRole = 'lead' | 'left' | 'right' | 'intercept' | 'lkp' | 'sector';

export interface LastKnownSighting {
  x: number;
  z: number;
  vx: number;
  vz: number;
  dirX: number;
  dirZ: number;
  speed: number;
  time: number;
  interId: number;
  active: boolean;
  lkpChecked: boolean;
}

export interface DirectorUnitView {
  id: number;
  x: number;
  z: number;
  seesPlayer: boolean;
  role: TacticalRole;
  targetInter: number;
  targetX: number;
  targetZ: number;
}

/**
 * Police AI Director / Coordinator.
 * - Maintains the shared Last Known Position (LKP) and velocity of the suspect.
 * - Never leaks the player's true position when line-of-sight is broken.
 * - When in sight: assigns Lead (PIT), Left/Right flankers (box-in), and forward Interceptors
 *   that route via A* to cut the player off 1-3 blocks ahead.
 * - When sight is lost: sends the closest unit to verify the exact LKP while fanning the rest
 *   of the squad across unvisited intersections in the player's projected escape cone.
 */
export class PoliceDirector {
  readonly lastKnown: LastKnownSighting = {
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    dirX: 0,
    dirZ: 1,
    speed: 0,
    time: -999,
    interId: 0,
    active: false,
    lkpChecked: false,
  };

  /** Timestamp when each intersection was last cleared by a searching cop. */
  readonly visitedAt = new Map<number, number>();

  constructor(private graph: RoadGraph) {}

  reset() {
    this.lastKnown.active = false;
    this.lastKnown.lkpChecked = false;
    this.visitedAt.clear();
  }

  /** Record a confirmed sighting or crime report at (x, z) with velocity (vx, vz). */
  reportSighting(x: number, z: number, vx: number, vz: number, now: number) {
    const sp = Math.hypot(vx, vz);
    const lk = this.lastKnown;
    if (sp > 1.5) {
      lk.dirX = vx / sp;
      lk.dirZ = vz / sp;
    } else if (!lk.active) {
      lk.dirX = 0;
      lk.dirZ = 1;
    }
    lk.x = x;
    lk.z = z;
    lk.vx = vx;
    lk.vz = vz;
    lk.speed = sp;
    lk.time = now;
    lk.interId = this.graph.nearestIntersection(x, z).id;
    lk.active = true;
    lk.lkpChecked = false;
    // Fresh visual contact invalidates old search marks so future searches start clean
    this.visitedAt.clear();
  }

  /** Record that a unit drove through its current area, clearing nearby intersections. */
  recordUnitPosition(x: number, z: number, now: number): number {
    const I = this.graph.nearestIntersection(x, z);
    if (Math.hypot(I.x - x, I.z - z) <= CITY.ROAD * 1.35) {
      this.visitedAt.set(I.id, now);
      if (
        this.lastKnown.active &&
        !this.lastKnown.lkpChecked &&
        Math.hypot(x - this.lastKnown.x, z - this.lastKnown.z) <= CITY.ROAD * 1.4
      ) {
        this.lastKnown.lkpChecked = true;
      }
      return I.id;
    }
    return -1;
  }

  /**
   * Coordinate all active police units for this frame.
   * Mutates each unit's `role`, `targetInter`, `targetX`, `targetZ`.
   */
  coordinate(units: DirectorUnitView[], now: number, anySees: boolean) {
    if (!units.length || !this.lastKnown.active) return;
    const lk = this.lastKnown;

    if (anySees) {
      // Sort units by distance to the live LKP
      const sorted = [...units].sort(
        (a, b) => Math.hypot(a.x - lk.x, a.z - lk.z) - Math.hypot(b.x - lk.x, b.z - lk.z),
      );
      sorted.forEach((u, rank) => {
        const d = Math.hypot(u.x - lk.x, u.z - lk.z);
        // Check if this unit is already ahead of the player along their travel direction
        const relDot = ((u.x - lk.x) * lk.dirX + (u.z - lk.z) * lk.dirZ) / Math.max(1, d);
        if (rank === 0) {
          u.role = 'lead';
          const lead = clamp(d / 40, 0, 1.4);
          u.targetX = lk.x + lk.vx * lead;
          u.targetZ = lk.z + lk.vz * lead;
          u.targetInter = this.graph.nearestIntersection(u.targetX, u.targetZ).id;
        } else if (rank <= 2 && d < 85 && relDot < 0.45) {
          u.role = rank === 1 ? 'left' : 'right';
          const lead = clamp(d / 42, 0, 1.2);
          u.targetX = lk.x + lk.vx * lead;
          u.targetZ = lk.z + lk.vz * lead;
          u.targetInter = this.graph.nearestIntersection(u.targetX, u.targetZ).id;
        } else {
          // Interceptor: cut the player off 1.5..3.5 seconds ahead on the road grid
          u.role = 'intercept';
          const lookAhead = clamp(1.6 + (rank - 1) * 0.65, 1.5, 3.8);
          const aheadDist = Math.max(CITY.SPACING * 1.1, lk.speed * lookAhead);
          const ix = lk.x + lk.dirX * aheadDist;
          const iz = lk.z + lk.dirZ * aheadDist;
          const inter = this.graph.nearestIntersection(ix, iz);
          u.targetInter = inter.id;
          u.targetX = inter.x;
          u.targetZ = inter.z;
        }
      });
      return;
    }

    // --- SEARCH MODE (no unit has line of sight) ---
    const age = Math.max(0, now - lk.time);
    const taken = new Set<number>();

    // 1. If the exact LKP hasn't been physically checked yet, send the closest unit straight to LKP
    let lkpUnit: DirectorUnitView | null = null;
    if (!lk.lkpChecked) {
      let bestD = Infinity;
      for (const u of units) {
        const d = Math.hypot(u.x - lk.x, u.z - lk.z);
        if (d < bestD) {
          bestD = d;
          lkpUnit = u;
        }
      }
      if (lkpUnit) {
        lkpUnit.role = 'lkp';
        lkpUnit.targetInter = lk.interId;
        lkpUnit.targetX = lk.x;
        lkpUnit.targetZ = lk.z;
        taken.add(lk.interId);
      }
    }

    // 2. For all other units, assign de-conflicted search intersections fanning out from LKP
    for (const u of units) {
      if (u === lkpUnit) continue;
      u.role = 'sector';

      // Keep existing target intersection if it is still unvisited and not claimed by another unit
      const curVisited = this.visitedAt.get(u.targetInter) ?? -999;
      const distToCur =
        u.targetInter >= 0
          ? Math.hypot(
              this.graph.intersections[u.targetInter].x - u.x,
              this.graph.intersections[u.targetInter].z - u.z,
            )
          : 0;
      if (
        u.targetInter >= 0 &&
        now - curVisited > 14 &&
        distToCur > CITY.ROAD * 1.2 &&
        !taken.has(u.targetInter)
      ) {
        const I = this.graph.intersections[u.targetInter];
        u.targetX = I.x;
        u.targetZ = I.z;
        taken.add(I.id);
        continue;
      }

      const nextId = this.pickSearchIntersection(u, age, now, taken);
      const I = this.graph.intersections[nextId];
      u.targetInter = I.id;
      u.targetX = I.x;
      u.targetZ = I.z;
      taken.add(I.id);
    }
  }

  /** Score every intersection in the expanding search web around LKP and pick the best for unit `u`. */
  private pickSearchIntersection(
    u: DirectorUnitView,
    age: number,
    now: number,
    taken: Set<number>,
  ): number {
    const lk = this.lastKnown;
    const expectedDist = clamp(Math.max(22, lk.speed) * clamp(age, 1.2, 8), 75, 290);
    const maxRadius = clamp(120 + age * 28, 140, 420);

    let bestId = lk.interId;
    let bestScore = -Infinity;

    for (const I of this.graph.intersections) {
      if (I.degree < 2) continue;
      const dx = I.x - lk.x;
      const dz = I.z - lk.z;
      const dLkp = Math.hypot(dx, dz);
      if (dLkp > maxRadius) continue;

      let score = 0;

      // 1. Escape-cone alignment with player's last seen heading
      if (dLkp > 8) {
        const dot = (dx * lk.dirX + dz * lk.dirZ) / dLkp;
        score += dot * 55; // strong preference for forward escape cone
        // Side-street turnoff bonus (intersections perpendicular to the escape line)
        if (dot > -0.15 && dot < 0.55) score += 18;
      }

      // 2. Ring distance match (where the suspect could plausibly be after `age` seconds)
      const ringErr = Math.abs(dLkp - expectedDist);
      score -= ringErr * 0.32;

      // 3. Unvisited / freshness bonus (never bunch up on already-cleared intersections)
      const lastVisit = this.visitedAt.get(I.id);
      if (lastVisit !== undefined) {
        const since = now - lastVisit;
        if (since < 18) score -= 260 - since * 10;
      } else {
        score += 35;
      }

      // 4. De-confliction against other cops' assigned targets
      if (taken.has(I.id)) {
        score -= 300;
      } else {
        for (const tId of taken) {
          const T = this.graph.intersections[tId];
          if (Math.hypot(I.x - T.x, I.z - T.z) <= CITY.SPACING * 1.05) {
            score -= 85;
          }
        }
      }

      // 5. Travel efficiency for this specific cop unit
      const dUnit = Math.hypot(I.x - u.x, I.z - u.z);
      score -= dUnit * 0.18;

      if (score > bestScore) {
        bestScore = score;
        bestId = I.id;
      }
    }
    return bestId;
  }
}
