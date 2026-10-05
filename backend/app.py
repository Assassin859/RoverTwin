"""RoverTwin ground segment: FastAPI + WebSocket server.

Run:  uvicorn backend.app:app --reload
Then open http://localhost:8000 (API docs at /docs).
"""
from __future__ import annotations

import asyncio
import csv
import io
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .mission import Mission
from .plant import FAULTS
from .store import Store

ROOT = Path(__file__).resolve().parent.parent
TICK_S = 0.1
PREDICT_EVERY_S = 1.5

store = Store(ROOT / "data" / "rovertwin.db")


class Hub:
    def __init__(self) -> None:
        self.mission = Mission(store)
        self.clients: set[WebSocket] = set()
        self.sent_event_id = 0
        self.sent_pred = 0
        self.predicting = False
        self.last_predict = 0.0
        self.force_predict = True

    def reset(self) -> None:
        speed = self.mission.speed
        self.mission = Mission(store)
        self.mission.speed = speed
        self.sent_event_id = 0
        self.sent_pred = 0
        self.force_predict = True

    def hello(self) -> dict:
        m = self.mission
        return {"type": "hello", "meta": m.meta(), "history": list(m.history), "events": list(m.events),
                "snap": m.snapshot(), "pred": m.prediction}

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def predict(self) -> None:
        self.predicting = True
        m = self.mission
        try:
            inputs = m.prediction_inputs()
            pred = await asyncio.to_thread(Mission.compute_prediction, inputs)
            if m is self.mission:
                m.set_prediction(pred)
        finally:
            self.predicting = False

    async def run(self) -> None:
        last = time.perf_counter()
        last_commit = last
        while True:
            await asyncio.sleep(TICK_S)
            now = time.perf_counter()
            dt, last = min(now - last, 0.5), now
            m = self.mission
            if not m.paused:
                m.advance(m.speed * dt)
            if not self.predicting and (self.force_predict or now - self.last_predict > PREDICT_EVERY_S):
                self.force_predict = False
                self.last_predict = now
                asyncio.create_task(self.predict())
            if now - last_commit > 1.0:
                store.commit()
                last_commit = now
            if not self.clients:
                continue
            snap = m.snapshot()
            snap["type"] = "snap"
            snap["events"] = [e for e in m.events if e["id"] > self.sent_event_id]
            if snap["events"]:
                self.sent_event_id = snap["events"][-1]["id"]
            snap["sample"] = m.history[-1] if m.history else None
            await self.broadcast(snap)
            if m.pred_seq != self.sent_pred and m.prediction:
                self.sent_pred = m.pred_seq
                await self.broadcast({"type": "pred", "pred": m.prediction})

    def handle(self, msg: dict) -> None:
        m, op = self.mission, msg.get("op")
        if op == "inject":
            m.inject(msg["kind"], float(msg.get("severity", 0.8)), float(msg.get("ramp", 60)))
        elif op == "clear":
            m.clear(msg["kind"])
        elif op == "cmd":
            m.command(msg["name"], msg.get("value"))
        elif op == "plan":
            m.run_plan(msg["id"])
        elif op == "speed":
            m.speed = max(0.5, min(240.0, float(msg["value"])))
        elif op == "pause":
            m.paused = bool(msg["value"])
        elif op == "reset":
            self.reset()
            return
        else:
            raise ValueError(f"unknown op {op!r}")
        self.force_predict = True


hub = Hub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(hub.run())
    yield
    task.cancel()
    store.commit()


app = FastAPI(title="RoverTwin ground segment", version="1.0",
              description="Digital twin of a lunar rover for predictive fault simulation (TECHFEST ST-09).",
              lifespan=lifespan)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_json(hub.hello())
    hub.clients.add(ws)
    try:
        while True:
            msg = await ws.receive_json()
            mission = hub.mission
            try:
                hub.handle(msg)
            except (KeyError, ValueError) as exc:
                await ws.send_json({"type": "error", "error": str(exc)})
                continue
            if msg.get("op") == "reset" or hub.mission is not mission:
                await hub.broadcast(hub.hello())
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


# ------------------------------------------------------------------ REST API
class FaultIn(BaseModel):
    kind: str = Field(description="battery | thermal | sensor | comms")
    severity: float = Field(0.8, ge=0, le=1)
    ramp_s: float = Field(60, ge=0)


class CommandIn(BaseModel):
    name: str = Field(description="mode | drive | speed | payload | imu | trx | antenna | bat_isolated | pose | relay_hp")
    value: str | float | bool


class SimIn(BaseModel):
    speed: float | None = None
    paused: bool | None = None


@app.get("/api/state", summary="Current twin, telemetry sync, diagnosis and (test-harness) truth")
def get_state() -> dict:
    return hub.mission.snapshot()


@app.get("/api/prediction", summary="Latest predicted impact and ranked recovery plans")
def get_prediction() -> dict:
    return hub.mission.prediction or {}


@app.get("/api/faults", summary="Fault types that can be injected")
def get_faults() -> dict:
    return FAULTS


@app.post("/api/faults", summary="Inject a fault into the simulated rover (test harness)")
def post_fault(f: FaultIn) -> dict:
    if f.kind not in FAULTS:
        raise HTTPException(400, f"unknown fault {f.kind}")
    hub.mission.inject(f.kind, f.severity, f.ramp_s)
    hub.force_predict = True
    return {"ok": True}


@app.delete("/api/faults/{kind}", summary="Clear an injected fault (test harness)")
def delete_fault(kind: str) -> dict:
    hub.mission.clear(kind)
    return {"ok": True}


@app.post("/api/commands", summary="Send a command to the rover through the uplink")
def post_command(c: CommandIn) -> dict:
    try:
        cmd = hub.mission.command(c.name, c.value)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    hub.force_predict = True
    return cmd


@app.post("/api/plans/{plan_id}", summary="Execute a recovery plan simulated by the twin")
def post_plan(plan_id: str) -> dict:
    try:
        hub.mission.run_plan(plan_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    hub.force_predict = True
    return {"ok": True}


@app.post("/api/sim", summary="Change simulation speed or pause")
def post_sim(s: SimIn) -> dict:
    if s.speed is not None:
        hub.mission.speed = max(0.5, min(240.0, s.speed))
    if s.paused is not None:
        hub.mission.paused = s.paused
    return {"speed": hub.mission.speed, "paused": hub.mission.paused}


@app.post("/api/reset", summary="Restart the mission")
async def post_reset() -> dict:
    hub.reset()
    await hub.broadcast(hub.hello())
    return {"ok": True}


@app.get("/api/telemetry", summary="Received telemetry frames from the time-series store")
def get_telemetry(since: float = 0.0, limit: int = 5000) -> list[dict]:
    store.commit()
    return store.telemetry(since, limit)


@app.get("/api/events", summary="Mission event log")
def get_events(limit: int = 1000) -> list[dict]:
    store.commit()
    return store.events(limit)


@app.get("/api/telemetry.csv", summary="Download received telemetry as CSV")
def get_csv() -> StreamingResponse:
    store.commit()
    rows = store.telemetry(0.0, 1_000_000)
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=rovertwin_telemetry.csv"})


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
