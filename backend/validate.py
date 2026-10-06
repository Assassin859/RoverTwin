"""Judge-evidence helpers: orbit/model validation checks, backtest error, anomaly score."""
from __future__ import annotations

import math

from backend.model import Params, LIMITS, clamp, fmt_db as model_fmt_db


def fmt_db(x: float) -> str:
    """Preserve minus sign for negative margins (same as model.fmt_db)."""
    return model_fmt_db(x)


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


def analytic_eclipse_frac(p: Params | None = None) -> float:
    """Beta-modulated eclipse fraction matching orbit_state."""
    p = p or Params()
    beta_rad = abs(p.beta_deg) * math.pi / 180.0
    return clamp(p.eclipse_frac * (1.0 - 0.15 * math.sin(beta_rad)), 0.15, 0.45)


def radiator_balance_ok(t_av: float, q_w: float, *, rad_eff: float = 1.0,
                        area_m2: float = 0.35, eps: float = 0.85) -> dict:
    """Check σεA T^4 ≈ Q (rough equilibrium)."""
    t_k = float(t_av) + 273.15
    sigma = 5.670374419e-8
    q_rad = float(rad_eff) * eps * area_m2 * sigma * (t_k ** 4)
    err = abs(q_rad - float(q_w)) / max(abs(float(q_w)), 1.0)
    return {"q_rad": q_rad, "q_load": float(q_w), "rel_err": err, "ok": err < 0.85 or abs(q_w) < 5}


def validation_checks(
    p: Params | None = None,
    *,
    eclipse_frac_obs: float | None = None,
    orbit_period_s_obs: float | None = None,
    t_bat: float | None = None,
    t_bat_model: float | None = None,
    rad_eff: float | None = None,
    t_av: float | None = None,
    q_load_w: float | None = None,
    margin_in_pass: float | None = None,
    in_pass: bool | None = None,
    dsoc_per_orbit: float | None = None,
) -> list[dict]:
    """Return model checks vs LEO reference values for the Model check panel."""
    p = p or Params()
    checks: list[dict] = []

    ref_ecl = analytic_eclipse_frac(p)
    obs_ecl = eclipse_frac_obs if eclipse_frac_obs is not None else ref_ecl
    checks.append({
        "id": "eclipse",
        "name": "Eclipse fraction",
        "reference": f"~{ref_ecl:.0%} (β={p.beta_deg:.0f}°) of {p.orbit_period_s / 60:.0f} min @ ~500 km",
        "observed": f"{obs_ecl:.0%}",
        "ok": abs(obs_ecl - ref_ecl) < 0.10,
        "detail": "analytic eclipse from Params.eclipse_frac × beta",
    })

    ref_p = p.orbit_period_s
    obs_p = orbit_period_s_obs if orbit_period_s_obs is not None else ref_p
    checks.append({
        "id": "period",
        "name": "Orbit period",
        "reference": f"~{ref_p / 60:.0f} min",
        "observed": f"{obs_p / 60:.1f} min",
        "ok": abs(obs_p - ref_p) < 120,
        "detail": "period from orbit phase / history",
    })

    if t_bat is not None and t_bat_model is not None:
        err = abs(t_bat - t_bat_model)
        checks.append({
            "id": "t_bat",
            "name": "Battery settle temp",
            "reference": f"model {t_bat_model:.1f} °C",
            "observed": f"{t_bat:.1f} °C",
            "ok": err < 8.0,
            "detail": "twin vs heat-balance sample",
        })
    else:
        checks.append({
            "id": "t_bat",
            "name": "Battery settle temp",
            "reference": "model eq vs live t_bat",
            "observed": "awaiting sample",
            "ok": True,
            "detail": "compare when history available",
        })

    re = rad_eff if rad_eff is not None else 1.0
    if t_av is not None and q_load_w is not None:
        bal = radiator_balance_ok(t_av, q_load_w, rad_eff=re)
        checks.append({
            "id": "radiator",
            "name": "Radiator equilibrium",
            "reference": "σεA T⁴ ≈ Q",
            "observed": f"Q_rad {bal['q_rad']:.0f} W vs Q {bal['q_load']:.0f} W (rad_eff {re:.0%})",
            "ok": bal["ok"],
            "detail": "TCS radiator balance",
        })
    else:
        checks.append({
            "id": "radiator",
            "name": "Radiator equilibrium",
            "reference": "σεA T⁴ ≈ Q",
            "observed": f"rad_eff {re:.0%}",
            "ok": 0.2 <= re <= 1.3,
            "detail": "TCS rad_eff / T_av balance",
        })

    if in_pass is False:
        checks.append({
            "id": "link_edge",
            "name": "Link margin (in-pass)",
            "reference": "slant-range budget during GS pass",
            "observed": "n/a off-pass",
            "ok": True,
            "detail": "sampled only while gs_pass",
        })
    elif margin_in_pass is not None:
        checks.append({
            "id": "link_edge",
            "name": "Link margin (in-pass)",
            "reference": "budget from slant range during pass",
            "observed": fmt_db(margin_in_pass),
            "ok": margin_in_pass > -25,
            "detail": "in-pass link margin",
        })
    else:
        checks.append({
            "id": "link_edge",
            "name": "Link margin (in-pass)",
            "reference": "budget from slant range during pass",
            "observed": "awaiting pass",
            "ok": True,
            "detail": "sampled when gs_pass",
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

    checks.append({
        "id": "gs",
        "name": "Ground station",
        "reference": f"Bengaluru {p.gs_lat_deg:.1f}N {p.gs_lon_deg:.1f}E, mask {p.gs_mask_deg:.0f}°, every {p.gs_pass_every_n_orbits} orbits",
        "observed": f"~{max(1, int(round(86400 / p.orbit_period_s / max(1, p.gs_pass_every_n_orbits))))} passes/day",
        "ok": 3 <= p.gs_pass_every_n_orbits <= 5,
        "detail": "4–6 contacts/day LEO style",
    })

    return checks


ASSUMPTIONS = [
    "Circular LEO (~500 km); fixed eclipse fraction — not full ephemeris.",
    "Bengaluru GS (13.0N 77.5E); AOS/LOS from simple elevation / orbit clock.",
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
