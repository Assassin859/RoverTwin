"""Prediction from the twin's estimate, and recovery plans closed through the uplink."""
import pytest

from backend.mission import Mission


def predicted(m):
    pred = m.compute_prediction(m.prediction_inputs())
    m.set_prediction(pred)
    return pred


def wait_for_pass(m, limit_s=22000):
    t0 = m.t
    while m.t - t0 < limit_s:
        if m.plant.o.get("up_ok"):
            return True
        m.advance(30)
    return False


@pytest.fixture(scope="module")
def battery_mission():
    m = Mission(seed=3)
    m.advance(900)
    m.inject("battery", 0.85, 60)
    m.advance(2000)
    return m


def test_nominal_prediction_is_quiet():
    m = Mission(seed=3)
    m.advance(900)
    pred = predicted(m)
    assert pred["first_critical"] is None
    assert pred["recommended"] == "continue"
    assert len(pred["plans"]) == 1
    assert pred["plans"][0]["id"] == "continue"
    assert "No action" in pred["plans"][0]["name"] or "nominal" in pred["plans"][0]["notes"][0].lower()


def test_battery_fault_predicts_overheat_and_recommends_isolation(battery_mission):
    pred = predicted(battery_mission)
    assert pred["first_critical"] is not None
    assert pred["first_critical"]["key"] in ("t_bat_hot", "t_av_hot", "soc_low")
    plans = {p["id"]: p for p in pred["plans"]}
    assert "isolate" in plans
    # Isolation should improve peak battery temp vs doing nothing
    assert plans["isolate"]["metrics"]["max_t_bat"] <= plans["continue"]["metrics"]["max_t_bat"] + 0.5
    assert pred["recommended"] in ("isolate", "safe", "shed", "shade") or plans["isolate"]["score"] >= plans["continue"]["score"]


def test_executed_plan_reaches_the_rover_and_is_confirmed(battery_mission):
    m = battery_mission
    predicted(m)
    assert wait_for_pass(m), "need a ground pass to uplink"
    m.run_plan("isolate")
    assert not m.plant.s.cfg.bat_isolated, "commands take the uplink, not a shortcut"
    m.advance(120)
    assert m.plant.s.cfg.bat_isolated
    assert any(c["name"] == "bat_isolated" and c["status"] == "confirmed" for c in m.commands)
    t_peak = m.plant.s.t_bat
    m.advance(2400)
    assert m.plant.s.t_bat <= t_peak + 1.0, "the battery cools (or stops heating) once the bad string is out"
    contained = [f for f in m.twin.findings() if f["contained"]]
    assert contained, "the diagnosis survives as contained, not cured"
