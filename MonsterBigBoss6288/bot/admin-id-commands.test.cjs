'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdminIdHandler, commandEntries } = require('./admin-id-commands.cjs');

const owner = '61594703229486';
const member = '200000000001';
const outsider = '300000000001';

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
  const api = { sendMessage(message, threadID) { sent.push({ message, threadID }); } };
  const handler = createAdminIdHandler({ store, clock: () => now });
  const event = (body, senderID = owner, threadID = 't1') => ({ body, senderID, threadID });
  return { store, sent, handler, api, event, tick(ms) { now += ms; } };
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

test('command metadata exposes both commands without nested Commands changes', () => {
  const entries = commandEntries(fixture().handler);
  assert.deepEqual(entries.map(entry => entry.name), ['عرض ادمن البوت', 'سحب البوت']);
});

test('non-admin command forms are silent', async () => {
  const f = fixture();
  const before = f.sent.length;
  for (const body of ['عرض ادمن البوت', `سحب البوت ${member}`, 'سحب البوت']) {
    await f.handler.handle(f.api, f.event(body, outsider));
  }
  assert.equal(f.sent.length, before);
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
