'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
process.env.NODE_ENV = 'test';
process.env.ALTH_COMMAND_STATE_PATH = path.join(os.tmpdir(), `alth-followup-${process.pid}`, 'state.json');
const store = require('./command-state.cjs').defaultStore;
function stateKey(profile) { return profile === 'fifth' ? 'جودي' : 'جريد'; }
function fresh(profile) {
  process.env.BOT_COMMAND_PROFILE = profile;
  delete require.cache[require.resolve('./Commands/جريد.js')];
  return require('./Commands/جريد.js');
}
async function flush() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }
for (const [profile, name] of [['first', 'جريد'], ['second', 'جريدة'], ['third', 'جينو'], ['fourth', 'جين'], ['fifth', 'جودي']]) {
  test(`${profile}: command then ID, same sender and private chat, literal text, repeat, resume and stop`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cmd = fresh(profile); t.after(() => { cmd.pauseAll(); store.clear(stateKey(profile)); });
    const calls = []; const api = { async sendMessage(message, id) { calls.push({ message, id }); } };
    const control = { threadID: '61594703229486', senderID: '61594703229486', isGroup: false };
    await cmd.execute(api, { ...control, body: `${name} 3 5 ويس` });
    assert.equal(cmd.isActive(control.threadID), false);
    t.mock.timers.tick(10000); await flush();
    assert.equal(calls.some(c => c.message === 'ويس'), false);
    assert.equal(await cmd.handleRecipientFollowup(api, { ...control, senderID: 'other', body: '100012345678901' }), false);
    assert.equal(await cmd.handleRecipientFollowup(api, { ...control, isGroup: true, body: '100012345678901' }), false);
    assert.equal(await cmd.handleRecipientFollowup(api, { ...control, body: 'wrong-id' }), false);
    assert.equal(await cmd.handleRecipientFollowup(api, { ...control, body: '١٠٠٠١٢٣٤٥٦٧٨٩٠١' }), true);
    const saved = store.get(stateKey(profile), control.threadID);
    assert.equal(saved.message, 'ويس');
    assert.deepEqual(saved.recipients, [{ threadID: '100012345678901', name: '100012345678901' }]);
    t.mock.timers.tick(5000); await flush();
    t.mock.timers.tick(5000); await flush();
    assert.deepEqual(calls.filter(c => c.message === 'ويس').map(c => c.id), ['100012345678901', '100012345678901']);
    cmd.pauseAll();
    const resumed = fresh(profile); t.after(() => resumed.pauseAll());
    assert.equal(resumed.resumeAll(api), 1);
    await resumed.execute(api, { ...control, body: `${name} ايقاف` });
    t.mock.timers.tick(10000); await flush();
    assert.equal(store.get(stateKey(profile), control.threadID), undefined);
    assert.equal(calls.filter(c => c.message === 'ويس').length, 2);
  });
  test(`${profile}: stop cancels pending setup and expiry cannot start it`, async t => {
    const cmd = fresh(profile); t.after(() => { cmd.pauseAll(); store.clear(stateKey(profile)); });
    const api = { async sendMessage() {} };
    const control = { threadID: 'pending-control', senderID: 'owner', isGroup: false };
    await cmd.execute(api, { ...control, body: `${name} 3 5 ويس` });
    await cmd.execute(api, { ...control, body: `${name} ايقاف` });
    assert.equal(await cmd.handleRecipientFollowup(api, { ...control, body: '100012345678901' }), false);
    await cmd.execute(api, { ...control, body: `${name} 3 5 ويس` });
    t.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER);
    assert.equal(await cmd.handleRecipientFollowup(api, { ...control, body: '100012345678901' }), false);
    assert.equal(cmd.isActive(control.threadID), false);
  });
  test(`${profile}: refusal removes durable recipient, no retries after reload`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cmd = fresh(profile); t.after(() => { cmd.pauseAll(); store.clear(stateKey(profile)); });
    const calls = [];
    const api = { async sendMessage(message, id) { calls.push({ message, id }); if (id === '100012345678901') throw new Error('privacy refusal'); } };
    const control = { threadID: 'reject-control', senderID: 'owner', isGroup: false };
    await cmd.execute(api, { ...control, body: `${name} 1 1 محتوى` });
    await cmd.handleRecipientFollowup(api, { ...control, body: '100012345678901' });
    t.mock.timers.tick(1000); await flush();
    assert.equal(cmd.isActive(control.threadID), false);
    assert.equal(store.get(stateKey(profile), control.threadID), undefined);
    t.mock.timers.tick(10000); await flush();
    assert.equal(calls.filter(c => c.message === 'محتوى').length, 1);
    const resumed = fresh(profile); t.after(() => resumed.pauseAll()); assert.equal(resumed.resumeAll(api), 0);
  });
  test(`${profile}: routing accepts admin ID followup, silently ignores outsiders`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cmd = fresh(profile); t.after(() => { cmd.pauseAll(); store.clear(stateKey(profile)); });
    const { handleMessage } = require('./main');
    const { getBotCommandProfile } = require('./bot-command-profile.cjs');
    const calls = []; const api = { async sendMessage(message) { calls.push(message); } };
    const deps = { commands: new Map([[name, cmd]]), isAdmin: id => id === '61594703229486', isCommandEnabled: () => true, commandProfile: getBotCommandProfile({ BOT_COMMAND_PROFILE: profile }) };
    const control = { threadID: 'routing-control', senderID: '61594703229486', isGroup: false };
    await handleMessage(api, { ...control, body: `${name} 3 5 ويس` }, deps);
    await handleMessage(api, { ...control, senderID: 'intruder', body: '100012345678901' }, deps);
    assert.equal(cmd.isActive(control.threadID), false);
    const before = calls.length;
    await handleMessage(api, { ...control, senderID: 'intruder', body: `${name} 3 5 spam` }, deps);
    assert.equal(calls.length, before);
    await handleMessage(api, { ...control, body: '100012345678901' }, deps);
    assert.equal(cmd.isActive(control.threadID), true);
  });
}
