import { compareControllers } from "../core/compare.ts";
import { TripSource } from "../core/demand.ts";
import {
  cellAt,
  createWorld,
  parseWorld,
  toggleHouse,
  toggleRoad,
  type World,
} from "../core/grid.ts";
import { DEFAULT_MAP, maps } from "../core/maps.ts";
import { controllers, getController } from "../core/signals.ts";
import { Simulation } from "../core/sim.ts";
import { draw, SCALE } from "./render.ts";

const DT = 0.1;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("city");
const mapSelect = $<HTMLSelectElement>("map");
const controllerSelect = $<HTMLSelectElement>("controller");
const rateInput = $<HTMLInputElement>("rate");
const speedSelect = $<HTMLSelectElement>("speed");

let world: World;
let sim: Simulation;
let source = new TripSource(1);
let playing = true;
let owed = 0;
let lastFrame = 0;

const rate = (): number => Number(rateInput.value);
const controller = () => getController(controllerSelect.value);

function loadWorld(next: World): void {
  world = next;
  canvas.width = world.cols * SCALE;
  canvas.height = world.rows * SCALE;
  restart();
}

function restart(): void {
  sim = new Simulation(world, controller());
  source = new TripSource(1);
  owed = 0;
  $("comparison").replaceChildren();
  renderStats();
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function renderStats(): void {
  const s = sim.stats();
  const rows: [string, string, string][] = [
    ["Time", clock(s.time), "time"],
    ["Cars on the road", String(s.active), "active"],
    ["Waiting to enter", String(s.queued), "queued"],
    ["Trips finished", String(s.arrived), "arrived"],
    ["Mean delay", `${s.meanDelay.toFixed(1)} s`, "delay"],
    ["Mean standing", `${s.meanWait.toFixed(1)} s`, "wait"],
  ];
  $("stats").replaceChildren(
    ...rows.map(([name, value, id]) => {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = name;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dd.dataset.stat = id;
      wrap.append(dt, dd);
      return wrap;
    }),
  );
}

function renderComparison(): void {
  // Work on a copy so the comparison cannot disturb the live map.
  const copy: World = { ...world, roads: new Set(world.roads), houses: new Set(world.houses) };
  const results = compareControllers(copy, {
    duration: 600,
    carsPerMinute: rate(),
    seed: 1,
    dt: DT,
  });
  const box = $("comparison");
  box.replaceChildren();
  const colors = ["var(--bar-1)", "var(--bar-2)"];
  const bars = (title: string, pick: (i: number) => number): void => {
    const heading = document.createElement("div");
    heading.className = "bar-title";
    heading.textContent = title;
    box.append(heading);
    const max = Math.max(...results.map((_, i) => pick(i)), 1e-9);
    results.forEach((result, i) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      row.append(result.controller.label);
      const track = document.createElement("div");
      track.className = "bar-track";
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.style.width = `${(pick(i) / max) * 75}%`;
      bar.style.background = colors[i]!;
      const value = document.createElement("span");
      value.className = "bar-value";
      value.textContent = `${pick(i).toFixed(1)} s`;
      track.append(bar, value);
      row.append(track);
      box.append(row);
    });
  };
  bars("Mean delay per trip", (i) => results[i]!.stats.meanDelay);
  bars("Mean time standing", (i) => results[i]!.stats.meanWait);

  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const text of ["", "Finished", "On road", "Not entered"]) {
    const th = document.createElement("th");
    th.textContent = text;
    head.append(th);
  }
  const body = table.createTBody();
  for (const { controller: c, stats } of results) {
    const row = body.insertRow();
    for (const text of [c.label, stats.arrived, stats.active, stats.queued]) {
      row.insertCell().textContent = String(text);
    }
  }
  box.append(table);
}

function setup(): void {
  for (const [id, map] of Object.entries(maps)) mapSelect.add(new Option(map.label, id));
  mapSelect.value = DEFAULT_MAP;
  for (const c of controllers) controllerSelect.add(new Option(c.label, c.id));
  controllerSelect.value = "adaptive";

  const showController = (): void => {
    $("controller-summary").textContent = controller().summary;
  };
  showController();

  mapSelect.addEventListener("change", () => loadWorld(parseWorld(maps[mapSelect.value]!.text)));
  controllerSelect.addEventListener("change", () => {
    sim.controller = controller();
    sim.resetStats();
    showController();
  });
  rateInput.addEventListener("input", () => {
    $("rate-out").textContent = rateInput.value;
  });
  $("play").addEventListener("click", () => {
    playing = !playing;
    $("play").textContent = playing ? "Pause" : "Play";
  });
  $("reset").addEventListener("click", restart);
  $("clear").addEventListener("click", () => loadWorld(createWorld(world.cols, world.rows)));
  $("compare").addEventListener("click", renderComparison);

  const tool = (): string =>
    (document.querySelector('input[name="tool"]:checked') as HTMLInputElement).value;
  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "h" || event.target instanceof HTMLSelectElement) return;
    const next = tool() === "road" ? "house" : "road";
    (document.querySelector(`input[name="tool"][value="${next}"]`) as HTMLInputElement).checked =
      true;
  });
  canvas.addEventListener("click", (event) => {
    const box = canvas.getBoundingClientRect();
    const col = Math.floor(((event.clientX - box.left) / box.width) * world.cols);
    const row = Math.floor(((event.clientY - box.top) / box.height) * world.rows);
    if (col < 0 || col >= world.cols || row < 0 || row >= world.rows) return;
    const cell = cellAt(world, row, col);
    if (tool() === "house") toggleHouse(world, cell);
    else toggleRoad(world, cell);
    sim.mapChanged();
  });
  $("controls").addEventListener("submit", (event) => event.preventDefault());

  loadWorld(parseWorld(maps[DEFAULT_MAP]!.text));
}

function frame(now: number): void {
  const elapsed = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (playing) {
    owed += elapsed * Number(speedSelect.value);
    let steps = 0;
    while (owed >= DT && steps < 40) {
      sim.addTrips(source.take(world, rate(), sim.time + DT));
      sim.step(DT);
      owed -= DT;
      steps++;
    }
    if (steps > 0) renderStats();
  }
  draw(canvas, sim);
  requestAnimationFrame(frame);
}

setup();
requestAnimationFrame((now) => {
  lastFrame = now;
  frame(now);
});
