/**
 * Behaviour tests for the player, on Node's built-in runner — no dependencies,
 * no jsdom. The DOM stub below is deliberately minimal: it implements only what
 * the player actually touches, so a test failing means the player changed, not
 * that the stub drifted.
 *
 *     npm test
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const VIEW_H = 900;
let scrollY = 0;
let decodeMode = 'sync';   // 'sync' = decodes immediately, 'never' = never resolves
let reduceMotion = false;
let requested = [];

class El {
  constructor(cls = '') {
    this.className = cls;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {} };
    this._src = null;
    this.complete = false;
    this.naturalWidth = 0;
    this.offsetTop = 0;
    this.offsetHeight = 0;
  }
  set src(v) {
    this._src = v;
    requested.push(v);
    if (decodeMode === 'sync') { this.complete = true; this.naturalWidth = 100; }
  }
  get src() { return this._src; }
  decode() { return decodeMode === 'never' ? new Promise(() => {}) : Promise.resolve(); }
  set innerHTML(html) {
    this.children = [...html.matchAll(/class="([^"]+)"/g)].map((m) => new El(m[1]));
  }
  get innerHTML() { return ''; }
  querySelector(sel) {
    const want = sel.replace('.', '');
    const walk = (node) => {
      for (const c of node.children) {
        if (c.className.split(/\s+/).includes(want)) return c;
        const deep = walk(c);
        if (deep) return deep;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll() { return []; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { top: this.offsetTop - scrollY }; }
}

globalThis.window = {
  innerWidth: 1440,
  innerHeight: VIEW_H,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: reduceMotion }),
};
globalThis.location = { search: '' };
globalThis.document = { createElement: () => new El() };
globalThis.requestAnimationFrame = (fn) => { setTimeout(() => fn(0), 0); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.Image = class extends El {};

const { ScrollSequence, buildPreloadOrder, subsample, panAt, objectPositionFor } =
  await import('../src/scroll-sequence.js');

const FRAME_TOTAL = 150;
const frames = Array.from({ length: FRAME_TOTAL }, (_, i) =>
  `/f_${String(i + 1).padStart(3, '0')}.webp`);
const holds = [
  { index: 0,   weight: 1,  mode: 'pingpong', fps: 10, frames: ['/h0_1.webp', '/h0_2.webp'] },
  { index: 74,  weight: 60, mode: 'pingpong', fps: 10, frames: ['/h1_1.webp', '/h1_2.webp'] },
  { index: 149, weight: 60, mode: 'loop',     fps: 10, frames: ['/h2_1.webp', '/h2_2.webp'] },
];

// A running hold loop reschedules itself forever, which would keep the event
// loop alive and hang the runner. Every sequence is tracked and destroyed.
const live = [];
afterEach(() => { live.splice(0).forEach((s) => s.destroy()); });

function mount(options = {}) {
  requested = [];
  const el = new El('hero');
  el.offsetHeight = (650 / 100) * VIEW_H;
  const seq = new ScrollSequence(el, { frames, holds, heightVh: 650, ...options });
  live.push(seq);
  return seq;
}

const scrollTo = (seq, p) => {
  scrollY = p * (seq.el.offsetHeight - VIEW_H);
  seq._apply();
};
const settle = () => new Promise((r) => setTimeout(r, 20));

// ------------------------------------------------------------ pure helpers --

test('buildPreloadOrder covers every frame exactly once, ends first', () => {
  const order = buildPreloadOrder(FRAME_TOTAL);
  assert.equal(order.length, FRAME_TOTAL);
  assert.equal(new Set(order).size, FRAME_TOTAL);
  assert.deepEqual(order.slice(0, 3), [0, 149, 74]);
});

test('subsample keeps both endpoints', () => {
  const picked = subsample([...Array(FRAME_TOTAL).keys()], 48);
  assert.equal(picked.length, 48);
  assert.equal(picked[0], 0);
  assert.equal(picked.at(-1), FRAME_TOTAL - 1);
});

test('panAt holds the first keyframe before it, and interpolates after', () => {
  const kf = [{ frame: 1, cx: 0.3, fit: 'cover' }, { frame: 21, cx: 0.5, fit: 'contain' }];
  assert.deepEqual(panAt(kf, 1), { cx: 0.3, fit: 'cover' });
  const mid = panAt(kf, 11);
  assert.ok(mid.cx > 0.3 && mid.cx < 0.5, `expected 0.3 < ${mid.cx} < 0.5`);
  assert.equal(panAt(kf, 40).fit, 'contain');
});

test('objectPositionFor centres when the image does not overflow', () => {
  assert.equal(objectPositionFor(0.3, 4000, 900), '50% 50%');
});

// ------------------------------------------------------------ scroll budget --

test('total units = frames + sum of hold weights', () => {
  assert.equal(mount().totalUnits, FRAME_TOTAL + 1 + 60 + 60);
});

test('the frame index is monotonic and reaches the last frame', () => {
  const seq = mount();
  const seen = [0, 0.25, 0.5, 0.75, 1].map((p) => { scrollTo(seq, p); return seq.lastIndex; });
  assert.deepEqual(seen[0], 0);
  assert.equal(seen.at(-1), FRAME_TOTAL - 1);
  seen.forEach((v, i) => i && assert.ok(v >= seen[i - 1], `went backwards at ${i}`));
});

// ------------------------------------------------------------- frame swaps --

test('a decodable frame is revealed', async () => {
  decodeMode = 'sync';
  const seq = mount();
  scrollTo(seq, 0.5);
  await settle();
  const back = seq.frontIsA ? seq.imgA : seq.imgB;   // already flipped
  assert.equal(back.style.opacity, '1');
});

test('an undecodable frame is NOT revealed — the previous one stays', async () => {
  decodeMode = 'never';
  const seq = mount();
  const before = [seq.imgA.style.opacity, seq.imgB.style.opacity];
  scrollTo(seq, 0.5);
  await settle();
  assert.deepEqual([seq.imgA.style.opacity, seq.imgB.style.opacity], before);
  decodeMode = 'sync';
});

test('a stale decode loses to a newer frame', async () => {
  const seq = mount();
  scrollTo(seq, 0.3);
  const first = seq.swapSeq;
  scrollTo(seq, 0.6);
  assert.ok(seq.swapSeq > first, 'each swap should take a fresh token');
  await settle();
  const visible = [seq.imgA.style.opacity, seq.imgB.style.opacity].filter((o) => o === '1');
  assert.equal(visible.length, 1, 'exactly one layer should be visible');
});

// ---------------------------------------------------------------- preload --

test('maxConcurrent survives update()', () => {
  decodeMode = 'never';
  const seq = mount({ maxConcurrent: 6 });
  assert.equal(seq.active, 6);
  seq.update({});                       // must not start a second pump
  assert.equal(seq.active, 6);
  decodeMode = 'sync';
});

// ------------------------------------------------------------------ holds --

test('a hold claims its frame and releases once scrolled past', () => {
  const seq = mount();
  scrollTo(seq, 0);
  assert.equal(seq.activeHoldIndex, 0);
  scrollTo(seq, 0.2);                   // a plain frame
  assert.equal(seq.activeHoldIndex, -1);
  scrollTo(seq, 0.5);                   // the mid-sequence hold
  assert.equal(seq.activeHoldIndex, 74);
});

test('the pan schedule is read in full-sequence frame numbers, not subsampled ones', () => {
  // The schedule is authored against all 150 frames. On a phone the sequence
  // subsamples to 48, and feeding the subsampled index to the lookup squashes
  // the schedule into its first 48 keyframes — every later keyframe silently
  // stops applying. This asserts the late one still lands.
  globalThis.window.innerWidth = 390;
  const seq = mount({
    mobileFrameCount: 48,
    mobilePan: [
      { frame: 1,   cx: 0.5, fit: 'cover' },
      { frame: 140, cx: 0.5, fit: 'contain' },   // past the 48-frame subsample
    ],
  });
  scrollTo(seq, 1);                              // the last frame, 150 of 150
  assert.equal(seq.imgA.style.objectFit, 'contain',
    'a keyframe past mobileFrameCount must still apply');
  globalThis.window.innerWidth = 1440;
});

test('reduced motion drops the loop but keeps the sequence', () => {
  reduceMotion = true;
  const seq = mount();
  scrollTo(seq, 0);
  assert.equal(seq.activeHoldIndex, 0, 'the hold still occupies its scroll distance');
  assert.equal(seq.holdState, null, 'but no loop is running');
  assert.equal(requested.filter((u) => u.startsWith('/h')).length, 0,
    'and its frames are never fetched');
  scrollTo(seq, 0.5);
  assert.ok(seq.lastIndex > 0, 'the sequence itself still advances');
  reduceMotion = false;
});
