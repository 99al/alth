'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { getBotCommandProfile } = require('./bot-command-profile.cjs');
const { resolveStatePath } = require('./command-state.cjs');
const expected = {
  first: ['nm', 'جريد', ['namemute', 'غلق', 'lockname'], ['جرائد', 'جريد البوت']],
  second: ['nmm', 'جريدة', [], ['جريدة البوت']],
  third: ['nms', 'جينو', [], ['جينو البوت']],
  fourth: ['na', 'جين', [], []],
  fifth: ['nm5', 'جودي', [], []],
  sixth: ['nm6', 'جواد', [], []],
  seventh: ['nm', 'جود', ['namemute', 'غلق', 'lockname'], []],
  tenth: ['nm', 'دارو', ['namemute', 'غلق', 'lockname'], []]
};
for (const [id, [nm, jareed, nmAliases, jareedAliases]] of Object.entries(expected)) {
  test(`${id} profile remains unchanged`, () => {
    const profile = getBotCommandProfile({ BOT_COMMAND_PROFILE: id });
    assert.equal(profile.id, id);
    assert.equal(profile.nm.commandName, nm);
    assert.deepEqual([...profile.nm.aliases], nmAliases);
    assert.equal(profile.jareed.commandName, jareed);
    assert.deepEqual([...profile.jareed.aliases], jareedAliases);
    assert.equal(profile.groupTitle.commandName, id === 'seventh' || id === 'tenth' ? 'عنوان' : 'قروب');
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
test('tenth scheduler exports دارو, uses its own state key, and leaves جود inactive', async () => {
  process.env.BOT_COMMAND_PROFILE = 'tenth';
  const path = require.resolve('./Commands/جريد.js');
  delete require.cache[path];
  const command = require(path);
  assert.equal(command.name, 'دارو');
  assert.deepEqual(command.aliases, []);
  assert.equal(command.stateCommandName, 'دارو');
  const sent = [];
  const api = { sendMessage: async (message, threadID) => sent.push({ message, threadID }) };
  await command.execute(api, { threadID: 'tenth-test-thread', senderID: 'sender', isGroup: true, body: 'جود invalid' });
  assert.deepEqual(sent, []);
  await command.execute(api, { threadID: 'tenth-test-thread', senderID: 'sender', isGroup: true, body: 'دارو invalid' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /الصيغة: دارو/u);
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

test('tenth profile keeps shared commands but uses its own scheduler name', () => {
  const seventh = getBotCommandProfile({ BOT_COMMAND_PROFILE: 'seventh' });
  const tenth = getBotCommandProfile({ BOT_COMMAND_PROFILE: 'tenth' });
  assert.deepEqual(tenth.nm, seventh.nm);
  assert.deepEqual(tenth.groupTitle, { commandName: 'عنوان' });
  assert.deepEqual(seventh.jareed, { commandName: 'جود', aliases: [] });
  assert.deepEqual(tenth.jareed, { commandName: 'دارو', aliases: [] });
});

test('tenth production command storage is isolated from seventh', () => {
  const production = { NODE_ENV: 'production' };
  assert.equal(resolveStatePath({ ...production, BOT_COMMAND_PROFILE: 'seventh' }),
    '/data/alth-command-state/active-commands.json');
  assert.equal(resolveStatePath({ ...production, BOT_COMMAND_PROFILE: 'tenth' }),
    '/data/alth-tenth-command-state/active-commands.json');
});
