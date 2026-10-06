"""Cause→effect correlations from live coupling strengths and root findings."""
from __future__ import annotations

from collections import defaultdict, deque

SUBS = ("EPS", "TCS", "GNC", "COMMS", "MOB", "DATA")
EDGE_THR = 0.08
PATH_DEPTH = 3

# Short labels for multi-hop path summaries (mirrors frontend EDGE_STORY intent)
EDGE_SHORT = {
    "EPS>TCS": "battery heat",
    "TCS>EPS": "thermal load on power",
    "TCS>GNC": "gyro / wheel friction from heat",
    "TCS>COMMS": "radio thermal derate",
    "TCS>MOB": "thermal payload inhibit",
    "EPS>GNC": "brownout wheel torque cap",
    "EPS>COMMS": "low-bus radio loss",
    "EPS>MOB": "SOC payload shed",
    "GNC>COMMS": "antenna mispointing",
    "GNC>EPS": "ADCS compute power",
    "GNC>MOB": "pointing kills imaging",
    "COMMS>EPS": "signal-search power",
    "COMMS>DATA": "OBDH buffer fill",
    "MOB>EPS": "payload power",
}


def _graph(couplings: dict, thr: float = EDGE_THR) -> dict[str, list[tuple[str, float, str, str]]]:
    """adj[src] = [(dst, strength, edge_key, live_label), ...]"""
    adj: dict[str, list[tuple[str, float, str, str]]] = defaultdict(list)
    for key, val in (couplings or {}).items():
        if ">" not in key:
            continue
        s = float(val[0]) if isinstance(val, (list, tuple)) else float(val)
        label = val[1] if isinstance(val, (list, tuple)) and len(val) > 1 else EDGE_SHORT.get(key, key)
        if s < thr:
            continue
        a, b = key.split(">", 1)
        adj[a].append((b, s, key, label))
    return adj


def matrix_of(couplings: dict) -> dict[str, dict[str, float]]:
    m = {a: {b: 0.0 for b in SUBS} for a in SUBS}
    for key, val in (couplings or {}).items():
        if ">" not in key:
            continue
        a, b = key.split(">", 1)
        if a in m and b in m[a]:
            s = float(val[0]) if isinstance(val, (list, tuple)) else float(val)
            m[a][b] = round(s, 3)
    return m


def paths_from_roots(couplings: dict, findings: list[dict], depth: int = PATH_DEPTH) -> list[dict]:
    """BFS multi-hop paths from each uncontained root finding subsystem."""
    roots = []
    seen_root = set()
    for f in findings or []:
        if f.get("contained"):
            continue
        sub = f.get("sub")
        if not sub or sub in seen_root:
            continue
        seen_root.add(sub)
        roots.append(f)

    adj = _graph(couplings)
    out: list[dict] = []
    for f in roots:
        root = f["sub"]
        # state: (node, path_nodes, edge_keys, labels, min_strength)
        q = deque([(root, [root], [], [], 1.0)])
        visited_edges: set[str] = set()
        while q:
            node, nodes, edges, labels, strength = q.popleft()
            if len(edges) >= depth:
                continue
            for dst, s, key, label in adj.get(node, []):
                if key in visited_edges and dst in nodes:
                    continue
                # allow diamond but avoid cycles on nodes
                if dst in nodes:
                    continue
                ns = min(strength, s)
                n_nodes = nodes + [dst]
                n_edges = edges + [key]
                n_labels = labels + [label]
                visited_edges.add(key)
                via = n_nodes[1:-1]
                # Prefer live coupling labels; fall back to EDGE_SHORT
                path_label = " → ".join(n_labels) if n_labels else " → ".join(
                    EDGE_SHORT.get(e, e) for e in n_edges
                )
                out.append({
                    "from": root,
                    "to": dst,
                    "via": via,
                    "edges": n_edges,
                    "strength": round(ns, 3),
                    "label": path_label,
                    "finding_id": f.get("id", ""),
                    "finding": f.get("text", ""),
                })
                q.append((dst, n_nodes, n_edges, n_labels, ns))

    # strongest first; on ties prefer longer multi-hop paths (judge demo)
    best: dict[tuple, dict] = {}
    for p in out:
        k = (p["from"], p["to"], tuple(p["edges"]))
        if k not in best or p["strength"] > best[k]["strength"]:
            best[k] = p
    ranked = sorted(best.values(), key=lambda p: (-p["strength"], -len(p["edges"]), p["to"]))
    return ranked[:24]


def active_edges(paths: list[dict]) -> list[str]:
    seen: list[str] = []
    for p in paths:
        for e in p.get("edges", []):
            if e not in seen:
                seen.append(e)
    return seen


def correlations(couplings: dict, findings: list[dict]) -> dict:
    paths = paths_from_roots(couplings, findings)
    return {
        "matrix": matrix_of(couplings),
        "paths": paths,
        "active": active_edges(paths),
    }


def knock_on_cause(sub: str, couplings: dict, roots: set[str]) -> str:
    """Prefer a multi-hop explanation from a root when available."""
    if sub in roots:
        return ""
    paths = paths_from_roots(couplings, [{"id": "", "sub": r, "text": "", "contained": ""} for r in roots])
    hitting = [p for p in paths if p["to"] == sub]
    if hitting:
        p = hitting[0]
        hops = " → ".join([p["from"], *p["via"], p["to"]])
        return f"knock-on via {hops}: {p['label']}"
    best = max(
        ((float(v[0]) if isinstance(v, (list, tuple)) else float(v), k,
          v[1] if isinstance(v, (list, tuple)) and len(v) > 1 else "")
         for k, v in (couplings or {}).items() if k.endswith(">" + sub)),
        default=None,
    )
    if best and best[0] > 0.1:
        return f"knock-on from {best[1].split('>')[0]}: {best[2]}"
    return ""
