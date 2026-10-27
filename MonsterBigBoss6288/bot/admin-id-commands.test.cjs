'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdminIdHandler, commandEntries } = require('./admin-id-commands.cjs');

const owner = '61594703229486';
const member = '200000000001';
const outsider = '300000000001';
const inviteTarget = '400000000001';

function fixture(admins = [owner, member]) {
  let now = 1000;
  const state = new Set(admins);
  const store = {
    load: () => new Set(state),
    isAdmin: id => state.has(String(id)),
    remove: id => {
      id = String(id);
      if (!state.has(id)) return { ok: true, changed: false };
      if (state.size <= 1) return { ok: false, reason: 'last' };
      state.delete(id);
      return { ok: true, changed: true };
    }
  };
  const sent = [];
  const added = [];
  const api = {
    sendMessage(message, threadID) { sent.push({ message, threadID }); },
    addUserToGroup(targetID, threadID, callback) {
      added.push({ targetID: String(targetID), threadID: String(threadID) });
      callback();
    }
  };
  const handler = createAdminIdHandler({ store, clock: () => now });
  const event = (body, senderID = owner, threadID = 't1', extra = {}) => ({
    body, senderID, threadID, isGroup: true, ...extra
  });
  return { store, sent, added, handler, api, event, tick(ms) { now += ms; } };
}

test('lists fresh current admins and supports both inline removal orders', async () => {
  for (const form of [`سحب البوت ${member}`, `${member} سحب البوت`]) {
    const f = fixture();
    await f.handler.handle(f.api, f.event('عرض ادمن البوت'));
    assert.match(f.sent[0].message, new RegExp(`1\\. ${owner}`));
    assert.match(f.sent[0].message, new RegExp(member));
    await f.handler.handle(f.api, f.event(form));
    assert.equal(f.store.isAdmin(member), false);
    assert.match(f.sent.at(-1).message, /تم سحب/);
  }
});

test('inline removal clears an earlier pending selection', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event('عرض ادمن البوت'));
  await f.handler.handle(f.api, f.event(member));
  await f.handler.handle(f.api, f.event(`سحب البوت ${owner}`));
  assert.equal(f.store.isAdmin(owner), false);
  assert.equal(await f.handler.handle(f.api, f.event('سحب البوت')), true);
  assert.equal(f.store.isAdmin(member), true);
});

test('bare ID requires same flow, then explicit confirmation', async () => {
  const f = fixture();
  assert.equal(await f.handler.handle(f.api, f.event(member)), false);
  await f.handler.handle(f.api, f.event('عرض ادمن البوت'));
  await f.handler.handle(f.api, f.event(member));
  assert.equal(f.store.isAdmin(member), true);
  await f.handler.handle(f.api, f.event('سحب البوت'));
  assert.equal(f.store.isAdmin(member), false);
});

test('selection is sender/thread isolated, expires, and revoked requester is silent', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event('عرض ادمن البوت', owner, 'a'));
  assert.equal(await f.handler.handle(f.api, f.event(member, owner, 'b')), false);
  f.store.isAdmin = id => id === owner;
  assert.equal(await f.handler.handle(f.api, f.event(member, owner, 'a')), true);
  assert.equal(f.store.isAdmin(member), false);
  const g = fixture();
  await g.handler.handle(g.api, g.event('عرض ادمن البوت'));
  g.tick(120001);
  assert.equal(await g.handler.handle(g.api, g.event(member)), false);
  assert.equal(g.store.isAdmin(member), true);
});

test('invalid, nonmember, last-admin, and persistence failures never claim success', async () => {
  const f = fixture([owner]);
  await f.handler.handle(f.api, f.event('عرض ادمن البوت'));
  await f.handler.handle(f.api, f.event('123 سحب البوت'));
  assert.match(f.sent.at(-1).message, /ليس مشرفًا/);
  await f.handler.handle(f.api, f.event('سحب البوت'));
  assert.match(f.sent.at(-1).message, /استخدم/);
  await f.handler.handle(f.api, f.event('عرض ادمن البوت'));
  await f.handler.handle(f.api, f.event(owner));
  await f.handler.handle(f.api, f.event('سحب البوت'));
  assert.match(f.sent.at(-1).message, /آخر مشرف/);
  const g = fixture();
  g.store.remove = () => ({ ok: false, reason: 'storage' });
  await g.handler.handle(g.api, g.event('عرض ادمن البوت', owner));
  await g.handler.handle(g.api, g.event(member, owner));
  await g.handler.handle(g.api, g.event('سحب البوت', owner));
  assert.match(g.sent.at(-1).message, /تعذر حفظ/);
});

test('command metadata exposes admin management and manual group invitation', () => {
  const entries = commandEntries(fixture().handler);
  assert.deepEqual(entries.map(entry => entry.name), ['عرض ادمن البوت', 'سحب البوت', 'اضف']);
});

test('non-admin command forms stay silent, including invitation and confirmation', async () => {
  const f = fixture();
  const before = f.sent.length;
  for (const body of [
    'عرض ادمن البوت', `سحب البوت ${member}`, 'سحب البوت',
    `اضف ${inviteTarget}`, `تأكيد الإضافة ${inviteTarget}`, 'إلغاء الإضافة'
  ]) {
    await f.handler.handle(f.api, f.event(body, outsider));
  }
  assert.equal(f.sent.length, before);
  assert.equal(f.added.length, 0);
});

test('malformed inline removal is handled without writes', async () => {
  for (const body of ['سحب البوت abc', 'سحب البوت 0', 'سحب البوت 123 extra']) {
    const f = fixture();
    await f.handler.handle(f.api, f.event(body));
    assert.equal(f.store.isAdmin(member), true);
    assert.match(f.sent.at(-1).message, /الصيغة الصحيحة/);
  }
  const f = fixture();
  const before = f.sent.length;
  assert.equal(await f.handler.handle(f.api, f.event('سحب البوت abc', outsider)), true);
  assert.equal(f.sent.length, before);
  assert.equal(f.store.isAdmin(member), true);
});

test('manual invitation needs an exact second confirmation and runs once in the same group', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`, owner, 'group-a'));
  assert.equal(f.added.length, 0);
  assert.equal(f.sent.at(-1).threadID, 'group-a');
  assert.match(f.sent.at(-1).message, /موافقة صاحبه/);
  assert.match(f.sent.at(-1).message, new RegExp(`تأكيد الإضافة ${inviteTarget}`));

  await f.handler.handle(f.api, f.event('تأكيد الإضافة', owner, 'group-a'));
  assert.equal(f.added.length, 0);
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`, owner, 'group-b'));
  assert.equal(f.added.length, 0);
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`, owner, 'group-a'));
  assert.deepEqual(f.added, [{ targetID: inviteTarget, threadID: 'group-a' }]);
  assert.match(f.sent.at(-1).message, /تمت إضافة/);
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`, owner, 'group-a'));
  assert.equal(f.added.length, 1);
});

test('invitation confirmation is requester- and target-isolated', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`, owner, 'group-a'));
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`, member, 'group-a'));
  await f.handler.handle(f.api, f.event('تأكيد الإضافة 400000000002', owner, 'group-a'));
  assert.equal(f.added.length, 0);
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`, owner, 'group-a'));
  assert.equal(f.added.length, 1);
});

test('invitation rejects invalid IDs and DMs without adding anyone', async () => {
  for (const body of ['اضف', 'اضف 0', 'اضف 123', 'اضف abc', 'اضف 400000000001 extra']) {
    const f = fixture();
    await f.handler.handle(f.api, f.event(body));
    assert.equal(f.added.length, 0);
    assert.match(f.sent.at(-1).message, /الصيغة الصحيحة/);
  }
  const g = fixture();
  await g.handler.handle(g.api, g.event(`اضف ${inviteTarget}`, owner, 'dm-a', { isGroup: false }));
  assert.equal(g.added.length, 0);
  assert.match(g.sent.at(-1).message, /داخل المجموعة فقط/);
});

test('invitation expires and a revoked admin cannot confirm', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`));
  f.tick(120001);
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`));
  assert.equal(f.added.length, 0);

  const g = fixture();
  await g.handler.handle(g.api, g.event(`اضف ${inviteTarget}`));
  g.store.isAdmin = id => id === member;
  const before = g.sent.length;
  await g.handler.handle(g.api, g.event(`تأكيد الإضافة ${inviteTarget}`, owner));
  assert.equal(g.sent.length, before);
  assert.equal(g.added.length, 0);
});

test('failed Messenger invite never reports success', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`));
  f.api.addUserToGroup = (targetID, threadID, callback) => {
    f.added.push({ targetID: String(targetID), threadID: String(threadID) });
    callback(new Error('Messenger rejected request'));
  };
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`));
  assert.equal(f.added.length, 1);
  assert.match(f.sent.at(-1).message, /تعذرت إضافة/);
  assert.doesNotMatch(f.sent.at(-1).message, /✅/);
});

test('promise-based Messenger invite is supported', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`));
  f.api.addUserToGroup = async (targetID, threadID) => {
    f.added.push({ targetID: String(targetID), threadID: String(threadID) });
  };
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`));
  assert.deepEqual(f.added, [{ targetID: inviteTarget, threadID: 't1' }]);
  assert.match(f.sent.at(-1).message, /تمت إضافة/);
});

test('a returned request object is not accepted before its callback confirms success', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`));
  f.api.addUserToGroup = (targetID, threadID, callback) => {
    f.added.push({ targetID: String(targetID), threadID: String(threadID) });
    setImmediate(() => callback(new Error('later rejection')));
    return { request: true };
  };
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`));
  assert.equal(f.added.length, 1);
  assert.match(f.sent.at(-1).message, /تعذرت إضافة/);
});

test('a rejected or negative Promise invite and an unavailable API never claim success', async () => {
  for (const scenario of ['reject', 'false', 'missing']) {
    const f = fixture();
    await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`));
    if (scenario === 'missing') delete f.api.addUserToGroup;
    else f.api.addUserToGroup = async () => {
      if (scenario === 'reject') throw new Error('denied');
      return false;
    };
    await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`));
    assert.match(f.sent.at(-1).message, /تعذرت إضافة/);
    assert.doesNotMatch(f.sent.at(-1).message, /✅/);
  }
});

test('cancel is requester-specific and a cancelled invitation cannot run', async () => {
  const f = fixture();
  await f.handler.handle(f.api, f.event(`اضف ${inviteTarget}`));
  await f.handler.handle(f.api, f.event('إلغاء الإضافة', member));
  await f.handler.handle(f.api, f.event('إلغاء الإضافة', owner));
  await f.handler.handle(f.api, f.event(`تأكيد الإضافة ${inviteTarget}`, owner));
  assert.equal(f.added.length, 0);
});
