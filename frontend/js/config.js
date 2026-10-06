/** Resolve API + WebSocket URLs for live twin (same-origin, ?backend=, or localStorage). */
const LS_KEY = "sattwinBackend";

function stripSlash(u) {
  return String(u || "").replace(/\/+$/, "");
}

/** @returns {{ apiBase: string, wsUrl: string, raw: string, explicit: boolean, isStaticHost: boolean }} */
export function resolveBackend() {
  const params = new URLSearchParams(location.search);
  const q = (params.get("backend") || "").trim();
  let stored = "";
  try { stored = (localStorage.getItem(LS_KEY) || "").trim(); } catch { /* private mode */ }
  const raw = q || stored;
  const host = location.hostname || "";
  const isStaticHost = /\.vercel\.app$/i.test(host) || host === "rovertwin.vercel.app";

  if (!raw) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return {
      apiBase: "",
      wsUrl: `${proto}://${location.host}/ws`,
      raw: "",
      explicit: false,
      isStaticHost,
    };
  }

  let s = raw;
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return { apiBase: "", wsUrl: `${proto}://${location.host}/ws`, raw, explicit: true, isStaticHost };
  }

  let httpProto = u.protocol;
  if (httpProto === "ws:") httpProto = "http:";
  if (httpProto === "wss:") httpProto = "https:";
  const apiBase = stripSlash(`${httpProto}//${u.host}${u.pathname === "/" ? "" : u.pathname}`);
  const wsProto = httpProto === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProto}://${u.host}/ws`;

  if (q) {
    try { localStorage.setItem(LS_KEY, raw); } catch { /* ignore */ }
  }

  return { apiBase, wsUrl, raw, explicit: true, isStaticHost };
}

export function apiUrl(path, cfg = resolveBackend()) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return cfg.apiBase ? `${cfg.apiBase}${p}` : p;
}

export const CFG = resolveBackend();
