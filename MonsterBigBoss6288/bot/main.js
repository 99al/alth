const fs = require('fs');
const path = require('path');

// ─── قراءة المشرفين من ملف admins-config.json ───
function loadAdmins(configPath = path.join(__dirname, 'admins-config.json')) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');

    const config = JSON.parse(raw);

    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      !Array.isArray(config.admins) ||
      config.admins.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))
    ) {
      return new Set();
    }

    return new Set(config.admins);
  } catch {
    return new Set();
  }
}

const commandRegistry = new Map();

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
    console.error('[الث] تعذر تحميل الأوامر.');

    commandRegistry.clear();
    return;
  }

  const files = fs
    .readdirSync(commandsPath)
    .filter(f => f.endsWith('.js'));

  commandRegistry.clear();

  for (const file of files) {
    try {
      const filePath = path.join(commandsPath, file);

      // حذف النسخة القديمة من الذاكرة
      delete require.cache[require.resolve(filePath)];

      const cmd = require(filePath);

      if (!cmd || !cmd.name) {
        console.error('[الث] تم تجاهل تعريف أمر غير صالح.');
        continue;
      }

      commandRegistry.set(cmd.name, cmd);

    } catch {
      console.error('[الث] تعذر تحميل أحد الأوامر.');
    }
  }

  console.log('[الث] اكتمل تحميل الأوامر.');
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
async function handleMessage(api, event, dependencies = {}) {
  if (!event || !event.body) {
    return;
  }

  const commands = dependencies.commands || commandRegistry;
  const canAdmin = dependencies.isAdmin || isAdmin;
  const commandEnabled = dependencies.isCommandEnabled || isCommandEnabled;

  const body = String(event.body || '').trim();

  const threadID = String(
    event.threadID || ''
  );

  const senderID = String(
    event.senderID || ''
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

      console.log('[الث] تم تنفيذ تفاعل الرسائل الدوري.');

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

      } catch {
        console.error('[الث] تعذر تنفيذ تفاعل الرسالة.');
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
    } catch {
      console.error('[الث] تعذر فحص الرد التلقائي.');
    }
  }

  // ─── إيقاف حلقات تغيير الأسماء في المحادثة الحالية ───
  if (/^(?:إيقاف|ايقاف) الاسم$/u.test(body)) {
    if (!canAdmin(senderID)) {
      return;
    }

    const stopped = cancelActiveNameLoops(threadID, commands) > 0;
    const response = stopped
      ? '⏹️ تم إيقاف حلقات تغيير الكنيات واسم المجموعة ومؤقتاتها في هذه المحادثة.'
      : 'ℹ️ لا توجد حلقات تغيير أسماء نشطة في هذه المحادثة.';

    if (api && typeof api.sendMessage === 'function') {
      Promise.resolve(api.sendMessage(response, threadID))
        .catch(() => console.error('[الث] تعذر إرسال تأكيد إيقاف الأسماء.'));
    }

    return;
  }

  // ─── أمر الكنية ومرادفه ───
  if (/^(?:هويه|هوية)(?:\s+|$)/u.test(body)) {
    if (!canAdmin(senderID)) {
      return;
    }

    if (!commandEnabled('هويه')) {
      return;
    }

    const cmd = commands.get('هويه');
    if (cmd && typeof cmd.execute === 'function') {
      Promise.resolve(cmd.execute(api, event))
        .catch(() => console.error('[الث] تعذر تنفيذ أمر الكنية.'));
    }

    return;
  }

  // ─── أمر تغيير اسم المجموعة وتشغيل حمايته ───
  if (/^قروب(?:\s+|$)/u.test(body)) {
    if (!canAdmin(senderID)) {
      return;
    }

    if (!commandEnabled('قروب')) {
      return;
    }

    const cmd = commands.get('قروب');
    if (cmd && typeof cmd.execute === 'function') {
      Promise.resolve(cmd.execute(api, event))
        .catch(() => console.error('[الث] تعذر تنفيذ أمر اسم المجموعة.'));
    }

    return;
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
      ).catch(() => console.error('[الث] تعذر تنفيذ الأمر.'));
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
      ).catch(() => console.error('[الث] تعذر تنفيذ الأمر.'));
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
      ).catch(() => console.error('[الث] تعذر تنفيذ الأمر.'));
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
      ).catch(() => console.error('[الث] تعذر تنفيذ الأمر.'));
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
      ).catch(() => console.error('[الث] تعذر تنفيذ الأمر.'));
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
      ).catch(() => console.error('[الث] تعذر تنفيذ الأمر.'));
    }

    return;
  }
}

function cancelActiveNameLoops(threadID, commandMap = commandRegistry) {
  const isThreadScoped = threadID !== undefined && threadID !== null;
  const targetThread = isThreadScoped ? String(threadID) : undefined;
  let cancelled = 0;

  for (const name of ['هويه', 'قروب']) {
    const command = commandMap.get(name);
    if (!command) continue;

    try {
      const result = isThreadScoped
        ? typeof command.cancel === 'function' && command.cancel(targetThread)
        : typeof command.cancelAll === 'function' && command.cancelAll();

      if (typeof result === 'number') {
        cancelled += result;
      } else if (result) {
        cancelled += 1;
      }
    } catch {
      // التنظيف يجب ألا يمنع إعادة الاتصال أو إيقاف أمر آخر.
    }
  }

  return cancelled;
}

// ─── معالجة الأحداث العامة ───
function handleEvent(api, event) {
  // حالياً لا توجد معالجة خاصة للأحداث.
  // وجود الدالة مهم حتى يستطيع index.js استيرادها.
  return;
}

// ─── تصدير الدوال إلى index.js ───
module.exports = {
  loadAdmins,
  loadCommands,
  handleMessage,
  handleEvent,
  cancelActiveNameLoops
};
