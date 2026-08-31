const fs = require('fs');
const path = require('path');

// ─── قراءة المشرفين من ملف admins-config.json ───
function loadAdmins() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'admins-config.json'), 'utf8');
    const config = JSON.parse(raw);
    return new Set((config.admins || []).map(String));
  } catch (e) {
    // Fail closed: a missing or invalid admin file must not grant permissions.
    return new Set();
  }
}

const ADMINS = loadAdmins();
const commands = new Map();

// عداد الرسائل لكل جروب — كل 568 رسالة يتفاعل البوت
const msgCounters = new Map();
const REACTION_EMOJIS = ['🖤', '🥒', '☠️', '💀', '🔥'];
const REACTION_MILESTONE = 568;

const BOT_NICKNAME = `┌─── ⋆⋅☠︎⋅⋆ ───┐
 🖤 𝑩𝑰𝑮 • 𝑩𝑶𝑺𝑺 🖤 
└─── ⋆⋅☠︎⋅⋆ ───┘`;

function isAdmin(senderID) {
  // أعد تحميل قائمة المشرفين من الملف عند كل تحقق لاستيعاب التغييرات الفورية
  const current = loadAdmins();
  return current.has(String(senderID));
}

function loadCommands() {
  const commandsPath = path.join(__dirname, 'Commands');
  const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  commands.clear();
  for (const file of files) {
    try {
      delete require.cache[require.resolve(path.join(commandsPath, file))];
      const cmd = require(path.join(commandsPath, file));
      commands.set(cmd.name, cmd);
      console.log(`[الث] ✅ تم تحميل: ${cmd.name}`);
    } catch (e) {
      console.error(`[الث] ❌ خطأ في تحميل ${file}:`, e.message);
    }
  }
  console.log(`[الث] تم تحميل ${commands.size} أمر.`);
}

// ─── التحقق من تفعيل الأمر في commands-config.json ───
function isCommandEnabled(name) {
  try {
    const configPath = path.join(__dirname, 'commands-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (name in config) return config[name].enabled !== false;
    return true; // غير موجود في الملف = مفعّل افتراضياً
  } catch (e) {
    return true; // خطأ في القراءة = مفعّل افتراضياً
  }
}

function isHelpRequest(body) {
  return body === 'اومر' || body === 'أوامر' || body === 'اومر البوت' || body === 'أوامر البوت';
}

async function handleMessage(api, event) {
  if (!event || !event.body) return;

  const body = (event.body || '').trim();
  const threadID = String(event.threadID);
  const senderID = String(event.senderID || '');

  console.log(`[الث] 📩 رسالة من ${senderID} في ${threadID}: "${body.substring(0, 60)}"`);

  // عداد 568 — يتفاعل على الرسالة رقم 568 وكل مضاعفاتها
  if (event.messageID && event.isGroup !== false) {
    const prev = msgCounters.get(threadID) || 0;
    const next = prev + 1;
    msgCounters.set(threadID, next);
    if (next % REACTION_MILESTONE === 0) {
      const emoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
      console.log(`[الث] 🎯 رسالة #${next} في ${threadID} — تفاعل بـ ${emoji}`);
      try { await api.setMessageReaction(emoji, event.messageID); } catch (e) {
        console.error('[الث] خطأ في التفاعل:', e.message || e);
      }
    }
  }

  // الرد التلقائي — يعمل دائماً قبل فحص الأوامر (ليس بالإدمن فقط)
  const replyCmd = commands.get('رد');
  if (replyCmd && replyCmd.checkAutoReply) {
    await replyCmd.checkAutoReply(api, event).catch(e =>
      console.error('[الث] خطأ في checkAutoReply:', e.message)
    );
  }

  if (isHelpRequest(body)) {
    if (!isCommandEnabled('اومر')) return;
    const cmd = commands.get('اومر');
    if (cmd) cmd.execute(api, event).catch(e =>
      console.error('[الث] خطأ في عرض الأوامر:', e.message)
    );
    return;
  }

  // أوامر محمية: يستخدمها الإدمن فقط
  if (body === 'قصف' || body === 'قصف ايقاف' || body === 'قصف إيقاف') {
    if (!isAdmin(senderID)) return;
    if (!isCommandEnabled('قصف')) return;
    const cmd = commands.get('قصف');
    if (cmd) cmd.execute(api, event).catch(e =>
      console.error('[الث] خطأ في قصف:', e.message)
    );
    return;
  }

  if (body === 'كاتش' || body.startsWith('كاتش ') || body.startsWith('مجموعة ') || body.startsWith('جروب ')) {
    if (!isAdmin(senderID)) return;
    if (!isCommandEnabled('كاتش')) return;
    const cmd = commands.get('كاتش');
    if (cmd) cmd.execute(api, event).catch(e =>
      console.error('[الث] خطأ في كاتش/مجموعة:', e.message)
    );
    return;
  }

  if (body.startsWith('رد ') || body === 'رد قائمة') {
    if (!isAdmin(senderID)) return;
    if (!isCommandEnabled('رد')) return;
    const cmd = commands.get('رد');
    if (cmd) cmd.execute(api, event).catch(e =>
      console.error('[الث] خطأ في رد:', e.message)
    );
    return;
  }

  if (body.startsWith('يوت ')) {
    if (!isCommandEnabled('يوت')) return;
    const cmd = commands.get('يوت');
    if (cmd) cmd.execute(api, event).catch(e =>
      console.error('[الث] خطأ في يوت:', e.message)
    );
    return;
  }
}

function handleEvent(api, event) {
  if (!event) return;

  // طباعة الحدث للتشخيص
  const logType = event.logMessageType || event.type || '';
  if (logType !== 'read_receipt') {
    console.log(`[الث] 📌 حدث: type=${event.type} | logType=${logType}`);
  }

  const catchCmd = commands.get('كاتش');
  if (!catchCmd) return;

  // حماية الكنيات — حدث تغيير الكنية
  if (logType === 'log:user-nickname') {
    catchCmd.handleNicknameEvent(api, event);
  }

  // حماية اسم المجموعة — حدث تغيير الاسم
  if (logType === 'log:thread-name') {
    catchCmd.handleGroupNameEvent(api, event);
  }

  // بوت التحق بالمجموعة — حدث انضمام
  if (logType === 'log:subscribe') {
    const threadID = String(event.threadID);
    const logData = event.logMessageData || {};
    const addedParticipants = logData.addedParticipants || [];
    const botID = api.getCurrentUserID ? api.getCurrentUserID() : null;

    if (botID && addedParticipants.some(p => String(p.userFbId || p.userID || p.id || '') === String(botID))) {
      console.log(`[الث] ✅ تمت إضافتي إلى المجموعة ${threadID} — جاري تعيين الكنية...`);
      setTimeout(async () => {
        try {
          await api.nickname(BOT_NICKNAME, threadID, String(botID));
          console.log(`[الث] ✅ تم تعيين الكنية في المجموعة ${threadID}`);
        } catch (e) {
          console.error(`[الث] خطأ في تعيين الكنية بعد الانضمام:`, e.message || e);
        }
      }, 2000);
    }
  }
}

module.exports = { loadCommands, handleMessage, handleEvent, commands, isCommandEnabled };
