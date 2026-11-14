import { acceleration, CAR_LENGTH, type Driver, makeDriver } from "./car.ts";
import type { Trip } from "./demand.ts";
import { type Axis, axisOf, houseAccess, junctions, type World } from "./grid.ts";
import { findRoute } from "./route.ts";
import {
  type Controller,
  createSignal,
  type Demand,
  lightFor,
  type Signal,
  stepSignal,
} from "./signals.ts";

/** Length of one grid cell in metres. */
export const CELL = 24;
/** Where cars stop for a signal, measured along the leg that leads into the junction. */
export const STOP_LINE = CELL / 2 - 1;
/** Cars never close up further than this. */
export const MIN_GAP = 0.5;
/** A driver goes through amber only if stopping would need more braking than this. */
const COMFORT_BRAKE = 4;
/** How many legs past the current one a driver looks for cars and signals. */
const LOOK_AHEAD_LEGS = 3;
/** A junction's detectors see cars this many legs away. */
const DETECTOR_LEGS = 3;
/** Below this speed a car counts as waiting. */
const WAIT_SPEED = 0.5;

export interface Car {
  id: number;
  /** Road cells from start to destination. */
  path: number[];
  /** The car is between path[leg] and path[leg + 1]. */
  leg: number;
  /** Metres travelled along the current leg, measured at the front bumper. */
  pos: number;
  speed: number;
  driver: Driver;
  /** When the trip was requested, which can be before the car found room to enter. */
  requested: number;
  /** Seconds spent standing, including the time spent waiting to enter. */
  waited: number;
}

export interface Stats {
  time: number;
  active: number;
  /** Trips that are waiting for room to enter the road. */
  queued: number;
  arrived: number;
  /** Mean seconds from request to arrival. */
  meanTravel: number;
  /** Mean seconds lost compared with driving the route alone at full speed. */
  meanDelay: number;
  /** Mean seconds spent standing. */
  meanWait: number;
  /** Times a car was held back by the hard limit rather than by its own braking. */
  hardStops: number;
}

/** A car on its way to a junction. */
interface Approach {
  car: Car;
  /** The cell it enters the junction from and the cell it leaves to. */
  from: number;
  exit: number;
  /** Metres to the centre of the junction. */
  dist: number;
  /** Stopped, or about to be, by a red light. */
  held: boolean;
}

const edgeKey = (from: number, to: number, cells: number): number => from * cells + to;

/**
 * Cars drive along routes on the grid, follow the car ahead and obey signals.
 * Each step every car first measures the free distance ahead from the state of
 * the previous step, then all cars move at once.
 */
export class Simulation {
  readonly world: World;
  controller: Controller;
  time = 0;
  cars: Car[] = [];
  signals = new Map<number, Signal>();
  hardStops = 0;

  private nextId = 0;
  private waitingTrips: Trip[] = [];
  private arrived = 0;
  private travelSum = 0;
  private delaySum = 0;
  private waitSum = 0;
  private routes = new Map<number, number[] | null>();
  private approaches = new Map<number, Approach[]>();

  constructor(world: World, controller: Controller) {
    this.world = world;
    this.controller = controller;
    this.mapChanged();
  }

  /** Call after editing the world: rebuilds signals and drops cars whose route is gone. */
  mapChanged(): void {
    this.routes.clear();
    const next = new Map<number, Signal>();
    for (const cell of junctions(this.world)) {
      next.set(cell, this.signals.get(cell) ?? createSignal());
    }
    this.signals = next;
    this.cars = this.cars.filter((car) => car.path.every((cell) => this.world.roads.has(cell)));
    this.waitingTrips = this.waitingTrips.filter((trip) => this.routeFor(trip) !== null);
  }

  /** Ask for cars. Trips with no possible route are ignored. */
  addTrips(trips: Trip[]): void {
    for (const trip of trips) {
      if (this.routeFor(trip) !== null) this.waitingTrips.push(trip);
    }
  }

  private routeFor(trip: Trip): number[] | null {
    const cells = this.world.cols * this.world.rows;
    const key = trip.from * cells + trip.to;
    let route = this.routes.get(key);
    if (route === undefined) {
      const start = houseAccess(this.world, trip.from);
      const goal = houseAccess(this.world, trip.to);
      route = start === null || goal === null ? null : findRoute(this.world, start, goal);
      if (route && route.length < 2) route = null;
      this.routes.set(key, route);
    }
    return route;
  }

  step(dt: number): void {
    const cells = this.world.cols * this.world.rows;

    // Index the cars by the leg they are on and by the cell they are heading into.
    const byEdge = new Map<number, Car[]>();
    const byTarget = new Map<number, Car[]>();
    for (const car of this.cars) {
      const from = car.path[car.leg]!;
      const to = car.path[car.leg + 1]!;
      const key = edgeKey(from, to, cells);
      const onEdge = byEdge.get(key);
      if (onEdge) onEdge.push(car);
      else byEdge.set(key, [car]);
      const heading = byTarget.get(to);
      if (heading) heading.push(car);
      else byTarget.set(to, [car]);
    }
    for (const list of byEdge.values()) list.sort((a, b) => a.pos - b.pos);
    this.indexApproaches();

    this.stepSignals(dt);
    this.enterWaitingCars(byEdge, byTarget, cells);

    const views = this.cars.map((car) => this.lookAhead(car, byEdge, cells));

    const remaining: Car[] = [];
    this.cars.forEach((car, i) => {
      const { gap, leadSpeed, hardLimit } = views[i]!;
      const a = acceleration(car.driver, gap, car.speed, leadSpeed);
      let speed = Math.min(Math.max(car.speed + a * dt, 0), car.driver.maxSpeed);
      let move = ((car.speed + speed) / 2) * dt;
      const room = Math.max(hardLimit - MIN_GAP, 0);
      if (move > room) {
        // Safety net: the following rule should have braked earlier.
        if (move - room > 0.05) this.hardStops++;
        move = room;
        speed = Math.min(speed, move / dt);
      }
      car.speed = speed;
      car.pos += move;
      if (speed < WAIT_SPEED) car.waited += dt;
      while (car.pos >= CELL && car.leg < car.path.length - 1) {
        car.pos -= CELL;
        car.leg++;
      }
      if (car.leg >= car.path.length - 1) this.finish(car, dt);
      else remaining.push(car);
    });
    this.cars = remaining;
    this.time += dt;
  }

  private finish(car: Car, dt: number): void {
    const travel = this.time + dt - car.requested;
    const freeFlow = ((car.path.length - 1) * CELL) / car.driver.maxSpeed;
    this.arrived++;
    this.travelSum += travel;
    this.delaySum += Math.max(travel - freeFlow, 0);
    this.waitSum += car.waited;
  }

  private stepSignals(dt: number): void {
    // Count the cars within sight of each junction, by the axis they will arrive on.
    const demand = new Map<number, Demand>();
    for (const cell of this.signals.keys()) demand.set(cell, { ns: 0, ew: 0 });
    for (const car of this.cars) {
      const farthest = Math.min(car.leg + DETECTOR_LEGS - 1, car.path.length - 2);
      for (let leg = car.leg; leg <= farthest; leg++) {
        const counts = demand.get(car.path[leg + 1]!);
        if (!counts) continue;
        const passed = leg === car.leg && car.pos > STOP_LINE + MIN_GAP;
        if (!passed) counts[this.legAxis(car, leg)]++;
      }
    }
    for (const [cell, signal] of this.signals) {
      stepSignal(signal, this.controller, demand.get(cell)!, dt);
    }
  }

  /** For every junction, the cars within a few legs of it that will drive on through it. */
  private indexApproaches(): void {
    this.approaches.clear();
    for (const car of this.cars) {
      const farthest = Math.min(car.leg + LOOK_AHEAD_LEGS, car.path.length - 3);
      for (let leg = car.leg; leg <= farthest; leg++) {
        const node = car.path[leg + 1]!;
        const signal = this.signals.get(node);
        if (!signal) continue;
        const inside = leg === car.leg && car.pos > STOP_LINE + MIN_GAP;
        const entry: Approach = {
          car,
          from: car.path[leg]!,
          exit: car.path[leg + 2]!,
          dist: (leg - car.leg + 1) * CELL - car.pos,
          held: !inside && lightFor(signal, this.legAxis(car, leg)) === "red",
        };
        const list = this.approaches.get(node);
        if (list) list.push(entry);
        else this.approaches.set(node, [entry]);
      }
    }
  }

  private legAxis(car: Car, leg: number): Axis {
    return axisOf(this.world, car.path[leg]!, car.path[leg + 1]!);
  }

  private enterWaitingCars(
    byEdge: Map<number, Car[]>,
    byTarget: Map<number, Car[]>,
    cells: number,
  ): void {
    const stillWaiting: Trip[] = [];
    const usedEdges = new Set<number>();
    for (const trip of this.waitingTrips) {
      const path = trip.time <= this.time ? this.routeFor(trip) : null;
      const key = path ? edgeKey(path[0]!, path[1]!, cells) : -1;
      const first = byEdge.get(key)?.[0];
      let blocked = first !== undefined && first.pos < CAR_LENGTH + 4;
      // Do not pull out in front of a car that is about to drive past the house.
      for (const passing of path ? (byTarget.get(path[0]!) ?? []) : []) {
        if (passing.path[passing.leg + 2] !== path?.[1]) continue;
        if (CELL - passing.pos < 6 + passing.speed * 3) blocked = true;
      }
      if (!path || blocked || usedEdges.has(key)) {
        stillWaiting.push(trip);
        continue;
      }
      usedEdges.add(key);
      const car: Car = {
        id: this.nextId++,
        path,
        leg: 0,
        pos: 0,
        speed: 0,
        driver: makeDriver(trip.roll),
        requested: trip.time,
        waited: this.time - trip.time,
      };
      this.cars.push(car);
      // New cars are behind everything on their leg.
      const list = byEdge.get(key);
      if (list) list.unshift(car);
      else byEdge.set(key, [car]);
    }
    this.waitingTrips = stillWaiting;
  }

  /** The nearest thing ahead that the car must not run into: its distance and its speed. */
  private lookAhead(
    car: Car,
    byEdge: Map<number, Car[]>,
    cells: number,
  ): { gap: number; leadSpeed: number; hardLimit: number } {
    let gap = Number.POSITIVE_INFINITY;
    let leadSpeed = 0;
    const consider = (distance: number, speed: number): void => {
      if (distance < gap) {
        gap = distance;
        leadSpeed = speed;
      }
    };
    const lastLeg = car.path.length - 2;
    const farthest = Math.min(car.leg + LOOK_AHEAD_LEGS, lastLeg);

    // The car ahead: on this leg, or the last car on one of the next legs.
    const own = byEdge.get(edgeKey(car.path[car.leg]!, car.path[car.leg + 1]!, cells))!;
    const ahead = own[own.indexOf(car) + 1];
    if (ahead) {
      consider(ahead.pos - CAR_LENGTH - car.pos, ahead.speed);
    } else {
      for (let leg = car.leg + 1; leg <= farthest; leg++) {
        const tail = byEdge.get(edgeKey(car.path[leg]!, car.path[leg + 1]!, cells))?.[0];
        if (tail) {
          consider((leg - car.leg) * CELL + tail.pos - CAR_LENGTH - car.pos, tail.speed);
          break;
        }
      }
    }

    // Cars arriving from another side that will turn into the same road and are closer to it.
    // They are not in this lane yet, so they shape the acceleration but not the hard limit.
    let hardLimit = gap;
    for (let leg = car.leg; leg <= Math.min(farthest, lastLeg - 1); leg++) {
      const node = car.path[leg + 1]!;
      const mine = (leg - car.leg + 1) * CELL - car.pos;
      for (const rival of this.approaches.get(node) ?? []) {
        if (rival.car === car || rival.from === car.path[leg]) continue;
        if (rival.exit !== car.path[leg + 2]) continue;
        const first = rival.dist < mine || (rival.dist === mine && rival.car.id < car.id);
        if (first && !rival.held) consider(mine - rival.dist - CAR_LENGTH, rival.car.speed);
      }
    }

    // The first stop line ahead that the car has to stop at.
    for (let leg = car.leg; leg <= farthest; leg++) {
      const toLine = (leg - car.leg) * CELL + STOP_LINE - car.pos;
      if (toLine < 0) continue;
      const signal = this.signals.get(car.path[leg + 1]!);
      if (signal && this.mustStop(car, leg, signal, toLine, byEdge, cells)) {
        consider(toLine + MIN_GAP, 0);
        hardLimit = Math.min(hardLimit, toLine + MIN_GAP);
        break;
      }
    }
    return { gap, leadSpeed, hardLimit };
  }

  private mustStop(
    car: Car,
    leg: number,
    signal: Signal,
    toLine: number,
    byEdge: Map<number, Car[]>,
    cells: number,
  ): boolean {
    const light = lightFor(signal, this.legAxis(car, leg));
    if (light === "red") return true;
    if (light === "amber") return car.speed ** 2 / (2 * Math.max(toLine, 0.01)) <= COMFORT_BRAKE;
    // Green, but do not enter a junction whose exit is jammed.
    if (leg + 2 >= car.path.length) return false;
    const tail = byEdge.get(edgeKey(car.path[leg + 1]!, car.path[leg + 2]!, cells))?.[0];
    return tail !== undefined && tail.pos < CAR_LENGTH + 3 && tail.speed < 1;
  }

  stats(): Stats {
    const n = this.arrived;
    return {
      time: this.time,
      active: this.cars.length,
      queued: this.waitingTrips.filter((trip) => trip.time <= this.time).length,
      arrived: n,
      meanTravel: n ? this.travelSum / n : 0,
      meanDelay: n ? this.delaySum / n : 0,
      meanWait: n ? this.waitSum / n : 0,
      hardStops: this.hardStops,
    };
  }
}
