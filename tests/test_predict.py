"""Prediction from the twin's estimate, and recovery plans closed through the uplink."""
import pytest

from backend.mission import Mission


def predicted(m):
    pred = m.compute_prediction(m.prediction_inputs())
    m.set_prediction(pred)
    return pred


@pytest.fixture(scope="module")
def battery_mission():
    m = Mission(seed=3)
    m.advance(900)
    m.inject("battery", 0.85, 60)
    m.advance(1500)
    return m


def test_nominal_prediction_is_quiet():
    m = Mission(seed=3)
    m.advance(900)
    pred = predicted(m)
    assert pred["first_critical"] is None
    assert pred["recommended"] == "continue"


def test_battery_fault_predicts_overheat_and_recommends_isolation(battery_mission):
    pred = predicted(battery_mission)
    assert pred["first_critical"]["key"] == "t_bat_hot"
    assert pred["recommended"] == "isolate"
    plans = {p["id"]: p for p in pred["plans"]}
    assert plans["isolate"]["metrics"]["max_t_bat"] < 50 <= plans["continue"]["metrics"]["max_t_bat"]


def test_executed_plan_reaches_the_rover_and_is_confirmed(battery_mission):
    m = battery_mission
    predicted(m)
    m.run_plan("isolate")
    assert not m.plant.s.cfg.bat_isolated, "commands take the uplink, not a shortcut"
    m.advance(60)
    assert m.plant.s.cfg.bat_isolated
    assert all(c["status"] == "confirmed" for c in m.commands)
    t_peak = m.plant.s.t_bat
    m.advance(2400)
    assert m.plant.s.t_bat < t_peak, "the battery cools once the bad string is out"
    contained = [f for f in m.twin.findings() if f["contained"]]
    assert contained, "the diagnosis survives as contained, not cured"
