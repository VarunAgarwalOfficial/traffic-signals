//! A small, deterministic traffic simulator for comparing signal controllers.
//!
//! - [`grid`] and [`scenario`]: the drawn map and its settings, as text.
//! - [`network`]: lanes, junctions and the conflicts between paths through them.
//! - [`route`]: A* routing.
//! - [`follow`]: car following (Intelligent Driver Model, or the sigmoid rule).
//! - [`control`]: signal controllers behind one trait.
//! - [`sim`]: the simulation itself.
//! - [`metrics`]: runs, warm-up, and confidence intervals over seeds.

pub mod control;
pub mod follow;
pub mod grid;
pub mod metrics;
pub mod network;
pub mod rng;
pub mod route;
pub mod scenario;
pub mod sim;
