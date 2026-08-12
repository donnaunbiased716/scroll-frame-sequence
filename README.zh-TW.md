# scroll-frame-sequence

捲動驅動的逐幀影格序列，附停留循環 —— Apple 產品頁那種效果，加上通常沒人寫下來的那些部分。

一個 `<section>` 被捲動，一支影片在使用者的手指下一幀一幀前進。停止捲動就停在那一格，往回捲就倒著播。在指定的影格上還可以**停住**並播一小段循環動畫，讓「凍住」的畫面仍然有呼吸。

兩個部分，可以分開用：

- **`tools/`** —— 把影片變成影格、spritesheet 與停留循環，並且給你判斷成果好不好的實測數字。
- **`src/`** —— 約 530 行、零相依的播放器，全程不觸發你的框架重繪。

這裡的東西都是做完上線之後整理出來的，不是寫部落格想出來的。文件裡的數字都是量出來的，**包含那些比預期糟的**。

---

## 為什麼不直接用 `<video>`

| | `<video autoplay>` | 捲動逐幀 |
|---|---|---|
| 播放速度 | 影片自己決定 | **使用者的手決定** |
| 停下來 | 只能暫停 | **停在那一格** |
| 倒轉 | 拖進度條 | **往回捲** |
| 文案與畫面同步 | 要監聽 `timeupdate` | **同一個進度值，免費** |
| 手機自動播放 | `muted` + `playsinline`，還是常被擋 | **沒有這個問題** |

代價是頻寬的**形狀**，不是總量。25 秒的 H.264 約 7 MB 而且是串流；同樣內容做成 150 張 WebP 約 5 MB，但它希望在使用者開始捲之前就備齊。**這個專案大部分的設計都在處理「怎麼讓這件事不要變成問題」** —— 見[三層載入](#三層載入)。

---

## 安裝

播放器就是兩個檔案，沒有建置步驟也沒有相依。裝起來，或直接複製走。

```bash
# 播放器
npm install scroll-frame-sequence
# 或把 src/scroll-sequence.js 與 src/scroll-sequence.css 複製進你的專案

# 工具
pip install -r tools/requirements.txt   # Pillow、numpy；另外需要 ffmpeg
```

```js
import { ScrollSequence } from 'scroll-frame-sequence';
import 'scroll-frame-sequence/style.css';
```

---

## 快速上手

### 1. 做出影格

```bash
python tools/extract_frames.py source.mp4 frames/ \
    --count 150 --scale 1920:1080 --quality 72 --weighted

python tools/build_spritesheet.py frames/ spritesheet.webp --cols 9
#   -> 印出：sheetCols 9、sheetRows 17，以及 CSS 位移公式
```

### 2. 播放

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

基本情況就這樣。[`examples/`](examples/) 有可以直接跑的版本，以及一個含停留循環的版本。

---

## 容易做錯的地方

### 要抽幾張？

判準不是「幾秒」，而是**每一幀分到多少捲動像素**。

```
每幀像素 = (heightVh - 100) / 100 × 視窗高 / 幀數
```

| 每幀像素 | 觀感 |
|---|---|
| 低於 10 | 太密 —— 你在為看不出來的細節付費 |
| **15 – 20** | 舒適區（Apple AirPods 產品頁約 18.5）|
| 超過 30 | 明顯跳格 |

兩個實際上線過的設定：

| 區塊 | 幀數 | `heightVh` | 每幀像素 |
|---|---|---|---|
| 滿版 Hero | 150 | 650 | 18.3 |
| 頁面中段的較短區塊 | 120 | 320 | 16.5 |

### 用幀號抽樣，不要用 `fps`

`ffmpeg -vf fps=150/28` 是重新取樣時間軸。依進位不同你會拿到 150 或 151 張，而且**不保證抓到影片真正的第一幀與最後一幀** —— 而那兩張正是使用者盯著最久的：開場定格與結尾的定格姿勢。

```
幀號_i = round(i × (總幀數 - 1) / (目標張數 - 1))，i = 0 … 目標張數-1
```

`extract_frames.py` 就是這樣做的。這不是偏好問題，`fps` 抽樣會**默默弄丟你的頭尾**。

### 依動態量抽樣，不要依時間

均勻抽樣會把「鏡頭定住兩秒」和「角色進場兩秒」分到一樣多的影格。結果就是定住的那段讀起來像**「我還在捲，但動畫凍住了」**。

`--weighted` 依畫面實際變化量分配預算。同一支 16 秒素材、89 張的實測：

| | 均勻 | 動態加權 |
|---|---|---|
| 每步變化量的變異係數 | 0.73 | **0.38** |
| 低於平均一半的步數（「感覺卡住」）| 29 | **8** |

它有阻尼（`w = 0.35 + 0.65 × m/mean`），因為純比例分配會把安靜的段落整個刪掉，而那些安靜通常是刻意的。

### spritesheet 必須小，而理由不是檔案大小

瀏覽器解碼圖片是 `寬 × 高 × 4 bytes`，**跟它壓得多好完全無關**。以 150 幀計：

| 單格 | 拼接後 | 解碼記憶體 | |
|---|---|---|---|
| 1280x720 | 11520 x 12240 | **538 MB** | 手機直接當掉 |
| 960x540 | 8640 x 9180 | 303 MB | 太重 |
| **640x360** | **5760 x 6120** | **134 MB** | 用這個 |
| 480x270 | 4320 x 4590 | 76 MB | 明顯糊 |

所以拼接圖註定是低解析度層。它的任務是**讓動畫立刻能動**；清晰度是全解析度影格的事。

---

## 三層載入

```
底層   spritesheet      約 2 MB、一個請求、一秒左右就能開始捲
中層   全解析度影格      約 5 MB、陸續載入，載到哪張就蓋掉哪一格
上層   停留循環          使用者靠近時才抓
```

**任何地方都不需要「載好了沒」的狀態判斷**。`<img>` 的 `src` 還沒解碼時它本來就不繪製，底下那層自然露出來，位元組到了自動蓋上去。

**預載順序是二分逼近**，不是循序：

```
0 -> 149 -> 75 -> 37 -> 112 -> ...
```

循序載入的話，在下載快結束之前只有開頭能看。二分逼近讓大約兩成的位元組就覆蓋完整條動線，只是比較粗 —— 而**粗但完整永遠勝過細但只有前半段**。

**停留循環靠近才載。** 一度讓三組全部先載，那是約 9 MB 擋在主序列前面；改成 40 幀的提前量之後，進站成本降到約 1.6 MB。

---

## 停留循環

停留點把序列釘在某一格，在上面播一小段循環，捲過去之後交還。呼吸、霓虹閃爍、頭髮被風吹 —— 足夠讓凍住的畫面不像當掉的網頁。

捲動預算以「單位」計算：每格影格佔 1，停留點額外再佔 `weight`。

```
總單位 = 影格數 + 所有 weight 加總
```

```js
holds: [
  { index: 0,   weight: 1,  mode: 'pingpong', fps: 10, frames: [...] },
  { index: 60,  weight: 60, mode: 'pingpong', fps: 10, frames: [...] },
  { index: 149, weight: 60, mode: 'loop',     fps: 10, frames: [...],
    intro: [...] },   // 可選，第一次進入時播一次
]
```

第一格用 `weight: 1` 就是待機動畫的寫法：使用者停在頂端時無限播，一往下捲就立刻離開。

### 來回播放才是讓這件事實用的關鍵

生成出來的短片**通常不會閉合**，即使你照標準做法把同一張圖填進首尾幀要求無縫也一樣。同一批素材的實測，第一幀與最後一幀的差異，換算成「正常走一步」的倍數：

| 素材 | 倍數 |
|---|---|
| A —— 緊特寫、小動作 | 4.2x |
| B —— 廣角、多個主體 | 6.3x |
| C —— 同構圖、動作更小 | 7.7x |
| D —— 平坦背景、低對比 | 2.3x |

播 `1..N` 再 `N-1..2` **在結構上就沒有接點**。唯一代價是動作有一半時間在倒著跑 —— 呼吸、衣料、燈光呼吸看不出來；碼流下墜、單向的風就很明顯。

`make_loop.py` 會量接點、鏡頭飄移、亮度穩定度與位移偏向，然後告訴你該用哪個模式、為什麼：

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

如果動作是單向的、而且鏡頭鎖死，它會改推薦**交叉溶接** —— 對隨機紋理（雨、碼流、粒子）特別有效，因為兩端在統計上相同，即使數值不相等。它也會幫你印出一個要注意的地方：溶接後的循環是從來源第 `L` 幀開始，不是第 0 幀，所以**沒辦法對上精確的進場定格** —— 停留點必須跟底下那一格對齊時，用來回播放。

### 播放用 rAF，不用 `setInterval`

`setInterval` 會累積漂移，而且分頁在背景時被瀏覽器節流、回來時一次補播好幾幀。用真實經過時間推算索引可以同時解決兩者：

```js
const step = Math.floor((now - t0) / interval);
const k = ((step % period) + period) % period;
```

### 就緒檢查：找最久的那個坑

循環一進場就開始播，但影格還沒下載完。把 `.src` 換成尚未解碼的圖會先畫成空白，主序列露出來，圖到了又蓋回去 —— 一直重複。看起來就是閃爍，而且看不出來原因是載入。

修法是**跳過，不是等待**：

```js
if (url && isReady(url) && idx !== shown) node.src = url;   // 否則維持現在的畫面
```

循環會粗糙一下下然後自己變順，不需要任何載入狀態。

---

## 手機直式：把搖鏡做在瀏覽器裡

16:9 的畫面在 9:16 的視窗裡只看得到中央約 26–32% 的寬度。把橫向排開的一排主體置中裁切，等於只給觀眾看其中一個。

與其做第二套直式素材，不如送出**一份時間表** —— 幾百個位元組，告訴播放器要看哪裡：

```json
{
  "totalFrames": 150,
  "interpolation": { "cx": "smooth", "fit": "step" },
  "keyframes": [
    { "frame": 1,   "cx": 0.35, "fit": "cover",   "note": "主體在中線偏左" },
    { "frame": 40,  "cx": 0.50, "fit": "cover",   "note": "跨 39 幀移動，才讀得出是搖鏡" },
    { "frame": 41,  "cx": 0.50, "fit": "contain", "note": "切在畫面本來就在變的那一幀" },
    { "frame": 110, "cx": 0.50, "fit": "cover" }
  ]
}
```

- `cx` 是**比例不是像素** —— 裁切窗依裝置而異，寫死像素會在某些機型上偏掉。它會平滑內插。
- `fit` 是階梯函數：`cover` 滿版，`contain` 上下留白讓寬構圖活下來。

三條從做錯中得到的規則：

1. **`fit` 整支片切換不超過 4 次。** 更多就變成版面在閃。
2. **切在畫面本來就在變的地方** —— 白光淹沒、粒子爆散。轉換就藏進那個變化裡。
3. **`cx` 的移動要跨至少 10 幀。** 少於 5 幀看起來像抽搐。

還有一件事值得接受：當兩個重要主體分處畫面兩端，9:16 的窗口在數學上就是裝不下。**那是取景決策不是演算法** —— 選 `contain` 讓大家都變小，或選一邊放棄另一邊。唯一錯的做法是默默決定不講。

---

## 除錯

網址加上 `?seqdebug=1`：

```
progress 43.2%  frame 61/150  || pingpong 8/24 loop 3  pan 50% contain  ...f_061.webp
```

| 症狀 | 檢查 |
|---|---|
| 完全不動 | `<html>` 上的 `overflow-x: hidden` —— 見下 |
| 最後一幀不對 | 面板上的檔名，真的是 `f_150` 嗎 |
| 幀數是兩倍 | 重複上傳，重傳前要先清空 |
| 循環播兩次就停 | 不是壞掉，是 `weight` 太小被捲過去了 |
| 進場閃爍 | 面板會顯示 `loading n/N` |

### 會花掉你一個下午的那一個

```css
html, body { overflow-x: hidden; }   /* ✗ 讓 <html> 變成捲動容器 */
body { overflow-x: clip; }           /* ✓ 一樣裁掉溢出，但不建立容器 */
```

`<html>` 上的 `overflow-x: hidden` 會讓它變成捲動容器，於是 `position: sticky` **對整頁所有子孫元素靜默失效**。沒有錯誤、沒有警告，序列就是不動。

---

## API

```js
new ScrollSequence(container, options)
```

| 選項 | 預設 | |
|---|---|---|
| `frames` | `[]` | 影格網址陣列 |
| `poster` | `''` | 任何東西解碼之前顯示的靜態圖 |
| `dim` | `0.35` | 黑幕濃度 |
| `heightVh` | `500` | 區塊高度，也就是捲動距離 |
| `sheetUrl` / `sheetCols` / `sheetRows` | — | 快速載入層 |
| `holds` | `[]` | 見上 |
| `mobilePan` | `[]` | 時間表的關鍵影格 |
| `mobileFrameCount` | `48` | 手機抽樣張數，`0` 表示不抽樣 |
| `mobileBreakpoint` | `768` | px |
| `mobileHeightVh` | `0` | `0` 表示沿用 `heightVh` |
| `holdLookahead` | `40` | 距離停留點幾幀開始預載 |
| `maxConcurrent` | `6` | 並行圖片請求數 |
| `aspect` | `16/9` | 素材長寬比，用來換算直式跟拍的對準點 |
| `respectReducedMotion` | `true` | 見下方 |
| `debug` | `null` | `null` 自動偵測 `?seqdebug=1`；`true`/`false` 強制開關 |
| `onProgress` | — | `(progress, frameIndex, frameTotal)` |
| `onFrame` | — | `(frameIndex)`，只在改變時觸發 |

方法：`update(patch)`、`destroy()`，以及 `sequence.overlay` 讓你把自己的 DOM 掛上去。

**`onProgress` 一律回報完整序列的序號**，即使手機正在跑 48 張的抽樣版 —— 所以你的文案節拍不用管有沒有抽樣。

### 減少動態（reduced motion）

`prefers-reduced-motion` 要求的是少一點**自己會動**的動畫。序列本身只有在使用者捲動時才前進，所以留著；停留循環是自己在播的，所以拿掉。預設開啟 `respectReducedMotion` 時，循環不會啟動，那些影格也完全不會下載。停留的那一格照樣顯示、照樣佔用它的捲動距離，版面讀起來一模一樣 —— 只是不再呼吸。

---

## 文件

| | |
|---|---|
| [docs/pipeline.zh-TW.md](docs/pipeline.zh-TW.md) | 素材生產，含所有實測數字 |
| [docs/player.zh-TW.md](docs/player.zh-TW.md) | 播放器怎麼運作、為什麼這樣設計 |
| [docs/authoring.zh-TW.md](docs/authoring.zh-TW.md) | 餵資料給它的後台怎麼設計，與平台無關 |
| [docs/lessons.zh-TW.md](docs/lessons.zh-TW.md) | 什麼失敗了、量到什麼、什麼不要再試 |

English: [README.md](README.md) · [pipeline](docs/pipeline.md) ·
[player](docs/player.md) · [authoring](docs/authoring.md) · [lessons](docs/lessons.md)

---

## 範圍

這個專案**不包含** CMS、上傳器或儲存後端。影格就是網址，它們從哪來是你的事。

這是刻意畫的界線，不是打發你——**怎麼存是關於你的團隊的決定，不該由一個動畫元件替你決定。** 但那也是剩下最多工作的地方，所以 **[docs/authoring.zh-TW.md](docs/authoring.zh-TW.md)** 把「產生那些網址的東西」的設計寫完整了：它只需要做的四件事、150 個網址要怎麼存才存得住（分塊紀錄加瀏覽器端快取——150 次讀取變 6 次，回訪是 0 次）、操作者必須能改到的每一個設定，以及兩種完全不會報錯的失敗模式。

其中最糟那個的最短版本：**不要把 150 個網址塞進 CMS 的單一文字欄位。** 會撞到長度上限、寫入失敗，而如果你的儲存流程是「先寫 localStorage 再寫資料庫」，站長自己看永遠正常，只有訪客看不到。

## 授權

MIT，見 [LICENSE](LICENSE)。

Copyright (c) 2026 瑭宜網路多媒體有限公司 Tangyi Studio Co., Ltd.

為 [tangyi.mx](https://www.tangyi.mx) 而做，並從中抽出來開源。**不含任何影音素材**，請自備影片。
