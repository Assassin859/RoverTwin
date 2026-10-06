// Telemetry / twin / prediction chart on a 2D canvas.
const PAST = 3600, FUTURE = 7200;

export const CHARTS = [
  { key: "soc", title: "BATTERY CHARGE", unit: "%", scale: 100, min: 0, max: 100, limits: [[18, "auto-safe"]], low: true },
  { key: "t_bat", title: "BATTERY TEMP", unit: "°C", scale: 1, min: -10, max: 80, limits: [[50, "limit"]] },
  { key: "t_av", title: "AVIONICS TEMP", unit: "°C", scale: 1, min: -10, max: 90, limits: [[70, "limit"]] },
  { key: "margin", title: "LINK MARGIN", unit: "dB", scale: 1, min: -40, max: 20, limits: [[-21, "no link"]], low: true },
];

const C = {
  grid: "rgba(255,255,255,0.11)", frame: "rgba(255,255,255,0.14)", text: "#a89a8c", twin: "#ff9933", tm: "#f4ede4", truth: "#5cc8ff",
  pred: "#ff7b6b", band: "rgba(255,123,107,0.16)", unc: "rgba(255,153,51,0.16)", plan: "#3ecf6a", lim: "rgba(255,77,58,0.75)",
};

export class Chart {
  constructor(canvas, cfg) {
    this.cv = canvas;
    this.cfg = cfg;
    this.ctx = canvas.getContext("2d");
  }

  draw({ history, now, pred, plan, truthOn }) {
    const cv = this.cv, cfg = this.cfg, ctx = this.ctx;
    const dpr = Math.min(devicePixelRatio, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const L = 30, Rr = 6, T = 20, B = 16;
    const pw = W - L - Rr, ph = H - T - B;
    const t0 = now - PAST, t1 = now + FUTURE;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;
    const Y = (v) => T + (1 - (v - cfg.min) / (cfg.max - cfg.min)) * ph;
    const clampY = (v) => Y(Math.max(cfg.min, Math.min(cfg.max, v)));
    const sc = cfg.scale;

    // frame + grid
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.fillStyle = C.text;
    ctx.strokeStyle = C.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(L + 0.5, T + 0.5, pw - 1, ph - 1);
    ctx.strokeStyle = C.grid;
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = cfg.min + ((cfg.max - cfg.min) * i) / steps;
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillText(String(Math.round(v)), 2, y + 3);
    }
    for (const dt of [-3600, -1800, 0, 1800, 3600, 5400, 7200]) {
      const x = X(now + dt);
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
      if (dt !== 0) ctx.fillText((dt > 0 ? "+" : "") + dt / 3600 + "h", x - 10, H - 3);
    }
    // future shading
    ctx.fillStyle = "rgba(255,255,255,0.025)";
    ctx.fillRect(X(now), T, X(t1) - X(now), ph);
    // limits
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = C.lim;
    for (const [v, label] of cfg.limits) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillStyle = C.lim;
      ctx.fillText(label, L + pw - ctx.measureText(label).width - 2, y - 3);
    }
    ctx.setLineDash([]);

    const hist = history.filter((h) => h.t >= t0);
    // twin uncertainty band
    const uk = cfg.key === "margin" ? null : cfg.key;
    if (uk && hist.length > 1) {
      ctx.fillStyle = C.unc;
      ctx.beginPath();
      hist.forEach((h, i) => { const y = clampY((h.tw[uk] + (h.unc?.[uk] ?? 0)) * sc); i ? ctx.lineTo(X(h.t), y) : ctx.moveTo(X(h.t), y); });
      for (let i = hist.length - 1; i >= 0; i--) { const h = hist[i]; ctx.lineTo(X(h.t), clampY((h.tw[uk] - (h.unc?.[uk] ?? 0)) * sc)); }
      ctx.closePath(); ctx.fill();
    }
    // prediction band + baseline
    if (pred && pred.baseline) {
      const ts = pred.baseline.t.map((d) => pred.t0 + d);
      const band = pred.band[cfg.key];
      if (band) {
        ctx.fillStyle = C.band;
        ctx.beginPath();
        band.forEach((b, i) => { const y = clampY(b[1] * sc); i ? ctx.lineTo(X(ts[i]), y) : ctx.moveTo(X(ts[i]), y); });
        for (let i = band.length - 1; i >= 0; i--) ctx.lineTo(X(ts[i]), clampY(band[i][0] * sc));
        ctx.closePath(); ctx.fill();
      }
      line(ctx, ts, pred.baseline[cfg.key], X, clampY, sc, C.pred, 1.6, [5, 4]);
      if (plan) line(ctx, plan.t.map((d) => pred.t0 + d), plan[cfg.key], X, clampY, sc, C.plan, 2, []);
    }
    // truth
    if (truthOn && hist.length > 1) line(ctx, hist.map((h) => h.t), hist.map((h) => h.tr[cfg.key]), X, clampY, sc, C.truth, 1.2, [2, 3]);
    // telemetry dots
    ctx.fillStyle = C.tm;
    for (const h of hist) if (h.tm && h.tm[cfg.key] !== undefined) {
      ctx.beginPath(); ctx.arc(X(h.t), clampY(h.tm[cfg.key] * sc), 1.6, 0, 6.283); ctx.fill();
    }
    // twin estimate
    if (hist.length > 1) line(ctx, hist.map((h) => h.t), hist.map((h) => h.tw[cfg.key]), X, clampY, sc, C.twin, 2, []);
    // now marker
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.beginPath(); ctx.moveTo(X(now), T); ctx.lineTo(X(now), T + ph); ctx.stroke();

    // title + current value
    ctx.font = "700 10px Orbitron, sans-serif";
    ctx.fillStyle = "#ff9933";
    ctx.fillText(cfg.title, L, 12);
    const last = hist[hist.length - 1];
    if (last) {
      const v = last.tw[cfg.key] * sc;
      ctx.font = "500 12px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "#f4ede4";
      const txt = `${v.toFixed(cfg.key === "soc" ? 0 : 1)}${cfg.unit}`;
      ctx.fillText(txt, L + pw - ctx.measureText(txt).width, 12);
    }
  }
}

function line(ctx, ts, vs, X, Y, sc, color, w, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < ts.length; i++) {
    const v = vs[i];
    if (v === undefined || v === null) continue;
    const x = X(ts[i]), y = Y(v * sc);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    started = true;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export function chartLegend(truthOn = false) {
  return `<span style="color:${C.twin}">━ twin</span> · <span style="color:${C.tm}">● telemetry</span> · <span style="color:${C.pred}">┅ predicted</span> · <span style="color:${C.plan}">━ plan preview</span>${truthOn ? ` · <span style="color:${C.truth}">┄ truth (test harness)</span>` : ""}`;
}
