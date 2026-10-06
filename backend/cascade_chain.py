"""Timed cascading-loss stages from real twin state (no invented secondary faults)."""
from __future__ import annotations

EDGE_LIT = 0.12

EDGE_TEXT = {
    "EPS>TCS": "Pack heat lights EPS→TCS — battery warming the thermal node",
    "TCS>GNC": "Heat reaches GNC/ADCS — gyro drift coupling lights",
    "TCS>COMMS": "Thermal derate hits COMMS — radio margin under pressure",
    "TCS>MOB": "Thermal speed limit engages on mobility",
    "EPS>GNC": "Brownout noise hits GNC sensors",
    "EPS>COMMS": "Low bus voltage weakens the radio",
    "EPS>MOB": "Low SOC limits drive speed",
    "GNC>COMMS": "Attitude error mispoints the antenna",
    "GNC>EPS": "Visual-odometry fallback burns extra power",
    "GNC>MOB": "Attitude knowledge forces a drive halt",
    "COMMS>EPS": "Signal search draws extra power",
    "COMMS>DATA": "Downlink lost — science buffer filling",
    "MOB>EPS": "Drive motors taxing the battery",
    "TCS>EPS": "Thermal load feeds back onto power",
}


class CascadeTracker:
    """Accumulates ordered chain-reaction stages once per mission."""

    def __init__(self) -> None:
        self.stages: list[dict] = []
        self.seen: set[str] = set()
        self._prev: dict = {
            "drive": True,
            "payload": True,
            "down_ok": True,
            "mode": "NOMINAL",
        }

    def reset(self) -> None:
        self.stages.clear()
        self.seen.clear()
        self._prev = {"drive": True, "payload": True, "down_ok": True, "mode": "NOMINAL"}

    def _add(self, sid: str, t: float, kind: str, text: str, sub: str = "",
             edges: list[str] | None = None) -> dict | None:
        if sid in self.seen:
            return None
        self.seen.add(sid)
        stage = {
            "id": sid,
            "t": round(t, 1),
            "kind": kind,
            "sub": sub,
            "text": text,
            "edges": edges or [],
            "n": len(self.stages) + 1,
        }
        self.stages.append(stage)
        return stage

    def update(
        self,
        t: float,
        findings: list[dict],
        correlations: dict,
        couplings: dict,
        subsystems: list[dict],
        view: dict,
        fdir_texts: list[str] | None = None,
    ) -> list[dict]:
        """Detect new stages; return only those added this call."""
        new: list[dict] = []
        cfg = view.get("cfg") or {}
        if hasattr(cfg, "drive"):
            drive, payload, mode = cfg.drive, cfg.payload, cfg.mode
        else:
            drive = bool(cfg.get("drive", True))
            payload = bool(cfg.get("payload", True))
            mode = cfg.get("mode", "NOMINAL")
        down_ok = bool(view.get("down_ok", True))

        # 1) Root findings
        for f in findings or []:
            if f.get("contained"):
                continue
            sub = f.get("sub") or ""
            fid = f.get("id") or ""
            sid = f"root:{sub}:{fid}"
            text = f"ROOT on {sub}: {f.get('text', 'fault detected')}"
            st = self._add(sid, t, "root", text, sub=sub, edges=[])
            if st:
                new.append(st)

        # 2) Lit correlation edges (chain hops)
        active = correlations.get("active") or []
        coup = couplings or {}
        for edge in active:
            val = coup.get(edge)
            s = float(val[0]) if isinstance(val, (list, tuple)) else float(val or 0)
            if s < EDGE_LIT:
                continue
            sid = f"edge:{edge}"
            label = EDGE_TEXT.get(edge) or f"Coupling {edge} lights ({s:.2f})"
            st = self._add(sid, t, "edge", label, sub=edge.split(">")[-1], edges=[edge])
            if st:
                new.append(st)

        # Prefer announcing multi-hop path as a combined stage once
        for p in correlations.get("paths") or []:
            edges = p.get("edges") or []
            if len(edges) < 2:
                continue
            sid = f"path:{'>'.join(edges)}"
            chain = " → ".join([p["from"], *(p.get("via") or []), p["to"]])
            text = f"Chain reaction path: {chain}"
            st = self._add(sid, t, "path", text, sub=p.get("to", ""), edges=list(edges))
            if st:
                new.append(st)
            break  # one multi-hop banner is enough

        # 3) Knock-on subsystem degradation
        for sub in subsystems or []:
            if sub.get("root") or sub.get("status") == "NOMINAL":
                continue
            if not sub.get("cause"):
                continue
            sid = f"sub:{sub['id']}"
            text = f"Loss cascading into {sub['id']}: {sub['cause']}"
            # edges from cause path if present
            edges = []
            for a in active:
                if a.endswith(">" + sub["id"]):
                    edges.append(a)
            st = self._add(sid, t, "sub", text, sub=sub["id"], edges=edges)
            if st:
                new.append(st)

        # 4) Capability losses (transitions)
        if self._prev["drive"] and not drive:
            st = self._add("loss:drive", t, "loss", "Capability loss: drive commanded off / halted",
                           sub="MOB", edges=["GNC>MOB", "TCS>MOB", "EPS>MOB"])
            if st:
                new.append(st)
        if self._prev["payload"] and not payload:
            st = self._add("loss:payload", t, "loss", "Capability loss: science payload off",
                           sub="DATA", edges=[])
            if st:
                new.append(st)
        if self._prev["down_ok"] and not down_ok:
            st = self._add("loss:link", t, "loss", "Capability loss: downlink lost",
                           sub="COMMS", edges=["GNC>COMMS", "TCS>COMMS", "EPS>COMMS"])
            if st:
                new.append(st)

        # 5) FDIR autonomy
        if self._prev["mode"] != "SAFE" and mode == "SAFE":
            st = self._add("fdir:SAFE", t, "fdir",
                           "FDIR: autonomous SAFE mode — drive/payload inhibited",
                           sub="EPS", edges=[])
            if st:
                new.append(st)
        for msg in fdir_texts or []:
            low = msg.lower()
            if "halt" in low or "attitude" in low and "stop" in low:
                st = self._add("fdir:halt", t, "fdir", f"FDIR: {msg}", sub="GNC", edges=["GNC>MOB"])
                if st:
                    new.append(st)
            elif "safe mode" in low or "autonomous safe" in low:
                st = self._add("fdir:SAFE", t, "fdir", f"FDIR: {msg}", sub="EPS", edges=[])
                if st:
                    new.append(st)

        self._prev = {"drive": drive, "payload": payload, "down_ok": down_ok, "mode": mode}
        return new

    def snapshot(self) -> dict:
        return {
            "stages": list(self.stages),
            "latest": self.stages[-1]["text"] if self.stages else "",
            "playing": [s["id"] for s in self.stages],
        }
