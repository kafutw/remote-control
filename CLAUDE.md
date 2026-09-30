# CLAUDE.md

## 使用者貼上 Threads 連結時

使用者只要貼上 Threads 連結（`threads.com` / `threads.net`，含 `/share/xxx` 短連結或 `/@user/post/CODE`），不用另外說明，就直接執行：

```bash
python3 tools/threads.py <連結>          # 可一次放多個連結；要 JSON 就加 --json
```

把輸出整理給使用者：作者、時間、全文、圖片/影片連結、互動數、串文與回覆。使用者沒要求就不要翻譯或改寫貼文內容。

- 若出現 `Tunnel connection failed: 403`：代表雲端環境的網路政策擋住了 threads.com。請使用者到環境設定（標題列的雲端環境選單 → Edit → Network access）把 `www.threads.com`、`threads.com`、`www.threads.net` 加進允許清單，或改成更寬的存取等級。
- 若腳本跑得起來但抓不到內文（Threads 改版），修正 `tools/threads.py` 的解析邏輯後再試。
