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

/* 量能的兩段式狀態機。
 *
 * 為什麼不能只看「突破 1.1 兆就亮」：高檔爆量跟打底後放量，單日數字長得一模一樣，
 * 但一個是出貨、一個是進場。差別不在那一天，在**它之前發生過什麼**。
 * 所以要先看到量縮打底（< 7,000 億）進入待命，之後的突破才算數。
 *
 * 狀態：
 *   idle  ── 沒事
 *   armed ── 出現過量縮，在等突破（這其實是最該注意的狀態，不是亮燈）
 *   fired ── 待命期間內突破了，亮燈；亮完回到 idle，要重新打底才會再亮
 *
 * 待命有沒有期限？原始建議沒說。半年前的量縮配上今天的突破顯然不該算數，
 * 所以我加了一個 armWindow（預設 30 個交易日）並且放進門檻檔可調 ——
 * 這是我補的假設，不是講者給的，標在這裡免得日後被當成原始設定。
 */
export function evalVolume(series, cfg){
  var c = (cfg && cfg.volume) || {};
  var quiet    = c.quietBelow    || 7000;      // 億元
  var breakout = c.breakoutAbove || 11000;
  var overheat = c.overheatAbove || 13000;
  var win      = c.armWindow     || 30;

  var vals = series.map(function(r){ return r.total; });
  var state = "idle", armedAt = null, firedAt = null, armedDate = null;

  for(var i=0;i<vals.length;i++){
    var v = vals[i];
    if(v === null || v === undefined || !isFinite(v)) continue;
    if(armedAt !== null && (i - armedAt) > win){ armedAt = null; }   // 待命過期
    if(v < quiet){
      armedAt = i; armedDate = series[i].date;                      // 量縮，重新計時
    }else if(armedAt !== null && v > breakout){
      firedAt = i; armedAt = null;                                  // 觸發後要重新打底
    }
  }
  state = firedAt === vals.length - 1 ? "fired" : (armedAt !== null ? "armed" : "idle");

  var last = vals.length ? vals[vals.length-1] : null;
  var reasons = [];
  if(state === "fired"){
    reasons.push("量縮打底後突破 " + (breakout/10000).toFixed(2) + " 兆");
    // 突破當天就已經爆到過熱區，值得講一句 —— 那正是「高檔爆量」長的樣子
    if(last > overheat) reasons.push("但同日已達 " + (overheat/10000).toFixed(2) + " 兆過熱區，留意是換手還是出貨");
  }

  return {
    state: state, lit: state === "fired", reasons: reasons,
    ready: vals.length > 0,
    last: last, armedSince: armedAt !== null ? armedDate : null,
    daysArmed: armedAt !== null ? (vals.length - 1 - armedAt) : null,
    thresholds: {quiet:quiet, breakout:breakout, overheat:overheat, armWindow:win}
  };
}

/* 只在「由不亮轉成亮」的那一天記一筆。
   每天亮就每天記的話，一段趨勢會產生幾十列，之後算命中率會被同一個訊號灌爆。 */
export function shouldLog(wasLit, isLit){ return !wasLit && isLit; }

export const DEFAULTS = {
  fx: { consecutiveDays:3, fastMA:5, slowMA:20 },
  volume: { quietBelow:7000, breakoutAbove:11000, overheatAbove:13000, armWindow:30 }
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

  // ── 量能兩段式狀態機 ──
  var V = function(arr){ return arr.map(function(v,i){
    return {date:"2026-09-"+String(i+1).padStart(2,"0"), total:v}; }); };

  // 沒打底就直接爆量 → 不該亮。這是整個狀態機存在的理由。
  ok("沒量縮直接突破 → 不亮（高檔爆量不是買訊）",
     evalVolume(V([9000,9500,10000,11500]), DEFAULTS).lit === false,
     evalVolume(V([9000,9500,10000,11500]), DEFAULTS).state);

  // 先打底再突破 → 亮
  var arm = evalVolume(V([9000,6500,8000,9000,11500]), DEFAULTS);
  ok("量縮打底後突破 → 亮", arm.lit === true && arm.state === "fired", arm);

  // 打底後還沒突破 → armed，不是 idle 也不是亮
  var waiting = evalVolume(V([9000,6500,8000,9000]), DEFAULTS);
  ok("打底後等待中 → armed", waiting.state === "armed" && waiting.lit === false, waiting);
  ok("armed 會記得從哪天開始", waiting.armedSince === "2026-09-02" && waiting.daysArmed === 2, waiting);

  // 待命過期：量縮之後太久才突破，不算
  var stale = [6500]; for(var q=0;q<40;q++) stale.push(9000); stale.push(11500);
  ok("量縮後超過 armWindow 才突破 → 不亮",
     evalVolume(V(stale), DEFAULTS).lit === false, evalVolume(V(stale), DEFAULTS).state);

  // 亮完要重新打底
  var again = evalVolume(V([6500,11500,9000,11800]), DEFAULTS);
  ok("亮過之後沒重新打底就再突破 → 不亮", again.lit === false, again.state);

  // 過熱區會加註但仍算亮
  var hot = evalVolume(V([6500,13500]), DEFAULTS);
  ok("突破當日直接爆到過熱區 → 亮但加註",
     hot.lit === true && hot.reasons.length === 2 && hot.reasons[1].indexOf("過熱") >= 0, hot.reasons);

  // 門檻可調：同一組資料換門檻結果要不同
  ok("門檻調高後同一組資料不亮",
     evalVolume(V([6500,11500]), {volume:{quietBelow:7000,breakoutAbove:12000,
       overheatAbove:13000,armWindow:30}}).lit === false);

  console.error(fails.length ? "\n✗ " + fails.length + " 項失敗" : "\n全部通過");
  return fails.length;
}

if(process.argv.includes("--self-test")) process.exit(selfTest() ? 1 : 0);
