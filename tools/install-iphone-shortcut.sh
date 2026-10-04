#!/bin/bash
# 產生並簽章 iPhone 捷徑「Threads 解析」。要在 Mac 上跑（macOS 12 以上、已登入 iCloud）。
# 用法：bash tools/install-iphone-shortcut.sh
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HOME/Desktop/Threads 解析.shortcut"
TMP="$(mktemp -d)"
python3 "$REPO/tools/build-threads-shortcut.py" "$TMP/unsigned.shortcut" >/dev/null
shortcuts sign --mode anyone --input "$TMP/unsigned.shortcut" --output "$OUT"
rm -rf "$TMP"
echo "✅ 已在桌面產生「Threads 解析.shortcut」"
echo "   iPhone 安裝：把這個檔案 AirDrop 到 iPhone → 按「加入捷徑」"
echo "   （或在 Mac 上雙擊加入，有開 iCloud 同步的話 iPhone 會自動出現）"
echo "   用法：Threads 貼文按「分享」→「Threads 解析」；或複製連結後在捷徑 App 執行"
open -R "$OUT"
