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
const dictBlock = (html.match(/var DICT = '([^']*)'/) || [])[1] || '';
const bookBlock = (html.match(/var BOOK = \{[\s\S]*?\n  \};/) || [''])[0];

const problems = [];
const notes = [];
let chars = 0;

// 內建字典：注音、部首、筆畫要跟教育部一致（注音對得上任何一個讀音就算過，破音字本來就不只一個）
for (const row of dictBlock.split(';')) {
  if (!row) continue;
  const c = row.charAt(0);
  const [b, r, stroke] = row.slice(1).split('|');
  chars++;
  const m = moe[c];
  if (!m) { problems.push(`${c}　字典裡查不到`); continue; }
  if (!m.all.includes(b)) problems.push(`${c}　注音 ${b} 不在教育部的 ${m.all.join('/')} 裡`);
  if (m.r !== r) problems.push(`${c}　部首 ${r} 教育部:${m.r}`);
  if (Number(stroke) && m.s !== Number(stroke)) problems.push(`${c}　筆畫 ${stroke} 教育部:${m.s}`);
}

// 課本：語詞裡通常會有這一課的生字，沒有的話只是提醒一下（課名裡的詞會這樣，不算錯）
let lessons = 0, words = 0;
for (const [, name, zi, recog, ws] of bookBlock.matchAll(/\['([^']*)','([^']*)','([^']*)','([^']*)'\]/g)) {
  lessons++;
  const inLesson = new Set([...zi, ...recog]);
  for (const w of (ws ? ws.split(',') : [])) {
    words++;
    if (![...w].some((c) => inLesson.has(c))) {
      notes.push(`「${w}」（${name}）裡沒有這一課的生字`);
    }
  }
}
console.log(`課 ${lessons}、語詞 ${words}`);

console.log(`字典 ${chars} 個字，對不上 ${problems.length} 處`);
if (notes.length) {
  console.log(`另外有 ${notes.length} 個語詞沒有用到該課的生字（多半是課名裡的詞，不算錯）：`);
  for (const n of notes) console.log('  ·', n);
}
for (const p of problems) console.log('  ✗', p);
process.exit(problems.length ? 1 : 0);
