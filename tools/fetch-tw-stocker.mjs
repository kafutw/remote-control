#!/usr/bin/env node
/**
 * 從 GitHub 上的公開台股資料集抓歷史股價，聚合成日線 CSV。
 *
 *   node tools/fetch-tw-stocker.mjs 2330 0050 0056 -o data
 *
 * 資料來源：https://github.com/voidful/tw_stocker（raw.githubusercontent.com）
 * 這條路徑在受限的網路環境下通常還連得到 —— 券商、證交所、Yahoo Finance
 * 幾乎都會被擋，但 raw.githubusercontent.com 常常是通的。
 *
 * 注意：該資料集是 5 分鐘 K，涵蓋範圍有限（寫這支腳本時是 2024-02 ～ 2026-04），
 * 且不是每天更新。跑完會印出實際涵蓋的起訖日，**用之前一定要看那個日期**。
 * 要更長或更新的資料，用 tools/fetch-twse.mjs 從證交所抓。
 */

import fs from "node:fs";
import path from "node:path";

const BASE = "https://raw.githubusercontent.com/voidful/tw_stocker/main/data";

const argv = process.argv.slice(2);
const oi = argv.indexOf("-o");
const outDir = oi >= 0 ? argv[oi + 1] : "data";
const codes = argv.filter((a, i) => !a.startsWith("-") && i !== (oi >= 0 ? oi + 1 : -1));

if (!codes.length) {
  console.error("用法: node tools/fetch-tw-stocker.mjs <代號...> [-o 輸出目錄]");
  console.error("例如: node tools/fetch-tw-stocker.mjs 2330 0050 0056 -o data");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

/** 依台北日期分組，取當天最後一根 K 的收盤價 */
function toDaily(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const hdr = lines[0].split(",").map(s => s.trim());
  const iDt = hdr.findIndex(h => /^date(time)?$/i.test(h));
  const iCl = hdr.indexOf("Close");
  if (iDt < 0 || iCl < 0) throw new Error("CSV 欄位不符：" + hdr.join(","));

  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  });

  const byDay = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const d = new Date(c[iDt]);                 // 字串自帶時區資訊
    if (isNaN(d)) continue;
    const close = Number(c[iCl]);
    if (!isFinite(close) || close <= 0) continue;
    const day = dayFmt.format(d);
    const prev = byDay.get(day);
    if (!prev || d.getTime() >= prev.t) byDay.set(day, { t: d.getTime(), c: close });
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

let failed = 0;
for (const code of codes) {
  const url = `${BASE}/${code}.csv`;
  try {
    process.stderr.write(`抓取 ${code} … `);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = toDaily(await res.text());
    if (!rows.length) throw new Error("聚合後沒有資料");

    const out = path.join(outDir, `daily-${code}.csv`);
    fs.writeFileSync(out, "日期,收盤價\n" + rows.map(([d, v]) => `${d},${v.c}`).join("\n") + "\n");
    console.error(`${rows.length} 個交易日  ${rows[0][0]} ~ ${rows[rows.length - 1][0]}  → ${out}`);
  } catch (e) {
    failed++;
    console.error(`失敗：${e.message}`);
  }
}

console.error(`\n完成${failed ? `（${failed} 檔失敗）` : ""}。接著跑：`);
console.error(`  node tools/ma-analysis.mjs ${outDir}/daily-${codes[0]}.csv --ma 60`);
console.error(`\n⚠️ 上面印出的結束日期就是資料的真實新鮮度，比那之後發生的事這份資料都沒有。`);
