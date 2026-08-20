#!/usr/bin/env node
/**
 * 拿教育部的辭典資料核對 chinese.html 裡的生字表。
 *
 * 資料哪裡來（這個開發環境連不上 pedia.cloud.edu.tw，但連得到 GitHub）：
 *   git clone --depth 1 https://github.com/g0v/moedict-data /tmp/moedict-data
 *   xz -dc /tmp/moedict-data/dict-revised.json.xz > /tmp/moe.json
 *
 * 跑法：
 *   node tools/check-chinese-bank.mjs /tmp/moe.json
 *
 * 會檢查每個生字的注音、部首、總筆畫跟《重編國語辭典修訂本》一不一樣。
 * 注音只要對得上該字的任何一個讀音就算過（破音字本來就不只一個）；
 * 筆畫寫 0 的字是刻意跳過的（教育部自己兩份資料對不起來，例如「育」）。
 *
 * 資料版權屬教育部，這裡只拿來核對，不把辭典內容複製進 repo。
 */
import fs from 'node:fs';
import path from 'node:path';

const dictPath = process.argv[2];
const htmlPath = process.argv[3] || path.join(process.cwd(), 'chinese.html');
if (!dictPath) {
  console.error('用法：node tools/check-chinese-bank.mjs <教育部辭典 json> [chinese.html]');
  process.exit(2);
}

// ── 教育部辭典：只挑單字，記下所有讀音、部首、總筆畫 ──
const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
const moe = {};
for (const entry of dict) {
  const title = entry.title || '';
  if ([...title].length !== 1 || !entry.radical) continue;
  if (moe[title]) continue;                       // 同一個字只取第一筆
  moe[title] = {
    r: String(entry.radical).trim(),
    s: entry.stroke_count,
    all: (entry.heteronyms || []).map((h) => (h.bopomofo || '').trim()).filter(Boolean)
  };
}

const html = fs.readFileSync(htmlPath, 'utf8');
const pick = (re) => (html.match(re) || [''])[0];
const bank = pick(/var BANK = \{[\s\S]*?\n  \};/);
const extra = pick(/var EXTRA = \{[\s\S]*?\n  \};/);

const problems = [];
let chars = 0;

for (const [, line] of bank.matchAll(/'([^'|]+\|[^']*)'/g)) {
  const [c, b, r, stroke, words] = line.split('|');
  chars++;
  const m = moe[c];
  if (!m) { problems.push(`${c}　字典裡查不到`); continue; }
  if (!m.all.includes(b)) problems.push(`${c}　注音 我:${b} 教育部:${m.all.join('/')}`);
  if (m.r !== r) problems.push(`${c}　部首 我:${r} 教育部:${m.r}`);
  if (Number(stroke) && m.s !== Number(stroke)) {
    problems.push(`${c}　筆畫 我:${stroke} 教育部:${m.s}`);
  }
  // 語詞一定要含這個字，不然「語詞填空」挖不出空格
  for (const w of (words || '').split(',')) {
    if (w && !w.includes(c)) problems.push(`${c}　語詞「${w}」裡沒有這個字`);
  }
}

let extras = 0;
for (const [, c, b] of extra.matchAll(/'(.)':'([^']+)'/g)) {
  extras++;
  const m = moe[c];
  if (!m) { problems.push(`${c}（EXTRA）字典裡查不到`); continue; }
  if (!m.all.includes(b)) problems.push(`${c}（EXTRA）注音 我:${b} 教育部:${m.all.join('/')}`);
}

console.log(`生字 ${chars} 個、語詞用字 ${extras} 個，對不上 ${problems.length} 處`);
for (const p of problems) console.log('  ✗', p);
process.exit(problems.length ? 1 : 0);
