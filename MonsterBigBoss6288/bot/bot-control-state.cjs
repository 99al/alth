'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isProductionRuntime(env = process.env) {
  return env.NODE_ENV === 'production' ||
    ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID'].some(key =>
      typeof env[key] === 'string' && env[key].trim() !== '');
}

function statePath(env = process.env) {
  if (isProductionRuntime(env)) {
    const service = String(env.RAILWAY_SERVICE_ID || env.SERVICE_ID || '').trim();
    return path.join('/data', 'alth-admin-state', service ? `${service}-bot-control.json` : 'bot-control.json');
  }
  if (env.ALTH_BOT_CONTROL_STATE_PATH) return path.resolve(env.ALTH_BOT_CONTROL_STATE_PATH);
  return path.join(__dirname, '.admin-state', 'bot-control.json');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_CONTROL_STATE_PATH');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }

  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    const directoryDescriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createBotControlStateStore({ filePath = statePath(), fileSystem = fs } = {}) {
  function load() {
    let stat;
    try { stat = fileSystem.lstatSync(filePath); }
    catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, paused: false, initialized: false };
      return { ok: false, paused: true, reason: 'storage' };
    }

    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, paused: true, reason: 'storage' };
    try {
      const value = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.paused !== 'boolean') {
        return { ok: false, paused: true, reason: 'storage' };
      }
      return { ok: true, paused: value.paused, initialized: true };
    } catch {
      return { ok: false, paused: true, reason: 'storage' };
    }
  }

  function setPaused(paused) {
    if (typeof paused !== 'boolean') return { ok: false, reason: 'value' };
    const current = load();
    if (!current.ok) return { ok: false, reason: 'storage' };
    try {
      writeJsonAtomic(filePath, { version: 1, paused });
      return { ok: true, changed: current.paused !== paused };
    } catch {
      return { ok: false, reason: 'storage' };
    }
  }

  return { load, isPaused: () => load().paused, setPaused, filePath };
}

const defaultStore = createBotControlStateStore();
module.exports = { statePath, createBotControlStateStore, defaultStore };
