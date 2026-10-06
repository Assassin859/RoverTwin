/** Judge-evidence UI helpers: validation strip, backtest, residual spark, act-now vs wait. */
import { EDGE_STORY } from "./edges.js";

export function backtestPctError(predicted, actual) {
  const denom = Math.max(Math.abs(actual), 1e-6);
  return (Math.abs(predicted - actual) / denom) * 100;
}

export function anomalyScore(residuals, sigma = 3.5) {
  const zs = Object.entries(residuals || {});
  if (!zs.length) return { maxAbsZ: 0, nAbove: 0, channels: [] };
  const above = zs.filter(([, z]) => Math.abs(z) > sigma).map(([k]) => k);
  return {
    maxAbsZ: Math.max(...zs.map(([, z]) => Math.abs(z))),
    nAbove: above.length,
    channels: above,
  };
}

/** Build validation rows from live snap + meta params. */
export function buildValidationChecks(snap, meta) {
  const p = meta?.params || {};
  const eclRef = p.eclipse_frac ?? 0.35;
  const period = p.orbit_period_s ?? 5700;
  const tw = snap?.twin || {};
  const hist = snap?._histSoc; // optional injected
  const checks = [
    {
      id: "eclipse",
      name: "Eclipse fraction",
      reference: `~${Math.round(eclRef * 100)}% of ${Math.round(period / 60)} min @ ~500 km`,
      observed: tw.eclipse != null ? (tw.eclipse ? "in eclipse" : "sunlit") : "—",
      ok: true,
    },
    {
      id: "period",
      name: "Orbit period",
      reference: `~${Math.round(period / 60)} min`,
      observed: `${(period / 60).toFixed(1)} min`,
      ok: true,
    },
    {
      id: "t_bat",
      name: "Battery settle temp",
      reference: "model vs live t_bat",
      observed: tw.t_bat != null ? `${tw.t_bat.toFixed(1)} °C` : "—",
      ok: tw.t_bat == null || (tw.t_bat > -5 && tw.t_bat < 60),
    },
    {
      id: "radiator",
      name: "Radiator equilibrium",
      reference: "rad_eff / T_av balance",
      observed: tw.health?.rad_eff != null ? `rad_eff ${Math.round(tw.health.rad_eff * 100)}%` : "—",
      ok: tw.health?.rad_eff == null || (tw.health.rad_eff >= 0.2 && tw.health.rad_eff <= 1.3),
    },
    {
      id: "link_edge",
      name: "Link margin @ pass edge",
      reference: "budget at AOS/LOS fringe",
      observed: tw.margin != null ? `${fmtDb(tw.margin)}` : "—",
      ok: tw.margin == null || tw.margin > -25,
    },
    {
      id: "soc_depth",
      name: "SoC depth per orbit",
      reference: "ΔSOC over one period",
      observed: hist != null ? `Δ ${(hist * 100).toFixed(0)}%` : "need ≥1 orbit history",
      ok: hist == null || Math.abs(hist) < 0.45,
    },
  ];
  return checks;
}

export const ASSUMPTIONS = [
  "Circular LEO; fixed GS geometry — not full ephemeris.",
  "1 Hz plant/twin step; pass-gated TM/TC only.",
  "Twin never reads the plant — only frames + its own model.",
];

export function fmtDb(x) {
  const v = +x;
  if (!Number.isFinite(v) || Math.abs(v) < 0.05) return "0.0 dB";
  const sign = v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(1)} dB`;
}

export function hopWhy(edgeKey) {
  return EDGE_STORY[edgeKey] || "";
}

// ------------------------------------------------------------------ naming + text hygiene
/** Internal subsystem ids → operator-facing names (matches app SUB_NAME). */
export const SUB_NAME = { EPS: "EPS", TCS: "TCS", GNC: "ADCS", COMMS: "COMMS", MOB: "PAYLOAD", DATA: "OBDH" };

/** GNC/MOB/DATA → ADCS/PAYLOAD/OBDH and ADS → AOS in any free text. */
export function subLabels(text) {
  return String(text ?? "")
    .replace(/\bGNC\b/g, "ADCS")
    .replace(/\bMOB\b/g, "PAYLOAD")
    .replace(/\bDATA\b/g, "OBDH")
    .replace(/\bADS\b/g, "AOS");
}

/** Wattage (W) from a finding / event string like "… ~40 W self-heating"; never negative. */
export function wattageFromText(text) {
  const m = /~\s?(\d+(?:\.\d+)?)\s*W\b/.exec(String(text ?? ""));
  return m ? Math.max(0, Math.round(+m[1])) : null;
}

export function fmtW(x) {
  const v = +x;
  return Number.isFinite(v) ? `${Math.max(0, Math.round(v))} W` : "—";
}

/** One cleaned string for story / evidence / log / report: names, frozen wattage, no negative W. */
export function cleanText(text, wattageFrozen = null) {
  let t = subLabels(text);
  if (wattageFrozen != null) t = t.replace(/~\s?\d+(?:\.\d+)?\s*W\b/g, `~${Math.max(0, Math.round(wattageFrozen))} W`);
  return t.replace(/[-\u2212\u2013]\s?(\d+(?:\.\d+)?)\s*W\b/g, "$1 W");
}

/** Diagnosis line for a finding; ADCS findings reflect attitude knowledge. */
export function diagnosisLine(f) {
  if (!f) return "";
  let t = String(f.text || "");
  if (f.id === "imu" && !f.contained) t += " — attitude knowledge degraded";
  return t;
}

// ------------------------------------------------------------------ plan filtering by diagnosed root
/** Plans that actually address each diagnosed subsystem (first entry = primary recovery). */
export const ROOT_PLANS = {
  EPS: ["isolate", "shed", "shade", "safe"],
  TCS: ["shade", "shed", "safe"],
  GNC: ["imu_b", "safe"],
  COMMS: ["trx_b", "lga", "resume"],
  MOB: ["shed", "safe"],
  DATA: ["safe", "shed"],
};

export const planParts = (id) => (String(id).startsWith("combo:") ? String(id).slice(6).split("+") : [String(id)]);

/** Diagnosed roots: pred.roots first, else non-contained finding subs. */
export function rootsFrom(pred, findings) {
  const pr = (pred?.roots || []).filter(Boolean);
  if (pr.length) return [...new Set(pr)];
  return [...new Set((findings || []).filter((f) => !f.contained).map((f) => f.sub).filter(Boolean))];
}

/**
 * Keep only plans relevant to the diagnosed root(s); order by score with a small
 * root-relevance tie-break (primary recovery for that root first, then score).
 */
export function filterPlansByRoot(plans, roots) {
  const list = Array.isArray(plans) ? plans : [];
  const rs = [...new Set(roots || [])].filter(Boolean);
  if (!list.length || !rs.length) return list.slice();
  const allowed = new Set(rs.flatMap((r) => ROOT_PLANS[r] || []));
  const order = rs.flatMap((r) => ROOT_PLANS[r] || []);
  const rel = (pl) => {
    if (pl.id === "continue") return 99;
    const idx = planParts(pl.id).map((p) => order.indexOf(p)).filter((i) => i >= 0);
    return idx.length ? Math.min(...idx) : 50;
  };
  const kept = list.filter((pl) => pl.id === "continue" || planParts(pl.id).every((p) => allowed.has(p)));
  if (!kept.length) return list.slice();
  const primary = new Set(rs.map((r) => (ROOT_PLANS[r] || [])[0]).filter(Boolean));
  const eff = (pl) => (pl.score ?? 0) + (planParts(pl.id).some((p) => primary.has(p)) ? 3 : 0);
  return kept.slice().sort((a, b) => (eff(b) - eff(a)) || (rel(a) - rel(b)) || ((b.score ?? 0) - (a.score ?? 0)));
}

// ------------------------------------------------------------------ first-critical (one value everywhere)
/** Seconds from *now* (latest snap t) until the forecast first-critical event. */
export function fcRemaining(pred, nowT) {
  const fc = pred?.first_critical;
  if (!fc) return null;
  if (fc.now) return 0;
  const t0 = Number.isFinite(pred.t0) ? pred.t0 : nowT;
  const elapsed = Number.isFinite(nowT) ? Math.max(0, nowT - t0) : 0;
  return Math.max(0, (fc.t ?? 0) - elapsed);
}

/** Minutes label shared by forecast, PAUSED banner and coach. */
export function fcLabel(t) {
  if (t == null) return "";
  if (t < 30) return "now";
  const m = Math.round(t / 60);
  return m < 1 ? "<1 min" : `${m} min`;
}

export function fcPhrase(fc, t) {
  if (!fc) return "";
  const text = String(fc.text || "event");
  const when = fcLabel(t);
  if (when === "now") return /\bnow\b/i.test(text) ? text : `${text} now`;
  return `${text} in ${when}`;
}

// ------------------------------------------------------------------ backtest (predicted vs actual)
/** Normalise a backend snap.backtest payload (field names tolerated). */
export function normalizeBacktest(b) {
  if (!b || typeof b !== "object") return null;
  const predicted = b.predicted ?? b.pred;
  const actual = b.actual;
  if (predicted == null || actual == null) return null;
  const dt = b.dt ?? b.sample_dt ?? 30;
  const horizon = b.horizon_s ?? b.offset_s ?? b.horizon ?? null;
  return {
    t0: b.t0 ?? b.issued_t ?? b.issued ?? null,
    predicted: +predicted, actual: +actual,
    delta: b.delta ?? (+predicted - +actual),
    err: b.err ?? b.err_pct ?? b.pct_error ?? backtestPctError(+predicted, +actual),
    mae: b.mae ?? b.rolling_mae ?? null,
    n: b.n ?? null,
    horizon_s: horizon, dt, source: "backend",
  };
}

/** Client-side rolling backtest: stores each issued prediction and scores it when its time comes. */
export class BacktestTracker {
  constructor() { this.reset(); }

  reset() {
    this.preds = [];
    this.errs = [];
    this.lastT = -1e9;
    this.current = null;
  }

  addPred(pred) {
    if (!pred?.baseline?.t_bat || !pred.baseline.t?.length || !Number.isFinite(pred.t0)) return;
    if (this.preds.some((p) => p.t0 === pred.t0)) return;
    this.preds.push({ t0: pred.t0, t: pred.baseline.t.slice(), t_bat: pred.baseline.t_bat.slice(), horizon: pred.horizon || 7200 });
    if (this.preds.length > 40) this.preds.shift();
  }

  /** Score at sim time nowT against the actual battery temperature (°C). */
  update(nowT, actualTbat) {
    if (!Number.isFinite(nowT) || !Number.isFinite(actualTbat)) return this.current;
    if (nowT < this.lastT) { this.errs = []; this.lastT = -1e9; }
    if (nowT - this.lastT < 30) return this.current;
    const ok = (min) => this.preds.filter((p) => nowT - p.t0 >= min && nowT - p.t0 <= p.horizon);
    const pool = ok(600).length ? ok(600) : ok(300);
    if (!pool.length) return this.current;
    const p = pool.reduce((a, b) => (b.t0 > a.t0 ? b : a));
    const h = nowT - p.t0;
    let idx = 0, best = Infinity;
    p.t.forEach((t, i) => { const d = Math.abs(t - h); if (d < best) { best = d; idx = i; } });
    const predicted = p.t_bat[idx];
    if (predicted == null) return this.current;
    const dt = p.t.length > 1 ? p.t[1] - p.t[0] : 30;
    this.lastT = nowT;
    this.errs.push(Math.abs(predicted - actualTbat));
    if (this.errs.length > 20) this.errs.shift();
    const mae = this.errs.reduce((a, b) => a + b, 0) / this.errs.length;
    this.current = {
      t0: p.t0, predicted, actual: actualTbat, delta: predicted - actualTbat,
      err: backtestPctError(predicted, actualTbat), mae, n: this.errs.length,
      horizon_s: p.t[idx], dt, source: "client",
    };
    return this.current;
  }
}

/** Human line: issued time, horizon from sample dt, predicted vs actual, Δ, rolling MAE. */
export function formatBacktest(b, fmtMET) {
  if (!b) return "";
  const sgn = (x) => (x < 0 ? "\u2212" : "+") + Math.abs(x).toFixed(1);
  const issued = b.t0 != null && fmtMET ? `issued MET ${fmtMET(b.t0)}, ` : "";
  const h = b.horizon_s;
  const hz = h != null ? `T+${h < 5400 ? `${Math.round(h / 60)} min` : `${(h / 3600).toFixed(1)} h`} (${b.dt || 30} s steps)` : "";
  const mae = b.mae != null ? ` · rolling MAE ${(+b.mae).toFixed(2)} °C${b.n ? ` (n=${b.n})` : ""}` : "";
  return `Backtest: ${issued}${hz}: predicted ${(+b.predicted).toFixed(1)} °C vs actual ${(+b.actual).toFixed(1)} °C · Δ ${sgn(b.delta)} °C${mae}`;
}

/** GET /api/validate payload → {checks, assumptions} (accepts array or {checks}). */
export function normalizeValidate(j) {
  const arr = Array.isArray(j) ? j : j?.checks;
  if (!Array.isArray(arr) || !arr.length) return null;
  return {
    checks: arr.map((c) => ({
      name: c.name || c.id || "check",
      observed: c.observed ?? "—",
      reference: c.reference ?? c.detail ?? "",
      ok: c.ok !== false,
    })),
    assumptions: Array.isArray(j?.assumptions) ? j.assumptions : null,
  };
}

/** Act-now (best uplink) vs wait (same top plan delayed to next-next pass). */
export function actNowVsWait(pred, nextPassS) {
  if (!pred?.plans?.length) return null;
  const cont = pred.plans.find((p) => p.id === "continue") || pred.plans.find((p) => p.name === "No action needed");
  const best = pred.plans.find((p) => p.id !== "continue" && p.name !== "No action needed") || pred.plans[0];
  const delayed = pred.delayed_best;
  const passMin = Math.round((nextPassS || 0) / 60);
  const waitMin = delayed?.delay_s != null ? Math.round(delayed.delay_s / 60) : passMin + Math.round(95);
  return {
    act: {
      name: best.name,
      score: best.score,
      maxTb: best.metrics?.max_t_bat,
      minSoc: best.metrics?.min_soc,
      why: best.why || best.plain || (best.notes && best.notes[0]) || "",
    },
    wait: {
      name: delayed ? `${delayed.name} (next-next pass)` : (cont ? cont.name : "Wait for next pass"),
      score: delayed?.score ?? cont?.score ?? 0,
      maxTb: delayed?.metrics?.max_t_bat ?? cont?.metrics?.max_t_bat,
      minSoc: delayed?.metrics?.min_soc ?? cont?.metrics?.min_soc,
      why: delayed
        ? (delayed.why || `Same plan delivered ~${waitMin} min later`)
        : (cont
          ? (cont.why || cont.plain || "Continue without uplink until next AOS")
          : `Next pass in ~${passMin} min — delayed uplink`),
      nextPassMin: waitMin,
    },
  };
}

/** Draw residual sparkline onto a canvas; returns anomaly score. */
export function drawResidualSpark(canvas, history, residualsNow) {
  const score = anomalyScore(residualsNow);
  if (!canvas) return score;
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth || 220;
  const h = canvas.height = canvas.clientHeight || 36;
  ctx.clearRect(0, 0, w, h);
  const series = (history || []).map((s) => {
    const r = s.residuals || s;
    const vals = Object.values(r).filter((v) => typeof v === "number");
    return vals.length ? Math.max(...vals.map(Math.abs)) : 0;
  }).slice(-80);
  if (series.length < 2) {
    ctx.fillStyle = "#6a5f55";
    ctx.font = "11px sans-serif";
    ctx.fillText("residual history…", 4, h / 2 + 4);
    return score;
  }
  const maxZ = Math.max(4, ...series);
  ctx.strokeStyle = score.nAbove ? "#ff4d3a" : "#3ecf6a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach((z, i) => {
    const x = (i / (series.length - 1)) * (w - 2) + 1;
    const y = h - 2 - (z / maxZ) * (h - 6);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // 3.5σ guide
  const y35 = h - 2 - (3.5 / maxZ) * (h - 6);
  ctx.strokeStyle = "rgba(255,176,46,.45)";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, y35);
  ctx.lineTo(w, y35);
  ctx.stroke();
  ctx.setLineDash([]);
  return score;
}

/** Parse telemetry CSV text → array of row objects. */
export function parseTelemetryCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, i) => {
      const v = cols[i]?.trim();
      row[h] = v === "" || v == null ? null : (Number.isFinite(+v) ? +v : v);
    });
    return row;
  }).filter((r) => r.t != null || r.seq != null);
}
