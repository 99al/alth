'use strict';

/**
 * وحدة مستقلة لأمر /nm — المؤلف: الث
 *
 * تكامل مقصود يدويًا فقط:
 *   const nm = require('./nm-command.standalone');
 *   nm.start(api); // بعد تسجيل الدخول لاستئناف الأقفال المحفوظة
 *   await nm.execute(api, event, { authorized: true }); // بعد فحص المشرف
 *   nm.stop(); // عند قطع الاتصال/إعادة التشغيل
 *
 * الملف خارج Commands عمدًا: main.js الحالي لا يوجّه /nm، ولا يهيّئ
 * إضافات جديدة. لا تفعّل authorized إلا بعد فحص صلاحية المشرف في المستدعي.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;
const DEFAULT_DATA_FILE = path.join(__dirname, 'database', 'data', 'nmData.json');
const HELP = [
  'طريقة الاستخدام:',
  '/nm اسم المجموعة min max',
  '/nm time min max',
  '/nm status',
  '/nm off',
  'الأرقام بالدقائق، والحد المسموح من 1 إلى 1440.'
].join('\n');

function isValidRange(minMinutes, maxMinutes) {
  return Number.isInteger(minMinutes) &&
    Number.isInteger(maxMinutes) &&
    minMinutes >= MIN_MINUTES &&
    maxMinutes <= MAX_MINUTES &&
    minMinutes <= maxMinutes;
}

function validateEntry(entry, threadID) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    typeof entry.name !== 'string' ||
    !entry.name.trim() ||
    !isValidRange(entry.minMinutes, entry.maxMinutes)
  ) {
    throw new Error(`Invalid nmData entry for thread ${threadID}`);
  }
  return {
    name: entry.name.trim(),
    minMinutes: entry.minMinutes,
    maxMinutes: entry.maxMinutes
  };
}

function readState(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: 1, groups: {} };
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    !parsed.groups ||
    typeof parsed.groups !== 'object' ||
    Array.isArray(parsed.groups)
  ) {
    throw new Error('Invalid nmData.json structure; refusing to overwrite it');
  }

  const groups = {};
  for (const [threadID, entry] of Object.entries(parsed.groups)) {
    groups[threadID] = validateEntry(entry, threadID);
  }
  return { version: 1, groups };
}

function createNmCommand({ dataFile = DEFAULT_DATA_FILE, isAuthorized } = {}) {
  const filePath = path.resolve(dataFile);
  const state = readState(filePath);
  const timers = new Map();
  let activeApi = null;

  function persist() {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // بعض أنظمة الملفات لا تدعم chmod؛ لا يؤثر ذلك على استمرار الأمر.
      }
    } finally {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        // لا نغطي الخطأ الأصلي إذا تعذر تنظيف الملف المؤقت.
      }
    }
  }

  function clearTimer(threadID) {
    const timer = timers.get(String(threadID));
    if (timer) clearTimeout(timer);
    timers.delete(String(threadID));
  }

  function schedule(threadID, entry) {
    clearTimer(threadID);
    if (!activeApi || state.groups[threadID] !== entry) return;

    const range = entry.maxMinutes - entry.minMinutes + 1;
    const minutes = entry.minMinutes + Math.floor(Math.random() * range);
    const timer = setTimeout(async () => {
      timers.delete(threadID);
      if (!activeApi || state.groups[threadID] !== entry) return;

      try {
        await activeApi.setTitle(entry.name, threadID);
      } catch (error) {
        console.error(`[الث /nm] تعذر إعادة اسم المجموعة للمحادثة ${threadID}:`, error?.message || error);
      } finally {
        if (activeApi && state.groups[threadID] === entry) {
          schedule(threadID, entry);
        }
      }
    }, minutes * 60 * 1000);
    timers.set(threadID, timer);
  }

  async function send(api, message, threadID) {
    if (!api || typeof api.sendMessage !== 'function') return false;
    await api.sendMessage(message, threadID);
    return true;
  }

  async function hasPermission(api, event, context) {
    if (typeof isAuthorized === 'function') {
      return Boolean(await isAuthorized(api, event, context));
    }
    if (context && context.authorized === true) return true;
    if (context && typeof context.isAdmin === 'function') {
      return Boolean(await context.isAdmin(String(event.senderID || '')));
    }
    return false;
  }

  async function execute(api, event, context = {}) {
    const threadID = String(event && event.threadID || '');
    const body = String(event && event.body || '').trim();
    const match = body.match(/^\/nm(?:\s+([\s\S]*))?$/iu);
    if (!match) return false;

    if (!threadID) return true;
    if (!await hasPermission(api, event || {}, context)) {
      await send(api, 'هذا الأمر مخصص للمشرفين.', threadID);
      return true;
    }

    const args = String(match[1] || '').trim();
    const lowerArgs = args.toLowerCase();

    if (lowerArgs === 'status') {
      const entry = state.groups[threadID];
      const message = entry
        ? `🔒 قفل الاسم مفعّل.\nالاسم: ${entry.name}\nالفاصل: ${entry.minMinutes}–${entry.maxMinutes} دقيقة.`
        : '🔓 لا يوجد قفل اسم مفعّل في هذه المجموعة.';
      await send(api, message, threadID);
      return true;
    }

    if (lowerArgs === 'off') {
      const previous = state.groups[threadID];
      if (!previous) {
        await send(api, 'لا يوجد قفل اسم مفعّل في هذه المجموعة.', threadID);
        return true;
      }
      delete state.groups[threadID];
      try {
        persist();
      } catch (error) {
        state.groups[threadID] = previous;
        await send(api, 'تعذر حفظ إيقاف القفل؛ لم يتغير الإعداد.', threadID);
        console.error('[الث /nm] تعذر حفظ ملف القفل:', error?.message || error);
        return true;
      }
      clearTimer(threadID);
      await send(api, 'تم إيقاف قفل اسم المجموعة.', threadID);
      return true;
    }

    if (/^time\s+/iu.test(args)) {
      const timeMatch = args.match(/^time\s+(\d+)\s+(\d+)$/iu);
      if (!timeMatch) {
        await send(api, HELP, threadID);
        return true;
      }
      const minMinutes = Number(timeMatch[1]);
      const maxMinutes = Number(timeMatch[2]);
      if (!isValidRange(minMinutes, maxMinutes)) {
        await send(api, `الفاصل يجب أن يكون بين ${MIN_MINUTES} و${MAX_MINUTES} دقيقة، وأن يكون الحد الأدنى أقل من أو يساوي الأعلى.`, threadID);
        return true;
      }
      const previous = state.groups[threadID];
      if (!previous) {
        await send(api, 'فعّلي القفل أولًا: /nm اسم المجموعة min max', threadID);
        return true;
      }
      const updated = { ...previous, minMinutes, maxMinutes };
      state.groups[threadID] = updated;
      try {
        persist();
      } catch (error) {
        state.groups[threadID] = previous;
        await send(api, 'تعذر حفظ الفاصل الجديد؛ بقي الإعداد السابق.', threadID);
        console.error('[الث /nm] تعذر حفظ ملف القفل:', error?.message || error);
        return true;
      }
      if (activeApi) schedule(threadID, updated);
      await send(api, `تم تحديث الفاصل إلى ${minMinutes}–${maxMinutes} دقيقة.`, threadID);
      return true;
    }

    const nameMatch = args.match(/^(.+\S)\s+(\d+)\s+(\d+)$/u);
    if (!nameMatch) {
      await send(api, HELP, threadID);
      return true;
    }

    const name = nameMatch[1].trim();
    const minMinutes = Number(nameMatch[2]);
    const maxMinutes = Number(nameMatch[3]);
    if (!name || !isValidRange(minMinutes, maxMinutes)) {
      await send(api, `تأكدي من الاسم والفاصل؛ المدى المسموح ${MIN_MINUTES}–${MAX_MINUTES} دقيقة.`, threadID);
      return true;
    }
    if (!api || typeof api.setTitle !== 'function') {
      await send(api, 'واجهة setTitle غير متاحة في اتصال البوت الحالي.', threadID);
      return true;
    }

    try {
      await api.setTitle(name, threadID);
    } catch (error) {
      await send(api, 'تعذر تغيير اسم المجموعة. تحققي من اتصال البوت وصلاحيته في المجموعة.', threadID);
      console.error(`[الث /nm] تعذر تعيين الاسم للمحادثة ${threadID}:`, error?.message || error);
      return true;
    }

    const previous = state.groups[threadID];
    const entry = { name, minMinutes, maxMinutes };
    state.groups[threadID] = entry;
    try {
      persist();
    } catch (error) {
      if (previous) state.groups[threadID] = previous;
      else delete state.groups[threadID];
      await send(api, 'تغيّر الاسم، لكن تعذر حفظ القفل محليًا؛ لن تُستأنف الحماية تلقائيًا بعد إعادة التشغيل.', threadID);
      console.error('[الث /nm] تعذر حفظ ملف القفل:', error?.message || error);
      return true;
    }

    if (activeApi) schedule(threadID, entry);
    await send(api, `تم تفعيل قفل الاسم: ${name}\nالفاصل: ${minMinutes}–${maxMinutes} دقيقة.`, threadID);
    return true;
  }

  function start(api) {
    if (!api || typeof api.setTitle !== 'function') {
      throw new TypeError('start(api) requires an API with setTitle(name, threadID)');
    }
    for (const threadID of [...timers.keys()]) clearTimer(threadID);
    activeApi = api;
    for (const [threadID, entry] of Object.entries(state.groups)) {
      schedule(threadID, entry);
    }
    return Object.keys(state.groups).length;
  }

  function stop() {
    for (const threadID of [...timers.keys()]) clearTimer(threadID);
    activeApi = null;
    return timers.size;
  }

  function getStatus(threadID) {
    const entry = state.groups[String(threadID)];
    return entry ? { ...entry } : null;
  }

  function getAllStatuses() {
    return Object.fromEntries(
      Object.entries(state.groups).map(([threadID, entry]) => [threadID, { ...entry }])
    );
  }

  return { execute, start, stop, getStatus, getAllStatuses, dataFile: filePath };
}

const defaultCommand = createNmCommand();

module.exports = {
  name: 'nm',
  aliases: ['namemute', 'غلق', 'lockname'],
  author: 'الث',
  description: 'قفل اسم المجموعة وإعادته دوريًا — إعداد محلي مستقل',
  execute: (...args) => defaultCommand.execute(...args),
  start: (...args) => defaultCommand.start(...args),
  stop: (...args) => defaultCommand.stop(...args),
  getStatus: (...args) => defaultCommand.getStatus(...args),
  getAllStatuses: (...args) => defaultCommand.getAllStatuses(...args),
  createNmCommand
};
