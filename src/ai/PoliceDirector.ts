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
  behindInterId: number;
  aheadInterId: number;
  active: boolean;
  lkpChecked: boolean;
}

export interface DirectorUnitView {
  id: number;
  x: number;
  z: number;
  dirX?: number;
  dirZ?: number;
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
 * - When sight is lost: sends the closest unit directly through the exact LKP while converging the
 *   rest of the squad onto the LKP's immediate forward escape intersections before fanning out.
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
    behindInterId: 0,
    aheadInterId: 0,
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
    const { ahead, behind } = this.graph.aheadIntersection(x, z, lk.dirX, lk.dirZ);
    lk.interId = this.graph.nearestIntersection(x, z).id;
    lk.behindInterId = behind;
    lk.aheadInterId = ahead;
    lk.active = true;
    lk.lkpChecked = false;
    // Fresh visual contact invalidates old search marks so future searches start clean
    this.visitedAt.clear();
  }

  /** Record that a unit drove through its current area, clearing nearby intersections and exact LKP. */
  recordUnitPosition(x: number, z: number, now: number): number {
    const lk = this.lastKnown;
    const distLkp = Math.hypot(x - lk.x, z - lk.z);
    const alongEscape = (x - lk.x) * lk.dirX + (z - lk.z) * lk.dirZ;
    // Only mark LKP checked when a unit physically reaches or passes the exact LKP spot (not 12m behind it on frame 1)
    if (
      lk.active &&
      !lk.lkpChecked &&
      distLkp <= CITY.ROAD * 0.85 &&
      (distLkp <= 6.5 || (now >= lk.time + 0.35 && alongEscape >= -2.5))
    ) {
      lk.lkpChecked = true;
    }
    const I = this.graph.nearestIntersection(x, z);
    // Require the unit to be inside the intersection box (past building corners at 11 m) to clear it
    if (Math.hypot(I.x - x, I.z - z) <= CITY.ROAD * 0.85) {
      // Do not prematurely mark the LKP's own segment endpoints visited before the LKP itself is checked
      if (lk.lkpChecked || (I.id !== lk.interId && I.id !== lk.aheadInterId)) {
        this.visitedAt.set(I.id, now);
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
        const relDot = ((u.x - lk.x) * lk.dirX + (u.z - lk.z) * lk.dirZ) / Math.max(1, d);
        if (rank === 0) {
          u.role = 'lead';
          const lead = clamp(d / 40, 0, 1.3);
          u.targetX = lk.x + lk.vx * lead;
          u.targetZ = lk.z + lk.vz * lead;
          u.targetInter = this.graph.aheadIntersection(u.targetX, u.targetZ, lk.dirX, lk.dirZ).ahead;
        } else if (rank <= 2 && (d < 105 || u.seesPlayer) && relDot < 0.65) {
          u.role = rank === 1 ? 'left' : 'right';
          const lead = clamp(d / 42, 0, 1.15);
          u.targetX = lk.x + lk.vx * lead;
          u.targetZ = lk.z + lk.vz * lead;
          u.targetInter = this.graph.aheadIntersection(u.targetX, u.targetZ, lk.dirX, lk.dirZ).ahead;
        } else {
          // Interceptor: cut the player off 1.5..3.5 seconds ahead on the road grid
          u.role = 'intercept';
          const lookAhead = clamp(1.6 + (rank - 1) * 0.65, 1.5, 3.6);
          const aheadDist = clamp(Math.max(CITY.SPACING * 1.05, lk.speed * lookAhead), CITY.SPACING, 215);
          const ix = lk.x + lk.dirX * aheadDist;
          const iz = lk.z + lk.dirZ * aheadDist;
          const inter = this.graph.nearestIntersection(ix, iz);
          // If this interceptor already reached the cutoff intersection, close in toward the player's LKP intersection
          if (Math.hypot(u.x - inter.x, u.z - inter.z) < CITY.ROAD * 1.15) {
            const closeInter = this.graph.intersections[lk.aheadInterId] ?? inter;
            u.targetInter = closeInter.id;
            u.targetX = lk.x;
            u.targetZ = lk.z;
          } else {
            u.targetInter = inter.id;
            u.targetX = inter.x;
            u.targetZ = inter.z;
          }
        }
      });
      return;
    }

    // --- SEARCH MODE (no unit has line of sight) ---
    const age = Math.max(0, now - lk.time);
    const taken = new Set<number>();

    // 1. If the exact LKP hasn't been physically checked yet, send the closest unit straight through LKP
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

    // 2. Pass 1: preserve valid existing sector targets so units needing a new target never steal a teammate's active target
    const needsPick: DirectorUnitView[] = [];
    let sectorRank = 0;
    for (const u of units) {
      if (u === lkpUnit) continue;
      const wasSector = u.role === 'sector';
      u.role = 'sector';

      const curInter = u.targetInter >= 0 ? this.graph.intersections[u.targetInter] : undefined;
      const curVisited = this.visitedAt.get(u.targetInter) ?? -999;
      const distToCur = curInter ? Math.hypot(curInter.x - u.x, curInter.z - u.z) : 0;
      const distCurLkp = curInter ? Math.hypot(curInter.x - lk.x, curInter.z - lk.z) : Infinity;
      const maxKeepDist = !lk.lkpChecked || age < 3 ? CITY.SPACING * 1.15 : 230;
      if (
        wasSector &&
        curInter &&
        now - curVisited > 14 &&
        distToCur > CITY.ROAD * 0.9 &&
        distCurLkp <= maxKeepDist &&
        !taken.has(u.targetInter)
      ) {
        u.targetX = curInter.x;
        u.targetZ = curInter.z;
        taken.add(curInter.id);
        sectorRank++;
      } else {
        needsPick.push(u);
      }
    }

    // 3. Pass 2: assign fresh forward/sector intersections to units that need a new target
    for (const u of needsPick) {
      const nextId = this.pickSearchIntersection(u, age, now, taken, sectorRank++);
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
    sectorRank = 0,
  ): number {
    const lk = this.lastKnown;
    // Start tight around LKP (1 block = 94 m) while LKP is unchecked or fresh, then expand up to 215 m
    const baseDist = !lk.lkpChecked || age < 2.5
      ? CITY.SPACING
      : clamp(Math.max(18, lk.speed * 0.72) * clamp(age - 1, 1, 5), 75, 190);
    const expectedDist = clamp(baseDist + (sectorRank % 2 === 1 ? 25 : -10), 60, 210);
    const maxRadius = clamp(140 + age * 20, 155, 245);
    const ufx = u.dirX ?? lk.dirX;
    const ufz = u.dirZ ?? lk.dirZ;
    const uAhead = this.graph.aheadIntersection(u.x, u.z, ufx, ufz).ahead;
    const lkpNeighbors = new Set([
      ...this.graph.neighbors(lk.interId),
      ...this.graph.neighbors(lk.aheadInterId),
    ]);
    const unitForwardSet = new Set([uAhead, ...this.graph.neighbors(uAhead)]);

    let bestId = lk.aheadInterId;
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
        score += dot * 58; // strong preference for forward escape cone
        // Side-street turnoff bonus (intersections perpendicular to the escape line)
        if (dot > -0.15 && dot < 0.55) score += 18;
      }

      // 2. Priority on the exact intersection ahead of LKP & immediate 1-block escape branches
      if (!lk.lkpChecked || age < 7) {
        if (I.id === lk.aheadInterId) score += 80;
        if (lkpNeighbors.has(I.id)) score += 45;
      }
      // Forward continuity: prefer the intersection ahead of the unit and its connected outgoing branches (no mid-block U-turns)
      if (unitForwardSet.has(I.id)) score += 34;
      const dUnit = Math.hypot(I.x - u.x, I.z - u.z);
      if (dUnit > 8 && (u.dirX !== undefined || u.dirZ !== undefined)) {
        const uDot = ((I.x - u.x) * ufx + (I.z - u.z) * ufz) / dUnit;
        score += uDot * 24;
      }

      // 3. Ring distance match (where the suspect could plausibly be after `age` seconds)
      const ringErr = Math.abs(dLkp - expectedDist);
      score -= ringErr * 0.36;

      // 4. Unvisited / freshness bonus (never bunch up on already-cleared intersections)
      const lastVisit = this.visitedAt.get(I.id);
      if (lastVisit !== undefined) {
        const since = now - lastVisit;
        if (since < 18) score -= 260 - since * 10;
      } else {
        score += 42;
      }

      // 5. De-confliction: never assign two units to the same intersection
      if (taken.has(I.id)) {
        score -= 350;
      } else {
        for (const tId of taken) {
          // Do not repel sector units away from the LKP's own segment endpoints!
          if (tId === lk.interId || tId === lk.aheadInterId) continue;
          const T = this.graph.intersections[tId];
          if (Math.hypot(I.x - T.x, I.z - T.z) <= CITY.SPACING * 1.05) {
            score -= 35;
          }
        }
      }

      // 6. Travel efficiency for this specific cop unit
      score -= dUnit * 0.2;

      if (score > bestScore) {
        bestScore = score;
        bestId = I.id;
      }
    }
    return bestId;
  }
}
