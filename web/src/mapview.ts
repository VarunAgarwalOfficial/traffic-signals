/**
 * Draws the map as a pixel town, with the signals and the cars, and handles pan and zoom.
 *
 * One art pixel is one metre. The still town is painted once into an offscreen canvas; each drawn
 * frame copies it, adds the sprites (cars, signals, trees, walkers, smoke, a cat) at whole art
 * pixels, and shows the result at a whole number of screen pixels per art pixel. Idle motion runs at
 * 10 drawn frames a second and stops under reduced motion.
 */
import { PALETTE as P, reducedMotion, ticker } from "./pixel.ts";
import { drawnBounds, HOUSE, ROAD, type Scenario } from "./scenario.ts";
import {
  arms,
  carSprites,
  drawDuck,
  drawSignalHead,
  drawSmoke,
  heading,
  paintTown,
  type Town,
} from "./town.ts";
import { CAR_STRIDE, type NetworkInfo } from "./wasm.ts";

/** The map's colours. The town is light only, so this is the pixel palette. */
export type Palette = typeof P;

export function readPalette(): Palette {
  return P;
}

const FPS = 10;
const ROAD_WIDTH = 8;
/** The largest zoom, in screen pixels per art pixel. */
const MAX_ZOOM = 8;
type Box = { x0: number; y0: number; x1: number; y1: number };

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
  /** CSS pixels per metre (a whole number of device pixels) and the world origin on screen. */
  scale = 2;
  ox = 0;
  oy = 0;
  showGrid = false;
  /** Name one house and one signal where they sit on the map. */
  labels = false;
  /** Cells to outline: the selection and the keyboard cursor. */
  selected = -1;
  cursor = -1;
  /** Pixels at the bottom of the canvas covered by controls; `fit` keeps the map clear of them. */
  bottomInset = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private before: Float32Array = new Float32Array(0);
  private now: Float32Array = new Float32Array(0);
  private lights: Float32Array = new Float32Array(0);
  private beforeAt = new Map<number, number>();
  /** The zoom asked for, before snapping, so small wheel steps add up. */
  private want = 2;
  private blend = 1;
  private town: Town | null = null;
  private townKey = "";
  private networkVersion = 0;
  private readonly frameCanvas = document.createElement("canvas");
  private readonly frameCtx: CanvasRenderingContext2D;
  private tick = 0;
  private stopTicker: (() => void) | null = null;
  private lastKey = "";
  private dirty = true;
  /** The light each lane shows, and lanes caught between two lights for one dark frame. */
  private shown = new Uint8Array(0);
  /** The view `fit` last set, and its margin, to fit again if the box changes before any pan. */
  private fitted = "";
  private fitMargin: number | undefined;
  private dark = new Uint8Array(0);

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly cell: number,
  ) {
    const ctx = canvas.getContext("2d");
    const frameCtx = this.frameCanvas.getContext("2d");
    if (!ctx || !frameCtx) throw new Error("This browser cannot draw on a canvas.");
    this.ctx = ctx;
    this.frameCtx = frameCtx;
    // Run the idle motion only while the map is on screen.
    new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        if (!this.stopTicker) {
          this.stopTicker = ticker(FPS, (frame) => {
            this.tick = frame;
            this.render();
          });
        }
      } else {
        this.stopTicker?.();
        this.stopTicker = null;
      }
    }).observe(canvas);
  }

  /** Take the network of a simulation started from `formatScenario(this.scenario)`. */
  setNetwork(net: NetworkInfo | null): void {
    const sc = this.scenario;
    this.network = net;
    this.networkVersion++;
    this.dirty = true;
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

  private get dpr(): number {
    return this.canvas.width / Math.max(this.width, 1);
  }

  /**
   * Show everything drawn at the largest whole-number zoom that fits. The margin (in cells) is kept
   * when it fits at that zoom and given up when it does not.
   */
  fit(margin = this.width < 600 ? 0.4 : 1.5): void {
    const sc = this.scenario;
    if (!sc || this.width === 0) return;
    const dpr = this.dpr;
    const b = drawnBounds(sc) ?? { c0: 0, r0: 0, c1: sc.cols - 1, r1: sc.rows - 1 };
    const w = (b.c1 - b.c0 + 1) * this.cell;
    const h = (b.r1 - b.r0 + 1) * this.cell;
    const height = this.height - this.bottomInset;
    const tight = Math.floor(Math.min((this.width * dpr) / w, (height * dpr) / h));
    const m = 2 * margin * this.cell;
    const loose = Math.floor(Math.min((this.width * dpr) / (w + m), (height * dpr) / (h + m)));
    const k = Math.min(Math.max(1, loose, tight), Math.round(MAX_ZOOM * dpr));
    this.scale = k / dpr;
    this.want = this.scale;
    this.ox = Math.round((this.width / 2 - ((b.c0 + b.c1 + 1) / 2) * this.cell * this.scale) * dpr);
    this.oy = Math.round((height / 2 - ((b.r0 + b.r1 + 1) / 2) * this.cell * this.scale) * dpr);
    this.ox /= dpr;
    this.oy /= dpr;
    this.fitMargin = margin;
    this.fitted = `${this.ox},${this.oy},${this.scale}`;
  }

  /** Zoom about a point. Zoom snaps to whole device pixels per art pixel. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const dpr = this.dpr;
    const kNow = Math.round(this.scale * dpr);
    this.want = Math.min(MAX_ZOOM, Math.max(1 / dpr, this.want * factor));
    let k = Math.max(1, Math.round(this.want * dpr));
    // A button press always moves at least one step.
    if (Math.abs(Math.log(factor)) >= 0.15 && k === kNow)
      k = Math.max(1, kNow + Math.sign(factor - 1));
    k = Math.min(k, Math.round(MAX_ZOOM * dpr));
    if (Math.abs(Math.log(factor)) >= 0.15) this.want = k / dpr;
    if (k === kNow) return;
    const next = k / dpr;
    const ratio = next / this.scale;
    this.ox = sx - (sx - this.ox) * ratio;
    this.oy = sy - (sy - this.oy) * ratio;
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
    this.dirty = true;
    this.beforeAt.clear();
    for (let i = 0; i < this.before.length; i += CAR_STRIDE) {
      this.beforeAt.set(this.before[i + 6]!, i);
    }
  }

  clearCars(): void {
    this.before = this.now = new Float32Array(0);
    this.lights = new Float32Array(0);
    this.dirty = true;
  }

  /**
   * Ask for the scene. `blend` in [0, 1] moves cars from the previous state to the current one.
   * A change of view draws at once; motion waits for the next drawn frame of the clock, so cars
   * move in whole art pixels at 10 frames a second. Under reduced motion the cars jump each step.
   */
  draw(blend = 1): void {
    this.blend = blend;
    const key = this.viewKey();
    const clockRunning = this.stopTicker !== null && !reducedMotion() && !document.hidden;
    if (key !== this.lastKey || (this.dirty && !clockRunning)) this.render();
  }

  private viewKey(): string {
    return [
      this.ox,
      this.oy,
      this.scale,
      this.width,
      this.height,
      this.canvas.width,
      this.selected,
      this.cursor,
      this.canvas.dataset.editing,
      this.townSignature(),
    ].join();
  }

  /** What the still town depends on: the cells and which houses a road reaches. */
  private townSignature(): string {
    const sc = this.scenario;
    if (!sc) return "";
    let h = 0;
    for (let i = 0; i < sc.cells.length; i++) h = (Math.imul(h, 31) + sc.cells[i]! * (i + 1)) | 0;
    return `${sc.cols}x${sc.rows}:${h}:${this.network ? this.networkVersion : -1}`;
  }

  private render(): void {
    // A box that changed size under a view nobody has moved (a tile in a reflowing grid) fits again.
    const asFitted = this.fitted === `${this.ox},${this.oy},${this.scale}`;
    if (this.resize() && asFitted) this.fit(this.fitMargin);
    this.lastKey = this.viewKey();
    this.dirty = false;
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = P.meadow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const sc = this.scenario;
    if (!sc || this.width === 0) return;

    const signature = this.townSignature();
    if (!this.town || signature !== this.townKey) {
      const connected = this.network
        ? new Set(this.network.houses.filter((h) => h.connected).map((h) => h.cell))
        : null;
      this.town = paintTown(sc, this.cell, connected);
      this.townKey = signature;
    }
    const town = this.town;
    const f = this.frameCtx;
    const W = town.still.width;
    const H = town.still.height;
    if (this.frameCanvas.width !== W || this.frameCanvas.height !== H) {
      this.frameCanvas.width = W;
      this.frameCanvas.height = H;
    }
    f.imageSmoothingEnabled = false;
    f.drawImage(town.still, 0, 0);
    const frame = this.tick;
    const still = reducedMotion();

    if (this.showGrid && canvas.dataset.editing === "true") this.drawGrid(f, sc);
    this.drawStops(f, still);
    this.drawCars(f);
    for (const w of town.walkers) {
      const t = still ? w.phase : w.phase + (frame >> 2);
      const along = t % (2 * w.length);
      const s = along < w.length ? along : 2 * w.length - along;
      const img = w.frames[still ? 0 : (frame >> 2) & 1]!;
      f.drawImage(img, w.x0 + w.dx * s, w.y0 + w.dy * s);
    }
    for (const t of town.trees) {
      const lean = still ? 0 : ((frame + t.phase) >> 3) & 1;
      f.drawImage(t.frames[lean]!, t.x, t.y);
    }
    if (!still) for (const ch of town.chimneys) drawSmoke(f, ch, frame >> 1);
    for (const d of town.ducks) drawDuck(f, d, still ? 0 : frame);
    if (town.cat) {
      const c = still ? 0 : frame % 47 < 2 ? 2 : (frame >> 3) % 3 === 0 ? 1 : 0;
      f.drawImage(town.cat.frames[c]!, town.cat.x, town.cat.y);
    }
    this.drawOutline(f, sc, this.selected, false);
    this.drawOutline(f, sc, this.cursor, true);

    const dpr = this.dpr;
    const k = Math.round(this.scale * dpr);
    ctx.drawImage(
      this.frameCanvas,
      Math.round(this.ox * dpr),
      Math.round(this.oy * dpr),
      W * k,
      H * k,
    );
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawPlaces(town);
    this.drawWeights(sc);
    if (this.labels) this.drawLabels(sc);
  }

  /** A dot at every cell corner while editing, so cells can be counted. */
  private drawGrid(f: CanvasRenderingContext2D, sc: Scenario): void {
    f.fillStyle = P.meadowDeep;
    for (let r = 0; r <= sc.rows; r++) {
      for (let c = 0; c <= sc.cols; c++) f.fillRect(c * this.cell - 1, r * this.cell - 1, 2, 2);
    }
  }

  /**
   * Each lane's signal: a bar across the lane at the stop in the light's colour, and a signal head
   * on the pavement beside it. A lane without a signal gets a dotted give-way line.
   */
  private drawStops(f: CanvasRenderingContext2D, still: boolean): void {
    const net = this.network;
    if (!net) return;
    if (this.shown.length < this.lights.length) {
      this.shown = new Uint8Array(this.lights.length);
      this.dark = new Uint8Array(this.lights.length);
    }
    const colours = [P.plate, P.proved, P.measured, P.against];
    const half = this.cell / 2;
    for (const s of net.stops) {
      let light = this.lights[s.lane] ?? 0;
      // A change of light shows one dark frame first, as a lamp switching.
      if (!still && light !== this.shown[s.lane]) {
        if (this.dark[s.lane]) {
          this.dark[s.lane] = 0;
          this.shown[s.lane] = light;
        } else {
          this.dark[s.lane] = 1;
          light = -1;
        }
      }
      const across = Math.abs(s.dx) > Math.abs(s.dy);
      const along = across ? s.x : s.y;
      const side = across ? s.y : s.x;
      const forward = across ? Math.sign(s.dx) : Math.sign(s.dy);
      const a0 = forward > 0 ? Math.round(along) - 2 : Math.round(along) - 1;
      const c0 = Math.round(side) - 2;
      const rect = (a: number, c: number, la: number, lc: number) =>
        across ? f.fillRect(a, c, la, lc) : f.fillRect(c, a, lc, la);
      if (light === 0) {
        f.fillStyle = P.plate;
        for (let k = 0; k < 4; k += 2) rect(a0 + (forward > 0 ? 1 : 0), c0 + k, 1, 1);
        continue;
      }
      f.fillStyle = light < 0 ? P.roadDark : colours[light]!;
      rect(a0, c0, 2, 4);
      // The head stands on the pavement on the lane's outer side.
      const cellCentre = Math.floor(side / this.cell) * this.cell + half;
      const out = side > cellCentre ? 1 : -1;
      const pave = out > 0 ? cellCentre + 5 : cellCentre - (across ? 10 : 8);
      if (across) drawSignalHead(f, a0, pave, Math.max(light, 0));
      else drawSignalHead(f, pave, a0 - 1, Math.max(light, 0));
    }
    // A ring marks junctions that were given their own controller.
    const sc = this.scenario;
    if (!sc) return;
    f.fillStyle = P.blueDeep;
    for (const node of net.nodes) {
      if (!sc.junctions.has(node.cell)) continue;
      const x = Math.round(node.x);
      const y = Math.round(node.y);
      f.fillRect(x - 1, y - 3, 2, 1);
      f.fillRect(x - 1, y + 2, 2, 1);
      f.fillRect(x - 3, y - 1, 1, 2);
      f.fillRect(x + 2, y - 1, 1, 2);
      f.fillRect(x - 2, y - 2, 1, 1);
      f.fillRect(x + 1, y - 2, 1, 1);
      f.fillRect(x - 2, y + 1, 1, 1);
      f.fillRect(x + 1, y + 1, 1, 1);
    }
  }

  private drawCars(f: CanvasRenderingContext2D): void {
    const { now, before } = this;
    const blend = reducedMotion() ? 1 : this.blend;
    const art = carSprites();
    const at: [number, number, number, number, number][] = [];
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
      }
      at.push([x, y, heading(hx, hy), id, now[i + 5]! < -1.2 ? 1 : 0]);
    }
    for (const [x, y, h] of at) {
      const img = art.shadow[h]!;
      f.drawImage(img, Math.round(x) - (img.width >> 1) + 1, Math.round(y) - (img.height >> 1) + 1);
    }
    for (const [x, y, h, id, braking] of at) {
      const img = art.body[id % art.body.length]![h]![braking]!;
      f.drawImage(img, Math.round(x) - (img.width >> 1), Math.round(y) - (img.height >> 1));
    }
  }

  private drawOutline(
    f: CanvasRenderingContext2D,
    sc: Scenario,
    cell: number,
    dashed: boolean,
  ): void {
    if (cell < 0) return;
    const x = (cell % sc.cols) * this.cell;
    const y = Math.floor(cell / sc.cols) * this.cell;
    const n = this.cell;
    f.fillStyle = P.blueDeep;
    for (let t = 0; t < n; t++) {
      if (dashed && t % 4 >= 2) continue;
      f.fillRect(x + t, y, 1, 1);
      f.fillRect(x + t, y + n - 1, 1, 1);
      f.fillRect(x, y + t, 1, 1);
      f.fillRect(x + n - 1, y + t, 1, 1);
    }
  }

  private font(): string {
    const family = getComputedStyle(document.body).fontFamily || "Georgia, serif";
    return `17px ${family}`;
  }

  /** Write a label with a cream halo, so it reads on grass, road or roof. */
  private text(text: string, x: number, y: number): void {
    const { ctx } = this;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = P.plate;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = P.ink;
    ctx.fillText(text, x, y);
  }

  /** The names of the town's places, once a cell is large enough for the name to fit beside it. */
  private drawPlaces(town: Town): void {
    if (this.cell * this.scale < 30 || town.places.length === 0) return;
    const { ctx } = this;
    ctx.font = this.font();
    for (const p of town.places) {
      const w = ctx.measureText(p.name).width;
      const sx = p.x * this.scale + this.ox;
      const x = p.align === "center" ? sx - w / 2 : p.align === "right" ? sx - w : sx;
      this.text(p.name, Math.round(x), Math.round(p.y * this.scale + this.oy));
    }
  }

  /** House weights other than 1, under the house, once the house is large enough to hold them. */
  private drawWeights(sc: Scenario): void {
    const k = this.cell * this.scale;
    if (k <= 56) return;
    const { ctx } = this;
    ctx.font = this.font();
    for (let i = 0; i < sc.cells.length; i++) {
      if (sc.cells[i] !== HOUSE) continue;
      const weight = sc.weights.get(i) ?? 1;
      if (weight === 1) continue;
      const label = `×${weight}`;
      const w = ctx.measureText(label).width;
      const x = ((i % sc.cols) + 0.5) * k + this.ox - w / 2;
      const y = (Math.floor(i / sc.cols) + 1) * k + this.oy - 2;
      this.text(label, x, y);
    }
  }

  /**
   * Screen-space names for one house and one signalled junction, with a halo. Each name goes at the
   * first spot beside its house or junction whose box is clear of the canvas edge, every road and
   * house, and the other name; a name with no clear spot is left off.
   */
  private drawLabels(sc: Scenario): void {
    const { ctx, cell } = this;
    ctx.font = this.font();
    const k = cell * this.scale;
    const half = ((ROAD_WIDTH + 6) / 2) * this.scale + 3;
    // What a name must not touch, in screen boxes: each road arm, each house, the other name.
    const blocked: Box[] = [];
    for (let i = 0; i < sc.cells.length; i++) {
      const x = (i % sc.cols) * k + this.ox;
      const y = Math.floor(i / sc.cols) * k + this.oy;
      if (sc.cells[i] === HOUSE) blocked.push({ x0: x, y0: y, x1: x + k, y1: y + k });
      if (sc.cells[i] !== ROAD) continue;
      const cx = x + k / 2;
      const cy = y + k / 2;
      blocked.push({ x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half });
      arms(sc, i).forEach((on, d) => {
        if (!on) return;
        const [dx, dy] = DIRS[d]!;
        const ex = cx + (dx * k) / 2;
        const ey = cy + (dy * k) / 2;
        blocked.push({
          x0: Math.min(cx, ex) - half,
          y0: Math.min(cy, ey) - half,
          x1: Math.max(cx, ex) + half,
          y1: Math.max(cy, ey) + half,
        });
      });
    }
    const m = ctx.measureText("Hg");
    const up = m.actualBoundingBoxAscent;
    const down = m.actualBoundingBoxDescent;
    const clear = (b: Box) =>
      b.x0 > 4 &&
      b.y0 > 4 &&
      b.x1 < this.width - 4 &&
      b.y1 < this.height - 4 &&
      !blocked.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    /** Try the four corners around an anchor, `gap` out from it; draw at the first clear one. */
    const place = (text: string, ax: number, ay: number, gap: number): boolean => {
      const w = ctx.measureText(text).width;
      for (const [sx, sy] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const x = sx > 0 ? ax + gap : ax - gap - w;
        const y = sy > 0 ? ay + gap + up : ay - gap - down;
        const box = { x0: x - 2, y0: y - up - 2, x1: x + w + 2, y1: y + down + 2 };
        if (!clear(box)) continue;
        this.text(text, x, y);
        blocked.push(box);
        return true;
      }
      return false;
    };
    for (let i = 0; i < sc.cells.length; i++) {
      if (sc.cells[i] !== HOUSE || this.town?.placeCells.has(i)) continue;
      // Beside the house, level with it.
      const x = ((i % sc.cols) + 1) * k + this.ox + 4;
      const y = (Math.floor(i / sc.cols) + 0.5) * k + this.oy + (up - down) / 2;
      const w = ctx.measureText("house").width;
      const box = { x0: x - 2, y0: y - up - 2, x1: x + w + 2, y1: y + down + 2 };
      if (!clear(box)) continue;
      this.text("house", x, y);
      blocked.push(box);
      break;
    }
    for (const n of this.network?.nodes ?? []) {
      if (!n.canSignal) continue;
      // In the corner of a block, just off the junction.
      if (
        place(
          "junction with signals",
          n.x * this.scale + this.ox,
          n.y * this.scale + this.oy,
          half + 3,
        )
      )
        break;
    }
  }
}
