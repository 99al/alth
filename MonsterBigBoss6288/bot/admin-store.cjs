'use strict';

const fs = require('fs');
const path = require('path');

const ID_RE = /^[1-9]\d*$/;
const DEFAULT_CONFIG = path.join(__dirname, 'admins-config.json');

function statePath(env = process.env) {
  if (isProductionRuntime(env)) {
    const service = String(env.RAILWAY_SERVICE_ID || env.SERVICE_ID || '').trim();
    return path.join('/data', 'alth-admin-state', service ? `${service}-admins.json` : 'admins.json');
  }
  if (env.ALTH_ADMIN_STATE_PATH) return path.resolve(env.ALTH_ADMIN_STATE_PATH);
  return path.join(__dirname, '.admin-state', 'admins.json');
}

function isProductionRuntime(env = process.env) {
  return env.NODE_ENV === 'production' ||
    ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID'].some(key =>
      typeof env[key] === 'string' && env[key].trim() !== '');
}

function hasExplicitStatePath(env = process.env) {
  return Boolean(env.ALTH_ADMIN_STATE_PATH);
}

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }
function readSeed(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.admins) || config.admins.some(id => !validId(id))) throw new Error('INVALID_ADMIN_SEED');
  return [...new Set(config.admins)];
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_ADMIN_STATE_PATH');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function parseState(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.admins) || !Array.isArray(value.revoked) || value.admins.some(id => !validId(id)) || value.revoked.some(id => !validId(id))) throw new Error('INVALID_ADMIN_STATE');
  const admins = new Set(value.admins);
  const revoked = new Set(value.revoked);
  for (const id of revoked) admins.delete(id);
  return { admins, revoked };
}

function load(configPath = DEFAULT_CONFIG, env = process.env) {
  const file = statePath(env);
  try {
    if (env.NODE_ENV === 'test' && !hasExplicitStatePath(env)) return new Set(readSeed(configPath));
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error && error.code === 'ENOENT') stat = null;
      else throw error;
    }
    if (!stat) {
      const admins = new Set(readSeed(configPath));
      const state = { admins: [...admins], revoked: [] };
      try { writeJsonAtomic(file, state); } catch { return new Set(); }
      return admins;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_ADMIN_STATE_PATH');
    return parseState(fs.readFileSync(file, 'utf8')).admins;
  } catch {
    return new Set();
  }
}

function change(operation, target, configPath = DEFAULT_CONFIG, env = process.env) {
  if (!validId(target)) return { ok: false, reason: 'target' };
  const file = statePath(env);
  let current;
  try {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error && error.code === 'ENOENT') stat = null;
      else throw error;
    }
    if (!stat) {
      current = { admins: new Set(readSeed(configPath)), revoked: new Set() };
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_ADMIN_STATE_PATH');
      current = parseState(fs.readFileSync(file, 'utf8'));
    }
  } catch { return { ok: false, reason: 'storage' }; }
  if (operation === 'add') {
    if (current.admins.has(target)) return { ok: true, changed: false };
    current.admins.add(target); current.revoked.delete(target);
  } else {
    if (!current.admins.has(target)) return { ok: true, changed: false };
    if (current.admins.size <= 1) return { ok: false, reason: 'last' };
    current.admins.delete(target); current.revoked.add(target);
  }
  try { writeJsonAtomic(file, { admins: [...current.admins], revoked: [...current.revoked] }); return { ok: true, changed: true }; }
  catch { return { ok: false, reason: 'storage' }; }
}

module.exports = { statePath, load, isAdmin: (id, configPath, env) => load(configPath, env).has(String(id)), add: (id, configPath, env) => change('add', String(id), configPath, env), remove: (id, configPath, env) => change('remove', String(id), configPath, env), writeJsonAtomic };
