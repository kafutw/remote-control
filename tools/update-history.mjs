#!/usr/bin/env node
/**
 * 把 data/daily-*.csv 的歷史日線補到最新。
 *
 *   node tools/update-history.mjs                # 補 2330 / 0050 / 0056
 *   node tools/update-history.mjs 2330 --months 6
 *
 * 為什麼要特別小心：這些 CSV 是整個「跌破季線的歷史統計」的唯一根據，
 * 網頁上的次數、乖離率、站回天數、60 日報酬全部從它算出來。
 * 一旦寫進錯的收盤價，錯誤會安靜地變成投資判斷的依據 ——
 * 比檔案沒更新嚴重得多。所以這支腳本的預設立場是「寧可不寫」：
 *
 *   1. 只合併、不取代。既有的每一列都保留，新資料只填日期上的缺口。
 *   2. 有重疊就對帳。抓回來的日期若已存在於 CSV，兩邊的收盤價必須吻合；
 *      對不上就整檔放棄寫入並回報，不會寫一半。
 *   3. 分割自動還原，並且要求還原後重疊區能對上（第 2 點）才算數。
 *   4. 任何一步失敗都不動原檔，並以非 0 結束，讓 workflow log 看得見。
 *
 * ⚠️ www.twse.com.tw 跟已驗證可用的 openapi.twse.com.tw 是不同主機，
 *    從 GitHub Actions runner 通不通要看第一次執行的 log。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const codes = argv.filter(a => /^\d{4,6}$/.test(a));
const SYMBOLS = codes.length ? codes : ["2330", "0050", "0056"];
const MONTHS = Number(flag("months", 4));      // 往回抓幾個月，蓋掉可能的缺口
const DELAY = Number(flag("delay", 4000));     // 證交所對連續請求很敏感
const DRY = argv.includes("--dry-run");
/* --rebuild：整段重抓，用證交所的價格取代既有檔案。
   平常不該用 —— 預設的合併模式安全得多。
   要用的時機是「既有資料本身就是錯的」：2026-08-01 對帳發現 2330 的
   tw_stocker 資料在 56 個重疊日期裡有 13 天跟證交所對不上（差 0.5%～0.9%，
   有高有低，像是把當天盤中某根 K 棒當成收盤）。那種情況下補缺口沒有用，
   錯的那幾天會一直留著，而整份「跌破季線」統計就是建立在這些收盤價上。
   重抓有嚴格門檻：任何一個月失敗就整檔放棄，否則會用一份有洞的資料
   取代一份完整的資料。 */
const REBUILD = argv.includes("--rebuild");
const FROM = flag("from", null);               // --rebuild 用，預設沿用既有檔案的起始日

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, "0");

/** 民國年 115/07/28 → 2026-07-28 */
function toISO(roc) {
  const m = String(roc).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return `${+m[1] + 1911}-${pad(+m[2])}-${pad(+m[3])}`;
}

/** 失敗時把回應開頭帶回來 —— 只看 HTTP 狀態碼會漏掉「200 但回的是 HTML 錯誤頁」 */
async function getJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${body.slice(0, 80)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`回應不是 JSON（可能被擋或改版）：${body.slice(0, 80)}`);
  }
}

function readCSV(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).slice(1)
    .map(l => l.split(","))
    .filter(c => c.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(c[0].trim()))
    .map(c => ({ date: c[0].trim(), close: Number(c[1]) }))
    .filter(r => isFinite(r.close) && r.close > 0);
}

/** 抓回來的月度資料裡，單日出現分割倍數的跳空就還原到跟既有 CSV 同一個基準 */
const SPLIT_RATIOS = [2, 3, 4, 5, 10, 20];
function detectSplit(prev, next) {
  const ratio = prev / next, inv = 1 / ratio;
  for (const r of SPLIT_RATIOS) {
    if (Math.abs(ratio - r) / r < 0.08) return r;
    if (Math.abs(inv - r) / r < 0.08) return 1 / r;
  }
  return null;
}

let exitCode = 0;
const summary = [];

for (const stock of SYMBOLS) {
  const file = `data/daily-${stock}.csv`;
  const existing = readCSV(file);
  if (!existing.length) {
    console.error(`✗ ${stock}：${file} 讀不到既有資料，跳過（這支腳本只補缺口，不建新檔）`);
    exitCode = 1;
    continue;
  }
  const lastHave = existing[existing.length - 1].date;
  console.log(`\n── ${stock} ── 既有 ${existing.length} 列，最後一天 ${lastHave}`);

  // 合併模式：從最後一天往回退 MONTHS 個月，重疊的部分正好拿來對帳
  // 重抓模式：從既有資料的第一天開始，整段重來
  const start = REBUILD
    ? new Date((FROM || existing[0].date) + "T00:00:00Z")
    : new Date(lastHave + "T00:00:00Z");
  if (!REBUILD) start.setUTCMonth(start.getUTCMonth() - (MONTHS - 1));
  const now = new Date();
  const months = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
       d <= now;
       d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}01`);
  }

  const fetched = [];
  let failed = 0;
  for (const [i, date] of months.entries()) {
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY`
              + `?date=${date}&stockNo=${stock}&response=json`;
    try {
      const j = await getJSON(url);
      if (j.stat !== "OK") { process.stderr.write(`  ${date} 無資料(${j.stat})\n`); }
      else {
        let n = 0;
        for (const r of j.data || []) {
          const iso = toISO(r[0]);
          const close = Number(String(r[6]).replace(/,/g, ""));   // 欄位 6 = 收盤價
          if (iso && isFinite(close) && close > 0) { fetched.push({ date: iso, close }); n++; }
        }
        console.log(`  ${date} ✓ ${n} 列`);
      }
    } catch (e) {
      failed++;
      console.error(`  ${date} ✗ ${e.message}`);
    }
    if (i < months.length - 1) await sleep(DELAY);
  }

  if (!fetched.length) {
    console.error(`✗ ${stock}：一列都沒抓到（${failed}/${months.length} 個月失敗），原檔不動`);
    exitCode = 1;
    summary.push({ stock, status: "抓不到", last: lastHave });
    continue;
  }

  fetched.sort((a, b) => (a.date < b.date ? -1 : 1));

  // 還原分割：以既有 CSV 的基準為準，把抓回來這段裡的跳空補回去
  const adj = [];
  for (let i = 0; i < fetched.length; i++) {
    const s = i > 0 ? detectSplit(fetched[i - 1].close, fetched[i].close) : null;
    if (s) {
      console.log(`  ⚠️ ${fetched[i].date} 疑似分割 1:${s >= 1 ? s : "1/" + (1 / s).toFixed(0)}，`
                + `把該日之前的價格除以 ${s}`);
      for (const r of adj) r.close /= s;
    }
    adj.push({ ...fetched[i] });
  }

  const have = new Map(existing.map(r => [r.date, r.close]));

  if (REBUILD) {
    // 有任何一個月失敗就放棄：抓到一半的資料會在中間留一個看不見的洞，
    // 而均線是滾動計算的，一個洞會污染它之後 60 天的每一個值。
    if (failed) {
      console.error(`✗ ${stock}：重抓時有 ${failed}/${months.length} 個月失敗，`
                  + `不能拿有缺口的資料取代完整的檔案，原檔不動`);
      exitCode = 1;
      summary.push({ stock, status: `重抓失敗 ${failed} 個月`, last: lastHave });
      continue;
    }
    const covered = existing.filter(r => r.date >= adj[0].date && r.date <= adj[adj.length - 1].date);
    if (adj.length < covered.length * 0.98) {
      console.error(`✗ ${stock}：重抓只拿到 ${adj.length} 列，既有同區間有 ${covered.length} 列，`
                  + `少太多，原檔不動`);
      exitCode = 1;
      summary.push({ stock, status: "重抓列數過少", last: lastHave });
      continue;
    }
    // 改了哪些天要講出來 —— 重抓是會改動既有數字的操作，不能無聲無息
    const changed = adj.filter(r => have.has(r.date) && Math.abs(r.close - have.get(r.date)) / have.get(r.date) > 0.005);
    console.log(`  重抓 ${adj.length} 列（${adj[0].date} ～ ${adj[adj.length-1].date}）`);
    console.log(`  其中 ${changed.length} 天的收盤價與既有檔案不同，一律以證交所為準`);
    changed.slice(0, 10).forEach(r =>
      console.log(`     ${r.date}  ${have.get(r.date)} → ${r.close.toFixed(2)}`));
    if (changed.length > 10) console.log(`     …還有 ${changed.length - 10} 天`);
    if (DRY) { console.log("  --dry-run，不寫檔"); }
    else {
      writeFileSync(file, "日期,收盤價\n"
        + adj.map(r => `${r.date},${r.close}`).join("\n") + "\n");
    }
    summary.push({ stock, status: DRY ? "重抓試跑" : `已重抓（改 ${changed.length} 天）`,
                   last: adj[adj.length - 1].date, added: adj.length - existing.length });
    continue;
  }

  // 合併模式的對帳：重疊日期兩邊必須吻合。對不上就代表基準不同或資料有問題，整檔放棄。
  let checked = 0;
  const mismatch = [];
  for (const r of adj) {
    if (!have.has(r.date)) continue;
    checked++;
    const a = have.get(r.date), rel = Math.abs(r.close - a) / a;
    if (rel > 0.005) mismatch.push(`${r.date} 既有 ${a} vs 抓到 ${r.close.toFixed(2)}`);
  }
  if (checked === 0) {
    console.error(`✗ ${stock}：抓回來的資料跟既有 CSV 完全沒有重疊，無法對帳，原檔不動`);
    exitCode = 1;
    summary.push({ stock, status: "無重疊可對帳", last: lastHave });
    continue;
  }
  if (mismatch.length) {
    console.error(`✗ ${stock}：${checked} 個重疊日期中有 ${mismatch.length} 天對不上，原檔不動`);
    mismatch.slice(0, 5).forEach(m => console.error(`     ${m}`));
    exitCode = 1;
    summary.push({ stock, status: `對帳失敗 ${mismatch.length}/${checked}`, last: lastHave });
    continue;
  }
  console.log(`  對帳 ✓ ${checked} 個重疊日期全部吻合`);

  // 合併：既有的一律保留，只填缺口
  const added = adj.filter(r => !have.has(r.date));
  if (!added.length) {
    console.log(`  已經是最新的，沒有新資料（仍到 ${lastHave}）`);
    summary.push({ stock, status: "已最新", last: lastHave, added: 0 });
    continue;
  }
  const merged = existing.concat(added).sort((a, b) => (a.date < b.date ? -1 : 1));
  const newLast = merged[merged.length - 1].date;
  console.log(`  ＋${added.length} 列，${lastHave} → ${newLast}`);

  if (DRY) { console.log("  --dry-run，不寫檔"); }
  else {
    writeFileSync(file, "日期,收盤價\n"
      + merged.map(r => `${r.date},${r.close}`).join("\n") + "\n");
  }
  summary.push({ stock, status: DRY ? "試跑" : "已更新", last: newLast, added: added.length });
}

console.log("\n═══ 結果 ═══");
for (const s of summary) {
  console.log(`  ${s.stock}  ${s.status.padEnd(14)} 最後一天 ${s.last}`
            + (s.added ? `  ＋${s.added} 列` : ""));
}
if (exitCode) console.log("\n有標的沒有更新成功 —— 這些檔案維持原狀，沒有被寫入可疑的資料。");
process.exit(exitCode);
