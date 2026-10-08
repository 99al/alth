'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.ALTH_COMMAND_STATE_PATH = path.join(os.tmpdir(), `alth-persistent-commands-${process.pid}`, 'state.json');

const {
  createCommandStateStore,
  defaultStore: commandState,
  resolveStatePath,
  PRODUCTION_STATE_PATH
} = require('./command-state.cjs');

function fresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

function makeApi(overrides = {}) {
  const calls = { messages: [], nicknames: [], groupNames: [], threadInfo: 0, typing: [] };
  const api = {
    async sendMessage(message, threadID) {
      calls.messages.push({ message, threadID: String(threadID) });
      if (overrides.sendMessage) return overrides.sendMessage(message, threadID, calls);
    },
    async getThreadInfo(threadID) {
      calls.threadInfo++;
      if (overrides.getThreadInfo) return overrides.getThreadInfo(threadID, calls);
      return {
        participantIDs: ['member-1'],
        threadName: 'اسم محمي',
        nicknames: { 'member-1': 'كنية محمية' }
      };
    },
    async nickname(nickname, threadID, userID) {
      calls.nicknames.push({ nickname, threadID: String(threadID), userID: String(userID) });
      if (overrides.nickname) return overrides.nickname(nickname, threadID, userID, calls);
    },
    async gcname(name, threadID) {
      calls.groupNames.push({ name, threadID: String(threadID) });
      if (overrides.gcname) return overrides.gcname(name, threadID, calls);
    },
    async sendTypingIndicator(threadID, active) {
      calls.typing.push({ threadID: String(threadID), active });
    }
  };
  return { api, calls };
}

async function flushAsyncWork() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('command state survives a new store instance and is written with private permissions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-state-store-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state', 'active.json');
  const first = createCommandStateStore({ filePath });
  first.set('جريد', 'thread-store', { minSeconds: 3, maxSeconds: 8, message: 'رسالة' });
  first.set('جريد', '__proto__', { minSeconds: 4, maxSeconds: 9, message: 'مفتاح' });

  const restarted = createCommandStateStore({ filePath });
  assert.deepEqual(restarted.get('جريد', 'thread-store'), {
    minSeconds: 3,
    maxSeconds: 8,
    message: 'رسالة'
  });
  assert.deepEqual(restarted.get('جريد', '__proto__'), {
    minSeconds: 4,
    maxSeconds: 9,
    message: 'مفتاح'
  });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
});

test('production scheduled-command state resolves to the Railway volume', () => {
  assert.equal(resolveStatePath({ NODE_ENV: 'production' }), PRODUCTION_STATE_PATH);
  assert.equal(resolveStatePath({ NODE_ENV: 'test', RAILWAY_PROJECT_ID: 'test-project' }), PRODUCTION_STATE_PATH);
});

test('ويس resumes from saved state after a module reload and manual stop removes it permanently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const threadID = 'thread-wis-persist';
  const initial = fresh('./Commands/قصف.js');
  initial.cancelAll();
  commandState.set('ويس', threadID, true);

  const { api } = makeApi();
  const resumed = fresh('./Commands/قصف.js');
  assert.equal(resumed.resumeAll(api), 1);
  assert.equal(resumed.isActive(threadID), true);

  await resumed.execute(api, { body: 'ويس ايقاف', threadID });
  assert.equal(commandState.get('ويس', threadID), undefined);
  assert.equal(resumed.isActive(threadID), false);

  resumed.pauseAll();
  const afterManualStop = fresh('./Commands/قصف.js');
  assert.equal(afterManualStop.resumeAll(api), 0);
  t.after(() => afterManualStop.pauseAll());
});

test('جريد restores a saved schedule and manual stop prevents it from returning', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const threadID = 'thread-jareed-persist';
  const initial = fresh('./Commands/جريد.js');
  initial.pauseAll();
  commandState.set('جريد', threadID, { minSeconds: 60, maxSeconds: 60, message: 'رسالة اختبار' });

  const { api } = makeApi();
  const resumed = fresh('./Commands/جريد.js');
  assert.equal(resumed.resumeAll(api), 1);
  assert.equal(resumed.isActive(threadID), true);
  await resumed.execute(api, { body: 'جريد ايقاف', threadID });
  assert.equal(commandState.get('جريد', threadID), undefined);
  assert.equal(resumed.isActive(threadID), false);

  const afterManualStop = fresh('./Commands/جريد.js');
  assert.equal(afterManualStop.resumeAll(api), 0);
  t.after(() => afterManualStop.pauseAll());
});

test('قروب and هويه resume saved protection after module reload, but manual stop deletes it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const apiGroup = makeApi({ getThreadInfo: async () => ({ threadName: 'اسم قديم' }) });
  const apiNickname = makeApi({ getThreadInfo: async () => ({
    participantIDs: ['member-1'],
    nicknames: { 'member-1': 'كنية قديمة' }
  }) });
  commandState.set('قروب', 'thread-group-reload', { name: 'اسم محمي' });
  commandState.set('هويه', 'thread-nickname-reload', { nickname: 'كنية محمية' });

  const groupCommand = fresh('./Commands/قروب.js');
  const nicknameCommand = fresh('./Commands/هويه.js');
  assert.equal(groupCommand.resumeAll(apiGroup.api), 1);
  assert.equal(nicknameCommand.resumeAll(apiNickname.api), 1);
  await flushAsyncWork();
  assert.ok(apiGroup.calls.groupNames.some(call => call.name === 'اسم محمي'));
  assert.ok(apiNickname.calls.nicknames.some(call => call.nickname === 'كنية محمية'));

  groupCommand.pauseAll();
  nicknameCommand.pauseAll();
  const groupAfterReload = fresh('./Commands/قروب.js');
  const nicknameAfterReload = fresh('./Commands/هويه.js');
  assert.equal(groupAfterReload.resumeAll(apiGroup.api), 1);
  assert.equal(nicknameAfterReload.resumeAll(apiNickname.api), 1);
  assert.equal(groupAfterReload.cancel('thread-group-reload'), true);
  assert.equal(nicknameAfterReload.cancel('thread-nickname-reload'), true);
  assert.equal(commandState.get('قروب', 'thread-group-reload'), undefined);
  assert.equal(commandState.get('هويه', 'thread-nickname-reload'), undefined);
  assert.equal(fresh('./Commands/قروب.js').resumeAll(apiGroup.api), 0);
  assert.equal(fresh('./Commands/هويه.js').resumeAll(apiNickname.api), 0);
  t.after(() => {
    groupAfterReload.cancelAll();
    nicknameAfterReload.cancelAll();
  });
});

test('كاتش restores stored protection after module reload and stop removes it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const threadID = 'thread-katch-reload';
  const { api, calls } = makeApi({ getThreadInfo: async () => ({
    participantIDs: ['member-1'],
    threadName: 'اسم محمي',
    nicknames: { 'member-1': 'كنية محمية' }
  }) });
  const first = fresh('./Commands/\\u0643\\u0627\\u062a\\u0634.js');
  first.cancelAll();
  await first.execute(api, { body: 'مجموعة اسم محمي', threadID });
  assert.deepEqual(commandState.get('كاتش', threadID), { groupName: 'اسم محمي' });

  first.pauseAll();
  const resumed = fresh('./Commands/\\u0643\\u0627\\u062a\\u0634.js');
  assert.equal(resumed.resumeAll(api), 1);
  await flushAsyncWork();
  resumed.handleGroupNameEvent(api, {
    threadID,
    logMessageData: { name: 'اسم تغيّر' }
  });
  t.mock.timers.tick(300);
  await flushAsyncWork();
  assert.ok(calls.groupNames.filter(call => call.name === 'اسم محمي').length >= 2);

  assert.equal(resumed.cancel(threadID), true);
  assert.equal(commandState.get('كاتش', threadID), undefined);
  assert.equal(fresh('./Commands/\\u0643\\u0627\\u062a\\u0634.js').resumeAll(api), 0);
  t.after(() => resumed.cancelAll());
});

test('رد rules survive command reload and continue replying', async t => {
  const threadID = 'thread-reply-persist';
  const { api, calls } = makeApi();
  const first = fresh('./Commands/رد.js');
  await first.execute(api, { body: 'رد صباح» مرحبًا', threadID });
  assert.deepEqual(commandState.get('رد', threadID), { rules: [['صباح', 'مرحبًا']] });

  const resumed = fresh('./Commands/رد.js');
  await resumed.checkAutoReply(api, { body: 'صباح', threadID });
  assert.ok(calls.messages.some(({ message }) => message === 'مرحبًا'));
  await resumed.execute(api, { body: 'رد حذف صباح', threadID });
  assert.equal(commandState.get('رد', threadID), undefined);
});

test('dispatcher routes جريد, legacy جرائد, and اومر', async () => {
  const { handleMessage, loadCommands, commands } = require('./main');
  const dispatched = [];
  const commandsForTest = new Map([
    ['جريد', { execute: (_api, event) => dispatched.push(event.body) }],
    ['اومر', { execute: (_api, event) => dispatched.push(event.body) }]
  ]);
  const { api } = makeApi();
  const dependencies = { commands: commandsForTest, isAdmin: () => true, isCommandEnabled: () => true };
  await handleMessage(api, { body: 'جريد 2 4 رسالة', threadID: 'route', senderID: 'admin' }, dependencies);
  await handleMessage(api, { body: 'جرائد 2 4 رسالة', threadID: 'route', senderID: 'admin' }, dependencies);
  await handleMessage(api, { body: 'اومر', threadID: 'route', senderID: 'admin' }, dependencies);
  assert.deepEqual(dispatched, ['جريد 2 4 رسالة', 'جريد 2 4 رسالة', 'اومر']);

  loadCommands();
  const helpApi = makeApi();
  await handleMessage(helpApi.api, { body: 'اومر', threadID: 'help', senderID: 'admin' }, {
    commands,
    isAdmin: () => true,
    isCommandEnabled: () => true
  });
  await flushAsyncWork();
  assert.ok(helpApi.calls.messages.some(({ message }) => message.includes('جريد')));
});
