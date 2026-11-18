'use strict';

const ADMIN_ID_RE = /^[1-9]\d{5,19}$/;
const BASIC_ID_RE = /^[1-9]\d*$/;
const HELP = [
  'أوامر الإدارة الخاصة:',
  'تشغيل — استئناف أوامر البوت ومهامه المحفوظة.',
  'إيقاف — إيقاف الأوامر والمهام المجدولة، مع إبقاء مستمع الخاص وصيانة الاتصال والذاكرة.',
  'إعادة تشغيل — إعادة تهيئة اتصال البوت مع حفظ حالة الإيقاف المؤقت.',
  'حالة البوت — عرض الاتصال والاستماع وحالة الإيقاف.',
  'عرض الأوامر — عرض هذه القائمة.',
  'إضافة مشرف <ID> — إضافة حساب إلى صلاحيات هذا البوت.',
  'حذف مشرف <ID> — سحب صلاحيات حساب.',
  'عرض المشرفين — عرض الحسابات المخولة لهذا البوت.',
  '',
  'مصدر الأوامر المسموح: حساب البوت نفسه فقط، في محادثة خاصة.',
  'ملاحظة: «إيقاف» لا يطفئ خدمة Railway؛ يبقى اتصال Messenger وبعض صيانة الاتصال والذاكرة قائمًا حتى يمكن تلقي «تشغيل».',
].join('\n');

function parseCommand(rawBody) {
  const body = String(rawBody || '').trim().replace(/\s+/gu, ' ');
  const exact = new Map([
    ['تشغيل', { name: 'start' }],
    ['إيقاف', { name: 'stop' }],
    ['ايقاف', { name: 'stop' }],
    ['إعادة تشغيل', { name: 'restart' }],
    ['اعادة تشغيل', { name: 'restart' }],
    ['حالة البوت', { name: 'status' }],
    ['عرض الأوامر', { name: 'help' }],
    ['عرض الاوامر', { name: 'help' }],
    ['إضافة مشرف', { name: 'add', missingId: true }],
    ['اضافة مشرف', { name: 'add', missingId: true }],
    ['حذف مشرف', { name: 'remove', missingId: true }],
    ['عرض المشرفين', { name: 'admins' }]
  ]);
  if (exact.has(body)) return exact.get(body);

  let match = body.match(/^(?:إضافة|اضافة) مشرف ([1-9]\d{5,19})$/u);
  if (match) return { name: 'add', id: match[1] };
  match = body.match(/^حذف مشرف ([1-9]\d{5,19})$/u);
  if (match) return { name: 'remove', id: match[1] };
  if (/^(?:إضافة|اضافة) مشرف(?:\s|$)/u.test(body)) return { name: 'add', invalid: true };
  if (/^حذف مشرف(?:\s|$)/u.test(body)) return { name: 'remove', invalid: true };
  return null;
}

function formatUptime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours ? `${hours}س` : '', minutes ? `${minutes}د` : '', `${secs}ث`].filter(Boolean).join(' ');
}

function validAdminList(store) {
  try {
    const current = store.load();
    if (!(current instanceof Set)) return null;
    const ids = [...current].map(String).filter(id => BASIC_ID_RE.test(id));
    return ids.sort((a, b) => a.length - b.length || a.localeCompare(b));
  } catch {
    return null;
  }
}

function createPrivateAdminControl({
  adminStore,
  controlStore,
  actions = {},
  getBotAccountID = () => null,
  clock = () => Date.now()
} = {}) {
  if (!adminStore || typeof adminStore.isAdmin !== 'function' || typeof adminStore.load !== 'function') {
    throw new TypeError('adminStore must implement isAdmin and load');
  }
  if (!controlStore || typeof controlStore.load !== 'function' || typeof controlStore.setPaused !== 'function') {
    throw new TypeError('controlStore must implement load and setPaused');
  }

  let lifecycleBusy = false;
  const seenMessages = new Map();
  const duplicateWindowMs = 10 * 60 * 1000;
  const maxSeenMessages = 512;

  async function send(api, event, message) {
    if (!api || typeof api.sendMessage !== 'function' || !event?.threadID) return false;
    try {
      await Promise.resolve(api.sendMessage(message, String(event.threadID)));
      return true;
    } catch {
      return false;
    }
  }

  function authorized(senderID) {
    if (!BASIC_ID_RE.test(String(senderID || ''))) return false;
    try { return adminStore.isAdmin(String(senderID)); } catch { return false; }
  }

  function isRepeatedMessage(event) {
    const messageID = String(event?.messageID || '').trim();
    const threadID = String(event?.threadID || '').trim();
    if (!messageID || messageID.length > 512 || !threadID) return true;
    const now = clock();
    for (const [key, timestamp] of seenMessages) {
      if (now - timestamp > duplicateWindowMs) seenMessages.delete(key);
      else break;
    }
    const key = `${threadID}:${messageID}`;
    if (seenMessages.has(key)) return true;
    seenMessages.set(key, now);
    while (seenMessages.size > maxSeenMessages) {
      seenMessages.delete(seenMessages.keys().next().value);
    }
    return false;
  }

  async function lifecycle(api, event, operation) {
    if (lifecycleBusy) {
      await send(api, event, '⏳ يوجد أمر تشغيل أو إيقاف قيد التنفيذ؛ انتظر لحظات ثم أعد المحاولة.');
      return true;
    }
    lifecycleBusy = true;
    try {
      const current = controlStore.load();
      if (!current?.ok) {
        await send(api, event, '❌ تعذر قراءة حالة البوت الدائمة؛ لم أغيّر التشغيل.');
        return true;
      }

      if (operation === 'stop') {
        if (current.paused) {
          await send(api, event, 'ℹ️ البوت متوقف مؤقتًا بالفعل؛ مستمع الخاص ما زال يعمل.');
          return true;
        }
        const saved = controlStore.setPaused(true);
        if (!saved?.ok) {
          await send(api, event, '❌ تعذر حفظ حالة الإيقاف؛ لم أوقف المهام.');
          return true;
        }
        try {
          if (typeof actions.onStop === 'function' && await actions.onStop() === false) throw new Error('stop_failed');
        } catch {
          controlStore.setPaused(false);
          await send(api, event, '❌ تعذر إيقاف مهام البوت بالكامل؛ أُلغيت حالة الإيقاف المحفوظة.');
          return true;
        }
        await send(api, event, '⏸️ تم إيقاف أوامر البوت ومهامه المجدولة. بقي مستمع الخاص وصيانة الاتصال والذاكرة فعّالة لاستقبال «تشغيل» أو «إعادة تشغيل»؛ خدمة Railway نفسها لم تُطفأ.');
        return true;
      }

      if (operation === 'start') {
        if (!current.paused) {
          await send(api, event, '✅ البوت يعمل بالفعل.');
          return true;
        }
        const saved = controlStore.setPaused(false);
        if (!saved?.ok) {
          await send(api, event, '❌ تعذر حفظ حالة التشغيل؛ بقي البوت متوقفًا مؤقتًا.');
          return true;
        }
        try {
          if (typeof actions.onStart === 'function' && await actions.onStart() === false) throw new Error('start_failed');
        } catch {
          controlStore.setPaused(true);
          await send(api, event, '❌ تعذر استئناف المهام؛ بقي البوت متوقفًا مؤقتًا.');
          return true;
        }
        await send(api, event, '▶️ تم استئناف أوامر البوت ومهامه المحفوظة.');
        return true;
      }

      if (operation === 'restart') {
        const sent = await send(api, event, '🔄 جارٍ إعادة تهيئة اتصال البوت؛ سأحافظ على حالة التشغيل أو الإيقاف الحالية.');
        if (!sent) return true;
        try {
          if (typeof actions.onRestart !== 'function' || await actions.onRestart() === false) {
            await send(api, event, '❌ تعذر بدء إعادة التهيئة.');
          }
        } catch {
          await send(api, event, '❌ تعذر بدء إعادة التهيئة.');
        }
        return true;
      }
      return false;
    } finally {
      lifecycleBusy = false;
    }
  }

  async function handle(api, event) {
    // Fail closed: only the logged-in bot identity may issue these commands in a DM.
    if (!event || event.isGroup !== false) return false;
    const command = parseCommand(event.body);
    if (!command) return false;
    const senderID = String(event.senderID || '');
    const botID = String(typeof getBotAccountID === 'function' ? getBotAccountID() || '' : '');

    if (!botID || senderID !== botID) {
      await send(api, event, '⛔ أوامر الإدارة الخاصة تقبل فقط من حساب البوت نفسه وفي محادثة خاصة.');
      return true;
    }

    if (isRepeatedMessage(event)) return true;

    if (!authorized(senderID)) {
      await send(api, event, '⛔ حساب البوت غير مسجل كمشرف؛ لم يُنفذ الأمر.');
      return true;
    }

    if (command.name === 'help') return send(api, event, HELP).then(() => true);

    if (command.name === 'status') {
      const control = controlStore.load();
      if (!control?.ok) {
        await send(api, event, '❌ تعذر قراءة حالة البوت من التخزين الدائم.');
        return true;
      }
      let status = {};
      try { status = typeof actions.getStatus === 'function' ? actions.getStatus() || {} : {}; } catch {}
      const login = status.connected === true ? 'متصل' : 'غير متصل';
      const listener = status.listening === true ? 'مستمع Messenger بدأ' : 'مستمع Messenger غير جاهز';
      const paused = control.paused ? 'متوقف مؤقتًا' : 'يعمل';
      const lines = [`حالة البوت: ${paused}`, `تسجيل الدخول: ${login}`, `الاستماع: ${listener}`];
      if (Number.isFinite(status.uptimeSeconds)) lines.push(`مدة العملية الحالية: ${formatUptime(status.uptimeSeconds)}`);
      await send(api, event, lines.join('\n'));
      return true;
    }

    if (command.name === 'admins') {
      const admins = validAdminList(adminStore);
      if (!admins) {
        await send(api, event, '❌ تعذر قراءة قائمة المشرفين المحفوظة.');
        return true;
      }
      const message = admins.length ? `👮 المشرفون المصرح لهم لهذا البوت:\n${admins.map((id, index) => `${index + 1}. ${id}`).join('\n')}` : '❌ قائمة المشرفين فارغة؛ لم أمنح صلاحية لأي حساب.';
      await send(api, event, message);
      return true;
    }

    if (command.name === 'add' || command.name === 'remove') {
      if (command.missingId) {
        await send(api, event, `الصيغة: «${command.name === 'add' ? 'إضافة' : 'حذف'} مشرف <ID>».`);
        return true;
      }
      if (command.invalid || !ADMIN_ID_RE.test(String(command.id || ''))) {
        await send(api, event, '❌ الآيدي غير صالح. أرسل آيدي Messenger رقميًا من 6 إلى 20 خانة.');
        return true;
      }
      const targetID = command.id;
      if (command.name === 'add') {
        let result;
        try { result = adminStore.add(targetID); } catch { result = { ok: false, reason: 'storage' }; }
        if (!result?.ok) {
          await send(api, event, result?.reason === 'target' ? '❌ الآيدي غير صالح.' : '❌ تعذر حفظ المشرف؛ لم تُمنح الصلاحية.');
        } else {
          await send(api, event, result.changed === false ? 'ℹ️ هذا الحساب مشرف بالفعل.' : '✅ تمت إضافة المشرف إلى قائمة هذا البوت الدائمة.');
        }
        return true;
      }

      const botID = String(typeof getBotAccountID === 'function' ? getBotAccountID() || '' : '');
      if (targetID === senderID || (botID && targetID === botID)) {
        await send(api, event, '⚠️ لا يمكن سحب صلاحية الحساب الذي أرسل الأمر أو حساب البوت نفسه.');
        return true;
      }
      let result;
      try { result = adminStore.remove(targetID); } catch { result = { ok: false, reason: 'storage' }; }
      if (result?.reason === 'last') {
        await send(api, event, '⚠️ لا يمكن سحب آخر مشرف؛ يجب أن يبقى حساب واحد مخول على الأقل.');
      } else if (!result?.ok) {
        await send(api, event, result?.reason === 'target' ? '❌ الآيدي غير صالح.' : '❌ تعذر حفظ التغيير؛ لم تُسحب الصلاحية.');
      } else {
        await send(api, event, result.changed === false ? 'ℹ️ هذا الحساب ليس ضمن المشرفين.' : '✅ تم سحب صلاحية المشرف وحفظ التغيير.');
      }
      return true;
    }

    return lifecycle(api, event, command.name);
  }

  return { handle, isKnownCommand: body => parseCommand(body) !== null };
}

function registerBotAccountAsAdmin(adminStore, botAccountID) {
  const id = String(botAccountID || '');
  if (!ADMIN_ID_RE.test(id)) return { ok: false, reason: 'identity' };
  try { return adminStore.add(id); } catch { return { ok: false, reason: 'storage' }; }
}

module.exports = { HELP, parseCommand, formatUptime, createPrivateAdminControl, registerBotAccountAsAdmin };
