const activeSchedules = new Map();
const pendingSleeps = new Map();
const commandState = require('../command-state.cjs').defaultStore;

const MAX_DELAY_SECONDS = 24 * 60 * 60;

function sleep(ms, threadID) {
  return new Promise((resolve) => {
    const key = String(threadID);
    const timer = setTimeout(() => {
      const current = pendingSleeps.get(key);
      if (current && current.timer === timer) pendingSleeps.delete(key);
      resolve(true);
    }, ms);
    pendingSleeps.set(key, { timer, resolve });
  });
}

function cancelSleep(threadID) {
  const key = String(threadID);
  const pending = pendingSleeps.get(key);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingSleeps.delete(key);
  pending.resolve(false);
  return true;
}

function getCommandArguments(body) {
  if (body === 'جريد' || body === 'جريد البوت') return '';
  if (body.startsWith('جريد البوت ')) return body.slice('جريد البوت '.length).trim();
  if (body.startsWith('جريد ')) return body.slice('جريد '.length).trim();
  return null;
}

function parseSchedule(body) {
  const args = getCommandArguments(body);
  if (args === null) return null;

  const stop = args === 'ايقاف' || args === 'إيقاف';
  if (stop) return { stop: true };

  const match = args.match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
  if (!match) return { error: '⚠️ الصيغة: جريد 10 15 نص الرسالة' };

  const minSeconds = Number(match[1]);
  const maxSeconds = Number(match[2]);
  const message = match[3].trim();

  if (
    !Number.isSafeInteger(minSeconds) ||
    !Number.isSafeInteger(maxSeconds) ||
    minSeconds < 1 ||
    maxSeconds < minSeconds ||
    maxSeconds > MAX_DELAY_SECONDS
  ) {
    return {
      error: `⚠️ يجب أن يكون الوقت بين 1 و${MAX_DELAY_SECONDS} ثانية، وأن يكون الرقم الأول أصغر من أو مساويًا للثاني.`
    };
  }

  if (!message) return { error: '⚠️ اكتب الرسالة بعد الوقت.' };
  return { minSeconds, maxSeconds, message };
}

function randomDelay(minSeconds, maxSeconds) {
  const range = maxSeconds - minSeconds + 1;
  return (minSeconds + Math.floor(Math.random() * range)) * 1000;
}

async function runSchedule(api, threadID, schedule) {
  while (activeSchedules.get(threadID) === schedule) {
    const delay = randomDelay(schedule.minSeconds, schedule.maxSeconds);
    const elapsed = await sleep(delay, threadID);
    if (!elapsed || activeSchedules.get(threadID) !== schedule) break;

    try {
      await api.sendMessage(schedule.message, threadID);
      console.log(
        `[جريد] ✅ أُرسلت رسالة مجدولة إلى ${threadID} بعد ${(delay / 1000).toFixed(0)}ث`
      );
    } catch {
      console.error('[جريد] تعذر إرسال الرسالة المجدولة؛ ستستمر المحاولة في الدورة التالية.');
    }
  }

  console.log(`[جريد] ⏹️ توقفت الجدولة في ${threadID}`);
}

function startSchedule(api, threadID, schedule) {
  cancelSleep(threadID);
  activeSchedules.set(threadID, schedule);
  void runSchedule(api, threadID, schedule).catch(() => {
    console.error('[جريد] توقفت الجدولة بسبب خطأ غير متوقع.');
  });
}

function isValidSavedSchedule(schedule) {
  return Boolean(schedule && typeof schedule === 'object' &&
    Number.isSafeInteger(schedule.minSeconds) &&
    Number.isSafeInteger(schedule.maxSeconds) &&
    schedule.minSeconds >= 1 &&
    schedule.maxSeconds >= schedule.minSeconds &&
    schedule.maxSeconds <= MAX_DELAY_SECONDS &&
    typeof schedule.message === 'string' && schedule.message.trim() !== '');
}

module.exports = {
  name: 'جريد',
  aliases: ['جريد البوت', 'جرائد'],
  description: 'إرسال رسالة متكررة بزمن عشوائي حتى إيقافها يدويًا',

  async execute(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim();
    const parsed = parseSchedule(body);
    if (!parsed) return;

    if (parsed.stop) {
      const wasActive = activeSchedules.has(threadID);
      activeSchedules.delete(threadID);
      cancelSleep(threadID);
      let wasSaved = false;
      try {
        wasSaved = commandState.remove('جريد', threadID);
      } catch {
        await api.sendMessage('⏹️ أُوقف الإرسال في هذه العملية، لكن تعذر حفظ الإيقاف الدائم. أعد «جريد ايقاف» بعد عودة التخزين.', threadID);
        return;
      }
      if (wasActive || wasSaved) {
        await api.sendMessage('✅ تم إيقاف جريد البوت في هذه المحادثة.', threadID);
      } else {
        await api.sendMessage('⚠️ لا توجد جدولة مفعّلة في هذه المحادثة.', threadID);
      }
      return;
    }

    if (parsed.error) {
      await api.sendMessage(parsed.error, threadID);
      return;
    }

    if (activeSchedules.has(threadID)) {
      await api.sendMessage(
        '⚠️ توجد جدولة مفعّلة بالفعل. أرسل «جريد ايقاف» أولًا لتغييرها.',
        threadID
      );
      return;
    }

    let savedSchedule;
    try {
      savedSchedule = commandState.get('جريد', threadID);
    } catch {
      await api.sendMessage('❌ تعذر قراءة حالة جريد من التخزين الدائم.', threadID);
      return;
    }
    if (savedSchedule) {
      if (isValidSavedSchedule(savedSchedule)) startSchedule(api, threadID, savedSchedule);
      await api.sendMessage('⚠️ توجد جدولة محفوظة بالفعل. أرسل «جريد ايقاف» أولًا لتغييرها.', threadID);
      return;
    }

    const schedule = {
      minSeconds: parsed.minSeconds,
      maxSeconds: parsed.maxSeconds,
      message: parsed.message
    };
    try {
      commandState.set('جريد', threadID, schedule);
    } catch {
      await api.sendMessage('❌ تعذر حفظ جدول جريد؛ لم يبدأ الإرسال.', threadID);
      return;
    }

    startSchedule(api, threadID, schedule);
    await api.sendMessage(
      `✅ تم تشغيل جريد البوت.\n🎲 الإرسال كل مدة عشوائية بين ${schedule.minSeconds} و${schedule.maxSeconds} ثانية، ويستمر حتى إيقافه يدويًا.\n⏹️ للإيقاف: جريد ايقاف`,
      threadID
    );
  },

  isActive(threadID) {
    const key = String(threadID);
    if (activeSchedules.has(key)) return true;
    try { return isValidSavedSchedule(commandState.get('جريد', key)); } catch { return false; }
  },

  resumeAll(api) {
    let saved;
    try {
      saved = commandState.getAll('جريد');
    } catch {
      console.error('[جريد] تعذر قراءة الجداول المحفوظة لاستئنافها.');
      return 0;
    }
    let resumed = 0;
    for (const [threadID, schedule] of Object.entries(saved)) {
      if (!isValidSavedSchedule(schedule) || activeSchedules.has(threadID)) continue;
      startSchedule(api, threadID, schedule);
      resumed++;
    }
    return resumed;
  },

  pauseAll() {
    const paused = activeSchedules.size;
    for (const threadID of activeSchedules.keys()) cancelSleep(threadID);
    activeSchedules.clear();
    return paused;
  }
};
