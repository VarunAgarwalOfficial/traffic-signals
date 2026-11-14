/** The drawn map and its settings, in the same text form the Rust core reads. */

export const EMPTY = 0;
export const ROAD = 1;
export const HOUSE = 2;

export interface Scenario {
  cols: number;
  rows: number;
  cells: Uint8Array;
  controller: string;
  follow: "idm" | "sigmoid";
  /** Trips per hour, shared out between houses. */
  demand: number;
  reroute: number;
  /** House weights by cell; houses not listed weigh 1. */
  weights: Map<number, number>;
  /** Per-junction controller by cell; "none" removes the signal. */
  junctions: Map<number, string>;
  /** Controller settings this editor does not change, kept as `param` lines. */
  params: string[];
  /** Extra flows this editor does not change: origin cell, destination cell, trips per hour. */
  flows: [number, number, number][];
}

/** The drawing area is at least this big, so there is room around a preset. */
const MIN_COLS = 36;
const MIN_ROWS = 24;

export function parseScenario(text: string): Scenario {
  const lines = text.split("\n");
  const mapAt = lines.findIndex((l) => l.trim() === "map");
  if (mapAt < 0 || lines[0]?.trim() !== "traffic-scenario 1") {
    throw new Error("This is not a traffic scenario.");
  }
  const map = lines
    .slice(mapAt + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const srcCols = map[0]?.length ?? 0;
  if (srcCols === 0 || map.some((l) => l.length !== srcCols)) {
    throw new Error("The map in this scenario is damaged.");
  }
  if (srcCols > 200 || map.length > 200) throw new Error("The map is too large to edit here.");
  // Leave a few empty cells around what was drawn.
  const cols = Math.max(srcCols + 6, MIN_COLS);
  const rows = Math.max(map.length + 6, MIN_ROWS);
  const dx = Math.floor((cols - srcCols) / 2);
  const dy = Math.floor((rows - map.length) / 2);
  const sc: Scenario = {
    cols,
    rows,
    cells: new Uint8Array(cols * rows),
    controller: "fixed",
    follow: "idm",
    demand: 600,
    reroute: 30,
    weights: new Map(),
    junctions: new Map(),
    params: [],
    flows: [],
  };
  map.forEach((line, r) => {
    [...line].forEach((ch, c) => {
      sc.cells[(r + dy) * cols + c + dx] = ch === "#" ? ROAD : ch === "H" ? HOUSE : EMPTY;
    });
  });
  const cell = (word: string | undefined): number => {
    const [c, r] = (word ?? "").split(",").map(Number);
    if (c === undefined || r === undefined || Number.isNaN(c) || Number.isNaN(r)) return -1;
    return (r + dy) * cols + c + dx;
  };
  for (const raw of lines.slice(1, mapAt)) {
    const w = (raw.split("#")[0] ?? "").trim().split(/\s+/);
    const value = Number(w[1]);
    if (w[0] === "controller" && w[1]) sc.controller = w[1];
    else if (w[0] === "follow") sc.follow = w[1] === "sigmoid" ? "sigmoid" : "idm";
    else if (w[0] === "demand" && value >= 0) sc.demand = value;
    else if (w[0] === "reroute" && value >= 0) sc.reroute = value;
    else if (w[0] === "house" && cell(w[1]) >= 0) sc.weights.set(cell(w[1]), Number(w[2]) || 1);
    else if (w[0] === "junction" && w[2] && cell(w[1]) >= 0) sc.junctions.set(cell(w[1]), w[2]);
    else if (w[0] === "param" && w.length === 3) sc.params.push(w.join(" "));
    else if (w[0] === "flow" && cell(w[1]) >= 0 && cell(w[2]) >= 0 && Number(w[3]) >= 0) {
      sc.flows.push([cell(w[1]), cell(w[2]), Number(w[3])]);
    }
  }
  return sc;
}

/** The scenario as text, cut down to the part of the grid that is drawn on. */
export function formatScenario(sc: Scenario, controller = sc.controller): string {
  const box = drawnBounds(sc) ?? { c0: 0, r0: 0, c1: 0, r1: 0 };
  const at = (cell: number) =>
    `${(cell % sc.cols) - box.c0},${Math.floor(cell / sc.cols) - box.r0}`;
  const out = [
    "traffic-scenario 1",
    `controller ${controller}`,
    `follow ${sc.follow}`,
    `demand ${sc.demand}`,
    `reroute ${sc.reroute}`,
    ...sc.params,
  ];
  for (const [cell, weight] of sc.weights) {
    if (sc.cells[cell] === HOUSE && weight !== 1) out.push(`house ${at(cell)} ${weight}`);
  }
  for (const [from, to, rate] of sc.flows) {
    if (sc.cells[from] === HOUSE && sc.cells[to] === HOUSE) {
      out.push(`flow ${at(from)} ${at(to)} ${rate}`);
    }
  }
  for (const [cell, id] of sc.junctions) {
    if (sc.cells[cell] === ROAD) out.push(`junction ${at(cell)} ${id}`);
  }
  out.push("map");
  for (let r = box.r0; r <= box.r1; r++) {
    let line = "";
    for (let c = box.c0; c <= box.c1; c++) {
      const v = sc.cells[r * sc.cols + c];
      line += v === ROAD ? "#" : v === HOUSE ? "H" : ".";
    }
    out.push(line);
  }
  return `${out.join("\n")}\n`;
}

/** Number of road cells next to a cell. */
export function roadDegree(sc: Scenario, cell: number): number {
  const c = cell % sc.cols;
  const r = Math.floor(cell / sc.cols);
  let n = 0;
  if (r > 0 && sc.cells[cell - sc.cols] === ROAD) n++;
  if (r < sc.rows - 1 && sc.cells[cell + sc.cols] === ROAD) n++;
  if (c > 0 && sc.cells[cell - 1] === ROAD) n++;
  if (c < sc.cols - 1 && sc.cells[cell + 1] === ROAD) n++;
  return n;
}

/** The smallest box of cells that holds everything drawn, or null for an empty map. */
export function drawnBounds(
  sc: Scenario,
): { c0: number; r0: number; c1: number; r1: number } | null {
  let box: { c0: number; r0: number; c1: number; r1: number } | null = null;
  for (let i = 0; i < sc.cells.length; i++) {
    if (sc.cells[i] === EMPTY) continue;
    const c = i % sc.cols;
    const r = Math.floor(i / sc.cols);
    box = box
      ? {
          c0: Math.min(box.c0, c),
          r0: Math.min(box.r0, r),
          c1: Math.max(box.c1, c),
          r1: Math.max(box.r1, r),
        }
      : { c0: c, r0: r, c1: c, r1: r };
  }
  return box;
}

/** Pack a scenario into a link fragment and back. */
export async function encodeShare(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function decodeShare(code: string): Promise<string> {
  const binary = atob(code.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}
