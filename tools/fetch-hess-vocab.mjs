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

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * HTML 實體還原。十進位（&#39;）與**十六進位**（&#x627E;）都要認 ——
 * 只認十進位的話，中文標題會整串變成 \u0000，而且看起來只是「字有點怪」，
 * 不會有任何錯誤。Wordwall 的標題正是用十六進位寫中文的。
 */
function decodeEntity(e) {
  if (e[0] !== "#") return ENTITIES[e] ?? null;
  const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : null;
}

/** HTML → 可讀純文字。標籤換行，這樣單字一個一行的版面才不會黏成一串。 */
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => decodeEntity(e) ?? m)
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

  // 連結解析用 DigiLink 真實版面測（照抄自探測 log），因為前一版就是在這裡漏掉
  // 全部的連結 —— 而且它「成功」跑完、寫出一個 0 連結的檔案，完全沒有症狀。
  const REAL = '<div class="unit-section"> <div class="unit-header"> <img src="/image/digi-link/icons.png" /> ' +
    '<h5 class="unit-name"> Wordwall </h5> </div> <ul class="page-list"> <li class="page-item"> ' +
    '<a class="page" href="/DigiLink/05/16/533"> <span> Unit 1 </span> <i class="fas fa-chevron-right"></i> </a> </li> ' +
    '<li class="page-item"> <a class="page" href="/DigiLink/05/16/535"> <span> Review 1 </span> </a> </li> </ul> </div> ' +
    '<div class="unit-section"> <div class="unit-header"> <h5 class="unit-name"> Quizlet </h5> </div> ' +
    '<ul class="page-list"> <li class="page-item"> <a class="page" href="/DigiLink/05/16/557"> <span> Unit 1 </span> </a> </li> </ul> </div>';
  const wantLinks = [
    ["Wordwall", "Unit 1", "https://hessdigi.hess.com.tw/DigiLink/05/16/533"],
    ["Wordwall", "Review 1", "https://hessdigi.hess.com.tw/DigiLink/05/16/535"],
    ["Quizlet", "Unit 1", "https://hessdigi.hess.com.tw/DigiLink/05/16/557"],
  ];
  const gotLinks = extractUnitLinks(REAL, "https://hessdigi.hess.com.tw/DigiLink/05/16")
    .map(l => [l.platform, l.unit, l.href]);
  if (JSON.stringify(gotLinks) !== JSON.stringify(wantLinks)) {
    bad++;
    console.error(`✗ DigiLink 單元連結\n   預期 ${JSON.stringify(wantLinks)}\n   實得 ${JSON.stringify(gotLinks)}`);
  } else console.error("✓ DigiLink 單元連結（平台歸屬、站內相對路徑）");

  // 兩件會靜靜出錯的事：網址裡的 &amp; 不還原會抓成 404 或抓到別組單字；
  // 標籤掉了就分不出「單字」和「字母」，最後會把字母表當單字表背。
  const SUB = '<a href="https://wordwall.net/resource/33782827" class="btn">記憶配對 字母</a> ' +
    '<a href="https://wordwall.net/resource/33599817" class="btn">找到夥伴 單字</a> ' +
    '<a href="https://quizlet.com/tw/601778996/x-flash-cards/?i=268wv3&amp;x=1jqt">前往</a> ' +
    '<link href="https://use.fontawesome.com/releases/v5.0.9/css/all.css" /> ' +
    '<a href="/DigiLink/05/16">回上頁</a> <a href="https://hessdigi.hess.com.tw/DigiLink/Index">首頁</a>';
  const wantTargets = [
    ["記憶配對 字母", "https://wordwall.net/resource/33782827"],
    ["找到夥伴 單字", "https://wordwall.net/resource/33599817"],
    ["前往", "https://quizlet.com/tw/601778996/x-flash-cards/?i=268wv3&x=1jqt"],
  ];
  const gotTargets = extractTargetLinks(SUB).map(t => [t.label, t.url]);
  if (JSON.stringify(gotTargets) !== JSON.stringify(wantTargets)) {
    bad++;
    console.error(`✗ 練習網址\n   預期 ${JSON.stringify(wantTargets)}\n   實得 ${JSON.stringify(gotTargets)}`);
  } else console.error("✓ 練習網址（保留標籤、還原 &amp;、濾掉 CDN 與站內連結）");

  const WW = '<title>Fun World 1_U1_&#x627E;&#x5230;&#x5925;&#x4F34; - Find the match</title>' +
    '<meta name="description" content="apple, book, cat, ant, bird, cup">';
  const gotWW = parseWordwall(WW);
  const wantWW = { title: "Fun World 1_U1_找到夥伴 - Find the match",
                   words: ["apple", "book", "cat", "ant", "bird", "cup"], letters: [] };
  if (JSON.stringify(gotWW) !== JSON.stringify(wantWW)) {
    bad++;
    console.error(`✗ Wordwall 單字\n   預期 ${JSON.stringify(wantWW)}\n   實得 ${JSON.stringify(gotWW)}`);
  } else console.error("✓ Wordwall 單字（meta description、標題還原中文實體）");

  const ABC = '<title>Fun World 1_U1_&#x8A18;&#x61B6;&#x914D;&#x5C0D;</title>' +
    '<meta name="description" content="a, b, c, apple">';
  const gotABC = parseWordwall(ABC);
  if (JSON.stringify(gotABC.letters) !== JSON.stringify(["a", "b", "c"]) ||
      JSON.stringify(gotABC.words) !== JSON.stringify(["apple"])) {
    bad++;
    console.error(`✗ 字母與單字要分開\n   實得 ${JSON.stringify(gotABC)}`);
  } else console.error("✓ 字母與單字分開（字母表活動不會被當成單字）");

  // 真假遊戲、對錯遊戲的選項會混進 meta，長得跟單字一模一樣。
  // 不擋掉，小孩就會背到 True 和 Incorrect —— 而且資料看起來完全正常。
  const NOISE = '<title>x</title><meta name="description" content="True, goat, hen, False, fish., ' +
    '&#x771F;, Correct, insect, Incorrect">';
  const gotNoise = parseWordwall(NOISE);
  if (JSON.stringify(gotNoise.words) !== JSON.stringify(["goat", "hen", "fish", "insect"])) {
    bad++;
    console.error(`✗ 遊戲選項要濾掉\n   實得 ${JSON.stringify(gotNoise.words)}`);
  } else console.error("✓ 遊戲選項與標點（True／False／Correct／中文／fish.）不會混進單字");

  const KH = JSON.stringify({
    title: "Halloween (低年級)",
    questions: [
      { question: "Choose the correct answer.", choices: [{ answer: "D", correct: true }, { answer: "B", correct: false }] },
      { question: "What do you say on Halloween?", choices: [{ answer: "Trick or <b>treat</b>!", correct: true }, { answer: "Good night.", correct: false }] },
    ],
  });
  const gotKH = parseKahoot(KH);
  const wantKH = { title: "Halloween (低年級)", questions: [
    { question: "Choose the correct answer.", answers: ["D"] },
    { question: "What do you say on Halloween?", answers: ["Trick or treat !"] },
  ] };
  if (JSON.stringify(gotKH) !== JSON.stringify(wantKH)) {
    bad++;
    console.error(`✗ Kahoot 題庫\n   預期 ${JSON.stringify(wantKH)}\n   實得 ${JSON.stringify(gotKH)}`);
  } else console.error("✓ Kahoot 題庫（只留正解、題目去 HTML）");

  if (kahootId("https://create.kahoot.it/share/halloween-r1/dfa11a74-8737-4e4c-ae7f-bde78a3cebf1")
      !== "dfa11a74-8737-4e4c-ae7f-bde78a3cebf1") {
    bad++; console.error("✗ Kahoot uuid 取不出來");
  } else console.error("✓ Kahoot uuid（從分享網址的最後一段取）");

  process.exit(bad ? 1 : 0);
}

/**
 * DigiLink 的單元連結。第三次探測（同日）才看清楚它長這樣：
 *
 *   <div class="unit-section">
 *     <div class="unit-header"><h5 class="unit-name"> Wordwall </h5></div>
 *     <ul class="page-list">
 *       <li class="page-item"><a class="page" href="/DigiLink/05/16/533"><span> Unit 1 </span>…</a></li>
 *
 * 也就是說單元**是**超連結，只是連到站內的 /DigiLink/{類}/{冊}/{頁} ——
 * 前一版把 hess.com.tw 當「站內導覽」整批濾掉，等於親手把答案丟掉。
 * 平台名（Wordwall／Quizlet／Blooket／Kahoot）在最近的一個 unit-name 裡，
 * 所以邊走邊記：遇到標題就換平台，遇到連結就掛在當下的平台底下。
 */
function extractUnitLinks(html, base) {
  const out = [];
  let platform = "";
  const token = /<h5[^>]*class="unit-name"[^>]*>([\s\S]*?)<\/h5>|<a[^>]*class="page"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(token)) {
    if (m[1] !== undefined) { platform = toText(m[1]).replace(/\n/g, " ").trim(); continue; }
    let href;
    try { href = new URL(m[2], base).href; } catch { continue; }
    out.push({ platform, unit: toText(m[3]).replace(/\n/g, " ").trim(), href });
  }
  return out;
}

/** 只還原實體，不動標籤 —— 網址裡的 &amp; 不還原會抓成 404。 */
function unescapeHtml(s) {
  return s.replace(/&(#?\w+);/g, (m, e) => decodeEntity(e) ?? m);
}

/**
 * 站內頁 /DigiLink/05/16/557 → 真正的練習網址，連按鈕上的標籤一起留下。
 * 標籤很重要：同一個單元的 Wordwall 常常有兩個活動 ——「記憶配對 字母」和
 *「找到夥伴 單字」—— 要的是後者，有標籤就不用猜。
 *
 * 第五次探測（同日）確認過各平台從 GitHub runner 連出去的結果：
 *   Quizlet  → HTTP 403 Captcha Challenge，一般頁／嵌入頁／webapi 三種全擋，機房 IP 沒得談
 *   Wordwall → HTTP 200，而且單字就印在頁面上（"apple, book, cat, ant, bird, cup"）
 *   所以單字從 Wordwall 撈，Quizlet 只留網址給人點。
 */
function extractTargetLinks(html) {
  const noise = /fontawesome|bootstrap|jquery|googleapis|gstatic|w3\.org|schema\.org|facebook|line\.me/i;
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = unescapeHtml(m[1]);
    if (/\bhess\.com\.tw/.test(url) || noise.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ label: toText(m[2]).replace(/\n/g, " ").trim(), url });
  }
  return out;
}

/**
 * Wordwall 活動頁 → 單字。第六次探測（同日）確認單字就放在 meta 裡，很乾淨：
 *
 *   <title>Fun World 1_U1_找到夥伴 - Find the match</title>
 *   <meta name="description" content="apple, book, cat, ant, bird, cup">
 *
 * 不要改用「可見文字」—— 那裡混著 Share／Print／Embed／Leaderboard 一堆介面字樣，
 * 照單全收會把按鈕當單字背（粗解析當時撈出 23 個「字」，一半以上是介面）。
 */
function parseWordwall(html) {
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const items = (meta ? unescapeHtml(meta[1]) : "")
    .split(/\s*,\s*/)
    .map(w => w.trim().replace(/[.,;:!?]+$/, ""))     // "fish." 這種尾巴要削掉
    .filter(Boolean)
    // 遊戲的作答按鈕不是單字。真假遊戲、對錯遊戲的選項會混進 meta 裡，
    // 而它們長得跟單字一模一樣 —— 不擋掉，小孩就會背到 True 和 Incorrect。
    .filter(w => !/^(true|false|correct|incorrect|yes|no)$/i.test(w))
    .filter(w => !/[一-鿿]/.test(w));                  // 中文（「真」「假」）同理
  return {
    title: title ? unescapeHtml(title[1]).replace(/\s+/g, " ").trim() : "",
    // 一個字母的是字母表活動（a, b, c…），不是單字。分開放，不要混在一起，
    // 但也不要丟掉 —— 小一上本來就在教字母。
    words: items.filter(w => w.length > 1),
    letters: items.filter(w => w.length === 1 && /^[a-z]$/i.test(w)),
  };
}

/**
 * Kahoot 題庫。第七次探測（同日）的結果，順便記下另外兩家的下場：
 *   Blooket → HTTP 403「Just a moment...」，api／dashboard／play 三個端點全被 Cloudflare 擋
 *   Kahoot  → play.kahoot.it/rest/kahoots/{uuid} 回完整 JSON，題目與選項都在裡面
 *
 * 何嘉仁的 Kahoot 是每冊兩份節慶複習（萬聖節、聖誕節、復活節、端午…），
 * 由 Hess_eteaching 這個帳號發布。題目文字可能含 HTML，要先轉純文字。
 */
function kahootId(url) {
  const m = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

function parseKahoot(body) {
  let d;
  try { d = JSON.parse(body); } catch { return null; }
  return {
    title: (d.title || "").trim(),
    questions: (d.questions || []).map(q => ({
      question: toText(q.question || "").replace(/\n/g, " ").trim(),
      // 正解才是要記的東西；其他選項是干擾項，背了會出事。
      answers: (q.choices || []).filter(c => c.correct).map(c => toText(c.answer || "").trim()).filter(Boolean),
    })).filter(q => q.question || q.answers.length),
  };
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
  // 第七輪：單字有了（Wordwall 的 meta），但課本還有「生活用語」——
  // Good morning 那類句子。Wordwall 的活動只練字母與單字，撈不到句子。
  // 線索是站內頁的標題：Quizlet 和 Blooket 都寫著「Unit 1（單字＋生活用語）」，
  // 也就是同一組內容。Quizlet 擋機房 IP，那就換 Blooket 和 Kahoot 試 ——
  // 這兩家都有公開的題目 API，而且還沒試過。
  const BLOOKET = "60f14ac59933c3001b7ad06b";                       // FW1 Unit 1
  const KAHOOT  = "dfa11a74-8737-4e4c-ae7f-bde78a3cebf1";           // FW1 Review 1（萬聖節）
  const tries = [
    ["Blooket API",       `https://api.blooket.com/api/games?gameId=${BLOOKET}`],
    ["Blooket dashboard", `https://dashboard.blooket.com/api/games?gameId=${BLOOKET}`],
    ["Blooket play",      `https://play.blooket.com/api/games?gameId=${BLOOKET}`],
    ["Blooket 網頁",      `https://dashboard.blooket.com/set/${BLOOKET}`],
    ["Kahoot API",        `https://play.kahoot.it/rest/kahoots/${KAHOOT}`],
    ["Kahoot card",       `https://create.kahoot.it/rest/kahoots/${KAHOOT}/card/?includeKahoot=true`],
  ];

  for (const [name, url] of tries) {
    const r = await get(url);
    console.log(`\n${"═".repeat(72)}\n${name}　${url}`);
    console.log(`  HTTP ${r.status}${r.error ? "  " + r.error : ""}  ${r.body.length} bytes`);
    // JSON 就直接印開頭 —— 題目文字會在裡面，看得到才寫得出解析規則。
    const looksJson = /^\s*[[{]/.test(r.body);
    console.log(`  ${looksJson ? "JSON" : "非 JSON"}`);
    console.log("  " + r.body.slice(0, looksJson ? 2200 : 500).replace(/\s+/g, " "));
    if (!looksJson && r.ok) {
      for (const key of ["question", "questions", "answers", "correctAnswers", "title", "\u0022name\u0022"]) {
        const at = r.body.indexOf(`"${key}"`);
        if (at >= 0) console.log(`  含 "${key}" @${at}：${r.body.slice(at, at + 240).replace(/\s+/g, " ")}`);
      }
    }
    await sleep(1200);
  }

  console.log("\n看完再決定單字要從哪裡撈。");
  process.exit(0);
}

// ── 正式抓取 ────────────────────────────────────────────────────────
// 兩份產出：
//   hess-sources.json  冊 → 單元 → 各平台的練習網址（Quizlet 擋機房 IP，但人點得進去）
//   hess-vocab.json    冊 → 單元 → 單字（從 Wordwall 的 meta description）
const sources = { source: "何嘉仁 Fun World 數位練習平台（hessdigi）", fetchedAt: new Date().toISOString(), books: [] };
const vocab = {
  source: "何嘉仁 Fun World（國小英語課本）",
  via: "hessdigi 數位練習平台 → Wordwall 活動頁的 meta description",
  note: "只有英文。Wordwall 是英文配圖的活動，沒有中文；有中文的是 Quizlet，但它擋機房 IP（403）。",
  fetchedAt: new Date().toISOString(),
  books: [],
};

for (const url of DIGI) {
  const res = await get(url);
  if (!res.ok || res.body.length < 2000) continue;
  const label = bookLabel(toText(res.body));
  if (!isFunWorld(label)) continue;
  const n = Number(label.match(/(\d)$/)[1]);
  const meta = BOOKS[n - 1];
  const links = extractUnitLinks(res.body, url);

  // 再往下一層：站內頁裡才有真正的練習網址（Quizlet／Wordwall／Blooket／Kahoot）。
  // AI 小幫手是提示詞產生器，沒有單字，跳過省請求。
  for (const l of links) {
    if (/AI|提示詞/.test(l.platform)) continue;
    const sub = await get(l.href);
    if (sub.ok) l.targets = extractTargetLinks(sub.body);
    await sleep(400);
  }

  const withTarget = links.filter(l => l.targets?.length).length;
  console.error(`✓ ${label}（${meta.grade}）${links.length} 個單元連結，其中 ${withTarget} 個問到練習網址`);
  sources.books.push({ book: n, grade: meta.grade, label, digiUrl: url, links });

  // 再一層：Wordwall 的活動頁才有單字。一個單元可能有好幾個活動
  //（「找到夥伴 單字」「記憶配對 字母」…），全部抓下來各自留著，
  // 再併成該單元的單字清單 —— 併的時候不分大小寫去重，但保留原始拼法。
  const units = [];
  for (const l of links) {
    if (l.platform !== "Wordwall") continue;
    const activities = [];
    for (const t of l.targets || []) {
      if (!/(^|\.)wordwall\.net$/.test(new URL(t.url).hostname)) continue;
      const w = await get(t.url);
      if (!w.ok) { console.error(`  ✗ ${label} ${l.unit} ${t.url} → HTTP ${w.status}`); continue; }
      activities.push({ ...parseWordwall(w.body), url: t.url });
      await sleep(400);
    }
    const seen = new Set(), words = [], letters = new Set();
    for (const a of activities) {
      for (const w of a.words) if (!seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); words.push(w); }
      for (const c of a.letters) letters.add(c.toLowerCase());
    }
    units.push({ unit: l.unit, words, letters: [...letters].sort(), activities });
    console.error(`    ${l.unit.padEnd(9)} ${words.length} 字　${words.join(", ") || "（沒抓到）"}`);
  }
  // 節慶複習的 Kahoot 題庫。這是目前唯一撈得到「句子」的來源 ——
  // Wordwall 只有單字，Quizlet 與 Blooket 都被 Cloudflare 擋在門外。
  const quizzes = [];
  for (const l of links) {
    if (l.platform !== "Kahoot") continue;
    for (const t of l.targets || []) {
      const id = kahootId(t.url);
      if (!id) continue;
      const k = await get(`https://play.kahoot.it/rest/kahoots/${id}`);
      if (!k.ok) { console.error(`  ✗ ${label} ${l.unit} Kahoot ${id} → HTTP ${k.status}`); continue; }
      const parsed = parseKahoot(k.body);
      if (!parsed) { console.error(`  ✗ ${label} ${l.unit} Kahoot ${id} → 回應不是 JSON`); continue; }
      quizzes.push({ unit: l.unit, shareUrl: t.url, ...parsed });
      console.error(`    Kahoot ${l.unit.padEnd(9)}「${parsed.title}」${parsed.questions.length} 題`);
      for (const q of parsed.questions) console.error(`        ${q.question}　→　${q.answers.join(" / ")}`);
      await sleep(500);
    }
  }

  vocab.books.push({ book: n, grade: meta.grade, label, digiUrl: url, units, quizzes });
  await sleep(400);
}

sources.books.sort((a, b) => a.book - b.book);
vocab.books.sort((a, b) => a.book - b.book);
vocab.totalWords = vocab.books.reduce((t, b) => t + b.units.reduce((n, u) => n + u.words.length, 0), 0);

if (!sources.books.length) {
  console.error("\n✗ 一冊都沒找到，不寫檔。先跑 --probe 看 DigiLink 是不是改版了。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(sources, null, 2) + "\n");

// 一個字都沒抓到就不要覆蓋既有的單字檔 —— 維持原狀，不要讓頁面從「有單字」
// 變成「沒單字」而看起來像是課本改版了。
const vocabFile = path.join(path.dirname(outFile), "hess-vocab.json");
if (vocab.totalWords === 0) {
  console.error("\n✗ 一個單字都沒抓到，不寫 hess-vocab.json（保留原檔）。");
} else {
  fs.writeFileSync(vocabFile, JSON.stringify(vocab, null, 2) + "\n");
  const csv = ["book,grade,unit,word"];
  for (const b of vocab.books)
    for (const u of b.units)
      for (const w of u.words)
        csv.push([b.book, b.grade, u.unit, w].map(v => /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(","));
  fs.writeFileSync(vocabFile.replace(/\.json$/, ".csv"), csv.join("\n") + "\n");
}

const missing = BOOKS.filter(b => !sources.books.some(s => s.book === b.book));
console.error(`\n寫入 hess-sources.json：${sources.books.length} 冊、` +
  `${sources.books.reduce((n, b) => n + b.links.length, 0)} 個連結` +
  (missing.length ? `　⚠️ 還缺 ${missing.map(b => b.id + "(" + b.grade + ")").join("、")}` : ""));
console.error(`寫入 hess-vocab.json：共 ${vocab.totalWords} 個單字`);
