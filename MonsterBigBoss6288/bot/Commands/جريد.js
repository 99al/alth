const activeSchedules = new Map();

const MAX_DELAY_SECONDS = 24 * 60 * 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await sleep(delay);

    if (activeSchedules.get(threadID) !== schedule) break;

    try {
      await api.sendMessage(schedule.message, threadID);
      console.log(
        `[جريد] ✅ أُرسلت رسالة مجدولة إلى ${threadID} بعد ${(delay / 1000).toFixed(0)}ث`
      );
    } catch (error) {
      console.error('[جريد] خطأ في الإرسال:', error.message || error);
    }
  }

  console.log(`[جريد] ⏹️ توقفت الجدولة في ${threadID}`);
}

module.exports = {
  name: 'جريد',
  aliases: ['جريد البوت'],
  description: 'إرسال رسالة متكررة بزمن عشوائي',

  async execute(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim();
    const parsed = parseSchedule(body);

    if (!parsed) return;

    if (parsed.stop) {
      if (activeSchedules.delete(threadID)) {
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

    const schedule = {
      minSeconds: parsed.minSeconds,
      maxSeconds: parsed.maxSeconds,
      message: parsed.message
    };
    activeSchedules.set(threadID, schedule);

    await api.sendMessage(
      `✅ تم تشغيل جريد البوت.\n🎲 الإرسال كل مدة عشوائية بين ${schedule.minSeconds} و${schedule.maxSeconds} ثانية.\n⏹️ للإيقاف: جريد ايقاف`,
      threadID
    );

    runSchedule(api, threadID, schedule).catch((error) => {
      console.error('[جريد] خطأ غير متوقع:', error.message || error);
      if (activeSchedules.get(threadID) === schedule) activeSchedules.delete(threadID);
    });
  },

  isActive(threadID) {
    return activeSchedules.has(String(threadID));
  }
};