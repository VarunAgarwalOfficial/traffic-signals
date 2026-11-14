import { CAR_LENGTH } from "../core/car.ts";
import { type Axis, colOf, roadNeighbours, rowOf, type World } from "../core/grid.ts";
import { lightFor } from "../core/signals.ts";
import { type Car, CELL, type Simulation, STOP_LINE } from "../core/sim.ts";

/** Pixels per cell on the canvas. */
export const SCALE = 44;
/** How far cars keep to the left of the middle of the road, as a share of a cell. */
const LANE = 0.2;

interface Vec {
  x: number;
  y: number;
}

const centre = (world: World, cell: number): Vec => ({
  x: (colOf(world, cell) + 0.5) * SCALE,
  y: (rowOf(world, cell) + 0.5) * SCALE,
});

/** Unit direction of travel between two neighbouring cells. */
const heading = (world: World, from: number, to: number): Vec => ({
  x: colOf(world, to) - colOf(world, from),
  y: rowOf(world, to) - rowOf(world, from),
});

/** Traffic keeps left: the left of a heading on a screen whose y axis points down. */
const leftOf = (d: Vec): Vec => ({ x: d.y, y: -d.x });

const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Where a point on a car's route is drawn, and which way it faces. */
function place(world: World, car: Car, pos: number): { at: Vec; angle: number } {
  let leg = car.leg;
  let along = pos;
  if (along < 0 && leg > 0) {
    leg--;
    along += CELL;
  }
  const t = Math.max(along, 0) / CELL;
  const from = car.path[leg]!;
  const to = car.path[leg + 1]!;
  const dir = heading(world, from, to);
  // Blend the heading with the previous or next leg near the ends, so turns are rounded.
  let facing = dir;
  if (t < 0.5 && leg > 0) {
    facing = lerp(heading(world, car.path[leg - 1]!, from), dir, 0.5 + t);
  } else if (t >= 0.5 && leg < car.path.length - 2) {
    facing = lerp(dir, heading(world, to, car.path[leg + 2]!), t - 0.5);
  }
  const mid = lerp(centre(world, from), centre(world, to), t);
  const side = leftOf(facing);
  return {
    at: { x: mid.x + side.x * LANE * SCALE, y: mid.y + side.y * LANE * SCALE },
    angle: Math.atan2(facing.y, facing.x),
  };
}

export function draw(canvas: HTMLCanvasElement, sim: Simulation): void {
  const world = sim.world;
  const ctx = canvas.getContext("2d")!;
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();

  ctx.fillStyle = color("--ground");
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color("--grid");
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let col = 1; col < world.cols; col++) {
    ctx.moveTo(col * SCALE, 0);
    ctx.lineTo(col * SCALE, canvas.height);
  }
  for (let row = 1; row < world.rows; row++) {
    ctx.moveTo(0, row * SCALE);
    ctx.lineTo(canvas.width, row * SCALE);
  }
  ctx.stroke();

  ctx.fillStyle = color("--house");
  for (const house of world.houses) {
    const c = centre(world, house);
    ctx.beginPath();
    ctx.roundRect(c.x - SCALE * 0.32, c.y - SCALE * 0.32, SCALE * 0.64, SCALE * 0.64, 5);
    ctx.fill();
  }

  // Roads: a square per cell, slightly oversized so neighbours join without seams.
  ctx.fillStyle = color("--road");
  for (const road of world.roads) {
    const c = centre(world, road);
    ctx.fillRect(c.x - SCALE / 2 - 0.5, c.y - SCALE / 2 - 0.5, SCALE + 1, SCALE + 1);
  }
  ctx.strokeStyle = color("--lane");
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  for (const road of world.roads) {
    if (sim.signals.has(road)) continue;
    const c = centre(world, road);
    for (const next of roadNeighbours(world, road)) {
      const d = heading(world, road, next);
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + (d.x * SCALE) / 2, c.y + (d.y * SCALE) / 2);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // One light per approach, beside the stop line on the side the cars drive on.
  const lightColor = { green: "--go", amber: "--amber", red: "--stop" } as const;
  for (const [cell, signal] of sim.signals) {
    const c = centre(world, cell);
    for (const from of roadNeighbours(world, cell)) {
      const d = heading(world, from, cell);
      const side = leftOf(d);
      const axis: Axis = d.x === 0 ? "ns" : "ew";
      const back = 1 - STOP_LINE / CELL + 0.06;
      const x = c.x - d.x * back * SCALE + side.x * (LANE + 0.22) * SCALE;
      const y = c.y - d.y * back * SCALE + side.y * (LANE + 0.22) * SCALE;
      ctx.fillStyle = color(lightColor[lightFor(signal, axis)]);
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  const length = (CAR_LENGTH / CELL) * SCALE;
  const width = SCALE * 0.17;
  const moving = color("--car");
  const standing = color("--standing");
  for (const car of sim.cars) {
    // A car's position is its front bumper; draw the body around its middle.
    const { at, angle } = place(world, car, car.pos - CAR_LENGTH / 2);
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(angle);
    ctx.fillStyle = car.speed < 0.5 ? standing : moving;
    ctx.beginPath();
    ctx.roundRect(-length / 2, -width / 2, length, width, 2);
    ctx.fill();
    ctx.restore();
  }
}
