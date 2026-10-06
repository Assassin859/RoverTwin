"""Command validation must reject bad values without freezing the sim."""
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.mission import Mission
from backend.model import validate_command


@pytest.mark.parametrize(
    "name,value",
    [
        ("speed", "fast"),
        ("speed", -0.5),
        ("speed", 2.0),
        ("mode", "ZOOM"),
        ("imu", "C"),
        ("trx", "Z"),
        ("antenna", "DISH"),
        ("pose", "UPSIDE_DOWN"),
        ("nope", True),
    ],
)
def test_validate_command_rejects_bad_values(name, value):
    with pytest.raises(ValueError):
        validate_command(name, value)


@pytest.mark.parametrize(
    "name,value,expected",
    [
        ("speed", 0.5, 0.5),
        ("speed", "0.25", 0.25),
        ("imu", "B", "B"),
        ("drive", "true", True),
        ("payload", 0, False),
        ("mode", "SAFE", "SAFE"),
        ("pose", "SUN", "SUN"),
    ],
)
def test_validate_command_accepts_good_values(name, value, expected):
    n, v = validate_command(name, value)
    assert n == name
    assert v == expected


def test_bad_command_does_not_freeze_mission():
    m = Mission(seed=1)
    m.advance(30)
    t0 = m.t
    with pytest.raises(ValueError):
        m.command("speed", "fast")
    m.advance(60)
    assert m.t > t0 + 50
    m.command("imu", "B")
    assert m.commands[-1]["name"] == "imu"


def test_rest_bad_command_returns_400():
    with TestClient(app) as client:
        r = client.post("/api/commands", json={"name": "speed", "value": "fast"})
        assert r.status_code == 400
        r2 = client.post("/api/commands", json={"name": "imu", "value": "C"})
        assert r2.status_code == 400
        r3 = client.post("/api/commands", json={"name": "imu", "value": "B"})
        assert r3.status_code == 200
