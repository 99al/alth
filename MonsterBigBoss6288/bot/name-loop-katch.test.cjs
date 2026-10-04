const assert = require('node:assert/strict');
const test = require('node:test');
const { cancelActiveNameLoops, handleMessage } = require('./main');
const katchCommand = require('./Commands/\\u0643\\u0627\\u062a\\u0634.js');

function withMockTimers(t) {
  katchCommand.cancelAll();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => katchCommand.cancelAll());
}

async function flushAsyncWork() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function makeApi(overrides = {}) {
  const calls = { messages: [], nicknames: [], groupNames: [] };
  const api = {
    async sendMessage(message, threadID) {
      calls.messages.push({ message, threadID: String(threadID) });
      if (overrides.sendMessage) return overrides.sendMessage(message, threadID);
    },
    async getThreadInfo(threadID) {
      if (overrides.getThreadInfo) return overrides.getThreadInfo(threadID);
      return { participantIDs: [] };
    },
    async nickname(nickname, threadID, userID) {
      calls.nicknames.push({ nickname, threadID: String(threadID), userID: String(userID) });
      if (overrides.nickname) return overrides.nickname(nickname, threadID, userID);
    },
    async gcname(groupName, threadID) {
      calls.groupNames.push({ groupName, threadID: String(threadID) });
      if (overrides.gcname) return overrides.gcname(groupName, threadID);
    }
  };
  return { api, calls };
}

test('كاتش remains a one-shot nickname operation with its existing 1.5-second spacing', async t => {
  withMockTimers(t);
  const { api, calls } = makeApi({
    getThreadInfo: async () => ({ participantIDs: ['member-1', 'member-2'] })
  });
  const operation = katchCommand.execute(api, {
    body: 'كاتش لقب',
    threadID: 'thread-katch-one-shot'
  });
  await flushAsyncWork();
  assert.equal(calls.nicknames.length, 1);

  t.mock.timers.tick(1_500);
  await flushAsyncWork();
  assert.equal(calls.nicknames.length, 2);
  t.mock.timers.tick(1_500);
  await flushAsyncWork();
  await operation;

  assert.equal(calls.nicknames.length, 2);
  assert.equal(katchCommand.getProtectedNicknames().get('thread-katch-one-shot'), 'لقب');
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await flushAsyncWork();
  assert.equal(calls.nicknames.length, 2);
});

test('إيقاف الاسم cancels pending كاتش event timers only for the current thread', async t => {
  withMockTimers(t);
  const commands = new Map([['كاتش', katchCommand]]);
  const { api, calls } = makeApi();
  const dependencies = {
    commands,
    isAdmin: () => true,
    isCommandEnabled: () => true
  };

  katchCommand.getProtectedNicknames().set('thread-stop-katch', 'كنية محمية');
  katchCommand.getProtectedNicknames().set('thread-keep-katch', 'كنية أخرى');
  katchCommand.getProtectedGroupNames().set('thread-stop-katch', 'اسم محمي');
  katchCommand.getProtectedGroupNames().set('thread-keep-katch', 'اسم آخر');

  katchCommand.handleNicknameEvent(api, {
    threadID: 'thread-stop-katch',
    logMessageData: { participant_id: 'member-a', nickname: 'تغيير' }
  });
  katchCommand.handleGroupNameEvent(api, {
    threadID: 'thread-stop-katch',
    logMessageData: { name: 'تغيير' }
  });
  katchCommand.handleNicknameEvent(api, {
    threadID: 'thread-keep-katch',
    logMessageData: { participant_id: 'member-b', nickname: 'تغيير' }
  });
  katchCommand.handleGroupNameEvent(api, {
    threadID: 'thread-keep-katch',
    logMessageData: { name: 'تغيير' }
  });

  await handleMessage(
    api,
    { body: 'إيقاف الاسم', threadID: 'thread-stop-katch', senderID: 'admin' },
    dependencies
  );
  await flushAsyncWork();
  assert.ok(calls.messages.some(({ message }) => message.includes('عمليات تغيير الأسماء')));

  t.mock.timers.tick(500);
  await flushAsyncWork();

  assert.equal(katchCommand.getProtectedNicknames().has('thread-stop-katch'), false);
  assert.equal(katchCommand.getProtectedGroupNames().has('thread-stop-katch'), false);
  assert.equal(katchCommand.getProtectedNicknames().get('thread-keep-katch'), 'كنية أخرى');
  assert.equal(katchCommand.getProtectedGroupNames().get('thread-keep-katch'), 'اسم آخر');
  assert.deepEqual(calls.nicknames.map(call => call.threadID), ['thread-keep-katch']);
  assert.deepEqual(calls.groupNames.map(call => call.threadID), ['thread-keep-katch']);
  katchCommand.cancel('thread-keep-katch');
});

test('disconnect cleanup cancels pending كاتش event timers', async t => {
  withMockTimers(t);
  const commands = new Map([['كاتش', katchCommand]]);
  const { api, calls } = makeApi();

  katchCommand.getProtectedNicknames().set('thread-disconnect-katch', 'كنية');
  katchCommand.getProtectedGroupNames().set('thread-disconnect-katch', 'اسم');
  katchCommand.handleNicknameEvent(api, {
    threadID: 'thread-disconnect-katch',
    logMessageData: { participant_id: 'member-a', nickname: 'تغيير' }
  });
  katchCommand.handleGroupNameEvent(api, {
    threadID: 'thread-disconnect-katch',
    logMessageData: { name: 'تغيير' }
  });

  assert.ok(cancelActiveNameLoops(undefined, commands) > 0);
  t.mock.timers.tick(500);
  await flushAsyncWork();
  assert.equal(calls.nicknames.length, 0);
  assert.equal(calls.groupNames.length, 0);
});
