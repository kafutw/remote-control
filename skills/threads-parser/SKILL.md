---
name: threads-parser
description: 解析 Threads（threads.com / threads.net）貼文：作者、發文時間、全文、圖片影片、互動數、串文與回覆，也能打包成資料夾＋zip。只要訊息裡出現 Threads 連結（/@帳號/post/代碼、/share/xxx 短連結、/t/xxx），就算使用者沒多說一句話、只貼了連結，也要用這個 skill 直接解析，不要先問要做什麼。使用者說「解析這篇」「抓這篇 Threads」「幫我存這篇脆」「打包」「下載圖片影片」時也用。
---

# Threads 貼文解析

Threads 對一般瀏覽器只回一頁 JS 空殼，用網頁抓取工具或瀏覽器看通常拿不到內文；
`scripts/threads.py` 會改用社群預覽爬蟲的 UA 和官方嵌入頁（/embed）取得完整內容，
所以一律用這支腳本，不要自己去抓網頁。它只用 Python 標準函式庫，免安裝。

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

## 整理給使用者

依序列出：作者（@帳號）、時間（台北時間）、互動數、連結、全文、圖片／影片連結、串文、回覆。
全文照原文呈現——使用者沒要求就不要翻譯、摘要或改寫，因為他們通常是要保存或引用原文。

## 出錯時

- `Tunnel connection failed: 403`、`EGRESS_BLOCKED`、`Name or service not known` 之類的網路錯誤：
  是執行環境的網路權限沒開放 Threads，不是連結壞了。請使用者在 claude.ai 的
  設定 → Capabilities（功能）→ 程式碼執行的網路存取，把 `www.threads.com`、`threads.com`、
  `www.threads.net`、`*.cdninstagram.com`、`*.fbcdn.net`（圖片影片用）加入允許的網域，
  或改成允許所有網域，然後重試。
- 「找不到貼文網址」：短連結失效或貼文已刪除；請使用者改用 Threads 裡「複製連結」拿到的
  `/@帳號/post/代碼` 完整網址。
- 腳本跑得起來但抓不到內文：多半是 Threads 改版。看 `scripts/threads.py` 的 `from_embed`
  （嵌入頁解析）與 `embedded_posts`（頁內 JSON），對照實際抓到的 HTML 修正後再試。
