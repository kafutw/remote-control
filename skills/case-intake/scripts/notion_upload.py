#!/usr/bin/env python3
"""把本機檔案送到 Notion 的 file upload 網址（只用標準函式庫）。

先用 Notion 工具 create_file_upload 拿到 upload_url 與 authorization，再執行：

    python3 notion_upload.py <upload_url> <authorization> <檔案路徑>

authorization 可以帶或不帶 "Bearer " 前綴。成功時印出 Notion 回傳的 JSON
（含 file_upload_id、status: uploaded），之後用 file_upload_id 掛到頁面欄位。
"""
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid


def upload(url: str, auth: str, path: str) -> dict:
    if not auth.lower().startswith("bearer "):
        auth = "Bearer " + auth
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        data = f.read()
    boundary = "----caseintake" + uuid.uuid4().hex
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode()
    body = head + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": auth,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode(errors='replace')[:800]}")


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    url, auth, path = sys.argv[1:]
    if os.path.getsize(path) > 20 * 1024 * 1024:
        sys.exit("檔案超過 20 MB，Notion 單次上傳不收；請使用者壓縮或改放雲端連結。")
    print(json.dumps(upload(url, auth, path), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
