import type { Axis } from "./grid.ts";

export type Stage = "green" | "amber" | "clear";

/** One junction's signal. `axis` has the right of way; the other axis is red. */
export interface Signal {
  axis: Axis;
  /** green, then amber, then a short all-red stage before the other axis goes. */
  stage: Stage;
  /** Seconds spent in the current stage. */
  elapsed: number;
}

/** Cars approaching a junction on each axis. */
export type Demand = Record<Axis, number>;

export interface Controller {
  id: ControllerId;
  label: string;
  summary: string;
  /** Asked every step while green: should the green end now? */
  shouldSwitch(signal: Signal, demand: Demand): boolean;
}

export type ControllerId = "fixed" | "adaptive";

export const AMBER_TIME = 3;
export const CLEAR_TIME = 2;
export const FIXED_GREEN = 20;
export const MIN_GREEN = 6;
export const MAX_GREEN = 45;

const other = (axis: Axis): Axis => (axis === "ns" ? "ew" : "ns");

export const controllers: Controller[] = [
  {
    id: "fixed",
    label: "Fixed time",
    summary: `Each direction gets ${FIXED_GREEN} seconds of green in turn, whether or not anyone is there.`,
    shouldSwitch: (signal) => signal.elapsed >= FIXED_GREEN,
  },
  {
    id: "adaptive",
    label: "Adaptive",
    summary:
      "Counts the cars near the junction on each side. After a minimum green it switches once the red side has at least twice as many cars as the green side, or at a maximum green if anyone is waiting.",
    shouldSwitch: (signal, demand) => {
      const waiting = demand[other(signal.axis)];
      if (signal.elapsed < MIN_GREEN || waiting === 0) return false;
      return waiting >= 2 * demand[signal.axis] || signal.elapsed >= MAX_GREEN;
    },
  },
];

export function getController(id: string): Controller {
  const controller = controllers.find((c) => c.id === id);
  if (!controller) throw new Error(`unknown controller "${id}" (expected fixed or adaptive)`);
  return controller;
}

export function createSignal(axis: Axis = "ns"): Signal {
  return { axis, stage: "green", elapsed: 0 };
}

/** Advance a signal by `dt` seconds. */
export function stepSignal(
  signal: Signal,
  controller: Controller,
  demand: Demand,
  dt: number,
): void {
  signal.elapsed += dt;
  if (signal.stage === "green") {
    if (controller.shouldSwitch(signal, demand)) {
      signal.stage = "amber";
      signal.elapsed = 0;
    }
  } else if (signal.stage === "amber") {
    if (signal.elapsed >= AMBER_TIME) {
      signal.stage = "clear";
      signal.elapsed = 0;
    }
  } else if (signal.elapsed >= CLEAR_TIME) {
    signal.axis = other(signal.axis);
    signal.stage = "green";
    signal.elapsed = 0;
  }
}

/** What a driver arriving on `axis` sees. */
export function lightFor(signal: Signal, axis: Axis): "green" | "amber" | "red" {
  if (signal.axis !== axis || signal.stage === "clear") return "red";
  return signal.stage;
}
