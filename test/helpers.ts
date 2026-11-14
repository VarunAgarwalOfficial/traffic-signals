import { CAR_LENGTH } from "../src/core/car.ts";
import { axisOf, isJunction, type World } from "../src/core/grid.ts";
import { lightFor } from "../src/core/signals.ts";
import { MIN_GAP, type Simulation, STOP_LINE } from "../src/core/sim.ts";

export interface Violations {
  redRuns: number;
  /** Cars closer than a car length on a leg that does not start at a junction. */
  overlaps: number;
  /** The same, on the first leg out of a junction, where two turning streams merge. */
  mergeOverlaps: number;
}

/** Step the simulation and count broken rules. */
export function watch(sim: Simulation, world: World, steps: number, dt = 0.1): Violations {
  const result: Violations = { redRuns: 0, overlaps: 0, mergeOverlaps: 0 };
  for (let i = 0; i < steps; i++) {
    const before = new Map(sim.cars.map((car) => [car.id, { leg: car.leg, pos: car.pos }]));
    sim.step(dt);
    const lanes = new Map<string, number[]>();
    for (const car of sim.cars) {
      const from = car.path[car.leg]!;
      const to = car.path[car.leg + 1]!;
      const key = `${from}>${to}`;
      lanes.set(key, [...(lanes.get(key) ?? []), car.pos]);

      const was = before.get(car.id);
      const signal = sim.signals.get(to);
      const crossed =
        was && was.leg === car.leg && was.pos <= STOP_LINE && car.pos > STOP_LINE + MIN_GAP + 0.01;
      if (signal && crossed && lightFor(signal, axisOf(world, from, to)) === "red") {
        result.redRuns++;
      }
    }
    for (const [key, positions] of lanes) {
      positions.sort((a, b) => a - b);
      const afterJunction = isJunction(world, Number(key.split(">")[0]));
      for (let j = 1; j < positions.length; j++) {
        if (positions[j]! - positions[j - 1]! < CAR_LENGTH + MIN_GAP - 0.01) {
          if (afterJunction) result.mergeOverlaps++;
          else result.overlaps++;
        }
      }
    }
  }
  return result;
}
