#!/usr/bin/env python3
"""
Extract a scroll sequence from a video.

    python extract_frames.py in.mp4 out/ --count 150
    python extract_frames.py in.mp4 out/ --count 150 --weighted
    python extract_frames.py in.mp4 out/ --count 150 --ladder

Two things this does differently from the obvious approach:

1. It samples by *frame index*, never with ffmpeg's `fps` filter.
   `fps=N/duration` resamples the timeline: you get N or N+1 files depending on
   rounding, and neither the true first nor the true last frame is guaranteed to
   survive. For a scroll sequence the first and last frames are the two the user
   stares at longest, so they have to be exact.

       index_i = round(i * (total - 1) / (count - 1)),  i = 0 .. count-1

2. `--weighted` distributes frames by visual change instead of by time.
   A shot that holds still for two seconds does not deserve the same number of
   frames as two seconds of a character entering. With uniform sampling those
   still stretches read as "the animation froze while I was still scrolling".
   Weighted sampling spends the budget where the picture is actually moving.

   The weight is damped (`w = a + (1-a) * m/mean(m)`, a = 0.35) so a quiet beat
   still gets a few frames — a pure motion proportion would delete it entirely.

Requires: ffmpeg, ffprobe, Pillow, numpy.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image


# ----------------------------------------------------------------- probe ----

def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration,codec_name",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = (s.get("r_frame_rate") or "24/1").split("/")
    return {
        "width": int(s["width"]),
        "height": int(s["height"]),
        "fps": float(num) / float(den or 1),
        "frames": int(s.get("nb_frames") or 0),
        "duration": float(s.get("duration") or 0),
        "codec": s.get("codec_name", "?"),
    }


def count_frames(path: Path) -> int:
    """nb_frames is missing or wrong in some containers; count for real."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return int(out or 0)


# ---------------------------------------------------------------- sample ----

def uniform_indices(total: int, count: int, start: int = 0, end: int | None = None) -> list[int]:
    end = (total - 1) if end is None else end
    if count < 2:
        raise SystemExit("--count must be >= 2")
    span = end - start
    if count > span + 1:
        raise SystemExit(f"--count {count} exceeds the {span + 1} available frames")
    idx = [start + round(i * span / (count - 1)) for i in range(count)]
    if len(set(idx)) != count:  # only possible with a pathological span
        raise SystemExit("sampled indices collided; reduce --count")
    return idx


def motion_profile(path: Path, width: int = 256) -> np.ndarray:
    """Mean absolute difference between consecutive frames, at low resolution.

    Decodes the whole clip into memory at `width` px: roughly 0.4 MB per frame
    at the default 256, so a 25-second 30 fps source needs ~350 MB. Fine for the
    10-30 second clips a scroll sequence is built from; if you are pointing this
    at something long, lower `width` or cut the source down first.
    """
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path),
             "-vf", f"scale={width}:-1", "-vsync", "0", f"{td}/f_%06d.png"],
            check=True)
        files = sorted(Path(td).glob("*.png"))
        arrs = [np.asarray(Image.open(f).convert("RGB"), dtype=np.float32) for f in files]
    d = np.array([np.abs(arrs[i + 1] - arrs[i]).mean() for i in range(len(arrs) - 1)],
                 dtype=np.float32)
    return np.append(d, 0.0)


def weighted_indices(motion: np.ndarray, count: int, start: int = 0,
                     end: int | None = None, damping: float = 0.35) -> list[int]:
    end = (len(motion) - 1) if end is None else end
    seg = motion[start:end + 1]
    if seg.size < count:
        raise SystemExit("not enough frames in the selected range")
    mean = float(seg.mean()) or 1.0
    w = damping + (1.0 - damping) * (seg / mean)
    cum = np.concatenate([[0.0], np.cumsum(w)])
    targets = np.linspace(0.0, float(cum[-1]), count)

    raw = [start + int(min(max(np.searchsorted(cum, t), 0), seg.size - 1)) for t in targets]
    out: list[int] = []
    for v in raw:                       # enforce strictly increasing
        out.append(v if not out else max(v, out[-1] + 1))
    out[-1] = end
    for i in range(len(out) - 2, -1, -1):
        if out[i] >= out[i + 1]:
            out[i] = out[i + 1] - 1
    if out[0] < start:
        raise SystemExit("weighted sampling collapsed; lower --count or raise --damping")
    return out


def select_expr(indices: list[int]) -> str:
    return "+".join(rf"eq(n\,{n})" for n in indices)


# ----------------------------------------------------------------- write ----

def render(src: Path, indices: list[int], outdir: Path, prefix: str,
           scale: str | None, quality: int, fmt: str, crop: str | None) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    for old in outdir.glob(f"{prefix}*"):
        old.unlink()
    chain = [f"select='{select_expr(indices)}'"]
    if crop:
        chain.append(f"crop={crop}")
    if scale:
        chain.append(f"scale={scale}:flags=lanczos")
    codec = ["-c:v", "libwebp", "-quality", str(quality), "-compression_level", "6"] \
        if fmt == "webp" else ["-q:v", str(quality)]
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-vf", ",".join(chain), "-vsync", "0", *codec,
         str(outdir / f"{prefix}%03d.{fmt}")],
        check=True)


def report(outdir: Path, fmt: str) -> tuple[int, int]:
    files = sorted(outdir.glob(f"*.{fmt}"))
    total = sum(f.stat().st_size for f in files)
    return len(files), total


def evenness(src: Path, indices: list[int], motion: np.ndarray | None) -> str:
    """How uniform the visual change per sampled step is. Lower CV is smoother."""
    if motion is None:
        return ""
    steps = np.array([motion[a:b].sum() for a, b in zip(indices, indices[1:])], dtype=np.float32)
    if steps.size == 0 or steps.mean() == 0:
        return ""
    cv = float(steps.std() / steps.mean())
    stalls = int((steps < steps.mean() * 0.5).sum())
    return (f"  per-step change: mean {steps.mean():.2f}  cv {cv:.2f}"
            f"  below-half steps {stalls}/{steps.size}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    ap.add_argument("outdir")
    ap.add_argument("--count", type=int, required=True, help="how many frames to produce")
    ap.add_argument("--prefix", default="f_")
    ap.add_argument("--format", choices=["webp", "jpg", "png"], default="webp")
    ap.add_argument("--quality", type=int, default=72,
                    help="WebP quality 0-100, or JPEG -q:v 2-31 (lower is better)")
    ap.add_argument("--scale", default=None, help='e.g. "1920:1080"')
    ap.add_argument("--crop", default=None, help='e.g. "1988:1118:12:0" (applied before scale)')
    ap.add_argument("--start", type=int, default=0, help="first source frame to consider")
    ap.add_argument("--end", type=int, default=None, help="last source frame to consider")
    ap.add_argument("--weighted", action="store_true", help="sample by visual change, not time")
    ap.add_argument("--damping", type=float, default=0.35,
                    help="0 = pure motion weighting, 1 = uniform (default 0.35)")
    ap.add_argument("--ladder", action="store_true", help="report several qualities and exit")
    ap.add_argument("--dump-indices", default=None, help="write the chosen frame indices to JSON")
    a = ap.parse_args()

    src, outdir = Path(a.source), Path(a.outdir)
    if not src.exists():
        raise SystemExit(f"not found: {src}")
    for exe in ("ffmpeg", "ffprobe"):
        if not shutil.which(exe):
            raise SystemExit(f"{exe} is not on PATH")

    info = probe(src)
    total = info["frames"] or count_frames(src)
    print(f"source  {info['width']}x{info['height']}  {info['fps']:.3f} fps  "
          f"{total} frames  {info['duration']:.3f}s  {info['codec']}")

    motion = None
    if a.weighted:
        print("measuring motion ...")
        motion = motion_profile(src)
        total = min(total, len(motion))
        indices = weighted_indices(motion, a.count, a.start, a.end, a.damping)
        print(f"sampling  motion-weighted (damping {a.damping})")
    else:
        indices = uniform_indices(total, a.count, a.start, a.end)
        print("sampling  uniform")
    print(f"  first {indices[:4]} ... last {indices[-4:]}")

    if a.dump_indices:
        Path(a.dump_indices).write_text(json.dumps(indices), encoding="utf-8")

    if a.ladder:
        print("\nquality ladder:")
        qs = (55, 60, 65, 72, 78, 85) if a.format == "webp" else (2, 3, 4, 5, 6)
        with tempfile.TemporaryDirectory() as td:
            for q in qs:
                render(src, indices, Path(td), "t_", a.scale, q, a.format, a.crop)
                n, size = report(Path(td), a.format)
                print(f"  quality {q:>3}: {size / 1048576:6.2f} MB   avg {size / n / 1024:6.1f} KB")
        return

    render(src, indices, outdir, a.prefix, a.scale, a.quality, a.format, a.crop)
    n, size = report(outdir, a.format)
    print(f"\nwrote {n} files to {outdir}  {size / 1048576:.2f} MB  avg {size / n / 1024:.1f} KB")
    line = evenness(src, indices, motion)
    if line:
        print(line)

    if n != a.count:
        print(f"WARNING: expected {a.count} files, got {n}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
