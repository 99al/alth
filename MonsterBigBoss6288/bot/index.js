const fs = require('fs');
const path = require('path');
const express = require('express');
const { login } = require('ws3-fca');
const { loadCommands, handleMessage, handleEvent } = require('./main');

const PORT = process.env.PORT || 3000;
const app = express();

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

app.get('/', (req, res) => {
  res.json({
    status: botApi ? '🟢 بوت الث يعمل' : '🔴 جاري إعادة الاتصال...',
    bot: 'الث',
    loggedIn: !!botApi,
    uptime: Math.floor(process.uptime()) + ' ثانية',
    reconnectAttempts,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.send('pong - الث حي ويعمل 💀');
});

app.post('/reconnect', (req, res) => {
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

app.get('/testsend', async (req, res) => {
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
      success: true,
      threadID
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.post('/updatecookies', express.json(), (req, res) => {
  const appstatePath = path.join(
    __dirname,
    'appstate.json'
  );

  try {
    const cookies = req.body;

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({
        error: 'Invalid cookies format.'
      });
    }

    fs.writeFileSync(
      appstatePath,
      JSON.stringify(cookies, null, 2)
    );

    console.log(
      '[الث] ✅ تم تحديث الكوكيز عبر HTTP'
    );

    res.json({
      success: true,
      message: 'Cookies updated. Reconnecting...'
    });

    scheduleRestart(3000);
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

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
        '[الث] ⚠️ Heartbeat failed:',
        e.message
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
    if (
      !api ||
      typeof api.getAppState !== 'function'
    ) {
      return;
    }

    const state = api.getAppState();

    if (state && state.length > 0) {
      fs.writeFileSync(
        path.join(__dirname, 'appstate.json'),
        JSON.stringify(state, null, 2)
      );

      if (reason) {
        console.log(
          `[الث] 💾 تم تجديد الجلسة (${reason})`
        );
      }
    }
  } catch (e) {
    console.error(
      '[الث] ⚠️ فشل حفظ appstate:',
      e.message
    );
  }
}

function startAppstateSaver(api) {
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

process.on('uncaughtException', err => {
  console.error(
    '[الث] 🔴 خطأ غير متوقع:',
    err && err.message
      ? err.message
      : String(err)
  );

  console.log(
    '[الث] 🟢 استمرار... إعادة الاتصال خلال 10 ثواني'
  );

  isRestarting = false;
  scheduleRestart(10000);
});

process.on('unhandledRejection', reason => {
  const msg =
    reason && reason.message
      ? reason.message
      : String(reason);

  if (
    msg.includes('Cookie not in this host') ||
    msg.includes("host's domain")
  ) {
    console.warn(
      '[الث] ⚠️ تحذير cookie domain — تجاهل'
    );
    return;
  }

  console.error(
    '[الث] 🔴 وعد غير معالج:',
    msg
  );

  isRestarting = false;
  scheduleRestart(15000);
});

process.on('SIGTERM', () => {
  console.log(
    '[الث] ⚠️ استلمت SIGTERM — البوت يكمل'
  );
});

process.on('SIGHUP', () => {
  console.log(
    '[الث] ⚠️ استلمت SIGHUP — البوت يكمل'
  );
});

function startBot() {
  if (isRestarting) return;

  const appstatePath = path.join(
    __dirname,
    'appstate.json'
  );

  if (!fs.existsSync(appstatePath)) {
    console.error(
      '[الث] ❌ appstate.json غير موجود'
    );

    setTimeout(startBot, 30000);
    return;
  }

  let appstate;

  try {
    appstate = JSON.parse(
      fs.readFileSync(
        appstatePath,
        'utf8'
      )
    );
  } catch (e) {
    console.error(
      '[الث] ❌ خطأ في قراءة appstate.json:',
      e.message
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
        const errStr =
          JSON.stringify(err);

        console.error(
          '[الث] ❌ فشل تسجيل الدخول:',
          errStr
        );

        const errMsg = String(
          err.message ||
          err.error ||
          errStr
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

      try {
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
            fs.writeFileSync(
              appstatePath,
              JSON.stringify(
                state,
                null,
                2
              )
            );
          }
        }

        console.log(
          '[الث] 💾 تم تحديث appstate.json'
        );
      } catch (e) {}

      const ctx = api.ctx;

      if (ctx && ctx.lastSeqId) {
        ctx.firstListen = true;

        console.log(
          `[الث] 🔑 Sequence ID: ${ctx.lastSeqId}`
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
          '[الث] خطأ في استئناف ويس:',
          e.message
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

        console.error(
          '[الث] ⚠️ خطأ في الاستماع:',
          JSON.stringify(err)
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

        const threadID =
          String(
            event.threadID || ''
          );

        const senderID =
          String(
            event.senderID || ''
          );

        const body =
          String(
            event.body || ''
          ).substring(0, 50);

        if (
          type !== 'typ' &&
          type !== 'read_receipt'
        ) {
          console.log(
            `[الث] 📩 type=${type} thread=${threadID} sender=${senderID} body="${body}"`
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
          '[الث] ⚠️ خطأ في معالجة الحدث:',
          e.message
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
      '[الث] ❌ استثناء في startListening:',
      e.message
    );

    scheduleRestart(10000);
  }
}

function scheduleRestart(delay) {

  if (isRestarting) return;

  isRestarting = true;

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