/** The Compare view: the same seeded traffic under several controllers, side by side. */
import { clock, delayPerMinute } from "./build.ts";
import {
  type Bar,
  barChart,
  estimate,
  lineChart,
  minuteTicks,
  paintKey,
  type Series,
} from "./charts.ts";
import { MapView, readPalette } from "./mapview.ts";
import { formatScenario, type Scenario } from "./scenario.ts";
import type { ControllerInfo, Core, Metrics, Simulation } from "./wasm.ts";
import type { Job, Reply } from "./worker.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const SEEDS = 8;
/** Simulated seconds advanced per real second while tiles animate. */
const PLAYBACK = 60;
/**
 * How a controller is drawn: the site has four meaning colours and there are five controllers,
 * so the fifth, capacity-aware pressure, takes the colour of max pressure, which it refines, and
 * is drawn hollow and dashed.
 */
const markOf = (i: number): { colour: string; hollow: boolean } => ({
  colour: `var(--series-${Math.min(i, 3) + 1})`,
  hollow: i > 3,
});

interface Tile {
  info: ControllerInfo;
  colour: string;
  hollow: boolean;
  sim: Simulation;
  view: MapView;
  readout: HTMLElement;
}

interface Row {
  info: ControllerInfo;
  colour: string;
  hollow: boolean;
  runs: Metrics[];
}

export class CompareView {
  private tiles: Tile[] = [];
  private rows: Row[] = [];
  private replicated = false;
  private duration = 1200;
  private elapsed = 0;
  private owed = 0;
  private lastFrame = 0;
  private lastCharts = 0;
  private running = false;
  private visible = false;
  private worker: Worker | null = null;
  private looping = false;

  constructor(
    private readonly core: Core,
    private readonly source: () => { scenario: Scenario; seed: number },
  ) {
    const host = $("compare-controllers");
    core.info.controllers.forEach((c, i) => {
      const label = document.createElement("label");
      label.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = c.id;
      box.checked = true;
      const key = document.createElement("i");
      paintKey(key, markOf(i));
      label.append(box, key, c.label);
      host.append(label);
    });
    $<HTMLFormElement>("compare-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.startLive();
    });
    $("compare-seeds").addEventListener("click", () => this.startSeeds());
    new ResizeObserver(() => this.renderResults()).observe($("compare-results"));
  }

  /** Draw on the next frame; the loop keeps going only while a live run is under way. */
  private kick(): void {
    if (this.looping) return;
    this.looping = true;
    requestAnimationFrame((t) => this.frame(t));
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.lastFrame = 0;
    if (!visible) return;
    const { scenario, seed } = this.source();
    $("compare-intro").textContent =
      `Each controller gets the map above and exactly the same trips: ${scenario.demand.toLocaleString("en")} an hour, seed ${seed}. The first quarter of each run lets the traffic build up and is not measured. Nothing has run yet: choose the controllers and press Run side by side.`;
    for (const t of this.tiles) t.view.resize();
    this.renderResults();
    this.kick();
  }

  themeChanged(): void {
    for (const t of this.tiles) t.view.palette = readPalette();
    this.renderResults();
  }

  private chosen(): { info: ControllerInfo; colour: string; hollow: boolean }[] {
    const boxes = [...document.querySelectorAll<HTMLInputElement>("#compare-controllers input")];
    return this.core.info.controllers
      .map((info, i) => ({ info, ...markOf(i), on: boxes[i]?.checked }))
      .filter((c) => c.on);
  }

  private status(text: string): void {
    $("compare-status").textContent = text;
  }

  private stop(): void {
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
    for (const t of this.tiles) t.sim.free();
    this.tiles = [];
    $("compare-tiles").replaceChildren();
  }

  // ----- live, side by side -----

  private startLive(): void {
    const chosen = this.chosen();
    if (chosen.length === 0) {
      this.status("Choose at least one controller.");
      return;
    }
    this.stop();
    const { scenario, seed } = this.source();
    this.duration = Number($<HTMLSelectElement>("compare-duration").value);
    this.elapsed = 0;
    this.owed = 0;
    this.replicated = false;
    const host = $("compare-tiles");
    try {
      for (const c of chosen) {
        const sim = this.core.simulate(formatScenario(scenario, c.info.id), seed);
        sim.setWarmup(this.duration / 4);
        const figure = document.createElement("figure");
        figure.className = "tile";
        const caption = document.createElement("figcaption");
        const key = document.createElement("i");
        paintKey(key, c);
        const name = document.createElement("strong");
        name.textContent = c.info.label;
        const readout = document.createElement("span");
        caption.append(key, name, readout);
        const canvas = document.createElement("canvas");
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `The map under ${c.info.label} control`);
        figure.append(caption, canvas);
        host.append(figure);
        const view = new MapView(canvas, this.core.info.cell);
        view.scenario = scenario;
        view.setNetwork(sim.network());
        view.resize();
        view.fit(0.6);
        this.tiles.push({ ...c, sim, view, readout });
      }
    } catch (error) {
      this.stop();
      this.status(error instanceof Error ? error.message : String(error));
      return;
    }
    this.rows = this.tiles.map((t) => ({
      info: t.info,
      colour: t.colour,
      hollow: t.hollow,
      runs: [],
    }));
    this.running = true;
    $("compare-results").hidden = false;
    this.collectLive();
    this.renderResults();
    this.kick();
  }

  private collectLive(): void {
    this.tiles.forEach((t, i) => {
      const s = t.sim.stats();
      this.rows[i]!.runs = [s.metrics];
      const stopped = `${s.queued} ${s.queued === 1 ? "car" : "cars"} stopped`;
      const held = s.metrics.delay_all.toFixed(0);
      t.readout.textContent =
        s.metrics.finished > 0
          ? `${held} ${held === "1" ? "second" : "seconds"} hold-up, ${stopped}`
          : stopped;
    });
  }

  private frame(now: number): void {
    this.looping = false;
    if (!this.visible || this.tiles.length === 0) {
      this.lastFrame = 0;
      return;
    }
    const real = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    const dt = this.core.info.dt;
    if (this.running) {
      this.owed += real * PLAYBACK;
      const left = Math.round((this.duration - this.elapsed) / dt);
      const steps = Math.min(Math.floor(this.owed / dt), left, 120);
      if (steps > 0) {
        this.owed -= steps * dt;
        this.elapsed += steps * dt;
        for (const t of this.tiles) {
          t.sim.step(steps);
          t.view.setFrame(t.sim.cars(), t.sim.lights());
        }
      }
      const finished = this.elapsed >= this.duration - dt / 2;
      if (finished || now - this.lastCharts > 700) {
        this.lastCharts = now;
        this.collectLive();
        this.renderResults();
      }
      if (finished) {
        this.running = false;
        this.status(
          `Finished: ${clock(this.duration)} of town time with one seed. One run can mislead; repeat with ${SEEDS} seeds to see how much the result varies.`,
        );
      } else {
        this.status(`Running: ${clock(this.elapsed)} of ${clock(this.duration)} of town time.`);
      }
    }
    for (const t of this.tiles) t.view.draw(1);
    if (this.running) {
      this.looping = true;
      requestAnimationFrame((t) => this.frame(t));
    } else {
      this.lastFrame = 0;
    }
  }

  // ----- many seeds, in a worker -----

  private startSeeds(): void {
    const chosen = this.chosen();
    if (chosen.length === 0) {
      this.status("Choose at least one controller.");
      return;
    }
    this.stop();
    const { scenario, seed } = this.source();
    this.duration = Number($<HTMLSelectElement>("compare-duration").value);
    this.rows = chosen.map((c) => ({ ...c, runs: [] }));
    this.replicated = true;
    const job: Job = { runs: [], duration: this.duration, warmup: this.duration / 4 };
    for (let k = 0; k < SEEDS; k++) {
      for (const c of chosen) {
        job.runs.push({
          key: c.info.id,
          scenario: formatScenario(scenario, c.info.id),
          seed: seed + k,
        });
      }
    }
    let done = 0;
    this.status(`Running ${job.runs.length} simulations in the background.`);
    $("compare-results").hidden = false;
    this.renderResults();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      if (reply.kind === "run") {
        this.rows.find((r) => r.info.id === reply.key)?.runs.push(reply.metrics);
        done++;
        this.status(`Running: ${done} of ${job.runs.length} simulations finished.`);
        if (done % chosen.length === 0) this.renderResults();
      } else if (reply.kind === "done") {
        this.status(
          `Finished: ${SEEDS} seeds (${seed} to ${seed + SEEDS - 1}), ${clock(this.duration)} each. Bars show the mean; whiskers the 95% interval over seeds.`,
        );
        this.renderResults();
        worker.terminate();
      } else {
        this.status(`The run failed: ${reply.message}`);
        worker.terminate();
      }
    };
    worker.onerror = () => this.status("The background run failed to start.");
    worker.postMessage(job);
  }

  // ----- results -----

  private renderResults(): void {
    if (!this.visible || $("compare-results").hidden) return;
    const rows = this.rows.filter((r) => r.runs.length > 0);
    const bars = (pick: (m: Metrics) => number, note: (r: Row) => string): Bar[] =>
      rows.map((r) => {
        const e = estimate(r.runs.map(pick));
        return {
          label: r.info.label,
          colour: r.colour,
          hollow: r.hollow,
          value: e.mean,
          interval: r.runs.length > 1 ? e.interval : undefined,
          note: note(r),
        };
      });
    const mean = (r: Row, pick: (m: Metrics) => number) => estimate(r.runs.map(pick)).mean;
    barChart($("chart-delay"), {
      bars: bars(
        (m) => m.delay_all,
        (r) => {
          const n = mean(r, (m) => m.unfinished).toFixed(0);
          return `${n} ${n === "1" ? "trip" : "trips"} unfinished at the end`;
        },
      ),
      format: (v) => v.toFixed(v < 10 ? 1 : 0),
      unit: " seconds",
      description: "Average hold-up per trip for each controller.",
    });
    barChart($("chart-flow"), {
      bars: bars(
        (m) => m.throughput,
        (r) => {
          const n = mean(r, (m) => m.demand).toFixed(0);
          return `${n} ${n === "1" ? "trip" : "trips"} an hour asked for`;
        },
      ),
      format: (v) => Math.round(v).toLocaleString("en"),
      description: "Trips finished per hour for each controller.",
    });
    $("cap-delay-note").textContent =
      "Seconds lost against driving the route on an empty road. Trips still under way count at their hold-up so far.";
    const asked = rows[0] ? mean(rows[0], (m) => m.demand) : 0;
    $("cap-flow-note").textContent =
      `${Math.round(asked).toLocaleString("en")} an hour were asked for. Less than that means queues are growing.`;

    const timeFigure = $("chart-time").closest("figure") as HTMLElement;
    timeFigure.hidden = this.replicated || this.tiles.length === 0;
    if (!timeFigure.hidden) {
      const series: Series[] = this.tiles.map((t) => ({
        label: t.info.label,
        colour: t.colour,
        dashed: t.hollow,
        points: delayPerMinute(t.sim.series()),
      }));
      lineChart($("chart-time"), {
        series,
        x: (v) => clock(v),
        xTicks: minuteTicks,
        y: (v) => `${Math.round(v)} s`,
        shadeBelow: this.duration / 4,
        shadeLabel: "build-up, not measured",
        description:
          "Average hold-up in seconds of trips finishing in each minute of town time, one line per controller.",
      });
      const legend = $("legend-time");
      legend.replaceChildren(
        ...this.tiles.map((t) => {
          const item = document.createElement("span");
          const key = document.createElement("i");
          paintKey(key, t);
          item.append(key, t.info.label);
          return item;
        }),
      );
    }
    this.renderTable(rows);
  }

  private renderTable(rows: Row[]): void {
    const table = $("compare-table");
    const many = rows.some((r) => r.runs.length > 1);
    const cell = (r: Row, pick: (m: Metrics) => number, digits: number) => {
      const e = estimate(r.runs.map(pick));
      const value = e.mean.toLocaleString("en", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
      return many && Number.isFinite(e.interval)
        ? `${value} ± ${e.interval.toFixed(digits)}`
        : value;
    };
    const columns: [string, (r: Row) => string][] = [
      ["Average hold-up, seconds", (r) => cell(r, (m) => m.delay_all, 1)],
      ["Finished trips only, seconds", (r) => cell(r, (m) => m.delay_mean, 1)],
      ["Slowest 5%, seconds", (r) => cell(r, (m) => m.delay_p95, 0)],
      ["Finished an hour", (r) => cell(r, (m) => m.throughput, 0)],
      ["Unfinished", (r) => cell(r, (m) => m.unfinished, 0)],
      ["Cars stopped, on average", (r) => cell(r, (m) => m.queue_mean, 1)],
      ["Stops per trip", (r) => cell(r, (m) => m.stops_per_trip, 2)],
    ];
    const head = document.createElement("tr");
    head.append(
      Object.assign(document.createElement("th"), { textContent: "Controller", scope: "col" }),
    );
    for (const [name] of columns) {
      head.append(Object.assign(document.createElement("th"), { textContent: name, scope: "col" }));
    }
    const body = rows.map((r) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      const key = document.createElement("i");
      paintKey(key, r);
      th.append(key, r.info.label);
      tr.append(th);
      for (const [, value] of columns) {
        tr.append(Object.assign(document.createElement("td"), { textContent: value(r) }));
      }
      return tr;
    });
    const caption = document.createElement("caption");
    caption.textContent = many
      ? `Mean ± 95% interval over ${rows[0]?.runs.length ?? 0} seeds`
      : "One seed, measured after the build-up";
    table.replaceChildren(caption, head, ...body);
  }
}
