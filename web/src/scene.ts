/**
 * The scenery around the roads: named places, a river, a hill, fields and tree clumps. The
 * simulation never sees any of it. The valley town has its own; any other map, or the valley once
 * its places are edited away, gets a few tree clumps on open ground.
 */

import { drawnBounds, EMPTY, HOUSE, type Scenario } from "./scenario.ts";
import { hash } from "./town.ts";

export type PlaceKind = "school" | "station" | "market" | "park" | "farm";

export const PLACE_NAMES: Record<PlaceKind, string> = {
  school: "School",
  station: "Station",
  market: "Market",
  park: "Park",
  farm: "Farm",
};

export interface Clump {
  x: number;
  y: number;
  r: number;
  n: number;
  pine: boolean;
}

/** All positions are art pixels on the whole grid. */
export interface Scene {
  places: Map<number, PlaceKind>;
  /** The river's centre line, west to east; empty for none. */
  river: [number, number][];
  hills: { x: number; y: number; rx: number; ry: number }[];
  /** Crop: 0 wheat, 1 green, 2 ploughed, 3 meadow. */
  fields: { x0: number; y0: number; x1: number; y1: number; crop: number }[];
  clumps: Clump[];
  /** A railway running north to south at this x, or null. */
  rail: number | null;
}

/** The valley preset, in cells from the top left of what is drawn. Positions may lie outside it. */
const VALLEY = {
  cols: 21,
  rows: 13,
  places: [
    [7, 0, "school"],
    [20, 4, "station"],
    [10, 6, "market"],
    [14, 8, "park"],
    [4, 12, "farm"],
  ] as [number, number, PlaceKind][],
  river: [
    [-10, 10.5],
    [-4, 10.9],
    [1, 10.6],
    [6, 10.95],
    [10, 10.65],
    [14, 11.1],
    [18, 10.8],
    [22, 11.3],
    [30, 11.0],
  ],
  hills: [{ x: 0, y: -3, rx: 7.5, ry: 5 }],
  fields: [
    [-7, 11.6, -2, 15.5, 3],
    [-1.7, 11.6, 3.4, 12.9, 0],
    [-1.7, 13.2, 3.4, 15.5, 2],
    [6, 11.6, 11.5, 13.5, 1],
    [6, 13.8, 11.5, 16, 0],
  ],
  clumps: [
    [19.5, 0.8, 2.2, 10, false],
    [24, 6, 2, 8, false],
    [0.5, -1, 2.8, 9, true],
    [14.5, 7, 1.3, 5, false],
    [15.5, 12.5, 2.2, 7, false],
    [11, 1, 1.1, 3, false],
    [1, 7.5, 1.2, 3, false],
  ] as [number, number, number, number, boolean][],
  rail: 21.3,
};

export function sceneFor(sc: Scenario, size: number): Scene {
  const box = drawnBounds(sc);
  if (box && box.c1 - box.c0 + 1 === VALLEY.cols && box.r1 - box.r0 + 1 === VALLEY.rows) {
    const cellOf = (c: number, r: number) => (box.r0 + r) * sc.cols + box.c0 + c;
    if (VALLEY.places.every(([c, r]) => sc.cells[cellOf(c, r)] === HOUSE)) {
      const px = (c: number) => Math.round((box.c0 + c) * size);
      const py = (r: number) => Math.round((box.r0 + r) * size);
      return {
        places: new Map(VALLEY.places.map(([c, r, kind]) => [cellOf(c, r), kind])),
        river: VALLEY.river.map(([c, r]) => [px(c!), py(r!)]),
        hills: VALLEY.hills.map((h) => ({
          x: px(h.x),
          y: py(h.y),
          rx: h.rx * size,
          ry: h.ry * size,
        })),
        fields: VALLEY.fields.map(([c0, r0, c1, r1, crop]) => ({
          x0: px(c0!),
          y0: py(r0!),
          x1: px(c1!),
          y1: py(r1!),
          crop: crop!,
        })),
        clumps: VALLEY.clumps.map(([c, r, radius, n, pine]) => ({
          x: px(c),
          y: py(r),
          r: radius * size,
          n,
          pine,
        })),
        rail: px(VALLEY.rail),
      };
    }
  }
  return {
    places: new Map(),
    river: [],
    hills: [],
    fields: [],
    clumps: openClumps(sc, size),
    rail: null,
  };
}

/** Three clumps of trees on the open ground inside what is drawn, well apart. */
function openClumps(sc: Scenario, size: number): Clump[] {
  const box = drawnBounds(sc);
  if (!box) return [];
  const empty = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < sc.cols && r < sc.rows && sc.cells[r * sc.cols + c] === EMPTY;
  const open: [number, number][] = [];
  for (let r = box.r0 - 1; r <= box.r1 + 1; r++) {
    for (let c = box.c0 - 1; c <= box.c1 + 1; c++) {
      let clear = true;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) clear &&= empty(c + dc, r + dr);
      if (clear) open.push([c, r]);
    }
  }
  open.sort((p, q) => hash(p[0], p[1], 41) - hash(q[0], q[1], 41));
  const out: Clump[] = [];
  for (const [c, r] of open) {
    if (out.length >= 3) break;
    if (out.some((k) => Math.abs(k.x / size - c) + Math.abs(k.y / size - r) < 7)) continue;
    out.push({
      x: (c + 0.5) * size,
      y: (r + 0.5) * size,
      r: size * 1.2,
      n: 5,
      pine: out.length === 1,
    });
  }
  return out;
}
