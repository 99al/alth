const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 10;

// مدة الحماية: 24 ساعة
const PROTECTION_DURATION = 24 * 60 * 60 * 1000;

// فحص اسم القروب كل 10 ثوانٍ
const CHECK_INTERVAL = 10 * 1000;

// لمنع تشغيل أكثر من حماية لنفس القروب
const activeProtections = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
function startProtection(api, threadID, groupName) {
  if (activeProtections.has(threadID)) {
    return;
  }

  const startedAt = Date.now();

  console.log(
    `[قروب] 🛡️ بدأت حماية الاسم "${groupName}" في ${threadID} لمدة 24 ساعة`
  );

  const timer = setInterval(async () => {
    try {
      // انتهاء مدة الحماية
      if (Date.now() - startedAt >= PROTECTION_DURATION) {
        clearInterval(timer);
        activeProtections.delete(threadID);

        console.log(
          `[قروب] ⏹️ انتهت حماية الاسم في ${threadID} بعد 24 ساعة`
        );

        return;
      }

      const currentName = await getCurrentGroupName(api, threadID);

      // إذا تم تغيير الاسم، يتم استرجاع الاسم المحمي
      if (
        currentName !== null &&
        currentName !== groupName
      ) {
        console.log(
          `[قروب] ⚠️ تم تغيير الاسم في ${threadID} من "${currentName}" إلى "${groupName}"`
        );

        const success = await changeGroupName(
          api,
          threadID,
          groupName
        );

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
    }
  }, CHECK_INTERVAL);

  activeProtections.set(threadID, {
    timer,
    groupName,
    startedAt
  });
}

module.exports = {
  name: 'قروب',

  description:
    'تغيير اسم المجموعة بعد 5-10 ثوانٍ وحمايته لمدة 24 ساعة',

  async execute(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim();

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

    // إيقاف الحماية القديمة لنفس القروب
    const oldProtection = activeProtections.get(threadID);

    if (oldProtection) {
      clearInterval(oldProtection.timer);
      activeProtections.delete(threadID);
    }

    const delay = randomDelay();

    // انتظار 5-10 ثوانٍ بدون إرسال رسالة
    await sleep(delay);

    try {
      // تغيير الاسم
      const success = await changeGroupName(
        api,
        threadID,
        groupName
      );

      // إذا فشل التغيير، لا نرسل أي رسالة
      if (!success) {
        return;
      }

      // تشغيل الحماية لمدة 24 ساعة
      startProtection(
        api,
        threadID,
        groupName
      );

      // لا توجد رسالة نجاح

      console.log(
        `[قروب] تم تغيير الاسم إلى "${groupName}" في ${threadID}`
      );

    } catch (error) {
      // تسجيل الخطأ فقط في الـconsole
      console.error(
        '[قروب] خطأ:',
        error.message || error
      );

      // لا توجد أي رسالة داخل القروب
    }
  }
};