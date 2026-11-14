#!/bin/sh
# Reproduces the comparison tables in the README. About two minutes on four threads.
set -e
cd "$(dirname "$0")/.."
cargo build -j4 --release -p traffic
T=./target/release/traffic
COMMON="--seeds 10 --duration 2400 --warmup 600 --format csv"
# 1. All controllers on the 4x4 grid, from light traffic to twice what it can carry.
$T --preset grid --demand 500:6500:500 $COMMON --out results/grid.csv
# 2. The same with drivers who never look for another way round a full road.
$T --preset grid --demand 500:6500:1000 --reroute 0 $COMMON --out results/grid-no-reroute.csv
# 3. Fixed time with other green times, so the baseline is not a straw man.
for g in 10 30 40; do
  $T --preset grid --controller fixed --param fixed.green=$g --demand 500:6500:1000 $COMMON --out results/grid-fixed-$g.csv
done
# 4. Self-organising lights with a lower threshold, closer to Gershenson's sotl-request.
$T --preset grid --controller sotl --param sotl.theta=3 --param sotl.min_green=5 --demand 500:6500:1000 $COMMON --out results/grid-sotl-eager.csv
# 5. The town and the arterial.
$T --preset town --demand 500:4500:1000 $COMMON --out results/town.csv
$T --preset arterial --demand 500:3500:1000 $COMMON --out results/arterial.csv
