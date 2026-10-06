#!/usr/bin/env python3
"""Record a thinned WS-shaped demo mission for Vercel offline replay.

Usage (from repo root):
  python scripts/record_replay.py
Writes frontend/assets/demo-replay.json.gz
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


def _thin_pred(pred: dict | None) -> dict | None:
    if not pred:
        return None
    out = {k: pred[k] for k in ("t0", "horizon", "events", "fdir", "first_critical", "recommended") if k in pred}
    out["band"] = pred.get("band")
    # Keep every 4th sample of each series to shrink payload
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
        pl = {k: p[k] for k in ("id", "name", "plain", "score", "notes", "metrics", "cmds", "blocked", "needs_uplink", "delivered") if k in p}
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
    h = m.history[-1]
    # history entries are already compact dicts from Mission
    return h


def main() -> None:
    m = Mission(seed=3)
    messages: list[dict] = []
    wall = 0.0
    last_event_id = 0
    last_pred_seq = -1
    snap_every = 8  # emit snap every N advances of 2s → ~16 sim-s between UI snaps at record rate

    def emit(msg: dict, dt_wall: float = 0.35) -> None:
        nonlocal wall
        messages.append({"t_wall": round(wall, 3), "msg": msg})
        wall += dt_wall

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
    last_event_id = m.event_seq

    m.inject("battery", 0.9, 0.0)
    n = 0
    # ~35 min sim at coarse steps for cascade + critical
    while m.t < 600 + 2100:
        m.advance(2.0)
        n += 1
        if m.prediction is None or m.pred_seq == 0:
            try:
                m.set_prediction(m.compute_prediction(m.prediction_inputs()))
            except Exception:
                pass
        if n % snap_every != 0 and not (m.events and m.events[-1]["id"] > last_event_id):
            continue
        snap = m.snapshot()
        snap["type"] = "snap"
        snap["session_id"] = "replay"
        new_ev = [e for e in m.events if e["id"] > last_event_id]
        if new_ev:
            last_event_id = new_ev[-1]["id"]
        snap["events"] = new_ev
        snap["sample"] = _sample(m)
        emit(snap, 0.25 if new_ev else 0.12)
        if m.prediction and m.pred_seq != last_pred_seq:
            last_pred_seq = m.pred_seq
            emit({"type": "pred", "pred": _thin_pred(m.prediction)}, 0.05)

    # Force a final prediction
    pred = m.compute_prediction(m.prediction_inputs())
    m.set_prediction(pred)
    snap = m.snapshot()
    snap["type"] = "snap"
    snap["session_id"] = "replay"
    snap["events"] = []
    snap["sample"] = _sample(m)
    emit(snap, 0.2)
    emit({"type": "pred", "pred": _thin_pred(pred)}, 0.05)

    payload = {
        "version": 1,
        "title": "Battery cascade demo (LEO)",
        "messages": messages,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(raw)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(messages)} messages, sim t={m.t:.0f}s)")


if __name__ == "__main__":
    main()
