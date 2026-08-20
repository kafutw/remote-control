# meltdown-nudge

小孩卡關或崩潰的時候，跳出來讓他喘一口氣的小元件。從「ABC 字母大考驗」抽出來的，可以放進任何練習類的網頁。

**一個 JS 檔、沒有相依套件、沒有建置步驟、ES5 寫的**（老 iPad 的 Safari 也跑得動）。CSS 由元件自己注入，class 一律 `mn-` 開頭，不會撞到你的樣式。

- 📄 [`meltdown-nudge.js`](meltdown-nudge.js)（約 11 KB）
- 🧪 [`demo.html`](demo.html) — 可以直接玩的示範

## 它做兩件事

1. **連續失敗幾次就跳**一句話出來。
2. **太吵也跳** — 開麥克風**只量音量**，不錄音、不上傳、不判斷內容。

跳出來的那句話會**用語音念**，念完停一秒**自己關掉繼續**，不用等小孩按。語氣可以**自動升級**：前幾次好好講，還是一直鬧就換比較促咪的說法。

## 用法

```html
<script src="meltdown-nudge.js"></script>
<script>
var nudge = MeltdownNudge.create({
  missStreak: 5,                    // 連錯 5 次跳一次
  noise: { level: 0.16 },           // 要聽音量才給；不給就完全不碰麥克風
  onResume: function () { nextQuestion(); },   // 使用者（或自動）選擇繼續
  onStop:   function () { endRound(); }        // 使用者選擇今天先到這裡
});

// 在你的作答流程裡呼叫
nudge.miss();     // 答錯 / 超時
nudge.hit();      // 答對，連錯歸零

// 開始聽音量。瀏覽器規定一定要在使用者手勢裡呼叫（例如「開始」按鈕）
startBtn.onclick = function () { nudge.listen(); startRound(); };
</script>
```

## 設定

| 參數 | 預設 | 說明 |
|---|---|---|
| `missStreak` | `5` | 連續失敗幾次跳一次。`0` = 不用這條規則 |
| `noise` | `null` | 給了才開麥克風。`{ level, sustainMs, decay, cooldownMs, tickMs }` |
| `noise.level` | `0.08` | 音量門檻 0～1（RMS）。0.05 很容易跳／0.08 一般／0.12 要再吵一點／0.20 要崩潰大哭 |
| `noise.sustainMs` | `1000` | 要吵夠這麼久才跳。亂叫一聲大概就是一秒 |
| `noise.decay` | `0.35` | 安靜時退回去的倍率。**哭是一陣一陣的，中間換氣不該歸零**，所以用累加不用連續 |
| `noise.cooldownMs` | `90000` | 跳過之後多久內不再打擾 |
| `lines` | 內建 | `{ soft: [[emoji, 句子], …], fun: […] }` |
| `tone` | `'auto'` | `auto`（先 soft 再 fun）／`soft`／`fun` |
| `softTimes` | `2` | auto 模式下，前幾次用 soft |
| `speak` | `true` | 要不要念出來 |
| `lang` | `'zh-TW'` | 挑語音用的語言，找不到完全相符的就找同語系 |
| `rate` `pitch` `volume` | `1` | 語音參數 |
| `autoResumeMs` | `1000` | 念完停多久自己繼續。`0` / `null` = 一定要按按鈕 |
| `failSafeMs` | `9000` | 語音卡住的保險，時間到自己走 |
| `goText` `stopText` | 見原始碼 | 兩顆按鈕的字。`stopText: ''` 就不顯示第二顆 |
| `onShow` | — | `fn({ reason: 'miss'｜'noise'｜'manual', tone, line })` |
| `onResume` `onStop` | — | 繼續／收工 |
| `onError` | — | `fn(code, message)`，目前只有 `'mic'` |
| `audioContext` | — | 想共用你自己的 AudioContext 就傳進來 |

## 方法

| 方法 | 說明 |
|---|---|
| `miss()` | 失敗一次。真的跳出來時回傳 `true` |
| `hit()` | 成功一次，連錯歸零 |
| `show()` / `close(go)` | 手動跳 / 手動關（`go = false` 代表收工） |
| `listen(onFail)` / `mute()` | 開始 / 停止聽音量 |
| `level()` / `peak()` / `resetPeak()` | 現在音量、量到的最大音量 — 拿來畫音量條、幫使用者挑門檻 |
| `isOpen()` / `isListening()` | 狀態 |
| `set(patch)` | 改設定（例如使用者在設定畫面調門檻） |
| `destroy()` | 收乾淨 |

## 幾個一定要知道的限制

- **麥克風要 https**：`navigator.mediaDevices` 在 `file://` 和純 http 底下**根本不存在**，這時 `onError('mic', …)` 會告訴你原因。`localhost` 算安全來源，開發時可用。
- `listen()` **必須在使用者手勢裡呼叫**，不然瀏覽器不給權限；iOS 每次重新載入都要再給一次。
- **它分不出哭還是笑**，只知道吵。弟弟大叫、電視開很大聲一樣會跳 — 這是刻意的取捨：真的要辨識哭聲得跑聲音分類模型，不是一個 11 KB 的檔案塞得下的。
- 音量門檻跟裝置的麥克風增益有關，**請用 `peak()` 讓使用者自己校**，不要寫死。
- 元件不碰 `localStorage`；設定要存哪裡、怎麼存，由你決定。

## 觸發時機實測

每 150ms 取樣一次、`sustainMs 1000`、`decay 0.35`、門檻 0.08 跑出來的：

| 情況 | 結果 |
|---|---|
| 一直大哭 | 0.9 秒跳 |
| 哭 2 秒停 1 秒（換氣） | 0.9 秒跳 |
| 哭 1 秒停 1.5 秒（斷斷續續） | 0.9 秒跳 |
| 亂叫一聲（約 1 秒） | 0.9 秒跳 |
| 電視背景音（低於門檻） | 不跳 |
| 安靜 | 不跳 |

想改回「要吵久一點才跳」，把 `sustainMs` 調大即可。

## 授權

MIT。
