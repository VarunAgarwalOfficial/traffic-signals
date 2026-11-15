import "./style.css";
import { BuildView } from "./build.ts";
import { CompareView } from "./compare.ts";
import { decodeShare, encodeShare, formatScenario, parseScenario } from "./scenario.ts";
import { Core } from "./wasm.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** A message in the page, under the controls: no pop-ups. */
function notice(message: string): void {
  $("notice").textContent = message;
}

async function start(): Promise<void> {
  const core = await Core.load();
  const presets = core.info.presets;
  const presetSelect = $<HTMLSelectElement>("preset");
  for (const p of presets) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.label} map`;
    presetSelect.append(o);
  }
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "Shared map";
  custom.hidden = true;
  presetSelect.append(custom);

  let initial = parseScenario(presets[0]!.text);
  const link = new URLSearchParams(location.hash.slice(1));
  const shared = link.get("s");
  const seed = Math.min(999999, Math.max(1, Math.round(Number(link.get("seed")) || 1)));
  if (shared) {
    try {
      initial = parseScenario(await decodeShare(shared));
      custom.hidden = false;
      presetSelect.value = "";
    } catch {
      notice("That link does not hold a map this page can read. Showing the town instead.");
    }
  }

  const build = new BuildView(core, initial, shared ? seed : 1);
  const compare = new CompareView(core, () => ({ scenario: build.scenario, seed: build.seed }));

  presetSelect.addEventListener("change", () => {
    const preset = presets.find((p) => p.id === presetSelect.value);
    if (!preset) return;
    build.load(parseScenario(preset.text));
    history.replaceState(null, "", location.pathname + location.search);
  });

  $("share").addEventListener("click", async () => {
    const code = await encodeShare(formatScenario(build.scenario));
    const hash = `#s=${code}&seed=${build.seed}`;
    const url = `${location.origin}${location.pathname}${hash}`;
    history.replaceState(null, "", hash);
    try {
      await navigator.clipboard.writeText(url);
      $("share-status").textContent =
        "Link copied. It holds the map, the trips an hour, the controllers and the seed.";
    } catch {
      $("share-status").textContent = "The link is in the address bar. Copy it from there.";
    }
  });

  // The comparison is a closed disclosure under the town; it works only while open.
  const comparePanel = $<HTMLDetailsElement>("compare");
  comparePanel.addEventListener("toggle", () => compare.setVisible(comparePanel.open));

  // No theme button: the page follows the system colour scheme, as the host page does.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    build.themeChanged();
    compare.themeChanged();
  });
  document.documentElement.dataset.ready = "true";
}

start().catch((error) => {
  const main = document.querySelector("main");
  if (main) {
    const p = document.createElement("p");
    p.className = "fatal";
    p.textContent = `The simulation could not start: ${error instanceof Error ? error.message : error}`;
    main.replaceChildren(p);
  }
});
