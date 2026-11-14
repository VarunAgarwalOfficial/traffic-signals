/** The Build view: draw the map, run the simulation, read the measurements. */
import { lineChart } from "./charts.ts";
import { MapView, readPalette } from "./mapview.ts";
import { EMPTY, formatScenario, HOUSE, ROAD, type Scenario } from "./scenario.ts";
import { type Core, SERIES_STRIDE, type Simulation } from "./wasm.ts";

type Tool = "select" | "road" | "house" | "erase";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export const FOLLOW_NOTES: Record<Scenario["follow"], string> = {
  idm: "Intelligent Driver Model: eases off as it nears the speed it wants and brakes in proportion to how fast it is closing on the car ahead.",
  sigmoid:
    "The 2021 rule: acceleration is a sigmoid of the gap minus the wanted gap. It knows nothing of the speed limit, so that is enforced separately.",
};

/** Seconds as m:ss or h:mm:ss. */
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Mean delay of the trips finishing in each minute, from the core's ten-second series. */
export function delayPerMinute(series: Float32Array): [number, number][] {
  const points: [number, number][] = [];
  const rows = series.length / SERIES_STRIDE;
  for (let start = 0; start + 6 <= rows; start += 6) {
    let arrived = 0;
    let delay = 0;
    for (let k = start; k < start + 6; k++) {
      arrived += series[k * SERIES_STRIDE + 1]!;
      delay += series[k * SERIES_STRIDE + 2]!;
    }
    const time = series[(start + 5) * SERIES_STRIDE]!;
    if (arrived > 0) points.push([time, delay / arrived]);
  }
  return points;
}

interface Snapshot {
  cells: Uint8Array;
  weights: Map<number, number>;
  junctions: Map<number, string>;
}

export class BuildView {
  scenario: Scenario;
  seed = 1;
  private sim: Simulation | null = null;
  private readonly view: MapView;
  private tool: Tool = "select";
  private playing = true;
  private speed = 4;
  private owed = 0;
  private lastFrame = 0;
  private lastStats = 0;
  private lastChart = 0;
  private visible = true;
  private undoStack: Snapshot[] = [];
  /** Active pointers on the canvas, for drawing, panning and pinching. */
  private pointers = new Map<number, { x: number; y: number }>();
  private stroke: { last: number; changed: boolean; moved: number; panning: boolean } | null = null;
  private pinch: { distance: number; x: number; y: number } | null = null;

  constructor(
    private readonly core: Core,
    scenario: Scenario,
    private readonly toast: (message: string) => void,
  ) {
    this.scenario = scenario;
    this.view = new MapView($<HTMLCanvasElement>("map"), core.info.cell);
    this.view.showGrid = true;
    this.fillControls();
    this.bindControls();
    this.bindCanvas();
    new ResizeObserver(() => {
      const first = this.view.scale === 2 && this.view.ox === 0;
      if (this.view.resize() && first) this.view.fit();
    }).observe(this.view.canvas);
    this.view.resize();
    this.load(scenario);
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Replace the whole scenario (a preset or a shared link). */
  load(scenario: Scenario): void {
    this.scenario = scenario;
    this.undoStack = [];
    this.view.scenario = scenario;
    this.view.selected = -1;
    this.view.resize();
    this.view.fit();
    $<HTMLSelectElement>("controller").value = scenario.controller;
    $<HTMLInputElement>("demand").value = String(scenario.demand);
    this.syncControls();
    this.rebuild();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.view.resize();
      this.lastFrame = 0;
    }
  }

  themeChanged(): void {
    this.view.palette = readPalette();
    this.drawChart();
  }

  // ----- simulation -----

  /** Start the simulation again from the current drawing. */
  private rebuild(): void {
    this.sim?.free();
    this.sim = null;
    this.view.clearCars();
    try {
      this.sim = this.core.simulate(formatScenario(this.scenario), this.seed);
      this.view.network = this.sim.network();
      this.pushFrame();
    } catch (error) {
      this.view.network = null;
      this.toast(error instanceof Error ? error.message : String(error));
    }
    this.owed = 0;
    this.updateStats();
    this.drawChart();
    this.renderInspector();
    $<HTMLButtonElement>("undo").disabled = this.undoStack.length === 0;
  }

  private pushFrame(): void {
    if (this.sim) this.view.setFrame(this.sim.cars(), this.sim.lights());
  }

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    if (!this.visible) return;
    const elapsed = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    const dt = this.core.info.dt;
    if (this.sim && this.playing && !this.stroke?.changed) {
      this.owed += elapsed * this.speed;
      const steps = Math.min(Math.floor(this.owed / dt), 80);
      if (steps > 0) {
        this.sim.step(steps);
        this.owed -= steps * dt;
        if (this.owed > dt) this.owed = 0;
        this.pushFrame();
      }
    }
    this.view.draw(this.playing ? Math.min(this.owed / dt, 1) : 1);
    if (now - this.lastStats > 400) {
      this.lastStats = now;
      this.updateStats();
    }
    if (now - this.lastChart > 3000) {
      this.lastChart = now;
      this.drawChart();
    }
  }

  private updateStats(): void {
    const set = (id: string, text: string) => {
      const node = $(id);
      if (node.textContent !== text) node.textContent = text;
    };
    if (!this.sim) {
      for (const id of ["s-delay", "s-p95", "s-flow", "s-stops", "s-queue", "s-backlog"])
        set(id, "–");
      set("clock", "0:00");
      return;
    }
    const s = this.sim.stats();
    const m = s.metrics;
    const some = m.finished > 0;
    set("clock", clock(s.time));
    set("s-delay", some ? `${m.delay_mean.toFixed(1)} s` : "–");
    set("s-p95", some ? `${m.delay_p95.toFixed(0)} s` : "–");
    set("s-flow", s.time >= 60 ? Math.round(m.throughput).toLocaleString("en") : "–");
    set("s-stops", some ? m.stops_per_trip.toFixed(1) : "–");
    set("s-queue", `${s.queued} of ${s.active}`);
    set("s-backlog", String(s.backlog));
  }

  private drawChart(): void {
    const host = $("build-chart");
    const points = this.sim ? delayPerMinute(this.sim.series()) : [];
    host.classList.toggle("empty", points.length < 2);
    if (points.length < 2) {
      host.querySelector("svg")?.remove();
      host.dataset.empty = "The chart starts after two minutes of simulated time.";
      return;
    }
    lineChart(host, {
      series: [{ label: "Mean delay", colour: "var(--series-1)", points }],
      x: (v) => clock(v),
      y: (v) => `${Math.round(v)} s`,
      height: 150,
      description: "Mean delay of trips finishing in each simulated minute.",
    });
  }

  // ----- editing -----

  private snapshot(): void {
    const sc = this.scenario;
    this.undoStack.push({
      cells: sc.cells.slice(),
      weights: new Map(sc.weights),
      junctions: new Map(sc.junctions),
    });
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  private undo(): void {
    const last = this.undoStack.pop();
    if (!last) return;
    this.scenario.cells.set(last.cells);
    this.scenario.weights = last.weights;
    this.scenario.junctions = last.junctions;
    this.view.selected = -1;
    this.rebuild();
  }

  /** Use the current tool on a cell. Returns true if the drawing changed. */
  private apply(cell: number, dragging: boolean): boolean {
    const sc = this.scenario;
    if (cell < 0) return false;
    const was = sc.cells[cell];
    let next = was;
    if (this.tool === "road")
      next = was === EMPTY ? ROAD : dragging ? was : was === ROAD ? EMPTY : was;
    else if (this.tool === "erase") next = EMPTY;
    else if (this.tool === "house" && !dragging)
      next = was === EMPTY ? HOUSE : was === HOUSE ? EMPTY : was;
    if (next === was) return false;
    sc.cells[cell] = next!;
    if (next !== HOUSE) sc.weights.delete(cell);
    if (next !== ROAD) sc.junctions.delete(cell);
    if (this.view.selected === cell) this.view.selected = -1;
    return true;
  }

  /** Cells on the straight line between two cells, so a fast drag leaves no holes. */
  private between(from: number, to: number): number[] {
    const cols = this.scenario.cols;
    let c = from % cols;
    let r = Math.floor(from / cols);
    const c1 = to % cols;
    const r1 = Math.floor(to / cols);
    const out: number[] = [];
    while (c !== c1 || r !== r1) {
      // Move along one axis at a time so the road never steps diagonally.
      if (Math.abs(c1 - c) >= Math.abs(r1 - r)) c += Math.sign(c1 - c);
      else r += Math.sign(r1 - r);
      out.push(r * cols + c);
    }
    return out;
  }

  private select(cell: number): void {
    const kind = cell >= 0 ? this.scenario.cells[cell] : EMPTY;
    const junction = this.view.network?.nodes.some((n) => n.cell === cell && n.canSignal);
    this.view.selected = kind === HOUSE || junction ? cell : -1;
    this.renderInspector();
  }

  private renderInspector(): void {
    const host = $("inspector");
    const sc = this.scenario;
    const cell = this.view.selected;
    host.replaceChildren();
    const note = (text: string) => {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = text;
      return p;
    };
    if (cell < 0) {
      host.append(
        note(
          "With the Select tool, pick a junction to give it its own controller, or a house to change how many trips it makes.",
        ),
      );
      return;
    }
    const where = `column ${(cell % sc.cols) + 1}, row ${Math.floor(cell / sc.cols) + 1}`;
    const label = document.createElement("label");
    label.className = "field";
    const caption = document.createElement("span");
    const select = document.createElement("select");
    label.append(caption, select);
    const option = (value: string, text: string) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      select.append(o);
    };
    if (sc.cells[cell] === HOUSE) {
      caption.textContent = `House at ${where}`;
      for (const w of [0.5, 1, 2, 4, 8])
        option(String(w), w === 1 ? "Normal share of trips" : `${w} times the trips`);
      select.value = String(sc.weights.get(cell) ?? 1);
      select.addEventListener("change", () => {
        this.snapshot();
        sc.weights.set(cell, Number(select.value));
        this.rebuild();
      });
    } else {
      caption.textContent = `Junction at ${where}`;
      const town = this.core.info.controllers.find((c) => c.id === sc.controller)?.label ?? "";
      option("", `Same as the town (${town})`);
      for (const c of this.core.info.controllers) option(c.id, c.label);
      option("none", "No signal: give way");
      select.value = sc.junctions.get(cell) ?? "";
      select.addEventListener("change", () => {
        this.snapshot();
        if (select.value) sc.junctions.set(cell, select.value);
        else sc.junctions.delete(cell);
        this.rebuild();
      });
    }
    host.append(label);
  }

  // ----- controls -----

  private fillControls(): void {
    const controller = $<HTMLSelectElement>("controller");
    for (const c of this.core.info.controllers) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.label;
      controller.append(o);
    }
  }

  private syncControls(): void {
    const sc = this.scenario;
    const info = this.core.info.controllers.find((c) => c.id === sc.controller);
    $("controller-summary").textContent = info?.summary ?? "";
    $("demand-value").textContent = sc.demand.toLocaleString("en");
    $("follow-summary").textContent = FOLLOW_NOTES[sc.follow];
    for (const b of document.querySelectorAll<HTMLInputElement>("#follow input")) {
      b.checked = b.value === sc.follow;
    }
    const max = Number($<HTMLInputElement>("demand").max);
    if (sc.demand > max) $<HTMLInputElement>("demand").max = String(sc.demand);
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    for (const b of document.querySelectorAll<HTMLElement>(".tools [data-tool]")) {
      b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    }
    this.view.canvas.dataset.tool = tool;
  }

  private setPlaying(playing: boolean): void {
    this.playing = playing;
    const button = $("play");
    button.setAttribute("aria-label", playing ? "Pause" : "Play");
    button.querySelector("use")?.setAttribute("href", playing ? "#i-pause" : "#i-play");
  }

  private stepOnce(): void {
    if (!this.sim) return;
    this.setPlaying(false);
    this.sim.step(Math.round(1 / this.core.info.dt));
    this.pushFrame();
    this.pushFrame();
    this.updateStats();
  }

  private zoom(factor: number): void {
    const box = this.view.canvas.getBoundingClientRect();
    this.view.zoomAt(factor, box.width / 2, box.height / 2);
  }

  private bindControls(): void {
    for (const b of document.querySelectorAll<HTMLElement>(".tools [data-tool]")) {
      b.addEventListener("click", () => this.setTool(b.dataset.tool as Tool));
    }
    $("undo").addEventListener("click", () => this.undo());
    $("zoom-in").addEventListener("click", () => this.zoom(1.3));
    $("zoom-out").addEventListener("click", () => this.zoom(1 / 1.3));
    $("zoom-fit").addEventListener("click", () => this.view.fit());
    $("play").addEventListener("click", () => this.setPlaying(!this.playing));
    $("step").addEventListener("click", () => this.stepOnce());
    $("restart").addEventListener("click", () => this.rebuild());
    for (const b of document.querySelectorAll<HTMLInputElement>("#speed input")) {
      b.addEventListener("change", () => {
        this.speed = Number(b.value);
      });
    }
    $<HTMLSelectElement>("controller").addEventListener("change", (e) => {
      this.scenario.controller = (e.target as HTMLSelectElement).value;
      this.sim?.setController(this.scenario.controller);
      if (this.sim) this.view.network = this.sim.network();
      this.syncControls();
      this.renderInspector();
    });
    $<HTMLInputElement>("demand").addEventListener("input", (e) => {
      this.scenario.demand = Number((e.target as HTMLInputElement).value);
      this.sim?.setDemand(this.scenario.demand);
      this.syncControls();
    });
    for (const b of document.querySelectorAll<HTMLInputElement>("#follow input")) {
      b.addEventListener("change", () => {
        this.scenario.follow = b.value as Scenario["follow"];
        this.syncControls();
        this.rebuild();
      });
    }
    $<HTMLInputElement>("seed").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      this.seed = Math.min(999999, Math.max(1, Math.round(Number(input.value) || 1)));
      input.value = String(this.seed);
      this.rebuild();
    });
  }

  private bindCanvas(): void {
    const canvas = this.view.canvas;
    const local = (e: PointerEvent | WheelEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        // A second finger turns the gesture into pan and zoom; undo any mark the first one made.
        if (this.stroke?.changed) this.undo();
        this.stroke = null;
        const [a, b] = [...this.pointers.values()];
        this.pinch = {
          distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
          x: (a!.x + b!.x) / 2,
          y: (a!.y + b!.y) / 2,
        };
        return;
      }
      const panning = this.tool === "select" || e.button !== 0;
      const cell = this.view.cellAt(p.x, p.y);
      this.stroke = { last: cell, changed: false, moved: 0, panning };
      if (!panning && cell >= 0) {
        this.snapshot();
        if (this.apply(cell, false)) {
          this.stroke.changed = true;
          this.view.network = null;
          this.view.clearCars();
        } else {
          this.undoStack.pop();
        }
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const before = this.pointers.get(e.pointerId);
      if (!before) return;
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const x = (a!.x + b!.x) / 2;
        const y = (a!.y + b!.y) / 2;
        this.view.ox += x - this.pinch.x;
        this.view.oy += y - this.pinch.y;
        if (this.pinch.distance > 0) this.view.zoomAt(distance / this.pinch.distance, x, y);
        this.pinch = { distance, x, y };
        return;
      }
      const stroke = this.stroke;
      if (!stroke) return;
      stroke.moved += Math.abs(p.x - before.x) + Math.abs(p.y - before.y);
      if (stroke.panning) {
        if (stroke.moved > 4) {
          this.view.ox += p.x - before.x;
          this.view.oy += p.y - before.y;
        }
        return;
      }
      const cell = this.view.cellAt(p.x, p.y);
      if (cell < 0 || cell === stroke.last || this.tool === "house") return;
      if (!stroke.changed) this.snapshot();
      let changed = false;
      for (const c of stroke.last < 0 ? [cell] : this.between(stroke.last, cell)) {
        changed = this.apply(c, true) || changed;
      }
      stroke.last = cell;
      if (changed) {
        stroke.changed = true;
        this.view.network = null;
        this.view.clearCars();
      } else if (!stroke.changed) {
        this.undoStack.pop();
      }
    });
    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const stroke = this.stroke;
      if (!stroke || this.pointers.size > 0) return;
      this.stroke = null;
      if (stroke.changed) this.rebuild();
      else if (stroke.panning && stroke.moved <= 4 && p && e.type === "pointerup") {
        this.select(this.view.cellAt(p.x, p.y));
      }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = local(e);
        this.view.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
      },
      { passive: false },
    );
    canvas.addEventListener("focus", () => {
      if (!canvas.matches(":focus-visible")) return;
      if (this.view.cursor < 0) {
        const box = canvas.getBoundingClientRect();
        this.view.cursor = Math.max(0, this.view.cellAt(box.width / 2, box.height / 2));
      }
    });
    canvas.addEventListener("blur", () => {
      this.view.cursor = -1;
    });
    canvas.addEventListener("keydown", (e) => this.key(e));
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && this.visible) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT") return;
        e.preventDefault();
        this.undo();
      }
    });
  }

  private key(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sc = this.scenario;
    const view = this.view;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const move = moves[e.key];
    if (move) {
      const at = Math.max(view.cursor, 0);
      const c = Math.min(sc.cols - 1, Math.max(0, (at % sc.cols) + move[0]));
      const r = Math.min(sc.rows - 1, Math.max(0, Math.floor(at / sc.cols) + move[1]));
      view.cursor = r * sc.cols + c;
      view.reveal(view.cursor);
    } else if (e.key === "Enter" || e.key === " ") {
      if (view.cursor < 0) return;
      if (this.tool === "select") this.select(view.cursor);
      else {
        this.snapshot();
        if (this.apply(view.cursor, false)) this.rebuild();
        else this.undoStack.pop();
      }
    } else if ("vrhe".includes(e.key.toLowerCase()) && e.key.length === 1) {
      const tools: Record<string, Tool> = { v: "select", r: "road", h: "house", e: "erase" };
      this.setTool(tools[e.key.toLowerCase()]!);
    } else if (e.key === "+" || e.key === "=") this.zoom(1.3);
    else if (e.key === "-") this.zoom(1 / 1.3);
    else if (e.key === "0") view.fit();
    else if (e.key.toLowerCase() === "p") this.setPlaying(!this.playing);
    else if (e.key === ".") this.stepOnce();
    else return;
    e.preventDefault();
  }
}
