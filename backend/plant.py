"""The simulated physical rover and the radio link to the ground.

Nothing outside this module may read the plant's ``State`` or ``Health``
(except the test-harness "truth" view). The twin only receives telemetry
frames that survive the link.
"""
from __future__ import annotations

import math
import random
from dataclasses import asdict, dataclass

from .model import GROUND_COMMANDS, Health, Params, State, apply_command, clamp, step

FAULTS = {
    "battery": {
        "name": "Battery degradation",
        "detail": "Cell ageing in string 2: capacity fade, higher resistance and an internal micro-short.",
    },
    "thermal": {
        "name": "Thermal stress",
        "detail": "Dust and damaged insulation on the radiator: the avionics box can no longer shed heat.",
    },
    "sensor": {
        "name": "Sensor failure",
        "detail": "IMU-A gyro develops a growing bias: the rover slowly loses track of where it is pointing.",
    },
    "comms": {
        "name": "Communication loss",
        "detail": "Transponder A power amplifier fails: the radio link to the relay orbiter fades out.",
    },
}


def apply_fault(h: Health, kind: str, x: float) -> None:
    if kind == "battery":
        h.bat_capacity_frac *= 1.0 - 0.45 * x
        h.bat_r_mult *= 1.0 + 5.0 * x
        h.bat_leak_w += 80.0 * x * x
    elif kind == "thermal":
        h.rad_eff *= 1.0 - 0.7 * x
    elif kind == "sensor":
        h.imu_a_bias += 0.12 * x
    elif kind == "comms":
        h.trx_a_loss_db += 45.0 * x


@dataclass
class Fault:
    kind: str
    severity: float
    ramp_s: float
    t0: float

    def level(self, t: float) -> float:
        if self.ramp_s <= 0:
            return self.severity
        return self.severity * clamp((t - self.t0) / self.ramp_s, 0.0, 1.0)


class RoverPlant:
    def __init__(self, p: Params, rng: random.Random):
        self.p, self.rng = p, rng
        self.s = State()
        self.h = Health()
        self.faults: dict[str, Fault] = {}
        self.terrain = 1.0
        self.seq = 0
        self.pending_events: list[str] = []
        self.acks: list[int] = []
        self.o: dict = {}

    def inject(self, kind: str, severity: float, ramp_s: float) -> None:
        if kind not in FAULTS:
            raise ValueError(f"unknown fault {kind!r}")
        self.faults[kind] = Fault(kind, clamp(severity, 0.0, 1.0), max(0.0, ramp_s), self.s.t)

    def clear(self, kind: str) -> None:
        self.faults.pop(kind, None)

    def _health(self) -> Health:
        h = Health()
        for f in self.faults.values():
            apply_fault(h, f.kind, f.level(self.s.t))
        return h

    def step(self, dt: float) -> dict:
        self.h = self._health()
        # terrain roughness: Ornstein-Uhlenbeck process on drive power
        self.terrain += (1.0 - self.terrain) * dt / 40.0 + self.rng.gauss(0, 0.04) * math.sqrt(dt)
        self.terrain = clamp(self.terrain, 0.6, 1.5)
        self.o = step(self.s, self.h, self.p, dt, self.terrain)
        self.pending_events += self.o["events"]
        return self.o

    def execute(self, cmd: dict) -> None:
        msg = apply_command(self.s, cmd["name"], cmd["value"])
        self.acks.append(cmd["id"])
        self.pending_events.append(f"Executed command #{cmd['id']}: {msg}")

    def telemetry(self) -> dict:
        """One housekeeping frame, as measured by onboard sensors."""
        s, o, g = self.s, self.o, self.rng.gauss
        self.seq += 1
        return {
            "seq": self.seq,
            "t": s.t,
            "soc": clamp(s.soc + g(0, 0.001), 0, 1),
            "v_bus": o["v_bus"] + g(0, 0.03),
            "i_bat": o["i_bat"] + g(0, 0.05),
            "t_av": s.t_av + g(0, 0.2),
            "t_bat": s.t_bat + g(0, 0.2),
            "p_sol": max(0.0, o["p_sol"] + g(0, 1.5)),
            "p_load": o["p_load"] + g(0, 1.5),
            "loads": {k: round(o[k], 2) for k in ("p_av", "p_sens", "p_mob", "p_pay", "p_comm", "p_heat_av", "p_heat_bat")},
            "innov": o["innov"] + g(0, 0.003),
            "speed": o["v"],
            "x": s.x, "z": s.z, "heading": s.heading, "odometer": s.odometer, "shade": s.shade,
            "buffer_mb": s.buffer_mb,
            "no_contact_s": s.no_contact_s, "no_lock_s": s.no_lock_s,
            "auto_safe": s.auto_safe,
            "cfg": asdict(s.cfg),
        }


class RadioLink:
    """Rover <-> relay orbiter <-> ground. Light-time plus relay latency,
    data-rate-limited telemetry cadence, packet loss on weak links and a
    command uplink that only works when the uplink closes."""

    LATENCY_S = 2.6
    FRAME_KBIT = 8.0

    def __init__(self, p: Params, rng: random.Random):
        self.p, self.rng = p, rng
        self.down: list[tuple[float, dict]] = []
        self.up: list[dict] = []
        self.next_frame_t = 0.0
        self.sent = 0
        self.dropped = 0
        self.next_cmd_id = 1
        self.margin = 0.0
        self.rate = 0.0

    def downlink(self, t: float, plant: RoverPlant) -> None:
        o = plant.o
        self.margin, self.rate = o["margin"], o["rate"]
        if not o["down_ok"] or t < self.next_frame_t:
            return
        self.next_frame_t = t + max(1.0, self.FRAME_KBIT / max(o["rate"], 1e-6))
        frame = plant.telemetry()
        frame["events"], plant.pending_events = plant.pending_events, []
        frame["acks"], plant.acks = plant.acks, []
        frame["margin"] = o["margin"] + self.rng.gauss(0, 0.3)
        frame["rate"] = o["rate"]
        self.sent += 1
        p_loss = clamp(0.01 + (3.0 - o["margin"]) * 0.05, 0.01, 0.6) if o["margin"] < 3.0 else 0.01
        if self.rng.random() < p_loss:
            self.dropped += 1
            plant.pending_events = frame["events"] + plant.pending_events
            plant.acks = frame["acks"] + plant.acks
            return
        self.down.append((t + self.LATENCY_S, frame))

    def arrivals(self, t: float) -> list[dict]:
        out = [f for (ta, f) in self.down if ta <= t]
        self.down = [(ta, f) for (ta, f) in self.down if ta > t]
        return out

    def send_command(self, name: str, value, t: float) -> dict:
        cmd = {"id": self.next_cmd_id, "name": name, "value": value, "sent_t": t, "status": "queued"}
        self.next_cmd_id += 1
        if name in GROUND_COMMANDS:
            cmd["status"] = "ground"
        else:
            self.up.append(cmd)
        return cmd

    def deliver_commands(self, t: float, plant: RoverPlant) -> list[dict]:
        if not plant.o.get("up_ok"):
            for c in self.up:
                c["status"] = "waiting for uplink"
            return []
        ready = [c for c in self.up if t - c["sent_t"] >= self.LATENCY_S]
        self.up = [c for c in self.up if c not in ready]
        for c in ready:
            c["status"] = "delivered"
        return ready
