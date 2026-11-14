//! A scenario: the drawn map, the demand and the control settings, as plain text.
//!
//! ```text
//! traffic-scenario 1
//! controller max-pressure     # default for every signalised junction
//! follow idm                  # or: sigmoid
//! demand 900                  # trips per hour, shared out between houses
//! reroute 30                  # seconds a blocked driver waits before trying another way; 0 = never
//! param fixed.green 25        # controller settings
//! house 4,0 2                 # column,row and a weight (default 1)
//! flow 4,0 16,12 120          # an extra origin-destination flow, trips per hour
//! junction 10,6 actuated      # one junction's controller; `none` removes its signal
//! map
//! ....H....
//! ```

use crate::control::{Params, CONTROLLERS};
use crate::follow::FollowModel;
use crate::grid::{Cell, Grid};
use std::collections::BTreeMap;

pub const HEADER: &str = "traffic-scenario 1";

#[derive(Clone, Debug, PartialEq)]
pub struct Scenario {
    pub grid: Grid,
    pub controller: String,
    pub follow: FollowModel,
    /// Trips per hour, split between pairs of houses in proportion to their weights.
    pub demand: f64,
    pub reroute_after: f64,
    pub params: Params,
    /// Weight of a house by cell; houses not listed weigh 1.
    pub weights: BTreeMap<usize, f64>,
    /// Extra flows: (origin cell, destination cell, trips per hour).
    pub flows: Vec<(usize, usize, f64)>,
    /// Per-junction choice by cell: a controller id, or `none` for no signal.
    pub junctions: BTreeMap<usize, String>,
}

impl Scenario {
    pub fn new(grid: Grid) -> Self {
        Self {
            grid,
            controller: "fixed".into(),
            follow: FollowModel::Idm,
            demand: 600.0,
            reroute_after: 30.0,
            params: Params::new(),
            weights: BTreeMap::new(),
            flows: vec![],
            junctions: BTreeMap::new(),
        }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let lines: Vec<&str> = text
            .lines()
            .map(|l| l.split('#').next().unwrap_or("").trim_end())
            .collect();
        // Inside the map `#` is a road, so take the map from the raw text.
        let map_at = lines
            .iter()
            .position(|l| l.trim() == "map")
            .ok_or("the scenario has no `map` section")?;
        let raw: Vec<&str> = text.lines().skip(map_at + 1).collect();
        let mut sc = Scenario::new(Grid::parse(&raw)?);
        let mut seen_header = false;
        for (n, line) in lines[..map_at].iter().enumerate() {
            let words: Vec<&str> = line.split_whitespace().collect();
            let bad = |what: &str| format!("line {}: {what}", n + 1);
            let number = |w: &str| {
                w.parse::<f64>()
                    .ok()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .ok_or_else(|| bad("expected a number that is not negative"))
            };
            let cell = |w: &str| -> Result<usize, String> {
                let (c, r) = w
                    .split_once(',')
                    .ok_or_else(|| bad("expected column,row"))?;
                match (c.parse::<usize>(), r.parse::<usize>()) {
                    (Ok(c), Ok(r)) if c < sc.grid.cols && r < sc.grid.rows => {
                        Ok(sc.grid.index(c, r))
                    }
                    _ => Err(bad("that cell is outside the map")),
                }
            };
            match words.as_slice() {
                [] => {}
                ["traffic-scenario", "1"] => seen_header = true,
                ["controller", id] => {
                    known_controller(id).ok_or_else(|| bad("unknown controller"))?;
                    sc.controller = (*id).into();
                }
                ["follow", name] => {
                    sc.follow = FollowModel::parse(name)
                        .ok_or_else(|| bad("expected `idm` or `sigmoid`"))?;
                }
                ["demand", v] => sc.demand = number(v)?,
                ["reroute", v] => sc.reroute_after = number(v)?,
                ["param", key, v] => {
                    let v = number(v)?;
                    sc.params.insert((*key).into(), v);
                }
                ["house", at, w] => {
                    let (at, w) = (cell(at)?, number(w)?);
                    sc.weights.insert(at, w);
                }
                ["flow", from, to, v] => {
                    let flow = (cell(from)?, cell(to)?, number(v)?);
                    sc.flows.push(flow);
                }
                ["junction", at, id] => {
                    if *id != "none" {
                        known_controller(id).ok_or_else(|| bad("unknown controller"))?;
                    }
                    let at = cell(at)?;
                    sc.junctions.insert(at, (*id).into());
                }
                _ => return Err(bad("not understood")),
            }
        }
        if !seen_header {
            return Err(format!("the first line must be `{HEADER}`"));
        }
        Ok(sc)
    }

    pub fn format(&self) -> String {
        let at = |cell: usize| {
            let (c, r) = self.grid.col_row(cell);
            format!("{c},{r}")
        };
        let mut out = format!(
            "{HEADER}\ncontroller {}\nfollow {}\ndemand {}\nreroute {}\n",
            self.controller,
            self.follow.name(),
            self.demand,
            self.reroute_after
        );
        for (key, v) in &self.params {
            out += &format!("param {key} {v}\n");
        }
        for (&cell, w) in &self.weights {
            if self.grid.cells[cell] == Cell::House && *w != 1.0 {
                out += &format!("house {} {w}\n", at(cell));
            }
        }
        for &(from, to, v) in &self.flows {
            out += &format!("flow {} {} {v}\n", at(from), at(to));
        }
        for (&cell, id) in &self.junctions {
            out += &format!("junction {} {id}\n", at(cell));
        }
        out + "map\n" + &self.grid.format()
    }
}

fn known_controller(id: &str) -> Option<()> {
    CONTROLLERS.iter().any(|c| c.id == id).then_some(())
}

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub text: &'static str,
}

/// Built-in scenarios.
pub const PRESETS: &[Preset] = &[
    Preset {
        id: "town",
        label: "Town",
        text: include_str!("../presets/town.txt"),
    },
    Preset {
        id: "grid",
        label: "Grid",
        text: include_str!("../presets/grid.txt"),
    },
    Preset {
        id: "arterial",
        label: "Arterial",
        text: include_str!("../presets/arterial.txt"),
    },
    Preset {
        id: "cross",
        label: "Crossroads",
        text: include_str!("../presets/cross.txt"),
    },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}
