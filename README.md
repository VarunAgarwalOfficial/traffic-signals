# Traffic signals

Draw a road network in the browser, put houses on it, and watch cars drive between them. Pick how
the traffic signals are controlled, then run the same seeded traffic under several controllers and
compare delay and throughput. The simulation is a Rust library; the browser runs it as WebAssembly
and a command line runs the same code for sweeps.

## The idea

The original was two attempts, in 2021, at one question: can traffic be simulated well enough to
make the signals smarter? The first was a city builder: click cells to lay roads, place houses, and
cars find their way between houses with A* search. The second dropped the grid to work out how one
car should follow another. Its notes hold the neat part: take the gap to the car ahead minus a safe
distance, pass it through a sigmoid shifted to be zero at zero, and scale by the car's limits. One
smooth formula then brakes hard when too close, corrects gently near the safe distance and gives
full throttle on an open road. Neither attempt reached the signals. This project keeps all three
ideas (the drawn grid, A* between houses, the sigmoid follower) and builds the missing part around
them: junctions where cars give way properly, five signal controllers from the literature, and
measurements that can be repeated.

Nothing here is new research. The value is that the standard controllers can be compared on a map
you drew, with a seed, in a browser tab.

## Run it

Needs Rust with the `wasm32-unknown-unknown` target, and a recent Node (built with Node 26).

```
cd web
npm install
npm run dev            # builds the WebAssembly core, then serves http://localhost:5173
npm run build          # static site in web/dist
```

Copy `web/.env.example` to `web/.env` to change the port.

In the browser:

- **Build.** Road, House and Erase draw on the grid (drag to draw a road). Select picks a junction
  to give it its own controller or no signal at all, or a house to change its share of the trips.
  Drag with Select, or with two fingers, to move the map; scroll or pinch to zoom. Play, pause,
  step one second, and four speeds. The controller and the demand change while it runs; drawing
  starts the run again.
- **Compare.** Runs the Build map under the ticked controllers with identical trips, side by side,
  and charts delay and throughput. "Repeat with 8 seeds" runs in the background and adds 95%
  intervals.
- **Share** copies a link that holds the map, the demand, the controllers and the seed.
- Keyboard: Tab to the map, arrow keys move a cursor, Enter uses the tool; V, R, H, E pick tools;
  P plays or pauses; `.` steps; `+`, `-`, `0` zoom.

Command line:

```
cargo run --release -p traffic -- --help
cargo run --release -p traffic -- --preset grid --demand 500:6500:500 --seeds 10 --format csv
cargo run --release -p traffic -- --file my-town.txt --controller fixed,max-pressure --format json
```

A scenario file is the text the Share link carries (see `crates/core/presets/`). Every run is
deterministic: the same options give the same numbers, on the command line and in the browser.

## Test

```
cargo test --release               # 7 tests of the core
cargo clippy --all-targets && cargo fmt --check
cd web && npm run lint && npm run build
node scripts/same-in-browser.mjs   # the WebAssembly build and the native build agree
./scripts/validate.sh              # the sweeps behind the tables below, about 90 s
```

The tests check that A* matches an exhaustive search, that a seed repeats a run exactly, that no
two cars ever overlap and none runs a red light in heavy traffic or on 60 random drawings, that
cars turning across oncoming traffic still get through, and that a jammed town empties.

## How it works

**Map to network.** A cell is 20 m. Runs of road cells become one road with a lane each way
(driving on the left); cells where three or four roads meet, or a road ends, become nodes. Bends
are rounded. Inside a junction every allowed movement is a curve from the end of one lane to the
start of another, and two movements conflict where their curves come within 2.3 m. A house opens
onto the road cell next to it.

**Routes.** A* over lanes by travel time at the speed limit (50 km/h, 6.5 m/s through a turn),
with straight-line time as the heuristic.

**Demand.** Trips per hour are shared between ordered pairs of houses in proportion to the product
of their weights; a scenario may add explicit origin-destination flows. Arrivals are a Poisson
stream from the seed. The stream never looks at the traffic, so every controller is asked to carry
exactly the same trips. A car pulls out only into a safe gap, and waiting to pull out counts as
delay.

**Car following.** Two rules, chosen per scenario. Both look at the gap `s` to whatever is ahead
(a car, a stop line, a point to give way at), own speed `v`, the other's speed, and wanted speed
`v0`.

- Intelligent Driver Model (default): `a = a_max [1 - (v/v0)^4 - (s*/s)^2]`, with
  `s* = s0 + v T + v dv / (2 sqrt(a_max b))`.
- Sigmoid (the 2021 rule): `x = s - wanted gap`, `a = limit (2 / (1 + e^(-k x)) - 1)`, with
  separate `limit` and `k` for accelerating and braking.

How they differ: `2 sigmoid(x) - 1` is `tanh(x/2)`, so the sigmoid rule is a relative of the
optimal-velocity models, applied to acceleration. It has no term for the open road, so the speed
limit is enforced beside it, and it reacts to the gap only, where the Intelligent Driver Model
also reacts to closing speed. The wanted gap here adds a braking-distance term the 2021 notes did
not have; without it a car arriving at a standing queue reacts too late. On the grid the two give similar
pictures. With the sigmoid rule, fixed time has 97 ± 12 s of delay at 3500 trips an hour (82 ± 7
with the Intelligent Driver Model) and actuated control 41.8 ± 2.2 s (41.3 ± 1.0); beyond capacity
the sigmoid rule carries a few percent fewer cars (`results/grid-sigmoid.csv`). Neither ever needed
the hard limit that stops one car entering another.

**Junctions.** A car nearing a junction asks to enter when it is one comfortable braking distance
away, and is refused (and stops at the line) unless all of these hold:

- its signal is green, or the junction has none;
- the lane it wants has room for it after everyone already let in (spillback: no car enters a
  junction without room to leave it);
- every car already let in on a conflicting path will be clear before it gets there;
- no car with right of way would reach the shared patch before it has cleared it (gap acceptance).
  Straight on beats a near-side turn beats a turn across oncoming traffic; among equals, first
  come first served.

A car waiting to turn across traffic may go in the first 1.5 s of amber, once the cars it gave way
to have stopped. Cars let in are never asked to give way to cars let in later, so nothing waits in
a circle inside a junction.

**Rerouting.** A driver first in line whose exit has been full for 30 s takes another route if one
exists (`reroute` in the scenario; 0 turns it off). This is a modelling choice with a large effect
on gridlock; see below.

**Signals.** Two phases per junction, north-south and east-west; turns across oncoming traffic are
permitted, not protected. A change is 3 s amber and 2 s all red, and no green is shorter than 5 s.
A controller sees detector counts for its lanes and answers one question: which phase should be
green? Adding one means implementing `Controller::decide` in `crates/core/src/control.rs` and
adding two lines to the list there.

| Controller | Rule | Source |
| --- | --- | --- |
| Fixed time | 20 s green per phase, in turn. | |
| Actuated | Hold green while cars are within 25 m of the line, up to 40 s; then serve the next phase with demand; rest in green if nobody waits. | FHWA Signal Timing Manual, ch. 5 |
| Self-organising | Each red phase adds up cars within 80 m, times seconds. At 8 car-seconds, after 6 s of green, it gets green (the paper's sotl-phase). | Gershenson 2005 |
| Max pressure | Every 10 s or later, green goes to the phase with the largest sum over its movements of (cars waiting for the movement) minus (cars on the lane it feeds, divided by that lane's exits). | Varaiya 2013; Wongpiromsarn et al. 2012 |
| Capacity-aware pressure | The same with each queue replaced by the convex pressure of Gregoire et al. (their eq. 5, m = 4), which reaches 1 when a lane is full, and with movements nobody waits for ignored. | Gregoire et al. 2014 |

Settings are `param` lines in a scenario or `--param` on the command line: `fixed.green`,
`actuated.max_green`, `sotl.theta`, `sotl.min_green`, `sotl.platoon`, `pressure.slot`.

**Measured.** Delay is travel time from the moment the trip was asked for, minus the time the
route takes alone. Reported: mean and 95th percentile over finished trips; a mean that also counts
unfinished trips at their delay so far (a lower bound, and the fair number once queues grow);
trips finished per hour; cars standing; stops per trip. Trips asked for during the warm-up are
left out. Over several seeds the tables give the mean and a 95% Student-t interval. Every row also
counts overlapping cars, red-light runs and uses of the hard limit; all three should be zero.

## What the comparison shows

`./scripts/validate.sh` writes these to `results/`. The 4 by 4 grid, 100 m blocks, 40 simulated
minutes of which the first 10 are warm-up, 10 seeds, mean ± 95% interval. Mean delay in seconds,
counting unfinished trips:

| Trips an hour | Fixed | Actuated | Self-organising | Max pressure | Capacity-aware |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 36.0 ± 1.0 | 18.1 ± 0.5 | 26.5 ± 0.7 | 14.1 ± 0.5 | 13.2 ± 0.4 |
| 1500 | 40.4 ± 0.8 | 24.5 ± 0.4 | 30.4 ± 0.5 | 25.9 ± 0.8 | 27.2 ± 0.8 |
| 2500 | 47.6 ± 2.0 | 30.9 ± 0.8 | 37.0 ± 0.8 | 36.0 ± 0.9 | 36.9 ± 1.0 |
| 3500 | 82 ± 7 | 41.3 ± 1.0 | 56.2 ± 2.7 | 50.7 ± 2.2 | 51.5 ± 1.9 |
| 4000 | 154 ± 11 | 58 ± 5 | 93 ± 8 | 81 ± 12 | 75 ± 7 |
| 4500 | 260 ± 13 | 125 ± 23 | 183 ± 16 | 166 ± 22 | 183 ± 22 |
| 5500 | 433 ± 17 | 442 ± 18 | 395 ± 18 | 428 ± 12 | 395 ± 17 |
| 6500 | 555 ± 12 | 627 ± 18 | 544 ± 15 | 574 ± 19 | 536 ± 13 |

Trips finished per hour at and beyond what the grid can carry (about 4000):

| Trips an hour | Fixed | Actuated | Self-organising | Max pressure | Capacity-aware |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4000 | 3720 ± 41 | 3978 ± 46 | 3938 ± 62 | 3947 ± 49 | 3970 ± 51 |
| 6500 | 3861 ± 74 | 3132 ± 173 | 3724 ± 170 | 3608 ± 124 | 3990 ± 93 |
| 6500, no rerouting | 3221 ± 329 | 1469 ± 395 | 2617 ± 719 | 3412 ± 157 | 3876 ± 139 |

Read against the published results:

- **Self-organising control beats fixed time at low load and loses the advantage at saturation**
  (Gershenson 2005). Reproduced in kind: 26.5 s against 36.0 s at 500 trips an hour, no
  significant difference at 6500 (544 ± 15 against 555 ± 12), with 8.1 stops a trip against 5.3.
  A more eager setting (`sotl.theta=3`, `sotl.min_green=5`, closer to the paper's sotl-request)
  sharpens both ends: 17.7 ± 0.4 s at 500, and 566 ± 11 s at 6500. The paper's deadlocks do not
  appear, because here no car may stop inside a junction. Against the other adaptive controllers,
  which the paper did not test, self-organising control is never the best.
- **Max pressure keeps up where fixed time does not** (Varaiya 2013). At 4000 trips an hour max
  pressure finishes 3947 ± 49 an hour with 152 trips outstanding; fixed time finishes 3720 ± 41 and
  has 294 outstanding and growing. Other green times do not rescue fixed time: of 10, 20, 30 and
  40 s the best at 4000 is 10 s, which finishes 3782 ± 53 an hour (`results/grid-fixed-*.csv`).
- **Plain max pressure fails when roads fill up, and capacity-aware pressure fixes it** (Gregoire
  et al. 2014). At 6500 capacity-aware pressure finishes 3990 ± 93 an hour against 3608 ± 124. In
  the town, jammed with 7000 trips an hour for 15 minutes and then left alone, capacity-aware
  pressure emptied the roads in 6 of 6 seeds and max pressure in 2 of 6: it holds green for a
  queue whose exit is full while cars that could move wait at red.
- Actuated control is the best or near it below capacity and the worst above it. Tuned simple
  controllers being hard to beat is itself a known result (Jayawardana et al. 2022).

**Gridlock.** With rerouting on (the default), the fixed-time town emptied after the jam in 6 of 6
seeds. With rerouting off it emptied in 1 of 6: four full roads around a block, each waiting to
turn into the next, stay that way for good. That is a property of one-lane roads with drivers who
never change their minds, not a numerical accident, and the model still shows it if asked to.

Across the 2160 runs in `results/` no two cars overlapped and the hard limit was never used. One
car crossed a stop line at red, in one of the 250 runs with the sigmoid rule (max pressure, 6500
trips an hour); none did with the Intelligent Driver Model.

**SUMO was not compared.** It is not installed on the machine this was built on, so there is no
quantitative check against another simulator. These numbers describe this model, not a real city.

## What it does not model

- One lane each way. No overtaking, no turn lanes: a car waiting to turn across traffic holds up
  everyone behind it, which makes turning traffic cost more capacity than on a real arterial.
- Two-phase signals only. No protected turns, no offsets or green waves between junctions.
- Junctions without signals are first come first served within each class of turn; there are no
  priority roads or roundabouts.
- Roads follow the grid: four directions, 20 m cells, one speed limit.
- All cars are 4.5 m long; no buses, lorries, cycles or pedestrians. Drivers differ a little in
  wanted speed, acceleration and headway, and never make mistakes.
- Routes are fixed at departure, by free-flow time. Drivers do not know about congestion until
  they are stuck behind it for 30 s.
- Detectors are perfect: controllers see exact counts, and where each car will turn.
- Max pressure splits a downstream queue evenly over that lane's exits, because turning ratios are
  not measured.

## Layout

```
crates/core/   the simulation library, no dependencies
  src/grid.rs, scenario.rs   the drawn map and its text form; presets/
  src/network.rs             lanes, junction movements, conflicts
  src/route.rs               A*
  src/follow.rs              the two car-following rules
  src/control.rs             the Controller trait and the five controllers
  src/sim.rs                 the simulation step
  src/metrics.rs             runs, warm-up, intervals
  tests/model.rs
crates/cli/    the `traffic` command
crates/wasm/   C-ABI exports for the browser (no wasm-bindgen)
web/           Vite and TypeScript: canvas map, editor, compare view, charts
web/src/c-editorial-tokens.css   the site's tokens; web/public/fonts the fonts they name
scripts/       validate.sh, same-in-browser.mjs
results/       output of validate.sh
```

## The look

The page uses the look of the author's site. `web/src/c-editorial-tokens.css` is the site's token
file, copied unchanged, and `web/src/style.css` gives this page's own names (`--ink`, `--go`,
`--series-1` and so on) the token values. The fonts the token file names are in `web/public/fonts`
with their licences; the text is Newsreader, under the SIL Open Font License
(`web/public/fonts/Newsreader-OFL.txt`). Dark follows the system setting.

The site has four meaning colours, used the same way in all the author's tools:

| Meaning colour | In the tools generally | Here |
| --- | --- | --- |
| proved (green) | finished, the answer; series 4 | green signal; max pressure |
| measured (ochre) | being read or compared; series 3 | amber signal; self-organising |
| against (red) | written, moved, wrong; series 2 | red signal, brake lights; actuated |
| open (violet) | the current item; series 1 | the chosen square, junctions with their own controller; fixed time |

There are five controllers and four colours, so capacity-aware pressure takes the colour of max
pressure, which it refines, and is drawn as a hollow bar, a dashed line and an outlined key.
Roads are now the page colour inside a kerb in the muted ink, so each signal sits on the page
colour; houses are filled in the muted ink. Cars are still each a different colour, but those
colours are the ink, the muted ink and the ink with each meaning colour mixed in, so no car reads
as a signal.

Removed: IBM Plex Sans, the blue accent and the old palette, the theme override, every shadow
(buttons, tooltip, slider), the gradient arrow on lists, the pill and rounded shapes, the filled
"pressed" tool (now a heavier ink edge), the tile and map boxes (now rules), bold figures and the
button transitions. Moved because text is now 17 px or more: map labels need their own width
before they are placed, a house's weight shows only once the house is 56 px wide (was 26), bar
chart rows grew from 30 to 36 px (54 when the name sits above the bar, now below 560 px wide
rather than 440), the value column from 112 to 170 px, line charts from 220 to 240 px with a left
margin that follows the widest label, and controls grew from 36 to 44 px.

Contrast, checked with the WCAG 2 formula on the token values: text 15.1 to 1 light and 13.8 dark,
muted text 5.9 and 7.1; the signal and series colours against the page, which is also the road,
4.9 to 6.1 light and 6.8 to 7.8 dark; cars 5.9 to 15.1 light and 7.1 to 13.8 dark; houses and kerbs
5.9 and 7.1.

## References

- Gershenson, 2005. Self-organizing traffic lights. Complex Systems 16(1). arXiv:nlin/0411066
- Varaiya, 2013. Max pressure control of a network of signalized intersections. Transportation
  Research Part C 36.
- Wongpiromsarn, Uthaicharoenpong, Wang, Frazzoli, Wang, 2012. Distributed traffic signal control
  for maximum network throughput. arXiv:1205.5938
- Gregoire, Qian, Frazzoli, de La Fortelle, Wongpiromsarn, 2014. Capacity-aware back-pressure
  traffic signal control. arXiv:1309.6484
- Treiber, Hennecke, Helbing, 2000. Congested traffic states in empirical observations and
  microscopic simulations. Physical Review E 62. arXiv:cond-mat/0002177
- Bando, Hasebe, Nakayama, Shibata, Sugiyama, 1995. Dynamical model of traffic congestion and
  numerical simulation. Physical Review E 51.
- FHWA Signal Timing Manual, chapter 5: actuated control.
- Jayawardana, Tang, Li, Suo, Wu, 2022. The impact of task underspecification in evaluating deep
  reinforcement learning. NeurIPS.

## Credit

Rebuilt from two 2021 prototypes by Varun Agarwal ("AI-based Traffic" 2 and 3, Python with pygame).

## Status

Working, as of 26 November 2026. See [STATUS.md](STATUS.md).

## Licence

MIT. See [LICENSE](LICENSE). Fonts keep their own licences, as listed above.
