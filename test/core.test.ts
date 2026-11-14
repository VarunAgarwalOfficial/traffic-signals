import assert from "node:assert/strict";
import { test } from "node:test";
import { acceleration, makeDriver, safeGap } from "../src/core/car.ts";
import { compareControllers } from "../src/core/compare.ts";
import { type Trip, TripSource } from "../src/core/demand.ts";
import {
  cellAt,
  createWorld,
  junctions,
  parseWorld,
  roadNeighbours,
  toggleRoad,
  type World,
} from "../src/core/grid.ts";
import { maps } from "../src/core/maps.ts";
import { createRng } from "../src/core/rng.ts";
import { findRoute } from "../src/core/route.ts";
import {
  controllers,
  createSignal,
  FIXED_GREEN,
  getController,
  lightFor,
  MIN_GREEN,
  stepSignal,
} from "../src/core/signals.ts";
import { Simulation, STOP_LINE } from "../src/core/sim.ts";
import { watch } from "./helpers.ts";

const fixed = getController("fixed");
const adaptive = getController("adaptive");

/** Breadth-first search: the reference for the shortest number of steps. */
function bfsLength(world: World, start: number, goal: number): number | null {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  for (const cell of queue) {
    if (cell === goal) return dist.get(cell)!;
    for (const next of roadNeighbours(world, cell)) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(cell)! + 1);
        queue.push(next);
      }
    }
  }
  return null;
}

test("A* routes are connected and as short as breadth-first search finds", () => {
  const rng = createRng(11);
  for (let round = 0; round < 60; round++) {
    const world = createWorld(12, 9);
    for (let cell = 0; cell < 12 * 9; cell++) if (rng.next() < 0.62) world.roads.add(cell);
    const roads = [...world.roads];
    const start = roads[rng.int(0, roads.length - 1)]!;
    const goal = roads[rng.int(0, roads.length - 1)]!;
    const route = findRoute(world, start, goal);
    const best = bfsLength(world, start, goal);
    if (best === null) {
      assert.equal(route, null);
      continue;
    }
    assert.ok(route);
    assert.equal(route.length - 1, best);
    for (let i = 1; i < route.length; i++) {
      assert.ok(roadNeighbours(world, route[i - 1]!).includes(route[i]!));
    }
  }
});

test("the following rule is zero at the wanted gap, monotonic and bounded", () => {
  const driver = makeDriver(0.5);
  assert.equal(acceleration(driver, safeGap(driver, 8), 8), 0);
  assert.equal(acceleration(driver, Number.POSITIVE_INFINITY, 5), driver.maxAccel);
  let last = Number.NEGATIVE_INFINITY;
  for (let gap = -5; gap <= 200; gap += 0.5) {
    const a = acceleration(driver, gap, 10);
    assert.ok(a >= last && a >= -driver.maxBrake && a <= driver.maxAccel);
    last = a;
  }
  // Closing in on a stopped car calls for more room than following a moving one.
  assert.ok(acceleration(driver, 30, 12, 0) < acceleration(driver, 30, 12, 12));
});

test("signals: fixed time cycles, adaptive follows demand, never both sides go", () => {
  const signal = createSignal();
  let switchedAt = -1;
  for (let i = 0; i < 1000; i++) {
    stepSignal(signal, fixed, { ns: 0, ew: 0 }, 0.1);
    assert.ok(lightFor(signal, "ns") === "red" || lightFor(signal, "ew") === "red");
    if (switchedAt < 0 && signal.axis === "ew") switchedAt = i / 10;
  }
  assert.ok(switchedAt > FIXED_GREEN && switchedAt < FIXED_GREEN + 6, "green, amber, all red");

  const after = (demand: { ns: number; ew: number }, seconds: number) => {
    const s = createSignal();
    for (let i = 0; i < seconds * 10; i++) stepSignal(s, adaptive, demand, 0.1);
    return s.stage;
  };
  assert.equal(after({ ns: 5, ew: 0 }, 300), "green", "nobody waits: stay green");
  assert.equal(after({ ns: 0, ew: 4 }, MIN_GREEN - 0.5), "green", "minimum green");
  assert.equal(after({ ns: 0, ew: 4 }, MIN_GREEN + 0.5), "amber", "empty green gives way");
  assert.equal(after({ ns: 3, ew: 5 }, MIN_GREEN + 5), "green", "not yet twice as many");
  assert.equal(after({ ns: 3, ew: 6 }, MIN_GREEN + 0.5), "amber");
});

test("the trip stream depends on the seed only, not on how it is read", () => {
  const world = parseWorld(maps.town!.text);
  const whole = new TripSource(5).take(world, 30, 600);
  const pieces = new TripSource(5);
  const joined: Trip[] = [];
  for (let t = 1; t <= 600; t++) joined.push(...pieces.take(world, 30, t));
  assert.deepEqual(joined, whole);
  assert.ok(Math.abs(whole.length - 300) < 60, "30 a minute for 10 minutes");
  for (const trip of whole) assert.notEqual(trip.from, trip.to);
});

test("a car stops at a red light by its own braking and goes on green", () => {
  const world = parseWorld(maps.cross!.text);
  const sim = new Simulation(world, fixed);
  const [, west, east] = [...world.houses].sort((a, b) => a - b);
  // The signal starts green for north-south, so a car from the west meets a red.
  sim.addTrips([{ time: 0, from: west!, to: east!, roll: 0.5 }]);
  for (let i = 0; i < 150; i++) sim.step(0.1);
  const car = sim.cars[0]!;
  assert.ok(car.speed < 0.2);
  assert.ok(car.pos <= STOP_LINE && car.pos > STOP_LINE - 4, "just short of the line");
  assert.equal(sim.hardStops, 0, "the safety net was not needed");
  for (let i = 0; i < 400; i++) sim.step(0.1);
  assert.equal(sim.stats().arrived, 1);
});

test("no red light is run, no cars overlap, every car arrives", () => {
  for (const controller of controllers) {
    const world = parseWorld(maps.town!.text);
    const sim = new Simulation(world, controller);
    const trips = new TripSource(4).take(world, 70, 240);
    sim.addTrips(trips);
    // Four busy minutes, then time for the roads to empty.
    assert.deepEqual(watch(sim, world, 8400), { redRuns: 0, overlaps: 0, mergeOverlaps: 0 });
    const stats = sim.stats();
    assert.deepEqual([stats.arrived, stats.active, stats.queued], [trips.length, 0, 0]);
  }
});

test("editing the map updates signals and drops cars whose road is gone", () => {
  const world = parseWorld(maps.cross!.text);
  const sim = new Simulation(world, fixed);
  assert.deepEqual(junctions(world), [cellAt(world, 4, 5)]);
  const [north, , , south] = [...world.houses].sort((a, b) => a - b);
  sim.addTrips([{ time: 0, from: north!, to: south!, roll: 0.5 }]);
  for (let i = 0; i < 20; i++) sim.step(0.1);
  assert.equal(sim.cars.length, 1);
  toggleRoad(world, cellAt(world, 5, 5));
  sim.mapChanged();
  assert.equal(sim.cars.length, 0);
  assert.equal(sim.signals.size, 1, "three arms still make a junction");
  toggleRoad(world, cellAt(world, 3, 5));
  sim.mapChanged();
  assert.equal(sim.signals.size, 0);
});

test("a comparison is repeatable, and adaptive signals cut the delay in light traffic", () => {
  const world = parseWorld(maps.town!.text);
  const options = { duration: 600, carsPerMinute: 20, seed: 1, dt: 0.1 };
  const [fixedRun, adaptiveRun] = compareControllers(world, options);
  assert.deepEqual(compareControllers(world, options), [fixedRun, adaptiveRun]);
  assert.ok(adaptiveRun!.stats.meanDelay < fixedRun!.stats.meanDelay * 0.8);
});
