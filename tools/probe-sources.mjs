#!/usr/bin/env node
/**
 * 探測各家行情來源從「這台機器」通不通，以及回的東西長什麼樣。
 *
 *   node tools/probe-sources.mjs
 *
 * 為什麼需要這支：
 * 「能不能抓到」不是一個全域答案，是「從哪裡抓」的答案。
 * Yahoo 與 Stooq 從家用網路好好的，從 GitHub Actions 的機房 IP 全部被擋；
 * 寫這個專案的沙盒則是連證交所都連不出去。
 * 所以要判斷一個來源能不能用，得在**真正會跑它的那台機器上**測。
 *
 * 而且光知道「失敗了」修不了東西 —— 這支會把狀態碼、content-type、
 * 回應開頭、以及 JSON 的結構印出來，那才是能拿來對格式的資訊。
 * 上櫃（TPEx）目前就卡在這裡：它有回應、是合法 JSON，但我找不到資料列。
 *
 * 不寫任何檔案，純粹回報。
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, "0");

const now = new Date();
const Y = now.getUTCFullYear(), M = now.getUTCMonth() + 1;
const ym = `${Y}${pad(M)}`;
const roc = `${Y - 1911}/${pad(M)}`;

/* 每個候選：名字、網址、這個來源是拿來做什麼的 */
const TARGETS = [
  ["證交所 OpenAPI 個股",
   "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", "上市個股收盤（非即時）"],
  ["證交所 OpenAPI 指數",
   "https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST", "加權指數"],
  ["證交所 www 日成交值 FMTQIK",
   `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ym}01&response=json`, "上市每日成交值"],
  ["證交所 MIS 即時（四檔一次）",
   "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" +
     encodeURIComponent("tse_t00.tw|tse_2330.tw|tse_0050.tw|tse_0056.tw") + "&json=1&delay=0",
   "★ 台股盤中即時。一次要四檔，順便看批次會不會被限流"],
  ["證交所 三大法人 BFI82U",
   `https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate=${ym}01&type=day&response=json`, "外資買賣超"],
  ["櫃買 TPEx 新版路徑",
   `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${ym}01&response=json`,
   "★ 上櫃成交值 —— 目前卡住的就是這個"],
  ["櫃買 TPEx OpenAPI",
   "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes", "上櫃（另一條路）"],
  ["櫃買 TPEx 舊版 php",
   `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_index/st41_result.php?l=zh-tw&d=${roc}&o=json`,
   "上櫃（舊端點）"],
  ["CNBC",
   "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=TSM&requestMethod=itv&exthrs=1&fund=1&output=json",
   "目前美股／日韓在用的"],
  ["er-api 匯率",
   "https://open.er-api.com/v6/latest/USD", "目前匯率在用的"],
  ["Yahoo Finance",
   "https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?interval=1d&range=5d",
   "已知擋機房 IP，測來對照"],
  ["Stooq",
   "https://stooq.com/q/l/?s=2330.tw&f=sd2t2ohlcv&h&e=csv", "已知擋機房 IP，測來對照"],
  ["FinMind",
   "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=2330&start_date=2026-07-01",
   "免費額度，沒帶 token 看它回什麼"],
];

/** JSON 的結構長什麼樣 —— 對格式要看的是這個，不是那一大坨內容 */
function shape(j, d = 0){
  if(j === null || j === undefined) return String(j);
  if(Array.isArray(j))
    return `Array(${j.length})` + (j.length && d < 2 ? ` of ${shape(j[0], d + 1)}` : "");
  if(typeof j === "object"){
    const k = Object.keys(j);
    return `{ ${k.slice(0, 14).join(", ")}${k.length > 14 ? ", …" : ""} }`;
  }
  return typeof j;
}

/* 期交所單獨處理：GET 回的是 405 Method Not Allowed，不是 403 ——
   代表主機通，只是要 POST。試幾種 payload 看哪一種被接受。 */
async function probeTaifex(){
  const url = "https://mis.taifex.com.tw/futures/api/getQuoteList";
  const bodies = [
    { label:"台指期全月份",
      body:{MarketType:"0",SymbolType:"F",KindID:"1",CID:"TXF",ExpireMonth:"",
            RowSize:"全部",PageNo:"",SortColumn:"",AscDesc:"A"} },
    { label:"台指期近月",
      body:{MarketType:"0",SymbolType:"F",KindID:"1",CID:"TXF",ExpireMonth:"999999",
            RowSize:"100",PageNo:"1",SortColumn:"",AscDesc:"A"} },
    { label:"最精簡",
      body:{SymbolType:"F",KindID:"1",CID:"TXF"} },
  ];
  console.log(`\n── 期交所 POST\n   ★ 台指期夜盤 —— GET 回 405，改試 POST\n   mis.taifex.com.tw`);
  for(const b of bodies){
    try{
      const r = await fetch(url, {
        method:"POST",
        headers:{ "User-Agent":UA, "Content-Type":"application/json",
                  Accept:"application/json",
                  Origin:"https://mis.taifex.com.tw",
                  Referer:"https://mis.taifex.com.tw/futures/RegularSession/EquityIndices/" },
        body: JSON.stringify(b.body),
        signal: AbortSignal.timeout(20000)
      });
      const t = await r.text();
      console.log(`   [${b.label}] HTTP ${r.status}  ${t.length}B`);
      if(!r.ok){ console.log(`     ✗ ${t.slice(0,160).replace(/\s+/g," ")}`); continue; }
      let j = null; try{ j = JSON.parse(t); }catch{}
      if(j){
        console.log(`     ✓ 結構 ${shape(j)}`);
        const list = j.RtData?.QuoteList || j.RtData?.quoteList || j.QuoteList;
        if(Array.isArray(list) && list.length){
          console.log(`     ✓ ${list.length} 筆，第一筆：${JSON.stringify(list[0]).slice(0,320)}`);
          return true;
        }
        console.log(`     ⚠️ 沒有 QuoteList：${JSON.stringify(j).slice(0,240)}`);
      }else{
        console.log(`     ⚠️ 非 JSON：${t.slice(0,160)}`);
      }
    }catch(e){ console.log(`   [${b.label}] ✗ ${e.name}: ${e.message}`); }
    await sleep(900);
  }
  return false;
}

let ok = 0, blocked = 0, weird = 0;

for(const [name, url, why] of TARGETS){
  const host = new URL(url).host;
  process.stdout.write(`\n── ${name}\n   ${why}\n   ${host}\n`);
  const t0 = Date.now();
  try{
    const r = await fetch(url, {
      headers:{ "User-Agent":UA, Accept:"application/json, text/csv, text/plain, */*" },
      signal: AbortSignal.timeout(20000)
    });
    const ct = r.headers.get("content-type") || "(無)";
    const body = await r.text();
    const ms = Date.now() - t0;
    console.log(`   HTTP ${r.status}  ${ct.split(";")[0]}  ${body.length}B  ${ms}ms`);

    if(!r.ok){
      console.log(`   ✗ 回應開頭：${body.slice(0,140).replace(/\s+/g," ")}`);
      blocked++; continue;
    }
    // 是 JSON 就印結構與第一列；不是就印開頭幾行
    let j = null;
    try{ j = JSON.parse(body); }catch{}
    if(j !== null){
      console.log(`   ✓ 結構 ${shape(j)}`);
      // 把最可能是資料列的東西挖出來看第一筆
      const cand = Array.isArray(j) ? j
                 : (j.data || j.aaData || j.tables?.[0]?.data || j.msgArray || null);
      if(Array.isArray(cand) && cand.length){
        console.log(`   ✓ 共 ${cand.length} 列，第一列：`);
        console.log(`     ${JSON.stringify(cand[0]).slice(0,300)}`);
      }else{
        console.log(`   ⚠️ 找不到陣列型的資料列 —— 這就是要對的地方`);
        console.log(`     ${JSON.stringify(j).slice(0,300)}`);
        weird++; continue;
      }
    }else{
      const head = body.split(/\r?\n/).slice(0,3).join(" ⏎ ");
      console.log(`   ✓ 非 JSON，開頭：${head.slice(0,220)}`);
    }
    ok++;
  }catch(e){
    console.log(`   ✗ ${e.name}: ${e.message}`);
    blocked++;
  }
  await sleep(900);          // 對證交所連續請求要客氣一點
}

await probeTaifex();

console.log(`\n═══ 從這台機器：可用 ${ok} ／ 連不到或被擋 ${blocked} ／ 通了但格式對不上 ${weird} ═══`);
console.log("（「格式對不上」才是能修的；「被擋」多半只能換來源）");
