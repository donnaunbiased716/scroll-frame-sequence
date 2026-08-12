# Authoring: getting frames into the player

The player takes an array of URLs and a handful of settings. Where they come
from is deliberately out of scope — but "out of scope" is not the same as
"unimportant", and the thing that produces those URLs is where a scroll sequence
stops being a demo and starts being something a team can actually run.

This page is the design of that thing. It is platform-agnostic: it applies
whether you build it on a low-code site builder, on your own server, or decide
you do not need one at all.

---

## The four jobs

An authoring tool for a scroll sequence only has to do four things.

**1. Turn N images into N URLs.**
Batch upload, sorted by filename. Sort *naturally*, not lexically —
`f_2.webp` must come before `f_10.webp`, which string comparison gets wrong.
Split the digits out and compare them as numbers.

**2. Store that list so it survives.**
Harder than it sounds. See below.

**3. Capture the settings.**
Hold points, the spritesheet grid, the portrait pan schedule. All of it is
plain data; forms are fine.

**4. Show the operator that the order is right.**
One line of text does most of the work here. See below.

---

## Storing the list

### Do not put the list in a single text field

150 URLs at ~100 characters each is roughly 20 kB. Add the rest of a page's
content and you exceed the field's limit, and the write fails.

The failure itself would be findable. What makes it dangerous is a save path
that writes to a client-side cache first:

```
1. write to localStorage   ← always succeeds
2. write to the database   ← failed, error swallowed
```

| who | what they see |
|---|---|
| the editor, with the cache | all 150 frames, correct preview |
| every visitor | nothing |

**Nobody notices**, because the person checking always has the cache.

### Chunk it

Give the URL list its own record type, and store it in chunks:

| field | |
|---|---|
| `sequence_id` | which sequence this belongs to — see the second trap below |
| `chunk_index` | 0, 1, 2 … |
| `urls` | a JSON array of URLs, as a string |
| `total_frames` | how many frames the whole sequence has |

**25 URLs per row** works well: 150 frames becomes 6 rows of about 2.5 kB each.
Small enough that no field limit is anywhere near, few enough that fetching the
whole sequence is one query, not 150.

### Cache it on the client

Write the assembled URL list to `localStorage` as well — about 20 kB, with an
expiry of a week or so.

On a return visit the list is available **synchronously**, so the first paint is
already the sequence rather than a poster waiting on a database round trip.
Re-fetch in the background and replace the cache, which means a frame swap
reaches returning visitors on their next visit at the latest.

| | database reads before the animation can start |
|---|---|
| one row per URL | 150 |
| chunked | 6 |
| **chunked + cached, return visit** | **0** |

That last row is the one that matters. A hero animation that waits on the
network is a hero animation nobody sees the beginning of.

---

## The settings the operator has to be able to set

Everything below is data the player already accepts. The value of the authoring
tool is that a person can change it without touching code — and that the tool
stops them from entering something that will look broken.

### Hold points

| field | what it is | the trap |
|---|---|---|
| `index` | which frame to pin on | 0-based in the player; if your UI is 1-based, convert in one place only |
| `weight` | how much extra scroll distance the hold occupies | see below |
| `weightMobile` | the same, for phones | **must be set separately** — see below |
| `mode` | `loop` or `pingpong` | `make_loop.py` tells you which; do not guess |
| `fps` | playback rate of the loop | **must match how the clip was cut** — see below |
| `frames` | the loop's frame URLs | |
| `framesMobile` | optional lower-resolution set for phones | falls back to `frames` |
| `intro` | optional one-shot, played once on first entry | a move that ends in a pose is not a loop |

**`weight` on the first frame should be 1.** That is the idle animation: it
loops forever while the user sits at the top and is gone the moment they scroll.
Any larger and they have to scroll *through* it before the page starts moving.

**Mobile weight is not the same number.** Phones run a subsampled sequence —
48 frames instead of 150 — so one unit of scroll covers three times as much of
the story. Reusing the desktop weight turns a hold into two and a half screens
of scrolling. Roughly a third of the desktop value is a good starting point.

**`fps` must match how the clip was cut.** 24 frames covering 4 seconds is 6 fps;
48 frames covering the same 4 seconds is 12 fps. Get it wrong and the loop runs
in fast-forward or slow motion, and it will not be obvious why.

### Spritesheet grid

| field | |
|---|---|
| `sheetUrl` | the tiled image |
| `sheetCols` / `sheetRows` | the grid |

`build_spritesheet.py` prints both numbers. **They must match the generation
exactly** — one wrong number and every frame shows the wrong cell, across the
whole animation. Consider storing them alongside the sheet URL rather than as
free-form inputs a human retypes.

### Portrait pan

A JSON schedule (see [`schema/mobile-pan.schema.json`](../schema/mobile-pan.schema.json))
plus `mobileFrameCount`, the number of frames phones subsample down to.

Accept the whole JSON document as a paste-in field rather than building a
keyframe editor. The schedule is authored by looking at the footage, which
happens outside the tool anyway, and a text field that validates against the
schema is more useful than a form that constrains what you can express.

---

## The one screen that saves the most time

Show this line after upload:

```
150 frames, 150 distinct numbers
```

Two numbers that must match. If they do not, the operator has either duplicates
or a gap, and they know it before publishing rather than after.

Three more things worth building, in order of how much grief they prevent:

**Clear-all before re-upload.** Uploading a new set without clearing produces
`f_001-old, f_001-new, f_002-old …` interleaved, at double the count. Offer a
"keep the last uploaded of each number" repair as well — a stable sort keeps
same-numbered entries in upload order, so this is a few lines.

**Name the sequence in the panel title.** If one uploader serves more than one
page and the sequence identifier is hard-coded, uploading on the second page
silently overwrites the first, and the second page still cannot read its own.
Pass the identifier in, and **display it**: "Opening sequence — *home*" in the
title makes the mistake visible before it happens rather than after.

**Never let a write failure be silent.** Especially when the editor's own view
is served from a cache that will mask it. A red box that blocks publishing is
worth more than any amount of preview polish.

---

## Three ways to build it

### A. Do not build one

If only developers update the sequence, you do not need an authoring tool. Put
the `frames/` directory on static hosting and generate a `manifest.json` next to
it with the URL list and the settings. The player reads that.

Cheapest option, no database to corrupt, and it version-controls with the rest
of the site. **Start here** unless a non-developer needs to change the sequence.

### B. A low-code site builder

Workable as long as the platform gives you file upload and a custom data table.
Model the chunked records described above as the table, and build the upload
panel on top.

Both traps on this page bite hardest here, because platform field limits are
rarely documented anywhere prominent and a failed write may not surface at all.

### C. Your own server

An upload endpoint that writes to object storage and returns URLs, a table for
the list, an admin page. The extra work is authentication and upload progress;
the core logic is the same as A.

---

Whichever you pick, what the player wants is unchanged: **a list of URLs and a
few settings.** That is the point of leaving this out of the library — how you
store it is a decision about your team, and it should not be made for you by an
animation component.
