import { describe, expect, it } from 'vitest';
import { RoadGraph, type Intersection, type Segment, generateCity, interId } from '../src/city/CityLayout';
import { findPath, pathLength } from '../src/ai/Pathfinder';

/** Build a tiny custom graph: a 3x1 strip of intersections plus an isolated node. */
function tinyGraph() {
  const mk = (id: number, x: number, z: number): Intersection => ({ id, i: id, j: 0, x, z, degree: 0, hasLights: false, lightOffset: 0 });
  const I = [mk(0, 0, 0), mk(1, 94, 0), mk(2, 188, 0), mk(3, 0, 500)];
  const S: Segment[] = [
    { id: 0, a: 0, b: 1, axis: 'x', removed: false, ring: false },
    { id: 1, a: 1, b: 2, axis: 'x', removed: false, ring: false },
  ];
  return new RoadGraph(I, S);
}

describe('A* pathfinder', () => {
  it('finds a straight path on a small graph', () => {
    const g = tinyGraph();
    expect(findPath(g, 0, 2)).toEqual([0, 1, 2]);
    expect(findPath(g, 2, 0)).toEqual([2, 1, 0]);
    expect(findPath(g, 1, 1)).toEqual([1]);
  });

  it('returns null for unreachable goals', () => {
    const g = tinyGraph();
    expect(findPath(g, 0, 3)).toBeNull();
  });

  it('finds Manhattan-optimal paths across the city grid', () => {
    const { graph } = generateCity(1337);
    const a = interId(0, 0);
    const b = interId(12, 12);
    const p = findPath(graph, a, b)!;
    expect(p[0]).toBe(a);
    expect(p[p.length - 1]).toBe(b);
    // ring roads are never removed -> the Manhattan distance is achievable
    expect(pathLength(graph, p)).toBeCloseTo(24 * 94);
    // consecutive nodes must be connected by a live lane
    for (let k = 1; k < p.length; k++) expect(graph.neighbors(p[k - 1])).toContain(p[k]);
  });

  it('routes around removed segments', () => {
    const { graph, segments } = generateCity(1337);
    const s = segments.find((x) => x.removed)!;
    const p = findPath(graph, s.a, s.b)!;
    expect(p.length).toBeGreaterThan(2);
  });
});
