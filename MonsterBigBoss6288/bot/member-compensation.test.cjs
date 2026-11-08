'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMemberQueue } = require('./member-compensation.cjs');
const G = '9001', H = '9002';
const participants = () => Array.from({ length: 249 }, (_, index) => String(1000 + index));
const event = (key = 'event1', threadID = G) => ({ type: 'event', logMessageType: 'log:unsubscribe', threadID, messageID: key, logMessageData: { leftParticipantFbId: '999' } });
const message = (id, threadID = G) => ({ body: `ضيف ${id}`, threadID, senderID: '11', isGroup: true });
function fixture() {
  let data = { version: 1, groups: {} }, writes = 0, admins = ['11'];
  const adds = [], notices = [];
  const api = {
    getThreadInfo: (tid, callback) => callback(null, { participantIDs: participants() }),
    addUserToGroup: (id, tid, callback) => { adds.push([id, tid]); callback(null, {}); },
    sendMessage: (text, to, callback) => { notices.push([text, to]); callback(null, {}); }
  };
  const read = () => structuredClone(data);
  const write = value => { writes++; data = structuredClone(value); };
  const make = (options = {}) => createMemberQueue({ enabled: true, file: '/unused', read, write, getAdminIDs: () => admins, requestTimeoutMs: 25, ...options });
  const queue = async (instance, id, tid = G) => instance.command(api, message(id, tid), () => true);
  return { api, adds, notices, make, queue, read, write, get data() { return data; }, set data(value) { data = value; }, get writes() { return writes; }, set admins(value) { admins = value; } };
}

test('admin/group validation, help, whitespace, multiple IDs and group-isolated dedupe', async () => {
  const f = fixture(), q = f.make();
  await q.command(f.api, { ...message('5000'), isGroup: false }, () => true);
  await q.command(f.api, { ...message('5000'), isGroup: undefined }, () => true);
  await q.command(f.api, message('5000'), () => false);
  await q.command(f.api, message('5000', '__proto__'), () => true);
  assert.equal(f.writes, 0);
  await q.command(f.api, { ...message('5000'), body: ' ضيف\t5000 ' }, () => true);
  await f.queue(q, '5000'); await f.queue(q, '5001'); await f.queue(q, '5000', H);
  assert.deepEqual(f.data.groups[G].queue, ['5000', '5001']); assert.deepEqual(f.data.groups[H].queue, ['5000']);
  const before = f.writes;
  await f.queue(q, '0'); await f.queue(q, '01'); await f.queue(q, 'not-an-id');
  await q.command(f.api, { ...message('5000'), body: 'ضيف' }, () => true);
  assert.equal(f.writes, before); assert(f.notices.some(([text]) => text.includes('الاستخدام')));
});

test('duplicate/concurrent events and restart never consume next ID; groups remain isolated', async () => {
  const f = fixture(); let q = f.make();
  await f.queue(q, '5000'); await f.queue(q, '5001'); await f.queue(q, '5000', H);
  await Promise.all([q.onEvent(f.api, event()), q.onEvent(f.api, event())]);
  assert.deepEqual(f.adds, [['5000', G]]); assert.deepEqual(f.data.groups[G].queue, ['5001']);
  q = f.make(); await q.onEvent(f.api, event()); await f.queue(q, '5000');
  assert.deepEqual(f.data.groups[G].queue, ['5001']);
  await Promise.all([q.onEvent(f.api, event('event2')), q.onEvent(f.api, event('event1', H))]);
  assert.deepEqual(new Set(f.adds.map(JSON.stringify)), new Set([['5000', G], ['5001', G], ['5000', H]].map(JSON.stringify)));
});

test('only a valid leave with exactly 249 distinct valid members and absent leaver is eligible', async () => {
  const f = fixture(), q = f.make(); await f.queue(q, '5000');
  const snapshots = [participants().slice(1), [...participants(), '7000'], [...participants(), '1000'], [...participants().slice(1), '999'], [...participants().slice(1), 'bad']];
  for (let index = 0; index < snapshots.length; index++) await q.onEvent({ ...f.api, getThreadInfo: async () => ({ participantIDs: snapshots[index] }) }, event(`invalid${index}`));
  await q.onEvent(f.api, { ...event(), type: 'message' });
  await q.onEvent(f.api, { ...event(), logMessageData: {} });
  assert.equal(f.adds.length, 0); assert.deepEqual(f.data.groups[G].queue, ['5000']);
  await q.onEvent(f.api, event('valid')); assert.equal(f.adds.length, 1);
});

test('approval mode retains queue; existing member is skipped; notifications use current admins and identify group', async () => {
  const f = fixture(), q = f.make(); await f.queue(q, '1000'); await f.queue(q, '5000');
  for (const approvalMode of [true, 1, '1', 'true']) await q.onEvent({ ...f.api, getThreadInfo: async () => ({ participantIDs: participants(), approvalMode }) }, event(`approval-${approvalMode}-${typeof approvalMode}`));
  assert.equal(f.adds.length, 0); assert.deepEqual(f.data.groups[G].queue, ['1000', '5000']);
  f.admins = ['22']; f.notices.length = 0;
  await q.onEvent(f.api, event('allowed'));
  assert.equal(f.data.groups[G].seen['1000'].status, 'already_member'); assert.deepEqual(f.adds, [['5000', G]]);
  assert(f.notices.length > 0); assert(f.notices.every(([text, to]) => to === '22' && text.includes(G)));
});

test('callback-only request handles wait for completion and confirmed membership is distinguished', async () => {
  const f = fixture(), q = f.make({ requestTimeoutMs: 100 }); await f.queue(q, '5000');
  let added = false;
  const api = { ...f.api,
    getThreadInfo: (tid, cb) => cb(null, { participantIDs: [...participants(), ...(added ? ['5000'] : [])] }),
    addUserToGroup: (id, tid, cb) => { setTimeout(() => { added = true; f.adds.push([id, tid]); cb(null, {}); cb(Error('late duplicate')); }, 5); return { request: true }; }
  };
  await q.onEvent(api, event()); assert.equal(added, true); assert.equal(f.adds.length, 1);
  assert(f.notices.some(([text]) => text.includes('تأكدت عضوية')));
});

test('Promise completion and negative API results are authoritative, with no retry after restart', async () => {
  const f = fixture(); let q = f.make(); await f.queue(q, '5000');
  await q.onEvent({ ...f.api, getThreadInfo: async () => ({ participantIDs: participants() }), addUserToGroup: async () => undefined }, event());
  assert.equal(f.data.groups[G].seen['5000'].status, 'acknowledged'); assert(f.notices.some(([text]) => text.includes('غير مؤكدة')));
  const results = [false, { success: false }, { error: 'denied' }, { errors: ['denied'] }];
  for (let index = 0; index < results.length; index++) {
    const id = String(5100 + index); await f.queue(q, id);
    await q.onEvent({ ...f.api, addUserToGroup: async () => results[index] }, event(`negative${index}`));
    assert.equal(f.data.groups[G].seen[id].status, 'failed'); q = f.make(); await f.queue(q, id); assert(!f.data.groups[G].queue.includes(id));
  }
});

test('stalled add times out once; stalled thread-info never consumes a queued account', async () => {
  const f = fixture(), q = f.make(); await f.queue(q, '5000'); await f.queue(q, '5001');
  let calls = 0;
  await q.onEvent({ ...f.api, addUserToGroup: () => { calls++; } }, event());
  assert.equal(f.data.groups[G].seen['5000'].status, 'uncertain'); assert.deepEqual(f.data.groups[G].queue, ['5001']);
  await f.make().onEvent(f.api, event()); assert.equal(calls, 1); assert.equal(f.adds.length, 0);
  await q.onEvent({ ...f.api, getThreadInfo: () => {} }, event('info-timeout')); assert.deepEqual(f.data.groups[G].queue, ['5001']);
});

test('durable intent precedes effect, and restart converts interrupted intent without retry', async () => {
  const f = fixture(), q = f.make(); await f.queue(q, '5000');
  await q.onEvent({ ...f.api, addUserToGroup: (id, tid, cb) => { assert.equal(f.data.groups[tid].seen[id].status, 'in_flight'); assert(!f.data.groups[tid].queue.includes(id)); cb(null, {}); } }, event());
  f.data.groups[G].seen['5000'] = { status: 'in_flight', event: 'interrupted', at: 1 };
  const restarted = f.make(); assert.equal(f.data.groups[G].seen['5000'].status, 'uncertain_after_restart');
  await f.queue(restarted, '5000'); await restarted.onEvent(f.api, event('another')); assert.equal(f.adds.length, 0);
});

test('malformed state fails closed; storage failures before/after effect never permit duplicate adds', async () => {
  for (const bad of [{ groups: {} }, { version: 1, groups: { [G]: { queue: ['5000'], seen: {}, events: [], history: [] } } }, { version: 1, groups: { [G]: { queue: [], seen: {}, events: [{}], history: [] } } }]) {
    const f = fixture(), q = f.make({ read: () => bad }); await f.queue(q, '5000'); await q.onEvent(f.api, event()); assert.equal(f.writes, 0); assert.equal(f.adds.length, 0);
  }
  const f = fixture(); let q = f.make(); await f.queue(q, '5000');
  let writes = 0;
  q = f.make({ write: value => { if (++writes === 2) throw Error('disk'); f.write(value); } });
  await q.onEvent(f.api, event()); assert.equal(f.adds.length, 0); assert.deepEqual(f.data.groups[G].queue, ['5000']);
  // New instance: claim + intent succeed, completion write fails after the add.
  writes = 0; q = f.make({ write: value => { if (++writes >= 3) throw Error('disk'); f.write(value); } });
  await q.onEvent(f.api, event('postwrite')); assert.equal(f.adds.length, 1); assert.equal(f.data.groups[G].seen['5000'].status, 'in_flight');
  q = f.make(); assert.equal(f.data.groups[G].seen['5000'].status, 'uncertain_after_restart');
  await f.queue(q, '5000'); await q.onEvent(f.api, event('postrestart')); assert.equal(f.adds.length, 1);
});

test('private filesystem persistence, restart, symlink refusal and disabled initialization', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot2-member-'));
  try {
    const f = fixture(), file = path.join(dir, 'private', 'queue.json');
    let q = createMemberQueue({ enabled: true, file, requestTimeoutMs: 25 }); await f.queue(q, '5000');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    q = createMemberQueue({ enabled: true, file, requestTimeoutMs: 25 }); await q.onEvent(f.api, event()); assert.equal(f.adds.length, 1);
    const link = path.join(dir, 'linked.json'); fs.symlinkSync(file, link); const before = fs.readFileSync(file, 'utf8');
    await f.queue(createMemberQueue({ enabled: true, file: link, requestTimeoutMs: 25 }), '5001'); assert.equal(fs.readFileSync(file, 'utf8'), before);
    let reads = 0;
    const inactive = createMemberQueue({ env: { BOT_COMMAND_PROFILE: 'first' }, read: () => { reads++; throw Error('must not read'); }, write: () => { throw Error('must not write'); } });
    assert.equal(await inactive.command(f.api, message('5000'), () => true), false); await inactive.onEvent(f.api, event()); assert.equal(reads, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('main runtime loads member queue only for the second command profile', () => {
  const script = `const Module=require('node:module');const old=Module._load;let initialized=0;Module._load=function(name,...rest){if(name==='./member-compensation.cjs')return{createMemberQueue(){initialized++;return{command:async()=>false,onEvent:async()=>{}}}};return old.call(this,name,...rest)};require('./main.js');console.log('MEMBER_INIT='+initialized);`;
  for (const [profile, expected] of [['first', 0], ['second', 1]]) {
    const child = spawnSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, NODE_ENV: 'test', BOT_COMMAND_PROFILE: profile }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert(child.stdout.includes(`MEMBER_INIT=${expected}`), child.stdout);
  }
});
