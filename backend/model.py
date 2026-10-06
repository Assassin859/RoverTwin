"""Coupled subsystem model of a lunar rover.

The *same* equations run in two places:

* ``plant.py`` - the simulated "real" rover, driven by the true (hidden) health
  parameters plus process noise. It only talks to the ground through telemetry.
* ``twin.py``  - the digital twin, driven by *estimated* health parameters that
  are continuously re-fitted from the telemetry stream.

Subsystems and the physical links between them:

    EPS   battery + solar array + loads. Battery I^2R and internal-short heat
          feed the thermal model; bus voltage feeds sensors and the radio.
    TCS   two-node lumped thermal model (avionics box + battery) radiating to
          space. Temperature drives sensor noise, radio derating, battery
          resistance and onboard thermal protection.
    GNC   attitude knowledge from IMU + sun sensor. Attitude error drives
          antenna pointing loss, visual-odometry compute load and drive safety.
    COMMS link budget to the relay orbiter. Margin sets data rate, telemetry
          cadence, command uplink and signal-search power.
    MOB   drive power and speed, limited by SOC, temperature and attitude.
    DATA  science buffer filled by the payload and drained by the downlink.
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


@dataclass(frozen=True)
class Params:
    # EPS
    bat_capacity_wh: float = 600.0
    bat_r0: float = 0.06
    solar_peak_w: float = 270.0
    charge_eff: float = 0.96
    # loads [W]
    p_avionics: float = 28.0
    p_compute: float = 8.0
    p_compute_vo: float = 16.0
    p_sensors: float = 10.0
    p_sensors_safe: float = 6.0
    p_mobility_nom: float = 60.0
    p_payload: float = 25.0
    p_comm_hga: float = 30.0
    p_comm_lga: float = 22.0
    p_comm_search: float = 44.0
    p_heater_av: float = 25.0
    p_heater_bat: float = 15.0
    # TCS
    c_av: float = 3500.0
    c_bat: float = 4500.0
    rad_eps_area: float = 0.45
    g_ab: float = 1.2
    g_bat_env: float = 0.15
    q_sun_body: float = 22.0
    t_sink_sun: float = 250.0
    t_sink_shade: float = 200.0
    # GNC
    att_floor: float = 0.25
    att_tau: float = 150.0
    gyro_bias_per_c: float = 0.0025
    # MOB
    v_nom: float = 0.10
    loop_radius: float = 45.0
    # COMMS
    m0_db: float = 10.0
    hga_beam_deg: float = 10.0
    lga_gain_db: float = -24.0
    rate_max_kbps: float = 256.0
    rate_min_kbps: float = 2.0
    uplink_min_kbps: float = 1.0
    trx_b_loss_db: float = 2.5
    uplink_bonus_db: float = 10.0
    relay_hp_db: float = 6.0
    relay_period_s: float = 7200.0
    # DATA
    buffer_cap_mb: float = 24.0
    science_mb_s: float = 0.006
    hk_mb_s: float = 0.00025
    # onboard autonomy (FDIR)
    soc_auto_safe: float = 0.18
    soc_dead: float = 0.03
    soc_revive: float = 0.08
    t_av_auto_safe: float = 72.0
    t_bat_auto_safe: float = 55.0
    att_stop_deg: float = 10.0
    search_after_s: float = 600.0
    comm_loss_timer_s: float = 1800.0


@dataclass
class Health:
    """Fault-affected parameters. Truth lives in the plant, estimates in the twin."""

    bat_capacity_frac: float = 1.0
    bat_r_mult: float = 1.0
    bat_leak_w: float = 0.0
    rad_eff: float = 1.0
    imu_a_bias: float = 0.0
    trx_a_loss_db: float = 0.0


@dataclass
class Config:
    """Commandable configuration (plus onboard-autonomy overrides)."""

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
    t_av: float = 25.0
    t_bat: float = 19.7
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
    cfg: Config = field(default_factory=Config)

    def clone(self) -> "State":
        s = copy.copy(self)
        s.cfg = copy.copy(self.cfg)
        return s


# ---------------------------------------------------------------- environment
def sun_elevation(t: float) -> float:
    return math.radians(35.0 + 6.0 * math.sin(2 * math.pi * t / 21600.0))


def relay_range_db(t: float, p: Params) -> float:
    return 1.5 * math.sin(2 * math.pi * t / p.relay_period_s)


def voc(soc: float) -> float:
    """Open-circuit voltage of the 7S Li-ion pack."""
    return 22.0 + 7.0 * soc - 1.5 * math.exp(-soc / 0.06)


def effective_battery(cfg: Config, h: Health, p: Params) -> tuple[float, float, float]:
    """Capacity [Wh], resistance multiplier and leak [W] of the connected pack.

    Isolating the faulty string leaves one healthy string: half capacity,
    double resistance, no internal short.
    """
    if cfg.bat_isolated:
        return 0.5 * p.bat_capacity_wh, 2.0, 0.0
    return p.bat_capacity_wh * h.bat_capacity_frac, h.bat_r_mult, h.bat_leak_w


def sink_temp(shade: float, p: Params) -> float:
    return p.t_sink_sun + (p.t_sink_shade - p.t_sink_sun) * shade


def thermal_gyro_bias(t_av: float, p: Params) -> float:
    """Gyro bias drift caused by a hot avionics box [deg/s]."""
    return p.gyro_bias_per_c * max(0.0, t_av - 45.0)


def link_budget(c: Config, att_err: float, t_av: float, v_bus: float, t: float,
                trx_a_loss_db: float, p: Params) -> dict:
    """Downlink margin [dB] at the maximum data rate and its loss terms."""
    if c.antenna == "HGA":
        gain, point = 0.0, min(80.0, 12.0 * (att_err / p.hga_beam_deg) ** 2)
    else:
        gain, point = p.lga_gain_db, 0.0
    trx = trx_a_loss_db if c.trx == "A" else p.trx_b_loss_db
    temp = 0.2 * max(0.0, t_av - 45.0)
    brown = -10.0 * math.log10(max(clamp((v_bus - 21.5) / 2.5, 0.0, 1.0), 0.01))
    relay = p.relay_hp_db if c.relay_hp else 0.0
    margin = p.m0_db + gain + relay - point - trx - temp - brown - relay_range_db(t, p)
    return {"margin": margin, "point": point, "trx": trx, "temp": temp, "brown": brown}


# ------------------------------------------------------------------- commands
def enter_safe(s: State, reason: str = "") -> None:
    c = s.cfg
    c.mode, c.drive, c.payload = "SAFE", False, False
    if c.pose == "NORMAL":
        c.pose = "SUN"
    s.auto_safe = reason


def apply_command(s: State, name: str, value) -> str:
    """Apply a ground command to the rover configuration. Returns a summary."""
    c = s.cfg
    if name == "mode":
        if value == "SAFE":
            enter_safe(s, "")
            return "Entered SAFE mode (drive off, payload off, face Sun)"
        c.mode, c.drive, c.payload, c.pose, c.speed_frac = "NOMINAL", True, True, "NORMAL", 1.0
        s.auto_safe = ""
        return "Resumed NOMINAL operations"
    if name == "drive":
        c.drive = bool(value)
        return "Driving " + ("enabled" if c.drive else "stopped")
    if name == "speed":
        c.speed_frac = clamp(float(value), 0.0, 1.0)
        return f"Drive speed set to {c.speed_frac:.0%}"
    if name == "payload":
        c.payload = bool(value)
        return "Payload " + ("on" if c.payload else "off")
    if name == "imu":
        c.imu = "B" if value == "B" else "A"
        return f"Navigation switched to IMU-{c.imu}"
    if name == "trx":
        c.trx = "B" if value == "B" else "A"
        return f"Radio switched to transponder {c.trx}"
    if name == "antenna":
        c.antenna = "LGA" if value == "LGA" else "HGA"
        return f"Antenna set to {c.antenna}"
    if name == "bat_isolated":
        c.bat_isolated = bool(value)
        return "Faulty battery string " + ("isolated" if c.bat_isolated else "reconnected")
    if name == "pose":
        c.pose = value if value in ("NORMAL", "SUN", "SHADE") else "NORMAL"
        if c.pose != "NORMAL":
            c.drive = False
        return {"SUN": "Parking facing the Sun", "SHADE": "Parking in shadow"}.get(c.pose, "Normal pose")
    if name == "relay_hp":
        c.relay_hp = bool(value)
        return "Relay orbiter high-gain mode " + ("on" if c.relay_hp else "off")
    raise ValueError(f"unknown command {name!r}")


GROUND_COMMANDS = {"relay_hp"}


# --------------------------------------------------------------- the dynamics
def autonomy(s: State, p: Params) -> list[str]:
    """Onboard fault protection, evaluated on the current state."""
    ev: list[str] = []
    c = s.cfg
    if s.dead:
        if s.soc > p.soc_revive:
            s.dead = False
            enter_safe(s, "reboot after power loss")
            ev.append("Battery recovered: avionics rebooted into SAFE mode")
        return ev
    if s.soc < p.soc_dead:
        s.dead = True
        ev.append("Battery exhausted: rover lost power")
        return ev
    if c.mode != "SAFE":
        if s.soc < p.soc_auto_safe:
            enter_safe(s, "low battery")
            ev.append("Autonomous SAFE mode: battery below 18%")
        elif s.t_av > p.t_av_auto_safe:
            enter_safe(s, "avionics over-temperature")
            ev.append("Autonomous SAFE mode: avionics over-temperature")
        elif s.t_bat > p.t_bat_auto_safe:
            enter_safe(s, "battery over-temperature")
            ev.append("Autonomous SAFE mode: battery over-temperature")
    if c.drive and s.att_err > p.att_stop_deg:
        c.drive = False
        ev.append("Attitude knowledge poor: autonomous drive halt")
    if s.no_contact_s > p.comm_loss_timer_s and (c.trx == "A" or c.antenna == "HGA"):
        c.trx, c.antenna = "B", "LGA"
        if c.mode != "SAFE":
            enter_safe(s, "comm-loss timer")
        s.no_contact_s = 0.0
        ev.append("Comm-loss timer expired: switched to transponder B + low-gain antenna")
    return ev


def step(s: State, h: Health, p: Params, dt: float, terrain: float = 1.0) -> dict:
    """Advance the rover by ``dt`` seconds (mutates ``s``) and return outputs."""
    events = autonomy(s, p)
    c = s.cfg
    alive = not s.dead
    safe = c.mode == "SAFE"

    # environment
    sun_raw = max(0.0, math.sin(sun_elevation(s.t)))
    s.shade += ((0.95 if c.pose == "SHADE" else 0.0) - s.shade) * min(1.0, dt / 240.0)
    sun = sun_raw * (1.0 - s.shade)

    # GNC: attitude knowledge
    brown = clamp((s.v_bus - 21.5) / 2.5, 0.0, 1.0)
    hot = max(0.0, s.t_av - 40.0) / 10.0
    noise_mult = 1.0 + hot * hot + 2.0 * (1.0 - brown)
    bias, imu_noise = (h.imu_a_bias, 1.0) if c.imu == "A" else (0.0, 1.6)
    bias += thermal_gyro_bias(s.t_av, p)
    floor = p.att_floor * noise_mult * imu_noise
    s.att_err = clamp(s.att_err + (abs(bias) - (s.att_err - floor) / p.att_tau) * dt, 0.05, 60.0)
    vo = clamp((s.att_err - 2.0) / 4.0, 0.0, 1.0) if alive else 0.0
    p_compute = p.p_compute + p.p_compute_vo * vo
    p_sens = (p.p_sensors_safe if safe else p.p_sensors) if alive else 0.0

    # MOB
    v = p.v_nom * c.speed_frac if (c.drive and not safe and alive) else 0.0
    lim_eps = clamp((s.soc - 0.20) / 0.10, 0.0, 1.0)
    lim_tcs = clamp(1.0 - (s.t_av - 60.0) / 15.0, 0.3, 1.0)
    lim_nav = clamp(1.0 - (s.att_err - 4.0) / 6.0, 0.0, 1.0)
    v_cmd = v
    v *= lim_eps * lim_tcs * lim_nav
    p_mob = p.p_mobility_nom * (v / p.v_nom) * terrain
    ds = v * dt
    s.odometer += ds
    s.heading = s.odometer / p.loop_radius + 0.15 * math.sin(s.odometer / 9.0)
    s.x -= math.sin(s.heading) * ds
    s.z -= math.cos(s.heading) * ds
    if v > 0:
        s.nav_err += ds * (0.01 + math.radians(s.att_err))
    else:
        s.nav_err *= 1.0 - min(1.0, dt / 600.0)

    # DATA / payload
    payload_on = c.payload and not safe and alive and s.buffer_mb < p.buffer_cap_mb - 0.01
    p_pay = p.p_payload if payload_on else 0.0

    # COMMS
    lb = link_budget(c, s.att_err, s.t_av, s.v_bus, s.t, h.trx_a_loss_db, p)
    point, trx_loss, temp_loss, brown_db = lb["point"], lb["trx"], lb["temp"], lb["brown"]
    margin = lb["margin"] if alive else -99.0
    rate = min(p.rate_max_kbps, p.rate_max_kbps * 10 ** (margin / 10.0))
    down_ok = rate >= p.rate_min_kbps
    up_ok = alive and p.rate_max_kbps * 10 ** ((margin + p.uplink_bonus_db) / 10.0) >= p.uplink_min_kbps
    s.no_contact_s = 0.0 if up_ok else s.no_contact_s + dt
    s.no_lock_s = 0.0 if (up_ok and down_ok) else s.no_lock_s + dt
    searching = alive and s.no_lock_s > p.search_after_s
    if not alive:
        p_comm = 0.0
    elif searching:
        p_comm = p.p_comm_search
    else:
        p_comm = p.p_comm_lga if c.antenna == "LGA" else p.p_comm_hga

    gen = (p.science_mb_s if payload_on else 0.0) + (p.hk_mb_s if alive else 0.0)
    down = rate / 8000.0 if down_ok else 0.0
    sent = min(down * dt, s.buffer_mb + gen * dt)
    s.buffer_mb += gen * dt - sent
    if s.buffer_mb > p.buffer_cap_mb:
        s.data_lost_mb += s.buffer_mb - p.buffer_cap_mb
        s.buffer_mb = p.buffer_cap_mb
    s.science_mb += sent

    # TCS heaters (proportional thermostats)
    q_h_av = p.p_heater_av * clamp((-5.0 - s.t_av) / 5.0, 0.0, 1.0) if alive else 0.0
    q_h_bat = p.p_heater_bat * clamp((5.0 - s.t_bat) / 5.0, 0.0, 1.0) if alive else 0.0

    # EPS
    p_av = p.p_avionics + p_compute if alive else 0.0
    p_load = p_av + p_sens + p_mob + p_pay + p_comm + q_h_av + q_h_bat
    p_sol = p.solar_peak_w * sun * (1.1 if c.pose == "SUN" else 1.0)
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

    # TCS two-node thermal balance
    q_av_elec = 0.92 * (p_av + p_sens + p_comm) + 0.8 * p_pay + q_h_av
    q_sun = p.q_sun_body * sun
    t_sink = sink_temp(s.shade, p)
    q_rad = p.rad_eps_area * h.rad_eff * SIGMA * ((s.t_av + K0) ** 4 - t_sink**4)
    q_ab = p.g_ab * (s.t_bat - s.t_av)
    q_env = p.g_bat_env * (s.t_bat - (t_sink - K0))
    s.t_av += (q_av_elec + q_sun + q_ab - q_rad) / p.c_av * dt
    s.t_bat += (loss + leak + q_h_bat - q_ab - q_env) / p.c_bat * dt

    s.t += dt

    # how strongly each subsystem is currently pushing on the others
    search_w = (p_comm - (p.p_comm_lga if c.antenna == "LGA" else p.p_comm_hga)) if searching else 0.0
    # Conduction into avionics (hot pack → T_av) foreshadows gyro/radio thermal effects
    cond_in = max(0.0, q_ab) / 12.0
    couplings = {
        "EPS>TCS": (clamp((loss + leak) / 30.0, 0, 1), f"{loss + leak:.0f} W battery heat"),
        "TCS>EPS": (clamp((q_h_av + q_h_bat) / 25.0 + max(0.0, s.t_bat - 40.0) / 20.0, 0, 1),
                    f"heaters {q_h_av + q_h_bat:.0f} W" if q_h_av + q_h_bat > 1 else f"battery at {s.t_bat:.0f}°C"),
        "TCS>GNC": (clamp(hot * hot / 4.0 + thermal_gyro_bias(s.t_av, p) / 0.03 + cond_in, 0, 1),
                    f"gyro drift {thermal_gyro_bias(s.t_av, p):.3f}°/s · {max(0.0, q_ab):.0f} W into avionics"),
        "TCS>COMMS": (clamp(temp_loss / 5.0 + 0.35 * cond_in, 0, 1),
                      f"-{temp_loss:.1f} dB radio derate" if temp_loss > 0.05 else f"{max(0.0, q_ab):.0f} W pack→avionics"),
        "TCS>MOB": (1.0 - lim_tcs, "thermal speed limit"),
        "EPS>GNC": (clamp(2.0 * (1.0 - brown), 0, 1), f"bus {v_bus:.1f} V brownout"),
        "EPS>COMMS": (clamp(brown_db / 6.0, 0, 1), f"-{brown_db:.1f} dB low bus voltage"),
        "EPS>MOB": (1.0 - lim_eps if v_cmd > 0 else 0.0, f"speed limited, SOC {s.soc:.0%}"),
        "GNC>COMMS": (clamp(point / 10.0, 0, 1), f"-{point:.1f} dB antenna mispointing"),
        "GNC>EPS": (vo, f"+{p.p_compute_vo * vo:.0f} W fallback compute"),
        "GNC>MOB": (1.0 - lim_nav if v_cmd > 0 else (1.0 if s.att_err > p.att_stop_deg else 0.0),
                    f"attitude error {s.att_err:.1f}°"),
        "COMMS>EPS": (clamp(search_w / 14.0, 0, 1), f"+{search_w:.0f} W signal search"),
        "COMMS>DATA": (clamp(s.buffer_mb / p.buffer_cap_mb, 0, 1) if not down_ok else 0.0,
                       f"buffer {s.buffer_mb / p.buffer_cap_mb:.0%} full"),
        "MOB>EPS": (clamp(p_mob / 600.0, 0, 1), f"drive {p_mob:.0f} W"),
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
    }

