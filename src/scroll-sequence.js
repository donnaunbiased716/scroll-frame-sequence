/*!
 * scroll-frame-sequence — scroll-driven image sequence player with hold loops.
 * MIT License. Copyright (c) 2026 Tangyi Studio Co., Ltd.
 *
 * Zero dependencies. Framework-agnostic.
 *
 * Design notes that matter (docs/player.md has the full reasoning):
 *   - Scroll never goes through framework state. Progress is applied straight
 *     to the DOM inside a rAF and we bail out early when the frame index has
 *     not changed. 150 frames over 4950 px only swaps every ~18 px, so state
 *     updates would do ~15x more work than the animation needs.
 *   - Two <img> elements alternate. Writing .src on a visible <img> paints a
 *     blank while the new bitmap decodes; swapping between two layers hides it.
 *   - Three loading layers (spritesheet -> full frames -> hold loops) remove the
 *     need for "is it loaded yet" state: an <img> whose src has not decoded
 *     simply does not paint, so the layer underneath shows through.
 */

const DEFAULTS = {
  frames: [],
  poster: '',
  dim: 0.35,
  heightVh: 500,
  sheetUrl: '',
  sheetCols: 0,
  sheetRows: 0,
  holds: [],
  mobilePan: [],
  mobileFrameCount: 48,
  mobileBreakpoint: 768,
  mobileHeightVh: 0,     // 0 = reuse heightVh
  holdLookahead: 40,     // begin fetching a hold within N frames of it
  maxConcurrent: 6,
  aspect: 16 / 9,        // source aspect ratio, used to resolve the portrait pan
  respectReducedMotion: true,  // see _startHold — this drops hold loops, not the sequence
  debug: null,           // null = auto-detect ?seqdebug=1
  onProgress: null,      // (progress, frameIndex, frameTotal)
  onFrame: null,         // (frameIndex) — only when the index actually changes
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * Preload order that reaches a watchable animation as early as possible.
 * Sequential order means only the opening is usable until the download is
 * nearly done. Binary subdivision gives 0 -> N-1 -> mid -> ... so roughly a
 * fifth of the bytes already covers the whole storyline, just coarsely.
 */
export function buildPreloadOrder(n) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const order = [0, n - 1];
  const seen = new Set(order);
  const queue = [[0, n - 1]];
  while (queue.length) {
    const [lo, hi] = queue.shift();
    if (hi - lo <= 1) continue;
    const mid = (lo + hi) >> 1;
    if (!seen.has(mid)) { seen.add(mid); order.push(mid); }
    queue.push([lo, mid], [mid, hi]);
  }
  return order;
}

/** Evenly pick `count` items, always including the first and the last. */
export function subsample(arr, count) {
  if (count >= arr.length || count < 2) return arr.slice();
  const last = arr.length - 1;
  return Array.from({ length: count }, (_, i) => arr[Math.round((i * last) / (count - 1))]);
}

/**
 * Mobile pan lookup. `cx` interpolates smoothly between keyframes; `fit` is a
 * step function that holds until the next keyframe which changes it.
 */
export function panAt(keyframes, frame1based) {
  if (!keyframes || !keyframes.length) return { cx: 0.5, fit: 'cover' };
  const kf = keyframes.slice().sort((a, b) => a.frame - b.frame);
  let fit = kf[0].fit || 'cover';
  for (const k of kf) if (k.frame <= frame1based && k.fit) fit = k.fit;

  if (frame1based <= kf[0].frame) return { cx: kf[0].cx ?? 0.5, fit };
  const lastKf = kf[kf.length - 1];
  if (frame1based >= lastKf.frame) return { cx: lastKf.cx ?? 0.5, fit };
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    if (frame1based >= a.frame && frame1based <= b.frame) {
      const span = b.frame - a.frame || 1;
      const t = smoothstep(clamp((frame1based - a.frame) / span, 0, 1));
      return { cx: (a.cx ?? 0.5) + ((b.cx ?? 0.5) - (a.cx ?? 0.5)) * t, fit };
    }
  }
  return { cx: 0.5, fit };
}

/**
 * Turn a 0..1 horizontal target into a CSS object-position percentage.
 * The percentage is relative to the overflow, not to the image, which is why
 * this has to be resolved against the live viewport rather than baked in.
 */
export function objectPositionFor(cx, viewportW, viewportH, aspect = 16 / 9) {
  const scaledW = viewportH * aspect;
  const overflow = scaledW - viewportW;
  if (overflow <= 0) return '50% 50%';
  const left = clamp(cx * scaledW - viewportW / 2, 0, overflow);
  return `${(left / overflow) * 100}% 50%`;
}

export class ScrollSequence {
  constructor(container, options = {}) {
    this.el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.el) throw new Error('[scroll-sequence] container not found');
    this.opt = { ...DEFAULTS, ...options };

    this.rafId = 0;
    this.lastIndex = -1;
    this.frontIsA = true;
    this.swapSeq = 0;
    this.queue = [];
    this.active = 0;
    this.imgPool = new Map();
    this.holdPool = new Map();
    this.preloadedHolds = new Set();
    this.holdState = null;
    this.holdRaf = 0;
    this.activeHoldIndex = -1;
    this.destroyed = false;

    this._buildDom();
    this._resolveResponsive();
    this._buildSegments();
    this._startPreload();

    this._onScroll = () => {
      if (this.rafId) return;
      this.rafId = requestAnimationFrame(() => { this.rafId = 0; this._apply(); });
    };
    this._onResize = () => {
      this._resolveResponsive();
      this._buildSegments();
      this.lastIndex = -1;
      this._apply();
    };

    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize);
    this._apply();
  }

  // ---------------------------------------------------------------- DOM ----

  _buildDom() {
    const o = this.opt;
    this.el.classList.add('sfs-root');
    this.el.innerHTML = `
      <div class="sfs-sticky">
        <div class="sfs-sheet"></div>
        <img class="sfs-frame sfs-a" alt="" decoding="async" />
        <img class="sfs-frame sfs-b" alt="" decoding="async" />
        <img class="sfs-hold" alt="" decoding="async" />
        <div class="sfs-dim"></div>
        <div class="sfs-slot"></div>
      </div>`;
    this.sticky = this.el.querySelector('.sfs-sticky');
    this.sheet = this.el.querySelector('.sfs-sheet');
    this.imgA = this.el.querySelector('.sfs-a');
    this.imgB = this.el.querySelector('.sfs-b');
    this.holdImg = this.el.querySelector('.sfs-hold');
    this.dimEl = this.el.querySelector('.sfs-dim');
    this.slot = this.el.querySelector('.sfs-slot');

    this.dimEl.style.background = `rgba(0,0,0,${o.dim})`;
    if (o.poster) this.sticky.style.backgroundImage = `url("${o.poster}")`;
    if (o.sheetUrl) this.sheet.style.backgroundImage = `url("${o.sheetUrl}")`;

    const flag = new URLSearchParams(location.search).get('seqdebug');
    const wantDebug = o.debug ?? (flag !== null && flag !== '0' && flag !== 'false');
    if (wantDebug) {
      this.debugEl = document.createElement('div');
      this.debugEl.className = 'sfs-debug';
      this.sticky.appendChild(this.debugEl);
    }
  }

  // --------------------------------------------------------- responsive ----

  _resolveResponsive() {
    const o = this.opt;
    this.isMobile = window.innerWidth <= o.mobileBreakpoint;
    this.reduceMotion = !!o.respectReducedMotion &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    this.allFrames = o.frames.filter(Boolean);
    this.frames = this.isMobile && o.mobileFrameCount > 0
      ? subsample(this.allFrames, o.mobileFrameCount)
      : this.allFrames;

    // Hold indices are authored against the full list, so remap for mobile.
    const ratio = this.allFrames.length > 1
      ? (this.frames.length - 1) / (this.allFrames.length - 1)
      : 0;
    this.holds = (o.holds || []).map((h) => {
      const index = this.isMobile ? Math.round((h.index || 0) * ratio) : (h.index || 0);
      const weight = this.isMobile && h.weightMobile > 0 ? h.weightMobile : (h.weight ?? 0);
      const frames = (this.isMobile && h.framesMobile?.length > 1 ? h.framesMobile : h.frames) || [];
      const intro = (this.isMobile && h.introMobile?.length ? h.introMobile : h.intro) || [];
      return { ...h, index: clamp(index, 0, this.frames.length - 1), weight, frames, intro };
    }).filter((h) => h.frames.length > 1 && h.weight > 0);

    const vh = this.isMobile && o.mobileHeightVh ? o.mobileHeightVh : o.heightVh;
    this.el.style.height = `${vh}vh`;

    const hasSheet = !this.isMobile && o.sheetUrl && o.sheetCols > 0 && o.sheetRows > 0;
    if (hasSheet) {
      this.sheet.style.backgroundSize = `${o.sheetCols * 100}% ${o.sheetRows * 100}%`;
      this.sheet.style.display = '';
    } else {
      // On mobile there is no sheet to sit under the frames, and a stale
      // cover-fitted still would show through the letterbox in `contain` mode.
      this.sheet.style.display = 'none';
    }

    // Pan is portrait-only, so its inline object-fit has to be cleared when it
    // no longer applies — otherwise a `contain` frame stays letterboxed after a
    // resize back to desktop, or after rotating a phone into landscape.
    if (!this.isMobile || !o.mobilePan?.length) {
      for (const im of [this.imgA, this.imgB, this.holdImg]) {
        im.style.objectFit = '';
        im.style.objectPosition = '';
      }
      delete this.sticky.dataset.fit;
    }
  }

  /**
   * Scroll budget. Every frame costs 1 unit; a hold costs `weight` on top.
   * This is what lets a hold occupy real scroll distance without compressing
   * the frames around it.
   */
  _buildSegments() {
    const n = this.frames.length;
    const byIndex = new Map(this.holds.map((h) => [h.index, h]));
    this.segments = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const hold = byIndex.get(i) || null;
      const span = 1 + (hold ? hold.weight : 0);
      this.segments.push({ start: acc, end: acc + span, index: i, hold });
      acc += span;
    }
    this.totalUnits = Math.max(1, acc);
  }

  _findSegment(u) {
    const list = this.segments;
    if (!list.length) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (u < list[mid].end) hi = mid; else lo = mid + 1;
    }
    return list[lo];
  }

  // --------------------------------------------------------------- core ----

  _progress() {
    const rect = this.el.getBoundingClientRect();
    const distance = Math.max(1, this.el.offsetHeight - window.innerHeight);
    return clamp(-rect.top / distance, 0, 1);
  }

  _apply() {
    if (this.destroyed) return;
    const p = this._progress();
    const seg = this._findSegment(p * this.totalUnits);
    const index = seg ? seg.index : Math.max(0, this.frames.length - 1);

    // Callers always get the index in the *full* sequence, so a page's copy
    // cues do not have to know whether mobile subsampling happened.
    const origIndex = this.frames.length > 1
      ? Math.round((index * (this.allFrames.length - 1)) / (this.frames.length - 1))
      : index;
    this.opt.onProgress?.(p, origIndex, this.allFrames.length);

    if (!this.frames.length) return;

    if (index !== this.lastIndex) {
      this._showFrame(index);
      this._ensureHoldLoaded(index);
      this.lastIndex = index;
      this.opt.onFrame?.(origIndex);
    }
    if (this.isMobile && this.opt.mobilePan?.length) this._applyPan(index);

    if (seg?.hold) this._startHold(seg.hold, seg.index);
    else if (this.activeHoldIndex !== -1) this._stopHold();

    if (this.debugEl) this._paintDebug(p, index, seg?.hold || null);
  }

  _showFrame(index) {
    const url = this.frames[index];
    if (!url) return;
    const o = this.opt;
    if (!this.isMobile && o.sheetCols > 0 && o.sheetRows > 0) {
      const c = o.sheetCols, r = o.sheetRows;
      const col = index % c, row = Math.floor(index / c);
      // Percentage background-position is relative to (container - image),
      // hence /(cols-1) rather than a plain multiply.
      this.sheet.style.backgroundPosition =
        `${c > 1 ? (col / (c - 1)) * 100 : 0}% ${r > 1 ? (row / (r - 1)) * 100 : 0}%`;
    }
    const back = this.frontIsA ? this.imgB : this.imgA;
    const front = this.frontIsA ? this.imgA : this.imgB;

    // Reveal only once the new bitmap can actually paint. Writing .src and
    // flipping opacity in the same tick is exactly what two layers exist to
    // avoid: an <img> whose src has not decoded paints nothing, so the old
    // frame would be hidden before the new one is there to replace it.
    const token = ++this.swapSeq;
    const flip = () => {
      if (this.destroyed || token !== this.swapSeq) return;  // a newer frame won the race
      back.style.opacity = '1';
      front.style.opacity = '0';
      this.frontIsA = !this.frontIsA;
    };

    back.src = url;
    const decoded = back.decode?.();
    if (decoded) {
      // Rejects when .src changes mid-decode — which is the stale case anyway.
      decoded.then(flip, () => {});
    } else if (back.complete && back.naturalWidth > 0) {
      flip();
    } else {
      back.addEventListener('load', flip, { once: true });
    }
  }

  _applyPan(index) {
    const { cx, fit } = panAt(this.opt.mobilePan, index + 1);
    const pos = objectPositionFor(cx, window.innerWidth, window.innerHeight, this.opt.aspect);
    for (const im of [this.imgA, this.imgB, this.holdImg]) {
      im.style.objectFit = fit;
      im.style.objectPosition = fit === 'cover' ? pos : '50% 50%';
    }
    this.sticky.dataset.fit = fit;
  }

  // -------------------------------------------------------------- holds ----

  _startHold(hold, key) {
    if (this.activeHoldIndex === key) return;
    this._stopHold();
    this.activeHoldIndex = key;

    // `prefers-reduced-motion` is about animation that runs on its own. The
    // sequence itself is driven by the user's hand and stays; a hold loop plays
    // by itself, so that is the part that goes. The held frame underneath is
    // still shown, and the hold still occupies its scroll distance.
    if (this.reduceMotion) return;

    this._preloadHold(hold);

    const L = hold.frames.length;
    const period = hold.mode === 'pingpong' ? Math.max(1, (L - 1) * 2) : L;
    const intro = hold.intro || [];
    this.holdState = {
      hold, L, period, intro,
      interval: 1000 / (hold.fps || 10),
      t0: 0, k: -1, shown: -1, loops: 0,
      introDone: intro.length === 0 || this.playedIntro?.has(key),
    };
    this.holdImg.style.opacity = '1';

    const tick = (now) => {
      const st = this.holdState;
      if (!st) return;
      if (!st.t0) st.t0 = now;
      const step = Math.floor((now - st.t0) / st.interval);

      // Optional one-shot intro (e.g. an arm rising into its final pose)
      // plays once on first entry, then the loop takes over.
      if (!st.introDone) {
        if (step < st.intro.length) {
          const url = st.intro[step];
          if (url && this._isReady(url) && step !== st.shown) {
            this.holdImg.src = url;
            st.shown = step;
          }
          this.holdRaf = requestAnimationFrame(tick);
          return;
        }
        st.introDone = true;
        st.t0 = now;
        st.shown = -1;
        (this.playedIntro ||= new Set()).add(key);
        this.holdRaf = requestAnimationFrame(tick);
        return;
      }

      const k = ((step % st.period) + st.period) % st.period;
      if (k !== st.k) {
        if (k < st.k) st.loops += 1;
        st.k = k;
        // pingpong: 0..L-1 then L-2..1, so the endpoints never repeat.
        const idx = st.hold.mode === 'pingpong' && k >= st.L ? st.period - k : k;
        const url = st.hold.frames[idx];
        // Skip a frame that has not decoded rather than painting a blank.
        // The loop looks coarse for a moment, then heals itself.
        if (url && this._isReady(url) && idx !== st.shown) {
          this.holdImg.src = url;
          st.shown = idx;
        }
      }
      this.holdRaf = requestAnimationFrame(tick);
    };
    this.holdRaf = requestAnimationFrame(tick);
  }

  _stopHold() {
    if (this.holdRaf) cancelAnimationFrame(this.holdRaf);
    this.holdRaf = 0;
    this.holdState = null;
    this.activeHoldIndex = -1;
    this.holdImg.style.opacity = '0';
  }

  _isReady(url) {
    const im = this.holdPool.get(url);
    return !!(im && im.complete && im.naturalWidth > 0);
  }

  _preloadHold(hold) {
    if (this.preloadedHolds.has(hold)) return;
    this.preloadedHolds.add(hold);
    for (const url of [...(hold.intro || []), ...hold.frames]) {
      if (this.holdPool.has(url)) continue;
      const img = new Image();
      this.holdPool.set(url, img);
      img.onload = () => { img.decode?.().catch(() => {}); };
      img.src = url;
    }
  }

  /**
   * Only fetch a hold once the user is within `holdLookahead` frames of it.
   * Loading every hold up front put ~9 MB in front of the main sequence and
   * delayed the thing the user is actually looking at.
   */
  _ensureHoldLoaded(index) {
    if (this.reduceMotion) return;   // the loops will never play; do not fetch them
    for (const h of this.holds) {
      if (Math.abs(h.index - index) <= this.opt.holdLookahead) this._preloadHold(h);
    }
  }

  // ------------------------------------------------------------ preload ----

  /**
   * The queue and the in-flight count live on the instance, not in this call,
   * so that a later update() appends to the same queue instead of starting a
   * second pump — two pumps with private counters would double `maxConcurrent`.
   */
  _startPreload() {
    for (const i of buildPreloadOrder(this.frames.length)) {
      const url = this.frames[i];
      if (url && !this.imgPool.has(url)) this.queue.push(url);
    }
    this._pump();
  }

  _pump() {
    while (this.active < this.opt.maxConcurrent && this.queue.length) {
      const url = this.queue.shift();
      if (this.imgPool.has(url)) continue;
      this.active++;
      const img = new Image();
      this.imgPool.set(url, img);
      const done = () => { this.active--; if (!this.destroyed) this._pump(); };
      img.onload = () => { const d = img.decode?.(); d ? d.then(done, done) : done(); };
      img.onerror = done;
      img.src = url;
    }
  }

  // -------------------------------------------------------------- debug ----

  _paintDebug(p, index, hold) {
    const url = this.frames[index] || '';
    let line = `progress ${(p * 100).toFixed(1)}%  frame ${index + 1}/${this.frames.length}`;
    if (hold) {
      const st = this.holdState;
      const ready = hold.frames.filter((u) => this._isReady(u)).length;
      const phase = st && !st.introDone ? 'intro' : hold.mode;
      line += `  || ${phase} ${st ? st.k + 1 : 0}/${hold.frames.length} loop ${st ? st.loops + 1 : 1}`;
      if (ready < hold.frames.length) line += `  loading ${ready}/${hold.frames.length}`;
    }
    if (this.isMobile && this.opt.mobilePan?.length) {
      const { cx, fit } = panAt(this.opt.mobilePan, index + 1);
      line += `  pan ${(cx * 100).toFixed(0)}% ${fit}`;
    }
    this.debugEl.textContent = `${line}  ...${url.split('/').pop()}`;
  }

  // ---------------------------------------------------------------- api ----

  /** Mount your own DOM on top of the sequence (captions, CTAs, ...). */
  get overlay() { return this.slot; }

  update(patch = {}) {
    Object.assign(this.opt, patch);
    this._resolveResponsive();
    this._buildSegments();
    this.lastIndex = -1;
    this._startPreload();
    this._apply();
  }

  destroy() {
    this.destroyed = true;
    this._stopHold();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    window.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    this.queue.length = 0;
    this.imgPool.clear();
    this.holdPool.clear();
    this.el.innerHTML = '';
    this.el.classList.remove('sfs-root');
  }
}

export default ScrollSequence;
