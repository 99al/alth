'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
process.env.NODE_ENV = 'test';
process.env.ALTH_COMMAND_STATE_PATH = path.join(os.tmpdir(), `alth-jareed-recipients-${process.pid}`, 'state.json');
const commandState = require('./command-state.cjs').defaultStore;

function freshCommand() {
  const resolved = require.resolve('./Commands/جريد.js');
  delete require.cache[resolved];
  return require(resolved);
}

function makeApi({ threads = [], callbackStyle = false } = {}) {
  const calls = { messages: [], listCalls: 0 };
  const api = {
    async sendMessage(message, threadID) {
      calls.messages.push({ message, threadID: String(threadID) });
    },
    getThreadList(limit, timestamp, callback) {
      calls.listCalls += 1;
      assert.equal(limit, 100);
      assert.equal(timestamp, null);
      if (callbackStyle) {
        setImmediate(() => callback(null, threads));
        return undefined;
      }
      return Promise.resolve(threads);
    }
  };
  return { api, calls };
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('private جريد lists direct chats, selects named recipients, sends to them, and stops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const command = freshCommand();
  const control = { threadID: 'admin-dm', senderID: 'owner-id', isGroup: false };
  const { api, calls } = makeApi({ threads: [
    { threadID: 'person-1', name: 'ليلى', isGroup: false },
    { threadID: 'group-1', name: 'مجموعة', isGroup: true },
    { threadID: 'person-2', name: 'سامي', isGroup: false },
    { threadID: 'owner-id', name: 'المشرف', isGroup: false }
  ] });
  t.after(() => {
    command.pauseAll();
    commandState.clear('جريد');
  });

  await command.execute(api, { ...control, body: 'جريد' });
  assert.equal(calls.listCalls, 1);
  assert.match(calls.messages.at(-1).message, /1\. ليلى/u);
  assert.match(calls.messages.at(-1).message, /2\. سامي/u);
  assert.doesNotMatch(calls.messages.at(-1).message, /مجموعة|المشرف/u);

  await command.execute(api, { ...control, body: 'جريد اختيار ١،٢' });
  assert.match(calls.messages.at(-1).message, /تم تحديد 2/u);
  await command.execute(api, { ...control, body: 'جريد 1 1 رسالة اختبار' });
  const saved = commandState.get('جريد', control.threadID);
  assert.deepEqual(saved.recipients.map(recipient => recipient.threadID), ['person-1', 'person-2']);
  assert.equal(command.isActive(control.threadID), true);

  t.mock.timers.tick(1000);
  await flushAsyncWork();
  assert.deepEqual(
    calls.messages.filter(call => call.message === 'رسالة اختبار').map(call => call.threadID),
    ['person-1', 'person-2']
  );

  await command.execute(api, { ...control, body: 'جريد ايقاف' });
  assert.equal(command.isActive(control.threadID), false);
  assert.equal(commandState.get('جريد', control.threadID), undefined);
});

test('private recipient list supports the legacy callback API and excludes group chats', async t => {
  const command = freshCommand();
  const { api, calls } = makeApi({ callbackStyle: true, threads: [
    { threadID: 'direct-1', threadName: 'محادثة خاصة', isGroup: false },
    { threadID: 'group-2', threadName: 'مجموعة كبيرة', isGroup: true }
  ] });
  t.after(() => {
    command.pauseAll();
    commandState.clear('جريد');
  });
  await command.execute(api, { body: 'جريد', threadID: 'admin-dm-2', senderID: 'owner-2', isGroup: false });
  assert.equal(calls.listCalls, 1);
  assert.match(calls.messages.at(-1).message, /محادثة خاصة/u);
  assert.doesNotMatch(calls.messages.at(-1).message, /مجموعة كبيرة/u);
});

test('group schedule remains scoped to the group and retains the old syntax', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const command = freshCommand();
  const { api, calls } = makeApi();
  t.after(() => {
    command.pauseAll();
    commandState.clear('جريد');
  });
  await command.execute(api, { body: 'جريد ٢ ٢ رسالة مجموعة ٣', threadID: 'group-thread', senderID: 'admin', isGroup: true });
  assert.equal(commandState.get('جريد', 'group-thread').recipients, undefined);
  assert.equal(commandState.get('جريد', 'group-thread').message, 'رسالة مجموعة ٣');
  t.mock.timers.tick(2000);
  await flushAsyncWork();
  assert.ok(calls.messages.some(call => call.message === 'رسالة مجموعة ٣' && call.threadID === 'group-thread'));
  await command.execute(api, { body: 'جريد ايقاف', threadID: 'group-thread', senderID: 'admin', isGroup: true });
  assert.equal(command.isActive('group-thread'), false);
});

test('a saved multi-recipient schedule resumes after module reload and can be stopped in its control chat', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controlThreadID = 'saved-admin-dm';
  commandState.set('جريد', controlThreadID, {
    minSeconds: 1,
    maxSeconds: 1,
    message: 'رسالة مستعادة',
    recipients: [
      { threadID: 'saved-person-1', name: 'شخص 1' },
      { threadID: 'saved-person-2', name: 'شخص 2' }
    ]
  });
  const command = freshCommand();
  const { api, calls } = makeApi();
  t.after(() => {
    command.pauseAll();
    commandState.clear('جريد');
  });
  assert.equal(command.resumeAll(api), 1);
  t.mock.timers.tick(1000);
  await flushAsyncWork();
  assert.deepEqual(
    calls.messages.filter(call => call.message === 'رسالة مستعادة').map(call => call.threadID),
    ['saved-person-1', 'saved-person-2']
  );
  await command.execute(api, { body: 'جريد ايقاف', threadID: controlThreadID, senderID: 'owner', isGroup: false });
  assert.equal(command.isActive(controlThreadID), false);
  assert.equal(commandState.get('جريد', controlThreadID), undefined);
});
