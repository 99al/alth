'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const mcCommand = require('./Commands/mc');
const { handleMessage } = require('./main');

function makeApi() {
  const calls = { deletions: [], messages: [] };
  const api = {
    getCurrentUserID: () => 'bot-1',
    async unsendMessage(messageID, threadID) {
      calls.deletions.push({ messageID, threadID });
    },
    async sendMessage(message, threadID) {
      calls.messages.push({ message, threadID });
    }
  };
  return { api, calls };
}

test('mc retracts only the bot message being replied to', async () => {
  const { api, calls } = makeApi();
  const result = await mcCommand.execute(api, {
    body: 'mc',
    threadID: 'thread-1',
    messageReply: { messageID: 'bot-message-7', senderID: 'bot-1' }
  });

  assert.equal(result, true);
  assert.deepEqual(calls.deletions, [{ messageID: 'bot-message-7', threadID: 'thread-1' }]);
  assert.deepEqual(calls.messages, []);
});

test('mc requires a reply and refuses to retract a message from another sender', async () => {
  const { api, calls } = makeApi();

  assert.equal(await mcCommand.execute(api, { threadID: 'thread-1' }), false);
  assert.equal(await mcCommand.execute(api, {
    threadID: 'thread-1',
    messageReply: { messageID: 'member-message-4', senderID: 'member-1' }
  }), false);

  assert.deepEqual(calls.deletions, []);
  assert.equal(calls.messages.length, 2);
  assert.match(calls.messages[0].message, /رسالة البوت/u);
  assert.match(calls.messages[1].message, /رسالة أرسلها البوت/u);
});

test('main routes mc and /mc, and blocks non-admin or disabled invocations', async () => {
  const dispatched = [];
  const commands = new Map([
    ['mc', { execute: (_api, event) => dispatched.push(event.body) }]
  ]);
  const { api } = makeApi();
  const isEnabled = { value: true };
  const dependencies = {
    commands,
    isAdmin: senderID => senderID === 'admin-1',
    isCommandEnabled: name => name !== 'mc' || isEnabled.value
  };

  await handleMessage(api, { body: 'mc', threadID: 't-1', senderID: 'admin-1' }, dependencies);
  await handleMessage(api, { body: '/mc', threadID: 't-1', senderID: 'admin-1' }, dependencies);
  await handleMessage(api, { body: 'mc', threadID: 't-1', senderID: 'member-1' }, dependencies);
  isEnabled.value = false;
  await handleMessage(api, { body: 'mc', threadID: 't-1', senderID: 'admin-1' }, dependencies);

  assert.deepEqual(dispatched, ['mc', '/mc']);
});
