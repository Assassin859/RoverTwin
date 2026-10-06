"""Judge-evidence helpers: validation, backtest, anomaly, CSV ingest, scoring."""
from backend.model import Params, step, State, Health, fmt_db
from backend.validate import (
    validation_checks, backtest_pct_error, anomaly_score, ASSUMPTIONS,
)
from backend.mission import Mission
from backend.predict import plan_cost
from backend.cascade_chain import CascadeTracker


def test_validation_eclipse_approx_035():
    checks = validation_checks(Params())
    ecl = next(c for c in checks if c["id"] == "eclipse")
    assert ecl["ok"]
    assert "35%" in ecl["reference"] or "0.35" in str(Params().eclipse_frac)
    assert abs(Params().eclipse_frac - 0.35) < 1e-6
    assert ASSUMPTIONS


def test_backtest_pct_error_formula():
    assert abs(backtest_pct_error(52.0, 51.3) - (0.7 / 51.3 * 100)) < 1e-6
    assert backtest_pct_error(10, 10) == 0.0


def test_anomaly_score_from_z_map():
    a = anomaly_score({"soc": 1.0, "t_bat": 4.2, "margin": -5.0})
    assert a["n_above"] == 2
    assert a["max_abs_z"] == 5.0
    assert "t_bat" in a["channels"] and "margin" in a["channels"]


def test_fmt_db_no_double_negative():
    assert fmt_db(0.0) == "0.0 dB"
    assert fmt_db(-0.01) == "0.0 dB"
    assert "--" not in fmt_db(0.0)
    assert fmt_db(3.2) == "3.2 dB"
    s = State(soc=0.5, t_av=20, t_bat=20)
    o = step(s, Health(), Params(), 1.0)
    label = o["couplings"]["EPS>COMMS"][1]
    assert "--" not in label
    assert "-0.0" not in label or label.startswith("0.0")


def test_isolate_beats_continue_score():
    m = Mission(seed=3)
    m.advance(600)
    m.inject("battery", 0.9, 0.0)
    m.advance(1800)
    pred = m.compute_prediction(m.prediction_inputs())
    plans = {p["id"]: p for p in pred["plans"]}
    assert "isolate" in plans
    assert plans["isolate"]["score"] >= plans["continue"]["score"]
    assert plans["isolate"]["metrics"]["max_t_bat"] <= plans["continue"]["metrics"]["max_t_bat"] + 1.0
    assert plans["isolate"].get("why")
    assert plan_cost([("bat_isolated", True)]) < 2.0


def test_battery_mob_payload_score_drops():
    m = Mission(seed=3)
    m.advance(400)
    m.inject("battery", 0.9, 0.0)
    m.advance(2400)
    subs = {s["id"]: s for s in m.twin.subsystems()}
    assert subs["MOB"]["score"] < 100
    assert subs["EPS"]["score"] < 100


def test_cascade_resolved_text_frozen():
    tr = CascadeTracker()
    view = {"cfg": {"drive": True, "payload": True, "mode": "NOMINAL"}, "down_ok": True}
    findings = [{"id": "bat_leak", "sub": "EPS", "text": "short ~40 W", "contained": ""}]
    corr = {"active": ["EPS>COMMS"], "paths": []}
    coup = {"EPS>COMMS": (0.9, "3.2 dB low bus voltage")}
    tr.update(10, findings, corr, coup, [], view, [])
    # Resolve
    tr.update(20, [], {"active": [], "paths": []}, coup, [], view, [])
    snap1 = tr.snapshot({"EPS>COMMS": (0.1, "0.0 dB low bus voltage")}, [], [])
    edge = next(s for s in snap1["stages"] if s["kind"] == "edge")
    assert edge.get("resolved")
    frozen = edge["text"]
    snap2 = tr.snapshot({"EPS>COMMS": (0.95, "9.9 dB low bus voltage")}, [], [])
    edge2 = next(s for s in snap2["stages"] if s["kind"] == "edge")
    assert edge2["text"] == frozen
    assert "9.9" not in edge2["text"]


def test_csv_ingest_roundtrip():
    m = Mission(seed=1)
    m.advance(120)
    rows = [
        {"t": 10, "seq": 1, "soc": 0.55, "v_bus": 28.1, "i_bat": 0.2, "t_av": 22, "t_bat": 21, "margin": 8, "rate": 120},
        {"t": 11, "seq": 2, "soc": 0.55, "v_bus": 28.0, "i_bat": 0.2, "t_av": 22, "t_bat": 21, "margin": 8, "rate": 120},
        {"t": 12, "seq": 3, "soc": 0.54, "v_bus": 28.0, "i_bat": 0.3, "t_av": 22, "t_bat": 21, "margin": 7, "rate": 120},
        {"t": 13, "seq": 4, "soc": 0.54, "v_bus": 27.9, "i_bat": 0.3, "t_av": 22, "t_bat": 22, "margin": 7, "rate": 120},
        {"t": 14, "seq": 5, "soc": 0.54, "v_bus": 27.9, "i_bat": 0.3, "t_av": 22, "t_bat": 22, "margin": 7, "rate": 120},
        {"t": 15, "seq": 6, "soc": 0.53, "v_bus": 27.8, "i_bat": 0.4, "t_av": 23, "t_bat": 22, "margin": 6, "rate": 100},
    ]
    out = m.ingest_csv_rows(rows)
    assert out["ingested"] == 6
    assert out["rx"] >= 6
    assert out["sync"] in ("SYNCED", "INIT", "LOW RATE")
