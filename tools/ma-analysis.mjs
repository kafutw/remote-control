#!/usr/bin/env node
/**
 * 均線跌破分析 —— 統計一檔股票歷史上跌破季線（或任一均線）的次數與後續走勢。
 *
 *   node tools/ma-analysis.mjs <csv 檔> [--ma 60] [--confirm 3]
 *
 * CSV 只要含「日期」和「收盤價」兩欄就能跑，欄位順序、欄名、分隔符號都會自動判斷。
 * 已知可直接吃的來源：
 *   - 證交所 STOCK_DAY CSV（民國年，如 115/07/28）
 *   - Google 試算表 GOOGLEFINANCE 匯出的 CSV
 *   - Goodinfo / 券商軟體匯出的日線表（先另存成 CSV）
 *   - Yahoo Finance 的 Date,Open,High,Low,Close,... 格式
 *
 * --ma       要看的均線天數，預設 60（季線）。20＝月線，240＝年線。
 * --confirm  連續幾個交易日收在均線下才算「有效跌破」，預設 3。
 */

import fs from "node:fs";

/* ---------- 參數 ---------- */
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MA = flag("ma", 60);
const CONFIRM = flag("confirm", 3);
const AS_JSON = argv.includes("--json");
/** --json 時 stdout 只能有 JSON，診斷一律轉 stderr，否則管線接不起來 */
const log = (...a) => (AS_JSON ? console.error(...a) : console.log(...a));

if (!file) {
  console.error("用法: node tools/ma-analysis.mjs <csv檔> [--ma 60] [--confirm 3]");
  process.exit(1);
}

/* ---------- 解析 CSV ---------- */
function splitLine(line, sep) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$/g, ""));
}

/** 民國年 115/07/28、西元 2026-07-28、2026/7/28 都吃 */
function parseDate(s) {
  // 只取空白／T 之前的日期部分，"2020-01-03 00:00:00" 這種也吃得下
  s = String(s).replace(/"/g, "").trim().split(/[ T]/)[0].trim();
  let m = s.match(/^(\d{2,3})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) {
    const y = +m[1];
    return new Date(Date.UTC(y < 1911 ? y + 1911 : y, +m[2] - 1, +m[3]));
  }
  m = s.match(/^(\d{4})[\/-]?(\d{1,2})[\/-]?(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function parseNum(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(/[",\s元]/g, ""));
  return isFinite(n) ? n : null;
}

const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
const lines = raw.split(/\r?\n/).filter(l => l.trim() !== "");
const sep = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? "\t" : ",";

/* 找出日期欄與收盤欄：先看欄名，找不到就用「每列都能解析成日期／數字」來猜 */
let dateCol = -1, closeCol = -1, startRow = 0;
const head = splitLine(lines[0], sep);
head.forEach((h, i) => {
  const t = h.replace(/\s/g, "");
  if (dateCol < 0 && /日期|date|時間/i.test(t)) dateCol = i;
  if (/收盤|收市|close|adjclose/i.test(t) && !/漲跌|change/i.test(t)) closeCol = i;
});
if (dateCol >= 0 || closeCol >= 0) startRow = 1;

if (dateCol < 0 || closeCol < 0) {
  const probe = lines.slice(startRow, startRow + 30).map(l => splitLine(l, sep));
  const width = Math.max(...probe.map(r => r.length));
  for (let c = 0; c < width; c++) {
    const vals = probe.map(r => r[c]).filter(v => v != null && v !== "");
    if (!vals.length) continue;
    const dateOk = vals.filter(v => parseDate(v)).length / vals.length;
    const numOk = vals.filter(v => parseNum(v) !== null).length / vals.length;
    if (dateCol < 0 && dateOk > 0.8 && numOk < 0.8) dateCol = c;
    else if (closeCol < 0 && dateCol >= 0 && c > dateCol && numOk > 0.8) {
      const avg = vals.reduce((a, v) => a + parseNum(v), 0) / vals.length;
      if (avg > 0) closeCol = c;
    }
  }
}
if (dateCol < 0 || closeCol < 0) {
  console.error("找不到日期或收盤價欄位。請確認 CSV 至少有這兩欄。");
  console.error("第一行看到的是：", head.join(" | "));
  process.exit(1);
}
log(
  startRow === 1
    ? `欄位判斷：日期＝第 ${dateCol + 1} 欄「${head[dateCol]}」，收盤＝第 ${closeCol + 1} 欄「${head[closeCol]}」`
    : `欄位判斷（無表頭）：日期＝第 ${dateCol + 1} 欄，收盤＝第 ${closeCol + 1} 欄`
);

/* ---------- 讀成序列 ---------- */
const seen = new Set();
let bars = [];
for (let i = startRow; i < lines.length; i++) {
  const r = splitLine(lines[i], sep);
  const d = parseDate(r[dateCol]);
  const c = parseNum(r[closeCol]);
  if (!d || c === null || c <= 0) continue;
  const key = d.toISOString().slice(0, 10);
  if (seen.has(key)) continue;
  seen.add(key);
  bars.push({ date: key, close: c });
}
bars.sort((a, b) => (a.date < b.date ? -1 : 1));

/* ---------- 股票分割還原 ----------
 * 未還原的分割在原始資料裡長得跟崩盤一模一樣：0050 在 2025-06-18 一拆四，
 * 188.65 變成 47.55，看起來是單日 −74.8%。若不處理，它會被當成一次「有效跌破」，
 * 還會污染其後 60 天的均線 —— 統計整個歪掉。
 *
 * 判定方式：單日變動幅度大到不像真實行情（跌破 1/1.9 或漲過 1.9 倍），
 * 且比值接近常見的分割比例，就視為分割，把分割日之前的價格全部換算到之後的基準。
 */
const SPLIT_RATIOS = [2, 3, 4, 5, 10, 20];
const splits = [];
for (let i = 1; i < bars.length; i++) {
  const ratio = bars[i - 1].close / bars[i].close;       // >1 表示變便宜（分割）
  const inv = 1 / ratio;                                  // >1 表示變貴（反向分割）
  for (const r of SPLIT_RATIOS) {
    // 容許 8% 誤差：分割當天本來就會有正常漲跌
    if (Math.abs(ratio - r) / r < 0.08) { splits.push({ i, factor: r, kind: "分割" }); break; }
    if (Math.abs(inv - r) / r < 0.08)   { splits.push({ i, factor: 1 / r, kind: "反向分割" }); break; }
  }
}
if (splits.length) {
  for (const s of splits) {
    for (let k = 0; k < s.i; k++) bars[k].close /= s.factor;
    log(`⚠️ 偵測到${s.kind}：${bars[s.i].date} 比例 1:${s.factor >= 1 ? s.factor : (1 / s.factor)}`
              + `，已將該日之前的價格還原到相同基準`);
  }
  log("");
}

if (bars.length < MA + 40) {
  console.error(`資料只有 ${bars.length} 筆，算 ${MA} 日均線加上後續追蹤至少需要 ${MA + 40} 筆。`);
  process.exit(1);
}
log(`讀到 ${bars.length} 個交易日：${bars[0].date} ～ ${bars[bars.length - 1].date}\n`);

/* ---------- 均線 ---------- */
let sum = 0;
bars.forEach((b, i) => {
  sum += b.close;
  if (i >= MA) sum -= bars[i - MA].close;
  b.ma = i >= MA - 1 ? sum / MA : null;
  b.bias = b.ma ? (b.close / b.ma - 1) * 100 : null;
});
/* 均線自己的斜率：跟 10 天前比 */
bars.forEach((b, i) => {
  b.slope = b.ma && i >= 10 && bars[i - 10].ma ? (b.ma / bars[i - 10].ma - 1) * 100 : null;
});

/* ---------- 找跌破事件 ---------- */
const fwd = (i, n) =>
  i + n < bars.length ? (bars[i + n].close / bars[i].close - 1) * 100 : null;

const events = [];
for (let i = MA; i < bars.length; i++) {
  const prev = bars[i - 1], cur = bars[i];
  if (!prev.ma || !cur.ma) continue;
  if (!(prev.close >= prev.ma && cur.close < cur.ma)) continue; // 由上往下穿過

  // 連續收在均線下幾天
  let below = 0;
  for (let j = i; j < bars.length && bars[j].ma && bars[j].close < bars[j].ma; j++) below++;
  // 幾天後站回
  let backIn = null;
  for (let j = i; j < bars.length; j++) {
    if (bars[j].ma && bars[j].close >= bars[j].ma) { backIn = j - i; break; }
  }
  // 站回之前的最低點與最深負乖離
  let trough = cur.close, deepest = cur.bias;
  const end = backIn === null ? bars.length - 1 : i + backIn;
  for (let j = i; j <= end; j++) {
    if (bars[j].close < trough) trough = bars[j].close;
    if (bars[j].bias !== null && bars[j].bias < deepest) deepest = bars[j].bias;
  }

  events.push({
    date: cur.date,
    close: cur.close,
    ma: cur.ma,
    bias: cur.bias,
    slope: cur.slope,
    below,
    backIn,
    trough,
    troughPct: (trough / cur.close - 1) * 100,
    deepest,
    effective: below >= CONFIRM,
    r20: fwd(i, 20),
    r60: fwd(i, 60)
  });
}

/* ---------- --json：把每個事件吐出來，給圖表用 ---------- */
if (AS_JSON) {
  const round = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(d));
  process.stdout.write(JSON.stringify({
    window: { from: bars[0].date, to: bars[bars.length - 1].date, sessions: bars.length },
    ma: MA, confirm: CONFIRM,
    splitsApplied: splits.map(s => ({ date: bars[s.i].date, factor: s.factor })),
    events: events.map(e => ({
      date: e.date, close: round(e.close), ma: round(e.ma),
      bias: round(e.bias), deepest: round(e.deepest),
      below: e.below, backIn: e.backIn, effective: e.effective,
      r20: round(e.r20), r60: round(e.r60)
    }))
  }, null, 2) + "\n");
  process.exit(0);
}

/* ---------- 輸出 ---------- */
const f = (n, d = 2) => (n === null || n === undefined || !isFinite(n) ? "—" : n.toFixed(d));
const pc = (n, d = 2) => (n === null || n === undefined || !isFinite(n) ? "—" : n.toFixed(d) + "%");
const eff = events.filter(e => e.effective);
const fake = events.filter(e => !e.effective);

console.log(`═══ 跌破 ${MA} 日均線：共 ${events.length} 次 ═══`);
console.log(`  有效跌破（連續 ${CONFIRM} 天以上收在均線下）：${eff.length} 次`);
console.log(`  假跌破（${CONFIRM} 天內站回）：${fake.length} 次`);
console.log(`  平均一年約 ${(events.length / ((bars.length) / 244)).toFixed(1)} 次，其中有效 ${(eff.length / ((bars.length) / 244)).toFixed(1)} 次\n`);

console.log("日期         收盤     均線    當日乖離  均線斜率  連續破  站回天數  最深乖離  期間最大跌幅   20日後   60日後  類型");
console.log("─".repeat(122));
for (const e of events) {
  console.log(
    [
      e.date.padEnd(11),
      f(e.close).padStart(8),
      f(e.ma).padStart(8),
      pc(e.bias).padStart(9),
      pc(e.slope).padStart(9),
      String(e.below).padStart(6),
      (e.backIn === null ? "未站回" : String(e.backIn)).padStart(8),
      pc(e.deepest).padStart(9),
      pc(e.troughPct).padStart(13),
      pc(e.r20).padStart(8),
      pc(e.r60).padStart(8),
      "  " + (e.effective ? "有效" : "假跌破")
    ].join("")
  );
}

const stat = (arr, pick) => {
  const v = arr.map(pick).filter(x => x !== null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return {
    n: v.length,
    med: v[Math.floor(v.length / 2)],
    avg: v.reduce((a, b) => a + b, 0) / v.length,
    p25: v[Math.floor(v.length * 0.25)],
    p75: v[Math.floor(v.length * 0.75)],
    win: (v.filter(x => x > 0).length / v.length) * 100
  };
};

function block(title, arr) {
  if (!arr.length) return;
  console.log(`\n═══ ${title}（${arr.length} 次）═══`);
  for (const [label, pick] of [
    ["跌破後 20 日報酬", e => e.r20],
    ["跌破後 60 日報酬", e => e.r60],
    ["站回前最大跌幅", e => e.troughPct],
    ["最深負乖離", e => e.deepest]
  ]) {
    const s = stat(arr, pick);
    if (!s) continue;
    console.log(
      `  ${label.padEnd(9)}  中位數 ${f(s.med).padStart(7)}%   平均 ${f(s.avg).padStart(7)}%` +
      `   四分位 ${f(s.p25)}% ~ ${f(s.p75)}%   為正比例 ${f(s.win, 0)}%`
    );
  }
  const backs = arr.map(e => e.backIn).filter(x => x !== null).sort((a, b) => a - b);
  if (backs.length) {
    console.log(`  站回均線天數  中位數 ${backs[Math.floor(backs.length / 2)]} 天   最久 ${backs[backs.length - 1]} 天` +
      `   至今未站回 ${arr.filter(e => e.backIn === null).length} 次`);
  }
}

block("全部跌破", events);
block(`有效跌破（連續 ${CONFIRM} 天以上）`, eff);
block("假跌破", fake);

console.log("\n註：報酬以跌破當天收盤價為基準，未計股利與交易成本。歷史分布不保證未來重演。");
