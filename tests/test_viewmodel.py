"""View-model contract: ops, incident, timeline, protocol."""
from backend.mission import Mission
from backend.viewmodel import PROTOCOL_VERSION, compute_ops, compute_timeline, static_model


def test_protocol_version_in_meta():
    m = Mission(seed=1)
    meta = m.meta()
    assert meta["protocol_version"] == PROTOCOL_VERSION
    assert "model" in meta and "couplings" in meta["model"]


def test_ops_nominal_when_healthy():
    m = Mission(seed=1)
    m.advance(200)
    snap = m.snapshot()
    assert "ops" in snap
    assert snap["ops"]["mode"] in ("NOMINAL", "WATCH", "DEGRADED", "CRITICAL", "SAFE")
    assert "incident" in snap
    assert snap["incident"]["status"] in (
        "none", "suspected", "diagnosed", "plan_queued", "executing", "resolved", "contained"
    )
    assert "timeline" in snap
    assert "eclipses" in snap["timeline"] and "passes" in snap["timeline"]


def test_ops_not_nominal_if_score_below_80():
    ops = compute_ops([
        {"id": "EPS", "score": 50, "status": "WARNING", "cause": "short"},
        {"id": "TCS", "score": 90, "status": "NOMINAL", "cause": ""},
    ])
    assert ops["mode"] == "DEGRADED"
    assert "EPS" in ops["reason"]


def test_timeline_has_future_passes():
    from backend.model import Params
    tl = compute_timeline(1000.0, Params(), n=3)
    assert isinstance(tl["passes"], list)


def test_static_model_catalogue():
    from backend.model import Params
    m = static_model(Params())
    assert len(m["couplings"]) >= 10
    assert m["orbit"]["gs"]["lat_deg"] == 13.0


def test_plan_score_breakdown():
    m = Mission(seed=3)
    m.advance(600)
    m.inject("battery", 0.9, 0.0)
    m.advance(1800)
    pred = m.compute_prediction(m.prediction_inputs())
    pl = pred["plans"][0]
    assert "score_breakdown" in pl
    assert "safety" in pl["score_breakdown"]
    assert "delivery" in pl
    assert "target_subsystem" in pl or pl["id"] == "continue"


def test_backtest_report_shape():
    m = Mission(seed=1)
    m.advance(100)
    rep = m.backtest_report()
    assert "rows" in rep and "summary" in rep
