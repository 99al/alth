const fs = require('fs');
const path = require('path');
const express = require('express');
const { login } = require('ws3-fca');
const { loadCommands, handleMessage, handleEvent, cancelActiveNameLoops } = require('./main');
const security = require('./security.cjs');

const PORT = process.env.PORT || 3000;
const app = express();

const authRateLimiter = security.createLoginRateLimiter({
  windowMs: 15 * 60 * 1000,
  globalMaxAttempts: 20,
});

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>دخول لوحة البوت</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 12vh auto; padding: 0 1rem; }
    input, button { box-sizing: border-box; width: 100%; padding: .75rem; margin-top: .75rem; }
    #message { min-height: 1.5em; }
  </style>
</head>
<body>
  <main>
    <h1>دخول لوحة البوت</h1>
    <form id="login-form">
      <label for="password">كلمة المرور</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="512">
      <button type="submit">دخول</button>
      <p id="message" role="status" aria-live="polite"></p>
    </form>
  </main>
  <script>
    const form = document.getElementById('login-form');
    const message = document.getElementById('message');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = 'جارٍ التحقق…';
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: form.elements.password.value })
        });
        if (response.ok) {
          window.location.reload();
          return;
        }
        message.textContent = response.status === 429
          ? 'محاولات كثيرة. حاول لاحقًا.'
          : response.status === 403
            ? 'تعذر التحقق من مصدر الطلب.'
            : 'تعذر تسجيل الدخول.';
      } catch {
        message.textContent = 'تعذر إكمال الطلب.';
      }
    });
  </script>
</body>
</html>`;

const AUTHENTICATED_STATUS_HTML = Object.freeze({
  running: '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>حالة البوت</title><h1>حالة البوت</h1><p>البوت يعمل.</p></html>',
  reconnecting: '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>حالة البوت</title><h1>حالة البوت</h1><p>البوت غير متصل حاليًا.</p></html>',
});

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function checkAuthAttemptLimit(res) {
  const attempt = authRateLimiter.attempt();
  if (attempt.allowed) return true;
  res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
  res.status(429).json({ error: 'Too many authentication attempts.' });
  return false;
}

function checkLoginAttemptLimit(req, res, next) {
  if (!checkAuthAttemptLimit(res)) return;
  next();
}

function requireAllowedOrigin(req, res) {
  if (security.isAllowedOrigin(req.headers.origin)) return true;
  res.status(403).json({ error: 'Request origin is not allowed.' });
  return false;
}

function validateAuthMutation(req, res, next) {
  setNoStore(res);
  if (!requireAllowedOrigin(req, res)) return;
  next();
}

function respondWithSafeRequestError(err, req, res, next) {
  if (res.headersSent) return;
  setNoStore(res);
  res.status(400).json({ error: 'Invalid request.' });
}

app.get('/api/auth/session', (req, res) => {
  setNoStore(res);
  return res.json({
    authenticated: security.authIsConfigured() &&
      security.hasValidSessionCookie(req.headers.cookie),
  });
});

app.post('/api/auth/login', validateAuthMutation, checkLoginAttemptLimit, express.json({ limit: '2kb' }), (req, res) => {
  if (!security.authIsConfigured()) {
    return res.status(503).json({ error: 'Authentication unavailable.' });
  }
  if (!security.passwordMatches(req.body && req.body.password)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  res.setHeader('Set-Cookie', security.createSessionCookieHeader());
  return res.json({ authenticated: true });
});

app.post('/api/auth/logout', validateAuthMutation, (req, res) => {
  res.setHeader('Set-Cookie', security.clearSessionCookieHeader());
  return res.json({ authenticated: false });
});



let botApi = null;
let msgEmitter = null;
let isRestarting = false;
let reconnectAttempts = 0;
let botUserID = null;
let botStartTime = Date.now();
let msgCount = 0;
let heartbeatInterval = null;
let appstateSaverInterval = null;
let lastReconnectRequest = 0;

function requireDashboardAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');

  if (!security.authIsConfigured()) {
    return res.status(503).json({ error: 'Dashboard authentication is not configured.' });
  }
  if (!security.hasValidSessionCookie(req.headers.cookie)) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!security.isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  next();
}

app.get('/', (req, res) => {
  setNoStore(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const authenticated = security.authIsConfigured() &&
    security.hasValidSessionCookie(req.headers.cookie);
  if (!authenticated) return res.send(LOGIN_PAGE_HTML);
  return res.send(botApi ? AUTHENTICATED_STATUS_HTML.running : AUTHENTICATED_STATUS_HTML.reconnecting);
});

app.get('/ping', (req, res) => {
  res.send('pong - الث حي ويعمل 💀');
});

app.post('/reconnect', requireDashboardAuth, (req, res) => {
  const now = Date.now();

  if (now - lastReconnectRequest < 10000) {
    console.log('[الث] ⏸️ طلب إعادة اتصال مُجمّد');
    return res.json({
      success: true,
      message: 'طلب مُسجّل'
    });
  }

  lastReconnectRequest = now;

  console.log('[الث] 🔄 طلب إعادة اتصال وارد');

  res.json({
    success: true,
    message: 'جاري إعادة الاتصال...'
  });

  setTimeout(() => scheduleRestart(3000), 200);
});

app.get('/testsend', requireDashboardAuth, async (req, res) => {
  const threadID = req.query.thread;

  if (!threadID || !botApi) {
    return res.status(400).json({
      error: 'bot not ready'
    });
  }

  try {
    await botApi.sendMessage(
      '💀 تجربة إرسال',
      threadID
    );

    res.json({
      success: true
    });
  } catch {
    res.status(500).json({
      error: 'تعذر إرسال رسالة الاختبار.'
    });
  }
});

app.post('/updatecookies', requireDashboardAuth, express.json({ limit: '256kb' }), (req, res) => {
  if (!security.canWriteAppstate()) {
    return res.status(409).json({ error: security.appstateUpdateConflictMessage() });
  }

  try {
    const cookies = req.body;

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({
        error: 'Invalid cookies format.'
      });
    }

    security.writeAppstate(cookies);

    console.log(
      '[الث] ✅ تم تحديث الكوكيز عبر HTTP'
    );

    res.json({
      success: true,
      message: 'Cookies updated. Reconnecting...'
    });

    scheduleRestart(3000);
  } catch {
    res.status(500).json({
      error: 'تعذر تحديث جلسة البوت.'
    });
  }
});
app.use(respondWithSafeRequestError);

app.listen(PORT, () => {
  console.log(
    `[الث] 🌐 خادم Uptime يعمل على المنفذ ${PORT}`
  );
});

function writeBotState(loggedIn, extra = {}) {
  try {
    const stateFile = path.join(
      __dirname,
      'bot-state.json'
    );

    const state = {
      loggedIn,
      userID: botUserID,
      userName: null,
      uptime: Math.floor(
        (Date.now() - botStartTime) / 1000
      ),
      reconnectAttempts,
      lastUpdated: new Date().toISOString(),
      status: loggedIn
        ? 'متصل'
        : 'غير متصل',
      ...extra
    };

    fs.writeFileSync(
      stateFile,
      JSON.stringify(state, null, 2)
    );
  } catch (e) {}
}

setInterval(() => {
  writeBotState(!!botApi);
}, 10000);

function startHeartbeat(api) {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(() => {
    try {
      if (
        api &&
        typeof api.getCurrentUserID === 'function'
      ) {
        api.getCurrentUserID();
        console.log('[الث] 💓 Heartbeat');
      }
    } catch (e) {
      console.error(
        '[الث] ⚠️ Heartbeat failed (تفاصيل الخطأ محجوبة)'
      );
    }
  }, 30000);
}

function startMemorySweeper(api) {
  setInterval(() => {
    try {
      if (
        api &&
        api._msgQueue &&
        Array.isArray(api._msgQueue)
      ) {
        api._msgQueue = [];
      }

      if (api && api._messageCache) {
        const keys = Object.keys(
          api._messageCache
        );

        if (keys.length > 50) {
          keys
            .slice(0, keys.length - 50)
            .forEach(k => {
              delete api._messageCache[k];
            });
        }
      }

      if (api && api._threadCache) {
        const keys = Object.keys(
          api._threadCache
        );

        if (keys.length > 20) {
          keys
            .slice(0, keys.length - 20)
            .forEach(k => {
              delete api._threadCache[k];
            });
        }
      }

      if (typeof global.gc === 'function') {
        global.gc();
      }

      console.log('[SYSTEM] 🟢 تنظيف الذاكرة');
    } catch (e) {}
  }, 10 * 60 * 1000);
}

function saveAppstate(api, reason) {
  try {
    if (!security.canPersistAppstate()) return;

    if (
      !api ||
      typeof api.getAppState !== 'function'
    ) {
      return;
    }

    const state = api.getAppState();

    if (state && state.length > 0) {
      security.persistAppstate(state);

      if (reason) {
        console.log(
          `[الث] 💾 تم تجديد الجلسة (${reason})`
        );
      }
    }
  } catch (e) {
    console.error(
      '[الث] ⚠️ فشل حفظ appstate (تفاصيل الخطأ محجوبة)'
    );
  }
}

function startAppstateSaver(api) {
  if (!security.canPersistAppstate()) return;

  if (appstateSaverInterval) {
    clearInterval(appstateSaverInterval);
  }

  appstateSaverInterval = setInterval(() => {
    saveAppstate(api, 'دوري');
  }, 5 * 60 * 1000);

  console.log(
    '[الث] ⏱️ تجديد الجلسة كل 5 دقائق مفعّل'
  );
}

process.on('uncaughtException', () => {
  console.error(
    '[الث] 🔴 خطأ غير متوقع (تفاصيل الخطأ محجوبة)'
  );

  console.log(
    '[الث] 🟢 استمرار... إعادة الاتصال خلال 10 ثواني'
  );

  isRestarting = false;
  scheduleRestart(10000);
});

process.on('unhandledRejection', () => {
  console.error(
    '[الث] 🔴 وعد غير معالج (تفاصيل السبب محجوبة)'
  );

  isRestarting = false;
  scheduleRestart(15000);
});

process.on('SIGTERM', () => {
  cancelActiveNameLoops();
  console.log(
    '[الث] ⚠️ استلمت SIGTERM — البوت يكمل'
  );
});

process.on('SIGHUP', () => {
  cancelActiveNameLoops();
  console.log(
    '[الث] ⚠️ استلمت SIGHUP — البوت يكمل'
  );
});

function startBot() {
  if (isRestarting) return;

  let appstate;

  try {
    appstate = security.loadAppstate().appstate;
  } catch (e) {
    console.error(
      '[الث] ❌ تعذر تحميل إعداد الجلسة (تفاصيل الخطأ محجوبة)'
    );

    setTimeout(startBot, 30000);
    return;
  }

  console.log(
    '[الث] 🚀 جاري تسجيل الدخول...'
  );

  login(
    {
      appState: appstate
    },
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
        console.error(
          '[الث] ❌ فشل تسجيل الدخول (تفاصيل الخطأ محجوبة)'
        );

        const errMsg = String(
          err.message ||
          err.error ||
          err
        );

        if (
          errMsg.includes(
            'retrieving userID'
          ) ||
          errMsg.includes('blocked') ||
          errMsg.includes(
            'unknown location'
          ) ||
          errMsg.includes('checkpoint')
        ) {
          console.log(
            '[الث] 🔴 checkpoint أو حظر — إعادة بعد 5 دقائق'
          );

          isRestarting = false;

          setTimeout(
            startBot,
            5 * 60 * 1000
          );

          return;
        }

        reconnectAttempts++;

        const delay = Math.min(
          15000 * reconnectAttempts,
          120000
        );

        console.log(
          `[الث] ⏳ إعادة بعد ${delay / 1000}ث`
        );

        isRestarting = false;

        setTimeout(
          startBot,
          delay
        );

        return;
      }

      console.log(
        '[الث] ✅ تم تسجيل الدخول!'
      );

      isRestarting = false;
      reconnectAttempts = 0;
      botApi = api;

      try {
        if (
          typeof api.getCurrentUserID ===
          'function'
        ) {
          botUserID =
            api.getCurrentUserID();
        }
      } catch (e) {}

      writeBotState(true, {
        status: 'متصل ويعمل'
      });

      if (security.canPersistAppstate()) try {
        if (
          typeof api.getAppState ===
          'function'
        ) {
          const state =
            api.getAppState();

          if (
            state &&
            state.length > 0
          ) {
            security.persistAppstate(state);
          }
        }

        console.log('[الث] 💾 تم تحديث نسخة الجلسة المحلية');
      } catch (e) {}

      const ctx = api.ctx;

      if (ctx && ctx.lastSeqId) {
        ctx.firstListen = true;

        console.log(
          '[الث] 🔑 تم العثور على Sequence ID (القيمة محجوبة)'
        );
      } else {
        console.log(
          '[الث] ⚠️ لم يُعثر على irisSeqID'
        );
      }

      loadCommands();

      startListening(api);

      startHeartbeat(api);

      startMemorySweeper(api);

      startAppstateSaver(api);

      try {
        const {
          commands
        } = require('./main');

        const wis =
          commands.get('ويس');

        if (
          wis &&
          typeof wis.resumeAll ===
          'function'
        ) {
          wis.resumeAll(api);
        }
      } catch (e) {
        console.error(
          '[الث] خطأ في استئناف ويس (تفاصيل الخطأ محجوبة)'
        );
      }

      console.log(
        '[الث] 🤖 البوت "الث" يعمل — لا يتوقف أبداً 💀'
      );

      console.log(
        '[الث] ─────────────────────────────────'
      );

      console.log(
        '[الث] 📋 الأوامر المتاحة:'
      );

      console.log(
        '[الث]   • ويس / ويس ايقاف'
      );

      console.log(
        '[الث]   • هويه [الكنية]'
      );

      console.log(
        '[الث]   • ايقاف الاسم / إيقاف الاسم'
      );

      console.log(
        '[الث]   • قروب [اسم المجموعة]'
      );

      console.log(
        '[الث]   • جريد [من] [إلى] [رسالة] / جريد ايقاف'
      );

      console.log(
        '[الث]   • رد [كلمة]» [رد]'
      );

      console.log(
        '[الث]   • يوت [اسم المقطع]'
      );

      console.log(
        '[الث] ─────────────────────────────────'
      );
    }
  );
}

async function startListening(api) {
  try {

    const callback = (err, event) => {

      if (err) {

        cancelActiveNameLoops();

        console.error(
          '[الث] ⚠️ خطأ في الاستماع (تفاصيل الخطأ محجوبة)'
        );

        const errMsg = String(
          err.message ||
          err.error ||
          err
        );

        /*
         * هذا هو السطر الذي كان فيه الخطأ.
         * تم إصلاحه بالكامل.
         */

        if (
          errMsg.includes(
            'Not logged in'
          ) ||
          errMsg.includes(
            'sequence ID'
          ) ||
          errMsg.includes(
            'appstate'
          ) ||
          errMsg.includes(
            'Failed to get'
          )
        ) {
          scheduleRestart(5000);
        }

        return;
      }

      if (!event) return;

      try {

        const type =
          event.type || 'unknown';

        if (
          type !== 'typ' &&
          type !== 'read_receipt'
        ) {
          console.log(
            '[الث] 📩 حدث وارد'
          );
        }

        if (
          type === 'message' ||
          type === 'message_reply'
        ) {
          handleMessage(
            api,
            event
          );
        } else {
          handleEvent(
            api,
            event
          );
        }

        msgCount++;

        if (
          msgCount % 10 === 0
        ) {
          saveAppstate(
            api,
            `بعد ${msgCount} رسالة`
          );
        }

      } catch (e) {

        console.error(
          '[الث] ⚠️ خطأ في معالجة الحدث (تفاصيل الخطأ محجوبة)'
        );
      }
    };

    msgEmitter =
      await api.listenMqtt(
        callback
      );

    console.log(
      '[الث] 👂 البوت يستمع...'
    );

  } catch (e) {

    console.error(
      '[الث] ❌ استثناء في startListening (تفاصيل الخطأ محجوبة)'
    );

    scheduleRestart(10000);
  }
}

function scheduleRestart(delay) {

  if (isRestarting) return;

  isRestarting = true;

  cancelActiveNameLoops();

  try {
    if (heartbeatInterval) {
      clearInterval(
        heartbeatInterval
      );

      heartbeatInterval = null;
    }
  } catch (e) {}

  try {
    if (appstateSaverInterval) {
      clearInterval(
        appstateSaverInterval
      );

      appstateSaverInterval = null;
    }
  } catch (e) {}

  try {
    if (
      msgEmitter &&
      typeof msgEmitter.stop ===
      'function'
    ) {
      msgEmitter.stop();
    }
  } catch (e) {}

  msgEmitter = null;
  botApi = null;

  writeBotState(false);

  const actualDelay =
    Math.min(
      Math.max(
        Number(delay) || 0,
        1000
      ),
      120000
    );

  reconnectAttempts++;

  console.log(
    `[الث] ⏳ إعادة الاتصال بعد ${actualDelay / 1000}ث (محاولة ${reconnectAttempts})`
  );

  setTimeout(() => {

    isRestarting = false;

    startBot();

  }, actualDelay);
}

startBot();
