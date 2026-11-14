//! Car following: how hard a driver accelerates given the gap ahead.

use crate::rng::exp;

/// Length of every car in metres.
pub const CAR_LEN: f64 = 4.5;
/// Width of every car in metres.
pub const CAR_WIDTH: f64 = 1.8;
/// Hardest braking either rule will ask for, in m/s^2.
pub const MAX_BRAKE: f64 = 8.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FollowModel {
    /// Intelligent Driver Model (Treiber, Hennecke and Helbing, 2000).
    Idm,
    /// The owner's 2021 rule: a sigmoid of the gap error applied to acceleration.
    Sigmoid,
}

impl FollowModel {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "idm" => Some(Self::Idm),
            "sigmoid" => Some(Self::Sigmoid),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Idm => "idm",
            Self::Sigmoid => "sigmoid",
        }
    }
}

/// One driver's character. Distances in metres, time in seconds.
#[derive(Clone, Copy, Debug)]
pub struct Driver {
    /// Wanted speed as a fraction of the speed limit.
    pub speed_factor: f64,
    /// Comfortable acceleration.
    pub accel: f64,
    /// Comfortable braking.
    pub brake: f64,
    /// Gap kept to the car ahead when standing.
    pub stand_gap: f64,
    /// Time headway.
    pub headway: f64,
}

impl Driver {
    /// A driver from a roll in [0, 1): higher rolls drive a little faster and closer.
    pub fn from_roll(roll: f64) -> Self {
        Self {
            speed_factor: 0.92 + 0.16 * roll,
            accel: 1.8 + 0.6 * roll,
            brake: 2.4 + 0.6 * roll,
            stand_gap: 2.0,
            headway: 1.3 - 0.3 * roll,
        }
    }
}

/// Acceleration for a driver at speed `v` who wants speed `v0`, with `gap` metres
/// to something moving at `lead_v`. An infinite gap means an open road.
pub fn acceleration(model: FollowModel, d: &Driver, v: f64, v0: f64, gap: f64, lead_v: f64) -> f64 {
    let a = match model {
        FollowModel::Idm => idm(d, v, v0, gap, lead_v),
        FollowModel::Sigmoid => sigmoid(d, v, v0, gap, lead_v),
    };
    a.max(-MAX_BRAKE)
}

/// a = a_max [1 - (v/v0)^4 - (s*/s)^2],  s* = s0 + v T + v dv / (2 sqrt(a b)).
fn idm(d: &Driver, v: f64, v0: f64, gap: f64, lead_v: f64) -> f64 {
    let ratio = v / v0.max(0.1);
    let free = 1.0 - ratio * ratio * ratio * ratio;
    if gap == f64::INFINITY {
        return d.accel * free;
    }
    let closing = v * (v - lead_v) / (2.0 * (d.accel * d.brake).sqrt());
    let wanted = d.stand_gap + (v * d.headway + closing).max(0.0);
    let s = gap.max(0.05);
    d.accel * (free - (wanted / s) * (wanted / s))
}

/// Steepness of the sigmoid when accelerating and when braking, per metre.
const SIGMOID_K_ACCEL: f64 = 0.5;
const SIGMOID_K_BRAKE: f64 = 0.6;
/// Braking the sigmoid driver plans for when closing in on something slower.
const SIGMOID_PLANNED_BRAKE: f64 = 3.0;

/// x = gap - wanted gap;  a = limit (2 / (1 + e^(-k x)) - 1).
///
/// The rule has no term for the open road, so the wanted speed is enforced
/// separately: full throttle below it, none at it, braking above it.
fn sigmoid(d: &Driver, v: f64, v0: f64, gap: f64, lead_v: f64) -> f64 {
    let cap = if v > v0 + 0.5 {
        -d.brake
    } else if v >= v0 {
        0.0
    } else {
        d.accel
    };
    if gap == f64::INFINITY {
        return cap;
    }
    let closing = (v * v - lead_v * lead_v).max(0.0) / (2.0 * SIGMOID_PLANNED_BRAKE);
    let x = gap - (d.stand_gap + d.headway * v + closing);
    let (limit, k) = if x >= 0.0 {
        (d.accel, SIGMOID_K_ACCEL)
    } else {
        (MAX_BRAKE, SIGMOID_K_BRAKE)
    };
    (limit * (2.0 / (1.0 + exp(-k * x)) - 1.0)).min(cap)
}
