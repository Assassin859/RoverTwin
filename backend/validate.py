"""Judge-evidence helpers: orbit/model validation checks, backtest error, anomaly score."""
from __future__ import annotations

from backend.model import Params, LIMITS, clamp


def fmt_db(x: float) -> str:
    ax = abs(float(x))
    if ax < 0.05:
        return "0.0 dB"
    return f"{ax:.1f} dB"


def backtest_pct_error(predicted: float, actual: float) -> float:
    """Percent relative error |pred−actual| / max(|actual|, ε) × 100."""
    denom = max(abs(float(actual)), 1e-6)
    return abs(float(predicted) - float(actual)) / denom * 100.0


def anomaly_score(residuals: dict[str, float], sigma: float = 3.5) -> dict:
    """NASA-style residual anomaly: max |z| and count of channels above threshold."""
    zs = {k: float(v) for k, v in (residuals or {}).items()}
    if not zs:
        return {"max_abs_z": 0.0, "n_above": 0, "channels": []}
    above = [k for k, z in zs.items() if abs(z) > sigma]
    return {
        "max_abs_z": max(abs(z) for z in zs.values()),
        "n_above": len(above),
        "channels": above,
    }


def validation_checks(
    p: Params | None = None,
    *,
    eclipse_frac_obs: float | None = None,
    orbit_period_s_obs: float | None = None,
    t_bat: float | None = None,
    t_bat_model: float | None = None,
    rad_eff: float | None = None,
    margin_edge: float | None = None,
    dsoc_per_orbit: float | None = None,
) -> list[dict]:
    """Return 5–6 model checks vs LEO reference values for the Model check panel."""
    p = p or Params()
    checks: list[dict] = []

    ref_ecl = p.eclipse_frac
    obs_ecl = eclipse_frac_obs if eclipse_frac_obs is not None else ref_ecl
    checks.append({
        "id": "eclipse",
        "name": "Eclipse fraction",
        "reference": f"~{ref_ecl:.0%} of {p.orbit_period_s / 60:.0f} min @ ~500 km",
        "observed": f"{obs_ecl:.0%}",
        "ok": abs(obs_ecl - ref_ecl) < 0.08,
        "detail": "circular LEO eclipse from Params.eclipse_frac / orbit_state",
    })

    ref_p = p.orbit_period_s
    obs_p = orbit_period_s_obs if orbit_period_s_obs is not None else ref_p
    checks.append({
        "id": "period",
        "name": "Orbit period",
        "reference": f"~{ref_p / 60:.0f} min",
        "observed": f"{obs_p / 60:.1f} min",
        "ok": abs(obs_p - ref_p) < 120,
        "detail": "orbit_period_s",
    })

    if t_bat is not None and t_bat_model is not None:
        err = abs(t_bat - t_bat_model)
        checks.append({
            "id": "t_bat",
            "name": "Battery settle temp",
            "reference": f"model {t_bat_model:.1f} °C",
            "observed": f"{t_bat:.1f} °C",
            "ok": err < 8.0,
            "detail": "twin vs plant sample (truth harness)",
        })
    else:
        checks.append({
            "id": "t_bat",
            "name": "Battery settle temp",
            "reference": "model eq vs live t_bat",
            "observed": "awaiting sample",
            "ok": True,
            "detail": "compare when truth or twin history available",
        })

    re = rad_eff if rad_eff is not None else 1.0
    checks.append({
        "id": "radiator",
        "name": "Radiator equilibrium",
        "reference": "rad_eff ≈ 1.0 balanced with T_av",
        "observed": f"rad_eff {re:.0%}",
        "ok": 0.2 <= re <= 1.3,
        "detail": "TCS rad_eff / T_av balance",
    })

    if margin_edge is not None:
        checks.append({
            "id": "link_edge",
            "name": "Link margin @ pass edge",
            "reference": "budget near AOS/LOS fringe (~0 dB)",
            "observed": fmt_db(margin_edge),
            "ok": margin_edge > -25,
            "detail": "margin near pass boundary",
        })
    else:
        checks.append({
            "id": "link_edge",
            "name": "Link margin @ pass edge",
            "reference": "budget near AOS/LOS fringe",
            "observed": "awaiting pass edge",
            "ok": True,
            "detail": "sampled when next_pass_s small or just after LOS",
        })

    if dsoc_per_orbit is not None:
        checks.append({
            "id": "soc_depth",
            "name": "SoC depth per orbit",
            "reference": "ΔSOC over one period (shallow LEO cycle)",
            "observed": f"Δ {dsoc_per_orbit:+.0%}",
            "ok": abs(dsoc_per_orbit) < 0.45,
            "detail": "history window over orbit_period_s",
        })
    else:
        checks.append({
            "id": "soc_depth",
            "name": "SoC depth per orbit",
            "reference": "ΔSOC over one ~95 min period",
            "observed": "need ≥1 orbit history",
            "ok": True,
            "detail": "history window",
        })

    return checks


ASSUMPTIONS = [
    "Circular LEO (~500 km); fixed eclipse fraction — not full ephemeris.",
    "Fixed ground-station geometry; AOS/LOS from simple elevation model.",
    "1 Hz discrete plant/twin step; no continuous SimPy event queue.",
    "Telemetry and uplink only during ground-station passes.",
    "Twin never reads the plant — only pass-gated frames + its own model.",
]


def ensemble_threshold_band(
    band: dict | None,
    key: str,
    limit: float,
    *,
    low: bool = False,
    dt: float = 30.0,
) -> dict | None:
    """Min/max time-to-threshold from ensemble band crossing a limit."""
    if not band or key not in band:
        return None
    cols = band[key]
    times = []
    for i, pair in enumerate(cols):
        lo, hi = pair[0], pair[1]
        crossed = (lo <= limit) if low else (hi >= limit)
        if crossed:
            times.append(i * dt)
    if not times:
        return None
    return {"t_min": min(times), "t_max": max(times), "limit": limit, "key": key}
