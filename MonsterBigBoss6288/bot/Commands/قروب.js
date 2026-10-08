const { createThreadRunRegistry } = require('../name-loop-registry.cjs');
const commandState = require('../command-state.cjs').defaultStore;

const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 10;
const CHECK_INTERVAL = 10 * 1000;
const activeRuns = createThreadRunRegistry();

function randomDelay() {
  return (MIN_DELAY_SECONDS + Math.floor(Math.random() * (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS + 1))) * 1000;
}

async function getCurrentGroupName(api, threadID) {
  try {
    if (typeof api.getThreadInfo === 'function') {
      const info = await api.getThreadInfo(threadID);
      if (info && typeof info.threadName === 'string') return info.threadName;
      if (info && typeof info.name === 'string') return info.name;
    }
  } catch {
    console.error('[قروب] تعذر قراءة اسم المجموعة.');
  }
  return null;
}

async function changeGroupName(api, threadID, groupName) {
  try {
    await api.gcname(groupName, threadID);
    return true;
  } catch {
    console.error('[قروب] تعذر تغيير اسم المجموعة؛ ستستمر الحماية في المحاولة.');
    return false;
  }
}

function startProtection(run, api, threadID, groupName) {
  let checkInProgress = false;

  const reconcile = async () => {
    if (checkInProgress || !activeRuns.isActive(run)) return;
    checkInProgress = true;
    try {
      const currentName = await getCurrentGroupName(api, threadID);
      if (!activeRuns.isActive(run)) return;
      if (currentName === null || currentName !== groupName) {
        const success = await changeGroupName(api, threadID, groupName);
        if (success && activeRuns.isActive(run)) {
          console.log(`[قروب] أُعيد اسم المجموعة المحمي في ${threadID}.`);
        }
      }
    } finally {
      checkInProgress = false;
    }
  };

  console.log(`[قروب] بدأت حماية اسم المجموعة في ${threadID} حتى الإيقاف اليدوي.`);
  void reconcile();
  activeRuns.scheduleInterval(run, () => { void reconcile(); }, CHECK_INTERVAL);
}

function isValidSavedGroupName(entry) {
  return entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.trim() !== '';
}

module.exports = {
  name: 'قروب',
  description: 'تغيير اسم المجموعة وحمايته حتى إيقافه يدويًا',

  async execute(api, event) {
    const threadID = String(event && event.threadID || '');
    const body = String(event && event.body || '').trim();
    const groupName = body.startsWith('قروب ') ? body.slice('قروب '.length).trim() : '';

    if (!groupName) {
      await api.sendMessage('⚠️ الصيغة الصحيحة:\nقروب اسم المجموعة', threadID);
      return;
    }

    const run = activeRuns.begin(threadID, { replace: true });
    if (!run) return;

    try {
      commandState.set('قروب', threadID, { name: groupName });
    } catch {
      activeRuns.finish(run);
      await api.sendMessage('❌ تعذر حفظ حماية اسم المجموعة في التخزين الدائم؛ لم يبدأ الأمر.', threadID);
      return;
    }

    try {
      if (!await activeRuns.wait(run, randomDelay())) return;
      if (!activeRuns.isActive(run)) return;
      await changeGroupName(api, threadID, groupName);
      if (!activeRuns.isActive(run)) return;
      startProtection(run, api, threadID, groupName);
      console.log(`[قروب] تم تطبيق الاسم المطلوب في ${threadID}.`);
    } catch {
      console.error('[قروب] تعذر تنفيذ تغيير اسم المجموعة.');
      if (activeRuns.isActive(run)) startProtection(run, api, threadID, groupName);
    }
  },

  resumeAll(api) {
    let saved;
    try { saved = commandState.getAll('قروب'); } catch {
      console.error('[قروب] تعذر قراءة حمايات أسماء المجموعات المحفوظة.');
      return 0;
    }
    let resumed = 0;
    for (const [threadID, entry] of Object.entries(saved)) {
      if (!isValidSavedGroupName(entry) || activeRuns.has(threadID)) continue;
      const run = activeRuns.begin(threadID);
      if (!run) continue;
      startProtection(run, api, threadID, entry.name);
      resumed++;
    }
    return resumed;
  },

  pauseAll() {
    return activeRuns.cancelAll();
  },

  cancel(threadID) {
    const key = String(threadID);
    const wasActive = activeRuns.cancel(key);
    try {
      const wasSaved = commandState.remove('قروب', key);
      return wasActive || wasSaved;
    } catch {
      console.error('[قروب] تعذر حفظ إيقاف حماية اسم المجموعة.');
      const error = new Error('Could not persist manual stop.');
      error.code = 'COMMAND_STATE_WRITE_FAILED';
      error.cancelled = wasActive;
      throw error;
    }
  },

  cancelAll() {
    const wasActive = activeRuns.cancelAll();
    try { return Math.max(wasActive, commandState.clear('قروب')); } catch {
      console.error('[قروب] تعذر حفظ إيقاف حمايات أسماء المجموعات.');
      return wasActive;
    }
  }
};
