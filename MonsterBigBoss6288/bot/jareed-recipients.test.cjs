'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.ALTH_COMMAND_STATE_PATH = path.join(os.tmpdir(), `alth-jareed-recipients-${process.pid}`, 'state.json');
const commandState = require('./command-state.cjs').defaultStore;
const profiles = {
  first: { command: 'جريد', aliases: ['جرائد', 'جريد البوت'], other: 'جريدة' },
  second: { command: 'جريدة', aliases: ['جريدة البوت'], other: 'جريد' },
  third: { command: 'جينو', aliases: ['جينو البوت'], other: 'جريدة' },
  fourth: { command: 'جين', aliases: [], other: 'جينو' },
  fifth: { command: 'جودي', aliases: [], other: 'جين' },
  sixth: { command: 'جواد', aliases: [], other: 'جودي' }
};

function freshCommand(profile) {
  process.env.BOT_COMMAND_PROFILE = profile;
  const resolved = require.resolve('./Commands/جريد.js');
  delete require.cache[resolved];
  return require(resolved);
}
function stateKey(profile) { return ['fifth', 'sixth'].includes(profile) ? (profile === 'sixth' ? 'جواد' : 'جودي') : 'جريد'; }
function clearState(profile) { commandState.clear(stateKey(profile)); }
function makeApi({ threads = [], callbackStyle = false, failIDs = [] } = {}) {
  const calls = { messages: [], listCalls: 0 };
  const failures = new Set(failIDs.map(String));
  const api = {
    async sendMessage(message, threadID) {
      const id = String(threadID);
      calls.messages.push({ message, threadID: id });
      if (failures.has(id)) throw new Error(`send failed: ${id}`);
    },
    getThreadList(limit, timestamp, callback) {
      calls.listCalls += 1;
      assert.equal(limit, 100); assert.equal(timestamp, null);
      if (callbackStyle) { setImmediate(() => callback(null, threads)); return undefined; }
      return Promise.resolve(threads);
    }
  };
  return { api, calls };
}
async function flushAsyncWork() {
  for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
}
function cleanup(t, command, profile) {
  t.after(() => { command.pauseAll(); clearState(profile); });
}

for (const profile of Object.keys(profiles)) {
  const cfg = profiles[profile];
  test(`${profile}: private list selects only direct recipients and excludes control/sender`, { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = freshCommand(profile); cleanup(t, command, profile);
    const control = { threadID: 'admin-dm', senderID: 'owner-id', isGroup: false };
    const { api, calls } = makeApi({ threads: [
      { threadID: 'person-1', name: 'ليلى', isGroup: false },
      { threadID: 'group-1', name: 'مجموعة', isGroup: true },
      { threadID: 'person-2', name: 'سامي', isGroup: false },
      { threadID: 'owner-id', name: 'المشرف', isGroup: false }
    ] });
    await command.execute(api, { ...control, body: cfg.command });
    assert.equal(calls.listCalls, 1);
    assert.match(calls.messages.at(-1).message, /1\. ليلى/u);
    assert.match(calls.messages.at(-1).message, /2\. سامي/u);
    assert.doesNotMatch(calls.messages.at(-1).message, /مجموعة|المشرف/u);
    await command.execute(api, { ...control, body: `${cfg.command} اختيار ١،٢` });
    await command.execute(api, { ...control, body: `${cfg.command} 1 1 رسالة اختبار` });
    const saved = commandState.get(stateKey(profile), control.threadID);
    assert.equal(saved.targetType, 'private');
    assert.deepEqual(saved.recipients.map(r => r.threadID), ['person-1', 'person-2']);
    assert.equal(command.isActive(control.threadID), true);
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.deepEqual(calls.messages.filter(c => c.message === 'رسالة اختبار').map(c => c.threadID), ['person-1', 'person-2']);
    await command.execute(api, { ...control, body: `${cfg.command} ايقاف` });
    assert.equal(command.isActive(control.threadID), false);
    assert.equal(commandState.get(stateKey(profile), control.threadID), undefined);
  });

  test(`${profile}: legacy callback listing and old group syntax remain supported`, { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = freshCommand(profile); cleanup(t, command, profile);
    const { api, calls } = makeApi({ callbackStyle: true, threads: [
      { threadID: 'direct-1', threadName: 'محادثة خاصة', isGroup: false },
      { threadID: 'group-2', threadName: 'مجموعة كبيرة', isGroup: true }
    ] });
    await command.execute(api, { body: cfg.command, threadID: 'admin-dm-2', senderID: 'owner-2', isGroup: false });
    assert.equal(calls.listCalls, 1);
    assert.match(calls.messages.at(-1).message, /محادثة خاصة/u);
    assert.doesNotMatch(calls.messages.at(-1).message, /مجموعة كبيرة/u);
    await command.execute(api, { body: `${cfg.command} 2 2 رسالة مجموعة ٣`, threadID: 'group-thread', senderID: 'admin', isGroup: true });
    assert.equal(commandState.get(stateKey(profile), 'group-thread').recipients, undefined);
    t.mock.timers.tick(2000); await flushAsyncWork();
    assert.ok(calls.messages.some(c => c.message === 'رسالة مجموعة ٣' && c.threadID === 'group-thread'));
    await command.execute(api, { body: `${cfg.command} ايقاف`, threadID: 'group-thread', senderID: 'admin', isGroup: true });
    commandState.set(stateKey(profile), 'legacy-resume', { minSeconds: 1, maxSeconds: 1, message: 'legacy restored' });
    assert.equal(command.resumeAll(api), 1);
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.ok(calls.messages.some(c => c.message === 'legacy restored' && c.threadID === 'legacy-resume'));
  });

  test(`${profile}: private schedule refuses to start without an explicit selection`, { concurrency: false }, async t => {
    const command = freshCommand(profile); cleanup(t, command, profile);
    const { api, calls } = makeApi();
    await command.execute(api, { body: `${cfg.command} 1 1 بلا اختيار`, threadID: 'private', senderID: 'private', isGroup: false });
    assert.equal(commandState.get(stateKey(profile), 'private'), undefined);
    assert.match(calls.messages.at(-1).message, /آيدي حساب المستلم/u);
  });

  test(`${profile}: multiple fake-timed cycles send all selected recipients`, { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = freshCommand(profile); cleanup(t, command, profile);
    const listing = makeApi({ threads: [{ threadID: 'r1', name: 'أ', isGroup: false }, { threadID: 'r2', name: 'ب', isGroup: false }] });
    const event = { threadID: 'control', senderID: 'control', isGroup: false };
    await command.execute(listing.api, { ...event, body: cfg.command });
    await command.execute(listing.api, { ...event, body: `${cfg.command} اختيار 1،٢` });
    await command.execute(listing.api, { ...event, body: `${cfg.command} 1 1 دورة` });
    t.mock.timers.tick(1000); await flushAsyncWork();
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.deepEqual(listing.calls.messages.filter(c => c.message === 'دورة').map(c => c.threadID), ['r1', 'r2', 'r1', 'r2']);
  });

  test(`${profile}: a corrupt saved recipients list never falls back to control chat on resume`, { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const key = stateKey(profile);
    commandState.set(key, 'corrupt', { minSeconds: 1, maxSeconds: 1, message: 'لا ترسل', recipients: [{ threadID: 42 }] });
    const command = freshCommand(profile); cleanup(t, command, profile);
    const { api, calls } = makeApi();
    assert.equal(command.resumeAll(api), 0);
    t.mock.timers.tick(5000); await flushAsyncWork();
    assert.equal(calls.messages.filter(c => c.message === 'لا ترسل').length, 0);
    assert.deepEqual(commandState.get(key, 'corrupt').recipients, [{ threadID: 42 }]);
    commandState.set(key, 'missing-private', { targetType: 'private', minSeconds: 1, maxSeconds: 1, message: 'لا fallback' });
    assert.equal(command.resumeAll(api), 0);
    t.mock.timers.tick(2000); await flushAsyncWork();
    assert.equal(calls.messages.filter(c => c.message === 'لا fallback').length, 0);
  });

  test(`${profile}: failed recipient does not stop remaining recipients or later cycles`, { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = freshCommand(profile); cleanup(t, command, profile);
    const event = { threadID: 'control-fail', senderID: 'control-fail', isGroup: false };
    const listed = makeApi({ threads: [{ threadID: 'good-1', name: 'أ', isGroup: false }, { threadID: 'bad', name: 'فاشل', isGroup: false }, { threadID: 'good-2', name: 'ب', isGroup: false }] , failIDs: ['bad'] });
    await command.execute(listed.api, { ...event, body: cfg.command });
    await command.execute(listed.api, { ...event, body: `${cfg.command} اختيار 1،٢،٣` });
    await command.execute(listed.api, { ...event, body: `${cfg.command} 1 1 استمرار` });
    t.mock.timers.tick(1000); await flushAsyncWork();
    t.mock.timers.tick(1000); await flushAsyncWork();
    const sent = listed.calls.messages.filter(c => c.message === 'استمرار').map(c => c.threadID);
    assert.deepEqual(sent, ['good-1', 'bad', 'good-2', 'good-1', 'good-2']);
  });

  test(`${profile}: stopping prevents any new cycles`, { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = freshCommand(profile); cleanup(t, command, profile);
    const { api, calls } = makeApi();
    const event = { threadID: 'stopper', senderID: 'stopper', isGroup: false };
    await command.execute(api, { ...event, body: cfg.command });
    await command.execute(api, { ...event, body: `${cfg.command} اختيار 1` });
    await command.execute(api, { ...event, body: `${cfg.command} 1 1 توقف` });
    await command.execute(api, { ...event, body: `${cfg.command} ايقاف` });
    t.mock.timers.tick(10000); await flushAsyncWork();
    assert.equal(calls.messages.filter(c => c.message === 'توقف').length, 0);
    assert.equal(command.isActive(event.threadID), false);
  });

  test(`${profile}: resume preserves selected recipients and aliases are isolated from the other service`, { concurrency: false }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = freshCommand(profile); cleanup(t, command, profile);
    const key = stateKey(profile);
    commandState.set(key, 'saved', { minSeconds: 1, maxSeconds: 1, message: 'مستعاد', recipients: [{ threadID: 'saved-1', name: 'واحد' }, { threadID: 'saved-2', name: 'اثنان' }] });
    const { api, calls } = makeApi();
    assert.equal(command.resumeAll(api), 1);
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.deepEqual(calls.messages.filter(c => c.message === 'مستعاد').map(c => c.threadID), ['saved-1', 'saved-2']);
    await command.execute(api, { body: `${cfg.other} 1 1 مرفوض`, threadID: 'other', senderID: 'other', isGroup: false });
    assert.equal(commandState.get(key, 'other'), undefined);
    for (const alias of cfg.aliases) {
      const listed = makeApi({ threads: [{ threadID: 'alias-recipient', name: 'مستلم' }] });
      await command.execute(listed.api, { body: alias, threadID: `alias-${alias}`, senderID: `alias-${alias}`, isGroup: false });
      assert.equal(listed.calls.listCalls, 1, `alias ${alias} must be accepted`);
    }
  });
}
