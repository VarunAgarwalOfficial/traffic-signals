/** Runs whole scenarios off the main thread, one message back per finished run. */
import { Core, type Metrics } from "./wasm.ts";

export interface Job {
  runs: { key: string; scenario: string; seed: number }[];
  duration: number;
  warmup: number;
}

export type Reply =
  | { kind: "run"; key: string; metrics: Metrics }
  | { kind: "done" }
  | { kind: "error"; message: string };

const core = Core.load();

self.onmessage = async (event: MessageEvent<Job>) => {
  const post = (reply: Reply) => self.postMessage(reply);
  try {
    const c = await core;
    for (const run of event.data.runs) {
      const metrics = c.run(run.scenario, run.seed, event.data.duration, event.data.warmup);
      post({ kind: "run", key: run.key, metrics });
    }
    post({ kind: "done" });
  } catch (error) {
    post({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
