# CLAUDE.md

## 使用者貼上 Threads 連結時

使用者只要貼上 Threads 連結（`threads.com` / `threads.net`，含 `/share/xxx` 短連結或 `/@user/post/CODE`），不用另外說明，就直接執行：

```bash
python3 tools/threads.py <連結>          # 可一次放多個連結；要 JSON 就加 --json
```

Windows 若沒有 `python3` 指令，改用 `python` 或 `py`。

使用者要「打包」時加 `--save ~/Desktop/Threads`：每篇產生一個資料夾（`貼文.html`、`貼文.txt`、`data.json`、`media/` 圖片影片）和同名 zip。

Mac 桌面 App：`bash tools/install-mac-app.sh` 會在桌面建立「Threads 解析」，複製連結後雙擊即可打包，不必開 Claude Code。

iPhone 捷徑：在 Mac 上跑 `bash tools/install-iphone-shortcut.sh`（產生器是 `tools/build-threads-shortcut.py`），桌面會出現已簽章的「Threads 解析.shortcut」，AirDrop 到 iPhone 加入。在 Threads 按「分享」選它（或複製連結後執行）：顯示全文、作者、時間、互動數，圖片影片存到相簿，全文存成備忘錄。捷徑的解析邏輯是照 `threads.py` 的 `from_embed`／`time_from_code` 寫的，改其中一邊時另一邊也要跟著改。

claude.ai Skill（**手機 claude.ai 聊天用的主路線，2026-10-05 已安裝並實測可用**）：`skills/threads-parser/`（`scripts/threads.py` 是 `tools/threads.py` 的複本），打包成 `skills/threads-parser.skill` 上傳到 claude.ai。
- 已安裝在 claude.ai「Customize → Skills → Yours」的 `threads-parser`，啟用中。
- 網路設定（設定 → Capabilities → Code execution and file creation → Allow network egress 開著、Domain allowlist 維持「Package managers only」）的 Additional allowed domains 已加：`www.threads.com`、`threads.com`、`www.threads.net`、`threads.net`、`*.cdninstagram.com`、`*.fbcdn.net`。個人 Max 帳號就有這個欄位，不需要組織管理員。設定跟著帳號走，手機自動同步。
- 實測：新對話只貼 `https://www.threads.com/share/BAHax6OPkA/`，Claude 自己叫用 skill 跑腳本，給出作者、時間、互動數、全文、串文、回覆；接著說「我也想做類似的圖」會下載圖片與影片實際看過再分析（圖片網域也通）。
- 更新流程：改了 `tools/threads.py` 就複製到 `skills/threads-parser/scripts/`，用 skill-creator 的 `package_skill` 重新打包，再到 claude.ai 該 skill 頁面上傳新版（同名 skill 會變成新版本，不用先刪）。
- 若沒觸發（Claude 改用 web_fetch 說無法解析）：改 `SKILL.md` 的 description，把「只貼連結也要用、不要用 web_fetch」講得更明確再打包上傳。

iPhone 捷徑是備用路線（路線 B），skill 能用就不用它；捷徑還沒實機測過。

把輸出整理給使用者：作者、時間、全文、圖片/影片連結、互動數、串文與回覆。使用者沒要求就不要翻譯或改寫貼文內容。

- 若出現 `Tunnel connection failed: 403`（雲端環境的網路政策擋住 threads.com）：**不要叫使用者改設定，直接改用 GitHub Actions 代抓**，使用者不用做任何事：
  1. GitHub MCP `actions_run_trigger`：`method: run_workflow`、`owner: kafutw`、`repo: remote-control`、`workflow_id: threads.yml`、`ref` 用預設分支（`claude/baby-travel-packing-list-hwk2gb`）、`inputs: {"url": "<連結，多個用空白隔開>"}`；要打包就再加 `"save": "true"`（zip 會在該次執行的 Artifacts，給使用者那次執行的網址）。
  2. 背景 `sleep 45` 等它跑完 → `actions_list`（`list_workflow_runs`，`resource_id: threads.yml`）找最新那次（標題是「Threads 解析 <連結>」）→ `list_workflow_jobs` 拿 job id → `get_job_logs`（`return_content: true`）。
  3. 結果在 log 的 `===== THREADS MARKDOWN BEGIN/END =====`（與 JSON BEGIN/END）之間，照下面的方式整理給使用者。
  - 使用者想讓這個環境自己連得到的話，才請他到環境設定（標題列的雲端環境選單 → Edit → Network access）把 `www.threads.com`、`threads.com`、`www.threads.net` 加進允許清單。
- 若腳本跑得起來但抓不到內文（Threads 改版），修正 `tools/threads.py` 的解析邏輯後再試。
