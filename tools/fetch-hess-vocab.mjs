#!/usr/bin/env node
/**
 * 何嘉仁（Hess）國小英語 Fun World 第 1～4 冊（小一上～小二下）的單字來源探勘。
 *
 *   node tools/fetch-hess-vocab.mjs --self-test   # 離線驗解析規則
 *   node tools/fetch-hess-vocab.mjs --probe       # 探測：各冊 id、單元連結、樣本頁面（不寫檔）
 *   node tools/fetch-hess-vocab.mjs -o data/hess-sources.json
 *
 * 為什麼是 GitHub Actions 在跑這支：執行 Claude 的沙盒對外只放行 GitHub 與
 * 套件庫，連 hess.com.tw 會被 proxy 擋掉（CONNECT 403）。Actions 的 runner
 * 網路沒有限制，所以由它抓、寫回 repo，沙盒再從 raw.githubusercontent.com 讀。
 * 跟 data/live.json 那條管線是同一招。
 *
 * 冊次對應（已由課本封面確認 Fun World 1、2 是小一；3、4 依教材編排推得）：
 *   Fun World 1 → 小一上　　Fun World 2 → 小一下
 *   Fun World 3 → 小二上　　Fun World 4 → 小二下
 *
 * 單字表是版權內容。這裡只取「單字本身」給自家小孩複習，不抓課文、不抓音檔。
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const probe = argv.includes("--probe");
const oi = argv.indexOf("-o");
const outFile = oi >= 0 ? argv[oi + 1] : "data/hess-sources.json";
const DELAY = 1500;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * 第一次探測（2026-08-18）的結論，寫在這裡免得下次又走一遍冤枉路：
 *
 * ✗ CDOnline（neweteaching.hess.com.tw/CDOnline/FW1_V2.html…）通，但**沒有單字**，
 *   整頁只有「CD2 Track 70 / 00:49」這種音軌清單與時間，而且頁尾聲明音檔僅限
 *   購買教材者使用。這條路是死的，不要再回去抓。順帶一提 FW1／FW2 是 `_V2.html`，
 *   FW3／FW4 沒有 `_V2`，是 `FW3.html`／`FW4.html`。
 *
 * ✓ DigiLink（hessdigi.hess.com.tw/DigiLink/05/{id}）是分冊的「數位練習平台」入口，
 *   每一冊列出各單元的 Wordwall／Quizlet／Blooket／Kahoot 連結 —— **單字在那些連結裡**，
 *   不在何嘉仁自己的頁面上。已知 16=Fun World 1、19=Fun World 2、20=Fun World 3、
 *   17=Go Magic 1、18=Super Fun 1；Fun World 4 的 id 還沒找到，所以下面掃寬一點。
 *
 * 所以現在的探測要做兩件事：把每一冊的 id 找齊，並且**印出頁面上的外部連結**
 * （純文字看不到 href，第一次就是這樣漏掉的）。
 */
const BOOKS = [
  { id: "FW1", book: 1, grade: "小一上" },
  { id: "FW2", book: 2, grade: "小一下" },
  { id: "FW3", book: 3, grade: "小二上" },
  { id: "FW4", book: 4, grade: "小二下" },
];

/** Fun World 4 的 id 還沒找到，整段掃過去比猜快。 */
const DIGI = Array.from({ length: 40 }, (_, i) => `https://hessdigi.hess.com.tw/DigiLink/05/${i + 1}`);

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

/** 頁面上的外部連結（單字在這些連結裡，不在何嘉仁自己的頁面上）。 */
function extractLinks(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href;
    try { href = new URL(m[1], base).href; } catch { continue; }
    const host = new URL(href).hostname.replace(/^www\./, "");
    if (/hess\.com\.tw$/.test(host)) continue;          // 站內導覽，不是練習連結
    const label = toText(m[2]).replace(/\n/g, " ").trim();
    out.push({ label, href, host });
  }
  return out;
}

/** DigiLink 頁面上「數位練習平台」下一行就是教材名（Fun World 1、Super Fun 1…）。 */
function bookLabel(text) {
  const lines = text.split("\n");
  const i = lines.findIndex(l => l.includes("數位練習平台"));
  return i >= 0 ? (lines[i + 1] || "").trim() : "";
}

const isFunWorld = label => /^Fun World\s*[1-4]$/i.test(label);

// ── 探測模式：先看清楚長什麼樣，再談解析 ──────────────────────────────
if (probe) {
  console.log("── 掃 DigiLink，找出各冊的 id、單元、以及單元連到哪裡 ──");
  const pages = [];
  for (const url of DIGI) {
    const res = await get(url);
    if (!res.ok || res.body.length < 2000) continue;   // 404 頁固定 1136 bytes
    const text = toText(res.body);
    const label = bookLabel(text);
    const links = extractLinks(res.body, url);
    const hosts = [...new Set(links.map(l => l.host))];
    console.log(`\n${url}\n  教材 ${label || "（認不出來）"}　連結 ${links.length} 個　平台 ${hosts.join(", ") || "無"}`);
    if (isFunWorld(label)) {
      pages.push({ url, label, links });
      for (const l of links) console.log(`    ${l.label.padEnd(10)} ${l.href}`);
    }
    await sleep(600);
  }

  // 連結拿到了還不夠 —— 那些站認不認 runner 的 IP、單字在不在 HTML 裡，
  // 是兩件不同的事，而且只有真的抓一次才知道。每個平台各試一個。
  console.log("\n── 每個平台各抓一個樣本，看單字撈不撈得出來 ──");
  const seen = new Set();
  for (const p of pages) {
    for (const l of p.links) {
      if (seen.has(l.host)) continue;
      seen.add(l.host);
      const res = await get(l.href);
      const text = res.ok ? toText(res.body) : "";
      console.log(`\n${l.host}　${p.label} ${l.label}\n  ${l.href}\n  HTTP ${res.status}${res.error ? "  " + res.error : ""}  html ${res.body.length} bytes  text ${text.length} chars`);
      if (!res.ok) continue;
      const units = extractUnits(text);
      console.log(`  直接解析：${units.reduce((n, u) => n + u.words.length, 0)} 個字`);
      // 這類站多半把內容塞在 HTML 裡的 JSON，不在可見文字上。
      for (const key of ["terms", "word", "definition", "cards", "answers", "questions"]) {
        const hit = res.body.indexOf(`"${key}"`);
        if (hit >= 0) console.log(`  含 "${key}" 於 offset ${hit}：${res.body.slice(hit, hit + 220).replace(/\s+/g, " ")}`);
      }
      console.log("  ── 可見文字（前 1200 字）──");
      console.log(text.slice(0, 1200).split("\n").map(x => "  | " + x).join("\n"));
      await sleep(1200);
    }
  }
  console.log("\n看完再決定從哪個平台撈單字，然後把規則寫進 extractUnits()。");
  process.exit(0);
}

// ── 正式抓取：先把「哪一冊、哪一單元、連到哪裡」這張表建起來 ──────────
// 單字本身還沒有著落（何嘉仁自己的頁面上沒有），但這張表是後面每一步的地基，
// 而且它本身就有用 —— 點進去就是該單元的練習。
const sources = { source: "何嘉仁 Fun World 數位練習平台（hessdigi）", fetchedAt: new Date().toISOString(), books: [] };

for (const url of DIGI) {
  const res = await get(url);
  if (!res.ok || res.body.length < 2000) continue;
  const label = bookLabel(toText(res.body));
  if (!isFunWorld(label)) continue;
  const n = Number(label.match(/(\d)$/)[1]);
  const meta = BOOKS[n - 1];
  const links = extractLinks(res.body, url);
  console.error(`✓ ${label}（${meta.grade}）${links.length} 個練習連結　${url}`);
  sources.books.push({ book: n, grade: meta.grade, label, digiUrl: url, links });
  await sleep(600);
}

sources.books.sort((a, b) => a.book - b.book);

if (!sources.books.length) {
  console.error("\n✗ 一冊都沒找到，不寫檔。先跑 --probe 看 DigiLink 是不是改版了。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(sources, null, 2) + "\n");

const missing = BOOKS.filter(b => !sources.books.some(s => s.book === b.book));
console.error(`\n寫入 hess-sources.json：${sources.books.length} 冊、` +
  `${sources.books.reduce((n, b) => n + b.links.length, 0)} 個連結` +
  (missing.length ? `　⚠️ 還缺 ${missing.map(b => b.id + "(" + b.grade + ")").join("、")}` : ""));
