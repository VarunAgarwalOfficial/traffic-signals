// Checks that the WebAssembly build and the native command line give the same numbers.
// Usage: node scripts/same-in-browser.mjs   (after `cargo build --release -p traffic` and `npm run wasm` in web/)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const wasm = readFileSync(`${root}web/src/traffic.wasm`);
const { instance } = await WebAssembly.instantiate(wasm, {});
const x = instance.exports;
const text = () =>
  new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.tr_text_ptr(), x.tr_text_len()));

let failed = false;
for (const [preset, controller, demand] of [
  ["town", "max-pressure", 2500],
  ["grid", "sotl", 4500],
  ["arterial", "capacity-aware", 1500],
]) {
  const scenario = readFileSync(`${root}crates/core/presets/${preset}.txt`, "utf8")
    .replace(/^controller .*/m, `controller ${controller}`)
    .replace(/^demand .*/m, `demand ${demand}`);
  const bytes = new TextEncoder().encode(scenario);
  const ptr = x.tr_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
  if (x.tr_run(ptr, bytes.length, 1, 900, 300) < 0) throw new Error(text());
  const inBrowser = JSON.parse(text());
  const native = JSON.parse(
    execFileSync(`${root}target/release/traffic`, [
      "--preset", preset, "--controller", controller, "--demand", String(demand),
      "--seeds", "1", "--duration", "900", "--warmup", "300", "--format", "json",
    ]).toString(),
  ).settings[0].runs[0];
  const same = Object.keys(native).every((k) => Math.abs(native[k] - inBrowser[k]) < 0.0006);
  failed ||= !same;
  console.log(`${same ? "same" : "DIFFERENT"}  ${preset} ${controller} ${demand}: delay ${inBrowser.delay_mean.toFixed(3)} s, ${inBrowser.finished} trips`);
}
process.exit(failed ? 1 : 0);
