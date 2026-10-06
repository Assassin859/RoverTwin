// Guided demo: narrated walk — auto-advances for hands-free ≤3 min judge path.
// Live backend when connected; in replay highlights recorded inject/plan events.
import { EDGE_STORY } from "./edges.js";

const STORY = {
  battery: {
    icon: "🔋", name: "Battery degradation", severity: 0.85, judge: true,
    analogy: "Internal short → pack heat → avionics → gyro (EPS→TCS→GNC).",
    why: "The battery is the spacecraft power bus. No power means no mission, and an overheating pack can be lost for good.",
    fix: ["Track battery health from telemetry trends, not just the charge level",
      "Build the battery from separate strings so a bad one can be isolated",
      "Keep reserve power and plan rest stops in sunlight"],
  },
  thermal: {
    icon: "🌡️", name: "Thermal stress", severity: 1.0,
    analogy: "Radiator loss → avionics heat → ADCS and radio derate.",
    why: "LEO eclipse still swings thermal load hard. Temperature control keeps every part working.",
    fix: ["Protect radiators and monitor efficiency from telemetry",
      "Schedule heavy imaging for sunlit arcs",
      "Use thermal-safe attitude and duty cycling before limits are reached"],
  },
  sensor: {
    icon: "🧭", name: "Sensor failure", severity: 0.9,
    analogy: "Gyro bias → attitude error → antenna miss (ADCS→COMMS).",
    why: "ADCS needs a clean IMU. Without pointing, the antenna misses the ground station and imaging fails.",
    fix: ["Fly a backup IMU for every critical axis",
      "Cross-check gyro against sun sensor",
      "Raise an alert the moment data stops matching the model"],
  },
  comms: {
    icon: "📡", name: "Communication loss", severity: 0.8,
    analogy: "Transponder loss → blind twin → OBDH buffer fill.",
    why: "Ground contact only happens in short passes. Without the radio, even a healthy spacecraft is useless until the next AOS.",
    fix: ["Carry a spare transponder and a low-gain antenna",
      "Store-and-forward science until the next pass",
      "Use silence as evidence when the model says the link should close"],
  },
};

const COMMON = [
  "Faults chain through live model edges (EPS/TCS/ADCS/COMMS) — knock-ons are correlated, not separate gauges.",
  "Mission control ranks recovery with a 2 h forward simulation before the next pass — FDIR with a twin, not guesswork.",
  "Testing on a twin costs nothing. A failure on orbit can cost crores and years of work.",
];

const $ = (id) => document.getElementById(id);
const pct = (v) => `${Math.round(v * 100)}%`;
const dur = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export class Guide {
  constructor({ S, bus, send, showConsole }) {
    Object.assign(this, { S, bus, send, showConsole });
    this.active = false;
    this.coach = $("coach");
    this.report = $("report");
    this.pathCue = "";
    this.llmCue = false;
    this.seenChain = new Set();
    this._timers = [];
    this._wall0 = 0;
    bus.addEventListener("snap", (e) => this.active && this.onSnap(e.detail));
    bus.addEventListener("event", (e) => this.active && this.onEvent(e.detail));
    bus.addEventListener("hello", () => this.active && this.onHello());
    bus.addEventListener("pred", (e) => this.active && this.onPred(e.detail));
    this.coach.addEventListener("click", (e) => this.onClick(e));
    this.coach.addEventListener("mouseover", (e) => {
      const c = e.target.closest("[data-plan]");
      this.S.preview = c ? c.dataset.plan : this.S.preview;
    });
    this.report.addEventListener("click", (e) => this.onClick(e));
    document.addEventListener("llm-note", (e) => {
      if (!this.active || this.step !== "cascade" || this.llmCue || !e.detail?.text) return;
      this.llmCue = true;
      this.say("OPERATOR NOTE updated — same twin facts, plain language (local LLM or template).", "twin");
    });
  }

  _clearTimers() {
    for (const id of this._timers) clearTimeout(id);
    this._timers = [];
  }

  _later(ms, fn) {
    const id = setTimeout(() => {
      this._timers = this._timers.filter((x) => x !== id);
      if (this.active) fn();
    }, ms);
    this._timers.push(id);
  }

  start() {
    this.active = true;
    this._clearTimers();
    this._wall0 = performance.now();
    $("console")?.classList.add("guide-active");
    this.report.classList.add("hidden");
    this.reset();
    this.step = "boot";
    // Replay-safe: hello may already be applied — do not stall on reset.
    if (this.S.replay) {
      this.render(`<div class="step"><span>GUIDED DEMO · RECORDED</span></div>
        <h2>Following the recorded mission…</h2>
        <p>Inject / plan / reset are disabled offline. Coach highlights recorded events as they play.</p>`);
      this._later(400, () => this.go("intro"));
      return;
    }
    if (this.S.snap && this.S.meta) {
      this.render(`<div class="step"><span>GUIDED DEMO</span></div><h2>Mission already live — continuing…</h2>`);
      this.send("speed", { value: 30 });
      this._later(300, () => this.go("intro"));
      return;
    }
    this.render(`<div class="step"><span>GUIDED DEMO</span></div><h2>Starting a fresh mission…</h2>`);
    this.send("reset");
    this._later(8000, () => {
      if (this.step === "boot" && this.active) {
        this.send("speed", { value: 30 });
        this.go("intro");
      }
    });
  }

  stop() {
    this.active = false;
    this._clearTimers();
    $("console")?.classList.remove("guide-active");
    this.coach.classList.add("hidden");
    this.report.classList.add("hidden");
    this.spot([]);
    this.S.preview = null;
  }

  reset() {
    this.kind = null;
    this.narr = [];
    this.seenEdges = new Set();
    this.pathCue = "";
    this.llmCue = false;
    this.seenChain = new Set();
    this.m = {};
    this.readyAt = null;
    this._autoBat = false;
  }

  onHello() {
    if (this.step === "boot") {
      this.send("speed", { value: 30 });
      this.go("intro");
    } else if (this.step === "again") {
      this.send("speed", { value: 30 });
      this.go("pick");
    }
  }

  spot(ids) {
    document.querySelectorAll(".spot").forEach((e) => e.classList.remove("spot"));
    ids.forEach((id) => $(id)?.classList.add("spot"));
  }

  render(html) {
    this.coach.innerHTML = html + `<div style="text-align:right;margin-top:6px"><button class="x" data-a="quit">exit demo</button></div>`;
    this.coach.classList.remove("hidden");
    const low = [...document.querySelectorAll(".spot")].some((e) => e.getBoundingClientRect().top > innerHeight * 0.45);
    this.coach.classList.toggle("top", low);
  }

  go(step) {
    this.step = step;
    this.readyAt = null;
    const S = this.S;
    if (step === "intro") {
      this.spot(["subsPanel", "orbitStrip"]);
      this.render(`<div class="step"><span>1 / 6 · MIRROR</span></div>
        <h2>LEO EO twin — not a dashboard</h2>
        <p>Ground segment ↔ LEO smallsat (~95 min orbit). Watch eclipse vs sunlit and <b>AOS</b>. Coupled EPS / TCS / ADCS / COMMS / PAYLOAD / OBDH.</p>
        <div class="row"><button class="cta" data-a="next">NEXT</button><span class="note">auto in 6 s</span></div>`);
      this._later(6000, () => this.step === "intro" && this.go("sync"));
    } else if (step === "sync") {
      this.spot(["statusPill", "orbitStrip", "cascadePanel"]);
      this.render(`<div class="step"><span>2 / 6 · SYNC</span></div>
        <h2>Pass-gated telemetry</h2>
        <p>Downlink only during AOS. Pill shows SYNCED / LOW RATE / BLIND. Twin never reads the plant.</p>
        <div class="row"><button class="cta" data-a="next">NEXT</button><span class="note">auto in 5 s</span></div>`);
      this._later(5000, () => this.step === "sync" && this.go("pick"));
    } else if (step === "pick") {
      this.reset();
      this.spot(["faultPanel"]);
      const order = ["battery", "thermal", "sensor", "comms"];
      const replayNote = S.replay
        ? `<p class="note">Recorded mission: battery fault will appear as a FAULT event — coach tracks it.</p>`
        : `<p>Battery is the clearest judge path (EPS→TCS→GNC). Auto-starts in 4 s.</p>`;
      this.render(`<div class="step"><span>3 / 6 · BREAK</span></div>
        <h2>Inject a fault</h2>${replayNote}
        <div class="row" style="justify-content:stretch;margin-bottom:8px"><button class="cta" data-a="batdemo" style="width:100%" ${S.replay ? "disabled" : ""}>RUN BATTERY DEMO</button></div>
        <div class="cards">${order.map((k) => {
          const s = STORY[k];
          return `<button class="card${s.judge ? " best" : ""}" data-fault="${k}" ${S.replay ? "disabled" : ""}>${s.judge ? `<span class="badge">Best for judges</span>` : ""}<span class="ic">${s.icon}</span><b>${s.name}</b><span>${s.analogy}</span></button>`;
        }).join("")}</div>`);
      this._later(4000, () => {
        if (this.step !== "pick") return;
        if (S.replay) {
          this.kind = "battery";
          this.m.tInject = S.snap?.t ?? 0;
          this.go("cascade");
        } else {
          this._runBattery();
        }
      });
    } else if (step === "cascade") {
      this.spot(["cascadePanel", "leftCol"]);
      this.renderCascade();
    } else if (step === "predict") {
      if (!S.replay) this.send("pause", { value: true });
      this.spot(["cascadePanel", "storyLine"]);
      const p = S.pred, cont = p?.plans?.find((x) => x.id === "continue");
      const fc = p?.first_critical;
      const evs = (p?.events || []).slice(0, 3);
      this.render(`<div class="step"><span>5 / 6 · PREDICT</span></div>
        <h2>${fc ? `If nothing is done: ${esc(lc(fc.text))} in ${dur(fc.t)}` : `If nothing is done: ${esc(cont?.notes?.join(", ") || "limits held")}`}</h2>
        <p>Look at the story line under the cascade — diagnosis, next risk, recommended fix. Charts live in MORE if you need them.</p>
        <ul class="narr">${evs.map((e) => `<li class="${e.level === "crit" ? "bad" : ""}">In ${dur(e.t)}: ${esc(e.text)}</li>`).join("") || "<li>No hard limits crossed.</li>"}</ul>
        <div class="row"><button class="cta" data-a="next">WHAT CAN WE DO?</button><span class="note">auto in 5 s</span></div>`);
      this._later(5000, () => this.step === "predict" && this.go("decide"));
    } else if (step === "decide") {
      this.spot(["plansPanel"]);
      const plans = S.pred?.plans || [];
      const best = plans[0];
      const pick = best ? [best] : [];
      if (best && best.id !== "continue") {
        const cont = plans.find((x) => x.id === "continue");
        if (cont) pick.push(cont);
      }
      const other = plans.find((x) => !pick.includes(x));
      if (other) pick.push(other);
      const replayHint = S.replay
        ? `<p class="note">Recorded: wait for Execute / plan event, or auto-pick best in 8 s for the report.</p>`
        : `<p>Each card is a full 2 h simulation. Auto-selects best in 8 s.</p>`;
      this.render(`<div class="step"><span>6 / 6 · RECOVER</span></div>
        <h2>Pick a recovery plan</h2>${replayHint}
        <div class="cards">${pick.map((pl) => `
          <button class="card ${pl === best && pl.id !== "continue" ? "best hl" : ""}" data-plan="${esc(pl.id)}" ${S.replay && pl.id !== "continue" ? "" : ""}>
            <b>${esc(pl.name)}</b><span>${esc(pl.why || pl.plain)}</span>
            <div class="out">score ${pl.score.toFixed(0)} · min charge ${pct(pl.metrics.min_soc)} · battery ${pl.metrics.max_t_bat.toFixed(0)}°C · link ${pct(pl.metrics.link_frac)}</div>
          </button>`).join("")}</div>`);
      this._later(8000, () => {
        if (this.step !== "decide" || !best) return;
        this._choosePlan(best.id);
      });
    } else if (step === "outcome") {
      this.spot(["plansPanel", "cascadePanel"]);
      this.renderOutcome();
      // Hands-free: report within wall budget (~2.5 min from start, or 25 s after decide)
      const elapsed = performance.now() - this._wall0;
      const wait = Math.max(4000, Math.min(25000, 150000 - elapsed));
      this._later(wait, () => {
        if (this.step === "outcome" && !this.m.reported) this.showReport();
      });
    }
  }

  _runBattery() {
    this.kind = "battery";
    this.m.tInject = this.S.snap?.t ?? 0;
    this.send("inject", { kind: "battery", severity: STORY.battery.severity, ramp: 60 });
    this.send("speed", { value: 60 });
    this.send("pause", { value: false });
    this.go("cascade");
  }

  _choosePlan(pl) {
    const plan = this.S.pred?.plans?.find((x) => x.id === pl);
    if (!plan) return;
    if (!this.S.replay && pl !== "continue") this.send("plan", { id: pl });
    if (!this.S.replay) {
      this.send("speed", { value: 60 });
      this.send("pause", { value: false });
    }
    this.S.preview = null;
    const tr = this.S.snap?.truth || this.S.snap?.twin || { soc: 0.5, t_bat: 25, t_av: 25 };
    Object.assign(this.m, {
      plan: pl, planName: plan.name, best: pl === this.S.pred.plans[0].id, predicted: plan.metrics,
      tDecide: this.S.snap?.t ?? 0, minSoc: tr.soc, maxTb: tr.t_bat, maxTa: tr.t_av, samples: 0, linkUp: 0,
    });
    this.narr = [];
    this.say(pl === "continue" ? "Operator decided to wait and see." : `Plan sent: ${plan.name}.`);
    this.go("outcome");
  }

  renderCascade() {
    const ready = this.readyAt != null;
    const corr = this.S.snap?.correlations;
    const paths = corr?.paths || [];
    const top = [...paths].sort((a, b) => (b.edges?.length || 0) - (a.edges?.length || 0))[0];
    const pathLine = top
      ? `Follow the chain: ${(top.edges || []).join(" → ")} — timed losses stack under CHAIN REACTION.`
      : "Follow the chain: root → lit edges → capability losses under HOW IT SPREADS.";
    this.render(`<div class="step"><span>4 / 6 · CASCADE</span><span>${STORY[this.kind || "battery"].icon} ${STORY[this.kind || "battery"].name}</span></div>
      <h2>Watch the fault spread</h2>
      <p>${pathLine}</p>
      <ul class="narr">${this.narr.slice(-6).map((n) => `<li class="${n.c}">${esc(n.t)}</li>`).join("") || "<li>Waiting for cascade effects…</li>"}</ul>
      <div class="row">${ready ? `<button class="cta" data-a="next">SEE THE PREDICTION</button>` : `<span class="note">Running — diagnosis + lit path…</span>`}</div>`);
  }

  renderOutcome() {
    this.render(`<div class="step"><span>OUTCOME</span><span>${dur(Math.max(0, (this.S.snap?.t ?? 0) - (this.m.tDecide || 0)))} after decision</span></div>
      <h2>${esc(this.m.planName || "Recovery")}</h2>
      <p>Commands wait for the next ground-station pass, then confirm in telemetry.</p>
      <ul class="narr">${this.narr.slice(-5).map((n) => `<li class="${n.c}">${esc(n.t)}</li>`).join("")}</ul>
      <div class="row"><button class="cta alt" data-a="report">SHOW REPORT NOW</button></div>`);
  }

  say(t, c = "") {
    this.narr.push({ t, c });
    if (this.step === "cascade") this.renderCascade();
    if (this.step === "outcome") this.renderOutcome();
  }

  onPred(p) {
    if (!this.active) return;
    if (this.step === "cascade" && p?.first_critical && this.readyAt == null) {
      this.readyAt = performance.now();
      this.renderCascade();
      this._later(2500, () => this.step === "cascade" && this.go("predict"));
    }
  }

  onEvent(e) {
    // Replay: highlight recorded inject / plan as coach events
    if (this.S.replay && this.active) {
      if (e.kind === "FAULT" && this.step === "pick") {
        this.kind = "battery";
        this.m.tInject = e.t;
        this.say("Recorded fault: " + lc(e.text), "bad");
        this.go("cascade");
      } else if (e.kind === "CMD" && /bat_isolated|isolate|plan/i.test(e.text) && this.step === "decide") {
        this.say("Recorded recovery: " + e.text, "twin");
        const best = this.S.pred?.plans?.[0];
        if (best) this._choosePlan(best.id);
      }
    }
    if (!["cascade", "outcome"].includes(this.step)) return;
    if (e.kind === "TWIN" && e.text.startsWith("Anomaly")) {
      this.m.tDetect ??= e.t;
      this.say("The twin noticed: " + lc(e.text.replace("Anomaly: ", "").replace(/ \(.*\)$/, "")) + ".", "twin");
    } else if (e.kind === "DIAG") {
      this.m.tDiag ??= e.t;
      this.m.diag ??= e.text;
      const body = e.text.replace("Diagnosis: ", "").replace(/ \(confidence.*\)$/, "");
      this.say("Root finding (twin): " + body + ".", "twin");
    } else if (e.kind === "FDIR") {
      if (e.text.startsWith("Executed command")) this.say("Spacecraft confirms: " + e.text.replace(/^Executed command #\d+: /, ""), "twin");
      else this.say("The spacecraft protected itself: " + e.text, "bad");
    } else if (e.kind === "SYNC" && e.text.startsWith("Telemetry lost")) {
      this.m.tLost ??= e.t;
      this.say("Telemetry stopped. The twin keeps going on its own model.", "bad");
    } else if (e.kind === "SYNC" && e.text.startsWith("Telemetry restored")) {
      this.say("Telemetry is back, and the twin snaps into sync again.", "twin");
    } else if (e.kind === "PRED") {
      this.m.pred ??= e.text;
    } else if (e.kind === "FAULT" && this.step === "cascade" && !this.m.tInject) {
      this.m.tInject = e.t;
      this.kind ??= "battery";
      this.say("Fault onset: " + lc(e.text), "bad");
    }
  }

  onSnap(sn) {
    if (this.step === "cascade") {
      if (this.m.tInject == null) this.m.tInject = sn.t;
      for (const [k, [s]] of Object.entries(sn.couplings || {})) {
        if (s >= 0.25 && !this.seenEdges.has(k) && EDGE_STORY[k]) {
          this.seenEdges.add(k);
          this.say(EDGE_STORY[k]);
        }
      }
      const corr = sn.correlations || {};
      const multi = (corr.paths || []).find((p) => (p.edges || []).length >= 2);
      if (multi && this.pathCue !== multi.edges.join(">")) {
        this.pathCue = multi.edges.join(">");
        this.say(`Lit multi-hop path: ${multi.edges.join(" → ")}.`, "twin");
      }
      for (const st of (sn.cascade_chain?.stages || [])) {
        if (this.seenChain.has(st.id)) continue;
        this.seenChain.add(st.id);
        this.say(`Loss ${st.n}: ${st.text}`, st.kind === "root" ? "bad" : "twin");
      }
      const p = this.S.pred;
      const since = sn.t - (this.m.tInject ?? sn.t);
      const understood = this.m.tDiag != null || this.m.tLost != null || (sn.findings || []).length > 0;
      const active = corr.active || [];
      const pathLit = this.kind === "battery"
        ? active.includes("EPS>TCS") || this.seenEdges.has("EPS>TCS")
        : active.length > 0 || this.seenEdges.size > 0;
      const chainReady = (sn.cascade_chain?.stages || []).some((s) => s.kind === "root")
        && (sn.cascade_chain?.stages || []).some((s) => s.kind === "edge" || s.kind === "path");
      const actionable = p && (p.first_critical || (p.plans?.[0] && p.plans[0].id !== "continue"));
      const fastReady = understood && (pathLit || chainReady) && since > 120;
      const fullReady = understood && actionable && since > 400;
      if (this.readyAt == null && (fastReady || fullReady || since > 900 || (this.S.replay && since > 60))) {
        this.readyAt = performance.now();
        this.renderCascade();
      }
      if (this.readyAt != null && performance.now() - this.readyAt > 4000) this.go("predict");
    } else if (this.step === "outcome") {
      const tr = sn.truth || sn.twin;
      const m = this.m;
      if (!tr) return;
      m.minSoc = Math.min(m.minSoc ?? 1, tr.soc);
      m.maxTb = Math.max(m.maxTb ?? 0, tr.t_bat);
      m.maxTa = Math.max(m.maxTa ?? 0, tr.t_av);
      m.samples = (m.samples || 0) + 1;
      if (tr.margin > -21) m.linkUp = (m.linkUp || 0) + 1;
      // Faster report path: 400 sim-s or wall timer in go("outcome")
      if (sn.t - (m.tDecide || 0) > 400 && !m.reported) this.showReport();
      else if (!m.reported && performance.now() - (this.lastRender || 0) > 1000) {
        this.lastRender = performance.now();
        this.renderOutcome();
      }
    }
  }

  onClick(e) {
    const a = e.target.closest("[data-a]")?.dataset.a;
    const f = e.target.closest("[data-fault]")?.dataset.fault;
    const pl = e.target.closest("[data-plan]")?.dataset.plan;
    if (a === "quit") return this.stop();
    if (a === "console") return this.stop();
    if (a === "again") {
      this.report.classList.add("hidden");
      $("console")?.classList.add("guide-active");
      this.step = "again";
      if (this.S.replay) {
        this.go("pick");
        return;
      }
      this.send("reset");
      return;
    }
    if (a === "report") return this.showReport();
    if (a === "batdemo") {
      if (this.S.replay) return;
      return this._runBattery();
    }
    if (a === "next") {
      const order = ["intro", "sync", "pick", "cascade", "predict", "decide"];
      return this.go(order[order.indexOf(this.step) + 1]);
    }
    if (f) {
      if (this.S.replay) return;
      this.kind = f;
      this.m.tInject = this.S.snap.t;
      this.send("inject", { kind: f, severity: STORY[f].severity, ramp: 60 });
      this.send("speed", { value: 60 });
      this.send("pause", { value: false });
      this.go("cascade");
    }
    if (pl) this._choosePlan(pl);
  }

  showReport() {
    const m = this.m, st = STORY[this.kind || "battery"], S = this.S;
    m.reported = true;
    this._clearTimers();
    this.coach.classList.add("hidden");
    // Keep console usable — non-modal report (pointer-events via CSS)
    this.spot([]);
    if (!S.replay) this.send("speed", { value: 30 });
    const link = m.samples ? m.linkUp / m.samples : 1;
    const ok = (m.maxTb ?? 0) <= 55 && (m.maxTa ?? 0) <= 70 && (m.minSoc ?? 1) >= 0.18 && link > 0.5;
    const li = (a) => a.map((x) => `<li>${x}</li>`).join("");
    const happened = [
      `Injected ${st.name.toLowerCase()} at ${pct(st.severity)} severity.`,
      ...[...this.seenEdges].slice(0, 4).map((k) => EDGE_STORY[k]),
      `After the decision: battery charge stayed above ${pct(m.minSoc ?? 0)}, battery peaked at ${(m.maxTb ?? 0).toFixed(0)}°C, avionics at ${(m.maxTa ?? 0).toFixed(0)}°C, link up ${pct(link)} of the time.`,
    ];
    const twin = [
      m.tDetect != null ? `Spotted an anomaly ${dur(m.tDetect - m.tInject)} after the fault began.` : "No residual anomaly was needed: the effect was visible directly.",
      m.diag ? `${esc(m.diag.replace(/ \(confidence.*\)$/, ""))} (found ${dur((m.tDiag || 0) - (m.tInject || 0))} after onset).` : "",
      m.tLost != null ? "Kept predicting the spacecraft while telemetry was lost." : "",
      m.pred ? esc(m.pred) + "." : "",
      `Simulated ${S.pred?.plans.length ?? "several"} recovery options; chose "${esc(m.planName || "")}"${m.best ? ", the twin's top recommendation" : ""}.`,
    ].filter(Boolean);
    this.report.innerHTML = `<div class="box">
      <h2>Mission report: ${st.icon} ${st.name}</h2>
      <div class="res ${ok ? "ok" : "bad"}">${ok ? "Spacecraft safe. The twin's prediction gave the operator time to act." : "The spacecraft is in trouble. Try the twin's top recommendation next time."}</div>
      <div class="three">
        <div><h3>WHAT HAPPENED</h3><ul>${li(happened)}</ul></div>
        <div><h3>WHAT THE TWIN DID</h3><ul>${li(twin)}</ul></div>
        <div><h3>WHY IT MATTERS</h3><ul>${li([st.why, ...COMMON])}</ul></div>
        <div><h3>HOW TO MINIMISE IT</h3><ul>${li(st.fix)}</ul></div>
      </div>
      <div class="btns"><button class="cta" data-a="again">TEST ANOTHER FAULT</button><button class="cta alt" data-a="console">EXPLORE MISSION CONTROL</button></div>
    </div>`;
    this.report.classList.remove("hidden");
  }
}
