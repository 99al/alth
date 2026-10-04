const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { cancelActiveNameLoops, handleMessage } = require('./main');
const nicknameCommand = require('./Commands/هويه');
const groupCommand = require('./Commands/قروب');
const katchCommand = require('./Commands/\\u0643\\u0627\\u062a\\u0634.js');

function cancelAllCommands() {
  nicknameCommand.cancelAll();
  groupCommand.cancelAll();
  katchCommand.cancelAll();
}

function withMockTimers(t) {
  cancelAllCommands();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => cancelAllCommands());
}

async function flushAsyncWork() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function advanceNicknameDelays(t, count) {
  for (let i = 0; i < count; i++) {
    t.mock.timers.tick(5_000);
    await flushAsyncWork();
  }
}

function makeApi(overrides = {}) {
  const calls = {
    messages: [],
    nicknames: [],
    groupNames: [],
    threadInfo: []
  };
  const nicknamesByThread = new Map();

  const api = {
    async sendMessage(message, threadID) {
      calls.messages.push({ message, threadID: String(threadID) });
      if (overrides.sendMessage) return overrides.sendMessage(message, threadID);
    },
    async getThreadInfo(threadID) {
      const key = String(threadID);
      calls.threadInfo.push(key);
      if (overrides.getThreadInfo) return overrides.getThreadInfo(threadID, calls);
      const nicknames = nicknamesByThread.get(key) || new Map();
      return {
        participantIDs: ['member-1'],
        threadName: 'محمي',
        nicknames: Object.fromEntries(nicknames)
      };
    },
    async nickname(nickname, threadID, userID) {
      const key = String(threadID);
      const memberID = String(userID);
      calls.nicknames.push({ nickname, threadID: key, userID: memberID });
      let threadNicknames = nicknamesByThread.get(key);
      if (!threadNicknames) {
        threadNicknames = new Map();
        nicknamesByThread.set(key, threadNicknames);
      }
      threadNicknames.set(memberID, nickname);
      if (overrides.nickname) return overrides.nickname(nickname, threadID, memberID);
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

function allNameCommands() {
  return new Map([
    ['هويه', nicknameCommand],
    ['قروب', groupCommand],
    ['كاتش', katchCommand]
  ]);
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

test('إيقاف الاسم cancels nickname and group-name loops only in the current thread', async t => {
  withMockTimers(t);

  const commands = allNameCommands();
  const { api, calls } = makeApi();
  katchCommand.getProtectedNicknames().set('thread-a', 'كنية أ');
  katchCommand.getProtectedNicknames().set('thread-b', 'كنية ب');
  katchCommand.getProtectedGroupNames().set('thread-a', 'مجموعة أ');
  katchCommand.getProtectedGroupNames().set('thread-b', 'مجموعة ب');

  await dispatch(api, commands, 'هويه لقب أ', 'thread-a');
  await dispatch(api, commands, 'هويه لقب ب', 'thread-b');
  await dispatch(api, commands, 'قروب اسم أ', 'thread-a');
  await dispatch(api, commands, 'قروب اسم ب', 'thread-b');
  await dispatch(api, commands, 'إيقاف الاسم', 'thread-a');

  assert.ok(calls.messages.some(({ message, threadID }) =>
    threadID === 'thread-a' && message.includes('عمليات تغيير الأسماء والكنيات')
  ));
  assert.equal(katchCommand.getProtectedNicknames().has('thread-a'), false);
  assert.equal(katchCommand.getProtectedNicknames().get('thread-b'), 'كنية ب');
  assert.equal(katchCommand.getProtectedGroupNames().has('thread-a'), false);
  assert.equal(katchCommand.getProtectedGroupNames().get('thread-b'), 'مجموعة ب');

  t.mock.timers.tick(10_000);
  await flushAsyncWork();

  assert.deepEqual(calls.nicknames.map(call => call.threadID), ['thread-b']);
  assert.deepEqual(calls.groupNames.map(call => call.threadID), ['thread-b']);
  assert.equal(groupCommand.cancel('thread-b'), true);
  assert.equal(groupCommand.cancel('thread-a'), false);
});

test('a repeated قروب invocation replaces the pending delay instead of creating duplicate loops', async t => {
  withMockTimers(t);

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
  withMockTimers(t);

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

test('هويه compares ThreadInfo.nicknames and only writes nicknames that differ', async t => {
  withMockTimers(t);
  const state = {
    participants: ['already-matching', 'changed', 'unset'],
    nicknames: { 'already-matching': 'لقب', changed: 'قديم' }
  };
  const { api, calls } = makeApi({
    getThreadInfo: async () => ({
      participantIDs: [...state.participants],
      nicknames: { ...state.nicknames }
    }),
    nickname: async (nickname, _threadID, userID) => {
      state.nicknames[userID] = nickname;
    }
  });

  const operation = nicknameCommand.execute(api, {
    body: 'هويه لقب',
    threadID: 'thread-nickname'
  });
  await flushAsyncWork();
  await advanceNicknameDelays(t, state.participants.length);
  await operation;
  await flushAsyncWork();

  assert.deepEqual(calls.nicknames, [
    { nickname: 'لقب', threadID: 'thread-nickname', userID: 'changed' },
    { nickname: 'لقب', threadID: 'thread-nickname', userID: 'unset' }
  ]);
  assert.equal(state.nicknames['already-matching'], 'لقب');
  assert.equal(state.nicknames.changed, 'لقب');
  assert.equal(state.nicknames.unset, 'لقب');

  state.nicknames.changed = 'تغيّرت';
  t.mock.timers.tick(10_000);
  await flushAsyncWork();
  assert.equal(calls.nicknames.length, 3);
  assert.equal(calls.nicknames[2].userID, 'changed');

  t.mock.timers.tick(10_000);
  await flushAsyncWork();
  assert.equal(calls.nicknames.length, 3);
  assert.equal(nicknameCommand.cancel('thread-nickname'), true);
});

test('هويه protection expires after 24 hours and stops reading nicknames', async t => {
  withMockTimers(t);
  const { api, calls } = makeApi({
    getThreadInfo: async () => ({
      participantIDs: ['member-1'],
      nicknames: { 'member-1': 'لقب' }
    })
  });

  const operation = nicknameCommand.execute(api, {
    body: 'هويه لقب',
    threadID: 'thread-nickname-expiry'
  });
  await flushAsyncWork();
  await advanceNicknameDelays(t, 1);
  await operation;
  await flushAsyncWork();
  assert.equal(calls.nicknames.length, 0);

  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await flushAsyncWork();
  assert.equal(nicknameCommand.cancel('thread-nickname-expiry'), false);

  const readsAfterExpiry = calls.threadInfo.length;
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  assert.equal(calls.threadInfo.length, readsAfterExpiry);
  assert.equal(calls.nicknames.length, 0);
});

test('a repeated هويه invocation does not create a second nickname timer', async t => {
  withMockTimers(t);

  const { api, calls } = makeApi();
  const first = nicknameCommand.execute(api, { body: 'هويه لقب أول', threadID: 'thread-nick-dup' });
  await flushAsyncWork();
  const second = nicknameCommand.execute(api, { body: 'هوية لقب ثانٍ', threadID: 'thread-nick-dup' });
  await second;
  await flushAsyncWork();

  await advanceNicknameDelays(t, 1);
  await first;
  await flushAsyncWork();

  assert.deepEqual(calls.nicknames, [
    { nickname: 'لقب أول', threadID: 'thread-nick-dup', userID: 'member-1' }
  ]);
  assert.ok(calls.messages.some(({ message }) => message.includes('يوجد تغيير كنيات جارٍ')));
  assert.equal(nicknameCommand.cancel('thread-nick-dup'), true);
});

test('disconnect cleanup cancels all name loops and prevents an in-flight stale poll from mutating', async t => {
  withMockTimers(t);

  let resolveThreadInfo;
  const groupApi = makeApi({
    getThreadInfo: () => new Promise(resolve => { resolveThreadInfo = resolve; })
  });
  const nicknameApi = makeApi();
  const commands = allNameCommands();

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

test('restart path invokes name-operation cleanup', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const restartBody = indexSource.match(/function scheduleRestart\(delay\) \{([\s\S]*?)\n\}/);

  assert.ok(restartBody, 'scheduleRestart should be present');
  assert.match(restartBody[1], /cancelActiveNameLoops\(\)/);
});
