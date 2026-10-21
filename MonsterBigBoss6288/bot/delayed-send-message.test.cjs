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

test('waits for callback-only sends and resolves with callback data', async () => {
  let callback;
  const api = {
    sendMessage(message, threadID, done) {
      callback = done;
    },
    sendTypingIndicator() {}
  };

  installDelayedSendMessage(api, {
    sendTimeoutMs: 100,
    typingDurationForText: () => 0,
    postTypingDelayMs: 0
  });

  const pending = api.sendMessage('callback-only', 'thread-callback');
  await new Promise(resolve => setTimeout(resolve, 10));
  let completed = false;
  pending.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(completed, false);

  const result = { messageID: 'callback-ok' };
  callback(null, result);
  assert.deepEqual(await pending, result);
});

test('treats an async undefined return as successful Promise API completion', async () => {
  const api = {
    async sendMessage() {
      return undefined;
    },
    sendTypingIndicator() {}
  };

  installDelayedSendMessage(api, {
    sendTimeoutMs: 100,
    typingDurationForText: () => 0,
    postTypingDelayMs: 0
  });

  assert.equal(await api.sendMessage('async-undefined', 'thread-async'), undefined);
});

test('invokes the supplied callback at most once', async () => {
  let callbackCount = 0;
  const api = {
    sendMessage(message, threadID, done) {
      done(null, { messageID: 'callback-ok' });
      done(null, { messageID: 'duplicate' });
    },
    sendTypingIndicator() {}
  };

  installDelayedSendMessage(api, {
    sendTimeoutMs: 100,
    typingDurationForText: () => 0,
    postTypingDelayMs: 0
  });

  const result = await api.sendMessage('callback-once', 'thread-once', () => {
    callbackCount += 1;
  });
  assert.deepEqual(result, { messageID: 'callback-ok' });
  assert.equal(callbackCount, 1);
});

test('rejects synchronous send exceptions', async () => {
  const syncError = new Error('sync failure');
  const api = {
    sendMessage() {
      throw syncError;
    },
    sendTypingIndicator() {}
  };

  installDelayedSendMessage(api, {
    sendTimeoutMs: 100,
    typingDurationForText: () => 0,
    postTypingDelayMs: 0
  });

  await assert.rejects(api.sendMessage('sync-error', 'thread-error'), error => error === syncError);
});
