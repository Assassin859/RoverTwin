"""Coupled subsystem model of a LEO Earth-observation smallsat.

The *same* equations run in two places:

* ``plant.py`` - the simulated "real" spacecraft, driven by the true (hidden)
  health parameters plus process noise. It only talks to the ground through
  telemetry during ground-station passes.
* ``twin.py``  - the digital twin, driven by *estimated* health parameters that
  are continuously re-fitted from the telemetry stream.

Subsystem keys (stable wire IDs; UI labels map GNC→ADCS, MOB→PAYLOAD, DATA→OBDH):

    EPS   battery + solar array + loads. Battery I^2R and internal-short heat
          feed the thermal model; bus voltage feeds ADCS wheels and the radio.
    TCS   two-node lumped thermal model (avionics + battery) radiating to space.
    GNC   ADCS: IMU + sun sensor + reaction wheels. Attitude error drives
          antenna pointing loss and payload imaging quality.
    COMMS S-band to the ground station — only during AOS/LOS pass windows.
    MOB   PAYLOAD: imaging duty / load, limited by SOC, temperature and pointing.
    DATA  OBDH: science buffer filled by the payload and drained on downlink.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field

SIGMA = 5.670374419e-8
K0 = 273.15

SUBSYSTEMS = ("EPS", "TCS", "GNC", "COMMS", "MOB", "DATA")

LIMITS = {
    "soc_min": 0.15,
    "t_av_max": 70.0,
    "t_bat_max": 50.0,
    "t_av_min": -20.0,
    "t_bat_min": 0.0,
}


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def fmt_db(x: float) -> str:
    """Sign-aware dB label — preserves minus for negative margins."""
    v = float(x)
    if abs(v) < 0.05:
        return "0.0 dB"
    sign = "−" if v < 0 else ""
    return f"{sign}{abs(v):.1f} dB"


@dataclass(frozen=True)
class Params:
    # EPS
    bat_capacity_wh: float = 480.0
    bat_r0: float = 0.06
    solar_peak_w: float = 220.0
    charge_eff: float = 0.96
    # loads [W]
    p_avionics: float = 28.0
    p_compute: float = 8.0
    p_compute_vo: float = 14.0
    p_sensors: float = 10.0
    p_sensors_safe: float = 6.0
    p_mobility_nom: float = 35.0
    p_payload: float = 32.0
    p_comm_hga: float = 28.0
    p_comm_lga: float = 18.0
    p_comm_search: float = 40.0
    p_heater_av: float = 22.0
    p_heater_bat: float = 15.0
    # TCS
    c_av: float = 3200.0
    c_bat: float = 4000.0
    rad_eps_area: float = 0.42
    g_ab: float = 2.4  # battery→avionics conduction (stronger for TCS WARN on bat heat)
    g_bat_env: float = 0.15
    q_sun_body: float = 28.0
    t_sink_sun: float = 255.0
    t_sink_shade: float = 220.0
    # GNC / ADCS
    att_floor: float = 0.20
    att_tau: float = 120.0
    gyro_bias_per_c: float = 0.0025
    wheel_cap_rpm: float = 6000.0
    # MOB / viz
    v_nom: float = 0.10
    loop_radius: float = 45.0
    # COMMS / orbit
    m0_db: float = 12.0
    hga_beam_deg: float = 8.0
    lga_gain_db: float = -18.0
    rate_max_kbps: float = 512.0
    rate_min_kbps: float = 2.0
    uplink_min_kbps: float = 1.0
    trx_b_loss_db: float = 2.5
    uplink_bonus_db: float = 8.0
    relay_hp_db: float = 5.0
    relay_period_s: float = 5700.0
    orbit_period_s: float = 5700.0
    eclipse_frac: float = 0.35
    gs_pass_frac: float = 0.14  # longer AOS window when contact orbit hits
    gs_pass_phase: float = 0.15
    # Pass every Nth orbit (~4–6 contacts/day for ~15–16 orbits/day LEO)
    gs_pass_every_n_orbits: int = 3
    # Ground station (ISRO Bengaluru) — used by validate / schedule docs
    gs_lat_deg: float = 13.0
    gs_lon_deg: float = 77.5
    gs_mask_deg: float = 8.0  # 5–10° elevation mask
    # Orbit beta angle (sun–orbit plane); eclipse analytic uses this
    beta_deg: float = 25.0
    # DATA / OBDH — sized so nominal off-pass fill stays under ~80%
    buffer_cap_mb: float = 96.0
    science_mb_s: float = 0.008
    hk_mb_s: float = 0.0004
    # FDIR
    soc_auto_safe: float = 0.18
    soc_dead: float = 0.03
    soc_revive: float = 0.08
    t_av_auto_safe: float = 72.0
    t_bat_auto_safe: float = 55.0
    att_stop_deg: float = 8.0
    search_after_s: float = 400.0
    comm_loss_timer_s: float = 500.0
    wheel_dump_rpm: float = 5500.0
    uv_bus_v: float = 25.5  # undervoltage load-shed threshold
    silence_aos_s: float = 20.0  # wait after AOS before blaming TRX


@dataclass
class Health:
    bat_capacity_frac: float = 1.0
    bat_r_mult: float = 1.0
    bat_leak_w: float = 0.0
    rad_eff: float = 1.0
    imu_a_bias: float = 0.0
    trx_a_loss_db: float = 0.0
    wheel_fric_mult: float = 1.0


@dataclass
class Config:
    mode: str = "NOMINAL"
    drive: bool = True
    speed_frac: float = 1.0
    payload: bool = True
    imu: str = "A"
    trx: str = "A"
    antenna: str = "HGA"
    bat_isolated: bool = False
    pose: str = "NORMAL"
    relay_hp: bool = False


@dataclass
class State:
    t: float = 0.0
    soc: float = 0.80
    t_av: float = 22.0
    t_bat: float = 18.0
    att_err: float = 0.25
    nav_err: float = 0.0
    buffer_mb: float = 2.0
    odometer: float = 0.0
    x: float = 0.0
    z: float = 0.0
    heading: float = 0.0
    shade: float = 0.0
    v_bus: float = 27.5
    no_contact_s: float = 0.0
    no_lock_s: float = 0.0
    auto_safe: str = ""
    dead: bool = False
    science_mb: float = 0.0
    data_lost_mb: float = 0.0
    wheel_rpm: float = 800.0
    cfg: Config = field(default_factory=Config)

    def clone(self) -> "State":
        s = copy.copy(self)
        s.cfg = copy.copy(self.cfg)
        return s


# ---------------------------------------------------------------- environment
def orbit_state(t: float, p: Params | None = None) -> dict:
    """LEO orbit clock: sunlit/eclipse and ground-station AOS/LOS.

    Passes occur every ``gs_pass_every_n_orbits`` orbits (Bengaluru-style sparse
    contacts). ``beta_deg`` modulates the analytic eclipse fraction.
    """
    p = p or Params()
    period = p.orbit_period_s
    phase = (t % period) / period
    angle = 2.0 * math.pi * phase
    ecl = p.eclipse_frac
    beta_rad = abs(p.beta_deg) * math.pi / 180.0
    ecl_eff = clamp(ecl * (1.0 - 0.15 * math.sin(beta_rad)), 0.15, 0.45)
    in_eclipse = phase < ecl_eff * 0.5 or phase > 1.0 - ecl_eff * 0.5
    sunlit = not in_eclipse
    half = p.gs_pass_frac * 0.5
    centre = p.gs_pass_phase
    d = min(abs(phase - centre), 1.0 - abs(phase - centre))
    orbit_i = int(math.floor(t / period))
    n = max(1, int(p.gs_pass_every_n_orbits))
    pass_orbit = (orbit_i % n) == 0
    gs_pass = pass_orbit and d <= half
    pass_start = (centre - half) % 1.0
    if gs_pass:
        next_pass_s = 0.0
        aos_age_s = ((phase - pass_start) % 1.0) * period
    else:
        k = 0 if (pass_orbit and phase < pass_start) else 1
        while ((orbit_i + k) % n) != 0:
            k += 1
            if k > n + 2:
                break
        next_t = (orbit_i + k) * period + pass_start * period
        next_pass_s = max(0.0, next_t - t)
        aos_age_s = 0.0
    return {
        "angle": angle,
        "phase": phase,
        "sunlit": sunlit,
        "eclipse": in_eclipse,
        "gs_pass": gs_pass,
        "next_pass_s": float(next_pass_s),
        "aos_age_s": float(aos_age_s),
        "beta": p.beta_deg,
        "eclipse_frac_eff": ecl_eff,
    }


def sun_elevation(t: float, p: Params | None = None) -> float:
    st = orbit_state(t, p)
    return math.radians(55.0 if st["sunlit"] else -20.0)


def relay_range_db(t: float, p: Params) -> float:
    st = orbit_state(t, p)
    return 0.0 if st["gs_pass"] else 40.0


def voc(soc: float) -> float:
    return 22.0 + 7.0 * soc - 1.5 * math.exp(-soc / 0.06)


def effective_battery(cfg: Config, h: Health, p: Params) -> tuple[float, float, float]:
    if cfg.bat_isolated:
        return 0.5 * p.bat_capacity_wh, 2.0, 0.0
    return p.bat_capacity_wh * h.bat_capacity_frac, h.bat_r_mult, h.bat_leak_w


def sink_temp(shade: float, p: Params) -> float:
    return p.t_sink_sun + (p.t_sink_shade - p.t_sink_sun) * shade


def thermal_gyro_bias(t_av: float, p: Params) -> float:
    return p.gyro_bias_per_c * max(0.0, t_av - 45.0)


def link_budget(c: Config, att_err: float, t_av: float, v_bus: float, t: float,
                trx_a_loss_db: float, p: Params) -> dict:
    if c.antenna == "HGA":
        gain, point = 0.0, min(80.0, 12.0 * (att_err / p.hga_beam_deg) ** 2)
    else:
        gain, point = p.lga_gain_db, 0.0
    trx = trx_a_loss_db if c.trx == "A" else p.trx_b_loss_db
    temp = 0.2 * max(0.0, t_av - 45.0)
    brown = -10.0 * math.log10(max(clamp((v_bus - (p.uv_bus_v - 4.0)) / 2.5, 0.0, 1.0), 0.01))
    gs = p.relay_hp_db if c.relay_hp else 0.0
    margin = p.m0_db + gain + gs - point - trx - temp - brown
    return {"margin": margin, "point": point, "trx": trx, "temp": temp, "brown": brown}


COMMAND_NAMES = frozenset({
    "mode", "drive", "speed", "payload", "imu", "trx", "antenna",
    "bat_isolated", "pose", "relay_hp",
})
GROUND_COMMANDS = frozenset({"relay_hp"})


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("true", "1", "yes", "on"):
            return True
        if low in ("false", "0", "no", "off"):
            return False
    raise ValueError(f"expected boolean, got {value!r}")


def validate_command(name: str, value) -> tuple[str, object]:
    if name not in COMMAND_NAMES:
        raise ValueError(f"unknown command {name!r}")
    if name == "mode":
        if value not in ("SAFE", "NOMINAL"):
            raise ValueError("mode must be SAFE or NOMINAL")
        return name, value
    if name in ("drive", "payload", "bat_isolated", "relay_hp"):
        return name, _as_bool(value)
    if name == "speed":
        try:
            v = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"speed must be a number 0..1, got {value!r}") from exc
        if not 0.0 <= v <= 1.0:
            raise ValueError(f"speed must be in [0, 1], got {v}")
        return name, v
    if name == "imu":
        if value not in ("A", "B"):
            raise ValueError("imu must be A or B")
        return name, value
    if name == "trx":
        if value not in ("A", "B"):
            raise ValueError("trx must be A or B")
        return name, value
    if name == "antenna":
        if value not in ("HGA", "LGA"):
            raise ValueError("antenna must be HGA or LGA")
        return name, value
    if name == "pose":
        if value not in ("NORMAL", "SUN", "SHADE"):
            raise ValueError("pose must be NORMAL, SUN, or SHADE")
        return name, value
    raise ValueError(f"unknown command {name!r}")


def enter_safe(s: State, reason: str = "") -> None:
    c = s.cfg
    c.mode, c.drive, c.payload = "SAFE", False, False
    if c.pose == "NORMAL":
        c.pose = "SUN"
    s.auto_safe = reason


def apply_command(s: State, name: str, value) -> str:
    name, value = validate_command(name, value)
    c = s.cfg
    if name == "mode":
        if value == "SAFE":
            enter_safe(s, "")
            return "Entered SAFE mode (payload off, sun-pointing)"
        c.mode, c.drive, c.payload, c.pose, c.speed_frac = "NOMINAL", True, True, "NORMAL", 1.0
        s.auto_safe = ""
        return "Resumed NOMINAL operations"
    if name == "drive":
        c.drive = bool(value)
        return "Imaging " + ("enabled" if c.drive else "inhibited")
    if name == "speed":
        c.speed_frac = clamp(float(value), 0.0, 1.0)
        return f"Imaging duty set to {c.speed_frac:.0%}"
    if name == "payload":
        c.payload = bool(value)
        return "Payload " + ("on" if c.payload else "off")
    if name == "imu":
        c.imu = value
        return f"ADCS switched to IMU-{c.imu}"
    if name == "trx":
        c.trx = value
        return f"Radio switched to transponder {c.trx}"
    if name == "antenna":
        c.antenna = value
        return f"Antenna set to {c.antenna}"
    if name == "bat_isolated":
        c.bat_isolated = bool(value)
        return "Faulty battery string " + ("isolated" if c.bat_isolated else "reconnected")
    if name == "pose":
        c.pose = value
        if c.pose != "NORMAL":
            c.drive = False
        return {"SUN": "Sun-pointing attitude", "SHADE": "Thermal safe attitude"}.get(c.pose, "Nadir-pointing")
    if name == "relay_hp":
        c.relay_hp = bool(value)
        return "Ground-station high-power assist " + ("on" if c.relay_hp else "off")
    raise ValueError(f"unknown command {name!r}")


def autonomy(s: State, p: Params) -> list[str]:
    ev: list[str] = []
    c = s.cfg
    if s.dead:
        if s.soc > p.soc_revive:
            s.dead = False
            enter_safe(s, "reboot after power loss")
            ev.append("Battery recovered: OBDH rebooted into SAFE mode")
        return ev
    if s.soc < p.soc_dead:
        s.dead = True
        ev.append("Battery exhausted: spacecraft lost power")
        return ev
    if c.mode != "SAFE":
        if s.soc < p.soc_auto_safe:
            enter_safe(s, "low battery")
            ev.append("Autonomous SAFE mode: battery below 18% — sun-pointing")
        elif s.t_av > p.t_av_auto_safe:
            enter_safe(s, "avionics over-temperature")
            ev.append("Autonomous SAFE mode: avionics over-temperature")
        elif s.t_bat > p.t_bat_auto_safe:
            enter_safe(s, "battery over-temperature")
            ev.append("Autonomous SAFE mode: battery over-temperature")
        elif s.wheel_rpm > p.wheel_dump_rpm:
            enter_safe(s, "momentum dump")
            ev.append("Autonomous SAFE mode: reaction wheel near saturation — momentum dump")
    if c.drive and s.att_err > p.att_stop_deg:
        c.drive = False
        c.payload = False
        ev.append("Attitude knowledge poor: payload imaging inhibited")
    # Undervoltage FDIR: shed payload and cap wheels when bus sags (battery short)
    if not s.dead and s.v_bus < p.uv_bus_v:
        if c.payload or c.speed_frac > 0.5:
            c.payload = False
            c.speed_frac = min(c.speed_frac, 0.5)
            ev.append(f"Undervoltage FDIR ({s.v_bus:.1f} V < {p.uv_bus_v:.1f} V): payload shed, wheel power capped")
    if s.no_contact_s > p.comm_loss_timer_s and (c.trx == "A" or c.antenna == "HGA"):
        c.trx, c.antenna = "B", "LGA"
        if c.mode != "SAFE":
            enter_safe(s, "comm-loss timer")
        s.no_contact_s = 0.0
        ev.append("Comm-loss timer expired: switched to transponder B + LGA")
    return ev


def step(s: State, h: Health, p: Params, dt: float, terrain: float = 1.0) -> dict:
    _ = terrain
    events = autonomy(s, p)
    c = s.cfg
    alive = not s.dead
    safe = c.mode == "SAFE"
    orb = orbit_state(s.t, p)

    s.shade = 1.0 if orb["eclipse"] else (0.85 if c.pose == "SHADE" else 0.0)
    sun = 0.0 if orb["eclipse"] else 1.0
    if c.pose == "SHADE" and sun > 0:
        sun *= 0.15

    brown = clamp((s.v_bus - p.uv_bus_v) / 2.0, 0.0, 1.0)  # full torque at uv+2 V; capped below UV
    uv = s.v_bus < p.uv_bus_v
    hot = max(0.0, s.t_av - 40.0) / 10.0
    noise_mult = 1.0 + hot * hot + 2.0 * (1.0 - brown) + (1.2 if uv else 0.0)
    bias, imu_noise = (h.imu_a_bias, 1.0) if c.imu == "A" else (0.0, 1.6)
    bias += thermal_gyro_bias(s.t_av, p)
    fric = h.wheel_fric_mult * (1.0 + 0.4 * hot)
    wheel_power_frac = brown * (0.35 if safe else 1.0)
    # Slow momentum accumulation so nominal flights don't dump every orbit
    if alive and not safe:
        s.wheel_rpm = clamp(s.wheel_rpm + (6.0 * fric - 5.0 * wheel_power_frac) * dt / 60.0,
                            0.0, p.wheel_cap_rpm)
    else:
        s.wheel_rpm = max(0.0, s.wheel_rpm - 50.0 * dt / 60.0)
    sat = clamp(s.wheel_rpm / p.wheel_cap_rpm, 0.0, 1.0)
    wheel_cap = 1.0 - 0.7 * sat * (1.0 - brown)
    floor = p.att_floor * noise_mult * imu_noise / max(wheel_cap, 0.15)
    uv_bias = 0.025 if uv else 0.0  # undervoltage → slower wheel authority → knowledge drift
    s.att_err = clamp(s.att_err + (abs(bias) + uv_bias - (s.att_err - floor) / p.att_tau) * dt, 0.05, 60.0)
    vo = clamp((s.att_err - 2.0) / 4.0, 0.0, 1.0) if alive else 0.0
    p_compute = p.p_compute + p.p_compute_vo * vo
    p_sens = (p.p_sensors_safe if safe else p.p_sensors) if alive else 0.0

    imaging = c.drive and c.payload and not safe and alive
    lim_eps = clamp((s.soc - 0.20) / 0.10, 0.0, 1.0)
    lim_uv = brown  # undervoltage also cuts imaging duty
    lim_tcs = clamp(1.0 - (s.t_av - 55.0) / 15.0, 0.2, 1.0)
    lim_nav = clamp(1.0 - (s.att_err - 3.0) / 5.0, 0.0, 1.0)
    duty_cmd = c.speed_frac if imaging else 0.0
    duty = duty_cmd * lim_eps * lim_uv * lim_tcs * lim_nav
    p_mob = p.p_mobility_nom * duty * (0.4 + 0.6 * sat)
    s.heading = orb["angle"]
    s.x = math.cos(orb["angle"]) * p.loop_radius
    s.z = math.sin(orb["angle"]) * p.loop_radius
    s.odometer += duty * dt * 0.05
    v = duty * p.v_nom

    payload_on = imaging and duty > 0.05 and s.buffer_mb < p.buffer_cap_mb - 0.01
    p_pay = p.p_payload * duty if payload_on else 0.0

    lb = link_budget(c, s.att_err, s.t_av, s.v_bus, s.t, h.trx_a_loss_db, p)
    point, trx_loss, temp_loss, brown_db = lb["point"], lb["trx"], lb["temp"], lb["brown"]
    margin_raw = lb["margin"] if alive else -99.0
    in_pass = orb["gs_pass"] and alive
    margin = margin_raw if in_pass else -40.0
    rate = min(p.rate_max_kbps, p.rate_max_kbps * 10 ** (margin / 10.0)) if in_pass else 0.0
    down_ok = in_pass and rate >= p.rate_min_kbps
    # Uplink needs a usable margin too — severe TRX loss must close the door
    up_ok = in_pass and margin_raw > -6.0 and (
        p.rate_max_kbps * 10 ** ((margin_raw + p.uplink_bonus_db) / 10.0) >= p.uplink_min_kbps
    )
    # Contact timers only run during AOS — off-pass silence is nominal store-and-forward
    if up_ok:
        s.no_contact_s = 0.0
    elif in_pass:
        s.no_contact_s += dt
    if up_ok and down_ok:
        s.no_lock_s = 0.0
    elif in_pass:
        s.no_lock_s += dt
    searching = alive and s.no_lock_s > p.search_after_s
    if not alive:
        p_comm = 0.0
    elif searching:
        p_comm = p.p_comm_search
    elif in_pass:
        p_comm = p.p_comm_lga if c.antenna == "LGA" else p.p_comm_hga
    else:
        p_comm = 4.0

    gen = (p.science_mb_s * duty if payload_on else 0.0) + (p.hk_mb_s if alive else 0.0)
    down = rate / 8000.0 if down_ok else 0.0
    sent = min(down * dt, s.buffer_mb + gen * dt)
    s.buffer_mb += gen * dt - sent
    if s.buffer_mb > p.buffer_cap_mb:
        s.data_lost_mb += s.buffer_mb - p.buffer_cap_mb
        s.buffer_mb = p.buffer_cap_mb
    s.science_mb += sent

    q_h_av = p.p_heater_av * clamp((-5.0 - s.t_av) / 5.0, 0.0, 1.0) if alive else 0.0
    q_h_bat = p.p_heater_bat * clamp((5.0 - s.t_bat) / 5.0, 0.0, 1.0) if alive else 0.0

    p_av = p.p_avionics + p_compute if alive else 0.0
    p_load = p_av + p_sens + p_mob + p_pay + p_comm + q_h_av + q_h_bat
    p_sol = p.solar_peak_w * sun * (1.15 if c.pose == "SUN" else 1.0)
    cap, r_mult, leak = effective_battery(c, h, p)
    r = p.bat_r0 * r_mult * math.exp(-0.025 * (s.t_bat - 25.0))
    e = voc(s.soc)
    p_bat = p_sol - p_load
    if s.soc >= 1.0 and p_bat > 0:
        p_sol -= p_bat
        p_bat = 0.0
    disc = e * e + 4.0 * r * p_bat
    i = (-e + math.sqrt(disc)) / (2.0 * r) if disc > 0 else -e / (2.0 * r)
    v_bus = e + i * r
    loss = i * i * r
    de = (p_bat - loss) * (p.charge_eff if p_bat > 0 else 1.0) - leak
    s.soc = clamp(s.soc + de * dt / 3600.0 / cap, 0.0, 1.0)
    s.v_bus = v_bus

    q_av_elec = 0.92 * (p_av + p_sens + p_comm) + 0.8 * p_pay + q_h_av
    q_sun = p.q_sun_body * sun
    t_sink = sink_temp(s.shade, p)
    q_rad = p.rad_eps_area * h.rad_eff * SIGMA * ((s.t_av + K0) ** 4 - t_sink**4)
    q_ab = p.g_ab * (s.t_bat - s.t_av)
    q_env = p.g_bat_env * (s.t_bat - (t_sink - K0))
    s.t_av += (q_av_elec + q_sun + q_ab - q_rad) / p.c_av * dt
    s.t_bat += (loss + leak + q_h_bat - q_ab - q_env) / p.c_bat * dt

    s.t += dt

    search_w = (p_comm - 4.0) if searching else 0.0
    couplings = {
        "EPS>TCS": (clamp((loss + leak) / 28.0, 0, 1), f"{loss + leak:.0f} W battery heat"),
        "TCS>EPS": (clamp((q_h_av + q_h_bat) / 25.0 + max(0.0, s.t_bat - 40.0) / 20.0, 0, 1),
                    f"heaters {q_h_av + q_h_bat:.0f} W" if q_h_av + q_h_bat > 1 else f"battery at {s.t_bat:.0f}°C"),
        "TCS>GNC": (clamp(hot * hot / 3.5 + thermal_gyro_bias(s.t_av, p) / 0.03 + 0.25 * (fric - 1.0), 0, 1),
                    f"gyro drift {thermal_gyro_bias(s.t_av, p):.3f}°/s, wheel fric x{fric:.1f}"),
        "TCS>COMMS": (clamp(temp_loss / 5.0, 0, 1), f"{fmt_db(temp_loss)} radio derate"),
        "TCS>MOB": (1.0 - lim_tcs, "thermal payload inhibit"),
        "EPS>GNC": (clamp(2.0 * (1.0 - brown) + 0.8 * sat * (1.0 - brown) + (0.55 if uv else 0.0), 0, 1),
                    f"bus {v_bus:.1f} V — wheel torque capped"),
        "EPS>COMMS": (clamp(brown_db / 6.0, 0, 1), f"{fmt_db(brown_db)} low bus voltage"),
        "EPS>MOB": (clamp(max(1.0 - lim_eps, 1.0 - lim_uv,
                              0.85 if (uv or not c.payload) else 0.0,
                              0.4 if s.soc < 0.25 else 0.0), 0, 1)
                    if (duty_cmd > 0 or uv or not c.payload or lim_uv < 0.95 or s.soc < 0.25) else 0.0,
                    f"payload shed, bus {v_bus:.1f} V, SOC {s.soc:.0%}"),
        "GNC>COMMS": (clamp(point / 8.0, 0, 1), f"{fmt_db(point)} antenna mispointing"),
        "GNC>EPS": (vo, f"+{p.p_compute_vo * vo:.0f} W ADCS compute"),
        "GNC>MOB": (1.0 - lim_nav if duty_cmd > 0 else (1.0 if s.att_err > p.att_stop_deg else 0.0),
                    f"pointing {s.att_err:.1f}° — imaging quality"),
        "COMMS>EPS": (clamp(search_w / 14.0, 0, 1), f"+{search_w:.0f} W signal search"),
        "COMMS>DATA": (clamp(s.buffer_mb / p.buffer_cap_mb, 0, 1) if not down_ok else 0.0,
                       f"OBDH buffer {s.buffer_mb / p.buffer_cap_mb:.0%} full"),
        "MOB>EPS": (clamp((p_mob + p_pay) / 80.0, 0, 1), f"payload+wheels {p_mob + p_pay:.0f} W"),
    }

    return {
        "events": events,
        "p_sol": p_sol, "p_load": p_load, "p_av": p_av, "p_sens": p_sens, "p_mob": p_mob,
        "p_pay": p_pay, "p_comm": p_comm, "p_heat_av": q_h_av, "p_heat_bat": q_h_bat,
        "i_bat": i, "v_bus": v_bus, "r_bat": r, "cap_wh": cap, "leak": leak, "loss": loss,
        "margin": margin, "rate": rate if down_ok else 0.0, "down_ok": down_ok, "up_ok": up_ok,
        "searching": searching, "v": v, "noise_mult": noise_mult, "point_loss": point,
        "temp_loss": temp_loss, "brown_db": brown_db, "trx_loss": trx_loss, "q_rad": q_rad,
        "sun": sun, "payload_on": payload_on, "innov": abs(bias), "vo": vo,
        "couplings": couplings,
        "orbit": orb, "sunlit": orb["sunlit"], "gs_pass": orb["gs_pass"],
        "next_pass_s": orb["next_pass_s"], "eclipse": orb["eclipse"],
        "wheel_rpm": s.wheel_rpm, "imaging_duty": duty,
    }
