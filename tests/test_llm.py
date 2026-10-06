"""Ollama explainer unit tests (mocked — no live Ollama required)."""
from backend import llm


def test_build_context_from_snap():
    snap = {
        "findings": [{"id": "bat_leak", "sub": "EPS", "text": "internal short", "contained": ""}],
        "correlations": {
            "paths": [
                {"from": "EPS", "to": "TCS", "via": [], "edges": ["EPS>TCS"],
                 "strength": 0.9, "label": "battery heat"},
                {"from": "EPS", "to": "GNC", "via": ["TCS"], "edges": ["EPS>TCS", "TCS>GNC"],
                 "strength": 0.5, "label": "heat → gyro"},
            ],
            "active": ["EPS>TCS", "TCS>GNC"],
        },
    }
    pred = {"first_critical": {"key": "t_bat", "text": "battery hot", "t": 600},
            "recommended": "isolate_bat",
            "plans": [{"id": "isolate_bat", "name": "Isolate string 2"}]}
    ctx = llm.build_context(snap, pred)
    assert ctx["top_finding"]["id"] == "bat_leak"
    assert ctx["paths"][0]["edges"] == ["EPS>TCS", "TCS>GNC"]  # longest first
    assert len(ctx["paths"]) <= 3
    assert ctx["recommended_name"] == "Isolate string 2"
    assert "key" not in (ctx["first_critical"] or {})


def test_template_note_nominal():
    text = llm.template_note({"findings": [], "paths": []})
    assert "nominal" in text.lower()


def test_template_note_cascade():
    ctx = {
        "findings": [{"id": "bat_leak", "sub": "EPS", "text": "internal short ~56 W"}],
        "top_finding": {"id": "bat_leak", "sub": "EPS", "text": "internal short ~56 W"},
        "paths": [{"from": "EPS", "to": "GNC", "via": ["TCS"], "edges": ["EPS>TCS", "TCS>GNC"],
                   "strength": 0.6, "label": "heat → gyro"}],
        "first_critical": {"text": "battery above 50°C", "t": 900},
        "recommended_name": "Isolate string 2",
    }
    text = llm.template_note(ctx)
    assert "EPS" in text and "TCS" in text
    assert "EPS>TCS" in text
    assert "Isolate string 2" in text
    assert "template" in text.lower()


def test_explain_uses_injected_generate():
    ctx = {"findings": [], "paths": [], "active_edges": []}
    out = llm.explain(ctx, generate=lambda _payload: "Twin is nominal. No active fault paths.")
    assert out["ok"] is True
    assert out["source"] == "ollama"
    assert "nominal" in out["text"].lower()


def test_explain_empty_generate_falls_back_to_template():
    out = llm.explain({"findings": [], "paths": []}, generate=lambda _p: "")
    assert out["ok"] is False
    assert out["source"] == "template"
    assert "nominal" in out["text"].lower()
