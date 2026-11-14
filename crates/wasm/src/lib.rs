//! WebAssembly interface with a plain C ABI: numbers in, numbers out.
//!
//! Text goes in through memory from `tr_alloc`; text comes back through
//! `tr_text_ptr`/`tr_text_len`, and tables of numbers through `tr_buf_ptr`.
//! Both are overwritten by the next call that returns text or numbers.

use std::cell::RefCell;
use std::fmt::Write as _;
use traffic_core::control::CONTROLLERS;
use traffic_core::metrics::{measure, run, RunMetrics, METRIC_NAMES};
use traffic_core::network::CELL;
use traffic_core::scenario::{Scenario, PRESETS};
use traffic_core::sim::{Light, Sim, DT};

#[derive(Default)]
struct State {
    sims: Vec<Option<Sim>>,
    text: String,
    buf: Vec<f32>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// # Safety
/// `ptr` must come from `tr_alloc(len)` and hold `len` bytes.
unsafe fn read_text(ptr: *const u8, len: usize) -> String {
    String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).into_owned()
}

#[no_mangle]
pub extern "C" fn tr_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

/// # Safety
/// `ptr` must come from `tr_alloc(len)` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn tr_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn tr_text_ptr() -> *const u8 {
    with(|s| s.text.as_ptr())
}

#[no_mangle]
pub extern "C" fn tr_text_len() -> usize {
    with(|s| s.text.len())
}

#[no_mangle]
pub extern "C" fn tr_buf_ptr() -> *const f32 {
    with(|s| s.buf.as_ptr())
}

/// Controllers, presets and constants, as JSON text.
#[no_mangle]
pub extern "C" fn tr_info() {
    let controllers: Vec<String> = CONTROLLERS
        .iter()
        .map(|c| {
            format!(
                "{{\"id\":{},\"label\":{},\"summary\":{}}}",
                quote(c.id),
                quote(c.label),
                quote(c.summary)
            )
        })
        .collect();
    let presets: Vec<String> = PRESETS
        .iter()
        .map(|p| {
            format!(
                "{{\"id\":{},\"label\":{},\"text\":{}}}",
                quote(p.id),
                quote(p.label),
                quote(p.text)
            )
        })
        .collect();
    let metrics: Vec<String> = METRIC_NAMES.iter().map(|m| quote(m)).collect();
    with(|s| {
        s.text = format!(
            "{{\"cell\":{CELL},\"dt\":{DT},\"controllers\":[{}],\"presets\":[{}],\"metrics\":[{}]}}",
            controllers.join(","),
            presets.join(","),
            metrics.join(",")
        );
    });
}

/// Start a simulation from scenario text. Returns a handle, or -1 with the
/// reason as text.
///
/// # Safety
/// `ptr` must come from `tr_alloc(len)` and hold `len` bytes of UTF-8.
#[no_mangle]
pub unsafe extern "C" fn tr_sim_new(ptr: *const u8, len: usize, seed: f64) -> i32 {
    let text = read_text(ptr, len);
    with(|s| match Scenario::parse(&text) {
        Ok(scenario) => {
            let sim = Sim::new(&scenario, seed as u64);
            let slot = s.sims.iter().position(Option::is_none).unwrap_or_else(|| {
                s.sims.push(None);
                s.sims.len() - 1
            });
            s.sims[slot] = Some(sim);
            slot as i32
        }
        Err(e) => {
            s.text = e;
            -1
        }
    })
}

#[no_mangle]
pub extern "C" fn tr_sim_free(handle: i32) {
    with(|s| {
        if let Some(slot) = s.sims.get_mut(handle as usize) {
            *slot = None;
        }
    });
}

fn with_sim<R: Default>(
    handle: i32,
    f: impl FnOnce(&mut Sim, &mut String, &mut Vec<f32>) -> R,
) -> R {
    with(|s| {
        let State { sims, text, buf } = s;
        match sims.get_mut(handle as usize).and_then(Option::as_mut) {
            Some(sim) => f(sim, text, buf),
            None => R::default(),
        }
    })
}

/// What the compiled network looks like, as JSON text: junctions, stop lines, houses.
#[no_mangle]
pub extern "C" fn tr_sim_network(handle: i32) {
    with_sim(handle, |sim, text, _| {
        let net = &sim.net;
        let nodes: Vec<String> = net
            .nodes
            .iter()
            .enumerate()
            .map(|(n, node)| {
                format!(
                    "{{\"cell\":{},\"x\":{},\"y\":{},\"arms\":{},\"canSignal\":{},\"controller\":{}}}",
                    node.cell,
                    node.pos.0,
                    node.pos.1,
                    node.incoming.len(),
                    node.can_signal(),
                    sim.controller_at(n).map_or("null".into(), quote)
                )
            })
            .collect();
        let stops: Vec<String> = net
            .lanes
            .iter()
            .enumerate()
            .filter(|(_, l)| net.nodes[l.to].incoming.len() >= 2)
            .map(|(i, l)| {
                let (p, h) = l.path.pose(l.length);
                format!(
                    "{{\"lane\":{i},\"x\":{:.2},\"y\":{:.2},\"dx\":{:.3},\"dy\":{:.3}}}",
                    p.0, p.1, h.0, h.1
                )
            })
            .collect();
        let houses: Vec<String> = net
            .houses
            .iter()
            .map(|h| {
                format!(
                    "{{\"cell\":{},\"connected\":{}}}",
                    h.cell,
                    !h.access.is_empty()
                )
            })
            .collect();
        *text = format!(
            "{{\"lanes\":{},\"nodes\":[{}],\"stops\":[{}],\"houses\":[{}]}}",
            net.lanes.len(),
            nodes.join(","),
            stops.join(","),
            houses.join(",")
        );
    });
}

#[no_mangle]
pub extern "C" fn tr_sim_step(handle: i32, steps: u32) {
    with_sim(handle, |sim, _, _| {
        for _ in 0..steps {
            sim.step();
        }
    });
}

/// Fill the buffer with x, y, heading x, heading y, speed, acceleration, id per car.
/// Returns the number of cars.
#[no_mangle]
pub extern "C" fn tr_sim_cars(handle: i32) -> u32 {
    with_sim(handle, |sim, _, buf| {
        buf.clear();
        for c in sim.cars() {
            let (p, h) = sim.pose(c);
            buf.extend([p.0, p.1, h.0, h.1, c.v, c.a, f64::from(c.id)].map(|v| v as f32));
        }
        (buf.len() / 7) as u32
    })
}

/// Fill the buffer with one light per lane: 0 none, 1 green, 2 amber, 3 red.
#[no_mangle]
pub extern "C" fn tr_sim_lights(handle: i32) -> u32 {
    with_sim(handle, |sim, _, buf| {
        buf.clear();
        for lane in 0..sim.net.lanes.len() {
            buf.push(match sim.light(lane) {
                Light::None => 0.0,
                Light::Green => 1.0,
                Light::Amber => 2.0,
                Light::Red => 3.0,
            });
        }
        buf.len() as u32
    })
}

fn metrics_json(m: &RunMetrics) -> String {
    let fields: Vec<String> = METRIC_NAMES
        .iter()
        .zip(m.values())
        .map(|(name, v)| format!("\"{name}\":{}", if v.is_finite() { v } else { 0.0 }))
        .collect();
    format!(
        "{{\"seed\":{},\"demand\":{},{}}}",
        m.seed,
        m.demand,
        fields.join(",")
    )
}

/// Metrics so far, as JSON text, with the time, cars on the road and trips waiting.
#[no_mangle]
pub extern "C" fn tr_sim_stats(handle: i32) {
    with_sim(handle, |sim, text, _| {
        let m = measure(sim, 0);
        let queued = sim.tally.series.last().map_or(0, |s| s.queued);
        *text = format!(
            "{{\"time\":{:.1},\"active\":{},\"backlog\":{},\"queued\":{},\"metrics\":{}}}",
            sim.time,
            sim.active(),
            sim.backlog(),
            queued,
            metrics_json(&m)
        );
    });
}

/// Fill the buffer with the time series: time, trips finished, sum of their
/// delays, cars standing, trips waiting, per ten seconds. Returns the row count.
#[no_mangle]
pub extern "C" fn tr_sim_series(handle: i32) -> u32 {
    with_sim(handle, |sim, _, buf| {
        buf.clear();
        for s in &sim.tally.series {
            buf.extend([
                s.time as f32,
                s.arrived as f32,
                s.delay_sum as f32,
                s.queued as f32,
                s.backlog as f32,
            ]);
        }
        (buf.len() / 5) as u32
    })
}

/// # Safety
/// `ptr` must come from `tr_alloc(len)` and hold `len` bytes of UTF-8.
#[no_mangle]
pub unsafe extern "C" fn tr_sim_set_controller(handle: i32, ptr: *const u8, len: usize) -> i32 {
    let id = read_text(ptr, len);
    with_sim(handle, |sim, _, _| i32::from(sim.set_controller(&id)))
}

/// Measure only trips requested after `seconds` (the warm-up).
#[no_mangle]
pub extern "C" fn tr_sim_set_warmup(handle: i32, seconds: f64) {
    with_sim(handle, |sim, _, _| sim.tally.measure_from = seconds);
}

#[no_mangle]
pub extern "C" fn tr_sim_set_demand(handle: i32, per_hour: f64) {
    with_sim(handle, |sim, _, _| sim.set_demand(per_hour));
}

/// Run a whole scenario and return its metrics as JSON text. Returns 0, or -1
/// with the reason as text.
///
/// # Safety
/// `ptr` must come from `tr_alloc(len)` and hold `len` bytes of UTF-8.
#[no_mangle]
pub unsafe extern "C" fn tr_run(
    ptr: *const u8,
    len: usize,
    seed: f64,
    duration: f64,
    warmup: f64,
) -> i32 {
    let text = read_text(ptr, len);
    with(|s| match Scenario::parse(&text) {
        Ok(scenario) => {
            s.text = metrics_json(&run(&scenario, seed as u64, duration, warmup));
            0
        }
        Err(e) => {
            s.text = e;
            -1
        }
    })
}
