/** The Rust core, loaded as WebAssembly through its plain C interface. */
import wasmUrl from "./traffic.wasm?url";

export interface ControllerInfo {
  id: string;
  label: string;
  summary: string;
}

export interface Info {
  /** Side of a grid cell in metres. */
  cell: number;
  /** Simulated seconds per step. */
  dt: number;
  controllers: ControllerInfo[];
  presets: { id: string; label: string; text: string }[];
}

export interface Metrics {
  seed: number;
  demand: number;
  delay_mean: number;
  delay_p95: number;
  delay_all: number;
  throughput: number;
  finished: number;
  unfinished: number;
  queue_mean: number;
  queue_max: number;
  stops_per_trip: number;
  reroutes: number;
  hard_brakes: number;
  red_runs: number;
  overlaps: number;
}

export interface Stats {
  time: number;
  active: number;
  backlog: number;
  queued: number;
  metrics: Metrics;
}

export interface NetworkInfo {
  lanes: number;
  nodes: {
    cell: number;
    x: number;
    y: number;
    arms: number;
    canSignal: boolean;
    controller: string | null;
  }[];
  stops: { lane: number; x: number; y: number; dx: number; dy: number }[];
  houses: { cell: number; connected: boolean }[];
}

/** Numbers per car in the car table: x, y, heading x, heading y, speed, acceleration, id. */
export const CAR_STRIDE = 7;
/** Numbers per row of the time series: time, finished, delay sum, standing, waiting. */
export const SERIES_STRIDE = 5;

interface Exports {
  memory: WebAssembly.Memory;
  tr_alloc(len: number): number;
  tr_free(ptr: number, len: number): void;
  tr_text_ptr(): number;
  tr_text_len(): number;
  tr_buf_ptr(): number;
  tr_info(): void;
  tr_sim_new(ptr: number, len: number, seed: number): number;
  tr_sim_free(handle: number): void;
  tr_sim_network(handle: number): void;
  tr_sim_step(handle: number, steps: number): void;
  tr_sim_cars(handle: number): number;
  tr_sim_lights(handle: number): number;
  tr_sim_stats(handle: number): void;
  tr_sim_series(handle: number): number;
  tr_sim_set_controller(handle: number, ptr: number, len: number): number;
  tr_sim_set_demand(handle: number, perHour: number): void;
  tr_sim_set_warmup(handle: number, seconds: number): void;
  tr_run(ptr: number, len: number, seed: number, duration: number, warmup: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Core {
  readonly info: Info;

  private constructor(private readonly x: Exports) {
    x.tr_info();
    this.info = JSON.parse(this.text()) as Info;
  }

  static async load(): Promise<Core> {
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Core(instance.exports as unknown as Exports);
  }

  private text(): string {
    // Views are made fresh each time: any call may have grown the memory.
    const view = new Uint8Array(this.x.memory.buffer, this.x.tr_text_ptr(), this.x.tr_text_len());
    return decoder.decode(view);
  }

  private numbers(count: number): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.tr_buf_ptr(), count).slice();
  }

  private withText<T>(text: string, call: (ptr: number, len: number) => T): T {
    const bytes = encoder.encode(text);
    const ptr = this.x.tr_alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      return call(ptr, bytes.length);
    } finally {
      this.x.tr_free(ptr, bytes.length);
    }
  }

  /** Start a simulation. Throws with the core's message if the scenario is not valid. */
  simulate(scenario: string, seed: number): Simulation {
    const handle = this.withText(scenario, (p, n) => this.x.tr_sim_new(p, n, seed));
    if (handle < 0) throw new Error(this.text());
    return new Simulation(this, handle);
  }

  /** Run a whole scenario and return what it measured. */
  run(scenario: string, seed: number, duration: number, warmup: number): Metrics {
    const ok = this.withText(scenario, (p, n) => this.x.tr_run(p, n, seed, duration, warmup));
    if (ok < 0) throw new Error(this.text());
    return JSON.parse(this.text()) as Metrics;
  }

  /** @internal */
  _json<T>(call: (x: Exports) => void): T {
    call(this.x);
    return JSON.parse(this.text()) as T;
  }

  /** @internal */
  _table(call: (x: Exports) => number, stride: number): Float32Array {
    return this.numbers(call(this.x) * stride);
  }

  /** @internal */
  _call<T>(call: (x: Exports) => T): T {
    return call(this.x);
  }

  /** @internal */
  _text<T>(text: string, call: (x: Exports, ptr: number, len: number) => T): T {
    return this.withText(text, (p, n) => call(this.x, p, n));
  }
}

export class Simulation {
  private freed = false;

  constructor(
    private readonly core: Core,
    private readonly handle: number,
  ) {}

  network(): NetworkInfo {
    return this.core._json((x) => x.tr_sim_network(this.handle));
  }

  step(steps: number): void {
    this.core._call((x) => x.tr_sim_step(this.handle, steps));
  }

  cars(): Float32Array {
    return this.core._table((x) => x.tr_sim_cars(this.handle), CAR_STRIDE);
  }

  /** One number per lane: 0 no signal, 1 green, 2 amber, 3 red. */
  lights(): Float32Array {
    return this.core._table((x) => x.tr_sim_lights(this.handle), 1);
  }

  stats(): Stats {
    return this.core._json((x) => x.tr_sim_stats(this.handle));
  }

  series(): Float32Array {
    return this.core._table((x) => x.tr_sim_series(this.handle), SERIES_STRIDE);
  }

  setController(id: string): void {
    this.core._text(id, (x, p, n) => x.tr_sim_set_controller(this.handle, p, n));
  }

  setDemand(perHour: number): void {
    this.core._call((x) => x.tr_sim_set_demand(this.handle, perHour));
  }

  /** Measure only trips requested after this many seconds. */
  setWarmup(seconds: number): void {
    this.core._call((x) => x.tr_sim_set_warmup(this.handle, seconds));
  }

  free(): void {
    if (!this.freed) this.core._call((x) => x.tr_sim_free(this.handle));
    this.freed = true;
  }
}
