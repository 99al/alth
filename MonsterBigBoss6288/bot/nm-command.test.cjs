'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNmCommand } = require('./nm-command.standalone');

function makeTempDataFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-nm-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'database', 'data', 'nmData.json');
}

function makeApi() {
  const calls = { messages: [], titles: [] };
  const api = {
    async sendMessage(message, threadID) {
      calls.messages.push({ message, threadID: String(threadID) });
    },
    async setTitle(name, threadID) {
      calls.titles.push({ name, threadID: String(threadID) });
    }
  };
  return { api, calls };
}

async function flushAsyncWork() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('nm authorization stays closed by default and accepts the supplied admin checker', async t => {
  const command = createNmCommand({ dataFile: makeTempDataFile(t) });
  const { api, calls } = makeApi();
  const event = { body: '/nm اسم تجريبي 1 2', threadID: 'thread-auth', senderID: 'member' };

  assert.equal(await command.execute(api, event), true);
  assert.equal(calls.titles.length, 0, 'unauthorized invocation cannot change the group name');
  assert.ok(calls.messages.some(({ message }) => message.includes('مخصص للمشرفين')));

  assert.equal(await command.execute(api, event, {
    isAdmin: senderID => senderID === 'member'
  }), true);
  assert.deepEqual(calls.titles, [{ name: 'اسم تجريبي', threadID: 'thread-auth' }]);
  assert.deepEqual(command.getStatus('thread-auth'), {
    name: 'اسم تجريبي',
    minMinutes: 1,
    maxMinutes: 2
  });
});

test('nm persists settings, restores timers after start, and stops every timer on disconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dataFile = makeTempDataFile(t);
  const command = createNmCommand({ dataFile, isAuthorized: () => true });
  const { api, calls } = makeApi();

  assert.equal(command.start(api), 0);
  await command.execute(api, {
    body: '/nm الاسم المحمي 1 1',
    threadID: 'thread-persist',
    senderID: 'admin'
  });
  assert.deepEqual(calls.titles, [{ name: 'الاسم المحمي', threadID: 'thread-persist' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), {
    version: 1,
    groups: {
      'thread-persist': { name: 'الاسم المحمي', minMinutes: 1, maxMinutes: 1 }
    }
  });

  t.mock.timers.tick(60_000);
  await flushAsyncWork();
  assert.equal(calls.titles.length, 2, 'active lock reapplies the name on its interval');

  command.stop();
  t.mock.timers.tick(120_000);
  await flushAsyncWork();
  assert.equal(calls.titles.length, 2, 'disconnect cleanup prevents later timer mutations');

  const resumed = createNmCommand({ dataFile, isAuthorized: () => true });
  assert.equal(resumed.start(api), 1, 'saved locks are restored on the next login');
  t.mock.timers.tick(60_000);
  await flushAsyncWork();
  assert.equal(calls.titles.length, 3, 'restored lock resumes while the bot is connected');
  resumed.stop();
});

test('nm time and off commands update persistence and cancel the group timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dataFile = makeTempDataFile(t);
  const command = createNmCommand({ dataFile, isAuthorized: () => true });
  const { api, calls } = makeApi();
  command.start(api);

  await command.execute(api, { body: '/nm اسم ثابت 5 5', threadID: 'thread-off', senderID: 'admin' });
  await command.execute(api, { body: '/nm time 2 3', threadID: 'thread-off', senderID: 'admin' });
  assert.deepEqual(command.getStatus('thread-off'), {
    name: 'اسم ثابت',
    minMinutes: 2,
    maxMinutes: 3
  });

  await command.execute(api, { body: '/nm off', threadID: 'thread-off', senderID: 'admin' });
  assert.equal(command.getStatus('thread-off'), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), { version: 1, groups: {} });
  const titlesBeforeAdvance = calls.titles.length;
  t.mock.timers.tick(5 * 60_000);
  await flushAsyncWork();
  assert.equal(calls.titles.length, titlesBeforeAdvance, 'off cancels the scheduled title reset');
  command.stop();
});
