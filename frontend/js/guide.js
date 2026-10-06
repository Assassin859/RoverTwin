// Guided demo: a narrated walk through mirror -> break -> predict -> recover,
// driven entirely by the live backend (nothing here is scripted telemetry).
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
    analogy: "Radiator loss → avionics heat → sensors and radio derate.",
    why: "The lunar surface swings from about +120°C to -170°C. Temperature control keeps every part working.",
    fix: ["Protect radiators from dust and monitor their efficiency from telemetry",
      "Schedule heavy work for cooler periods",
      "Use shade and duty cycling before limits are reached, not after"],
  },
  sensor: {
    icon: "🧭", name: "Sensor failure", severity: 0.9,
    analogy: "Gyro bias → attitude error → antenna miss (GNC→COMMS).",
    why: "Sensors give the rover its sense of direction, and the antenna needs that to find the orbiter.",
    fix: ["Fly a backup sensor for every critical job",
      "Cross-check sensors against each other (gyro against sun sensor)",
      "Raise an alert the moment data stops matching the model"],
  },
  comms: {
    icon: "📡", name: "Communication loss", severity: 0.8,
    analogy: "Transponder loss → blind twin → search power drain.",
    why: "The radio is the only bridge between Earth and the rover. Without it, even a healthy rover is useless to Earth.",
    fix: ["Carry a spare transponder and a low-gain antenna that needs no pointing",
      "Give the rover an onboard comm-loss timer and a stored safe plan",
      "Keep predicting the rover with the twin while it is silent"],
  },
};

const COMMON = [
  "Faults chain through live model edges (EPS/TCS/GNC·ADCS/COMMS) — knock-ons are correlated, not separate gauges.",
  "Mission control ranks recovery with a 2 h forward simulation before uplink — FDIR with a twin, not guesswork.",
  "Testing on a twin costs nothing. A failure on the Moon can cost crores and years of work.",
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
    bus.addEventListener("snap", (e) => this.active && this.onSnap(e.detail));
    bus.addEventListener("event", (e) => this.active && this.onEvent(e.detail));
    bus.addEventListener("hello", () => this.active && this.onHello());
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

  start() {
    this.active = true;
    this.report.classList.add("hidden");
    this.reset();
    this.step = "boot";
    this.render(`<div class="step"><span>GUIDED DEMO</span></div><h2>Starting a fresh mission…</h2>`);
    this.send("reset");
  }

  stop() {
    this.active = false;
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
      this.spot(["subsPanel"]);
      this.render(`<div class="step"><span>1 / 6 · MIRROR</span></div>
        <h2>Satellite-ops twin — not a dashboard</h2>
        <p>Ground segment ↔ relay orbiter ↔ lunar rover. Six coupled subsystems (EPS / TCS / GNC·ADCS / COMMS / MOB / DATA). A dashboard replays canned curves; this twin runs the <b>same physics</b> and only ingests delayed frames — it never reads the plant.</p>
        <div class="row"><button class="cta" data-a="next">NEXT</button></div>`);
    } else if (step === "sync") {
      this.spot(["syncPill", "chartsPanel"]);
      this.render(`<div class="step"><span>2 / 6 · SYNC</span></div>
        <h2>Telemetry-locked, lossy link</h2>
        <p>~2.6 s latency, rate-limited and lossy. Pill shows SYNCED / LOW RATE / BLIND. While blind the twin keeps predicting alone, then re-locks when frames return.</p>
        <div class="row"><button class="cta" data-a="next">NEXT</button></div>`);
    } else if (step === "pick") {
      this.reset();
      this.spot(["faultPanel"]);
      const order = ["battery", "thermal", "sensor", "comms"];
      this.render(`<div class="step"><span>3 / 6 · BREAK</span></div>
        <h2>Inject a fault</h2>
        <p>Battery is the clearest judge path (EPS→TCS→GNC heat cascade). Or pick another fault.</p>
        <div class="row" style="justify-content:stretch;margin-bottom:8px"><button class="cta" data-a="batdemo" style="width:100%">RUN BATTERY DEMO</button></div>
        <div class="cards">${order.map((k) => {
          const s = STORY[k];
          return `<button class="card${s.judge ? " best" : ""}" data-fault="${k}">${s.judge ? `<span class="badge">Best for judges</span>` : ""}<span class="ic">${s.icon}</span><b>${s.name}</b><span>${s.analogy}</span></button>`;
        }).join("")}</div>`);
    } else if (step === "cascade") {
      this.spot(["cascadePanel", "diagPanel", "notePanel"]);
      this.renderCascade();
    } else if (step === "predict") {
      this.send("pause", { value: true });
      this.spot(["impactPanel"]);
      const p = S.pred, cont = p.plans.find((x) => x.id === "continue");
      const fc = p.first_critical;
      const evs = p.events.slice(0, 3);
      this.render(`<div class="step"><span>5 / 6 · PREDICT</span></div>
        <h2>${fc ? `If nothing is done: ${esc(lc(fc.text))} in ${dur(fc.t)}` : `If nothing is done: ${esc(cont.notes.join(", "))}`}</h2>
        <p>Paused. Ensemble forecast over 2 h — dashed lines and bands on the charts.</p>
        <ul class="narr">${evs.map((e) => `<li class="${e.level === "crit" ? "bad" : ""}">In ${dur(e.t)}: ${esc(e.text)}</li>`).join("") || "<li>No hard limits crossed.</li>"}</ul>
        <div class="row"><button class="cta" data-a="next">WHAT CAN WE DO?</button></div>`);
    } else if (step === "decide") {
      this.spot(["plansPanel"]);
      const plans = S.pred.plans;
      const best = plans[0];
      const pick = [best];
      if (best.id !== "continue") pick.push(plans.find((x) => x.id === "continue"));
      const other = plans.find((x) => !pick.includes(x));
      if (other) pick.push(other);
      this.render(`<div class="step"><span>6 / 6 · RECOVER</span></div>
        <h2>Pick a recovery plan</h2>
        <p>Each card is a full 2 h simulation. Hover to preview on the charts, then choose.</p>
        <div class="cards">${pick.map((pl) => `
          <button class="card ${pl === best && pl.id !== "continue" ? "best" : ""}" data-plan="${esc(pl.id)}">
            <b>${esc(pl.name)}</b><span>${esc(pl.plain)}</span>
            <div class="out">score ${pl.score.toFixed(0)} · min charge ${pct(pl.metrics.min_soc)} · battery ${pl.metrics.max_t_bat.toFixed(0)}°C · link ${pct(pl.metrics.link_frac)}</div>
          </button>`).join("")}</div>`);
    } else if (step === "outcome") {
      this.spot(["impactPanel", "chartsPanel"]);
      this.renderOutcome();
    }
  }

  renderCascade() {
    const ready = this.readyAt != null;
    const corr = this.S.snap?.correlations;
    const paths = corr?.paths || [];
    const top = [...paths].sort((a, b) => (b.edges?.length || 0) - (a.edges?.length || 0))[0];
    const pathLine = top
      ? `Follow the chain reaction: ${(top.edges || []).join(" → ")} — timed losses stack in CHAIN REACTION as each knock-on fires.`
      : "Follow the chain reaction: root → lit edges → capability/FDIR losses appear in order under HOW IT SPREADS.";
    this.render(`<div class="step"><span>4 / 6 · CASCADE</span><span>${STORY[this.kind].icon} ${STORY[this.kind].name}</span></div>
      <h2>Watch the fault spread</h2>
      <p>${pathLine}</p>
      <ul class="narr">${this.narr.slice(-6).map((n) => `<li class="${n.c}">${esc(n.t)}</li>`).join("") || "<li>Fault injected. Waiting for the effects to show up…</li>"}</ul>
      <div class="row">${ready ? `<button class="cta" data-a="next">SEE THE PREDICTION</button>` : `<span class="note">Running at 60× — waiting for diagnosis + lit path…</span>`}</div>`);
  }

  renderOutcome() {
    this.render(`<div class="step"><span>OUTCOME</span><span>${dur(Math.max(0, (this.S.snap?.t ?? 0) - this.m.tDecide))} after the decision</span></div>
      <h2>${esc(this.m.planName)}</h2>
      <p>Commands travel to the Moon through the relay orbiter, and the rover confirms them in its telemetry.</p>
      <ul class="narr">${this.narr.slice(-5).map((n) => `<li class="${n.c}">${esc(n.t)}</li>`).join("")}</ul>
      <div class="row"><button class="cta alt" data-a="report">SHOW REPORT NOW</button></div>`);
  }

  say(t, c = "") {
    this.narr.push({ t, c });
    if (this.step === "cascade") this.renderCascade();
    if (this.step === "outcome") this.renderOutcome();
  }

  onEvent(e) {
    if (!["cascade", "outcome"].includes(this.step)) return;
    if (e.kind === "TWIN" && e.text.startsWith("Anomaly")) {
      this.m.tDetect ??= e.t;
      this.say("The twin noticed: " + lc(e.text.replace("Anomaly: ", "").replace(/ \(.*\)$/, "")) + ".", "twin");
    } else if (e.kind === "DIAG") {
      this.m.tDiag ??= e.t;
      this.m.diag ??= e.text;
      const body = e.text.replace("Diagnosis: ", "").replace(/ \(confidence.*\)$/, "");
      this.say("Root finding (twin): " + body + ". Knock-ons show on HOW IT SPREADS via model edges.", "twin");
    } else if (e.kind === "FDIR") {
      if (e.text.startsWith("Executed command")) this.say("Rover confirms: " + e.text.replace(/^Executed command #\d+: /, ""), "twin");
      else this.say("The rover protected itself: " + e.text, "bad");
    } else if (e.kind === "SYNC" && e.text.startsWith("Telemetry lost")) {
      this.m.tLost ??= e.t;
      this.say("Telemetry stopped. The twin keeps going on its own model.", "bad");
    } else if (e.kind === "SYNC" && e.text.startsWith("Telemetry restored")) {
      this.say("Telemetry is back, and the twin snaps into sync again.", "twin");
    } else if (e.kind === "PRED") {
      this.m.pred ??= e.text;
    }
  }

  onSnap(sn) {
    if (this.step === "cascade") {
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
      const since = sn.t - this.m.tInject;
      const understood = this.m.tDiag != null || this.m.tLost != null;
      const active = corr.active || [];
      const pathLit = this.kind === "battery"
        ? active.includes("EPS>TCS")
        : active.length > 0 || this.seenEdges.size > 0;
      const chainReady = (sn.cascade_chain?.stages || []).some((s) => s.kind === "root")
        && (sn.cascade_chain?.stages || []).some((s) => s.kind === "edge" || s.kind === "path");
      const actionable = p && p.t0 > this.m.tInject + 60 && (p.first_critical || p.plans[0].id !== "continue");
      const fastReady = this.kind === "battery" && understood && (pathLit || chainReady) && since > 180;
      const fullReady = understood && actionable && since > 600;
      if (this.readyAt == null && (fastReady || fullReady || since > 1200)) {
        this.readyAt = performance.now();
        this.renderCascade();
      }
      if (this.readyAt != null && performance.now() - this.readyAt > 10000) this.go("predict");
    } else if (this.step === "outcome") {
      const tr = sn.truth;
      const m = this.m;
      m.minSoc = Math.min(m.minSoc, tr.soc);
      m.maxTb = Math.max(m.maxTb, tr.t_bat);
      m.maxTa = Math.max(m.maxTa, tr.t_av);
      m.samples++;
      if (tr.margin > -21) m.linkUp++;
      if (sn.t - m.tDecide > 2400 && !m.reported) this.showReport();
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
      this.step = "again";
      this.send("reset");
      return;
    }
    if (a === "report") return this.showReport();
    if (a === "batdemo") {
      this.kind = "battery";
      this.m.tInject = this.S.snap.t;
      this.send("inject", { kind: "battery", severity: STORY.battery.severity, ramp: 60 });
      this.send("speed", { value: 60 });
      this.send("pause", { value: false });
      return this.go("cascade");
    }
    if (a === "next") {
      const order = ["intro", "sync", "pick", "cascade", "predict", "decide"];
      return this.go(order[order.indexOf(this.step) + 1]);
    }
    if (f) {
      this.kind = f;
      this.m.tInject = this.S.snap.t;
      this.send("inject", { kind: f, severity: STORY[f].severity, ramp: 60 });
      this.send("speed", { value: 60 });
      this.send("pause", { value: false });
      this.go("cascade");
    }
    if (pl) {
      const plan = this.S.pred.plans.find((x) => x.id === pl);
      if (pl !== "continue") this.send("plan", { id: pl });
      this.send("speed", { value: 60 });
      this.send("pause", { value: false });
      this.S.preview = null;
      const tr = this.S.snap.truth;
      Object.assign(this.m, {
        plan: pl, planName: plan.name, best: pl === this.S.pred.plans[0].id, predicted: plan.metrics,
        tDecide: this.S.snap.t, minSoc: tr.soc, maxTb: tr.t_bat, maxTa: tr.t_av, samples: 0, linkUp: 0,
      });
      this.narr = [];
      this.say(pl === "continue" ? "Operator decided to wait and see." : `Plan sent: ${plan.name}.`);
      this.go("outcome");
    }
  }

  showReport() {
    const m = this.m, st = STORY[this.kind], S = this.S;
    m.reported = true;
    this.coach.classList.add("hidden");
    this.spot([]);
    this.send("speed", { value: 30 });
    const link = m.samples ? m.linkUp / m.samples : 1;
    const ok = m.maxTb <= 50 && m.maxTa <= 70 && m.minSoc >= 0.18 && link > 0.6;
    const li = (a) => a.map((x) => `<li>${x}</li>`).join("");
    const happened = [
      `Injected ${st.name.toLowerCase()} at ${pct(st.severity)} severity.`,
      ...[...this.seenEdges].slice(0, 4).map((k) => EDGE_STORY[k]),
      `After the decision: battery charge stayed above ${pct(m.minSoc)}, battery peaked at ${m.maxTb.toFixed(0)}°C, avionics at ${m.maxTa.toFixed(0)}°C, link up ${pct(link)} of the time.`,
    ];
    const twin = [
      m.tDetect != null ? `Spotted an anomaly ${dur(m.tDetect - m.tInject)} after the fault began.` : "No residual anomaly was needed: the effect was visible directly.",
      m.diag ? `${esc(m.diag.replace(/ \(confidence.*\)$/, ""))} (found ${dur(m.tDiag - m.tInject)} after onset).` : "",
      m.tLost != null ? "Kept predicting the rover while telemetry was lost." : "",
      m.pred ? esc(m.pred) + "." : "",
      `Simulated ${S.pred?.plans.length ?? "several"} recovery options; you chose "${esc(m.planName)}"${m.best ? ", the twin's top recommendation" : ""}.`,
    ].filter(Boolean);
    this.report.innerHTML = `<div class="box">
      <h2>Mission report: ${st.icon} ${st.name}</h2>
      <div class="res ${ok ? "ok" : "bad"}">${ok ? "Rover safe. The twin's prediction gave the operator time to act." : "The rover is in trouble. Try the twin's top recommendation next time."}</div>
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
