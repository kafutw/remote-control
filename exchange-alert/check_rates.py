#!/usr/bin/env python3
"""匯率警報器:抓取 USD/TWD、USD/JPY、JPY/TWD,依 config.json 的規則判斷是否發警報。

資料來源:
  1. 台灣銀行牌告匯率 CSV(即期買入/賣出的中價)— 最接近實際換匯會拿到的價格
  2. open.er-api.com(國際中價)— 台銀抓不到時的備援

執行結果:
  - 一律更新 history.json(每天保留一筆最新觀測值,供「N 日新高/新低」判斷)
  - 若有規則觸發且不在冷卻期內,寫出 alert_title.txt 與 alert_body.md,
    由 GitHub Actions workflow 拿去開 Issue(GitHub 會寄 email 通知)
"""

import csv
import io
import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
TAIPEI = timezone(timedelta(hours=8))

PAIR_KEYS = {
    "USD/TWD": "usd_twd",
    "USD/JPY": "usd_jpy",
    "JPY/TWD": "jpy_twd",
}


def http_get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (exchange-alert)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8-sig")


def fetch_bot_taiwan() -> dict:
    """台灣銀行牌告匯率。CSV 欄位:0=幣別、3=即期買入、13=即期賣出。"""
    text = http_get("https://rate.bot.com.tw/xrt/flcsv/0/day")
    spot = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 14 or row[0].strip() not in ("USD", "JPY"):
            continue
        try:
            buy = float(row[3])
            sell = float(row[13])
        except ValueError:
            continue
        if buy > 0 and sell > 0:
            spot[row[0].strip()] = (buy + sell) / 2
    if "USD" not in spot or "JPY" not in spot:
        raise RuntimeError("台銀 CSV 缺少 USD 或 JPY 的即期匯率")
    usd_twd, jpy_twd = spot["USD"], spot["JPY"]
    return {
        "usd_twd": round(usd_twd, 4),
        "jpy_twd": round(jpy_twd, 5),
        "usd_jpy": round(usd_twd / jpy_twd, 3),
        "source": "台灣銀行牌告匯率(即期中價)",
    }


def fetch_erapi() -> dict:
    data = json.loads(http_get("https://open.er-api.com/v6/latest/USD"))
    if data.get("result") != "success":
        raise RuntimeError(f"open.er-api.com 回應異常: {data.get('result')}")
    twd = float(data["rates"]["TWD"])
    jpy = float(data["rates"]["JPY"])
    return {
        "usd_twd": round(twd, 4),
        "usd_jpy": round(jpy, 3),
        "jpy_twd": round(twd / jpy, 5),
        "source": "open.er-api.com(國際中價)",
    }


def fetch_rates() -> dict:
    errors = []
    for fetcher in (fetch_bot_taiwan, fetch_erapi):
        try:
            return fetcher()
        except Exception as exc:  # noqa: BLE001 - 換下一個來源
            errors.append(f"{fetcher.__name__}: {exc}")
    raise RuntimeError("所有匯率來源都失敗:\n" + "\n".join(errors))


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def update_history(history: dict, today: str, rates: dict, keep: int = 400) -> None:
    obs = [o for o in history.get("observations", []) if o.get("date") != today]
    obs.append({
        "date": today,
        "usd_twd": rates["usd_twd"],
        "usd_jpy": rates["usd_jpy"],
        "jpy_twd": rates["jpy_twd"],
        "source": rates["source"],
    })
    obs.sort(key=lambda o: o["date"])
    history["observations"] = obs[-keep:]


def in_cooldown(history: dict, rule_id: str, today: datetime, cooldown_days: int) -> bool:
    last = history.get("last_alerts", {}).get(rule_id)
    if not last:
        return False
    last_dt = datetime.strptime(last, "%Y-%m-%d").replace(tzinfo=TAIPEI)
    return (today - last_dt).days < cooldown_days


def check_threshold_rules(config: dict, rates: dict) -> list:
    hits = []
    for rule in config.get("rules", []):
        value = rates[PAIR_KEYS[rule["pair"]]]
        threshold = rule["threshold"]
        if rule["direction"] == "below" and value <= threshold:
            hits.append((rule["id"], f"{rule['note']} — {rule['pair']} = {value}(門檻 ≤ {threshold})"))
        elif rule["direction"] == "above" and value >= threshold:
            hits.append((rule["id"], f"{rule['note']} — {rule['pair']} = {value}(門檻 ≥ {threshold})"))
    return hits


def check_rolling_rules(config: dict, rates: dict, history: dict, today: str) -> list:
    """N 日新高/新低:跟過去 lookback_days 內(不含今天)的觀測值比較。"""
    lookback = config.get("lookback_days", 90)
    min_obs = config.get("min_observations", 20)
    cutoff = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=lookback)).strftime("%Y-%m-%d")
    past = [o for o in history.get("observations", []) if cutoff <= o["date"] < today]
    hits = []
    for rule in config.get("rolling", []):
        key = PAIR_KEYS[rule["pair"]]
        values = [o[key] for o in past if key in o]
        if len(values) < min_obs:
            continue
        value = rates[key]
        rule_id = f"roll_{key}_{rule['direction']}"
        if rule["direction"] == "low" and value < min(values):
            hits.append((rule_id, f"{rule['note']} — {rule['pair']} = {value}(前 {lookback} 日最低 {min(values)})"))
        elif rule["direction"] == "high" and value > max(values):
            hits.append((rule_id, f"{rule['note']} — {rule['pair']} = {value}(前 {lookback} 日最高 {max(values)})"))
    return hits


def build_alert(hits: list, rates: dict, today: str) -> tuple:
    title = f"💱 匯率警報 {today}:" + ";".join(h[1].split(" — ")[0] for h in hits)
    lines = [
        f"## 觸發條件({today},資料來源:{rates['source']})",
        "",
        *[f"- ⚠️ {msg}" for _, msg in hits],
        "",
        "## 目前匯率",
        "",
        "| 貨幣對 | 匯率 | 意義 |",
        "|---|---|---|",
        f"| USD/TWD | {rates['usd_twd']} | 1 美元換多少台幣 |",
        f"| JPY/TWD | {rates['jpy_twd']} | 1 日圓換多少台幣 |",
        "",
        "> 想調整警報門檻,改 `exchange-alert/config.json` 即可。",
    ]
    return title, "\n".join(lines)


def main() -> int:
    now = datetime.now(TAIPEI)
    today = now.strftime("%Y-%m-%d")

    config = load_json(BASE / "config.json", {})
    history = load_json(BASE / "history.json", {"observations": [], "last_alerts": {}})

    rates = fetch_rates()
    print(f"[{today}] USD/TWD={rates['usd_twd']} USD/JPY={rates['usd_jpy']} "
          f"JPY/TWD={rates['jpy_twd']}({rates['source']})")

    hits = check_rolling_rules(config, rates, history, today)
    hits += check_threshold_rules(config, rates)

    update_history(history, today, rates)

    cooldown = config.get("cooldown_days", 2)
    active = [(rid, msg) for rid, msg in hits if not in_cooldown(history, rid, now, cooldown)]
    for rid, msg in hits:
        if (rid, msg) not in active:
            print(f"(冷卻中,略過){msg}")

    if active:
        for rid, _ in active:
            history.setdefault("last_alerts", {})[rid] = today
        title, body = build_alert(active, rates, today)
        (BASE / "alert_title.txt").write_text(title, encoding="utf-8")
        (BASE / "alert_body.md").write_text(body, encoding="utf-8")
        print("=== 觸發警報 ===")
        print(title)
    else:
        print("未觸發任何警報。")

    (BASE / "history.json").write_text(
        json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
