#!/usr/bin/env node
/**
 * 抓即時行情，算好均線，寫成 data/live.json。
 *
 *   node tools/fetch-live.mjs [-o data/live.json]
 *
 * 這支腳本設計成在 **GitHub Actions 的 runner** 上跑（見 .github/workflows/market-data.yml）。
 * Actions 的機器對外網路沒有限制，打得到 Yahoo Finance 與證交所；
 * 而產出的 JSON 推回 repo 之後，raw.githubusercontent.com 是受限環境唯一連得到的來源，
 * 於是晨報排程就能讀到真正的即時數字，而不是搜尋引擎的轉述。
 *
 * 每個標的獨立 try/catch —— 一個掛掉不影響其他，結果裡會留下 error 欄位，
 * 讓讀取端知道哪一格是壞的，而不是拿到一個看起來正常的錯數字。
 */

import fs from "node:fs";
import path from "node:path";

const outIdx = process.argv.indexOf("-o");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : "data/live.json";

/* 要抓什麼。key 是給讀取端用的穩定名稱，不會因為代號寫法改變而壞掉 */
const SYMBOLS = [
  { key: "twii",   sym: "^TWII",  name: "加權指數",       group: "tw",    dp: 2, ma: true  },
  { key: "tsmc",   sym: "2330.TW",name: "台積電",         group: "tw",    dp: 2, ma: true  },
  { key: "e0050",  sym: "0050.TW",name: "元大台灣50",     group: "tw",    dp: 2, ma: true  },
  { key: "e0056",  sym: "0056.TW",name: "元大高股息",     group: "tw",    dp: 2, ma: true  },
  { key: "adr",    sym: "TSM",    name: "台積電 ADR",     group: "us",    dp: 2, ma: false },
  { key: "sox",    sym: "^SOX",   name: "費城半導體",     group: "us",    dp: 2, ma: false },
  { key: "ixic",   sym: "^IXIC",  name: "納斯達克",       group: "us",    dp: 2, ma: false },
  { key: "gspc",   sym: "^GSPC",  name: "標普 500",       group: "us",    dp: 2, ma: false },
  { key: "dji",    sym: "^DJI",   name: "道瓊工業",       group: "us",    dp: 2, ma: false },
  { key: "n225",   sym: "^N225",  name: "日經 225",       group: "asia",  dp: 2, ma: false },
  { key: "kospi",  sym: "^KS11",  name: "韓國 KOSPI",     group: "asia",  dp: 2, ma: false },
  { key: "usdtwd", sym: "TWD=X",  name: "USD／TWD",       group: "fx",    dp: 3, ma: false }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sma = (arr, n) =>
  arr.length < n ? null : arr.slice(-n).reduce((a, b) => a + b, 0) / n;

async function fetchOne(s) {
  const range = s.ma ? "1y" : "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.sym)}`
            + `?range=${range}&interval=1d`;

  const res = await fetch(url, {
    headers: {
      // Yahoo 對沒有 UA 的請求會擋
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "Accept": "application/json"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description || "回應沒有 result");

  const meta = r.meta || {};
  const closes = (r.indicators?.quote?.[0]?.close || []).filter(v => typeof v === "number" && isFinite(v));

  const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? null;
  const prev  = meta.chartPreviousClose ?? meta.previousClose
             ?? (closes.length > 1 ? closes[closes.length - 2] : null);
  if (price === null) throw new Error("沒有取到價格");

  const out = {
    name: s.name, symbol: s.sym, group: s.group, dp: s.dp,
    price,
    prevClose: prev,
    change: prev !== null ? +(price - prev).toFixed(6) : null,
    pct:    prev ? +(((price / prev) - 1) * 100).toFixed(4) : null,
    currency: meta.currency || null,
    // regular / pre / post / closed —— 讀取端可據此判斷這是即時價還是收盤價
    marketState: meta.marketState || null,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null
  };

  if (s.ma) {
    // 均線用日線收盤算。60 日 = 季線，是這整套判斷的核心
    const ma20 = sma(closes, 20), ma60 = sma(closes, 60), ma240 = sma(closes, 240);
    out.ma20  = ma20  !== null ? +ma20.toFixed(2)  : null;
    out.ma60  = ma60  !== null ? +ma60.toFixed(2)  : null;
    out.ma240 = ma240 !== null ? +ma240.toFixed(2) : null;
    out.bias20  = ma20  ? +(((price / ma20)  - 1) * 100).toFixed(2) : null;
    out.bias60  = ma60  ? +(((price / ma60)  - 1) * 100).toFixed(2) : null;
    out.bias240 = ma240 ? +(((price / ma240) - 1) * 100).toFixed(2) : null;
    out.bars = closes.length;
  }
  return out;
}

const data = {};
let ok = 0, bad = 0;

for (const s of SYMBOLS) {
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    try {
      data[s.key] = await fetchOne(s);
      ok++; done = true;
      console.error(`✓ ${s.name.padEnd(12)} ${data[s.key].price}`);
    } catch (e) {
      if (attempt === 3) {
        bad++;
        data[s.key] = { name: s.name, symbol: s.sym, group: s.group, error: String(e.message || e) };
        console.error(`✗ ${s.name.padEnd(12)} ${e.message}`);
      } else {
        await sleep(attempt * 2000);
      }
    }
  }
  await sleep(400);   // 對 Yahoo 客氣一點，免得被限流
}

/* ADR 溢價：ADR × 匯率 ÷ 5 ÷ 台積電台股價 − 1。這是台股開盤前最有用的一格 */
const adr = data.adr, tsmc = data.tsmc, fx = data.usdtwd;
if (adr?.price && tsmc?.price && fx?.price) {
  const converted = adr.price * fx.price / 5;
  data.adrPremium = {
    converted: +converted.toFixed(2),
    premiumPct: +(((converted / tsmc.price) - 1) * 100).toFixed(2),
    impliedOpen: adr.pct !== null ? +(tsmc.price * (1 + adr.pct / 100)).toFixed(0) : null,
    note: "台積電 ADR 長期有一到二成結構性溢價，看溢價率的『變化』而不是絕對值"
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  generatedAtTaipei: new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "medium"
  }).format(new Date()),
  source: "Yahoo Finance chart API",
  ok, failed: bad,
  data
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
console.error(`\n寫入 ${OUT}　成功 ${ok} / 失敗 ${bad}`);

// 全部失敗才算這次執行失敗；部分失敗仍然把拿到的寫出去
if (ok === 0) process.exit(1);
