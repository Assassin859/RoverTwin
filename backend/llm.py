"""Optional local Ollama explainer — narrates twin facts only (qwen2.5:3b)."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")

SYSTEM = (
    "Spacecraft ops narrator for SatTwin (LEO Earth-observation smallsat; "
    "EPS/TCS/ADCS/COMMS/PAYLOAD/OBDH). "
    "Use ONLY the FACTS JSON. Do not invent numbers, faults, or recoveries. "
    "Name subsystems and edges (e.g. EPS>TCS). Prefer ADCS/PAYLOAD/OBDH labels "
    "over GNC/MOB/DATA when speaking to operators. "
    "Write 3–4 short sentences. If findings empty, say the twin is nominal."
)

_status_cache: dict | None = None
_status_at = 0.0
_STATUS_TTL = 30.0


def status(force: bool = False) -> dict:
    global _status_cache, _status_at
    now = time.monotonic()
    if not force and _status_cache is not None and (now - _status_at) < _STATUS_TTL:
        return _status_cache
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=2.0) as r:
            data = json.loads(r.read().decode())
        names = [m.get("name", "") for m in data.get("models", [])]
        has = any(OLLAMA_MODEL == n or n.startswith(OLLAMA_MODEL + ":") or OLLAMA_MODEL in n for n in names)
        _status_cache = {"ok": True, "host": OLLAMA_HOST, "model": OLLAMA_MODEL, "model_ready": has, "models": names[:12]}
    except Exception as e:
        _status_cache = {"ok": False, "host": OLLAMA_HOST, "model": OLLAMA_MODEL, "model_ready": False, "error": str(e)}
    _status_at = now
    return _status_cache


def build_context(snap: dict, pred: dict | None) -> dict:
    """Compact fact pack for the LLM (not a full snapshot dump)."""
    corr = snap.get("correlations") or {}
    findings = [
        {"id": f.get("id"), "sub": f.get("sub"), "text": f.get("text"),
         "contained": bool(f.get("contained"))}
        for f in (snap.get("findings") or [])[:4]
    ]
    paths = sorted(
        (corr.get("paths") or [])[:12],
        key=lambda p: (-len(p.get("edges") or []), -(p.get("strength") or 0)),
    )[:3]
    fc = (pred or {}).get("first_critical")
    return {
        "findings": findings,
        "top_finding": findings[0] if findings else None,
        "paths": [
            {"from": p["from"], "to": p["to"], "via": p.get("via"), "edges": p.get("edges"),
             "strength": p.get("strength"), "label": p.get("label")}
            for p in paths
        ],
        "active_edges": (corr.get("active") or [])[:10],
        "cascade_latest": (snap.get("cascade_chain") or {}).get("latest") or None,
        "first_critical": ({"text": fc.get("text"), "t": fc.get("t")} if isinstance(fc, dict) else None),
        "recommended": (pred or {}).get("recommended"),
        "recommended_name": next(
            (pl.get("name") for pl in ((pred or {}).get("plans") or []) if pl.get("id") == (pred or {}).get("recommended")),
            None,
        ),
    }


def _fmt_dur(s) -> str:
    try:
        s = float(s)
    except (TypeError, ValueError):
        return str(s)
    if s < 90:
        return f"{round(s)} s"
    if s < 5400:
        return f"{round(s / 60)} min"
    return f"{s / 3600:.1f} h"


def template_note(context: dict) -> str:
    """Deterministic narration from twin facts (used offline / on LLM failure)."""
    findings = context.get("findings") or []
    paths = context.get("paths") or []
    if not findings and not paths:
        return "Twin is nominal — no active root findings or cause→effect paths."
    parts = []
    top = context.get("top_finding") or (findings[0] if findings else None)
    if top:
        parts.append(f"Root: {top.get('sub')} — {top.get('text')}.")
    best = max(paths, key=lambda p: (len(p.get("edges") or []), p.get("strength") or 0), default=None)
    if best:
        chain = " → ".join([best["from"], *(best.get("via") or []), best["to"]])
        edges = ", ".join(best.get("edges") or [])
        parts.append(f"Cascade {chain} via {edges} ({best.get('label') or 'live coupling'}).")
    elif context.get("active_edges"):
        parts.append("Active edges: " + ", ".join(context["active_edges"][:6]) + ".")
    if context.get("cascade_latest"):
        parts.append(f"Latest cascade stage: {context['cascade_latest']}.")
    fc = context.get("first_critical")
    if fc:
        parts.append(f"If nothing is done: {fc.get('text')} in about {_fmt_dur(fc.get('t'))}.")
    rec = context.get("recommended_name") or context.get("recommended")
    if rec:
        parts.append(f"Twin-ranked recovery: {rec}.")
    parts.append("Source: twin correlations (template note).")
    return " ".join(parts)


def explain(context: dict, generate=None) -> dict:
    """Call Ollama /api/generate. `generate` is injectable for tests."""
    tmpl = template_note(context)
    st = status() if generate is None else {"ok": True, "model_ready": True}
    if generate is None and (not st.get("ok") or not st.get("model_ready")):
        return {"ok": False, "model": OLLAMA_MODEL, "text": tmpl, "source": "template", "context": context}

    prompt = (
        SYSTEM
        + "\n\nFACTS (JSON):\n"
        + json.dumps(context, ensure_ascii=False)
        + "\n\nNarrate the cause→effect cascade:"
    )
    body = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 96},
    }

    def _default_generate(payload: dict) -> str:
        req = urllib.request.Request(
            f"{OLLAMA_HOST}/api/generate",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=45.0) as r:
            return json.loads(r.read().decode()).get("response", "").strip()

    try:
        text = (generate or _default_generate)(body)
        if not text:
            return {"ok": False, "model": OLLAMA_MODEL, "text": tmpl, "source": "template", "context": context}
        return {"ok": True, "model": OLLAMA_MODEL, "text": text, "source": "ollama", "context": context}
    except urllib.error.URLError:
        return {"ok": False, "model": OLLAMA_MODEL, "text": tmpl, "source": "template", "context": context}
    except Exception:
        return {"ok": False, "model": OLLAMA_MODEL, "text": tmpl, "source": "template", "context": context}
