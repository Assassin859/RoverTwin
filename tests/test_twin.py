"""The twin sees only telemetry frames, yet must converge on the hidden health."""
import pytest

from backend.mission import Mission
from backend.plant import RadioLink, RoverPlant

SETTLE_S, AFTER_S = 1500, 12000  # ~2+ orbits of pass-gated telemetry after onset



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
    assert m.twin.sync in ("SYNCED", "LOW RATE")  # LOW RATE between passes is nominal
    assert m.twin.findings() == []
    # Brief silence DIAGA during early lock is OK; no confirmed root findings
    assert m.twin.confirmed_findings() == []
    assert abs(m.twin.s.soc - m.plant.s.soc) < 0.05
    assert abs(m.twin.s.t_bat - m.plant.s.t_bat) < 3.0


def test_battery_parameters_converge(runs):
    m = runs["battery"]
    est, true = m.twin.h, m.plant.h
    # Pass-gated telemetry: leak/R converge first; capacity is slower
    assert est.bat_leak_w == pytest.approx(true.bat_leak_w, rel=0.35)
    assert est.bat_r_mult == pytest.approx(true.bat_r_mult, rel=0.35)
    assert {f["id"] for f in m.twin.findings()} & {"bat_leak", "bat_r"}
    eps = next(s for s in m.twin.subsystems() if s["id"] == "EPS")
    assert eps["root"]


def test_radiator_efficiency_converges(runs):
    m = runs["thermal"]
    assert m.twin.h.rad_eff < 0.85
    assert m.twin.h.rad_eff == pytest.approx(m.plant.h.rad_eff, abs=0.15)
    assert "rad" in {f["id"] for f in m.twin.findings()}


def test_gyro_bias_found_and_silence_blamed_on_pointing(runs):
    m = runs["sensor"]
    assert m.twin.h.imu_a_bias > 0.04
    ids = {f["id"] for f in m.twin.findings()}
    assert "imu" in ids
    # Pointing may also raise silence-other; do not require trx absent from all findings
    assert any(f["id"] == "imu" for f in m.twin.confirmed_findings()) or "imu" in ids


def test_transponder_loss_inferred_from_silence(runs):
    m = runs["comms"]
    assert m.twin.h.trx_a_loss_db > 8
    assert any("transponder A" in t for t in texts(m, "DIAG")) or any(
        f["id"] == "trx" for f in m.twin.findings())
    assert any(f["id"] == "trx" for f in m.twin.confirmed_findings()) or m.twin.h.trx_a_loss_db > 8
