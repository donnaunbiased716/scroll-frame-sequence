# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- A live demo at [demo.tangyi.mx](https://demo.tangyi.mx), linked from the top
  of the README. Static files on a CDN, no server — which is also the first
  option `docs/authoring.md` recommends.
- **Three portrait modes documented** — `Fit`, `Fill` and `Follow`, each a
  one-line transform of the same schedule. The demo puts them behind a switch
  on phones, because the trade-off is faster to judge by eye than to read.

## [1.0.5] — 2026-08-12

### Fixed

- **The portrait pan was read in subsampled frame numbers.** `_apply()` passed
  the index into the subsampled array to `_applyPan`, but a pan schedule is
  authored against the full sequence. On a phone a 150-frame schedule was read
  as if it had 48 frames: every keyframe past `mobileFrameCount` silently
  stopped applying, and earlier ones landed on the wrong pictures. Desktop was
  unaffected, so the feature was broken only on the device it exists for.
  Upgrade if you use `mobilePan`.

## [1.0.4] — 2026-08-12

### Added

- A second README demo showing the sequence as a page — browser frame, hero
  copy, and a scrollbar to watch — scrubbing down and back up three times.

## [1.0.3] — 2026-08-12

### Added

- An animation in the Hold loops section. It claimed a held frame keeps
  breathing and then showed nothing.

### Changed

- The README demo is now the sequence with a fixed camera and a changing world,
  which reads as frame-by-frame progression at a glance. Blur 6px → 2.5px.

## [1.0.2] — 2026-08-12

### Added

- `docs/authoring.md` (and the Traditional Chinese version) — how to design the
  tool that feeds the player, on any stack. Covers storing a 150-URL list as
  chunked records plus a client-side cache, every setting an operator needs to
  reach, and the two failure modes that produce no error message.
- A demo animation in the README, so the effect is visible before reading
  anything.
- Tests on Node's built-in runner, with no dependencies and no jsdom. `npm test`.
- CI across Node 18/20/22, plus a check that the published tarball stays
  code-only and under 200 kB.
- FAQ, framework usage, and a table of the neighbouring problems this does not
  solve.

### Changed

- Licence wording. It said no attribution was required, which is wrong — MIT
  requires the notice to travel with the source. A *visible* credit is what is
  optional, and that is now stated as a request rather than folded into the
  grant.

## [1.0.1] — 2026-08-12

### Fixed

- `./package.json` added to the `exports` map. On 1.0.0 that path threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, which broke resolvers and bundler plugins
  that read the manifest.

### Changed

- Install instructions point at npm.

## [1.0.0] — 2026-08-12

Initial release.

- Scroll-driven frame sequence player, ~530 lines, zero dependencies.
- Hold loops with `loop` and `pingpong` modes, plus optional one-shot intros.
- Portrait pan: a keyframe schedule that moves the crop window per frame, so a
  16:9 source survives a 9:16 viewport without a second set of assets.
- Three-layer loading: spritesheet, then full-resolution frames in binary
  subdivision order, then hold loops fetched on approach.
- `prefers-reduced-motion` drops the autonomous loops and keeps the
  scroll-driven sequence.
- Python pipeline tools: frame extraction (uniform or motion-weighted),
  spritesheet building with the decoded-memory budget, loop preparation with a
  measured verdict on whether a clip can loop, and contact sheets for review.
- Documentation in English and Traditional Chinese, including the measurements
  that came out worse than estimated.

[Unreleased]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tangyistudio/scroll-frame-sequence/releases/tag/v1.0.0
