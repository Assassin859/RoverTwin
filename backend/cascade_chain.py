"""Timed cascading-loss stages from confirmed twin diagnoses only."""
from __future__ import annotations

from collections import defaultdict

EDGE_LIT = 0.12

EDGE_TEXT = {
    "EPS>TCS": "Pack heat lights EPS→TCS — battery warming the thermal node",
    "TCS>GNC": "Heat reaches ADCS — gyro drift / wheel friction",
    "TCS>COMMS": "Thermal derate hits COMMS — radio margin under pressure",
    "TCS>MOB": "Thermal limit inhibits payload imaging",
    "EPS>GNC": "Brownout caps reaction-wheel torque",
    "EPS>COMMS": "Low bus voltage weakens the radio",
    "EPS>MOB": "Low SOC sheds payload imaging",
    "GNC>COMMS": "Attitude error mispoints the antenna",
    "GNC>EPS": "ADCS compute draws extra power",
    "GNC>MOB": "Poor pointing kills imaging quality",
    "COMMS>EPS": "Signal search draws extra power",
    "COMMS>DATA": "Off-pass / link lost — OBDH buffer filling",
    "MOB>EPS": "Payload and wheels taxing the battery",
    "TCS>EPS": "Thermal load feeds back onto power",
}

KIND_ORDER = {"root": 0, "edge": 1, "path": 2, "sub": 3, "loss": 4, "fdir": 5, "recovery": 6}


def _live_edge_text(edge: str, couplings: dict) -> str:
    base = EDGE_TEXT.get(edge, f"Coupling {edge} lights")
    val = (couplings or {}).get(edge)
    if isinstance(val, (list, tuple)) and len(val) > 1 and val[1]:
        return f"{base} ({val[1]})"
    return base


def _root_text(sub: str, findings: list[dict]) -> str:
    parts = [f.get("text") or "fault detected" for f in findings if f.get("sub") == sub and not f.get("contained")]
    if not parts:
        parts = [f.get("text") or "fault detected" for f in findings if f.get("sub") == sub]
    body = "; ".join(parts) if parts else "fault detected"
    return f"ROOT on {sub}: {body}"


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
        self._live_findings: list[dict] = []
        self._live_subs: list[dict] = []
        self._live_coup: dict = {}

    def reset(self) -> None:
        self.stages.clear()
        self.seen.clear()
        self._prev = {"drive": True, "payload": True, "down_ok": True, "mode": "NOMINAL"}
        self._live_findings = []
        self._live_subs = []
        self._live_coup = {}

    def _renumber(self) -> None:
        self.stages.sort(key=lambda st: (KIND_ORDER.get(st["kind"], 9), st.get("t", 0), st["id"]))
        for i, st in enumerate(self.stages, 1):
            st["n"] = i

    def _stage(self, sid: str) -> dict | None:
        return next((s for s in self.stages if s["id"] == sid), None)

    def _add(self, sid: str, t: float, kind: str, text: str, sub: str = "",
             edges: list[str] | None = None, finding_id: str = "") -> dict | None:
        existing = self._stage(sid)
        if existing is not None:
            if existing.get("resolved"):
                existing["resolved"] = False
                existing["text"] = text
                existing["t"] = round(t, 1)
                return existing  # re-opened — treat as noteworthy
            return None
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
            "resolved": False,
            "n": len(self.stages) + 1,
        }
        self.stages.append(stage)
        return stage

    def _resolve(self, confirmed: list[dict], correlations: dict, t: float) -> list[dict]:
        """Mark stages resolved when roots clear/contain — keep history."""
        active_subs = {f.get("sub") for f in confirmed if not f.get("contained")}
        contained = {f.get("sub"): f.get("contained") for f in confirmed if f.get("contained")}
        # Cleared entirely (no finding left for a former root sub)
        active = set(correlations.get("active") or [])
        newly: list[dict] = []
        for st in self.stages:
            if st.get("resolved"):
                continue
            drop = False
            if st["kind"] == "root":
                sub = st.get("sub") or ""
                if sub not in active_subs:
                    drop = True
                    if sub in contained:
                        rec = self._add(
                            f"recovery:{sub}", t, "recovery",
                            f"Recovery: fault on {sub} contained ({contained[sub]})",
                            sub=sub, finding_id=st.get("finding_id", ""),
                        )
                        if rec:
                            newly.append(rec)
            elif st["kind"] in ("edge", "path", "sub"):
                if not active_subs:
                    drop = True
                elif st["kind"] == "edge":
                    edge = st["id"][5:] if st["id"].startswith("edge:") else (st.get("edges") or [""])[0]
                    if edge not in active:
                        drop = True
                elif st["kind"] == "path":
                    edges = st.get("edges") or []
                    if not edges or not all(e in active for e in edges):
                        drop = True
            if drop:
                st["resolved"] = True
                txt = st.get("text") or ""
                if not str(txt).startswith("Resolved:"):
                    txt = f"Resolved: {txt}"
                st["text"] = txt
                st["text_frozen"] = txt
                newly.append(st)
        self._renumber()
        return newly

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
        """`findings` must be confirmed diagnoses only. Returns {new, resolved}."""
        self._live_findings = list(findings or [])
        self._live_subs = list(subsystems or [])
        self._live_coup = couplings or {}

        resolved = self._resolve(findings or [], correlations or {}, t)
        new: list[dict] = []
        cfg = view.get("cfg") or {}
        if hasattr(cfg, "drive"):
            drive, payload, mode = cfg.drive, cfg.payload, cfg.mode
        else:
            drive = bool(cfg.get("drive", True))
            payload = bool(cfg.get("payload", True))
            mode = cfg.get("mode", "NOMINAL")
        down_ok = bool(view.get("down_ok", True))

        active_findings = [f for f in (findings or []) if not f.get("contained")]
        conf_subs = {f.get("sub") for f in active_findings}

        # 1) One ROOT per subsystem (merge finding texts)
        by_sub: dict[str, list[dict]] = defaultdict(list)
        for f in active_findings:
            by_sub[f.get("sub") or ""].append(f)
        for sub, flist in by_sub.items():
            if not sub:
                continue
            fid = flist[0].get("id") or ""
            text = _root_text(sub, flist)
            st = self._add(f"root:{sub}", t, "root", text, sub=sub, finding_id=fid)
            if st:
                new.append(st)
            else:
                # Refresh text on existing active root
                existing = self._stage(f"root:{sub}")
                if existing and not existing.get("resolved"):
                    existing["text"] = text
                    existing["finding_id"] = fid

        if not conf_subs:
            self._prev = {"drive": drive, "payload": payload, "down_ok": down_ok, "mode": mode}
            self._renumber()
            return {"new": new, "retracted": resolved, "resolved": resolved}

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
            st = self._add("loss:drive", t, "loss", "Capability loss: payload imaging inhibited",
                           sub="MOB", edges=["GNC>MOB", "TCS>MOB", "EPS>MOB"])
            if st:
                new.append(st)
        if self._prev["payload"] and not payload:
            st = self._add("loss:payload", t, "loss", "Capability loss: science payload off",
                           sub="DATA", edges=[])
            if st:
                new.append(st)
        if self._prev["down_ok"] and not down_ok:
            st = self._add("loss:link", t, "loss", "Capability loss: downlink lost / off-pass",
                           sub="COMMS", edges=["GNC>COMMS", "TCS>COMMS", "EPS>COMMS"])
            if st:
                new.append(st)

        # 5) FDIR
        if self._prev["mode"] != "SAFE" and mode == "SAFE":
            st = self._add("fdir:SAFE", t, "fdir",
                           "FDIR: autonomous SAFE — sun-point, payload inhibited",
                           sub="EPS", edges=[])
            if st:
                new.append(st)
        for msg in fdir_texts or []:
            low = msg.lower()
            if "imaging" in low or "inhibit" in low or "halt" in low:
                st = self._add("fdir:halt", t, "fdir", f"FDIR: {msg}", sub="GNC", edges=["GNC>MOB"])
                if st:
                    new.append(st)
            elif "safe mode" in low or "autonomous safe" in low or "momentum" in low:
                st = self._add("fdir:SAFE", t, "fdir", f"FDIR: {msg}", sub="EPS", edges=[])
                if st:
                    new.append(st)

        self._prev = {"drive": drive, "payload": payload, "down_ok": down_ok, "mode": mode}
        self._renumber()
        return {"new": new, "retracted": resolved, "resolved": resolved}

    def snapshot(self, couplings: dict | None = None,
                 findings: list[dict] | None = None,
                 subsystems: list[dict] | None = None) -> dict:
        """Refresh stage text from live findings/couplings/subsystem causes."""
        coup = couplings if couplings is not None else self._live_coup
        finds = findings if findings is not None else self._live_findings
        subs = {s["id"]: s for s in (subsystems if subsystems is not None else self._live_subs)}
        stages = []
        for st in self.stages:
            s = dict(st)
            kind = s["kind"]
            if kind == "root" and not s.get("resolved"):
                sub = s.get("sub") or ""
                s["text"] = _root_text(sub, finds)
            elif kind == "edge" and s.get("edges"):
                # Freeze resolved chain text so live dB labels cannot rewrite history
                if s.get("resolved"):
                    frozen = s.get("text_frozen") or s.get("text") or ""
                    if not str(frozen).startswith("Resolved:"):
                        frozen = f"Resolved: {frozen}"
                    s["text"] = frozen
                    s["text_frozen"] = frozen
                else:
                    s["text"] = _live_edge_text(s["edges"][0], coup)
            elif kind == "sub" and not s.get("resolved"):
                sub = subs.get(s.get("sub") or "")
                if sub and sub.get("cause"):
                    s["text"] = f"Loss cascading into {sub['id']}: {sub['cause']}"
            elif kind == "root" and s.get("resolved"):
                frozen = s.get("text_frozen") or s.get("text") or ""
                if not str(frozen).startswith("Resolved:"):
                    frozen = f"Resolved: {frozen}"
                s["text"] = frozen
                s["text_frozen"] = frozen
            stages.append(s)
        active = [x for x in stages if not x.get("resolved")]
        latest = (active[-1] if active else stages[-1] if stages else None)
        return {
            "stages": stages,
            "latest": latest["text"] if latest else "",
            "playing": [x["id"] for x in stages],
        }
