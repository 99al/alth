'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const store = require('./admin-store.cjs');
const owner = '61594703229486';
const member = '200000000001';
const outsider = '300000000001';

if (process.env.ADMIN_CHILD) {
  const main = require('./main');
  const profile = require('./bot-command-profile.cjs').getBotCommandProfile();
  const calls = { sent: [], reactions: [], commands: [], auto: 0 };
  const api = {
    async sendMessage(message, threadID) { calls.sent.push({ message, threadID }); },
    async setMessageReaction(...args) { calls.reactions.push(args); }
  };
  const commands = new Map([
    ['اومر', { execute() { calls.commands.push('list'); } }],
    [profile.nm.commandName, { execute() { calls.commands.push(profile.nm.commandName); } }],
    [profile.jareed.commandName, { execute() { calls.commands.push(profile.jareed.commandName); } }],
    ['رد', { checkAutoReply() { calls.auto++; } }]
  ]);
  const event = (body, senderID = owner, extra = {}) => ({ body, senderID,
    threadID: 'thread-admin', messageID: 'message-admin', isGroup: true, ...extra });
  const dispatch = async (body, sender = owner, extra = {}) => {
    await main.handleMessage(api, event(body, sender, extra), { commands, isCommandEnabled: () => true });
    await new Promise(resolve => setImmediate(resolve));
  };
  (async () => {
    const seed = process.env.ADMIN_TEST_SEED;
    // Keep production code's seed path untouched; initialize the test state from an explicit seed.
    if (!fs.existsSync(process.env.ALTH_ADMIN_STATE_PATH)) assert.equal(store.isAdmin(owner, seed), true);
    if (process.env.ADMIN_CHILD === 'fresh') {
      assert.equal(store.isAdmin(owner), false);
      assert.equal(store.isAdmin(member), true);
      return;
    }
    if (process.env.ADMIN_CHILD === 'silent') {
      for (let i = 0; i < 570; i++) {
        await dispatch(i % 2 ? 'ادمن' : 'سحب ادمن', outsider, { messageReply: { senderID: member } });
      }
      assert.deepEqual(calls, { sent: [], reactions: [], commands: [], auto: 0 });
      assert.equal(store.isAdmin(member), false);
      await dispatch('ادمن', owner, { mentions: { [member]: '@member' } });
      assert.equal(store.isAdmin(member), false);
      assert.match(calls.sent.at(-1).message, /الرد/);
      await dispatch('سحب ادمن', owner);
      assert.match(calls.sent.at(-1).message, /الرد/);
      assert.equal(calls.auto, 0);
      return;
    }
    await dispatch('ادمن', owner, { messageReply: { senderID: member }, mentions: { [outsider]: '@other' } });
    assert.equal(store.isAdmin(member), true);
    assert.equal(store.isAdmin(outsider), false);
    assert.equal(calls.auto, 0);
    assert.equal(calls.reactions.length, 0);
    await dispatch('اومر', member);
    await dispatch(`/${profile.nm.commandName} name 1 1`, member);
    await dispatch(`${profile.jareed.commandName} 1 1 text`, member);
    assert.deepEqual(calls.commands, ['list', profile.nm.commandName, profile.jareed.commandName]);
    await dispatch('سحب ادمن', owner, { messageReply: { senderID: member } });
    assert.equal(store.isAdmin(member), false);
    const count = calls.commands.length;
    const sentCount = calls.sent.length;
    await dispatch('اومر', member);
    await dispatch('ادمن', member, { messageReply: { senderID: outsider } });
    await dispatch('سحب ادمن', member, { messageReply: { senderID: owner } });
    assert.equal(calls.commands.length, count);
    assert.equal(calls.sent.length, sentCount);
    for (const body of ['ادمن يضيف', 'ادمن extra', 'سحب ادمن extra']) {
      await dispatch(body, owner, { messageReply: { senderID: member } });
      assert.equal(store.isAdmin(member), false);
    }
    await dispatch('ادمن', owner, { messageReply: { senderID: member } });
    await dispatch('سحب ادمن', member, { messageReply: { senderID: owner } });
    assert.equal(store.isAdmin(owner), false);
    assert.equal(store.isAdmin(member), true);
    await dispatch('سحب ادمن', member, { messageReply: { senderID: member } });
    assert.equal(store.isAdmin(member), true);
    assert.match(calls.sent.at(-1).message, /آخر مشرف/);
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-admin-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const seed = path.join(dir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({ admins: [owner] }));
    return { dir, seed, state: path.join(dir, 'admins.json') };
  }
  function child(profile, scenario, files) {
    const env = { ...process.env, NODE_ENV: 'test', BOT_COMMAND_PROFILE: profile,
      ALTH_ADMIN_STATE_PATH: files.state, ADMIN_TEST_SEED: files.seed, ADMIN_CHILD: scenario };
    for (const key of ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']) delete env[key];
    const result = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${profile}/${scenario}: ${result.stdout}\n${result.stderr}`);
  }
  for (const profile of ['first', 'second', 'third']) {
    test(`grant/revoke, profile routing and restart persistence (${profile})`, t => {
      const files = setup(t);
      child(profile, 'routing', files);
      child(profile, 'fresh', files);
    });
    test(`unauthorized grant/revoke stays silent; target must be reply (${profile})`, t => {
      child(profile, 'silent', setup(t));
    });
  }
  test('corrupt state fails closed and cannot be overwritten', t => {
    const f = setup(t), env = { NODE_ENV: 'test', ALTH_ADMIN_STATE_PATH: f.state };
    fs.writeFileSync(f.state, '{broken');
    assert.equal(store.isAdmin(owner, f.seed, env), false);
    assert.equal(store.add(member, f.seed, env).ok, false);
    assert.equal(fs.readFileSync(f.state, 'utf8'), '{broken');
  });
  test('write failures do not report success or grant privileges', t => {
    const f = setup(t), env = { NODE_ENV: 'test', ALTH_ADMIN_STATE_PATH: f.state };
    assert.equal(store.isAdmin(owner, f.seed, env), true);
    const original = fs.renameSync;
    t.mock.method(fs, 'renameSync', () => { throw new Error('disk unavailable'); });
    assert.equal(store.add(member, f.seed, env).ok, false);
    assert.equal(store.isAdmin(member, f.seed, env), false);
    t.mock.restoreAll();
    assert.equal(fs.renameSync, original);
    assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
  });
  test('symlink and dangling symlink state fail closed', t => {
    const f = setup(t), env = { NODE_ENV: 'test', ALTH_ADMIN_STATE_PATH: f.state };
    fs.symlinkSync(path.join(f.dir, 'missing.json'), f.state);
    assert.equal(store.isAdmin(owner, f.seed, env), false);
    assert.equal(store.add(member, f.seed, env).ok, false);
    fs.writeFileSync(path.join(f.dir, 'missing.json'), JSON.stringify({ admins: [owner], revoked: [] }));
    assert.equal(store.isAdmin(owner, f.seed, env), false);
  });
  test('production path is service-isolated on the existing volume', () => {
    assert.equal(store.statePath({ NODE_ENV: 'production', ALTH_ADMIN_STATE_PATH: '/tmp/x' }), '/data/alth-admin-state/admins.json');
    assert.equal(store.statePath({ RAILWAY_SERVICE_ID: 'service' }), '/data/alth-admin-state/service-admins.json');
    assert.match(store.statePath({ RAILWAY_PROJECT_ID: 'project' }), /^\/data\//);
  });
}
