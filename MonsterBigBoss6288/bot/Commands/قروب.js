const { createThreadRunRegistry } = require('../name-loop-registry.cjs');

const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 10;

// مدة الحماية: 24 ساعة
const PROTECTION_DURATION = 24 * 60 * 60 * 1000;

// فحص اسم القروب كل 10 ثوانٍ
const CHECK_INTERVAL = 10 * 1000;
const activeRuns = createThreadRunRegistry();

function randomDelay() {
  return (
    MIN_DELAY_SECONDS +
    Math.floor(
      Math.random() *
        (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS + 1)
    )
  ) * 1000;
}

/**
 * الحصول على اسم القروب الحالي
 */
async function getCurrentGroupName(api, threadID) {
  try {
    if (typeof api.getThreadInfo === 'function') {
      const info = await api.getThreadInfo(threadID);

      if (info && typeof info.threadName === 'string') {
        return info.threadName;
      }

      if (info && typeof info.name === 'string') {
        return info.name;
      }
    }
  } catch (error) {
    console.error(
      `[قروب] تعذر قراءة اسم المجموعة ${threadID}:`,
      error.message || error
    );
  }

  return null;
}

/**
 * تغيير اسم القروب
 */
async function changeGroupName(api, threadID, groupName) {
  try {
    await api.gcname(groupName, threadID);
    return true;
  } catch (error) {
    console.error(
      `[قروب] فشل تغيير الاسم في ${threadID}:`,
      error.message || error
    );
    return false;
  }
}

/**
 * تشغيل حماية اسم القروب لمدة 24 ساعة
 */
function startProtection(run, api, threadID, groupName) {
  let checkInProgress = false;

  console.log(
    `[قروب] 🛡️ بدأت حماية الاسم "${groupName}" في ${threadID} لمدة 24 ساعة`
  );

  activeRuns.scheduleTimeout(run, () => {
    activeRuns.finish(run);
    console.log(
      `[قروب] ⏹️ انتهت حماية الاسم في ${threadID} بعد 24 ساعة`
    );
  }, PROTECTION_DURATION);

  activeRuns.scheduleInterval(run, async () => {
    if (checkInProgress || !activeRuns.isActive(run)) {
      return;
    }

    checkInProgress = true;

    try {
      const currentName = await getCurrentGroupName(api, threadID);
      if (!activeRuns.isActive(run)) return;

      // إذا تم تغيير الاسم، يتم استرجاع الاسم المحمي
      if (currentName !== null && currentName !== groupName) {
        console.log(
          `[قروب] ⚠️ تم تغيير الاسم في ${threadID} من "${currentName}" إلى "${groupName}"`
        );

        const success = await changeGroupName(api, threadID, groupName);
        if (!activeRuns.isActive(run)) return;

        if (success) {
          console.log(
            `[قروب] 🛡️ تم استرجاع اسم المجموعة إلى "${groupName}" في ${threadID}`
          );
        }
      }
    } catch (error) {
      // الخطأ داخل دورة المراقبة لا يوقف الحماية
      console.error(
        `[قروب] خطأ أثناء المراقبة ${threadID}:`,
        error.message || error
      );
    } finally {
      checkInProgress = false;
    }
  }, CHECK_INTERVAL);
}

module.exports = {
  name: 'قروب',

  description:
    'تغيير اسم المجموعة بعد 5-10 ثوانٍ وحمايته لمدة 24 ساعة',

  async execute(api, event) {
    const threadID = String(event && event.threadID || '');
    const body = String(event && event.body || '').trim();

    const groupName = body.startsWith('قروب ')
      ? body.slice('قروب '.length).trim()
      : '';

    // رسالة الصيغة الصحيحة فقط
    if (!groupName) {
      await api.sendMessage(
        '⚠️ الصيغة الصحيحة:\nقروب اسم المجموعة',
        threadID
      );
      return;
    }

    // إعادة الأمر تستبدل الحلقة القديمة دون إبقاء مؤقتاتها.
    const run = activeRuns.begin(threadID, { replace: true });
    if (!run) return;

    try {
      // انتظار 5-10 ثوانٍ بدون إرسال رسالة
      if (!await activeRuns.wait(run, randomDelay())) return;
      if (!activeRuns.isActive(run)) return;

      // تغيير الاسم
      const success = await changeGroupName(api, threadID, groupName);
      if (!activeRuns.isActive(run)) return;

      // إذا فشل التغيير، لا نرسل أي رسالة
      if (!success) {
        activeRuns.finish(run);
        return;
      }

      // تشغيل الحماية لمدة 24 ساعة
      startProtection(run, api, threadID, groupName);

      // لا توجد رسالة نجاح
      console.log(
        `[قروب] تم تغيير الاسم إلى "${groupName}" في ${threadID}`
      );
    } catch (error) {
      console.error(
        '[قروب] خطأ:',
        error.message || error
      );
      activeRuns.finish(run);
      // لا توجد أي رسالة داخل القروب
    }
  },

  cancel(threadID) {
    return activeRuns.cancel(threadID);
  },

  cancelAll() {
    return activeRuns.cancelAll();
  }
};
