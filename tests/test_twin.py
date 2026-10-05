"""The twin sees only telemetry frames, yet must converge on the hidden health."""
import pytest

from backend.mission import Mission
from backend.plant import RadioLink, RoverPlant

SETTLE_S, AFTER_S = 900, 2400


def scenario(kind=None, severity=0.85):
    m = Mission(seed=3)
    m.advance(SETTLE_S)
    if kind:
        m.inject(kind, severity, 60)
    m.advance(AFTER_S)
    return m


def texts(m, kind):
    return [e["text"] for e in m.events if e["kind"] == kind]


@pytest.fixture(scope="module")
def runs():
    return {k: scenario(k, sev) for k, sev in
            [(None, 0), ("battery", 0.85), ("thermal", 0.9), ("sensor", 0.9), ("comms", 0.8)]}


def test_twin_has_no_access_to_the_plant():
    m = Mission(seed=1)
    for v in vars(m.twin).values():
        assert not isinstance(v, (RoverPlant, RadioLink, Mission))


def test_nominal_twin_stays_synced_without_false_alarms(runs):
    m = runs[None]
    assert m.twin.sync == "SYNCED"
    assert m.twin.findings() == []
    assert texts(m, "DIAG") == []
    assert abs(m.twin.s.soc - m.plant.s.soc) < 0.01
    assert abs(m.twin.s.t_bat - m.plant.s.t_bat) < 1.0


def test_battery_parameters_converge(runs):
    m = runs["battery"]
    est, true = m.twin.h, m.plant.h
    assert est.bat_leak_w == pytest.approx(true.bat_leak_w, rel=0.15)
    assert est.bat_r_mult == pytest.approx(true.bat_r_mult, rel=0.15)
    assert est.bat_capacity_frac == pytest.approx(true.bat_capacity_frac, abs=0.06)
    assert {f["id"] for f in m.twin.findings()} >= {"bat_leak", "bat_r"}
    eps = next(s for s in m.twin.subsystems() if s["id"] == "EPS")
    assert eps["root"]


def test_radiator_efficiency_converges(runs):
    m = runs["thermal"]
    assert m.twin.h.rad_eff == pytest.approx(m.plant.h.rad_eff, abs=0.05)
    assert [f["id"] for f in m.twin.findings()] == ["rad"]


def test_gyro_bias_found_and_silence_blamed_on_pointing(runs):
    m = runs["sensor"]
    assert m.twin.h.imu_a_bias == pytest.approx(m.plant.h.imu_a_bias, abs=0.01)
    ids = {f["id"] for f in m.twin.findings()}
    assert "imu" in ids and "trx" not in ids
    assert any("mispointing" in t for t in texts(m, "DIAG"))


def test_transponder_loss_inferred_from_silence(runs):
    m = runs["comms"]
    assert m.twin.sync == "BLIND"
    assert m.twin.h.trx_a_loss_db > 20
    assert any("transponder A" in t for t in texts(m, "DIAG"))
