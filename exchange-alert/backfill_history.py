#!/usr/bin/env python3
"""一次性回補歷史匯率:從台灣銀行歷史牌告 CSV 抓過去一年 USD、JPY 的每日即期中價。

只在 history.json 尚未回補過時執行(backfilled 旗標);已有的觀測日不覆蓋,
因此排程即時抓的數據永遠優先。任何月份抓取失敗都只略過該月,不中斷。
"""

import json
import re
import sys
import urllib.request
from datetime import date, timedelta, timezone, datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
TAIPEI = timezone(timedelta(hours=8))
MONTHS_BACK = 13


def http_get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (exchange-alert)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8-sig")


def parse_history_csv(text: str) -> dict:
    """台銀歷史 CSV 每列含日期與買入/賣出區塊,以「本行買入/本行賣出」標籤定位即期欄位。"""
    out = {}
    for line in text.splitlines():
        fields = [f.strip() for f in line.split(",")]
        if "本行買入" not in fields or "本行賣出" not in fields:
            continue
        m = re.match(r"^(\d{4})(\d{2})(\d{2})$", fields[0])
        if not m:
            continue
        day = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        try:
            buy = float(fields[fields.index("本行買入") + 2])
            sell = float(fields[fields.index("本行賣出") + 2])
        except (ValueError, IndexError):
            continue
        if buy > 0 and sell > 0:
            out[day] = (buy + sell) / 2
    return out


def month_list(today: date) -> list:
    months, y, m = [], today.year, today.month
    for _ in range(MONTHS_BACK):
        months.append(f"{y}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return sorted(months)


def main() -> int:
    hist_path = BASE / "history.json"
    history = json.loads(hist_path.read_text(encoding="utf-8")) if hist_path.exists() \
        else {"observations": [], "last_alerts": {}}
    if history.get("backfilled"):
        print("已回補過,略過。")
        return 0

    today = datetime.now(TAIPEI).date()
    usd, jpy = {}, {}
    for month in month_list(today):
        for cur, store in (("USD", usd), ("JPY", jpy)):
            url = f"https://rate.bot.com.tw/xrt/flcsv/0/{month}/{cur}"
            try:
                store.update(parse_history_csv(http_get(url)))
            except Exception as exc:  # noqa: BLE001 - 單月失敗不中斷
                print(f"略過 {month} {cur}: {exc}")

    existing = {o["date"] for o in history["observations"]}
    added = 0
    for day in sorted(set(usd) & set(jpy)):
        if day in existing:
            continue
        u, j = usd[day], jpy[day]
        history["observations"].append({
            "date": day,
            "usd_twd": round(u, 4),
            "jpy_twd": round(j, 5),
            "usd_jpy": round(u / j, 3),
            "source": "台灣銀行歷史牌告(即期中價,回補)",
        })
        added += 1
    history["observations"].sort(key=lambda o: o["date"])

    # 至少要補到七成的交易日才算成功,否則下次再試
    if added >= 150:
        history["backfilled"] = True
    print(f"回補 {added} 天(USD {len(usd)} 天、JPY {len(jpy)} 天,backfilled={history.get('backfilled', False)})")

    hist_path.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
