/**
 * scroll-frame-sequence — type definitions.
 * MIT License. Copyright (c) 2026 Tangyi Studio Co., Ltd.
 */

/** How a frame is fitted into a portrait viewport. */
export type Fit = 'cover' | 'contain';

/** How a hold loop plays. `pingpong` has no seam by construction. */
export type HoldMode = 'loop' | 'pingpong';

export interface PanKeyframe {
  /** 1-based frame number, in the **full** sequence — not the mobile subsample. */
  frame: number;
  /**
   * Horizontal target as a ratio of the source width: 0 = left edge, 1 = right
   * edge. Never pixels — the crop window differs per device. Interpolated
   * smoothly between keyframes.
   */
  cx?: number;
  /** Step function: holds until the next keyframe that changes it. */
  fit?: Fit;
  /** Ignored by the player. Kept so a schedule stays reviewable by a human. */
  note?: string;
}

export interface Hold {
  /** 0-based index into `frames`, authored against the full sequence. */
  index: number;
  /** Extra scroll units this hold occupies. Every frame is worth 1. */
  weight: number;
  /** Phones run a subsample, so one unit covers more story. 0 reuses `weight`. */
  weightMobile?: number;
  mode?: HoldMode;
  /** Playback rate of the loop. Must match how the clip was cut. */
  fps?: number;
  frames: string[];
  /** Optional lower-resolution set for phones. Falls back to `frames`. */
  framesMobile?: string[];
  /** Optional one-shot, played once on first entry. A move that ends in a pose is not a loop. */
  intro?: string[];
  introMobile?: string[];
}

export interface ScrollSequenceOptions {
  /** Frame image URLs, in order. */
  frames?: string[];
  /** Still shown before anything decodes. */
  poster?: string;
  /** Black overlay opacity, 0–1. */
  dim?: number;
  /** Section height in vh. This is the scroll distance. */
  heightVh?: number;
  /** The fast-load layer. */
  sheetUrl?: string;
  sheetCols?: number;
  sheetRows?: number;
  holds?: Hold[];
  /** Keyframes from the portrait pan schedule. */
  mobilePan?: PanKeyframe[];
  /** Frames phones subsample down to. `0` disables subsampling. */
  mobileFrameCount?: number;
  /** Viewport width at or below which the mobile path is used, in px. */
  mobileBreakpoint?: number;
  /** `0` reuses `heightVh`. */
  mobileHeightVh?: number;
  /** Begin fetching a hold within this many frames of it. */
  holdLookahead?: number;
  /** Parallel image requests. */
  maxConcurrent?: number;
  /** Source aspect ratio, used to resolve the portrait pan. */
  aspect?: number;
  /**
   * Drop hold loops when the user prefers reduced motion. The scroll-driven
   * sequence is kept — it is driven by the user's hand, not by a clock.
   */
  respectReducedMotion?: boolean;
  /** `null` auto-detects `?seqdebug=1`; `true`/`false` forces the overlay. */
  debug?: boolean | null;
  /**
   * Fires continuously while scrolling. `frameIndex` is always the index in the
   * **full** sequence, even when a phone is running a subsample.
   *
   * Do not push this straight into framework state — write to the DOM, or
   * quantise first.
   */
  onProgress?: (progress: number, frameIndex: number, frameTotal: number) => void;
  /** Fires only when the frame index actually changes. */
  onFrame?: (frameIndex: number) => void;
}

export declare class ScrollSequence {
  constructor(container: string | HTMLElement, options?: ScrollSequenceOptions);

  /** Mount your own DOM on top of the sequence — captions, CTAs. */
  readonly overlay: HTMLElement;

  /** Merge new options and re-apply. Safe to call with new `frames`. */
  update(patch?: ScrollSequenceOptions): void;

  /** Removes listeners and clears the container. Required in SPA teardown. */
  destroy(): void;
}

/**
 * Preload order that reaches a watchable animation as early as possible:
 * `0 -> n-1 -> mid -> ...` rather than sequential.
 */
export declare function buildPreloadOrder(n: number): number[];

/** Evenly pick `count` items, always including the first and the last. */
export declare function subsample<T>(arr: T[], count: number): T[];

/** Look up the pan schedule. `frame1based` is in full-sequence frame numbers. */
export declare function panAt(
  keyframes: PanKeyframe[],
  frame1based: number,
): { cx: number; fit: Fit };

/** Turn a 0–1 horizontal target into a CSS `object-position` value. */
export declare function objectPositionFor(
  cx: number,
  viewportW: number,
  viewportH: number,
  aspect?: number,
): string;

export default ScrollSequence;
