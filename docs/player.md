# How the player works

Roughly 600 lines, no dependencies. This page explains the decisions rather than
the lines; the source is commented where a line is surprising.

---

## 1. Structure

```html
<section class="sfs-root" style="height: 650vh">   <!-- creates the scroll distance -->
  <div class="sfs-sticky">                          <!-- stays on screen -->
    <div class="sfs-sheet"></div>                   <!-- fast-load layer -->
    <img class="sfs-frame sfs-a" />                 <!-- full-res, alternating -->
    <img class="sfs-frame sfs-b" />
    <img class="sfs-hold" />                        <!-- hold loop -->
    <div class="sfs-dim"></div>
    <div class="sfs-slot"></div>                    <!-- your content -->
  </div>
</section>
```

The outer section's height *is* the scroll distance. The sticky child is what the
user sees.

> **`position: sticky` fails silently.** If any ancestor — most often `<html>` —
> has `overflow-x: hidden`, it becomes a scroll container and sticky stops
> working for every descendant, with no error. Use `body { overflow-x: clip }`.
> This costs people a whole afternoon roughly once per project.

## 2. Progress

```js
const rect = el.getBoundingClientRect();
const distance = Math.max(1, el.offsetHeight - window.innerHeight);
const p = clamp(-rect.top / distance, 0, 1);
```

`offsetHeight - innerHeight` because the first viewport-height of scrolling is
spent bringing the section into place; only the remainder moves the sequence.

## 3. Scroll must not go through framework state

This is the difference between smooth and janky.

`progress` is continuous — every wheel notch fires. If each one triggers a state
update you get a memo recompute, a new style object and a diff of the subtree.
But the picture only changes every ~18 px. A 150-frame sequence over 4950 px
changes 150 times while the scroll handler fires thousands of times, so **more
than 90% of that work produces no visible change**, all of it on the main thread.

Instead:

```js
const onScroll = () => {
  if (rafId) return;                              // coalesce to one per frame
  rafId = requestAnimationFrame(apply);
};

const apply = () => {
  const index = /* ... */;
  if (index === lastIndex) return;                // nothing changed, stop here
  showFrame(index);                               // write the DOM directly
};
```

The whole scroll runs without a single re-render.

**If a caller genuinely needs continuous progress** — text that cross-fades with
scroll position, say — quantise it. Rounding to 0.5% gives about 200 updates
across the whole section, which is far below one-per-frame and still fine-grained
enough that a 7%-per-step opacity ramp shows no stepping.

## 4. Two alternating `<img>` elements

Assigning `.src` on a visible `<img>` paints a blank while the new bitmap
decodes. On a full-screen background that blank is a flash of whatever is
underneath.

Write into the hidden layer, and **swap opacity only once the new bitmap can
paint** — `img.decode()` resolving, or `load` as the fallback. The outgoing frame
stays visible for exactly as long as it takes, and the change is invisible.

Flipping in the same tick as the `.src` write is the mistake this is meant to
prevent: the old frame is hidden immediately while the new one is still
undecoded, so for a moment neither paints and you get the flash back — with two
layers instead of one and nothing to show for it.

Fast scrolling queues several of these at once, so each swap carries a token and
a decode that finishes late simply loses to the newer frame.

Keeping a reference to every `Image` you preload matters too: it keeps the
decoded bitmap alive, so re-assigning the same URL later is instant rather than a
fresh decode.

## 5. Scroll budget with holds

Every frame costs 1 unit. A hold costs its `weight` on top.

```
total units = frames + sum(hold.weight)
```

Segments are built once and searched with a binary search per scroll frame:

```js
segments = [{ start, end, index, hold }, ...]
```

Worked example — 150 frames, `heightVh: 650`, 900 px viewport, holds of weight
1 / 60 / 60:

| | |
|---|---|
| total units | 150 + 1 + 60 + 60 = 271 |
| scroll travel | (650 − 100) / 100 × 900 = 4950 px |
| one unit | 18.3 px |
| hold weight 1 | 37 px — one flick and you are past it |
| hold weight 60 | 1100 px ≈ 1.2 screens |

**`heightVh` and `weight` have to move together.** Increasing weight alone steals
distance from the ordinary frames and makes them fly past.

`weight: 1` on frame 0 is the idle-animation idiom: it loops indefinitely while
the user sits at the top and disappears the instant they scroll.

## 6. Hold playback

### Timing from the clock, not from a timer

```js
const step = Math.floor((now - t0) / interval);
const k = ((step % period) + period) % period;
```

`setInterval` drifts, and browsers throttle it in a background tab then fire
several callbacks at once on return — which looks like the loop skipping. Driving
the index from elapsed real time inside a rAF fixes both.

`period` is `N` for `loop` and `(N-1) * 2` for `pingpong`, so ping-pong plays
`0..N-1` then `N-2..1` and never repeats an endpoint.

### Readiness check

The longest-lived bug in this component: a loop starts before its frames have
downloaded, `.src` paints blank, the main sequence flashes through, the image
lands and covers it — over and over.

```js
if (url && isReady(url) && idx !== shown) node.src = url;
```

Skip the frame instead of showing a blank. The loop looks coarse for a moment and
then heals itself — no loading state, no spinner, no flash.

### Optional one-shot intro

Some hold points are not loops. If a hold has an `intro` array, it plays once on
first entry and then hands over to the loop. Scrolling away and back does not
replay it, because replaying "the arm rises into position" every time the user
returns looks broken.

## 7. Loading

Three layers, no coordination needed:

```
spritesheet   one request, low resolution, scrollable in about a second
full frames   binary-subdivision order, 6 at a time
hold loops    fetched within `holdLookahead` (40) frames of the hold
```

The reason no coordination is needed: an `<img>` whose `src` has not decoded does
not paint. The layer underneath shows through, and when the bytes land the upper
layer covers it. There is no state to get wrong.

**Binary subdivision** (`0 → N-1 → mid → …`) so partial loading still covers the
whole storyline. Sequential order leaves the ending unwatchable until the very
end of the download.

**Lookahead for holds** because loading all of them first put ~9 MB in front of
the thing the user is actually looking at. 40 frames of warning is roughly 700 px
of scrolling — comfortably enough time.

## 8. Phones

| | desktop | phone |
|---|---|---|
| frames | 150 | 48, subsampled in the browser |
| bytes | ~5 MB | ~1.6 MB |
| spritesheet | yes | no |
| holds | yes, at full resolution | yes, optionally at lower resolution |
| scroll travel | 650vh | 450vh |

Subsampling happens client-side, so no second set of files is needed. Hold
indices are authored against the full list and remapped automatically.

**Holds stay on mobile.** They are the only moments in the whole sequence with
any dwell time; removing them means most of your visitors never see the parts you
spent the most effort on. Reduce `weightMobile` instead — the phone's scroll
travel is shorter, so the same weight feels much longer.

No spritesheet on mobile, deliberately: there is no `contain` letterbox to fill,
and a stale cover-fitted still underneath shows through the black bars.

`onProgress` always reports the index in the **full** sequence, so copy cues
written against desktop frame numbers keep working.

## 9. Portrait panning

See the [README](../README.md#portrait-phones-pan-in-the-browser) for the
schedule format. Two implementation notes:

`cx` is a ratio because the crop window depends on the device:

```js
const scaledW = viewportH * (16 / 9);
const overflow = scaledW - viewportW;
const left = clamp(cx * scaledW - viewportW / 2, 0, overflow);
return `${(left / overflow) * 100}% 50%`;
```

`object-position` percentages are relative to the *overflow*, not the image,
which is why this has to be computed live rather than baked in.

`cx` interpolates with smoothstep, not linearly. Linear interpolation between
keyframes produces a visible velocity change at each one; smoothstep eases in and
out and reads as a real camera move.

## 10. Debug overlay

`?seqdebug=1` prints progress, frame index, hold state, loop count, load
progress, pan position and the current filename. The filename is the fastest way
to catch an ordering mistake — if the last frame is `f_149` rather than `f_150`,
you know immediately.
