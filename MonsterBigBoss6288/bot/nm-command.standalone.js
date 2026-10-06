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
 * عند ربطها بالبوت، استدع execute بعد فحص صلاحية المشرف، وابدأ/أوقف المؤقتات
 * مع دورة حياة الاتصال. لا تفعّل authorized قبل إتمام فحص الصلاحية.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIN_SECONDS = 1;
const MAX_SECONDS = 24 * 60 * 60;
const DEFAULT_DATA_FILE = path.join(__dirname, 'database', 'data', 'nmData.json');
const HELP = [
  'طريقة الاستخدام:',
  '/nm اسم المجموعة min max',
  '/nm time min max',
  '/nm status',
  '/nm off',
  'الأرقام بلا وحدة بالدقائق؛ أضيفي s للثواني أو m للدقائق. المدى حتى 24 ساعة.'
].join('\n');


function isValidRange(minSeconds, maxSeconds) {
  return Number.isInteger(minSeconds) &&
    Number.isInteger(maxSeconds) &&
    minSeconds >= MIN_SECONDS &&
    maxSeconds <= MAX_SECONDS &&
    minSeconds <= maxSeconds;
}


function parseDurationSeconds(value) {
  const match = String(value == null ? '' : value).trim().match(/^(\d+)(s|m)?$/iu);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  const seconds = amount * (match[2] && match[2].toLowerCase() === 's' ? 1 : 60);
  return Number.isSafeInteger(seconds) ? seconds : null;
}


function parseRange(minValue, maxValue) {
  const minSeconds = parseDurationSeconds(minValue);
  const maxSeconds = parseDurationSeconds(maxValue);
  if (!isValidRange(minSeconds, maxSeconds)) return null;
  return { minSeconds, maxSeconds };
}


function formatDuration(seconds) {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    if (minutes === 1) return 'دقيقة واحدة';
    if (minutes === 2) return 'دقيقتان';
    return String(minutes) + ' دقائق';
  }
  if (seconds === 1) return 'ثانية واحدة';
  if (seconds === 2) return 'ثانيتان';
  return String(seconds) + ' ثانية';
}


function formatRange(minSeconds, maxSeconds) {
  return formatDuration(minSeconds) + '–' + formatDuration(maxSeconds);
}


function validateEntry(entry, threadID) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    typeof entry.name !== 'string' ||
    !entry.name.trim()
  ) {
    throw new Error('Invalid nmData entry for thread ' + threadID);
  }
  const hasSecondFields =
    Object.prototype.hasOwnProperty.call(entry, 'minSeconds') ||
    Object.prototype.hasOwnProperty.call(entry, 'maxSeconds');
  const minSeconds = hasSecondFields ? entry.minSeconds : entry.minMinutes * 60;
  const maxSeconds = hasSecondFields ? entry.maxSeconds : entry.maxMinutes * 60;
  if (!isValidRange(minSeconds, maxSeconds)) {
    throw new Error('Invalid nmData entry for thread ' + threadID);
  }
  return {
    name: entry.name.trim(),
    minSeconds,
    maxSeconds
  };
}


function readState(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: 2, groups: {} };
    throw error;
  }


  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
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
  return { version: 2, groups };
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


    const range = entry.maxSeconds - entry.minSeconds + 1;
    const seconds = entry.minSeconds + Math.floor(Math.random() * range);
    const timer = setTimeout(async () => {
      timers.delete(threadID);
      if (!activeApi || state.groups[threadID] !== entry) return;


      try {
        await activeApi.setTitle(entry.name, threadID);
      } catch (error) {
        console.error('[الث /nm] تعذر إعادة اسم المجموعة للمحادثة ' + threadID + ':', error?.message || error);
      } finally {
        if (activeApi && state.groups[threadID] === entry) {
          schedule(threadID, entry);
        }
      }
    }, seconds * 1000);
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
        ? '🔒 قفل الاسم مفعّل.\nالاسم: ' + entry.name + '\nالفاصل: ' + formatRange(entry.minSeconds, entry.maxSeconds) + '.'
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
      const timeMatch = args.match(/^time\s+(\d+(?:s|m)?)\s+(\d+(?:s|m)?)$/iu);
      if (!timeMatch) {
        await send(api, HELP, threadID);
        return true;
      }
      const range = parseRange(timeMatch[1], timeMatch[2]);
      if (!range) {
        await send(api, 'الفاصل يجب أن يكون من ثانية واحدة إلى 24 ساعة، مع حد أدنى لا يتجاوز الأعلى. استخدمي s للثواني أو m للدقائق.', threadID);
        return true;
      }
      const { minSeconds, maxSeconds } = range;
      const previous = state.groups[threadID];
      if (!previous) {
        await send(api, 'فعّلي القفل أولًا: /nm اسم المجموعة min max', threadID);
        return true;
      }
      const updated = { ...previous, minSeconds, maxSeconds };
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
      await send(api, 'تم تحديث الفاصل إلى ' + formatRange(minSeconds, maxSeconds) + '.', threadID);
      return true;
    }


    const nameMatch = args.match(/^(.+\S)\s+(\d+(?:s|m)?)\s+(\d+(?:s|m)?)$/u);
    if (!nameMatch) {
      await send(api, HELP, threadID);
      return true;
    }


    const name = nameMatch[1].trim();
    const range = parseRange(nameMatch[2], nameMatch[3]);
    if (!name || !range) {
      await send(api, 'تأكدي من الاسم والفاصل؛ المدى المسموح من ثانية واحدة إلى 24 ساعة. استخدمي s للثواني أو m للدقائق.', threadID);
      return true;
    }
    const { minSeconds, maxSeconds } = range;
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
    const entry = { name, minSeconds, maxSeconds };
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
    await send(api, 'تم تفعيل قفل الاسم: ' + name + '\nالفاصل: ' + formatRange(minSeconds, maxSeconds) + '.', threadID);
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
