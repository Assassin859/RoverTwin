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
  const ax = Math.abs(+x);
  if (ax < 0.05) return "0.0 dB";
  return `${ax.toFixed(1)} dB`;
}

export function hopWhy(edgeKey) {
  return EDGE_STORY[edgeKey] || "";
}

/** Act-now (best uplink) vs wait (continue / next pass). */
export function actNowVsWait(pred, nextPassS) {
  if (!pred?.plans?.length) return null;
  const cont = pred.plans.find((p) => p.id === "continue") || pred.plans.find((p) => p.name === "No action needed");
  const best = pred.plans.find((p) => p.id !== "continue" && p.name !== "No action needed") || pred.plans[0];
  const passMin = Math.round((nextPassS || 0) / 60);
  return {
    act: {
      name: best.name,
      score: best.score,
      maxTb: best.metrics?.max_t_bat,
      minSoc: best.metrics?.min_soc,
      why: best.why || best.plain || (best.notes && best.notes[0]) || "",
    },
    wait: {
      name: cont ? cont.name : "Wait for next pass",
      score: cont?.score ?? 0,
      maxTb: cont?.metrics?.max_t_bat,
      minSoc: cont?.metrics?.min_soc,
      why: cont
        ? (cont.why || cont.plain || "Continue without uplink until next AOS")
        : `Next pass in ~${passMin} min — delayed uplink`,
      nextPassMin: passMin,
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
