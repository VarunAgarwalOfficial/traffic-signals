# Traffic signals

A traffic simulation on a road grid you can draw yourself. Cars route between houses, follow each
other and obey signals. Two signal controllers, fixed time and adaptive, can be compared on the
same traffic.

## The idea

The original was two attempts at one question: can traffic be simulated well enough to make the
signals smarter? The first attempt was a city builder: click cells to lay roads, place houses, and
cars find their way between houses with A* search. The second dropped the grid and worked on how a
single car should behave. Its notes hold the neat part: take the gap to the car ahead minus a safe
distance, pass it through a sigmoid shifted to be zero at zero, and scale by the car's limits. One
smooth formula then gives hard braking when too close, gentle correction near the safe distance and
full throttle on an open road. Neither attempt reached the signals. This rebuild joins the two
halves and adds the missing part.

The adaptive controller here is a plain rule that counts cars. Nothing is learned, so it is not
called AI.

## How it works

**Map.** A grid of cells, each empty, a road or a house. A cell is 16 m. A house opens onto the
first road cell next to it. A road cell with three or four road neighbours is a junction and gets a
signal.

**Routes.** A* over road cells with the Manhattan distance as heuristic, as in the original.

**Demand.** Trips between random pairs of houses arrive as a Poisson stream from a seeded
generator. The stream does not look at the traffic, so two runs with the same seed ask for exactly
the same cars whatever the signals do. A car that finds no room at its house waits there, and that
wait counts.

**Car following.** With gap `g` to whatever is ahead (a car or a stop line), own speed `v` and the
speed `u` of the thing ahead:

```
wanted = standing gap + headway * v + max(v^2 - u^2, 0) / (2 * planned braking)
x      = g - wanted
a      = limit * (2 / (1 + e^(-k x)) - 1)
```

`limit` and `k` are the acceleration values when `x > 0` and the braking values when `x < 0`. The
sigmoid is the original's. The last term of `wanted` is new: without the braking distance, a car
approaching a standing queue reacts too late. Every driver gets slightly different limits. A hard
limit stops a car from ever entering the one ahead or crossing a red line; in normal running it is
almost never needed and the simulation counts when it is.

**Signals.** Each junction gives green to one axis (north-south or east-west), then 3 s amber, then
2 s all red, then the other axis. On amber a driver stops if that takes no more than 4 m/s^2 of
braking. A car does not enter a junction while its exit is jammed.

| Controller | Rule |
| --- | --- |
| Fixed time | 20 s of green for each axis in turn. |
| Adaptive | Counts cars within four cells of the junction on each axis. After 6 s of green it switches when the red side has at least twice as many cars as the green side (so also when the green side is empty), or after 45 s if anyone is waiting. With nobody waiting it stays green. |

**Measured** per finished trip: travel time from request to arrival, delay against driving the
route alone at full speed, and time spent standing.

### What it shows

`npm run compare -- --sweep` on the default town (nine junctions, 15 simulated minutes, seed 1):

| Cars per minute | Fixed: delay (s) | Adaptive: delay (s) | Fixed: finished | Adaptive: finished |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 26.5 | 10.3 | 144 | 147 |
| 20 | 28.6 | 12.7 | 310 | 315 |
| 40 | 30.6 | 18.8 | 607 | 614 |
| 60 | 40.9 | 31.9 | 865 | 890 |
| 80 | 85.4 | 109.5 | 713 | 731 |
| 100 | 181.6 | 191.2 | 659 | 592 |

In light and medium traffic the adaptive rule cuts delay by a third to a half, because fixed
signals hold cars at red for nobody. Once the roads are full it has no advantage and can do worse:
counting nearby cars says nothing useful when every approach is full, and the town locks up either
way. These numbers describe this model, not a real city.

## Run

Needs Node 23.6 or newer (it runs TypeScript directly).

```
npm install
npm run dev                                   # interactive view at http://localhost:5173
npm run compare                               # both controllers on the default map
npm run compare -- --map avenue --sweep       # another map, a range of traffic levels
npm run compare -- --help                     # all options; --json for machine output
```

In the view: click a cell to add or remove a road; choose the house tool (or press H, as in the
original) to add or remove houses. Signals appear wherever three or four roads meet. Change the
controller, the number of cars per minute and the speed while it runs. "Compare controllers" runs
ten simulated minutes of the current map under both controllers and shows the result.
`npm run build` writes a static site to `dist/`. `PORT` sets the port (see `.env.example`).

## Test

```
npm test          # core logic, with node:test
npm run lint      # Biome: lint and format check
npm run build     # type check and production build
```

The tests check, among other things, that A* matches breadth-first search, that no car runs a red
light or overlaps another, and that every car asked for arrives.

## Layout

```
src/core/   pure simulation: grid, route, car, signals, demand, sim, compare, maps
src/cli.ts  command line comparison
src/web/    browser view: canvas drawing and controls
test/       tests for the core
```

## Limits

- Cars turning across oncoming traffic do not give way; they pass through each other inside the
  junction. Cars merging into the same exit do keep their distance.
- One lane each way, no overtaking, no pedestrians, cars are driven on the left.
- A house on a junction cell or roads drawn as solid blocks work but look odd.

## Credit

Rebuilt from two 2021 prototypes by Varun Agarwal ("AI-based Traffic" 2 and 3, Python with pygame).
