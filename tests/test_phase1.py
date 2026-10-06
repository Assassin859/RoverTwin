"""Prognostics clamp, status hysteresis, hello event dedupe."""
from backend.mission import Mission
from backend.model import Params
from backend.twin import DigitalTwin, status_of, status_with_hysteresis


def test_prognostics_clamps_capacity_and_gates_rul():
    tw = DigitalTwin(Params())
    tw.h.bat_capacity_frac = 1.08
    tw.n_est["cap"] = 0
    pr = tw.prognostics()
    assert pr["capacity"] <= 1.0
    assert pr["rul_days"] is None
    assert pr["rul_ready"] is False

    tw.n_est["cap"] = 25
    tw.h.bat_capacity_frac = 0.9
    pr2 = tw.prognostics()
    assert pr2["capacity"] == 0.9
    assert pr2["rul_days"] is not None
    assert pr2["rul_days"] <= 3650
    assert pr2["rul_ready"] is True


def test_status_hysteresis_avoids_flicker():
    assert status_of(79) == "WATCH"
    # Enter WATCH from NOMINAL at <80
    assert status_with_hysteresis(79, "NOMINAL") == "WATCH"
    # Stay WATCH until leave band (>=85)
    assert status_with_hysteresis(82, "WATCH") == "WATCH"
    assert status_with_hysteresis(86, "WATCH") == "NOMINAL"
    # Enter CRITICAL below 30; leave only above 35
    assert status_with_hysteresis(29, "WARNING") == "CRITICAL"
    assert status_with_hysteresis(32, "CRITICAL") == "CRITICAL"
    assert status_with_hysteresis(36, "CRITICAL") == "WARNING"


def test_hello_event_cursor_skips_replay():
    """After hello, sent_event_id should equal mission.event_seq so first snap
    does not re-send Mission start."""
    m = Mission(seed=1)
    assert any("Mission start" in e["text"] for e in m.events)
    # Simulate what ws_endpoint does after hello
    sent = m.event_seq
    incremental = [e for e in m.events if e["id"] > sent]
    assert incremental == []
    m.advance(5)
    m.log("SYS", "later")
    incremental2 = [e for e in m.events if e["id"] > sent]
    assert len(incremental2) == 1
    assert incremental2[0]["text"] == "later"
