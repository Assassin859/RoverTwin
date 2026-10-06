"""Mission orchestrator: rover plant -> radio link -> digital twin -> operators."""
from __future__ import annotations

import copy
import random
from collections import deque
from dataclasses import asdict

from .model import GROUND_COMMANDS, LIMITS, Params, apply_command
from .plant import FAULTS, RadioLink, RoverPlant
from .predict import PLAN_BY_ID, PLANS, predict_all
from .store import Store
from .twin import RESIDUALS, DigitalTwin
from .cascade_chain import CascadeTracker

HISTORY_DT = 10.0


class Mission:
    def __init__(self, store: Store | None = None, seed: int | None = None):
        self.p = Params()
        self.rng = random.Random(seed)
        self.plant = RoverPlant(self.p, self.rng)
        self.link = RadioLink(self.p, self.rng)
        self.twin = DigitalTwin(self.p)
        self.cascade = CascadeTracker()
        self.store = store
        self.t = 0.0
        self.speed = 30.0
        self.paused = False
        self._acc = 0.0
        self._last_hist = -1e9
        self.events: deque[dict] = deque(maxlen=500)
        self.event_seq = 0
        self.history: deque[dict] = deque(maxlen=1500)
        self.commands: deque[dict] = deque(maxlen=40)
        self.prediction: dict | None = None
        self.pred_seq = 0
        self._pred_keys: set[str] = set()
        self.log("SYS", "Mission start: rover exploring near the lunar south pole, relay orbiter overhead")
        if store:
            store.reset()

    # ------------------------------------------------------------------ time
    def advance(self, sim_dt: float) -> None:
        self._acc += sim_dt
        while self._acc >= 1.0:
            self._acc -= 1.0
            self._tick()

    def _tick(self) -> None:
        pl = self.plant
        pl.step(1.0)
        self.t = pl.s.t
        self.link.downlink(self.t, pl)
        for cmd in self.link.deliver_commands(self.t, pl):
            pl.execute(cmd)
        self.twin.propagate(1.0, self.t)
        for f in self.link.arrivals(self.t):
            self.twin.ingest(f, self.t)
            for cid in f.get("acks", []):
                for c in self.commands:
                    if c["id"] == cid:
                        c["status"] = "confirmed"
            if self.store:
                self.store.frame(f)
        for kind, text in self.twin.events:
            self.log(kind, text)
        fdir_texts = [text for kind, text in self.twin.events if kind == "FDIR"]
        self.twin.events = []
        # Cascading loss stages from *confirmed* diagnoses only
        confirmed = self.twin.confirmed_findings()
        corr = self.twin.correlations()
        coup = self.twin.o.get("couplings") or {}
        result = self.cascade.update(
            self.t,
            confirmed,
            corr,
            coup,
            self.twin.subsystems(),
            self.twin.view(),
            fdir_texts,
        )
        for st in result.get("new") or []:
            self.log("CASCADE", st["text"])
        for st in result.get("retracted") or []:
            self.log("CASCADE", f"Retracted: {st['text']}")
        if self.t - self._last_hist >= HISTORY_DT:
            self._last_hist = self.t
            sample = self.sample()
            self.history.append(sample)
            if self.store:
                self.store.twin(sample)

    def log(self, kind: str, text: str) -> None:
        self.event_seq += 1
        e = {"id": self.event_seq, "t": self.t, "kind": kind, "text": text}
        self.events.append(e)
        if self.store:
            self.store.event(e)

    # ------------------------------------------------------------- operators
    def inject(self, kind: str, severity: float, ramp_s: float) -> None:
        self.plant.inject(kind, severity, ramp_s)
        self.log("FAULT", f"[test harness] Injected {FAULTS[kind]['name'].lower()} at {severity:.0%} severity"
                          f"{f', ramping over {ramp_s / 60:.0f} min' if ramp_s >= 60 else ''}")

    def clear(self, kind: str) -> None:
        if kind in self.plant.faults:
            self.plant.clear(kind)
            self.log("FAULT", f"[test harness] Cleared {FAULTS[kind]['name'].lower()}")

    def command(self, name: str, value, source: str = "operator") -> dict:
        allowed = {"mode", "drive", "speed", "payload", "imu", "trx", "antenna",
                   "bat_isolated", "pose", "relay_hp"}
        if name not in allowed:
            raise ValueError(f"unknown command {name!r}")
        cmd = self.link.send_command(name, value, self.t)
        if name in GROUND_COMMANDS:
            apply_command(self.plant.s, name, value)
        self.twin.expect(cmd, self.t)
        cmd["source"] = source
        self.commands.append(cmd)
        where = "ground segment" if name in GROUND_COMMANDS else "uplink queue"
        self.log("CMD", f"#{cmd['id']} {name} = {value} sent to {where}" + (f" ({source})" if source != "operator" else ""))
        return cmd

    def run_plan(self, plan_id: str) -> None:
        plan = None
        if self.prediction:
            plan = next((x for x in self.prediction["plans"] if x["id"] == plan_id), None)
        plan = plan or PLAN_BY_ID.get(plan_id)
        if not plan:
            raise ValueError(f"unknown plan {plan_id!r}")
        self.log("CMD", f"Executing recovery plan: {plan['name']}")
        for name, value in plan["cmds"]:
            self.command(name, value, source="plan")

    # ------------------------------------------------------------ prediction
    def prediction_inputs(self) -> tuple:
        tw = self.twin
        return (tw.s.clone(), copy.copy(tw.h), bool(tw.o.get("up_ok")), dict(tw.unc), self.p, tw.terrain)

    @staticmethod
    def compute_prediction(inputs: tuple) -> dict:
        return predict_all(*inputs)

    def set_prediction(self, pred: dict) -> None:
        self.prediction = pred
        self.pred_seq += 1
        keys = set()
        for e in pred["events"]:
            keys.add(e["key"])
            if e["key"] not in self._pred_keys and e["level"] == "crit":
                self.log("PRED", f"If nothing is done: {e['text'][:1].lower() + e['text'][1:]} in {e['t'] / 60:.0f} min")
        self._pred_keys = keys

    # -------------------------------------------------------------- snapshots
    def truth(self) -> dict:
        s, o, h = self.plant.s, self.plant.o, self.plant.h
        return {
            "soc": s.soc, "t_av": s.t_av, "t_bat": s.t_bat, "att_err": s.att_err, "margin": o.get("margin", 0),
            "x": s.x, "z": s.z, "heading": s.heading, "buffer_mb": s.buffer_mb, "v_bus": o.get("v_bus", 0),
            "health": asdict(h), "cfg": asdict(s.cfg), "dead": s.dead,
        }

    def sample(self) -> dict:
        tw, tr = self.twin.view(), self.truth()
        f = self.twin.last_frame
        fresh = f is not None and self.t - self.twin.last_frame_t < HISTORY_DT
        keys = ("soc", "t_av", "t_bat", "margin", "att_err")
        return {
            "t": self.t,
            "tw": {k: round(tw[k], 4) for k in keys},
            "tr": {k: round(tr[k], 4) for k in keys},
            "tm": {k: round(f[k], 4) for k in ("soc", "t_av", "t_bat", "margin")} if fresh else None,
            "unc": {k: round(v, 4) for k, v in tw["unc"].items()},
        }

    def meta(self) -> dict:
        return {
            "faults": FAULTS, "limits": LIMITS,
            "plans": [{"id": p["id"], "name": p["name"], "plain": p["plain"]} for p in PLANS],
            "residuals": {k: v[0] for k, v in RESIDUALS.items()},
            "buffer_cap": self.p.buffer_cap_mb,
        }

    def snapshot(self) -> dict:
        tw = self.twin
        f = tw.last_frame
        return {
            "t": self.t, "speed": self.speed, "paused": self.paused,
            "twin": tw.view(), "truth": self.truth(),
            "sync": {
                "state": tw.sync, "age": self.t - tw.last_frame_t if f else None, "rx": tw.rx,
                "lost": tw.lost + self.link.dropped, "rate": tw.last_rate, "seq": f["seq"] if f else 0,
                "latency": RadioLink.LATENCY_S,
            },
            "link": {"margin": self.link.margin, "rate": self.link.rate},
            "subsystems": tw.subsystems(), "findings": tw.confirmed_findings(),
            "residuals": {k: round(v, 2) for k, v in tw.z.items()},
            "anomalies": sorted(tw.active_anoms),
            "couplings": {k: [round(v[0], 3), v[1]] for k, v in tw.o["couplings"].items()},
            "correlations": tw.correlations(),
            "cascade_chain": self.cascade.snapshot(tw.o.get("couplings") or {}),
            "prognostics": tw.prognostics(),
            "faults": [{"kind": k, "severity": fl.severity, "level": fl.level(self.t)}
                       for k, fl in self.plant.faults.items()],
            "commands": list(self.commands)[-8:],
            "pred_seq": self.pred_seq,
        }
