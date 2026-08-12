# Producing the material

Everything on this page is measured output from real sequences, including the
estimates that turned out wrong.

---

## 1. Source video

| | |
|---|---|
| Length | 12–25 s per segment. Longer segments are harder to sample evenly |
| Resolution | whatever the generator gives you; 720p is common |
| Bitrate | the highest you can get — every frame becomes a still, so per-frame detail matters more than for streaming |
| Cuts | avoid them. A scroll sequence reads as one continuous camera move; hard cuts look like a bug |

If the source is generated with an image-to-video model, keep the camera locked
or moving at a constant rate. A drifting camera is invisible when playing at
24 fps and very visible when the user is inching through frame by frame.

## 2. Upscaling

Most generators cap at 720p. A full-bleed background on a 1920-wide display is
therefore a 1.5x enlargement, and on 2560 a 2x one — visibly soft.

`ffmpeg`'s `scale` is interpolation; it spreads the same information over more
pixels and adds nothing. Real sharpening needs super-resolution.

Two paths, in order of preference:

1. **A dedicated upscaler** (Topaz Video AI and similar). Keep the frame rate
   unchanged — some presets silently interpolate to 60 fps, which multiplies your
   frame count and invalidates every index you calculated. Export at a high
   bitrate; it is an intermediate file, size does not matter.
2. **Real-ESRGAN 4x, then Lanczos down to the target.** Over-enlarging and
   reducing gives cleaner edges than a direct 1.5x. On CPU this is slow — measure
   before committing:

   | model | seconds per 720p frame (2 cores) | 150 frames |
   |---|---|---|
   | `RealESRGAN_x4plus` | ~397 | ~16.5 h |
   | `realesr-animevideov3` | ~8–20 | ~25–50 min |

   The lighter model is dramatically faster and, at 1:1 viewing size on a
   full-screen background, hard to tell apart. At 300% pixel-peep the heavier
   model is clearly better — but that is not the viewing condition.

**Only upscale the frames you keep.** Extract the N frames you need first, then
upscale those. Upscaling all 577 frames of a 24-second clip to throw away 457 of
them is pure waste.

## 3. Sampling

```
index_i = round(i * (total - 1) / (count - 1)),  i = 0 .. count-1
```

Get `total` from `ffprobe -count_frames`; the `nb_frames` header lies in some
containers.

Do not use `-vf fps=N/duration`. It resamples the timeline, gives N or N+1 files
depending on rounding, and does not guarantee the true first and last frames —
which are the two the user looks at longest.

### Uniform or motion-weighted

Uniform is correct when the source moves at a roughly constant rate.

Motion-weighted is better when it does not. Measure the per-frame change first:

```bash
python tools/extract_frames.py in.mp4 out/ --count 89 --weighted
#   per-step change: mean 13.42  cv 0.38  below-half steps 8/88
```

`cv` is the coefficient of variation of visual change per scroll step; lower is
smoother. `below-half steps` counts the steps that will read as stalled.

Measured on the same 16-second source:

| | uniform | weighted |
|---|---|---|
| cv | 0.73 | **0.38** |
| stalled steps | 29 / 88 | **8 / 88** |

Weighting is damped by default (`--damping 0.35`, i.e. `w = 0.35 + 0.65·m/mean`).
Pure proportionality deletes deliberately quiet beats; a still moment usually
needs a few frames to register as a moment.

### Trim dead tails before sampling

Generated clips often end on a completely frozen second. Sampled uniformly, that
becomes 5–6 identical files and the scroll appears to hang right at the end.
Measure and cut:

```bash
# find where motion stops, then
python tools/extract_frames.py in.mp4 out/ --count 61 --end 264
```

## 4. Encoding

| | |
|---|---|
| Format | WebP |
| Quality | 72 as a starting point |
| `-compression_level` | 6 — no quality cost, 2–3% smaller, a few seconds slower |
| Naming | `f_001.webp` … zero-padded, contiguous |

Run the ladder before choosing:

```bash
python tools/extract_frames.py in.mp4 out/ --count 150 --ladder
```

### Real numbers, so your estimates start closer than ours did

| set | format | total | per frame |
|---|---|---|---|
| 150 x 1280x720 | JPEG `-q:v 3` | 10.37 MB | 70.8 KB |
| 150 x 1280x720 | WebP q75 | 4.88 MB | 33.3 KB |
| 150 x 1920x1080, upscaled | WebP q72 | 8.04 MB | 54.9 KB |
| 150 x 1920x1080, native down-sample | WebP q72 | 12.42 MB | 84.8 KB |
| 120 x 1920x1080, upscaled | WebP q65 | 7.17 MB | 61.2 KB |

Three things worth internalising:

**WebP saved 53%, not the 60–70% usually quoted.** That figure assumes a
high-quality JPEG baseline. Ours was already compressed at `-q:v 3`, so there was
less to win.

**Native detail costs more than upscaled detail.** The 12.42 MB set is *larger*
than the 8.04 MB one at the same resolution because it carries real information;
the upscaled set is smoother and therefore compresses better. Smaller is not
better here — it means less is there.

**Denoising to save bytes does not work on this material.** Light `hqdn3d`
recovered 7% and cost visible detail. When the frames are full of fine
high-frequency detail, the size *is* the content.

## 5. Spritesheet

```bash
python tools/build_spritesheet.py frames/ sheet.webp --cols 9
```

Pick `--cols` so the grid is close to full. 120 frames at 12 columns is exactly
10 rows with no blank cells; 150 at 9 columns is 17 rows with 3 spare.

Decoded memory is the binding constraint, not file size — see the table in the
[README](../README.md#the-spritesheet-has-to-be-small-for-a-reason-that-is-not-file-size).
Keep the cells at 640x360 unless you have measured otherwise.

Expected size for 150 cells at 640x360, quality 75: **2.0–2.9 MB**. If your
material is full of high-frequency detail you will not get under 1.5 MB, and
dropping quality will not save you — from q75 to q55 recovered only 20% and cost
real quality. Reduce cell size or frame count instead.

Blank cells are filled black but lossy WebP will not round-trip them to exactly
zero (measured maximum 20–30). Detect them with a threshold.

## 6. Hold loops

```bash
python tools/make_loop.py hold.mp4 out/ --count 24
```

Ask the generator for 4–5 seconds, a locked camera, constant lighting and small
motion only. Then verify rather than assume — the tool reports:

| measurement | pass |
|---|---|
| first frame vs the sequence frame it sits on | MAE < 3 |
| luminance amplitude across the clip | < 5% |
| camera drift, first vs last | ≤ 1 px at 384-wide |
| seam, first vs last, relative to a normal step | < 1.5x to loop as-is |

If the first frame does not match the sequence frame underneath, the switch into
the hold will visibly jump. Feed the exact still from your sequence as the
generator's first frame and check the number afterwards.

A one-shot entry animation — an arm rising into its final pose, say — is not a
loop and cannot be made into one. Split it:

```bash
python tools/make_loop.py hold.mp4 out/ --count 24 --intro-until 1.9
```

The player takes `intro` (played once) and `frames` (looped) separately.

## 7. Review

Never ship without looking at a contact sheet:

```bash
python tools/contact_sheet.py frames/ survey.png --cols 10 --mark 1,75,150
```

`--mark` takes the frames you hold on, so they are easy to find on the sheet.

Check, in this order:

1. Frame 1 and frame N are the right pictures.
2. Every beat you care about has coverage — if the sequence is built around a
   handful of reveals, each one needs frames near it.
3. Nothing repeats. Runs of visually identical frames mean the sampling needs
   trimming or weighting.
4. Your anchor object (a table, a horizon, a product) does not drift or morph.
   In a moving-camera shot, compare a crop of the anchor across frames rather
   than aligning whole frames — whole-frame alignment is meaningless when the
   camera is moving on purpose.
