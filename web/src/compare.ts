/** The Compare view: the same seeded traffic under several controllers, side by side. */
import { clock, delayPerMinute } from "./build.ts";
import { type Bar, barChart, estimate, lineChart, minuteTicks, type Series } from "./charts.ts";
import { MapView, readPalette } from "./mapview.ts";
import { formatScenario, type Scenario } from "./scenario.ts";
import type { ControllerInfo, Core, Metrics, Simulation } from "./wasm.ts";
import type { Job, Reply } from "./worker.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const SEEDS = 8;
/** Simulated seconds advanced per real second while tiles animate. */
const PLAYBACK = 60;

interface Tile {
  info: ControllerInfo;
  colour: string;
  sim: Simulation;
  view: MapView;
  readout: HTMLElement;
}

interface Row {
  info: ControllerInfo;
  colour: string;
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
      key.style.background = `var(--series-${i + 1})`;
      label.append(box, key, c.label);
      host.append(label);
    });
    $<HTMLFormElement>("compare-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.startLive();
    });
    $("compare-seeds").addEventListener("click", () => this.startSeeds());
    new ResizeObserver(() => this.renderResults()).observe($("compare-results"));
    requestAnimationFrame((t) => this.frame(t));
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.lastFrame = 0;
    if (!visible) return;
    const { scenario, seed } = this.source();
    $("compare-intro").textContent =
      `Each controller gets the map from Build and exactly the same trips: ${scenario.demand.toLocaleString("en")} an hour, seed ${seed}. The first quarter of the run is warm-up and is not measured.`;
    for (const t of this.tiles) t.view.resize();
    this.renderResults();
  }

  themeChanged(): void {
    for (const t of this.tiles) t.view.palette = readPalette();
    this.renderResults();
  }

  private chosen(): { info: ControllerInfo; colour: string }[] {
    const boxes = [...document.querySelectorAll<HTMLInputElement>("#compare-controllers input")];
    return this.core.info.controllers
      .map((info, i) => ({ info, colour: `var(--series-${i + 1})`, on: boxes[i]?.checked }))
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
        key.style.background = c.colour;
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
    this.rows = this.tiles.map((t) => ({ info: t.info, colour: t.colour, runs: [] }));
    this.running = true;
    $("compare-results").hidden = false;
    this.collectLive();
    this.renderResults();
  }

  private collectLive(): void {
    this.tiles.forEach((t, i) => {
      const s = t.sim.stats();
      this.rows[i]!.runs = [s.metrics];
      t.readout.textContent =
        s.metrics.finished > 0
          ? `${s.metrics.delay_all.toFixed(0)} s delay, ${s.queued} standing`
          : `${s.queued} standing`;
    });
  }

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    if (!this.visible || this.tiles.length === 0) return;
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
          `Finished: ${clock(this.duration)} simulated with one seed. One run can mislead; repeat with ${SEEDS} seeds for intervals.`,
        );
      } else {
        this.status(`Running: ${clock(this.elapsed)} of ${clock(this.duration)} simulated.`);
      }
    }
    for (const t of this.tiles) t.view.draw(1);
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
          value: e.mean,
          interval: r.runs.length > 1 ? e.interval : undefined,
          note: note(r),
        };
      });
    const mean = (r: Row, pick: (m: Metrics) => number) => estimate(r.runs.map(pick)).mean;
    barChart($("chart-delay"), {
      bars: bars(
        (m) => m.delay_all,
        (r) => `${mean(r, (m) => m.unfinished).toFixed(0)} trips unfinished at the end`,
      ),
      format: (v) => v.toFixed(v < 10 ? 1 : 0),
      unit: " s",
      description: "Mean delay per trip for each controller.",
    });
    barChart($("chart-flow"), {
      bars: bars(
        (m) => m.throughput,
        (r) => `${mean(r, (m) => m.demand).toFixed(0)} trips an hour asked for`,
      ),
      format: (v) => Math.round(v).toLocaleString("en"),
      description: "Trips finished per hour for each controller.",
    });
    $("cap-delay-note").textContent =
      "Seconds lost against driving the route alone. Trips still under way count at their delay so far.";
    const asked = rows[0] ? mean(rows[0], (m) => m.demand) : 0;
    $("cap-flow-note").textContent =
      `${Math.round(asked).toLocaleString("en")} an hour were asked for. Less than that means queues are growing.`;

    const timeFigure = $("chart-time").closest("figure") as HTMLElement;
    timeFigure.hidden = this.replicated || this.tiles.length === 0;
    if (!timeFigure.hidden) {
      const series: Series[] = this.tiles.map((t) => ({
        label: t.info.label,
        colour: t.colour,
        points: delayPerMinute(t.sim.series()),
      }));
      lineChart($("chart-time"), {
        series,
        x: (v) => clock(v),
        xTicks: minuteTicks,
        y: (v) => `${Math.round(v)} s`,
        shadeBelow: this.duration / 4,
        shadeLabel: "warm-up",
        description:
          "Mean delay of trips finishing in each simulated minute, one line per controller.",
      });
      const legend = $("legend-time");
      legend.replaceChildren(
        ...this.tiles.map((t) => {
          const item = document.createElement("span");
          const key = document.createElement("i");
          key.style.background = t.colour;
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
      ["Mean delay, s", (r) => cell(r, (m) => m.delay_all, 1)],
      ["Finished trips only, s", (r) => cell(r, (m) => m.delay_mean, 1)],
      ["Slowest 5%, s", (r) => cell(r, (m) => m.delay_p95, 0)],
      ["Finished an hour", (r) => cell(r, (m) => m.throughput, 0)],
      ["Unfinished", (r) => cell(r, (m) => m.unfinished, 0)],
      ["Standing cars", (r) => cell(r, (m) => m.queue_mean, 1)],
      ["Stops a trip", (r) => cell(r, (m) => m.stops_per_trip, 2)],
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
      key.style.background = r.colour;
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
      : "One seed, measured after the warm-up";
    table.replaceChildren(caption, head, ...body);
  }
}
