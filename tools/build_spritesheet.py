#!/usr/bin/env python3
"""
Tile a frame sequence into one spritesheet — the fast-load layer.

    python build_spritesheet.py frames/ sheet.webp --cols 9
    python build_spritesheet.py frames/ sheet.webp --cols 12 --cell 640x360 --ladder

Why the cells have to be small
------------------------------
A browser decodes an image into memory at `width * height * 4 bytes`,
**independent of how well it compressed on disk**. A 2 MB WebP can still cost
half a gigabyte of RAM once decoded. For 150 frames:

    cell 1280x720  ->  11520 x 12240  ->  538 MB   crashes phones
    cell  960x540  ->   8640 x  9180  ->  303 MB   too heavy
    cell  640x360  ->   5760 x  6120  ->  134 MB   usable
    cell  480x270  ->   4320 x  4590  ->   76 MB   visibly soft

So the sheet is permanently a low-resolution layer. Its job is "let the
animation move immediately"; sharpness is the full-resolution frames' job.

Blank cells are not pure black
------------------------------
When the grid has more cells than frames, the leftovers are filled black — but
lossy WebP will not round-trip them to exactly 0 (measured max 20-30). If your
player detects empty cells, use a threshold, not `=== 0`.

Requires: Pillow.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from PIL import Image

EXTS = ("*.webp", "*.jpg", "*.jpeg", "*.png")


def natural_key(p: Path):
    return [int(s) if s.isdigit() else s for s in re.split(r"(\d+)", p.name)]


def collect(src: Path) -> list[Path]:
    files = sorted({f for pat in EXTS for f in src.glob(pat)}, key=natural_key)
    if not files:
        raise SystemExit(f"no frames found in {src}")
    return files


def build(files: list[Path], cols: int, cw: int, ch: int) -> tuple[Image.Image, int]:
    rows = -(-len(files) // cols)
    sheet = Image.new("RGB", (cols * cw, rows * ch), (0, 0, 0))  # RGB, never RGBA
    for i, f in enumerate(files):
        im = Image.open(f).convert("RGB").resize((cw, ch), Image.LANCZOS)
        sheet.paste(im, ((i % cols) * cw, (i // cols) * ch))
    return sheet, rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src_dir")
    ap.add_argument("out")
    ap.add_argument("--cols", type=int, default=9)
    ap.add_argument("--cell", default="640x360")
    ap.add_argument("--quality", type=int, default=75)
    ap.add_argument("--ladder", action="store_true")
    a = ap.parse_args()

    cw, ch = (int(v) for v in a.cell.lower().split("x"))
    files = collect(Path(a.src_dir))
    sheet, rows = build(files, a.cols, cw, ch)

    if a.ladder:
        for q in (55, 60, 65, 70, 75, 80):
            tmp = Path(a.out).with_suffix(f".q{q}.tmp")
            sheet.save(tmp, "WEBP", quality=q, method=6)
            print(f"  quality {q}: {tmp.stat().st_size / 1024:8.1f} KB")
            tmp.unlink()
        return

    out = Path(a.out)
    sheet.save(out, "WEBP", quality=a.quality, method=6)
    blank = a.cols * rows - len(files)
    mem = sheet.size[0] * sheet.size[1] * 4 / 1048576

    print(f"size        : {sheet.size[0]} x {sheet.size[1]} px")
    print(f"grid        : {a.cols} cols x {rows} rows, cell {cw} x {ch}")
    print(f"frames      : {len(files)} ({blank} blank cell(s))")
    print(f"file        : {out.stat().st_size / 1024:.1f} KB")
    print(f"decoded RAM : ~{mem:.0f} MB" + ("   WARNING: over 200 MB" if mem > 200 else ""))
    print()
    print("player config:")
    print(f"  sheetCols: {a.cols}")
    print(f"  sheetRows: {rows}")
    print()
    print("CSS offset for frame n (0-based):")
    print(f"  background-position: -(n % {a.cols} * {cw})px  -(floor(n / {a.cols}) * {ch})px")
    n = len(files) - 1
    print(f"  frame 1   -> 0px 0px")
    print(f"  frame {len(files)} -> -{(n % a.cols) * cw}px -{(n // a.cols) * ch}px")
    if blank:
        print("\nnote: blank cells are not exactly 0 after lossy WebP; "
              "detect them with a threshold, not `=== 0`.")


if __name__ == "__main__":
    main()
