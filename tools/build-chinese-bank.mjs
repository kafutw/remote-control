#!/usr/bin/env node
/**
 * 把康軒國語的課次資料 ＋ 教育部辭典，組成 chinese.html 裡的內建題庫。
 *
 * 課次資料：data/康軒國語_114學年_逐課彙總.csv
 *   來源是教育部教育百科的「生字詞彙表」（國語 × 康軒版 × 114 學年度），
 *   一列一課，含生字、認讀字、語詞。
 *
 * 注音、部首、總筆畫：教育部《重編國語辭典修訂本》開放資料
 *   git clone --depth 1 https://github.com/g0v/moedict-data /tmp/moedict-data
 *   xz -dc /tmp/moedict-data/dict-revised.json.xz > /tmp/moe.json
 *
 * 跑法：
 *   node tools/build-chinese-bank.mjs /tmp/moe.json          # 寫回 chinese.html
 *   node tools/build-chinese-bank.mjs /tmp/moe.json --dry    # 只印統計不動檔案
 *
 * 產生的東西會塞在 chinese.html 的 BOOK-START / BOOK-END 之間。
 */
import fs from 'node:fs';

const dictPath = process.argv[2];
const dry = process.argv.includes('--dry');
if (!dictPath) {
  console.error('用法：node tools/build-chinese-bank.mjs <教育部辭典 json> [--dry]');
  process.exit(2);
}

/* ── 教育部辭典 ──
   注意：辭典把一個字的各種讀音（heteronyms）並排放著，順序不是「常用的排前面」，
   直接取第一個會拿到古音（佛 ㄅㄧˋ、份 ㄅㄧㄣ、價 ˙ㄍㄚ）。所以常用音是這樣挑的：
     1. 先看這個字在課本語詞裡怎麼唸（操場 → 場 唸 ㄔㄤˇ）—— 課本教什麼就是什麼
     2. 沒有的話，看這個讀音在辭典所有詞條裡出現幾次，多的贏
     3. 還是平手就看哪個讀音的義項多
   拿 428 個手動查證過的字回頭驗，這個作法對 422 個；剩下的寫在 OVERRIDE 裡。 */
const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));

// 課本教的音跟辭典的排序不一樣，這幾個手動指定
// （辭典是學術版，破音字的排序跟課本教的不一定一樣，例如操場辭典寫 ㄔㄤˊ、課本教 ㄔㄤˇ）
const OVERRIDE = {
  '喝': 'ㄏㄜ', '子': 'ㄗˇ', '熟': 'ㄕㄡˊ', '校': 'ㄒㄧㄠˋ', '相': 'ㄒㄧㄤ',
  '場': 'ㄔㄤˇ', '重': 'ㄓㄨㄥˋ', '都': 'ㄉㄡ', '將': 'ㄐㄧㄤ'
};

const wordBpmf = {};          // 詞 → [注音, …]（同一個詞可能有多種唸法）
const useCount = {};          // 字 → { 讀音: 在詞裡出現幾次 }
const single = {};            // 字 → 辭典裡的單字條目
for (const e of dict) {
  const t = e.title || '';
  if (!/^[一-鿿]+$/.test(t)) continue;
  const cs = [...t];
  if (cs.length === 1) {
    if (e.radical && !single[t]) single[t] = e;
    continue;
  }
  for (const h of e.heteronyms || []) {
    const bp = (h.bopomofo || '').trim();
    if (!bp) continue;
    const syl = bp.split(/\s+/);
    if (syl.length !== cs.length) continue;
    (wordBpmf[t] || (wordBpmf[t] = [])).push(syl);
    cs.forEach((c, i) => {
      (useCount[c] || (useCount[c] = {}));
      useCount[c][syl[i]] = (useCount[c][syl[i]] || 0) + 1;
    });
  }
}

// 課本語詞投的票（權重最高）
const bookVote = {};
function voteFromWord(w) {
  const rows = wordBpmf[w];
  if (!rows) return;
  const cs = [...w];
  for (const syl of rows) {
    cs.forEach((c, i) => {
      (bookVote[c] || (bookVote[c] = {}));
      bookVote[c][syl[i]] = (bookVote[c][syl[i]] || 0) + 1;
    });
  }
}

function readingOf(c) {
  const e = single[c];
  if (!e) return null;
  const hs = (e.heteronyms || []).filter((h) => h.bopomofo);
  if (!hs.length) return null;
  if (OVERRIDE[c] && hs.some((h) => h.bopomofo.trim() === OVERRIDE[c])) return OVERRIDE[c];
  let top = hs[0].bopomofo.trim(), score = -1;
  for (const h of hs) {
    const b = h.bopomofo.trim();
    const s = (bookVote[c] && bookVote[c][b] ? bookVote[c][b] : 0) * 10000 +
              (useCount[c] && useCount[c][b] ? useCount[c][b] : 0) * 100 +
              (h.definitions || []).length;
    if (s > score) { score = s; top = b; }
  }
  return top;
}

/* ── 課次表 ── */
const csv = fs.readFileSync('data/康軒國語_114學年_逐課彙總.csv', 'utf8').replace(/^﻿/, '');
const rows = [];
{
  // 這份 CSV 沒有引號包起來的欄位，直接切逗號就好
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    rows.push(row);
  }
}

const GRADE = { 一年級: 1, 二年級: 2, 三年級: 3, 四年級: 4, 五年級: 5, 六年級: 6 };
const TERM = { 上學期: 1, 下學期: 2 };
const splitList = (s) => (s || '').split(/[、,]/).map((x) => x.trim()).filter(Boolean);

const book = {};                      // '1a' → [[課名, 生字, 認讀字, 語詞], …]
const chars = new Set();
let lessons = 0, ziCount = 0, recogCount = 0, wordCount = 0;

for (const r of rows) {
  const g = GRADE[r['年級']], t = TERM[r['學期']];
  if (!g || !t) continue;
  const key = g + (t === 1 ? 'a' : 'b');
  const zi = splitList(r['生字']);
  const recog = splitList(r['認讀字']);
  const words = splitList(r['語詞']).filter((w) => /^[一-鿿]{2,8}$/.test(w));
  // 課名長這樣：「第一課：拍拍手」，前面的「第X課：」拿掉，課次另外有欄位
  const name = (r['課名'] || '').replace(/^第[一二三四五六七八九十]+課[：:]\s*/, '');
  (book[key] || (book[key] = [])).push([name, zi.join(''), recog.join(''), words.join(',')]);
  zi.concat(recog).forEach((c) => chars.add(c));
  words.forEach((w) => [...w].forEach((c) => chars.add(c)));
  words.forEach(voteFromWord);
  lessons++; ziCount += zi.length; recogCount += recog.length; wordCount += words.length;
}

/* ── 字典：課本用得到的字才收 ── */
const missing = [];
const dictLines = [];
for (const c of [...chars].sort()) {
  const e = single[c];
  const b = readingOf(c);
  if (!e || !b) { missing.push(c); continue; }
  dictLines.push(`${c}${b}|${String(e.radical).trim()}|${e.stroke_count || 0}`);
}

/* ── 語詞的意思 ──
   教育百科每個語詞都附辭典解釋，拿來出「看解釋選詞」。只取第一句、
   去掉括號和例句，太短或沒鑑別度的（「動物名」「→鯊」這種）就不要，
   解釋裡本來就有那個詞的也不要（等於把答案寫在題目上）。 */
const glossRows = [];
try {
  const raw = fs.readFileSync('data/康軒國語_114學年_語詞解釋.csv', 'utf8').replace(/^﻿/, '');
  const lines = raw.trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    // 解釋裡有逗號，所以只切第一個逗號
    const at = line.indexOf(',');
    if (at < 0) continue;
    const w = line.slice(0, at).trim().replace(/^"|"$/g, '');
    let def = line.slice(at + 1).trim().replace(/^"|"$/g, '').replace(/""/g, '"');
    def = def.split(/[。；;]|如：|\[例\]|例：/)[0];
    def = def.replace(/[（(][^)）]*[)）]/g, '').replace(/^\d+\.\s*/, '').trim();
    def = def.replace(/[|;'\\]/g, '，').replace(/，+/g, '，').replace(/^，|，$/g, '');
    if (!w || !def) continue;
    if (/^[→⇒]|^參見|^見「|^同「/.test(def)) continue;      // 只是叫你去看別的詞條
    if ([...def].length < 4 || [...def].length > 30) continue;
    if (def.includes(w)) continue;                            // 解釋裡有答案
    glossRows.push(`${w}|${def}`);
  }
} catch (e) {
  console.log('（沒有找到語詞解釋的 CSV，這次不產生「看解釋選詞」的資料）');
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const out = [];
out.push('  /* 課次資料：康軒版國語 114 學年度，來源是教育部教育百科的「生字詞彙表」');
out.push('     （https://pedia.cloud.edu.tw/Bookmark/Textword）。一課一筆：');
out.push('     [課名, 生字, 認讀字, 語詞（逗號分開）]。認讀字是課本要求「認得但不必會寫」的字。');
out.push('     這一段是 tools/build-chinese-bank.mjs 產生的，不要手改。 */');
out.push('  var BOOK = {');
for (const key of Object.keys(book)) {
  out.push(`    '${key}': [`);
  for (const [name, zi, recog, words] of book[key]) {
    out.push(`      ['${esc(name)}','${zi}','${recog}','${esc(words)}'],`);
  }
  out.push('    ],');
}
out.push('  };');
out.push('');
out.push('  /* 每個字的注音、部首、總筆畫，取自教育部《重編國語辭典修訂本》開放資料。');
out.push('     格式：字＋注音|部首|總筆畫，用分號隔開。 */');
out.push("  var DICT = '" + dictLines.join(';') + "';");
out.push('');
out.push('  /* 語詞的意思，出「看解釋選詞」用。來源同樣是教育百科的辭典解釋，');
out.push('     只留第一句、去掉例句和括號；沒鑑別度的（「動物名」「→鯊」）不收。 */');
out.push("  var GLOSS = '" + glossRows.join(';') + "';");

const block = out.join('\n');

console.log(`課 ${lessons}、生字 ${ziCount}、認讀字 ${recogCount}、語詞 ${wordCount}`);
console.log(`不重複的字 ${chars.size}，其中 ${dictLines.length} 個查得到教育部的注音部首筆畫`);
console.log(`語詞解釋可用的有 ${glossRows.length} 個`);
if (missing.length) console.log('查不到的字：', missing.join(''));
console.log(`產生的資料 ${(Buffer.byteLength(block) / 1024).toFixed(0)} KB`);

if (dry) process.exit(0);

const htmlPath = 'chinese.html';
const html = fs.readFileSync(htmlPath, 'utf8');
const start = '  /* BOOK-START */';
const end = '  /* BOOK-END */';
const a = html.indexOf(start), b = html.indexOf(end);
if (a < 0 || b < 0) {
  console.error(`chinese.html 裡找不到 ${start} / ${end} 這兩個標記`);
  process.exit(1);
}
fs.writeFileSync(htmlPath, html.slice(0, a + start.length) + '\n' + block + '\n' + html.slice(b));
console.log('已寫回 chinese.html');
