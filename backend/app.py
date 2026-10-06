"""RoverTwin ground segment: FastAPI + WebSocket server.

Run:  uvicorn backend.app:app --reload
Then open http://localhost:8000 (API docs at /docs).

WebSocket consoles each own a private Mission. REST /api/* uses a shared
operator desk (smoke scripts / capture) — not the multi-user console.
"""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import math
import os
import signal
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .mission import Mission
from .plant import FAULTS
from .store import Store
from . import llm as llm_mod

ROOT = Path(__file__).resolve().parent.parent
TICK_S = 0.1
PREDICT_EVERY_S = 1.5
log = logging.getLogger("rovertwin.hub")

_db_path = Path(os.environ.get("SATTWIN_DB") or (ROOT / "data" / "rovertwin.db"))
store = Store(_db_path)


def _finite(name: str, v: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{name} must be a number")
    fv = float(v)
    if not math.isfinite(fv):
        raise ValueError(f"{name} must be finite (got {v!r})")
    return fv


@dataclass
class Session:
    ws: WebSocket
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    mission: Mission = field(default_factory=lambda: Mission(store=None))
    sent_event_id: int = 0
    sent_pred: int = 0
    predicting: bool = False
    last_predict: float = 0.0
    force_predict: bool = True


class Hub:
    def __init__(self) -> None:
        # Shared desk for REST / smoke scripts
        self.mission = Mission(store)
        self.sessions: dict[WebSocket, Session] = {}
        self.desk_predicting = False
        self.desk_last_predict = 0.0
        self.desk_force_predict = True
        self.desk_sent_event_id = 0
        self.desk_sent_pred = 0

    def reset_desk(self) -> None:
        speed = self.mission.speed
        self.mission = Mission(store)
        self.mission.speed = speed
        self.desk_sent_event_id = 0
        self.desk_sent_pred = 0
        self.desk_force_predict = True

    def reset_session(self, sess: Session) -> None:
        speed = sess.mission.speed
        sess.mission = Mission(store=None)
        sess.mission.speed = speed
        sess.sent_event_id = 0
        sess.sent_pred = 0
        sess.force_predict = True

    def session_by_id(self, session_id: str | None) -> Session | None:
        if not session_id:
            return None
        for sess in self.sessions.values():
            if sess.id == session_id:
                return sess
        return None

    def hello(self, sess: Session) -> dict:
        m = sess.mission
        return {
            "type": "hello",
            "session_id": sess.id,
            "meta": m.meta(),
            "history": list(m.history),
            "events": list(m.events),
            "snap": m.snapshot(),
            "pred": m.prediction,
        }

    def handle(self, m: Mission, msg: dict, *, on_reset) -> None:
        op = msg.get("op")
        if op == "inject":
            sev = _finite("severity", float(msg.get("severity", 0.8)))
            if sev < 0 or sev > 1:
                raise ValueError("severity must be in [0, 1]")
            m.inject(msg["kind"], sev, float(msg.get("ramp", 60)))
        elif op == "clear":
            m.clear(msg["kind"])
        elif op == "cmd":
            m.command(msg["name"], msg.get("value"))
        elif op == "plan":
            m.run_plan(msg["id"])
        elif op == "speed":
            m.speed = max(0.5, min(240.0, _finite("speed", float(msg["value"]))))
        elif op == "pause":
            if not isinstance(msg.get("value"), bool):
                raise ValueError("pause value must be boolean")
            m.paused = msg["value"]
        elif op == "reset":
            on_reset()
            return
        else:
            raise ValueError(f"unknown op {op!r}")

    async def predict_mission(self, m: Mission, flag_owner, flag_name: str) -> None:
        setattr(flag_owner, flag_name, True)
        try:
            inputs = m.prediction_inputs()
            pred = await asyncio.to_thread(Mission.compute_prediction, inputs)
            # Only apply if this mission object is still current
            if flag_owner is self and flag_name == "desk_predicting" and m is self.mission:
                m.set_prediction(pred)
            elif isinstance(flag_owner, Session) and flag_owner.mission is m:
                m.set_prediction(pred)
        finally:
            setattr(flag_owner, flag_name, False)

    async def run(self) -> None:
        last = time.perf_counter()
        last_commit = last
        while True:
            await asyncio.sleep(TICK_S)
            now = time.perf_counter()
            dt, last = min(now - last, 0.5), now

            # Shared desk (REST)
            desk = self.mission
            try:
                if not desk.paused:
                    desk.advance(desk.speed * dt)
            except Exception:
                log.exception("shared-desk advance failed; continuing")
            if not self.desk_predicting and (self.desk_force_predict or now - self.desk_last_predict > PREDICT_EVERY_S):
                self.desk_force_predict = False
                self.desk_last_predict = now
                asyncio.create_task(self.predict_mission(desk, self, "desk_predicting"))

            if now - last_commit > 1.0:
                store.commit()
                last_commit = now

            # Private console sessions
            dead: list[WebSocket] = []
            for ws, sess in list(self.sessions.items()):
                m = sess.mission
                try:
                    if not m.paused:
                        m.advance(m.speed * dt)
                except Exception:
                    log.exception("session %s advance failed; continuing", sess.id)
                if not sess.predicting and (sess.force_predict or now - sess.last_predict > PREDICT_EVERY_S):
                    sess.force_predict = False
                    sess.last_predict = now
                    asyncio.create_task(self.predict_mission(m, sess, "predicting"))
                try:
                    snap = m.snapshot()
                    snap["type"] = "snap"
                    snap["session_id"] = sess.id
                    snap["events"] = [e for e in m.events if e["id"] > sess.sent_event_id]
                    if snap["events"]:
                        sess.sent_event_id = snap["events"][-1]["id"]
                    snap["sample"] = m.history[-1] if m.history else None
                    await ws.send_json(snap)
                    if m.pred_seq != sess.sent_pred and m.prediction:
                        sess.sent_pred = m.pred_seq
                        await ws.send_json({"type": "pred", "pred": m.prediction})
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.sessions.pop(ws, None)


hub = Hub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    loop = asyncio.get_running_loop()

    def _sigterm(*_args):
        log.info("SIGTERM received — shutting down")

    try:
        loop.add_signal_handler(signal.SIGTERM, _sigterm)
    except (NotImplementedError, AttributeError, RuntimeError):
        pass
    task = asyncio.create_task(hub.run())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    store.commit()


app = FastAPI(title="RoverTwin ground segment", version="1.0",
              description="Spacecraft / satellite-ops digital twin (LEO EO smallsat) for TECHFEST ST-09.",
              lifespan=lifespan)

# CORS so a Vercel-hosted UI can call a remote uvicorn (?backend=).
_cors_extra = [o.strip() for o in os.environ.get("ROVERTWIN_CORS", "").split(",") if o.strip()]
_cors_origins = [
    "https://rovertwin.vercel.app",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
    *_cors_extra,
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=r"https://([\w-]+\.)?vercel\.app|http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    sess = Session(ws=ws)
    hub.sessions[ws] = sess
    await ws.send_json(hub.hello(sess))
    sess.sent_event_id = sess.mission.event_seq
    try:
        while True:
            try:
                msg = await ws.receive_json()
            except Exception as exc:
                await ws.send_json({"type": "error", "error": f"malformed JSON: {exc}"})
                continue
            try:
                if msg.get("op") == "reset":
                    hub.reset_session(sess)
                    sess.force_predict = True
                    await ws.send_json(hub.hello(sess))
                    sess.sent_event_id = sess.mission.event_seq
                else:
                    hub.handle(sess.mission, msg, on_reset=lambda: None)
                    sess.force_predict = True
            except (KeyError, ValueError, TypeError) as exc:
                await ws.send_json({"type": "error", "error": str(exc)})
    except WebSocketDisconnect:
        pass
    finally:
        hub.sessions.pop(ws, None)


# ------------------------------------------------------------------ REST API (shared desk)
class FaultIn(BaseModel):
    kind: str = Field(description="battery | thermal | sensor | comms")
    severity: float = Field(0.8, ge=0, le=1)
    ramp_s: float = Field(60, ge=0)

    @field_validator("severity")
    @classmethod
    def sev_finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("severity must be finite")
        return v


class CommandIn(BaseModel):
    name: str = Field(description="mode | drive | speed | payload | imu | trx | antenna | bat_isolated | pose | relay_hp")
    value: str | float | bool


class SimIn(BaseModel):
    speed: float | None = None
    paused: bool | None = None

    @field_validator("speed")
    @classmethod
    def speed_ok(cls, v: float | None) -> float | None:
        if v is None:
            return v
        if not math.isfinite(v):
            raise ValueError("speed must be finite")
        return v


@app.get("/api/state", summary="Shared desk twin snapshot (REST). Console uses a private WebSocket mission.")
def get_state() -> dict:
    return hub.mission.snapshot()


@app.get("/api/prediction", summary="Latest predicted impact and ranked recovery plans (shared desk)")
def get_prediction() -> dict:
    return hub.mission.prediction or {}


@app.get("/api/validate", summary="Model / orbit validation checks for Model check tab")
def get_validate(session_id: str | None = None) -> dict:
    sess = hub.session_by_id(session_id)
    m = sess.mission if sess else hub.mission
    return m.validation_report()


@app.get("/api/faults", summary="Fault types that can be injected")
def get_faults() -> dict:
    return FAULTS


@app.post("/api/faults", summary="Inject a fault into the shared-desk rover (test harness)")
def post_fault(f: FaultIn) -> dict:
    if f.kind not in FAULTS:
        raise HTTPException(400, f"unknown fault {f.kind}")
    hub.mission.inject(f.kind, f.severity, f.ramp_s)
    hub.desk_force_predict = True
    return {"ok": True}


@app.delete("/api/faults/{kind}", summary="Clear an injected fault (test harness)")
def delete_fault(kind: str) -> dict:
    if kind not in FAULTS:
        raise HTTPException(404, f"unknown fault {kind}")
    if kind not in hub.mission.plant.faults:
        raise HTTPException(404, f"fault {kind} not active")
    hub.mission.clear(kind)
    return {"ok": True}


@app.post("/api/commands", summary="Send a command through the uplink (shared desk)")
def post_command(c: CommandIn) -> dict:
    try:
        cmd = hub.mission.command(c.name, c.value)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    hub.desk_force_predict = True
    return cmd


@app.post("/api/plans/{plan_id}", summary="Execute a recovery plan (shared desk)")
def post_plan(plan_id: str) -> dict:
    try:
        hub.mission.run_plan(plan_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    hub.desk_force_predict = True
    return {"ok": True}


@app.post("/api/sim", summary="Set shared-desk simulation speed or pause")
def post_sim(s: SimIn) -> dict:
    if s.speed is not None:
        hub.mission.speed = max(0.5, min(240.0, s.speed))
    if s.paused is not None:
        hub.mission.paused = s.paused
    return {"speed": hub.mission.speed, "paused": hub.mission.paused}


@app.post("/api/reset", summary="Restart the shared-desk mission")
async def post_reset() -> dict:
    hub.reset_desk()
    return {"ok": True}


class ExplainIn(BaseModel):
    session_id: str | None = Field(None, description="WebSocket console session id from hello/snap")


@app.get("/api/llm/status", summary="Whether local Ollama and the configured model are available")
def llm_status() -> dict:
    return llm_mod.status()


@app.post("/api/llm/explain", summary="Plain-language cause→effect note grounded on twin correlations")
async def llm_explain(body: ExplainIn = ExplainIn()) -> dict:
    # Prefer the caller's console session when session_id is provided.
    sess = hub.session_by_id(body.session_id)
    if sess is not None:
        m = sess.mission
    elif len(hub.sessions) == 1:
        m = next(iter(hub.sessions.values())).mission
    else:
        m = hub.mission
    snap = m.snapshot()
    pred = m.prediction
    ctx = llm_mod.build_context(snap, pred)
    return await asyncio.to_thread(llm_mod.explain, ctx)


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
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=telemetry.csv"})


class CsvIngestBody(BaseModel):
    csv: str = Field(description="telemetry.csv text (same columns as GET /api/telemetry.csv)")
    session_id: str | None = Field(None, description="Target WebSocket console session")


@app.post("/api/telemetry/ingest", summary="Ingest recorded telemetry CSV into the twin (local judge evidence)")
def ingest_csv(body: CsvIngestBody) -> dict:
    buf = io.StringIO(body.csv)
    reader = csv.DictReader(buf)
    rows = list(reader)
    if not rows:
        raise HTTPException(422, detail={"message": "empty CSV", "errors": []})
    sess = hub.session_by_id(body.session_id)
    m = sess.mission if sess else hub.mission
    result = m.ingest_csv_rows(rows)
    if result.get("errors") and not result.get("ingested"):
        raise HTTPException(422, detail={"message": "CSV validation failed", "errors": result["errors"]})
    return {
        "ok": True,
        "ingested": result["ingested"],
        "sync": result["sync"],
        "rx": result["rx"],
        "errors": result.get("errors") or [],
        "anomalies": result.get("anomalies", 0),
        "state": (result.get("snap") or {}).get("sync"),
    }


app.mount("/", StaticFiles(directory=str(ROOT / "frontend"), html=True), name="frontend")
