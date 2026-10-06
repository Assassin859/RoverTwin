"""Cascading failure chain reaction — confirmed diagnoses only."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from backend.cascade_chain import CascadeTracker
from backend.mission import Mission
from backend.store import Store


def test_nominal_leaves_cascade_empty():
    m = Mission(seed=1)
    m.advance(3600)
    assert m.cascade.stages == []
    assert m.twin.confirmed_findings() == []
    assert m.snapshot()["cascade_chain"]["playing"] == []


def test_battery_builds_ordered_cascade_chain():
    m = Mission(seed=3)
    m.advance(900)
    m.inject("battery", 0.85, 60)
    m.advance(2400)
    chain = m.cascade.snapshot(m.twin.o.get("couplings") or {})
    ids = chain["playing"]
    assert any(i.startswith("root:") for i in ids)
    assert "edge:EPS>TCS" in ids
    assert chain["latest"]
    assert any(e["kind"] == "CASCADE" and not e["text"].startswith("Retracted") for e in m.events)
    # Honest thermal hop may not light yet while avionics are cool
    coup = m.twin.o["couplings"]
    if coup["TCS>GNC"][0] < 0.12:
        assert "edge:TCS>GNC" not in ids


def test_cascade_retracts_when_root_clears():
    m = Mission(seed=3)
    m.advance(600)
    m.inject("battery", 0.9, 30)
    m.advance(2000)
    assert any(s["kind"] == "root" for s in m.cascade.stages)
    m.clear("battery")
    # Force estimates back under threshold and re-tick diagnosis
    m.twin.h.bat_leak_w = 0.0
    m.twin.h.bat_r_mult = 1.0
    m.twin.persist.clear()
    m.twin.reported.clear()
    m.advance(30)
    # With no confirmed findings, prune should clear root/edge stages
    assert m.twin.confirmed_findings() == []
    assert not any(s["kind"] == "root" for s in m.cascade.stages)


def test_cascade_clears_on_new_mission():
    m = Mission(seed=1)
    m.advance(100)
    m.inject("battery", 0.9, 30)
    m.advance(1500)
    assert m.cascade.stages
    m2 = Mission(seed=1)
    assert m2.cascade.stages == []


def test_tracker_dedupes_and_prunes():
    tr = CascadeTracker()
    view = {"cfg": {"drive": True, "payload": True, "mode": "NOMINAL"}, "down_ok": True}
    findings = [{"id": "bat_leak", "sub": "EPS", "text": "short", "contained": ""}]
    corr = {"active": ["EPS>TCS"], "paths": []}
    coup = {"EPS>TCS": (0.9, "59 W battery heat")}
    subs = [{"id": "EPS", "score": 40, "status": "CRITICAL", "root": True, "cause": ""}]
    a = tr.update(10, findings, corr, coup, subs, view, [])
    b = tr.update(20, findings, corr, coup, subs, view, [])
    assert a["new"]
    assert b["new"] == []
    gone = tr.update(30, [], {"active": [], "paths": []}, coup, [], view, [])
    assert gone["retracted"]
    assert tr.stages == []


def test_store_concurrent_writes(tmp_path: Path):
    st = Store(tmp_path / "t.db")

    def work(i):
        st.frame({"t": float(i), "seq": i, "soc": 0.5, "v_bus": 28, "i_bat": 0,
                  "t_av": 20, "t_bat": 20, "margin": 10, "rate": 100})
        st.event({"id": i, "t": float(i), "kind": "SYS", "text": "x"})
        st.commit()

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(work, range(40)))
    assert len(st.telemetry(0, 100)) == 40
