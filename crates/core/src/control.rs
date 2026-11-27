//! Signal controllers. Each junction has one; all see the same observation and
//! answer one question: which phase should be green?
//!
//! To add a controller, implement [`Controller`] and add a line to [`CONTROLLERS`]
//! and to [`make`].

use std::collections::BTreeMap;

/// What a junction's detectors report about one lane.
#[derive(Clone, Copy, Debug, Default)]
pub struct LaneObs {
    /// Phase that gives this lane green (incoming lanes only).
    pub phase: usize,
    /// Cars on the lane, up to 150 m from the junction.
    pub cars: u32,
    /// Cars slower than 1 m/s.
    pub queued: u32,
    /// Cars within 80 m of the stop line.
    pub approaching: u32,
    /// Cars within 25 m of the stop line.
    pub near: u32,
    /// Queued cars the lane can hold.
    pub capacity: u32,
    /// Ways out of the junction at the lane's far end (at least 1).
    pub exits: u32,
}

/// One way through the junction.
#[derive(Clone, Copy, Debug)]
pub struct MovementObs {
    /// Index into `incoming` and `outgoing`.
    pub from: usize,
    pub to: usize,
    /// Cars on the incoming lane that will take this movement.
    pub cars: u32,
}

#[derive(Clone, Debug, Default)]
pub struct JunctionObs {
    /// Seconds since the last call.
    pub dt: f64,
    pub phases: usize,
    /// The phase that is green now and for how long it has been.
    pub phase: usize,
    pub green_for: f64,
    pub incoming: Vec<LaneObs>,
    pub outgoing: Vec<LaneObs>,
    pub movements: Vec<MovementObs>,
}

impl JunctionObs {
    fn sum(&self, phase: usize, f: impl Fn(&LaneObs) -> u32) -> u32 {
        self.incoming
            .iter()
            .filter(|l| l.phase == phase)
            .map(f)
            .sum()
    }

    /// The next phase after `phase`, in order, for which `wanted` holds.
    fn next_phase(&self, phase: usize, wanted: impl Fn(usize) -> bool) -> Option<usize> {
        (1..self.phases)
            .map(|k| (phase + k) % self.phases)
            .find(|&p| wanted(p))
    }
}

pub trait Controller {
    /// Called every step while a phase is green. Return the phase that should be
    /// green; returning another phase starts amber, then all-red, then that phase.
    /// The junction itself enforces [`MIN_GREEN`].
    fn decide(&mut self, obs: &JunctionObs) -> usize;
}

/// Seconds of amber and of all-red between two phases.
pub const AMBER: f64 = 3.0;
pub const ALL_RED: f64 = 2.0;
/// No green is shorter than this, whatever the controller asks.
pub const MIN_GREEN: f64 = 5.0;

pub struct ControllerInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
}

pub const CONTROLLERS: &[ControllerInfo] = &[
    ControllerInfo {
        id: "fixed",
        label: "Fixed time",
        summary: "Each direction gets the same green in turn, whether or not anyone is there.",
    },
    ControllerInfo {
        id: "actuated",
        label: "Actuated",
        summary: "Holds green while cars keep arriving, up to a maximum, then serves the next direction that has demand.",
    },
    ControllerInfo {
        id: "sotl",
        label: "Self-organising",
        summary: "Counts cars approaching the red light over time and switches when the count passes a threshold.",
    },
    ControllerInfo {
        id: "max-pressure",
        label: "Max pressure",
        summary: "Gives green to the direction with the most cars waiting minus the cars already downstream.",
    },
    ControllerInfo {
        id: "capacity-aware",
        label: "Capacity-aware pressure",
        summary: "Max pressure with queues measured against road capacity, so a full road downstream stops attracting cars.",
    },
];

/// Named numbers a scenario can override, such as `fixed.green`.
pub type Params = BTreeMap<String, f64>;

fn param(params: &Params, key: &str, default: f64) -> f64 {
    params.get(key).copied().unwrap_or(default)
}

pub fn make(id: &str, params: &Params) -> Option<Box<dyn Controller>> {
    Some(match id {
        "fixed" => Box::new(FixedTime {
            green: param(params, "fixed.green", 20.0),
        }),
        "actuated" => Box::new(Actuated {
            max_green: param(params, "actuated.max_green", 40.0),
        }),
        "sotl" => Box::new(SelfOrganising {
            theta: param(params, "sotl.theta", 8.0),
            min_green: param(params, "sotl.min_green", 6.0),
            platoon: param(params, "sotl.platoon", 0.0) > 0.0,
            count: vec![],
            last_phase: usize::MAX,
        }),
        "max-pressure" => Box::new(MaxPressure {
            slot: param(params, "pressure.slot", 10.0),
            capacity_aware: false,
        }),
        "capacity-aware" => Box::new(MaxPressure {
            slot: param(params, "pressure.slot", 10.0),
            capacity_aware: true,
        }),
        _ => return None,
    })
}

/// A fixed cycle: `green` seconds for each phase in turn.
struct FixedTime {
    green: f64,
}

impl Controller for FixedTime {
    fn decide(&mut self, obs: &JunctionObs) -> usize {
        if obs.green_for >= self.green {
            (obs.phase + 1) % obs.phases
        } else {
            obs.phase
        }
    }
}

/// Vehicle-actuated control in the usual sense (FHWA Signal Timing Manual, ch. 5):
/// the green is extended while a detector near the stop line keeps seeing cars
/// (gap-out when it does not) and is cut at a maximum (max-out). With nobody
/// waiting elsewhere the green rests where it is.
struct Actuated {
    max_green: f64,
}

impl Controller for Actuated {
    fn decide(&mut self, obs: &JunctionObs) -> usize {
        let waiting = |p: usize| obs.sum(p, |l| l.queued + l.near) > 0;
        let Some(next) = obs.next_phase(obs.phase, waiting) else {
            return obs.phase;
        };
        let gap_out = obs.sum(obs.phase, |l| l.near) == 0;
        if gap_out || obs.green_for >= self.max_green {
            next
        } else {
            obs.phase
        }
    }
}

/// Self-organising traffic lights (Gershenson, 2005). Each red direction
/// integrates the number of cars approaching or waiting (cars times seconds).
/// When that reaches `theta` and the green has lasted `min_green`, it gets green:
/// the paper's sotl-phase rule. With `platoon` set, the switch also waits while a
/// few cars are about to cross on green (sotl-platoon, with omega = 25 m, mu = 3).
struct SelfOrganising {
    theta: f64,
    min_green: f64,
    platoon: bool,
    count: Vec<f64>,
    last_phase: usize,
}

impl Controller for SelfOrganising {
    fn decide(&mut self, obs: &JunctionObs) -> usize {
        self.count.resize(obs.phases, 0.0);
        if obs.phase != self.last_phase {
            self.count[obs.phase] = 0.0;
            self.last_phase = obs.phase;
        }
        for (p, count) in self.count.iter_mut().enumerate() {
            if p != obs.phase {
                *count += obs.sum(p, |l| l.approaching) as f64 * obs.dt;
            }
        }
        if obs.green_for < self.min_green {
            return obs.phase;
        }
        if self.platoon {
            let crossing = obs.sum(obs.phase, |l| l.near);
            if (1..=3).contains(&crossing) {
                return obs.phase;
            }
        }
        let mut best = obs.phase;
        for p in 0..obs.phases {
            if p != obs.phase
                && self.count[p] >= self.theta
                && (best == obs.phase || self.count[p] > self.count[best])
            {
                best = p;
            }
        }
        best
    }
}

/// Max pressure (Varaiya, 2013; Wongpiromsarn et al., 2012). The weight of a
/// movement is the queue behind it minus the average queue per onward movement
/// on the lane it feeds (the cars there, split evenly over that lane's exits,
/// because turning ratios are not measured). A phase's pressure is the sum over
/// its movements; the phase with the most pressure gets green for at least one
/// slot.
///
/// The capacity-aware form (Gregoire et al., 2015) replaces queue lengths by a
/// convex pressure in [0, 1] that reaches 1 when a lane is full, and ignores
/// movements nobody is waiting for. A full lane downstream then cancels the
/// pull of any queue, so green is not spent on cars that cannot move.
struct MaxPressure {
    slot: f64,
    capacity_aware: bool,
}

/// Gregoire et al., equation 5, with their m = 4.
fn normalised_pressure(queue: f64, capacity: f64) -> f64 {
    /// Capacity at which pressure stays linear all the way; here, about 500 m of lane.
    const C_INF: f64 = 80.0;
    let x = queue / capacity;
    let p = (queue / C_INF + (2.0 - capacity / C_INF) * x * x * x * x) / (1.0 + x * x * x);
    p.min(1.0)
}

impl Controller for MaxPressure {
    fn decide(&mut self, obs: &JunctionObs) -> usize {
        if obs.green_for < self.slot {
            return obs.phase;
        }
        let mut pressure = vec![0.0; obs.phases];
        for m in &obs.movements {
            let (a, b) = (&obs.incoming[m.from], &obs.outgoing[m.to]);
            pressure[a.phase] += if self.capacity_aware {
                if m.cars == 0 {
                    0.0
                } else {
                    let up = normalised_pressure(a.cars as f64, a.capacity as f64);
                    let down = normalised_pressure(b.cars as f64, b.capacity as f64);
                    (up - down).max(0.0)
                }
            } else {
                m.cars as f64 - b.cars as f64 / b.exits.max(1) as f64
            };
        }
        let mut best = obs.phase;
        for p in 0..obs.phases {
            if pressure[p] > pressure[best] + 1e-9 {
                best = p;
            }
        }
        best
    }
}
