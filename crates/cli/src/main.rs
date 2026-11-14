//! Seeded experiments from the command line.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use traffic_core::control::CONTROLLERS;
use traffic_core::follow::FollowModel;
use traffic_core::metrics::{estimate, run, RunMetrics, METRIC_NAMES};
use traffic_core::scenario::{preset, Scenario, PRESETS};

const HELP: &str = "\
traffic: run a traffic scenario under one or more signal controllers

usage: traffic [options]

  --preset NAME        built-in scenario: town, grid, arterial, cross (default town)
  --file PATH          read a scenario file instead (same text the browser shares)
  --controller LIST    comma-separated controller ids, or `all` (default all)
  --demand LIST        trips per hour: one value, a list a,b,c or a range from:to:step
                       (default: the scenario's own demand)
  --seeds N            runs per setting, seeds 1..N (default 5)
  --duration SECONDS   simulated time per run (default 1200)
  --warmup SECONDS     trips requested before this are not measured (default 300)
  --follow MODEL       idm or sigmoid (default: the scenario's)
  --reroute SECONDS    how long a blocked driver waits before trying another way; 0 = never
  --param KEY=VALUE    controller setting, e.g. fixed.green=30 (repeatable)
  --format FORMAT      table, csv or json (default table)
  --runs               with csv: one row per run instead of one per setting
  --out PATH           write to a file instead of standard output
  --threads N          worker threads, 1 to 4 (default 4)
  --list               list controllers and presets
  --help

Every run is deterministic: the same options give the same numbers.
";

struct Options {
    scenario: Scenario,
    name: String,
    controllers: Vec<String>,
    demands: Vec<f64>,
    seeds: u64,
    duration: f64,
    warmup: f64,
    format: String,
    per_run: bool,
    out: Option<String>,
    threads: usize,
}

fn parse_demands(text: &str) -> Result<Vec<f64>, String> {
    let num = |s: &str| {
        s.parse::<f64>()
            .ok()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or(format!("bad demand `{s}`"))
    };
    let parts: Vec<&str> = text.split(':').collect();
    if let [from, to, step] = parts.as_slice() {
        let (from, to, step) = (num(from)?, num(to)?, num(step)?);
        if step <= 0.0 || to < from {
            return Err("a demand range is from:to:step with step above zero".into());
        }
        let n = ((to - from) / step + 1e-9) as usize;
        return Ok((0..=n).map(|i| from + step * i as f64).collect());
    }
    text.split(',').map(num).collect()
}

fn parse_args(args: &[String]) -> Result<Option<Options>, String> {
    let mut name = "town".to_string();
    let mut file: Option<String> = None;
    let mut controllers = "all".to_string();
    let mut demands: Option<String> = None;
    let mut follow: Option<String> = None;
    let mut reroute: Option<f64> = None;
    let mut params: Vec<(String, f64)> = vec![];
    let (mut seeds, mut duration, mut warmup, mut threads) = (5u64, 1200.0, 300.0, 4usize);
    let mut format = "table".to_string();
    let (mut per_run, mut out) = (false, None);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || it.next().cloned().ok_or(format!("{arg} needs a value"));
        let number = |v: String| v.parse::<f64>().map_err(|_| format!("bad number `{v}`"));
        match arg.as_str() {
            "--help" | "-h" => {
                print!("{HELP}");
                return Ok(None);
            }
            "--list" => {
                println!("controllers:");
                for c in CONTROLLERS {
                    println!("  {:<15} {}", c.id, c.summary);
                }
                println!("presets:");
                for p in PRESETS {
                    println!("  {:<15} {}", p.id, p.label);
                }
                return Ok(None);
            }
            "--preset" => name = value()?,
            "--file" => file = Some(value()?),
            "--controller" => controllers = value()?,
            "--demand" => demands = Some(value()?),
            "--seeds" => seeds = number(value()?)? as u64,
            "--duration" => duration = number(value()?)?,
            "--warmup" => warmup = number(value()?)?,
            "--follow" => follow = Some(value()?),
            "--reroute" => reroute = Some(number(value()?)?),
            "--param" => {
                let v = value()?;
                let (k, x) = v.split_once('=').ok_or("--param takes KEY=VALUE")?;
                params.push((k.to_string(), number(x.to_string())?));
            }
            "--format" => format = value()?,
            "--runs" => per_run = true,
            "--out" => out = Some(value()?),
            "--threads" => threads = number(value()?)? as usize,
            other => return Err(format!("unknown option `{other}` (try --help)")),
        }
    }
    let text = match &file {
        Some(path) => {
            name = path.clone();
            std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?
        }
        None => preset(&name)
            .ok_or(format!("unknown preset `{name}` (try --list)"))?
            .text
            .to_string(),
    };
    let mut scenario = Scenario::parse(&text)?;
    if let Some(f) = follow {
        scenario.follow = FollowModel::parse(&f).ok_or("--follow takes idm or sigmoid")?;
    }
    if let Some(r) = reroute {
        scenario.reroute_after = r;
    }
    scenario.params.extend(params);
    let controllers: Vec<String> = if controllers == "all" {
        CONTROLLERS.iter().map(|c| c.id.to_string()).collect()
    } else {
        controllers.split(',').map(str::to_string).collect()
    };
    for c in &controllers {
        if !CONTROLLERS.iter().any(|k| k.id == c) {
            return Err(format!("unknown controller `{c}` (try --list)"));
        }
    }
    let demands = match demands {
        Some(d) => parse_demands(&d)?,
        None => vec![scenario.demand],
    };
    if !matches!(format.as_str(), "table" | "csv" | "json") {
        return Err("--format takes table, csv or json".into());
    }
    if seeds == 0 || duration <= warmup {
        return Err("need at least one seed and a duration longer than the warm-up".into());
    }
    Ok(Some(Options {
        scenario,
        name,
        controllers,
        demands,
        seeds,
        duration,
        warmup,
        format,
        per_run,
        out,
        threads: threads.clamp(1, 4),
    }))
}

/// One setting: a controller at a demand level, with a run per seed.
struct Setting {
    controller: String,
    demand: f64,
    runs: Vec<RunMetrics>,
}

fn run_all(o: &Options) -> Vec<Setting> {
    let mut jobs = Vec::new();
    for (ci, controller) in o.controllers.iter().enumerate() {
        for (di, &demand) in o.demands.iter().enumerate() {
            for seed in 1..=o.seeds {
                jobs.push((ci, di, controller.clone(), demand, seed));
            }
        }
    }
    let next = AtomicUsize::new(0);
    // Results are keyed by setting and seed, so the order threads finish in does not matter.
    let done: Mutex<BTreeMap<(usize, usize, u64), RunMetrics>> = Mutex::new(BTreeMap::new());
    std::thread::scope(|scope| {
        for _ in 0..o.threads.min(jobs.len()) {
            scope.spawn(|| loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                let Some((ci, di, controller, demand, seed)) = jobs.get(k) else {
                    break;
                };
                let mut scenario = o.scenario.clone();
                scenario.controller = controller.clone();
                scenario.demand = *demand;
                let metrics = run(&scenario, *seed, o.duration, o.warmup);
                done.lock()
                    .expect("no worker panics")
                    .insert((*ci, *di, *seed), metrics);
            });
        }
    });
    let done = done.into_inner().expect("no worker panics");
    let mut settings: Vec<Setting> = Vec::new();
    for ((ci, di, _), metrics) in done {
        let (controller, demand) = (&o.controllers[ci], o.demands[di]);
        match settings.last_mut() {
            Some(s) if &s.controller == controller && s.demand == demand => s.runs.push(metrics),
            _ => settings.push(Setting {
                controller: controller.clone(),
                demand,
                runs: vec![metrics],
            }),
        }
    }
    settings
}

fn num(v: f64) -> String {
    if v.is_finite() {
        format!("{:.3}", v)
    } else {
        "null".into()
    }
}

fn render(o: &Options, settings: &[Setting]) -> String {
    let mut out = String::new();
    let column =
        |s: &Setting, k: usize| estimate(&s.runs.iter().map(|r| r.values()[k]).collect::<Vec<_>>());
    match o.format.as_str() {
        "csv" if o.per_run => {
            let _ = writeln!(
                out,
                "scenario,controller,demand,seed,{}",
                METRIC_NAMES.join(",")
            );
            for s in settings {
                for r in &s.runs {
                    let v: Vec<String> = r.values().iter().map(|&x| num(x)).collect();
                    let _ = writeln!(
                        out,
                        "{},{},{},{},{}",
                        o.name,
                        s.controller,
                        s.demand,
                        r.seed,
                        v.join(",")
                    );
                }
            }
        }
        "csv" => {
            let heads: Vec<String> = METRIC_NAMES
                .iter()
                .map(|m| format!("{m},{m}_ci95"))
                .collect();
            let _ = writeln!(out, "scenario,controller,demand,seeds,{}", heads.join(","));
            for s in settings {
                let v: Vec<String> = (0..METRIC_NAMES.len())
                    .map(|k| {
                        let e = column(s, k);
                        format!("{},{}", num(e.mean), num(e.half_width).replace("null", ""))
                    })
                    .collect();
                let _ = writeln!(
                    out,
                    "{},{},{},{},{}",
                    o.name,
                    s.controller,
                    s.demand,
                    s.runs.len(),
                    v.join(",")
                );
            }
        }
        "json" => {
            let _ = write!(
                out,
                "{{\"scenario\":\"{}\",\"duration\":{},\"warmup\":{},\"settings\":[",
                o.name.replace('\\', "\\\\").replace('"', "\\\""),
                o.duration,
                o.warmup
            );
            for (i, s) in settings.iter().enumerate() {
                let _ = write!(
                    out,
                    "{}{{\"controller\":\"{}\",\"demand\":{},\"summary\":{{",
                    if i > 0 { "," } else { "" },
                    s.controller,
                    s.demand
                );
                for (k, name) in METRIC_NAMES.iter().enumerate() {
                    let e = column(s, k);
                    let _ = write!(
                        out,
                        "{}\"{name}\":{{\"mean\":{},\"ci95\":{}}}",
                        if k > 0 { "," } else { "" },
                        num(e.mean),
                        num(e.half_width)
                    );
                }
                out.push_str("},\"runs\":[");
                for (j, r) in s.runs.iter().enumerate() {
                    let _ = write!(out, "{}{{\"seed\":{}", if j > 0 { "," } else { "" }, r.seed);
                    for (name, v) in METRIC_NAMES.iter().zip(r.values()) {
                        let _ = write!(out, ",\"{name}\":{}", num(v));
                    }
                    out.push('}');
                }
                out.push_str("]}");
            }
            out.push_str("]}\n");
        }
        _ => {
            let _ = writeln!(
                out,
                "{}: {} s per run, first {} s not measured, {} seed(s); mean ± 95% interval over seeds\n",
                o.name, o.duration, o.warmup, o.seeds
            );
            let _ = writeln!(
                out,
                "{:<15} {:>6}  {:>13}  {:>13}  {:>13}  {:>12}  {:>10}  {:>6}  {:>6}  {:>8}",
                "controller",
                "demand",
                "delay s",
                "delay p95 s",
                "delay all s",
                "finished/h",
                "unfinished",
                "queue",
                "stops",
                "checks"
            );
            let pm = |e: traffic_core::metrics::Estimate, d: usize| {
                if e.half_width.is_finite() {
                    format!("{:.d$} ± {:.d$}", e.mean, e.half_width)
                } else {
                    format!("{:.d$}", e.mean)
                }
            };
            for s in settings {
                let bad: f64 = (10..13)
                    .map(|k| column(s, k).mean * s.runs.len() as f64)
                    .sum();
                let _ = writeln!(
                    out,
                    "{:<15} {:>6}  {:>13}  {:>13}  {:>13}  {:>12}  {:>10.1}  {:>6.1}  {:>6.2}  {:>8}",
                    s.controller,
                    s.demand,
                    pm(column(s, 0), 1),
                    pm(column(s, 1), 1),
                    pm(column(s, 2), 1),
                    pm(column(s, 3), 0),
                    column(s, 5).mean,
                    column(s, 6).mean,
                    column(s, 8).mean,
                    if bad == 0.0 { "ok".to_string() } else { format!("{bad:.0} bad") }
                );
            }
            out.push_str(
                "\ndelay all counts unfinished trips at their delay so far. checks: hard brakes, red runs and overlaps, summed.\n",
            );
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse_args(&args) {
        Ok(Some(o)) => o,
        Ok(None) => return,
        Err(e) => {
            eprintln!("traffic: {e}");
            std::process::exit(2);
        }
    };
    let text = render(&options, &run_all(&options));
    match &options.out {
        Some(path) => {
            if let Err(e) = std::fs::write(path, text) {
                eprintln!("traffic: {path}: {e}");
                std::process::exit(1);
            }
        }
        None => print!("{text}"),
    }
}
