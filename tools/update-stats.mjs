#!/usr/bin/env node
/**
 * 從 data/daily-*.csv 重新算出「跌破季線的歷史統計」，寫成 data/history-stats.json。
 *
 *   node tools/update-stats.mjs
 *   node tools/update-stats.mjs --check      # 只比對，不寫檔，有落差就以非 0 結束
 *
 * 為什麼要有這支：那些統計數字原本是手打進 watchtower.html 的。
 * 手打的數字有兩個問題 ——
 *   一、CSV 補了新資料之後不會跟著變，頁面會愈來愈舊卻看不出來；
 *   二、打錯了沒有任何東西會抓到（0050 的分割就是這樣錯了一輪）。
 * 改成從 CSV 算出來寫成 JSON，頁面優先讀 JSON，數字就只有一個來源。
 * 頁面上仍留一份寫死的當備援（離線或抓不到 JSON 時用），
 * --check 就是拿來確認那份備援有沒有跟 CSV 脫節。
 *
 * 統計口徑刻意跟 tools/ma-analysis.mjs 完全一致（含偶數項取上中位），
 * 兩邊算出不同的數字比兩邊都沒有更糟。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
const MA = 60, CONFIRM = 3;
const SYMBOLS = [
  { code: "2330", name: "台積電" },
  { code: "0050", name: "元大台灣 50" },
  { code: "0056", name: "元大高股息" }
];

/** 與 ma-analysis 同一套：偶數項取上中位 v[floor(n/2)] */
const sortNum = a => a.slice().sort((x, y) => x - y);
const med = a => (a.length ? sortNum(a)[Math.floor(a.length / 2)] : null);
const p25 = a => (a.length ? sortNum(a)[Math.floor(a.length * 0.25)] : null);
const p75 = a => (a.length ? sortNum(a)[Math.floor(a.length * 0.75)] : null);
const r2 = v => (v === null || !isFinite(v) ? null : Math.round(v * 100) / 100);
/* 負號用 U+2212，跟頁面上其他數字一致 */
const fmtPct = v => (v === null || !isFinite(v) ? "—"
  : (v < 0 ? "−" : v > 0 ? "+" : "") + Math.abs(v).toFixed(2) + "%");

const out = { generatedAt: new Date().toISOString(), ma: MA, confirm: CONFIRM, stocks: {} };
let worstLast = null, bestFirst = null;

for (const { code, name } of SYMBOLS) {
  const file = `data/daily-${code}.csv`;
  if (!existsSync(file)) { console.error(`✗ ${file} 不存在`); process.exit(1); }

  let j;
  try {
    j = JSON.parse(execFileSync("node",
      ["tools/ma-analysis.mjs", file, "--ma", String(MA), "--confirm", String(CONFIRM), "--json"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  } catch (e) {
    console.error(`✗ ${code}：ma-analysis 執行失敗 — ${e.message}`);
    process.exit(1);
  }

  const eff = j.events.filter(e => e.effective);
  const r60 = eff.map(e => e.r60).filter(v => v !== null && isFinite(v));
  const deep = eff.map(e => e.deepest).filter(v => v !== null && isFinite(v));
  const backs = eff.map(e => e.backIn).filter(v => v !== null);
  const years = j.window.sessions / 247;                 // 台股一年約 247 個交易日

  out.stocks[code] = {
    name,
    from: j.window.from, to: j.window.to, sessions: j.window.sessions,
    splitsApplied: j.splitsApplied,
    breaks: j.events.length,
    eff: eff.length,
    fake: j.events.length - eff.length,
    perYear: r2(j.events.length / years),
    deepMed: r2(med(deep)),
    deepQ25: r2(p25(deep)), deepQ75: r2(p75(deep)),
    backMed: backs.length ? med(backs) : null,
    backMax: backs.length ? Math.max(...backs) : null,
    neverBack: eff.filter(e => e.backIn === null).length,
    r60Med: r2(med(r60)),
    win: r60.length ? Math.round((r60.filter(v => v > 0).length / r60.length) * 100) : null,
    events: r60.map(r2),
    // 有效跌破裡有幾次還沒滿 60 天 —— 點圖畫得出來的點會比 eff 少，要說得出為什麼
    pending: eff.length - r60.length
  };

  if (!worstLast || j.window.to < worstLast) worstLast = j.window.to;
  if (!bestFirst || j.window.from > bestFirst) bestFirst = j.window.from;
}

const ym = d => d.slice(0, 7).replace("-", "/");
out.window = `${ym(bestFirst)} ～ ${ym(worstLast)}`;
out.coverageTo = worstLast;
out.staleDays = Math.floor((Date.now() - Date.parse(worstLast + "T00:00:00Z")) / 86400000);

for (const [code, s] of Object.entries(out.stocks)) {
  console.log(`${code} ${s.name.padEnd(12)} ${s.from}～${s.to}　`
    + `跌破 ${s.breaks}（有效 ${s.eff}）　最深乖離中位 ${s.deepMed}%　`
    + `60日報酬中位 ${s.r60Med}%　正報酬 ${s.win}%`
    + (s.splitsApplied.length ? `　[已還原分割 ${s.splitsApplied.map(x => x.date).join(",")}]` : "")
    + (s.pending ? `　（${s.pending} 次未滿 60 天，不入分布）` : ""));
}
console.log(`\n涵蓋 ${out.window}，最舊的一檔只到 ${out.coverageTo}（${out.staleDays} 天前）`);

// 對帳：頁面裡寫死的備援值有沒有跟 CSV 脫節
const html = readFileSync("watchtower.html", "utf8");
const drift = [];
for (const [code, s] of Object.entries(out.stocks)) {
  const m = html.match(new RegExp(`code:"${code}"[\\s\\S]{0,1400}?hist:\\{([\\s\\S]*?)\\}\\s*\\}`));
  if (!m) { drift.push(`${code}：在 watchtower.html 裡找不到 hist 區塊`); continue; }
  const src = m[1];
  const num = k => {
    const mm = src.match(new RegExp(k + ":\\s*(-?[\\d.]+)"));
    return mm ? Number(mm[1]) : null;
  };
  for (const [k, want] of [["breaks", s.breaks], ["eff", s.eff], ["fake", s.fake],
                           ["deepMed", s.deepMed], ["backMed", s.backMed],
                           ["backMax", s.backMax], ["r60Med", s.r60Med], ["win", s.win]]) {
    const got = num(k);
    if (got !== want) drift.push(`${code}.${k}：頁面寫 ${got}，CSV 算出來是 ${want}`);
  }
  // perYear 頁面只顯示到小數一位，比到那一位就好，否則會為了看不見的位數一直報警
  const py = num("perYear");
  if (py === null || py.toFixed(1) !== s.perYear.toFixed(1)) {
    drift.push(`${code}.perYear：頁面寫 ${py}，CSV 算出來是 ${s.perYear.toFixed(1)}`);
  }
  const wantQ = `${fmtPct(s.deepQ25)} ～ ${fmtPct(s.deepQ75)}`;
  const gotQ = (src.match(/deepQ:\s*"([^"]*)"/) || [])[1];
  if (gotQ !== wantQ) drift.push(`${code}.deepQ：頁面寫 "${gotQ}"，CSV 算出來是 "${wantQ}"`);
  const gotEv = (src.match(/events:\s*\[([^\]]*)\]/) || [])[1];
  const wantEv = s.events.join(", ");
  if (!gotEv || gotEv.split(",").map(x => Number(x)).join() !== s.events.join()) {
    drift.push(`${code}.events：頁面寫 [${gotEv}]，CSV 算出來是 [${wantEv}]`);
  }
}
if (html.indexOf(`histWindow: "${out.window}"`) < 0) {
  drift.push(`histWindow：頁面沒有寫成 "${out.window}"`);
}

if (drift.length) {
  console.error(`\n⚠️ watchtower.html 裡寫死的備援值跟 CSV 對不上（${drift.length} 處）：`);
  drift.forEach(d => console.error("   " + d));
  console.error("   頁面在 GitHub Pages 上會讀 data/history-stats.json，看到的是對的；");
  console.error("   但離線開啟或抓不到 JSON 時會退回這些舊值。請更新 watchtower.html。");
} else {
  console.log("對帳 ✓ 頁面裡寫死的備援值與 CSV 一致");
}

if (CHECK_ONLY) process.exit(drift.length ? 1 : 0);
writeFileSync("data/history-stats.json", JSON.stringify(out, null, 2) + "\n");
console.log("→ data/history-stats.json");
