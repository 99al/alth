'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { getBotCommandProfile } = require('./bot-command-profile.cjs');
const expected = {
  first: ['nm', 'جريد', ['namemute', 'غلق', 'lockname'], ['جرائد', 'جريد البوت']],
  second: ['nmm', 'جريدة', [], ['جريدة البوت']],
  third: ['nms', 'جينو', [], ['جينو البوت']],
  fourth: ['na', 'جين', [], []],
  fifth: ['nm5', 'جودي', [], []],
  sixth: ['nm6', 'جواد', [], []]
};
for (const [id, [nm, jareed, nmAliases, jareedAliases]] of Object.entries(expected)) {
  test(`${id} profile remains unchanged`, () => {
    const profile = getBotCommandProfile({ BOT_COMMAND_PROFILE: id });
    assert.equal(profile.id, id);
    assert.equal(profile.nm.commandName, nm);
    assert.deepEqual([...profile.nm.aliases], nmAliases);
    assert.equal(profile.jareed.commandName, jareed);
    assert.deepEqual([...profile.jareed.aliases], jareedAliases);
  });
}
test('seventh profile has isolated names and no legacy aliases', () => {
  const profile = getBotCommandProfile({ BOT_COMMAND_PROFILE: 'seventh' });
  assert.deepEqual(profile.nm, { commandName: 'nm7', aliases: [] });
  assert.deepEqual(profile.jareed, { commandName: 'جود', aliases: [] });
  assert.equal(getBotCommandProfile({ BOT_COMMAND_PROFILE: 'seventh' }).id, 'seventh');
});
test('seventh scheduler exports only its selected command and uses its own state key', async () => {
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
