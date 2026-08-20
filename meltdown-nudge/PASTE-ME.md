# 崩潰提醒 — 整包貼給 AI 用

想把「崩潰提醒」加到別的 App，**把這個檔案整份複製、貼到那個對話框**就好。
下面第一段是給 AI 看的指示，第二段是元件原始碼，第三段是接線範例。

---

## ① 給 AI 的指示（照做就好）

請把下面「② 元件原始碼」整段，原封不動放進這個網頁的 `<script>` 區塊裡（放在主程式的 `<script>` 之前），然後照「③ 怎麼接」把它接到現有的作答流程。要求：

1. **不要改元件的內容**，它已經測過了；要調行為請用 `create()` 的參數。
2. 設定值存在這個 App 自己的 localStorage 紀錄裡，欄位建議：`noiseAt`（0 / 0.10 / 0.16 / 0.24）、`nudgeAt`（0 / 3 / 5）、`tone`（`auto` / `soft` / `fun`）。**預設 `noiseAt: 0.16`、`nudgeAt: 0`**（只有崩潰大叫才跳，答錯不打斷）。
3. 在設定或歷史畫面加一張「崩潰提醒」卡：門檻四選一、連錯三選一、語氣三選一，加一顆「🎤 測一下現在多大聲」按鈕配即時音量條（用 `level()` 和 `peak()`），還要顯示「上一輪最大音量 X，門檻 Y」和權限失敗原因——**沒跳的時候要查得出原因**。
4. **只有在作答的時候才 `listen()`**（而且一定要在使用者按「開始」的那個手勢裡呼叫），一輪結束 `mute()`。
5. 提醒跳出來的時候，**把該題的倒數和「換下一題」的計時器都凍住**，關掉再補回去；App 自己的語音在 `nudge.isOpen()` 時要讓路，不要蓋掉提醒講的話。
6. 這個 App 若是「單檔、離線也要能用」的設計，就用內嵌的方式，不要改成 `<script src>` 去拉外部檔案。

---

## ② 元件原始碼

<!-- BEGIN meltdown-nudge.js -->
```js
（把 meltdown-nudge.js 的完整內容貼在這裡；同一個資料夾裡就有那個檔）
```
<!-- END meltdown-nudge.js -->

> 這個區塊是刻意留空的：原始碼就在隔壁的 [`meltdown-nudge.js`](meltdown-nudge.js)，
> 複製那個檔的全部內容貼進來即可，避免同一份程式在 repo 裡出現兩份、以後改到不同步。

---

## ③ 怎麼接

```js
var nudge = MeltdownNudge.create({
  missStreak: db.nudgeAt,                               // 0 = 答錯不打斷
  noise: db.noiseAt ? { level: db.noiseAt } : null,     // null = 完全不碰麥克風
  tone: db.tone,                                        // 'auto' 先溫柔，鬧不停才促咪
  onShow: function () {                                 // 跳出來了 → 把時間凍住
    S.pausedAt = Date.now();
    freezeReveal();
  },
  onResume: function () { thawRound(); },               // 繼續 → 把凍住的時間補回去
  onStop:   function () { thawRound(); endGame(false); },
  onError:  function (code, msg) { db.micFail = msg; save(); renderMicHint(); }
});

// 作答流程
markWrong(...)   →  nudge.miss();      // 答錯 / 超時
answerRight(...) →  nudge.hit();       // 答對，連錯歸零
startRound()     →  if (db.noiseAt) { nudge.resetPeak(); nudge.listen(); }
endRound()       →  db.lastPeak = nudge.peak(); nudge.mute(); nudge.close(true);
```

計時凍結的兩個小工具（照抄）：

```js
var revealTimer = null, revealAt = 0, revealLeft = 0;
function armReveal(ms) {
  clearTimeout(revealTimer);
  revealAt = Date.now() + ms;
  revealTimer = setTimeout(nextQuestion, ms);
}
function freezeReveal() {
  if (!revealTimer) return;
  revealLeft = Math.max(0, revealAt - Date.now());
  clearTimeout(revealTimer); revealTimer = null;
}
function thawReveal() {
  if (!revealLeft) return;
  armReveal(revealLeft); revealLeft = 0;
}
function thawRound() {
  if (S && S.pausedAt) {
    if (S.qEndAt) S.qEndAt += Date.now() - S.pausedAt;   // 停在提醒上的時間不算他的
    S.pausedAt = 0;
  }
  thawReveal();
}
```

倒數的地方記得加一句：`if (S.pausedAt) return;`，不然提醒還開著時間就一直跑。

---

## ④ 一定要先講清楚的限制

- **麥克風要 https**：`navigator.mediaDevices` 在 `file://` 和純 http 底下根本不存在。`localhost` 可以。
- `listen()` **必須在使用者手勢裡呼叫**；iOS 每次重新載入都要再給一次權限。
- **它分不出哭還是笑**，只知道吵。弟弟大叫、電視很大聲一樣會跳。
- 門檻跟每支手機的麥克風增益有關，**要讓使用者用 `peak()` 自己校**，不要寫死。
- 元件不碰 localStorage，設定存哪裡由 App 決定。

完整參數表在 [`README.md`](README.md)。
