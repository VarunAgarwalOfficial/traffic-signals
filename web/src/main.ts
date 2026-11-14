import "./style.css";
import { BuildView } from "./build.ts";
import { CompareView } from "./compare.ts";
import { decodeShare, encodeShare, formatScenario, parseScenario } from "./scenario.ts";
import { Core } from "./wasm.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let toastTimer = 0;
function toast(message: string): void {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

function currentTheme(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function showTheme(): void {
  const dark = currentTheme() === "dark";
  const button = $("theme");
  button.setAttribute("aria-label", dark ? "Use the light theme" : "Use the dark theme");
  button.querySelector("use")?.setAttribute("href", dark ? "#i-sun" : "#i-moon");
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
  const shared = new URLSearchParams(location.hash.slice(1)).get("s");
  if (shared) {
    try {
      initial = parseScenario(await decodeShare(shared));
      custom.hidden = false;
      presetSelect.value = "";
    } catch {
      toast("That link does not hold a map this page can read. Showing the town instead.");
    }
  }

  const build = new BuildView(core, initial, toast);
  const compare = new CompareView(core, () => ({ scenario: build.scenario, seed: build.seed }));

  presetSelect.addEventListener("change", () => {
    const preset = presets.find((p) => p.id === presetSelect.value);
    if (!preset) return;
    build.load(parseScenario(preset.text));
    history.replaceState(null, "", location.pathname + location.search);
  });

  $("share").addEventListener("click", async () => {
    const code = await encodeShare(formatScenario(build.scenario));
    const url = `${location.origin}${location.pathname}#s=${code}`;
    history.replaceState(null, "", `#s=${code}`);
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied. It holds the map, the demand and the controller.");
    } catch {
      toast("The link is in the address bar. Copy it from there.");
    }
  });

  const tabs = [$("tab-build"), $("tab-compare")];
  const show = (which: number) => {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === which));
      tab.tabIndex = i === which ? 0 : -1;
    });
    $("build").hidden = which !== 0;
    $("compare").hidden = which !== 1;
    build.setVisible(which === 0);
    compare.setVisible(which === 1);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => show(i));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const next = (i + 1) % tabs.length;
      show(next);
      tabs[next]?.focus();
    });
  });

  $("theme").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("traffic-theme", next);
    } catch {
      // Private browsing: the choice lasts for this visit only.
    }
    showTheme();
    build.themeChanged();
    compare.themeChanged();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    showTheme();
    build.themeChanged();
    compare.themeChanged();
  });
  showTheme();
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
