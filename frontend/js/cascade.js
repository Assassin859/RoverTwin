// Live subsystem dependency graph. Edge weight = coupling strength computed by
// the twin's physics model each step; labels state the physical mechanism.
import { edgeLabel, edgeTooltip } from "./edges.js";

const NODES = {
  EPS: [80, 52, "EPS"], TCS: [260, 30, "TCS"], COMMS: [440, 52, "COMMS"],
  GNC: [260, 112, "ADCS"], MOB: [80, 165, "PAYLOAD"], DATA: [440, 165, "OBDH"],
};
const STATUS_COLOR = { NOMINAL: "#3ecf6a", WATCH: "#ffb02e", WARNING: "#ff7a3d", CRITICAL: "#ff4d3a" };
const NS = "http://www.w3.org/2000/svg";
const VIEW_W = 520, VIEW_H = 200;

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export class Cascade {
  constructor(svg) {
    this.svg = svg;
    this.edges = {};
    this.nodes = {};
    this.highlight = new Set();
    const defs = el("defs", {}, svg);
    for (const [id, c] of [["g", "#4a3f35"], ["a", "#ffb02e"], ["r", "#ff4d3a"], ["h", "#ff9933"]]) {
      const m = el("marker", { id: "arw-" + id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" }, defs);
      el("path", { d: "M0,0 L10,5 L0,10 z", fill: c }, m);
    }
    this.gEdges = el("g", {}, svg);
    this.gLabels = el("g", {}, svg);
    this.gHops = el("g", {}, svg);
    this.gNodes = el("g", {}, svg);
    for (const [id, [x, y, label]] of Object.entries(NODES)) {
      const g = el("g", { class: "node", transform: `translate(${x},${y})` }, this.gNodes);
      const ring = el("circle", { class: "ring", r: 25, stroke: STATUS_COLOR.NOMINAL }, g);
      const t = el("text", { y: -2 }, g);
      t.textContent = label.length > 8 ? label.split("/")[0] : label;
      const s = el("text", { class: "sc", y: 11 }, g);
      s.textContent = "100";
      this.nodes[id] = { ring, s };
    }
  }

  setHighlight(keys) {
    this.highlight = new Set(keys || []);
  }

  pulseEdges(keys, ms = 1200) {
    for (const key of keys || []) {
      const e = this.edges[key] || this._edge(key);
      e.path.classList.add("pulse-flash");
      clearTimeout(e._pulseTimer);
      e._pulseTimer = setTimeout(() => e.path.classList.remove("pulse-flash"), ms);
    }
  }

  _edge(key) {
    if (this.edges[key]) return this.edges[key];
    const [a, b] = key.split(">");
    const [x1, y1] = NODES[a], [x2, y2] = NODES[b];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len, off = 16;
    const sx = x1 + (dx / len) * 27, sy = y1 + (dy / len) * 27;
    const ex = x2 - (dx / len) * 29, ey = y2 - (dy / len) * 29;
    const cx = (x1 + x2) / 2 + nx * off, cy = (y1 + y2) / 2 + ny * off;
    const path = el("path", { class: "edge", d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}` }, this.gEdges);
    path.style.pointerEvents = "stroke";
    path.style.cursor = "help";
    const tip = el("title", {}, path);
    // Chip sits on the curve midpoint (t = .5), not the control point, so it stays on the edge.
    const mx = 0.25 * sx + 0.5 * cx + 0.25 * ex, my = 0.25 * sy + 0.5 * cy + 0.25 * ey;
    const lg = el("g", {}, this.gLabels);
    const bg = el("rect", { class: "elabel-bg", rx: 4, height: 17 }, lg);
    const tx = el("text", { class: "elabel", x: mx, y: my + 4, "text-anchor": "middle" }, lg);
    const tip2 = el("title", {}, lg);
    return (this.edges[key] = { path, tip, tip2, lg, bg, tx, cx: mx, cy: my, w: 0 });
  }

  update(couplings, subsystems, activeKeys) {
    const active = new Set(activeKeys || []);
    const hi = this.highlight.size ? this.highlight : active;
    const hasFocus = hi.size > 0;

    for (const [key, [s, label]] of Object.entries(couplings || {})) {
      const e = this._edge(key);
      const onPath = hi.has(key);
      const lvl = onPath ? "h" : s < 0.12 ? "g" : s < 0.5 ? "a" : "r";
      const color = { g: "#4a3f35", a: "#ffb02e", r: "#ff4d3a", h: "#ff9933" }[lvl];
      e.path.setAttribute("stroke", color);
      e.path.setAttribute("stroke-width", (onPath ? 2.5 + 4 * s : 1 + 4 * s).toFixed(2));
      let op = 0.35 + 0.65 * Math.min(1, s * 2);
      if (hasFocus && !onPath) op *= 0.35;
      if (onPath) op = Math.max(op, 0.95);
      if (active.has(key) && !onPath) op = Math.max(op, 0.55);
      e.path.setAttribute("opacity", op.toFixed(2));
      e.path.setAttribute("marker-end", `url(#arw-${lvl})`);
      e.path.classList.toggle("flow", s >= 0.12 || onPath);
      e.path.classList.toggle("path", onPath);
      const tip = edgeTooltip(key, label);
      e.tip.textContent = tip;
      e.tip2.textContent = tip;
      // Short 12px chip only (e.g. "heat 60 W"); full equation lives in the tooltip + Evidence table.
      const onText = (onPath || s >= 0.35) ? edgeLabel(key, label) : "";
      const show = (s >= 0.2 || onPath) && !!onText;
      e.lg.style.display = show ? "" : "none";
      e.lg.style.opacity = hasFocus && !onPath ? "0.25" : "1";
      if (show && e.tx.textContent !== onText) {
        e.tx.textContent = onText;
        let tl = 0;
        try { tl = e.tx.getComputedTextLength(); } catch { tl = 0; }
        if (!tl) tl = onText.length * 6.6; // svg not laid out yet
        const w = Math.min(96, Math.max(30, tl + 10));
        // Keep the chip inside the viewBox so it never clips at the edge of the graph.
        const x = Math.min(VIEW_W - w / 2 - 2, Math.max(w / 2 + 2, e.cx));
        const y = Math.min(VIEW_H - 10, Math.max(10, e.cy));
        e.w = w;
        e.tx.setAttribute("x", x);
        e.tx.setAttribute("y", y + 4);
        e.bg.setAttribute("width", w);
        e.bg.setAttribute("x", x - w / 2);
        e.bg.setAttribute("y", y - 8.5);
        e.px = x;
        e.py = y;
      }
    }
    // Hop numbers along highlighted path
    while (this.gHops.firstChild) this.gHops.removeChild(this.gHops.firstChild);
    const ordered = [...hi];
    ordered.forEach((key, i) => {
      const e = this.edges[key];
      if (!e) return;
      const t = el("text", { class: "hop-num", x: e.px ?? e.cx, y: (e.py ?? e.cy) - 13, "text-anchor": "middle" }, this.gHops);
      t.textContent = String(i + 1);
    });
    for (const sub of subsystems || []) {
      const n = this.nodes[sub.id];
      if (!n) continue;
      n.ring.setAttribute("stroke", STATUS_COLOR[sub.status]);
      n.s.textContent = sub.root ? `${sub.score} ROOT` : String(sub.score);
    }
  }
}
