/** Two small SVG charts: lines over time and horizontal bars with intervals. */

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Round axis steps: 1, 2 or 5 times a power of ten. */
function ticks(max: number, count: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export interface Series {
  label: string;
  /** A CSS colour, usually a custom property. */
  colour: string;
  points: [number, number][];
}

export interface LineOptions {
  series: Series[];
  /** Formats an x value (seconds) and a y value for axis labels and the tooltip. */
  x: (v: number) => string;
  y: (v: number) => string;
  /** Shade x values below this, to show a period that is not measured. */
  shadeBelow?: number;
  shadeLabel?: string;
  height?: number;
  description: string;
}

function tooltip(host: HTMLElement): HTMLElement {
  let tip = host.querySelector<HTMLElement>(".chart-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    host.append(tip);
  }
  return tip;
}

function placeTip(host: HTMLElement, tip: HTMLElement, x: number, y: number): void {
  tip.hidden = false;
  const w = tip.offsetWidth;
  const left = Math.min(Math.max(4, x + 12), host.clientWidth - w - 4);
  tip.style.left = `${x + 12 + w > host.clientWidth ? Math.max(4, x - w - 12) : left}px`;
  tip.style.top = `${Math.max(4, y - tip.offsetHeight - 8)}px`;
}

export function lineChart(host: HTMLElement, o: LineOptions): void {
  const width = Math.max(host.clientWidth, 240);
  const height = o.height ?? 220;
  const m = { top: 12, right: 14, bottom: 26, left: 44 };
  const all = o.series.flatMap((s) => s.points);
  const xMax = Math.max(1, ...all.map((p) => p[0]));
  const yTicks = ticks(Math.max(1, ...all.map((p) => p[1])), 4);
  const yMax = yTicks[yTicks.length - 1] ?? 1;
  const xTicks = ticks(xMax, width < 420 ? 3 : 6).filter((t) => t <= xMax);
  const sx = (v: number) => m.left + (v / xMax) * (width - m.left - m.right);
  const sy = (v: number) => height - m.bottom - (v / yMax) * (height - m.top - m.bottom);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "chart" });
  svg.setAttribute("aria-label", o.description);
  if (o.shadeBelow && o.shadeBelow > 0) {
    const w = sx(Math.min(o.shadeBelow, xMax)) - m.left;
    svg.append(
      el("rect", {
        x: m.left,
        y: m.top,
        width: w,
        height: height - m.top - m.bottom,
        class: "shade",
      }),
    );
    if (o.shadeLabel && w > 70) {
      svg.append(el("text", { x: m.left + 6, y: m.top + 12, class: "axis" }, o.shadeLabel));
    }
  }
  for (const t of yTicks) {
    svg.append(
      el("line", { x1: m.left, x2: width - m.right, y1: sy(t), y2: sy(t), class: "grid" }),
      el("text", { x: m.left - 8, y: sy(t) + 4, "text-anchor": "end", class: "axis" }, o.y(t)),
    );
  }
  for (const t of xTicks) {
    svg.append(
      el("text", { x: sx(t), y: height - 8, "text-anchor": "middle", class: "axis" }, o.x(t)),
    );
  }
  for (const s of o.series) {
    if (s.points.length === 0) continue;
    const d = s.points.map(
      (p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`,
    );
    const path = el("path", { d: d.join(""), class: "line" });
    path.style.stroke = s.colour;
    svg.append(path);
    const last = s.points[s.points.length - 1]!;
    const dot = el("circle", { cx: sx(last[0]), cy: sy(last[1]), r: 4, class: "dot" });
    dot.style.fill = s.colour;
    svg.append(dot);
  }
  const cross = el("line", {
    y1: m.top,
    y2: height - m.bottom,
    class: "cross",
    visibility: "hidden",
  });
  svg.append(cross);
  host.querySelector("svg")?.remove();
  host.prepend(svg);

  const tip = tooltip(host);
  const xs = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const at = ((e.clientX - box.left - m.left) / (width - m.left - m.right)) * xMax;
    const x = xs.reduce(
      (best, v) => (Math.abs(v - at) < Math.abs(best - at) ? v : best),
      xs[0] ?? 0,
    );
    const rows = o.series
      .map((s) => ({ s, p: s.points.find((p) => p[0] === x) }))
      .filter((r) => r.p)
      .sort((a, b) => b.p![1] - a.p![1]);
    if (rows.length === 0) return;
    cross.setAttribute("x1", String(sx(x)));
    cross.setAttribute("x2", String(sx(x)));
    cross.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const head = document.createElement("strong");
    head.textContent = o.x(x);
    tip.append(head);
    for (const r of rows) {
      const row = document.createElement("span");
      const key = document.createElement("i");
      key.style.background = r.s.colour;
      row.append(
        key,
        `${r.s.label}`,
        Object.assign(document.createElement("b"), { textContent: o.y(r.p![1]) }),
      );
      tip.append(row);
    }
    placeTip(host, tip, e.clientX - box.left, e.clientY - box.top);
  });
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}

export interface Bar {
  label: string;
  colour: string;
  value: number;
  /** Half-width of the 95% interval, if there is one. */
  interval?: number;
  /** Extra line for the tooltip. */
  note?: string;
}

export interface BarOptions {
  bars: Bar[];
  format: (v: number) => string;
  description: string;
}

export function barChart(host: HTMLElement, o: BarOptions): void {
  const width = Math.max(host.clientWidth, 240);
  const row = 30;
  const labelWidth = Math.min(170, Math.max(96, width * 0.32));
  const valueWidth = 96;
  const height = o.bars.length * row + 6;
  const max = Math.max(1e-9, ...o.bars.map((b) => b.value + (b.interval ?? 0)));
  const span = width - labelWidth - valueWidth;
  const sx = (v: number) => labelWidth + (v / max) * span;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "chart" });
  svg.setAttribute("aria-label", o.description);
  const tip = tooltip(host);
  o.bars.forEach((b, i) => {
    const y = i * row + 4;
    const g = el("g", { class: "bar" });
    g.append(el("rect", { x: 0, y, width, height: row - 2, class: "hit" }));
    g.append(el("text", { x: 0, y: y + 18, class: "label" }, b.label));
    const w = Math.max(2, sx(b.value) - labelWidth);
    // Square at the baseline, rounded at the data end.
    const r = Math.min(4, w);
    const path = el("path", {
      d: `M${labelWidth},${y + 4}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${14 - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${r - w}z`,
    });
    path.style.fill = b.colour;
    g.append(path);
    let end = sx(b.value);
    if (b.interval !== undefined && Number.isFinite(b.interval)) {
      const lo = sx(Math.max(0, b.value - b.interval));
      end = sx(b.value + b.interval);
      g.append(
        el("line", { x1: lo, x2: end, y1: y + 11, y2: y + 11, class: "whisker" }),
        el("line", { x1: lo, x2: lo, y1: y + 7, y2: y + 15, class: "whisker" }),
        el("line", { x1: end, x2: end, y1: y + 7, y2: y + 15, class: "whisker" }),
      );
    }
    const text =
      b.interval !== undefined && Number.isFinite(b.interval)
        ? `${o.format(b.value)} ± ${o.format(b.interval)}`
        : o.format(b.value);
    g.append(el("text", { x: end + 8, y: y + 18, class: "value" }, text));
    g.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      tip.replaceChildren();
      const head = document.createElement("strong");
      head.textContent = b.label;
      const line = document.createElement("span");
      line.textContent = text;
      tip.append(head, line);
      if (b.note)
        tip.append(Object.assign(document.createElement("span"), { textContent: b.note }));
      placeTip(host, tip, e.clientX - box.left, e.clientY - box.top);
    });
    g.addEventListener("pointerleave", () => {
      tip.hidden = true;
    });
    svg.append(g);
  });
  host.querySelector("svg")?.remove();
  host.prepend(svg);
}

/** Two-sided 95% points of Student's t for 1 to 30 degrees of freedom. */
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

/** Mean over runs and the half-width of its 95% confidence interval. */
export function estimate(values: number[]): { mean: number; interval: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  if (n < 2) return { mean, interval: Number.NaN };
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  return { mean, interval: (T95[n - 2] ?? 1.96) * Math.sqrt(variance / n) };
}
