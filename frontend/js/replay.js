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
 * Supports pause / resume / loop and wall-clock scaling.
 * @returns {{ stop: () => void, pause: () => void, resume: () => void, setLoop: (v: boolean) => void, paused: boolean }}
 */
export function playReplay(data, dispatch, { onDone, onLoop, loop = true } = {}) {
  const msgs = data.messages || [];
  let i = 0;
  let timer = null;
  let paused = false;
  let looping = loop;
  let pauseAccum = 0;
  let pauseAt = 0;
  let t0 = performance.now();
  const wall0 = msgs[0]?.t_wall ?? 0;
  let stopped = false;

  function clear() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function wallElapsed() {
    const now = performance.now();
    if (paused) return pauseAt - t0 - pauseAccum;
    return now - t0 - pauseAccum;
  }

  function scheduleNext() {
    clear();
    if (stopped || paused) return;
    if (i >= msgs.length) {
      if (looping) {
        i = 0;
        t0 = performance.now();
        pauseAccum = 0;
        onLoop?.();
        scheduleNext();
        return;
      }
      onDone?.();
      return;
    }
    const m = msgs[i];
    const target = ((m.t_wall ?? 0) - wall0) * 1000;
    const delay = Math.max(0, Math.min(target - wallElapsed(), 60000));
    timer = setTimeout(() => {
      timer = null;
      if (stopped || paused) return;
      i += 1;
      dispatch(m.msg);
      scheduleNext();
    }, delay);
  }

  scheduleNext();
  return {
    get paused() {
      return paused;
    },
    stop() {
      stopped = true;
      clear();
    },
    pause() {
      if (paused || stopped) return;
      paused = true;
      pauseAt = performance.now();
      clear();
    },
    resume() {
      if (!paused || stopped) return;
      pauseAccum += performance.now() - pauseAt;
      paused = false;
      scheduleNext();
    },
    setLoop(v) {
      looping = !!v;
    },
  };
}
