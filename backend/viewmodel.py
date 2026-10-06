"""Operator view-model: incident, ops, timeline, static model catalogue.

Single source of truth for the React console — panels must not re-derive status.
"""
from __future__ import annotations

import math
import uuid
from typing import Any

from .correlate import EDGE_SHORT, SUBS
from .model import LIMITS, Params, orbit_state
from .plant import FAULTS
from .predict import PLANS

PROTOCOL_VERSION = 2

# Wire IDs stay stable; UI labels map GNC→ADCS, MOB→PAYLOAD, DATA→OBDH
SUB_LABEL = {
    "EPS": "EPS", "TCS": "TCS", "GNC": "ADCS", "COMMS": "COMMS",
    "MOB": "PAYLOAD", "DATA": "OBDH",
}

COUPLING_CATALOGUE = [
    {"id": "EPS>TCS", "from": "EPS", "to": "TCS",
     "equation_tex": r"Q_{\mathrm{bat}}=I^{2}R+P_{\mathrm{leak}}",
     "equation_text": "Q_bat = I²R + P_leak → heats T_bat, then T_av via G_ab",
     "variables": ["I", "R", "P_leak", "T_bat", "T_av", "G_ab"],
     "units": {"Q_bat": "W", "T_bat": "°C", "T_av": "°C"},
     "description": "Battery I²R and internal-short heat warm the thermal nodes."},
    {"id": "TCS>EPS", "from": "TCS", "to": "EPS",
     "equation_tex": r"P_{\mathrm{heat}}+{\mathrm{age}}(T)",
     "equation_text": "Heaters + hot-cell ageing tax the battery",
     "variables": ["P_heat", "T_bat"], "units": {"P_heat": "W"},
     "description": "Thermal load feeds back onto power."},
    {"id": "TCS>GNC", "from": "TCS", "to": "GNC",
     "equation_tex": r"b_{\mathrm{gyro}}+=0.0025\max(0,T_{\mathrm{av}}-45)",
     "equation_text": "b_gyro += 0.0025·max(0, T_av−45) °/s; wheel fric↑",
     "variables": ["T_av", "b_gyro"], "units": {"b_gyro": "°/s"},
     "description": "Heat raises gyro drift and wheel friction."},
    {"id": "TCS>COMMS", "from": "TCS", "to": "COMMS",
     "equation_tex": r"L_{\mathrm{temp}}=0.2\max(0,T_{\mathrm{av}}-45)",
     "equation_text": "L_temp = 0.2·max(0, T_av−45) dB",
     "variables": ["T_av", "L_temp"], "units": {"L_temp": "dB"},
     "description": "Hot radio electronics lose link margin."},
    {"id": "TCS>MOB", "from": "TCS", "to": "MOB",
     "equation_tex": r"\mathrm{duty}\propto\mathbf{1}[T_{\mathrm{av}}<T_{\mathrm{lim}}]",
     "equation_text": "Imaging duty limited when T_av is high",
     "variables": ["T_av", "duty"], "units": {"duty": "1"},
     "description": "Thermal limit inhibits payload imaging."},
    {"id": "EPS>GNC", "from": "EPS", "to": "GNC",
     "equation_tex": r"\tau\propto\mathrm{brownout}(V_{\mathrm{bus}})",
     "equation_text": "Brownout × wheel saturation caps torque",
     "variables": ["V_bus", "tau"], "units": {"V_bus": "V"},
     "description": "Bus sag caps reaction-wheel torque."},
    {"id": "EPS>COMMS", "from": "EPS", "to": "COMMS",
     "equation_tex": r"L_{\mathrm{brown}}(V_{\mathrm{bus}})",
     "equation_text": "L_brownout(V_bus) in the link budget",
     "variables": ["V_bus", "L_brown"], "units": {"L_brown": "dB"},
     "description": "Low bus voltage weakens the radio."},
    {"id": "EPS>MOB", "from": "EPS", "to": "MOB",
     "equation_tex": r"\mathrm{duty}\propto\mathrm{SoC},\,V_{\mathrm{bus}}",
     "equation_text": "Payload shed when SOC / bus is low",
     "variables": ["SoC", "V_bus", "duty"], "units": {"SoC": "1"},
     "description": "Undervoltage / low SoC sheds imaging."},
    {"id": "GNC>COMMS", "from": "GNC", "to": "COMMS",
     "equation_tex": r"L_{\mathrm{point}}=12(\theta/\mathrm{beam})^{2}",
     "equation_text": "L_point = 12·(θ/beam)² on the HGA",
     "variables": ["theta", "beam", "L_point"], "units": {"theta": "°", "L_point": "dB"},
     "description": "Attitude error mispoints the antenna."},
    {"id": "GNC>EPS", "from": "GNC", "to": "EPS",
     "equation_tex": r"P_{\mathrm{ADCS}}\le +14\,\mathrm{W}",
     "equation_text": "ADCS compute ≤ +14 W when pointing is bad",
     "variables": ["P_ADCS"], "units": {"P_ADCS": "W"},
     "description": "ADCS works harder and burns extra power."},
    {"id": "GNC>MOB", "from": "GNC", "to": "MOB",
     "equation_tex": r"\mathrm{inhibit}:\ \theta>8^\circ",
     "equation_text": "Imaging inhibit when attitude error > 8°",
     "variables": ["theta"], "units": {"theta": "°"},
     "description": "Poor pointing kills imaging quality."},
    {"id": "COMMS>EPS", "from": "COMMS", "to": "EPS",
     "equation_tex": r"P_{\mathrm{search}}",
     "equation_text": "Search power when no lock past timer",
     "variables": ["P_search"], "units": {"P_search": "W"},
     "description": "Signal search draws extra power."},
    {"id": "COMMS>DATA", "from": "COMMS", "to": "DATA",
     "equation_tex": r"\dot B=\mathrm{science}-\mathrm{downlink}",
     "equation_text": "Buffer fill while off-pass / link down",
     "variables": ["B", "science", "downlink"], "units": {"B": "MB"},
     "description": "OBDH buffer fills until the next pass."},
    {"id": "MOB>EPS", "from": "MOB", "to": "EPS",
     "equation_tex": r"P_{\mathrm{pay}}+P_{\mathrm{wheels}}",
     "equation_text": "P_payload + P_wheels on the bus",
     "variables": ["P_pay", "P_wheels"], "units": {"P_pay": "W"},
     "description": "Payload and wheels tax the battery."},
]


def compute_ops(subsystems: list[dict], cfg: dict | None = None) -> dict:
    """NOMINAL≥80, WATCH 60–79, DEGRADED 40–59, CRITICAL<40; SAFE if FDIR mode."""
    cfg = cfg or {}
    if cfg.get("mode") == "SAFE":
        return {
            "mode": "SAFE",
            "reason": cfg.get("auto_safe") or "autonomous SAFE",
            "worst_subsystem": None,
        }
    worst = None
    for s in subsystems or []:
        if worst is None or float(s.get("score", 100)) < float(worst.get("score", 100)):
            worst = s
    if not worst:
        return {"mode": "NOMINAL", "reason": "all subsystems healthy", "worst_subsystem": None}
    sc = float(worst["score"])
    sid = worst["id"]
    label = SUB_LABEL.get(sid, sid)
    cause = (worst.get("cause") or "").strip()
    if sc < 40:
        mode = "CRITICAL"
    elif sc < 60:
        mode = "DEGRADED"
    elif sc < 80:
        mode = "WATCH"
    else:
        mode = "NOMINAL"
    if mode == "NOMINAL":
        reason = "all subsystems ≥ 80"
    else:
        reason = f"{label} {int(round(sc))}" + (f": {cause}" if cause else "")
    return {"mode": mode, "reason": reason, "worst_subsystem": sid}


def _wattage_from_text(text: str) -> float | None:
    import re
    m = re.search(r"~?\s*(-?\d+(?:\.\d+)?)\s*W", text or "", re.I)
    return abs(float(m.group(1))) if m else None


def compute_incident(
    *,
    t: float,
    findings: list[dict],
    couplings: dict,
    subsystems: list[dict],
    prediction: dict | None,
    plan_state: dict | None = None,
    prev: dict | None = None,
) -> dict:
    """Build incident view-model; freeze magnitude at first diagnosis."""
    prev = prev or {}
    plan_state = plan_state or {}
    active = [f for f in (findings or []) if not f.get("contained")]
    contained = [f for f in (findings or []) if f.get("contained")]

    status = "none"
    root = None
    if plan_state.get("state") == "CONFIRMED" and (not active or all(f.get("contained") for f in findings or [])):
        status = "resolved"
    elif plan_state.get("state") in ("QUEUED", "UPLINKED"):
        status = "plan_queued"
    elif plan_state.get("state") == "EXECUTED":
        status = "executing"
    elif active:
        status = "diagnosed"
    elif contained and not active:
        status = "contained"
    elif any(float(s.get("score", 100)) < 80 for s in (subsystems or [])):
        status = "suspected"

    if active:
        f0 = active[0]
        root = {
            "subsystem": f0.get("sub"),
            "kind": f0.get("id"),
            "text": f0.get("text") or "",
            "confidence": float(f0.get("conf") or 0.9),
            "detected_at_t": (prev.get("root") or {}).get("detected_at_t", t),
            "diagnosed_at_t": (prev.get("root") or {}).get("diagnosed_at_t", t),
        }

    magnitude = prev.get("magnitude")
    if root and magnitude is None:
        w = _wattage_from_text(root["text"])
        if w is not None:
            magnitude = {"label": "self-heating", "value": w, "unit": "W", "frozen_at_t": t}
    if status in ("none",) and not active:
        magnitude = None

    hops = []
    for key, val in (couplings or {}).items():
        s = float(val[0]) if isinstance(val, (list, tuple)) else float(val or 0)
        if s < 0.12 or ">" not in key:
            continue
        a, b = key.split(">", 1)
        live = val[1] if isinstance(val, (list, tuple)) and len(val) > 1 else EDGE_SHORT.get(key, key)
        hops.append({
            "from": a, "to": b, "rule_id": key,
            "value": round(s, 3), "unit": "1",
            "at_t": t, "why": live,
        })
    hops.sort(key=lambda h: -h["value"])

    fc = (prediction or {}).get("first_critical")
    events = (prediction or {}).get("events") or []
    if fc:
        band = None
        if prediction and prediction.get("band", {}).get("t_bat"):
            # crude band from ensemble column near fc.t
            cols = prediction["band"]["t_bat"]
            idx = min(len(cols) - 1, max(0, int(float(fc.get("t") or 0) / 30)))
            lo, hi = cols[idx] if idx < len(cols) else (None, None)
            if lo is not None:
                band = [float(lo), float(hi)]
        kind = "critical" if fc.get("level") == "crit" else "risk"
        forecast_headline = {
            "kind": kind,
            "text": fc.get("text") or "",
            "earliest_event_t": float(fc.get("t") or 0),
            "band": band,
        }
    elif events and status not in ("none", "resolved"):
        forecast_headline = {
            "kind": "watch",
            "text": events[0].get("text") or "Watch items in forecast",
            "earliest_event_t": float(events[0].get("t") or 0),
            "band": None,
        }
    elif status in ("none", "resolved") and not events:
        forecast_headline = {
            "kind": "clear", "text": "All clear for the next 2 hours",
            "earliest_event_t": None, "band": None,
        }
    else:
        # Never "clear" while events or active incident
        forecast_headline = {
            "kind": "watch",
            "text": (events[0].get("text") if events else "Monitoring"),
            "earliest_event_t": float(events[0]["t"]) if events else None,
            "band": None,
        }

    iid = prev.get("id") or (uuid.uuid4().hex[:12] if status != "none" else None)
    if status == "none":
        iid = None

    return {
        "id": iid,
        "status": status,
        "root": root,
        "magnitude": magnitude,
        "hops": hops[:8],
        "forecast_headline": forecast_headline,
        "recommended_plan_id": (prediction or {}).get("recommended"),
        "executed_plan_id": plan_state.get("plan_id"),
        "plan_state": plan_state.get("state"),
        "resolved_at_t": t if status == "resolved" else prev.get("resolved_at_t"),
    }


def compute_timeline(t: float, p: Params, n: int = 3) -> dict:
    """Next eclipses and ground passes from the orbit clock."""
    period = p.orbit_period_s
    eclipses, passes = [], []
    # Sample forward ~4 orbits at 30 s
    horizon = period * 4
    in_ecl = in_pass = False
    ecl_start = pass_start = None
    dt = 30.0
    steps = int(horizon / dt)
    for i in range(steps + 1):
        ti = t + i * dt
        st = orbit_state(ti, p)
        if st["eclipse"] and not in_ecl:
            in_ecl, ecl_start = True, ti
        elif not st["eclipse"] and in_ecl:
            eclipses.append({"start": ecl_start, "end": ti})
            in_ecl = False
            if len(eclipses) >= n:
                pass
        if st["gs_pass"] and not in_pass:
            in_pass, pass_start = True, ti
        elif not st["gs_pass"] and in_pass:
            passes.append({"start": pass_start, "end": ti})
            in_pass = False
    if in_ecl and ecl_start is not None and len(eclipses) < n:
        eclipses.append({"start": ecl_start, "end": t + horizon})
    if in_pass and pass_start is not None and len(passes) < n:
        passes.append({"start": pass_start, "end": t + horizon})
    return {
        "eclipses": eclipses[:n],
        "passes": passes[:n],
        "now": t,
    }


def static_model(p: Params) -> dict:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "subsystems": [
            {"id": s, "label": SUB_LABEL[s]} for s in SUBS
        ],
        "couplings": COUPLING_CATALOGUE,
        "faults": FAULTS,
        "plans": [{"id": pl["id"], "name": pl["name"], "plain": pl["plain"],
                   "roots": sorted(pl.get("roots") or ())} for pl in PLANS],
        "thresholds": {
            "ops": {"NOMINAL": 80, "WATCH": 60, "DEGRADED": 40, "CRITICAL": 0},
            "limits": dict(LIMITS),
        },
        "orbit": {
            "altitude_km": 500,
            "period_s": p.orbit_period_s,
            "eclipse_frac": p.eclipse_frac,
            "beta_deg": p.beta_deg,
            "gs": {
                "name": "Bengaluru",
                "lat_deg": p.gs_lat_deg,
                "lon_deg": p.gs_lon_deg,
                "mask_deg": p.gs_mask_deg,
                "every_n_orbits": p.gs_pass_every_n_orbits,
            },
        },
        "assumptions": [
            "Circular LEO (~500 km); fixed eclipse fraction — not full ephemeris.",
            "Bengaluru GS; AOS/LOS from orbit clock + mask.",
            "1 Hz plant/twin step; pass-gated TM/TC only.",
            "Twin never reads the plant — only pass-gated frames + its own model.",
        ],
    }


def next_aos_t(t: float, p: Params, up_ok: bool = False) -> float:
    if up_ok:
        return t
    st = orbit_state(t, p)
    return t + float(st.get("next_pass_s") or 0.0)
