//! Routing with A* over lanes, by travel time at the speed limit.

use crate::network::{dist, Network, Point, LANE_SPEED};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    /// Lanes in driving order.
    pub lanes: Vec<usize>,
    /// Where on the first lane the trip starts and where on the last it ends.
    pub start_s: f64,
    pub end_s: f64,
    /// Seconds the trip takes alone on the road.
    pub time: f64,
}

struct Open {
    f: f64,
    g: f64,
    /// Search state: lane * 2, plus 1 for a start part-way along the lane.
    state: usize,
    order: u32,
}

impl PartialEq for Open {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Open {}
impl PartialOrd for Open {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Open {
    /// Smallest f first; ties go to the entry pushed first, so the search is repeatable.
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .f
            .total_cmp(&self.f)
            .then(other.order.cmp(&self.order))
    }
}

/// Fastest route from any of `starts` to any of `goals`, each a (lane, distance) pair.
/// `banned` forbids one movement, given as (from lane, to lane).
pub fn find_route(
    net: &Network,
    starts: &[(usize, f64)],
    goals: &[(usize, f64)],
    banned: Option<(usize, usize)>,
) -> Option<Route> {
    const GOAL: usize = usize::MAX;
    let goal_points: Vec<Point> = goals
        .iter()
        .map(|&(l, s)| net.lanes[l].path.pose(s).0)
        .collect();
    // Straight-line time to the nearest goal never overestimates the drive.
    let h = |p: Point| {
        goal_points
            .iter()
            .map(|&q| dist(p, q) / LANE_SPEED)
            .fold(f64::INFINITY, f64::min)
    };
    let states = net.lanes.len() * 2;
    let mut best = vec![f64::INFINITY; states];
    let mut entered_at = vec![0.0; states];
    let mut parent = vec![usize::MAX; states];
    let mut done = vec![false; states];
    let mut heap = BinaryHeap::new();
    let mut order = 0;
    let mut push = |heap: &mut BinaryHeap<Open>, f: f64, g: f64, state: usize| {
        heap.push(Open { f, g, state, order });
        order += 1;
    };
    for &(lane, s) in starts {
        let state = lane * 2 + 1;
        best[state] = 0.0;
        entered_at[state] = s;
        push(&mut heap, h(net.lanes[lane].path.pose(s).0), 0.0, state);
    }
    let mut goal: Option<(f64, usize, f64)> = None;
    while let Some(Open { g, state, .. }) = heap.pop() {
        if state == GOAL {
            break;
        }
        if done[state] {
            continue;
        }
        done[state] = true;
        let lane = state / 2;
        let s_in = entered_at[state];
        let l = &net.lanes[lane];
        for &(goal_lane, goal_s) in goals {
            if goal_lane == lane && goal_s > s_in {
                let total = g + (goal_s - s_in) / l.speed;
                if goal.is_none_or(|(t, _, _)| total < t) {
                    goal = Some((total, state, goal_s));
                    push(&mut heap, total, total, GOAL);
                }
            }
        }
        let at_end = g + (l.length - s_in) / l.speed;
        for &m in &l.movements {
            let mv = &net.movements[m];
            if banned == Some((lane, mv.to)) {
                continue;
            }
            let next = mv.to * 2;
            let g2 = at_end + mv.length / mv.speed;
            if g2 < best[next] {
                best[next] = g2;
                parent[next] = state;
                push(
                    &mut heap,
                    g2 + h(net.lanes[mv.to].path.pose(0.0).0),
                    g2,
                    next,
                );
            }
        }
    }
    let (time, mut state, end_s) = goal?;
    let mut lanes = vec![state / 2];
    while parent[state] != usize::MAX {
        state = parent[state];
        lanes.push(state / 2);
    }
    lanes.reverse();
    Some(Route {
        lanes,
        start_s: entered_at[state],
        end_s,
        time,
    })
}
