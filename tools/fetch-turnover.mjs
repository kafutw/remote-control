#!/usr/bin/env node
/**
 * 每日成交值（上市＋上櫃），寫進 data/turnover.csv。
 *
 *   node tools/fetch-turnover.mjs [--months 3] [-o data/turnover.csv]
 *
 * ── 為什麼一定要兩個市場相加 ──
 * 量能燈號的門檻（7,000 億／1.1 兆／1.3 兆）是拿**上市＋上櫃**校準出來的。
 * 只抓上市大約會少掉 15～20%，拿去比同一組門檻就會系統性偏低，
 * 燈幾乎不會亮 —— 而且是無聲的：你看到的是「今天沒訊號」，
 * 不是「我只拿到一半的資料」。
 * 所以上櫃抓不到時，這支腳本**寧可把 total 留空**，讓判定端拒絕評估，
 * 也不要寫一個看起來正常但偏低的數字進去。
 *
 * ── 來源 ──
 * 上市　TWSE FMTQIK（每日市場成交資訊，一次回一整個月）
 * 上櫃　TPEx 每日市場統計，依序試幾個端點 —— 這站改版頻繁，
 *       而且寫這支的環境連不出去，沒辦法先驗，所以多備幾個。
 *
 * 這支的執行環境對外連線被政策擋掉，只有 GitHub Actions 的 runner 抓得到。
 * 抓不到就維持原檔不動 —— 沿用 update-history.mjs 的紀律：
 * 寧可不寫，也不要寫進不確定的東西。
 */
import fs from "node:fs";
import path from "node:path";

const flag = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const OUT    = flag("o", "data/turnover.csv");
const MONTHS = Math.max(1, Math.min(24, +flag("months", 2) || 2));

const pad = n => String(n).padStart(2, "0");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 民國年 115/07/28 → 2026-07-28（跟 update-history.mjs 同一套） */
function toISO(roc){
  const m = String(roc).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if(!m) return null;
  return `${+m[1] + 1911}-${pad(+m[2])}-${pad(+m[3])}`;
}
const num = v => {
  // 空字串一定要回 null，不能回 0 —— Number("") 是 0 而且 isFinite(0) 為真。
  // 這條漏掉的後果：CSV 裡「上櫃還沒抓到」的空欄位被讀成 0，
  // total 算成「只有上市」卻標記為完整，判定端就拿一個少了 15% 的數字去比門檻。
  // 這正是整支腳本設計來避免的那種無聲錯誤，卻從讀檔這一端漏進來。
  const t = String(v ?? "").replace(/[,\s]/g, "");
  if(t === "") return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
};
/** 元 → 億元。門檻用億元寫，讀起來才跟「7,000 億」對得上 */
const toYi = v => v === null ? null : +(v / 1e8).toFixed(2);

/** 失敗時把回應開頭帶回來 —— 只看狀態碼會漏掉「200 但回的是 HTML 錯誤頁」 */
async function getJSON(url){
  const res = await fetch(url, {
    headers:{ "User-Agent":"Mozilla/5.0", "Accept":"application/json" }
  });
  const body = await res.text();
  if(!res.ok) throw new Error(`HTTP ${res.status}：${body.slice(0,80)}`);
  try{ return JSON.parse(body); }
  catch{ throw new Error(`回應不是 JSON（可能被擋或改版）：${body.slice(0,80)}`); }
}

/* ── 上市：TWSE FMTQIK ── */
async function twseMonth(y, m){
  const j = await getJSON(
    `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${y}${pad(m)}01&response=json`);
  const rows = j.data || j.aaData || [];
  // 當月還沒有交易日（月初、連假）也會是空的，那不是故障
  if(!rows.length) throw new Error("回應裡沒有 data（該月可能還沒有交易日）");
  // 欄位順序：日期／成交股數／成交金額／成交筆數／指數／漲跌
  const out = [];
  for(const r of rows){
    const d = toISO(r[0]), amt = num(r[2]);
    if(d && amt !== null) out.push({date:d, twse:toYi(amt)});
  }
  return out;
}

/* ── 上櫃：TPEx ──
 * 2026-08-04 用 tools/probe-sources.mjs 從 runner 實測的結果：
 *   www/zh-tw/afterTrading/tradingIndex  → HTTP 200，{ tables, date, flagField, stat }，
 *                                          資料在 tables[0].data，**但只回一列（最近一個交易日）**
 *   openapi/v1/tpex_mainboard_daily_close_quotes → 200，10,199 列，但那是逐檔報價不是市場合計
 *   web/.../st41_result.php              → 200，同樣只回一列
 * 也就是說這個端點**沒辦法一次補一個月**，跟上市的 FMTQIK 不一樣。
 * 所以歷史只能靠每天跑一次慢慢累積；已經過去而當時沒抓到的日子補不回來，
 * 那些日子的 total 會留空，判定端看到空值就跳過 —— 這是對的行為。 */
/** 回應長什麼樣子 —— 解析失敗時印出來。
 *  第一次上線兩個端點都回「沒有資料列」：它們有回應、是 JSON、但我找不到列。
 *  光知道「失敗了」修不了，要知道**它到底回了什麼**才有辦法對。
 *  這個環境連不到 TPEx，所以只能讓下一次 Actions 執行把答案帶回來。 */
function shape(j, depth = 0){
  if(j === null || j === undefined) return String(j);
  if(Array.isArray(j)) return `Array(${j.length})` + (j.length && depth < 2 ? `of ${shape(j[0], depth+1)}` : "");
  if(typeof j === "object"){
    const ks = Object.keys(j);
    return `{${ks.slice(0,12).join(",")}${ks.length>12?",…":""}}`;
  }
  return typeof j;
}

async function tpexMonth(y, m){
  const roc = `${y - 1911}/${pad(m)}`;
  const tries = [
    // 新版站台（www/ 路徑）優先 —— 舊的 st41_result.php 已知回不出列
    { url:`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${y}${pad(m)}01&response=json`,
      pick:j => j.tables?.[0]?.data || j.data || j.aaData },
    { url:`https://www.tpex.org.tw/openapi/v1/tpex_daily_market_stat`,
      pick:j => Array.isArray(j) ? j : null },
    { url:`https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_index/st41_result.php?l=zh-tw&d=${roc}&o=json`,
      pick:j => j.aaData || j.data },
  ];
  const errs = [];
  for(const t of tries){
    try{
      const j = await getJSON(t.url);
      const rows = t.pick(j);
      // 失敗時把回應的結構印出來，下一次執行的 log 就會告訴我們該怎麼接
      if(!rows || !rows.length) throw new Error("回應裡沒有資料列｜結構 " + shape(j));
      const out = [];
      for(const r of rows){
        const d = toISO(r[0]);
        if(!d) continue;
        // 欄位順序各版本不同，取這一列裡「最大的那個數」當成交金額（千元或元都可能）。
        // 成交金額一定遠大於股數以外的其他欄位（指數、筆數），所以這個取法夠穩。
        const nums = r.slice(1).map(num).filter(v => v !== null && v > 0);
        if(!nums.length) continue;
        let amt = Math.max(...nums);
        // 有些版本用千元為單位：一個交易日的上櫃成交值不可能小於 10 億元，
        // 小於這個數量級就當成千元換算回來
        if(amt < 1e9) amt *= 1000;
        out.push({date:d, tpex:toYi(amt)});
      }
      if(!out.length) throw new Error("有列但解析不出日期或金額｜首列 "
            + JSON.stringify(rows[0]).slice(0,160));
      return out;
    }catch(e){ errs.push(`${t.url.replace(/^https:\/\/www\.tpex\.org\.tw/,"")} → ${e.message}`); }
  }
  throw new Error("上櫃全部端點失敗｜" + errs.join(" ｜ "));
}

/* ── CSV ── */
function readCSV(file){
  if(!fs.existsSync(file)) return [];
  return fs.readFileSync(file,"utf8").split(/\r?\n/).slice(1).filter(Boolean)
    .map(l => l.split(","))
    .filter(c => /^\d{4}-\d{2}-\d{2}$/.test((c[0]||"").trim()))
    .map(c => ({ date:c[0].trim(), twse:num(c[1]), tpex:num(c[2]), total:num(c[3]) }));
}
function writeCSV(file, rows){
  rows.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, "date,twse,tpex,total\n"
    + rows.map(r => [r.date, r.twse ?? "", r.tpex ?? "", r.total ?? ""].join(",")).join("\n") + "\n");
}

/* ── 主流程 ── */
const now = new Date();
const months = [];
for(let k = MONTHS - 1; k >= 0; k--){
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
  months.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
}

const twseAll = new Map(), tpexAll = new Map();
let twseOK = 0, tpexOK = 0;

for(const [y, m] of months){
  try{
    for(const r of await twseMonth(y, m)) twseAll.set(r.date, r.twse);
    twseOK++;
    console.error(`✓ 上市 ${y}/${pad(m)}`);
  }catch(e){ console.error(`✗ 上市 ${y}/${pad(m)}：${e.message}`); }
  await sleep(1200);                       // 證交所對連續請求不友善

  try{
    for(const r of await tpexMonth(y, m)) tpexAll.set(r.date, r.tpex);
    tpexOK++;
    console.error(`✓ 上櫃 ${y}/${pad(m)}`);
  }catch(e){ console.error(`✗ 上櫃 ${y}/${pad(m)}：${e.message}`); }
  await sleep(1200);
}

if(!twseOK){
  console.error("\n上市完全抓不到，維持原檔不動");
  process.exit(1);
}

// 既有資料先讀進來，只補不蓋 —— 已經有 total 的日子不動它
const merged = new Map(readCSV(OUT).map(r => [r.date, r]));
let filled = 0, partial = 0;

for(const date of new Set([...twseAll.keys(), ...tpexAll.keys()])){
  const prev = merged.get(date) || {date};
  const twse = twseAll.get(date) ?? prev.twse ?? null;
  const tpex = tpexAll.get(date) ?? prev.tpex ?? null;
  // total 只有兩邊都在才給。少一邊就留空，判定端會因此拒絕評估 ——
  // 這正是我們要的：寧可說「資料不全」，不要給一個偏低 15～20% 的數字。
  const total = (twse !== null && tpex !== null) ? +(twse + tpex).toFixed(2) : null;
  if(total !== null) filled++; else partial++;
  merged.set(date, {date, twse, tpex, total});
}

writeCSV(OUT, [...merged.values()]);
const rows = readCSV(OUT);
const last = rows[rows.length - 1];
console.error(`\n寫入 ${OUT}　共 ${rows.length} 列　完整 ${filled} / 只有單邊 ${partial}`);
if(last) console.error(`最新 ${last.date}　上市 ${last.twse} 億　上櫃 ${last.tpex ?? "—"} 億　合計 ${last.total ?? "（資料不全，不判定）"}`);
if(!tpexOK) console.error("⚠️ 上櫃一個月都沒抓到 —— 燈號會顯示「資料不全」而不是「沒訊號」");
