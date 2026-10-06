// Shared coupling stories: plain language + the equation behind each edge.
export const EDGE_STORY = {
  "EPS>TCS": "The damaged battery is heating itself, and the heat spreads into the avionics box.",
  "TCS>EPS": "The temperature is now working against the battery.",
  "TCS>GNC": "Heat raises gyro drift and wheel friction, so ADCS pointing gets worse.",
  "TCS>COMMS": "Hot radio electronics lose power, so the signal to the ground station weakens.",
  "TCS>MOB": "It is too hot to keep imaging, so the payload duty is cut.",
  "EPS>GNC": "Bus voltage is sagging, so reaction-wheel torque is capped.",
  "EPS>COMMS": "Low bus voltage weakens the radio.",
  "EPS>MOB": "The battery is low, so the spacecraft sheds payload imaging.",
  "GNC>COMMS": "Unsure of its attitude, the antenna mispoints and the pass fades.",
  "GNC>EPS": "ADCS works harder to recover pointing and burns extra power.",
  "GNC>MOB": "Poor pointing kills imaging quality, so the payload is inhibited.",
  "COMMS>EPS": "Off-pass, the radio may search at full power and drain the battery.",
  "COMMS>DATA": "Science cannot downlink until the next pass, so the OBDH buffer fills.",
  "MOB>EPS": "Imaging and wheels draw battery power.",
};

export const EDGE_EQ = {
  "EPS>TCS": "Q_bat = I²R + P_leak → heats T_bat, then T_av via G_ab",
  "TCS>EPS": "Heaters + hot-cell ageing tax the battery",
  "TCS>GNC": "b_gyro += 0.0025·max(0, T_av−45) °/s; wheel fric↑",
  "TCS>COMMS": "L_temp = 0.2·max(0, T_av−45) dB",
  "TCS>MOB": "Imaging duty limited when T_av is high",
  "EPS>GNC": "Brownout × wheel saturation caps torque",
  "EPS>COMMS": "L_brownout(V_bus) in the link budget",
  "EPS>MOB": "Payload shed when SOC is low",
  "GNC>COMMS": "L_point = 12·(θ/beam)² on the HGA",
  "GNC>EPS": "ADCS compute ≤ +14 W when pointing is bad",
  "GNC>MOB": "Imaging inhibit when attitude error > 8°",
  "COMMS>EPS": "Search power when no lock past timer",
  "COMMS>DATA": "Buffer fill while off-pass / link down",
  "MOB>EPS": "P_payload + P_wheels on the bus",
};

/** Short on-graph chip (<= ~14 chars): live value only. Full equation stays in tooltip + Evidence table. */
const N = "([-\u2212]?\\d+(?:\\.\\d+)?)";
const grab = (v, pre, post) => {
  const m = new RegExp(pre + N + post).exec(v);
  return m ? m[1] : null;
};
const CHIP_FMT = {
  "EPS>TCS": (v) => { const n = grab(v, "", "\\s*W"); return n ? `heat ${n.replace(/^[-\u2212]/, "")} W` : "heat"; },
  "TCS>EPS": (v) => {
    const n = grab(v, "heaters\\s*", "\\s*W");
    if (n) return `heat ${n} W`;
    const t = grab(v, "at\\s*", "");
    return t ? `bat ${t}\u00b0C` : "tax";
  },
  "TCS>GNC": (v) => { const n = grab(v, "drift\\s*", ""); return n ? `drift ${n}\u00b0/s` : "drift"; },
  "TCS>COMMS": (v) => { const n = grab(v, "", "\\s*dB"); return n ? `${n} dB` : "derate"; },
  "TCS>MOB": () => "inhibit",
  "EPS>GNC": (v) => { const n = grab(v, "bus\\s*", ""); return n ? `bus ${n} V` : "bus"; },
  "EPS>COMMS": (v) => { const n = grab(v, "", "\\s*dB"); return n ? `${n} dB` : "bus dB"; },
  "EPS>MOB": (v) => { const n = grab(v, "SOC\\s*", ""); return n ? `shed ${n}%` : "shed"; },
  "GNC>COMMS": (v) => { const n = grab(v, "", "\\s*dB"); return n ? `${n} dB` : "point"; },
  "GNC>EPS": (v) => { const n = grab(v, "", "\\s*W"); return n ? `+${n.replace(/^[-\u2212]/, "")} W` : "+W"; },
  "GNC>MOB": (v) => { const n = grab(v, "pointing\\s*", ""); return n ? `point ${n}\u00b0` : "point"; },
  "COMMS>EPS": (v) => { const n = grab(v, "", "\\s*W"); return n ? `+${n.replace(/^[-\u2212]/, "")} W` : "search"; },
  "COMMS>DATA": (v) => { const n = grab(v, "", "%"); return n ? `buf ${n}%` : "buffer"; },
  "MOB>EPS": (v) => { const n = grab(v, "", "\\s*W"); return n ? `load ${n.replace(/^[-\u2212]/, "")} W` : "load"; },
};

export function edgeChip(key, live) {
  const v = String(live || "").trim();
  const f = CHIP_FMT[key];
  const out = f ? f(v) : (v ? v.slice(0, 14) : key.split(">")[0]);
  return out.length > 16 ? `${out.slice(0, 15)}\u2026` : out;
}

/** Short on-graph label: chip text (full eq only in tooltip). */
export function edgeLabel(key, live) {
  return edgeChip(key, live);
}

/** Full tooltip: story + equation + live value. */
export function edgeTooltip(key, live) {
  const parts = [];
  if (EDGE_STORY[key]) parts.push(EDGE_STORY[key]);
  if (EDGE_EQ[key]) parts.push(`Eq: ${EDGE_EQ[key]}`);
  if (live) parts.push(`Live: ${live}`);
  return parts.join("\n") || key;
}
