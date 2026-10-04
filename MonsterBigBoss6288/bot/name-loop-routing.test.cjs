const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { cancelActiveNameLoops, handleMessage } = require('./main');
const nicknameCommand = require('./Commands/هويه');
const groupCommand = require('./Commands/قروب');

function enableMockTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
}

async function flushAsyncWork() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function makeApi(overrides = {}) {
  const calls = {
    messages: [],
    nicknames: [],
    groupNames: [],
    threadInfo: []
  };

  const api = {
    async sendMessage(message, threadID) {
      calls.messages.push({ message, threadID: String(threadID) });
      if (overrides.sendMessage) return overrides.sendMessage(message, threadID);
    },
    async getThreadInfo(threadID) {
      calls.threadInfo.push(String(threadID));
      if (overrides.getThreadInfo) return overrides.getThreadInfo(threadID, calls);
      return { participantIDs: ['member-1'], threadName: 'محمي' };
    },
    async nickname(nickname, threadID, userID) {
      calls.nicknames.push({ nickname, threadID: String(threadID), userID });
      if (overrides.nickname) return overrides.nickname(nickname, threadID, userID);
    },
    async gcname(groupName, threadID) {
      calls.groupNames.push({ groupName, threadID: String(threadID) });
      if (overrides.gcname) return overrides.gcname(groupName, threadID);
    }
  };

  return { api, calls };
}

function dependencies(commands, overrides = {}) {
  return {
    commands,
    isAdmin: overrides.isAdmin || (() => true),
    isCommandEnabled: overrides.isCommandEnabled || (() => true)
  };
}

async function dispatch(api, commands, body, threadID) {
  await handleMessage(
    api,
    { body, threadID, senderID: 'admin' },
    dependencies(commands)
  );
  await flushAsyncWork();
}

test('dispatcher routes هويه, alias هوية, and قروب to their loaded commands', async () => {
  const dispatched = [];
  const commands = new Map([
    ['هويه', { execute: (_api, event) => dispatched.push(['nickname', event.body]) }],
    ['قروب', { execute: (_api, event) => dispatched.push(['group', event.body]) }]
  ]);
  const api = { sendMessage: async () => {} };

  await handleMessage(api, { body: 'هويه لقب', threadID: 't-1', senderID: 'admin' }, dependencies(commands));
  await handleMessage(api, { body: 'هوية لقب', threadID: 't-1', senderID: 'admin' }, dependencies(commands));
  await handleMessage(api, { body: 'قروب اسم جديد', threadID: 't-1', senderID: 'admin' }, dependencies(commands));

  assert.deepEqual(dispatched, [
    ['nickname', 'هويه لقب'],
    ['nickname', 'هوية لقب'],
    ['group', 'قروب اسم جديد']
  ]);
});

test('إيقاف الاسم cancels both loops only in the current thread', async t => {
  enableMockTimers(t);
  nicknameCommand.cancelAll();
  groupCommand.cancelAll();

  const commands = new Map([
    ['هويه', nicknameCommand],
    ['قروب', groupCommand]
  ]);
  const { api, calls } = makeApi();

  await dispatch(api, commands, 'هويه لقب أ', 'thread-a');
  await dispatch(api, commands, 'هويه لقب ب', 'thread-b');
  await dispatch(api, commands, 'قروب اسم أ', 'thread-a');
  await dispatch(api, commands, 'قروب اسم ب', 'thread-b');
  await dispatch(api, commands, 'إيقاف الاسم', 'thread-a');

  assert.ok(calls.messages.some(({ message, threadID }) =>
    threadID === 'thread-a' && message.includes('تم إيقاف حلقات تغيير الكنيات واسم المجموعة')
  ));

  t.mock.timers.tick(10_000);
  await flushAsyncWork();

  assert.deepEqual(calls.nicknames.map(call => call.threadID), ['thread-b']);
  assert.deepEqual(calls.groupNames.map(call => call.threadID), ['thread-b']);
  assert.equal(groupCommand.cancel('thread-b'), true);
  assert.equal(groupCommand.cancel('thread-a'), false);
});

test('a repeated قروب invocation replaces the pending delay instead of creating duplicate loops', async t => {
  enableMockTimers(t);
  groupCommand.cancelAll();

  const { api, calls } = makeApi();
  const first = groupCommand.execute(api, { body: 'قروب الاسم الأول', threadID: 'thread-dup' });
  await flushAsyncWork();
  const second = groupCommand.execute(api, { body: 'قروب الاسم الثاني', threadID: 'thread-dup' });
  await flushAsyncWork();

  t.mock.timers.tick(10_000);
  await Promise.all([first, second]);
  await flushAsyncWork();

  assert.deepEqual(calls.groupNames, [{ groupName: 'الاسم الثاني', threadID: 'thread-dup' }]);
  assert.equal(groupCommand.cancel('thread-dup'), true);
});

test('قروب protection ends at 24 hours and does not keep polling afterward', async t => {
  enableMockTimers(t);
  groupCommand.cancelAll();

  const { api, calls } = makeApi({
    getThreadInfo: async () => ({ threadName: 'اسم محمي' })
  });
  const operation = groupCommand.execute(api, {
    body: 'قروب اسم محمي',
    threadID: 'thread-expiry'
  });

  t.mock.timers.tick(10_000);
  await operation;
  await flushAsyncWork();
  assert.deepEqual(calls.groupNames, [{ groupName: 'اسم محمي', threadID: 'thread-expiry' }]);

  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await flushAsyncWork();
  assert.equal(groupCommand.cancel('thread-expiry'), false);

  const readsAfterExpiry = calls.threadInfo.length;
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.threadInfo.length, readsAfterExpiry);
  assert.equal(calls.groupNames.length, 1);
});

test('disconnect cleanup cancels all name loops and prevents an in-flight stale poll from mutating', async t => {
  enableMockTimers(t);
  nicknameCommand.cancelAll();
  groupCommand.cancelAll();

  let resolveThreadInfo;
  const groupApi = makeApi({
    getThreadInfo: () => new Promise(resolve => { resolveThreadInfo = resolve; })
  });
  const nicknameApi = makeApi();
  const commands = new Map([
    ['هويه', nicknameCommand],
    ['قروب', groupCommand]
  ]);

  const groupRun = groupCommand.execute(groupApi.api, {
    body: 'قروب اسم محمي',
    threadID: 'thread-disconnect'
  });
  t.mock.timers.tick(10_000);
  await groupRun;
  await flushAsyncWork();

  // يبدأ فحص القروب ويمكث طلب API مفتوحًا حين يقع قطع الاتصال.
  t.mock.timers.tick(10_000);
  await flushAsyncWork();
  assert.equal(typeof resolveThreadInfo, 'function');

  const nicknameRun = nicknameCommand.execute(nicknameApi.api, {
    body: 'هويه لقب',
    threadID: 'thread-disconnect'
  });
  await flushAsyncWork();

  assert.equal(cancelActiveNameLoops(undefined, commands), 2);
  resolveThreadInfo({ threadName: 'اسم تغيّر أثناء الانقطاع' });
  await Promise.all([groupRun, nicknameRun]);
  await flushAsyncWork();

  const groupMutationCount = groupApi.calls.groupNames.length;
  assert.equal(groupMutationCount, 1);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await flushAsyncWork();

  assert.equal(groupApi.calls.groupNames.length, groupMutationCount);
  assert.equal(nicknameApi.calls.nicknames.length, 0);
  assert.equal(groupCommand.cancel('thread-disconnect'), false);
});

test('restart path invokes name-loop cleanup', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const restartBody = indexSource.match(/function scheduleRestart\(delay\) \{([\s\S]*?)\n\}/);

  assert.ok(restartBody, 'scheduleRestart should be present');
  assert.match(restartBody[1], /cancelActiveNameLoops\(\)/);
});
