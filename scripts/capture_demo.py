"""Drive a battery-fault demo via REST and print timing cues for stills / GIF.

Usage (server must already be running)::

    python scripts/capture_demo.py --base http://127.0.0.1:8765

Stills expected under docs/assets/ (captured from the console UI):
  01-inject.png, 02-cascade.png, 03-forecast.png, 04-recovery.png

Then::

    python scripts/make_gif.py
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def api(base: str, method: str, path: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def wait_until(base: str, predicate, timeout=120.0, label="condition"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        snap = api(base, "GET", "/api/state")
        if predicate(snap):
            return snap
        time.sleep(0.4)
    raise TimeoutError(f"timed out waiting for {label}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8765")
    args = p.parse_args()
    base = args.base
    try:
        api(base, "GET", "/api/faults")
    except urllib.error.URLError as e:
        print(f"Server not reachable at {base}: {e}", file=sys.stderr)
        sys.exit(1)

    print("reset…")
    api(base, "POST", "/api/reset")
    api(base, "POST", "/api/sim", {"speed": 120, "paused": False})
    time.sleep(2)
    print("STILL 01-inject — inject battery 0.85")
    api(base, "POST", "/api/faults", {"kind": "battery", "severity": 0.85, "ramp_s": 60})

    print("wait for diagnosis…")
    snap = wait_until(base, lambda s: any(f.get("sub") == "EPS" for f in s.get("findings", [])), 90, "EPS finding")
    print(f"  findings={[f['text'][:40] for f in snap['findings']]}")
    print("STILL 02-cascade — EPS→TCS edge lit, root cause")

    print("wait for prediction critical…")
    def has_crit(_):
        try:
            pred = api(base, "GET", "/api/prediction")
            return pred and pred.get("first_critical")
        except Exception:
            return False
    wait_until(base, has_crit, 120, "first_critical")
    pred = api(base, "GET", "/api/prediction")
    print(f"  first_critical={pred['first_critical']}")
    print(f"  recommended={pred.get('recommended')}")
    print("STILL 03-forecast — predicted impact + plan ranking")

    plan = pred.get("recommended") or "isolate"
    print(f"execute plan {plan}…")
    api(base, "POST", f"/api/plans/{plan}")
    time.sleep(4)
    snap = api(base, "GET", "/api/state")
    print(f"  bat_isolated={snap['twin']['cfg'].get('bat_isolated')}")
    print("STILL 04-recovery — isolation confirmed, forecast green")
    print("Done. Capture the four stills from the browser, then run scripts/make_gif.py")


if __name__ == "__main__":
    main()
