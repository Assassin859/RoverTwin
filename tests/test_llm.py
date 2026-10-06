"""Ollama explainer unit tests (mocked — no live Ollama required)."""
from backend import llm


def test_build_context_from_snap():
    snap = {
        "findings": [{"id": "bat_leak", "sub": "EPS", "text": "internal short", "contained": ""}],
        "correlations": {
            "paths": [{"from": "EPS", "to": "TCS", "via": [], "edges": ["EPS>TCS"],
                       "strength": 0.7, "label": "battery heat"}],
            "active": ["EPS>TCS"],
        },
    }
    pred = {"first_critical": {"key": "t_bat", "text": "battery hot", "t": 600},
            "recommended": "isolate_bat",
            "plans": [{"id": "isolate_bat", "name": "Isolate string 2"}]}
    ctx = llm.build_context(snap, pred)
    assert ctx["findings"][0]["id"] == "bat_leak"
    assert ctx["paths"][0]["edges"] == ["EPS>TCS"]
    assert ctx["recommended"] == "isolate_bat"
    assert ctx["recommended_name"] == "Isolate string 2"


def test_explain_uses_injected_generate():
    ctx = {"findings": [], "paths": [], "active_edges": []}
    out = llm.explain(ctx, generate=lambda _payload: "Twin is nominal. No active fault paths.")
    assert out["ok"] is True
    assert "nominal" in out["text"].lower()
    assert out["model"] == llm.OLLAMA_MODEL


def test_explain_empty_generate_fails_gracefully():
    out = llm.explain({"findings": []}, generate=lambda _p: "")
    assert out["ok"] is False
    assert "Empty" in out["text"]
