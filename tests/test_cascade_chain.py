"""Cascading failure chain reaction stages from real twin state."""
from backend.cascade_chain import CascadeTracker
from backend.mission import Mission


def test_battery_builds_ordered_cascade_chain():
    m = Mission(seed=3)
    m.advance(900)
    m.inject("battery", 0.85, 60)
    m.advance(2400)
    chain = m.cascade.snapshot()
    ids = chain["playing"]
    assert any(i.startswith("root:") for i in ids)
    assert "edge:EPS>TCS" in ids
    # Second hop or multi-hop path / subsystem knock-on
    assert (
        "edge:TCS>GNC" in ids
        or any(i.startswith("path:") for i in ids)
        or any(i.startswith("sub:") for i in ids)
    )
    kinds = [s["kind"] for s in chain["stages"]]
    assert kinds[0] == "root" or any(k == "root" for k in kinds)
    assert chain["latest"]
    # CASCADE events logged
    assert any(e["kind"] == "CASCADE" for e in m.events)


def test_cascade_clears_on_new_mission():
    m = Mission(seed=1)
    m.advance(100)
    m.inject("battery", 0.9, 30)
    m.advance(800)
    assert m.cascade.stages
    m2 = Mission(seed=1)
    assert m2.cascade.stages == []
    assert m2.cascade.snapshot()["playing"] == []


def test_tracker_dedupes_stages():
    tr = CascadeTracker()
    view = {"cfg": {"drive": True, "payload": True, "mode": "NOMINAL"}, "down_ok": True}
    findings = [{"id": "bat_leak", "sub": "EPS", "text": "short", "contained": ""}]
    corr = {"active": ["EPS>TCS"], "paths": [
        {"from": "EPS", "to": "GNC", "via": ["TCS"], "edges": ["EPS>TCS", "TCS>GNC"], "strength": 0.8}
    ]}
    coup = {"EPS>TCS": (0.9, "heat"), "TCS>GNC": (0.5, "gyro")}
    subs = [{"id": "EPS", "score": 40, "status": "CRITICAL", "root": True, "cause": ""}]
    a = tr.update(10, findings, corr, coup, subs, view, [])
    b = tr.update(20, findings, corr, coup, subs, view, [])
    assert a
    assert b == []
    assert len(tr.stages) == len({s["id"] for s in tr.stages})
