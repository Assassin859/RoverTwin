"""Timed cascading-loss stages from confirmed twin diagnoses only."""
from __future__ import annotations

EDGE_LIT = 0.12

EDGE_TEXT = {
    "EPS>TCS": "Pack heat lights EPS→TCS — battery warming the thermal node",
    "TCS>GNC": "Heat reaches ADCS — gyro drift coupling lights",
    "TCS>COMMS": "Thermal derate hits COMMS — radio margin under pressure",
    "TCS>MOB": "Thermal speed limit engages on mobility",
    "EPS>GNC": "Brownout noise hits ADCS sensors",
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


def _live_edge_text(edge: str, couplings: dict) -> str:
    base = EDGE_TEXT.get(edge, f"Coupling {edge} lights")
    val = (couplings or {}).get(edge)
    if isinstance(val, (list, tuple)) and len(val) > 1 and val[1]:
        return f"{base} ({val[1]})"
    return base


class CascadeTracker:
    """Ordered chain-reaction stages; only confirmed findings seed roots."""

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

    def _renumber(self) -> None:
        for i, st in enumerate(self.stages, 1):
            st["n"] = i

    def _add(self, sid: str, t: float, kind: str, text: str, sub: str = "",
             edges: list[str] | None = None, finding_id: str = "") -> dict | None:
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
            "finding_id": finding_id,
            "n": len(self.stages) + 1,
        }
        self.stages.append(stage)
        return stage

    def _prune(self, confirmed: list[dict], correlations: dict) -> list[dict]:
        """Drop stages whose root is gone or whose edge is no longer active."""
        conf_ids = {f.get("id") for f in confirmed if not f.get("contained")}
        conf_subs = {f.get("sub") for f in confirmed if not f.get("contained")}
        active = set(correlations.get("active") or [])
        retracted: list[dict] = []
        keep: list[dict] = []
        for st in self.stages:
            drop = False
            if st["kind"] == "root":
                fid = st.get("finding_id") or (st["id"].split(":")[-1] if ":" in st["id"] else "")
                if fid not in conf_ids:
                    drop = True
            elif st["kind"] in ("edge", "path", "sub"):
                if not conf_subs:
                    drop = True
                elif st["kind"] == "edge":
                    edge = st["id"][5:] if st["id"].startswith("edge:") else (st.get("edges") or [""])[0]
                    if edge not in active:
                        drop = True
                elif st["kind"] == "path":
                    edges = st.get("edges") or []
                    if not edges or not all(e in active for e in edges):
                        drop = True
                elif st["kind"] == "sub" and st.get("sub") and st["sub"] in conf_subs:
                    drop = False  # root sub itself ok
                elif st["kind"] == "sub" and not conf_subs:
                    drop = True
            if drop:
                self.seen.discard(st["id"])
                retracted.append(st)
            else:
                keep.append(st)
        self.stages = keep
        self._renumber()
        return retracted

    def update(
        self,
        t: float,
        findings: list[dict],
        correlations: dict,
        couplings: dict,
        subsystems: list[dict],
        view: dict,
        fdir_texts: list[str] | None = None,
    ) -> dict:
        """`findings` must be confirmed diagnoses only. Returns {new, retracted}."""
        retracted = self._prune(findings or [], correlations or {})
        new: list[dict] = []
        cfg = view.get("cfg") or {}
        if hasattr(cfg, "drive"):
            drive, payload, mode = cfg.drive, cfg.payload, cfg.mode
        else:
            drive = bool(cfg.get("drive", True))
            payload = bool(cfg.get("payload", True))
            mode = cfg.get("mode", "NOMINAL")
        down_ok = bool(view.get("down_ok", True))

        conf_subs = {f.get("sub") for f in (findings or []) if not f.get("contained")}

        # 1) Confirmed root findings
        for f in findings or []:
            if f.get("contained"):
                continue
            sub = f.get("sub") or ""
            fid = f.get("id") or ""
            sid = f"root:{sub}:{fid}"
            text = f"ROOT on {sub}: {f.get('text', 'fault detected')}"
            st = self._add(sid, t, "root", text, sub=sub, edges=[], finding_id=fid)
            if st:
                new.append(st)

        if not conf_subs:
            self._prev = {"drive": drive, "payload": payload, "down_ok": down_ok, "mode": mode}
            return {"new": new, "retracted": retracted}

        # 2) Lit correlation edges (from confirmed-root paths only)
        active = correlations.get("active") or []
        coup = couplings or {}
        for edge in active:
            val = coup.get(edge)
            s = float(val[0]) if isinstance(val, (list, tuple)) else float(val or 0)
            if s < EDGE_LIT:
                continue
            sid = f"edge:{edge}"
            st = self._add(sid, t, "edge", _live_edge_text(edge, coup),
                           sub=edge.split(">")[-1], edges=[edge])
            if st:
                new.append(st)

        for p in correlations.get("paths") or []:
            edges = p.get("edges") or []
            if len(edges) < 2:
                continue
            sid = f"path:{'>'.join(edges)}"
            chain = " → ".join([p["from"], *(p.get("via") or []), p["to"]])
            st = self._add(sid, t, "path", f"Chain reaction path: {chain}",
                           sub=p.get("to", ""), edges=list(edges))
            if st:
                new.append(st)
            break

        # 3) Knock-on subsystem degradation
        for sub in subsystems or []:
            if sub.get("root") or sub.get("status") == "NOMINAL":
                continue
            if not sub.get("cause"):
                continue
            sid = f"sub:{sub['id']}"
            edges = [a for a in active if a.endswith(">" + sub["id"])]
            st = self._add(sid, t, "sub", f"Loss cascading into {sub['id']}: {sub['cause']}",
                           sub=sub["id"], edges=edges)
            if st:
                new.append(st)

        # 4) Capability losses (only while a confirmed root exists)
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

        # 5) FDIR
        if self._prev["mode"] != "SAFE" and mode == "SAFE":
            st = self._add("fdir:SAFE", t, "fdir",
                           "FDIR: autonomous SAFE mode — drive/payload inhibited",
                           sub="EPS", edges=[])
            if st:
                new.append(st)
        for msg in fdir_texts or []:
            low = msg.lower()
            if "halt" in low or ("attitude" in low and "stop" in low):
                st = self._add("fdir:halt", t, "fdir", f"FDIR: {msg}", sub="GNC", edges=["GNC>MOB"])
                if st:
                    new.append(st)
            elif "safe mode" in low or "autonomous safe" in low:
                st = self._add("fdir:SAFE", t, "fdir", f"FDIR: {msg}", sub="EPS", edges=[])
                if st:
                    new.append(st)

        self._prev = {"drive": drive, "payload": payload, "down_ok": down_ok, "mode": mode}
        return {"new": new, "retracted": retracted}

    def snapshot(self, couplings: dict | None = None) -> dict:
        """Refresh edge stage text from live coupling labels when provided."""
        stages = []
        for st in self.stages:
            s = dict(st)
            if s["kind"] == "edge" and s.get("edges") and couplings is not None:
                s["text"] = _live_edge_text(s["edges"][0], couplings)
            stages.append(s)
        return {
            "stages": stages,
            "latest": stages[-1]["text"] if stages else "",
            "playing": [s["id"] for s in stages],
        }
