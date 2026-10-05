"""Compose docs/assets/battery-demo.gif from the four storyboard stills."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
FRAMES = [
    ("01-inject.png", "1 · Inject battery degradation"),
    ("02-cascade.png", "2 · Fault cascade (EPS → TCS)"),
    ("03-forecast.png", "3 · 2 h forecast + ranked plans"),
    ("04-recovery.png", "4 · Isolate string — twin recovers"),
]
OUT = ASSETS / "battery-demo.gif"
W, H = 960, 540


def load(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGB")
    im.thumbnail((W, H), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (W, H), (10, 8, 6))
    x = (W - im.width) // 2
    y = (H - im.height) // 2
    canvas.paste(im, (x, y))
    return canvas


def caption(im: Image.Image, text: str) -> Image.Image:
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("arial.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    pad = 10
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    box = (8, H - th - 2 * pad - 8, 8 + tw + 2 * pad, H - 8)
    draw.rectangle(box, fill=(255, 153, 51))
    draw.text((box[0] + pad, box[1] + pad - 2), text, fill=(26, 15, 6), font=font)
    return im


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    frames = []
    for name, label in FRAMES:
        path = ASSETS / name
        if not path.exists():
            raise SystemExit(f"missing still: {path}")
        frames.append(caption(load(path), label))
    # ~75 s at 18 s/frame if viewed as storyboard; GIF delay in ms
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=18000,
        loop=0,
        optimize=False,
    )
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
