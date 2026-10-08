'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_VERSION = 1;
const PRODUCTION_STATE_PATH = '/data/alth-command-state/active-commands.json';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isProductionRuntime(env = process.env) {
  const railwayKeys = ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID'];
  return railwayKeys.some(key => typeof env[key] === 'string' && env[key].trim() !== '') ||
    !['development', 'test'].includes(env.NODE_ENV);
}

function resolveStatePath(env = process.env) {
  if (isProductionRuntime(env)) return PRODUCTION_STATE_PATH;
  if (env.NODE_ENV === 'test') {
    if (typeof env.ALTH_COMMAND_STATE_PATH === 'string' && env.ALTH_COMMAND_STATE_PATH.trim()) {
      return path.resolve(env.ALTH_COMMAND_STATE_PATH);
    }
    return path.join(os.tmpdir(), `alth-command-state-${process.pid}`, 'active-commands.json');
  }
  if (typeof env.ALTH_COMMAND_STATE_PATH === 'string' && env.ALTH_COMMAND_STATE_PATH.trim()) {
    return path.resolve(env.ALTH_COMMAND_STATE_PATH);
  }
  return path.join(os.homedir(), '.alth-command-state', 'active-commands.json');
}

function emptyState() {
  return { version: STATE_VERSION, commands: Object.create(null) };
}

function validateState(value) {
  if (!isPlainObject(value) || value.version !== STATE_VERSION || !isPlainObject(value.commands)) {
    throw new Error('Command state has an unsupported structure');
  }

  const commands = Object.create(null);
  for (const [commandName, threads] of Object.entries(value.commands)) {
    if (!commandName || commandName.length > 80 || !isPlainObject(threads)) {
      throw new Error('Command state has an unsupported structure');
    }

    const entries = Object.create(null);
    for (const [threadID, entry] of Object.entries(threads)) {
      if (!threadID || threadID.length > 256 || !(entry === true || isPlainObject(entry))) {
        throw new Error('Command state has an unsupported structure');
      }
      entries[threadID] = JSON.parse(JSON.stringify(entry));
    }
    if (Object.keys(entries).length) commands[commandName] = entries;
  }

  return { version: STATE_VERSION, commands };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Command state directory is not a private directory');
  }
  fs.chmodSync(directory, 0o700);
  if (fs.realpathSync.native(directory) !== path.resolve(directory)) {
    throw new Error('Command state directory could not be safely resolved');
  }
}

function writePrivateJson(filePath, value) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  ensurePrivateDirectory(directory);

  const staging = path.join(directory, '.alth-private');
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const stagingStat = fs.lstatSync(staging);
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
    throw new Error('Command state staging directory is invalid');
  }
  fs.chmodSync(staging, 0o700);
  if (path.dirname(fs.realpathSync.native(staging)) !== fs.realpathSync.native(directory)) {
    throw new Error('Command state staging directory is outside its parent');
  }

  const temporary = path.join(staging, `.${path.basename(absolutePath)}.${process.pid}.${crypto.randomBytes(10).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, absolutePath);
    fs.chmodSync(absolutePath, 0o600);
    const directoryFD = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFD); } finally { fs.closeSync(directoryFD); }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createCommandStateStore({ filePath = resolveStatePath() } = {}) {
  const absolutePath = path.resolve(filePath);

  function load() {
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyState();
      throw new Error('Command state could not be read');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
      throw new Error('Command state could not be read');
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch {
      throw new Error('Command state could not be read');
    }
    return validateState(parsed);
  }

  function save(state) {
    writePrivateJson(absolutePath, validateState(state));
  }

  function get(commandName, threadID) {
    const state = load();
    return state.commands[String(commandName)]?.[String(threadID)];
  }

  function getAll(commandName) {
    const state = load();
    return { ...(state.commands[String(commandName)] || {}) };
  }

  function set(commandName, threadID, entry) {
    if (!(entry === true || isPlainObject(entry))) {
      throw new TypeError('Command state entries must be plain objects or true');
    }
    const state = load();
    const name = String(commandName);
    const thread = String(threadID);
    if (!name || name.length > 80 || !thread || thread.length > 256) {
      throw new TypeError('Command state key is invalid');
    }
    if (!state.commands[name]) state.commands[name] = Object.create(null);
    state.commands[name][thread] = JSON.parse(JSON.stringify(entry));
    save(state);
    return true;
  }

  function remove(commandName, threadID) {
    const state = load();
    const name = String(commandName);
    const thread = String(threadID);
    const entries = state.commands[name];
    if (!entries || !Object.prototype.hasOwnProperty.call(entries, thread)) return false;
    delete entries[thread];
    if (Object.keys(entries).length === 0) delete state.commands[name];
    save(state);
    return true;
  }

  function clear(commandName) {
    const state = load();
    const name = String(commandName);
    const count = Object.keys(state.commands[name] || {}).length;
    if (!count) return 0;
    delete state.commands[name];
    save(state);
    return count;
  }

  function removeThread(threadID, commandNames) {
    const state = load();
    const thread = String(threadID);
    let removed = 0;
    for (const name of commandNames) {
      const entries = state.commands[String(name)];
      if (entries && Object.prototype.hasOwnProperty.call(entries, thread)) {
        delete entries[thread];
        removed++;
        if (Object.keys(entries).length === 0) delete state.commands[String(name)];
      }
    }
    if (removed) save(state);
    return removed;
  }

  return Object.freeze({ filePath: absolutePath, load, get, getAll, set, remove, clear, removeThread });
}

const defaultStore = createCommandStateStore();

module.exports = {
  PRODUCTION_STATE_PATH,
  resolveStatePath,
  createCommandStateStore,
  defaultStore
};
