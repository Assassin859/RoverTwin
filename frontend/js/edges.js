// Shared coupling stories: plain language + the equation behind each edge.
export const EDGE_STORY = {
  "EPS>TCS": "The damaged battery is heating itself, and the heat spreads into the electronics box.",
  "TCS>EPS": "The temperature is now working against the battery.",
  "TCS>GNC": "Heat makes the motion sensor drift, so the rover is less sure which way it points.",
  "TCS>COMMS": "Hot radio electronics lose power, so the signal to Earth weakens.",
  "TCS>MOB": "It is too hot to drive at full speed, so the rover slows down to protect itself.",
  "EPS>GNC": "Battery voltage is sagging, so the sensors get noisy.",
  "EPS>COMMS": "Low battery voltage weakens the radio.",
  "EPS>MOB": "The battery is low, so the rover drives slower.",
  "GNC>COMMS": "Unsure of its direction, the antenna misses the orbiter and the signal fades.",
  "GNC>EPS": "The computer works harder to figure out where it is, and burns extra power.",
  "GNC>MOB": "Not knowing which way it points, the rover stops driving to stay safe.",
  "COMMS>EPS": "With no signal, the radio keeps searching at full power and drains the battery.",
  "COMMS>DATA": "Science data can't be sent home, so the onboard memory fills up.",
  "MOB>EPS": "Driving burns battery power through the motors.",
};

export const EDGE_EQ = {
  "EPS>TCS": "Q_bat = I²R + P_leak → heats T_bat, then T_av via G_ab",
  "TCS>EPS": "Heaters + hot-cell ageing tax the battery",
  "TCS>GNC": "b_gyro += 0.0025·max(0, T_av−45) °/s",
  "TCS>COMMS": "L_temp = 0.2·max(0, T_av−45) dB",
  "TCS>MOB": "Speed limited when T_av is high",
  "EPS>GNC": "Brownout raises sensor noise floor",
  "EPS>COMMS": "L_brownout(V_bus) in the link budget",
  "EPS>MOB": "Speed limited when SOC is low",
  "GNC>COMMS": "L_point = 12·(θ/10°)² on the HGA",
  "GNC>EPS": "Visual-odometry fallback ≤ +16 W compute",
  "GNC>MOB": "Drive halt when attitude error > 10°",
  "COMMS>EPS": "Signal search draws +14 W",
  "COMMS>DATA": "Buffer fills while downlink is down",
  "MOB>EPS": "P_mob = f(speed, terrain)",
};

export function edgeTooltip(key, liveLabel = "") {
  const story = EDGE_STORY[key] || "";
  const eq = EDGE_EQ[key] || "";
  const bits = [liveLabel, story, eq && `Equation: ${eq}`].filter(Boolean);
  return bits.join("\n");
}
