/**
 * The city is a grid of cells. A cell is empty, a road or a house.
 * Cells are numbered row by row: index = row * cols + col.
 */
export interface World {
  cols: number;
  rows: number;
  roads: Set<number>;
  houses: Set<number>;
}

export type Axis = "ns" | "ew";

/** Neighbour offsets as [row, col]: north, east, south, west. */
const DIRS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];

export function createWorld(cols: number, rows: number): World {
  return { cols, rows, roads: new Set(), houses: new Set() };
}

export const cellAt = (world: World, row: number, col: number): number => row * world.cols + col;
export const rowOf = (world: World, cell: number): number => Math.floor(cell / world.cols);
export const colOf = (world: World, cell: number): number => cell % world.cols;

/** The up to four cells next to a cell, in the order north, east, south, west. */
export function adjacent(world: World, cell: number): number[] {
  const row = rowOf(world, cell);
  const col = colOf(world, cell);
  const out: number[] = [];
  for (const [dr, dc] of DIRS) {
    const r = row + dr;
    const c = col + dc;
    if (r >= 0 && r < world.rows && c >= 0 && c < world.cols) out.push(cellAt(world, r, c));
  }
  return out;
}

export function roadNeighbours(world: World, cell: number): number[] {
  return adjacent(world, cell).filter((n) => world.roads.has(n));
}

/** A road cell where three or four roads meet. These get a signal. */
export function isJunction(world: World, cell: number): boolean {
  return world.roads.has(cell) && roadNeighbours(world, cell).length >= 3;
}

export function junctions(world: World): number[] {
  return [...world.roads].filter((cell) => isJunction(world, cell)).sort((a, b) => a - b);
}

/** The road cell a house opens onto: the first road next to it, or null if it has none. */
export function houseAccess(world: World, house: number): number | null {
  return roadNeighbours(world, house)[0] ?? null;
}

/** Whether moving between two neighbouring cells is along the north-south or east-west axis. */
export function axisOf(world: World, from: number, to: number): Axis {
  return colOf(world, from) === colOf(world, to) ? "ns" : "ew";
}

export function toggleRoad(world: World, cell: number): void {
  if (world.houses.has(cell)) return;
  if (!world.roads.delete(cell)) world.roads.add(cell);
}

export function toggleHouse(world: World, cell: number): void {
  if (world.roads.has(cell)) return;
  if (!world.houses.delete(cell)) world.houses.add(cell);
}

/** Read a map drawn with `#` for road, `H` for house and `.` for empty. */
export function parseWorld(text: string): World {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const cols = lines[0]?.length ?? 0;
  if (cols === 0) throw new Error("the map is empty");
  const world = createWorld(cols, lines.length);
  lines.forEach((line, row) => {
    if (line.length !== cols) throw new Error(`map row ${row + 1} has a different length`);
    [...line].forEach((ch, col) => {
      if (ch === "#") world.roads.add(cellAt(world, row, col));
      else if (ch === "H") world.houses.add(cellAt(world, row, col));
      else if (ch !== ".") throw new Error(`unknown map character "${ch}" in row ${row + 1}`);
    });
  });
  return world;
}

export function formatWorld(world: World): string {
  const lines: string[] = [];
  for (let row = 0; row < world.rows; row++) {
    let line = "";
    for (let col = 0; col < world.cols; col++) {
      const cell = cellAt(world, row, col);
      line += world.roads.has(cell) ? "#" : world.houses.has(cell) ? "H" : ".";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
