const { createThreadRunRegistry } = require('../name-loop-registry.cjs');

const MIN_DELAY_SECONDS = 3;
const MAX_DELAY_SECONDS = 5;
const PROTECTION_DURATION = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 10 * 1000;
const activeRuns = createThreadRunRegistry();

function randomDelay() {
  return (
    MIN_DELAY_SECONDS +
    Math.floor(Math.random() * (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS + 1))
  ) * 1000;
}

async function getThreadNicknameState(api, threadID) {
  if (!api || typeof api.getThreadInfo !== 'function') {
    throw new Error('Thread details are unavailable.');
  }

  const info = await api.getThreadInfo(threadID);
  if (
    !info ||
    !Array.isArray(info.participantIDs) ||
    !info.nicknames ||
    typeof info.nicknames !== 'object' ||
    Array.isArray(info.nicknames)
  ) {
    throw new Error('Thread nickname state is unavailable.');
  }

  for (const value of Object.values(info.nicknames)) {
    if (typeof value !== 'string') {
      throw new Error('Thread nickname state is invalid.');
    }
  }

  return {
    participants: [...new Set(info.participantIDs.map(id => String(id)).filter(Boolean))],
    nicknames: info.nicknames
  };
}

function currentNickname(nicknames, userID) {
  const key = String(userID);
  return Object.prototype.hasOwnProperty.call(nicknames, key)
    ? nicknames[key]
    : '';
}

function startProtection(run, api, threadID, nickname) {
  let checkInProgress = false;

  activeRuns.scheduleTimeout(run, () => {
    activeRuns.finish(run);
    console.log('[هويه] انتهت حماية الكنيات بعد 24 ساعة.');
  }, PROTECTION_DURATION);

  activeRuns.scheduleInterval(run, async () => {
    if (checkInProgress || !activeRuns.isActive(run)) return;
    checkInProgress = true;

    try {
      const state = await getThreadNicknameState(api, threadID);
      if (!activeRuns.isActive(run)) return;

      let attemptedWrites = 0;
      for (const userID of state.participants) {
        if (!activeRuns.isActive(run)) return;
        if (currentNickname(state.nicknames, userID) === nickname) continue;

        if (attemptedWrites > 0 && !await activeRuns.wait(run, randomDelay())) {
          return;
        }
        if (!activeRuns.isActive(run)) return;

        try {
          await api.nickname(nickname, threadID, userID);
          if (!activeRuns.isActive(run)) return;
          attemptedWrites++;
        } catch {
          attemptedWrites++;
          console.error('[هويه] تعذرت استعادة كنية عضو إلى الهدف المحمي.');
        }
      }
    } catch {
      console.error('[هويه] تعذرت قراءة حالة الكنيات في المحادثة.');
    } finally {
      checkInProgress = false;
    }
  }, CHECK_INTERVAL);
}

module.exports = {
  name: 'هويه',
  aliases: ['هوية'],
  description: 'تغيير كنيات أعضاء المجموعة بفاصل عشوائي 3-5 ثوانٍ وحمايتها 24 ساعة',

  async execute(api, event) {
    const threadID = String(event && event.threadID || '');
    const body = String(event && event.body || '').trim();
    const prefix = body.startsWith('هوية ') ? 'هوية ' : 'هويه ';
    const nickname = body.startsWith(prefix) ? body.slice(prefix.length).trim() : '';

    if (!nickname) {
      await api.sendMessage('⚠️ الصيغة: هويه اسم الكنية (أو هوية اسم الكنية)', threadID);
      return;
    }

    const run = activeRuns.begin(threadID);
    if (!run) {
      await api.sendMessage(
        '⚠️ يوجد تغيير كنيات جارٍ في هذه المحادثة. أوقفه بالأمر «إيقاف الاسم» أولًا.',
        threadID
      );
      return;
    }

    let protectionStarted = false;
    try {
      const state = await getThreadNicknameState(api, threadID);
      if (!activeRuns.isActive(run)) return;

      await api.sendMessage(
        `⏳ سيتم ضبط كنيات ${state.participants.length} عضوًا إلى «${nickname}» بفاصل عشوائي بين 3 و5 ثوانٍ، ثم حمايتها 24 ساعة.`,
        threadID
      );
      if (!activeRuns.isActive(run)) return;

      let successCount = 0;
      for (const userID of state.participants) {
        if (!await activeRuns.wait(run, randomDelay())) return;
        if (!activeRuns.isActive(run)) return;

        if (currentNickname(state.nicknames, userID) === nickname) {
          successCount++;
          continue;
        }

        try {
          await api.nickname(nickname, threadID, userID);
          if (!activeRuns.isActive(run)) return;
          successCount++;
          console.log(`[هويه] تم ضبط كنية عضو في المحادثة ${threadID}.`);
        } catch {
          console.error('[هويه] تعذر ضبط كنية أحد الأعضاء.');
        }
      }

      if (!activeRuns.isActive(run)) return;
      startProtection(run, api, threadID, nickname);
      protectionStarted = true;

      await api.sendMessage(
        `✅ اكتمل أمر هويه: تم تطبيق الكنية المطلوبة على ${successCount}/${state.participants.length} عضوًا. الحماية مفعلة لمدة 24 ساعة.`,
        threadID
      );
    } catch {
      console.error('[هويه] تعذر تنفيذ أمر تغيير الكنيات.');
      if (activeRuns.isActive(run)) {
        await api.sendMessage('❌ تعذر قراءة الكنيات أو تنفيذ الأمر بأمان.', threadID);
      }
    } finally {
      if (!protectionStarted) activeRuns.finish(run);
    }
  },

  cancel(threadID) {
    return activeRuns.cancel(threadID);
  },

  cancelAll() {
    return activeRuns.cancelAll();
  }
};
