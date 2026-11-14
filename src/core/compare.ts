import { TripSource } from "./demand.ts";
import type { World } from "./grid.ts";
import { type Controller, controllers } from "./signals.ts";
import { Simulation, type Stats } from "./sim.ts";

export interface RunOptions {
  /** Simulated seconds. */
  duration: number;
  carsPerMinute: number;
  seed: number;
  /** Step length in seconds. */
  dt: number;
}

export const defaultRun: RunOptions = { duration: 900, carsPerMinute: 40, seed: 1, dt: 0.1 };

/** Run one controller without drawing anything. */
export function runHeadless(world: World, controller: Controller, options: RunOptions): Stats {
  const sim = new Simulation(world, controller);
  const source = new TripSource(options.seed);
  const steps = Math.round(options.duration / options.dt);
  for (let i = 0; i < steps; i++) {
    sim.addTrips(source.take(world, options.carsPerMinute, sim.time + options.dt));
    sim.step(options.dt);
  }
  return sim.stats();
}

/** Run every controller on the same map with the same stream of trips. */
export function compareControllers(
  world: World,
  options: RunOptions,
): { controller: Controller; stats: Stats }[] {
  return controllers.map((controller) => ({
    controller,
    stats: runHeadless(world, controller, options),
  }));
}
