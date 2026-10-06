"""Fault propagation through the coupled LEO smallsat model (no twin, no noise)."""
import pytest

from backend.model import Health, Params, State, orbit_state, step
from backend.plant import apply_fault

P = Params()


def run(kind=None, x=1.0, secs=3600, t0=0.0, **cfg):
    h = Health()
    if kind:
        apply_fault(h, kind, x)
    s = State(t=t0)
    for k, v in cfg.items():
        setattr(s.cfg, k, v)
    out = None
    for _ in range(int(secs)):
        out = step(s, h, P, 1.0)
    return s, out


@pytest.fixture(scope="module")
def nominal():
    # Two orbits so sunlit/eclipse cycle settles
    return run(secs=int(2 * P.orbit_period_s))


def test_orbit_state_sunlit_eclipse_and_pass():
    sun, ecl, passes = 0, 0, 0
    for i in range(int(P.orbit_period_s)):
        st = orbit_state(float(i), P)
        sun += int(st["sunlit"])
        ecl += int(st["eclipse"])
        passes += int(st["gs_pass"])
    assert sun + ecl == int(P.orbit_period_s)
    assert 0.25 < ecl / P.orbit_period_s < 0.45
    assert passes > 100
    assert orbit_state(0.0, P)["next_pass_s"] >= 0


def test_nominal_mission_is_steady(nominal):
    s, o = nominal
    assert s.soc > 0.35
    assert s.t_av < 65 and s.t_bat < 45
    assert s.att_err < 5.0
    assert not s.dead
    assert s.cfg.mode == "NOMINAL"
    # Heater / off-pass buffer edges may light; other couplings stay modest
    ignore = {"TCS>EPS", "COMMS>DATA"}
    hot = {k: v for k, v in o["couplings"].items() if k not in ignore}
    assert all(v[0] < 0.95 for v in hot.values())


def test_battery_fault_hits_at_least_three_subsystems(nominal):
    """Goal: battery degradation lights ≥3 coupled subsystems in the demo window."""
    sn, _ = nominal
    t0 = P.orbit_period_s * 0.95
    s, o = run("battery", 0.85, secs=2400, t0=t0)
    assert s.t_bat > sn.t_bat + 5
    assert s.soc < sn.soc - 0.03
    coup = o["couplings"]
    lit = [k for k, v in coup.items() if v[0] >= 0.12]
    assert "EPS>TCS" in lit
    touched = set()
    for k in lit:
        a, b = k.split(">")
        touched.add(a)
        touched.add(b)
    assert "EPS" in touched and len(touched) >= 3


def test_thermal_fault_degrades_adcs_and_radio(nominal):
    sn, _ = nominal
    s, o = run("thermal", 1.0, secs=4800)
    assert s.t_av > sn.t_av + 10
    assert s.att_err > sn.att_err
    assert o["temp_loss"] >= 0
    assert o["couplings"]["TCS>GNC"][0] > 0.15


def test_sensor_fault_hurts_pointing_and_payload(nominal):
    s, o = run("sensor", 0.9, secs=1800)
    assert s.att_err > 4
    # Imaging inhibited by attitude FDIR (duty/drive/payload)
    assert o["imaging_duty"] < 0.5 or not o["payload_on"] or not s.cfg.drive
    assert o["point_loss"] > 1 or s.cfg.antenna == "LGA" or s.att_err > 8


def test_comm_loss_blocks_pass_link():
    # Accumulate missed-AOS contact time across several passes with dead TRX-A
    s, o = run("comms", 1.0, secs=int(P.comm_loss_timer_s + P.orbit_period_s), t0=0.0)
    assert o["trx_loss"] > 20 or s.cfg.trx == "B"
    assert s.cfg.trx == "B" and s.cfg.antenna == "LGA"


def test_uplink_only_in_pass():
    h = Health()
    s = State(t=P.orbit_period_s * 0.5)
    o = step(s, h, P, 1.0)
    assert not o["gs_pass"]
    assert not o["up_ok"]
    s2 = State(t=P.orbit_period_s * P.gs_pass_phase)
    o2 = step(s2, h, P, 1.0)
    assert o2["gs_pass"]
    assert o2["up_ok"] or o2["down_ok"]


def test_isolating_the_bad_string_stops_the_heating(nominal):
    s_bad, _ = run("battery", 0.85, secs=2400)
    s, _ = run("battery", 0.85, secs=2400, bat_isolated=True)
    assert s.t_bat < s_bad.t_bat - 5
