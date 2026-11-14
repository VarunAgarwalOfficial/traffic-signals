import { parseArgs } from "node:util";
import { compareControllers, defaultRun, type RunOptions } from "./core/compare.ts";
import { formatWorld, junctions, parseWorld } from "./core/grid.ts";
import { DEFAULT_MAP, maps } from "./core/maps.ts";

function usage(): string {
  return [
    "Usage: npm run compare -- [options]",
    "",
    "Simulates the same traffic under each signal controller and prints the results.",
    "",
    "Options (defaults in brackets):",
    `  --map NAME        one of ${Object.keys(maps).join(", ")} [${DEFAULT_MAP}]`,
    `  --rate N          cars entering per minute [${defaultRun.carsPerMinute}]`,
    `  --minutes N       simulated minutes [${defaultRun.duration / 60}]`,
    `  --seed N          seed of the trip stream [${defaultRun.seed}]`,
    "  --sweep           repeat for a range of rates",
    "  --json            print the results as JSON",
    "  --help            show this text",
  ].join("\n");
}

function number(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`--${name} needs a number, got "${raw}"`);
  return value;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  const line = (row: string[]): string =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ");
  const [head, ...body] = rows;
  return [line(head!), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      map: { type: "string" },
      rate: { type: "string" },
      minutes: { type: "string" },
      seed: { type: "string" },
      sweep: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  const mapName = values.map ?? DEFAULT_MAP;
  const map = maps[mapName];
  if (!map)
    throw new Error(`unknown map "${mapName}" (expected one of ${Object.keys(maps).join(", ")})`);
  const world = parseWorld(map.text);
  const base: RunOptions = {
    ...defaultRun,
    carsPerMinute: number("rate", values.rate, defaultRun.carsPerMinute),
    duration: number("minutes", values.minutes, defaultRun.duration / 60) * 60,
    seed: number("seed", values.seed, defaultRun.seed),
  };
  const rates = values.sweep ? [10, 20, 40, 60, 80, 100] : [base.carsPerMinute];
  const runs = rates.map((carsPerMinute) => {
    const options = { ...base, carsPerMinute };
    return { options, results: compareControllers(world, options) };
  });

  if (values.json) {
    const plain = runs.map(({ options, results }) => ({
      options,
      results: results.map(({ controller, stats }) => ({ controller: controller.id, ...stats })),
    }));
    console.log(JSON.stringify({ map: mapName, runs: plain }, null, 2));
    return;
  }

  console.log(formatWorld(world));
  console.log(
    `\n${map.label}. ${world.houses.size} houses, ${junctions(world).length} signalled junctions, ` +
      `${base.duration / 60} simulated minutes, seed ${base.seed}.`,
  );
  console.log("Times are seconds per finished trip. Delay is time lost against an empty road.\n");
  const rows = [
    [
      "cars/min",
      "controller",
      "arrived",
      "on road",
      "not yet entered",
      "travel",
      "delay",
      "standing",
    ],
  ];
  for (const { options, results } of runs) {
    for (const { controller, stats } of results) {
      rows.push([
        String(options.carsPerMinute),
        controller.label,
        String(stats.arrived),
        String(stats.active),
        String(stats.queued),
        stats.meanTravel.toFixed(1),
        stats.meanDelay.toFixed(1),
        stats.meanWait.toFixed(1),
      ]);
    }
  }
  console.log(table(rows));
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  console.error("Run with --help for the list of options.");
  process.exitCode = 1;
}
