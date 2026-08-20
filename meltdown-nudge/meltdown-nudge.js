/*!
 * meltdown-nudge — 小孩卡關／崩潰的時候跳出來喘口氣的小元件
 *
 * 從「ABC 字母大考驗」抽出來的。做兩件事：
 *   1. 連續失敗幾次就跳出一句話（可以自動從溫柔換成促咪）
 *   2. 太吵（哭鬧）也跳——只量麥克風的音量，不錄音、不上傳、不判斷內容
 * 跳出來的那句話會用語音念，念完停一秒自己關掉繼續，不用等小孩按。
 *
 * 沒有相依套件、沒有建置步驟，ES5 寫的，直接 <script> 引入就能用。
 *
 * 用法：
 *   var nudge = MeltdownNudge.create({ missStreak: 5, onResume: next });
 *   nudge.miss();     // 答錯
 *   nudge.hit();      // 答對（連錯歸零）
 *   nudge.listen();   // 開始聽音量（一定要在使用者手勢裡呼叫）
 *   nudge.mute();     // 停止聽
 *
 * 授權：MIT
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeltdownNudge = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CSS_ID = 'meltdown-nudge-css';
  var CSS = [
    '.mn-veil{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
    'justify-content:center;padding:24px;background:#FFF9F0;color:#40352B;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",',
    '"Microsoft JhengHei","Segoe UI",Roboto,sans-serif;animation:mn-in .18s ease-out}',
    '@keyframes mn-in{from{opacity:0}to{opacity:1}}',
    '.mn-box{width:100%;max-width:420px;text-align:center}',
    '.mn-emoji{font-size:72px;line-height:1;margin-bottom:14px}',
    '.mn-line{font-size:26px;font-weight:800;line-height:1.4;margin:0 0 26px}',
    '.mn-btn{display:block;width:100%;font-family:inherit;font-size:19px;font-weight:800;',
    'cursor:pointer;border-radius:999px;padding:16px 20px;border:2px solid transparent;',
    'background:#F09A2E;color:#fff;margin-bottom:10px}',
    '.mn-btn.mn-ghost{background:transparent;color:#8A7660;border-color:#F0E2CD;',
    'font-size:16px;width:auto;margin:0 auto;padding:12px 22px}',
    '.mn-btn:active{transform:translateY(1px)}',
    '@media (prefers-color-scheme:dark){',
    '.mn-veil{background:#241E19;color:#F7EDE0}',
    '.mn-btn{background:#FFC062;color:#2A211A}',
    '.mn-btn.mn-ghost{color:#C6B199;border-color:#47392C}}'
  ].join('');

  var DEFAULT_LINES = {
    soft: [['🫂', '沒關係，慢慢來'], ['🎥', '我要錄給老師看'], ['🧱', '生氣要扣樂高錢']],
    fun: [['📺', '哭哭浪費看電視時間喔'], ['📺', '認真！答完才能看電視喔']]
  };

  function ext(a, b) {
    var k;
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
    return a;
  }

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function create(opts) {
    opts = opts || {};

    var cfg = ext({
      // ── 什麼時候跳 ──
      missStreak: 5,        // 連續失敗幾次跳一次；0 = 不用連錯這條規則
      noise: null,          // { level, sustainMs, decay, cooldownMs }；null = 不開麥克風
                            // 預設 level 0.08、撐 1 秒就跳（亂叫一聲就會跳）
      // ── 說什麼 ──
      lines: null,          // { soft: [[emoji, 句子], …], fun: […] }
      tone: 'auto',         // 'auto'（先溫柔再促咪）| 'soft' | 'fun'
      softTimes: 2,         // auto 模式下，前幾次用溫柔的
      // ── 聲音 ──
      speak: true,
      lang: 'zh-TW',
      rate: 1, pitch: 1, volume: 1,
      // ── 節奏 ──
      autoResumeMs: 1000,   // 念完停多久自己繼續；null / 0 = 一定要按按鈕
      failSafeMs: 9000,     // 語音卡住的保險，時間到就自己走
      // ── 文字 ──
      goText: '再試一次 💪',
      stopText: '今天先到這裡',   // 空字串 = 不顯示這顆
      // ── 事件 ──
      onShow: null,         // fn({ reason: 'miss' | 'noise' | 'manual', tone, line })
      onResume: null,       // 使用者（或自動）選擇繼續
      onStop: null,         // 使用者選擇今天先到這裡
      onError: null         // fn(code, message)；code: 'mic'
    }, opts);

    var lines = cfg.lines || DEFAULT_LINES;
    var noise = cfg.noise ? ext({ level: 0.08, sustainMs: 1000, decay: 0.35,
                                  cooldownMs: 90000, tickMs: 150 }, cfg.noise) : null;

    var shown = 0;                 // 總共跳過幾次（決定語氣）
    var missRun = 0;               // 目前連續失敗幾次
    var pos = {};                  // 每一組講到第幾句
    var veil = null, timers = [], closing = false, reason = 'manual';
    var mic = { stream: null, ctx: null, an: null, buf: null, timer: null,
                loud: 0, peak: 0, level: 0, muteUntil: 0, owned: false };
    var dead = false;

    /* ────────── 說話 ────────── */
    function canSpeak() {
      return cfg.speak && typeof window !== 'undefined' &&
             !!window.speechSynthesis && !!window.SpeechSynthesisUtterance;
    }
    function pickVoice() {
      var vs = [];
      try { vs = window.speechSynthesis.getVoices() || []; } catch (e) {}
      var want = String(cfg.lang || '').toLowerCase();
      var base = want.split('-')[0];
      var exact = null, loose = null, i, l;
      for (i = 0; i < vs.length; i++) {
        l = String(vs[i].lang || '').toLowerCase().replace('_', '-');
        if (!exact && l === want) exact = vs[i];
        if (!loose && l.split('-')[0] === base) loose = vs[i];
      }
      return exact || loose || null;
    }
    function say(text, onEnd) {
      if (!canSpeak()) { if (onEnd) setTimeout(onEnd, 0); return; }
      var fired = false;
      function done() { if (!fired) { fired = true; if (onEnd) onEnd(); } }
      try {
        var ss = window.speechSynthesis;
        if (ss.speaking || ss.pending) ss.cancel();
        var u = new window.SpeechSynthesisUtterance(text);
        var v = pickVoice();
        if (v) u.voice = v;
        u.lang = (v && v.lang) || cfg.lang;
        u.rate = cfg.rate; u.pitch = cfg.pitch; u.volume = cfg.volume;
        u.onend = done; u.onerror = done;
        ss.speak(u);
        try { ss.resume(); } catch (e2) {}
      } catch (e) { done(); }
    }
    function hush() {
      if (!canSpeak()) return;
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }

    /* ────────── 挑句子 ────────── */
    function toneNow() {
      if (cfg.tone !== 'auto') return cfg.tone;
      return shown <= cfg.softTimes ? 'soft' : 'fun';
    }
    function nextLine() {
      var tone = toneNow();
      var list = lines[tone] || lines.soft || DEFAULT_LINES.soft;
      if (!list.length) list = DEFAULT_LINES.soft;
      var i = pos[tone] || 0;
      pos[tone] = (i + 1) % list.length;
      return { tone: tone, item: list[i] };
    }

    /* ────────── 畫面 ────────── */
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function clearTimers() {
      for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
      timers = [];
    }

    function close(go) {
      if (closing || !veil) return;
      closing = true;
      clearTimers();
      hush();
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      veil = null;
      if (go) { if (cfg.onResume) cfg.onResume(); }
      else if (cfg.onStop) cfg.onStop();
    }

    function show(why) {
      if (dead || veil) return;
      injectCss();
      reason = why || 'manual';
      shown++;
      closing = false;
      var pickd = nextLine();
      var emoji = pickd.item[0], text = pickd.item[1];

      veil = document.createElement('div');
      veil.className = 'mn-veil';
      veil.setAttribute('role', 'dialog');
      veil.setAttribute('aria-modal', 'true');
      veil.setAttribute('aria-label', text);

      var box = document.createElement('div');
      box.className = 'mn-box';

      var e = document.createElement('div');
      e.className = 'mn-emoji';
      e.textContent = emoji;

      var p = document.createElement('p');
      p.className = 'mn-line';
      p.textContent = text;                       // 一律用 textContent，不吃 HTML

      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'mn-btn';
      go.textContent = cfg.goText;
      go.addEventListener('click', function () { close(true); });

      box.appendChild(e); box.appendChild(p); box.appendChild(go);

      if (cfg.stopText) {
        var stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'mn-btn mn-ghost';
        stop.textContent = cfg.stopText;
        stop.addEventListener('click', function () { close(false); });
        box.appendChild(stop);
      }

      veil.appendChild(box);
      document.body.appendChild(veil);
      go.focus();

      if (cfg.onShow) cfg.onShow({ reason: reason, tone: pickd.tone, line: text });

      // 念給他聽，念完停一下自己繼續；沒設 autoResumeMs 就一定要按
      if (cfg.autoResumeMs) {
        say(text, function () { later(function () { close(true); }, cfg.autoResumeMs); });
        later(function () { close(true); }, cfg.failSafeMs);
      } else {
        say(text, null);
      }
    }

    /* ────────── 麥克風：只量音量 ────────── */
    function micLevel() {
      if (!mic.an) return 0;
      mic.an.getByteTimeDomainData(mic.buf);
      var sum = 0, i, v;
      for (i = 0; i < mic.buf.length; i++) {
        v = (mic.buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / mic.buf.length);
    }

    function micTick() {
      var lv = micLevel();
      mic.level = lv;
      if (lv > mic.peak) mic.peak = lv;
      if (!noise || veil) return;
      // 哭是一陣一陣的，中間換氣不該歸零：吵的時候加、安靜的時候慢慢退
      mic.loud = Math.max(0, mic.loud +
        (lv >= noise.level ? noise.tickMs : -noise.tickMs * noise.decay));
      var now = Date.now();
      if (mic.loud < noise.sustainMs || now < mic.muteUntil) return;
      mic.loud = 0;
      mic.muteUntil = now + noise.cooldownMs;
      show('noise');
    }

    function listen(onFail) {
      if (dead || mic.stream) return;
      var md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        fail('mic', '這個環境沒有 mediaDevices：網址必須是 https（或 localhost）', onFail);
        return;
      }
      md.getUserMedia({ audio: true }).then(function (st) {
        if (dead) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
        mic.stream = st;
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!mic.ctx) { mic.ctx = cfg.audioContext || new AC(); mic.owned = !cfg.audioContext; }
          if (mic.ctx.state === 'suspended') mic.ctx.resume();
          var src = mic.ctx.createMediaStreamSource(st);
          var an = mic.ctx.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);                       // 只接到 analyser，不接喇叭，不會有回音
          mic.an = an;
          mic.buf = new Uint8Array(an.fftSize);
          mic.timer = setInterval(micTick, (noise && noise.tickMs) || 150);
        } catch (e) {
          mute();
          fail('mic', '讀不到音量：' + e.message, onFail);
        }
      })['catch'](function (e) {
        fail('mic', '沒拿到麥克風權限（' + (e && e.name) + '）', onFail);
      });
    }

    function fail(code, msg, onFail) {
      if (onFail) onFail(msg);
      if (cfg.onError) cfg.onError(code, msg);
    }

    function mute() {
      if (mic.timer) { clearInterval(mic.timer); mic.timer = null; }
      if (mic.stream) {
        mic.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
        mic.stream = null;
      }
      if (mic.ctx && mic.owned) { try { mic.ctx.close(); } catch (e) {} mic.ctx = null; }
      mic.an = null; mic.loud = 0; mic.level = 0;
    }

    /* ────────── 對外 ────────── */
    var api = {
      // 答錯 / 失敗一次。連續次數到了就跳
      miss: function () {
        if (dead) return false;
        missRun++;
        if (cfg.missStreak && missRun >= cfg.missStreak && !veil) {
          missRun = 0;
          show('miss');
          return true;
        }
        return false;
      },
      // 答對 / 成功一次，連續次數歸零
      hit: function () { missRun = 0; },
      // 手動跳一次（測試或自己判斷的時候用）
      show: function () { show('manual'); },
      // 手動關掉：go = true 代表「繼續」
      close: function (go) { close(go !== false); },
      listen: listen,
      mute: mute,
      // 現在的音量 0～1，拿來畫音量條
      level: function () { return mic.level; },
      // 開始聽之後量到的最大音量，設定門檻的時候很好用
      peak: function () { return mic.peak; },
      resetPeak: function () { mic.peak = 0; },
      isOpen: function () { return !!veil; },
      isListening: function () { return !!mic.stream; },
      // 改設定（例如使用者在設定畫面調門檻）
      set: function (patch) {
        patch = patch || {};
        ext(cfg, patch);
        if (patch.lines) lines = patch.lines;
        // noise: null 要真的關掉，所以用 hasOwnProperty 判斷而不是看真假值
        if (Object.prototype.hasOwnProperty.call(patch, 'noise')) {
          noise = patch.noise
            ? ext(noise || { level: 0.08, sustainMs: 1000, decay: 0.35,
                             cooldownMs: 90000, tickMs: 150 }, patch.noise)
            : null;
          if (!noise) mute();
        }
      },
      config: function () { return cfg; },
      destroy: function () {
        dead = true;
        clearTimers();
        mute();
        if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
        veil = null;
      }
    };
    return api;
  }

  return { create: create, version: '1.0.0' };
}));
