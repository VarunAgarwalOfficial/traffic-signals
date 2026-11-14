import { houseAccess, type World } from "./grid.ts";
import { createRng, type Rng } from "./rng.ts";

/** A wish to drive from one house to another, starting at `time` seconds. */
export interface Trip {
  time: number;
  from: number;
  to: number;
  /** A number in [0, 1) that fixes the driver's character. */
  roll: number;
}

/**
 * An endless, seeded stream of trips between houses.
 *
 * Trips are drawn without looking at the traffic, so two simulations with the
 * same seed are asked to carry exactly the same cars, whatever their signals do.
 */
export class TripSource {
  private readonly rng: Rng;
  /** Departure time of the next trip, drawn ahead so the stream does not depend on how it is read. */
  private next: number | null = null;
  private last = 0;

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  /** All trips that start before `until`, given the current map and rate in cars per minute. */
  take(world: World, carsPerMinute: number, until: number): Trip[] {
    const trips: Trip[] = [];
    if (carsPerMinute <= 0) {
      this.next = null;
      this.last = Math.max(this.last, until);
      return trips;
    }
    const houses = [...world.houses]
      .filter((h) => houseAccess(world, h) !== null)
      .sort((a, b) => a - b);
    while (true) {
      // Exponential gaps between departures give a Poisson stream.
      this.next ??= this.last - (Math.log(1 - this.rng.next()) * 60) / carsPerMinute;
      if (this.next >= until) return trips;
      const time = this.next;
      this.last = time;
      this.next = null;
      const a = this.rng.int(0, Math.max(houses.length - 1, 0));
      const b = this.rng.int(0, Math.max(houses.length - 2, 0));
      const roll = this.rng.next();
      if (houses.length < 2) continue;
      const from = houses[a]!;
      const to = houses[b >= a ? b + 1 : b]!;
      trips.push({ time, from, to, roll });
    }
  }
}
