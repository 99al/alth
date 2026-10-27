'use strict';

const ID_RE = /^[1-9]\d*$/;
const ADD_TARGET_RE = /^[1-9]\d{5,19}$/;
const LIST_COMMAND = 'عرض ادمن البوت';
const REMOVE_COMMAND = 'سحب البوت';
const ADD_COMMAND = 'اضف';
const ADD_CONFIRM_COMMAND = 'تأكيد الإضافة';
const ADD_CANCEL_COMMAND = 'إلغاء الإضافة';
const INVALID_REMOVE_MESSAGE = '❌ الصيغة الصحيحة: «سحب البوت <ID>» أو أرسل «سحب البوت» بعد اختيار آيدي من القائمة.';
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const ADD_TIMEOUT_MS = 20 * 1000;

function addUserToGroup(api, targetID, threadID) {
  if (!api || typeof api.addUserToGroup !== 'function') {
    return Promise.reject(new TypeError('group invite is unavailable'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    timeout = setTimeout(() => finish(new Error('group invite timed out')), ADD_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();

    let result;
    try {
      result = api.addUserToGroup(targetID, threadID, error => finish(error));
    } catch (error) {
      finish(error);
      return;
    }

    if (result && typeof result.then === 'function') {
      result.then(value => {
        if (value === false || (value && typeof value === 'object' && value.error)) {
          finish(new Error('group invite failed'));
        } else {
          finish();
        }
      }, finish);
    }
  });
}

function createAdminIdHandler({ store, clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!store) throw new TypeError('admin store is required');
  const selections = new Map();
  const invitations = new Map();

  function key(senderID, threadID) {
    return `${String(senderID)}\u0000${String(threadID)}`;
  }
  function send(api, message, threadID) {
    if (api && typeof api.sendMessage === 'function') {
      return Promise.resolve(api.sendMessage(message, threadID)).catch(() => {});
    }
    return Promise.resolve();
  }
  function currentAdmins() {
    const admins = store.load();
    return admins instanceof Set ? [...admins].filter(id => ID_RE.test(String(id))) : [];
  }
  function authorized(senderID) {
    return ID_RE.test(String(senderID)) && store.isAdmin(String(senderID));
  }
  function clear(senderID, threadID) {
    selections.delete(key(senderID, threadID));
  }
  function getSelection(senderID, threadID) {
    const value = selections.get(key(senderID, threadID));
    if (!value) return null;
    if (clock() - value.createdAt > ttlMs) {
      clear(senderID, threadID);
      return null;
    }
    return value;
  }
  function clearInvitation(senderID, threadID) {
    invitations.delete(key(senderID, threadID));
  }
  function getInvitation(senderID, threadID) {
    const value = invitations.get(key(senderID, threadID));
    if (!value) return null;
    if (clock() - value.createdAt > ttlMs) {
      clearInvitation(senderID, threadID);
      return null;
    }
    return value;
  }
  function listingMessage(admins) {
    if (!admins.length) return 'ℹ️ لا يوجد مشرفون محفوظون حاليًا.';
    return [
      '👮 مشرفو هذا البوت:',
      ...admins.map((id, index) => `${index + 1}. ${id}`),
      '',
      'أرسل آيديًا من القائمة، ثم أرسل «سحب البوت» للتأكيد.'
    ].join('\n');
  }
  function parseInline(body) {
    let match = body.match(/^سحب البوت\s+([1-9]\d*)$/u);
    if (match) return match[1];
    match = body.match(/^([1-9]\d*)\s+سحب البوت$/u);
    return match ? match[1] : null;
  }
  function isMalformedInline(body) {
    return /^سحب البوت\s+\S.*$/u.test(body) && parseInline(body) === null;
  }

  async function handleInvitation(api, event, body, senderID, threadID) {
    const isAddPrefix = body === ADD_COMMAND || body.startsWith(`${ADD_COMMAND} `);
    const isConfirmPrefix = body === ADD_CONFIRM_COMMAND || body.startsWith(`${ADD_CONFIRM_COMMAND} `);
    const isCancel = body === ADD_CANCEL_COMMAND;
    if (!isAddPrefix && !isConfirmPrefix && !isCancel) return false;

    if (!authorized(senderID)) {
      clearInvitation(senderID, threadID);
      return true;
    }

    if (isAddPrefix) {
      clearInvitation(senderID, threadID);
      if (event?.isGroup === false || !threadID) {
        await send(api, '⚠️ يعمل أمر الإضافة داخل المجموعة فقط.', threadID);
        return true;
      }

      const match = body.match(/^اضف\s+([1-9]\d{5,19})$/u);
      if (!match || !ADD_TARGET_RE.test(match[1])) {
        await send(api, '⚠️ الصيغة الصحيحة: «اضف <ID>» باستخدام آيدي رقمي صالح.', threadID);
        return true;
      }

      const targetID = match[1];
      invitations.set(key(senderID, threadID), { targetID, createdAt: clock() });
      await send(
        api,
        `⚠️ طلب إضافة الحساب ${targetID} إلى هذه المجموعة. تأكد من موافقة صاحبه؛ للتنفيذ أرسل «تأكيد الإضافة ${targetID}» خلال دقيقتين، أو «إلغاء الإضافة».`,
        threadID
      );
      return true;
    }

    if (isCancel) {
      const pending = getInvitation(senderID, threadID);
      clearInvitation(senderID, threadID);
      await send(api, pending ? '⏹️ تم إلغاء طلب الإضافة.' : 'ℹ️ لا يوجد طلب إضافة معلّق في هذه المجموعة.', threadID);
      return true;
    }

    const pending = getInvitation(senderID, threadID);
    const match = body.match(/^تأكيد الإضافة\s+([1-9]\d{5,19})$/u);
    if (!pending) {
      await send(api, 'ℹ️ لا يوجد طلب إضافة معلّق في هذه المجموعة. ابدأ بـ«اضف <ID>».', threadID);
      return true;
    }
    if (!match || match[1] !== pending.targetID) {
      await send(api, `⚠️ لم يتطابق الآيدي مع الطلب. أرسل «تأكيد الإضافة ${pending.targetID}» أو «إلغاء الإضافة».`, threadID);
      return true;
    }
    if (event?.isGroup === false || !threadID) {
      clearInvitation(senderID, threadID);
      await send(api, '⚠️ يجب تأكيد الإضافة في المجموعة نفسها التي بدأ فيها الطلب.', threadID);
      return true;
    }

    clearInvitation(senderID, threadID);
    try {
      await addUserToGroup(api, pending.targetID, threadID);
      await send(api, `✅ تمت إضافة الحساب ${pending.targetID} إلى هذه المجموعة.`, threadID);
    } catch {
      await send(api, `❌ تعذرت إضافة الحساب ${pending.targetID}. تحقق من موافقة صاحبه وصلاحية البوت؛ لم أؤكد نجاح الإضافة.`, threadID);
    }
    return true;
  }

  async function handle(api, event) {
    const body = String(event?.body || '').trim();
    const senderID = String(event?.senderID || '');
    const threadID = String(event?.threadID || '');

    if (await handleInvitation(api, event, body, senderID, threadID)) return true;

    const isListing = body === LIST_COMMAND;
    const inlineTarget = parseInline(body);
    const isConfirmation = body === REMOVE_COMMAND;
    const isBareID = ID_RE.test(body);
    const isMalformed = isMalformedInline(body);
    const isKnown = isListing || inlineTarget !== null || isConfirmation || isBareID || isMalformed;

    // Bare IDs are deliberately not consumed unless this sender/thread has a live selection flow.
    if (!isKnown) return false;
    if (!authorized(senderID)) {
      if (isListing || inlineTarget !== null || isConfirmation || isMalformed) {
        clear(senderID, threadID);
        return true;
      }
      const pending = getSelection(senderID, threadID);
      if (pending) clear(senderID, threadID);
      return Boolean(pending);
    }

    if (isListing) {
      clear(senderID, threadID);
      const admins = currentAdmins();
      if (admins.length) selections.set(key(senderID, threadID), { createdAt: clock() });
      await send(api, listingMessage(admins), threadID);
      return true;
    }

    if (inlineTarget !== null) {
      clear(senderID, threadID);
      const admins = currentAdmins();
      if (!admins.includes(inlineTarget)) {
        await send(api, '❌ هذا الآيدي ليس مشرفًا في هذا البوت.', threadID);
        return true;
      }
      const result = store.remove(inlineTarget);
      if (result && result.ok) {
        await send(api, result.changed === false ? 'ℹ️ لم يحدث تغيير؛ الآيدي ليس مشرفًا.' : '✅ تم سحب المشرف.', threadID);
      } else if (result && result.reason === 'last') {
        await send(api, '⚠️ لا يمكن سحب آخر مشرف.', threadID);
      } else {
        await send(api, '❌ تعذر حفظ التغيير؛ لم يتم سحب المشرف.', threadID);
      }
      return true;
    }

    if (isMalformed) {
      clear(senderID, threadID);
      await send(api, INVALID_REMOVE_MESSAGE, threadID);
      return true;
    }

    if (isBareID) {
      const selection = getSelection(senderID, threadID);
      if (!selection) return false;
      const admins = currentAdmins();
      if (!admins.includes(body)) {
        clear(senderID, threadID);
        await send(api, '❌ هذا الآيدي ليس مشرفًا في هذا البوت.', threadID);
        return true;
      }
      selections.set(key(senderID, threadID), { targetID: body, createdAt: clock() });
      await send(api, `تم اختيار ${body}. أرسل «سحب البوت» للتأكيد.`, threadID);
      return true;
    }

    if (isConfirmation) {
      const selection = getSelection(senderID, threadID);
      if (!selection || !selection.targetID) {
        await send(api, 'ℹ️ استخدم «عرض ادمن البوت» أولًا، أو «سحب البوت <ID>».', threadID);
        return true;
      }
      clear(senderID, threadID);
      if (!authorized(senderID)) return true;
      if (!currentAdmins().includes(selection.targetID)) {
        await send(api, '❌ هذا الآيدي لم يعد مشرفًا في هذا البوت.', threadID);
        return true;
      }
      const result = store.remove(selection.targetID);
      if (result && result.ok) {
        await send(api, result.changed === false ? 'ℹ️ لم يحدث تغيير؛ الآيدي ليس مشرفًا.' : '✅ تم سحب المشرف.', threadID);
      } else if (result && result.reason === 'last') {
        await send(api, '⚠️ لا يمكن سحب آخر مشرف.', threadID);
      } else if (result && result.reason === 'target') {
        await send(api, '❌ الآيدي غير صالح.', threadID);
      } else {
        await send(api, '❌ تعذر حفظ التغيير؛ لم يتم سحب المشرف.', threadID);
      }
      return true;
    }
    return false;
  }

  return { handle, clear, _selections: selections, _invitations: invitations };
}

function commandEntries(handler) {
  return [
    { name: LIST_COMMAND, description: 'عرض مشرفي هذا البوت الحاليين', execute: (api, event) => handler.handle(api, event) },
    { name: REMOVE_COMMAND, description: 'سحب مشرف من هذا البوت بالآيدي بعد التأكيد', execute: (api, event) => handler.handle(api, event) },
    { name: ADD_COMMAND, description: 'إضافة يدوية إلى المجموعة بعد تأكيد المشرف', execute: (api, event) => handler.handle(api, event) }
  ];
}

module.exports = { LIST_COMMAND, REMOVE_COMMAND, ADD_COMMAND, ADD_CONFIRM_COMMAND, ADD_CANCEL_COMMAND, createAdminIdHandler, commandEntries };
