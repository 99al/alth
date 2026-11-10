'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
process.env.NODE_ENV = 'test';
process.env.ALTH_COMMAND_STATE_PATH = path.join(os.tmpdir(), `bot-profile-${process.pid}`, 'state.json');
const { getBotCommandProfile } = require('./bot-command-profile.cjs');
const expected = {
  first: ['nm', 'جريد', ['namemute', 'غلق', 'lockname'], ['جرائد', 'جريد البوت']],
  second: ['nmm', 'جريدة', [], ['جريدة البوت']],
  third: ['nms', 'جينو', [], ['جينو البوت']],
  fourth: ['na', 'جين', [], []],
  fifth: ['nm5', 'جودي', [], []],
  sixth: ['nm6', 'جواد', [], []],
  eighth: ['nm', 'موعد', ['namemute', 'غلق', 'lockname'], []],
  ninth: ['nm9', 'سكون', [], []]
};
for (const [id, [nm, jareed, nmAliases, jareedAliases]] of Object.entries(expected)) {
  test(`${id} profile remains unchanged`, () => {
    const profile = getBotCommandProfile({ BOT_COMMAND_PROFILE: id });
    assert.equal(profile.id, id);
    assert.equal(profile.nm.commandName, nm);
    assert.deepEqual([...profile.nm.aliases], nmAliases);
    assert.equal(profile.jareed.commandName, jareed);
    assert.deepEqual([...profile.jareed.aliases], jareedAliases);
    assert.equal(profile.groupTitle.commandName, id === 'eighth' ? 'لقب' : id === 'ninth' ? 'nm9' : 'قروب');
  });
}
test('seventh profile keeps Bot 1 nm, renames scheduler and group-title commands', () => {
  const profile = getBotCommandProfile({ BOT_COMMAND_PROFILE: 'seventh' });
  assert.deepEqual(profile.nm, { commandName: 'nm', aliases: ['namemute', 'غلق', 'lockname'] });
  assert.deepEqual(profile.jareed, { commandName: 'جود', aliases: [] });
  assert.deepEqual(profile.groupTitle, { commandName: 'عنوان' });
  assert.equal(Object.values(profile).some(value => value && value.commandName === 'nm7'), false);
});
test('seventh scheduler exports selected command and uses its own state key', async () => {
  process.env.BOT_COMMAND_PROFILE = 'seventh';
  const path = require.resolve('./Commands/جريد.js');
  delete require.cache[path];
  const command = require(path);
  assert.equal(command.name, 'جود');
  assert.deepEqual(command.aliases, []);
  assert.equal(command.stateCommandName, 'جود');
  const sent = [];
  const api = { sendMessage: async (message, threadID) => sent.push({ message, threadID }) };
  await command.execute(api, { threadID: 'test-thread', senderID: 'sender', isGroup: true, body: 'جواد invalid' });
  assert.deepEqual(sent, []);
  await command.execute(api, { threadID: 'test-thread', senderID: 'sender', isGroup: true, body: 'جود invalid' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /الصيغة/u);
});
test('seventh group-title command exports عنوان, parses its name, and persists under قروب', async () => {
  process.env.BOT_COMMAND_PROFILE = 'seventh';
  const path = require.resolve('./Commands/قروب.js');
  delete require.cache[path];
  const command = require(path);
  assert.equal(command.name, 'عنوان');
  const sent = [];
  await command.execute({ sendMessage: async message => sent.push(message) }, {
    body: 'عنوان', threadID: 'profile-title-test'
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /عنوان اسم المجموعة/u);
});

test('eighth profile exports موعد with its own state key and rejects جود', async () => {
  process.env.BOT_COMMAND_PROFILE = 'eighth';
  const path = require.resolve('./Commands/جريد.js');
  delete require.cache[path];
  const command = require(path);
  assert.equal(command.name, 'موعد');
  assert.deepEqual(command.aliases, []);
  assert.equal(command.stateCommandName, 'موعد');
  const sent = [];
  const api = { sendMessage: async (message, threadID) => sent.push({ message, threadID }) };
  await command.execute(api, { threadID: 'eighth-thread', senderID: 'sender', isGroup: true, body: 'جود invalid' });
  assert.deepEqual(sent, []);
  await command.execute(api, { threadID: 'eighth-thread', senderID: 'sender', isGroup: true, body: 'موعد invalid' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /الصيغة/u);
});
test('eighth group-title command exports لقب and help mentions its title syntax', async () => {
  process.env.BOT_COMMAND_PROFILE = 'eighth';
  const path = require.resolve('./Commands/قروب.js');
  delete require.cache[path];
  const command = require(path);
  assert.equal(command.name, 'لقب');
  const sent = [];
  await command.execute({ sendMessage: async message => sent.push(message) }, { body: 'لقب', threadID: 'eighth-title-test' });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /لقب اسم المجموعة/u);
});

test('ninth profile keeps سكون and routes group titles through /nm9 with its existing persistence key', () => {
  const profile = getBotCommandProfile({ BOT_COMMAND_PROFILE: 'ninth' });
  assert.equal(profile.id, 'ninth');
  assert.deepEqual(profile.nm, { commandName: 'nm9', aliases: [] });
  assert.deepEqual(profile.jareed, { commandName: 'سكون', aliases: [] });
  assert.deepEqual(profile.groupTitle, { commandName: 'nm9', stateKey: 'nm9' });
});

test('ninth scheduler exposes سكون with an isolated durable command key', async () => {
  process.env.BOT_COMMAND_PROFILE = 'ninth';
  const path = require.resolve('./Commands/جريد.js'); delete require.cache[path];
  const command = require(path);
  assert.equal(command.name, 'سكون');
  assert.equal(command.stateCommandName, 'سكون');
  assert.deepEqual(command.aliases, []);
  const sent = [];
  await command.execute({ sendMessage: async message => sent.push(message) }, {
    threadID: 'ninth-schedule-test', senderID: 'admin', isGroup: true, body: 'سكون invalid'
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /سكون 10 15/u);
});

test('ninth /nm9 invokes the shared group-title handler, not a separate NM handler', async () => {
  process.env.BOT_COMMAND_PROFILE = 'ninth';
  const { handleMessage } = require('./main');
  const titleCalls = [];
  const commands = new Map([
    ['nm9', { execute: async (_api, event) => titleCalls.push(event.body) }],
    ['unused-nm-lock', { execute: () => assert.fail('standalone name-lock handler must not run') }]
  ]);
  const dependencies = { commands, isAdmin: id => id === '61593476548155', isCommandEnabled: () => true };
  await handleMessage({ sendMessage: async () => {} }, {
    body: '/nm9 اسم المجموعة الجديد', threadID: 'ninth-title-test', senderID: '61593476548155'
  }, dependencies);
  assert.deepEqual(titleCalls, ['nm9 اسم المجموعة الجديد']);
});

test('ninth command loading registers the shared group-title module under nm9', () => {
  process.env.BOT_COMMAND_PROFILE = 'ninth';
  const mainPath = require.resolve('./main'); delete require.cache[mainPath];
  const main = require(mainPath);
  main.loadCommands();
  assert.equal(main.commands.get('nm9').description, 'تغيير اسم المجموعة وحمايته حتى إيقافه يدويًا');
  assert.equal(main.commands.has('قروب'), false);
});

test('ninth /nm9 group-title module preserves its nm9 state key and setTitle behavior', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  process.env.BOT_COMMAND_PROFILE = 'ninth';
  const path = require.resolve('./Commands/قروب.js'); delete require.cache[path];
  const command = require(path);
  assert.equal(command.name, 'nm9');
  const state = require('./command-state.cjs').defaultStore;
  const threadID = `ninth-title-${process.pid}`;
  const titles = [];
  let currentTitle = '';
  try {
    const execution = command.execute({
      setTitle: async (name, id) => { titles.push({ name, id }); currentTitle = name; },
      getThreadInfo: async () => ({ threadName: currentTitle }),
      sendMessage: async () => {}
    }, {
      body: 'nm9 اسم المجموعة الجديد', threadID
    });
    t.mock.timers.tick(10000);
    await execution;
    assert.equal(state.get('nm9', threadID).name, 'اسم المجموعة الجديد');
    assert.equal(state.get('قروب', threadID), undefined);
    assert.deepEqual(titles, [{ name: 'اسم المجموعة الجديد', id: threadID }]);
  } finally {
    state.remove('nm9', threadID);
    command.pauseAll();
  }
});
