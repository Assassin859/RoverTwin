/** Offline recorded-mission player when live WebSocket is unreachable. */

const REPLAY_URL = "assets/demo-replay.json.gz";

async function inflateGzip(buf) {
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const stream = new Response(buf).body.pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }
  throw new Error("gzip DecompressionStream unavailable");
}

export async function loadReplay(url = REPLAY_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`replay fetch ${res.status}`);
  const gz = await res.arrayBuffer();
  const raw = await inflateGzip(gz);
  const text = new TextDecoder().decode(raw);
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.messages)) throw new Error("replay missing messages");
  return data;
}

/**
 * Play timed hello/snap/pred messages through dispatch(msg).
 * @returns {{ stop: () => void }}
 */
export function playReplay(data, dispatch, { onDone } = {}) {
  const msgs = data.messages || [];
  const timers = [];
  let i = 0;
  const t0 = performance.now();
  const wall0 = msgs[0]?.t_wall ?? 0;

  function scheduleNext() {
    if (i >= msgs.length) {
      onDone?.();
      return;
    }
    const m = msgs[i++];
    const delay = Math.max(0, ((m.t_wall ?? 0) - wall0) * 1000 - (performance.now() - t0));
    const id = setTimeout(() => {
      dispatch(m.msg);
      scheduleNext();
    }, Math.min(delay, 60000));
    timers.push(id);
  }
  scheduleNext();
  return {
    stop() {
      for (const id of timers) clearTimeout(id);
      timers.length = 0;
    },
  };
}
