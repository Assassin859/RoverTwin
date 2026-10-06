"""LEO orbit helpers and pass-gated uplink."""
from backend.mission import Mission
from backend.model import Params, orbit_state


def test_orbit_next_pass_eta_positive_off_pass():
    p = Params()
    # Mid-orbit should be far from pass centre 0.15
    st = orbit_state(p.orbit_period_s * 0.55, p)
    assert not st["gs_pass"]
    assert st["next_pass_s"] > 60


def test_command_queues_off_pass_and_delivers_in_pass():
    m = Mission(seed=2)
    p = m.p
    # Park just after a pass so uplink is closed
    target = p.orbit_period_s * 0.55
    m.advance(target)
    assert not m.twin.o.get("gs_pass")
    cmd = m.command("payload", False)
    assert "queued until next pass" in cmd["status"] or cmd["status"] == "queued"
    # Run until next pass + latency
    m.advance(p.orbit_period_s * 0.7)
    assert any(c["name"] == "payload" and c["status"] == "confirmed" for c in m.commands) or m.plant.s.cfg.payload is False
