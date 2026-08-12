#!/usr/bin/env python3
"""
Contact sheets — the review step you should never skip.

    python contact_sheet.py frames/ survey.png --cols 10          # from a folder
    python contact_sheet.py clip.mp4 survey.jpg --fps 1 --cols 6   # from a video
    python contact_sheet.py frames/ survey.png --cols 10 --mark 1,61,150

Every frame gets its number printed on it, so when something looks wrong you can
say "frame 61" instead of "somewhere near the middle". `--mark` highlights the
hold points in green.

Requires: Pillow (and ffmpeg only when the input is a video).
"""
from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

EXTS = ("*.webp", "*.jpg", "*.jpeg", "*.png")


def natural_key(p: Path):
    return [int(s) if s.isdigit() else s for s in re.split(r"(\d+)", p.name)]


def frames_from_video(src: Path, fps: float, tmp: Path) -> list[Path]:
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(src),
                    "-vf", f"fps={fps},scale=480:-1", "-vsync", "0", f"{tmp}/f_%05d.png"],
                   check=True)
    return sorted(tmp.glob("*.png"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="a frame folder or a video file")
    ap.add_argument("out")
    ap.add_argument("--cols", type=int, default=10)
    ap.add_argument("--width", type=int, default=192, help="thumbnail width")
    ap.add_argument("--fps", type=float, default=1.0, help="only used for video input")
    ap.add_argument("--every", type=int, default=1, help="use every Nth frame")
    ap.add_argument("--mark", default="", help="1-based frame numbers to highlight, comma separated")
    a = ap.parse_args()

    src = Path(a.source)
    marks = {int(x) for x in a.mark.split(",") if x.strip().isdigit()}

    with tempfile.TemporaryDirectory() as td:
        if src.is_dir():
            files = sorted({f for pat in EXTS for f in src.glob(pat)}, key=natural_key)
        else:
            files = frames_from_video(src, a.fps, Path(td))
        if not files:
            raise SystemExit(f"no frames found in {src}")
        files = files[::max(1, a.every)]

        probe = Image.open(files[0])
        tw = a.width
        th = max(1, round(tw * probe.height / probe.width))
        cols = a.cols
        rows = -(-len(files) // cols)
        pad, label = 4, 14

        sheet = Image.new("RGB", (cols * (tw + pad) + pad, rows * (th + label + pad) + pad), (15, 15, 15))
        d = ImageDraw.Draw(sheet)
        for i, f in enumerate(files):
            im = Image.open(f).convert("RGB").resize((tw, th), Image.LANCZOS)
            x = pad + (i % cols) * (tw + pad)
            y = pad + (i // cols) * (th + label + pad)
            sheet.paste(im, (x, y + label))
            n = i * max(1, a.every) + 1
            d.text((x + 2, y + 1), str(n), fill=(110, 255, 140) if n in marks else (255, 215, 50))

        out = Path(a.out)
        sheet.save(out, quality=92) if out.suffix.lower() in (".jpg", ".jpeg") else sheet.save(out)
        print(f"{len(files)} frames  {cols} x {rows}  -> {out}  ({sheet.size[0]}x{sheet.size[1]})")
        if marks:
            print(f"highlighted: {sorted(marks)}")


if __name__ == "__main__":
    main()
