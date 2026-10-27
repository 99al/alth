'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

if (!process.env.COMMAND_LIST_PROFILE_TEST) {
  for (const profile of ['first', 'second', 'third', 'fourth', 'fifth']) {
    test(`command list access with ${profile} bot profile`, () => {
      const result = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, BOT_COMMAND_PROFILE: profile, COMMAND_LIST_PROFILE_TEST: '1' },
        encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
  }
} else {
  process.env.NODE_ENV = 'test';
  process.env.ALTH_COMMAND_STATE_PATH = path.join(os.tmpdir(), `alth-command-list-${process.pid}`, 'state.json');
  const main = require('./main');
  const { getBotCommandProfile } = require('./bot-command-profile.cjs');
  const profile = getBotCommandProfile();
  const adminPath = path.join(__dirname, 'admins-config.json');
  const adminID = '123456789';
  const forms = ['اومر', 'أوامر', 'اومر البوت', 'أوامر البوت', '  اومر  ', 'أوامر تفاصيل'];

  function mockAdmins(t, raw = JSON.stringify({ admins: [adminID] })) {
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (file, ...args) {
      if (file === adminPath) return raw;
      return read.call(this, file, ...args);
    });
  }

  async function dispatch(body, senderID, dependencies = {}, isGroup = true) {
    const sent = [];
    const reactions = [];
    await main.handleMessage({
      async sendMessage(message, threadID) { sent.push({ message, threadID }); },
      async setMessageReaction(...args) { reactions.push(args); }
    }, { body, senderID, threadID: 'thread-list', messageID: 'message-list', isGroup }, dependencies);
    await new Promise(resolve => setImmediate(resolve));
    return { sent, reactions };
  }

  main.loadCommands();

  test('loads the real command list and preserves profile-specific command names', () => {
    assert.equal(main.commands.get('اومر'), require('./Commands/اومر'));
    assert.ok(main.commands.has(profile.nm.commandName));
    assert.ok(main.commands.has(profile.jareed.commandName));
  });

  test('bot admin receives the real list for every supported spelling in group and private chats', async t => {
    mockAdmins(t);
    for (const isGroup of [true, false]) {
      for (const body of forms) {
        const { sent } = await dispatch(body, adminID, { isCommandEnabled: () => true }, isGroup);
        assert.equal(sent.length, 1, body);
        assert.equal(sent[0].threadID, 'thread-list');
        assert.match(sent[0].message, /أوامر بوت الث/);
        assert.ok(sent[0].message.includes(profile.nm.commandName));
        assert.ok(sent[0].message.includes(profile.jareed.commandName));
      }
    }
  });

  test('non-admin requests are entirely silent and never reach list, auto replies, or reactions', async t => {
    mockAdmins(t);
    let executed = 0;
    let autoReplies = 0;
    let enabledChecks = 0;
    const commands = new Map([
      ['اومر', { execute() { executed++; } }],
      ['رد', { checkAutoReply() { autoReplies++; } }]
    ]);
    for (let i = 0; i < 570; i++) {
      const { sent, reactions } = await dispatch(forms[i % forms.length], '987654321', {
        commands,
        isCommandEnabled() { enabledChecks++; return true; }
      }, i % 2 === 0);
      assert.deepEqual(sent, []);
      assert.deepEqual(reactions, []);
    }
    assert.equal(executed, 0);
    assert.equal(autoReplies, 0);
    assert.equal(enabledChecks, 0);
    for (const body of forms) {
      assert.deepEqual((await dispatch(body, '987654321')).sent, []);
    }
  });

  test('missing sender and invalid bot admin configuration fail closed without a reply', async t => {
    mockAdmins(t, '{invalid json');
    assert.deepEqual((await dispatch('اومر', adminID)).sent, []);
    assert.deepEqual((await dispatch('أوامر', undefined)).sent, []);
  });

  test('disabled list command stays silent even for bot admins', async t => {
    mockAdmins(t);
    let executed = 0;
    const result = await dispatch('اومر', adminID, {
      commands: new Map([['اومر', { execute() { executed++; } }]]),
      isCommandEnabled: () => false
    });
    assert.deepEqual(result.sent, []);
    assert.equal(executed, 0);
  });
}
