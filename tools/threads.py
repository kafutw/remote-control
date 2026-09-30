#!/usr/bin/env python3
"""解析 Threads 貼文：作者、時間、全文、圖片/影片、互動數。

用法：
  python3 tools/threads.py <threads 連結> [...]      # 輸出 Markdown
  python3 tools/threads.py --json <threads 連結>      # 輸出 JSON

支援 threads.com / threads.net 的 /share/xxx 短連結與 /@user/post/CODE 連結。
只用標準函式庫，免安裝套件。
"""
import html
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
TPE = timezone(timedelta(hours=8))
POST_RE = re.compile(r"threads\.(?:com|net)/@([\w.]+)/post/([\w-]+)")


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def meta(page, prop):
    m = re.search(r'<meta[^>]+(?:property|name)="%s"[^>]+content="([^"]*)"' % re.escape(prop), page)
    return html.unescape(m.group(1)) if m else None


def walk(node):
    """走訪巢狀 JSON，產出所有 dict。"""
    stack = [node]
    while stack:
        n = stack.pop()
        if isinstance(n, dict):
            yield n
            stack.extend(n.values())
        elif isinstance(n, list):
            stack.extend(n)


def media_of(post):
    items = post.get("carousel_media") or [post]
    out = []
    for it in items:
        vids = it.get("video_versions") or []
        imgs = (it.get("image_versions2") or {}).get("candidates") or []
        if vids:
            out.append({"type": "video", "url": vids[0].get("url")})
        elif imgs:
            best = max(imgs, key=lambda c: c.get("width") or 0)
            out.append({"type": "image", "url": best.get("url")})
    return [m for m in out if m["url"]]


def from_post(post):
    info = post.get("text_post_app_info") or {}
    user = post.get("user") or {}
    ts = post.get("taken_at")
    text = (post.get("caption") or {}).get("text")
    if not text:  # 新版把全文拆成 text_fragments
        frags = ((info.get("text_fragments") or {}).get("fragments")) or []
        text = "".join(f.get("plaintext", "") for f in frags) or None
    return {
        "username": user.get("username"),
        "code": post.get("code"),
        "time": datetime.fromtimestamp(ts, TPE).strftime("%Y-%m-%d %H:%M") if ts else None,
        "text": text,
        "likes": post.get("like_count"),
        "replies": info.get("direct_reply_count"),
        "reposts": info.get("repost_count"),
        "quotes": info.get("quote_count"),
        "media": media_of(post),
    }


def embedded_posts(page):
    """從頁面內嵌的 JSON 找出所有貼文物件（主文 + 串文 + 回覆）。"""
    posts, seen = [], set()
    for blob in re.findall(r'<script type="application/json"[^>]*>(.*?)</script>', page, re.S):
        if "taken_at" not in blob:
            continue
        try:
            data = json.loads(blob)
        except ValueError:
            continue
        for d in walk(data):
            if "taken_at" in d and "code" in d and d.get("pk") not in seen:
                seen.add(d.get("pk"))
                posts.append(from_post(d))
    return sorted(posts, key=lambda p: p["time"] or "")


def parse(url):
    final, page = fetch(url)
    m = POST_RE.search(final) or POST_RE.search(page)
    username, code = (m.group(1), m.group(2)) if m else (None, None)
    canonical = f"https://www.threads.com/@{username}/post/{code}" if m else final

    posts = embedded_posts(page)
    main = next((p for p in posts if p["code"] == code), None)
    # 同作者、緊接在主文之後的是串文（續篇），其他作者的是回覆
    thread, replies = [], []
    for p in posts:
        if p is main:
            continue
        (thread if p["username"] == username else replies).append(p)

    if not main:  # 抓不到內嵌 JSON 時，退回 og: 標籤
        title = meta(page, "og:title") or ""
        img = meta(page, "og:image")
        main = {
            "username": username,
            "code": code,
            "time": None,
            "text": meta(page, "og:description") or meta(page, "description"),
            "likes": None, "replies": None, "reposts": None, "quotes": None,
            "media": [{"type": "image", "url": img}] if img else [],
            "display_name": title.split(" (@")[0] or None,
        }
    return {"url": canonical, "post": main, "thread": thread, "replies": replies}


def to_markdown(r):
    p = r["post"]
    lines = [f"## @{p['username']} 的 Threads 貼文", "", f"- 連結：{r['url']}"]
    if p.get("time"):
        lines.append(f"- 時間：{p['time']}（台北）")
    stats = [(k, p.get(k)) for k in ("likes", "replies", "reposts", "quotes")]
    label = {"likes": "讚", "replies": "回覆", "reposts": "轉發", "quotes": "引用"}
    s = "・".join(f"{label[k]} {v}" for k, v in stats if v is not None)
    if s:
        lines.append(f"- 互動：{s}")
    lines += ["", p.get("text") or "（無文字）"]

    def media(ms):
        return [f"- {'🎬' if m['type'] == 'video' else '🖼️'} {m['url']}" for m in ms]

    if p["media"]:
        lines += ["", "### 媒體"] + media(p["media"])
    for i, t in enumerate(r["thread"], 2):
        lines += ["", f"### 串文 {i}", t.get("text") or ""] + media(t["media"])
    if r["replies"]:
        lines += ["", "### 回覆"]
        for c in r["replies"]:
            lines.append(f"- **@{c['username']}**：{(c.get('text') or '').strip()}")
    return "\n".join(lines)


def main(argv):
    as_json = "--json" in argv
    failed = 0
    urls = [a for a in argv if not a.startswith("--")]
    if not urls:
        print(__doc__)
        return 1
    for u in urls:
        try:
            r = parse(u)
        except Exception as e:  # noqa: BLE001
            print(f"❌ 無法解析 {u}：{e}", file=sys.stderr)
            failed += 1
            continue
        print(json.dumps(r, ensure_ascii=False, indent=2) if as_json else to_markdown(r))
        print()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
