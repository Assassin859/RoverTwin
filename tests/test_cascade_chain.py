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
    chain = m.cascade.snapshot(m.twin.o.get("couplings") or {}, m.twin.confirmed_findings(), m.twin.subsystems())
    ids = chain["playing"]
    roots = [i for i in ids if i.startswith("root:")]
    assert roots == ["root:EPS"]  # one ROOT per subsystem
    assert "edge:EPS>TCS" in ids
    assert chain["latest"]
    assert any(e["kind"] == "CASCADE" and not e["text"].startswith("Retracted") for e in m.events)
    coup = m.twin.o["couplings"]
    if coup["TCS>GNC"][0] < 0.12:
        assert "edge:TCS>GNC" not in ids


def test_comms_silence_confirms_and_seeds_cascade():
    """Silence-inferred trx must reach confirmed_findings and seed cascade."""
    m = Mission(seed=3)
    m.advance(900)
    m.inject("comms", 0.8, 60)
    m.advance(int(m.p.orbit_period_s * 1.5))
    ids = {f["id"] for f in m.twin.confirmed_findings()}
    assert "trx" in ids
    # Sync may be BLIND (missed pass) or LOW RATE (between passes) after silence diagnosis
    assert m.twin.sync in ("BLIND", "LOW RATE", "SYNCED")
    chain = m.snapshot()["cascade_chain"]
    playing = chain.get("playing") or []
    assert "root:COMMS" in playing
    assert any(s["kind"] == "root" and s.get("sub") == "COMMS" for s in m.cascade.stages)


def test_cascade_resolves_on_containment():
    m = Mission(seed=3)
    m.advance(900)
    m.inject("battery", 0.85, 60)
    m.advance(1500)
    assert any(s["kind"] == "root" and not s.get("resolved") for s in m.cascade.stages)
    # Sparse GS — wait for uplink (may be multiple orbits)
    for _ in range(800):
        if m.twin.o.get("up_ok"):
            break
        m.advance(30)
    m.command("bat_isolated", True)
    m.advance(int(m.p.orbit_period_s * 0.5) + 120)
    roots = [s for s in m.cascade.stages if s["kind"] == "root"]
    assert roots and all(s.get("resolved") for s in roots)
    assert any(s["kind"] == "recovery" for s in m.cascade.stages)


def test_cascade_resolves_when_root_clears():
    m = Mission(seed=3)
    m.advance(600)
    m.inject("battery", 0.9, 30)
    m.advance(2000)
    assert any(s["kind"] == "root" for s in m.cascade.stages)
    m.clear("battery")
    m.twin.h.bat_leak_w = 0.0
    m.twin.h.bat_r_mult = 1.0
    m.twin.persist.clear()
    m.twin.reported.clear()
    m.advance(30)
    assert m.twin.confirmed_findings() == []
    roots = [s for s in m.cascade.stages if s["kind"] == "root"]
    assert roots, "history kept"
    assert all(s.get("resolved") for s in roots)


def test_cascade_clears_on_new_mission():
    m = Mission(seed=1)
    m.advance(100)
    m.inject("battery", 0.9, 30)
    m.advance(1500)
    assert m.cascade.stages
    m2 = Mission(seed=1)
    assert m2.cascade.stages == []


def test_tracker_one_root_and_resolves():
    tr = CascadeTracker()
    view = {"cfg": {"drive": True, "payload": True, "mode": "NOMINAL"}, "down_ok": True}
    findings = [
        {"id": "bat_leak", "sub": "EPS", "text": "short", "contained": ""},
        {"id": "bat_r", "sub": "EPS", "text": "resistance x3", "contained": ""},
    ]
    corr = {"active": ["EPS>TCS"], "paths": []}
    coup = {"EPS>TCS": (0.9, "59 W battery heat")}
    subs = [{"id": "EPS", "score": 40, "status": "CRITICAL", "root": True, "cause": ""}]
    a = tr.update(10, findings, corr, coup, subs, view, [])
    assert sum(1 for s in a["new"] if s["kind"] == "root") == 1
    assert tr._stage("root:EPS")["text"].count(";") == 1  # merged texts
    # Debounce: edge emits after ≥10 s stable
    b = tr.update(21, findings, corr, coup, subs, view, [])
    assert any(s["kind"] == "edge" for s in b["new"])
    b2 = tr.update(25, findings, corr, coup, subs, view, [])
    assert b2["new"] == []
    gone = tr.update(30, [], {"active": [], "paths": []}, coup, [], view, [])
    assert gone["resolved"]
    assert tr.stages  # history kept
    assert all(s.get("resolved") for s in tr.stages if s["kind"] in ("root", "edge"))


def test_snapshot_refreshes_live_edge_text():
    tr = CascadeTracker()
    view = {"cfg": {"drive": True, "payload": True, "mode": "NOMINAL"}, "down_ok": True}
    findings = [{"id": "bat_leak", "sub": "EPS", "text": "short ~40 W", "contained": ""}]
    corr = {"active": ["EPS>TCS"], "paths": []}
    coup = {"EPS>TCS": (0.9, "40 W battery heat")}
    tr.update(10, findings, corr, coup, [], view, [])
    tr.update(21, findings, corr, coup, [], view, [])
    snap = tr.snapshot({"EPS>TCS": (0.95, "59 W battery heat")}, findings, [])
    edge = next(s for s in snap["stages"] if s["kind"] == "edge")
    assert "59 W" in edge["text"]


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
