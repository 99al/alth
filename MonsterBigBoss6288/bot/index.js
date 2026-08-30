const fs = require('fs');
const path = require('path');
const express = require('express');
const { login } = require('ws3-fca');
const { loadCommands, handleMessage, handleEvent } = require('./main');

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/', (req, res) => {
  res.json({
    status: botApi ? '🟢 بوت مستر يعمل' : '🔴 جاري إعادة الاتصال...',
    bot: 'مستر',
    loggedIn: !!botApi,
    uptime: Math.floor(process.uptime()) + ' ثانية',
    reconnectAttempts,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => res.send('pong - مستر حي ويعمل 💀'));

// endpoint لإعادة الاتصال فقط (بعد حفظ الكوكيز من خارج)
// debounce: نتجاهل أي طلب خلال 10 ثوان من آخر طلب
let lastReconnectRequest = 0;
app.post('/reconnect', (req, res) => {
  const now = Date.now();
  if (now - lastReconnectRequest < 10000) {
    console.log('[مستر] ⏸️ طلب إعادة اتصال مُجمَّد (10 ثوان cooldown)');
    res.json({ success: true, message: 'طلب مُسجَّل — سيُطبَّق خلال قليل' });
    return;
  }
  lastReconnectRequest = now;
  console.log('[مستر] 🔄 طلب إعادة اتصال وارد');
  res.json({ success: true, message: 'جاري إعادة الاتصال...' });
  // تأخير 3 ثوان للتأكد من اكتمال حفظ الملف ثم إعادة الاتصال
  setTimeout(() => scheduleRestart(3000), 200);
});

app.get('/testsend', async (req, res) => {
  const threadID = req.query.thread;
  if (!threadID || !botApi) return res.status(400).json({ error: 'bot not ready' });
  try {
    await botApi.sendMessage('💀 تجريبة إرسال', threadID);
    res.json({ success: true, threadID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/updatecookies', express.json(), (req, res) => {
  const appstatePath = path.join(__dirname, 'appstate.json');
  try {
    const cookies = req.body;
    if (!Array.isArray(cookies) || cookies.length === 0)
      return res.status(400).json({ error: 'Invalid cookies format.' });
    fs.writeFileSync(appstatePath, JSON.stringify(cookies, null, 2));
    console.log('[مستر] ✅ تم تحديث الكوكيز عبر HTTP');
    res.json({ success: true, message: 'Cookies updated. Reconnecting...' });
    scheduleRestart(3000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[مستر] 🌐 خادم Uptime يعمل على المنفذ ${PORT}`);
});

let botApi = null;
let msgEmitter = null;
let isRestarting = false;
let reconnectAttempts = 0;
let botUserID = null;
let botStartTime = Date.now();
let msgCount = 0;

// ─── كتابة حالة البوت إلى ملف مشترك ───
function writeBotState(loggedIn, extra = {}) {
  try {
    const stateFile = path.join(__dirname, 'bot-state.json');
    const state = {
      loggedIn,
      userID: botUserID,
      userName: null,
      uptime: Math.floor((Date.now() - botStartTime) / 1000),
      reconnectAttempts,
      lastUpdated: new Date().toISOString(),
      status: loggedIn ? 'متصل' : 'غير متصل',
      ...extra
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {}
}

// تحديث دوري للحالة كل 10 ثواني
setInterval(() => writeBotState(!!botApi), 10000);

// ─── Heartbeat كل 30 ثانية ───
let heartbeatInterval = null;
function startHeartbeat(api) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    try {
      if (api && api.getCurrentUserID) {
        api.getCurrentUserID();
        console.log('[مستر] 💓 Heartbeat');
      }
    } catch (e) {
      console.error('[مستر] ⚠️ Heartbeat failed:', e.message);
    }
  }, 30000);
}

// ─── تنظيف الذاكرة كل 10 دقائق ───
function startMemorySweeper(api) {
  setInterval(() => {
    try {
      if (api && api._msgQueue && Array.isArray(api._msgQueue)) api._msgQueue = [];
      if (api && api._messageCache) {
        const keys = Object.keys(api._messageCache);
        if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(k => delete api._messageCache[k]);
      }
      if (api && api._threadCache) {
        const keys = Object.keys(api._threadCache);
        if (keys.length > 20) keys.slice(0, keys.length - 20).forEach(k => delete api._threadCache[k]);
      }
      if (typeof global.gc === 'function') global.gc();
      console.log('[SYSTEM] 🟢 تنظيف الذاكرة');
    } catch (e) {}
  }, 10 * 60 * 1000);
}

// ─── حفظ appstate بشكل متكرر لتجديد الجلسة تلقائياً ───
// فيسبوك يجدد tokens الجلسة (xs, fr) باستمرار — حفظها دورياً يمنع انتهاء الصلاحية
let appstateSaverInterval = null;

// ─── صمّام الأمان العالمي: لا يموت البوت أبداً ───
// Register handlers after all state variables are initialized. This keeps a
// startup dependency error from causing a second temporal-dead-zone error.
process.on('uncaughtException', (err) => {
  console.error('[مستر] 🔴 خطأ غير متوقع:', err && err.message ? err.message : String(err));
  console.log('[مستر] 🟢 استمرار... إعادة الاتصال خلال 10 ثواني');
  isRestarting = false;
  scheduleRestart(10000);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (msg.includes('Cookie not in this host') || msg.includes("host's domain")) {
    console.warn('[مستر] ⚠️ تحذير cookie domain (ws3-fca) — تجاهل بدون إعادة تشغيل');
    return;
  }
  console.error('[مستر] 🔴 وعد غير معالج:', msg);
  console.log('[مستر] 🟢 إعادة الاتصال خلال 15 ثانية');
  isRestarting = false;
  scheduleRestart(15000);
});

process.on('SIGTERM', () => {
  console.log('[مستر] ⚠️ استلمت SIGTERM — البوت يتجاهلها ويكمل');
});

process.on('SIGHUP', () => {
  console.log('[مستر] ⚠️ استلمت SIGHUP — البوت يتجاهلها ويكمل');
});

function saveAppstate(api, reason) {
  try {
    const state = api.getAppState();
    if (state && state.length > 0) {
      fs.writeFileSync(path.join(__dirname, 'appstate.json'), JSON.stringify(state, null, 2));
      if (reason) console.log(`[مستر] 💾 تم تجديد الجلسة (${reason})`);
    }
  } catch (e) {
    console.error('[مستر] ⚠️ فشل حفظ appstate:', e.message);
  }
}

function startAppstateSaver(api) {
  if (appstateSaverInterval) clearInterval(appstateSaverInterval);
  // حفظ كل 5 دقائق بدل 30 — يضمن دائماً أحدث tokens
  appstateSaverInterval = setInterval(() => saveAppstate(api, 'دوري'), 5 * 60 * 1000);
  console.log('[مستر] ⏱️ تجديد الجلسة كل 5 دقائق مفعّل');
}

// ─── المحرك الرئيسي: يعيد المحاولة دائماً ───
function startBot() {
  if (isRestarting) return;

  const appstatePath = path.join(__dirname, 'appstate.json');

  // لو الملف مش موجود → ننتظر ونحاول مجدداً
  if (!fs.existsSync(appstatePath)) {
    console.error('[مستر] ❌ appstate.json غير موجود — إعادة المحاولة بعد 30 ثانية');
    setTimeout(startBot, 30000);
    return;
  }

  let appstate;
  try {
    appstate = JSON.parse(fs.readFileSync(appstatePath, 'utf8'));
  } catch (e) {
    console.error('[مستر] ❌ خطأ في قراءة appstate.json:', e.message, '— إعادة بعد 30 ثانية');
    setTimeout(startBot, 30000);
    return;
  }

  console.log('[مستر] 🚀 جاري تسجيل الدخول...');

  login(
    { appState: appstate },
    {
      listenEvents: true,
      selfListen: false,
      autoMarkDelivery: false,
      autoMarkRead: false,
      forceLogin: false,
      autoReconnect: true,
      online: true
    },
    (err, api) => {
      if (err) {
        const errStr = JSON.stringify(err);
        console.error('[مستر] ❌ فشل تسجيل الدخول:', errStr);
        const errMsg = String(err.message || err.error || errStr);

        // فيسبوك حظر الجلسة → انتظر 5 دقائق
        if (errMsg.includes('retrieving userID') || errMsg.includes('blocked') || errMsg.includes('unknown location') || errMsg.includes('checkpoint')) {
          console.log('[مستر] 🔴 checkpoint أو حظر — إعادة بعد 5 دقائق');
          isRestarting = false;
          setTimeout(startBot, 5 * 60 * 1000);
          return;
        }

        // أي خطأ آخر → انتظر مع backoff (15ث → 30ث → 60ث → 120ث max)
        reconnectAttempts++;
        const delay = Math.min(15000 * reconnectAttempts, 120000);
        console.log(`[مستر] ⏳ إعادة بعد ${delay / 1000}ث (محاولة ${reconnectAttempts})`);
        isRestarting = false;
        setTimeout(startBot, delay);
        return;
      }

      console.log('[مستر] ✅ تم تسجيل الدخول!');
      isRestarting = false;
      reconnectAttempts = 0;
      botApi = api;

      // استخراج ID الحساب وكتابة الحالة
      try {
        botUserID = api.getCurrentUserID ? api.getCurrentUserID() : null;
      } catch (e) {}
      writeBotState(true, { status: 'متصل ويعمل' });

      // حفظ فوري للـ appstate
      try {
        const state = api.getAppState();
        if (state && state.length > 0)
          fs.writeFileSync(appstatePath, JSON.stringify(state, null, 2));
        console.log('[مستر] 💾 تم تحديث appstate.json');
      } catch (e) {}

      const ctx = api.ctx;
      if (ctx && ctx.lastSeqId) {
        ctx.firstListen = true;
        console.log(`[مستر] 🔑 Sequence ID: ${ctx.lastSeqId}`);
      } else {
        console.log('[مستر] ⚠️ لم يُعثر على irisSeqID');
      }

      loadCommands();
      startListening(api);
      startHeartbeat(api);
      startMemorySweeper(api);
      startAppstateSaver(api);

      // استئناف حلقات القصف بعد إعادة الاتصال
      try {
        const { commands } = require('./main');
        const qasf = commands.get('قصف');
        if (qasf && qasf.resumeAll) qasf.resumeAll(api);
      } catch (e) {
        console.error('[مستر] خطأ في استئناف القصف:', e.message);
      }

      console.log('[مستر] 🤖 البوت "مستر" يعمل — لا يتوقف أبداً 💀');
      console.log('[مستر] ─────────────────────────────────');
      console.log('[مستر] 📋 الأوامر المتاحة:');
      console.log('[مستر]   • قصف / قصف ايقاف');
      console.log('[مستر]   • كاتش / مجموعة / جروب');
      console.log('[مستر]   • رد [كلمة]» [رد]');
      console.log('[مستر]   • يوت [اسم المقطع]');
      console.log('[مستر] ─────────────────────────────────');
    }
  );
}

// ─── مستمع الأحداث ───
async function startListening(api) {
  try {
    const callback = (err, event) => {
      if (err) {
        console.error('[مستر] ⚠️ خطأ في الاستماع:', JSON.stringify(err));
        const errMsg = String(err.message || err.error || err);

        // أخطاء جلسة → أعد تسجيل الدخول
        if (errMsg.includes('Not logged in') || errMsg.includes('sequence ID') ||
            errMsg.includes('appstate') || errMsg.includes('Failed to get')) {
          scheduleRestart(15000);
        } else {
          scheduleRestart(5000);
        }
        return;
      }

      if (!event) return;
      try {
        const type = event.type || 'unknown';
        const threadID = String(event.threadID || '');
        const senderID = String(event.senderID || '');
        const body = (event.body || '').substring(0, 50);
        if (type !== 'typ' && type !== 'read_receipt') {
          console.log(`[مستر] 📩 type=${type} thread=${threadID} sender=${senderID} body="${body}"`);
        }
        if (type === 'message' || type === 'message_reply') {
          handleMessage(api, event);
        } else {
          handleEvent(api, event);
        }
        // حفظ الجلسة بعد كل 10 رسائل لضمان تجديد الـ tokens
        msgCount++;
        if (msgCount % 10 === 0) saveAppstate(api, `بعد ${msgCount} رسالة`);
      } catch (e) {
        console.error('[مستر] ⚠️ خطأ في معالجة الحدث:', e.message);
      }
    };

    msgEmitter = await api.listenMqtt(callback);
    console.log('[مستر] 👂 البوت يستمع...');
  } catch (e) {
    console.error('[مستر] ❌ استثناء في startListening:', e.message);
    scheduleRestart(10000);
  }
}

// ─── جدولة إعادة الاتصال: لا تُكرر إذا كانت جارية ───
function scheduleRestart(delay) {
  // ⚠️ لا نتجاهل الطلب إذا أتى من uncaughtException — isRestarting تُعاد ضبطها قبل الاستدعاء
  if (isRestarting) return;
  isRestarting = true;

  try { if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } } catch (e) {}
  try { if (appstateSaverInterval) { clearInterval(appstateSaverInterval); appstateSaverInterval = null; } } catch (e) {}
  try { if (msgEmitter && typeof msgEmitter.stop === 'function') msgEmitter.stop(); } catch (e) {}

  msgEmitter = null;
  botApi = null;
  writeBotState(false);

  // تأخير ثابت بحد أقصى 120 ثانية — لا مضاعفة تتراكم عبر جلسات ناجحة
  const actualDelay = Math.min(delay, 120000);
  reconnectAttempts++;
  console.log(`[مستر] ⏳ إعادة الاتصال بعد ${actualDelay / 1000}ث (محاولة ${reconnectAttempts})`);

  setTimeout(() => {
    isRestarting = false;
    startBot();
  }, actualDelay);
}

startBot();
