import type { RoadGraph } from '../city/CityLayout';

/** A* over the intersection graph. Returns intersection ids from start to goal (inclusive), or null. */
export function findPath(graph: RoadGraph, start: number, goal: number): number[] | null {
  if (start === goal) return [start];
  const I = graph.intersections;
  const h = (a: number) => Math.abs(I[a].x - I[goal].x) + Math.abs(I[a].z - I[goal].z);
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  const open: { id: number; f: number }[] = [{ id: start, f: h(start) }];
  const closed = new Set<number>();
  while (open.length) {
    // small graphs (169 nodes): linear min-extraction is fine
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k].f < open[bi].f) bi = k;
    const { id } = open.splice(bi, 1)[0];
    if (id === goal) {
      const path = [id];
      let c = id;
      while (came.has(c)) {
        c = came.get(c)!;
        path.push(c);
      }
      return path.reverse();
    }
    if (closed.has(id)) continue;
    closed.add(id);
    for (const lane of graph.outgoing[id]) {
      const n = lane.to;
      if (closed.has(n)) continue;
      const cost = g.get(id)! + lane.len + 14;
      if (cost < (g.get(n) ?? Infinity)) {
        g.set(n, cost);
        came.set(n, id);
        open.push({ id: n, f: cost + h(n) });
      }
    }
  }
  return null;
}

/** Total path length in metres between intersection centres. */
export function pathLength(graph: RoadGraph, path: number[]): number {
  let d = 0;
  for (let k = 1; k < path.length; k++) {
    const a = graph.intersections[path[k - 1]];
    const b = graph.intersections[path[k]];
    d += Math.hypot(a.x - b.x, a.z - b.z);
  }
  return d;
}
