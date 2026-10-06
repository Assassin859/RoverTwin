"""Battery inject → cause→effect correlation paths and matrix."""
from backend.mission import Mission


def test_battery_correlation_paths_include_eps_tcs():
    m = Mission(seed=3)
    m.advance(900)
    m.inject("battery", 0.85, 60)
    m.advance(2400)
    corr = m.twin.correlations()
    assert corr["matrix"]["EPS"]["TCS"] >= 0.08
    assert "EPS>TCS" in corr["active"]
    assert any(p["from"] == "EPS" and "EPS>TCS" in p["edges"] for p in corr["paths"])
    # Phantom foreshadowing removed: cool avionics must not light TCS>GNC
    if m.twin.s.t_av < 40:
        assert corr["matrix"]["TCS"]["GNC"] < 0.12 or "TCS>GNC" not in corr["active"]


def test_thermal_fault_can_light_tcs_gnc():
    m = Mission(seed=2)
    m.advance(600)
    m.inject("thermal", 1.0, 60)
    m.advance(3000)
    corr = m.twin.correlations()
    assert corr["matrix"]["TCS"]["GNC"] >= 0.12 or any(
        "TCS>GNC" in (p.get("edges") or []) for p in corr["paths"]
    )


def test_snapshot_exposes_correlations():
    m = Mission(seed=1)
    m.advance(120)
    snap = m.snapshot()
    assert "correlations" in snap
    assert set(snap["correlations"]) >= {"matrix", "paths", "active"}
    assert "EPS" in snap["correlations"]["matrix"]
