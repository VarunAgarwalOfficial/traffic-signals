/** Draws the map, the signals and the cars on a canvas, with pan and zoom. */
import { drawnBounds, HOUSE, ROAD, type Scenario } from "./scenario.ts";
import { CAR_STRIDE, type NetworkInfo } from "./wasm.ts";

export interface Palette {
  ground: string;
  dot: string;
  kerb: string;
  road: string;
  mark: string;
  house: string;
  roof: string;
  ink: string;
  accent: string;
  green: string;
  amber: string;
  red: string;
  brake: string;
  cars: string[];
}

/** Read the map colours from the page's CSS variables (they change with the theme). */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ground: v("--map-ground"),
    dot: v("--map-dot"),
    kerb: v("--map-kerb"),
    road: v("--map-road"),
    mark: v("--map-mark"),
    house: v("--map-house"),
    roof: v("--map-roof"),
    ink: v("--ink"),
    accent: v("--accent"),
    green: v("--go"),
    amber: v("--amber"),
    red: v("--stop"),
    brake: v("--brake"),
    cars: [1, 2, 3, 4, 5, 6].map((i) => v(`--car-${i}`)),
  };
}

const ROAD_WIDTH = 8.6;
const CAR_LENGTH = 4.5;
const CAR_WIDTH = 1.8;
const BEND = 9;
/** North, east, south, west as (dx, dy). */
const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export class MapView {
  scenario: Scenario | null = null;
  /** The compiled network, in the coordinates of the whole drawing area. */
  network: NetworkInfo | null = null;
  /** Where the core's origin is: it only sees the part of the grid that is drawn on. */
  private shiftX = 0;
  private shiftY = 0;
  palette: Palette = readPalette();
  /** Pixels per metre and the screen position of the world origin, in CSS pixels. */
  scale = 2;
  ox = 0;
  oy = 0;
  showGrid = false;
  /** Cells to outline: the selection and the keyboard cursor. */
  selected = -1;
  cursor = -1;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private before: Float32Array = new Float32Array(0);
  private now: Float32Array = new Float32Array(0);
  private lights: Float32Array = new Float32Array(0);
  private beforeAt = new Map<number, number>();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly cell: number,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw on a canvas.");
    this.ctx = ctx;
  }

  /** Take the network of a simulation started from `formatScenario(this.scenario)`. */
  setNetwork(net: NetworkInfo | null): void {
    const sc = this.scenario;
    this.network = net;
    if (!net || !sc) return;
    const box = drawnBounds(sc) ?? { c0: 0, r0: 0, c1: 0, r1: 0 };
    const cols = box.c1 - box.c0 + 1;
    const here = (cell: number) =>
      (Math.floor(cell / cols) + box.r0) * sc.cols + (cell % cols) + box.c0;
    this.shiftX = box.c0 * this.cell;
    this.shiftY = box.r0 * this.cell;
    for (const node of net.nodes) {
      node.cell = here(node.cell);
      node.x += this.shiftX;
      node.y += this.shiftY;
    }
    for (const stop of net.stops) {
      stop.x += this.shiftX;
      stop.y += this.shiftY;
    }
    for (const house of net.houses) house.cell = here(house.cell);
  }

  /** Match the canvas to its box on the page. Returns true if the size changed. */
  resize(): boolean {
    const box = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    const changed = this.canvas.width !== w || this.canvas.height !== h;
    if (changed) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.width = box.width;
    this.height = box.height;
    return changed;
  }

  /** Pixels at the bottom of the canvas covered by controls; `fit` keeps the map clear of them. */
  bottomInset = 0;

  /** Show everything drawn, with a margin. */
  fit(margin = 1.5): void {
    const sc = this.scenario;
    if (!sc || this.width === 0) return;
    const b = drawnBounds(sc) ?? { c0: 0, r0: 0, c1: sc.cols - 1, r1: sc.rows - 1 };
    const w = (b.c1 - b.c0 + 1 + 2 * margin) * this.cell;
    const h = (b.r1 - b.r0 + 1 + 2 * margin) * this.cell;
    const height = this.height - this.bottomInset;
    this.scale = Math.min(this.width / w, height / h, 6);
    this.ox = this.width / 2 - ((b.c0 + b.c1 + 1) / 2) * this.cell * this.scale;
    this.oy = height / 2 - ((b.r0 + b.r1 + 1) / 2) * this.cell * this.scale;
  }

  zoomAt(factor: number, sx: number, sy: number): void {
    const next = Math.min(12, Math.max(0.35, this.scale * factor));
    const k = next / this.scale;
    this.ox = sx - (sx - this.ox) * k;
    this.oy = sy - (sy - this.oy) * k;
    this.scale = next;
  }

  /** The cell under a point of the canvas, or -1 outside the drawing area. */
  cellAt(sx: number, sy: number): number {
    const sc = this.scenario;
    if (!sc) return -1;
    const c = Math.floor((sx - this.ox) / this.scale / this.cell);
    const r = Math.floor((sy - this.oy) / this.scale / this.cell);
    return c < 0 || r < 0 || c >= sc.cols || r >= sc.rows ? -1 : r * sc.cols + c;
  }

  /** Scroll so that a cell is in view (for the keyboard cursor). */
  reveal(cell: number): void {
    const sc = this.scenario;
    if (!sc || cell < 0) return;
    const pad = this.cell * this.scale;
    const x = (cell % sc.cols) * this.cell * this.scale + this.ox;
    const y = Math.floor(cell / sc.cols) * this.cell * this.scale + this.oy;
    if (x < pad) this.ox += pad - x;
    if (y < pad) this.oy += pad - y;
    if (x > this.width - 2 * pad) this.ox -= x - (this.width - 2 * pad);
    if (y > this.height - 2 * pad) this.oy -= y - (this.height - 2 * pad);
  }

  /** Give the view a new simulation state. The previous one is kept to blend from. */
  setFrame(cars: Float32Array, lights: Float32Array): void {
    this.before = this.now;
    this.now = cars;
    this.lights = lights;
    this.beforeAt.clear();
    for (let i = 0; i < this.before.length; i += CAR_STRIDE) {
      this.beforeAt.set(this.before[i + 6]!, i);
    }
  }

  clearCars(): void {
    this.before = this.now = new Float32Array(0);
    this.lights = new Float32Array(0);
  }

  /** Draw the scene. `blend` in [0, 1] moves cars from the previous state to the current one. */
  draw(blend = 1): void {
    const { ctx, palette: p } = this;
    const sc = this.scenario;
    const dpr = this.canvas.width / Math.max(this.width, 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.ground;
    ctx.fillRect(0, 0, this.width, this.height);
    if (!sc) return;
    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);
    const px = 1 / this.scale;
    if (this.showGrid) this.drawGrid(sc, px);
    this.drawRoads(sc, px);
    this.drawHouses(sc, px);
    this.drawStops(px);
    this.drawCars(blend, px);
    this.drawOutline(sc, this.selected, px, false);
    this.drawOutline(sc, this.cursor, px, true);
    ctx.restore();
  }

  private drawGrid(sc: Scenario, px: number): void {
    const { ctx, cell } = this;
    // The edge of the drawing area, and a dot at every cell corner in view.
    ctx.strokeStyle = this.palette.dot;
    ctx.lineWidth = px;
    ctx.strokeRect(0, 0, sc.cols * cell, sc.rows * cell);
    if (cell * this.scale < 9) return;
    const c0 = Math.max(0, Math.floor(-this.ox / this.scale / cell));
    const r0 = Math.max(0, Math.floor(-this.oy / this.scale / cell));
    const c1 = Math.min(sc.cols, Math.ceil((this.width - this.ox) / this.scale / cell));
    const r1 = Math.min(sc.rows, Math.ceil((this.height - this.oy) / this.scale / cell));
    ctx.fillStyle = this.palette.dot;
    const d = 1.5 * px;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) ctx.fillRect(c * cell - d / 2, r * cell - d / 2, d, d);
    }
  }

  /** The arms of a road cell: which neighbours are road. */
  private arms(sc: Scenario, cell: number): boolean[] {
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

  private tracePaths(sc: Scenario, centreLinesOnly: boolean): void {
    const { ctx, cell } = this;
    const half = cell / 2;
    ctx.beginPath();
    for (let i = 0; i < sc.cells.length; i++) {
      if (sc.cells[i] !== ROAD) continue;
      const x = ((i % sc.cols) + 0.5) * cell;
      const y = (Math.floor(i / sc.cols) + 0.5) * cell;
      const arms = this.arms(sc, i);
      const open = arms.flatMap((on, d) => (on ? [d] : []));
      if (open.length === 2 && (open[0]! + open[1]!) % 2 === 1) {
        // A bend, rounded the same way the cars drive it.
        const [ax, ay] = DIRS[open[0]!]!;
        const [bx, by] = DIRS[open[1]!]!;
        ctx.moveTo(x + ax * half, y + ay * half);
        ctx.lineTo(x + ax * BEND, y + ay * BEND);
        ctx.quadraticCurveTo(x, y, x + bx * BEND, y + by * BEND);
        ctx.lineTo(x + bx * half, y + by * half);
        continue;
      }
      if (centreLinesOnly && open.length > 2) continue;
      if (open.length === 0 && !centreLinesOnly) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y);
      }
      for (const d of open) {
        const [dx, dy] = DIRS[d]!;
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx * half, y + dy * half);
      }
    }
  }

  private drawRoads(sc: Scenario, px: number): void {
    const { ctx, palette: p } = this;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    this.tracePaths(sc, false);
    ctx.strokeStyle = p.kerb;
    ctx.lineWidth = ROAD_WIDTH + 1.6;
    ctx.stroke();
    ctx.strokeStyle = p.road;
    ctx.lineWidth = ROAD_WIDTH;
    ctx.stroke();
    if (this.scale < 1.1) return;
    ctx.lineCap = "butt";
    this.tracePaths(sc, true);
    ctx.strokeStyle = p.mark;
    ctx.lineWidth = Math.max(0.28, px);
    ctx.setLineDash([2.5, 3.5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawHouses(sc: Scenario, px: number): void {
    const { ctx, cell, palette: p } = this;
    const connected = new Set(
      this.network?.houses.filter((h) => h.connected).map((h) => h.cell) ?? [],
    );
    for (let i = 0; i < sc.cells.length; i++) {
      if (sc.cells[i] !== HOUSE) continue;
      const x = (i % sc.cols) * cell;
      const y = Math.floor(i / sc.cols) * cell;
      const inset = cell * 0.2;
      const size = cell - 2 * inset;
      ctx.beginPath();
      ctx.roundRect(x + inset, y + inset, size, size, 1.6);
      if (this.network && !connected.has(i)) {
        // No road next to it: nobody can leave or arrive.
        ctx.strokeStyle = p.house;
        ctx.lineWidth = Math.max(0.5, 1.5 * px);
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      ctx.fillStyle = p.house;
      ctx.fill();
      // A hipped roof seen from above.
      ctx.strokeStyle = p.roof;
      ctx.lineWidth = Math.max(0.4, px);
      const a = x + inset;
      const b = y + inset;
      const ridge = size * 0.28;
      ctx.beginPath();
      ctx.moveTo(a, b);
      ctx.lineTo(a + ridge, b + size / 2);
      ctx.lineTo(a, b + size);
      ctx.moveTo(a + size, b);
      ctx.lineTo(a + size - ridge, b + size / 2);
      ctx.lineTo(a + size, b + size);
      ctx.moveTo(a + ridge, b + size / 2);
      ctx.lineTo(a + size - ridge, b + size / 2);
      ctx.stroke();
      const weight = sc.weights.get(i) ?? 1;
      if (weight !== 1 && cell * this.scale > 26) {
        ctx.fillStyle = p.ink;
        ctx.font = `600 ${cell * 0.24}px "IBM Plex Sans", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`×${weight}`, x + cell / 2, y + cell - inset * 0.48);
      }
    }
  }

  private drawStops(px: number): void {
    const net = this.network;
    if (!net) return;
    const { ctx, palette: p } = this;
    const colours = [p.mark, p.green, p.amber, p.red];
    ctx.lineCap = "round";
    for (const s of net.stops) {
      const light = this.lights[s.lane] ?? 0;
      // Across the lane, just before the junction.
      const nx = -s.dy;
      const ny = s.dx;
      const bx = s.x - s.dx * 0.2;
      const by = s.y - s.dy * 0.2;
      ctx.beginPath();
      ctx.moveTo(bx - nx * 1.25, by - ny * 1.25);
      ctx.lineTo(bx + nx * 1.25, by + ny * 1.25);
      ctx.strokeStyle = colours[light] ?? p.mark;
      ctx.lineWidth =
        light === 0 ? Math.max(0.3, px) : Math.max(0.95, (this.scale < 1.5 ? 2 : 3) * px);
      ctx.stroke();
    }
    // A ring marks junctions that were given their own controller.
    const sc = this.scenario;
    if (!sc) return;
    for (const node of net.nodes) {
      if (!sc.junctions.has(node.cell)) continue;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 1.6, 0, Math.PI * 2);
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = Math.max(0.5, 1.5 * px);
      ctx.stroke();
    }
  }

  private drawCars(blend: number, px: number): void {
    const { ctx, palette: p, now, before } = this;
    const detailed = this.scale > 2.2;
    const minWidth = Math.max(CAR_WIDTH, 2.2 * px);
    for (let i = 0; i < now.length; i += CAR_STRIDE) {
      let x = now[i]! + this.shiftX;
      let y = now[i + 1]! + this.shiftY;
      let hx = now[i + 2]!;
      let hy = now[i + 3]!;
      const id = now[i + 6]!;
      const j = this.beforeAt.get(id);
      if (j !== undefined && blend < 1) {
        const x0 = before[j]! + this.shiftX;
        const y0 = before[j + 1]! + this.shiftY;
        x = x0 + (x - x0) * blend;
        y = y0 + (y - y0) * blend;
        hx = before[j + 2]! + (hx - before[j + 2]!) * blend;
        hy = before[j + 3]! + (hy - before[j + 3]!) * blend;
        const len = Math.hypot(hx, hy) || 1;
        hx /= len;
        hy /= len;
      }
      ctx.save();
      ctx.transform(hx, hy, -hy, hx, x, y);
      ctx.fillStyle = p.cars[id % p.cars.length]!;
      ctx.beginPath();
      ctx.roundRect(-CAR_LENGTH / 2, -minWidth / 2, CAR_LENGTH, minWidth, 0.5);
      ctx.fill();
      if (detailed) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
        ctx.fillRect(0.35, -CAR_WIDTH / 2 + 0.22, 0.9, CAR_WIDTH - 0.44);
        if (now[i + 5]! < -1.2) {
          ctx.fillStyle = p.brake;
          ctx.fillRect(-CAR_LENGTH / 2, -CAR_WIDTH / 2, 0.45, 0.5);
          ctx.fillRect(-CAR_LENGTH / 2, CAR_WIDTH / 2 - 0.5, 0.45, 0.5);
        }
      }
      ctx.restore();
    }
  }

  private drawOutline(sc: Scenario, cell: number, px: number, dashed: boolean): void {
    if (cell < 0) return;
    const { ctx } = this;
    const x = (cell % sc.cols) * this.cell;
    const y = Math.floor(cell / sc.cols) * this.cell;
    ctx.strokeStyle = this.palette.accent;
    ctx.lineWidth = 2 * px;
    if (dashed) ctx.setLineDash([4 * px, 3 * px]);
    ctx.beginPath();
    ctx.roundRect(x + px, y + px, this.cell - 2 * px, this.cell - 2 * px, 3 * px);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
