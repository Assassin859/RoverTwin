"""Build docs/SatTwin-ST09.pptx (and RoverTwin-ST09.pptx alias) for TECHFEST ST-09."""
from __future__ import annotations

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
OUT = ROOT / "docs" / "SatTwin-ST09.pptx"
OUT_ALIAS = ROOT / "docs" / "RoverTwin-ST09.pptx"

BG = RGBColor(0x0B, 0x0F, 0x14)
INK = RGBColor(0xE6, 0xED, 0xF3)
SAF = RGBColor(0xFF, 0x99, 0x33)
MUT = RGBColor(0x9A, 0xA7, 0xB4)
GRN = RGBColor(0x3F, 0xB9, 0x50)


def set_slide_bg(slide, rgb=BG):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = rgb


def add_title(slide, text, top=0.35, size=28):
    box = slide.shapes.add_textbox(Inches(0.5), Inches(top), Inches(9), Inches(0.7))
    tf = box.text_frame
    p = tf.paragraphs[0]
    p.text = text
    p.font.size = Pt(size)
    p.font.bold = True
    p.font.color.rgb = SAF
    p.font.name = "Calibri"


def add_body(slide, lines, top=1.15, size=15):
    box = slide.shapes.add_textbox(Inches(0.5), Inches(top), Inches(9), Inches(5.5))
    tf = box.text_frame
    tf.word_wrap = True
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        p.font.size = Pt(size)
        p.font.color.rgb = INK if not line.startswith("  ") else MUT
        p.font.name = "Calibri"
        p.space_after = Pt(6)


def add_image(slide, path: Path, left=0.5, top=2.0, width=9.0):
    if path.exists():
        slide.shapes.add_picture(str(path), Inches(left), Inches(top), width=Inches(width))


def main():
    prs = Presentation()
    prs.slide_width = Inches(10)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]

    # 1 Title
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "SatTwin", 1.6, 44)
    add_body(s, [
        "TECHFEST 2026–27 · Space Technology Hackathon · ST-09",
        "Mission Digital Twin for Predictive Fault Simulation",
        "",
        "A telemetry-synchronised LEO Earth-observation smallsat twin —",
        "not a dashboard of canned plots.",
        "",
        "github.com/Assassin859/RoverTwin  ·  rovertwin.vercel.app",
    ], top=2.5, size=17)

    # 2 Architecture
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Architecture — plant, link, twin")
    add_body(s, [
        "Plant (hidden truth)     — model.step + faults + FDIR autonomy",
        "RadioLink                — pass-gated TM/TC: latency, rate limit, loss",
        "DigitalTwin              — same physics; estimates health from frames only",
        "Correlate / Cascade      — 14 coupling edges; multi-hop cause→effect",
        "Predictor                — 2 h ensemble forecast + ranked recovery plans",
        "FastAPI ground segment   — private /ws console (~10 Hz) + REST /api/*",
        "Operator console         — inject · watch cascade · predict · execute at AOS",
        "",
        "Invariant: the twin never reads plant state (tests/test_twin.py).",
        "UI names: EPS · TCS · ADCS · COMMS · PAYLOAD · OBDH",
        "Wire ids GNC/MOB/DATA map to ADCS/PAYLOAD/OBDH in the console.",
    ], size=15)

    # 3 Trap 1
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Q1 — subsystems + equations")
    add_body(s, [
        "Six coupled subsystems in one 1 Hz step:",
        "  EPS · TCS · ADCS(GNC) · COMMS · PAYLOAD(MOB) · OBDH(DATA)",
        "",
        "EPS:  Voc(SOC),  P = Voc·I + I²R,  SOĊ from solar − load − heat − leak",
        "TCS:  two-node C·Ṫ (avionics & battery); radiator η·A·σ(T⁴ − T_sink⁴)",
        "ADCS: attitude error + thermal gyro bias 0.0025·max(0, T_av−45)",
        "COMMS: link margin M → data rate; pointing / temp / brownout losses",
        "",
        "14 live coupling edges are drawn from these equations every second.",
    ], size=15)

    # 4 Trap 2
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Q2 — battery cascade (live)")
    add_body(s, [
        "Inject battery degradation → internal short + rising R",
        "Next: battery heats (EPS→TCS) → avionics / ADCS / COMMS knock-ons",
        "Twin diagnoses root, forecasts first critical, ranks isolate-string",
        "Execute at next AOS → uplink → contained / resolved",
    ], top=1.1, size=15)
    add_image(s, ASSETS / "02-cascade.png", top=2.6, width=9.0)

    # 5 Trap 3
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Q3 — synced twin ≠ standalone sim")
    add_body(s, [
        "Plant → RadioLink (2.6 s latency, rate limit, packet loss) → Twin",
        "Sync states: INIT · SYNCED · LOW RATE · BLIND (pass-gated AOS/LOS)",
        "While blind the twin propagates alone; silence can diagnose the radio.",
        "Show truth = test harness overlay — never the twin’s belief.",
    ], size=15)
    add_image(s, ASSETS / "03-forecast.png", top=3.6, width=9.0)

    # 6 Trap 4
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Q4 — validation & fidelity")
    add_body(s, [
        "pytest: cascade edges, twin convergence, recovery ranking, evidence APIs",
        "GET /api/validate · GET /api/backtest · session CSV ingest",
        "",
        "Headless ~40 min after battery onset (seed 3):",
        "  leak / R_mult / capacity / radiator η / IMU bias track truth",
        "  nominal runs raise no false diagnoses",
    ], size=15)
    add_image(s, ASSETS / "04-recovery.png", top=3.8, width=9.0)

    # 7 Demo
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "3-minute judge demo")
    add_body(s, [
        "1. Landing → 3-MIN JUDGE PATH",
        "2. Inject Battery → residuals, diagnosis, lit cascade edges",
        "3. Forecast / first critical → ranked recovery plans",
        "4. Execute isolate → uplink confirm → contained",
        "5. Optional: Show truth · hover edges for equations",
        "",
        "Run:   uvicorn backend.app:app --port 8000",
        "Offline backup: https://rovertwin.vercel.app",
        "Repo:  https://github.com/Assassin859/RoverTwin",
    ], size=16)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    prs.save(OUT)
    prs.save(OUT_ALIAS)
    print(f"wrote {OUT}")
    print(f"wrote {OUT_ALIAS}")


if __name__ == "__main__":
    main()
