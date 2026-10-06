import { TwinScene } from "./scene.js";
import { Chart, CHARTS, chartLegend } from "./charts.js";
import { Cascade } from "./cascade.js";
import { Guide } from "./guide.js";
import { EDGE_EQ } from "./edges.js";
import { CFG, apiUrl } from "./config.js";
import { loadReplay, playReplay } from "./replay.js";
import {
  buildValidationChecks, ASSUMPTIONS, actNowVsWait, drawResidualSpark,
  backtestPctError, fmtDb, parseTelemetryCsv, hopWhy,
} from "./evidence.js";

const $ = (id) => document.getElementById(id);
export const S = {
  meta: null, snap: null, history: [], events: [], pred: null, truth: false, preview: null,
  connected: false, allPlans: false, pauseOnCritical: true, highlightEdges: null, llmKey: "",
  autoHiDone: false, sessionId: "", replay: false, backtest: null, residHist: [],
};
export const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
let lastAnoms = "";
let pausedCritKey = null;
let llmTimer = null;
let llmBusy = false;
let llmPending = false;
let wsFails = 0;
let gotHello = false;
let replayHandle = null;
let replayPaused = false;
const SUBS_ORDER = ["EPS", "TCS", "GNC", "COMMS", "MOB", "DATA"];
const MATRIX_LABEL = { EPS: "P", TCS: "T", GNC: "A", COMMS: "C", MOB: "L", DATA: "O" };

const ICON = { battery: "🔋", thermal: "🌡️", sensor: "🧭", comms: "📡" };
const SHORT_FAULT = { battery: "Battery", thermal: "Overheat", sensor: "Sensor", comms: "Radio" };
const SUB_NAME = { EPS: "EPS", TCS: "TCS", GNC: "ADCS", COMMS: "COMMS", MOB: "PAYLOAD", DATA: "OBDH" };
const ST_ICON = { NOMINAL: "●", WATCH: "○", WARNING: "▲", CRITICAL: "◆" };
const TICKER_KINDS = new Set(["FAULT", "FDIR", "TWIN", "DIAG", "PRED", "SYNC", "CASCADE"]);
const KIND_NAME = { FAULT: "FAULT", FDIR: "SAT", TWIN: "TWIN", DIAG: "DIAG", PRED: "PRED", CMD: "CMD", SYNC: "LINK", SYS: "SYS", CASCADE: "CHAIN" };

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

// --------------------------------------------------------------- websocket / replay
let ws;
function dispatchServerMsg(msg) {
  if (msg.type === "hello") onHello(msg);
  else if (msg.type === "snap") onSnap(msg);
  else if (msg.type === "pred") onPred(msg.pred);
  else if (msg.type === "error") console.warn("server:", msg.error);
}

function showToast(msg, ms = 2800) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function showReplayBanner(on, reason) {
  const el = $("replayBanner");
  if (!el) return;
  el.classList.toggle("hidden", !on);
  const txt = $("replayBannerTxt");
  if (txt) {
    txt.textContent = reason
      || "Recorded mission (offline backup) — inject/plan disabled; loops when the tape ends.";
  }
}

async function startReplay() {
  if (S.replay || replayHandle) return;
  S.replay = true;
  showReplayBanner(true);
  setConn(true);
  try {
    const data = await loadReplay();
    if (data.reason) showReplayBanner(true, data.reason);
    replayHandle = playReplay(data, dispatchServerMsg, {
      loop: true,
      onLoop() {
        showToast("Replay restarted");
        pausedCritKey = null;
        clearCritBanner();
      },
    });
  } catch (err) {
    console.warn("replay failed", err);
    setConn(false);
    const c = $("conn");
    if (c && !isDeployHost()) {
      c.innerHTML = `Ground segment: <b>offline — could not load recorded mission</b>`;
    }
  }
  applyGroundGate();
}

function isDeployHost() {
  return CFG.isStaticHost || /\.vercel\.app$/i.test(location.hostname);
}

function connect() {
  if (S.replay) return;
  // On static host without explicit backend, go straight to replay.
  if (isDeployHost() && !CFG.explicit) {
    startReplay();
    return;
  }
  try {
    ws = new WebSocket(CFG.wsUrl);
  } catch {
    wsFails++;
    if (wsFails >= 2 || (isDeployHost() && !CFG.explicit)) startReplay();
    else setTimeout(connect, 1500);
    return;
  }
  ws.onopen = () => { wsFails = 0; setConn(true); };
  ws.onerror = () => { /* close handles fallback */ };
  ws.onclose = () => {
    if (S.replay) return;
    setConn(false);
    if (!gotHello) wsFails++;
    const giveUp = wsFails >= 2 || (isDeployHost() && !CFG.explicit && wsFails >= 1);
    if (giveUp) startReplay();
    else setTimeout(connect, 1500);
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "hello") gotHello = true;
    dispatchServerMsg(msg);
  };
}
export function send(op, data = {}) {
  if (S.replay) return;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, ...data }));
}
function setConn(on) {
  S.connected = on;
  const c = $("conn");
  if (c) {
    c.classList.toggle("off", !on);
    let label;
    if (S.replay) label = "recorded mission";
    else if (on) label = "connected";
    else if (isDeployHost()) label = "connecting to recorded mission…";
    else label = "offline — run uvicorn locally for the live twin";
    c.innerHTML = `Ground segment: <b>${label}</b>`;
  }
  applyGroundGate();
  if (!on && !S.replay && $("syncPill")) {
    $("syncPill").className = "pill offline";
    $("syncTxt").textContent = "GROUND OFFLINE";
    $("syncSub").textContent = isDeployHost() ? "loading replay…" : "reconnect WebSocket";
  }
}

function applyGroundGate() {
  const off = !S.connected || S.replay;
  const tip = S.replay
    ? "Recorded mission — inject/plans disabled"
    : (!S.connected ? (isDeployHost() ? "Loading recorded mission…" : "Ground segment offline — start uvicorn (see README)") : "");
  for (const b of document.querySelectorAll("#faults .fbtn, #plans .pbtn.go, #cmds button, #activeFaults [data-clear]")) {
    b.disabled = off;
    if (off) b.title = tip;
    else if (b.dataset.kind && S.meta?.faults?.[b.dataset.kind]) b.title = S.meta.faults[b.dataset.kind].detail;
    else if (b.dataset.clear) b.title = "Remove the fault from the simulated spacecraft (test harness only)";
    else if (!b.dataset.kind) b.removeAttribute("title");
  }
  // Speed / reset still usable in live; in replay only truth/pauseCrit UI
  for (const b of document.querySelectorAll("#speed button, #resetBtn")) {
    if (S.replay) {
      b.disabled = true;
      b.title = "Recorded mission";
    } else {
      b.disabled = false;
      b.removeAttribute("title");
    }
  }
}

function onHello(msg) {
  S.sessionId = msg.session_id || "";
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
  if (snap.session_id) S.sessionId = snap.session_id;
  S.snap = snap;
  const last = S.history[S.history.length - 1];
  if (snap.sample && (!last || snap.sample.t > last.t)) {
    S.history.push(snap.sample);
    if (S.history.length > 1500) S.history.shift();
  }
  for (const e of snap.events || []) {
    S.events.push(e);
    addLog(e);
    if (e.kind === "CASCADE") {
      const chain = snap.cascade_chain?.stages || [];
      const st = chain.find((x) => x.text === e.text) || chain[chain.length - 1];
      if (st?.edges?.length) cascade.pulseEdges(st.edges);
    }
    emit("event", e);
  }
  render();
  emit("snap", snap);
}

function onPred(pred) {
  S.pred = pred;
  // Prediction backtest: compare earlier baseline point to current telemetry
  if (pred?.baseline?.t_bat && S.snap?.twin) {
    const arr = pred.baseline.t_bat;
    if (arr.length > 5) {
      const idx = Math.min(arr.length - 1, 20); // ~T+10 min at 30 s steps thinned
      const predicted = arr[idx];
      const actual = S.snap.twin.t_bat;
      const err = backtestPctError(predicted, actual);
      S.backtest = { predicted, actual, err, at: `T+${idx * 0.5 | 0}` };
    }
  }
  renderPred();
  emit("pred", pred);
  const fc = pred?.first_critical;
  if (S.pauseOnCritical && fc && pausedCritKey !== fc.key) {
    pausedCritKey = fc.key;
    if (S.replay && replayHandle) {
      replayHandle.pause();
      replayPaused = true;
      const btn = $("replayPauseBtn");
      if (btn) btn.textContent = "Resume";
    } else {
      send("pause", { value: true });
    }
    showCritBanner(fc);
  }
}

function showCritBanner(fc) {
  const el = $("critBanner");
  if (!el) return;
  const when = fc.t < 90 ? `${Math.round(fc.t)} s` : fc.t < 5400 ? `${Math.round(fc.t / 60)} min` : `${(fc.t / 3600).toFixed(1)} h`;
  el.querySelector(".crit-msg").textContent = `PAUSED — critical forecast: ${fc.text} in ${when}`;
  el.classList.remove("hidden");
}

function clearCritBanner() {
  $("critBanner")?.classList.add("hidden");
}

function resumeFromCritical() {
  clearCritBanner();
  // Keep pausedCritKey so the same first_critical does not immediately re-pause.
  if (S.replay && replayHandle) {
    replayHandle.resume();
    replayPaused = false;
    const btn = $("replayPauseBtn");
    if (btn) btn.textContent = "Pause";
  } else {
    send("pause", { value: false });
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
  ["Imaging", "drive", [[true, "On"], [false, "Off"]], (c) => c.drive],
  ["Duty", "speed", [[0.5, "50%"], [1, "100%"]], (c) => c.speed_frac],
  ["Payload", "payload", [[true, "On"], [false, "Off"]], (c) => c.payload],
  ["IMU", "imu", [["A", "A"], ["B", "B (spare)"]], (c) => c.imu],
  ["Transponder", "trx", [["A", "A"], ["B", "B (spare)"]], (c) => c.trx],
  ["Antenna", "antenna", [["HGA", "High-gain"], ["LGA", "Low-gain"]], (c) => c.antenna],
  ["Batt. string 2", "bat_isolated", [[false, "Connected"], [true, "Isolated"]], (c) => c.bat_isolated],
  ["Attitude", "pose", [["NORMAL", "Nadir"], ["SUN", "Sun"], ["SHADE", "Thermal"]], (c) => c.pose],
  ["GS assist", "relay_hp", [[false, "Normal"], [true, "High-power"]], (c) => c.relay_hp],
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
  $("morePlans").addEventListener("click", () => {
    S.allPlans = !S.allPlans;
    if (S.allPlans) openDrawer("residPanel");
    renderPred();
  });
  document.querySelector("#morePanel .tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) showTab(b.dataset.tab);
  });
  $("drawerToggle")?.addEventListener("click", () => {
    const d = $("morePanel");
    if (d.classList.contains("collapsed")) openDrawer();
    else closeDrawer();
  });
  $("moreMenuBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const m = $("moreMenu");
    const open = m.classList.toggle("hidden") === false;
    $("moreMenuBtn").setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-wrap")) {
      $("moreMenu")?.classList.add("hidden");
      $("moreMenuBtn")?.setAttribute("aria-expanded", "false");
    }
  });
  $("playPauseBtn")?.addEventListener("click", () => send("pause", { value: !S.snap?.paused }));
  $("speedSelect")?.addEventListener("change", (e) => {
    send("pause", { value: false });
    send("speed", { value: +e.target.value });
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
  COMMS: (tw, h, tr) => [["Link", tw.gs_pass ? (tw.down_ok && tw.margin >= 0 ? fmtDb(tw.margin) : tw.searching ? "searching" : "lost") : `next ${Math.round((tw.next_pass_s || 0) / 60)}m`,
    tr && fmtDb(Math.max(tr.margin, -60))], ["Radio", `TRX-${tw.cfg.trx}`]],
  MOB: (tw) => [["Duty", pct(tw.imaging_duty || 0)],
    ["Imaging", tw.cfg.mode === "SAFE" ? "safe hold" : tw.cfg.drive && tw.cfg.payload ? "on" : "off"]],
  DATA: (tw) => [["Buffer", pct(tw.buffer_mb / S.meta.buffer_cap)],
    ["OBDH", tw.cfg.payload && tw.cfg.mode !== "SAFE" ? "imaging" : "idle"]],
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

function openDrawer(tab) {
  const d = $("morePanel");
  d.classList.remove("collapsed");
  $("drawerToggle")?.setAttribute("aria-expanded", "true");
  if (tab) showTab(tab);
  requestAnimationFrame(drawCharts);
}

function closeDrawer() {
  $("morePanel").classList.add("collapsed");
  $("drawerToggle")?.setAttribute("aria-expanded", "false");
}

function render() {
  const sn = S.snap;
  if (!sn || !S.meta) return;
  const tw = sn.twin, h = tw.health, tr = S.truth ? sn.truth : null;
  scene.truthOn = S.truth;
  scene.setState(tw, sn.truth, sn.speed);

  // top bar — merged status pill (still write syncTxt / modeTxt)
  $("met").textContent = "MET " + fmtMET(sn.t);
  const sy = sn.sync || {};
  if (S.connected) {
    $("syncTxt").textContent = sy.state === "BLIND" ? "TWIN BLIND" : (sy.state || "INIT");
    $("syncSub").textContent = sy.age == null || sy.state === "SYNCED" ? "" : sy.state === "BLIND"
      ? `no telemetry for ${fmtDur(sy.age)}`
      : `${(sy.rate || 0).toFixed(0)} kbps`;
  }
  const worst = (sn.subsystems || []).reduce((w, s) => {
    const rank = { CRITICAL: 4, WARNING: 3, WATCH: 2, NOMINAL: 1 };
    return (rank[s.status] || 0) > (rank[w?.status] || 0) ? s : w;
  }, null);
  const linkBad = !!(tw.gs_pass && (tw.margin < 0 || !tw.down_ok));
  let mode;
  if (tw.dead) mode = "NO POWER";
  else if (linkBad) mode = "NO LINK";
  else if (worst?.status === "CRITICAL" || (worst && worst.score < 30)) mode = "CRITICAL";
  else if (tw.cfg.mode === "SAFE") mode = tw.auto_safe ? `SAFE · auto: ${tw.auto_safe}` : "SAFE MODE";
  else if (worst?.status === "WARNING") mode = "DEGRADED";
  else mode = "NOMINAL";
  const modeBad = tw.dead || linkBad || worst?.status === "CRITICAL" || (worst && worst.score < 30);
  const modeWarn = tw.cfg.mode === "SAFE" || worst?.status === "WARNING" || worst?.status === "WATCH";
  const syncCls = { SYNCED: "ok", "LOW RATE": "warn", INIT: "warn", BLIND: "bad" }[sy.state] || "warn";
  const pillCls = modeBad ? "bad" : modeWarn || syncCls === "warn" ? "warn" : syncCls === "bad" ? "bad" : "ok";
  $("modeTxt").textContent = mode;
  const syncShort = $("syncTxt").textContent || "INIT";
  const merged = $("statusMerged");
  if (merged) merged.textContent = `${mode} · ${syncShort}`;
  const statusPill = $("statusPill");
  if (statusPill) statusPill.className = "pill " + pillCls;
  $("syncPill").className = "pill sr-only " + syncCls;
  $("modePill").className = "pill sr-only " + (modeBad ? "bad" : modeWarn ? "warn" : "ok");

  const hasFault = !!(sn.faults?.length || (sn.findings || []).some((f) => !f.contained));
  $("console").classList.toggle("has-fault", hasFault);

  const orb = sn.link || {};
  const orbitEl = $("orbitStrip");
  if (orbitEl) {
    const passMin = Math.round((orb.next_pass_s || tw.next_pass_s || 0) / 60);
    orbitEl.textContent = orb.gs_pass || tw.gs_pass
      ? "AOS · ground pass active"
      : `${tw.eclipse || orb.eclipse ? "ECLIPSE" : "SUNLIT"} · next pass in ${passMin} min`;
    orbitEl.className = "orbit-strip " + (orb.gs_pass || tw.gs_pass ? "pass" : tw.eclipse || orb.eclipse ? "ecl" : "sun");
  }
  for (const b of $("speed").children) {
    const v = b.dataset.v;
    b.classList.toggle("on", v === "pause" ? sn.paused : !sn.paused && +v === sn.speed);
  }
  const pp = $("playPauseBtn");
  if (pp) pp.textContent = sn.paused ? "▶" : "II";
  const sel = $("speedSelect");
  if (sel && !sn.paused) {
    const opts = [...sel.options].map((o) => +o.value);
    if (opts.includes(sn.speed)) sel.value = String(sn.speed);
  }

  // compact subsystem tiles
  const subs = Object.fromEntries(sn.subsystems.map((s) => [s.id, s]));
  patch($("subs"), Object.keys(SUBS).map((id) => {
    const s = subs[id];
    const st = s?.status || "NOMINAL";
    return `<div class="sub ${st}" title="${esc(s?.cause || "")}"><div class="sub-h"><b>${SUB_NAME[id]}</b><span class="score">${s?.score ?? "—"}</span></div>
      <div class="sub-st">${ST_ICON[st] || "●"} ${st}</div></div>`;
  }).join(""));

  // story line under cascade
  const story = $("storyLine");
  if (story) {
    const find = (sn.findings || []).find((f) => !f.contained) || (sn.findings || [])[0];
    const fc = S.pred?.first_critical;
    const rec = S.pred?.plans?.[0];
    const diag = find ? find.text : "All systems nominal";
    const next = fc ? `${fc.text} in ${fmtDur(fc.t)}` : (orb.gs_pass || tw.gs_pass ? "ground pass active" : `next pass in ${Math.round((orb.next_pass_s || tw.next_pass_s || 0) / 60)} min`);
    const recTxt = rec ? rec.name : "—";
    story.textContent = `Diagnosis: ${diag} · Next: ${next} · Fix: ${recTxt}`;
  }

  // diagnosis
  const pr = sn.prognostics;
  const batFound = sn.findings.some((f) => f.sub === "EPS");
  let progTail = "estimating…";
  if (tw.cfg.bat_isolated) progTail = "running on the healthy string only";
  else if (pr.rul_days == null || pr.rul_ready === false) progTail = "estimating remaining life…";
  else if (pr.rul_days > 0) progTail = `about ${pr.rul_days > 3650 ? "10+ years" : Math.round(pr.rul_days) + " days"} until 50% capacity`;
  else progTail = "already below 50% capacity";
  patch($("diag"), (sn.findings.length
    ? sn.findings.map((f) => `<div class="diag-item${f.contained ? " contained" : ""}">${esc(f.text)}<small>${SUB_NAME[f.sub]} · ${pct(f.conf)} sure${f.contained ? ` · contained: ${esc(f.contained)}` : ""}</small></div>`).join("")
    : `<div class="diag-none">Nothing wrong. Every telemetry frame matches the twin's model.</div>`)
    + `<div class="note">Knock-ons are correlated through the live model edges — not separate gauges.</div>`
    + (batFound ? `<div class="note">Battery outlook: ${pct(Math.min(1, pr.capacity))} capacity, ${progTail}.</div>` : ""));

  // residuals + estimator convergence (model-check tab)
  const anoms = new Set(sn.anomalies);
  const nest = sn.estimator || {};
  const EST_CHIP = [
    ["r", "R_int", 8], ["leak", "leak", 8], ["cap", "capacity", 10],
    ["rad", "radiator", 8], ["imu", "IMU", 6], ["trx", "TRX", 6],
  ];
  const estChips = EST_CHIP.map(([k, lab, need]) => {
    const n = nest[k] || 0;
    const ok = n >= need;
    return `<span class="est-chip ${ok ? "ok" : n > 0 ? "warm" : ""}" title="${lab}: ${n}/${need} updates">${lab} ${n}/${need}</span>`;
  }).join("");
  patch($("resid"), Object.entries(S.meta.residuals).map(([k, label]) => {
    const z = sn.residuals[k] ?? 0, c = Math.max(-10, Math.min(10, z));
    const left = c < 0 ? 50 + c * 5 : 50, width = Math.abs(c) * 5;
    return `<div class="res-row ${anoms.has(k) ? "alarm" : ""}"><span>${label}</span><div class="res-bar"><i style="left:${left}%;width:${width}%"></i></div><span>${z >= 0 ? "+" : ""}${z.toFixed(1)}σ</span></div>`;
  }).join("")
    + `<div class="est-row">${estChips}</div>`
    + `<div class="note">How far the telemetry departs from what the twin expected. Above 3.5σ the twin flags an anomaly; the bar shrinks back once it has worked out the cause.${S.truth ? "" : " Tick “Show truth” to compare its health estimates with the hidden real values."}</div>`);
  renderValidate(sn);
  S.residHist.push({ ...sn.residuals });
  if (S.residHist.length > 120) S.residHist.shift();
  const aScore = drawResidualSpark($("residSpark"), S.residHist, sn.residuals);
  const aEl = $("anomalyScore");
  if (aEl) {
    aEl.textContent = `Anomaly score: max |z| = ${aScore.maxAbsZ.toFixed(1)}σ · ${aScore.nAbove} channel(s) > 3.5σ${aScore.channels.length ? ` (${aScore.channels.join(", ")})` : ""}`;
  }
  patch($("estimates"), S.truth ? estimatesTable(h, sn.truth.health, tw.cfg) : "");
  $("modelDot").classList.toggle("hidden", !anoms.size);
  const anomsKey = [...anoms].sort().join(",");
  if (anoms.size && anomsKey !== lastAnoms) {
    lastAnoms = anomsKey;
    // Do not auto-open MORE drawer — keep main screen clean
  }
  if (!anoms.size) lastAnoms = "";

  const corr = sn.correlations || { matrix: {}, paths: [], active: [] };
  // Auto-highlight longest strong path once when findings appear
  if ((sn.findings || []).length && (corr.paths || []).length && !S.highlightEdges && !S.autoHiDone) {
    const top = [...corr.paths].sort((a, b) => (b.edges?.length || 0) - (a.edges?.length || 0)
      || (b.strength || 0) - (a.strength || 0))[0];
    if (top?.edges?.length) {
      S.highlightEdges = top.edges;
      S.autoHiDone = true;
    }
  }
  if (!(sn.findings || []).length) S.autoHiDone = false;
  const hi = S.highlightEdges || corr.active;
  cascade.setHighlight(S.highlightEdges);
  cascade.update(sn.couplings, sn.subsystems, corr.active);
  renderChain(sn.cascade_chain || { stages: [] });
  renderCorrTable(corr, hi);
  renderCorrMatrix(corr.matrix, hi, corr.paths);
  scheduleExplain(sn, corr);

  // view chips — LEO: imaging / orbit, not rover drive speed
  const imagingOn = !!tw.cfg.drive || !!tw.cfg.payload;
  const chips = [
    `<span class="pill ${imagingOn ? "ok" : "warn"}"><span class="dot"></span>${imagingOn ? "imaging on" : "imaging idle"}</span>`,
    `<span class="pill ${tw.eclipse || orb.eclipse ? "warn" : "ok"}"><span class="dot"></span>${tw.eclipse || orb.eclipse ? "eclipse" : "sunlit orbit"}</span>`,
    `<span class="pill ${tw.down_ok && tw.margin >= 0 ? "ok" : "bad"}"><span class="dot"></span>${tw.down_ok && tw.margin >= 0 ? `link ${fmtDb(tw.margin)}` : "no link"}</span>`,
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
    <button data-clear="${f.kind}" title="Remove the fault from the simulated spacecraft (test harness only)">clear</button></div>`).join(""));

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

function renderChain(chain) {
  const stages = chain.stages || [];
  const box = $("chainReaction");
  if (!box) return;
  if (!stages.length) {
    patch(box, `<div class="ch-h">CHAIN REACTION</div><div class="ch-empty">Waiting for a root fault — losses will stack here in order.</div>`);
    return;
  }
  const hi = new Set(S.highlightEdges || []);
  const latest = [...stages].reverse().find((s) => !s.resolved)?.id || stages[stages.length - 1]?.id;
  const rows = stages.map((st) => {
    const edges = st.edges || [];
    const on = edges.length && edges.every((e) => hi.has(e));
    const cls = [on ? "on" : "", st.id === latest ? "pulse" : "", st.resolved ? "resolved" : ""].filter(Boolean).join(" ");
    const eqKey = edges[edges.length - 1];
    const eq = (st.kind === "edge" || st.kind === "path") && eqKey ? (EDGE_EQ[eqKey] || "") : "";
    const why = (st.kind === "edge" || st.kind === "path") && eqKey ? hopWhy(eqKey) : "";
    return `<li data-edges="${esc(edges.join("|"))}" data-id="${esc(st.id)}" class="${cls}">
      <span class="ch-n">${st.n || ""}.</span><span class="ch-k">${esc(st.kind)}</span>${esc(st.text)}${eq ? `<div class="ch-eq" title="${esc(eq)}">${esc(eq)}</div>` : ""}${why ? `<div class="ch-why">${esc(why)}</div>` : ""}</li>`;
  }).join("");
  patch(box, `<div class="ch-h">CHAIN REACTION <small>${stages.length} stage${stages.length === 1 ? "" : "s"}</small></div><ol>${rows}</ol>`);
}

function renderValidate(sn) {
  const box = $("validateStrip");
  if (!box) return;
  const checks = buildValidationChecks(sn, S.meta);
  const assum = (S.meta?.assumptions || ASSUMPTIONS).slice(0, 3);
  patch(box, `<div class="ch-h" style="margin-bottom:4px">MODEL CHECK</div>`
    + checks.map((c) => `<div class="vc ${c.ok ? "ok" : "bad"}"><b>${esc(c.name)}</b><span>${esc(c.observed)}</span><span style="grid-column:1/-1">${esc(c.reference)}</span></div>`).join("")
    + `<div class="note" style="margin-top:6px"><b>Assumptions / limits:</b> ${assum.map(esc).join(" · ")}</div>`);
}

function renderCorrTable(corr, hi) {
  const paths = [...(corr.paths || [])].sort((a, b) => (b.edges?.length || 0) - (a.edges?.length || 0)
    || (b.strength || 0) - (a.strength || 0));
  const hiSet = new Set(hi || []);
  if (!paths.length) {
    patch($("corrTable"), `<div class="note">No active root-cause paths. Inject a fault to light cause→effect correlations.</div>`);
    return;
  }
  const rows = paths.slice(0, 8).map((p) => {
    const edges = p.edges || [];
    const hops = edges.length;
    const chain = [p.from, ...(p.via || []), p.to].map((x) => SUB_NAME[x] || x).join(" → ");
    const on = edges.length && edges.every((e) => hiSet.has(e));
    const eq = EDGE_EQ[edges[edges.length - 1]] || "";
    return `<tr data-edges="${esc(edges.join("|"))}" class="${on ? "on" : ""}">
      <td>${esc(SUB_NAME[p.from] || p.from)}</td>
      <td>${esc(chain)}</td>
      <td class="str">${hops}</td>
      <td class="str">${p.strength.toFixed(2)}</td>
      <td class="eq" title="${esc(eq)}">${esc(p.label)}</td></tr>`;
  }).join("");
  patch($("corrTable"), `<table><thead><tr><th>Root</th><th>Path</th><th>Hops</th><th>Str</th><th>Effect</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderCorrMatrix(matrix, hi, paths) {
  const hiSet = new Set(hi || []);
  if (!matrix || !Object.keys(matrix).length) {
    patch($("corrMatrix"), "");
    return;
  }
  const legend = `<div class="mx-leg">P=Power · T=Thermal · A=ADCS · C=Comms · L=Payload · O=OBDH</div>`;
  const cells = [`<div class="mh"></div>` + SUBS_ORDER.map((b) => `<div class="mh">${MATRIX_LABEL[b]}</div>`).join("")];
  for (const a of SUBS_ORDER) {
    cells.push(`<div class="mh">${MATRIX_LABEL[a]}</div>`);
    for (const b of SUBS_ORDER) {
      const s = matrix[a]?.[b] || 0;
      const key = `${a}>${b}`;
      const hot = s >= 0.12;
      const alpha = Math.min(1, s);
      const bg = hot ? `rgba(255,153,51,${0.15 + 0.75 * alpha})` : "rgba(255,255,255,.04)";
      const eq = EDGE_EQ[key] || "";
      cells.push(`<div class="cell${hiSet.has(key) ? " on" : ""}${hot ? " hot" : ""}" data-edge="${key}" style="background:${bg}" title="${esc(key)} · ${s.toFixed(2)}${eq ? " — " + esc(eq) : ""}">${hot ? s.toFixed(1) : ""}</div>`);
    }
  }
  patch($("corrMatrix"), `${legend}<div style="display:grid;grid-template-columns:18px repeat(6,1fr);gap:1px">${cells.join("")}</div>`);
  $("corrMatrix")._paths = paths || [];
}

function scheduleExplain(sn, corr) {
  const key = JSON.stringify({
    f: (sn.findings || []).map((x) => x.id + (x.contained || "")),
    a: corr.active || [],
  });
  if (key === S.llmKey) return;
  S.llmKey = key;
  clearTimeout(llmTimer);
  const delay = (corr.active || []).length ? 800 : 2500;
  llmTimer = setTimeout(() => fetchExplain(false), delay);
}

async function fetchExplain(manual) {
  if (S.replay || isDeployHost()) {
    const note = $("llmNote");
    if (note && manual) {
      note.textContent = "Operator note uses the live twin backend — open with a local uvicorn or ?backend= to explain.";
    }
    return;
  }
  if (llmBusy) {
    llmPending = true;
    return;
  }
  llmBusy = true;
  llmPending = false;
  const note = $("llmNote");
  if (note) {
    note.classList.add("busy");
    note.textContent = manual ? "Asking local qwen2.5:3b…" : "Updating operator note…";
  }
  try {
    const r = await fetch(apiUrl("/api/llm/explain"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: S.sessionId || null }),
    });
    const j = await r.json();
    if (note) {
      note.classList.remove("busy");
      note.textContent = j.text || "No explanation.";
    }
    const badge = $("llmBadge");
    if (badge) {
      if (S.replay || isDeployHost()) badge.textContent = j.ok ? `local ${j.model}` : "operator note";
      else if (j.ok) badge.textContent = `local ${j.model}`;
      else if (j.source === "template") badge.textContent = `template note · ${j.model || "offline"}`;
      else badge.textContent = j.text?.startsWith("Ollama") ? "note offline" : `local ${j.model || "llm"} (fallback)`;
    }
    if (!j.ok && !S.replay && !isDeployHost()) refreshLlmStatus();
    // Coach cue for guided demo
    document.dispatchEvent(new CustomEvent("llm-note", { detail: { text: j.text, ok: j.ok, source: j.source } }));
  } catch {
    if (note) {
      note.classList.remove("busy");
      note.textContent = S.replay || isDeployHost()
        ? "Operator note unavailable in recorded mode — twin correlations still show on the graph."
        : "Could not reach /api/llm/explain — twin correlations still work without the LLM.";
    }
    if (!S.replay && !isDeployHost()) refreshLlmStatus();
  } finally {
    llmBusy = false;
    if (llmPending) {
      llmPending = false;
      fetchExplain(false);
    }
  }
}

async function refreshLlmStatus() {
  if (S.replay || isDeployHost()) {
    const badge = $("llmBadge");
    if (badge) badge.textContent = "operator note";
    const sub = $("noteSub");
    if (sub) sub.textContent = "recorded mission note";
    return;
  }
  try {
    const j = await (await fetch(apiUrl("/api/llm/status"))).json();
    const badge = $("llmBadge");
    if (!badge) return;
    badge.textContent = j.ok && j.model_ready ? `Ollama ready · ${j.model}` : j.ok ? `Ollama up · pull ${j.model}` : "note offline — template still works";
  } catch {
    const badge = $("llmBadge");
    if (badge) badge.textContent = "note offline — template still works";
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
  const activeFind = (S.snap.findings || []).some((f) => !f.contained && (f.conf ?? 1) >= 0.5);
  let head;
  if (fc) {
    // Ensemble time-to-threshold band when available
    const band = p.band?.t_bat;
    let bandNote = "";
    if (band && band.length > 2) {
      const lim = 50;
      let tMin = null, tMax = null;
      band.forEach((pair, i) => {
        if (pair[1] >= lim) {
          if (tMin == null) tMin = i * 30;
          tMax = i * 30;
        }
      });
      if (tMin != null) bandNote = ` (ensemble ${fmtDur(tMin)}–${fmtDur(tMax)})`;
    }
    head = `${esc(fc.text)} in ${fmtDur(fc.t)}${bandNote}`;
  } else if (activeFind) {
    head = "Forecast still risky — diagnosis active";
  } else {
    head = "All clear for the next 2 hours";
  }
  const evs = [...p.events.map((e) => ({ ...e })), ...p.fdir].sort((a, b) => a.t - b.t);
  patch($("impact"), `
    <div class="impact-head ${fc || activeFind ? "bad" : "ok"}">${head}</div>
    ${evs.length ? evs.slice(0, 4).map((e) => `<div class="ev ${e.level}"><span>in ${fmtDur(e.t)}</span><span>${e.level === "info" ? "FDIR: " : ""}${esc(e.text)}</span></div>`).join("") : `<div class="note">The twin expects the spacecraft to stay healthy through the next orbits.</div>`}`);

  const bt = $("backtestLine");
  if (bt) {
    if (S.backtest) {
      const b = S.backtest;
      bt.textContent = `Backtest: predicted ${b.predicted.toFixed(1)} °C at ${b.at}, actual ${b.actual.toFixed(1)} °C, error ${b.err.toFixed(1)}%`;
    } else bt.textContent = "";
  }

  const aw = actNowVsWait(p, S.snap.twin?.next_pass_s || S.snap.link?.next_pass_s);
  const awBox = $("actWait");
  if (awBox && aw) {
    patch(awBox, `<div class="aw-summary">If we wait: ${esc(aw.wait.name)} · score ${aw.wait.score.toFixed(0)} · next pass ~${aw.wait.nextPassMin} min</div>
      <div class="aw act"><h4>ACT NOW</h4><b>${esc(aw.act.name)}</b>
        <div>score ${aw.act.score.toFixed(0)} · peak ${aw.act.maxTb?.toFixed(0) ?? "—"}°C · min SoC ${pct(aw.act.minSoc ?? 0)}</div>
        <div class="note">${esc(aw.act.why)}</div></div>
      <div class="aw wait"><h4>WAIT FOR NEXT PASS</h4><b>${esc(aw.wait.name)}</b>
        <div>score ${aw.wait.score.toFixed(0)} · peak ${aw.wait.maxTb?.toFixed(0) ?? "—"}°C · min SoC ${pct(aw.wait.minSoc ?? 0)} · next ~${aw.wait.nextPassMin} min</div>
        <div class="note">${esc(aw.wait.why)}</div></div>`);
    awBox.classList.add("folded");
  }

  const tw = S.snap.twin;
  const ids = p.plans.map((x) => x.id).join(",");
  const box = $("plans");
  if (ids !== planIds) {
    planIds = ids;
    box.innerHTML = p.plans.map((pl) => `<div class="plan" data-id="${esc(pl.id)}">
      <div class="plan-h"><span class="rk badge hidden">BEST</span><b>${esc(pl.name)}</b><span class="sc"></span></div>
      <div class="scorebar"><i></i></div><div class="notes"></div>
      <div class="acts"><button class="pbtn" data-act="preview">Preview</button><button class="pbtn go" data-act="run">${S.replay ? "Recorded" : "Execute"}</button><span class="up badge warn hidden">queued until next pass</span></div></div>`).join("");
  }
  const shown = S.allPlans ? p.plans.length : 3;
  p.plans.forEach((pl, i) => {
    const el = box.querySelector(`[data-id="${CSS.escape(pl.id)}"]`);
    if (!el) return;
    const m = pl.metrics;
    el.classList.toggle("hidden", i >= shown && S.preview !== pl.id);
    el.classList.toggle("collapsed", i > 0 && !S.allPlans && S.preview !== pl.id);
    el.title = `${pl.plain}\nLowest charge ${pct(m.min_soc)} · battery peak ${m.max_t_bat.toFixed(0)}°C · avionics peak ${m.max_t_av.toFixed(0)}°C · link up ${pct(m.link_frac)}`;
    el.classList.toggle("best", i === 0 && pl.id !== "continue");
    el.classList.toggle("preview", S.preview === pl.id);
    el.querySelector(".rk").classList.toggle("hidden", !(i === 0 && pl.id !== "continue"));
    el.querySelector(".sc").textContent = pl.score.toFixed(0);
    el.querySelector(".scorebar i").style.width = `${Math.max(0, Math.min(100, pl.score))}%`;
    const why = pl.why || pl.notes?.[0] || "";
    patch(el.querySelector(".notes"), [
      why ? `<span class="${why === "all limits respected" || why.includes("nominal") ? "good" : ""}">${esc(why)}</span>` : "",
      ...pl.notes.slice(0, 1).filter((n) => n !== why).map((n) => `<span class="${n === "all limits respected" ? "good" : ""}">${esc(n)}</span>`),
    ].join(""));
    const runBtn = el.querySelector("[data-act=run]");
    runBtn.classList.toggle("hidden", pl.id === "continue" || pl.name === "No action needed");
    if (S.replay) {
      runBtn.disabled = true;
      runBtn.title = "Recorded mission — Execute disabled; watch the tape";
    }
    el.querySelector("[data-act=preview]").classList.toggle("on", S.preview === pl.id);
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
$("resetBtn").onclick = () => { pausedCritKey = null; clearCritBanner(); S.llmKey = ""; S.highlightEdges = null; S.autoHiDone = false; send("reset"); };
$("truth").onchange = (e) => { S.truth = e.target.checked; render(); };
$("pauseCrit").onchange = (e) => { S.pauseOnCritical = e.target.checked; if (!e.target.checked) { pausedCritKey = null; clearCritBanner(); } };
$("critResume")?.addEventListener("click", resumeFromCritical);
$("replayPauseBtn")?.addEventListener("click", () => {
  if (!replayHandle) return;
  if (replayPaused || replayHandle.paused) {
    replayHandle.resume();
    replayPaused = false;
    $("replayPauseBtn").textContent = "Pause";
    clearCritBanner();
  } else {
    replayHandle.pause();
    replayPaused = true;
    $("replayPauseBtn").textContent = "Resume";
  }
});
$("csvIngest")?.addEventListener("change", async (e) => {
  const status = $("csvIngestStatus");
  if (S.replay || isDeployHost()) {
    if (status) status.textContent = "available with live backend";
    e.target.value = "";
    return;
  }
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseTelemetryCsv(text);
    if (!rows.length) throw new Error("no rows");
    const res = await fetch(apiUrl("/api/telemetry/ingest"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: text }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.detail || "ingest failed");
    if (status) status.textContent = `SYNCED · ${j.ingested} frames · twin ${j.sync}`;
    showToast(`CSV ingest: ${j.ingested} frames → ${j.sync}`);
  } catch (err) {
    if (status) status.textContent = `ingest failed: ${err.message || err}`;
  }
  e.target.value = "";
});
$("explainBtn").onclick = () => { S.llmKey = ""; fetchExplain(true); };
$("corrTable").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-edges]");
  if (!tr) return;
  const edges = tr.dataset.edges.split("|").filter(Boolean);
  S.highlightEdges = S.highlightEdges && edges.join() === S.highlightEdges.join() ? null : edges;
  render();
});
$("chainReaction").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-edges]");
  if (!li) return;
  const edges = (li.dataset.edges || "").split("|").filter(Boolean);
  if (!edges.length) return;
  S.highlightEdges = S.highlightEdges && edges.join() === S.highlightEdges.join() ? null : edges;
  cascade.pulseEdges(edges);
  render();
});
$("corrMatrix").addEventListener("click", (e) => {
  const c = e.target.closest("[data-edge]");
  if (!c) return;
  const key = c.dataset.edge;
  const paths = $("corrMatrix")._paths || S.snap?.correlations?.paths || [];
  const hit = [...paths]
    .filter((p) => (p.edges || []).includes(key))
    .sort((a, b) => (b.strength || 0) - (a.strength || 0) || (b.edges?.length || 0) - (a.edges?.length || 0))[0];
  const edges = hit?.edges || [key];
  S.highlightEdges = S.highlightEdges && edges.join() === S.highlightEdges.join() ? null : edges;
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
setInterval(refreshLlmStatus, 30000);
if (isDeployHost()) {
  const api = document.querySelector('#moreMenu a[href="/docs"]');
  if (api) api.classList.add("hidden");
}
connect();
