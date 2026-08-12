# Lessons

What broke, what was measured, and what is not worth trying again. Kept separate
from the how-to pages because this is the part that usually is not written down.

---

## Three bugs that produce no error message

### `overflow-x: hidden` on `<html>`

```css
html, body { overflow-x: hidden; }   /* ✗ */
body { overflow-x: clip; }           /* ✓ */
```

Setting `overflow-x: hidden` on `<html>` makes it a scroll container, and
`position: sticky` **stops working for every descendant on the page**. No error,
no warning. The sequence simply does not move, and the natural assumption is that
the sequence code is broken.

`clip` clips the same overflow without creating a container.

### <a id="storage"></a>Frame URLs in a single CMS field

150 URLs at ~100 characters each is roughly 20 KB. Add the rest of a page's
content and it overflows the field's limit, and the database write fails.

That alone would be findable. What made it dangerous was the save path:

```
1. write to localStorage   ← always succeeds
2. write to the database   ← failed
```

with the failure swallowed by `.catch(console.error)`. The result:

| who | what they saw |
|---|---|
| the editor, with `localStorage` | all 150 frames, correct preview |
| every visitor | nothing |

**Nobody notices**, because the person checking always has the cache.

Two fixes, both worth having: store frame URLs in their own record, chunked
(25 URLs per row, ~2.5 KB each), and never let a write failure be silent when the
editor's own view is served from a cache that will mask it.

### A hard-coded key shared by two sequences

One uploader served two pages, but the storage key was hard-coded to `'home'`.
Uploading on the second page overwrote the first page's frames, and the second
page still could not read its own.

Pass the key in, and **display it in the UI**. "Opening sequence — *home*" in the
panel title makes a mistake visible before it happens rather than after.

---

## Estimates that were wrong

Recording these because the wrong number is more useful than the right one: it
tells you which way your intuition leans.

| estimate | actual | why |
|---|---|---|
| WebP saves 60–70% vs JPEG | **53%** | the quoted figure assumes a high-quality JPEG baseline; ours was already compressed |
| spritesheet fits in 800 KB – 1.5 MB | **2.0–2.9 MB** | high-frequency material, 150 distinct frames, nothing to deduplicate |
| lower quality will fix the size | **it will not** | q75 → q55 saved 20% and cost visible quality; from 12.4 MB, five settings spanned only 1.2 MB |
| denoising will save bytes | **7%** | it was not noise, it was detail |
| upscaled and native look similar in size | **native is 55% larger** | the upscaled frames are smoother, so they compress better — smaller here means less information |

The pattern: **compression settings are a weak lever once the material is
detailed.** The strong levers are frame count and resolution, and both change
your grid numbers, so decide early.

---

## Generated material

### Loops do not close, even when you ask for one

The standard advice is to feed the same still as first and last frame so the
model returns to its starting pose. Measured across one batch of clips, frame 0
versus the final frame, expressed as a multiple of a normal one-step change:

| clip | ratio |
|---|---|
| A — tight close-up, small motion | 4.2x |
| B — wide shot, several subjects | 6.3x |
| C — same framing, less motion | 7.7x |
| D — flat background, low contrast | 2.3x |

A perfect loop would be near 1.0. **Assume the clip does not close and pick a
playback mode that does not need it** — ping-pong is free and removes the seam by
construction.

Different generators differ here. Measure yours before designing around it.

### Trying to salvage a broken loop by trimming usually fails

For one clip with a mid-loop lighting drop, splicing out the dark section made
the seam *worse*: 19.2 versus 9.6 for the original, against a normal step of 4.5.
Cutting a segment out removes the frames that made the two ends similar.

### An intro is not a loop

A one-shot move that ends in a pose — an object rising into position and staying
there — cannot loop. The first and last frames differ by design, and looping it
plays the move in reverse over and over, like a wave. Split it into a one-shot
intro plus a loop, and do not replay the intro when the user scrolls back.

---

## Judgement calls, not bugs

Worth naming because they keep coming back and there is no correct answer.

**A 9:16 window cannot hold two subjects at opposite edges.** This is geometry,
not an algorithm. Either letterbox and accept that everything is smaller, or pick
a side and lose the other. The only wrong move is deciding silently.

**Motion-weighted sampling is better on average and needs damping.** Pure
proportional weighting deletes deliberately quiet beats — and a held moment often
*is* the point. `w = 0.35 + 0.65·m/mean` keeps a few frames on the quiet parts.

**More frames is not better.** Below ~10 px per frame you are paying for
detail nobody can perceive at scroll speed.

**Ping-pong reverses the motion.** For breathing, cloth, flickering light — free.
For falling code, drifting smoke, one-way wind — visible, and a cross-fade or a
regeneration is the honest answer. No measurement decides this reliably; look at
the clip.

---

## Review discipline

The habit that caught the most problems, in order of value:

1. **A numbered contact sheet before shipping anything.** "Frame 61 is wrong" is
   actionable; "something in the middle looks off" is not.
2. **Compare at actual display size, not zoomed in.** A face that occupies 130 px
   on the final page does not need to survive a 300% pixel-peep, and judging by
   pixel-peep leads you to spend hours on differences nobody will ever see.
3. **Measure the join, do not eyeball it.** Mean absolute difference between two
   frames, expressed as a multiple of a normal step, tells you in one number
   whether a cut will be visible.
4. **Report the estimates that missed.** Every wrong number above came from
   writing the estimate down first. Without that, the result is just a number and
   nothing gets learned.
