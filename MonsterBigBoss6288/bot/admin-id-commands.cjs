'use strict';

const ID_RE = /^[1-9]\d*$/;
const LIST_COMMAND = 'عرض ادمن البوت';
const REMOVE_COMMAND = 'سحب البوت';
const INVALID_REMOVE_MESSAGE = '❌ الصيغة الصحيحة: «سحب البوت <ID>» أو أرسل «سحب البوت» بعد اختيار آيدي من القائمة.';
const DEFAULT_TTL_MS = 2 * 60 * 1000;

function createAdminIdHandler({ store, clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!store) throw new TypeError('admin store is required');
  const selections = new Map();

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
  function listingMessage(admins) {
    if (!admins.length) return 'ℹ️ لا يوجد مشرفون محفوظون حاليًا.';
    return [
      '👮 مشرفو هذا البوت:',
      ...admins.map((id, index) => `${index + 1}. ${id}`),
      '',
      'أرسل آيديًا رقميًا من القائمة، ثم أرسل «سحب البوت» للتأكيد.'
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

  async function handle(api, event) {
    const body = String(event?.body || '').trim();
    const senderID = String(event?.senderID || '');
    const threadID = String(event?.threadID || '');
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

  return { handle, clear, _selections: selections };
}

function commandEntries(handler) {
  return [
    { name: LIST_COMMAND, description: 'عرض مشرفي هذا البوت الحاليين', execute: (api, event) => handler.handle(api, event) },
    { name: REMOVE_COMMAND, description: 'سحب مشرف من هذا البوت بالآيدي بعد التأكيد', execute: (api, event) => handler.handle(api, event) }
  ];
}

module.exports = { LIST_COMMAND, REMOVE_COMMAND, createAdminIdHandler, commandEntries };
