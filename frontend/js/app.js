import { TwinScene } from "./scene.js";
import { Chart, CHARTS, chartLegend } from "./charts.js";
import { Cascade } from "./cascade.js";
import { Guide } from "./guide.js";

const $ = (id) => document.getElementById(id);
export const S = { meta: null, snap: null, history: [], events: [], pred: null, truth: false, preview: null, connected: false };
export const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

const ICON = { battery: "🔋", thermal: "🌡️", sensor: "🧭", comms: "📡" };
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
  c.classList.toggle("off", !on);
  c.innerHTML = `Ground segment: <b>${on ? "connected" : "offline, start the server (see README)"}</b>`;
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
    <div class="fault">
      <span class="ic">${ICON[k]}</span><b>${esc(f.name)}</b>
      <button class="ibtn" data-kind="${k}">Inject</button>
      <p>${esc(f.detail)}</p>
      <div class="ctl"><input type="range" min="0.2" max="1" step="0.05" value="0.85" data-sev="${k}" aria-label="${esc(f.name)} severity"><span class="sv" id="sv-${k}">85%</span></div>
    </div>`).join("");
  $("faults").addEventListener("input", (e) => {
    const k = e.target.dataset.sev;
    if (k) $("sv-" + k).textContent = pct(+e.target.value);
  });
  $("faults").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    const sev = +document.querySelector(`[data-sev="${b.dataset.kind}"]`).value;
    send("inject", { kind: b.dataset.kind, severity: sev, ramp: +$("ramp").value });
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
    if (b) send("cmd", { name: b.dataset.name, value: JSON.parse(b.dataset.value) });
  });

  $("plans").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.closest(".plan").dataset.id;
    if (b.dataset.act === "run") { send("plan", { id }); S.preview = null; }
    else S.preview = S.preview === id ? null : id;
    renderPred();
    drawCharts();
  });
}

// ------------------------------------------------------------------ render
const SUBS = {
  EPS: ["Electrical power", (tw, h, tr) => [
    ["Charge", pct(tw.soc), tr && pct(tr.soc)], ["Bus", `${tw.v_bus.toFixed(1)} V`],
    ["Solar", `${tw.p_sol.toFixed(0)} W`], ["Load", `${tw.p_load.toFixed(0)} W`],
    ["Battery", `${tw.i_bat >= 0 ? "+" : ""}${(tw.i_bat * tw.v_bus).toFixed(0)} W`],
    ["Capacity", tw.cfg.bat_isolated ? "50% (1 string)" : pct(h.bat_capacity_frac)]]],
  TCS: ["Thermal control", (tw, h, tr) => [
    ["Avionics", `${tw.t_av.toFixed(1)}°C`, tr && `${tr.t_av.toFixed(1)}°`], ["Battery", `${tw.t_bat.toFixed(1)}°C`, tr && `${tr.t_bat.toFixed(1)}°`],
    ["Heaters", `${tw.heaters.toFixed(0)} W`], ["Radiator", pct(h.rad_eff)]]],
  GNC: ["Navigation & attitude", (tw, h, tr) => [
    ["Attitude err", `${tw.att_err.toFixed(1)}°`, tr && `${tr.att_err.toFixed(1)}°`], ["Nav drift", `${tw.nav_err.toFixed(1)} m`],
    ["Active IMU", tw.cfg.imu], ["IMU-A bias", `${h.imu_a_bias.toFixed(3)}°/s`]]],
  COMMS: ["Relay link", (tw, h, tr) => [
    ["Margin", `${Math.max(tw.margin, -60).toFixed(1)} dB`, tr && `${Math.max(tr.margin, -60).toFixed(0)}`], ["Rate", `${tw.rate.toFixed(0)} kbps`],
    ["Radio", `TRX-${tw.cfg.trx} · ${tw.cfg.antenna}`], ["Link", tw.searching ? "searching" : tw.down_ok ? "locked" : "no signal"]]],
  MOB: ["Mobility", (tw) => [
    ["Speed", `${(tw.v * 100).toFixed(1)} cm/s`], ["Odometer", `${tw.odometer.toFixed(0)} m`],
    ["Drive", tw.cfg.mode === "SAFE" ? "safe hold" : tw.cfg.drive ? "on" : "stopped"], ["Pose", tw.cfg.pose.toLowerCase()]]],
  DATA: ["Science data", (tw) => [
    ["Buffer", `${tw.buffer_mb.toFixed(1)}/${S.meta.buffer_cap} MB`], ["Payload", tw.cfg.payload && tw.cfg.mode !== "SAFE" ? "on" : "off"]]],
};

function render() {
  const sn = S.snap;
  if (!sn || !S.meta) return;
  const tw = sn.twin, h = tw.health, tr = S.truth ? sn.truth : null;
  scene.truthOn = S.truth;
  scene.setState(tw, sn.truth, sn.speed);

  // top bar
  $("met").textContent = "MET " + fmtMET(sn.t);
  const sy = sn.sync;
  const syncCls = { SYNCED: "ok", "LOW RATE": "warn", INIT: "warn", BLIND: "bad" }[sy.state];
  $("syncPill").className = "pill " + syncCls;
  $("syncTxt").textContent = sy.state === "BLIND" ? "TWIN BLIND" : `TWIN ${sy.state}`;
  $("syncSub").textContent = sy.age == null ? "" : sy.state === "BLIND"
    ? `no telemetry for ${fmtDur(sy.age)}`
    : `frame #${sy.seq} · ${sy.age.toFixed(0)} s ago · ${sy.rate.toFixed(0)} kbps`;
  const mode = tw.dead ? "NO POWER" : tw.cfg.mode === "SAFE" ? (tw.auto_safe ? `SAFE · auto: ${tw.auto_safe}` : "SAFE MODE") : "NOMINAL OPS";
  $("modePill").className = "pill " + (tw.dead ? "bad" : tw.cfg.mode === "SAFE" ? "warn" : "ok");
  $("modeTxt").textContent = mode;
  for (const b of $("speed").children) {
    const v = b.dataset.v;
    b.classList.toggle("on", v === "pause" ? sn.paused : !sn.paused && +v === sn.speed);
  }

  // subsystems
  const subs = Object.fromEntries(sn.subsystems.map((s) => [s.id, s]));
  patch($("subs"), Object.entries(SUBS).map(([id, [full, kv]]) => {
    const s = subs[id];
    const tag = s.root ? `<div class="tagline root">ROOT CAUSE</div>` : s.cause ? `<div class="tagline knock">${esc(s.cause)}</div>` : "";
    return `<div class="sub ${s.status}"><div class="sub-h"><b>${id}</b><span class="full">${full}</span><span class="score">${s.score}</span></div>
      <div class="kv">${kv(tw, h, tr).map(([k, v, t]) => `<div><span>${k}</span><span>${v}${t ? `<span class="tr">${t}</span>` : ""}</span></div>`).join("")}</div>${tag}</div>`;
  }).join(""));

  // diagnosis
  const pr = sn.prognostics;
  const knock = sn.subsystems.filter((s) => s.cause && !s.cause.startsWith("fault contained"));
  const progTail = sn.twin.cfg.bat_isolated ? ", running on the healthy string only"
    : pr.rul_days > 0 ? `, ~${pr.rul_days > 3650 ? ">10 yr" : Math.round(pr.rul_days) + " days"} to 50%` : ", already below 50%";
  patch($("diag"), (sn.findings.length
    ? sn.findings.map((f) => `<div class="diag-item${f.contained ? " contained" : ""}">${esc(f.text)}<small>${f.sub} · confidence ${pct(f.conf)}${f.contained ? ` · CONTAINED: ${esc(f.contained)}` : ""}</small></div>`).join("")
    : `<div class="diag-none">No fault diagnosed: all telemetry is explained by the nominal model.</div>`)
    + (knock.length ? knock.map((s) => `<div class="note">${s.id}: ${esc(s.cause)}</div>`).join("") : "")
    + `<div class="note">Battery prognosis: ${pct(pr.capacity)} capacity, ageing ${pr.fade_pct_day.toFixed(2)}%/day at current temperature${progTail}.</div>`);

  // residuals
  const anoms = new Set(sn.anomalies);
  patch($("resid"), Object.entries(S.meta.residuals).map(([k, label]) => {
    const z = sn.residuals[k] ?? 0, c = Math.max(-10, Math.min(10, z));
    const left = c < 0 ? 50 + c * 5 : 50, width = Math.abs(c) * 5;
    return `<div class="res-row ${anoms.has(k) ? "alarm" : ""}"><span>${label}</span><div class="res-bar"><i style="left:${left}%;width:${width}%"></i></div><span>${z >= 0 ? "+" : ""}${z.toFixed(1)}σ</span></div>`;
  }).join("") + `<div class="note">Bars show how far telemetry departs from what the twin predicted. Above 3.5σ is an anomaly; it collapses once the estimator explains the fault.</div>`);
  patch($("estimates"), S.truth ? estimatesTable(h, sn.truth.health, tw.cfg) : "");

  cascade.update(sn.couplings, sn.subsystems);

  // view chips
  const chips = [
    `<span class="pill ${tw.v > 0.001 ? "ok" : "warn"}"><span class="dot"></span>${tw.v > 0.001 ? `driving ${(tw.v * 100).toFixed(0)} cm/s` : "stationary"}</span>`,
    `<span class="pill ${tw.down_ok ? "ok" : "bad"}"><span class="dot"></span>${tw.down_ok ? `link ${tw.margin.toFixed(0)} dB` : "no link"}</span>`,
  ];
  if (sy.state === "BLIND") chips.push(`<span class="pill bad"><span class="dot"></span>no telemetry: showing the twin's own prediction</span>`);
  if (S.truth) chips.push(`<span class="pill" style="color:var(--cyan)">wireframe = hidden truth</span>`);
  patch($("viewChips"), chips.join(""));
  patch($("viewLegend"), `${chartLegend()}<br>Drag to orbit · scroll to zoom`);

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
    <div class="impact-head ${fc ? "bad" : "ok"}">${fc ? `${esc(fc.text)} in ${fmtDur(fc.t)}` : "No limit violations predicted in the next 2 h"}</div>
    <div class="impact-sub">5-member ensemble on the twin's estimated health · onboard autonomy included</div>
    ${evs.length ? evs.slice(0, 10).map((e) => `<div class="ev ${e.level}"><span>T+${fmtDur(e.t)}</span><span>${e.level === "info" ? "Rover autonomy: " : ""}${esc(e.text)}</span></div>`).join("") : `<div class="note">The twin expects the rover to stay healthy.</div>`}`);

  const tw = S.snap.twin;
  const ids = p.plans.map((x) => x.id).join(",");
  const box = $("plans");
  if (ids !== planIds) {
    planIds = ids;
    box.innerHTML = p.plans.map((pl) => `<div class="plan" data-id="${esc(pl.id)}">
      <div class="plan-h"><span class="rk badge hidden">BEST</span><b>${esc(pl.name)}</b><span class="sc"></span></div>
      <div class="scorebar"><i></i></div><div class="meta"></div><div class="notes"></div>
      <div class="acts"><button class="pbtn" data-act="preview">Preview</button><button class="pbtn go" data-act="run">Execute</button><span class="up badge warn hidden">uplink down: queued</span></div></div>`).join("");
  }
  p.plans.forEach((pl, i) => {
    const el = box.querySelector(`[data-id="${CSS.escape(pl.id)}"]`);
    if (!el) return;
    const m = pl.metrics;
    el.classList.toggle("best", i === 0 && pl.id !== "continue");
    el.classList.toggle("preview", S.preview === pl.id);
    el.querySelector(".rk").classList.toggle("hidden", !(i === 0 && pl.id !== "continue"));
    el.querySelector(".sc").textContent = pl.score.toFixed(0);
    el.querySelector(".scorebar i").style.width = `${Math.max(0, Math.min(100, pl.score))}%`;
    el.querySelector(".meta").textContent = `min SOC ${pct(m.min_soc)} · batt ${m.max_t_bat.toFixed(0)}°C · avio ${m.max_t_av.toFixed(0)}°C · link ${pct(m.link_frac)}`;
    patch(el.querySelector(".notes"), pl.notes.map((n) => `<span class="${n === "all limits respected" ? "good" : ""}">${esc(n)}</span>`).join(""));
    el.querySelector("[data-act=preview]").classList.toggle("on", S.preview === pl.id);
    el.querySelector("[data-act=run]").classList.toggle("hidden", pl.id === "continue");
    el.querySelector(".up").classList.toggle("hidden", !(pl.needs_uplink && !tw.up_ok));
  });
}

function addLog(e) {
  const d = document.createElement("div");
  d.className = "le " + e.kind;
  d.innerHTML = `<span class="tm">${fmtMET(e.t)}</span><span class="k">${KIND_NAME[e.kind] || e.kind}</span><span>${esc(e.text)}</span>`;
  const log = $("log");
  log.prepend(d);
  while (log.children.length > 300) log.lastChild.remove();
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
$("resetBtn").onclick = () => send("reset");
$("truth").onchange = (e) => { S.truth = e.target.checked; render(); };
$("speed").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.v === "pause") send("pause", { value: !S.snap?.paused });
  else { send("pause", { value: false }); send("speed", { value: +b.dataset.v }); }
};

const guide = new Guide({ S, bus, send, showConsole });
addEventListener("resize", drawCharts);
connect();
