'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { statePath, createBotControlStateStore } = require('./bot-control-state.cjs');

test('private state survives a new store instance and uses restrictive permissions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-bot-control-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state', 'control.json');
  const first = createBotControlStateStore({ filePath });
  assert.deepEqual(first.load(), { ok: true, paused: false, initialized: false });
  assert.deepEqual(first.setPaused(true), { ok: true, changed: true });

  const restarted = createBotControlStateStore({ filePath });
  assert.deepEqual(restarted.load(), { ok: true, paused: true, initialized: true });
  assert.deepEqual(restarted.setPaused(false), { ok: true, changed: true });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
});

test('production state path is isolated per Railway service on the existing data volume', () => {
  assert.equal(statePath({ NODE_ENV: 'production', RAILWAY_SERVICE_ID: 'service-a' }), '/data/alth-admin-state/service-a-bot-control.json');
  assert.equal(statePath({ NODE_ENV: 'production', RAILWAY_SERVICE_ID: 'service-b' }), '/data/alth-admin-state/service-b-bot-control.json');
  assert.notEqual(statePath({ RAILWAY_PROJECT_ID: 'project', RAILWAY_SERVICE_ID: 'service-a' }), statePath({ RAILWAY_PROJECT_ID: 'project', RAILWAY_SERVICE_ID: 'service-b' }));
});

test('corrupt state and symlink state fail closed as paused and cannot be overwritten', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-bot-control-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'control.json');
  fs.writeFileSync(filePath, '{broken');
  const corrupt = createBotControlStateStore({ filePath });
  assert.equal(corrupt.load().ok, false);
  assert.equal(corrupt.isPaused(), true);
  assert.deepEqual(corrupt.setPaused(false), { ok: false, reason: 'storage' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');

  const target = path.join(directory, 'target.json');
  const link = path.join(directory, 'link.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, paused: false }));
  fs.symlinkSync(target, link);
  const linked = createBotControlStateStore({ filePath: link });
  assert.equal(linked.load().ok, false);
  assert.deepEqual(linked.setPaused(true), { ok: false, reason: 'storage' });
});

test('invalid pause values are rejected', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-bot-control-value-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createBotControlStateStore({ filePath: path.join(directory, 'control.json') });
  assert.deepEqual(store.setPaused('yes'), { ok: false, reason: 'value' });
});
