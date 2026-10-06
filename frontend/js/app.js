import { TwinScene } from "./scene.js";
import { Chart, CHARTS, chartLegend } from "./charts.js";
import { Cascade } from "./cascade.js";
import { Guide } from "./guide.js";
import { EDGE_EQ } from "./edges.js";

const $ = (id) => document.getElementById(id);
export const S = { meta: null, snap: null, history: [], events: [], pred: null, truth: false, preview: null, connected: false, allPlans: false, pauseOnCritical: true, highlightEdges: null, llmKey: "" };
export const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
let lastAnoms = "";
let pausedCritKey = null;
let llmTimer = null;
let llmBusy = false;
const SUBS_ORDER = ["EPS", "TCS", "GNC", "COMMS", "MOB", "DATA"];
const MATRIX_LABEL = { EPS: "P", TCS: "T", GNC: "G", COMMS: "C", MOB: "M", DATA: "D" };

const ICON = { battery: "🔋", thermal: "🌡️", sensor: "🧭", comms: "📡" };
const SHORT_FAULT = { battery: "Battery", thermal: "Overheat", sensor: "Sensor", comms: "Radio" };
const SUB_NAME = { EPS: "POWER", TCS: "THERMAL", GNC: "NAV", COMMS: "COMMS", MOB: "MOBILITY", DATA: "DATA" };
const TICKER_KINDS = new Set(["FAULT", "FDIR", "TWIN", "DIAG", "PRED", "SYNC"]);
const KIND_NAME = { FAULT: "FAULT", FDIR: "ROVER", TWIN: "TWIN", DIAG: "DIAG", PRED: "PRED", CMD: "CMD", SYNC: "LINK", SYS: "SYS" };

// ------------------------------------------------------------------ helpers
export const fmtMET = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
export const fmtDur = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function patch(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// --------------------------------------------------------------- websocket
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "hello") onHello(msg);
    else if (msg.type === "snap") onSnap(msg);
    else if (msg.type === "pred") onPred(msg.pred);
    else if (msg.type === "error") console.warn("server:", msg.error);
  };
}
export function send(op, data = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, ...data }));
}
function setConn(on) {
  S.connected = on;
  const c = $("conn");
  if (c) {
    c.classList.toggle("off", !on);
    c.innerHTML = `Ground segment: <b>${on ? "connected" : "offline — start the server (see README)"}</b>`;
  }
  applyGroundGate();
  if (!on && $("syncPill")) {
    $("syncPill").className = "pill offline";
    $("syncTxt").textContent = "GROUND OFFLINE";
    $("syncSub").textContent = "reconnect WebSocket";
  }
}

function applyGroundGate() {
  const off = !S.connected;
  const tip = off ? "Ground segment offline — start uvicorn (see README)" : "";
  for (const b of document.querySelectorAll("#faults .fbtn, #plans .pbtn.go, #cmds button, #activeFaults [data-clear]")) {
    b.disabled = off;
    if (off) b.title = tip;
    else if (b.dataset.kind && S.meta?.faults?.[b.dataset.kind]) b.title = S.meta.faults[b.dataset.kind].detail;
    else if (b.dataset.clear) b.title = "Remove the fault from the simulated rover (test harness only)";
    else if (!b.dataset.kind) b.removeAttribute("title");
  }
}

function onHello(msg) {
  S.meta = msg.meta;
  S.history = msg.history || [];
  S.events = msg.events || [];
  S.pred = msg.pred;
  S.preview = null;
  S.snap = msg.snap;
  buildStatic();
  $("log").innerHTML = "";
  $("ticker").innerHTML = "";
  S.events.forEach(addLog);
  render();
  renderPred();
  emit("hello", msg);
}

function onSnap(snap) {
  S.snap = snap;
  const last = S.history[S.history.length - 1];
  if (snap.sample && (!last || snap.sample.t > last.t)) {
    S.history.push(snap.sample);
    if (S.history.length > 1500) S.history.shift();
  }
  for (const e of snap.events || []) {
    S.events.push(e);
    addLog(e);
    emit("event", e);
  }
  render();
  emit("snap", snap);
}

function onPred(pred) {
  S.pred = pred;
  renderPred();
  emit("pred", pred);
  const fc = pred?.first_critical;
  if (S.pauseOnCritical && fc && pausedCritKey !== fc.key) {
    pausedCritKey = fc.key;
    send("pause", { value: true });
  }
}

// ------------------------------------------------------------- 3D + charts
const scene = new TwinScene();
scene.mount($("landView"), { interactive: false });
const charts = CHARTS.map((cfg) => new Chart($("ch-" + cfg.key), cfg));
const cascade = new Cascade($("cascade"));

// ------------------------------------------------------------ static parts
const CMDS = [
  ["Mode", "mode", [["NOMINAL", "Nominal"], ["SAFE", "Safe"]], (c) => c.mode],
  ["Drive", "drive", [[true, "Go"], [false, "Stop"]], (c) => c.drive],
  ["Speed", "speed", [[0.5, "50%"], [1, "100%"]], (c) => c.speed_frac],
  ["Payload", "payload", [[true, "On"], [false, "Off"]], (c) => c.payload],
  ["IMU", "imu", [["A", "A"], ["B", "B (spare)"]], (c) => c.imu],
  ["Transponder", "trx", [["A", "A"], ["B", "B (spare)"]], (c) => c.trx],
  ["Antenna", "antenna", [["HGA", "High-gain"], ["LGA", "Low-gain"]], (c) => c.antenna],
  ["Batt. string 2", "bat_isolated", [[false, "Connected"], [true, "Isolated"]], (c) => c.bat_isolated],
  ["Pose", "pose", [["NORMAL", "Normal"], ["SUN", "Sun"], ["SHADE", "Shadow"]], (c) => c.pose],
  ["Relay orbiter", "relay_hp", [[false, "Normal"], [true, "High-gain"]], (c) => c.relay_hp],
];

let built = false;
function buildStatic() {
  if (built) return;
  built = true;
  $("faults").innerHTML = Object.entries(S.meta.faults).map(([k, f]) => `
    <button class="fbtn" data-kind="${k}" title="${esc(f.detail)}"><span class="ic">${ICON[k]}</span>${esc(SHORT_FAULT[k])}</button>`).join("");
  $("sev").addEventListener("input", (e) => { $("sevTxt").textContent = pct(+e.target.value); });
  $("faults").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (b && S.connected) send("inject", { kind: b.dataset.kind, severity: +$("sev").value, ramp: +$("ramp").value });
  });
  $("morePlans").addEventListener("click", () => { S.allPlans = !S.allPlans; renderPred(); });
  document.querySelector("#morePanel .tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) showTab(b.dataset.tab);
  });
  $("activeFaults").addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear]");
    if (b) send("clear", { kind: b.dataset.clear });
  });

  $("cmds").innerHTML = CMDS.map(([label, name, opts]) => `
    <div class="cmd-row"><span>${label}</span><div class="seg">${opts.map(([v, t]) =>
      `<button data-name="${name}" data-value='${JSON.stringify(v)}'>${t}</button>`).join("")}</div></div>`).join("");
  $("cmds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-name]");
    if (b && S.connected) send("cmd", { name: b.dataset.name, value: JSON.parse(b.dataset.value) });
  });

  $("plans").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.closest(".plan").dataset.id;
    if (b.dataset.act === "run") {
      if (!S.connected) return;
      send("plan", { id });
      S.preview = null;
    } else S.preview = S.preview === id ? null : id;
    renderPred();
    drawCharts();
  });
  applyGroundGate();
}

// ------------------------------------------------------------------ render
const SUBS = {
  EPS: (tw, h, tr) => [["Charge", pct(tw.soc), tr && pct(tr.soc)],
    ["Net", `${tw.i_bat >= 0 ? "+" : ""}${(tw.i_bat * tw.v_bus).toFixed(0)} W`]],
  TCS: (tw, h, tr) => [["Avionics", `${tw.t_av.toFixed(0)}°C`, tr && `${tr.t_av.toFixed(0)}°C`],
    ["Battery", `${tw.t_bat.toFixed(0)}°C`, tr && `${tr.t_bat.toFixed(0)}°C`]],
  GNC: (tw, h, tr) => [["Pointing", `${tw.att_err.toFixed(1)}°`, tr && `${tr.att_err.toFixed(1)}°`],
    ["Gyro", tw.cfg.imu === "A" ? "IMU-A" : "IMU-B"]],
  COMMS: (tw, h, tr) => [["Link", tw.down_ok ? `${tw.margin.toFixed(0)} dB` : tw.searching ? "searching" : "lost",
    tr && `${Math.max(tr.margin, -60).toFixed(0)} dB`], ["Radio", `TRX-${tw.cfg.trx}`]],
  MOB: (tw) => [["Speed", `${(tw.v * 100).toFixed(0)} cm/s`],
    ["Drive", tw.cfg.mode === "SAFE" ? "safe hold" : tw.cfg.drive ? "on" : tw.cfg.pose === "NORMAL" ? "stopped" : "parked"]],
  DATA: (tw) => [["Buffer", pct(tw.buffer_mb / S.meta.buffer_cap)],
    ["Science", tw.cfg.payload && tw.cfg.mode !== "SAFE" ? "on" : "off"]],
};

function tileTag(s) {
  if (s.root) return `<div class="tagline root">ROOT CAUSE</div>`;
  if (!s.cause) return "";
  if (s.cause.startsWith("fault contained")) return `<div class="tagline ok">contained</div>`;
  const via = (s.cause.match(/via ([^:]+)/) || [])[1];
  if (via) return `<div class="tagline knock" title="${esc(s.cause)}">via ${esc(via.trim())}</div>`;
  const src = (s.cause.match(/from (\w+)/) || [])[1];
  return `<div class="tagline knock">hit by ${SUB_NAME[src] || src}</div>`;
}

export function showTab(id) {
  for (const b of document.querySelectorAll("#morePanel [data-tab]")) b.classList.toggle("on", b.dataset.tab === id);
  for (const p of document.querySelectorAll("#morePanel .tab-pane")) p.classList.toggle("on", p.id === id);
}

function render() {
  const sn = S.snap;
  if (!sn || !S.meta) return;
  const tw = sn.twin, h = tw.health, tr = S.truth ? sn.truth : null;
  scene.truthOn = S.truth;
  scene.setState(tw, sn.truth, sn.speed);

  // top bar
  $("met").textContent = "MET " + fmtMET(sn.t);
  if (S.connected) {
    const sy = sn.sync;
    const syncCls = { SYNCED: "ok", "LOW RATE": "warn", INIT: "warn", BLIND: "bad" }[sy.state];
    $("syncPill").className = "pill " + syncCls;
    $("syncTxt").textContent = sy.state === "BLIND" ? "TWIN BLIND" : `TWIN ${sy.state}`;
    $("syncSub").textContent = sy.age == null || sy.state === "SYNCED" ? "" : sy.state === "BLIND"
      ? `no telemetry for ${fmtDur(sy.age)}`
      : `${sy.rate.toFixed(0)} kbps`;
  }
  const sy = sn.sync;
  const mode = tw.dead ? "NO POWER" : tw.cfg.mode === "SAFE" ? (tw.auto_safe ? `SAFE · auto: ${tw.auto_safe}` : "SAFE MODE") : "NOMINAL OPS";
  $("modePill").className = "pill " + (tw.dead ? "bad" : tw.cfg.mode === "SAFE" ? "warn" : "ok");
  $("modeTxt").textContent = mode;
  for (const b of $("speed").children) {
    const v = b.dataset.v;
    b.classList.toggle("on", v === "pause" ? sn.paused : !sn.paused && +v === sn.speed);
  }

  // subsystems
  const subs = Object.fromEntries(sn.subsystems.map((s) => [s.id, s]));
  patch($("subs"), Object.entries(SUBS).map(([id, kv]) => {
    const s = subs[id];
    return `<div class="sub ${s.status}" title="${esc(s.cause || "")}"><div class="sub-h"><b>${SUB_NAME[id]}</b><span class="score">${s.score}</span></div>
      <div class="kv">${kv(tw, h, tr).map(([k, v, t]) => `<div><span>${k}</span><span>${v}${t ? `<span class="tr">${t}</span>` : ""}</span></div>`).join("")}</div>${tileTag(s)}</div>`;
  }).join(""));

  // diagnosis
  const pr = sn.prognostics;
  const batFound = sn.findings.some((f) => f.sub === "EPS");
  const progTail = tw.cfg.bat_isolated ? "running on the healthy string only"
    : pr.rul_days > 0 ? `about ${pr.rul_days > 3650 ? "10+ years" : Math.round(pr.rul_days) + " days"} until 50% capacity` : "already below 50% capacity";
  patch($("diag"), (sn.findings.length
    ? sn.findings.map((f) => `<div class="diag-item${f.contained ? " contained" : ""}">${esc(f.text)}<small>${SUB_NAME[f.sub]} · ${pct(f.conf)} sure${f.contained ? ` · contained: ${esc(f.contained)}` : ""}</small></div>`).join("")
    : `<div class="diag-none">Nothing wrong. Every telemetry frame matches the twin's model.</div>`)
    + `<div class="note">Knock-ons are correlated through the live model edges — not separate gauges.</div>`
    + (batFound ? `<div class="note">Battery outlook: ${pct(pr.capacity)} capacity, ${progTail}.</div>` : ""));

  // residuals
  const anoms = new Set(sn.anomalies);
  patch($("resid"), Object.entries(S.meta.residuals).map(([k, label]) => {
    const z = sn.residuals[k] ?? 0, c = Math.max(-10, Math.min(10, z));
    const left = c < 0 ? 50 + c * 5 : 50, width = Math.abs(c) * 5;
    return `<div class="res-row ${anoms.has(k) ? "alarm" : ""}"><span>${label}</span><div class="res-bar"><i style="left:${left}%;width:${width}%"></i></div><span>${z >= 0 ? "+" : ""}${z.toFixed(1)}σ</span></div>`;
  }).join("") + `<div class="note">How far the telemetry departs from what the twin expected. Above 3.5σ the twin flags an anomaly; the bar shrinks back once it has worked out the cause.${S.truth ? "" : " Tick “Show truth” to compare its health estimates with the hidden real values."}</div>`);
  patch($("estimates"), S.truth ? estimatesTable(h, sn.truth.health, tw.cfg) : "");
  $("modelDot").classList.toggle("hidden", !anoms.size);
  const anomsKey = [...anoms].sort().join(",");
  if (anoms.size && anomsKey !== lastAnoms) {
    lastAnoms = anomsKey;
    showTab("residPanel");
  }
  if (!anoms.size) lastAnoms = "";

  const corr = sn.correlations || { matrix: {}, paths: [], active: [] };
  const hi = S.highlightEdges || corr.active;
  cascade.setHighlight(S.highlightEdges);
  cascade.update(sn.couplings, sn.subsystems, corr.active);
  renderCorrTable(corr, hi);
  renderCorrMatrix(corr.matrix, hi);
  scheduleExplain(sn, corr);

  // view chips
  const chips = [
    `<span class="pill ${tw.v > 0.001 ? "ok" : "warn"}"><span class="dot"></span>${tw.v > 0.001 ? `driving ${(tw.v * 100).toFixed(0)} cm/s` : "stationary"}</span>`,
    `<span class="pill ${tw.down_ok ? "ok" : "bad"}"><span class="dot"></span>${tw.down_ok ? `link ${tw.margin.toFixed(0)} dB` : "no link"}</span>`,
  ];
  if (sy.state === "BLIND") chips.push(`<span class="pill bad"><span class="dot"></span>no telemetry: showing the twin's own prediction</span>`);
  if (S.truth) chips.push(`<span class="pill" style="color:var(--cyan)">wireframe = hidden truth</span>`);
  patch($("viewChips"), chips.join(""));
  patch($("chartLegend"), chartLegend(S.truth));
  applyGroundGate();

  // commands
  for (const b of $("cmds").querySelectorAll("[data-name]")) {
    const def = CMDS.find((c) => c[1] === b.dataset.name);
    b.classList.toggle("on", def[3](tw.cfg) === JSON.parse(b.dataset.value));
  }
  patch($("pending"), sn.commands.slice().reverse().map((c) => {
    const st = c.status.startsWith("waiting") ? "waiting" : c.status;
    return `<div><span>#${c.id} ${esc(c.name)} = ${esc(JSON.stringify(c.value))}</span><span class="st ${st}">${esc(c.status)}</span></div>`;
  }).join(""));

  // active faults
  patch($("activeFaults"), sn.faults.map((f) => `<div class="af">${ICON[f.kind]} <span>${esc(S.meta.faults[f.kind].name)}</span>
    <div class="bar"><i style="width:${Math.round(f.level * 100)}%"></i></div><span class="num">${pct(f.level)}</span>
    <button data-clear="${f.kind}" title="Remove the fault from the simulated rover (test harness only)">clear</button></div>`).join(""));

  drawCharts();
}

function estimatesTable(est, tru, cfg) {
  const rows = [
    ["Capacity", est.bat_capacity_frac, tru.bat_capacity_frac, 0.05, (v) => pct(v)],
    ["Resistance", est.bat_r_mult, tru.bat_r_mult, 0.3, (v) => `x${v.toFixed(2)}`],
    ["Internal short", est.bat_leak_w, tru.bat_leak_w, 3, (v) => `${v.toFixed(1)} W`],
    ["Radiator", est.rad_eff, tru.rad_eff, 0.06, (v) => pct(v)],
    ["IMU-A bias", est.imu_a_bias, tru.imu_a_bias, 0.01, (v) => `${v.toFixed(3)}°/s`],
    ["TRX-A loss", est.trx_a_loss_db, tru.trx_a_loss_db, 3, (v) => `${v.toFixed(1)} dB`],
  ];
  const ok = (a, b, tol) => Math.abs(a - b) <= Math.max(0.12 * Math.abs(b), tol);
  return `<table class="est"><tr><th>Health parameter</th><th>Twin estimate</th><th>Truth</th></tr>${rows.map(([n, e, t, tol, f]) =>
    `<tr><td style="font-family:inherit">${n}</td><td class="${ok(e, t, tol) ? "ok" : "off"}">${f(e)}</td><td>${f(t)}</td></tr>`).join("")}</table>
    <div class="note">Truth is hidden from the twin: it only sees telemetry. ${cfg.bat_isolated ? "Battery parameters frozen while string 2 is isolated." : ""}</div>`;
}

function renderCorrTable(corr, hi) {
  const paths = corr.paths || [];
  const hiSet = new Set(hi || []);
  if (!paths.length) {
    patch($("corrTable"), `<div class="note">No active root-cause paths. Inject a fault to light cause→effect correlations.</div>`);
    return;
  }
  const rows = paths.slice(0, 8).map((p) => {
    const edges = p.edges || [];
    const chain = [p.from, ...(p.via || []), p.to].map((x) => SUB_NAME[x] || x).join(" → ");
    const on = edges.length && edges.every((e) => hiSet.has(e));
    const eq = EDGE_EQ[edges[edges.length - 1]] || "";
    return `<tr data-edges="${esc(edges.join("|"))}" class="${on ? "on" : ""}">
      <td>${esc(SUB_NAME[p.from] || p.from)}</td>
      <td>${esc(chain)}</td>
      <td class="str">${p.strength.toFixed(2)}</td>
      <td class="eq" title="${esc(eq)}">${esc(p.label)}</td></tr>`;
  }).join("");
  patch($("corrTable"), `<table><thead><tr><th>Root</th><th>Path</th><th>Str</th><th>Effect</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderCorrMatrix(matrix, hi) {
  const hiSet = new Set(hi || []);
  if (!matrix || !Object.keys(matrix).length) {
    patch($("corrMatrix"), "");
    return;
  }
  const cells = [`<div class="mh"></div>` + SUBS_ORDER.map((b) => `<div class="mh">${MATRIX_LABEL[b]}</div>`).join("")];
  for (const a of SUBS_ORDER) {
    cells.push(`<div class="mh">${MATRIX_LABEL[a]}</div>`);
    for (const b of SUBS_ORDER) {
      const s = matrix[a]?.[b] || 0;
      const key = `${a}>${b}`;
      const hot = s >= 0.12;
      const alpha = Math.min(1, s);
      const bg = hot ? `rgba(255,153,51,${0.15 + 0.75 * alpha})` : "rgba(255,255,255,.04)";
      cells.push(`<div class="cell${hiSet.has(key) ? " on" : ""}${hot ? " hot" : ""}" data-edge="${key}" style="background:${bg}" title="${key} · ${s.toFixed(2)}">${hot ? s.toFixed(1) : ""}</div>`);
    }
  }
  patch($("corrMatrix"), `<div style="display:grid;grid-template-columns:18px repeat(6,1fr);gap:1px">${cells.join("")}</div>`);
}

function scheduleExplain(sn, corr) {
  const key = JSON.stringify({
    f: (sn.findings || []).map((x) => x.id + (x.contained || "")),
    a: corr.active || [],
  });
  if (key === S.llmKey) return;
  S.llmKey = key;
  clearTimeout(llmTimer);
  llmTimer = setTimeout(() => fetchExplain(false), 2500);
}

async function fetchExplain(manual) {
  if (llmBusy) return;
  llmBusy = true;
  const note = $("llmNote");
  if (note) {
    note.classList.add("busy");
    note.textContent = manual ? "Asking local qwen2.5:3b…" : "Updating operator note…";
  }
  try {
    const r = await fetch("/api/llm/explain", { method: "POST" });
    const j = await r.json();
    if (note) {
      note.classList.remove("busy");
      note.textContent = j.text || "No explanation.";
    }
    const badge = $("llmBadge");
    if (badge) badge.textContent = j.ok ? `local ${j.model}` : (j.text?.startsWith("Ollama") ? "Ollama offline" : `local ${j.model || "llm"} (fallback)`);
  } catch {
    if (note) {
      note.classList.remove("busy");
      note.textContent = "Could not reach /api/llm/explain — twin correlations still work without the LLM.";
    }
  } finally {
    llmBusy = false;
  }
}

async function refreshLlmStatus() {
  try {
    const j = await (await fetch("/api/llm/status")).json();
    const badge = $("llmBadge");
    if (!badge) return;
    badge.textContent = j.ok && j.model_ready ? `Ollama ready · ${j.model}` : j.ok ? `Ollama up · pull ${j.model}` : "Ollama offline — correlations still work";
  } catch {
    const badge = $("llmBadge");
    if (badge) badge.textContent = "Ollama offline — correlations still work";
  }
}

function drawCharts() {
  if (!S.snap) return;
  const plan = S.preview && S.pred ? S.pred.plans.find((p) => p.id === S.preview)?.series : null;
  for (const c of charts) c.draw({ history: S.history, now: S.snap.t, pred: S.pred, plan, truthOn: S.truth });
}

let planIds = "";
function renderPred() {
  const p = S.pred;
  if (!p || !S.snap) { patch($("impact"), `<div class="impact-sub">Waiting for the first prediction…</div>`); return; }
  const fc = p.first_critical;
  const evs = [...p.events.map((e) => ({ ...e })), ...p.fdir].sort((a, b) => a.t - b.t);
  patch($("impact"), `
    <div class="impact-head ${fc ? "bad" : "ok"}">${fc ? `${esc(fc.text)} in ${fmtDur(fc.t)}` : "All clear for the next 2 hours"}</div>
    ${evs.length ? evs.slice(0, 4).map((e) => `<div class="ev ${e.level}"><span>in ${fmtDur(e.t)}</span><span>${e.level === "info" ? "Rover reacts: " : ""}${esc(e.text)}</span></div>`).join("") : `<div class="note">The twin expects the rover to stay healthy.</div>`}`);

  const tw = S.snap.twin;
  const ids = p.plans.map((x) => x.id).join(",");
  const box = $("plans");
  if (ids !== planIds) {
    planIds = ids;
    box.innerHTML = p.plans.map((pl) => `<div class="plan" data-id="${esc(pl.id)}">
      <div class="plan-h"><span class="rk badge hidden">BEST</span><b>${esc(pl.name)}</b><span class="sc"></span></div>
      <div class="scorebar"><i></i></div><div class="notes"></div>
      <div class="acts"><button class="pbtn" data-act="preview">Preview</button><button class="pbtn go" data-act="run">Execute</button><span class="up badge warn hidden">uplink down: queued</span></div></div>`).join("");
  }
  const shown = S.allPlans ? p.plans.length : 3;
  p.plans.forEach((pl, i) => {
    const el = box.querySelector(`[data-id="${CSS.escape(pl.id)}"]`);
    if (!el) return;
    const m = pl.metrics;
    el.classList.toggle("hidden", i >= shown && S.preview !== pl.id);
    el.title = `${pl.plain}\nLowest charge ${pct(m.min_soc)} · battery peak ${m.max_t_bat.toFixed(0)}°C · avionics peak ${m.max_t_av.toFixed(0)}°C · link up ${pct(m.link_frac)}`;
    el.classList.toggle("best", i === 0 && pl.id !== "continue");
    el.classList.toggle("preview", S.preview === pl.id);
    el.querySelector(".rk").classList.toggle("hidden", !(i === 0 && pl.id !== "continue"));
    el.querySelector(".sc").textContent = pl.score.toFixed(0);
    el.querySelector(".scorebar i").style.width = `${Math.max(0, Math.min(100, pl.score))}%`;
    patch(el.querySelector(".notes"), pl.notes.slice(0, 2).map((n) => `<span class="${n === "all limits respected" ? "good" : ""}">${esc(n)}</span>`).join(""));
    el.querySelector("[data-act=preview]").classList.toggle("on", S.preview === pl.id);
    el.querySelector("[data-act=run]").classList.toggle("hidden", pl.id === "continue");
    el.querySelector(".up").classList.toggle("hidden", !(pl.needs_uplink && !tw.up_ok));
  });
  const more = $("morePlans");
  more.classList.toggle("hidden", p.plans.length <= 3);
  more.textContent = S.allPlans ? "Show fewer" : `Show all ${p.plans.length} options`;
}

function addLog(e) {
  const d = document.createElement("div");
  d.className = "le " + e.kind;
  d.innerHTML = `<span class="tm">${fmtMET(e.t)}</span><span class="k">${KIND_NAME[e.kind] || e.kind}</span><span>${esc(e.text)}</span>`;
  const log = $("log");
  log.prepend(d);
  while (log.children.length > 300) log.lastChild.remove();
  if (TICKER_KINDS.has(e.kind) && !(e.kind === "TWIN" && !e.text.startsWith("Anomaly"))) {
    const t = document.createElement("div");
    t.className = "tk " + e.kind;
    const text = e.text.replace(/^\[test harness\] /, "").replace(/ \((confidence|residual) [^)]*\)$/, "");
    t.innerHTML = `<b>${KIND_NAME[e.kind]}</b>${esc(text)}`;
    t.title = e.text;
    const tk = $("ticker");
    tk.append(t);
    while (tk.children.length > 2) tk.firstChild.remove();
  }
}

// ------------------------------------------------------------- navigation
function showConsole() {
  $("landing").classList.remove("on");
  $("console").classList.add("on");
  scene.mount($("view"), { interactive: true });
  render();
  renderPred();
}
function showLanding() {
  guide.stop();
  $("console").classList.remove("on");
  $("landing").classList.add("on");
  scene.mount($("landView"), { interactive: false });
}
$("goConsole").onclick = showConsole;
$("goGuide").onclick = () => { showConsole(); guide.start(); };
$("home").onclick = showLanding;
$("guideBtn").onclick = () => guide.start();
$("resetBtn").onclick = () => { pausedCritKey = null; S.llmKey = ""; S.highlightEdges = null; send("reset"); };
$("truth").onchange = (e) => { S.truth = e.target.checked; render(); };
$("pauseCrit").onchange = (e) => { S.pauseOnCritical = e.target.checked; if (!e.target.checked) pausedCritKey = null; };
$("explainBtn").onclick = () => { S.llmKey = ""; fetchExplain(true); };
$("corrTable").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-edges]");
  if (!tr) return;
  const edges = tr.dataset.edges.split("|").filter(Boolean);
  S.highlightEdges = S.highlightEdges && edges.join() === S.highlightEdges.join() ? null : edges;
  render();
});
$("corrMatrix").addEventListener("click", (e) => {
  const c = e.target.closest("[data-edge]");
  if (!c) return;
  const key = c.dataset.edge;
  S.highlightEdges = S.highlightEdges && S.highlightEdges[0] === key && S.highlightEdges.length === 1 ? null : [key];
  render();
});
$("speed").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.v === "pause") send("pause", { value: !S.snap?.paused });
  else { send("pause", { value: false }); send("speed", { value: +b.dataset.v }); }
};

const guide = new Guide({ S, bus, send, showConsole });
addEventListener("resize", drawCharts);
refreshLlmStatus();
connect();
