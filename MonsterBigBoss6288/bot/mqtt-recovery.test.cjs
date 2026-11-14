'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  classifyMqttTransportFailure,
  createMqttSendRecovery,
  stopMqttListener
} = require('./mqtt-recovery.cjs');

test('classifies only safe transport signals from library error fields', () => {
  assert.equal(classifyMqttTransportFailure({ error: 'Connection refused: undefined' }), 'connection_refused');
  assert.equal(classifyMqttTransportFailure({ message: 'Timeout waiting for ACK' }), 'connection_unavailable');
  assert.equal(classifyMqttTransportFailure(Object.assign(new Error('Socket hang up'), { code: 'ECONNRESET' })), 'connection_unavailable');
  assert.equal(classifyMqttTransportFailure({ error: 'Not authorized to send this message' }), null);
});

test('requires three transport failures within the window and applies a recovery cooldown', async () => {
  let currentTime = 10_000;
  const recoveries = [];
  const recovery = createMqttSendRecovery({
    threshold: 3,
    windowMs: 10_000,
    cooldownMs: 5_000,
    now: () => currentTime,
    onRecovery: details => recoveries.push(details)
  });

  assert.equal(recovery.recordFailure({ error: 'Connection refused' }).triggered, false);
  assert.equal(recovery.recordFailure({ error: 'Connection refused' }).triggered, false);
  const third = recovery.recordFailure({ error: 'Connection refused' });
  assert.equal(third.triggered, true);
  assert.deepEqual(recoveries, [{ category: 'connection_refused', failureCount: 3 }]);
  await third.completion;

  recovery.recordFailure({ error: 'Connection refused' });
  recovery.recordFailure({ error: 'Connection refused' });
  assert.equal(recovery.recordFailure({ error: 'Connection refused' }).triggered, false);
  assert.equal(recoveries.length, 1);

  currentTime += 5_001;
  recovery.recordFailure({ error: 'Connection refused' });
  recovery.recordFailure({ error: 'Connection refused' });
  const afterCooldown = recovery.recordFailure({ error: 'Connection refused' });
  assert.equal(afterCooldown.triggered, true);
  await afterCooldown.completion;
  assert.equal(recoveries.length, 2);
});

test('coalesces repeated transport failures while asynchronous listener cleanup is in flight', async () => {
  let releaseCleanup;
  let recoveryCount = 0;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const recovery = createMqttSendRecovery({
    threshold: 3,
    now: () => 1_000,
    onRecovery: () => {
      recoveryCount += 1;
      return cleanup;
    }
  });

  recovery.recordFailure({ error: 'Connection refused' });
  recovery.recordFailure({ error: 'Connection refused' });
  const first = recovery.recordFailure({ error: 'Connection refused' });
  assert.equal(first.triggered, true);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(recovery.recordFailure({ error: 'Connection refused' }).triggered, false);
  }
  assert.equal(recoveryCount, 1);

  releaseCleanup();
  await first.completion;
  assert.equal(recoveryCount, 1);
});

test('successful sends clear a partial failure streak; non-transport failures do not trigger reconnect', () => {
  const recoveries = [];
  const recovery = createMqttSendRecovery({
    threshold: 3,
    now: () => 1_000,
    onRecovery: details => recoveries.push(details)
  });

  recovery.recordFailure({ error: 'Connection refused' });
  recovery.recordFailure({ error: 'Connection refused' });
  recovery.recordSuccess();
  assert.equal(recovery.recordFailure({ error: 'Connection refused' }).count, 1);
  assert.equal(recovery.recordFailure({ error: 'Invalid thread ID' }).category, null);
  assert.equal(recovery.recordFailure({ error: 'Connection refused' }).count, 1);
  assert.equal(recoveries.length, 0);
});

class FakeFcaListener extends EventEmitter {
  constructor(id, activeListeners) {
    super();
    this.id = id;
    this.activeListeners = activeListeners;
    this.activeListeners.add(this);
    this.pendingNativeReconnect = false;
    this.nativeReconnectSchedules = 0;
    this.stopCalls = 0;
    this.stopping = false;
    this.cleaned = false;

    const scheduleInternalReconnect = () => {
      if (this.stopping || this.pendingNativeReconnect) return;
      this.pendingNativeReconnect = true;
      this.nativeReconnectSchedules += 1;
    };
    this.on('close', scheduleInternalReconnect);
    this.on('disconnect', scheduleInternalReconnect);
  }

  simulateDisconnect() {
    this.emit('close');
    this.emit('disconnect');
  }

  stopListeningAsync() {
    this.stopCalls += 1;
    this.stopping = true;
    return new Promise(resolve => {
      setTimeout(() => {
        this.pendingNativeReconnect = false;
        this.cleaned = true;
        this.removeAllListeners();
        this.activeListeners.delete(this);
        resolve();
      }, 5);
    });
  }
}

test('repeated internal disconnects recover only after send failures and clean each listener before replacing it', async () => {
  let currentTime = 20_000;
  const activeListeners = new Set();
  const allListeners = [];
  const makeListener = () => {
    const listener = new FakeFcaListener(`listener-${allListeners.length + 1}`, activeListeners);
    allListeners.push(listener);
    return listener;
  };
  let currentListener = makeListener();
  let recoveryCount = 0;
  const recovery = createMqttSendRecovery({
    threshold: 3,
    windowMs: 20_000,
    cooldownMs: 30_000,
    now: () => currentTime,
    onRecovery: async () => {
      const oldListener = currentListener;
      recoveryCount += 1;
      const completion = stopMqttListener(oldListener);
      assert.equal(activeListeners.size, 1, 'old listener remains during asynchronous cleanup');
      await completion;
      assert.equal(activeListeners.size, 0, 'old MQTT listener is removed before restart');
      currentListener = makeListener();
    }
  });

  async function disconnectThenFailSend() {
    currentListener.simulateDisconnect();
    const result = recovery.recordFailure({ error: 'Connection refused: undefined' });
    if (result.completion) await result.completion;
    return result;
  }

  await disconnectThenFailSend();
  await disconnectThenFailSend();
  const firstRecovery = await disconnectThenFailSend();
  assert.equal(firstRecovery.triggered, true);
  assert.equal(recoveryCount, 1);
  assert.equal(allListeners[0].nativeReconnectSchedules, 1, 'close and disconnect are coalesced like the library timer');
  assert.equal(allListeners[0].stopCalls, 1);
  assert.equal(allListeners[0].cleaned, true);
  assert.equal(activeListeners.size, 1);

  currentTime += 30_001;
  await disconnectThenFailSend();
  await disconnectThenFailSend();
  const secondRecovery = await disconnectThenFailSend();
  assert.equal(secondRecovery.triggered, true);
  assert.equal(recoveryCount, 2);
  assert.equal(allListeners[1].stopCalls, 1);
  assert.equal(allListeners[1].cleaned, true);
  assert.equal(allListeners.length, 3);
  assert.deepEqual([...activeListeners], [allListeners[2]]);
  assert.equal(allListeners[2].stopCalls, 0);
});

test('stopMqttListener waits for the callback-form public API when async stop is unavailable', async () => {
  let stopped = false;
  const listener = {
    stopListening(done) {
      setTimeout(() => {
        stopped = true;
        done();
      }, 5);
    }
  };

  await stopMqttListener(listener);
  assert.equal(stopped, true);
});
