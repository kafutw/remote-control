#!/usr/bin/env node
/* USD/TWD 的「前一日」錨點。
 *
 * 為什麼要這一支：er-api 只回一個當下匯率，沒有前收，所以頁面上那一列的
 * 漲跌永遠是「—」。要算日變動就得自己記住昨天是多少。
 *
 * 錨點刻意放在獨立的 data/fx-usdtwd.csv，不放進 live.json：
 * fetch-live.mjs 每次重建整份 live.json，而且不管抓成幾檔都會把檔案寫出去，
 * 失敗的標的變成 {name,group,error}。整批失敗時 exit 1 會讓 workflow 跳過
 * commit，壞檔進不了 repo；但**只有匯率單獨失敗**時 ok>0、job 成功、
 * commit 一份 usdtwd 只剩 error 的檔案 —— 錨點寄生在裡面就跟著沒了。
 *
 * 最重要的一條規則：錨點由「資料供應商的匯率日期」決定，不是由我們跑了
 * 幾次決定。workflow 一天跑 9 次，用「上一次執行的價格」當前收會得到一個
 * 10 分鐘前的錨點和一個永遠 ≈0% 的變動。
 */
import fs from "node:fs";
import path from "node:path";

/* ── 純函式：沒有 top-level side effect，所以可以直接 import 來測 ── */

export function taipeiDate(ms){
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",dateStyle:"short"})
           .format(new Date(ms));
}

/* er-api 每日 UTC 00:00（＝台北 08:00）更新一次，回應裡帶著自己的時戳。
   拿不到就退回執行時鐘 —— 但要把「怎麼知道的」記下來，
   絕不能把執行時鐘的日期標成供應商的公告日期。 */
export function rateDateFrom(unixSec, nowMs){
  if(unixSec && isFinite(unixSec)) return {date: taipeiDate(unixSec*1000), via:"provider"};
  return {date: taipeiDate(nowMs), via:"runClock"};
}

export function parseHistory(text){
  return String(text||"").split(/\r?\n/).slice(1)          // 掉表頭
    .map(function(l){ return l.trim(); }).filter(Boolean)
    .map(function(l){
      var c = l.split(",");
      return {date:c[0], rate:Number(c[1])};
    })
    .filter(function(r){ return /^\d{4}-\d{2}-\d{2}$/.test(r.date) && isFinite(r.rate); })
    .sort(function(a,b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

export function readHistory(file){
  try{ return parseHistory(fs.readFileSync(file,"utf8")); }
  catch(e){ return []; }        // 檔案還不存在＝第一次跑，不是錯誤
}

/* 歷史裡日期**嚴格早於** key 的最後一筆。
   這個 < 不能寫成 <=，是整支的安全繩：workflow 一天跑 9 次，
   寫成 <= 的話同一天第 2 次執行就會把自己當成前一日，
   change 變成 0 而且完全沒有症狀。自測第 2 條就是在守這一條。 */
export function prevEntry(hist, key){
  var out = null;
  for(var i=0;i<hist.length;i++) if(hist[i].date < key) out = hist[i];
  return out;
}

export function daysBetween(a, b){
  return Math.round((Date.parse(b+"T00:00:00Z") - Date.parse(a+"T00:00:00Z")) / 86400000);
}

export function isWeekend(iso){
  var d = new Date(iso+"T00:00:00Z").getUTCDay();
  return d === 0 || d === 6;
}

/* 只覆蓋同一天，不允許插進比現有最新還舊的日期
   （供應商時戳倒退時不能把歷史寫壞）。 */
export function mergeHistory(hist, key, rate){
  var out = hist.slice();
  for(var i=0;i<out.length;i++){
    if(out[i].date === key){ out[i] = {date:key, rate:rate}; return out; }
  }
  if(out.length && key < out[out.length-1].date) return out;   // 倒退，不寫
  out.push({date:key, rate:rate});
  out.sort(function(a,b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

/* 這支的核心。
   先取 prevDay 再合併，讀起來比較直觀，但**正確性不靠這個順序** ——
   靠的是 prevEntry 的嚴格 <。就算有人日後把兩行對調，答案仍然一樣
   （自測第 7 條驗的就是這個順序無關性，不是順序本身）。 */
export function deriveFx(hist, price, unixSec, nowMs){
  var k = rateDateFrom(unixSec, nowMs);
  var prev = prevEntry(hist, k.date);          // ← 一定要在 mergeHistory 之前
  return {
    asOf: k.date,
    asOfVia: k.via,
    prevClose: prev ? prev.rate : null,
    prevDay: prev ? prev.date : null,
    prevGapDays: prev ? daysBetween(prev.date, k.date) : null,
    nextHistory: mergeHistory(hist, k.date, price),
    // 週末照樣推算，但不寫入：手動在週日跑一次會插進「週日＝週五的凍結匯率」，
    // 害週一算成 ≈0%，把週末的跳空藏起來。
    shouldWrite: !isWeekend(k.date)
  };
}

const MAX_ROWS = 400;

export function serializeHistory(hist){
  return "date,rate\n"
    + hist.slice(-MAX_ROWS).map(function(r){ return r.date + "," + r.rate; }).join("\n") + "\n";
}

export function writeHistory(file, hist){
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, serializeHistory(hist));
}

/* ── 自測：純離線，不碰網路也不碰 data/ ── */

function selfTest(){
  var fails = [];
  function ok(name, cond, got){
    if(cond) console.error("  ✓ " + name);
    else { console.error("  ✗ " + name + "　得到：" + JSON.stringify(got)); fails.push(name); }
  }
  var D = function(s){ return Date.parse(s+"T00:00:00+08:00"); };

  console.error("fx-daily 自測");

  // 1　空歷史：不准無中生有
  var r1 = deriveFx([], 32.28872, D("2026-08-03")/1000, D("2026-08-03"));
  ok("空歷史 → prevClose 為 null", r1.prevClose === null && r1.prevGapDays === null, r1);

  // 2　同一供應商日期第二次跑：錨點不動
  var h2 = [{date:"2026-08-03",rate:32.30},{date:"2026-08-04",rate:32.28}];
  var r2 = deriveFx(h2, 32.27, D("2026-08-04")/1000, D("2026-08-04"));
  ok("同一天再跑 → 仍對前一天，不是對自己",
     r2.prevDay === "2026-08-03" && r2.prevClose === 32.30, r2);

  // 3　日期 +1
  var r3 = deriveFx(h2, 32.10, D("2026-08-05")/1000, D("2026-08-05"));
  ok("換日 → 對昨天", r3.prevDay === "2026-08-04" && r3.prevClose === 32.28, r3);

  // 4　週五 → 週一
  var h4 = [{date:"2026-08-07",rate:32.50}];                // 2026-08-07 是週五
  var r4 = deriveFx(h4, 32.20, D("2026-08-10")/1000, D("2026-08-10"));
  ok("週五→週一 → prevGapDays 是 3",
     r4.prevDay === "2026-08-07" && r4.prevGapDays === 3, r4);

  // 5　沒有供應商時戳 → 退回執行時鐘，並且要標出來
  var r5 = deriveFx(h2, 32.20, null, D("2026-08-05"));
  ok("沒有時戳 → asOfVia 是 runClock",
     r5.asOfVia === "runClock" && r5.asOf === "2026-08-05", r5);
  ok("有時戳 → asOfVia 是 provider", r3.asOfVia === "provider", r3);

  // 6　時戳倒退：不准寫壞歷史
  var r6 = deriveFx(h2, 99.99, D("2026-08-01")/1000, D("2026-08-05"));
  var last6 = r6.nextHistory[r6.nextHistory.length-1];
  ok("時戳倒退 → 不插進舊日期",
     r6.nextHistory.length === 2 && last6.date === "2026-08-04", r6.nextHistory);

  // 7　順序無關性：把「今天」先塞進歷史再算，答案必須一樣。
  //    真正的守門員是 prevEntry 的嚴格 <（第 2 條在守），
  //    這一條確認的是先合併也不會出錯，日後有人對調那兩行不會壞掉。
  var base7 = [{date:"2026-08-04",rate:32.28}];
  var r7  = deriveFx(base7, 32.10, D("2026-08-05")/1000, D("2026-08-05"));
  var r7b = deriveFx(mergeHistory(base7,"2026-08-05",32.10), 32.10,
                     D("2026-08-05")/1000, D("2026-08-05"));
  ok("先合併或後合併，prevDay 一樣",
     r7.prevDay === "2026-08-04" && r7b.prevDay === "2026-08-04",
     {a:r7.prevDay, b:r7b.prevDay});
  ok("prevDay 一定嚴格早於 asOf", r7.prevDay < r7.asOf, r7);
  ok("合併後歷史含今天", r7.nextHistory.some(function(x){ return x.date==="2026-08-05"; }),
     r7.nextHistory);

  // 8　週六日：照樣推算，但不寫
  var r8 = deriveFx(h2, 32.20, D("2026-08-08")/1000, D("2026-08-08"));   // 週六
  ok("週六 → shouldWrite 為 false", r8.shouldWrite === false, r8);
  ok("平日 → shouldWrite 為 true", r3.shouldWrite === true, r3);

  // 9　CSV 來回
  ok("parse(serialize(x)) 等於 x",
     JSON.stringify(parseHistory(serializeHistory(h2))) === JSON.stringify(h2),
     parseHistory(serializeHistory(h2)));

  console.error(fails.length ? "\n✗ " + fails.length + " 項失敗" : "\n全部通過");
  return fails.length;
}

if(process.argv.includes("--self-test")) process.exit(selfTest() ? 1 : 0);
