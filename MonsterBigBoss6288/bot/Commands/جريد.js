'use strict';

const activeSchedules = new Map();
const pendingSleeps = new Map();
const pendingRecipientSelections = new Map();
const pendingDirectSchedules = new Map();
const PENDING_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const commandState = require('../command-state.cjs').defaultStore;
const { getBotCommandProfile } = require('../bot-command-profile.cjs');
const commandProfile = getBotCommandProfile();
const commandName = commandProfile.jareed.commandName;
const commandAliases = [...commandProfile.jareed.aliases];
// Both services historically use this key on their separate existing volumes.
const stateCommandName = ['جودي', 'جواد'].includes(commandName) ? commandName : 'جريد';
const MAX_DELAY_SECONDS = 24 * 60 * 60;
const MAX_RECIPIENTS = 10;
const MAX_THREAD_RESULTS = 100;
const PAGE_SIZE = 15;
const THREAD_LIST_TIMEOUT_MS = 15000;

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
  const names = [commandName, ...commandAliases].sort((left, right) => right.length - left.length);
  for (const name of names) {
    if (body === name) return '';
    if (body.startsWith(`${name} `)) return body.slice(name.length).trim();
  }
  return null;
}

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, digit => String(digit.charCodeAt(0) - 0x06f0));
}

function parseSchedule(body, displayName = commandName) {
  const args = getCommandArguments(body);
  if (args === null) return null;
  const normalizedArgs = normalizeDigits(args);
  const stop = normalizedArgs === 'ايقاف' || normalizedArgs === 'إيقاف';
  if (stop) return { stop: true };
  const match = args.match(/^([0-9٠-٩۰-۹]+)\s+([0-9٠-٩۰-۹]+)\s+([\s\S]+)$/u);
  if (!match) return { error: `⚠️ الصيغة: ${displayName} 10 15 نص الرسالة` };
  const minSeconds = Number(normalizeDigits(match[1]));
  const maxSeconds = Number(normalizeDigits(match[2]));
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

function parseRecipientAction(args) {
  const normalized = normalizeDigits(args).trim();
  if (!normalized || normalized === 'عرض') return { type: 'list' };
  if (/^(?:الغاء الاختيار|إلغاء الاختيار|مسح الاختيار|الغاء|إلغاء)$/u.test(normalized)) {
    return { type: 'clear' };
  }
  if (normalized === 'التالي') return { type: 'page-relative', offset: 1 };
  if (normalized === 'السابق') return { type: 'page-relative', offset: -1 };
  const pageMatch = normalized.match(/^صفحة\s+(\d+)$/u);
  if (pageMatch) return { type: 'page', page: Number(pageMatch[1]) };
  const selectMatch = normalized.match(/^(?:اختيار|اختر)(?:\s+([\d\s،,؛;]+))?$/u);
  if (selectMatch) {
    const raw = (selectMatch[1] || '').trim();
    const numbers = raw ? raw.split(/[\s،,؛;]+/u).filter(Boolean) : [];
    if (!numbers.length || numbers.some(number => !/^\d+$/u.test(number))) {
      return { type: 'select-error' };
    }
    return { type: 'select', indexes: [...new Set(numbers.map(Number))] };
  }
  return null;
}

function isPrivateControlThread(event) {
  const threadID = String(event.threadID || '');
  const senderID = String(event.senderID || '');
  if (event.isGroup === true) return false;
  return event.isGroup === false || Boolean(threadID && senderID && threadID === senderID);
}

function threadPayload(value) {
  return Array.isArray(value) || Boolean(value && (
    Array.isArray(value.threads) || Array.isArray(value.threadList) || Array.isArray(value.data)
  ));
}

function unpackThreads(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.threads)) return value.threads;
  if (value && Array.isArray(value.threadList)) return value.threadList;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

function getThreadList(api) {
  if (!api || typeof api.getThreadList !== 'function') {
    return Promise.reject(new Error('واجهة getThreadList غير متاحة'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('انتهت مهلة جلب المحادثات')), THREAD_LIST_TIMEOUT_MS);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(unpackThreads(value));
    }
    const callback = (error, value) => {
      if (value === undefined && threadPayload(error)) finish(null, error);
      else if (error instanceof Error) finish(error);
      else if (error && value === undefined) finish(new Error(String(error)));
      else finish(null, value);
    };
    try {
      const result = api.getThreadList(MAX_THREAD_RESULTS, null, callback);
      if (result && typeof result.then === 'function') {
        result.then(value => finish(null, value), error => finish(error));
      } else if (threadPayload(result)) {
        finish(null, result);
      }
    } catch (error) {
      finish(error);
    }
  });
}

function isDirectThread(thread) {
  if (!thread || typeof thread !== 'object') return false;
  if (thread.isGroup === true) return false;
  if (thread.isGroup === false) return true;
  const participantIDs = Array.isArray(thread.participantIDs)
    ? thread.participantIDs
    : Array.isArray(thread.participants)
      ? thread.participants
      : null;
  return Boolean(participantIDs && participantIDs.length > 0 && participantIDs.length <= 2);
}

function formatThreadName(thread) {
  const name = thread.name || thread.threadName || thread.snippet || `محادثة ${thread.threadID}`;
  return String(name).replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 64) || `محادثة ${thread.threadID}`;
}

function prepareRecipients(threads, event) {
  const excludedIDs = new Set([String(event.threadID || ''), String(event.senderID || '')].filter(Boolean));
  const seen = new Set();
  const recipients = [];
  for (const thread of threads) {
    if (!isDirectThread(thread)) continue;
    const threadID = String(thread.threadID || thread.threadId || '');
    if (!threadID || threadID.length > 256 || excludedIDs.has(threadID) || seen.has(threadID)) continue;
    seen.add(threadID);
    recipients.push({ threadID, name: formatThreadName({ ...thread, threadID }) });
  }
  return recipients;
}

function renderRecipientPage(selection, page) {
  const pageCount = Math.max(1, Math.ceil(selection.threads.length / PAGE_SIZE));
  const targetPage = Math.min(Math.max(1, page), pageCount);
  const start = (targetPage - 1) * PAGE_SIZE;
  selection.page = targetPage;
  selection.pageItems = selection.threads.slice(start, start + PAGE_SIZE);
  const rows = selection.pageItems.map((thread, index) => `${index + 1}. ${thread.name}`);
  const selectedText = selection.selected.length
    ? `\nالمحدد الآن (${selection.selected.length}/${MAX_RECIPIENTS}): ${selection.selected.map(item => item.name).join('، ')}`
    : '';
  return [
    `📨 محادثات الخاص (${targetPage}/${pageCount}) — اختر أشخاصًا محددين:`,
    ...rows,
    '',
    `للاختيار: ${commandName} اختيار 1،3  •  للتنقل: ${commandName} صفحة ${Math.min(targetPage + 1, pageCount)} أو «${commandName} التالي»`,
    `بعد الاختيار ابدأ: ${commandName} 30 60 نص الرسالة${selectedText}`
  ].join('\n');
}

async function showRecipientPage(api, threadID, selection, page) {
  const text = renderRecipientPage(selection, page);
  pendingRecipientSelections.set(String(threadID), selection);
  await api.sendMessage(text, threadID);
}

function randomDelay(minSeconds, maxSeconds) {
  const range = maxSeconds - minSeconds + 1;
  return (minSeconds + Math.floor(Math.random() * range)) * 1000;
}

function getScheduleRecipients(schedule, controlThreadID) {
  if (schedule.targetType === 'private' && (!Array.isArray(schedule.recipients) || !schedule.recipients.length)) return [];
  if (!Array.isArray(schedule.recipients) || schedule.recipients.length === 0) {
    return [{ threadID: String(controlThreadID), name: '' }];
  }
  return schedule.recipients.map(recipient => ({
    threadID: String(recipient.threadID),
    name: typeof recipient.name === 'string' ? recipient.name : ''
  }));
}

async function runSchedule(api, controlThreadID, schedule) {
  while (activeSchedules.get(controlThreadID) === schedule) {
    const delay = randomDelay(schedule.minSeconds, schedule.maxSeconds);
    const elapsed = await sleep(delay, controlThreadID);
    if (!elapsed || activeSchedules.get(controlThreadID) !== schedule) break;
    let sent = 0;
    const recipients = getScheduleRecipients(schedule, controlThreadID);
    for (const recipient of recipients) {
      if (activeSchedules.get(controlThreadID) !== schedule) break;
      try {
        await api.sendMessage(schedule.message, recipient.threadID);
        sent++;
      } catch (error) {
        console.error(`[${commandName}] تعذر الإرسال إلى المستلم؛ لن تُعاد المحاولة له.`);
        if (schedule.targetType === 'private' || Array.isArray(schedule.recipients)) {
          schedule.recipients = schedule.recipients.filter(item => item.threadID !== recipient.threadID);
          try {
            if (schedule.recipients.length) commandState.set(stateCommandName, controlThreadID, schedule);
            else {
              activeSchedules.delete(controlThreadID);
              commandState.remove(stateCommandName, controlThreadID);
            }
          } catch {
            activeSchedules.delete(controlThreadID);
            console.error(`[${commandName}] أُوقفت الجدولة لتعذر حفظ استبعاد المستلم.`);
          }
          // Inform only the control chat; never contact the rejected recipient again.
          void Promise.resolve(api.sendMessage(`⏹️ أُوقف الإرسال إلى الحساب ${recipient.threadID} لأن Messenger رفض الإرسال أو تعذّر تسليمه.`, controlThreadID)).catch(() => {});
        }
      }
    }
    console.log(`[${commandName}] أُرسلت دورة إلى ${sent} من ${recipients.length} محادثة بعد ${(delay / 1000).toFixed(0)}ث`);
  }
  console.log(`[${commandName}] ⏹️ توقفت الجدولة في ${controlThreadID}`);
}

function startSchedule(api, threadID, schedule) {
  cancelSleep(threadID);
  activeSchedules.set(threadID, schedule);
  void runSchedule(api, threadID, schedule).catch(() => {
    console.error(`[${commandName}] توقفت الجدولة بسبب خطأ غير متوقع.`);
  });
}

function isValidSavedSchedule(schedule) {
  const validRecipients = Boolean(schedule) && ((schedule.recipients === undefined && schedule.targetType !== 'private') || (
    Array.isArray(schedule.recipients) &&
    schedule.recipients.length > 0 && schedule.recipients.length <= MAX_RECIPIENTS &&
    schedule.recipients.every(recipient => recipient && typeof recipient === 'object' &&
      typeof recipient.threadID === 'string' && recipient.threadID.length > 0 && recipient.threadID.length <= 256 &&
      (recipient.name === undefined || typeof recipient.name === 'string'))
  ));
  return Boolean(schedule && typeof schedule === 'object' &&
    Number.isSafeInteger(schedule.minSeconds) &&
    Number.isSafeInteger(schedule.maxSeconds) &&
    schedule.minSeconds >= 1 &&
    schedule.maxSeconds >= schedule.minSeconds &&
    schedule.maxSeconds <= MAX_DELAY_SECONDS &&
    typeof schedule.message === 'string' && schedule.message.trim() !== '' && validRecipients);
}

module.exports = {
  name: commandName,
  aliases: commandAliases,
  description: 'إرسال رسالة متكررة إلى محادثة أو أشخاص محددين من الخاص حتى الإيقاف اليدوي',
  async execute(api, event) {
    const threadID = String(event.threadID || '');
    if (!threadID) return;
    const body = String(event.body || '').trim();
    const args = getCommandArguments(body);
    if (args === null) return;
    const isPrivate = isPrivateControlThread(event);
    const recipientAction = parseRecipientAction(args);

    if (recipientAction) {
      if (!isPrivate) {
        if (event.isGroup === true) {
          await api.sendMessage(`ℹ️ اختيار مستلمي ${commandName} متاح في الخاص فقط. أرسل «${commandName}» للبوت في الخاص لعرض المحادثات.`, threadID);
        } else {
          await api.sendMessage(`⚠️ الصيغة: ${commandName} 10 15 نص الرسالة`, threadID);
        }
        return;
      }
      if (recipientAction.type === 'list') {
        let recipients;
        try {
          recipients = prepareRecipients(await getThreadList(api), event);
        } catch (error) {
          console.error(`[${commandName}] تعذر جلب قائمة المحادثات:`, error?.message || error);
          if (!api || typeof api.getThreadList !== 'function') {
            await api.sendMessage(`⚠️ الصيغة: ${commandName} 10 15 نص الرسالة`, threadID);
          } else {
            await api.sendMessage(`❌ لم أتمكن من جلب محادثات الحساب. تأكد من اتصال Messenger ثم أعد «${commandName}».`, threadID);
          }
          return;
        }
        if (!recipients.length) {
          pendingRecipientSelections.delete(threadID);
          await api.sendMessage('ℹ️ لم أجد محادثات خاصة فردية قابلة للاختيار في قائمة الحساب.', threadID);
          return;
        }
        const selection = { threads: recipients, page: 1, pageItems: [], selected: [] };
        await showRecipientPage(api, threadID, selection, 1);
        return;
      }
      const selection = pendingRecipientSelections.get(threadID);
      if (!selection) {
        await api.sendMessage(`ابدأ بإرسال «${commandName}» أولًا لأعرض محادثات الحساب، ثم اختر الأشخاص.`, threadID);
        return;
      }
      if (recipientAction.type === 'clear') {
        selection.selected = [];
        await showRecipientPage(api, threadID, selection, selection.page);
        return;
      }
      if (recipientAction.type === 'page' || recipientAction.type === 'page-relative') {
        const page = recipientAction.type === 'page'
          ? recipientAction.page
          : selection.page + recipientAction.offset;
        const pageCount = Math.max(1, Math.ceil(selection.threads.length / PAGE_SIZE));
        if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
          await api.sendMessage(`⚠️ رقم الصفحة من 1 إلى ${pageCount}.`, threadID);
          return;
        }
        await showRecipientPage(api, threadID, selection, page);
        return;
      }
      if (recipientAction.type === 'select-error') {
        await api.sendMessage(`⚠️ اكتب أرقامًا ظاهرة في الصفحة، مثل: ${commandName} اختيار 1،3`, threadID);
        return;
      }
      if (recipientAction.type === 'select') {
        if (recipientAction.indexes.some(index => index < 1 || index > selection.pageItems.length)) {
          await api.sendMessage(`⚠️ اختر أرقامًا من 1 إلى ${selection.pageItems.length} في الصفحة الحالية.`, threadID);
          return;
        }
        const selectedByID = new Map(selection.selected.map(item => [item.threadID, item]));
        for (const index of recipientAction.indexes) {
          const recipient = selection.pageItems[index - 1];
          selectedByID.set(recipient.threadID, recipient);
        }
        if (selectedByID.size > MAX_RECIPIENTS) {
          await api.sendMessage(`⚠️ الحد الأقصى ${MAX_RECIPIENTS} أشخاص. أزل بعض المحددين بـ«${commandName} إلغاء الاختيار».`, threadID);
          return;
        }
        selection.selected = [...selectedByID.values()];
        await api.sendMessage(
          `✅ تم تحديد ${selection.selected.length} من ${MAX_RECIPIENTS}: ${selection.selected.map(item => item.name).join('، ')}.\nابدأ الإرسال بالأمر: ${commandName} <من> <إلى> <نص الرسالة>\nمثال: ${commandName} 30 60 مرحبًا`,
          threadID
        );
        return;
      }
    }

    const parsed = parseSchedule(body);
    if (!parsed) return;
    if (parsed.stop) {
      const wasPending = pendingDirectSchedules.delete(threadID);
      pendingRecipientSelections.delete(threadID);
      const wasActive = activeSchedules.has(threadID);
      activeSchedules.delete(threadID);
      cancelSleep(threadID);
      let wasSaved = false;
      try {
        wasSaved = commandState.remove(stateCommandName, threadID);
      } catch {
        await api.sendMessage(`⏹️ أُوقف الإرسال في هذه العملية، لكن تعذر حفظ الإيقاف الدائم. أعد «${commandName} ايقاف» بعد عودة التخزين.`, threadID);
        return;
      }
      if (wasActive || wasSaved || wasPending) {
        await api.sendMessage(`✅ تم إيقاف ${commandName} في هذه المحادثة وإيقاف مستلميها.`, threadID);
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
      await api.sendMessage(`⚠️ توجد جدولة مفعّلة بالفعل. أرسل «${commandName} ايقاف» أولًا لتغييرها.`, threadID);
      return;
    }
    let savedSchedule;
    try {
      savedSchedule = commandState.get(stateCommandName, threadID);
    } catch {
      await api.sendMessage(`❌ تعذر قراءة حالة ${commandName} من التخزين الدائم.`, threadID);
      return;
    }
    if (savedSchedule) {
      if (isValidSavedSchedule(savedSchedule)) startSchedule(api, threadID, savedSchedule);
      await api.sendMessage(`⚠️ توجد جدولة محفوظة بالفعل. أرسل «${commandName} ايقاف» أولًا لتغييرها.`, threadID);
      return;
    }

    let recipients;
    if (isPrivate) {
      const selection = pendingRecipientSelections.get(threadID);
      if (!selection || selection.selected.length === 0) {
        pendingDirectSchedules.set(threadID, {
          senderID: String(event.senderID || ''),
          createdAt: Date.now(),
          minSeconds: parsed.minSeconds,
          maxSeconds: parsed.maxSeconds,
          message: parsed.message
        });
        await api.sendMessage(`أرسل الآن آيدي حساب المستلم كرسالة تالية (أرقام فقط). لن يبدأ الإرسال قبل وصوله.
للإلغاء: ${commandName} ايقاف`, threadID);
        return;
      }
      recipients = selection.selected.map(({ threadID: recipientThreadID, name }) => ({
        threadID: recipientThreadID,
        name
      }));
    }

    const schedule = {
      minSeconds: parsed.minSeconds,
      maxSeconds: parsed.maxSeconds,
      message: parsed.message,
      ...(recipients ? { targetType: 'private', recipients } : {})
    };
    try {
      commandState.set(stateCommandName, threadID, schedule);
    } catch {
      await api.sendMessage(`❌ تعذر حفظ جدول ${commandName}؛ لم يبدأ الإرسال.`, threadID);
      return;
    }
    startSchedule(api, threadID, schedule);
    const targetSummary = recipients
      ? `\n👥 المستلمون (${recipients.length}): ${recipients.map(item => item.name).join('، ')}`
      : '';
    await api.sendMessage(
      `✅ تم تشغيل ${commandName} البوت.${targetSummary}\n🎲 يرسل الرسالة كل مدة عشوائية بين ${schedule.minSeconds} و${schedule.maxSeconds} ثانية، ويستمر حتى إيقافه يدويًا.\n⏹️ للإيقاف من هذه المحادثة: ${commandName} ايقاف`,
      threadID
    );
  },
  async handleRecipientFollowup(api, event) {
    const threadID = String(event.threadID || '');
    const pending = pendingDirectSchedules.get(threadID);
    if (!pending || pending.senderID !== String(event.senderID || '') || !isPrivateControlThread(event)) return false;
    if (Date.now() - pending.createdAt > PENDING_RECIPIENT_TTL_MS) {
      pendingDirectSchedules.delete(threadID);
      return false;
    }
    const recipientID = normalizeDigits(String(event.body || '').trim());
    if (!/^[1-9]\d{4,24}$/u.test(recipientID)) return false;
    // Consume synchronously so duplicate incoming events cannot start two loops.
    pendingDirectSchedules.delete(threadID);
    if (activeSchedules.has(threadID)) return true;
    const schedule = {
      minSeconds: pending.minSeconds,
      maxSeconds: pending.maxSeconds,
      message: pending.message,
      targetType: 'private',
      recipients: [{ threadID: recipientID, name: recipientID }]
    };
    try {
      if (commandState.get(stateCommandName, threadID)) return true;
      commandState.set(stateCommandName, threadID, schedule);
    } catch {
      await api.sendMessage(`❌ تعذر حفظ جدول ${commandName}؛ لم يبدأ الإرسال. أعد الأمر.`, threadID);
      return true;
    }
    startSchedule(api, threadID, schedule);
    await api.sendMessage(`تم تشغيل ${commandName} للحساب ${recipientID}.
الرسالة: ${schedule.message}
الفاصل العشوائي: ${schedule.minSeconds}–${schedule.maxSeconds} ثانية.
للإيقاف: ${commandName} ايقاف`, threadID);
    return true;
  },
  isActive(threadID) {
    const key = String(threadID);
    if (activeSchedules.has(key)) return true;
    try { return isValidSavedSchedule(commandState.get(stateCommandName, key)); } catch { return false; }
  },
  resumeAll(api) {
    let saved;
    try {
      saved = commandState.getAll(stateCommandName);
    } catch {
      console.error(`[${commandName}] تعذر قراءة الجداول المحفوظة لاستئنافها.`);
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
    for (const threadID of [...activeSchedules.keys()]) cancelSleep(threadID);
    activeSchedules.clear();
    pendingRecipientSelections.clear();
    pendingDirectSchedules.clear();
    return paused;
  }
};
