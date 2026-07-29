#!/usr/bin/env node
/**
 * 從證交所（TWSE）抓單一個股的歷史日線收盤價，存成 CSV。
 *
 *   node tools/fetch-twse.mjs 2330 2015 -o 2330.csv
 *   node tools/fetch-twse.mjs 2330 2015 | node tools/ma-analysis.mjs /dev/stdin --ma 60
 *
 * 參數：股票代號、起始西元年（預設 2015）、-o 輸出檔（預設印到 stdout）。
 *
 * 證交所是一個月一包資料，所以會跑很多次請求；預設每次間隔 4 秒避免被擋，
 * 抓 10 年大約要 8 分鐘。進度會印在 stderr，不會混進 CSV。
 *
 * 注意：這支腳本要在「你自己的電腦」上跑。寫這支腳本的環境對外連線被政策
 * 擋掉，所以它沒有對真實的證交所端點測試過，只驗證過解析邏輯。
 */

const argv = process.argv.slice(2);
const pos = argv.filter(a => !a.startsWith("-") && argv[argv.indexOf(a) - 1] !== "-o");
const stock = pos[0];
const fromYear = Number(pos[1]) || 2015;
const outIdx = argv.indexOf("-o");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const DELAY = 4000;

if (!stock || !/^\d{4,6}$/.test(stock)) {
  console.error("用法: node tools/fetch-twse.mjs <股票代號> [起始年] [-o 檔名]");
  console.error("例如: node tools/fetch-twse.mjs 2330 2015 -o 2330.csv");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, "0");

/** 民國年 115/07/28 → 2026-07-28 */
function toISO(roc) {
  const m = String(roc).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return `${+m[1] + 1911}-${pad(+m[2])}-${pad(+m[3])}`;
}

const months = [];
const now = new Date();
for (let y = fromYear; y <= now.getFullYear(); y++) {
  for (let m = 1; m <= 12; m++) {
    if (y === now.getFullYear() && m > now.getMonth() + 1) break;
    months.push(`${y}${pad(m)}01`);
  }
}

const rows = [];
let ok = 0, empty = 0, failed = 0;

for (const [i, date] of months.entries()) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${date}&stockNo=${stock}&response=json`;
  let got = false;

  for (let attempt = 1; attempt <= 3 && !got; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 429) {                    // 被限流，退避後重試
        process.stderr.write(` [429, 等 ${attempt * 15}s]`);
        await sleep(attempt * 15000);
        continue;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();

      if (j.stat !== "OK") {                        // 該月無資料（未上市 / 休市）
        empty++; got = true; break;
      }
      // 欄位順序：日期,成交股數,成交金額,開盤,最高,最低,收盤,漲跌價差,成交筆數
      for (const r of j.data || []) {
        const iso = toISO(r[0]);
        const close = Number(String(r[6]).replace(/,/g, ""));
        if (iso && isFinite(close) && close > 0) rows.push([iso, close]);
      }
      ok++; got = true;
    } catch (e) {
      if (attempt === 3) { failed++; process.stderr.write(` [失敗 ${date}: ${e.message}]`); }
      else await sleep(attempt * 5000);
    }
  }

  const done = i + 1;
  process.stderr.write(`\r抓取中 ${done}/${months.length}　${date.slice(0, 4)}/${date.slice(4, 6)}　已收 ${rows.length} 筆　`);
  if (done < months.length) await sleep(DELAY);
}

process.stderr.write("\n");

if (!rows.length) {
  console.error("沒有抓到任何資料。確認股票代號正確，以及這台機器能連到 twse.com.tw。");
  process.exit(1);
}

// 去重 + 由舊到新排序
const seen = new Set();
const clean = rows
  .filter(([d]) => (seen.has(d) ? false : seen.add(d)))
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));

const csv = "日期,收盤價\n" + clean.map(r => r.join(",")).join("\n") + "\n";

if (outFile) {
  const fs = await import("node:fs");
  fs.writeFileSync(outFile, csv);
  console.error(`完成：${clean.length} 個交易日（${clean[0][0]} ～ ${clean[clean.length - 1][0]}）→ ${outFile}`);
  console.error(`成功 ${ok} 個月、無資料 ${empty} 個月、失敗 ${failed} 個月`);
  console.error(`\n接著跑：node tools/ma-analysis.mjs ${outFile} --ma 60`);
} else {
  process.stdout.write(csv);
  console.error(`完成：${clean.length} 個交易日（${clean[0][0]} ～ ${clean[clean.length - 1][0]}）`);
}
