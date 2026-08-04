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
import { readHistory, deriveFx, writeHistory } from "./fx-daily.mjs";
import { evalFx, evalVolume, shouldLog, DEFAULTS } from "./signals.mjs";

const outIdx = process.argv.indexOf("-o");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : "data/live.json";
const FX_HIST   = "data/fx-usdtwd.csv";
const THRESHOLDS = "data/thresholds.json";
const SIGNAL_LOG = "data/signals.csv";
const TURNOVER   = "data/turnover.csv";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sma = (a, n) => a.length < n ? null : a.slice(-n).reduce((x, y) => x + y, 0) / n;
const num = v => {
  // 空字串要回 null 不能回 0：Number("") 是 0 且 isFinite(0) 為真。
  // MIS 的欄位在沒成交時會是 "-" 或空的，讀成 0 就會生出一個假的崩盤。
  const t = String(v ?? "").replace(/,/g, "").trim();
  if(t === "") return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
};

/* 每個標的的候選來源，依序嘗試。symbol 寫法各站不同，所以連代號一起帶。 */
const SYMBOLS = [
  { key:"twii",  name:"加權指數",   dp:2, ma:true,
    srcs:[["mis","t00"],["twseIndex",""],["stooq","^twse"],["stooq","^tai"],["yahoo","^TWII"]] },
  { key:"tsmc",  name:"台積電",     dp:2, ma:true,
    srcs:[["mis","2330"],["twseStock","2330"],["stooq","2330.tw"],["yahoo","2330.TW"]] },
  { key:"e0050", name:"元大台灣50", dp:2, ma:true,
    srcs:[["mis","0050"],["twseStock","0050"],["stooq","0050.tw"],["yahoo","0050.TW"]] },
  { key:"e0056", name:"元大高股息", dp:2, ma:true,
    srcs:[["mis","0056"],["twseStock","0056"],["stooq","0056.tw"],["yahoo","0056.TW"]] },
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
  // VIX 是唯一「漲＝壞」的標的：它衡量的是 S&P 500 未來 30 天的隱含波動度，
  // 也就是市場願意為避險付多少錢。所以它跟頁面其他數字的紅綠意義是反過來的，
  // 顯示端要特別處理，不能直接套紅漲綠跌。
  { key:"vix",   name:"VIX 恐慌指數", dp:2, ma:false,
    srcs:[["cnbc",".VIX"],["twelve","VIX"],["stooq","^vix"],["yahoo","^VIX"]] },
  { key:"n225",  name:"日經 225",   dp:2, ma:false,
    srcs:[["cnbc",".N225"],["twelve","N225"],["stooq","^nkx"],["yahoo","^N225"]] },
  { key:"kospi", name:"韓國 KOSPI", dp:2, ma:false,
    srcs:[["cnbc",".KS11"],["twelve","KS11"],["stooq","^kospi"],["yahoo","^KS11"]] },
  // 台指期（含夜盤）。沒有備援來源：這個數字只有期交所給，
  // 抓不到就會留下 error 欄位，讀取端據此顯示「自己查」。
  { key:"txf",   name:"台指期",     dp:0, ma:false, srcs:[["taifex","TXF"]] },
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
/* ── 證交所 MIS：台股唯一免費免註冊的「盤中即時」，約 5 秒更新 ──
 *
 * 2026-08-04 用 probe-sources.mjs 從 runner 實測可用（HTTP 200，回 msgArray）。
 * 這是 OpenAPI 給不了的東西：OpenAPI 只有盤後結算的收盤，
 * MIS 在盤中就有價，收盤後也比 OpenAPI 早拿到當天收盤。
 *
 * 欄位是縮寫：z=最近成交價 y=昨收 o=開盤 h=最高 l=最低 v=累積成交量
 *            tv=當盤量 b/a=五檔買賣 d=最近成交日期 t=時刻 tlong=時間戳
 * 沒有官方文件，隨時可能改，所以它只是「優先嘗試」，後面照樣有備援。
 *
 * z 在沒有成交的那一瞬間會是 "-"，要往下退到前一筆成交價，
 * 再退到買賣五檔的中價 —— 直接把 "-" 當成 0 會生出一個假的崩盤。
 */
/* 我們用的代號 → MIS 的頻道字串。
   注意 msgArray 每一列的 c 是「證券代號」，指數是 t00 不是 twii ——
   第一次上線就是這裡對不上，加權指數靜靜地退回了 OpenAPI 的昨收。 */
const MIS_MAP = { "2330":"tse_2330.tw", "0050":"tse_0050.tw",
                  "0056":"tse_0056.tw", "t00":"tse_t00.tw" };
let misRows = null;
async function loadMis(){
  if(misRows !== null) return;
  misRows = new Map();
  const chans = Object.values(MIS_MAP).join("|");
  try{
    // 一次要完所有標的：MIS 對連續請求很敏感，分開打反而容易被限流
    const r = await fetch(
      `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chans)}&json=1&delay=0`,
      {headers:{"User-Agent":UA, Accept:"application/json",
                Referer:"https://mis.twse.com.tw/stock/fibest.jsp"}});
    if(!r.ok){ console.error("MIS 即時 HTTP " + r.status); return; }
    const j = JSON.parse(await r.text());
    for(const row of (j.msgArray || [])) misRows.set(String(row.c || "").trim(), row);
    console.error(`MIS 即時：${misRows.size} 檔　rtcode ${j.rtcode ?? "-"}`);
  }catch(e){ console.error("MIS 即時失敗：" + e.message); }
}
/** 五檔字串 "2325.0000_2330.0000_…" → 第一檔的數字 */
function misTop(s){
  const v = String(s ?? "").split("_").filter(Boolean)[0];
  return num(v);
}
function misQuote(code){
  const row = misRows.get(code);
  if(!row) throw new Error("MIS 沒有這一檔：" + code);
  // 價格的退路：最近成交 → 前一筆成交 → 買賣中價。全都沒有才算失敗。
  let price = num(row.z);
  if(price === null) price = num(row.pz);
  if(price === null){
    const bid = misTop(row.b), ask = misTop(row.a);
    if(bid !== null && ask !== null) price = (bid + ask) / 2;
  }
  if(price === null) throw new Error("MIS 沒有可用價格（z/pz/五檔都是空的）");

  const asOf = parseTwseDate(row.d) || null;      // d 是最近成交日期
  // 盤中與否由「資料日期是不是今天」＋「台北現在是不是交易時段」共同決定。
  // 只信其中一個都會出錯：週末 MIS 照樣回上一個交易日的資料。
  const t = taipeiNow();
  const inSession = t.dow >= 1 && t.dow <= 5 &&
                    (t.h*60 + t.mi) >= 9*60 && (t.h*60 + t.mi) <= 13*60+30;
  const marketState = (asOf === t.date && inSession) ? "REG_MKT" : "CLOSED";
  return { price, prevClose: num(row.y), marketState, asOf };
}

/** 台北的現在（日期＋時分＋星期），MIS 判斷盤中要用 */
function taipeiNow(){
  const p = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",
    day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})
    .formatToParts(new Date()).reduce((a,x)=>(a[x.type]=x.value,a),{});
  const date = `${p.year}-${p.month}-${p.day}`;
  return {date, h:parseInt(p.hour,10)%24, mi:+p.minute,
          dow:new Date(date+"T12:00:00Z").getUTCDay()};
}

/* ── 期交所 MIS：台指期，含夜盤 ──
 * 一開始判定「擋機房」是錯的：GET 回的是 405 Method Not Allowed 而不是 403，
 * 代表主機通、只是方法不對。2026-08-04 用 POST 實測成功。
 * 回傳 { RtCode, RtMsg, RtData:{ QuoteList:[…] } }，第一筆是臺指現貨（SymbolID 以 -S 結尾），
 * 後面才是各月份期貨。夜盤時段一樣有值，這是台股收盤後唯一還在動的台灣報價。
 */
async function taifexQuote(){
  const r = await fetch("https://mis.taifex.com.tw/futures/api/getQuoteList", {
    method:"POST",
    headers:{ "User-Agent":UA, "Content-Type":"application/json", Accept:"application/json",
              Origin:"https://mis.taifex.com.tw",
              Referer:"https://mis.taifex.com.tw/futures/RegularSession/EquityIndices/" },
    body: JSON.stringify({MarketType:"0",SymbolType:"F",KindID:"1",CID:"TXF",
                          ExpireMonth:"",RowSize:"全部",PageNo:"",SortColumn:"",AscDesc:"A"})
  });
  const body = await r.text();
  if(!r.ok) throw new Error(`HTTP ${r.status}｜${body.slice(0,80)}`);
  const j = JSON.parse(body);
  const list = j?.RtData?.QuoteList;
  if(!Array.isArray(list) || !list.length) throw new Error("回應裡沒有 QuoteList｜RtMsg " + j?.RtMsg);

  // -S 結尾是現貨，要的是期貨；取第一個非現貨的（近月）
  const fut = list.filter(x => !String(x.SymbolID||"").endsWith("-S"));
  const row = fut[0] || list[0];
  const price = num(row.CLastPrice), prev = num(row.CRefPrice);
  if(price === null) throw new Error("沒有 CLastPrice（可能非交易時段）");
  console.error(`  台指期 ${row.DispCName||row.SymbolID}　${price}`
    + (prev !== null ? `　參考價 ${prev}` : "") + `　狀態 ${row.Status||"-"}`);
  return { price, prevClose: prev, marketState: null,
           contract: row.DispCName || row.SymbolID || null };
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
      if(src === "taifex"){
        out = await taifexQuote();
      } else if(src === "mis"){
        await loadMis();
        out = misQuote(sym);
      } else if(src === "twseStock"){
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
        // open.er-api.com：免金鑰的匯率來源，每日更新（UTC 00:00＝台北 08:00）
        const j = JSON.parse(await getText("https://open.er-api.com/v6/latest/USD"));
        const rate = j && j.rates && j.rates[sym];
        if(!rate) throw new Error("回應裡沒有 " + sym);
        // 同一份回應裡就有更新時戳，本來被丟掉了。留著它，匯率才知道自己屬於哪一天，
        // 前一日錨點（tools/fx-daily.mjs）也才有可靠的換日依據。
        out = { price: rate, prevClose: null, marketState: null,
                rateUnix: Number(j && j.time_last_update_unix) || null };
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
      rateUnix: r.rateUnix || undefined,      // 匯率專用：供應商自己的更新時戳
      contract: r.contract || undefined,      // 台指期專用：哪一個月份的合約
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
  // **只有兩邊指的是同一個交易日才能對帳。**
  // 接上 MIS 之後這條變成必要的：MIS 盤中價跟證交所「上一個結算日」的收盤
  // 本來就不會相等，硬比會判定不一致，然後拿昨天的收盤蓋掉今天的即時價 ——
  // 那是把新資料換成舊資料，比不對帳更糟。
  const officialDate = parseTwseDate(row.Date ?? row.date ?? "") || twseDate;
  if(y.asOf && officialDate && y.asOf !== officialDate){
    crossCheck[key] = { primary:y.price, via:y.via, twse:official, agree:null,
                        note:`跳過對帳：${y.via} 是 ${y.asOf}、證交所是 ${officialDate}，不同交易日` };
    continue;
  }
  const diffPct = (y.price/official - 1)*100;
  const agree = Math.abs(diffPct) <= 0.5;
  crossCheck[key] = { primary:y.price, via:y.via, twse:official, diffPct:+diffPct.toFixed(3), agree,
                      note: agree ? "兩個來源一致" : "⚠️ 不一致，已改採證交所官方收盤" };
  if(!agree){ y.priceYahoo = y.price; y.price = official; y.correctedBy = "TWSE"; }
}

/* 訊號紀錄表的讀寫。CSV 逐列 append，壞不了整份檔案。
   欄位裡的逗號會破壞格式，所以一律換成頓號 —— 這張表是給人回頭看的，
   不值得為了它引進一套 CSV 跳脫規則。 */
/* 這一天這個指標已經記過了嗎。
   workflow 一天跑 9 次，沒有這道防線同一個訊號會被記 9 列，
   之後算命中率就會被同一件事灌爆。 */
function alreadyLogged(file, date, indicator){
  try{
    return fs.readFileSync(file,"utf8").split(/\r?\n/).slice(1).filter(Boolean)
      .some(r => { const c = r.split(","); return c[0] === date && c[1] === indicator; });
  }catch(e){ return false; }
}
function appendSignal(file, row){
  const clean = v => String(v ?? "").replace(/,/g, "、").replace(/[\r\n]/g, " ");
  fs.mkdirSync(path.dirname(file), {recursive:true});
  if(!fs.existsSync(file)) fs.writeFileSync(file, "date,indicator,signal,twii,note\n");
  fs.appendFileSync(file,
    [row.date, row.indicator, row.signal, row.twii, row.note].map(clean).join(",") + "\n");
}

/* 匯率的前一日錨點。
   er-api 只回當下匯率、沒有前收，所以「日變動」得靠自己記昨天是多少。
   錨點放獨立的 data/fx-usdtwd.csv —— 理由寫在 tools/fx-daily.mjs 的檔頭：
   匯率單獨失敗時 live.json 照樣會 commit，錨點寄生在裡面就會跟著消失。
   拿不到錨點時什麼都不編，寧可讓那一列顯示「—」。 */
const fxEntry = data.usdtwd;
if(fxEntry && !fxEntry.error && fxEntry.price){
  try{
    const hist = readHistory(FX_HIST);
    const fx = deriveFx(hist, fxEntry.price, fxEntry.rateUnix, Date.now());
    fxEntry.asOf        = fx.asOf;
    fxEntry.asOfVia     = fx.asOfVia;      // provider ／ runClock，兩者意思不同
    fxEntry.prevClose   = fx.prevClose;
    fxEntry.prevDay     = fx.prevDay;
    fxEntry.prevGapDays = fx.prevGapDays;
    if(fx.prevClose){
      fxEntry.change = +(fxEntry.price - fx.prevClose).toFixed(6);
      fxEntry.pct    = +(((fxEntry.price/fx.prevClose)-1)*100).toFixed(4);
    }
    // 週末只推算不寫入：手動在週日跑會插進「週日＝週五的凍結匯率」，
    // 害週一算成 ≈0%，把週末的跳空藏起來。
    if(fx.shouldWrite) writeHistory(FX_HIST, fx.nextHistory);
    console.error(`  匯率 ${fxEntry.price}　${fx.asOf}（${fx.asOfVia}）`
      + (fx.prevDay ? `　較 ${fx.prevDay}（${fx.prevGapDays} 天前）${fxEntry.pct>0?"+":""}${fxEntry.pct}%`
                    : "　尚無前一日錨點，日變動留空"));

    /* 燈號判定。門檻從資料檔讀，讀不到就用預設值，不讓一個手改壞的
       JSON 把整批行情擋下來。 */
    let cfg = DEFAULTS;
    try{ cfg = JSON.parse(fs.readFileSync(THRESHOLDS,"utf8")); }
    catch(e){ console.error("  門檻檔讀不到，用預設值：" + e.message); }

    const series = fx.nextHistory.map(r => r.rate);
    const sig = evalFx(series, cfg);
    fxEntry.signal = {
      lit: sig.lit, reasons: sig.reasons, ready: sig.ready,
      have: sig.have, need: sig.need,
      ma5: sig.fast !== null ? +sig.fast.toFixed(4) : null,
      ma20: sig.slow !== null ? +sig.slow.toFixed(4) : null
    };
    // 近 60 日的序列一起給前端畫圖，省得頁面再去讀一次 CSV
    fxEntry.series = fx.nextHistory.slice(-60);

    /* 訊號紀錄表：只在「由不亮轉成亮」那天記一列。
       沒有這張表，儀表板只會變成一個很漂亮但你不知道準不準的東西 ——
       三個月後要能回頭算命中率，就得知道當時亮燈的是哪一條規則、大盤在哪。 */
    if(sig.ready && fx.shouldWrite){
      // 昨天亮不亮，用「少掉今天那一點的序列」重算出來，不另外存狀態。
      // 存狀態就會有狀態走丟的問題；重算永遠跟資料一致。
      const prevLit = evalFx(series.slice(0, -1), cfg).lit;
      if(shouldLog(prevLit, sig.lit) && !alreadyLogged(SIGNAL_LOG, fx.asOf, "fx")){
        appendSignal(SIGNAL_LOG, {
          date: fx.asOf, indicator: "fx", signal: "台幣走強",
          twii: (data.twii && data.twii.price) || "",
          note: sig.reasons.join("；")
        });
        console.error(`  ⚡ 匯率燈號亮起並記錄：${sig.reasons.join("；")}`);
      }
    }
  }catch(e){
    console.error("  匯率錨點／燈號失敗（不影響其他標的）：" + e.message);
  }
}

/* 量能燈號。成交值由 tools/fetch-turnover.mjs 另外抓進 data/turnover.csv，
   這裡只負責判定並把結果放進 live.json，頁面就不必再讀一份 CSV。 */
const volume = (() => {
  try{
    const rows = fs.readFileSync(TURNOVER,"utf8").split(/\r?\n/).slice(1).filter(Boolean)
      .map(l => l.split(","))
      .filter(c => /^\d{4}-\d{2}-\d{2}$/.test((c[0]||"").trim()))
      .map(c => ({ date:c[0].trim(),
                   twse: c[1] ? Number(c[1]) : null,
                   tpex: c[2] ? Number(c[2]) : null,
                   total: c[3] ? Number(c[3]) : null }));
    if(!rows.length) return null;

    // 只有兩個市場都齊的日子才進判定。少了上櫃的日子留在檔案裡供對照，
    // 但不能拿去比門檻 —— 那組門檻是上市＋上櫃校準的。
    const full = rows.filter(r => r.total !== null && isFinite(r.total));
    const incomplete = rows.length - full.length;

    let cfg = DEFAULTS;
    try{ cfg = JSON.parse(fs.readFileSync(THRESHOLDS,"utf8")); }catch(e){}

    const sig = evalVolume(full, cfg);
    const out = {
      ...sig,
      complete: full.length, incomplete,
      // 最近一天如果資料不全，就明講「不判定」而不是給一個偏低的結論
      latestPartial: rows.length > 0 && rows[rows.length-1].total === null,
      series: rows.slice(-60)
    };
    console.error(`  量能 ${sig.last ?? "—"} 億　${sig.lit ? "🟢 亮燈" : "無訊號"}`
      + (sig.reach ? `　門檻校準：近 ${sig.reach.days} 日有 ${sig.reach.fired} 天會亮`
                     + `（${Math.round(sig.reach.fireRate*100)}%）` : "")
      + (out.latestPartial ? "　⚠️ 最新一日缺上櫃，不判定" : ""));

    if(sig.ready && !out.latestPartial && full.length >= 2){
      const prev = evalVolume(full.slice(0,-1), cfg);
      const day = full[full.length-1].date;
      if(shouldLog(prev.lit, sig.lit) && !alreadyLogged(SIGNAL_LOG, day, "volume")){
        appendSignal(SIGNAL_LOG, {
          date: day, indicator:"volume", signal:"量縮後放量",
          twii:(data.twii && data.twii.price) || "", note: sig.reasons.join("；")
        });
        console.error(`  ⚡ 量能燈號亮起並記錄：${sig.reasons.join("；")}`);
      }
    }
    return out;
  }catch(e){
    console.error("  量能燈號略過：" + e.message);
    return null;
  }
})();

const payload = {
  generatedAt: new Date().toISOString(),
  generatedAtTaipei: new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"})
                       .format(new Date()),
  sources: { note:"每個標的依序嘗試多個來源，實際採用的記在該標的的 via 欄位",
             order:"台股：證交所 → Stooq → Yahoo　｜　其他：Stooq → Yahoo" },
  ok, failed: bad, crossCheck, data,
  volume            // 量能燈號：判定在抓取端做完，頁面只負責顯示
};

/* ADR 溢價：ADR × 匯率 ÷ 5 ÷ 台積電台股價 − 1 */
const adr = data.adr, tsmc = data.tsmc, fx = data.usdtwd;
if(adr?.price && tsmc?.price && fx?.price){
  const conv = adr.price * fx.price / 5;
  payload.adrPremium = {
    converted:+conv.toFixed(2),
    fxAsOf: fx.asOf || null,        // 這個溢價率是用哪一天的匯率算的
    premiumPct:+(((conv/tsmc.price)-1)*100).toFixed(2),
    impliedOpen: adr.pct !== null && adr.pct !== undefined ? +(tsmc.price*(1+adr.pct/100)).toFixed(0) : null,
    note:"台積電 ADR 長期有一到二成結構性溢價，看溢價率的『變化』而不是絕對值"
  };
}

fs.mkdirSync(path.dirname(OUT), {recursive:true});
fs.writeFileSync(OUT, JSON.stringify(payload,null,2) + "\n");
console.error(`\n寫入 ${OUT}　成功 ${ok} / 失敗 ${bad}`);
if(ok === 0) process.exit(1);
