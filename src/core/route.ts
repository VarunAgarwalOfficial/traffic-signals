import { colOf, roadNeighbours, rowOf, type World } from "./grid.ts";

/**
 * A* over road cells with the Manhattan distance as heuristic.
 * Returns the cells from start to goal, both included, or null if there is no way.
 */
export function findRoute(world: World, start: number, goal: number): number[] | null {
  if (!world.roads.has(start) || !world.roads.has(goal)) return null;
  const h = (cell: number): number =>
    Math.abs(rowOf(world, cell) - rowOf(world, goal)) +
    Math.abs(colOf(world, cell) - colOf(world, goal));

  const cameFrom = new Map<number, number>();
  const g = new Map<number, number>([[start, 0]]);
  const closed = new Set<number>();
  // The grid is small, so a sorted array is enough for the open set.
  const open: { cell: number; f: number; h: number }[] = [
    { cell: start, f: h(start), h: h(start) },
  ];

  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i]!;
      const b = open[best]!;
      if (a.f < b.f || (a.f === b.f && a.h < b.h)) best = i;
    }
    const current = open.splice(best, 1)[0]!.cell;
    if (current === goal) {
      const path = [goal];
      let cell = goal;
      while (cell !== start) {
        cell = cameFrom.get(cell)!;
        path.push(cell);
      }
      return path.reverse();
    }
    if (closed.has(current)) continue;
    closed.add(current);
    const cost = g.get(current)! + 1;
    for (const next of roadNeighbours(world, current)) {
      if (cost < (g.get(next) ?? Number.POSITIVE_INFINITY)) {
        g.set(next, cost);
        cameFrom.set(next, current);
        open.push({ cell: next, f: cost + h(next), h: h(next) });
      }
    }
  }
  return null;
}
