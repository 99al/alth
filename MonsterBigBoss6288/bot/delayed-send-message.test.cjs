'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { installDelayedSendMessage } = require('./delayed-send-message.cjs');

test('a stalled Messenger send times out and releases the per-thread queue', async () => {
  const rawMessages = [];
  const api = {
    sendMessage(message) {
      rawMessages.push(message);
      if (message === 'first') return new Promise(() => {});
      return Promise.resolve({ messageID: 'second-ok' });
    },
    sendTypingIndicator() {}
  };

  assert.equal(installDelayedSendMessage(api, {
    sendTimeoutMs: 25,
    typingDurationForText: () => 0,
    postTypingDelayMs: 0
  }), true);

  await assert.rejects(api.sendMessage('first', 'thread-timeout'), /timed out after 25ms/);
  assert.deepEqual(rawMessages, ['first']);

  const result = await api.sendMessage('second', 'thread-timeout');
  assert.deepEqual(result, { messageID: 'second-ok' });
  assert.deepEqual(rawMessages, ['first', 'second']);
});
