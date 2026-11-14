//! Running a scenario and summarising what happened.

use crate::scenario::Scenario;
use crate::sim::{Sim, DT};

/// What one seeded run measured after its warm-up.
#[derive(Clone, Debug, Default)]
pub struct RunMetrics {
    pub seed: u64,
    /// Trips per hour the demand asked for.
    pub demand: f64,
    /// Mean and 95th percentile delay of measured trips that finished, seconds.
    pub delay_mean: f64,
    pub delay_p95: f64,
    /// Mean delay counting unfinished trips at their delay so far: a lower
    /// bound on the true mean, and the honest number when the roads are full.
    pub delay_all: f64,
    /// Trips finished per hour.
    pub throughput: f64,
    pub finished: u32,
    /// Measured trips still on the road or waiting at a house at the end.
    pub unfinished: u32,
    /// Cars standing on the road: mean and largest, sampled every second.
    pub queue_mean: f64,
    pub queue_max: u32,
    pub stops_per_trip: f64,
    pub reroutes: u32,
    /// Model checks. All three should be zero.
    pub hard_brakes: u32,
    pub red_runs: u32,
    pub overlaps: u32,
}

pub const METRIC_NAMES: &[&str] = &[
    "delay_mean",
    "delay_p95",
    "delay_all",
    "throughput",
    "finished",
    "unfinished",
    "queue_mean",
    "queue_max",
    "stops_per_trip",
    "reroutes",
    "hard_brakes",
    "red_runs",
    "overlaps",
];

impl RunMetrics {
    /// Values in the order of [`METRIC_NAMES`].
    pub fn values(&self) -> [f64; 13] {
        [
            self.delay_mean,
            self.delay_p95,
            self.delay_all,
            self.throughput,
            f64::from(self.finished),
            f64::from(self.unfinished),
            self.queue_mean,
            f64::from(self.queue_max),
            self.stops_per_trip,
            f64::from(self.reroutes),
            f64::from(self.hard_brakes),
            f64::from(self.red_runs),
            f64::from(self.overlaps),
        ]
    }
}

/// Read the metrics off a simulation that has run to `sim.time`.
pub fn measure(sim: &Sim, seed: u64) -> RunMetrics {
    let t = &sim.tally;
    let mut delays: Vec<f64> = t.delays.iter().map(|&d| f64::from(d)).collect();
    delays.sort_by(|a, b| a.total_cmp(b));
    let n = delays.len();
    let sum: f64 = delays.iter().sum();
    let pending = sim.pending_delays();
    let measured = (sim.time - t.measure_from).max(DT);
    RunMetrics {
        seed,
        demand: sim.demand_per_hour(),
        delay_mean: if n > 0 { sum / n as f64 } else { 0.0 },
        delay_p95: if n > 0 {
            delays[((n as f64 * 0.95).ceil() as usize).clamp(1, n) - 1]
        } else {
            0.0
        },
        delay_all: if n + pending.len() > 0 {
            (sum + pending.iter().sum::<f64>()) / (n + pending.len()) as f64
        } else {
            0.0
        },
        throughput: f64::from(t.arrived) * 3600.0 / measured,
        finished: n as u32,
        unfinished: pending.len() as u32,
        queue_mean: if t.queue_samples > 0 {
            t.queue_sum / f64::from(t.queue_samples)
        } else {
            0.0
        },
        queue_max: t.queue_max,
        stops_per_trip: if n > 0 {
            t.stops as f64 / n as f64
        } else {
            0.0
        },
        reroutes: t.reroutes,
        hard_brakes: t.hard_brakes,
        red_runs: t.red_runs,
        overlaps: t.overlaps,
    }
}

/// Run `scenario` for `duration` seconds and measure trips requested after `warmup`.
pub fn run(scenario: &Scenario, seed: u64, duration: f64, warmup: f64) -> RunMetrics {
    let mut sim = Sim::new(scenario, seed);
    sim.tally.measure_from = warmup;
    sim.check_overlaps(true);
    let steps = (duration / DT).round() as u64;
    for _ in 0..steps {
        sim.step();
    }
    measure(&sim, seed)
}

/// Mean of a sample with the half-width of its 95% confidence interval.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Estimate {
    pub mean: f64,
    pub half_width: f64,
    pub n: usize,
}

/// Two-sided 95% points of Student's t for 1 to 30 degrees of freedom.
const T95: [f64; 30] = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160,
    2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056,
    2.052, 2.048, 2.045, 2.042,
];

/// Mean and confidence interval over independent runs (one value per seed).
pub fn estimate(values: &[f64]) -> Estimate {
    let n = values.len();
    if n == 0 {
        return Estimate::default();
    }
    let mean = values.iter().sum::<f64>() / n as f64;
    if n == 1 {
        return Estimate {
            mean,
            half_width: f64::NAN,
            n,
        };
    }
    let var = values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (n - 1) as f64;
    let t = T95.get(n - 2).copied().unwrap_or(1.96);
    Estimate {
        mean,
        half_width: t * (var / n as f64).sqrt(),
        n,
    }
}
