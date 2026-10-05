---
name: threads-parser
description: 解析 Threads（threads.com / threads.net）貼文：作者、發文時間、全文、圖片影片、互動數、串文與回覆，也能打包成資料夾＋zip。只要訊息裡出現 Threads 連結（/@帳號/post/代碼、/share/xxx 短連結、/t/xxx），就算使用者沒多說一句話、整則訊息只有一個連結，也要立刻用這個 skill 的腳本解析，不要先問要做什麼。Threads 對網頁抓取（web_fetch）只回 JS 空殼，所以不要用 web_fetch 或瀏覽器去開 Threads 連結，也不要回「無法解析」，一律跑這個 skill 的腳本。使用者說「解析這篇」「抓這篇 Threads」「幫我存這篇脆」「打包」「下載圖片影片」「我也想做類似的圖」時也用。
---

# Threads 貼文解析

Threads 對一般瀏覽器只回一頁 JS 空殼，用網頁抓取工具（web_fetch）或瀏覽器看都拿不到內文，
看到「無法解析」「頁面沒有內容」就是這個原因。`scripts/threads.py` 會改用社群預覽爬蟲的 UA
和官方嵌入頁（/embed）取得完整內容，所以一律用這支腳本，不要自己去抓網頁。
它只用 Python 標準函式庫，免安裝。

## 用法

```bash
python3 scripts/threads.py <連結> [<連結> ...]          # Markdown 輸出
python3 scripts/threads.py --json <連結>                # 需要結構化資料時
python3 scripts/threads.py --save <輸出資料夾> <連結>    # 打包
```

`scripts/` 是相對於這個 skill 的資料夾；執行前先 cd 到 skill 目錄，或用完整路徑。

使用者要「打包／存檔／下載圖片影片」時用 `--save`，輸出到使用者拿得到的地方
（claude.ai 上是 `/mnt/user-data/outputs`）。每篇會產生 `<帳號>_<代碼>/`
資料夾（`貼文.html`、`貼文.txt`、`data.json`、`media/`）和同名 `.zip`，把 zip 交給使用者。

使用者要分析圖片（例如「我也想做類似的圖」）時，用 `--save` 把圖片下載下來，
再用檢視檔案的工具打開 `media/` 裡的圖片實際看過再分析，不要只憑網址猜。

## 整理給使用者

依序列出：作者（@帳號）、時間（台北時間）、互動數、連結、全文、圖片／影片連結、串文、回覆。
全文照原文呈現——使用者沒要求就不要翻譯、摘要或改寫，因為他們通常是要保存或引用原文。
串文與回覆也一樣：腳本抓到幾則就逐則列出「@帳號：原文」，不要歸納成「大多是…」這種摘要，
就算回覆只有「存」一個字也照列。
圖片影片網址很長，列成「圖片 1」「影片 1」這種短連結文字即可。

## 出錯時

- `Tunnel connection failed: 403`、`EGRESS_BLOCKED`、`Name or service not known` 之類的網路錯誤：
  是執行環境的網路權限沒開放 Threads，不是連結壞了。請使用者在 claude.ai 的
  設定 → Capabilities（功能）→ Code execution and file creation 底下的 Domain allowlist
  （網域允許清單），在 Additional allowed domains 加入 `www.threads.com`、`threads.com`、
  `www.threads.net`、`threads.net`，以及圖片影片用的 `*.cdninstagram.com`、`*.fbcdn.net`，然後重試。
  手機 App 若找不到這個欄位，請他用瀏覽器開 claude.ai 設定，設定會同步到手機。
- 「找不到貼文網址」：短連結失效或貼文已刪除；請使用者改用 Threads 裡「複製連結」拿到的
  `/@帳號/post/代碼` 完整網址。
- 腳本跑得起來但抓不到內文：多半是 Threads 改版。看 `scripts/threads.py` 的 `from_embed`
  （嵌入頁解析）與 `embedded_posts`（頁內 JSON），對照實際抓到的 HTML 修正後再試。
