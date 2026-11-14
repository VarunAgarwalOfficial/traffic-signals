//! The road network the simulation runs on: directed lanes joined at junctions.
//!
//! A drawn grid is compiled into this form. Runs of road cells become one road
//! with a lane in each direction; cells where roads meet or end become nodes.
//! Cars drive on the left.

use crate::grid::{Cell, Grid};

/// Side of one grid cell in metres.
pub const CELL: f64 = 16.0;
/// Distance of a lane's centre from the middle of the road.
pub const LANE_OFFSET: f64 = 1.75;
/// Half the side of a junction box: lanes stop this far from the node centre.
pub const BOX_HALF: f64 = 4.5;
/// Radius used to round a bend in a road.
const BEND_RADIUS: f64 = 5.0;
/// Speed limit on lanes, m/s (50 km/h).
pub const LANE_SPEED: f64 = 13.9;
/// Speed through a turn inside a junction, m/s.
pub const TURN_SPEED: f64 = 6.5;
/// Two paths through a junction conflict where they come closer than this.
const CONFLICT_DISTANCE: f64 = 2.3;
/// Road space one queued car takes: its length plus the standing gap.
pub const SLOT: f64 = 6.5;

pub type Point = (f64, f64);

/// A path made of straight pieces, with distances measured along it.
#[derive(Clone, Debug)]
pub struct Path {
    pub pts: Vec<Point>,
    /// Distance from the start to each point.
    pub cum: Vec<f64>,
}

impl Path {
    pub fn new(pts: Vec<Point>) -> Self {
        let mut cum = Vec::with_capacity(pts.len());
        let mut total = 0.0;
        for (i, p) in pts.iter().enumerate() {
            if i > 0 {
                total += dist(pts[i - 1], *p);
            }
            cum.push(total);
        }
        Self { pts, cum }
    }

    pub fn length(&self) -> f64 {
        *self.cum.last().unwrap_or(&0.0)
    }

    /// Position and unit heading at distance `s`, clamped to the path.
    pub fn pose(&self, s: f64) -> (Point, Point) {
        let n = self.pts.len();
        if n < 2 {
            return (self.pts.first().copied().unwrap_or((0.0, 0.0)), (1.0, 0.0));
        }
        let mut i = match self.cum.binary_search_by(|c| c.total_cmp(&s)) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        };
        i = i.min(n - 2);
        let (a, b) = (self.pts[i], self.pts[i + 1]);
        let seg = self.cum[i + 1] - self.cum[i];
        let t = if seg > 0.0 {
            ((s - self.cum[i]) / seg).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let heading = unit((b.0 - a.0, b.1 - a.1));
        ((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t), heading)
    }

    /// Distance along the path of the point closest to `p`, and how far away it is.
    pub fn project(&self, p: Point) -> (f64, f64) {
        let mut best = (0.0, f64::INFINITY);
        for i in 0..self.pts.len().saturating_sub(1) {
            let (a, b) = (self.pts[i], self.pts[i + 1]);
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 {
                (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let q = (a.0 + dx * t, a.1 + dy * t);
            let d = dist(p, q);
            if d < best.1 {
                best = (self.cum[i] + t * len2.sqrt(), d);
            }
        }
        best
    }
}

pub fn dist(a: Point, b: Point) -> f64 {
    ((a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1)).sqrt()
}

fn unit(v: Point) -> Point {
    let len = (v.0 * v.0 + v.1 * v.1).sqrt();
    if len > 0.0 {
        (v.0 / len, v.1 / len)
    } else {
        (1.0, 0.0)
    }
}

/// Left of a heading, in screen coordinates (y grows downwards).
fn left_of(h: Point) -> Point {
    (h.1, -h.0)
}

#[derive(Clone, Debug)]
pub struct Lane {
    pub from: usize,
    pub to: usize,
    pub path: Path,
    pub length: f64,
    /// The lane of the same road in the other direction.
    pub twin: usize,
    pub speed: f64,
    /// Movements that start at the end of this lane.
    pub movements: Vec<usize>,
    /// Queued cars the lane can hold.
    pub capacity: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Turn {
    Straight,
    /// Towards the near side (left, when driving on the left): crosses no opposing lane.
    Near,
    /// Across the oncoming lane (right, when driving on the left).
    Cross,
}

/// Where two movements through one junction get in each other's way.
#[derive(Clone, Copy, Debug)]
pub struct Conflict {
    pub other: usize,
    /// The stretch of this movement's path that is shared, as distances along it.
    pub own_enter: f64,
    pub own_exit: f64,
    /// The same stretch along the other movement's path.
    pub other_enter: f64,
    pub other_exit: f64,
    /// Both movements end in the same lane.
    pub merge: bool,
}

/// One way through a junction: from the end of a lane to the start of another.
#[derive(Clone, Debug)]
pub struct Movement {
    pub node: usize,
    pub from: usize,
    pub to: usize,
    pub path: Path,
    pub length: f64,
    pub turn: Turn,
    pub speed: f64,
    pub conflicts: Vec<Conflict>,
}

#[derive(Clone, Debug)]
pub struct Node {
    /// Grid cell the node sits on.
    pub cell: usize,
    pub pos: Point,
    pub incoming: Vec<usize>,
    pub outgoing: Vec<usize>,
    /// Groups of incoming lanes that may have green together (north-south, east-west).
    pub phases: Vec<Vec<usize>>,
}

impl Node {
    /// Three or more approaches on two axes: the junction can carry a signal.
    pub fn can_signal(&self) -> bool {
        self.incoming.len() >= 3 && self.phases.len() >= 2
    }
}

/// A place trips start and end, attached to the two lanes of the road next to it.
#[derive(Clone, Debug)]
pub struct House {
    pub cell: usize,
    pub pos: Point,
    /// (lane, distance along it) for each direction of the road, empty if no road is next to it.
    pub access: Vec<(usize, f64)>,
}

#[derive(Clone, Debug, Default)]
pub struct Network {
    pub nodes: Vec<Node>,
    pub lanes: Vec<Lane>,
    pub movements: Vec<Movement>,
    pub houses: Vec<House>,
}

fn cell_centre(grid: &Grid, cell: usize) -> Point {
    let (c, r) = grid.col_row(cell);
    ((c as f64 + 0.5) * CELL, (r as f64 + 0.5) * CELL)
}

impl Network {
    /// The movement from one lane into another, if the junction allows it.
    pub fn movement_between(&self, from: usize, to: usize) -> Option<usize> {
        self.lanes[from]
            .movements
            .iter()
            .copied()
            .find(|&m| self.movements[m].to == to)
    }

    /// Compile a drawn grid.
    pub fn from_grid(grid: &Grid) -> Self {
        let mut net = Network::default();
        let n = grid.cells.len();
        let mut node_of = vec![usize::MAX; n];
        let mut covered = vec![false; n];
        let add_node = |net: &mut Network, node_of: &mut Vec<usize>, cell: usize| {
            node_of[cell] = net.nodes.len();
            net.nodes.push(Node {
                cell,
                pos: cell_centre(grid, cell),
                incoming: vec![],
                outgoing: vec![],
                phases: vec![],
            });
        };
        for cell in 0..n {
            if grid.is_road(cell) && grid.road_degree(cell) != 2 {
                add_node(&mut net, &mut node_of, cell);
                covered[cell] = true;
            }
        }

        // Follow every road out of every node until it reaches the next node.
        let mut walked = vec![[false; 4]; n];
        let mut chains: Vec<Vec<usize>> = Vec::new();
        let trace = |start: usize,
                     dir: usize,
                     node_of: &Vec<usize>,
                     covered: &mut Vec<bool>,
                     walked: &mut Vec<[bool; 4]>| {
            let mut chain = vec![start];
            let (mut cur, mut d) = (start, dir);
            loop {
                walked[cur][d] = true;
                let Some(next) = grid.road_neighbour(cur, d) else {
                    break;
                };
                walked[next][(d + 2) % 4] = true;
                covered[next] = true;
                chain.push(next);
                if node_of[next] != usize::MAX {
                    break;
                }
                let back = (d + 2) % 4;
                let Some(onward) =
                    (0..4).find(|&k| k != back && grid.road_neighbour(next, k).is_some())
                else {
                    break;
                };
                cur = next;
                d = onward;
            }
            chain
        };
        for cell in 0..n {
            if node_of[cell] == usize::MAX {
                continue;
            }
            for dir in 0..4 {
                if grid.road_neighbour(cell, dir).is_some() && !walked[cell][dir] {
                    let chain = trace(cell, dir, &node_of, &mut covered, &mut walked);
                    chains.push(chain);
                }
            }
        }
        // What is left are closed rings with no junction: give each one node.
        for cell in 0..n {
            if grid.is_road(cell) && !covered[cell] {
                add_node(&mut net, &mut node_of, cell);
                covered[cell] = true;
                let dir = (0..4)
                    .find(|&d| grid.road_neighbour(cell, d).is_some())
                    .unwrap_or(0);
                let chain = trace(cell, dir, &node_of, &mut covered, &mut walked);
                chains.push(chain);
            }
        }

        for chain in &chains {
            let (first, last) = (chain[0], chain[chain.len() - 1]);
            if chain.len() < 2 || node_of[last] == usize::MAX {
                continue;
            }
            let centre = centreline(grid, chain);
            let (a, b) = (node_of[first], node_of[last]);
            let forward = net.lanes.len();
            for (from, to, pts) in [
                (a, b, offset_left(&centre)),
                (
                    b,
                    a,
                    offset_left(&centre.iter().rev().copied().collect::<Vec<_>>()),
                ),
            ] {
                let id = net.lanes.len();
                let path = Path::new(pts);
                let length = path.length();
                net.lanes.push(Lane {
                    from,
                    to,
                    length,
                    path,
                    twin: if id == forward { forward + 1 } else { forward },
                    speed: LANE_SPEED,
                    movements: vec![],
                    capacity: ((length / SLOT) as u32).max(1),
                });
                net.nodes[from].outgoing.push(id);
                net.nodes[to].incoming.push(id);
            }
        }

        net.build_movements();
        net.build_phases();
        net.attach_houses(grid);
        net
    }

    fn build_movements(&mut self) {
        for node in 0..self.nodes.len() {
            let first = self.movements.len();
            for &from in &self.nodes[node].incoming {
                for &to in &self.nodes[node].outgoing {
                    if to == self.lanes[from].twin {
                        continue;
                    }
                    let a = &self.lanes[from].path;
                    let b = &self.lanes[to].path;
                    let (p0, h0) = a.pose(a.length());
                    let (p2, h2) = b.pose(0.0);
                    let dot = h0.0 * h2.0 + h0.1 * h2.1;
                    let cross = h0.0 * h2.1 - h0.1 * h2.0;
                    let turn = if dot > 0.7 {
                        Turn::Straight
                    } else if cross < 0.0 {
                        Turn::Near
                    } else {
                        Turn::Cross
                    };
                    let pts = if turn == Turn::Straight || cross.abs() < 1e-6 {
                        vec![p0, p2]
                    } else {
                        // The corner where the two lane lines meet steers a smooth curve.
                        let t = ((p2.0 - p0.0) * h2.1 - (p2.1 - p0.1) * h2.0) / cross;
                        let corner = (p0.0 + h0.0 * t, p0.1 + h0.1 * t);
                        (0..=10)
                            .map(|i| {
                                let t = i as f64 / 10.0;
                                let u = 1.0 - t;
                                (
                                    u * u * p0.0 + 2.0 * u * t * corner.0 + t * t * p2.0,
                                    u * u * p0.1 + 2.0 * u * t * corner.1 + t * t * p2.1,
                                )
                            })
                            .collect()
                    };
                    let path = Path::new(pts);
                    let id = self.movements.len();
                    self.lanes[from].movements.push(id);
                    self.movements.push(Movement {
                        node,
                        from,
                        to,
                        length: path.length(),
                        path,
                        turn,
                        speed: if turn == Turn::Straight {
                            self.lanes[from].speed.min(self.lanes[to].speed)
                        } else {
                            TURN_SPEED
                        },
                        conflicts: vec![],
                    });
                }
            }
            for i in first..self.movements.len() {
                for j in i + 1..self.movements.len() {
                    if self.movements[i].from == self.movements[j].from {
                        continue;
                    }
                    let merge = self.movements[i].to == self.movements[j].to;
                    let (pi, pj) = (&self.movements[i].path, &self.movements[j].path);
                    let (Some((ie, ix)), Some((je, jx))) = (shared(pi, pj), shared(pj, pi)) else {
                        continue;
                    };
                    let (ilen, jlen) = (pi.length(), pj.length());
                    self.movements[i].conflicts.push(Conflict {
                        other: j,
                        own_enter: ie,
                        own_exit: if merge { ilen } else { ix },
                        other_enter: je,
                        other_exit: if merge { jlen } else { jx },
                        merge,
                    });
                    self.movements[j].conflicts.push(Conflict {
                        other: i,
                        own_enter: je,
                        own_exit: if merge { jlen } else { jx },
                        other_enter: ie,
                        other_exit: if merge { ilen } else { ix },
                        merge,
                    });
                }
            }
        }
    }

    fn build_phases(&mut self) {
        for node in &mut self.nodes {
            let mut groups: [Vec<usize>; 2] = [vec![], vec![]];
            for &lane in &node.incoming {
                let path = &self.lanes[lane].path;
                let (_, h) = path.pose(path.length());
                groups[usize::from(h.0.abs() > h.1.abs())].push(lane);
            }
            node.phases = groups.into_iter().filter(|g| !g.is_empty()).collect();
        }
    }

    fn attach_houses(&mut self, grid: &Grid) {
        for cell in 0..grid.cells.len() {
            if grid.cells[cell] != Cell::House {
                continue;
            }
            // Prefer a plain stretch of road over a junction cell.
            let roads: Vec<usize> = (0..4)
                .filter_map(|d| grid.road_neighbour(cell, d))
                .collect();
            let door = roads
                .iter()
                .copied()
                .find(|&r| grid.road_degree(r) <= 2)
                .or(roads.first().copied());
            let mut access = Vec::new();
            if let Some(door) = door {
                let p = cell_centre(grid, door);
                let nearest = (0..self.lanes.len())
                    .map(|l| (self.lanes[l].path.project(p).1, l))
                    .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                if let Some((_, lane)) = nearest {
                    for l in [lane, self.lanes[lane].twin] {
                        let len = self.lanes[l].length;
                        let s = self.lanes[l].path.project(p).0;
                        let lo = (SLOT - 1.0).min(len / 2.0);
                        access.push((l, s.clamp(lo, (len - 1.0).max(lo))));
                    }
                }
            }
            self.houses.push(House {
                cell,
                pos: cell_centre(grid, cell),
                access,
            });
        }
    }
}

/// The middle of the road along a chain of cells, pulled back from junction
/// boxes at its ends and rounded at bends.
fn centreline(grid: &Grid, chain: &[usize]) -> Vec<Point> {
    let raw: Vec<Point> = chain.iter().map(|&c| cell_centre(grid, c)).collect();
    let last = raw.len() - 1;
    let mut pts = Vec::new();
    for i in 0..raw.len() {
        let p = raw[i];
        if i == 0 || i == last {
            let towards = if i == 0 { raw[1] } else { raw[last - 1] };
            let h = unit((towards.0 - p.0, towards.1 - p.1));
            let cut = if grid.road_degree(chain[i]) >= 2 {
                BOX_HALF
            } else {
                0.0
            };
            pts.push((p.0 + h.0 * cut, p.1 + h.1 * cut));
            continue;
        }
        let h_in = unit((p.0 - raw[i - 1].0, p.1 - raw[i - 1].1));
        let h_out = unit((raw[i + 1].0 - p.0, raw[i + 1].1 - p.1));
        if (h_in.0 * h_out.0 + h_in.1 * h_out.1) > 0.99 {
            continue;
        }
        let a = (p.0 - h_in.0 * BEND_RADIUS, p.1 - h_in.1 * BEND_RADIUS);
        let b = (p.0 + h_out.0 * BEND_RADIUS, p.1 + h_out.1 * BEND_RADIUS);
        for k in 0..=6 {
            let t = k as f64 / 6.0;
            let u = 1.0 - t;
            pts.push((
                u * u * a.0 + 2.0 * u * t * p.0 + t * t * b.0,
                u * u * a.1 + 2.0 * u * t * p.1 + t * t * b.1,
            ));
        }
    }
    pts
}

/// The path shifted to the left of its direction of travel by the lane offset.
fn offset_left(pts: &[Point]) -> Vec<Point> {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let before = if i > 0 {
                unit((pts[i].0 - pts[i - 1].0, pts[i].1 - pts[i - 1].1))
            } else {
                unit((pts[1].0 - pts[0].0, pts[1].1 - pts[0].1))
            };
            let after = if i + 1 < n {
                unit((pts[i + 1].0 - pts[i].0, pts[i + 1].1 - pts[i].1))
            } else {
                before
            };
            let (n0, n1) = (left_of(before), left_of(after));
            let mid = unit((n0.0 + n1.0, n0.1 + n1.1));
            let scale = LANE_OFFSET / (mid.0 * n0.0 + mid.1 * n0.1).max(0.5);
            (pts[i].0 + mid.0 * scale, pts[i].1 + mid.1 * scale)
        })
        .collect()
}

/// The stretch of `a` (as distances along it) that comes close to `b`.
fn shared(a: &Path, b: &Path) -> Option<(f64, f64)> {
    const STEP: f64 = 0.25;
    let sample = |p: &Path| -> Vec<Point> {
        let n = (p.length() / STEP).ceil().max(1.0) as usize;
        (0..=n)
            .map(|i| p.pose(p.length() * i as f64 / n as f64).0)
            .collect()
    };
    let (sa, sb) = (sample(a), sample(b));
    let step = a.length() / (sa.len() - 1) as f64;
    let mut range: Option<(f64, f64)> = None;
    for (i, p) in sa.iter().enumerate() {
        if sb.iter().any(|q| dist(*p, *q) < CONFLICT_DISTANCE) {
            let d = i as f64 * step;
            range = Some(range.map_or((d, d), |(lo, _)| (lo, d)));
        }
    }
    range
}
