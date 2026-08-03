#!/usr/bin/env node
/* 燈號判定。純邏輯、不連網，所以可以離線把每一條規則驗過。
 *
 * 為什麼要獨立出來：抓資料會失敗、會被擋、會回怪東西，那些problem看得見。
 * 判定規則寫錯不會有任何症狀 —— 燈不亮你會以為「今天就是沒訊號」，
 * 而不是「規則寫反了所以永遠不會亮」。所以規則這一層要能單獨測。
 *
 * 門檻值一律從 data/thresholds.json 讀，不寫死在這裡：
 * 那些數字是依當前市值規模抓的經驗值，市值變了就得跟著調，
 * 而調參數不應該需要改程式。
 */

/* 滾動平均。回傳跟輸入等長的陣列，資料不夠的位置是 null ——
   不夠就誠實留空，不要用比較短的窗口硬算一個看起來像 20 日均的東西。 */
export function sma(values, n){
  return values.map(function(_, i){
    if(i + 1 < n) return null;
    var s = 0;
    for(var k = i + 1 - n; k <= i; k++){
      if(values[k] === null || values[k] === undefined || !isFinite(values[k])) return null;
      s += values[k];
    }
    return s / n;
  });
}

/* 最後 n 次「變化」是不是全部往下。
   USD/TWD 下降＝台幣升值，所以這裡找的是連續 n 日台幣走強。
   注意要 n 次變化就需要 n+1 個資料點。 */
export function fallingStreak(values, n){
  if(!values || values.length < n + 1) return false;
  for(var i = values.length - n; i < values.length; i++){
    if(!(values[i] < values[i-1])) return false;      // 持平不算，必須嚴格下降
  }
  return true;
}

/* fast 是不是「在最後一根」由上往下穿過 slow。
   要的是穿越的那一刻，不是「fast 一直在 slow 下面」——
   後者會讓燈在整段趨勢裡天天亮，訊號紀錄表就會被灌爆。 */
export function crossedBelow(fast, slow){
  var i = fast.length - 1;
  if(i < 1) return false;
  var a0 = fast[i-1], b0 = slow[i-1], a1 = fast[i], b1 = slow[i];
  if([a0,b0,a1,b1].some(function(v){ return v === null || v === undefined || !isFinite(v); })) return false;
  return a0 >= b0 && a1 < b1;
}

/* 匯率卡的判定。
   兩條規則都指向同一件事：台幣走強 → 外資有匯入的跡象 → 對台股偏多。
   但這只是「錢有沒有進來」的溫度計，不是保證 —— 判定結果要配訊號紀錄表
   回頭算命中率，不然這張卡只是好看。 */
export function evalFx(rates, cfg){
  var c = (cfg && cfg.fx) || {};
  var nStreak = c.consecutiveDays || 3;
  var nFast   = c.fastMA || 5;
  var nSlow   = c.slowMA || 20;

  var have = rates.length, need = nSlow + 1;      // 穿越判定要看前一根，所以 +1
  var fast = sma(rates, nFast), slow = sma(rates, nSlow);

  var reasons = [];
  if(fallingStreak(rates, nStreak)) reasons.push("連 " + nStreak + " 日台幣升值");
  if(crossedBelow(fast, slow))      reasons.push(nFast + " 日均由上向下穿越 " + nSlow + " 日均");

  return {
    lit: reasons.length > 0,
    reasons: reasons,
    ready: have >= need,            // 資料不夠就別假裝有結論
    have: have, need: need,
    fast: fast[fast.length-1] ?? null,
    slow: slow[slow.length-1] ?? null,
    fastSeries: fast, slowSeries: slow
  };
}

/* 量能：單日成交值突破門檻就亮。
 *
 * ── 原本的「量縮打底 → 待命 → 突破」兩段式已經拿掉 ──
 * 那一段的用意是分辨「打底後放量（進場）」與「高檔爆量（出貨）」——
 * 單日數字長得一模一樣，差別在它之前發生過什麼。想法是對的，
 * 但實際資料出來就知道行不通：2026/07 的上市成交值最低 7,476 億，
 * 22 個交易日沒有一天低於 7,000 億，加上上櫃只會更高。
 * 「量縮打底」這個階段在現在的市場規模下根本不存在，
 * 那個前提永遠不會成立，燈永遠不會亮。所以整段移除。
 *
 * ── 移除之後少了什麼，要講清楚 ──
 * 沒有前置條件，這盞燈就**分不出換手與出貨**。它只回答
 * 「今天的量有沒有超過某條線」，不回答「這個量是好是壞」。
 * 為了不讓這件事變成無聲的問題，evalVolume 會一併回報
 * 這條門檻在手上這段資料會亮幾次（fireRate）——
 * 一盞每天都亮或永遠不亮的燈，兩種都沒有資訊量，而且要看得見才知道。
 */
export function evalVolume(series, cfg){
  var c = (cfg && cfg.volume) || {};
  var breakout = c.breakoutAbove || 11000;     // 億元
  var overheat = c.overheatAbove || 13000;

  var vals = series.map(function(r){ return r.total; });
  var seen = vals.filter(function(v){ return v !== null && v !== undefined && isFinite(v); });

  var last = vals.length ? vals[vals.length-1] : null;
  var lit = last !== null && last !== undefined && isFinite(last) && last > breakout;

  var reasons = [];
  if(lit){
    reasons.push("成交值突破 " + (breakout/10000).toFixed(2) + " 兆");
    // 少了打底那一段之後，這句話從「補充說明」變成唯一的警語
    if(last > overheat)
      reasons.push("而且已達 " + (overheat/10000).toFixed(2)
                 + " 兆過熱區 —— 沒有前置條件可以分辨這是換手還是出貨，要自己看");
  }

  /* 這條門檻在手上這段資料會亮幾次。
     校準壞掉是無聲的：門檻太高就永遠不亮（看起來像「最近沒訊號」），
     太低就天天亮（看起來像「一直有訊號」）。兩種都要看得見。 */
  var fired = seen.filter(function(v){ return v > breakout; }).length;
  var reach = seen.length ? {
    lo: Math.min.apply(null, seen), hi: Math.max.apply(null, seen), days: seen.length,
    fired: fired, fireRate: fired / seen.length,
    breakoutReachable: Math.max.apply(null, seen) > breakout
  } : null;

  return {
    lit: lit, reasons: reasons,
    ready: seen.length > 0,
    last: last, reach: reach,
    thresholds: {breakout:breakout, overheat:overheat}
  };
}

/* 只在「由不亮轉成亮」的那一天記一筆。
   每天亮就每天記的話，一段趨勢會產生幾十列，之後算命中率會被同一個訊號灌爆。 */
export function shouldLog(wasLit, isLit){ return !wasLit && isLit; }

export const DEFAULTS = {
  fx: { consecutiveDays:3, fastMA:5, slowMA:20 },
  volume: { breakoutAbove:11000, overheatAbove:13000 }
};

/* ── 自測 ── */
function selfTest(){
  var fails = [];
  function ok(name, cond, got){
    if(cond) console.error("  ✓ " + name);
    else { console.error("  ✗ " + name + "　得到：" + JSON.stringify(got)); fails.push(name); }
  }
  console.error("signals 自測");

  // sma
  ok("資料不夠時是 null", JSON.stringify(sma([1,2],3)) === "[null,null]", sma([1,2],3));
  ok("3 日均算對", sma([1,2,3,4],3)[3] === 3, sma([1,2,3,4],3));

  // fallingStreak
  ok("連 3 日下降 → true",  fallingStreak([10,9,8,7],3) === true);
  ok("中間反彈 → false",    fallingStreak([10,9,10,7],3) === false);
  ok("持平不算下降",        fallingStreak([10,9,9,8],3) === false, [10,9,9,8]);
  ok("資料只有 3 點不足以判 3 次變化", fallingStreak([10,9,8],3) === false);
  ok("上升 → false",        fallingStreak([7,8,9,10],3) === false);

  // crossedBelow：只認穿越那一刻
  ok("剛穿下去 → true",     crossedBelow([2,0.9],[1,1]) === true);
  ok("本來就在下面 → false", crossedBelow([0.8,0.9],[1,1]) === false, "整段趨勢不該天天亮");
  ok("由下往上穿 → false",   crossedBelow([0.9,2],[1,1]) === false);
  ok("有 null → false",     crossedBelow([null,0.9],[1,1]) === false);

  // evalFx：資料不夠時不給結論
  var few = evalFx([32.3,32.2,32.1], DEFAULTS);
  ok("資料不夠 → ready 為 false", few.ready === false && few.have === 3 && few.need === 21, few);

  // 連 3 日升值會亮
  var down = [];
  for(var i=0;i<21;i++) down.push(32.5);              // 先鋪平
  down.push(32.4, 32.3, 32.2);                        // 再連 3 日走強
  var r = evalFx(down, DEFAULTS);
  ok("連 3 日升值 → 亮燈", r.lit === true && r.reasons.some(function(x){ return x.indexOf("連 3 日")>=0; }), r.reasons);
  ok("資料夠了 → ready 為 true", r.ready === true, r);

  // 平盤不該亮
  var flat = []; for(var j=0;j<25;j++) flat.push(32.5);
  ok("完全平盤 → 不亮", evalFx(flat, DEFAULTS).lit === false, evalFx(flat, DEFAULTS));

  // 台幣走貶不該亮（方向寫反的話這條會掛）
  var up = []; for(var k=0;k<25;k++) up.push(32.0 + k*0.05);
  ok("台幣持續走貶 → 不亮（方向寫反這條會掛）", evalFx(up, DEFAULTS).lit === false, evalFx(up, DEFAULTS));

  // 門檻真的有被讀進去：同一組資料，門檻 2 會亮、門檻 3 不會。
  // 剛好只有 2 連跌（中間先彈一次），所以兩個門檻的結果必須不同。
  var two = []; for(var m=0;m<21;m++) two.push(32.5);
  two.push(32.6, 32.55, 32.5);                        // 變化：升、跌、跌
  ok("門檻 2 日 → 亮",
     evalFx(two, {fx:{consecutiveDays:2, fastMA:5, slowMA:20}}).lit === true,
     evalFx(two, {fx:{consecutiveDays:2, fastMA:5, slowMA:20}}).reasons);
  ok("同一組資料門檻 3 日 → 不亮（證明門檻真的有讀）",
     evalFx(two, {fx:{consecutiveDays:3, fastMA:5, slowMA:20}}).lit === false,
     evalFx(two, {fx:{consecutiveDays:3, fastMA:5, slowMA:20}}).reasons);

  // shouldLog
  ok("由暗轉亮才記錄", shouldLog(false,true) === true && shouldLog(true,true) === false
     && shouldLog(true,false) === false);

  // ── 量能 ──
  var V = function(arr){ return arr.map(function(v,i){
    return {date:"2026-09-"+String(i+1).padStart(2,"0"), total:v}; }); };

  ok("超過門檻 → 亮", evalVolume(V([9000,11500]), DEFAULTS).lit === true);
  ok("沒超過 → 不亮", evalVolume(V([9000,10500]), DEFAULTS).lit === false);
  ok("剛好等於門檻 → 不亮（要嚴格大於）",
     evalVolume(V([9000,11000]), DEFAULTS).lit === false);

  // 過熱區的警語現在是唯一分辨換手／出貨的提示，不能掉
  var hot = evalVolume(V([13800]), DEFAULTS);
  ok("突破且過熱 → 兩句話，第二句講分不出換手或出貨",
     hot.lit === true && hot.reasons.length === 2
     && hot.reasons[1].indexOf("換手還是出貨") >= 0, hot.reasons);

  // 校準讀數：門檻壞掉是無聲的，兩個方向都要看得見
  var everyDay = evalVolume(V([12000,12500,13000,11500]), DEFAULTS);
  ok("天天都超過 → fireRate 是 1（門檻太低）",
     everyDay.reach.fireRate === 1, everyDay.reach);
  var never = evalVolume(V([9000,9500,8000]), DEFAULTS);
  ok("從來沒超過 → fireRate 是 0、breakoutReachable false（門檻太高）",
     never.reach.fireRate === 0 && never.reach.breakoutReachable === false, never.reach);

  // 用 2026/07 真實上市成交值（估算含上櫃 +18%）驗校準
  var twse = [13678.18,10835.83,10780.28,10644.32,12281.19,10045.6,9967.89,10676.62,
              12452.07,10243.86,9331.81,13331.57,10414.57,8662.52,10259.58,9306.12,
              8271.3,7476.47,8725.75,11491.85,11469.38,8877.32];
  var real = evalVolume(V(twse.map(function(v){ return +(v*1.18).toFixed(2); })), DEFAULTS);
  ok("2026/07 真實量級 → 這條門檻超過七成的日子都會亮（幾乎沒有資訊量）",
     real.reach.fireRate > 0.7, {fireRate:real.reach.fireRate, fired:real.reach.fired, days:real.reach.days});

  ok("門檻可調：調高之後同一組資料不亮",
     evalVolume(V([11500]), {volume:{breakoutAbove:12000, overheatAbove:13000}}).lit === false);

  console.error(fails.length ? "\n✗ " + fails.length + " 項失敗" : "\n全部通過");
  return fails.length;
}

if(process.argv.includes("--self-test")) process.exit(selfTest() ? 1 : 0);
