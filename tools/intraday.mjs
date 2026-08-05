#!/usr/bin/env node
/**
 * 日經 225 與韓國 KOSPI 的盤中取樣，寫進 data/intraday.json。
 *
 *   node tools/intraday.mjs                 # 取一次樣，附加到檔案裡
 *   node tools/intraday.mjs --self-test     # 純離線，驗附加／換日／未開盤的邏輯
 *
 * ── 為什麼不用 cron 每 5 分鐘跑一次 ──
 * 這正是 2026-08-04／05 壞掉的那個東西。原本 market-data.yml 在
 * 08:02～08:52 排了每 10 分鐘共 6 班，結果**連兩天一班都沒觸發**。
 * GitHub 的排程本來就不保證執行，而密集的 cron 是最先被丟掉的那一批。
 * 排「每 5 分鐘一班」只會讓同一個病更嚴重，而且症狀一樣是無聲的 ——
 * 你看到的是一條有洞的線，不是一則錯誤。
 *
 * 所以改成：**一班 cron 起一個 job，取樣的迴圈跑在 job 裡面。**
 * 只要那一班有觸發，後面 19 個點就都拿得到；沒觸發就整條線沒有，
 * 一眼看得出來。用「1 次不確定」換掉「19 次各自不確定」。
 *
 * ── 未開盤的判斷 ──
 * 跟 fetch-live.mjs 同一條規則：最新價與前收**完全相等**代表來源
 * 還沒有當天的成交，把前收當最新價回給你。指數是連續變動的，
 * 盤中要剛好等於前收到小數點下兩位幾乎不可能。這種樣本直接丟掉 ——
 * 寫進去會在開盤前畫出一段假的水平線，而水平線看起來就是「有在跑但沒動」。
 *
 * 檔案裡存的是**價格與前收**，不是漲跌幅。價格是來源給的原始事實，
 * 漲跌幅是推導出來的；存原始的，頁面要畫哪一種都可以，
 * 而且日後發現前收抓錯還救得回來。
 */
import fs from "node:fs";
import path from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36";

const flag = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const OUT = flag("o", "data/intraday.json");

/* 一天最多留幾個點。08:00–14:30 每 5 分鐘是 79 個，抓 120 當上限：
   夠放滿一整個盤，又擋得住迴圈失控把檔案撐大。 */
const MAX_POINTS = 120;

const TRACK = [
  { key:"nikkei", name:"日經 225",   cnbc:".N225",  td:"N225",  dp:0 },
  { key:"kospi",  name:"韓國 KOSPI", cnbc:".KS11",  td:"KS11",  dp:2 },
];

/* ── 純函式：這些是 --self-test 在驗的東西 ── */

/** 台北的現在（日期＋時分＋星期）。跟 fetch-live.mjs 同一份寫法 */
export function taipeiNow(d = new Date()){
  const p = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",
    day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})
    .formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hhmm:`${p.hour}:${p.minute}`, h:parseInt(p.hour,10)%24, mi:+p.minute,
           dow:new Date(date+"T12:00:00Z").getUTCDay() };
}

/** 日韓的交易時段（台北時間）：東京 08:00–14:30、首爾 08:00–14:30 */
export function inAsiaSession(t){
  const m = t.h*60 + t.mi;
  return t.dow >= 1 && t.dow <= 5 && m >= 8*60 && m <= 14*60 + 30;
}

/**
 * 把一次取樣併進既有檔案。
 *
 * 換日時**整份重來**，不是往後接。跨日接下去會畫出一條
 * 「昨天收盤直接連到今天開盤」的線，那一段跳空是真的存在，
 * 但畫在同一條連續線上會被讀成盤中走勢。日內圖就該只有今天。
 */
export function mergeSample(prev, sample){
  const fresh = { date: sample.date, updatedTaipei: sample.hhmm, series: {} };
  const base = (prev && prev.date === sample.date && prev.series) ? prev.series : {};

  for(const [key, q] of Object.entries(sample.quotes)){
    const old = base[key];
    const points = old && Array.isArray(old.points) ? old.points.slice() : [];
    // 前收沿用舊的，除非這次真的拿到了 —— 某一次取樣缺前收
    // 不該把整條線的基準抹掉（漲跌幅就會整條消失）
    const prevClose = (q.prevClose !== null && q.prevClose !== undefined)
                    ? q.prevClose : (old ? old.prevClose : null);

    if(q.price !== null && q.price !== undefined){
      // 同一分鐘重跑（手動觸發、重試）就覆蓋，不要疊兩個點
      if(points.length && points[points.length-1][0] === sample.hhmm) points.pop();
      points.push([sample.hhmm, q.price]);
    }
    fresh.series[key] = {
      name: q.name, dp: q.dp, prevClose,
      points: points.slice(-MAX_POINTS),
    };
  }
  // 這一輪沒抓到的標的保留原樣，不要因為一次失敗就把它的線刪掉
  for(const [key, v] of Object.entries(base))
    if(!(key in fresh.series)) fresh.series[key] = v;
  return fresh;
}

/* ── 抓取 ── */

const num = v => {
  const t = String(v ?? "").replace(/[,%\s]/g, "");
  if(t === "" || t === "-" || t === "--") return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
};

async function getText(url){
  const r = await fetch(url, { headers:{ "User-Agent":UA, Accept:"application/json,*/*" },
                               signal: AbortSignal.timeout(20000) });
  const body = await r.text().catch(()=> "");
  if(!r.ok) throw new Error(`HTTP ${r.status}｜${body.slice(0,80).replace(/\s+/g," ")}`);
  return body;
}

async function cnbcQuote(sym){
  const j = JSON.parse(await getText(
    "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
    + `?symbols=${encodeURIComponent(sym)}&requestMethod=itv&noform=1&partnerId=2`
    + "&fund=1&exthrs=0&output=json&events=0"));
  let q = j?.FormattedQuoteResult?.FormattedQuote;
  if(Array.isArray(q)) q = q[0];
  if(!q) throw new Error("回應沒有 FormattedQuote");
  const price = num(q.last), prevClose = num(q.previous_day_closing);
  if(price === null) throw new Error("沒有 last 欄位");
  return { price, prevClose };
}

const TD_KEY = process.env.TWELVEDATA_KEY || "";
async function twelveQuote(sym){
  if(!TD_KEY) throw new Error("沒有 TWELVEDATA_KEY（跳過）");
  const j = JSON.parse(await getText(
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(TD_KEY)}`));
  if(!j || j.status === "error") throw new Error(j?.message || "Twelve Data 回錯誤");
  const price = num(j.close), prevClose = num(j.previous_close);
  if(price === null) throw new Error("沒有 close 欄位");
  return { price, prevClose };
}

async function sample(){
  const t = taipeiNow();
  const quotes = {};
  for(const s of TRACK){
    let q = null, err = null;
    for(const [via, fn, sym] of [["cnbc", cnbcQuote, s.cnbc], ["twelve", twelveQuote, s.td]]){
      try{ q = await fn(sym); q.via = via; break; }
      catch(e){ err = `${via}: ${e.message}`; }
    }
    if(!q){ console.error(`✗ ${s.name}　${err}`); continue; }

    // 最新價＝前收 → 那個市場還沒開，這個樣本沒有資訊，丟掉。
    // 留著會在開盤前畫出一段水平線，看起來像「在跑但沒動」。
    if(q.prevClose !== null && q.price === q.prevClose){
      console.error(`➖ ${s.name}　尚未開盤（最新價＝前收 ${q.price}），不取樣`);
      quotes[s.key] = { name:s.name, dp:s.dp, price:null, prevClose:q.prevClose };
      continue;
    }
    quotes[s.key] = { name:s.name, dp:s.dp, price:q.price, prevClose:q.prevClose };
    const pct = q.prevClose ? ((q.price/q.prevClose - 1) * 100) : null;
    console.error(`✓ ${s.name}　${q.price}　${pct===null?"":(pct>0?"+":"")+pct.toFixed(2)+"%"}　via ${q.via}`);
  }
  return { date:t.date, hhmm:t.hhmm, quotes };
}

/* ── 自測 ── */
function selfTest(){
  let pass = 0, fail = 0;
  const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name))
                                    : (fail++, console.log("  ✗ " + name)); };
  const S = (date, hhmm, price, prevClose = 100) =>
    ({ date, hhmm, quotes:{ nikkei:{ name:"日經 225", dp:0, price, prevClose } } });

  console.log("mergeSample");
  const a = mergeSample(null, S("2026-08-05","08:05",101));
  ok("空檔案 → 建出一個點", a.series.nikkei.points.length === 1);
  ok("帶上日期", a.date === "2026-08-05");

  const b = mergeSample(a, S("2026-08-05","08:10",102));
  ok("同一天 → 附加成兩個點", b.series.nikkei.points.length === 2);
  ok("順序是時間先後", b.series.nikkei.points[1][0] === "08:10");
  ok("updatedTaipei 跟著最新一筆", b.updatedTaipei === "08:10");

  const c = mergeSample(b, S("2026-08-05","08:10",103));
  ok("同一分鐘重跑 → 覆蓋不疊加", c.series.nikkei.points.length === 2);
  ok("覆蓋成新值", c.series.nikkei.points[1][1] === 103);

  const d = mergeSample(c, S("2026-08-06","08:05",99));
  ok("換日 → 整份重來，不是接在昨天後面", d.series.nikkei.points.length === 1);
  ok("換日後日期正確", d.date === "2026-08-06");

  // 未開盤的樣本：price 是 null。它不能新增點，但也不能把已有的線清掉
  const e = mergeSample(b, { date:"2026-08-05", hhmm:"08:15",
                             quotes:{ nikkei:{ name:"日經 225", dp:0, price:null, prevClose:100 } } });
  ok("未開盤（price null）不新增點", e.series.nikkei.points.length === 2);
  ok("未開盤不清掉既有的線", e.series.nikkei.points[0][1] === 101);

  // 某一次取樣沒拿到前收，不該讓整條線失去基準
  const f = mergeSample(b, { date:"2026-08-05", hhmm:"08:20",
                             quotes:{ nikkei:{ name:"日經 225", dp:0, price:104, prevClose:null } } });
  ok("缺前收時沿用舊的前收", f.series.nikkei.prevClose === 100);

  // 這一輪只抓到 KOSPI，日經整個沒回 —— 日經的線要留著
  const g = mergeSample(b, { date:"2026-08-05", hhmm:"08:25",
                             quotes:{ kospi:{ name:"韓國 KOSPI", dp:2, price:50, prevClose:49 } } });
  ok("某一檔這輪失敗 → 保留它原本的線", g.series.nikkei.points.length === 2);
  ok("另一檔照樣寫入", g.series.kospi.points.length === 1);

  // 上限：超過 MAX_POINTS 要從頭砍，留最新的
  let h = null;
  for(let i = 0; i < MAX_POINTS + 10; i++)
    h = mergeSample(h, S("2026-08-05", "08:" + String(i).padStart(2,"0"), 100 + i));
  ok(`點數上限 ${MAX_POINTS}`, h.series.nikkei.points.length === MAX_POINTS);
  ok("砍掉的是最舊的", h.series.nikkei.points[h.series.nikkei.points.length-1][1] === 100 + MAX_POINTS + 9);

  console.log("\ninAsiaSession");
  const T = (h_, mi, dow) => ({h:h_, mi, dow});
  ok("平日 08:05 在盤中",  inAsiaSession(T(8,5,3)) === true);
  ok("平日 07:55 還沒開",  inAsiaSession(T(7,55,3)) === false);
  ok("平日 14:31 已收盤",  inAsiaSession(T(14,31,3)) === false);
  ok("週六 09:00 不算",    inAsiaSession(T(9,0,6)) === false);

  console.log(`\n${fail ? "✗" : "✓"} 通過 ${pass} ／ 失敗 ${fail}`);
  return fail === 0;
}

/* ── 主流程 ── */
if(process.argv.includes("--self-test")){
  process.exit(selfTest() ? 0 : 1);
}

const t = taipeiNow();
if(!inAsiaSession(t)){
  // 迴圈跑在 workflow 裡，收盤後自然會踏出時段。安靜結束，不當成失敗。
  console.error(`日韓非交易時段（台北 ${t.hhmm}），不取樣`);
  process.exit(0);
}

const s = await sample();
if(!Object.keys(s.quotes).length){
  console.error("這一輪一檔都沒抓到，維持原檔不動");
  process.exit(1);
}

let prev = null;
try{ prev = JSON.parse(fs.readFileSync(OUT, "utf8")); }catch{}
const next = mergeSample(prev, s);
fs.mkdirSync(path.dirname(OUT), { recursive:true });
fs.writeFileSync(OUT, JSON.stringify(next, null, 1) + "\n");

const n = Object.values(next.series).map(v => v.points.length);
console.error(`寫入 ${OUT}　${next.date} ${next.updatedTaipei}　各線點數 ${n.join(" / ")}`);
