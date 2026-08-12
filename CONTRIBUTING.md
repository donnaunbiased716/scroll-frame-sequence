# Contributing

This is maintained by one small studio, so the honest expectation first: issues
get read, and a reply may take a few days. Nothing here is abandoned.

## The most useful thing you can send

**A measurement.** This project's whole claim is that the numbers are real, and
several of them came out worse than we estimated. If your material behaves
differently — a different generator, a different codec, a different phone — the
number is worth more than an opinion, and it goes in
[docs/lessons.md](docs/lessons.md) with credit.

## Reporting a bug

Please include:

- What you saw, and what you expected instead.
- **The output of `?seqdebug=1`** at the moment it goes wrong. Add it to your
  URL and a diagnostic overlay appears bottom-left. That one line usually
  identifies the problem on its own.
- Frame count, `heightVh`, and whether it happens on a phone, a desktop, or both.

Two things that look like bugs and are not, worth checking first:

- **Nothing moves at all.** Something in your CSS has `overflow-x: hidden` on
  `<html>`, which turns it into a scroll container and silently stops
  `position: sticky` working for every descendant on the page. Use
  `body { overflow-x: clip }` instead.
- **A hold loop plays twice and stops.** Its `weight` is too small and you
  scrolled past it. Raise `weight` *and* `heightVh` together.

## Pull requests

- `npm test` must pass. No dependencies to install — the tests run on Node's
  built-in runner.
- Keep the player dependency-free. That constraint is a feature, not an
  oversight.
- If you change behaviour, add a test that fails without your change. The
  existing tests are behaviour-level, not unit-level; match that.
- Comments should say *why*, not *what*. The code already says what.

## What this project is not

Requests to add a CMS, an uploader, or a storage backend will be declined —
[docs/authoring.md](docs/authoring.md) explains how to build those yourself, on
any stack, and why the choice should stay yours.

For a 360° product spin, or a sequence that plays at high frame rate on its own,
a playback-oriented renderer is the better tool. See
[When to use something else](README.md#when-to-use-something-else).

## Media

No image, video, or frame assets in pull requests. The two demo animations in
`docs/` are the only exceptions and they are covered by a separate copyright
line — see [Licence](README.md#licence).
