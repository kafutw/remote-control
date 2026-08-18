#!/usr/bin/env node
/**
 * 抓何嘉仁（Hess）國小英語 Fun World 第 1～4 冊（小一上～小二下）的單字。
 *
 *   node tools/fetch-hess-vocab.mjs --probe      # 只探測：哪些網址通、頁面長什麼樣（不寫檔）
 *   node tools/fetch-hess-vocab.mjs -o data/hess-vocab.json
 *
 * 為什麼是 GitHub Actions 在跑這支：執行 Claude 的沙盒對外只放行 GitHub 與
 * 套件庫，連 hess.com.tw 會被 proxy 擋掉（CONNECT 403）。Actions 的 runner
 * 網路沒有限制，所以由它抓、寫回 repo，沙盒再從 raw.githubusercontent.com 讀。
 * 跟 data/live.json 那條管線是同一招。
 *
 * 冊次對應（依何嘉仁的教材編排；各校進度可能不同，以手上的課本冊次為準）：
 *   Fun World 1 → 小一上　　Fun World 2 → 小一下
 *   Fun World 3 → 小二上　　Fun World 4 → 小二下
 *
 * ⚠️ 這支腳本沒有在真實網站上跑過（寫它的環境連不出去），第一次跑務必用
 *    --probe，看 log 確認頁面結構後再調整下面的解析規則。單字表是版權內容，
 *    這裡只抓「單字本身」用於自家小孩複習，不抓也不存課文與音檔。
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const probe = argv.includes("--probe");
const oi = argv.indexOf("-o");
const outFile = oi >= 0 ? argv[oi + 1] : "data/hess-vocab.json";
const DELAY = 1500;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 每一冊的候選網址。哪個通、哪個有單字，靠 --probe 印出來的 log 決定。 */
const BOOKS = [
  { id: "FW1", book: 1, grade: "小一上" },
  { id: "FW2", book: 2, grade: "小一下" },
  { id: "FW3", book: 3, grade: "小二上" },
  { id: "FW4", book: 4, grade: "小二下" },
].map(b => ({
  ...b,
  urls: [
    `https://neweteaching.hess.com.tw/CDOnline/${b.id}_V2.html`,
    `https://neweteaching.hess.com.tw/CDOnline/${b.id}.html`,
  ],
}));

/** 數位互動練習（Wordwall）的入口。Fun World 1 已知是 /05/16，其餘用鄰近 id 掃。 */
const DIGI = Array.from({ length: 8 }, (_, i) => `https://hessdigi.hess.com.tw/DigiLink/05/${13 + i}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" } });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body, url };
    } catch (e) {
      if (attempt === 3) return { ok: false, status: 0, body: "", url, error: String(e.message || e) };
      await sleep(1000 * attempt);
    }
  }
}

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/** HTML → 可讀純文字。標籤換行，這樣單字一個一行的版面才不會黏成一串。 */
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e[0] === "#" ? String.fromCharCode(+e.slice(1)) : m))
    .split("\n").map(l => l.replace(/[ \t　]+/g, " ").trim()).filter(Boolean).join("\n");
}

/** 頁面靠 JS 撐起來的話，文字會少得可疑 —— 這時要找的是它背後的資料檔。 */
function findDataUrls(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/["'`]([^"'`\s]+\.(?:json|js|xml|txt))(?:\?[^"'`\s]*)?["'`]/gi)) {
    try { out.add(new URL(m[1], base).href); } catch {}
  }
  return [...out].filter(u => !/jquery|bootstrap|analytics|gtag|swiper|owl|popper/i.test(u));
}

const isEnglish = s => /^[A-Za-z][A-Za-z'’\- ]{0,24}$/.test(s);
const hasChinese = s => /[一-鿿]/.test(s);

/**
 * 從純文字裡撿單字。三種常見排版都試：
 *   "pencil 鉛筆"（同一行）、"pencil" 下一行 "鉛筆"、以及只有英文的清單。
 * 單元標題（Unit 3 / Lesson 2 / Review 1）沿路記著，撿到的字掛在最近一個單元底下。
 */
function extractUnits(text) {
  const lines = text.split("\n");
  const units = [];
  let cur = null;

  const push = (en, zh) => {
    if (!cur) cur = { unit: "未標示單元", words: [] };
    en = en.trim().replace(/\s+/g, " ");
    zh = (zh || "").trim();
    if (!isEnglish(en) || en.length < 2) return;
    if (/^(unit|lesson|review|track|words?|listen|song|chant|story|page|cd|mp3)$/i.test(en)) return;
    if (cur.words.some(w => w.en.toLowerCase() === en.toLowerCase())) return;
    cur.words.push({ en, zh });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = line.match(/^\s*((?:Unit|Lesson|Review)\s*\d+)\b(.*)$/i);
    if (head) {
      if (cur && cur.words.length) units.push(cur);
      cur = { unit: head[1].replace(/\s+/g, " "), title: head[2].trim() || undefined, words: [] };
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z'’\- ]{0,24}?)\s*[\t：:,，(（]?\s*([一-鿿][^A-Za-z]*)$/);
    if (pair) { push(pair[1], pair[2].replace(/[)）]$/, "")); continue; }
    if (isEnglish(line)) {
      const next = lines[i + 1] || "";
      if (hasChinese(next) && !isEnglish(next)) { push(line, next); i++; }
      else push(line, "");
    }
  }
  if (cur && cur.words.length) units.push(cur);
  return units;
}

// ── 解析規則的離線測試 ──────────────────────────────────────────────
// 抓不到看得見（HTTP 錯誤會叫），但解析寫歪不會有症狀：少撿到一半的字，
// 產出的檔案照樣長得很正常，只是小孩複習時少背了一半。所以規則要有測試。
if (argv.includes("--self-test")) {
  const cases = [
    { name: "同一行的英中對照", html: "<p>Unit 1 School</p><p>pencil 鉛筆</p><p>book 書</p>",
      want: [["Unit 1", "pencil", "鉛筆"], ["Unit 1", "book", "書"]] },
    { name: "英文與中文分兩行", html: "<div>Unit 2</div><div>apple</div><div>蘋果</div><div>banana</div><div>香蕉</div>",
      want: [["Unit 2", "apple", "蘋果"], ["Unit 2", "banana", "香蕉"]] },
    { name: "表格排版、只有英文", html: "<tr><td>Lesson 3</td></tr><tr><td>red</td></tr><tr><td>blue</td></tr>",
      want: [["Lesson 3", "red", ""], ["Lesson 3", "blue", ""]] },
    { name: "略過導覽字與重複字", html: "<p>Unit 1</p><p>Track 1</p><p>Words</p><p>cat 貓</p><p>cat 貓</p>",
      want: [["Unit 1", "cat", "貓"]] },
    { name: "多個單元不會混在一起", html: "<p>Unit 1</p><p>one 一</p><p>Unit 2</p><p>two 二</p>",
      want: [["Unit 1", "one", "一"], ["Unit 2", "two", "二"]] },
    { name: "片語（含空白）也要收", html: "<p>Unit 5</p><p>good morning 早安</p>",
      want: [["Unit 5", "good morning", "早安"]] },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = extractUnits(toText(c.html)).flatMap(u => u.words.map(w => [u.unit, w.en, w.zh]));
    const same = JSON.stringify(got) === JSON.stringify(c.want);
    if (!same) { bad++; console.error(`✗ ${c.name}\n   預期 ${JSON.stringify(c.want)}\n   實得 ${JSON.stringify(got)}`); }
    else console.error(`✓ ${c.name}`);
  }
  process.exit(bad ? 1 : 0);
}

// ── 探測模式：先看清楚長什麼樣，再談解析 ──────────────────────────────
if (probe) {
  const targets = [...BOOKS.flatMap(b => b.urls.map(u => ({ label: b.id, url: u }))),
                   ...DIGI.map(u => ({ label: "DigiLink", url: u }))];
  for (const t of targets) {
    const res = await get(t.url);
    const text = res.ok ? toText(res.body) : "";
    const title = (res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    console.log("\n" + "═".repeat(72));
    console.log(`${t.label}  ${t.url}`);
    console.log(`  HTTP ${res.status}${res.error ? "  " + res.error : ""}  html ${res.body.length} bytes  text ${text.length} chars`);
    if (title) console.log(`  <title> ${title}`);
    if (res.ok) {
      const units = extractUnits(text);
      console.log(`  解析到 ${units.length} 個單元、${units.reduce((n, u) => n + u.words.length, 0)} 個字`);
      if (text.length < 400) {
        console.log("  ⚠️ 文字太少，多半是 JS 撐起來的頁面。候選資料檔：");
        for (const u of findDataUrls(res.body, t.url).slice(0, 25)) console.log("     " + u);
      }
      console.log("  ── 頁面文字（前 4000 字）──");
      console.log(text.slice(0, 4000).split("\n").map(l => "  | " + l).join("\n"));
    }
    await sleep(DELAY);
  }
  console.log("\n看完 log 再回去調 extractUnits() 的規則，然後拿掉 --probe 正式抓。");
  process.exit(0);
}

// ── 正式抓取 ────────────────────────────────────────────────────────
const result = { source: "何嘉仁 Fun World（國小英語課本）", fetchedAt: new Date().toISOString(), books: [] };
let total = 0, failedBooks = 0;

for (const b of BOOKS) {
  let got = null;
  for (const url of b.urls) {
    const res = await get(url);
    console.error(`${b.id} ${url} → HTTP ${res.status}`);
    if (res.ok && res.body.length > 500) { got = res; break; }
    await sleep(DELAY);
  }
  if (!got) {
    console.error(`✗ ${b.id}（${b.grade}）全部候選網址都沒抓到`);
    result.books.push({ book: b.book, grade: b.grade, id: b.id, error: "fetch failed" });
    failedBooks++;
    continue;
  }
  const units = extractUnits(toText(got.body));
  const n = units.reduce((s, u) => s + u.words.length, 0);
  total += n;
  console.error(`✓ ${b.id}（${b.grade}）${units.length} 單元 / ${n} 字　${got.url}`);
  result.books.push({ book: b.book, grade: b.grade, id: b.id, sourceUrl: got.url, units });
  await sleep(DELAY);
}

result.totalWords = total;

// 一個字都沒解析出來就不要覆蓋既有檔案 —— 寧可維持原狀，也不要把空檔寫進去
// 讓頁面變成「沒有單字」而不是「抓失敗」。
if (total === 0) {
  console.error("\n✗ 一個單字都沒解析到，不寫檔（保留原有的 " + outFile + "）。先跑 --probe 看頁面結構。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");

const csv = ["book,grade,unit,en,zh"];
for (const b of result.books)
  for (const u of b.units || [])
    for (const w of u.words)
      csv.push([b.book, b.grade, u.unit, w.en, w.zh].map(v => /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(","));
fs.writeFileSync(outFile.replace(/\.json$/, ".csv"), csv.join("\n") + "\n");

console.error(`\n寫入 ${outFile}　共 ${total} 字，其中 ${failedBooks} 冊沒抓到。`);
