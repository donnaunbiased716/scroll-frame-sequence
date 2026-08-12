# 播放器運作原理

大約 600 行，沒有相依套件。這一頁講的是背後的決策而不是逐行說明；原始碼中凡是
會讓人意外的地方都有註解。

---

## 1. 結構

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

外層 section 的高度*就是*捲動距離。使用者實際看到的是那個 sticky 的子元素。

> **`position: sticky` 會無聲無息地失效。** 只要有任何祖先元素——最常見的是
> `<html>`——設了 `overflow-x: hidden`，它就會變成捲動容器，底下所有後代的
> sticky 全部失效，而且不會有任何錯誤訊息。請改用 `body { overflow-x: clip }`。
> 這件事大概每個專案都會害人耗掉一整個下午。

## 2. 進度

```js
const rect = el.getBoundingClientRect();
const distance = Math.max(1, el.offsetHeight - window.innerHeight);
const p = clamp(-rect.top / distance, 0, 1);
```

用 `offsetHeight - innerHeight` 是因為最初那一個視窗高度的捲動，是花在把 section
移到定位上；只有剩下的部分才會推動整個序列。

## 3. 捲動不能經過框架狀態

這就是順暢與卡頓的分野。

`progress` 是連續的——滾輪每動一格都會觸發。如果每一次都引發狀態更新，你就會拿到
一次 memo 重算、一個新的 style 物件，還有整棵子樹的 diff。但畫面其實每 ~18 px 才
會變一次。一段 150 影格的序列分布在 4950 px 上只會變化 150 次，而捲動處理器卻觸發
了好幾千次，所以**超過 90% 的工作沒有產生任何看得見的變化**，而且全都在主執行緒上。

改成這樣：

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

整段捲動過程一次重繪都不會發生。

**如果呼叫端真的需要連續的進度值**——比方說要讓文字隨捲動位置交叉淡入淡出——那就把
它量化。四捨五入到 0.5% 在整個 section 上大約會有 200 次更新，遠低於每影格一次，
而且仍然夠細緻，讓每階 7% 的透明度漸變看不出階梯感。

## 4. 兩個交替的 `<img>` 元素

在可見的 `<img>` 上指定 `.src`，會在新的點陣圖解碼期間畫出一片空白。在全螢幕背景上，
這片空白就是底下不管是什麼東西都閃一下。

改成寫進隱藏的那一層，而且**要等新的點陣圖真的畫得出來才切換 opacity** —— 等
`img.decode()` 完成，沒有這個 API 時退回 `load` 事件。舊的那一格會一直留著，需要多久
就留多久，整個變換就看不出來。

寫 `.src` 的同一個 tick 就翻上來，正是這套設計要防的錯：舊的立刻被藏起來，新的還沒
解碼，那一瞬間兩層都畫不出東西，閃爍原封不動回來 —— 而你用了兩層卻什麼也沒換到。

快速捲動時會同時排上好幾次交換，所以每次交換都帶一個序號，晚完成的解碼直接輸給更新
的那一格。

保留每一張你預載的 `Image` 的參照也很重要：這能讓解碼後的點陣圖留著，之後再指定同
一個 URL 時是瞬間完成，而不是重新解碼一次。

## 5. 含停留點的捲動預算

每個影格花 1 單位。一個停留點在此之上再加它的 `weight`。

```
total units = frames + sum(hold.weight)
```

分段只建立一次，之後每個捲動影格用二分搜尋去查：

```js
segments = [{ start, end, index, hold }, ...]
```

實例計算——150 影格、`heightVh: 650`、900 px 視窗高度、權重 1 / 60 / 60 的停留點：

| | |
|---|---|
| total units | 150 + 1 + 60 + 60 = 271 |
| scroll travel | (650 − 100) / 100 × 900 = 4950 px |
| one unit | 18.3 px |
| hold weight 1 | 37 px — 隨手一撥就過去了 |
| hold weight 60 | 1100 px ≈ 1.2 個螢幕 |

**`heightVh` 和 `weight` 必須一起調整。** 只加大 weight 等於從一般影格身上偷走距離，
會讓它們一閃而過。

在影格 0 上設 `weight: 1` 是待機動畫的慣用手法：使用者停在頂端時它會無限循環，一
捲動就立刻消失。

## 6. 停留播放

### 時間取自時鐘，不是取自計時器

```js
const step = Math.floor((now - t0) / interval);
const k = ((step % period) + period) % period;
```

`setInterval` 會漂移，而且瀏覽器在背景分頁中會節流它，回到前景時再一口氣把好幾個
callback 一起送出——看起來就像迴圈在跳格。改用 rAF 裡的實際經過時間來驅動索引，兩
個問題都解決。

`period` 在 `loop` 模式下是 `N`，在 `pingpong` 模式下是 `(N-1) * 2`，所以來回播放會
先播 `0..N-1` 再播 `N-2..1`，端點永遠不會重複。

### 就緒檢查

這個元件裡活最久的臭蟲：迴圈在它的影格還沒下載完就開始跑，`.src` 畫出一片空白，主
序列閃了過去，圖片載進來又蓋上去——一再重複。

```js
if (url && isReady(url) && idx !== shown) node.src = url;
```

寧可跳過那個影格，也不要顯示空白。迴圈會粗糙一下下，然後自己復原——沒有載入狀態、
沒有轉圈圈、沒有閃爍。

### 選用的一次性開場

有些停留點不是迴圈。如果一個停留點帶有 `intro` 陣列，它會在第一次進入時播放一次，
然後交棒給迴圈。捲走再捲回來不會重播，因為每次使用者回來都重播一次「手臂舉起就位」
看起來就像壞掉了。

## 7. 載入

三層，不需要任何協調：

```
spritesheet   one request, low resolution, scrollable in about a second
full frames   binary-subdivision order, 6 at a time
hold loops    fetched within `holdLookahead` (40) frames of the hold
```

不需要協調的原因是：`src` 尚未解碼完成的 `<img>` 不會繪製。底下那一層會透出來，等
位元組到齊，上層就把它蓋掉。沒有任何狀態可以出錯。

**二分細分**（`0 → N-1 → mid → …`）讓部分載入仍然涵蓋整條故事線。依序載入的話，在
下載快結束之前結尾都沒得看。

**停留點採用預先讀取**，是因為把它們全部先載完，等於在使用者真正在看的東西前面塞了
約 9 MB。40 個影格的提前量大約是 700 px 的捲動——時間相當充裕。

## 8. 手機

| | desktop | phone |
|---|---|---|
| frames | 150 | 48，在瀏覽器中抽樣 |
| bytes | ~5 MB | ~1.6 MB |
| spritesheet | 有 | 無 |
| holds | 有，全解析度 | 有，可選用較低解析度 |
| scroll travel | 650vh | 450vh |

抽樣是在客戶端進行的，所以不需要第二套檔案。停留點索引是以完整清單為基準撰寫的，
系統會自動重新對應。

**手機上要保留停留點。** 它們是整段序列中唯一有停留時間的時刻；拿掉它們，就代表大
多數訪客永遠看不到你花最多心力做的那些部分。改成調低 `weightMobile`——手機的捲動距
離較短，同樣的權重感覺會長得多。

手機上刻意不用拼接圖：那裡沒有 `contain` 產生的黑邊要填，而底下一張以 cover 裁切的
過時靜態圖會從黑邊透出來。

`onProgress` 回報的一律是**完整**序列中的索引，所以照桌機影格編號寫的文案提示點依
然有效。

## 9. 直式跟拍

排程格式請見 [README](../README.zh-TW.md#portrait-phones-pan-in-the-browser)。
另有兩點實作說明：

`cx` 是比例值，因為裁切視窗取決於裝置：

```js
const scaledW = viewportH * (16 / 9);
const overflow = scaledW - viewportW;
const left = clamp(cx * scaledW - viewportW / 2, 0, overflow);
return `${(left / overflow) * 100}% 50%`;
```

`object-position` 的百分比是相對於*溢出量*，不是相對於圖片，這就是為什麼它必須即時
計算而不能事先寫死。

`cx` 用 smoothstep 內插，不是線性。關鍵影格之間用線性內插，會在每一個關鍵影格上看
到明顯的速度變化；smoothstep 會頭尾緩入緩出，看起來像是真正的鏡頭運動。

## 10. 除錯疊層

`?seqdebug=1` 會印出進度、影格索引、停留狀態、循環次數、載入進度、跟拍位置以及目前
的檔名。檔名是抓出排序錯誤最快的方法——如果最後一個影格是 `f_149` 而不是 `f_150`，
你馬上就知道了。
