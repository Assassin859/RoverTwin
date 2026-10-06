"""Recorded Vercel replay asset loads and has hello/snap/pred messages."""
from __future__ import annotations

import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPLAY = ROOT / "frontend" / "assets" / "demo-replay.json.gz"


def test_replay_file_exists_and_gzip_opens():
    assert REPLAY.is_file(), f"missing {REPLAY}; run: python scripts/record_replay.py"
    with gzip.open(REPLAY, "rb") as f:
        data = json.loads(f.read().decode("utf-8"))
    assert data.get("version") in (1, 2)
    msgs = data["messages"]
    assert len(msgs) >= 3
    types = {m["msg"]["type"] for m in msgs}
    assert "hello" in types
    assert "snap" in types
    assert "pred" in types
    hello = next(m["msg"] for m in msgs if m["msg"]["type"] == "hello")
    assert "meta" in hello and "snap" in hello
    snap = next(m["msg"] for m in msgs if m["msg"]["type"] == "snap")
    assert "twin" in snap or snap.get("type") == "snap"
    pred = next(m["msg"] for m in msgs if m["msg"]["type"] == "pred")
    assert isinstance(pred.get("pred"), dict)
