"""Ground-segment time-series store (SQLite).

Holds every telemetry frame received on the ground, the twin's estimates and
the mission event log, so a pass can be replayed, exported or audited.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS telemetry (t REAL, seq INTEGER, soc REAL, v_bus REAL, i_bat REAL,
    t_av REAL, t_bat REAL, margin REAL, rate REAL, raw TEXT);
CREATE TABLE IF NOT EXISTS twin (t REAL, data TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER, t REAL, kind TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS telemetry_t ON telemetry (t);
"""


class Store:
    def __init__(self, path: str | Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.executescript(SCHEMA)

    def reset(self) -> None:
        self.db.executescript("DELETE FROM telemetry; DELETE FROM twin; DELETE FROM events;")
        self.db.commit()

    def frame(self, f: dict) -> None:
        self.db.execute(
            "INSERT INTO telemetry VALUES (?,?,?,?,?,?,?,?,?,?)",
            (f["t"], f["seq"], f["soc"], f["v_bus"], f["i_bat"], f["t_av"], f["t_bat"], f["margin"], f["rate"],
             json.dumps(f, separators=(",", ":"))),
        )

    def twin(self, sample: dict) -> None:
        self.db.execute("INSERT INTO twin VALUES (?,?)", (sample["t"], json.dumps(sample, separators=(",", ":"))))

    def event(self, e: dict) -> None:
        self.db.execute("INSERT INTO events VALUES (?,?,?,?)", (e["id"], e["t"], e["kind"], e["text"]))

    def commit(self) -> None:
        self.db.commit()

    def telemetry(self, since: float = 0.0, limit: int = 5000) -> list[dict]:
        cur = self.db.execute(
            "SELECT t, seq, soc, v_bus, i_bat, t_av, t_bat, margin, rate FROM telemetry WHERE t >= ? ORDER BY t LIMIT ?",
            (since, limit),
        )
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def events(self, limit: int = 1000) -> list[dict]:
        cur = self.db.execute("SELECT id, t, kind, text FROM events ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(zip(("id", "t", "kind", "text"), r)) for r in cur.fetchall()][::-1]
