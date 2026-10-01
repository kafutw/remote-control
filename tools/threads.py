#!/usr/bin/env python3
"""解析 Threads 貼文：作者、時間、全文、圖片/影片、互動數。

用法：
  python3 tools/threads.py <threads 連結> [...]      # 輸出 Markdown
  python3 tools/threads.py --json <threads 連結>      # 輸出 JSON
  python3 tools/threads.py --save <資料夾> <連結>     # 打包：文字、圖片影片、網頁、zip

支援 threads.com / threads.net 的 /share/xxx 短連結與 /@user/post/CODE 連結。
只用標準函式庫，免安裝套件。
"""
import html
import json
import os
import re
import shutil
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
TPE = timezone(timedelta(hours=8))
# 也接受相對路徑（/@user/post/CODE），頁面 JSON 裡常是這種寫法
POST_RE = re.compile(r"/@([\w.]+)/post/([\w-]+)")


# Threads 對未登入的瀏覽器有時會導去 error=invalid_post，
# 社群預覽爬蟲的 UA 通常仍拿得到完整頁面，所以輪流試。
CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"


class _Track(urllib.request.HTTPRedirectHandler):
    """記下每一站轉址：短連結常是 share → /@user/post/CODE → ?error=invalid_post，
    貼文網址只出現在中間那站。"""

    def __init__(self, chain):
        self.chain = chain

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, ua=UA):
    """回傳（轉址路線上所有網址, 最終頁面 HTML）。"""
    chain = [url]
    opener = urllib.request.build_opener(_Track(chain))
    req = urllib.request.Request(url, headers={
        "User-Agent": ua,
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml",
    })
    with opener.open(req, timeout=20) as r:
        return chain, r.read().decode("utf-8", "replace")


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


def from_embed(page):
    """解析 /embed 頁面（官方嵌入用，不需登入）。"""
    m = re.search(r'class="[^"]*BodyText[^"]*"[^>]*>(.*?)</(?:span|div)>', page, re.S)
    if not m:
        return None
    text = re.sub(r"<br\s*/?>", "\n", m.group(1))
    text = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
    media = []
    for src in re.findall(r'<(?:img|video|source)[^>]+src="([^"]+)"', page):
        src = html.unescape(src)
        # 排除頭像（小尺寸）
        if re.search(r"(cdninstagram|fbcdn)", src) and not re.search(r"s150x150|_s\d{2,3}x\d{2,3}|profile", src):
            kind = "video" if ".mp4" in src else "image"
            if not any(x["url"] == src for x in media):
                media.append({"type": kind, "url": src})
    return text, media


def resolve(url):
    """短連結 → 貼文網址。Threads 對不同 UA 給的轉址不同，輪流試。"""
    m = POST_RE.search(url)
    if m:
        return m, "", []
    tried = []
    for ua in (UA, "curl/8.4.0", CRAWLER_UA):
        try:
            chain, page = fetch(url, ua)
        except Exception as e:  # noqa: BLE001
            tried.append(f"{ua.split('/')[0]}: {e}")
            continue
        tried.append(f"{ua.split('/')[0]}: " + " → ".join(chain))
        for text in chain + [page]:
            m = POST_RE.search(text.replace("\\/", "/"))
            if m:
                return m, page, tried
    return None, "", tried


def parse(url):
    m, page, tried = resolve(url)
    if not m:
        raise ValueError("找不到貼文網址（連結可能失效或貼文已刪除）\n" + "\n".join(tried))
    username, code = m.group(1), m.group(2)
    canonical = f"https://www.threads.com/@{username}/post/{code}"

    pages = [page]
    posts = embedded_posts(page)
    main = next((p for p in posts if p["code"] == code), None)
    for ua in (UA, CRAWLER_UA):
        if main:
            break
        try:
            _, page = fetch(canonical, ua)
        except Exception:  # noqa: BLE001
            continue
        pages.append(page)
        posts = embedded_posts(page)
        main = next((p for p in posts if p["code"] == code), None)

    thread, replies = [], []
    if main:
        # 同作者的是串文（續篇），其他作者的是回覆
        for p in posts:
            if p is not main:
                (thread if p["username"] == username else replies).append(p)
    else:
        main = {"username": username, "code": code, "time": None, "text": None,
                "likes": None, "replies": None, "reposts": None, "quotes": None, "media": []}
        try:  # 官方嵌入頁
            _, epage = fetch(canonical + "/embed")
            got = from_embed(epage)
            if got:
                main["text"], main["media"] = got
        except Exception:  # noqa: BLE001
            pass
        if not main["text"]:  # 最後退回 og: 標籤
            for pg in reversed(pages):
                desc = meta(pg, "og:description")
                if desc:
                    main["text"] = desc
                    img = meta(pg, "og:image")
                    if img and not main["media"]:
                        main["media"] = [{"type": "image", "url": img}]
                    break
        if not main["text"] and not main["media"]:
            raise ValueError("抓不到貼文內容（可能需要登入才能看，或 Threads 改版）")
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


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
        shutil.copyfileobj(r, f)


def save_package(r, outdir):
    """打包成資料夾 + zip：貼文.html（含圖）、貼文.txt、data.json、media/。"""
    p = r["post"]
    name = f"{p['username']}_{p['code']}"
    folder = os.path.join(outdir, name)
    os.makedirs(os.path.join(folder, "media"), exist_ok=True)

    n = 0
    for post in [p] + r["thread"]:
        for m in post["media"]:
            n += 1
            ext = ".mp4" if m["type"] == "video" else ".jpg"
            em = re.search(r"\.(jpe?g|png|webp|heic|mp4|mov)(?:\?|$)", m["url"])
            if em:
                ext = "." + em.group(1)
            m["file"] = f"media/{n:02d}{ext}"
            try:
                download(m["url"], os.path.join(folder, m["file"]))
            except Exception as e:  # noqa: BLE001
                m["file"] = None
                print(f"⚠️ 媒體下載失敗：{m['url']}（{e}）", file=sys.stderr)

    with open(os.path.join(folder, "貼文.txt"), "w", encoding="utf-8") as f:
        f.write(to_markdown(r) + "\n")
    with open(os.path.join(folder, "data.json"), "w", encoding="utf-8") as f:
        json.dump(r, f, ensure_ascii=False, indent=2)
    with open(os.path.join(folder, "貼文.html"), "w", encoding="utf-8") as f:
        f.write(to_html(r))

    zip_path = shutil.make_archive(folder, "zip", outdir, name)
    return folder, zip_path


def to_html(r):
    e = html.escape
    p = r["post"]

    def block(post, title=None):
        out = [f"<h2>{e(title)}</h2>"] if title else []
        out.append(f'<div class="text">{e(post.get("text") or "")}</div>')
        for m in post["media"]:
            src = m.get("file") or m["url"]
            out.append(f'<video src="{e(src)}" controls></video>' if m["type"] == "video"
                       else f'<img src="{e(src)}" loading="lazy">')
        return "\n".join(out)

    label = {"likes": "讚", "replies": "回覆", "reposts": "轉發", "quotes": "引用"}
    stats = "・".join(f"{v} {p[k]}" for k, v in label.items() if p.get(k) is not None)
    body = [f"<h1>@{e(p['username'] or '')}</h1>",
            f'<p class="meta"><a href="{e(r["url"])}">{e(r["url"])}</a><br>'
            f'{e(p.get("time") or "")}{"（台北）" if p.get("time") else ""} {e(stats)}</p>',
            block(p)]
    for i, t in enumerate(r["thread"], 2):
        body.append(block(t, f"串文 {i}"))
    if r["replies"]:
        body.append("<h2>回覆</h2><ul>" + "".join(
            f"<li><b>@{e(c['username'] or '')}</b>：{e((c.get('text') or '').strip())}</li>"
            for c in r["replies"]) + "</ul>")
    return f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@{e(p['username'] or '')} 的 Threads 貼文</title><style>
body{{max-width:640px;margin:0 auto;padding:24px 16px;font:17px/1.7 -apple-system,"PingFang TC",sans-serif;color:#222;background:#fff}}
.meta{{color:#777;font-size:14px}} .text{{white-space:pre-wrap;margin:16px 0}}
img,video{{width:100%;border-radius:12px;margin:8px 0}} h2{{font-size:18px;margin-top:32px}}
@media (prefers-color-scheme:dark){{body{{background:#111;color:#eee}} a{{color:#8ab4f8}}}}
</style></head><body>{"".join(body)}</body></html>"""


def main(argv):
    as_json = "--json" in argv
    outdir = None
    if "--save" in argv:
        i = argv.index("--save")
        outdir = os.path.expanduser(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    failed = 0
    # 允許一個參數裡用空白／換行放多個連結（桌面 App 會整段丟進來）
    urls = [u for a in argv if not a.startswith("--") for u in a.split()]
    if not urls:
        print(__doc__)
        return 1
    for u in urls:
        try:
            r = parse(u)
            if outdir:
                folder, zip_path = save_package(r, outdir)
                print(f"✅ {folder}")
                continue
        except Exception as e:  # noqa: BLE001
            print(f"❌ 無法解析 {u}：{e}", file=sys.stderr)
            failed += 1
            continue
        print(json.dumps(r, ensure_ascii=False, indent=2) if as_json else to_markdown(r))
        print()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
