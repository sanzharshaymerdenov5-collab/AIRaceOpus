import { describe, expect, it } from 'vitest';
import { CITY, generateCity, interId, lineCoord } from '../src/city/CityLayout';
import { lightState } from '../src/city/TrafficLights';

const city = generateCity(1337);
const g = city.graph;

describe('road graph', () => {
  it('every live segment yields two opposite lanes', () => {
    const live = city.segments.filter((s) => !s.removed).length;
    expect(g.lanes.length).toBe(live * 2);
  });

  it('lanes keep to the right of the road centre', () => {
    for (const l of g.lanes) {
      const A = g.intersections[l.from];
      // vector from road centre line to lane start, should equal right vector * offset
      const cx = l.sx - (A.x + l.dx * (CITY.ROAD / 2));
      const cz = l.sz - (A.z + l.dz * (CITY.ROAD / 2));
      expect(cx).toBeCloseTo(-l.dz * CITY.LANE_OFFSET);
      expect(cz).toBeCloseTo(l.dx * CITY.LANE_OFFSET);
    }
  });

  it('nearestLane finds the lane under a point and respects heading', () => {
    const l = g.lanes[10];
    const px = l.sx + l.dx * 20;
    const pz = l.sz + l.dz * 20;
    const r = g.nearestLane(px, pz, l.dx, l.dz);
    expect(r.lane.id).toBe(l.id);
    expect(r.t).toBeCloseTo(20);
    expect(r.dist).toBeCloseTo(0);
    // heading the other way picks the opposite lane on the same segment
    const opp = g.nearestLane(px, pz, -l.dx, -l.dz);
    expect(opp.lane.seg).toBe(l.seg);
    expect(opp.lane.from).toBe(l.to);
  });

  it('incoming/outgoing are consistent at intersections', () => {
    for (const I of g.intersections) {
      for (const l of g.outgoing[I.id]) expect(l.from).toBe(I.id);
      for (const l of g.incoming[I.id]) expect(l.to).toBe(I.id);
      expect(g.outgoing[I.id].length).toBe(g.incoming[I.id].length);
      expect(g.outgoing[I.id].length).toBe(I.degree);
    }
  });

  it('successors never U-turn unless forced', () => {
    for (const l of g.lanes) {
      const succ = g.successors(l);
      expect(succ.length).toBeGreaterThan(0);
      if (g.outgoing[l.to].length > 1) expect(succ.every((s) => s.to !== l.from)).toBe(true);
    }
  });

  it('intersectionAt / onRoad', () => {
    const I = g.intersections[interId(6, 6)];
    expect(g.intersectionAt(I.x + 2, I.z - 3)).toBe(I.id);
    expect(g.intersectionAt(I.x + 30, I.z)).toBe(-1);
    expect(g.onRoad(I.x + 30, I.z)).toBe(true); // centre avenue is never removed
    expect(g.onRoad(lineCoord(6) + CITY.SPACING / 2, lineCoord(6) + CITY.SPACING / 2)).toBe(false); // block centre
  });

  it('traffic lights alternate between axes and never show green both ways', () => {
    const I = g.intersections.find((i) => i.hasLights)!;
    let sawX = false;
    let sawZ = false;
    for (let t = 0; t < 48; t += 0.25) {
      const x = lightState(I, 'x', t);
      const z = lightState(I, 'z', t);
      expect(x !== 'red' && z !== 'red').toBe(false);
      if (x === 'green') sawX = true;
      if (z === 'green') sawZ = true;
    }
    expect(sawX && sawZ).toBe(true);
  });
});
