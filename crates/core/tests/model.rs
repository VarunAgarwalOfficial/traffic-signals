//! The checks that matter: routes are shortest, runs repeat, cars never overlap
//! or run a red light, turning traffic gets through, and a jammed town empties.

use traffic_core::follow::{acceleration, Driver, FollowModel};
use traffic_core::grid::{Cell, Grid};
use traffic_core::metrics::{estimate, measure, run};
use traffic_core::network::Network;
use traffic_core::rng::Rng;
use traffic_core::route::find_route;
use traffic_core::scenario::{preset, Scenario};
use traffic_core::sim::Sim;

fn scenario(id: &str) -> Scenario {
    Scenario::parse(preset(id).expect("preset exists").text).expect("preset parses")
}

fn run_for(sim: &mut Sim, seconds: f64) {
    for _ in 0..(seconds * 10.0) as usize {
        sim.step();
    }
}

/// Fastest time between two houses by relaxing every lane until nothing improves.
fn slow_but_sure(net: &Network, from: usize, to: usize) -> Option<f64> {
    let mut at_start = vec![f64::INFINITY; net.lanes.len()];
    let mut best = f64::INFINITY;
    for &(lane, s) in &net.houses[from].access {
        let l = &net.lanes[lane];
        for &(goal, goal_s) in &net.houses[to].access {
            if goal == lane && goal_s > s {
                best = best.min((goal_s - s) / l.speed);
            }
        }
        for &m in &l.movements {
            let mv = &net.movements[m];
            let t = (l.length - s) / l.speed + mv.length / mv.speed;
            at_start[mv.to] = at_start[mv.to].min(t);
        }
    }
    for _ in 0..net.lanes.len() {
        for lane in 0..net.lanes.len() {
            let l = &net.lanes[lane];
            for &m in &l.movements {
                let mv = &net.movements[m];
                let t = at_start[lane] + l.length / l.speed + mv.length / mv.speed;
                at_start[mv.to] = at_start[mv.to].min(t);
            }
        }
    }
    for &(goal, goal_s) in &net.houses[to].access {
        best = best.min(at_start[goal] + goal_s / net.lanes[goal].speed);
    }
    best.is_finite().then_some(best)
}

#[test]
fn a_star_finds_the_fastest_route_between_every_pair_of_houses() {
    for id in ["town", "arterial"] {
        let net = Network::from_grid(&scenario(id).grid);
        for from in 0..net.houses.len() {
            for to in 0..net.houses.len() {
                if from == to {
                    continue;
                }
                let route =
                    find_route(&net, &net.houses[from].access, &net.houses[to].access, None);
                let expected = slow_but_sure(&net, from, to);
                match (route, expected) {
                    (Some(r), Some(t)) => {
                        assert!(
                            (r.time - t).abs() < 1e-6,
                            "{id} {from}->{to}: {} vs {t}",
                            r.time
                        );
                        for pair in r.lanes.windows(2) {
                            assert!(net.movement_between(pair[0], pair[1]).is_some());
                        }
                    }
                    (None, None) => {}
                    (r, t) => panic!("{id} {from}->{to}: {r:?} vs {t:?}"),
                }
            }
        }
    }
}

#[test]
fn the_same_seed_gives_the_same_run_and_scenarios_survive_a_round_trip() {
    let mut sc = scenario("town");
    sc.controller = "max-pressure".into();
    sc.demand = 2500.0;
    assert_eq!(Scenario::parse(&sc.format()).expect("round trip"), sc);
    let a = run(&sc, 7, 400.0, 100.0);
    let b = run(&sc, 7, 400.0, 100.0);
    assert_eq!(a.values(), b.values());
    assert!(a.finished > 100);
    let other = run(&sc, 8, 400.0, 100.0);
    assert_ne!(a.values(), other.values());
}

#[test]
fn heavy_traffic_never_overlaps_runs_a_red_light_or_needs_force() {
    for (follow, controller) in [
        (FollowModel::Idm, "fixed"),
        (FollowModel::Idm, "sotl"),
        (FollowModel::Sigmoid, "max-pressure"),
    ] {
        let mut sc = scenario("town");
        sc.follow = follow;
        sc.controller = controller.into();
        sc.demand = 4500.0;
        // One junction without a signal, so give-way rules are exercised too.
        let middle = sc.grid.index(10, 6);
        sc.junctions.insert(middle, "none".into());
        let m = run(&sc, 3, 900.0, 0.0);
        assert!(
            m.finished > 400,
            "{controller}: only {} trips finished",
            m.finished
        );
        assert_eq!(
            (m.overlaps, m.red_runs, m.hard_brakes),
            (0, 0, 0),
            "{controller} with {follow:?}"
        );
    }
}

#[test]
fn cars_turning_across_oncoming_traffic_wait_for_a_gap_and_still_get_through() {
    // Steady straight-through flows both ways, plus turners who must cross them.
    // A waiting turner holds up the cars behind it, so this is a hard case.
    let mut sc = scenario("cross");
    sc.demand = 0.0;
    let (n, s, e) = (
        sc.grid.index(6, 0),
        sc.grid.index(6, 12),
        sc.grid.index(12, 6),
    );
    let w = sc.grid.index(0, 6);
    sc.flows = vec![(n, s, 450.0), (s, n, 450.0), (n, w, 150.0), (s, e, 150.0)];
    for (controller, at_least) in [("fixed", 450.0), ("none", 900.0)] {
        sc.junctions.insert(sc.grid.index(6, 6), controller.into());
        let mut sim = Sim::new(&sc, 1);
        sim.check_overlaps(true);
        run_for(&mut sim, 1200.0);
        let m = measure(&sim, 1);
        assert_eq!((m.overlaps, m.hard_brakes), (0, 0), "{controller}");
        assert!(
            m.throughput > at_least,
            "{controller}: {} trips an hour",
            m.throughput
        );
    }
}

#[test]
fn a_jammed_town_empties_once_the_demand_stops() {
    for (controller, reroute) in [("fixed", 30.0), ("capacity-aware", 30.0)] {
        let mut sc = scenario("town");
        sc.controller = controller.into();
        sc.demand = 7000.0;
        sc.reroute_after = reroute;
        let mut sim = Sim::new(&sc, 2);
        run_for(&mut sim, 900.0);
        assert!(
            sim.active() + sim.backlog() > 500,
            "the town should be jammed"
        );
        sim.set_demand(0.0);
        run_for(&mut sim, 3600.0);
        assert_eq!(
            (sim.active(), sim.backlog()),
            (0, 0),
            "{controller}, reroute {reroute}: cars are stuck for good"
        );
    }
}

#[test]
fn any_drawing_runs_without_overlaps() {
    let mut rng = Rng::new(11);
    for _ in 0..60 {
        let mut grid = Grid::new(12, 9);
        for cell in grid.cells.iter_mut() {
            let roll = rng.unit();
            *cell = if roll < 0.5 {
                Cell::Road
            } else if roll < 0.62 {
                Cell::House
            } else {
                Cell::Empty
            };
        }
        let mut sc = Scenario::new(grid);
        sc.demand = 3000.0;
        sc.controller = "actuated".into();
        let mut sim = Sim::new(&sc, 5);
        sim.check_overlaps(true);
        run_for(&mut sim, 240.0);
        assert_eq!(sim.tally.overlaps, 0, "\n{}", sc.format());
    }
}

#[test]
fn both_following_rules_stop_behind_a_standing_car_and_cruise_on_an_open_road() {
    let d = Driver::from_roll(0.5);
    for model in [FollowModel::Idm, FollowModel::Sigmoid] {
        // Drive at a standing obstacle 200 m ahead.
        let (mut gap, mut v) = (200.0, 13.0);
        for _ in 0..600 {
            v = (v + acceleration(model, &d, v, 13.9, gap, 0.0) * 0.1_f64).max(0.0);
            gap -= v * 0.1;
        }
        assert!(
            v < 0.1 && gap > 0.5 && gap < 4.0,
            "{model:?}: v {v}, gap {gap}"
        );
        assert!(acceleration(model, &d, 5.0, 13.9, f64::INFINITY, 0.0) > 1.0);
        assert!(acceleration(model, &d, 13.9, 13.9, f64::INFINITY, 0.0).abs() < 0.1);
    }
    let e = estimate(&[1.0, 2.0, 3.0]);
    assert!((e.mean - 2.0).abs() < 1e-12 && (e.half_width - 4.303 / 3f64.sqrt()).abs() < 1e-9);
}
