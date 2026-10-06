"""Predicted impact and recovery simulation.

Starting from the twin's current state and *estimated* health, the model is
rolled forward (faster than real time) for:

* the baseline ("do nothing") plus a small ensemble with perturbed health
  estimates, giving a confidence band and predicted limit crossings;
* every applicable recovery plan, honouring the command uplink: a plan's
  commands only take effect once the predicted uplink closes.

Plans are scored on safety (limits, power), communications and mission return.
"""
from __future__ import annotations

import copy
import random

from .model import GROUND_COMMANDS, LIMITS, Health, Params, State, apply_command, clamp, step

PLANS = [
    {"id": "continue", "name": "Do nothing", "cmds": [],
     "plain": "Keep the current configuration and wait for the next ground pass."},
    {"id": "safe", "name": "Safe mode, sun-point", "cmds": [("mode", "SAFE")],
     "plain": "Inhibit payload, sun-point, and wait out the anomaly."},
    {"id": "shed", "name": "Load-shed: payload off, half duty", "cmds": [("payload", False), ("speed", 0.5)],
     "plain": "Switch off imaging and cut ADCS/payload duty to save power and heat."},
    {"id": "isolate", "name": "Isolate faulty battery string", "cmds": [("bat_isolated", True)],
     "plain": "Disconnect the damaged half of the battery so it stops heating and draining."},
    {"id": "shade", "name": "Thermal safe attitude, payload off", "cmds": [("pose", "SHADE"), ("payload", False)],
     "plain": "Hold a cooler attitude and stop imaging so the bus can shed heat."},
    {"id": "imu_b", "name": "Switch to backup IMU-B", "cmds": [("imu", "B")],
     "plain": "Use the spare IMU instead of the biased unit."},
    {"id": "trx_b", "name": "GS high-power + transponder B", "cmds": [("relay_hp", True), ("trx", "B")],
     "plain": "Boost the ground station and switch the spacecraft to its spare radio (next pass)."},
    {"id": "lga", "name": "Switch to low-gain antenna", "cmds": [("antenna", "LGA")],
     "plain": "Use the wide-beam antenna that needs less pointing (slower data)."},
    {"id": "resume", "name": "Resume nominal operations", "cmds": [("mode", "NOMINAL")],
     "plain": "Return to nadir-pointing and imaging after recovery."},
]
PLAN_BY_ID = {p["id"]: p for p in PLANS}


def _lc(text: str) -> str:
    return text[:1].lower() + text[1:]


def applicable(plan: dict, s: State) -> bool:
    c = s.cfg
    return {
        "continue": True,
        "safe": c.mode != "SAFE",
        "resume": c.mode == "SAFE",
        "shed": c.mode != "SAFE" and (c.payload or c.speed_frac > 0.5),
        "isolate": not c.bat_isolated,
        "shade": c.pose != "SHADE",
        "imu_b": c.imu == "A",
        "trx_b": c.trx == "A" or not c.relay_hp,
        "lga": c.antenna == "HGA",
    }.get(plan["id"], True)


EVENT_RULES = [
    ("t_bat_hot", lambda s, o: s.t_bat > LIMITS["t_bat_max"], "Battery above 50°C", "crit"),
    ("t_av_hot", lambda s, o: s.t_av > LIMITS["t_av_max"], "Avionics above 70°C", "crit"),
    ("soc_low", lambda s, o: s.soc < 0.18, "Battery below 18%", "crit"),
    ("dead", lambda s, o: s.dead, "Spacecraft loses power", "crit"),
    ("link_lost", lambda s, o: not o["down_ok"] and o.get("gs_pass", True), "Telemetry link lost in pass", "warn"),
    ("buffer_full", lambda s, o: o["payload_on"] is False and s.buffer_mb > 47.0, "Data buffer full, science lost", "warn"),
    ("att_bad", lambda s, o: s.att_err > 10, "Attitude error above 10°", "warn"),
]


def simulate(s0: State, h0: Health, p: Params, cmds: list, up_ok0: bool, horizon: float = 7200.0,
             dt: float = 10.0, sample: float = 60.0, terrain: float = 1.0) -> dict:
    s, h = s0.clone(), copy.copy(h0)
    pending = []
    for name, val in cmds:
        if name in GROUND_COMMANDS:
            apply_command(s, name, val)
        else:
            pending.append((name, val))
    delivered = None
    if pending and up_ok0:
        for name, val in pending:
            apply_command(s, name, val)
        pending, delivered = [], 0.0

    t0 = s.t
    ser = {k: [] for k in ("t", "soc", "t_av", "t_bat", "margin", "att_err")}
    m = {"min_soc": s.soc, "max_t_av": s.t_av, "max_t_bat": s.t_bat, "link": 0, "n": 0,
         "dist": 0.0, "sci": 0.0, "dead": False}
    events, seen = [], set()
    next_sample = 0.0
    odo0, sci0 = s.odometer, s.science_mb
    while s.t - t0 < horizon:
        o = step(s, h, p, dt, terrain)
        if pending and o["up_ok"]:
            for name, val in pending:
                apply_command(s, name, val)
            pending, delivered = [], s.t - t0
        el = s.t - t0
        m["min_soc"] = min(m["min_soc"], s.soc)
        m["max_t_av"] = max(m["max_t_av"], s.t_av)
        m["max_t_bat"] = max(m["max_t_bat"], s.t_bat)
        m["link"] += 1 if o["down_ok"] else 0
        m["n"] += 1
        m["dead"] |= s.dead
        for key, cond, text, lvl in EVENT_RULES:
            if key not in seen and cond(s, o):
                seen.add(key)
                events.append({"key": key, "t": el, "text": text, "level": lvl})
        for e in o["events"]:
            events.append({"key": "fdir", "t": el, "text": e, "level": "info"})
        if el >= next_sample:
            next_sample += sample
            ser["t"].append(round(el))
            ser["soc"].append(round(s.soc, 4))
            ser["t_av"].append(round(s.t_av, 2))
            ser["t_bat"].append(round(s.t_bat, 2))
            ser["margin"].append(round(max(o["margin"], -40.0), 2))
            ser["att_err"].append(round(s.att_err, 2))
    m["dist"] = s.odometer - odo0
    m["sci"] = s.science_mb - sci0
    m["link_frac"] = m["link"] / max(1, m["n"])
    m["end_soc"] = s.soc
    del m["link"], m["n"]
    return {"series": ser, "metrics": m, "events": events, "delivered": delivered,
            "blocked": bool(pending)}


def _trend_penalty(ser: dict) -> tuple[float, list[str]]:
    """Penalise plans that end the horizon still heading for a limit."""
    pen, notes = 0.0, []
    if len(ser["t"]) < 12:
        return pen, notes
    span = (ser["t"][-1] - ser["t"][-11]) / 3600.0
    for key, lim, label, up in (("t_av", LIMITS["t_av_max"], "avionics", True),
                                ("t_bat", LIMITS["t_bat_max"], "battery", True),
                                ("soc", 0.18, "battery charge", False)):
        a, b = ser[key][-11], ser[key][-1]
        rate = (b - a) / span
        if up and b < lim and rate > 0 and (lim - b) / rate < 1.0:
            pen += 8
            notes.append(f"{label} still heating towards its limit")
        if not up and b > lim and rate < 0 and (b - lim) / -rate < 1.0:
            pen += 8
            notes.append(f"{label} still falling towards 18%")
    return pen, notes


def score(m: dict, p: Params, horizon: float, ser: dict | None = None, cost: float = 0.0) -> tuple[float, list[str]]:
    """End-state-aware safety score. Peak pack temp dominates so isolate (~64°C) beats continue (~75°C)."""
    safety, notes = 60.0, []
    # Continuous temp penalty (not only past hard limits) so cooler end-states rank higher
    safety -= max(0.0, m["max_t_av"] - 55.0) * 1.4
    safety -= max(0.0, m["max_t_bat"] - 40.0) * 1.8
    if ser:
        pen, tn = _trend_penalty(ser)
        safety -= pen
        notes += tn
    if m["dead"]:
        safety -= 60
        notes.append("spacecraft loses power")
    if m["min_soc"] < 0.18:
        safety -= 10 + 25 * clamp((0.18 - m["min_soc"]) / 0.18, 0, 1)
        notes.append(f"battery falls to {m['min_soc']:.0%}")
    if m["max_t_bat"] > LIMITS["t_bat_max"]:
        safety -= min(35.0, 12 + (m["max_t_bat"] - LIMITS["t_bat_max"]) * 2.5)
        notes.append(f"battery reaches {m['max_t_bat']:.0f}°C")
    elif m["max_t_bat"] > 55:
        notes.append(f"battery peaks at {m['max_t_bat']:.0f}°C")
    if m["max_t_av"] > LIMITS["t_av_max"]:
        safety -= min(30.0, 10 + (m["max_t_av"] - LIMITS["t_av_max"]) * 2)
        notes.append(f"avionics reach {m['max_t_av']:.0f}°C")
    # End-state margin bonus (last sample) — healthier link at horizon wins ties
    if ser and ser.get("margin"):
        end_m = float(ser["margin"][-1])
        safety += clamp(end_m / 20.0, -2.0, 3.0)
    comms = 25.0 * m["link_frac"]
    if m["link_frac"] < 0.25:
        notes.append(f"in contact {m['link_frac']:.0%} of the time (pass windows)")
    sci_den = max(p.science_mb_s * horizon * 0.3, 1e-6)
    ret = 15.0 * clamp(0.2 * m["dist"] / max(p.v_nom * horizon, 1e-6) + 0.8 * m["sci"] / sci_den, 0, 1)
    if m["sci"] > 0:
        notes.append(f"science returned {m['sci']:.1f} MB")
    if not notes:
        notes.append("all limits respected")
    return round(max(0.0, safety) + comms + ret - cost, 1), notes


def plan_cost(cmds: list) -> float:
    """Small penalty for actions that give up redundancy (isolate tip cost kept low so cooling wins)."""
    costs = {
        "bat_isolated": 0.8, "imu": 1.5, "trx": 1.5, "relay_hp": 1.0, "antenna": 0.5,
        "pose": 0.35, "payload": 0.25, "mode": 0.4, "drive": 0.2, "speed": 0.15,
    }
    return sum(costs.get(n, 0.05) for n, v in cmds if v not in (False, "A", "HGA", "NORMAL", 1, 1.0))


def plan_why(plan: dict, notes: list[str]) -> str:
    """One-line why for UI: best note, else plan plain."""
    for n in notes:
        if n and n != "all limits respected":
            return n
    return plan.get("plain") or "all limits respected"


def _perturb(h: Health, s: State, unc: dict, rng: random.Random) -> tuple[Health, State]:
    h2, s2 = copy.copy(h), s.clone()
    h2.bat_leak_w = max(0.0, h.bat_leak_w * rng.uniform(0.75, 1.25) + rng.uniform(-2, 2))
    h2.bat_r_mult = max(0.5, h.bat_r_mult * rng.uniform(0.8, 1.2))
    h2.bat_capacity_frac = clamp(h.bat_capacity_frac * rng.uniform(0.92, 1.08), 0.2, 1.1)
    h2.rad_eff = clamp(h.rad_eff + rng.uniform(-0.06, 0.06), 0.05, 1.3)
    h2.imu_a_bias = max(0.0, h.imu_a_bias * rng.uniform(0.8, 1.2))
    h2.trx_a_loss_db = max(0.0, h.trx_a_loss_db + rng.uniform(-3, 3))
    s2.soc = clamp(s.soc + rng.uniform(-1, 1) * unc["soc"], 0, 1)
    s2.t_av += rng.uniform(-1, 1) * unc["t_av"]
    s2.t_bat += rng.uniform(-1, 1) * unc["t_bat"]
    return h2, s2


def predict_all(s: State, h: Health, up_ok: bool, unc: dict, p: Params, terrain: float = 1.0,
                horizon: float = 7200.0, members: int = 5, has_findings: bool = True) -> dict:
    base = simulate(s, h, p, [], up_ok, horizon, terrain=terrain)
    rng = random.Random(int(s.t))
    ens = []
    for _ in range(members):
        h2, s2 = _perturb(h, s, unc, rng)
        ens.append(simulate(s2, h2, p, [], up_ok, horizon, terrain=terrain)["series"])
    band = {}
    for k in ("soc", "t_av", "t_bat", "margin", "att_err"):
        cols = list(zip(base["series"][k], *[e[k] for e in ens]))
        band[k] = [[min(c), max(c)] for c in cols]

    def _end_margin(ser: dict) -> float:
        mlist = ser.get("margin") or []
        return float(mlist[-1]) if mlist else -99.0

    # Quiet nominal: only "Do nothing" when twin has no confirmed diagnosis
    if not has_findings:
        cont = next(p for p in PLANS if p["id"] == "continue")
        sc, notes = score(base["metrics"], p, horizon, base["series"], 0.0)
        quiet = {
            "id": cont["id"],
            "name": "No action needed",
            "plain": cont["plain"],
            "why": "twin is nominal — no recovery needed",
            "cmds": [],
            "score": sc,
            "notes": ["twin is nominal — no recovery needed"],
            "metrics": base["metrics"],
            "events": base["events"][:8],
            "series": base["series"],
            "end_margin": _end_margin(base["series"]),
            "delivered": None,
            "blocked": False,
            "needs_uplink": False,
        }
        crit = [e for e in base["events"] if e["level"] == "crit"]
        return {
            "t0": s.t, "horizon": horizon, "baseline": base["series"], "band": band,
            "events": [e for e in base["events"] if e["key"] != "fdir"],
            "fdir": [e for e in base["events"] if e["key"] == "fdir"][:6],
            "first_critical": crit[0] if crit else None,
            "plans": [quiet], "recommended": "continue",
        }

    results = []
    for plan in PLANS:
        if plan["id"] != "continue" and not applicable(plan, s):
            continue
        r = base if plan["id"] == "continue" else simulate(s, h, p, plan["cmds"], up_ok, horizon, terrain=terrain)
        sc, notes = score(r["metrics"], p, horizon, r["series"], plan_cost(plan["cmds"]))
        results.append({
            "id": plan["id"], "name": plan["name"], "plain": plan["plain"],
            "why": plan_why(plan, notes), "cmds": plan["cmds"],
            "score": sc, "notes": notes, "metrics": r["metrics"], "events": r["events"][:8],
            "series": r["series"], "end_margin": _end_margin(r["series"]),
            "delivered": r["delivered"], "blocked": r["blocked"],
            "needs_uplink": any(n not in GROUND_COMMANDS for n, _ in plan["cmds"]),
        })

    # let the twin try combining the two best single actions
    ranked = sorted((r for r in results if r["id"] != "continue"), key=lambda r: -r["score"])
    cont = next(r for r in results if r["id"] == "continue")
    if len(ranked) >= 2 and ranked[1]["score"] > cont["score"]:
        merged = dict(ranked[0]["cmds"])
        for n, v in ranked[1]["cmds"]:
            merged.setdefault(n, v)
        cmds = list(merged.items())
        r = simulate(s, h, p, cmds, up_ok, horizon, terrain=terrain)
        sc, notes = score(r["metrics"], p, horizon, r["series"], plan_cost(cmds))
        if sc > ranked[0]["score"] + 1:
            combo = {
                "id": "combo:" + ranked[0]["id"] + "+" + ranked[1]["id"],
                "name": f"{ranked[0]['name']} + {_lc(ranked[1]['name'])}",
                "plain": ranked[0]["plain"] + " Also: " + _lc(ranked[1]["plain"]),
                "why": plan_why({"plain": ranked[0]["plain"]}, notes),
                "cmds": cmds, "score": sc, "notes": notes, "metrics": r["metrics"],
                "events": r["events"][:8], "series": r["series"],
                "end_margin": _end_margin(r["series"]),
                "delivered": r["delivered"], "blocked": r["blocked"], "needs_uplink": True,
            }
            results.append(combo)

    # Rank: score, then end-state margin, then tip cost
    results.sort(key=lambda r: (-r["score"], -(r.get("end_margin") or -99), plan_cost(r.get("cmds") or []), r["id"]))
    crit = [e for e in base["events"] if e["level"] == "crit"]
    return {
        "t0": s.t, "horizon": horizon, "baseline": base["series"], "band": band,
        "events": [e for e in base["events"] if e["key"] != "fdir"],
        "fdir": [e for e in base["events"] if e["key"] == "fdir"][:6],
        "first_critical": crit[0] if crit else None,
        "plans": results, "recommended": results[0]["id"] if results else None,
    }
