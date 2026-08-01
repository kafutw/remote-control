#!/usr/bin/env node
/**
 * 抓即時行情，算好均線，寫成 data/live.json。
 *
 *   node tools/fetch-live.mjs [-o data/live.json]
 *
 * 在 GitHub Actions 的 runner 上跑（見 .github/workflows/market-data.yml）。
 * 受限的執行環境連不到任何行情站，但連得到 raw.githubusercontent.com，
 * 所以由 Actions 抓、推回 repo，晨報排程再讀回去。
 *
 * ── 為什麼是多來源 ──
 * 第一版只用 Yahoo，實際跑起來 12 檔全部 HTTP 429 —— Yahoo 會擋資料中心 IP，
 * 而 Actions 的 runner 正是資料中心 IP。所以改成每個標的準備多組來源，
 * 依序嘗試直到成功，並把「這個數字是誰給的」記在 via 欄位裡。
 *
 * 來源優先序：
 *   台股   證交所 OpenAPI（官方）→ Stooq → Yahoo
 *   其他   Stooq → Yahoo
 * Stooq 提供免金鑰的 CSV，對機房 IP 相對寬容；證交所是台股的權威但只有收盤。
 *
 * 每個標的獨立處理，一個掛掉不影響其他，失敗的會留下 error 欄位讓讀取端知道。
 */

import fs from "node:fs";
import path from "node:path";

const outIdx = process.argv.indexOf("-o");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : "data/live.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sma = (a, n) => a.length < n ? null : a.slice(-n).reduce((x, y) => x + y, 0) / n;
const num = v => { const n = Number(String(v).replace(/,/g, "").trim()); return isFinite(n) ? n : null; };

/* 每個標的的候選來源，依序嘗試。symbol 寫法各站不同，所以連代號一起帶。 */
const SYMBOLS = [
  { key:"twii",  name:"加權指數",   dp:2, ma:true,
    srcs:[["twseIndex",""],["stooq","^twse"],["stooq","^tai"],["yahoo","^TWII"]] },
  { key:"tsmc",  name:"台積電",     dp:2, ma:true,
    srcs:[["twseStock","2330"],["stooq","2330.tw"],["yahoo","2330.TW"]] },
  { key:"e0050", name:"元大台灣50", dp:2, ma:true,
    srcs:[["twseStock","0050"],["stooq","0050.tw"],["yahoo","0050.TW"]] },
  { key:"e0056", name:"元大高股息", dp:2, ma:true,
    srcs:[["twseStock","0056"],["stooq","0056.tw"],["yahoo","0056.TW"]] },
  { key:"adr",   name:"台積電 ADR", dp:2, ma:false,
    srcs:[["cnbc","TSM"],["twelve","TSM"],["stooq","tsm.us"],["yahoo","TSM"]] },
  { key:"sox",   name:"費城半導體", dp:2, ma:false,
    srcs:[["cnbc",".SOX"],["twelve","SOX"],["stooq","^sox"],["yahoo","^SOX"]] },
  { key:"ixic",  name:"納斯達克",   dp:2, ma:false,
    srcs:[["cnbc",".IXIC"],["twelve","IXIC"],["stooq","^ndq"],["yahoo","^IXIC"]] },
  { key:"gspc",  name:"標普 500",   dp:2, ma:false,
    srcs:[["cnbc",".SPX"],["twelve","SPX"],["stooq","^spx"],["yahoo","^GSPC"]] },
  { key:"dji",   name:"道瓊工業",   dp:2, ma:false,
    srcs:[["cnbc",".DJI"],["twelve","DJI"],["stooq","^dji"],["yahoo","^DJI"]] },
  { key:"n225",  name:"日經 225",   dp:2, ma:false,
    srcs:[["cnbc",".N225"],["twelve","N225"],["stooq","^nkx"],["yahoo","^N225"]] },
  { key:"kospi", name:"韓國 KOSPI", dp:2, ma:false,
    srcs:[["cnbc",".KS11"],["twelve","KS11"],["stooq","^kospi"],["yahoo","^KS11"]] },
  { key:"usdtwd",name:"USD／TWD",   dp:3, ma:false,
    srcs:[["erapi","TWD"],["stooq","usdtwd"],["yahoo","TWD=X"]] }
];

/* ── 證交所 OpenAPI：官方、免金鑰、只有收盤 ── */

/** 證交所同一組端點裡民國年與西元年都出現過（"1150731" 與 "20260731"），
 *  只認其中一種就會靜靜地拿不到日期。位數本身就分得出是哪一種：
 *  西元 8 碼、民國 7 碼（民國 100 年以後）或 6 碼。回傳 YYYY-MM-DD 或 null。 */
function parseTwseDate(src){
  const d = String(src ?? "").replace(/\D/g, "");
  let y, md;
  if(d.length === 8)      { y = +d.slice(0,4);           md = d.slice(4); }
  else if(d.length === 7) { y = +d.slice(0,3) + 1911;    md = d.slice(3); }
  else if(d.length === 6) { y = +d.slice(0,2) + 1911;    md = d.slice(2); }
  else return null;
  const mo = +md.slice(0,2), da = +md.slice(2,4);
  if(!(y >= 1990 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) return null;
  return `${y}-${String(mo).padStart(2,"0")}-${String(da).padStart(2,"0")}`;
}

let twseStocks = null, twseIndexRow = null, twseDate = null;
async function loadTwse(){
  if(twseStocks !== null) return;
  twseStocks = new Map();
  try{
    const r = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
                          {headers:{"User-Agent":UA, Accept:"application/json"}});
    if(r.ok){
      const j = await r.json();
      for(const row of (Array.isArray(j)?j:[])) twseStocks.set(String(row.Code ?? row.code).trim(), row);
      console.error(`證交所個股：${twseStocks.size} 檔`);
    } else console.error("證交所個股 HTTP " + r.status);
  }catch(e){ console.error("證交所個股失敗：" + e.message); }
  try{
    const r = await fetch("https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST",
                          {headers:{"User-Agent":UA, Accept:"application/json"}});
    if(r.ok){
      const j = await r.json();
      twseIndexRow = Array.isArray(j) && j.length ? j[j.length-1] : null;
    } else {
      console.error("證交所指數 HTTP " + r.status);
    }
    // 證交所是盤後結算才更新，抓取時間 ≠ 資料日期。把資料日期記下來，
    // 讀取端才知道這是哪一天的收盤，不會拿它蓋掉更新的數字。
    if(twseIndexRow){
      const rawSrc = String(twseIndexRow.Date ?? twseIndexRow.date ?? "");
      twseDate = parseTwseDate(rawSrc);
      // 判讀失敗時把原始字串印出來 —— 只印「無法判讀」的話，
      // 端點改格式就查不出改成什麼。asOf 是頁面判斷「這是哪一天的收盤」
      // 唯一的依據，它是 null 的時候整套防呆會退回最保守的行為。
      console.error("證交所資料日期：" + (twseDate || `（無法判讀，原始值 "${rawSrc}"）`));
    }
  }catch(e){ console.error("證交所指數失敗：" + e.message); }
}
/** 從一列裡挑出第一個 key 含指定字樣的數字，欄位改名也不會整支壞掉 */
function pick(row, ...needles){
  for(const n of needles)
    for(const [k,v] of Object.entries(row||{}))
      if(k.toLowerCase().includes(n.toLowerCase())){ const x = num(v); if(x !== null && x > 0) return x; }
  return null;
}

/* ── Stooq：免金鑰 CSV。l=最新報價，d/l=日線歷史（拿來算均線） ── */
const STOOQ_HOSTS = ["https://stooq.com", "https://stooq.pl"];
/** 失敗時把實際回應的前幾十個字帶進錯誤訊息 —— 光看狀態碼查不出網址哪裡錯 */
async function getText(url){
  const r = await fetch(url, {headers:{"User-Agent":UA, Accept:"text/csv,text/plain,*/*"}});
  const body = await r.text().catch(()=> "");
  if(!r.ok) throw new Error(`HTTP ${r.status}｜回應開頭「${body.slice(0,80).replace(/\s+/g," ")}」`);
  return body;
}
async function stooqQuote(sym){
  let last;
  for(const host of STOOQ_HOSTS){
    try{ return parseStooqQuote(await getText(`${host}/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`)); }
    catch(e){ last = e; }
  }
  throw last;
}
function parseStooqQuote(text){
  const lines = text.trim().split(/\r?\n/);
  if(lines.length < 2) throw new Error("回應沒有資料列｜" + text.slice(0,80));
  const head = lines[0].split(",").map(s=>s.trim().toLowerCase());
  const row  = lines[1].split(",").map(s=>s.trim());
  const get  = n => { const i = head.indexOf(n); return i<0 ? null : row[i]; };
  const close = num(get("close")), open = num(get("open"));
  if(close === null || String(get("close")).toUpperCase() === "N/D") throw new Error("Stooq 回 N/D（可能無此代號）");
  return { price: close, prevClose: null, open };
}
async function stooqDaily(sym){
  let text, last;
  for(const host of STOOQ_HOSTS){
    try{ text = await getText(`${host}/q/d/l/?s=${encodeURIComponent(sym)}&i=d`); break; }
    catch(e){ last = e; }
  }
  if(text === undefined) throw last;
  const lines = text.trim().split(/\r?\n/);
  if(lines.length < 3) throw new Error("歷史資料太短");
  const head = lines[0].split(",").map(s=>s.trim().toLowerCase());
  const ci = head.indexOf("close");
  if(ci < 0) throw new Error("找不到 Close 欄");
  return lines.slice(1).map(l=>num(l.split(",")[ci])).filter(v=>v!==null && v>0);
}

/* ── CNBC 公開報價端點：免金鑰。指數用 .SPX 這種點號寫法 ── */
async function cnbcQuote(sym){
  const url = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
            + `?symbols=${encodeURIComponent(sym)}&requestMethod=itv&noform=1&partnerId=2`
            + "&fund=1&exthrs=0&output=json&events=0";
  const j = JSON.parse(await getText(url));
  let q = j?.FormattedQuoteResult?.FormattedQuote;
  if(Array.isArray(q)) q = q[0];
  if(!q) throw new Error("回應沒有 FormattedQuote");
  const price = num(q.last), prev = num(q.previous_day_closing);
  if(price === null) throw new Error("沒有 last 欄位");
  return { price, prevClose: prev, marketState: q.curmktstatus || null };
}

/* ── Twelve Data：需免費金鑰，放在 repo secret TWELVEDATA_KEY。專為 API 用途設計，不擋機房 IP ── */
const TD_KEY = process.env.TWELVEDATA_KEY || "";
async function twelveQuote(sym){
  if(!TD_KEY) throw new Error("沒有設定 TWELVEDATA_KEY（跳過）");
  const j = JSON.parse(await getText(
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(TD_KEY)}`));
  if(!j || j.status === "error") throw new Error(j?.message || "Twelve Data 回錯誤");
  const price = num(j.close), prev = num(j.previous_close);
  if(price === null) throw new Error("沒有 close 欄位");
  return { price, prevClose: prev, marketState: j.is_market_open ? "REGULAR" : "CLOSED" };
}

/* ── Yahoo：留著當最後手段。從機房 IP 常被 429 擋。 ── */
async function yahooChart(sym, withMa){
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`
                        + `?range=${withMa?"1y":"5d"}&interval=1d`,
                        {headers:{"User-Agent":UA, Accept:"application/json"}});
  if(!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if(!res) throw new Error(j?.chart?.error?.description || "回應沒有 result");
  const m = res.meta || {};
  const closes = (res.indicators?.quote?.[0]?.close || []).filter(v=>typeof v==="number"&&isFinite(v));
  const price = m.regularMarketPrice ?? closes[closes.length-1];
  if(price == null) throw new Error("沒有取到價格");
  return { price, prevClose: m.chartPreviousClose ?? m.previousClose ?? closes[closes.length-2] ?? null,
           closes, marketState: m.marketState || null };
}

/* ── 逐一嘗試各來源 ── */
async function resolve(s){
  const tried = [];
  for(const [src, sym] of s.srcs){
    try{
      let out = null;
      if(src === "twseStock"){
        await loadTwse();
        const row = twseStocks.get(sym);
        if(!row) throw new Error("證交所查無此代號");
        const close = pick(row,"ClosingPrice","Closing","Close");
        const chg   = pick(row,"Change");
        if(close === null) throw new Error("沒有收盤價欄位");
        out = { price: close, prevClose: chg !== null ? close - chg : null, marketState:"CLOSED", asOf: twseDate };
      } else if(src === "twseIndex"){
        await loadTwse();
        if(!twseIndexRow) throw new Error("證交所指數沒有資料");
        const close = pick(twseIndexRow,"ClosingIndex","Closing","Close");
        if(close === null) throw new Error("沒有收盤指數欄位");
        out = { price: close, prevClose: null, marketState:"CLOSED", asOf: twseDate };
      } else if(src === "stooq"){
        const q = await stooqQuote(sym);
        out = { price: q.price, prevClose: null, marketState:null };
        if(s.ma || out.prevClose === null){
          try{
            const closes = await stooqDaily(sym);
            out.closes = closes;
            if(closes.length > 1) out.prevClose = closes[closes.length-2];
          }catch(e){ /* 歷史拿不到就只用報價，均線會是 null */ }
        }
      } else if(src === "cnbc"){
        out = await cnbcQuote(sym);
      } else if(src === "twelve"){
        out = await twelveQuote(sym);
      } else if(src === "erapi"){
        // open.er-api.com：免金鑰的匯率來源，每日更新
        const j = JSON.parse(await getText("https://open.er-api.com/v6/latest/USD"));
        const rate = j && j.rates && j.rates[sym];
        if(!rate) throw new Error("回應裡沒有 " + sym);
        out = { price: rate, prevClose: null, marketState: null };
      } else {
        out = await yahooChart(sym, s.ma);
      }
      out.via = `${src}:${sym || "-"}`;
      out.tried = tried;
      return out;
    }catch(e){
      tried.push(`${src}:${sym||"-"} → ${e.message}`);
      await sleep(600);
    }
  }
  throw new Error("全部來源都失敗｜" + tried.join(" ｜ "));
}

/* ── 主流程 ── */
const data = {};
let ok = 0, bad = 0;
for(const s of SYMBOLS){
  try{
    const r = await resolve(s);
    // 證交所只給收盤、沒有歷史，所以均線另外去 Stooq 拿日線來算：
    // 價格用官方的，均線用歷史的 —— 兩者職責分開。
    if(s.ma && (!r.closes || !r.closes.length)){
      const alt = s.srcs.find(x => x[0] === "stooq");
      if(alt){
        try{ r.closes = await stooqDaily(alt[1]); r.maVia = `stooq:${alt[1]}`; }
        catch(e){ console.error(`  （${s.name} 均線歷史拿不到：${e.message}）`); }
      }
    }
    const price = r.price, prev = r.prevClose;
    const o = {
      name:s.name, group:s.key, dp:s.dp, via:r.via, price,
      prevClose: prev,
      change: prev !== null ? +(price - prev).toFixed(6) : null,
      pct: prev ? +(((price/prev)-1)*100).toFixed(4) : null,
      marketState: r.marketState || null,
      asOf: r.asOf || null,
      triedBefore: (r.tried && r.tried.length) ? r.tried : undefined
    };
    if(s.ma && r.closes && r.closes.length){
      const c = r.closes;
      const m20=sma(c,20), m60=sma(c,60), m240=sma(c,240);
      o.ma20  = m20  !== null ? +m20.toFixed(2)  : null;
      o.ma60  = m60  !== null ? +m60.toFixed(2)  : null;
      o.ma240 = m240 !== null ? +m240.toFixed(2) : null;
      o.bias20  = m20  ? +(((price/m20) -1)*100).toFixed(2) : null;
      o.bias60  = m60  ? +(((price/m60) -1)*100).toFixed(2) : null;
      o.bias240 = m240 ? +(((price/m240)-1)*100).toFixed(2) : null;
      o.bars = c.length;
      if(r.maVia) o.maVia = r.maVia;
    }
    data[s.key] = o; ok++;
    console.error(`✓ ${s.name.padEnd(12)} ${String(price).padStart(11)}  via ${o.via}`
                  + (o.ma60 ? `  季線 ${o.ma60}` : ""));
  }catch(e){
    bad++;
    data[s.key] = { name:s.name, group:s.key, error:String(e.message||e) };
    console.error(`✗ ${s.name.padEnd(12)} ${e.message}`);
  }
  await sleep(500);
}

/* 台股：若同時有非證交所的值，跟證交所對帳；差 >0.5% 以官方為準 */
const crossCheck = {};
await loadTwse();
for(const [key, code] of Object.entries({tsmc:"2330", e0050:"0050", e0056:"0056"})){
  const y = data[key];
  if(!y || y.error || !y.price || String(y.via).startsWith("twse")) continue;
  const row = twseStocks.get(code); if(!row) continue;
  const official = pick(row,"ClosingPrice","Closing","Close"); if(official === null) continue;
  const diffPct = (y.price/official - 1)*100;
  const agree = Math.abs(diffPct) <= 0.5;
  crossCheck[key] = { primary:y.price, via:y.via, twse:official, diffPct:+diffPct.toFixed(3), agree,
                      note: agree ? "兩個來源一致" : "⚠️ 不一致，已改採證交所官方收盤" };
  if(!agree){ y.priceYahoo = y.price; y.price = official; y.correctedBy = "TWSE"; }
}

const payload = {
  generatedAt: new Date().toISOString(),
  generatedAtTaipei: new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"})
                       .format(new Date()),
  sources: { note:"每個標的依序嘗試多個來源，實際採用的記在該標的的 via 欄位",
             order:"台股：證交所 → Stooq → Yahoo　｜　其他：Stooq → Yahoo" },
  ok, failed: bad, crossCheck, data
};

/* ADR 溢價：ADR × 匯率 ÷ 5 ÷ 台積電台股價 − 1 */
const adr = data.adr, tsmc = data.tsmc, fx = data.usdtwd;
if(adr?.price && tsmc?.price && fx?.price){
  const conv = adr.price * fx.price / 5;
  payload.adrPremium = {
    converted:+conv.toFixed(2),
    premiumPct:+(((conv/tsmc.price)-1)*100).toFixed(2),
    impliedOpen: adr.pct !== null && adr.pct !== undefined ? +(tsmc.price*(1+adr.pct/100)).toFixed(0) : null,
    note:"台積電 ADR 長期有一到二成結構性溢價，看溢價率的『變化』而不是絕對值"
  };
}

fs.mkdirSync(path.dirname(OUT), {recursive:true});
fs.writeFileSync(OUT, JSON.stringify(payload,null,2) + "\n");
console.error(`\n寫入 ${OUT}　成功 ${ok} / 失敗 ${bad}`);
if(ok === 0) process.exit(1);
