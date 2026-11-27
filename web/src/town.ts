/**
 * The town as pixel art: one art pixel is one metre, so a 20 m cell is 20 art pixels and a car
 * sits on the map exactly where the simulation puts it. The ground, roads, houses, places and
 * shadows are painted once into a still layer; trees, walkers, smoke and the cat are sprites drawn
 * each frame. The ground stays calm on purpose: the cars and the signals are the story.
 */

import { makeCanvas, PALETTE as P, sprite } from "./pixel.ts";
import { HOUSE, ROAD, type Scenario } from "./scenario.ts";
import { PLACE_NAMES, type PlaceKind, sceneFor } from "./scene.ts";

/** What is under each art pixel, for shadows and for placing trees and walkers. */
const GRASS = 0;
const TARMAC = 1;
const KERB = 2;
const PAVEMENT = 3;
const BUILDING = 4;
const BLOCKED = 5;
const WATER = 6;
const FIELD = 7;
const BRIDGE = 8;
const PAVED = 9;
const RAIL = 10;

const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Colour as the 32-bit word ImageData holds on little-endian machines. */
const word = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
};

/** One step darker, for shadows: every ground colour maps to another palette colour. */
const SHADE = new Map<number, number>(
  (
    [
      [P.meadow, P.meadowMid],
      [P.meadowSoft, P.meadow],
      [P.meadowMid, P.leaf],
      [P.leaf, P.meadowDeep],
      [P.road, P.roadDark],
      [P.roadDark, P.stone4],
      [P.stone1, P.stone2],
      [P.stone2, P.stone3],
      [P.stone3, P.stone4],
      [P.stone4, P.roadDark],
      [P.plate, P.stone2],
      [P.butter, P.wood1],
      [P.wood1, P.wood2],
      [P.wood2, P.wood3],
      [P.wood3, P.wood4],
      [P.blue, P.blueMid],
      [P.blueSoft, P.blue],
      [P.blueMid, P.blueDeep],
    ] as const
  ).map(([a, b]) => [word(a), word(b)]),
);

/** A cheap, stable hash of two integers to [0, 1). */
export const hash = (x: number, y: number, seed = 0): number => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Smooth value noise on a lattice of `size` pixels. */
const noise = (x: number, y: number, size: number, seed: number): number => {
  const gx = Math.floor(x / size);
  const gy = Math.floor(y / size);
  const fx = x / size - gx;
  const fy = y / size - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(gx, gy, seed);
  const b = hash(gx + 1, gy, seed);
  const c = hash(gx, gy + 1, seed);
  const d = hash(gx + 1, gy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
};

const pixelCache = new WeakMap<HTMLCanvasElement, Uint32Array>();
const pixelsOf = (img: HTMLCanvasElement): Uint32Array => {
  let data = pixelCache.get(img);
  if (!data) {
    const g = img.getContext("2d")!;
    data = new Uint32Array(g.getImageData(0, 0, img.width, img.height).data.buffer);
    pixelCache.set(img, data);
  }
  return data;
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dots = (x: number, y: number, level: number): boolean =>
  level * 16 > BAYER[(y & 3) * 4 + (x & 3)]! + 0.5;

// ----- buildings -----

/** Roof colours: highlight, slope, shaded side. No purple: the blush roof shades to peach. */
const ROOFS = [
  [P.peach, P.peachMid, P.peachDeep],
  [P.blue, P.blueMid, P.blueDeep],
  [P.mint, P.mintMid, P.mintDeep],
  [P.butter, P.sunflowerMid, P.sunflowerDeep],
  [P.blush, P.blushMid, P.peachDeep],
] as const;
const WALLS = [P.plate, P.peachSoft, P.butter, P.blueSoft] as const;
const DOORS = [P.wood4, P.blueDeep, P.mintDeep, P.peachDeep] as const;

interface Look {
  w: number;
  roof: number;
  storeys: 1 | 2;
  roofs: readonly [string, string, string];
  wall: string;
  door: string;
  trim?: string;
  flowers?: boolean;
  /** A door this wide; 3 by default. */
  doorWidth?: number;
  barn?: boolean;
}

/**
 * A building seen from above and a little in front: a tiled roof lit from the top left, then the
 * front wall with framed windows, a framed door and a step.
 */
function building(l: Look): HTMLCanvasElement {
  const wallH = l.storeys === 2 ? 11 : 7;
  const H = l.roof + wallH;
  const c = makeCanvas(l.w, H);
  const g = c.getContext("2d")!;
  const rect = (x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  const [hi, mid, sh] = l.roofs;
  const trim = l.trim ?? P.wood5;
  // Roof: ink outline with rounded top corners, a lit ridge, tile courses, a shaded right end.
  rect(2, 0, l.w - 4, 1, P.ink);
  rect(1, 1, 1, 1, P.ink);
  rect(l.w - 2, 1, 1, 1, P.ink);
  rect(2, 1, l.w - 4, 1, hi);
  for (let y = 2; y < l.roof - 1; y++) {
    rect(0, y, 1, 1, P.ink);
    rect(l.w - 1, y, 1, 1, P.ink);
    for (let x = 1; x < l.w - 1; x++) {
      let col = mid;
      if (y % 2 === 0 && (x + y) % 3 === 0) col = sh;
      if (x === 1 && y < l.roof - 2) col = hi;
      if (x >= l.w - 3) col = sh;
      rect(x, y, 1, 1, col);
    }
  }
  rect(0, l.roof - 1, l.w, 1, P.ink);
  // Wall: eave shadow, the wall, a shaded right edge and a footing.
  const top = l.roof;
  rect(1, top, l.w - 2, wallH, l.wall);
  rect(1, top, l.w - 2, 1, P.stone3);
  rect(l.w - 2, top + 1, 1, wallH - 2, P.stone2);
  rect(1, top + wallH - 1, l.w - 2, 1, P.stone3);
  // Door, centred, in a frame, with a knob and a step.
  const dw = l.doorWidth ?? 3;
  const dx = Math.floor((l.w - dw) / 2);
  const doorTop = top + wallH - 6;
  if (l.barn) {
    rect(dx - 1, doorTop - 1, dw + 2, 6, P.plate);
    rect(dx, doorTop, dw, 5, l.door);
    for (let k = 0; k < Math.min(dw, 5); k++) {
      rect(dx + Math.round((k * (dw - 1)) / 4), doorTop + k, 1, 1, P.plate);
      rect(dx + dw - 1 - Math.round((k * (dw - 1)) / 4), doorTop + k, 1, 1, P.plate);
    }
  } else {
    rect(dx - 1, doorTop, dw + 2, 5, trim);
    rect(dx, doorTop + 1, dw, 4, l.door);
    rect(dx + dw - 1, doorTop + 3, 1, 1, P.sunflower);
    rect(dx, top + wallH - 1, dw, 1, P.stone1);
  }
  // Windows: a frame round four panes, the top left pane catching the light, a flower box below.
  const window = (x: number, y: number, flowers: boolean) => {
    rect(x, y, 4, 4, trim);
    rect(x + 1, y + 1, 1, 1, P.blueSoft);
    rect(x + 2, y + 1, 1, 1, P.blue);
    rect(x + 1, y + 2, 1, 1, P.blue);
    rect(x + 2, y + 2, 1, 1, P.blueMid);
    if (!flowers) return;
    rect(x, y + 4, 4, 1, P.leaf);
    rect(x + 1, y + 4, 1, 1, P.blushMid);
    rect(x + 3, y + 4, 1, 1, P.sunflower);
  };
  const row = (y: number, aroundDoor: boolean, flowers: boolean) => {
    const left = aroundDoor ? dx - 2 : l.w - 2;
    for (let x = 2; x + 4 <= left; x += 6) {
      window(x, y, flowers);
      if (aroundDoor || x + 10 <= l.w - 2) window(l.w - 2 - (x - 2) - 4, y, flowers);
      if (!aroundDoor && x + 10 > l.w - 2) break;
    }
  };
  if (!l.barn) {
    if (l.storeys === 2) row(top + 1, false, false);
    row(doorTop, true, l.flowers === true);
  }
  return c;
}

export type HouseKind = "cottage" | "house" | "long" | "tall";
const HOUSE_SIZES: Record<HouseKind, { w: number; roof: number; storeys: 1 | 2 }> = {
  cottage: { w: 12, roof: 7, storeys: 1 },
  house: { w: 16, roof: 8, storeys: 1 },
  long: { w: 18, roof: 8, storeys: 1 },
  tall: { w: 14, roof: 7, storeys: 2 },
};

const houseCache = new Map<string, HTMLCanvasElement>();

/**
 * The art for a house or a place. This is the swap point for the shared house set: when it lands,
 * return its sprites here and keep the same sizes, about 12 to 36 by 14 to 20 art pixels.
 */
export function houseArt(kind: HouseKind | PlaceKind, variant: number): HTMLCanvasElement {
  const key = `${kind}:${variant}`;
  const hit = houseCache.get(key);
  if (hit) return hit;
  const pick = <T>(list: readonly T[], n: number) => list[n % list.length]!;
  let look: Look;
  if (kind === "school") {
    look = {
      w: 36,
      roof: 9,
      storeys: 2,
      roofs: ROOFS[0],
      wall: P.butter,
      door: P.blueDeep,
      doorWidth: 4,
      trim: P.wood5,
    };
  } else if (kind === "station") {
    look = {
      w: 18,
      roof: 8,
      storeys: 1,
      roofs: ROOFS[2],
      wall: P.plate,
      door: P.mintDeep,
      doorWidth: 4,
      trim: P.mintDeep,
    };
  } else if (kind === "market") {
    look = {
      w: 18,
      roof: 8,
      storeys: 1,
      roofs: ROOFS[3],
      wall: P.plate,
      door: P.peachDeep,
      doorWidth: 4,
    };
  } else if (kind === "farm") {
    look = {
      w: 20,
      roof: 8,
      storeys: 1,
      roofs: ROOFS[0],
      wall: P.wood3,
      door: P.wood5,
      doorWidth: 6,
      barn: true,
    };
  } else if (kind === "park") {
    look = { w: 12, roof: 6, storeys: 1, roofs: ROOFS[2], wall: P.plate, door: P.mintDeep };
  } else {
    look = {
      ...HOUSE_SIZES[kind],
      roofs: pick(ROOFS, variant),
      wall: pick(WALLS, variant >> 2),
      door: pick(DOORS, variant >> 1),
      flowers: (variant & 1) === 0,
    };
  }
  const art = building(look);
  houseCache.set(key, art);
  return art;
}

const CHIMNEY_ROWS = ["pp", "cC", "cC"];
const BELL_ROWS = ["..dd..", ".dhhd.", "dhhhsd", "dPyyPd", "dPyyPd", "dddddd"];
const STALL_ROWS = ["aAaAaAa", "aAaAaAa", "aAaAaAa", "A.A.A.A", ".bgybg."];

/** A round tree, two frames: the crown leans one pixel in the second. */
const TREE_ROWS = [
  "...ooooo...",
  "..oMMMMlo..",
  ".oMMhMMllo.",
  "oMMhhMMlllo",
  "oMMMMMllllo",
  "olMMMllllso",
  "ollllllsso.",
  ".olsllssso.",
  "..oooooo...",
  "....tT.....",
  "....tT.....",
];
const TREE_KEY = {
  o: P.meadowDeep,
  M: P.meadowMid,
  h: P.meadow,
  l: P.leaf,
  s: P.meadowDeep,
  t: P.wood4,
  T: P.wood6,
};
const leaned = TREE_ROWS.map((row, y) => (y < 4 ? `.${row.slice(0, -1)}` : row));

/** A smaller tree with a pointed crown. */
const PINE_ROWS = [
  "...o...",
  "..oMo..",
  "..Mls..",
  ".oMlso.",
  ".Mllss.",
  "oMllsso",
  "ooooooo",
  "...T...",
];
const pineLeaned = PINE_ROWS.map((row, y) => (y < 3 ? `.${row.slice(0, -1)}` : row));

/** A duck on the water, facing right and facing left. */
const DUCK_RIGHT = ["..hb", "www.", ".ss."];
const DUCK_LEFT = ["bh..", ".www", ".ss."];

/** Walkers: hair, face, shirt, legs; two frames for the step. */
const WALKER_A = [".a.", ".f.", "bbb", ".b.", "l.l"];
const WALKER_B = [".a.", ".f.", "bbb", ".b.", ".l."];
const HAIR = [P.ink, P.wood5, P.sunflowerDeep, P.peachDeep] as const;
const SHIRTS = [P.blueMid, P.blushMid, P.mintMid, P.sunflower, P.peachMid, P.plate] as const;

/** The cat on a roof: sitting, two frames for the tail and one for a blink. */
const CAT_ROWS = ["c.c...", "ccc...", "ece..t", ".cccct", ".cc.cc"];
const CAT_TAIL = ["c.c...", "ccc..t", "ece..t", ".cccc.", ".cc.cc"];
const CAT_BLINK = ["c.c...", "ccc...", "ccc..t", ".cccct", ".cc.cc"];

export interface Walker {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  length: number;
  phase: number;
  frames: [HTMLCanvasElement, HTMLCanvasElement];
}

export interface Tree {
  x: number;
  y: number;
  frames: [HTMLCanvasElement, HTMLCanvasElement];
  phase: number;
}

export interface Chimney {
  x: number;
  y: number;
  phase: number;
}

export interface Duck {
  x0: number;
  y: number;
  length: number;
  phase: number;
}

/** A place's name, anchored in art pixels; drawn in screen space in a readable font. */
export interface PlaceLabel {
  name: string;
  x: number;
  y: number;
  align: "center" | "right" | "left";
}

export interface Town {
  ducks: Duck[];
  still: HTMLCanvasElement;
  trees: Tree[];
  walkers: Walker[];
  chimneys: Chimney[];
  cat: { x: number; y: number; frames: HTMLCanvasElement[] } | null;
  places: PlaceLabel[];
  /** The cells of the named places, which are not plain houses. */
  placeCells: Set<number>;
}

let spriteCache: {
  tree: [HTMLCanvasElement, HTMLCanvasElement];
  pine: [HTMLCanvasElement, HTMLCanvasElement];
  duck: [HTMLCanvasElement, HTMLCanvasElement];
  chimney: HTMLCanvasElement;
  bell: HTMLCanvasElement;
  stalls: HTMLCanvasElement[];
  walkers: [HTMLCanvasElement, HTMLCanvasElement][];
  cat: HTMLCanvasElement[];
} | null = null;

function sprites() {
  if (spriteCache) return spriteCache;
  const walkers: [HTMLCanvasElement, HTMLCanvasElement][] = [];
  for (let i = 0; i < 12; i++) {
    const key = {
      a: HAIR[i % HAIR.length]!,
      f: P.peach,
      b: SHIRTS[(i * 5) % SHIRTS.length]!,
      l: i % 3 === 0 ? P.blueDeep : P.ink,
    };
    walkers.push([sprite(WALKER_A, key), sprite(WALKER_B, key)]);
  }
  const catKey = { c: P.ink, e: P.sunflower, t: P.ink };
  const goods = { b: P.peachMid, g: P.mintMid, y: P.sunflower };
  spriteCache = {
    tree: [sprite(TREE_ROWS, TREE_KEY), sprite(leaned, TREE_KEY)],
    pine: [sprite(PINE_ROWS, TREE_KEY), sprite(pineLeaned, TREE_KEY)],
    duck: [
      sprite(DUCK_RIGHT, { h: P.mintDeep, b: P.sunflower, w: P.plate, s: P.blueMid }),
      sprite(DUCK_LEFT, { h: P.mintDeep, b: P.sunflower, w: P.plate, s: P.blueMid }),
    ],
    chimney: sprite(CHIMNEY_ROWS, { p: P.ink, c: P.stone2, C: P.stone4 }),
    bell: sprite(BELL_ROWS, {
      d: P.ink,
      h: P.peachMid,
      s: P.peachDeep,
      P: P.plate,
      y: P.sunflower,
    }),
    stalls: [P.blushMid, P.mintMid, P.sunflowerMid, P.blueMid].map((A) =>
      sprite(STALL_ROWS, { a: P.plate, A, ...goods }),
    ),
    walkers,
    cat: [sprite(CAT_ROWS, catKey), sprite(CAT_TAIL, catKey), sprite(CAT_BLINK, catKey)],
  };
  return spriteCache;
}

/** Which neighbours of a cell are road: north, east, south, west. */
export function arms(sc: Scenario, cell: number): boolean[] {
  const c = cell % sc.cols;
  const r = Math.floor(cell / sc.cols);
  return DIRS.map(([dx, dy]) => {
    const cc = c + dx;
    const rr = r + dy;
    return (
      cc >= 0 && rr >= 0 && cc < sc.cols && rr < sc.rows && sc.cells[rr * sc.cols + cc] === ROAD
    );
  });
}

/**
 * Paint the still layer of the town at one art pixel per metre. `connected` holds the house cells
 * a road reaches; the others are drawn as empty plots.
 */
export function paintTown(sc: Scenario, size: number, connected: Set<number> | null): Town {
  const S = sprites();
  const scene = sceneFor(sc, size);
  const W = sc.cols * size;
  const H = sc.rows * size;
  const kind = new Uint8Array(W * H);
  const half = size / 2;
  const rw = 4; // half the road's width: 8 m, near the core's 8.6 m.
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;

  // Roads: a square at the middle of each road cell and an arm to each road neighbour.
  const fill = (x0: number, y0: number, x1: number, y1: number, k: number) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) kind[y * W + x] = k;
    }
  };
  const roadCells: number[] = [];
  for (let i = 0; i < sc.cells.length; i++) {
    if (sc.cells[i] !== ROAD) continue;
    roadCells.push(i);
    const x = (i % sc.cols) * size;
    const y = Math.floor(i / sc.cols) * size;
    const cx = x + half;
    const cy = y + half;
    fill(cx - rw, cy - rw, cx + rw, cy + rw, TARMAC);
    const a = arms(sc, i);
    if (a[0]) fill(cx - rw, y, cx + rw, cy, TARMAC);
    if (a[1]) fill(cx, cy - rw, x + size, cy + rw, TARMAC);
    if (a[2]) fill(cx - rw, cy, cx + rw, y + size, TARMAC);
    if (a[3]) fill(x, cy - rw, cx, cy + rw, TARMAC);
    // Bends: round the outside corner and fill the inside one, as the cars drive them.
    const open = a.flatMap((on, d) => (on ? [d] : []));
    if (open.length === 2 && (open[0]! + open[1]!) % 2 === 1) {
      const sx = a[1] ? 1 : -1;
      const sy = a[2] ? 1 : -1;
      for (let k = 0; k < 3; k++) {
        for (let j = 0; j < 3 - k; j++) {
          const ox = cx - sx * (rw - k) - (sx > 0 ? 0 : 1);
          const oy = cy - sy * (rw - j) - (sy > 0 ? 0 : 1);
          kind[oy * W + ox] = GRASS;
          const ix = cx + sx * (rw + k) - (sx > 0 ? 0 : 1);
          const iy = cy + sy * (rw + j) - (sy > 0 ? 0 : 1);
          if (inside(ix, iy)) kind[iy * W + ix] = TARMAC;
        }
      }
    }
  }
  // Kerb, then two pixels of pavement, around every road.
  const ring = (from: number, to: number) => {
    const next: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (kind[y * W + x] !== GRASS) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (inside(xx, yy) && kind[yy * W + xx] === from) {
              near = true;
              break;
            }
          }
        }
        if (near) next.push(y * W + x);
      }
    }
    for (const i of next) kind[i] = to;
  };
  const OUTER = 99;
  ring(TARMAC, KERB);
  ring(KERB, PAVEMENT);
  ring(PAVEMENT, OUTER);

  const buf = new Uint32Array(W * H);
  const C = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, word(v)])) as Record<
    keyof typeof P,
    number
  >;
  const put = (x: number, y: number, c: number, k?: number) => {
    if (!inside(x, y)) return;
    buf[y * W + x] = c;
    if (k !== undefined) kind[y * W + x] = k;
  };
  /** Paint onto open grass only, so roads and buildings are never covered. */
  const onGrass = (x: number, y: number, c: number, k = GRASS) => {
    if (inside(x, y) && kind[y * W + x] === GRASS) put(x, y, c, k);
  };

  // Ground: plain road with the kerb's shade, plain pavement, and grass with a few faint patches.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const k = kind[i];
      let c: number;
      if (k === TARMAC) {
        const up = y > 0 ? kind[i - W] : 0;
        const left = x > 0 ? kind[i - 1] : 0;
        c = up === KERB || left === KERB ? C.roadDark : C.road;
      } else if (k === KERB) {
        c = C.stone2;
      } else if (k === PAVEMENT || k === OUTER) {
        c = C.stone1;
      } else {
        const n = noise(x, y, 56, 3);
        c = n > 0.82 && dots(x, y, 0.25) ? C.meadowSoft : C.meadow;
      }
      buf[i] = c;
    }
  }

  // A hill: three contour lines, nothing else, so it stays quiet.
  for (const h of scene.hills) {
    for (let y = Math.floor(h.y - h.ry); y <= h.y + h.ry; y++) {
      for (let x = Math.floor(h.x - h.rx); x <= h.x + h.rx; x++) {
        const band = (px: number, py: number) =>
          Math.floor(Math.sqrt(((px - h.x) / h.rx) ** 2 + ((py - h.y) / h.ry) ** 2) * 3);
        const b = band(x, y);
        if (b >= 3) continue;
        if (b !== band(x + 1, y) || b !== band(x, y + 1)) onGrass(x, y, C.meadowMid);
      }
    }
  }

  // Fields: rows of crop inside a hedge line.
  for (const f of scene.fields) {
    for (let y = f.y0; y < f.y1; y++) {
      for (let x = f.x0; x < f.x1; x++) {
        const edge = x === f.x0 || y === f.y0 || x === f.x1 - 1 || y === f.y1 - 1;
        let c: number;
        if (edge) c = C.leaf;
        else if (f.crop === 0) c = (y - f.y0) % 3 === 0 ? C.wood1 : C.butter;
        else if (f.crop === 1) c = (x - f.x0) % 3 === 0 ? C.leaf : C.meadowMid;
        else if (f.crop === 2) c = (y - f.y0) % 2 === 0 ? C.wood3 : C.wood2;
        else c = (y - f.y0) % 4 === 0 ? C.meadowMid : C.meadow;
        onGrass(x, y, c, FIELD);
      }
    }
  }

  // The river: banks, water, the bank's shade on the water, a few glints. A road over it is a
  // bridge with a parapet each side.
  const ducks: Duck[] = [];
  if (scene.river.length > 1) {
    const centre = (x: number): number => {
      const pts = scene.river;
      let k = 0;
      while (k < pts.length - 2 && pts[k + 1]![0] < x) k++;
      const [x0, y0] = pts[k]!;
      const [x1, y1] = pts[k + 1]!;
      const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
      return y0 + (y1 - y0) * (t * t * (3 - 2 * t)) + Math.round(Math.sin(x / 19) * 1.5);
    };
    for (let x = 0; x < W; x++) {
      const yc = centre(x);
      const hw = 7 + Math.round(noise(x, 0, 40, 5) * 2);
      for (let y = Math.floor(yc - hw); y <= yc + hw; y++) {
        if (!inside(x, y)) continue;
        const i = y * W + x;
        const d = Math.abs(y - yc);
        const k = kind[i];
        if (k === TARMAC) continue;
        if (k === KERB || k === PAVEMENT || k === OUTER) {
          put(x, y, k === OUTER ? C.plate : C.stone2, BRIDGE);
          continue;
        }
        if (k !== GRASS) continue;
        let c = C.blue;
        if (d > hw - 1.5) c = C.stone2;
        else if (y < yc && d > hw - 3.5) c = C.blueMid;
        else if (d < hw - 4 && (x * 7 + y * 13) % 29 === 0) c = C.blueSoft;
        put(x, y, c, d > hw - 1.5 ? BLOCKED : WATER);
      }
    }
    for (const fx of [0.36, 0.62]) {
      const x0 = Math.round(
        scene.river[0]![0] + fx * (scene.river.at(-1)![0] - scene.river[0]![0]),
      );
      ducks.push({ x0, y: Math.round(centre(x0 + 4)) - 1, length: 8, phase: Math.round(fx * 40) });
    }
  }
  for (let i = 0; i < kind.length; i++) if (kind[i] === OUTER) kind[i] = PAVEMENT;

  // The railway: ballast, sleepers and two rails, with the station platform beside it.
  if (scene.rail !== null) {
    const rx = scene.rail;
    for (let y = 0; y < H; y++) {
      for (let x = rx - 5; x <= rx + 5; x++) {
        if (!inside(x, y)) continue;
        const k = kind[y * W + x];
        if (k !== GRASS && k !== WATER && k !== FIELD && k !== BLOCKED) continue;
        let c = Math.abs(x - rx) === 5 ? C.stone3 : C.stone2;
        if (Math.abs(x - rx) <= 4 && y % 3 === 0) c = C.wood4;
        if (Math.abs(x - rx) === 2) c = C.stone4;
        put(x, y, c, RAIL);
      }
    }
  }

  // Under a bridge or the railway the water is in shade, to the right of it.
  for (let y = 0; y < H; y++) {
    for (let x = 2; x < W; x++) {
      const i = y * W + x;
      if (kind[i] !== WATER) continue;
      const l1 = kind[i - 1];
      const l2 = kind[i - 2];
      if (l1 === BRIDGE || l1 === RAIL || l2 === BRIDGE || l2 === RAIL) buf[i] = C.blueMid;
    }
  }

  // Road markings: a dashed centre line on straight roads, crossings at junctions.
  for (const i of roadCells) {
    const x = (i % sc.cols) * size;
    const y = Math.floor(i / sc.cols) * size;
    const a = arms(sc, i);
    const count = a.filter(Boolean).length;
    if (count >= 3) {
      for (let d = 0; d < 4; d++) {
        if (!a[d]) continue;
        for (let t = -rw; t < rw; t += 2) {
          for (let s = 0; s < 2; s++) {
            const along = rw + s; // between the stop line and the junction box
            if (d === 0) put(x + half + t, y + half - along - 1, C.plate);
            if (d === 2) put(x + half + t, y + half + along, C.plate);
            if (d === 3) put(x + half - along - 1, y + half + t, C.plate);
            if (d === 1) put(x + half + along, y + half + t, C.plate);
          }
        }
      }
    } else if ((a[1] || a[3]) && !(a[0] || a[2])) {
      for (let px = x; px < x + size; px++) if (px % 6 < 3) put(px, y + half, C.butter);
    } else if ((a[0] || a[2]) && !(a[1] || a[3])) {
      for (let py = y; py < y + size; py++) if (py % 6 < 3) put(x + half, py, C.butter);
    }
  }

  // Shadows, then the things that cast them.
  const shadow = (px: number, py: number) => {
    if (!inside(px, py)) return;
    const i = py * W + px;
    if (kind[i] === BUILDING) return;
    const dark = SHADE.get(buf[i]!);
    if (dark !== undefined) buf[i] = dark;
  };
  const stamp = (img: HTMLCanvasElement, px: number, py: number, k = BUILDING) => {
    const data = pixelsOf(img);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const v = data[y * img.width + x]!;
        if (v >>> 24 === 0) continue;
        put(px + x, py + y, v, k);
      }
    }
  };
  /** A building with its shadow two pixels right and below: light from the top left. */
  const raise = (img: HTMLCanvasElement, x: number, y: number) => {
    for (let yy = 2; yy < img.height + 2; yy++)
      for (let xx = 0; xx < 2; xx++) shadow(x + img.width + xx, y + yy);
    for (let xx = 2; xx < img.width; xx++)
      for (let yy = 0; yy < 2; yy++) shadow(x + xx, y + img.height + yy);
    stamp(img, x, y);
  };
  const area = (
    x0: number,
    y0: number,
    w: number,
    h: number,
    colour: (x: number, y: number) => number,
    k: number,
  ) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) onGrass(x, y, colour(x, y), k);
  };
  /** A paved path, which may cross a field or a lawn but never a road or a building. */
  const path = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!inside(x, y)) continue;
        const k = kind[y * W + x];
        if (k === GRASS || k === FIELD) put(x, y, (x + y) % 4 === 0 ? C.stone2 : C.stone1, PAVED);
      }
    }
  };

  const chimneys: Chimney[] = [];
  const places: Town["places"] = [];
  let cat: Town["cat"] = null;
  const plots: number[] = [];
  for (let i = 0; i < sc.cells.length; i++) {
    if (sc.cells[i] !== HOUSE) continue;
    const cx = (i % sc.cols) * size;
    const cy = Math.floor(i / sc.cols) * size;
    if (connected && !connected.has(i)) {
      plots.push(i);
      continue;
    }
    const place = scene.places.get(i);
    if (place) {
      paintPlace(place, cx, cy);
      continue;
    }
    const a = arms(sc, i);
    const sizes: HouseKind[] = ["house", "cottage", "long", "tall", "house"];
    const art = houseArt(
      sizes[Math.floor(hash(i, 4, 5) * sizes.length)]!,
      Math.floor(hash(i, 1, 5) * 40),
    );
    const x = cx + Math.floor((size - art.width) / 2);
    const y = cy + size - 2 - art.height;
    const doorX = x + Math.floor(art.width / 2);
    // A path from the door to the road.
    if (a[2]) path(doorX - 1, y + art.height, 2, size);
    else if (a[1]) path(doorX - 1, y + art.height, cx + size + 4 - doorX, 2);
    else if (a[3]) path(cx - 4, y + art.height, doorX + 1 - (cx - 4), 2);
    else if (a[0]) {
      path(cx + 1, cy - 4, 2, size);
      path(cx + 1, y + art.height, doorX - cx, 2);
    }
    raise(art, x, y);
    if (hash(i, 2, 5) < 0.5) {
      const ch = x + art.width - 6;
      stamp(S.chimney, ch, y);
      chimneys.push({ x: ch, y: y - 1, phase: Math.floor(hash(i, 3, 5) * 12) });
    } else if (!cat) {
      cat = { x: x + 3, y: y - 3, frames: S.cat };
    }
  }

  /** The named places: each has a building and the ground that says what it is. */
  function paintPlace(place: PlaceKind, cx: number, cy: number) {
    const name = PLACE_NAMES[place];
    if (place === "school") {
      const art = houseArt("school", 0);
      const x = cx + half - art.width / 2;
      // A playground behind, with a court marked on it, and a flag.
      area(
        x - 8,
        cy - 18,
        art.width + 16,
        18,
        (px, py) => ((px + py) % 9 === 0 ? C.stone2 : C.stone1),
        PAVED,
      );
      for (let t = 0; t < 22; t++) {
        put(x + 6 + t, cy - 14, C.butter);
        put(x + 6 + t, cy - 4, C.butter);
      }
      for (let t = 0; t < 10; t++) {
        put(x + 6, cy - 14 + t, C.butter);
        put(x + 27, cy - 14 + t, C.butter);
        put(x + 16, cy - 14 + t, C.butter);
      }
      raise(art, x, cy);
      stamp(S.bell, x + art.width / 2 - 3, cy - 4);
      for (let t = 0; t < 12; t++) put(x - 5, cy + 16 - t, C.ink);
      for (let t = 0; t < 15; t++)
        put(x - 4 + (t % 5), cy + 5 + Math.floor(t / 5), C.blushMid, BLOCKED);
      places.push({ name, x: x + art.width + 4, y: cy + 10, align: "left" });
    } else if (place === "station") {
      const art = houseArt("station", 0);
      const x = cx - 1;
      const y = cy + size - 2 - art.height;
      // The platform between the building and the railway, with its yellow edge line.
      if (scene.rail !== null) {
        const px0 = x + art.width;
        for (let py = cy - 2 * size; py < cy + 3 * size; py++) {
          for (let px = px0; px < scene.rail - 5; px++) {
            const edge = px === scene.rail - 6;
            const line = px === scene.rail - 7;
            put(px, py, edge ? C.plate : line ? C.sunflower : C.stone1, PAVED);
          }
        }
      }
      raise(art, x, y);
      // A clock on the roof.
      const kx = x + art.width / 2 - 2;
      for (const [dx, dy, c] of [
        [1, 0, C.ink],
        [2, 0, C.ink],
        [0, 1, C.ink],
        [3, 1, C.ink],
        [0, 2, C.ink],
        [3, 2, C.ink],
        [1, 3, C.ink],
        [2, 3, C.ink],
        [1, 1, C.plate],
        [2, 1, C.ink],
        [1, 2, C.plate],
        [2, 2, C.plate],
      ] as const) {
        put(kx + dx, y + 2 + dy, c);
      }
      places.push({ name, x: x - 3, y: cy - 4, align: "right" });
    } else if (place === "market") {
      // A paved square with stalls round the hall.
      area(
        cx - 12,
        cy - 18,
        2 * size + 8,
        3 * size - 2,
        (px, py) => (px % 6 === 0 || py % 6 === 0 ? C.stone2 : C.stone1),
        PAVED,
      );
      const art = houseArt("market", 0);
      raise(art, cx + 1, cy + size - 2 - art.height);
      const stalls: [number, number][] = [
        [cx - 9, cy - 15],
        [cx + 22, cy - 15],
        [cx - 9, cy + 14],
        [cx + 22, cy + 14],
        [cx + 22, cy + 1],
      ];
      for (const [n, [sx, sy]] of stalls.entries()) raise(S.stalls[n % S.stalls.length]!, sx, sy);
      places.push({ name, x: cx + half + 1, y: cy - 20, align: "center" });
    } else if (place === "park") {
      // A pale lawn with a ring path, a fountain, benches and a gate to the road.
      area(
        cx - size,
        cy - 2 * size,
        3 * size,
        2 * size + 1,
        (px, py) => (dots(px, py, 0.25) ? C.meadow : C.meadowSoft),
        GRASS,
      );
      const fx = cx + half;
      const fy = cy - size + 2;
      for (let y = fy - 14; y <= fy + 14; y++) {
        for (let x = fx - 20; x <= fx + 20; x++) {
          const e = ((x - fx) / 18) ** 2 + ((y - fy) / 12) ** 2;
          if (e > 0.82 && e <= 1.12) path(x, y, 1, 1);
          const f = (x - fx) ** 2 + (y - fy) ** 2;
          if (f <= 20) put(x, y, f <= 9 ? (f <= 1 ? C.plate : C.blue) : C.stone2, BLOCKED);
        }
      }
      path(fx - 1, fy + 12, 2, cy + size + 4 - (fy + 12));
      for (const [bx, by] of [
        [fx - 8, fy - 9],
        [fx + 5, fy + 8],
      ] as const) {
        for (let t = 0; t < 4; t++) {
          put(bx + t, by, C.wood4, BLOCKED);
          shadow(bx + t + 1, by + 1);
        }
      }
      places.push({ name, x: fx, y: cy - 2 * size + 2, align: "center" });
    } else {
      // The farm: a barn and a silo in a dirt yard.
      area(
        cx - 10,
        cy - 1,
        size + 22,
        size + 2,
        (px, py) => (hash(px, py, 71) < 0.08 ? C.wood2 : C.wood1),
        PAVED,
      );
      const art = houseArt("farm", 0);
      raise(art, cx, cy + size - 2 - art.height + 1);
      const sx = cx + size + 6;
      const sy = cy + 7;
      for (let y = -5; y <= 5; y++) {
        for (let x = -5; x <= 5; x++) {
          const d = x * x + y * y;
          if (d > 26) continue;
          let c = d > 18 ? C.ink : x + y < -3 ? C.stone1 : x + y > 3 ? C.stone3 : C.stone2;
          if (d <= 18 && d > 10 && (x + y) % 3 === 0) c = C.stone3;
          put(sx + x, sy + y, c, BUILDING);
        }
      }
      for (let k = 0; k < 6; k++) shadow(sx + 5 + (k >> 1), sy - 2 + k);
      places.push({ name, x: cx - 12, y: cy + 12, align: "right" });
    }
  }

  // A plot that no road reaches: a bare slab with a dashed edge, waiting for a road.
  for (const i of plots) {
    const x = (i % sc.cols) * size + 3;
    const y = Math.floor(i / sc.cols) * size + 3;
    for (let yy = 0; yy < 14; yy++) {
      for (let xx = 0; xx < 14; xx++) {
        const edge = xx === 0 || yy === 0 || xx === 13 || yy === 13;
        put(x + xx, y + yy, edge ? ((xx + yy) % 4 < 2 ? C.wood5 : C.stone1) : C.stone1, BUILDING);
      }
    }
  }

  // Trees, only in clumps: woods where the scene has them, a few trees elsewhere.
  const trees: Tree[] = [];
  const clear = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!inside(x, y) || kind[y * W + x] !== GRASS) return false;
      }
    }
    return true;
  };
  scene.clumps.forEach((clump, ci) => {
    let placed = 0;
    for (let n = 0; n < clump.n * 6 && placed < clump.n; n++) {
      const pine = clump.pine ? hash(n, ci, 60) < 0.85 : hash(n, ci, 60) < 0.12;
      const img = pine ? S.pine : S.tree;
      const w = img[0].width;
      const h = img[0].height;
      const angle = hash(n, ci, 61) * Math.PI * 2;
      const rad = Math.sqrt(hash(n, ci, 62)) * clump.r;
      const x = Math.round(clump.x + Math.cos(angle) * rad - w / 2);
      const y = Math.round(clump.y + Math.sin(angle) * rad - h / 2);
      if (!clear(x - 1, y + 2, w + 2, h)) continue;
      for (let yy = 0; yy < 3; yy++) {
        for (let xx = -1; xx < w - 1 - yy; xx++) shadow(x + xx + 3 + yy, y + h - 2 + yy);
      }
      for (let yy = y + 2; yy < y + h + 2; yy++)
        for (let xx = x - 1; xx < x + w + 1; xx++) kind[yy * W + xx] = BLOCKED;
      trees.push({ x, y, frames: img, phase: Math.floor(hash(n, ci, 64) * 16) });
      placed++;
    }
  });
  trees.sort((p, q) => p.y - q.y);

  // A few walkers on the pavements, back and forth.
  const walkers: Walker[] = [];
  const runs: { x0: number; y0: number; dx: number; dy: number; length: number }[] = [];
  for (let r = 0; r < sc.rows; r++) {
    let start = -1;
    for (let c = 0; c <= sc.cols; c++) {
      const on = c < sc.cols && sc.cells[r * sc.cols + c] === ROAD && arms(sc, r * sc.cols + c)[1];
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        if (c - start >= 2) {
          runs.push({
            x0: start * size + 4,
            y0: r * size,
            dx: 1,
            dy: 0,
            length: (c - start + 1) * size - 8,
          });
        }
        start = -1;
      }
    }
  }
  for (let c = 0; c < sc.cols; c++) {
    let start = -1;
    for (let r = 0; r <= sc.rows; r++) {
      const on = r < sc.rows && sc.cells[r * sc.cols + c] === ROAD && arms(sc, r * sc.cols + c)[2];
      if (on && start < 0) start = r;
      if (!on && start >= 0) {
        if (r - start >= 2) {
          runs.push({
            x0: c * size + 15,
            y0: start * size + 2,
            dx: 0,
            dy: 1,
            length: (r - start + 1) * size - 8,
          });
        }
        start = -1;
      }
    }
  }
  runs.forEach((run, n) => {
    if (hash(n, run.x0, 31) > 0.5 || walkers.length >= 6) return;
    walkers.push({
      ...run,
      phase: Math.floor(hash(n, run.y0, 32) * run.length * 2),
      frames: S.walkers[n % S.walkers.length]!,
    });
  });

  const still = makeCanvas(W, H);
  still
    .getContext("2d")!
    .putImageData(new ImageData(new Uint8ClampedArray(buf.buffer), W, H), 0, 0);
  return {
    still,
    trees,
    walkers,
    chimneys,
    cat,
    ducks,
    places,
    placeCells: new Set(scene.places.keys()),
  };
}

/** Smoke from a chimney: puffs that rise a pixel a frame, drift right and thin out in dither. */
export function drawSmoke(g: CanvasRenderingContext2D, ch: Chimney, frame: number): void {
  const period = 12;
  for (let p = 0; p < 3; p++) {
    const age = (frame + ch.phase + p * 4) % period;
    const level = 1 - age / period;
    const x = ch.x + Math.floor(age / 3);
    const y = ch.y - age;
    g.fillStyle = P.plate;
    const r = age < 4 ? 1 : 2;
    for (let yy = -r + 1; yy <= r - 1 + (r > 1 ? 1 : 0); yy++) {
      for (let xx = -r + 1; xx <= r - 1 + (r > 1 ? 1 : 0); xx++) {
        if (dots(x + xx, y + yy, level)) g.fillRect(x + xx, y + yy, 1, 1);
      }
    }
  }
}

// ----- cars and signals -----

/** A car seen from above, facing east: tail lights, rear window, roof, windscreen, headlights. */
const CAR_E = ["rbbby", "bwhWb", "rbbby"];
/** The same car facing south-east. */
const CAR_SE = ["rbb..", "bwbb.", "bbhbb", ".bbWb", "..bby"];

const rotate = (rows: string[]): string[] => {
  const h = rows.length;
  const w = rows[0]!.length;
  const out: string[] = [];
  for (let x = 0; x < w; x++) {
    let line = "";
    for (let y = h - 1; y >= 0; y--) line += rows[y]![x]!;
    out.push(line);
  }
  return out;
};

/** The eight headings, east first, clockwise (the map's y runs down). */
const CAR_SHAPES: string[][] = (() => {
  const out: string[][] = [];
  let e = CAR_E;
  let se = CAR_SE;
  for (let k = 0; k < 4; k++) {
    out.push(e, se);
    e = rotate(e);
    se = rotate(se);
  }
  return out;
})();

const CAR_COLOURS = [
  [P.blueMid, P.blueSoft, P.blueDeep],
  [P.peachMid, P.peachSoft, P.peachDeep],
  [P.mintMid, P.mintSoft, P.mintDeep],
  [P.sunflowerMid, P.butter, P.sunflowerDeep],
  [P.blushMid, P.blushSoft, P.peachDeep],
  [P.plate, P.stone1, P.stone4],
] as const;

export interface CarSprites {
  /** [colour][heading][braking] */
  body: HTMLCanvasElement[][][];
  shadow: HTMLCanvasElement[];
}

let carCache: CarSprites | null = null;

export function carSprites(): CarSprites {
  if (carCache) return carCache;
  const body = CAR_COLOURS.map(([b, h, d]) =>
    CAR_SHAPES.map((shape) =>
      [false, true].map((braking) =>
        sprite(shape, {
          b,
          h,
          r: braking ? P.against : d,
          w: P.blueDeep,
          W: P.blueSoft,
          y: P.butter,
        }),
      ),
    ),
  );
  const shadow = CAR_SHAPES.map((shape) =>
    sprite(
      shape.map((row) => row.replace(/[^.]/g, "s")),
      { s: P.roadDark },
    ),
  );
  carCache = { body, shadow };
  return carCache;
}

/** The heading index, 0 to 7, of a direction. */
export const heading = (hx: number, hy: number): number =>
  (Math.round(Math.atan2(hy, hx) / (Math.PI / 4)) + 8) % 8;

/** A signal head on the pavement, 3 by 5: a light housing with three lamps, red at the top. */
export function drawSignalHead(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  light: number,
): void {
  g.fillStyle = P.stone4;
  g.fillRect(x + 3, y + 1, 1, 5);
  g.fillStyle = P.ink;
  g.fillRect(x, y, 3, 5);
  const lamps = [P.against, P.sunflower, P.mintMid];
  for (let k = 0; k < 3; k++) {
    const on = (light === 3 && k === 0) || (light === 2 && k === 1) || (light === 1 && k === 2);
    g.fillStyle = on ? lamps[k]! : P.inkDeep;
    g.fillRect(x + 1, y + 1 + k, 1, 1);
  }
}

/** A duck paddling across its pond and back, a pixel every four frames. */
export function drawDuck(g: CanvasRenderingContext2D, d: Duck, frame: number): void {
  const S = sprites();
  const t = (d.phase + (frame >> 2)) % (2 * d.length);
  const right = t < d.length;
  const x = d.x0 + (right ? t : 2 * d.length - t);
  g.drawImage(S.duck[right ? 0 : 1], x, d.y);
}
