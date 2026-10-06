"""The digital twin.

It owns a copy of the rover model driven by *estimated* health parameters and
is kept in step with the rover only through telemetry frames:

1. Propagate: every simulated second the twin advances its own model using the
   configuration it believes the rover is in.
2. Synchronise: each arriving frame corrects the twin state (Kalman-style
   blending for measured channels, overwrite for discrete status).
3. Estimate: health parameters are re-fitted by inverting the physics over a
   sliding window (energy balance, thermal balance, link budget).
4. Detect: rate residuals compare the measured trend of each channel with the
   trend the twin predicted. A large residual means "something the model does
   not explain"; once the estimator absorbs the fault the residual collapses.
5. Diagnose: estimated parameters far from nominal are reported as root
   causes; degraded subsystems without their own fault are reported as
   knock-on effects, attributed to the strongest incoming coupling.

When telemetry stops the twin keeps propagating blind (including the rover's
onboard autonomy) and its uncertainty grows until the link returns.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import asdict, fields

from .model import (
    GROUND_COMMANDS, K0, LIMITS, SIGMA, Config, Health, Params, State, apply_command, clamp,
    link_budget, sink_temp, step, sun_elevation, thermal_gyro_bias, voc,
)
from .correlate import correlations as build_correlations, knock_on_cause

LATENCY_S = 2.6
EST_EVERY = 5

RESIDUALS = {
    "soc_rate": ("Battery charge trend", "EPS"),
    "t_bat_rate": ("Battery temperature trend", "EPS"),
    "t_av_rate": ("Avionics temperature trend", "TCS"),
    "v_bus": ("Bus voltage", "EPS"),
    "gyro": ("Gyro innovation", "GNC"),
    "margin": ("Link margin", "COMMS"),
}

OWN_FINDING = {"EPS": "bat", "TCS": "rad", "GNC": "imu", "COMMS": "trx"}


def _fit(xs: list[float], ys: list[float]) -> tuple[float, float, float, float]:
    """Least-squares slope, mean x, mean y and Sxx."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return (sxy / sxx if sxx > 1e-12 else 0.0), mx, my, sxx


def status_of(score: float) -> str:
    return "NOMINAL" if score >= 80 else "WATCH" if score >= 55 else "WARNING" if score >= 30 else "CRITICAL"


class DigitalTwin:
    def __init__(self, p: Params):
        self.p = p
        self.s = State(soc=0.5, t_av=20.0, t_bat=20.0)
        self.h = Health()
        self.o: dict = step(self.s.clone(), self.h, p, 0.0)
        self.win: deque[dict] = deque(maxlen=150)
        self.long: deque[tuple[float, float, float]] = deque(maxlen=900)
        self.n_est = {"r": 0, "leak": 0, "cap": 0, "rad": 0, "imu": 0, "trx": 0}
        self.z = {k: 0.0 for k in RESIDUALS}
        self.alarm = {k: 0 for k in RESIDUALS}
        self.active_anoms: set[str] = set()
        self.reported: set[str] = set()
        self.persist: dict[str, int] = {}
        self.events: list[tuple[str, str]] = []
        self.expected: list[tuple[float, dict]] = []
        self.rx = 0
        self.lost = 0
        self.last_seq = 0
        self.last_frame_t = -1e9
        self.last_rate = 0.0
        self.sync = "INIT"
        self.blind_since: float | None = None
        self.blind_logged = False
        self.last_rover_t = -1e9
        self.unc = {"soc": 0.2, "t_av": 5.0, "t_bat": 5.0, "att_err": 1.0}
        self.last_frame: dict | None = None
        self.prev = self.s.clone()
        self.frames_since_est = 0
        self.terrain = 1.0

    # ------------------------------------------------------------ propagation
    def propagate(self, dt: float, t_now: float) -> None:
        for due, cmd in [e for e in self.expected if e[0] <= t_now]:
            apply_command(self.s, cmd["name"], cmd["value"])
        self.expected = [e for e in self.expected if e[0] > t_now]
        self.prev = self.s.clone()
        self.o = step(self.s, self.h, self.p, dt, self.terrain)
        if self.sync == "BLIND":
            for e in self.o["events"]:
                self.events.append(("TWIN", f"Twin expects (unconfirmed): {e}"))
            self._explain_silence()
        self._update_sync(t_now, dt)

    def _explain_silence(self) -> None:
        """Silence is evidence too: if the model says the downlink should
        close but no frames arrive, raise the transponder-loss estimate just
        enough to explain the loss of signal."""
        s, p = self.s, self.p
        if not self.o["down_ok"] or s.dead or s.cfg.trx != "A":
            return
        lb = link_budget(s.cfg, s.att_err, s.t_av, s.v_bus, s.t, 0.0, p)
        threshold = 10 * math.log10(p.rate_min_kbps / p.rate_max_kbps)
        if lb["point"] > 10.0 or lb["brown"] > 3.0:
            if "silence_other" not in self.reported:
                self.reported.add("silence_other")
                cause = (f"antenna mispointing ({s.att_err:.0f}° attitude error)" if lb["point"] > 10.0
                         else f"low bus voltage ({s.v_bus:.1f} V)")
                self.events.append(("DIAG", f"Telemetry is silent: most likely cause is {cause}, not the radio"))
            return
        if lb["margin"] - self.h.trx_a_loss_db < threshold + 3.0:
            return
        needed = lb["margin"] - threshold + 1.0
        if needed > self.h.trx_a_loss_db:
            self.h.trx_a_loss_db = needed
            self.n_est["trx"] = max(self.n_est["trx"], 6)
            if "silence" not in self.reported:
                self.reported.add("silence")
                self.events.append(("DIAG", "Telemetry is silent although pointing, power and temperature were "
                                            "nominal: most likely cause is transponder A"))

    def expect(self, cmd: dict, t_now: float) -> None:
        """Assume a sent command executes after the light-time if the twin
        believes the uplink closes. Telemetry later confirms or corrects it."""
        if cmd["name"] in GROUND_COMMANDS:
            apply_command(self.s, cmd["name"], cmd["value"])
        elif self.o.get("up_ok"):
            self.expected.append((t_now + LATENCY_S, cmd))

    def _update_sync(self, t_now: float, dt: float) -> None:
        age = t_now - self.last_frame_t
        interval = max(1.0, 8.0 / max(self.last_rate, 1e-6))
        if self.rx < 5:
            new = "INIT"
        elif age > max(15.0, 4 * interval):
            new = "BLIND"
        elif self.last_rate < 64:
            new = "LOW RATE"
        else:
            new = "SYNCED"
        if new == "BLIND":
            g = dt / 60.0
            self.unc["soc"] = min(0.3, self.unc["soc"] + 0.0015 * g)
            self.unc["t_av"] = min(25.0, self.unc["t_av"] + 0.25 * g)
            self.unc["t_bat"] = min(25.0, self.unc["t_bat"] + 0.25 * g)
            self.unc["att_err"] = min(20.0, self.unc["att_err"] + 0.2 * g)
        if new != self.sync:
            if new == "BLIND":
                self.blind_since = self.last_frame_t
            elif self.sync == "BLIND":
                if self.blind_logged:
                    gap = (t_now - (self.blind_since or t_now)) / 60.0
                    self.events.append(("SYNC", f"Telemetry restored after {gap:.1f} min: twin re-synchronised"))
                self.blind_since, self.blind_logged = None, False
            elif self.sync == "INIT":
                self.events.append(("SYNC", "Twin locked onto the telemetry stream"))
            self.sync = new
        if self.sync == "BLIND" and not self.blind_logged and t_now - (self.blind_since or t_now) > 60:
            self.blind_logged = True
            self.events.append(("SYNC", "Telemetry lost: twin is now propagating blind on its model"))

    # -------------------------------------------------------------- ingestion
    def ingest(self, f: dict, t_now: float) -> None:
        s, p = self.s, self.p
        if self.last_seq and f["seq"] > self.last_seq + 1:
            self.lost += f["seq"] - self.last_seq - 1
        self.last_seq = f["seq"]
        self.rx += 1
        if f["t"] - self.last_rover_t > 30:
            self.win.clear()
            self.long.clear()
        self.last_rover_t = f["t"]
        self.last_frame_t = t_now
        self.last_rate = f["rate"]
        self.last_frame = f

        # twin's own predicted rates over the last step (before correction)
        pred = {
            "soc": (s.soc - self.prev.soc), "t_av": (s.t_av - self.prev.t_av),
            "t_bat": (s.t_bat - self.prev.t_bat),
        }
        v_pred = self.o["v_bus"]
        cfg = Config(**f["cfg"])
        lb = link_budget(cfg, s.att_err, f["t_av"], f["v_bus"], f["t"], self.h.trx_a_loss_db, p)
        m_pred = lb["margin"]

        k = 1.0 if self.rx <= 3 else 0.6
        s.soc += k * (f["soc"] - s.soc)
        s.t_av += k * (f["t_av"] - s.t_av)
        s.t_bat += k * (f["t_bat"] - s.t_bat)
        for name in ("x", "z", "heading", "odometer", "shade", "buffer_mb", "no_contact_s", "no_lock_s", "auto_safe"):
            setattr(s, name, f[name])
        s.v_bus = f["v_bus"]
        s.cfg = cfg
        s.dead = False
        if f["speed"] > 0.01:
            self.terrain = clamp(f["loads"]["p_mob"] / (p.p_mobility_nom * f["speed"] / p.v_nom), 0.5, 1.6)
        for key in ("soc", "t_av", "t_bat"):
            self.unc[key] = max({"soc": 0.004, "t_av": 0.3, "t_bat": 0.3}[key], self.unc[key] * 0.7)
        self.unc["att_err"] = max(0.2, self.unc["att_err"] * 0.9)

        for e in f.get("events", []):
            self.events.append(("FDIR", e))

        # level residuals (EWMA of normalised residuals)
        self._resid("v_bus", (f["v_bus"] - v_pred) / 0.12)
        exp_innov = (self.h.imu_a_bias if cfg.imu == "A" else 0.0) + thermal_gyro_bias(f["t_av"], p)
        self._resid("gyro", (f["innov"] - exp_innov) / 0.004)
        self._resid("margin", (f["margin"] - m_pred) / 0.8)

        sun = p.q_sun_body * max(0.0, math.sin(sun_elevation(f["t"]))) * (1.0 - f["shade"])
        L = f["loads"]
        self.win.append({
            "t": f["t"], "soc": f["soc"], "t_av": f["t_av"], "t_bat": f["t_bat"], "v": f["v_bus"],
            "i": f["i_bat"], "p_net": f["p_sol"] - f["p_load"], "heat_bat": L["p_heat_bat"],
            "q_av_in": 0.92 * (L["p_av"] + L["p_sens"] + L["p_comm"]) + 0.8 * L["p_pay"] + L["p_heat_av"] + sun,
            "sink": sink_temp(f["shade"], p), "innov": f["innov"], "cfg": cfg,
            "margin": f["margin"],
            "m_pred_no_trx": m_pred + lb["trx"] if cfg.trx == "A" and lb["point"] < 6.0 else None,
            "pred_soc": pred["soc"], "pred_t_av": pred["t_av"], "pred_t_bat": pred["t_bat"],
        })
        self.long.append((f["t"], f["soc"], f["p_sol"] - f["p_load"]))
        self.frames_since_est += 1
        if self.frames_since_est >= EST_EVERY and len(self.win) >= 40:
            self.frames_since_est = 0
            self._estimate()

    def _resid(self, key: str, z: float) -> None:
        z = clamp(z, -50, 50)
        self.z[key] = 0.85 * self.z[key] + 0.15 * z

    # ------------------------------------------------------------- estimation
    def _estimate(self) -> None:
        p, h, w = self.p, self.h, list(self.win)
        ts = [x["t"] for x in w]
        span = ts[-1] - ts[0]
        if span < 30:
            return
        isolated = w[-1]["cfg"].bat_isolated

        # battery resistance: V - Voc(SOC) = I * R
        if not isolated:
            ys = [x["v"] - voc(x["soc"]) for x in w]
            r_hat, mi, _, sii = _fit([x["i"] for x in w], ys)
            if sii / len(w) > 0.02 and r_hat > 0:
                tb = sum(x["t_bat"] for x in w) / len(w)
                obs = r_hat / (p.bat_r0 * math.exp(-0.025 * (tb - 25.0)))
                h.bat_r_mult += 0.2 * (clamp(obs, 0.5, 12.0) - h.bat_r_mult)
                self.n_est["r"] += 1
        r_mult = 2.0 if isolated else h.bat_r_mult

        def r_at(tb: float) -> float:
            return p.bat_r0 * r_mult * math.exp(-0.025 * (tb - 25.0))

        # battery thermal balance -> internal short (leak) power
        slope_tb, _, _, stt = _fit(ts, [x["t_bat"] for x in w])
        terms = [x["i"] ** 2 * r_at(x["t_bat"]) + x["heat_bat"]
                 - p.g_ab * (x["t_bat"] - x["t_av"]) - p.g_bat_env * (x["t_bat"] - (x["sink"] - K0)) for x in w]
        if not isolated:
            leak_obs = p.c_bat * slope_tb - sum(terms) / len(terms)
            h.bat_leak_w += 0.2 * (clamp(leak_obs, 0.0, 150.0) - h.bat_leak_w)
            self.n_est["leak"] += 1
        sig_slope = max(0.25 / math.sqrt(max(stt, 1e-9)), 3e-4)
        model_tb = sum(x["pred_t_bat"] for x in w) / len(w)
        self.z["t_bat_rate"] = clamp((slope_tb - model_tb) / sig_slope, -50, 50)

        # energy balance -> capacity: SOC = SOC0 + E / C, with E the cumulative
        # energy into the cells, so the regression slope of SOC on E is 1 / C
        if not isolated and len(self.long) >= 200:
            e_cum, energy, prev_t = [], 0.0, self.long[0][0]
            for (t, _, pn) in self.long:
                energy += (pn * (p.charge_eff if pn > 0 else 1.0) - h.bat_leak_w) * (t - prev_t) / 3600.0
                prev_t = t
                e_cum.append(energy)
            if max(e_cum) - min(e_cum) > 4.0:
                inv_c, _, _, _ = _fit(e_cum, [x[1] for x in self.long])
                if inv_c > 0:
                    cap = 1.0 / inv_c
                    h.bat_capacity_frac += 0.05 * (clamp(cap / p.bat_capacity_wh, 0.2, 1.1) - h.bat_capacity_frac)
                    self.n_est["cap"] += 1
        slope_soc, _, _, _ = _fit(ts, [x["soc"] for x in w])
        model_soc = sum(x["pred_soc"] for x in w) / len(w)
        self.z["soc_rate"] = clamp((slope_soc - model_soc) / max(0.001 / math.sqrt(max(stt, 1e-9)), 4e-6), -50, 50)

        # avionics thermal balance -> radiator efficiency
        slope_ta, _, _, _ = _fit(ts, [x["t_av"] for x in w])
        q_in = sum(x["q_av_in"] + p.g_ab * (x["t_bat"] - x["t_av"]) for x in w) / len(w)
        denom = sum(p.rad_eps_area * SIGMA * ((x["t_av"] + K0) ** 4 - x["sink"] ** 4) for x in w) / len(w)
        if denom > 20:
            eta = (q_in - p.c_av * slope_ta) / denom
            h.rad_eff += 0.2 * (clamp(eta, 0.05, 1.3) - h.rad_eff)
            self.n_est["rad"] += 1
        model_ta = sum(x["pred_t_av"] for x in w) / len(w)
        self.z["t_av_rate"] = clamp((slope_ta - model_ta) / sig_slope, -50, 50)

        # gyro innovation minus the thermally explained part -> IMU-A bias
        recent = w[-20:]
        if all(x["cfg"].imu == "A" for x in recent):
            b = sum(x["innov"] - thermal_gyro_bias(x["t_av"], p) for x in recent) / len(recent)
            h.imu_a_bias += 0.3 * (max(0.0, b) - h.imu_a_bias)
            self.n_est["imu"] += 1

        # link budget residual -> transponder A loss
        mm = [x for x in recent if x["m_pred_no_trx"] is not None]
        if len(mm) >= 5:
            obs = sum(x["m_pred_no_trx"] - x["margin"] for x in mm) / len(mm)
            h.trx_a_loss_db += 0.3 * (clamp(obs, 0.0, 60.0) - h.trx_a_loss_db)
            self.n_est["trx"] += 1

        self._detect()

    def _detect(self) -> None:
        for key, (label, sub) in RESIDUALS.items():
            z = self.z[key]
            if abs(z) > 3.5:
                self.alarm[key] += 1
            elif abs(z) < 1.5:
                self.alarm[key] = 0
                if key in self.active_anoms:
                    self.active_anoms.discard(key)
                    self.events.append(("TWIN", f"{label}: model now explains the data (residual {z:+.1f}σ)"))
            if self.alarm[key] >= 3 and key not in self.active_anoms:
                self.active_anoms.add(key)
                self.events.append(("TWIN", f"Anomaly: {label} deviates from the model ({z:+.1f}σ)"))
        current = self.findings()
        ids = {f["id"] for f in current}
        for fid in list(self.persist):
            if fid not in ids:
                del self.persist[fid]
                self.reported.discard(fid)
        for f in current:
            self.persist[f["id"]] = self.persist.get(f["id"], 0) + 1
            if self.persist[f["id"]] >= 12 and f["id"] not in self.reported:
                self.reported.add(f["id"])
                self.events.append(("DIAG", f"Diagnosis: {f['text']} (confidence {f['conf']:.0%})"))

    # -------------------------------------------------------------- diagnosis
    def findings(self) -> list[dict]:
        h, c, out = self.h, self.s.cfg, []

        # estimates freeze while the faulty unit is bypassed, so a contained
        # fault stays on the list instead of looking cured
        def add(fid, sub, text, dev, thr, n, contained=""):
            conf = clamp(0.5 + 0.5 * (dev - thr) / max(thr, 1e-9), 0.3, 0.98) * clamp(n / 6.0, 0.3, 1.0)
            out.append({"id": fid, "sub": sub, "text": text, "conf": conf, "contained": contained})

        iso = "string 2 isolated" if c.bat_isolated else ""
        if h.bat_leak_w > 8:
            add("bat_leak", "EPS", f"internal short in battery string 2, ~{h.bat_leak_w:.0f} W self-heating", h.bat_leak_w, 8, self.n_est["leak"], iso)
        if h.bat_r_mult > 2.0:
            add("bat_r", "EPS", f"battery internal resistance x{h.bat_r_mult:.1f}", h.bat_r_mult - 1, 1.0, self.n_est["r"], iso)
        if h.bat_capacity_frac < 0.8 and self.n_est["cap"] >= 20:
            add("bat_cap", "EPS", f"battery capacity fade to {h.bat_capacity_frac:.0%}", 1 - h.bat_capacity_frac, 0.2, self.n_est["cap"] / 4, iso)
        if h.rad_eff < 0.8:
            add("rad", "TCS", f"radiator efficiency down to {h.rad_eff:.0%} (dust / insulation damage)", 1 - h.rad_eff, 0.2, self.n_est["rad"])
        if h.imu_a_bias > 0.015:
            add("imu", "GNC", f"IMU-A gyro bias {h.imu_a_bias:.3f}°/s", h.imu_a_bias, 0.015, self.n_est["imu"],
                "running on IMU-B" if c.imu == "B" else "")
        if h.trx_a_loss_db > 5:
            add("trx", "COMMS", f"transponder A output down {h.trx_a_loss_db:.0f} dB", h.trx_a_loss_db, 5, self.n_est["trx"],
                "running on transponder B" if c.trx == "B" else "")
        return out

    def confirmed_findings(self) -> list[dict]:
        """Findings that have persisted long enough to raise a DIAG (judge-safe)."""
        return [f for f in self.findings() if self.persist.get(f["id"], 0) >= 12]

    def subsystems(self) -> list[dict]:
        s, h, o, c = self.s, self.h, self.o, self.s.cfg
        cap, r_mult, leak = (0.5, 2.0, 0.0) if c.bat_isolated else (h.bat_capacity_frac, h.bat_r_mult, h.bat_leak_w)
        sc = {
            "EPS": 100 - 60 * (1 - cap) - 6 * max(0, r_mult - 1) - 1.0 * leak - max(0, 0.35 - s.soc) * 200
                   - max(0, s.t_bat - LIMITS["t_bat_max"] + 10) * 2.5,
            "TCS": 100 - 100 * max(0, 1 - h.rad_eff) - max(0, s.t_av - 45) * 2.5 - max(0, -10 - s.t_av) * 3,
            "GNC": 100 - (300 * h.imu_a_bias if c.imu == "A" else 8) - max(0, s.att_err - 1) * 6,
            "COMMS": (100 if o["margin"] > 6 else 60 + 40 * max(0, o["margin"]) / 6 if o["margin"] > 0
                      else 45 if o["down_ok"] else 10) - (1.5 * h.trx_a_loss_db if c.trx == "A" else 5),
            "MOB": 100 if not c.drive or s.cfg.mode == "SAFE" else 100 * clamp(o["v"] / (self.p.v_nom * c.speed_frac + 1e-9), 0, 1),
            "DATA": 100 - 80 * s.buffer_mb / self.p.buffer_cap_mb,
        }
        if c.mode == "SAFE":
            sc["MOB"] = min(sc["MOB"], 60)
        found = self.confirmed_findings()
        roots = {f["sub"] for f in found if not f["contained"]}
        contained = {f["sub"]: f["contained"] for f in found if f["contained"]}
        out = []
        for sub, score in sc.items():
            score = clamp(score, 0, 100)
            cause = ""
            if sub in contained and sub not in roots:
                cause = f"fault contained: {contained[sub]}"
            elif sub not in roots and score < 80:
                cause = knock_on_cause(sub, o["couplings"], roots)
            out.append({"id": sub, "score": round(score), "status": status_of(score),
                        "root": sub in roots, "cause": cause})
        return out

    def prognostics(self) -> dict:
        h, s = self.h, self.s
        fade_per_day = 0.0002 * 2 ** ((s.t_bat - 25.0) / 10.0) * (1 + self.h.bat_leak_w / 20.0)
        cap = 0.5 if s.cfg.bat_isolated else h.bat_capacity_frac
        days = max(0.0, (cap - 0.5) / fade_per_day) if cap > 0.5 else 0.0
        return {"capacity": cap, "fade_pct_day": fade_per_day * 100, "rul_days": days}

    def correlations(self) -> dict:
        # Paths / active edges only from confirmed roots — avoids false cascade hops
        return build_correlations(self.o.get("couplings") or {}, self.confirmed_findings())

    # --------------------------------------------------------------- snapshot
    def view(self) -> dict:
        s, o = self.s, self.o
        return {
            "soc": s.soc, "t_av": s.t_av, "t_bat": s.t_bat, "att_err": s.att_err, "nav_err": s.nav_err,
            "buffer_mb": s.buffer_mb, "x": s.x, "z": s.z, "heading": s.heading, "shade": s.shade,
            "odometer": s.odometer, "v_bus": o["v_bus"], "i_bat": o["i_bat"], "margin": o["margin"],
            "rate": o["rate"], "p_sol": o["p_sol"], "p_load": o["p_load"], "v": o["v"],
            "up_ok": o["up_ok"], "down_ok": o["down_ok"], "searching": o["searching"],
            "loads": {k: o[k] for k in ("p_av", "p_sens", "p_mob", "p_pay", "p_comm")},
            "heaters": o["p_heat_av"] + o["p_heat_bat"],
            "cfg": asdict(s.cfg), "auto_safe": s.auto_safe, "dead": s.dead,
            "no_contact_s": s.no_contact_s,
            "health": {f.name: getattr(self.h, f.name) for f in fields(Health)},
            "unc": dict(self.unc),
        }
