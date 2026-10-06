"""Optional local Ollama explainer — narrates twin facts only (qwen2.5:3b)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")

SYSTEM = (
    "You are a spacecraft operations assistant for RoverTwin, a lunar rover + relay-orbiter "
    "digital twin (satellite-ops style EPS/TCS/GNC/COMMS). "
    "Use ONLY the JSON facts provided. Do not invent numbers, faults, or recoveries. "
    "Explain cause→effect chains using the named edges/paths. "
    "Write 4–6 short sentences for a judge demo. If findings are empty, say the twin is nominal."
)


def status() -> dict:
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=2.0) as r:
            data = json.loads(r.read().decode())
        names = [m.get("name", "") for m in data.get("models", [])]
        has = any(OLLAMA_MODEL == n or n.startswith(OLLAMA_MODEL + ":") or OLLAMA_MODEL in n for n in names)
        return {"ok": True, "host": OLLAMA_HOST, "model": OLLAMA_MODEL, "model_ready": has, "models": names[:12]}
    except Exception as e:
        return {"ok": False, "host": OLLAMA_HOST, "model": OLLAMA_MODEL, "model_ready": False, "error": str(e)}


def build_context(snap: dict, pred: dict | None) -> dict:
    corr = snap.get("correlations") or {}
    return {
        "findings": [
            {"id": f.get("id"), "sub": f.get("sub"), "text": f.get("text"),
             "contained": bool(f.get("contained"))}
            for f in (snap.get("findings") or [])[:8]
        ],
        "paths": [
            {"from": p["from"], "to": p["to"], "via": p.get("via"), "edges": p.get("edges"),
             "strength": p.get("strength"), "label": p.get("label")}
            for p in (corr.get("paths") or [])[:8]
        ],
        "active_edges": (corr.get("active") or [])[:14],
        "first_critical": (pred or {}).get("first_critical"),
        "recommended": (pred or {}).get("recommended"),
        "recommended_name": next(
            (pl.get("name") for pl in ((pred or {}).get("plans") or []) if pl.get("id") == (pred or {}).get("recommended")),
            None,
        ),
    }


def explain(context: dict, generate=None) -> dict:
    """Call Ollama /api/generate. `generate` is injectable for tests."""
    st = status() if generate is None else {"ok": True, "model_ready": True}
    if generate is None and (not st.get("ok") or not st.get("model_ready")):
        why = "Ollama offline" if not st.get("ok") else f"model {OLLAMA_MODEL} not pulled"
        return {"ok": False, "model": OLLAMA_MODEL, "text": f"{why} — twin correlations still show in the cascade and table.", "context": context}

    prompt = (
        SYSTEM
        + "\n\nFACTS (JSON):\n"
        + json.dumps(context, ensure_ascii=False)
        + "\n\nExplain the cause→effect cascade for the operator:"
    )
    body = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 180},
    }

    def _default_generate(payload: dict) -> str:
        req = urllib.request.Request(
            f"{OLLAMA_HOST}/api/generate",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60.0) as r:
            return json.loads(r.read().decode()).get("response", "").strip()

    try:
        text = (generate or _default_generate)(body)
        if not text:
            return {"ok": False, "model": OLLAMA_MODEL, "text": "Empty response from Ollama.", "context": context}
        return {"ok": True, "model": OLLAMA_MODEL, "text": text, "context": context}
    except urllib.error.URLError as e:
        return {"ok": False, "model": OLLAMA_MODEL, "text": f"Ollama unreachable: {e}", "context": context}
    except Exception as e:
        return {"ok": False, "model": OLLAMA_MODEL, "text": f"Ollama error: {e}", "context": context}
