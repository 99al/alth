'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPrivateAdminControl, parseCommand, registerBotAccountAsAdmin } = require('./private-admin-control.cjs');

const owner = '100000000001';
const botID = '100000000002';
const member = '100000000003';
const outsider = '100000000004';

function fixture({ admins = [owner, botID], paused = false, actions = {} } = {}) {
  const members = new Set(admins);
  let state = { ok: true, paused, initialized: true };
  const calls = { sent: [], starts: 0, stops: 0, restarts: 0 };
  let nextMessage = 0;
  const adminStore = {
    load: () => new Set(members),
    isAdmin: id => members.has(String(id)),
    add: id => {
      id = String(id);
      if (!/^[1-9]\d*$/.test(id)) return { ok: false, reason: 'target' };
      if (members.has(id)) return { ok: true, changed: false };
      members.add(id);
      return { ok: true, changed: true };
    },
    remove: id => {
      id = String(id);
      if (!members.has(id)) return { ok: true, changed: false };
      if (members.size <= 1) return { ok: false, reason: 'last' };
      members.delete(id);
      return { ok: true, changed: true };
    }
  };
  const controlStore = {
    load: () => ({ ...state }),
    isPaused: () => state.paused,
    setPaused: pausedValue => {
      state = { ok: true, paused: pausedValue, initialized: true };
      return { ok: true, changed: true };
    }
  };
  const actionSet = {
    getStatus: () => ({ connected: true, listening: true, uptimeSeconds: 65 }),
    onStop: () => { calls.stops++; return true; },
    onStart: () => { calls.starts++; return true; },
    onRestart: () => { calls.restarts++; return true; },
    ...actions
  };
  const handler = createPrivateAdminControl({ adminStore, controlStore, actions: actionSet, getBotAccountID: () => botID });
  const api = { async sendMessage(message, threadID) { calls.sent.push({ message, threadID: String(threadID) }); } };
  const event = (body, senderID = botID, threadID = 'dm-admin', isGroup = false, messageID = `message-${++nextMessage}`) => ({ body, senderID, threadID, isGroup, messageID, type: 'message' });
  return { handler, adminStore, controlStore, members, calls, api, event };
}

test('recognizes only the requested private management command forms', () => {
  assert.equal(parseCommand('تشغيل').name, 'start');
  assert.equal(parseCommand('ايقاف').name, 'stop');
  assert.equal(parseCommand('إعادة تشغيل').name, 'restart');
  assert.equal(parseCommand('حالة البوت').name, 'status');
  assert.equal(parseCommand('عرض الأوامر').name, 'help');
  assert.equal(parseCommand('إضافة مشرف 100000000003').id, member);
  assert.equal(parseCommand('حذف مشرف 100000000003').name, 'remove');
  assert.equal(parseCommand('عرض المشرفين').name, 'admins');
  assert.equal(parseCommand('إضافة مشرف 12 abc').invalid, true);
  assert.equal(parseCommand('اومر'), null);
});

test('only the bot identity can issue management commands; replies stay in the exact incoming private thread', async () => {
  const f = fixture();
  for (const body of ['عرض الأوامر', 'حالة البوت', 'عرض المشرفين']) {
    await f.handler.handle(f.api, f.event(body, botID, 'same-dm'));
    assert.equal(f.calls.sent.at(-1).threadID, 'same-dm');
  }
  assert.match(f.calls.sent[0].message, /إيقاف/);
  assert.match(f.calls.sent[0].message, /لا يطفئ خدمة Railway/);
  assert.match(f.calls.sent[0].message, /حساب البوت نفسه/);
  assert.match(f.calls.sent[1].message, /متصل/);
  assert.match(f.calls.sent[1].message, /مستمع Messenger بدأ/);
  assert.match(f.calls.sent[2].message, new RegExp(owner));
  assert.match(f.calls.sent[2].message, new RegExp(botID));
});

test('new management commands are not handled or replied to in group chats', async () => {
  const f = fixture();
  for (const body of ['تشغيل', 'إيقاف', 'إعادة تشغيل', 'حالة البوت', 'عرض الأوامر', 'إضافة مشرف 100000000003', 'حذف مشرف 100000000003', 'عرض المشرفين']) {
    assert.equal(await f.handler.handle(f.api, f.event(body, owner, 'group-thread', true)), false, body);
  }
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.starts, 0);
  assert.equal(f.calls.stops, 0);
  assert.equal(f.calls.restarts, 0);
  assert.equal(f.members.has(member), false);
});

test('even a saved human admin cannot issue management commands; only the logged-in bot identity is accepted', async () => {
  const f = fixture();
  for (const [body, sender] of [['تشغيل', owner], ['إيقاف', outsider], ['إعادة تشغيل', owner], ['إضافة مشرف 100000000003', outsider], ['حذف مشرف 100000000001', owner]]) {
    assert.equal(await f.handler.handle(f.api, f.event(body, sender)), true);
    assert.match(f.calls.sent.at(-1).message, /حساب البوت نفسه/);
  }
  assert.equal(f.members.has(member), false);
  assert.equal(f.controlStore.isPaused(), false);
  assert.deepEqual({ starts: f.calls.starts, stops: f.calls.stops, restarts: f.calls.restarts }, { starts: 0, stops: 0, restarts: 0 });
});

test('bot identity must also remain enrolled as an admin before a command can execute', async () => {
  const f = fixture({ admins: [owner] });
  assert.equal(await f.handler.handle(f.api, f.event('إيقاف', botID)), true);
  assert.equal(f.controlStore.isPaused(), false);
  assert.equal(f.calls.stops, 0);
  assert.match(f.calls.sent.at(-1).message, /غير مسجل كمشرف/);
});

test('duplicate self message event is ignored, while a new message ID is accepted', async () => {
  const f = fixture();
  const first = f.event('إيقاف', botID, 'same-dm', false, 'same-message');
  assert.equal(await f.handler.handle(f.api, first), true);
  assert.equal(f.calls.stops, 1);
  const sentAfterFirst = f.calls.sent.length;
  assert.equal(await f.handler.handle(f.api, first), true);
  assert.equal(f.calls.stops, 1);
  assert.equal(f.calls.sent.length, sentAfterFirst);

  assert.equal(await f.handler.handle(f.api, f.event('إيقاف', botID, 'same-dm', false, 'new-message')), true);
  assert.equal(f.calls.stops, 1);
  assert.match(f.calls.sent.at(-1).message, /بالفعل/);
});

test('stop persists a paused mode while preserving the private command listener, then start resumes', async () => {
  const f = fixture();
  assert.equal(await f.handler.handle(f.api, f.event('إيقاف')), true);
  assert.equal(f.controlStore.isPaused(), true);
  assert.equal(f.calls.stops, 1);
  assert.match(f.calls.sent.at(-1).message, /مستمع الخاص/);
  assert.match(f.calls.sent.at(-1).message, /صيانة الاتصال والذاكرة/);
  assert.match(f.calls.sent.at(-1).message, /خدمة Railway نفسها لم تُطفأ/);

  assert.equal(await f.handler.handle(f.api, f.event('تشغيل')), true);
  assert.equal(f.controlStore.isPaused(), false);
  assert.equal(f.calls.starts, 1);
  assert.match(f.calls.sent.at(-1).message, /تم استئناف/);
});

test('repeated stop is idempotent and start failure rolls back to paused', async () => {
  const f = fixture({ paused: true, actions: { onStart: () => false } });
  assert.equal(await f.handler.handle(f.api, f.event('إيقاف')), true);
  assert.equal(f.calls.stops, 0);
  assert.match(f.calls.sent.at(-1).message, /بالفعل/);
  assert.equal(await f.handler.handle(f.api, f.event('تشغيل')), true);
  assert.equal(f.controlStore.isPaused(), true);
  assert.match(f.calls.sent.at(-1).message, /بقي البوت متوقفًا مؤقتًا/);
});

test('stop failure rolls back the persisted pause and does not claim success', async () => {
  const f = fixture({ actions: { onStop: () => false } });
  await f.handler.handle(f.api, f.event('إيقاف'));
  assert.equal(f.controlStore.isPaused(), false);
  assert.doesNotMatch(f.calls.sent.at(-1).message, /تم إيقاف/);
  assert.match(f.calls.sent.at(-1).message, /تعذر إيقاف مهام البوت/);
});

test('restart acknowledges in the same DM and does not erase a saved paused state', async () => {
  const f = fixture({ paused: true });
  await f.handler.handle(f.api, f.event('إعادة تشغيل', botID, 'restart-dm'));
  assert.equal(f.calls.restarts, 1);
  assert.equal(f.controlStore.isPaused(), true);
  assert.equal(f.calls.sent[0].threadID, 'restart-dm');
  assert.match(f.calls.sent[0].message, /سأحافظ على حالة التشغيل/);
});

test('admin add/remove updates only the persistent admin store and protects self and last admin', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`إضافة مشرف ${member}`));
  assert.equal(f.members.has(member), true);
  assert.match(f.calls.sent.at(-1).message, /تمت إضافة المشرف/);

  await f.handler.handle(f.api, f.event(`حذف مشرف ${member}`));
  assert.equal(f.members.has(member), false);
  assert.match(f.calls.sent.at(-1).message, /تم سحب صلاحية المشرف/);

  await f.handler.handle(f.api, f.event(`حذف مشرف ${botID}`));
  assert.equal(f.members.has(botID), true);
  assert.match(f.calls.sent.at(-1).message, /الحساب الذي أرسل الأمر/);

  const only = fixture({ admins: [botID] });
  await only.handler.handle(only.api, only.event(`حذف مشرف ${botID}`));
  assert.equal(only.members.has(botID), true);
  assert.match(only.calls.sent.at(-1).message, /الحساب الذي أرسل الأمر/);

  const lastAdmin = fixture({ admins: [botID] });
  lastAdmin.adminStore.remove = () => ({ ok: false, reason: 'last' });
  await lastAdmin.handler.handle(lastAdmin.api, lastAdmin.event(`حذف مشرف ${member}`));
  assert.equal(lastAdmin.members.has(botID), true);
  assert.match(lastAdmin.calls.sent.at(-1).message, /آخر مشرف/);
});

test('bot account cannot remove its own authorization and is enrolled only with a valid account ID', () => {
  const f = fixture();
  const result = registerBotAccountAsAdmin(f.adminStore, botID);
  assert.equal(result.ok, true);
  const invalid = registerBotAccountAsAdmin(f.adminStore, 'not-an-id');
  assert.deepEqual(invalid, { ok: false, reason: 'identity' });
});

test('storage failures do not claim successful stop or admin changes', async () => {
  const f = fixture();
  f.controlStore.setPaused = () => ({ ok: false, reason: 'storage' });
  await f.handler.handle(f.api, f.event('إيقاف'));
  assert.equal(f.calls.stops, 0);
  assert.match(f.calls.sent.at(-1).message, /تعذر حفظ حالة الإيقاف/);

  f.adminStore.add = () => ({ ok: false, reason: 'storage' });
  await f.handler.handle(f.api, f.event(`إضافة مشرف ${member}`));
  assert.match(f.calls.sent.at(-1).message, /لم تُمنح الصلاحية/);
});

test('send failures do not crash management handling or trigger a false restart', async () => {
  const f = fixture();
  f.api.sendMessage = async () => { throw new Error('transport failure'); };
  await f.handler.handle(f.api, f.event('إعادة تشغيل'));
  assert.equal(f.calls.restarts, 0);
});
