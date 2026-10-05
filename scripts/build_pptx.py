"""Build docs/RoverTwin-ST09.pptx answering the four judge traps."""
from __future__ import annotations

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
OUT = ROOT / "docs" / "RoverTwin-ST09.pptx"

BG = RGBColor(0x0A, 0x08, 0x06)
INK = RGBColor(0xF4, 0xED, 0xE4)
SAF = RGBColor(0xFF, 0x99, 0x33)
MUT = RGBColor(0x8F, 0x84, 0x78)
GRN = RGBColor(0x3E, 0xCF, 0x6A)


def set_slide_bg(slide, rgb=BG):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = rgb


def add_title(slide, text, top=0.35, size=32):
    box = slide.shapes.add_textbox(Inches(0.5), Inches(top), Inches(9), Inches(0.7))
    tf = box.text_frame
    p = tf.paragraphs[0]
    p.text = text
    p.font.size = Pt(size)
    p.font.bold = True
    p.font.color.rgb = SAF
    p.font.name = "Calibri"


def add_body(slide, lines, top=1.2, size=16):
    box = slide.shapes.add_textbox(Inches(0.5), Inches(top), Inches(9), Inches(5))
    tf = box.text_frame
    tf.word_wrap = True
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        p.font.size = Pt(size)
        p.font.color.rgb = INK
        p.font.name = "Calibri"
        p.space_after = Pt(8)


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
    add_title(s, "RoverTwin", 1.8, 44)
    add_body(s, [
        "TECHFEST 2026–27 · Space Technology Hackathon · ST-09",
        "Mission Digital Twin for Predictive Fault Simulation",
        "",
        "A telemetry-synchronised digital twin of a lunar rover —",
        "not a dashboard of canned plots.",
        "",
        "github.com/Assassin859/RoverTwin",
    ], top=2.7, size=18)

    # 2 Trap 1 — subsystems + equations
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Judge trap 1 — subsystems + equations")
    add_body(s, [
        "Six coupled subsystems in one step: EPS · TCS · GNC · COMMS · MOB · DATA",
        "",
        "EPS:  Voc(SOC),  P = Voc·I + I²R,  SOĊ from solar − load − I²R − leak",
        "TCS:  two-node C·Ṫ for avionics & battery; radiator η·A·σ(T⁴ − T_sink⁴)",
        "GNC:  attitude error dynamics + thermal gyro bias 0.0025·max(0,T_av−45)",
        "COMMS:  M = M0 − pointing − trx − temp − brownout − range  → data rate",
        "",
        "14 live coupling edges are drawn from these equations every second.",
    ], size=15)

    # 3 Trap 2 — live cascade
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Judge trap 2 — live cascade (battery)")
    add_body(s, [
        "Inject battery degradation → internal short + high R",
        "Next: battery heats (EPS→TCS), then avionics, SOC drains",
        "Twin diagnoses root cause and ranks “isolate string” best",
    ], top=1.1, size=15)
    add_image(s, ASSETS / "02-cascade.png", top=2.3, width=9.0)

    # 4 Trap 3 — sync ≠ standalone
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Judge trap 3 — sync ≠ standalone sim")
    add_body(s, [
        "Plant (hidden truth) → RadioLink (2.6 s latency, rate limit, packet loss)",
        "                    → Twin (same model + estimated health only)",
        "",
        "Sync states: INIT · SYNCED · LOW RATE · BLIND",
        "While blind the twin propagates alone; silence can diagnose the radio.",
        "The twin never reads the plant — enforced by tests/test_twin.py.",
        "",
        "Show truth = test harness overlay, not the twin’s belief.",
    ], size=15)
    add_image(s, ASSETS / "03-forecast.png", top=4.0, width=9.0)

    # 5 Trap 4 — fidelity
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "Judge trap 4 — how we checked fidelity")
    add_body(s, [
        "pytest: cascade edges, twin convergence, recovery ranking (15 tests)",
        "",
        "Headless ~40 min after battery onset (seed 3):",
        "  leak 56 W vs 58 W true · R×5.18 vs ×5.25 · capacity 62% vs 62%",
        "  radiator η 0.377 vs 0.37 · IMU bias exact · nominal → no false DIAG",
        "",
        "UI “Show truth (test harness)” compares estimate vs hidden plant.",
        "Recovery: isolate string → contained finding, forecast goes green.",
    ], size=15)
    add_image(s, ASSETS / "04-recovery.png", top=4.2, width=9.0)

    # 6 Demo script
    s = prs.slides.add_slide(blank)
    set_slide_bg(s)
    add_title(s, "3-minute judge demo")
    add_body(s, [
        "1. Landing → GUIDED DEMO (primary CTA)",
        "2. Inject Battery → watch residuals, diagnosis, EPS→TCS edge",
        "3. Forecast pauses on critical → ranked recovery plans",
        "4. Execute isolate → uplink confirm → contained + all clear",
        "5. Optional: Show truth · Model check tab · hover edges for equations",
        "",
        "Cold start:  bash scripts/smoke.sh   or   .\\scripts\\smoke.ps1",
        "Run:         uvicorn backend.app:app --port 8000",
        "Repo:        https://github.com/Assassin859/RoverTwin",
    ], size=16)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    prs.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
