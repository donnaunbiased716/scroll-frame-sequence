# scroll-frame-sequence

Scroll-driven image sequences with hold loops — the Apple-product-page effect,
plus the parts nobody documents.

A `<section>` scrolls; a video plays frame by frame under the user's finger.
Stop scrolling and it stops on that frame. Scroll back and it runs backwards.
At chosen frames it can **hold** and play a small looping animation, so a
"frozen" moment still breathes.

Two halves, usable independently:

- **`tools/`** — turn a video into the frames, the spritesheet and the hold
  loops, with the measurements that tell you whether the result is any good.
- **`src/`** — a ~530-line, zero-dependency player that plays them without ever
  re-rendering your framework.

Everything here came out of shipping it, not out of a blog post. The numbers in
the docs are measured, including the ones that came out worse than expected.

---

## Why not just use `<video>`

| | `<video autoplay>` | scroll sequence |
|---|---|---|
| Playback speed | the file decides | **the user's hand decides** |
| Stopping | pause only | **stops on that exact frame** |
| Reversing | scrub the timeline | **scroll up** |
| Syncing copy to picture | listen to `timeupdate` | **same progress value, free** |
| Mobile autoplay | `muted` + `playsinline`, still blocked sometimes | **not a thing** |

The cost is bandwidth shape, not bandwidth size. A 25-second H.264 clip is about
7 MB and streams; the same content as 150 WebP frames is about 5 MB but wants to
be there before the user scrolls. **Most of this project is about making that not
matter** — see [three-layer loading](#three-layer-loading).

---

## Install

The player is two files with no build step and no dependencies — install it, or
just copy them into your project.

```bash
# player
npm install scroll-frame-sequence
# or copy src/scroll-sequence.js and src/scroll-sequence.css

# tools
pip install -r tools/requirements.txt   # Pillow, numpy; also needs ffmpeg
```

```js
import { ScrollSequence } from 'scroll-frame-sequence';
import 'scroll-frame-sequence/style.css';
```

---

## Quick start

### 1. Make the frames

```bash
python tools/extract_frames.py source.mp4 frames/ \
    --count 150 --scale 1920:1080 --quality 72 --weighted

python tools/build_spritesheet.py frames/ spritesheet.webp --cols 9
#   -> prints: sheetCols 9, sheetRows 17, and the CSS offset formula
```

### 2. Play them

```html
<link rel="stylesheet" href="scroll-sequence.css" />
<section id="hero"></section>

<script type="module">
  import { ScrollSequence } from './scroll-sequence.js';

  new ScrollSequence('#hero', {
    frames: Array.from({ length: 150 }, (_, i) =>
      `/frames/f_${String(i + 1).padStart(3, '0')}.webp`),
    sheetUrl: '/spritesheet.webp',
    sheetCols: 9,
    sheetRows: 17,
    heightVh: 650,
    dim: 0.35,
    onProgress: (p, frame, total) => {
      caption.textContent = `${frame + 1} / ${total}`;
    },
  });
</script>
```

That is the whole basic case. [`examples/`](examples/) has a runnable version and
one with hold loops.

---

## The parts that are easy to get wrong

### How many frames?

Not "how many seconds" — **how many scroll pixels each frame gets**.

```
pixels per frame = (heightVh - 100) / 100 * viewportHeight / frameCount
```

| px per frame | how it reads |
|---|---|
| under 10 | too dense — you pay for frames nobody can perceive |
| **15 – 20** | the comfortable band (Apple's AirPods page sits at ~18.5) |
| over 30 | visibly steppy |

Two configurations that shipped:

| section | frames | `heightVh` | px/frame |
|---|---|---|---|
| full-screen hero | 150 | 650 | 18.3 |
| shorter mid-page section | 120 | 320 | 16.5 |

### Sample by frame index, never with `fps`

`ffmpeg -vf fps=150/28` resamples the timeline. You get 150 or 151 files
depending on rounding, and neither the true first nor the true last frame is
guaranteed to survive. Those two frames are exactly the ones a user stares at
longest — the opening still and the final held pose.

```
index_i = round(i * (total - 1) / (count - 1)),  i = 0 .. count-1
```

`extract_frames.py` does this. It is not a preference; `fps` sampling silently
loses your endpoints.

### Sample by motion, not by time

Uniform sampling spends the same number of frames on two seconds of a locked-off
hold as on two seconds of a character entering. The held part then reads as
*"the animation froze while I was still scrolling"*.

`--weighted` distributes the budget by how much the picture actually changes.
Measured on a 16-second clip, 89 frames:

| | uniform | motion-weighted |
|---|---|---|
| coefficient of variation of per-step change | 0.73 | **0.38** |
| steps below half the mean ("feels stuck") | 29 | **8** |

It is damped (`w = 0.35 + 0.65 * m/mean`), because pure proportionality deletes
quiet beats entirely and those beats are usually deliberate.

### The spritesheet has to be small, for a reason that is not file size

A browser decodes an image at `width * height * 4 bytes`, **regardless of how
well it compressed**. For 150 frames:

| cell | sheet | decoded RAM | |
|---|---|---|---|
| 1280x720 | 11520 x 12240 | **538 MB** | crashes phones |
| 960x540 | 8640 x 9180 | 303 MB | too heavy |
| **640x360** | **5760 x 6120** | **134 MB** | use this |
| 480x270 | 4320 x 4590 | 76 MB | visibly soft |

So the sheet is permanently a low-resolution layer. Its job is *let the animation
move immediately*; sharpness is the full-resolution frames' job.

---

## Three-layer loading

```
bottom   spritesheet        ~2 MB, one request, animation is scrollable in a second
middle   full-res frames    ~5 MB, streams in, each frame covers the sheet as it lands
top      hold loops         fetched only when the user gets near one
```

No "is it loaded yet" state is needed anywhere. An `<img>` whose `src` has not
decoded simply does not paint, so the layer underneath shows through and the
upgrade happens by itself.

**Preload order is binary subdivision**, not sequential:

```
0 -> 149 -> 75 -> 37 -> 112 -> ...
```

Sequential order means only the opening is watchable until the download is nearly
finished. Subdividing means about a fifth of the bytes already covers the whole
storyline, just coarsely — and coarse-but-complete beats sharp-but-truncated
every time.

**Hold loops load on approach.** Fetching all of them up front once put ~9 MB in
front of the main sequence; the fix was a 40-frame lookahead, which brought the
initial cost down to ~1.6 MB.

---

## Hold loops

A hold pins the sequence at one frame and plays a short loop on top, then hands
back when the user scrolls past. Breathing, flickering neon, hair moving in wind
— enough that a held frame does not read as a hung page.

Scroll budget is in units: every frame costs 1, a hold costs `weight` more.

```
total units = frames + sum(weight)
```

```js
holds: [
  { index: 0,   weight: 1,  mode: 'pingpong', fps: 10, frames: [...] },
  { index: 60,  weight: 60, mode: 'pingpong', fps: 10, frames: [...] },
  { index: 149, weight: 60, mode: 'loop',     fps: 10, frames: [...],
    intro: [...] },   // optional, plays once on first entry
]
```

`weight: 1` on the first frame is the idle animation: it loops forever while the
user sits at the top and is gone the moment they scroll.

### Ping-pong is the feature that makes this practical

Generated clips usually **do not loop**, even when you asked the model for a
seamless one by feeding the same still as first and last frame. Measured across
one batch:

| clip | first vs last, relative to a normal one-step change |
|---|---|
| A — tight close-up, small motion | 4.2x |
| B — wide shot, several subjects | 6.3x |
| C — same framing, less motion | 7.7x |
| D — flat background, low contrast | 2.3x |

Playing `1..N` then `N-1..2` has **no seam at all**, by construction. The only
cost is that motion runs backwards half the time — invisible for breathing,
cloth and pulsing light; obvious for falling code or one-way wind.

`make_loop.py` measures the seam, the camera drift, the luminance stability and
the translational bias, then tells you which mode to use and why:

```
$ python tools/make_loop.py hold.mp4 out/ --count 24
source          97 frames
adjacent change 0.59
first->last     16.96  = 28.9x a normal step   does NOT close
luma amplitude  3.7%   stable
camera drift    dy=+0 dx=-1   none
flow bias       0.00 (no consistent direction)   safe to reverse

chosen mode     pingpong  (no consistent direction, and ping-pong removes the seam entirely)
```

For one-way motion with a locked camera it will pick **cross-fade** instead,
which is excellent on stochastic texture (rain, code, particles) because both
ends are statistically identical even when they are not equal. One caveat it
prints for you: a cross-faded loop starts at source frame `L`, not frame 0, so it
cannot match an exact entry still — use ping-pong when the hold must line up with
the frame underneath it.

### Playback uses rAF, not `setInterval`

`setInterval` accumulates drift, and browsers throttle it in a background tab
then replay several frames at once on return. Deriving the index from real
elapsed time fixes both:

```js
const step = Math.floor((now - t0) / interval);
const k = ((step % period) + period) % period;
```

### Readiness check: the bug that took longest to find

A loop starts playing before its frames have downloaded. Setting `.src` to an
undecoded image paints a blank, the main sequence shows through, the image
arrives and covers it again — repeatedly. It looks like flickering, and it is not
obvious that loading is the cause.

The fix is to skip, not to wait:

```js
if (url && isReady(url) && idx !== shown) node.src = url;   // otherwise hold the current frame
```

The loop is coarse for a moment and then heals itself, with no loading state
anywhere.

---

## Portrait phones: pan in the browser

A 16:9 frame in a 9:16 viewport shows roughly the middle 26–32% of the width.
Centre-cropping a row of subjects spread across the frame shows you one of them.

Rather than shipping a second set of portrait assets, ship **a schedule** —
a few hundred bytes that tell the player where to look:

```json
{
  "totalFrames": 150,
  "interpolation": { "cx": "smooth", "fit": "step" },
  "keyframes": [
    { "frame": 1,   "cx": 0.35, "fit": "cover",   "note": "subject sits left of centre" },
    { "frame": 40,  "cx": 0.50, "fit": "cover",   "note": "39 frames of travel, so it reads as a pan" },
    { "frame": 41,  "cx": 0.50, "fit": "contain", "note": "switch on a frame that already changes" },
    { "frame": 110, "cx": 0.50, "fit": "cover" }
  ]
}
```

- `cx` is a **ratio, not a pixel** — the crop window differs per device, so a
  baked pixel value drifts off on some phones. It interpolates smoothly.
- `fit` is a step function: `cover` fills the screen, `contain` letterboxes so a
  wide composition survives.

Three rules that came from doing it wrong first:

1. **Switch `fit` at most ~4 times.** More reads as flickering layout.
2. **Switch where the picture already changes** — a white flash, a particle
   burst. The transition then hides inside the cut.
3. **Move `cx` across at least 10 frames.** Under 5 looks like a twitch.

And one thing worth accepting: when two important subjects sit at opposite edges,
a 9:16 window mathematically cannot hold both. That is a framing decision, not an
algorithm — pick `contain` and let it be smaller, or pick a side.

---

## Debugging

Add `?seqdebug=1` to the URL:

```
progress 43.2%  frame 61/150  || pingpong 8/24 loop 3  pan 50% contain  ...f_061.webp
```

| symptom | check |
|---|---|
| nothing moves at all | `overflow-x: hidden` on `<html>` — see below |
| last frame is wrong | the filename in the overlay; is it really `f_150`? |
| twice as many frames as expected | duplicate upload; clear before re-uploading |
| loop plays twice and stops | not a bug — `weight` is too small, you scrolled past it |
| flicker on entering a hold | the overlay will say `loading n/N` |

### The one that will cost you an afternoon

```css
html, body { overflow-x: hidden; }   /* ✗ makes <html> a scroll container */
body { overflow-x: clip; }           /* ✓ clips the same overflow, no container */
```

`overflow-x: hidden` on `<html>` turns it into a scroll container, and
`position: sticky` **silently stops sticking for every descendant on the page**.
No error, no warning; the sequence simply does not move.

---

## API

```js
new ScrollSequence(container, options)
```

| option | default | |
|---|---|---|
| `frames` | `[]` | array of image URLs |
| `poster` | `''` | still shown before anything decodes |
| `dim` | `0.35` | black overlay opacity |
| `heightVh` | `500` | section height; this is the scroll distance |
| `sheetUrl` / `sheetCols` / `sheetRows` | — | the fast-load layer |
| `holds` | `[]` | see above |
| `mobilePan` | `[]` | keyframes from the schedule |
| `mobileFrameCount` | `48` | subsample for phones; `0` disables |
| `mobileBreakpoint` | `768` | px |
| `mobileHeightVh` | `0` | `0` reuses `heightVh` |
| `holdLookahead` | `40` | frames of warning before fetching a hold |
| `maxConcurrent` | `6` | parallel image requests |
| `aspect` | `16/9` | source aspect ratio; used to resolve the portrait pan |
| `respectReducedMotion` | `true` | see below |
| `debug` | `null` | `null` auto-detects `?seqdebug=1`; `true`/`false` forces it |
| `onProgress` | — | `(progress, frameIndex, frameTotal)` |
| `onFrame` | — | `(frameIndex)`, only when it changes |

Methods: `update(patch)`, `destroy()`, and `sequence.overlay` for mounting your
own DOM on top.

**`onProgress` always reports the index in the full sequence**, even when the
phone is running a 48-frame subsample — so your copy cues do not need to know
whether subsampling happened.

### Reduced motion

`prefers-reduced-motion` asks for less animation that runs *on its own*. The
sequence itself only advances because the user is scrolling, so it stays. Hold
loops play by themselves, so with `respectReducedMotion` (the default) they do
not start, and their frames are never downloaded. The held frame is still shown
and the hold still occupies its scroll distance, so the page reads identically —
it just stops breathing.

---

## Docs

| | |
|---|---|
| [docs/pipeline.md](docs/pipeline.md) | producing the material, with the numbers |
| [docs/player.md](docs/player.md) | how the player works and why it is built that way |
| [docs/authoring.md](docs/authoring.md) | designing the tool that feeds it, on any stack |
| [docs/lessons.md](docs/lessons.md) | what failed, what was measured, what to stop trying |

Traditional Chinese: [README.zh-TW.md](README.zh-TW.md) ·
[pipeline](docs/pipeline.zh-TW.md) · [player](docs/player.zh-TW.md) ·
[authoring](docs/authoring.zh-TW.md) · [lessons](docs/lessons.zh-TW.md)

---

## Scope

This project does **not** include a CMS, an uploader, or a storage backend.
Frames are URLs; where they come from is your business.

That is a deliberate boundary, not a shrug — how you store the list is a
decision about your team, and an animation component should not make it for you.
But it is also where most of the remaining work lives, so
**[docs/authoring.md](docs/authoring.md)** documents the design of the thing that
produces those URLs: the four jobs it has to do, how to store a 150-URL list so
it survives (chunked records plus a client-side cache — 150 reads becomes 6,
and 0 on a return visit), every setting an operator needs to reach, and the two
failure modes that produce no error message at all.

The shortest version of the worst one: do not put 150 URLs in a single CMS text
field. It overflows, the write fails, and if your save path writes to
`localStorage` first, the editor keeps seeing the correct page while every
visitor sees nothing.

## Licence

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Tangyi Studio Co., Ltd.

Built for [tangyi.mx](https://www.tangyi.mx) and extracted from it. No media
assets are included; bring your own video.
