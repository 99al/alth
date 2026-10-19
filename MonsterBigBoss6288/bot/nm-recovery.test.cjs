'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNmCommand } = require('./nm-command.standalone');
function makeTempDataFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-nm-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'nmData.json');
}
function makeApi() {
  const calls = { messages: [], titles: [] };
  return { calls, api: {
    async sendMessage(message, threadID) { calls.messages.push({ message, threadID }); },
    async setTitle(name, threadID) { calls.titles.push({ name, threadID }); }
  } };
}
async function flushAsyncWork() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}
for (const commandName of ['nm', 'nmm']) {
  test(`${commandName} recovers from a title request that never settles`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = createNmCommand({ dataFile: makeTempDataFile(t), isAuthorized: () => true, commandName });
    t.after(() => command.stop());
    const { api, calls } = makeApi();
    const goodSetTitle = api.setTitle;
    let attempts = 0;
    api.setTitle = (name, threadID) => {
      attempts++;
      if (attempts === 2) return new Promise(() => {});
      return goodSetTitle(name, threadID);
    };
    command.start(api);
    await command.execute(api, { body: `/${commandName} اسم محمي 1s 1s`, threadID: 'hang-loop' });
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.equal(attempts, 2);
    t.mock.timers.tick(30_000); await flushAsyncWork();
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.equal(attempts, 3, 'a stalled request must not permanently stop the saved lock');
    assert.equal(calls.titles.length, 2);
  });
  test(`${commandName} bounds the first title request without saving a false success`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dataFile = makeTempDataFile(t);
    const command = createNmCommand({ dataFile, isAuthorized: () => true, commandName });
    t.after(() => command.stop());
    const { api, calls } = makeApi();
    api.setTitle = () => new Promise(() => {});
    command.start(api);
    let finished = false;
    const work = command.execute(api, { body: `/${commandName} اسم معلق 1s 1s`, threadID: 'hang-start' }).then(() => { finished = true; });
    await flushAsyncWork();
    t.mock.timers.tick(30_000); await flushAsyncWork();
    assert.equal(finished, true, 'initial request must settle at the watchdog deadline');
    await work;
    assert.equal(command.getStatus('hang-start'), null);
    assert.equal(fs.existsSync(dataFile), false);
    assert.ok(calls.messages.some(({ message }) => message.includes('تعذر تغيير اسم المجموعة')));
  });
  test(`${commandName} ignores old in-flight callbacks after reconnect and keeps one new timer`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = createNmCommand({ dataFile: makeTempDataFile(t), isAuthorized: () => true, commandName });
    t.after(() => command.stop());
    const old = makeApi();
    const current = makeApi();
    let completeOld;
    command.start(old.api);
    await command.execute(old.api, { body: `/${commandName} اسم مستعاد 1s 1s`, threadID: 'reconnect' });
    old.api.setTitle = () => new Promise(resolve => { completeOld = resolve; });
    t.mock.timers.tick(1000); await flushAsyncWork();
    command.stop(); command.start(current.api);
    completeOld(); await flushAsyncWork();
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.equal(current.calls.titles.length, 1, 'only the new session may schedule work');
    command.stop();
    t.mock.timers.tick(60_000); await flushAsyncWork();
    assert.equal(current.calls.titles.length, 1, 'stop must clear the current timer');
  });
  test(`${commandName} disconnect cancels a stalled initial request without restoring state`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = createNmCommand({ dataFile: makeTempDataFile(t), isAuthorized: () => true, commandName });
    t.after(() => command.stop());
    const old = makeApi();
    let finishOld;
    old.api.setTitle = () => new Promise(resolve => { finishOld = resolve; });
    command.start(old.api);
    const work = command.execute(old.api, { body: `/${commandName} اسم قديم 1s 1s`, threadID: 'stale-start' });
    await flushAsyncWork();
    command.stop(); command.start(makeApi().api);
    finishOld(); await work;
    assert.equal(command.getStatus('stale-start'), null, 'a disconnected request must not enable a lock');
    assert.deepEqual(old.calls.messages, [], 'do not report success on a stale session');
  });
  test(`${commandName} rejected requests retry and late settlement after timeout is harmless`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const command = createNmCommand({ dataFile: makeTempDataFile(t), isAuthorized: () => true, commandName });
    t.after(() => command.stop());
    const { api } = makeApi();
    let attempts = 0;
    let finishLate;
    api.setTitle = () => {
      attempts++;
      if (attempts === 2) return Promise.reject(new Error('Connection closed'));
      if (attempts === 3) return new Promise(resolve => { finishLate = resolve; });
      return Promise.resolve();
    };
    command.start(api);
    await command.execute(api, { body: `/${commandName} اسم اختبار 1s 1s`, threadID: 'late' });
    t.mock.timers.tick(1000); await flushAsyncWork();
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.equal(attempts, 3);
    t.mock.timers.tick(30_000); await flushAsyncWork();
    finishLate(); await flushAsyncWork();
    t.mock.timers.tick(1000); await flushAsyncWork();
    assert.equal(attempts, 4, 'late completion must not create a duplicate retry');
  });
}
