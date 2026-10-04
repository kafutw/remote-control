#!/usr/bin/env python3
"""產生 iPhone／Mac 捷徑「Threads 解析」(.shortcut，未簽章)。

用法：python3 tools/build-threads-shortcut.py <輸出檔.shortcut>
簽章與安裝請用 tools/install-iphone-shortcut.sh（要在 Mac 上跑）。

捷徑流程跟 tools/threads.py 一樣：
  分享的連結（沒有就用剪貼簿）→ 找出 @帳號/post/代碼（短連結先用爬蟲 UA 抓一次）
  → 抓 /embed 頁 → 全文、圖片影片、互動數 → 由貼文代碼推算發文時間
  → 圖片影片存到相簿、全文存成備忘錄、最後顯示結果。
"""
import plistlib
import sys
import uuid

CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
SHORTCODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
# 貼文代碼前 41 位元是 2011-08-24 起算的毫秒數（同 threads.py 的 time_from_code）。
# 捷徑沒有 Unix 時間，改以「2020-01-01 08:00 台北」= 1577836800 為基準日加秒數。
CODE_EPOCH_SEC = 1314220021.721
REF_UNIX, REF_LOCAL = 1577836800, "2020-01-01 08:00"


# ---- 捷徑 plist 的積木 ----------------------------------------------------

def var(name):
    return {"Type": "Variable", "VariableName": name}


INPUT = {"Type": "ExtensionInput"}
ITEM = var("Repeat Item")


def att(a):
    return {"Value": a, "WFSerializationType": "WFTextTokenAttachment"}


def tok(*parts):
    """文字欄位：字串與變數混排。變數位置用 UTF-16 長度計算（NSRange）。"""
    s, ranges = "", {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            ranges["{%d, 1}" % (len(s.encode("utf-16-le")) // 2)] = p
            s += "￼"
    return {"Value": {"string": s, "attachmentsByRange": ranges},
            "WFSerializationType": "WFTextTokenString"}


def cond_input(a):
    return {"Type": "Variable", "Variable": att(a)}


class Builder:
    def __init__(self):
        self.actions = []

    def add(self, ident, out_name=None, **params):
        """加一個動作；有 out_name 就回傳它的輸出（給後面的動作引用）。"""
        ref = None
        if out_name:
            u = str(uuid.uuid4()).upper()
            params["UUID"] = u
            ref = {"Type": "ActionOutput", "OutputUUID": u, "OutputName": out_name}
        self.actions.append({"WFWorkflowActionIdentifier": ident,
                             "WFWorkflowActionParameters": params})
        return ref

    # 常用動作
    def comment(self, text):
        self.add("is.workflow.actions.comment", WFCommentActionText=text)

    def text(self, *parts):
        return self.add("is.workflow.actions.gettext", "文字", WFTextActionText=tok(*parts))

    def number(self, n):
        return self.add("is.workflow.actions.number", "數字", WFNumberActionNumber=n)

    def set(self, name, value):
        self.add("is.workflow.actions.setvariable", WFVariableName=name, WFInput=att(value))
        return var(name)

    def match(self, source, pattern):
        return self.add("is.workflow.actions.text.match", "符合項目", text=tok(source),
                        WFMatchTextPattern=pattern, WFMatchTextCaseSensitive=True)

    def group(self, matches, index):
        return self.add("is.workflow.actions.text.match.getgroup", "群組", matches=att(matches),
                        WFGetGroupType="Group At Index", WFGroupIndex=index)

    def first(self, items):
        return self.add("is.workflow.actions.getitemfromlist", "列表中的項目",
                        WFInput=att(items), WFItemSpecifier="First Item")

    def replace(self, source, find, repl, regex=False):
        f = tok(*find) if isinstance(find, tuple) else find
        return self.add("is.workflow.actions.text.replace", "更新後的文字", WFInput=tok(source),
                        WFReplaceTextFind=f, WFReplaceTextReplace=repl,
                        WFReplaceTextRegularExpression=regex, WFReplaceTextCaseSensitive=True)

    def fetch(self, *url_parts, ua=None):
        p = {"WFURL": tok(*url_parts), "WFHTTPMethod": "GET"}
        if ua:
            p["ShowHeaders"] = True
            p["WFHTTPHeaders"] = {"Value": {"WFDictionaryFieldValueItems": [
                {"WFItemType": 0, "WFKey": tok("User-Agent"), "WFValue": tok(ua)}]},
                "WFSerializationType": "WFDictionaryFieldValue"}
        return self.add("is.workflow.actions.downloadurl", "URL 的內容", **p)

    def math(self, a, op, b):
        return self.add("is.workflow.actions.math", "計算結果", WFInput=att(a),
                        WFMathOperation=op, WFMathOperand=b if isinstance(b, (int, float)) else att(b))

    def count_chars(self, source):
        return self.add("is.workflow.actions.count", "計數", Input=att(source), WFCountType="Characters")

    def alert_exit(self, title, msg):
        self.add("is.workflow.actions.alert", WFAlertActionTitle=title,
                 WFAlertActionMessage=msg, WFAlertActionCancelButtonShown=False)
        self.add("is.workflow.actions.exit")

    # 流程控制
    def if_(self, value, condition, string=None):
        g = str(uuid.uuid4()).upper()
        p = {"GroupingIdentifier": g, "WFControlFlowMode": 0,
             "WFInput": cond_input(value), "WFCondition": condition}
        if string is not None:
            p["WFConditionalActionString"] = tok(string)
        self.add("is.workflow.actions.conditional", **p)
        return g

    def else_(self, g):
        self.add("is.workflow.actions.conditional", GroupingIdentifier=g, WFControlFlowMode=1)

    def end_if(self, g):
        self.add("is.workflow.actions.conditional", GroupingIdentifier=g, WFControlFlowMode=2)

    def repeat(self, items):
        g = str(uuid.uuid4()).upper()
        self.add("is.workflow.actions.repeat.each", GroupingIdentifier=g,
                 WFControlFlowMode=0, WFInput=att(items))
        return g

    def end_repeat(self, g):
        self.add("is.workflow.actions.repeat.each", GroupingIdentifier=g, WFControlFlowMode=2)


HAS_VALUE, NO_VALUE, CONTAINS = 100, 101, 99
POST_RE = r"/@([\w.]+)/post/([\w-]+)"


def build():
    b = Builder()
    b.comment("Threads 解析：在 Threads 按「分享」選這個捷徑，或先複製連結再執行。\n"
              "由 tools/build-threads-shortcut.py 產生，解析邏輯同 tools/threads.py。")

    # 1. 找出 @帳號/post/代碼
    m = b.match(INPUT, POST_RE)
    b.set("比對", m)
    g = b.if_(m, NO_VALUE)
    link = b.match(INPUT, r"https?://\S+")
    g2 = b.if_(link, NO_VALUE)
    b.alert_exit("Threads 解析", "找不到 Threads 連結。請在 Threads 按「分享」選這個捷徑，或先複製貼文連結再執行。")
    b.end_if(g2)
    page = b.fetch(b.first(link), ua=CRAWLER_UA)  # 短連結：爬蟲 UA 會轉址到貼文頁
    page = b.replace(page, "\\/", "/")
    m2 = b.match(page, POST_RE)
    g2 = b.if_(m2, NO_VALUE)
    b.alert_exit("Threads 解析", "找不到貼文網址（連結可能失效或貼文已刪除）。")
    b.end_if(g2)
    b.set("比對", m2)
    b.end_if(g)

    first = b.first(var("比對"))
    user = b.set("帳號", b.group(first, 1))
    code = b.set("代碼", b.group(first, 2))
    url = b.set("網址", b.text("https://www.threads.com/@", user, "/post/", code))

    # 2. 官方嵌入頁（不用登入）
    embed = b.set("嵌入頁", b.fetch(url, "/embed", ua=CRAWLER_UA))
    region = b.match(embed, r'(?s)class="BodyTextContainer"[^>]*>(.*?)(?:class="PostDateContainer"|\z)')
    g = b.if_(region, NO_VALUE)
    b.alert_exit("Threads 解析", "抓不到貼文內容（可能需要登入才能看、貼文已刪除，或 Threads 改版）。")
    b.end_if(g)
    body = b.set("內文區", b.group(b.first(region), 1))

    # 3. 全文：第一個 <div 之前；<br> 換行、去標籤、解 HTML 實體
    t = b.group(b.first(b.match(body, r"(?s)^(.*?)(?:<div|\z)")), 1)
    t = b.replace(t, r"<br\s*/?>", "\n", regex=True)
    t = b.replace(t, r"<[^>]+>", "", regex=True)
    for ent, ch in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#039;", "'"),
                    ("&#39;", "'"), ("&#x27;", "'"), ("&nbsp;", " "), ("&amp;", "&")):
        t = b.replace(t, ent, ch)
    t = b.replace(t, r"^\s+|\s+$", "", regex=True)
    b.set("全文", t)

    # 4. 圖片影片：內文區裡的 img / video / source，略過影片封面與重複，下載後存到相簿
    posters = b.group(b.match(body, r'poster="([^"]+)"'), 1)
    b.set("封面", b.text("posters:\n", posters))
    b.set("已存", b.text("saved:"))
    b.set("數量", b.number(0))
    loop = b.repeat(b.match(body, r'<(?:img|video|source)\b[^>]*?\ssrc="([^"]+)"'))
    raw = b.set("原始網址", b.group(ITEM, 1))
    skip = b.text(var("封面"), "\n", var("已存"))
    g = b.if_(skip, CONTAINS, raw)
    b.else_(g)
    real = b.replace(raw, "&amp;", "&")
    b.add("is.workflow.actions.savetocameraroll", WFInput=att(b.fetch(real)),
          WFCameraRollSelectedGroup="Recents")
    b.set("已存", b.text(var("已存"), "\n", raw))
    b.set("數量", b.math(var("數量"), "+", 1))
    b.end_if(g)
    b.end_repeat(loop)

    # 5. 互動數：ActionBarCount 依序是 讚、回覆、轉發、分享
    counts = b.match(embed, r'(?s)class="ActionBarCount">([^<]*)<.*?class="ActionBarCount">([^<]*)<'
                            r'.*?class="ActionBarCount">([^<]*)<.*?class="ActionBarCount">([^<]*)<')
    g = b.if_(counts, HAS_VALUE)
    c = b.first(counts)
    cs = [b.group(c, i) for i in (1, 2, 3, 4)]
    b.set("互動", b.text("讚 ", cs[0], "・回覆 ", cs[1], "・轉發 ", cs[2], "・分享 ", cs[3]))
    b.else_(g)
    b.set("互動", b.text("（未取得）"))
    b.end_if(g)

    # 6. 發文時間：代碼轉成數字 pk，(pk >> 23) 是 2011-08-24 起算的毫秒
    b.set("字母表", b.text(SHORTCODE))
    b.set("pk", b.number(0))
    loop = b.repeat(b.match(code, r"[A-Za-z0-9_-]"))
    # 字母表裡「這個字元之後全部刪掉」，剩下的長度就是它的索引
    head = b.replace(var("字母表"), (ITEM, ".*"), "", regex=True)
    idx = b.count_chars(head)
    b.set("pk", b.math(b.math(var("pk"), "×", 64), "+", idx))
    b.end_repeat(loop)
    sec = b.math(b.math(var("pk"), "÷", 8388608), "÷", 1000)
    sec = b.math(sec, "+", round(CODE_EPOCH_SEC - REF_UNIX, 3))
    sec = b.add("is.workflow.actions.round", "四捨五入後的數字", WFInput=att(sec),
                WFRoundMode="Always Round Down")
    ref = b.add("is.workflow.actions.date", "日期", WFDateActionMode="Specified Date",
                WFDateActionDate=REF_LOCAL)
    when = b.add("is.workflow.actions.adjustdate", "調整後的日期", WFDate=tok(ref),
                 WFAdjustOperation="Add",
                 WFDuration={"Value": {"Magnitude": att(sec), "Unit": "sec"},
                             "WFSerializationType": "WFQuantityFieldValue"})
    when = b.add("is.workflow.actions.format.date", "格式化的日期", WFDate=tok(when),
                 WFDateFormatStyle="Custom", WFDateFormat="yyyy-MM-dd HH:mm")
    b.set("時間", when)

    # 7. 存備忘錄、顯示結果
    result = b.set("結果", b.text(
        "@", user, " 的 Threads 貼文\n時間：", var("時間"), "（台北）\n互動：", var("互動"),
        "\n連結：", url, "\n\n", var("全文"), "\n\n（", var("數量"), " 個圖片／影片已存到相簿）"))
    b.add("com.apple.mobilenotes.SharingExtension", WFCreateNoteInput=tok(result), ShowWhenRun=False)
    b.add("is.workflow.actions.showresult", Text=tok(result))

    return {
        "WFWorkflowClientVersion": "2607.0.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 255, "WFWorkflowIconGlyphNumber": 59511},
        "WFWorkflowImportQuestions": [],
        "WFWorkflowTypes": ["ActionExtension"],
        "WFWorkflowInputContentItemClasses": ["WFURLContentItem", "WFStringContentItem"],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowNoInputBehavior": {"Name": "WFWorkflowNoInputBehaviorGetClipboard", "Parameters": {}},
        "WFWorkflowOutputContentItemClasses": [],
        "WFQuickActionSurfaces": [],
        "WFWorkflowActions": b.actions,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    with open(sys.argv[1], "wb") as f:
        plistlib.dump(build(), f, fmt=plistlib.FMT_BINARY)
    print(f"✅ 已產生 {sys.argv[1]}（未簽章，iPhone 要先在 Mac 上用 shortcuts sign 簽章才能匯入）")
