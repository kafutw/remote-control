#!/bin/bash
# 在 Mac 桌面建立「Threads 解析」App。用法：bash tools/install-mac-app.sh
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Desktop/Threads 解析.app"
TMP="$(mktemp -d)"
sed "s|__REPO__|$REPO|" "$REPO/tools/threads-app.applescript" > "$TMP/app.applescript"
rm -rf "$APP"
osacompile -o "$APP" "$TMP/app.applescript"
rm -rf "$TMP"
echo "✅ 已在桌面建立「Threads 解析」"
echo "   用法：複製 Threads 連結 → 雙擊桌面的「Threads 解析」→ 按「解析」"
echo "   結果會放在桌面的 Threads 資料夾（每篇一個資料夾＋一個 zip）"
