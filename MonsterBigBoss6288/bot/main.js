const fs = require('fs');
const path = require('path');

// ─── قراءة المشرفين من ملف admins-config.json ───
function loadAdmins() {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, 'admins-config.json'),
      'utf8'
    );

    const config = JSON.parse(raw);

    return new Set((config.admins || []).map(String));
  } catch (e) {
    return new Set([
      '100041346095449',
      '100041346095449'
    ]);
  }
}

const ADMINS = loadAdmins();
const commands = new Map();

// ─── عداد الرسائل لكل جروب ───
// كل 568 رسالة يتفاعل البوت
const msgCounters = new Map();

const REACTION_EMOJIS = [
  '🖤',
  '🥒',
  '☠️',
  '💀',
  '🔥'
];

const REACTION_MILESTONE = 568;

// ─── اسم البوت ───
const BOT_NICKNAME = `┌─── ⋆⋅☠︎⋅⋆ ───┐
 🖤 الث • الث 🖤 
└─── ⋆⋅☠︎⋅⋆ ───┘`;

// ─── التحقق من المشرف ───
function isAdmin(senderID) {
  // إعادة تحميل المشرفين عند كل تحقق
  // حتى يتم تطبيق التغييرات مباشرة
  const current = loadAdmins();

  return current.has(String(senderID));
}

// ─── تحميل الأوامر ───
function loadCommands() {
  const commandsPath = path.join(__dirname, 'Commands');

  if (!fs.existsSync(commandsPath)) {
    console.error(
      `[الث] ❌ مجلد Commands غير موجود: ${commandsPath}`
    );

    commands.clear();
    return;
  }

  const files = fs
    .readdirSync(commandsPath)
    .filter(f => f.endsWith('.js'));

  commands.clear();

  for (const file of files) {
    try {
      const filePath = path.join(commandsPath, file);

      // حذف النسخة القديمة من الذاكرة
      delete require.cache[require.resolve(filePath)];

      const cmd = require(filePath);

      if (!cmd || !cmd.name) {
        console.error(
          `[الث] ⚠️ الملف ${file} لا يحتوي على name`
        );
        continue;
      }

      commands.set(cmd.name, cmd);

      console.log(
        `[الث] ✅ تم تحميل: ${cmd.name}`
      );

    } catch (e) {
      console.error(
        `[الث] ❌ خطأ في تحميل ${file}:`,
        e.message || e
      );
    }
  }

  console.log(
    `[الث] ✅ تم تحميل ${commands.size} أمر.`
  );
}

// ─── التحقق من تفعيل الأمر ───
function isCommandEnabled(name) {
  try {
    const configPath = path.join(
      __dirname,
      'commands-config.json'
    );

    if (!fs.existsSync(configPath)) {
      return true;
    }

    const config = JSON.parse(
      fs.readFileSync(configPath, 'utf8')
    );

    if (name in config) {
      return config[name].enabled !== false;
    }

    return true;

  } catch (e) {
    return true;
  }
}

// ─── معالجة الرسائل ───
async function handleMessage(api, event) {
  if (!event || !event.body) {
    return;
  }

  const body = String(event.body || '').trim();

  const threadID = String(
    event.threadID || ''
  );

  const senderID = String(
    event.senderID || ''
  );

  console.log(
    `[الث] 📩 رسالة من ${senderID} في ${threadID}: "${body.substring(0, 60)}"`
  );

  // ─── عداد الرسائل ───
  // يتفاعل البوت عند الرسالة 568
  // وكل مضاعفاتها
  if (
    event.messageID &&
    event.isGroup !== false
  ) {
    const prev =
      msgCounters.get(threadID) || 0;

    const next = prev + 1;

    msgCounters.set(
      threadID,
      next
    );

    if (
      next % REACTION_MILESTONE === 0
    ) {
      const emoji =
        REACTION_EMOJIS[
          Math.floor(
            Math.random() *
            REACTION_EMOJIS.length
          )
        ];

      console.log(
        `[الث] 🎯 رسالة #${next} في ${threadID} — تفاعل بـ ${emoji}`
      );

      try {
        if (
          api &&
          typeof api.setMessageReaction === 'function'
        ) {
          await api.setMessageReaction(
            emoji,
            event.messageID
          );
        }

      } catch (e) {
        console.error(
          '[الث] ❌ خطأ في التفاعل:',
          e.message || e
        );
      }
    }
  }

  // ─── الرد التلقائي ───
  const replyCmd =
    commands.get('رد');

  if (
    replyCmd &&
    typeof replyCmd.checkAutoReply === 'function'
  ) {
    try {
      await replyCmd.checkAutoReply(
        api,
        event
      );
    } catch (e) {
      console.error(
        '[الث] ❌ خطأ في checkAutoReply:',
        e.message || e
      );
    }
  }

  // ─── أمر ويس ───
  if (
    body === 'ويس' ||
    body === 'ويس ايقاف' ||
    body === 'ويس إيقاف'
  ) {
    if (!isAdmin(senderID)) {
      return;
    }

    if (!isCommandEnabled('ويس')) {
      return;
    }

    const cmd =
      commands.get('ويس');

    if (
      cmd &&
      typeof cmd.execute === 'function'
    ) {
      Promise.resolve(
        cmd.execute(api, event)
      ).catch(e =>
        console.error(
          '[الث] ❌ خطأ في ويس:',
          e.message || e
        )
      );
    }

    return;
  }

  // ─── أمر جرائد ───
  if (
    body.startsWith('جرائد ') ||
    body === 'جرائد إيقاف' ||
    body === 'جرائد ايقاف'
  ) {
    if (!isAdmin(senderID)) {
      return;
    }

    if (!isCommandEnabled('جرائد')) {
      return;
    }

    const cmd =
      commands.get('جرائد');

    if (
      cmd &&
      typeof cmd.execute === 'function'
    ) {
      Promise.resolve(
        cmd.execute(api, event)
      ).catch(e =>
        console.error(
          '[الث] ❌ خطأ في جرائد:',
          e.message || e
        )
      );
    }

    return;
  }

  // ─── أمر كاتش / مجموعة / جروب ───
  if (
    body.startsWith('كاتش ') ||
    body.startsWith('مجموعة ') ||
    body.startsWith('جروب ')
  ) {
    if (!isAdmin(senderID)) {
      return;
    }

    if (!isCommandEnabled('كاتش')) {
      return;
    }

    const cmd =
      commands.get('كاتش');

    if (
      cmd &&
      typeof cmd.execute === 'function'
    ) {
      Promise.resolve(
        cmd.execute(api, event)
      ).catch(e =>
        console.error(
          '[الث] ❌ خطأ في كاتش/مجموعة:',
          e.message || e
        )
      );
    }

    return;
  }

  // ─── أمر رد ───
  if (
    body.startsWith('رد ') ||
    body === 'رد قائمة'
  ) {
    if (!isAdmin(senderID)) {
      return;
    }

    if (!isCommandEnabled('رد')) {
      return;
    }

    const cmd =
      commands.get('رد');

    if (
      cmd &&
      typeof cmd.execute === 'function'
    ) {
      Promise.resolve(
        cmd.execute(api, event)
      ).catch(e =>
        console.error(
          '[الث] ❌ خطأ في رد:',
          e.message || e
        )
      );
    }

    return;
  }

  // ─── أمر يوت ───
  if (
    body.startsWith('يوت ')
  ) {
    if (!isCommandEnabled('يوت')) {
      return;
    }

    const cmd =
      commands.get('يوت');

    if (
      cmd &&
      typeof cmd.execute === 'function'
    ) {
      Promise.resolve(
        cmd.execute(api, event)
      ).catch(e =>
        console.error(
          '[الث] ❌ خطأ في يوت:',
          e.message || e
        )
      );
    }

    return;
  }

  // ─── أمر Files / ملفات ───
  if (
    /^(?:files|ملفات)(?:\s|$)/iu.test(body)
  ) {
    if (!isAdmin(senderID)) {
      return;
    }

    if (!isCommandEnabled('Files')) {
      return;
    }

    const cmd =
      commands.get('Files');

    if (
      cmd &&
      typeof cmd.execute === 'function'
    ) {
      Promise.resolve(
        cmd.execute(api, event)
      ).catch(e =>
        console.error(
          '[الث] ❌ خطأ في Files:',
          e.message || e
        )
      );
    }

    return;
  }
}

// ─── معالجة الأحداث العامة ───
function handleEvent(api, event) {
  // حالياً لا توجد معالجة خاصة للأحداث.
  // وجود الدالة مهم حتى يستطيع index.js استيرادها.
  return;
}

// ─── تصدير الدوال إلى index.js ───
module.exports = {
  loadCommands,
  handleMessage,
  handleEvent
};