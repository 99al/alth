const fs = require('fs');
const path = require('path');
const nmCommand = require('./nm-command.standalone');

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
    commandRegistry.set('nm', nmCommand);
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

  commandRegistry.set('nm', nmCommand);

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

  // ─── قائمة الأوامر ───
  if (/^(?:اومر|أوامر)(?:\s|$)/u.test(body)) {
    if (!commandEnabled('اومر')) return;
    const cmd = commands.get('اومر');
    if (cmd && typeof cmd.execute === 'function') {
      Promise.resolve(cmd.execute(api, event))
        .catch(() => console.error('[الث] تعذر عرض قائمة الأوامر.'));
    }
    return;
  }

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
    commandEnabled('رد') &&
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

  // ─── سحب رسالة البوت التي تم الرد عليها ───
  if (/^\/?mc$/iu.test(body)) {
    if (!canAdmin(senderID) || !commandEnabled('mc')) {
      return;
    }

    const cmd = commands.get('mc');
    if (cmd && typeof cmd.execute === 'function') {
      Promise.resolve(cmd.execute(api, event))
        .catch(() => console.error('[الث] تعذر تنفيذ أمر حذف الرسالة.'));
    }

    return;
  }

  // ─── أمر قفل اسم المجموعة ───
  if (/^\/nm(?:\s|$)/iu.test(body)) {
    if (!commandEnabled('nm')) {
      return;
    }

    const cmd = commands.get('nm');
    if (cmd && typeof cmd.execute === 'function') {
      Promise.resolve(cmd.execute(api, event, { isAdmin: canAdmin }))
        .catch(() => console.error('[الث] تعذر تنفيذ أمر قفل اسم المجموعة.'));
    }

    return;
  }

  // ─── إيقاف حلقات تغيير الأسماء في المحادثة الحالية ───
  if (/^(?:إيقاف|ايقاف) الاسم$/u.test(body)) {
    if (!canAdmin(senderID)) {
      return;
    }

    const stopResult = cancelActiveNameLoops(threadID, commands, { details: true });
    const stopped = stopResult.cancelled > 0;
    const response = stopResult.persistenceFailures > 0
      ? '⚠️ أُوقفت الحمايات الحالية، لكن تعذر حفظ الإيقاف على التخزين الدائم؛ قد تعود بعد إعادة تشغيل الخدمة. تحقق من وحدة /data ثم أعد «إيقاف الاسم».'
      : stopped
        ? '⏹️ تم إيقاف عمليات تغيير الأسماء والكنيات وحماياتها ومؤقتاتها في هذه المحادثة.'
        : 'ℹ️ لا توجد عمليات تغيير أسماء نشطة في هذه المحادثة.';

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
  const isGroupNameCommand = /^قروب(?:\s+|$)/u.test(body);
  const isGroupNameAlias =
    /^مجموعة(?:\s+|$)/u.test(body) &&
    !/^مجموعة\s+2(?:\s+|$)/u.test(body);

  if (isGroupNameCommand || isGroupNameAlias) {
    if (!canAdmin(senderID)) {
      return;
    }

    if (!commandEnabled('قروب')) {
      return;
    }

    const cmd = commands.get('قروب');
    if (cmd && typeof cmd.execute === 'function') {
      const commandEvent = isGroupNameAlias
        ? { ...event, body: body.replace(/^مجموعة(?=\s|$)/u, 'قروب') }
        : event;
      Promise.resolve(cmd.execute(api, commandEvent))
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

  // ─── أمر جريد مع إبقاء جرائد كاسم بديل ───
  if (/^(?:جريد|جرائد)(?:\s|$)/u.test(body)) {
    if (!canAdmin(senderID)) {
      return;
    }

    if (!commandEnabled('جريد')) {
      return;
    }

    const cmd = commands.get('جريد');

    if (
      cmd &&
      typeof cmd.execute === 'function'
    ) {
      const commandEvent = body.startsWith('جرائد')
        ? { ...event, body: body.replace(/^جرائد(?=\s|$)/u, 'جريد') }
        : event;
      Promise.resolve(
        cmd.execute(api, commandEvent)
      ).catch(() => console.error('[الث] تعذر تنفيذ أمر جريد.'));
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

function cancelActiveNameLoops(threadID, commandMap = commandRegistry, options = {}) {
  const isThreadScoped = threadID !== undefined && threadID !== null;
  const targetThread = isThreadScoped ? String(threadID) : undefined;
  let cancelled = 0;
  let persistenceFailures = 0;

  for (const name of ['هويه', 'قروب', 'كاتش']) {
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
    } catch (error) {
      if (error && error.code === 'COMMAND_STATE_WRITE_FAILED') {
        persistenceFailures++;
        if (error.cancelled) cancelled++;
      }
      // التنظيف يجب ألا يمنع إعادة الاتصال أو إيقاف أمر آخر.
    }
  }

  return options.details ? { cancelled, persistenceFailures } : cancelled;
}

function pausePersistentCommands(commandMap = commandRegistry) {
  let paused = 0;
  for (const name of ['ويس', 'جريد', 'هويه', 'قروب', 'كاتش']) {
    const command = commandMap.get(name);
    if (!command || typeof command.pauseAll !== 'function') continue;
    try {
      const result = command.pauseAll();
      if (typeof result === 'number') paused += result;
      else if (result) paused++;
    } catch {
      console.error('[الث] تعذر تعليق إحدى المهام المحفوظة مؤقتًا.');
    }
  }
  return paused;
}

function resumePersistentCommands(api, commandMap = commandRegistry) {
  let resumed = 0;
  for (const name of ['ويس', 'جريد', 'هويه', 'قروب', 'كاتش']) {
    const command = commandMap.get(name);
    if (!command || typeof command.resumeAll !== 'function') continue;
    try {
      const result = command.resumeAll(api);
      if (typeof result === 'number') resumed += result;
    } catch {
      console.error('[الث] تعذر استئناف إحدى المهام المحفوظة.');
    }
  }
  return resumed;
}

function startNmCommand(api) {
  return nmCommand.start(api);
}

function stopNmCommand() {
  return nmCommand.stop();
}

// ─── معالجة الأحداث العامة ───
function handleEvent(api, event) {
  const command = commandRegistry.get('كاتش');
  if (!command || !event) return;
  try {
    if (typeof command.handleNicknameEvent === 'function') {
      command.handleNicknameEvent(api, event);
    }
    if (typeof command.handleGroupNameEvent === 'function') {
      command.handleGroupNameEvent(api, event);
    }
  } catch {
    console.error('[الث] تعذر تطبيق حماية حدث المجموعة.');
  }
}

// ─── تصدير الدوال إلى index.js ───
module.exports = {
  loadAdmins,
  loadCommands,
  commands: commandRegistry,
  handleMessage,
  handleEvent,
  cancelActiveNameLoops,
  pausePersistentCommands,
  resumePersistentCommands,
  startNmCommand,
  stopNmCommand
};
