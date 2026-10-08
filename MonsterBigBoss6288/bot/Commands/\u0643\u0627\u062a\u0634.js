'use strict';

const protectedNicknames = new Map();
const protectedGroupNames = new Map();
const protectedGroupNames2 = new Map();
const { createThreadRunRegistry } = require('../name-loop-registry.cjs');
const commandState = require('../command-state.cjs').defaultStore;
const activeRuns = createThreadRunRegistry();
const pendingTimeouts = new Map();

function persistThreadState(threadID) {
  const key = String(threadID);
  const entry = {};
  if (protectedNicknames.has(key)) entry.nickname = protectedNicknames.get(key);
  if (protectedGroupNames.has(key)) entry.groupName = protectedGroupNames.get(key);
  if (protectedGroupNames2.has(key)) entry.delayedGroup = protectedGroupNames2.get(key);
  if (Object.keys(entry).length === 0) return commandState.remove('كاتش', key);
  return commandState.set('كاتش', key, entry);
}

function scheduleThreadTimeout(threadID, callback, delayMs) {
  const key = String(threadID);
  let timers = pendingTimeouts.get(key);
  if (!timers) {
    timers = new Set();
    pendingTimeouts.set(key, timers);
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (timers.size === 0) pendingTimeouts.delete(key);
    callback();
  }, delayMs);
  timers.add(timer);
  return timer;
}

function clearPendingTimeouts(threadID) {
  const key = String(threadID);
  const timers = pendingTimeouts.get(key);
  if (!timers) return false;
  for (const timer of timers) clearTimeout(timer);
  pendingTimeouts.delete(key);
  return true;
}

function cancelThreadState(threadID) {
  const key = String(threadID);
  const hadState = protectedNicknames.has(key) || protectedGroupNames.has(key) || protectedGroupNames2.has(key);
  const cancelledRun = activeRuns.cancel(key);
  const hadTimers = clearPendingTimeouts(key);
  protectedNicknames.delete(key);
  protectedGroupNames.delete(key);
  protectedGroupNames2.delete(key);
  let wasSaved = false;
  try { wasSaved = commandState.remove('كاتش', key); } catch {
    console.error('[كاتش] تعذر حفظ إيقاف الحماية.');
    const error = new Error('Could not persist manual stop.');
    error.code = 'COMMAND_STATE_WRITE_FAILED';
    error.cancelled = Boolean(hadState || cancelledRun || hadTimers);
    throw error;
  }
  return Boolean(hadState || cancelledRun || hadTimers || wasSaved);
}

function cancelAllThreadState() {
  const threadsWithState = new Set([
    ...protectedNicknames.keys(),
    ...protectedGroupNames.keys(),
    ...protectedGroupNames2.keys(),
    ...pendingTimeouts.keys()
  ]);
  try {
    for (const threadID of Object.keys(commandState.getAll('كاتش'))) threadsWithState.add(threadID);
  } catch {
    console.error('[كاتش] تعذر قراءة الحمايات المحفوظة.');
  }
  let cancelled = activeRuns.cancelAll();
  for (const threadID of threadsWithState) {
    if (cancelThreadState(threadID)) cancelled++;
  }
  return cancelled;
}

function isValidSavedState(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.nickname !== undefined && (typeof entry.nickname !== 'string' || !entry.nickname.trim())) return false;
  if (entry.groupName !== undefined && (typeof entry.groupName !== 'string' || !entry.groupName.trim())) return false;
  if (entry.delayedGroup !== undefined) {
    const delayed = entry.delayedGroup;
    if (!delayed || typeof delayed !== 'object' || typeof delayed.name !== 'string' || !delayed.name.trim() ||
        !Number.isSafeInteger(delayed.minMs) || !Number.isSafeInteger(delayed.maxMs) ||
        delayed.minMs < 1 || delayed.maxMs < delayed.minMs) return false;
  }
  return entry.nickname !== undefined || entry.groupName !== undefined || entry.delayedGroup !== undefined;
}

async function restoreSavedState(api, threadID, entry) {
  const run = activeRuns.begin(threadID);
  if (!run) return false;
  try {
    if ((entry.nickname || entry.groupName || entry.delayedGroup) && typeof api.getThreadInfo === 'function') {
      const info = await api.getThreadInfo(threadID);
      if (!activeRuns.isActive(run)) return false;
      if ((entry.groupName || entry.delayedGroup) && typeof api.gcname === 'function') {
        const target = entry.groupName || entry.delayedGroup.name;
        const current = info && (info.threadName || info.name);
        if (typeof current === 'string' && current !== target) await api.gcname(target, threadID);
      }
      if (entry.nickname && Array.isArray(info && info.participantIDs) && info.nicknames && typeof api.nickname === 'function') {
        let attemptedWrites = 0;
        for (const memberID of [...new Set(info.participantIDs.map(String))]) {
          if (!activeRuns.isActive(run)) return false;
          const current = Object.prototype.hasOwnProperty.call(info.nicknames, memberID) ? info.nicknames[memberID] : '';
          if (current === entry.nickname) continue;
          if (attemptedWrites > 0 && !await activeRuns.wait(run, 1500)) return false;
          if (!activeRuns.isActive(run)) return false;
          try {
            await api.nickname(entry.nickname, threadID, memberID);
            attemptedWrites++;
          } catch {
            console.error('[كاتش] تعذرت استعادة كنية عضو بعد الاتصال.');
          }
        }
      }
    }
  } catch {
    console.error('[كاتش] تعذرت استعادة الحماية بعد الاتصال.');
  } finally {
    activeRuns.finish(run);
  }
  return true;
}

module.exports = {
  name: 'كاتش',

  getProtectedNicknames() { return protectedNicknames; },
  getProtectedGroupNames() { return protectedGroupNames; },
  getProtectedGroupNames2() { return protectedGroupNames2; },

  async execute(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim();

    if (body.startsWith('كاتش ')) {
      const nickname = body.slice('كاتش '.length).trim();
      if (!nickname) {
        try { await api.sendMessage('⚠️ مثال: كاتش مستر', threadID); } catch {}
        return;
      }
      const run = activeRuns.begin(threadID);
      if (!run) {
        try { await api.sendMessage('⚠️ يوجد عمل اسم جارٍ في هذه المحادثة.', threadID); } catch {}
        return;
      }
      try { await api.sendMessage(`⏳ جاري تغيير الكنيات إلى: ${nickname}`, threadID); } catch {}
      if (!activeRuns.isActive(run)) return;

      try {
        const info = await api.getThreadInfo(threadID);
        if (!activeRuns.isActive(run)) return;
        const participants = Array.isArray(info && info.participantIDs) ? info.participantIDs : [];
        protectedNicknames.set(threadID, nickname);
        try {
          persistThreadState(threadID);
        } catch {
          protectedNicknames.delete(threadID);
          await api.sendMessage('❌ تعذر حفظ حماية الكنيات في التخزين الدائم.', threadID);
          return;
        }

        let successCount = 0;
        for (const uid of participants) {
          if (!activeRuns.isActive(run)) return;
          try {
            await api.nickname(nickname, threadID, String(uid));
            if (!activeRuns.isActive(run)) return;
            successCount++;
          } catch {
            console.error('[كاتش] تعذر تغيير كنية أحد الأعضاء.');
          }
          if (!await activeRuns.wait(run, 1500)) return;
        }
        if (!activeRuns.isActive(run)) return;
        try {
          await api.sendMessage(`✅ تم تغيير كنيات ${successCount}/${participants.length} عضو إلى: ${nickname}\n🛡️ الحماية مستمرة حتى إيقافها يدويًا.`, threadID);
        } catch {}
      } catch {
        console.error('[كاتش] تعذر تنفيذ تغيير الكنيات.');
        try { await api.sendMessage('❌ حدث خطأ أثناء تغيير الكنيات.', threadID); } catch {}
      } finally {
        activeRuns.finish(run);
      }
      return;
    }

    const group2Match = body.match(/^مجموعة\s+2\s+»(\d+)\|(\d+)\s+(.+)$/);
    if (group2Match) {
      const minSec = Number(group2Match[1]);
      const maxSec = Number(group2Match[2]);
      const groupName = group2Match[3].trim();
      if (!groupName || !Number.isSafeInteger(minSec) || !Number.isSafeInteger(maxSec) || minSec < 1 || minSec >= maxSec || maxSec > 86400) {
        try { await api.sendMessage('⚠️ مثال: مجموعة 2 »9|10 مستر', threadID); } catch {}
        return;
      }
      const previousDelayed = protectedGroupNames2.get(threadID);
      const previousGroup = protectedGroupNames.get(threadID);
      const delayed = { name: groupName, minMs: minSec * 1000, maxMs: maxSec * 1000 };
      protectedGroupNames2.set(threadID, delayed);
      protectedGroupNames.delete(threadID);
      try {
        persistThreadState(threadID);
      } catch {
        protectedGroupNames2.delete(threadID);
        if (previousDelayed) protectedGroupNames2.set(threadID, previousDelayed);
        if (previousGroup) protectedGroupNames.set(threadID, previousGroup);
        await api.sendMessage('❌ تعذر حفظ حماية اسم المجموعة في التخزين الدائم.', threadID);
        return;
      }
      try {
        await api.gcname(groupName, threadID);
        await api.sendMessage(`✅ تم تغيير اسم المجموعة إلى: ${groupName}\n🛡️ الحماية مستمرة حتى إيقافها يدويًا.`, threadID);
      } catch {
        console.error('[كاتش] تعذر تطبيق اسم المجموعة.');
        try { await api.sendMessage('❌ حدث خطأ في تغيير الاسم.', threadID); } catch {}
      }
      return;
    }

    if (body.startsWith('مجموعة ')) {
      const groupName = body.slice('مجموعة '.length).trim();
      if (!groupName) {
        try { await api.sendMessage('⚠️ مثال: مجموعة مستر', threadID); } catch {}
        return;
      }
      const previous = protectedGroupNames.get(threadID);
      const previousDelayed = protectedGroupNames2.get(threadID);
      protectedGroupNames.set(threadID, groupName);
      protectedGroupNames2.delete(threadID);
      try {
        persistThreadState(threadID);
      } catch {
        protectedGroupNames.delete(threadID);
        if (previous) protectedGroupNames.set(threadID, previous);
        if (previousDelayed) protectedGroupNames2.set(threadID, previousDelayed);
        await api.sendMessage('❌ تعذر حفظ حماية اسم المجموعة في التخزين الدائم.', threadID);
        return;
      }
      try {
        await api.gcname(groupName, threadID);
        await api.sendMessage(`✅ تم تغيير اسم المجموعة إلى: ${groupName}\n🛡️ الحماية مستمرة حتى إيقافها يدويًا.`, threadID);
      } catch {
        console.error('[كاتش] تعذر تطبيق اسم المجموعة.');
        try { await api.sendMessage('❌ حدث خطأ في تغيير الاسم.', threadID); } catch {}
      }
    }
  },

  handleNicknameEvent(api, event) {
    const threadID = String(event.threadID);
    const protectedName = protectedNicknames.get(threadID);
    if (!protectedName) return;
    const data = event.logMessageData || {};
    const changedUID = String(data.participant_id || data.participantID || event.userID || '');
    const newNickname = data.nickname || data.newNickname || '';
    if (!changedUID || newNickname === protectedName) return;
    scheduleThreadTimeout(threadID, async () => {
      if (protectedNicknames.get(threadID) !== protectedName) return;
      try { await api.nickname(protectedName, threadID, changedUID); } catch {
        console.error('[كاتش] تعذرت إعادة الكنية المحمية.');
      }
    }, 300);
  },

  handleGroupNameEvent(api, event) {
    const threadID = String(event.threadID);
    const protectedName = protectedGroupNames.get(threadID);
    const delayedConfig = protectedGroupNames2.get(threadID);
    if (delayedConfig) {
      const data = event.logMessageData || {};
      const newName = data.name || data.threadName || event.name || '';
      if (!newName || newName === delayedConfig.name) return;
      const delayMs = delayedConfig.minMs + Math.floor(Math.random() * (delayedConfig.maxMs - delayedConfig.minMs));
      scheduleThreadTimeout(threadID, async () => {
        if (protectedGroupNames2.get(threadID) !== delayedConfig) return;
        try { await api.gcname(delayedConfig.name, threadID); } catch {
          console.error('[كاتش] تعذرت إعادة اسم المجموعة المحمي.');
        }
      }, delayMs);
      return;
    }
    if (!protectedName) return;
    const data = event.logMessageData || {};
    const newName = data.name || data.threadName || event.name || '';
    if (!newName || newName === protectedName) return;
    scheduleThreadTimeout(threadID, async () => {
      if (protectedGroupNames.get(threadID) !== protectedName) return;
      try { await api.gcname(protectedName, threadID); } catch {
        console.error('[كاتش] تعذرت إعادة اسم المجموعة المحمي.');
      }
    }, 300);
  },

  resumeAll(api) {
    let saved;
    try { saved = commandState.getAll('كاتش'); } catch {
      console.error('[كاتش] تعذر قراءة الحمايات المحفوظة لاستعادتها.');
      return 0;
    }
    let resumed = 0;
    for (const [threadID, entry] of Object.entries(saved)) {
      if (!isValidSavedState(entry)) continue;
      if (entry.nickname) protectedNicknames.set(threadID, entry.nickname);
      if (entry.groupName) protectedGroupNames.set(threadID, entry.groupName);
      if (entry.delayedGroup) protectedGroupNames2.set(threadID, entry.delayedGroup);
      void restoreSavedState(api, threadID, entry);
      resumed++;
    }
    return resumed;
  },

  pauseAll() {
    activeRuns.cancelAll();
    for (const threadID of [...pendingTimeouts.keys()]) clearPendingTimeouts(threadID);
    return true;
  },

  cancel(threadID) {
    return cancelThreadState(threadID);
  },

  cancelAll() {
    return cancelAllThreadState();
  }
};
