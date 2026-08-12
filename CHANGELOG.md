# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/tangyistudio/scroll-frame-sequence/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tangyistudio/scroll-frame-sequence/releases/tag/v1.0.0
