"""Fault propagation through the coupled subsystem model (no twin, no noise)."""
import pytest

from backend.model import Health, Params, State, step
from backend.plant import apply_fault

P = Params()


def run(kind=None, x=1.0, secs=3600, **cfg):
    h = Health()
    if kind:
        apply_fault(h, kind, x)
    s = State()
    for k, v in cfg.items():
        setattr(s.cfg, k, v)
    out = None
    for _ in range(int(secs)):
        out = step(s, h, P, 1.0)
    return s, out


@pytest.fixture(scope="module")
def nominal():
    return run(secs=5400)


def test_nominal_mission_is_steady(nominal):
    s, o = nominal
    assert s.soc > 0.6
    assert s.t_av < 45 and s.t_bat < 35
    assert s.att_err < 1.0
    assert o["down_ok"] and not s.auto_safe and not s.dead
    assert all(v[0] < 0.25 for v in o["couplings"].values())


def test_battery_fault_heats_battery_then_avionics(nominal):
    sn, _ = nominal
    s, o = run("battery", 0.85, secs=5400)
    assert s.t_bat > sn.t_bat + 10, "internal short + I²R must heat the battery (EPS→TCS)"
    assert s.t_av > sn.t_av + 2, "battery heat must conduct into the avionics box"
    assert s.soc < sn.soc - 0.05, "the leak drains charge"
    assert o["couplings"]["EPS>TCS"][0] > 0.5


def test_thermal_fault_degrades_navigation_and_radio(nominal):
    sn, on = nominal
    s, o = run("thermal", 1.0, secs=4800)
    assert s.t_av > sn.t_av + 15
    assert s.att_err > 2 * sn.att_err, "hot gyro drifts (TCS→GNC)"
    assert o["temp_loss"] > 0, "hot transponder derates (TCS→COMMS)"
    assert o["margin"] < on["margin"] - 1
    assert o["couplings"]["TCS>GNC"][0] > 0.2


def test_sensor_fault_mispoints_antenna_and_costs_power(nominal):
    _, on = nominal
    s, o = run("sensor", 0.9, secs=1800)
    assert s.att_err > 5
    assert o["point_loss"] > 3, "attitude error mispoints the high-gain antenna (GNC→COMMS)"
    assert o["vo"] > 0 and o["p_av"] > on["p_av"], "visual-odometry fallback draws extra power (GNC→EPS)"
    assert o["v"] == 0, "autonomy halts driving on poor attitude knowledge"


def test_comm_loss_triggers_search_then_onboard_timer():
    s, o = run("comms", 1.0, secs=700)
    assert not o["down_ok"] and not o["up_ok"]
    assert o["searching"] and o["p_comm"] == P.p_comm_search, "signal search costs power (COMMS→EPS)"
    s, o = run("comms", 1.0, secs=P.comm_loss_timer_s + 60)
    assert s.cfg.trx == "B" and s.cfg.antenna == "LGA"
    assert o["down_ok"], "transponder B over the low-gain antenna restores a low-rate link"


def test_isolating_the_bad_string_stops_the_heating(nominal):
    sn, _ = nominal
    s, _ = run("battery", 0.85, secs=5400, bat_isolated=True)
    assert s.t_bat < sn.t_bat + 3
