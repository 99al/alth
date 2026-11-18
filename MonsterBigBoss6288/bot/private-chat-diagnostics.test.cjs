'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const diagnosticModule = require('./private-chat-diagnostics.cjs');

const sourceMain = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const sourceIndex = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const sourceList = fs.readFileSync(path.join(__dirname, 'Commands', 'اومر.js'), 'utf8');
const handlerStart = sourceMain.indexOf('async function handleMessage(');
const handlerEnd = sourceMain.indexOf('\n}\n', handlerStart) + 2;
assert(handlerStart >= 0 && handlerEnd > handlerStart, 'actual message handler is extracted');

function makeHarness({ isAdmin = true, enabled = true, sendFailure = null } = {}) {
  const lines = [];
  const diagnostic = diagnosticModule.createDiagnostics({ write: line => lines.push(line) });
  const registry = new Map();
  registry.set('اومر', null);
  registry.set('جريد', { name: 'جريد', aliases: [] });
  registry.set('رد', { name: 'رد', aliases: [] });

  const runtime = {
    module: { exports: {} }, exports: {},
    console: { log() {}, error() {} },
    privateChatDiagnostics: diagnosticModule,
    require(name) {
      if (name === 'fs') return { readFileSync() { throw new Error('synthetic file unavailable'); } };
      if (name === 'path') return { join: (...parts) => parts.join('/') };
      if (name === './private-chat-diagnostics.cjs') return diagnosticModule;
      throw new Error(`unexpected handler import: ${name}`);
    },
  };
  vm.createContext(runtime);
  vm.runInContext(`${sourceMain.slice(handlerStart, handlerEnd)}\nthis.handle = handleMessage;`, runtime, { timeout: 1000 });

  const commandRuntime = {
    module: { exports: {} }, exports: {}, __dirname: path.join(__dirname, 'Commands'),
    require(name) {
      if (name === 'fs') return { readFileSync() { throw new Error('synthetic config unavailable'); } };
      if (name === 'path') return path;
      if (name === '../private-chat-diagnostics.cjs') return diagnosticModule;
      if (name === '../main') return { commands: registry };
      throw new Error(`unexpected command import: ${name}`);
    },
  };
  vm.createContext(commandRuntime);
  vm.runInContext(sourceList, commandRuntime, { timeout: 1000 });
  registry.set('اومر', commandRuntime.module.exports);

  const sends = [];
  const api = {
    async sendMessage(text, threadID) {
      if (sendFailure) throw sendFailure;
      sends.push({ text, threadID, api: this });
    },
  };
  const dependencies = {
    commands: registry,
    isAdmin: () => isAdmin,
    isCommandEnabled: () => enabled,
    commandProfile: { jareed: { commandName: 'جريد' }, nm: { commandName: 'nm' } },
    adminIdHandler: { handle: async () => false },
    privateChatDiagnostics: diagnostic,
  };
  return { diagnostic, dependencies, lines, registry, runtime, sends, api };
}

async function runEvent(harness, { isGroup, type = 'message', body = 'أوامر', senderID = 'synthetic-admin-id', threadID = isGroup ? 'synthetic-group-thread' : 'synthetic-dm-thread' }) {
  const event = { type, body, senderID, threadID, isGroup };
  diagnosticModule.recordMessageEvent(event, harness.diagnostic);
  await harness.runtime.handle(harness.api, event, harness.dependencies);
  await new Promise(resolve => setImmediate(resolve));
  return event;
}

(async () => {
  const dm = makeHarness();
  await runEvent(dm, { isGroup: false, type: 'message_reply' });
  assert.equal(dm.sends.length, 1, 'DM reply is sent once');
  assert.equal(dm.sends[0].threadID, 'synthetic-dm-thread', 'DM response uses incoming thread');
  assert.equal(dm.sends[0].api, dm.api, 'DM response uses the same bot API/account');
  assert.match(dm.sends[0].text, /^📚 أوامر بوت/);
  assert.deepEqual(dm.lines.map(line => line.match(/stage=([^ ]+)/)?.[1]), [
    'event_received', 'command_matched', 'admin_allowed', 'reply_attempted', 'reply_succeeded',
  ]);
  assert(dm.lines.every(line => line.includes('chat=dm')));

  const group = makeHarness();
  await runEvent(group, { isGroup: true });
  assert.equal(group.sends.length, 1, 'group response behavior remains unchanged');
  assert.equal(group.sends[0].threadID, 'synthetic-group-thread', 'group response uses incoming group thread');
  assert.equal(group.sends[0].api, group.api, 'group response uses the same bot API/account');
  assert.match(group.sends[0].text, /^📚 أوامر بوت/);
  assert.deepEqual(group.lines.map(line => line.match(/stage=([^ ]+)/)?.[1]), [
    'event_received', 'command_matched', 'admin_allowed', 'reply_attempted', 'reply_succeeded',
  ]);
  assert(group.lines.every(line => line.includes('chat=group')));

  const denied = makeHarness({ isAdmin: false });
  await runEvent(denied, { isGroup: false });
  assert.equal(denied.sends.length, 0, 'non-admin remains blocked');
  assert(denied.lines.some(line => line.includes('stage=admin_denied chat=dm')));
  assert(!denied.lines.some(line => line.includes('reply_attempted')));

  const disabled = makeHarness({ enabled: false });
  await runEvent(disabled, { isGroup: false });
  assert.equal(disabled.sends.length, 0, 'disabled command remains disabled');
  assert(disabled.lines.some(line => line.includes('stage=command_disabled chat=dm')));
  assert(!disabled.lines.some(line => line.includes('reply_attempted')));

  const secretText = 'أوامر secret-cookie=synthetic-cookie thread_id=synthetic-thread sender=synthetic-admin-id';
  const failed = makeHarness({ sendFailure: Object.assign(new Error(`login_blocked ${secretText}`), { code: 'E_SYNTHETIC' }) });
  await runEvent(failed, { isGroup: false });
  assert(failed.lines.some(line => line === '[BOT2-DIAG] stage=reply_failed chat=dm type=message error_type=auth'));
  assert(failed.lines.every(line => !line.includes(secretText) && !line.includes('synthetic-cookie') && !line.includes('synthetic-admin-id')));
  assert(!failed.lines.some(line => line.includes('reply_succeeded')));

  const ignored = makeHarness();
  assert.equal(diagnosticModule.recordMessageEvent({ type: 'read_receipt', isGroup: false, body: secretText, threadID: 'synthetic-thread' }, ignored.diagnostic), false);
  assert.equal(ignored.lines.length, 0, 'non-message events do not create diagnostic records');

  let clock = 1000;
  const boundedLines = [];
  const bounded = diagnosticModule.createDiagnostics({ now: () => clock, write: line => boundedLines.push(line), windowMs: 100, maxEventRecords: 1, maxTotalRecords: 3 });
  assert.equal(bounded.emit('event_received', { chat: 'dm', type: 'message' }), true);
  assert.equal(bounded.emit('event_received', { chat: 'group', type: 'message' }), false, 'event log cap is enforced');
  assert.equal(bounded.emit('reply_failed', { chat: 'dm', type: 'message', errorType: 'anything-secret' }), true);
  assert(boundedLines[1].endsWith('error_type=other'), 'error type is allowlisted');
  clock += 101;
  assert.equal(bounded.emit('reply_attempted', { chat: 'dm', type: 'message' }), false, 'time window expires automatically');
  assert.equal(boundedLines.length, 2);

  const brokenWriter = diagnosticModule.createDiagnostics({ write() { throw new Error('synthetic logging failure'); } });
  assert.equal(brokenWriter.emit('reply_attempted', { chat: 'dm', type: 'message' }), false);
  const unaffected = makeHarness();
  unaffected.dependencies.privateChatDiagnostics = brokenWriter;
  await runEvent(unaffected, { isGroup: false });
  assert.equal(unaffected.sends.length, 1, 'logging failures do not prevent reply or message dispatch');

  assert.match(sourceIndex, /privateChatDiagnostics\.recordMessageEvent\(event\)/, 'live listener records only through safe event wrapper');
  assert.match(sourceIndex, /type === 'message'[\s\S]{0,80}type === 'message_reply'[\s\S]{0,220}handleMessage\(\s*api,\s*event,\s*\{/, 'existing message dispatch is retained with explicit control dependencies');
  assert.match(sourceIndex, /selfListen:\s*true/, 'the logged-in bot account can receive its own private commands');
  assert.match(sourceMain, /currentBotID && senderID === currentBotID\) return/, 'unrecognized self-authored events are ignored to prevent loops');
  assert.match(sourceMain, /if \(!adminAllowed\) return/, 'admin check remains enforced');

  console.log('PASS: DM/group routing, admin access, reply outcome, safe error category, redaction, caps, expiry, and unchanged dispatch');
})().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
