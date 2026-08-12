#!/usr/bin/env python3
"""
Turn a short generated clip into a hold-loop frame set — and tell you honestly
whether it can loop at all.

    python make_loop.py hold.mp4 out/ --count 24
    python make_loop.py hold.mp4 out/ --count 24 --mode auto
    python make_loop.py hold.mp4 out/ --count 24 --intro-until 1.9   # one-shot + loop

The problem this solves
-----------------------
Image-to-video models are commonly told to produce a seamless loop by feeding
the same still as both the first and last frame. In practice that often does not
close: measured across a batch of clips, frame 0 vs the final frame differed
2.3x to 7.7x more than a normal one-step change. Looping such a clip produces a
visible hitch once per cycle.

Three ways out, in the order this tool prefers them:

  ping-pong    Play 1..N then N-1..2. There is no seam at all, by construction.
               Costs nothing except that motion runs backwards half the time,
               which is invisible for breathing, cloth and pulsing light, and
               obvious for anything directional (falling code, drifting smoke,
               wind in one direction).

  cross-fade   Blend the tail into the head over K frames. Excellent for
               stochastic texture (rain, code, particles, fire) because the two
               ends are statistically identical even when not equal. Requires
               removing any camera drift first, otherwise the blend ghosts.
               Note the loop then starts at source frame L, not frame 0.

  sub-segment  Search all frame pairs for the closest match and loop between
               them. Only worth it when the clip genuinely revisits a pose.

`--mode auto` measures directionality and drift and picks one, printing why.

Requires: ffmpeg, ffprobe, Pillow, numpy.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image


def probe_frames(path: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return int(out or 0)


def load_small(path: Path, width: int = 384) -> list[np.ndarray]:
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(path),
                        "-vf", f"scale={width}:-1", "-vsync", "0", f"{td}/f_%05d.png"],
                       check=True)
        return [np.asarray(Image.open(f).convert("RGB"), dtype=np.float32)
                for f in sorted(Path(td).glob("*.png"))]


def luma(a: np.ndarray) -> np.ndarray:
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def best_shift(a: np.ndarray, b: np.ndarray, r: int = 8) -> tuple[float, int, int]:
    la, lb = luma(a), luma(b)
    best = (1e9, 0, 0)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            d = float(np.abs(np.roll(np.roll(lb, dy, 0), dx, 1)[r + 2:-r - 2, r + 2:-r - 2]
                             - la[r + 2:-r - 2, r + 2:-r - 2]).mean())
            if d < best[0]:
                best = (d, dy, dx)
    return best


def flow_bias(frames: list[np.ndarray], step: int = 4, radius: int = 4) -> tuple[float, str]:
    """
    Translational bias: does the picture consistently move one way?

    For a sample of consecutive pairs we find the (dy, dx) shift that best
    aligns them, then look at how consistently those shifts point the same way.
    Falling code, drifting smoke and one-way wind produce a consistent sign;
    breathing, cloth flutter and pulsing light produce shifts that hover at zero.

    Returns (0..1 consistency, human-readable direction).
    """
    small = [np.asarray(Image.fromarray(f.astype(np.uint8)).resize(
        (192, max(1, round(192 * f.shape[0] / f.shape[1]))), Image.BILINEAR), dtype=np.float32)
        for f in frames[::step]]
    if len(small) < 3:
        return 0.0, "n/a"
    vecs = []
    for a, b in zip(small, small[1:]):
        _, dy, dx = best_shift(a, b, radius)
        vecs.append((dy, dx))
    arr = np.array(vecs, dtype=np.float32)
    mag = float(np.hypot(*arr.mean(axis=0)))
    spread = float(np.hypot(*arr.std(axis=0))) or 1.0
    score = float(np.clip(mag / (mag + spread), 0.0, 1.0))
    dy, dx = arr.mean(axis=0)
    if mag < 0.3:
        label = "no consistent direction"
    else:
        v = "down" if dy > 0 else "up"
        h = "right" if dx > 0 else "left"
        label = v if abs(dy) >= abs(dx) else h
    return score, label


def analyse(frames: list[np.ndarray]) -> dict:
    n = len(frames)
    adj = np.array([float(np.abs(frames[i + 1] - frames[i]).mean()) for i in range(n - 1)])
    seam = float(np.abs(frames[-1] - frames[0]).mean())
    lum = np.array([float(luma(f).mean()) for f in frames])
    _, dy, dx = best_shift(frames[0], frames[-1])
    return {
        "frames": n,
        "adjacent_mean": float(adj.mean()),
        "seam": seam,
        "seam_ratio": seam / (float(adj.mean()) or 1.0),
        "luma_amp_pct": float((lum.max() - lum.min()) / (lum.mean() or 1.0) * 100.0),
        "drift": (dy, dx),
        "flow_bias": flow_bias(frames),
    }


def best_subsegment(frames: list[np.ndarray], min_frac: float = 0.6) -> tuple[float, int, int]:
    arr = np.stack(frames)
    n = len(arr)
    minlen = max(2, int(n * min_frac))
    best = (1e9, 0, n - 1)
    for a in range(0, n - minlen):
        diffs = np.abs(arr[a + minlen:] - arr[a]).mean(axis=(1, 2, 3))
        j = int(np.argmin(diffs)) + a + minlen
        d = float(diffs.min())
        if d < best[0]:
            best = (d, a, j)
    return best


def render_indices(src: Path, indices: list[int], outdir: Path, prefix: str,
                   quality: int, scale: str | None) -> list[Path]:
    outdir.mkdir(parents=True, exist_ok=True)
    for old in outdir.glob(f"{prefix}*"):
        old.unlink()
    sel = "+".join(rf"eq(n\,{n})" for n in indices)
    chain = [f"select='{sel}'"]
    if scale:
        chain.append(f"scale={scale}:flags=lanczos")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                    "-vf", ",".join(chain), "-vsync", "0",
                    "-c:v", "libwebp", "-quality", str(quality), "-compression_level", "6",
                    str(outdir / f"{prefix}%03d.webp")], check=True)
    return sorted(outdir.glob(f"{prefix}*.webp"))


def crossfade(paths: list[Path], loop_len: int, blend: int) -> None:
    """
    Rewrite the first `blend` files as a blend of the tail into the head, and
    drop everything past `loop_len`. The loop then starts at source frame
    `loop_len`, so it will not match an exact entry still — use ping-pong when
    the first frame has to line up with the main sequence.
    """
    arrs = [np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) for p in paths]
    out = []
    for i in range(loop_len):
        if i < blend:
            w = i / blend
            out.append(arrs[i + loop_len] * (1 - w) + arrs[i] * w)
        else:
            out.append(arrs[i])
    for i, a in enumerate(out):
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(
            paths[i], "WEBP", quality=75, method=6)
    for p in paths[loop_len:]:
        p.unlink()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    ap.add_argument("outdir")
    ap.add_argument("--count", type=int, default=24)
    ap.add_argument("--mode", choices=["auto", "pingpong", "crossfade", "subsegment", "raw"],
                    default="auto")
    ap.add_argument("--quality", type=int, default=75)
    ap.add_argument("--scale", default=None)
    ap.add_argument("--prefix", default="h_")
    ap.add_argument("--blend", type=int, default=4, help="cross-fade length in frames")
    ap.add_argument("--intro-until", type=float, default=0.0,
                    help="seconds of one-shot intro to split off (e.g. an arm rising)")
    ap.add_argument("--fps", type=float, default=24.0, help="source fps, for --intro-until")
    ap.add_argument("--report", default=None, help="write the measurements to JSON")
    a = ap.parse_args()

    src, outdir = Path(a.source), Path(a.outdir)
    total = probe_frames(src)
    small = load_small(src)
    m = analyse(small)

    print(f"source          {m['frames']} frames")
    print(f"adjacent change {m['adjacent_mean']:.2f}")
    print(f"first->last     {m['seam']:.2f}  = {m['seam_ratio']:.1f}x a normal step"
          f"   {'closes cleanly' if m['seam_ratio'] < 1.5 else 'does NOT close'}")
    print(f"luma amplitude  {m['luma_amp_pct']:.1f}%"
          f"   {'stable' if m['luma_amp_pct'] < 5 else 'flickers - check the source'}")
    print(f"camera drift    dy={m['drift'][0]:+d} dx={m['drift'][1]:+d}"
          f"   {'none' if max(map(abs, m['drift'])) <= 1 else 'present'}")
    bias, where = m["flow_bias"]
    print(f"flow bias       {bias:.2f} ({where})"
          f"   {'safe to reverse' if bias < 0.5 else 'reversing WILL be visible'}")

    mode = a.mode
    if mode == "auto":
        if m["seam_ratio"] < 1.5:
            mode, why = "raw", "the clip already closes on its own"
        elif bias >= 0.5:
            mode, why = "crossfade", f"motion runs consistently {where}, so reversing it would show"
        else:
            mode, why = "pingpong", "no consistent direction, and ping-pong removes the seam entirely"
        print(f"\nchosen mode     {mode}  ({why})")
        if mode == "pingpong":
            print("                if you can see the motion run backwards, "
                  "rerun with --mode crossfade")
        if mode == "crossfade" and max(map(abs, m["drift"])) > 1:
            print("                WARNING: the camera drifts, so the blend may ghost. "
                  "Consider --mode subsegment or de-drifting the source first.")

    intro_n = int(round(a.intro_until * a.fps)) if a.intro_until > 0 else 0
    if intro_n:
        k = max(2, round(a.count * intro_n / total))
        idx = [round(i * (intro_n - 1) / (k - 1)) for i in range(k)]
        render_indices(src, idx, outdir, "intro_", a.quality, a.scale)
        print(f"\nintro           {k} frames from 0..{intro_n} (play once)")

    start = intro_n
    end = total - 1
    if mode == "subsegment":
        _, sa, sj = best_subsegment(small)
        start, end = max(start, sa), sj
        print(f"loop segment    source frames {start}..{end}")

    span = end - start
    n = a.count if mode != "crossfade" else a.count
    idx = [start + round(i * span / (n - 1)) for i in range(n)]
    paths = render_indices(src, idx, outdir, a.prefix, a.quality, a.scale)

    if mode == "crossfade":
        loop_len = max(2, len(paths) - a.blend)
        crossfade(paths, loop_len, a.blend)
        paths = sorted(outdir.glob(f"{a.prefix}*.webp"))
        print(f"cross-fade      {a.blend} frames blended, loop length {len(paths)}")
        print("                NOTE: the loop now starts at source frame "
              f"{idx[loop_len]}, not frame 0 — if it must match an entry still, use ping-pong")

    size = sum(p.stat().st_size for p in paths)
    print(f"\nwrote           {len(paths)} frames  {size / 1024:.0f} KB  -> {outdir}")
    print(f"player          mode: '{'pingpong' if mode == 'pingpong' else 'loop'}'"
          f"   cycle: {(len(paths) - 1) * 2 if mode == 'pingpong' else len(paths)} steps")

    if a.report:
        Path(a.report).write_text(json.dumps({**{k: v for k, v in m.items() if k != "flow_bias"},
                                             "flow_bias": bias, "flow_dir": where,
                                             "mode": mode, "count": len(paths)},
                                             indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
