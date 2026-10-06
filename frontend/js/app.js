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
  subLabels, cleanText, wattageFromText, fmtW, diagnosisLine, rootsFrom, filterPlansByRoot,
  fcRemaining, fcLabel, fcPhrase, BacktestTracker, normalizeBacktest, formatBacktest, normalizeValidate,
} from "./evidence.js";

const $ = (id) => document.getElementById(id);
/** root = diagnosed subsystem id; status = NONE | ACTIVE | CONTAINED | RESOLVED; planState = QUEUED|UPLINKED|EXECUTED|CONFIRMED. */
function blankIncident() {
  return {
    root: null, roots: [], diagnosis: "", findingId: "", wattageFrozen: null, status: "NONE",
    recommendedPlan: null, planState: null, firstCriticalT: null,
    detectedAt: null, resolvedAt: null, resolvedScore: null,
  };
}
export const S = {
  meta: null, snap: null, history: [], events: [], pred: null, truth: false, preview: null,
  connected: false, allPlans: false, pauseOnCritical: true, highlightEdges: null, llmKey: "",
  autoHiDone: false, sessionId: "", replay: false, backtest: null, residHist: [],
  // Single source of truth for story card / status pill / evidence / report / log
  incident: blankIncident(),
  plans: [], planRun: null, markers: [], validate: null,
  lastMet: -1,
};
const backtester = new BacktestTracker();
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
  replayBannerOn = !!on;
  const txt = $("replayBannerTxt");
  if (txt) {
    txt.textContent = reason
      || "Recorded mission (offline backup) — inject/plan disabled; loops when the tape ends.";
  }
  updateBanners(); // single banner slot: PAUSED banner takes priority over this one
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
        replayPaused = false;
        resetClientState();
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

/** Drop everything tied to the previous mission (Reset, new hello, replay loop). */
function resetClientState() {
  S.backtest = null;
  S.residHist = [];
  backtester.reset();
  Object.assign(S.incident, blankIncident());
  S.plans = [];
  S.planRun = null;
  S.markers = [];
  S.lastMet = -1;
  S.llmKey = "";
  S.highlightEdges = null;
  S.autoHiDone = false;
  S.allPlans = false;
  S.preview = null;
  planIds = "";
  pausedCritKey = null;
  critPred = null;
  clearCritBanner();
}

function onHello(msg) {
  resetClientState();
  S.sessionId = msg.session_id || "";
  S.meta = msg.meta;
  S.history = msg.history || [];
  S.events = msg.events || [];
  S.pred = msg.pred;
  S.snap = msg.snap;
  if (Number.isFinite(msg.snap?.t)) S.lastMet = msg.snap.t;
  buildStatic();
  if (msg.pred) backtester.addPred(msg.pred);
  updatePlansView();
  updateIncident(msg.snap);
  $("log").innerHTML = "";
  $("ticker").innerHTML = "";
  S.events.forEach(addLog);
  render();
  renderPred();
  emit("hello", msg);
  refreshValidate(true);
}

function onSnap(snap) {
  if (snap.session_id) S.sessionId = snap.session_id;
  // MET comes from the latest snap only; late / out-of-order frames are dropped.
  if (Number.isFinite(snap.t)) {
    if (S.lastMet >= 0 && snap.t < S.lastMet) return;
    S.lastMet = snap.t;
  }
  S.snap = snap;
  const last = S.history[S.history.length - 1];
  if (snap.sample && (!last || snap.sample.t > last.t)) {
    S.history.push(snap.sample);
    if (S.history.length > 1500) S.history.shift();
  }
  updateBacktest(snap);
  updatePlansView();
  updatePlanRun(snap);
  updateIncident(snap); // before addLog so every log line sees the same frozen wattage
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

// ------------------------------------------------------------- incident (single source of truth)
/** Plans for the diagnosed root only, ordered by root relevance then score. */
function updatePlansView() {
  const p = S.pred;
  if (!p) { S.plans = []; return; }
  const finds = S.snap?.findings || [];
  const liveActive = finds.some((f) => !f.contained);
  let plans;
  if (!liveActive && (p.roots || []).length) {
    // Prediction is stale (fault already contained / resolved): only "do nothing" is honest.
    plans = (p.plans || []).filter((x) => x.id === "continue");
  } else {
    plans = filterPlansByRoot(p.plans || [], rootsFrom(p, finds));
  }
  S.plans = plans;
  const top = plans.find((x) => x.id !== "continue" && x.name !== "No action needed");
  S.incident.recommendedPlan = top ? { id: top.id, name: top.name, score: top.score } : null;
}

function updateIncident(sn) {
  if (!sn) return;
  const inc = S.incident;
  const finds = sn.findings || [];
  const active = finds.filter((f) => !f.contained);
  const scoreOf = (id) => (sn.subsystems || []).find((s) => s.id === id)?.score;
  const byConf = (a, b) => (b.conf ?? 0) - (a.conf ?? 0);

  if (active.length) {
    if (!inc.root || inc.status === "RESOLVED") {
      const rec = inc.recommendedPlan;
      Object.assign(inc, blankIncident()); // same object identity for guide.js
      inc.recommendedPlan = rec;
      if (S.planRun?.shown === "CONFIRMED") S.planRun = null;
      inc.detectedAt = sn.t;
    }
    const subs = [...new Set(active.map((f) => f.sub))];
    const root = (S.pred?.roots || []).find((r) => subs.includes(r)) || [...active].sort(byConf)[0].sub;
    const prim = active.filter((f) => f.sub === root).sort(byConf)[0];
    inc.root = root;
    inc.roots = subs;
    inc.findingId = prim.id;
    inc.status = "ACTIVE";
    if (inc.wattageFrozen == null) {
      const leak = finds.find((f) => f.id === "bat_leak" && !f.contained) || finds.find((f) => f.id === "bat_leak");
      const w = wattageFromText(leak?.text);
      if (w != null) inc.wattageFrozen = w;
    }
    inc.diagnosis = cleanText(diagnosisLine(prim), inc.wattageFrozen);
  } else if (inc.root && inc.status !== "RESOLVED") {
    const contained = finds.some((f) => f.contained && inc.roots.includes(f.sub));
    if (S.planRun?.shown === "CONFIRMED") {
      inc.status = "RESOLVED";
      inc.resolvedAt = sn.t;
      inc.resolvedScore = scoreOf(inc.root);
    } else if (contained) {
      inc.status = "CONTAINED";
    } else {
      const rec = inc.recommendedPlan;
      Object.assign(inc, blankIncident()); // fault cleared by the harness: back to watching
      inc.recommendedPlan = rec;
    }
  }
  inc.planState = S.planRun ? S.planRun.shown : null;
  inc.firstCriticalT = fcRemaining(S.pred, sn.t);
}

// ------------------------------------------------------------- backtest (predicted vs actual)
function updateBacktest(sn) {
  const fromBackend = normalizeBacktest(sn.backtest);
  if (fromBackend) { S.backtest = fromBackend; return; }
  const smp = S.history[S.history.length - 1];
  const actual = smp?.tm && sn.t - smp.t < 60 ? smp.tm.t_bat : sn.twin?.t_bat;
  S.backtest = backtester.update(sn.t, actual);
}

function onPred(pred) {
  S.pred = pred;
  backtester.addPred(pred);
  updatePlansView();
  if (S.snap) updateIncident(S.snap);
  renderPred();
  emit("pred", pred);
  const fc = pred?.first_critical;
  if (S.pauseOnCritical && fc && pausedCritKey !== fc.key) {
    pausedCritKey = fc.key;
    critPred = pred;
    if (S.replay && replayHandle) {
      replayHandle.pause();
      replayPaused = true;
    } else {
      send("pause", { value: true });
    }
    showCritBanner();
  }
}

// ------------------------------------------------------------- PAUSED banner (one slot, one Resume)
let critBannerOn = false;
let pendingPause = false;
let replayBannerOn = false;
let critPred = null;

const isPaused = () => (S.replay ? !!(replayHandle && replayHandle.paused) : !!S.snap?.paused);

function critText() {
  const pr = S.pred?.first_critical ? S.pred : critPred;
  const fc = pr?.first_critical;
  if (!fc) return "PAUSED \u2014 critical forecast";
  // Same minutes value as the forecast head and the coach (shared helper).
  return `PAUSED \u2014 critical forecast: ${fcPhrase(fc, fcRemaining(pr, S.snap?.t))}`;
}

function updateBanners() {
  const crit = $("critBanner"), rep = $("replayBanner");
  const paused = isPaused();
  // Any resume path (Resume, speed change, Reset, report close, Explore MC) lands here.
  if (critBannerOn && !paused && !pendingPause) critBannerOn = false;
  const showCrit = critBannerOn;
  if (crit) {
    crit.classList.toggle("hidden", !showCrit);
    const msg = crit.querySelector(".crit-msg");
    if (showCrit && msg) msg.textContent = critText();
  }
  if (rep) rep.classList.toggle("hidden", !replayBannerOn || showCrit);
  const rb = $("replayPauseBtn");
  if (rb) rb.textContent = paused ? "Resume" : "Pause";
}

function showCritBanner() {
  critBannerOn = true;
  pendingPause = true;
  clearTimeout(showCritBanner._t);
  showCritBanner._t = setTimeout(() => { pendingPause = false; updateBanners(); }, 2500);
  updateBanners();
}

function clearCritBanner() {
  critBannerOn = false;
  pendingPause = false;
  updateBanners();
}

/** Resume the sim (live or recorded) and drop the PAUSED banner. */
function resumeSim() {
  clearCritBanner();
  if (S.replay && replayHandle) {
    replayHandle.resume();
    replayPaused = false;
  } else {
    send("pause", { value: false });
  }
  updateBanners();
}

// ------------------------------------------------------------- Execute: toast + chip + chart marker
const PLAN_STEPS = ["QUEUED", "UPLINKED", "EXECUTED", "CONFIRMED"];

function executePlan(id) {
  const sn = S.snap;
  const pl = (S.pred?.plans || []).find((x) => x.id === id);
  if (!sn || !pl || !S.connected || S.replay) return;
  const cmdBase = Math.max(0, ...(sn.commands || []).map((c) => c.id));
  send("plan", { id });
  S.preview = null;
  S.planRun = {
    id, name: pl.name, tExec: sn.t, cmdBase, ncmds: (pl.cmds || []).length || 1,
    shown: "QUEUED", target: "QUEUED", shownAt: performance.now(),
  };
  S.markers.push({ t: sn.t, label: "EXEC" });
  S.incident.planState = "QUEUED";
  const wasPaused = isPaused();
  if (wasPaused) {
    // A paused sim cannot uplink: resume so the plan can progress (banner clears with it).
    clearCritBanner();
    send("pause", { value: false });
  }
  showToast(`Plan sent: ${pl.name} \u00b7 QUEUED${wasPaused ? " \u00b7 sim resumed so the uplink can run" : ""}`, 4200);
  renderPlanRun();
  renderPred();
  drawCharts();
}

function updatePlanRun(sn) {
  const pr = S.planRun;
  if (!pr || !sn) return;
  const cmds = (sn.commands || []).filter((c) => c.id > pr.cmdBase && c.source === "plan");
  const st = (c) => String(c.status || "");
  const delivered = (c) => /^(delivered|ground|confirmed)$/.test(st(c));
  const got = cmds.length >= pr.ncmds;
  let target = "QUEUED";
  if (cmds.some(delivered)) target = "UPLINKED";
  if (got && cmds.every(delivered)) target = "EXECUTED";
  if (got && cmds.every((c) => st(c) === "confirmed")) target = "CONFIRMED";
  pr.target = target;
  // Reveal one stage at a time (>= 700 ms) so all four chips are visible, even while paused.
  const i = PLAN_STEPS.indexOf(pr.shown), j = PLAN_STEPS.indexOf(target);
  if (j > i && performance.now() - pr.shownAt >= 700) {
    pr.shown = PLAN_STEPS[i + 1];
    pr.shownAt = performance.now();
    if (pr.shown === "CONFIRMED") showToast(`Plan CONFIRMED: ${pr.name}`, 3200);
  }
}

function renderPlanRun() {
  const box = $("planRun");
  if (!box) return;
  const pr = S.planRun;
  if (!pr) { box.classList.add("hidden"); patch(box, ""); return; }
  box.classList.remove("hidden");
  const i = PLAN_STEPS.indexOf(pr.shown);
  patch(box, `<div class="pr-name">${esc(pr.name)}</div><div class="pr-steps">${PLAN_STEPS.map((s, k) =>
    `<span class="pr-step st-${s}${k <= i ? " on" : ""}${k === i ? " cur" : ""}">${s}</span>`).join("")}</div>`);
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
    S.allPlans = !S.allPlans; // never touches the MORE drawer
    renderPred();
  });
  document.querySelector("#morePanel .tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) showTab(b.dataset.tab);
  });
  $("drawerToggle")?.addEventListener("click", () => {
    if ($("morePanel").classList.contains("collapsed")) openDrawer();
    else closeDrawer();
  });
  // MORE drawer: restore last tab + open state (stays open until the user closes it)
  {
    const m = loadMore();
    if (m.tab) showTab(m.tab, false);
    if (m.open) openDrawer(m.tab);
  }
  $("viewToggle")?.addEventListener("click", () => {
    const dock = $("viewDock");
    if (!dock) return;
    const hide = dock.classList.toggle("collapsed");
    $("viewToggle").textContent = hide ? "Show" : "Hide";
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
  $("playPauseBtn")?.addEventListener("click", () => {
    if (S.replay && replayHandle) {
      if (replayHandle.paused) resumeSim();
      else { replayHandle.pause(); replayPaused = true; updateBanners(); }
      return;
    }
    if (S.snap?.paused) resumeSim();
    else send("pause", { value: true });
  });
  $("speedSelect")?.addEventListener("change", (e) => {
    clearCritBanner(); // speed change = resume
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
      executePlan(id);
      return;
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

const MORE_KEY = "sattwin_more";
function loadMore() {
  try { return JSON.parse(localStorage.getItem(MORE_KEY) || "{}") || {}; } catch (_) { return {}; }
}
function saveMore(patchObj) {
  try { localStorage.setItem(MORE_KEY, JSON.stringify({ ...loadMore(), ...patchObj })); } catch (_) { /* private mode */ }
}

export function showTab(id, remember = true) {
  for (const b of document.querySelectorAll("#morePanel [data-tab]")) b.classList.toggle("on", b.dataset.tab === id);
  for (const p of document.querySelectorAll("#morePanel .tab-pane")) p.classList.toggle("on", p.id === id);
  if (remember) saveMore({ tab: id });
  if (id === "residPanel") refreshValidate();
  requestAnimationFrame(drawCharts);
}

function openDrawer(tab) {
  const d = $("morePanel");
  d.classList.remove("collapsed");
  $("drawerToggle")?.setAttribute("aria-expanded", "true");
  showTab(tab || loadMore().tab || "chartsPanel");
  saveMore({ open: true });
}

function closeDrawer() {
  $("morePanel").classList.add("collapsed");
  $("drawerToggle")?.setAttribute("aria-expanded", "false");
  saveMore({ open: false });
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
  let mergedTxt = `${mode} · ${syncShort}`;
  if (S.incident.status === "RESOLVED") {
    mergedTxt = `RESOLVED · ${syncShort}`;
  } else if (S.incident.status === "DEGRADED" && tw.cfg.bat_isolated) {
    mergedTxt = `DEGRADED · one string isolated`;
  } else if (S.incident.status === "DEGRADED" && tw.cfg.imu === "B") {
    mergedTxt = `DEGRADED · IMU-B`;
  } else if ((sn.subsystems || []).some((s) => s.score < 80) && mode === "NOMINAL") {
    mergedTxt = `DEGRADED · ${syncShort}`;
    mode = "DEGRADED";
  }
  if (merged) merged.textContent = mergedTxt;
  const statusPill = $("statusPill");
  if (statusPill) statusPill.className = "pill " + (S.incident.status === "RESOLVED" ? "ok" : mode === "DEGRADED" || S.incident.status === "DEGRADED" ? "warn" : pillCls);
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

  // 3-line story card under cascade
  const scores = (sn.subsystems || []).map((s) => s.score);
  const minScore = scores.length ? Math.min(...scores) : 100;
  const find = (sn.findings || []).find((f) => !f.contained) || (sn.findings || [])[0];
  const fc = S.pred?.first_critical;
  const rec = (S.pred?.plans || []).find((p) => p.id !== "continue" && p.name !== "No action needed") || S.pred?.plans?.[0];
  let diag = "—";
  if (S.incident.status === "RESOLVED") {
    const w = S.incident.wattageFrozen;
    const eps = (sn.subsystems || []).find((s) => s.id === "EPS");
    diag = `Resolved: ${S.incident.diagnosis || "fault contained"} at MET ${fmtMET(sn.t)}${eps ? ` · EPS ${eps.score}` : ""}${w != null ? ` · ${Math.max(0, w).toFixed(0)} W` : ""}`;
  } else if (find) {
    diag = find.text;
  } else if (minScore < 80) {
    const weak = (sn.subsystems || []).find((s) => s.score === minScore);
    diag = `${SUB_NAME[weak?.id] || "System"} degraded (${minScore})`;
  } else if ((sn.subsystems || []).some((s) => s.id === "COMMS" && s.status === "WATCH")) {
    diag = "Watching COMMS: no action needed yet";
  } else {
    diag = "All systems nominal";
  }
  const tFc = S.incident.firstCriticalT != null ? S.incident.firstCriticalT : fc?.t;
  const next = fc
    ? `${fc.text} in ${fmtDur(tFc ?? fc.t)}`
    : (orb.gs_pass || tw.gs_pass ? "ground pass active" : `next pass in ${Math.round((orb.next_pass_s || tw.next_pass_s || 0) / 60)} min`);
  let recTxt = "—";
  if (S.incident.status === "RESOLVED") recTxt = "Contained — monitoring";
  else if (rec && rec.id !== "continue" && rec.name !== "No action needed") recTxt = rec.name;
  else if (find) recTxt = "Evaluating options…";
  else if ((sn.subsystems || []).some((s) => s.id === "COMMS" && s.status === "WATCH")) recTxt = "Watching — no uplink yet";
  else recTxt = "No action needed";
  const elDiag = $("storyDiag"), elNext = $("storyNext"), elRec = $("storyRec");
  if (elDiag) elDiag.textContent = diag;
  if (elNext) elNext.textContent = next;
  if (elRec) elRec.textContent = recTxt;

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

let _validateAt = 0;
async function fetchValidate() {
  if (S.replay || Date.now() - _validateAt < 4000) return;
  _validateAt = Date.now();
  try {
    const q = S.sessionId ? `?session_id=${encodeURIComponent(S.sessionId)}` : "";
    const r = await fetch(apiUrl(`/api/validate${q}`));
    if (!r.ok) return;
    const j = await r.json();
    S._validate = j;
    const box = $("validateStrip");
    if (!box || !j.checks) return;
    const assum = (j.assumptions || ASSUMPTIONS).slice(0, 3);
    patch(box, `<div class="ch-h" style="margin-bottom:4px">MODEL CHECK</div>`
      + j.checks.map((c) => `<div class="vc ${c.ok ? "ok" : "bad"}"><b>${esc(c.name)}</b><span>${esc(c.observed)}</span><span style="grid-column:1/-1">${esc(c.reference)}</span></div>`).join("")
      + `<div class="note" style="margin-top:6px"><b>Assumptions / limits:</b> ${assum.map(esc).join(" · ")}</div>`);
  } catch (_) { /* offline / replay */ }
}

function renderValidate(sn) {
  const box = $("validateStrip");
  if (!box) return;
  if (S._validate?.checks) {
    const j = S._validate;
    const assum = (j.assumptions || ASSUMPTIONS).slice(0, 3);
    patch(box, `<div class="ch-h" style="margin-bottom:4px">MODEL CHECK</div>`
      + j.checks.map((c) => `<div class="vc ${c.ok ? "ok" : "bad"}"><b>${esc(c.name)}</b><span>${esc(c.observed)}</span><span style="grid-column:1/-1">${esc(c.reference)}</span></div>`).join("")
      + `<div class="note" style="margin-top:6px"><b>Assumptions / limits:</b> ${assum.map(esc).join(" · ")}</div>`);
  } else {
    const checks = buildValidationChecks(sn, S.meta);
    const assum = (S.meta?.assumptions || ASSUMPTIONS).slice(0, 3);
    patch(box, `<div class="ch-h" style="margin-bottom:4px">MODEL CHECK</div>`
      + checks.map((c) => `<div class="vc ${c.ok ? "ok" : "bad"}"><b>${esc(c.name)}</b><span>${esc(c.observed)}</span><span style="grid-column:1/-1">${esc(c.reference)}</span></div>`).join("")
      + `<div class="note" style="margin-top:6px"><b>Assumptions / limits:</b> ${assum.map(esc).join(" · ")}</div>`);
  }
  fetchValidate();
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
  for (const c of charts) c.draw({ history: S.history, now: S.snap.t, pred: S.pred, plan, truthOn: S.truth, markerT: S.execMarkerT });
}

let planIds = "";
function filterPlansForRoot(plans, roots, findings) {
  const rset = new Set(roots || []);
  if (!rset.size && findings?.length) {
    for (const f of findings) if (!f.contained) rset.add(f.sub);
  }
  if (!rset.size) return plans;
  const RADIO = new Set(["trx_b", "lga", "resume"]);
  const BAT = new Set(["isolate"]);
  const SENSOR = new Set(["imu_b"]);
  let list = plans.filter((pl) => {
    if (pl.id === "continue") return true;
    if (rset.size === 1 && rset.has("COMMS") && BAT.has(pl.id)) return false;
    if (rset.size === 1 && rset.has("GNC") && (BAT.has(pl.id) || pl.id === "trx_b" || pl.id === "lga")) return false;
    if (rset.has("COMMS") && !rset.has("EPS") && BAT.has(pl.id)) return false;
    return true;
  });
  list = [...list].sort((a, b) => {
    const rel = (pl) => {
      if (rset.has("GNC") && SENSOR.has(pl.id)) return 3;
      if (rset.has("EPS") && BAT.has(pl.id)) return 3;
      if (rset.has("COMMS") && RADIO.has(pl.id)) return 3;
      if (pl.relevance != null) return pl.relevance > 0 ? 2 : 0;
      return 1;
    };
    return rel(b) - rel(a) || (b.score - a.score);
  });
  return list;
}

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
    const tShow = S.incident.firstCriticalT != null ? S.incident.firstCriticalT : fc.t;
    head = `${esc(fc.text)} in ${fmtDur(tShow)}${bandNote}`;
  } else if (activeFind || (p.events || []).length) {
    head = "Forecast still risky — diagnosis active";
  } else {
    head = "All clear for the next 2 hours";
  }
  const evs = [...p.events.map((e) => ({ ...e })), ...p.fdir].sort((a, b) => a.t - b.t);
  // Never claim all-clear while listing events
  if (!fc && !activeFind && evs.length) head = "Watching forecast events";
  patch($("impact"), `
    <div class="impact-head ${fc || activeFind || evs.length ? "bad" : "ok"}">${head}</div>
    ${evs.length ? evs.slice(0, 4).map((e) => `<div class="ev ${e.level}"><span>in ${fmtDur(e.t)}</span><span>${e.level === "info" ? "FDIR: " : ""}${esc(e.text)}</span></div>`).join("") : `<div class="note">The twin expects the spacecraft to stay healthy through the next orbits.</div>`}`);

  const bt = $("backtestLine");
  if (bt) {
    const b = S.backtest || S.snap?.backtest;
    if (b && b.predicted != null) {
      const lab = b.label || (b.offset_s != null ? `T+${(b.offset_s / 60).toFixed(0)} min` : "");
      const act = b.actual != null ? b.actual.toFixed(1) : "…";
      const err = b.err_pct != null ? b.err_pct.toFixed(1) : (b.err != null ? b.err.toFixed(1) : "—");
      const mae = b.mae_pct != null ? ` · MAE ${b.mae_pct.toFixed(1)}%` : "";
      const dlt = b.delta != null ? ` · Δ ${b.delta >= 0 ? "+" : ""}${b.delta.toFixed(1)} °C` : "";
      bt.textContent = `Backtest ${lab}: predicted ${(+b.predicted).toFixed(1)} °C, actual ${act} °C, error ${err}%${dlt}${mae}`;
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
  const plans = filterPlansForRoot(p.plans, p.roots, S.snap.findings);
  const ids = plans.map((x) => x.id).join(",");
  const box = $("plans");
  if (ids !== planIds) {
    planIds = ids;
    box.innerHTML = plans.map((pl) => `<div class="plan" data-id="${esc(pl.id)}">
      <div class="plan-h"><span class="rk badge hidden">BEST</span><b>${esc(pl.name)}</b><span class="sc"></span><span class="plan-chip hidden"></span></div>
      <div class="scorebar"><i></i></div><div class="notes"></div>
      <div class="acts"><button class="pbtn" data-act="preview">Preview</button><button class="pbtn go" data-act="run">${S.replay ? "Recorded" : "Execute"}</button><span class="up badge warn hidden">queued until next pass</span></div></div>`).join("");
  }
  const shown = S.allPlans ? plans.length : 3;
  plans.forEach((pl, i) => {
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
    const chip = el.querySelector(".plan-chip");
    if (chip) {
      const show = S.planChip && S.planChip.id === pl.id;
      chip.classList.toggle("hidden", !show);
      if (show) chip.textContent = S.planChip.state;
    }
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
  more.classList.toggle("hidden", plans.length <= 3);
  more.textContent = S.allPlans ? "Show fewer" : `Show all ${plans.length} options`;
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
$("resetBtn").onclick = () => {
  resetClientState(); // clears S.backtest, S.residHist, incident, markers, PAUSED banner
  send("pause", { value: false });
  send("reset");
};
$("truth").onchange = (e) => { S.truth = e.target.checked; render(); };
$("pauseCrit").onchange = (e) => { S.pauseOnCritical = e.target.checked; if (!e.target.checked) { pausedCritKey = null; clearCritBanner(); } };
$("critResume")?.addEventListener("click", resumeSim);
// Report closed / Explore Mission Control: the coach is done, so drop any PAUSED state.
bus.addEventListener("report-close", () => {
  clearCritBanner();
  if (isPaused()) resumeSim();
});
$("replayPauseBtn")?.addEventListener("click", () => {
  if (!replayHandle) return;
  if (replayPaused || replayHandle.paused) {
    resumeSim();
  } else {
    replayHandle.pause();
    replayPaused = true;
    updateBanners();
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
