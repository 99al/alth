'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const main = require('./main.js');

const botID = '100000000009';

function mockControl() {
  const calls = { handled: [], autoReplies: 0, commands: 0 };
  return {
    calls,
    handler: {
      async handle(api, event) {
        if (event.isGroup === false && event.body === 'حالة البوت') {
          calls.handled.push(event.body);
          return true;
        }
        return false;
      }
    }
  };
}

function event(body, senderID, isGroup = false) {
  return { body, senderID, isGroup, threadID: isGroup ? 'group-thread' : 'dm-thread', messageID: 'message-id' };
}

test('self-authored private control is handled once, while self replies and group echoes are ignored', async () => {
  main.setBotAccountID(botID);
  const control = mockControl();
  const api = {
    async sendMessage() {},
    async setMessageReaction() {}
  };
  const commands = new Map([
    ['اومر', { execute() { control.calls.commands++; } }],
    ['رد', { checkAutoReply() { control.calls.autoReplies++; } }]
  ]);
  const deps = {
    privateAdminControl: control.handler,
    botAccountID: botID,
    isBotPaused: () => false,
    commands,
    isCommandEnabled: () => true
  };

  await main.handleMessage(api, event('حالة البوت', botID, false), deps);
  assert.deepEqual(control.calls.handled, ['حالة البوت']);

  await main.handleMessage(api, event('البوت يعمل الآن', botID, false), deps);
  await main.handleMessage(api, event('اومر', botID, true), deps);
  assert.equal(control.calls.commands, 0);
  assert.equal(control.calls.autoReplies, 0);
});

test('paused mode allows private control but skips existing group automation paths', async () => {
  main.setBotAccountID('100000000010');
  const control = mockControl();
  const calls = { autoReplies: 0, list: 0 };
  const api = { async sendMessage() {}, async setMessageReaction() {} };
  const commands = new Map([
    ['اومر', { execute() { calls.list++; } }],
    ['رد', { checkAutoReply() { calls.autoReplies++; } }]
  ]);
  const deps = {
    privateAdminControl: control.handler,
    botAccountID: '100000000010',
    isBotPaused: () => true,
    commands,
    isCommandEnabled: () => true,
    isAdmin: () => true
  };

  await main.handleMessage(api, event('حالة البوت', '100000000001', false), deps);
  assert.deepEqual(control.calls.handled, ['حالة البوت']);
  await main.handleMessage(api, event('اومر', '100000000001', true), deps);
  await main.handleMessage(api, event('رد كلمة» رد', '100000000001', true), deps);
  assert.equal(calls.list, 0);
  assert.equal(calls.autoReplies, 0);
});

test('paused mode skips group event automation and preserves the running event path', () => {
  const prior = main.commands.get('كاتش');
  const calls = { nickname: 0, groupName: 0 };
  main.commands.set('كاتش', {
    handleNicknameEvent() { calls.nickname++; },
    handleGroupNameEvent() { calls.groupName++; }
  });
  try {
    const api = {};
    const groupEvent = { type: 'thread-name', threadID: 'group-thread' };
    main.handleEvent(api, groupEvent, { isBotPaused: () => true });
    assert.deepEqual(calls, { nickname: 0, groupName: 0 });

    main.handleEvent(api, groupEvent, { isBotPaused: () => false });
    assert.deepEqual(calls, { nickname: 1, groupName: 1 });
  } finally {
    if (prior) main.commands.set('كاتش', prior);
    else main.commands.delete('كاتش');
  }
});

test('strict lifecycle wrappers surface task failures without forwarding raw errors', () => {
  const pauseFailure = new Map([['ويس', { pauseAll() { throw new Error('synthetic-sensitive-detail'); } }]]);
  assert.throws(
    () => main.pausePersistentCommands(pauseFailure, { throwOnError: true }),
    error => error.message === 'PAUSE_TASKS_FAILED'
  );

  const resumeFailure = new Map([['ويس', {
    resumeAll(api, options) {
      assert.equal(options.strict, true);
      throw new Error('synthetic-sensitive-detail');
    }
  }]]);
  assert.throws(
    () => main.resumePersistentCommands({}, resumeFailure, { throwOnError: true }),
    error => error.message === 'RESUME_TASKS_FAILED'
  );
});
