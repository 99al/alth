'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getBotCommandProfile } = require('./bot-command-profile.cjs');

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
    async setTitle(name, threadID) {
      calls.groupNames.push({ name, threadID: String(threadID) });
      if (overrides.setTitle) return overrides.setTitle(name, threadID, calls);
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

test('ويس starts its loop before the start notice finishes sending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const threadID = 'thread-wis-start-before-notice';
  const command = fresh('./Commands/قصف.js');
  command.cancelAll();
  let finishStartNotice;
  const { api, calls } = makeApi({
    sendMessage(message) {
      if (String(message).includes('جَـــارِي بَـــدْءُ')) {
        return new Promise(resolve => { finishStartNotice = resolve; });
      }
    }
  });
  t.after(() => {
    command.cancel(threadID);
    command.pauseAll();
    if (finishStartNotice) finishStartNotice();
  });

  const pendingStart = command.execute(api, { body: 'ويس', threadID });
  await flushAsyncWork();
  assert.equal(command.isActive(threadID), true);
  assert.ok(calls.typing.some(({ active }) => active === true), 'the loop began while the notice was still pending');

  finishStartNotice();
  await pendingStart;
});

test('ويس restarts a saved but inactive run without falsely saying it is already running', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const threadID = 'thread-wis-stale-saved-state';
  const initial = fresh('./Commands/قصف.js');
  initial.cancelAll();
  commandState.set('ويس', threadID, true);

  const { api, calls } = makeApi();
  const resumed = fresh('./Commands/قصف.js');
  t.after(() => {
    resumed.cancel(threadID);
    resumed.pauseAll();
  });

  await resumed.execute(api, { body: 'ويس', threadID });
  assert.equal(resumed.isActive(threadID), true);
  assert.ok(calls.messages.some(({ message }) => message.includes('استئناف إرسال الجرائد')));
  assert.equal(calls.messages.some(({ message }) => message.includes('الجرائد تعمل بالفعل')), false);
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
  await resumed.execute(api, { body: `${getBotCommandProfile().jareed.commandName} ايقاف`, threadID });
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

test('dispatcher keeps the first-bot commands and routes renamed commands only in the second profile', async () => {
  const { handleMessage, loadCommands, commands } = require('./main');
  const firstProfile = getBotCommandProfile({ BOT_COMMAND_PROFILE: 'first' });
  const secondProfile = getBotCommandProfile({ BOT_COMMAND_PROFILE: 'second' });
  const { api } = makeApi();
  const makeDependencies = (profile, dispatched) => ({
    commandProfile: profile,
    commands: new Map([
      [profile.nm.commandName, { execute: (_api, event) => dispatched.push(`nm:${event.body}`) }],
      [profile.jareed.commandName, { execute: (_api, event) => dispatched.push(`jareed:${event.body}`) }],
      ['اومر', { execute: (_api, event) => dispatched.push(`help:${event.body}`) }]
    ]),
    isAdmin: () => true,
    isCommandEnabled: () => true
  });

  const firstDispatched = [];
  const firstDependencies = makeDependencies(firstProfile, firstDispatched);
  for (const body of ['/nm status', '/nmm status', 'جريد 2 4 رسالة', 'جرائد 2 4 رسالة', 'جريدة 2 4 رسالة', 'اومر']) {
    await handleMessage(api, { body, threadID: 'route-first', senderID: 'admin' }, firstDependencies);
  }
  assert.deepEqual(firstDispatched, [
    'nm:/nm status',
    'jareed:جريد 2 4 رسالة',
    'jareed:جريد 2 4 رسالة',
    'help:اومر'
  ]);

  const secondDispatched = [];
  const secondDependencies = makeDependencies(secondProfile, secondDispatched);
  for (const body of ['/nmm status', '/nm status', 'جريدة 2 4 رسالة', 'جريد 2 4 رسالة', 'اومر']) {
    await handleMessage(api, { body, threadID: 'route-second', senderID: 'admin' }, secondDependencies);
  }
  assert.deepEqual(secondDispatched, [
    'nm:/nmm status',
    'jareed:جريدة 2 4 رسالة',
    'help:اومر'
  ]);

  loadCommands();
  const runtimeProfile = getBotCommandProfile();
  assert.ok(commands.has(runtimeProfile.nm.commandName), 'the runtime registry keeps its profile-specific name lock');
  const helpApi = makeApi();
  await handleMessage(helpApi.api, { body: 'اومر', threadID: 'help', senderID: 'admin' }, {
    commands,
    commandProfile: runtimeProfile,
    isAdmin: () => true,
    isCommandEnabled: () => true
  });
  await flushAsyncWork();
  assert.ok(helpApi.calls.messages.some(({ message }) => message.includes(runtimeProfile.jareed.commandName)));
});

test('second BOT_COMMAND_PROFILE loads nmm and جريدة as registered names without the first-bot spellings', () => {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    BOT_COMMAND_PROFILE: 'second',
    ALTH_COMMAND_STATE_PATH: path.join(os.tmpdir(), `alth-second-profile-${process.pid}`, 'state.json')
  };
  const script = [
    "const { loadCommands, commands, handleMessage } = require('./main');",
    'loadCommands();',
    'const messages = [];',
    'const titles = [];',
    "const api = { sendMessage: async message => messages.push(message), setTitle: async (name, threadID) => titles.push({ name, threadID }) };",
    'const dependencies = { isAdmin: () => true, isCommandEnabled: () => true };',
    "Promise.resolve().then(() => handleMessage(api, { body: '/nmm اسم البوت الثاني 1 1', threadID: 'new-nm', senderID: 'admin' }, dependencies))",
    "  .then(() => handleMessage(api, { body: '/nm اسم قديم 1 1', threadID: 'old-nm', senderID: 'admin' }, dependencies))",
    "  .then(() => handleMessage(api, { body: 'جريد', threadID: 'old-jareed', senderID: 'admin' }, dependencies))",
    "  .then(() => handleMessage(api, { body: 'جريدة', threadID: 'new-jareed', senderID: 'admin' }, dependencies))",
    '  .then(() => {',
    "    process.stdout.write('PROFILE_RESULT:' + JSON.stringify({ names: [...commands.keys()], commandName: commands.get('جريدة').name, titles, messages }));",
    '}).catch(error => { console.error(error); process.exitCode = 1; });'
  ].join('\n');
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env,
    encoding: 'utf8'
  });
  const result = output.match(/PROFILE_RESULT:(\{[^\n]+\})/);
  assert.ok(result, 'child process reports the loaded profile command names');
  const report = JSON.parse(result[1]);
  assert.ok(report.names.includes('nmm'));
  assert.ok(report.names.includes('جريدة'));
  assert.equal(report.names.includes('nm'), false);
  assert.equal(report.names.includes('جريد'), false);
  assert.equal(report.commandName, 'جريدة');
  assert.deepEqual(report.titles, [{ name: 'اسم البوت الثاني', threadID: 'new-nm' }]);
  assert.equal(report.messages.length, 2, 'the old /nm and جريد spellings are ignored in the second profile');
  assert.ok(report.messages.some(message => message.includes('قفل الاسم')));
  assert.ok(report.messages.some(message => message.includes('الصيغة: جريدة 10 15 نص الرسالة')));
});


test('third BOT_COMMAND_PROFILE loads nms and جينو without the other profile spellings', () => {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    BOT_COMMAND_PROFILE: 'third',
    ALTH_COMMAND_STATE_PATH: path.join(os.tmpdir(), `alth-third-profile-${process.pid}`, 'state.json')
  };
  const script = [
    "const { loadCommands, commands } = require('./main');",
    'loadCommands();',
    "process.stdout.write('PROFILE_RESULT:' + JSON.stringify({ names: [...commands.keys()], jareed: commands.get('جينو')?.name }));"
  ].join('\n');
  const output = execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' });
  const result = output.match(/PROFILE_RESULT:(\{[^\n]+\})/);
  assert.ok(result, 'child process reports the loaded third profile command names');
  const report = JSON.parse(result[1]);
  assert.ok(report.names.includes('nms'));
  assert.ok(report.names.includes('جينو'));
  assert.equal(report.names.includes('nm'), false);
  assert.equal(report.names.includes('nmm'), false);
  assert.equal(report.names.includes('جريد'), false);
  assert.equal(report.names.includes('جريدة'), false);
  assert.equal(report.jareed, 'جينو');
});
