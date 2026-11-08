'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ID = /^[1-9]\d{0,31}$/;
const STATUSES = new Set(['queued', 'in_flight', 'already_member', 'unsupported', 'acknowledged', 'failed', 'uncertain', 'uncertain_after_restart']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const empty = () => ({ version: 1, groups: {} });

function validate(state) {
  if (!object(state) || state.version !== 1 || !object(state.groups)) throw Error('INVALID_STATE');
  for (const [tid, group] of Object.entries(state.groups)) {
    if (!ID.test(tid) || !object(group) || !Array.isArray(group.queue) || !object(group.seen) || !Array.isArray(group.events) || !Array.isArray(group.history)) throw Error('INVALID_GROUP');
    if (new Set(group.queue).size !== group.queue.length || new Set(group.events).size !== group.events.length) throw Error('DUPLICATE_STATE');
    if (group.events.some(key => typeof key !== 'string' || !key)) throw Error('INVALID_EVENTS');
    for (const [id, record] of Object.entries(group.seen)) {
      if (!ID.test(id) || !object(record) || !STATUSES.has(record.status)) throw Error('INVALID_RECORD');
      if ((record.status === 'queued') !== group.queue.includes(id)) throw Error('INVALID_QUEUE_RECORD');
      if (record.status === 'in_flight' && (typeof record.event !== 'string' || !Number.isFinite(record.at))) throw Error('INVALID_INTENT');
    }
    for (const id of group.queue) if (typeof id !== 'string' || !ID.test(id) || group.seen[id]?.status !== 'queued') throw Error('INVALID_QUEUE');
    for (const record of group.history) if (!object(record) || !ID.test(record.id) || !STATUSES.has(record.status)) throw Error('INVALID_HISTORY');
  }
  return state;
}

function statePath(env) {
  const production = env.NODE_ENV === 'production' || ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID'].some(key => env[key]);
  const service = String(env.RAILWAY_SERVICE_ID || env.SERVICE_ID || 'bot-second').replace(/[^\w-]/g, '_');
  if (production) return `/data/alth-member-compensation/${service}.json`;
  return env.MEMBER_COMPENSATION_STATE_PATH ? path.resolve(env.MEMBER_COMPENSATION_STATE_PATH) : path.join(__dirname, '.member-queue', 'state.json');
}
function readFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('INVALID_STATE_PATH');
    return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
}
function writeFile(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw Error('INVALID_STATE_DIRECTORY');
  fs.chmodSync(dir, 0o700);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('INVALID_STATE_PATH');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
function callFca(api, name, args, timeout) {
  if (!api || typeof api[name] !== 'function') return Promise.reject(Error('UNSUPPORTED'));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) reject(error);
      else if (value === false || (object(value) && (value.success === false || value.error || (Array.isArray(value.errors) && value.errors.length)))) reject(Error('NEGATIVE_RESULT'));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(Error('TIMEOUT')), timeout);
    try {
      const result = api[name](...args, finish);
      // A synchronous request handle is not an acknowledgement. Only the
      // callback or returned Promise is authoritative, including undefined.
      if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
    } catch (error) { finish(error); }
  });
}

function createMemberQueue(options = {}) {
  const env = options.env || process.env;
  const enabled = options.enabled !== undefined ? options.enabled : env.BOT_COMMAND_PROFILE === 'second';
  const file = options.file || statePath(env);
  const read = options.read || (() => readFile(file));
  const write = options.write || (value => writeFile(file, value));
  const timeout = options.requestTimeoutMs || 15000;
  let state, storageError;
  let mutations = Promise.resolve();
  const locks = new Map();
  function get() {
    if (!state && !storageError) try { state = validate(read()); } catch (error) { storageError = error; }
    if (storageError) throw Error('STATE_UNAVAILABLE');
    return state;
  }
  function mutate(change) {
    const operation = mutations.then(() => {
      const draft = clone(get()), result = change(draft);
      validate(draft);
      try { write(draft); } catch (error) { storageError = error; throw error; }
      state = draft;
      return result;
    });
    mutations = operation.catch(() => {});
    return operation;
  }
  function locked(key, action) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chain = previous.then(() => gate);
    locks.set(key, chain);
    return previous.then(action).finally(() => { release(); if (locks.get(key) === chain) locks.delete(key); });
  }
  const groupOf = (value, tid) => value.groups[tid] || (value.groups[tid] = { queue: [], seen: {}, events: [], history: [] });
  async function send(api, text, to) { try { await callFca(api, 'sendMessage', [text, String(to)], timeout); } catch {} }
  async function notify(api, tid, text) {
    let admins = [];
    try { admins = options.getAdminIDs ? await options.getAdminIDs(tid) : []; } catch {}
    for (const admin of [...new Set(Array.from(admins || [], String))].filter(id => ID.test(id))) await send(api, `المجموعة ${tid}: ${text}`, admin);
  }
  async function command(api, event, isAdmin) {
    if (!enabled || !event) return false;
    const body = String(event.body || '').trim();
    if (!/^ضيف(?:\s|$)/u.test(body)) return false;
    const tid = String(event.threadID || '').trim(), sender = String(event.senderID || '').trim();
    if (!ID.test(tid) || event.isGroup !== true) return true;
    let authorized = false;
    try { authorized = typeof isAdmin === 'function' && await isAdmin(sender); } catch {}
    if (!authorized) return true;
    const match = body.match(/^ضيف\s+([0-9]+)$/u);
    if (!match || !ID.test(match[1])) { await send(api, 'الاستخدام: ضيف <ID> (آيدي رقمي صحيح)', tid); return true; }
    const id = match[1];
    try {
      const added = await locked(tid, () => mutate(value => {
        const group = groupOf(value, tid);
        if (group.seen[id]) return false;
        group.queue.push(id); group.seen[id] = { status: 'queued' }; return true;
      }));
      await send(api, added ? '✅ أُضيف إلى قائمة انتظار هذه المجموعة.' : 'ℹ️ هذا الحساب مسجل مسبقًا لهذه المجموعة.', tid);
    } catch { await send(api, '❌ تعذر حفظ القائمة الدائمة؛ لم يُؤكَّد تسجيل الحساب.', tid); }
    return true;
  }
  async function finish(tid, id, status) {
    try {
      await mutate(value => {
        const record = value.groups[tid]?.seen[id];
        if (record?.status === 'in_flight') { record.status = status; record.updatedAt = Date.now(); value.groups[tid].history.push({ id, status }); }
      });
    } catch { /* Durable intent remains consumed; storage is failed closed. */ }
  }
  async function onEvent(api, event) {
    if (!enabled || !event || event.type !== 'event' || event.logMessageType !== 'log:unsubscribe') return;
    const tid = String(event.threadID || '').trim(), leaver = String(event.logMessageData?.leftParticipantFbId || '').trim();
    if (!ID.test(tid) || !ID.test(leaver)) return;
    const data = event.logMessageData || {};
    const identity = event.messageID || event.logMessageID || data.messageID || data.logMessageID || data.timestamp || event.timestamp;
    // Without a stable event identity, conservatively dedupe the same leaver.
    const key = identity ? `event:${String(identity)}:${leaver}` : `leaver:${leaver}`;
    return locked(tid, async () => {
      try {
        if (!get().groups[tid]) return;
        const claimed = await mutate(value => {
          const group = groupOf(value, tid);
          if (group.events.includes(key)) return false;
          group.events.push(key); return true;
        });
        if (!claimed || !get().groups[tid].queue.length) return;
        const info = await callFca(api, 'getThreadInfo', [tid], timeout);
        const participants = Array.isArray(info?.participantIDs) ? info.participantIDs.map(String) : null;
        if (!participants || participants.length !== 249 || new Set(participants).size !== 249 || participants.some(id => !ID.test(id)) || participants.includes(leaver)) return;
        if ([true, 1, '1', 'true'].includes(info.approvalMode)) { await notify(api, tid, '⚠️ تتطلب المجموعة موافقة؛ لم تُجرَ إضافة ولم يُستهلك الحساب.'); return; }
        let selected;
        await mutate(value => {
          const group = groupOf(value, tid);
          while (group.queue.length) {
            const id = group.queue.shift(), record = group.seen[id];
            if (participants.includes(id)) { record.status = 'already_member'; group.history.push({ id, status: record.status }); continue; }
            record.status = 'in_flight'; record.event = key; record.at = Date.now(); selected = id;
            group.history.push({ id, status: 'in_flight' }); break;
          }
        });
        if (!selected) return;
        // The intent and consumed account are durable BEFORE the external call.
        if (!api || typeof api.addUserToGroup !== 'function') {
          await finish(tid, selected, 'unsupported'); await notify(api, tid, `⚠️ واجهة الإضافة غير مدعومة؛ لن تُعاد محاولة الحساب ${selected}.`); return;
        }
        try {
          await callFca(api, 'addUserToGroup', [selected, tid], timeout);
          await finish(tid, selected, 'acknowledged');
          let confirmed = false;
          try { const after = await callFca(api, 'getThreadInfo', [tid], timeout); confirmed = Array.isArray(after?.participantIDs) && after.participantIDs.map(String).includes(selected); } catch {}
          await notify(api, tid, confirmed ? `✅ تأكدت عضوية الحساب ${selected}.` : `ℹ️ أقرت الواجهة طلب الحساب ${selected}، لكن العضوية غير مؤكدة وقد تكون دعوة معلّقة.`);
        } catch (error) {
          const status = String(error?.message).includes('TIMEOUT') ? 'uncertain' : 'failed';
          await finish(tid, selected, status);
          await notify(api, tid, status === 'uncertain' ? `⚠️ انتهت مهلة محاولة الحساب ${selected}؛ النتيجة غير مؤكدة ولن تُعاد.` : `❌ فشلت محاولة الحساب ${selected}؛ لن تُعاد.`);
        }
      } catch { console.error('[الث] تعذر معالجة تعويض الأعضاء.'); }
    });
  }
  // Initialization is disabled outside Bot 2. Interrupted requests are never
  // restored to the queue, because an external effect may already have happened.
  if (enabled) try {
    const draft = clone(get()); let changed = false;
    for (const group of Object.values(draft.groups)) for (const [id, record] of Object.entries(group.seen)) if (record.status === 'in_flight') {
      record.status = 'uncertain_after_restart'; group.history.push({ id, status: record.status }); changed = true;
    }
    if (changed) { validate(draft); write(draft); state = draft; }
  } catch (error) { storageError = storageError || error; }
  return { enabled, command, onEvent, file };
}
module.exports = { createMemberQueue };
