#!/usr/bin/env python3
"""Record a thinned WS-shaped demo mission for Vercel offline replay.

Usage (from repo root):
  python scripts/record_replay.py
Writes frontend/assets/demo-replay.json.gz

Tape includes: mid-run critical pred, eclipse + AOS/LOS cues, run_plan isolate,
recovery snaps — compressed so t_wall ≤ ~3 min.
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.mission import Mission  # noqa: E402

OUT = ROOT / "frontend" / "assets" / "demo-replay.json.gz"
OUT_PUBLIC = ROOT / "frontend" / "public" / "assets" / "demo-replay.json.gz"
MAX_WALL = 170.0  # seconds — leave headroom under 3 min


def _thin_pred(pred: dict | None) -> dict | None:
    if not pred:
        return None
    out = {k: pred[k] for k in ("t0", "horizon", "events", "fdir", "first_critical", "recommended", "roots", "delayed_best") if k in pred}
    out["band"] = pred.get("band")
    base = pred.get("baseline") or {}
    series = {}
    for k, arr in base.items():
        if isinstance(arr, list) and len(arr) > 20:
            series[k] = arr[::4]
        else:
            series[k] = arr
    out["baseline"] = series
    plans = []
    for p in pred.get("plans") or []:
        pl = {k: p[k] for k in (
            "id", "name", "title", "plain", "why", "why_one_line", "score", "score_breakdown",
            "target_subsystem", "relevance", "notes", "metrics", "cmds", "blocked",
            "needs_uplink", "delivered", "end_margin", "end_state", "delivery",
        ) if k in p}
        ser = {}
        for k, arr in (p.get("series") or {}).items():
            if isinstance(arr, list) and len(arr) > 20:
                ser[k] = arr[::4]
            else:
                ser[k] = arr
        pl["series"] = ser
        pl["events"] = (p.get("events") or [])[:6]
        plans.append(pl)
    out["plans"] = plans
    return out


def _sample(m: Mission) -> dict | None:
    if not m.history:
        return None
    return m.history[-1]


def _emit_snap(m: Mission, messages: list, wall: list, last_event_id: list, dt: float = 0.12) -> None:
    snap = m.snapshot()
    snap["type"] = "snap"
    snap["session_id"] = "replay"
    new_ev = [e for e in m.events if e["id"] > last_event_id[0]]
    if new_ev:
        last_event_id[0] = new_ev[-1]["id"]
    snap["events"] = new_ev
    snap["sample"] = _sample(m)
    messages.append({"t_wall": round(wall[0], 3), "msg": snap})
    wall[0] += dt


def _ensure_pred(m: Mission, messages: list, wall: list, last_pred_seq: list) -> None:
    if m.prediction is None or m.pred_seq == 0:
        try:
            m.set_prediction(m.compute_prediction(m.prediction_inputs()))
        except Exception:
            return
    if m.prediction and m.pred_seq != last_pred_seq[0]:
        last_pred_seq[0] = m.pred_seq
        messages.append({"t_wall": round(wall[0], 3), "msg": {"type": "pred", "pred": _thin_pred(m.prediction)}})
        wall[0] += 0.04


def main() -> None:
    m = Mission(seed=3)
    messages: list[dict] = []
    wall = [0.0]
    last_event_id = [0]
    last_pred_seq = [-1]
    snap_every = 10

    def emit(msg: dict, dt_wall: float = 0.25) -> None:
        messages.append({"t_wall": round(wall[0], 3), "msg": msg})
        wall[0] += dt_wall

    # Settle then inject battery
    m.advance(600)
    m.speed = 60.0
    hello = {
        "type": "hello",
        "session_id": "replay",
        "meta": m.meta(),
        "history": list(m.history)[-40:],
        "events": list(m.events),
        "snap": m.snapshot(),
        "pred": _thin_pred(m.prediction),
    }
    hello["snap"]["type"] = "snap"
    hello["snap"]["session_id"] = "replay"
    hello["snap"]["events"] = []
    hello["snap"]["sample"] = _sample(m)
    emit(hello, 0.0)
    last_event_id[0] = m.event_seq

    m.inject("battery", 0.9, 0.0)
    n = 0
    saw_crit = False
    saw_ecl = False
    saw_pass = False
    # Phase 1: cascade until critical forecast (do not isolate yet)
    while m.t < 600 + 5000 and wall[0] < MAX_WALL * 0.5:
        m.advance(2.0)
        n += 1
        _ensure_pred(m, messages, wall, last_pred_seq)
        snap = m.snapshot()
        if snap.get("twin", {}).get("eclipse"):
            saw_ecl = True
        if snap.get("twin", {}).get("gs_pass"):
            saw_pass = True
        if m.prediction and m.prediction.get("first_critical"):
            saw_crit = True
        if n % snap_every != 0 and not (m.events and m.events[-1]["id"] > last_event_id[0]):
            continue
        _emit_snap(m, messages, wall, last_event_id, 0.15)
        _ensure_pred(m, messages, wall, last_pred_seq)
        if saw_crit and n > 150:
            break

    # Force a fresh prediction; if still no critical, run longer in eclipse
    for _ in range(3):
        pred = m.compute_prediction(m.prediction_inputs())
        m.set_prediction(pred)
        if pred.get("first_critical"):
            saw_crit = True
            break
        m.advance(400)
    _emit_snap(m, messages, wall, last_event_id, 0.12)
    emit({"type": "pred", "pred": _thin_pred(m.prediction)}, 0.05)
    last_pred_seq[0] = m.pred_seq
    if m.prediction and m.prediction.get("first_critical"):
        saw_crit = True
        messages.append({
            "t_wall": round(wall[0], 3),
            "msg": {"type": "cue", "cue": "critical", "text": m.prediction["first_critical"].get("text")},
        })
        wall[0] += 0.02

    # Phase 2: wait for a GS pass (sparse every-N orbits), then isolate before/at AOS
    for _ in range(900):
        if wall[0] > MAX_WALL * 0.75:
            break
        m.advance(5.0)
        if n % 8 == 0:
            _emit_snap(m, messages, wall, last_event_id, 0.06)
        if m.snapshot().get("twin", {}).get("gs_pass") or m.plant.o.get("up_ok"):
            saw_pass = True
            break
    try:
        m.run_plan("isolate")
    except Exception:
        try:
            m.command("bat_isolated", True)
        except Exception:
            pass
    _emit_snap(m, messages, wall, last_event_id, 0.1)

    # Phase 3: recovery + confirm while compressing wall
    for _ in range(240):
        if wall[0] >= MAX_WALL - 8:
            break
        m.advance(5.0)
        n += 1
        if n % 3 == 0:
            _emit_snap(m, messages, wall, last_event_id, 0.07)
            _ensure_pred(m, messages, wall, last_pred_seq)

    # Final recovery snap + pred
    try:
        pred2 = m.compute_prediction(m.prediction_inputs())
        m.set_prediction(pred2)
    except Exception:
        pred2 = m.prediction
    _emit_snap(m, messages, wall, last_event_id, 0.12)
    if pred2:
        emit({"type": "pred", "pred": _thin_pred(pred2)}, 0.04)

    # Compress wall times into ≤ MAX_WALL if overshot
    if wall[0] > MAX_WALL and messages:
        scale = MAX_WALL / wall[0]
        for row in messages:
            row["t_wall"] = round(row["t_wall"] * scale, 3)

    payload = {
        "version": 2,
        "title": "Battery cascade + isolate recovery (LEO)",
        "reason": "Recorded mission for offline venue backup — inject/plan disabled; loop when tape ends.",
        "cues": {"critical": saw_crit, "eclipse": saw_ecl, "pass": saw_pass},
        "messages": messages,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT_PUBLIC.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    for dest in (OUT, OUT_PUBLIC):
        with gzip.open(dest, "wb", compresslevel=9) as f:
            f.write(raw)
        print(f"wrote {dest} ({dest.stat().st_size} bytes, {len(messages)} messages, sim t={m.t:.0f}s, wall={messages[-1]['t_wall']:.1f}s)")


if __name__ == "__main__":
    main()
