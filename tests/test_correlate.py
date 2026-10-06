"""Battery inject → cause→effect correlation paths and matrix."""
from backend.mission import Mission


def test_battery_correlation_paths_include_eps_tcs():
    m = Mission(seed=3)
    m.advance(900)
    m.inject("battery", 0.85, 60)
    m.advance(2400)
    corr = m.twin.correlations()
    assert corr["matrix"]["EPS"]["TCS"] >= 0.08
    edge_sets = [tuple(p["edges"]) for p in corr["paths"]]
    assert any("EPS>TCS" in edges for edges in edge_sets)
    assert "EPS>TCS" in corr["active"]
    assert any(p["from"] == "EPS" for p in corr["paths"])


def test_snapshot_exposes_correlations():
    m = Mission(seed=1)
    m.advance(120)
    snap = m.snapshot()
    assert "correlations" in snap
    assert set(snap["correlations"]) >= {"matrix", "paths", "active"}
    assert "EPS" in snap["correlations"]["matrix"]
