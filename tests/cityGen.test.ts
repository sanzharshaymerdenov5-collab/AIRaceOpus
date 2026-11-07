import { describe, expect, it } from 'vitest';
import { CITY, generateCity, interId } from '../src/city/CityLayout';

describe('city generation', () => {
  it('is deterministic for a seed', () => {
    const a = generateCity(42);
    const b = generateCity(42);
    expect(a.buildings).toEqual(b.buildings);
    expect(a.segments.map((s) => s.removed)).toEqual(b.segments.map((s) => s.removed));
    expect(a.props.length).toBe(b.props.length);
  });

  it('differs for different seeds', () => {
    const a = generateCity(1);
    const b = generateCity(2);
    expect(a.buildings).not.toEqual(b.buildings);
  });

  it('removes some interior segments (plazas) but never ring roads', () => {
    const c = generateCity(7);
    const removed = c.segments.filter((s) => s.removed);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((s) => !s.ring)).toBe(true);
  });

  it('lane graph is strongly connected', () => {
    for (const seed of [1, 2, 3, 1337]) {
      const { graph, intersections } = generateCity(seed);
      const reach = (start: number, dirOut: boolean) => {
        const seen = new Set([start]);
        const stack = [start];
        while (stack.length) {
          const n = stack.pop()!;
          const next = dirOut ? graph.outgoing[n].map((l) => l.to) : graph.incoming[n].map((l) => l.from);
          for (const m of next) if (!seen.has(m)) (seen.add(m), stack.push(m));
        }
        return seen.size;
      };
      expect(reach(0, true)).toBe(intersections.length);
      expect(reach(0, false)).toBe(intersections.length);
    }
  });

  it('no building overlaps a road', () => {
    const { buildings, graph } = generateCity(1337);
    for (const b of buildings) {
      for (const [ox, oz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
        [0, 0],
      ]) {
        expect(graph.onRoad(b.x + (ox * b.w) / 2, b.z + (oz * b.d) / 2)).toBe(false);
      }
    }
  });

  it('spawn point is on the road', () => {
    const c = generateCity(1337);
    expect(c.graph.onRoad(c.spawn.x, c.spawn.z)).toBe(true);
  });

  it('city spans the configured size', () => {
    const c = generateCity(1);
    const xs = c.intersections.map((i) => i.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(CITY.N * CITY.SPACING);
    expect(c.intersections[interId(CITY.N / 2, CITY.N / 2)].x).toBe(0);
  });
});
