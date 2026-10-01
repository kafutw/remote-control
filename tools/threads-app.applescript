-- 桌面「Threads 解析」App：貼上連結 → 打包到桌面的 Threads 資料夾
-- 由 tools/install-mac-app.sh 編譯，__REPO__ 會換成專案路徑
set repo to "__REPO__"

set clip to ""
try
	set clip to the clipboard as text
end try
if clip does not contain "threads." then set clip to ""

set dlg to display dialog "貼上 Threads 連結（多個用空白隔開）：" default answer clip with title "Threads 解析" buttons {"取消", "解析"} default button "解析" cancel button "取消"
set u to text returned of dlg
if u is "" then return

display notification "解析中，請稍候…" with title "Threads 解析"
set cmd to "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH GIT_TERMINAL_PROMPT=0; mkdir -p ~/Desktop/Threads; cd " & quoted form of repo & " && (git pull -q --ff-only >/dev/null 2>&1 || true); python3 tools/threads.py --save ~/Desktop/Threads " & quoted form of u & " 2>&1; true"
set out to do shell script cmd
do shell script "open ~/Desktop/Threads"

if out contains "❌" then
	display dialog out buttons {"好"} default button "好" with title "Threads 解析" with icon caution
else
	display notification "完成！已存到桌面的 Threads 資料夾" with title "Threads 解析"
end if
