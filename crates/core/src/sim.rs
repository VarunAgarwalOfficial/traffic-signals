//! The simulation: cars follow routes over the network, keep their distance,
//! give way at junctions and obey signals.
//!
//! Every step has the same order: signals, new trips, junction entry decisions,
//! accelerations (all read from the state of the previous step), movement.
//! The only random numbers are in the demand stream, which never looks at the
//! traffic, so two runs with the same seed carry the same trips whatever the
//! signals do.

use crate::control::{self, Controller, JunctionObs, LaneObs, MovementObs, Params};
use crate::follow::{acceleration, Driver, FollowModel, CAR_LEN, CAR_WIDTH, MAX_BRAKE};
use crate::grid::Cell;
use crate::network::{Network, Point, Turn, SLOT};
use crate::rng::Rng;
use crate::route::{find_route, Route};
use crate::scenario::Scenario;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

/// Length of one step in seconds.
pub const DT: f64 = 0.1;
/// Cars never close up further than this, bumper to bumper.
const MIN_GAP: f64 = 0.3;
/// A waiting car stops this far before the stop line.
const STOP_BACK: f64 = 0.5;
/// Braking a driver counts on when deciding whether to enter a junction.
const DECIDE_BRAKE: f64 = 3.0;
/// Spare time demanded between two cars using the same patch of a junction.
const TIME_MARGIN: f64 = 1.0;
/// A car stays clear of a patch of junction another car is using by this much.
const SPACE_MARGIN: f64 = 1.0;
/// Below this speed a car counts as queued.
const QUEUE_SPEED: f64 = 1.0;
/// How far up a lane a junction's detectors reach.
const DETECT_RANGE: f64 = 150.0;
const NONE: usize = usize::MAX;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Light {
    /// The lane ends at a junction without a signal.
    None,
    Green,
    Amber,
    Red,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Green,
    Amber,
    AllRed,
}

struct Signal {
    controller: Box<dyn Controller>,
    phase: usize,
    next: usize,
    stage: Stage,
    elapsed: f64,
}

#[derive(Clone, Debug)]
pub struct Car {
    pub id: u32,
    route: Vec<usize>,
    /// Index into `route` of the lane the car is on, or has just left for a junction.
    leg: usize,
    /// The front of the car is inside the junction at the end of `route[leg]`.
    on_mov: bool,
    /// Distance of the front bumper along the lane, or along the junction path.
    pub s: f64,
    pub v: f64,
    /// Acceleration in the last step.
    pub a: f64,
    drv: Driver,
    /// The movement at the end of the current lane, if the trip goes on.
    mov: usize,
    /// The movement the rear of the car is still inside.
    tail_mov: usize,
    /// Allowed into the junction ahead; others treat the car as already in it.
    committed: bool,
    /// Order of commitment; earlier cars are never asked to give way to later ones.
    seq: u64,
    /// Told to wait at the stop line this step.
    walled: bool,
    /// When the car came up to the junction ahead; earlier goes first among equals.
    arrived_at: f64,
    dest_s: f64,
    requested: f64,
    free_time: f64,
    stops: u32,
    rolling: bool,
    /// Seconds spent first in line with no room in the lane it wants.
    blocked: f64,
}

#[derive(Clone, Copy)]
struct Trip {
    requested: f64,
    from: usize,
    to: usize,
    roll: f64,
}

/// The stream of trips. It reads nothing from the simulation.
struct Demand {
    rng: Rng,
    /// (origin house, destination house, share of the spread demand, fixed trips per hour).
    pairs: Vec<(usize, usize, f64, f64)>,
    per_hour: f64,
    next: f64,
}

impl Demand {
    fn rate(&self) -> f64 {
        self.pairs
            .iter()
            .map(|p| p.2 * self.per_hour + p.3)
            .sum::<f64>()
            / 3600.0
    }

    fn schedule(&mut self, now: f64) {
        let rate = self.rate();
        self.next = if rate > 0.0 {
            now + self.rng.exponential(rate)
        } else {
            f64::INFINITY
        };
    }

    fn draw(&mut self) -> Trip {
        let requested = self.next;
        let mut pick = self.rng.unit() * self.rate() * 3600.0;
        let roll = self.rng.unit();
        let mut chosen = self.pairs.len() - 1;
        for (i, p) in self.pairs.iter().enumerate() {
            pick -= p.2 * self.per_hour + p.3;
            if pick < 0.0 {
                chosen = i;
                break;
            }
        }
        self.schedule(requested);
        Trip {
            requested,
            from: self.pairs[chosen].0,
            to: self.pairs[chosen].1,
            roll,
        }
    }
}

/// One point of the time series kept for charts.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sample {
    pub time: f64,
    /// Trips finished since the previous sample and the sum of their delays.
    pub arrived: u32,
    pub delay_sum: f64,
    /// Cars standing on the road, and trips waiting at houses, at the sample time.
    pub queued: u32,
    pub backlog: u32,
}

/// Counts kept while the simulation runs.
#[derive(Clone, Debug, Default)]
pub struct Tally {
    /// Trips requested before this time are not measured (warm-up).
    pub measure_from: f64,
    /// Delay of every measured trip that finished, in seconds.
    pub delays: Vec<f32>,
    /// Stops made by those trips.
    pub stops: u64,
    /// Trips that finished after the warm-up, measured or not.
    pub arrived: u32,
    pub queue_sum: f64,
    pub queue_samples: u32,
    pub queue_max: u32,
    /// Times a car had to be held back by force instead of by its own braking.
    pub hard_brakes: u32,
    /// Cars that crossed a stop line at red.
    pub red_runs: u32,
    /// Pairs of overlapping cars seen by the overlap check.
    pub overlaps: u32,
    /// Drivers who gave up on a full road and went another way.
    pub reroutes: u32,
    pub series: Vec<Sample>,
}

pub struct Sim {
    pub net: Network,
    pub time: f64,
    pub tally: Tally,
    follow: FollowModel,
    reroute_after: f64,
    params: Params,
    default_controller: String,
    /// Controller id per node, for nodes that carry a signal.
    node_controller: Vec<Option<String>>,
    overrides: BTreeMap<usize, String>,
    signals: Vec<Option<Signal>>,
    lights: Vec<Light>,
    lane_phase: Vec<usize>,
    cars: Vec<Car>,
    alive: Vec<bool>,
    spare: Vec<usize>,
    /// Cars with their front on each lane, the one furthest along first.
    lane_cars: Vec<Vec<usize>>,
    /// The car that last left each lane for the junction, with its id.
    last_out: Vec<Option<(usize, u32)>>,
    /// Cars committed to or inside each movement, in order of commitment.
    occupants: Vec<Vec<usize>>,
    demand: Demand,
    waiting: Vec<VecDeque<Trip>>,
    routes: Vec<Option<Rc<Route>>>,
    next_id: u32,
    next_seq: u64,
    steps: u64,
    bucket: Sample,
    check_overlaps: bool,
}

enum Verdict {
    Go,
    Wait,
    ExitFull,
}

fn travel_time(d: f64, v: f64, a: f64, v_max: f64) -> f64 {
    if d <= 0.0 {
        return 0.0;
    }
    if v >= v_max {
        return d / v;
    }
    let d_acc = (v_max * v_max - v * v) / (2.0 * a);
    if d <= d_acc {
        ((v * v + 2.0 * a * d).sqrt() - v) / a
    } else {
        (v_max - v) / a + (d - d_acc) / v_max
    }
}

fn turn_class(turn: Turn) -> u8 {
    match turn {
        Turn::Straight => 0,
        Turn::Near => 1,
        Turn::Cross => 2,
    }
}

impl Sim {
    pub fn new(scenario: &Scenario, seed: u64) -> Self {
        let net = Network::from_grid(&scenario.grid);
        let houses = net.houses.len();
        let mut routes = vec![None; houses * houses];
        let weight = |h: usize| {
            scenario
                .weights
                .get(&net.houses[h].cell)
                .copied()
                .unwrap_or(1.0)
        };
        let mut pairs = Vec::new();
        for from in 0..houses {
            for to in 0..houses {
                if from == to {
                    continue;
                }
                let route =
                    find_route(&net, &net.houses[from].access, &net.houses[to].access, None);
                if let Some(route) = route {
                    routes[from * houses + to] = Some(Rc::new(route));
                    pairs.push((from, to, weight(from) * weight(to), 0.0));
                }
            }
        }
        let total: f64 = pairs.iter().map(|p| p.2).sum();
        for p in &mut pairs {
            p.2 = if total > 0.0 { p.2 / total } else { 0.0 };
        }
        let house_at = |cell: usize| net.houses.iter().position(|h| h.cell == cell);
        for &(from, to, per_hour) in &scenario.flows {
            if scenario.grid.cells[from] != Cell::House || scenario.grid.cells[to] != Cell::House {
                continue;
            }
            if let (Some(a), Some(b)) = (house_at(from), house_at(to)) {
                if let Some(p) = pairs.iter_mut().find(|p| p.0 == a && p.1 == b) {
                    p.3 += per_hour;
                }
            }
        }
        let mut demand = Demand {
            rng: Rng::new(seed),
            pairs,
            per_hour: scenario.demand,
            next: 0.0,
        };
        demand.schedule(0.0);

        let mut lane_phase = vec![0; net.lanes.len()];
        for node in &net.nodes {
            for (p, lanes) in node.phases.iter().enumerate() {
                for &l in lanes {
                    lane_phase[l] = p;
                }
            }
        }
        let mut sim = Sim {
            time: 0.0,
            tally: Tally::default(),
            follow: scenario.follow,
            reroute_after: scenario.reroute_after,
            params: scenario.params.clone(),
            default_controller: scenario.controller.clone(),
            node_controller: vec![None; net.nodes.len()],
            overrides: scenario.junctions.clone(),
            signals: (0..net.nodes.len()).map(|_| None).collect(),
            lights: vec![Light::None; net.lanes.len()],
            lane_phase,
            cars: Vec::new(),
            alive: Vec::new(),
            spare: Vec::new(),
            lane_cars: vec![Vec::new(); net.lanes.len()],
            last_out: vec![None; net.lanes.len()],
            occupants: vec![Vec::new(); net.movements.len()],
            demand,
            waiting: vec![VecDeque::new(); houses],
            routes,
            next_id: 0,
            next_seq: 0,
            steps: 0,
            bucket: Sample::default(),
            check_overlaps: false,
            net,
        };
        sim.install_controllers();
        sim.refresh_lights();
        sim
    }

    /// Count overlapping cars once a simulated second (costs a little time).
    pub fn check_overlaps(&mut self, on: bool) {
        self.check_overlaps = on;
    }

    /// Change the controller of every junction that has no choice of its own.
    pub fn set_controller(&mut self, id: &str) -> bool {
        if control::make(id, &self.params).is_none() {
            return false;
        }
        self.default_controller = id.into();
        self.install_controllers();
        true
    }

    /// Change the demand spread between houses, in trips per hour.
    pub fn set_demand(&mut self, per_hour: f64) {
        self.demand.per_hour = per_hour.max(0.0);
        self.demand.schedule(self.time);
    }

    fn install_controllers(&mut self) {
        for n in 0..self.net.nodes.len() {
            let node = &self.net.nodes[n];
            let choice = self
                .overrides
                .get(&node.cell)
                .unwrap_or(&self.default_controller);
            let wanted = (node.can_signal() && choice != "none").then(|| choice.clone());
            if wanted == self.node_controller[n] {
                continue;
            }
            self.signals[n] = wanted.as_ref().and_then(|id| {
                let controller = control::make(id, &self.params)?;
                // Keep the lights as they are when only the controller changes.
                let (phase, next, stage, elapsed) = match &self.signals[n] {
                    Some(s) => (s.phase, s.next, s.stage, s.elapsed),
                    None => (0, 0, Stage::Green, 0.0),
                };
                Some(Signal {
                    controller,
                    phase,
                    next,
                    stage,
                    elapsed,
                })
            });
            self.node_controller[n] = wanted;
        }
    }

    pub fn light(&self, lane: usize) -> Light {
        self.lights[lane]
    }

    /// The controller id at a node, if it carries a signal.
    pub fn controller_at(&self, node: usize) -> Option<&str> {
        self.node_controller[node].as_deref()
    }

    pub fn cars(&self) -> impl Iterator<Item = &Car> {
        self.cars
            .iter()
            .zip(&self.alive)
            .filter_map(|(c, &alive)| alive.then_some(c))
    }

    pub fn active(&self) -> usize {
        self.cars.len() - self.spare.len()
    }

    /// Trips waiting at houses for room on the road.
    pub fn backlog(&self) -> usize {
        self.waiting.iter().map(|q| q.len()).sum()
    }

    /// Delay so far of every measured trip that has not finished: a lower bound on its delay.
    pub fn pending_delays(&self) -> Vec<f64> {
        let from = self.tally.measure_from;
        let houses = self.net.houses.len();
        let so_far = |requested: f64, free: f64| (self.time - requested - free).max(0.0);
        let on_road = self
            .cars()
            .filter(|c| c.requested >= from)
            .map(|c| so_far(c.requested, c.free_time));
        let at_home = self
            .waiting
            .iter()
            .flatten()
            .filter(|t| t.requested >= from)
            .map(|t| {
                let free = self.routes[t.from * houses + t.to]
                    .as_ref()
                    .map_or(0.0, |r| r.time);
                so_far(t.requested, free)
            });
        on_road.chain(at_home).collect()
    }

    /// Trips per hour the demand stream asks for.
    pub fn demand_per_hour(&self) -> f64 {
        self.demand.rate() * 3600.0
    }

    pub fn step(&mut self) {
        self.step_signals();
        self.release_trips();
        self.decide_entries();
        self.move_cars();
        self.time += DT;
        self.steps += 1;
        if self.steps.is_multiple_of(10) {
            self.sample();
        }
    }

    // ----- signals -----

    fn step_signals(&mut self) {
        for n in 0..self.signals.len() {
            let Some(stage) = self.signals[n].as_ref().map(|s| s.stage) else {
                continue;
            };
            let obs = (stage == Stage::Green).then(|| self.observe(n));
            let signal = self.signals[n].as_mut().expect("checked above");
            signal.elapsed += DT;
            match signal.stage {
                Stage::Green => {
                    let obs = obs.expect("built for green");
                    let wanted = signal.controller.decide(&obs);
                    if wanted != signal.phase
                        && wanted < obs.phases
                        && signal.elapsed >= control::MIN_GREEN
                    {
                        signal.next = wanted;
                        signal.stage = Stage::Amber;
                        signal.elapsed = 0.0;
                    }
                }
                Stage::Amber if signal.elapsed >= control::AMBER => {
                    signal.stage = Stage::AllRed;
                    signal.elapsed = 0.0;
                }
                Stage::AllRed if signal.elapsed >= control::ALL_RED => {
                    signal.phase = signal.next;
                    signal.stage = Stage::Green;
                    signal.elapsed = 0.0;
                }
                _ => {}
            }
        }
        self.refresh_lights();
    }

    fn refresh_lights(&mut self) {
        for (n, node) in self.net.nodes.iter().enumerate() {
            for &lane in &node.incoming {
                self.lights[lane] = match &self.signals[n] {
                    None => Light::None,
                    Some(s) if self.lane_phase[lane] != s.phase => Light::Red,
                    Some(s) => match s.stage {
                        Stage::Green => Light::Green,
                        Stage::Amber => Light::Amber,
                        Stage::AllRed => Light::Red,
                    },
                };
            }
        }
    }

    fn observe(&self, n: usize) -> JunctionObs {
        let node = &self.net.nodes[n];
        let signal = self.signals[n]
            .as_ref()
            .expect("only signalised nodes are observed");
        let mut obs = JunctionObs {
            dt: DT,
            phases: node.phases.len(),
            phase: signal.phase,
            green_for: signal.elapsed,
            ..JunctionObs::default()
        };
        let exits = |lane: usize| self.net.lanes[lane].movements.len().max(1) as u32;
        let capacity = |lane: usize| {
            self.net.lanes[lane]
                .capacity
                .min((DETECT_RANGE / SLOT) as u32)
        };
        for &lane in &node.outgoing {
            let cars = self.lane_cars[lane]
                .iter()
                .filter(|&&i| self.cars[i].s <= DETECT_RANGE)
                .count() as u32;
            obs.outgoing.push(LaneObs {
                cars,
                capacity: capacity(lane),
                exits: exits(lane),
                ..LaneObs::default()
            });
        }
        for (from, &lane) in node.incoming.iter().enumerate() {
            let length = self.net.lanes[lane].length;
            let first = obs.movements.len();
            for &m in &self.net.lanes[lane].movements {
                let to = self.net.movements[m].to;
                let to = node.outgoing.iter().position(|&l| l == to).unwrap_or(0);
                obs.movements.push(MovementObs { from, to, cars: 0 });
            }
            let mut seen = LaneObs {
                phase: self.lane_phase[lane],
                capacity: capacity(lane),
                exits: exits(lane),
                ..LaneObs::default()
            };
            for &i in &self.lane_cars[lane] {
                let c = &self.cars[i];
                let d = length - c.s;
                if c.mov == NONE || d > DETECT_RANGE {
                    continue;
                }
                seen.cars += 1;
                seen.queued += u32::from(c.v < QUEUE_SPEED);
                seen.approaching += u32::from(d <= 80.0);
                seen.near += u32::from(d <= 25.0);
                let k = self.net.lanes[lane]
                    .movements
                    .iter()
                    .position(|&m| m == c.mov)
                    .unwrap_or(0);
                obs.movements[first + k].cars += 1;
            }
            obs.incoming.push(seen);
        }
        obs
    }

    // ----- demand -----

    fn release_trips(&mut self) {
        while self.demand.next <= self.time {
            let trip = self.demand.draw();
            self.waiting[trip.from].push_back(trip);
        }
        for house in 0..self.waiting.len() {
            let Some(&trip) = self.waiting[house].front() else {
                continue;
            };
            let houses = self.net.houses.len();
            let Some(route) = self.routes[trip.from * houses + trip.to].clone() else {
                self.waiting[house].pop_front();
                continue;
            };
            if self.room_to_pull_out(route.lanes[0], route.start_s) {
                self.waiting[house].pop_front();
                self.add_car(&trip, &route);
            }
        }
    }

    /// A car may pull out of a house when it would not be in anyone's way.
    fn room_to_pull_out(&self, lane: usize, s: f64) -> bool {
        let safe_behind = |gap: f64, v: f64| gap >= 2.0 + v + v * v / (2.0 * DECIDE_BRAKE);
        // The car that just left the lane may still have its tail on it.
        if let Some((rear, _)) = self.tail_of_last_out(lane) {
            if self.net.lanes[lane].length + rear - s < 2.0 {
                return false;
            }
        }
        let mut follower = false;
        for &i in &self.lane_cars[lane] {
            let c = &self.cars[i];
            if c.s >= s {
                if c.s - CAR_LEN - s < 2.0 {
                    return false;
                }
            } else {
                follower = true;
                if !safe_behind(s - CAR_LEN - c.s, c.v) {
                    return false;
                }
                break;
            }
        }
        if !follower {
            // Nobody behind on the lane: look at cars on their way in from the junction.
            let from = self.net.lanes[lane].from;
            for &inc in &self.net.nodes[from].incoming {
                for &m in &self.net.lanes[inc].movements {
                    if self.net.movements[m].to != lane {
                        continue;
                    }
                    for &i in &self.occupants[m] {
                        let c = &self.cars[i];
                        let to_go = self.net.movements[m].length - self.u_on(c, m);
                        if to_go > 0.0 && !safe_behind(to_go + s - CAR_LEN, c.v) {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    fn add_car(&mut self, trip: &Trip, route: &Route) {
        let lane = route.lanes[0];
        let car = Car {
            id: self.next_id,
            route: route.lanes.clone(),
            leg: 0,
            on_mov: false,
            s: route.start_s,
            v: 0.0,
            a: 0.0,
            drv: Driver::from_roll(trip.roll),
            mov: NONE,
            tail_mov: NONE,
            committed: false,
            seq: 0,
            walled: false,
            arrived_at: f64::INFINITY,
            dest_s: route.end_s,
            requested: trip.requested,
            free_time: route.time,
            stops: 0,
            rolling: false,
            blocked: 0.0,
        };
        self.next_id += 1;
        let i = match self.spare.pop() {
            Some(i) => {
                self.cars[i] = car;
                self.alive[i] = true;
                i
            }
            None => {
                self.cars.push(car);
                self.alive.push(true);
                self.cars.len() - 1
            }
        };
        self.cars[i].mov = self.next_movement(i);
        let at = self.lane_cars[lane]
            .iter()
            .position(|&j| self.cars[j].s < route.start_s)
            .unwrap_or(self.lane_cars[lane].len());
        self.lane_cars[lane].insert(at, i);
    }

    fn next_movement(&self, i: usize) -> usize {
        let c = &self.cars[i];
        match c.route.get(c.leg + 1) {
            Some(&to) => self
                .net
                .movement_between(c.route[c.leg], to)
                .unwrap_or(NONE),
            None => NONE,
        }
    }

    // ----- junctions -----

    /// Position of a car's front along movement `m`: negative while still on the
    /// lane before it, beyond the movement's length once on the lane after it.
    fn u_on(&self, c: &Car, m: usize) -> f64 {
        let mv = &self.net.movements[m];
        if c.tail_mov == m {
            mv.length + c.s
        } else if c.on_mov {
            c.s
        } else {
            c.s - self.net.lanes[mv.from].length
        }
    }

    /// The car that last left `lane` for the junction, while it is still in the
    /// junction: where its rear is, measured from the end of the lane, and which car.
    fn tail_of_last_out(&self, lane: usize) -> Option<(f64, usize)> {
        let (j, id) = self.last_out[lane]?;
        let f = &self.cars[j];
        if !self.alive[j] || f.id != id {
            return None;
        }
        let m = if f.on_mov { f.mov } else { f.tail_mov };
        (m != NONE && self.net.movements[m].from == lane).then(|| (self.u_on(f, m) - CAR_LEN, j))
    }

    /// Is there room in the lane a movement leads to, counting cars already promised a place?
    fn exit_free(&self, m: usize) -> bool {
        let to = self.net.movements[m].to;
        let lane = &self.net.lanes[to];
        let mut free = lane.length;
        if let Some(&t) = self.lane_cars[to].last() {
            let tail = &self.cars[t];
            free = free.min(tail.s - CAR_LEN + tail.v * tail.v / (2.0 * DECIDE_BRAKE));
        }
        let mut promised = 0;
        for &inc in &self.net.nodes[lane.from].incoming {
            for &other in &self.net.lanes[inc].movements {
                if self.net.movements[other].to == to {
                    promised += self.occupants[other]
                        .iter()
                        .filter(|&&i| self.cars[i].tail_mov != other)
                        .count();
                }
            }
        }
        free - promised as f64 * SLOT >= SLOT - 0.01
    }

    fn rank(&self, c: &Car) -> (u8, f64, u32) {
        (
            turn_class(self.net.movements[c.mov].turn),
            c.arrived_at,
            c.id,
        )
    }

    fn outranks(&self, a: &Car, b: &Car) -> bool {
        let (ra, rb) = (self.rank(a), self.rank(b));
        ra.0.cmp(&rb.0)
            .then(ra.1.total_cmp(&rb.1))
            .then(ra.2.cmp(&rb.2))
            .is_lt()
    }

    /// May car `i`, first in line on its lane, enter the junction ahead?
    fn may_enter(&self, i: usize) -> Verdict {
        let c = &self.cars[i];
        let lane = c.route[c.leg];
        let mv = &self.net.movements[c.mov];
        let dist = self.net.lanes[lane].length - c.s;
        match self.lights[lane] {
            Light::Red => return Verdict::Wait,
            Light::Amber => {
                // A car that has been waiting at the line for a gap may still go
                // early in the amber, once the traffic it gave way to has stopped.
                let early = self.signals[mv.node]
                    .as_ref()
                    .is_some_and(|s| s.elapsed < 2.0);
                if !(early && c.v < 1.0 && dist < 2.5) {
                    return Verdict::Wait;
                }
            }
            Light::Green | Light::None => {}
        }
        if !self.exit_free(c.mov) {
            return Verdict::ExitFull;
        }
        let reach = |d: f64| travel_time(d, c.v, 2.5, mv.speed.max(c.v));
        let clear = |d: f64| travel_time(d, c.v, c.drv.accel, mv.speed * c.drv.speed_factor);
        for cf in &mv.conflicts {
            let foe = &self.net.movements[cf.other];
            // Cars already let into the junction on a path that meets this one.
            for &j in &self.occupants[cf.other] {
                let f = &self.cars[j];
                let to_go = cf.other_exit + SPACE_MARGIN + CAR_LEN - self.u_on(f, cf.other);
                if to_go <= 0.0 {
                    continue;
                }
                if cf.merge || f.v < 1.0 {
                    return Verdict::Wait;
                }
                if reach(dist + cf.own_enter - SPACE_MARGIN) < to_go / f.v + TIME_MARGIN {
                    return Verdict::Wait;
                }
            }
            // Cars with right of way that are coming and would arrive too soon.
            if matches!(self.lights[foe.from], Light::Red | Light::Amber) {
                continue;
            }
            let foe_len = self.net.lanes[foe.from].length;
            let mut head = true;
            for &j in &self.lane_cars[foe.from] {
                let f = &self.cars[j];
                if f.committed || f.mov == NONE {
                    continue;
                }
                let is_head = std::mem::replace(&mut head, false);
                let foe_dist = foe_len - f.s;
                if foe_dist > DETECT_RANGE {
                    break;
                }
                if f.mov != cf.other || !self.outranks(f, c) {
                    continue;
                }
                if f.v <= 0.5 && !(is_head && self.exit_free(f.mov)) {
                    continue;
                }
                let arrives = travel_time(
                    foe_dist + cf.other_enter - SPACE_MARGIN,
                    f.v,
                    2.5,
                    self.net.lanes[foe.from].speed.max(f.v),
                );
                if arrives < clear(dist + cf.own_exit + CAR_LEN + SPACE_MARGIN) + TIME_MARGIN {
                    return Verdict::Wait;
                }
            }
        }
        Verdict::Go
    }

    fn decide_entries(&mut self) {
        let mut candidates: Vec<usize> = Vec::new();
        for lane in 0..self.net.lanes.len() {
            let length = self.net.lanes[lane].length;
            let light = self.lights[lane];
            let mut found = false;
            for k in 0..self.lane_cars[lane].len() {
                let i = self.lane_cars[lane][k];
                let c = &mut self.cars[i];
                c.walled = false;
                if c.mov == NONE {
                    continue;
                }
                let dist = length - c.s;
                if c.committed {
                    // The light changed and there is still room to stop: stop after all.
                    let brake = match light {
                        Light::Amber if dist > 2.5 => DECIDE_BRAKE,
                        Light::Red => 4.5,
                        _ => continue,
                    };
                    if dist > c.v * c.v / (2.0 * brake) + STOP_BACK + c.v * DT {
                        c.committed = false;
                        let m = c.mov;
                        self.occupants[m].retain(|&j| j != i);
                    } else {
                        continue;
                    }
                }
                if found {
                    continue;
                }
                found = true;
                let c = &mut self.cars[i];
                if dist <= c.v * c.v / (2.0 * DECIDE_BRAKE) + c.v * DT + 3.0 {
                    if c.arrived_at == f64::INFINITY {
                        c.arrived_at = self.time;
                    }
                    candidates.push(i);
                }
            }
        }
        candidates.sort_by(|&a, &b| {
            let (ra, rb) = (self.rank(&self.cars[a]), self.rank(&self.cars[b]));
            ra.0.cmp(&rb.0)
                .then(ra.1.total_cmp(&rb.1))
                .then(ra.2.cmp(&rb.2))
        });
        for i in candidates {
            match self.may_enter(i) {
                Verdict::Go => {
                    let c = &mut self.cars[i];
                    c.committed = true;
                    c.seq = self.next_seq;
                    c.blocked = 0.0;
                    self.next_seq += 1;
                    let m = c.mov;
                    self.occupants[m].push(i);
                }
                Verdict::Wait => self.cars[i].walled = true,
                Verdict::ExitFull => {
                    let c = &mut self.cars[i];
                    c.walled = true;
                    c.blocked += DT;
                    if self.reroute_after > 0.0 && c.blocked >= self.reroute_after {
                        c.blocked = 0.0;
                        self.try_another_way(i);
                    }
                }
            }
        }
    }

    /// A driver stuck behind a full road looks for a route through another exit.
    fn try_another_way(&mut self, i: usize) {
        let c = &self.cars[i];
        let lane = c.route[c.leg];
        let blocked = self.net.movements[c.mov].to;
        let Some(&last) = c.route.last() else { return };
        let goals = [
            (last, c.dest_s),
            (self.net.lanes[last].twin, {
                // The same house, reached from the other side of its road.
                let twin = self.net.lanes[last].twin;
                let p = self.net.lanes[last].path.pose(c.dest_s).0;
                self.net.lanes[twin].path.project(p).0
            }),
        ];
        let Some(route) = find_route(&self.net, &[(lane, c.s)], &goals, Some((lane, blocked)))
        else {
            return;
        };
        if route.lanes.len() < 2 {
            return;
        }
        let c = &mut self.cars[i];
        c.route = route.lanes;
        c.leg = 0;
        c.dest_s = route.end_s;
        self.cars[i].mov = self.next_movement(i);
        self.tally.reroutes += 1;
    }

    // ----- movement -----

    /// Acceleration for car `i` and how far it may move at most this step.
    /// `ahead` is the next car on the same lane, if any.
    fn plan(&self, i: usize, ahead: Option<usize>) -> (f64, f64) {
        let c = &self.cars[i];
        let lane = c.route[c.leg];
        let l = &self.net.lanes[lane];
        let mut v0 = l.speed * c.drv.speed_factor;
        // Things ahead: (gap as the driver sees it, its speed, room to move).
        let mut seen: Vec<(f64, f64, f64)> = Vec::new();
        let car = |seen: &mut Vec<(f64, f64, f64)>, gap: f64, v: f64| {
            seen.push((gap, v, gap - MIN_GAP));
        };
        let wall = |seen: &mut Vec<(f64, f64, f64)>, d: f64| {
            seen.push((d + c.drv.stand_gap, 0.0, d));
        };
        if c.on_mov {
            let mv = &self.net.movements[c.mov];
            if mv.turn != Turn::Straight {
                v0 = mv.speed * c.drv.speed_factor;
            }
            self.look_into_junction(i, c.s, &mut seen);
        } else {
            let dist = l.length - c.s;
            if let Some(j) = ahead {
                car(&mut seen, self.cars[j].s - CAR_LEN - c.s, self.cars[j].v);
            } else if let Some((rear, j)) = self.tail_of_last_out(lane) {
                // The car that left this lane last may still have its tail in the way.
                let f = &self.cars[j];
                let same_way = c.mov != NONE && (f.mov == c.mov || f.tail_mov == c.mov);
                if same_way || rear < 4.0 {
                    car(&mut seen, dist + rear, f.v);
                }
            }
            if c.mov != NONE {
                let mv = &self.net.movements[c.mov];
                if mv.turn != Turn::Straight {
                    let turn = mv.speed * c.drv.speed_factor;
                    v0 = v0.min((turn * turn + 2.0 * 1.5 * dist).sqrt());
                }
                if c.committed {
                    if ahead.is_none() {
                        self.look_into_junction(i, -dist, &mut seen);
                    }
                } else {
                    if c.walled {
                        wall(&mut seen, dist - STOP_BACK);
                    }
                    // Whatever happens, never over the line without leave.
                    seen.push((f64::INFINITY, 0.0, dist - 0.05));
                }
            }
        }
        let mut acc = acceleration(self.follow, &c.drv, c.v, v0, f64::INFINITY, 0.0);
        let mut room = f64::INFINITY;
        for (gap, lead_v, limit) in seen {
            if gap < f64::INFINITY {
                acc = acc.min(acceleration(self.follow, &c.drv, c.v, v0, gap, lead_v));
            }
            room = room.min(limit);
        }
        (acc, room)
    }

    /// What a car committed to its movement sees from position `u` along it.
    fn look_into_junction(&self, i: usize, u: f64, seen: &mut Vec<(f64, f64, f64)>) {
        let c = &self.cars[i];
        let m = c.mov;
        let mv = &self.net.movements[m];
        for &j in &self.occupants[m] {
            let f = &self.cars[j];
            let uf = self.u_on(f, m);
            if j != i && uf > u {
                let gap = uf - CAR_LEN - u;
                seen.push((gap, f.v, gap - MIN_GAP));
            }
        }
        if let Some(&t) = self.lane_cars[mv.to].last() {
            if t != i {
                let gap = mv.length - u + self.cars[t].s - CAR_LEN;
                seen.push((gap, self.cars[t].v, gap - MIN_GAP));
            }
        }
        // Give way inside the junction to cars that were let in earlier.
        for cf in &mv.conflicts {
            let d = cf.own_enter - SPACE_MARGIN - u;
            if d < 0.0 {
                continue;
            }
            let in_the_way = self.occupants[cf.other].iter().any(|&j| {
                let f = &self.cars[j];
                f.seq < c.seq && self.u_on(f, cf.other) - CAR_LEN <= cf.other_exit + 0.5
            });
            if in_the_way {
                seen.push((d + c.drv.stand_gap, 0.0, d));
            }
        }
    }

    fn move_cars(&mut self) {
        let mut plans: Vec<(usize, f64, f64)> = Vec::with_capacity(self.active());
        for lane in 0..self.lane_cars.len() {
            let mut ahead = None;
            for &i in &self.lane_cars[lane] {
                let (acc, room) = self.plan(i, ahead);
                plans.push((i, acc, room));
                ahead = Some(i);
            }
        }
        for i in 0..self.cars.len() {
            if self.alive[i] && self.cars[i].on_mov {
                let (acc, room) = self.plan(i, None);
                plans.push((i, acc, room));
            }
        }
        for &(i, acc, room) in &plans {
            let c = &mut self.cars[i];
            let mut v = (c.v + acc * DT).max(0.0);
            let mut ds = v * DT;
            if ds > room {
                ds = room.max(0.0);
                v = ds / DT;
                if c.v - v > 1.5 * MAX_BRAKE * DT {
                    self.tally.hard_brakes += 1;
                }
            }
            c.a = (v - c.v) / DT;
            c.v = v;
            c.s += ds;
            if c.rolling && v < 0.3 {
                c.rolling = false;
                c.stops += 1;
            } else if v > 2.0 {
                c.rolling = true;
            }
        }
        for &(i, _, _) in &plans {
            self.settle(i);
        }
    }

    /// Move a car on to the next piece of road when it has run off the end of this one.
    fn settle(&mut self, i: usize) {
        loop {
            let c = &self.cars[i];
            let lane = c.route[c.leg];
            if c.on_mov {
                let m = c.mov;
                let length = self.net.movements[m].length;
                if c.s < length {
                    break;
                }
                let to = self.net.movements[m].to;
                let c = &mut self.cars[i];
                c.s -= length;
                c.on_mov = false;
                c.leg += 1;
                c.tail_mov = m;
                c.committed = false;
                c.arrived_at = f64::INFINITY;
                let s = c.s;
                self.cars[i].mov = self.next_movement(i);
                let at = self.lane_cars[to]
                    .iter()
                    .position(|&j| self.cars[j].s < s)
                    .unwrap_or(self.lane_cars[to].len());
                self.lane_cars[to].insert(at, i);
            } else if c.mov == NONE {
                if c.s >= c.dest_s {
                    self.finish(i);
                    return;
                }
                break;
            } else {
                let length = self.net.lanes[lane].length;
                if c.s < length {
                    break;
                }
                if self.lights[lane] == Light::Red {
                    self.tally.red_runs += 1;
                }
                let c = &mut self.cars[i];
                c.s -= length;
                c.on_mov = true;
                let id = c.id;
                self.lane_cars[lane].retain(|&j| j != i);
                self.last_out[lane] = Some((i, id));
            }
        }
        let c = &self.cars[i];
        if c.tail_mov != NONE && !c.on_mov && c.s >= CAR_LEN {
            let m = c.tail_mov;
            self.occupants[m].retain(|&j| j != i);
            self.cars[i].tail_mov = NONE;
        }
    }

    fn finish(&mut self, i: usize) {
        let c = &self.cars[i];
        let lane = c.route[c.leg];
        let delay = (self.time + DT - c.requested - c.free_time).max(0.0);
        if c.requested >= self.tally.measure_from {
            self.tally.delays.push(delay as f32);
            self.tally.stops += u64::from(c.stops);
        }
        if self.time >= self.tally.measure_from {
            self.tally.arrived += 1;
        }
        self.bucket.arrived += 1;
        self.bucket.delay_sum += delay;
        if c.tail_mov != NONE {
            let m = c.tail_mov;
            self.occupants[m].retain(|&j| j != i);
        }
        self.lane_cars[lane].retain(|&j| j != i);
        self.alive[i] = false;
        self.spare.push(i);
    }

    // ----- measurement -----

    fn sample(&mut self) {
        let queued = self.cars().filter(|c| c.v < QUEUE_SPEED).count() as u32;
        if self.time >= self.tally.measure_from {
            self.tally.queue_sum += f64::from(queued);
            self.tally.queue_samples += 1;
            self.tally.queue_max = self.tally.queue_max.max(queued);
        }
        if self.check_overlaps {
            self.tally.overlaps += self.count_overlaps();
        }
        if self.steps.is_multiple_of(100) {
            self.bucket.time = self.time;
            self.bucket.queued = queued;
            self.bucket.backlog = self.backlog() as u32;
            self.tally.series.push(self.bucket);
            self.bucket = Sample::default();
        }
    }

    /// The point `back` metres behind the front of a car, following the road it came along.
    fn point_behind(&self, c: &Car, back: f64) -> Point {
        let lane = c.route[c.leg];
        let on_lane = |lane: usize, s: f64| self.net.lanes[lane].path.pose(s).0;
        let on_movement = |m: usize, x: f64| {
            let mv = &self.net.movements[m];
            if x >= 0.0 {
                mv.path.pose(x).0
            } else {
                on_lane(mv.from, self.net.lanes[mv.from].length + x)
            }
        };
        if c.on_mov {
            on_movement(c.mov, c.s - back)
        } else if c.s >= back || c.tail_mov == NONE {
            on_lane(lane, (c.s - back).max(0.0))
        } else {
            on_movement(
                c.tail_mov,
                self.net.movements[c.tail_mov].length + c.s - back,
            )
        }
    }

    /// Centre of a car and the unit vector it points along.
    pub fn pose(&self, c: &Car) -> (Point, Point) {
        let front = self.point_behind(c, 0.0);
        let rear = self.point_behind(c, CAR_LEN);
        let (dx, dy) = (front.0 - rear.0, front.1 - rear.1);
        let len = (dx * dx + dy * dy).sqrt();
        let heading = if len > 1e-6 {
            (dx / len, dy / len)
        } else {
            self.net.lanes[c.route[c.leg]].path.pose(c.s).1
        };
        (
            ((front.0 + rear.0) / 2.0, (front.1 + rear.1) / 2.0),
            heading,
        )
    }

    /// Number of pairs of cars whose bodies overlap right now.
    pub fn count_overlaps(&self) -> u32 {
        let mut boxes: Vec<(Point, Point)> = self.cars().map(|c| self.pose(c)).collect();
        boxes.sort_by(|a, b| a.0 .0.total_cmp(&b.0 .0));
        let (hl, hw) = ((CAR_LEN - 0.3) / 2.0, (CAR_WIDTH - 0.2) / 2.0);
        let mut count = 0;
        for i in 0..boxes.len() {
            for j in i + 1..boxes.len() {
                let (a, b) = (&boxes[i], &boxes[j]);
                if b.0 .0 - a.0 .0 > CAR_LEN + 1.0 {
                    break;
                }
                // Separating axis test for two rectangles.
                let d = (b.0 .0 - a.0 .0, b.0 .1 - a.0 .1);
                let axes = [a.1, (-a.1 .1, a.1 .0), b.1, (-b.1 .1, b.1 .0)];
                let apart = axes.iter().any(|ax| {
                    let reach = |h: Point| {
                        hl * (h.0 * ax.0 + h.1 * ax.1).abs() + hw * (h.0 * ax.1 - h.1 * ax.0).abs()
                    };
                    (d.0 * ax.0 + d.1 * ax.1).abs() > reach(a.1) + reach(b.1)
                });
                count += u32::from(!apart);
            }
        }
        count
    }
}
