'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION_COOKIE_NAME = '__Host-alth_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_DASHBOARD_ORIGIN = 'https://alth-production.up.railway.app';

function getDashboardOrigin() {
  const configured = process.env.DASHBOARD_ORIGIN || DEFAULT_DASHBOARD_ORIGIN;
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('DASHBOARD_ORIGIN must be an absolute origin');
  }

  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== configured.replace(/\/$/, '')) {
    throw new Error('DASHBOARD_ORIGIN must contain only scheme and host');
  }

  return parsed.origin;
}

function authIsConfigured() {
  const password = process.env.DASHBOARD_PASSWORD || '';
  const secret = process.env.DASHBOARD_SESSION_SECRET || '';
  try {
    getDashboardOrigin();
  } catch {
    return false;
  }
  return password.length >= 16 && Buffer.byteLength(secret, 'utf8') >= 32;
}

function passwordMatches(candidate) {
  if (!authIsConfigured() || typeof candidate !== 'string' || candidate.length > 512) {
    return false;
  }

  const expected = crypto.createHash('sha256').update(process.env.DASHBOARD_PASSWORD, 'utf8').digest();
  const supplied = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  return crypto.timingSafeEqual(expected, supplied);
}

function createSessionToken(nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!authIsConfigured()) {
    throw new Error('Dashboard authentication is not configured');
  }

  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET)
    .update(payload, 'utf8')
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!authIsConfigured() || typeof token !== 'string' || token.length > 2048) {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return false;
  }

  try {
    const expected = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET)
      .update(parts[0], 'utf8')
      .digest();
    const supplied = Buffer.from(parts[1], 'base64url');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) {
      return false;
    }

    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return payload && payload.v === 1 &&
      Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp) &&
      payload.iat <= nowSeconds + 60 && payload.exp - payload.iat === SESSION_TTL_SECONDS &&
      nowSeconds < payload.exp;
  } catch {
    return false;
  }
}

function getCookieToken(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      const token = part.slice(separator + 1).trim();
      return token || null;
    }
  }
  return null;
}

function hasValidSessionCookie(cookieHeader, nowSeconds) {
  const token = getCookieToken(cookieHeader);
  return token ? verifySessionToken(token, nowSeconds) : false;
}

function createSessionCookieHeader() {
  const token = createSessionToken();
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) return false;
    if (parsed.origin === getDashboardOrigin()) return true;
    return ['development', 'test'].includes(process.env.NODE_ENV) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function createLoginRateLimiter(options = {}) {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const globalMaxAttempts = options.globalMaxAttempts ?? 20;
  const validPositiveInteger = value => Number.isSafeInteger(value) && value > 0;

  if (!validPositiveInteger(windowMs) || windowMs > 24 * 60 * 60 * 1000 ||
      !validPositiveInteger(globalMaxAttempts)) {
    throw new Error('Invalid login rate limiter configuration');
  }

  const attemptTimes = [];
  let lastNow = 0;

  function attempt(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Rate limiter time must be a non-negative integer');
    }

    // Clamp backwards wall-clock adjustments so they cannot prematurely expire attempts.
    lastNow = Math.max(lastNow, now);
    while (attemptTimes.length > 0 && lastNow - attemptTimes[0] >= windowMs) {
      attemptTimes.shift();
    }

    if (attemptTimes.length >= globalMaxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((attemptTimes[0] + windowMs - lastNow) / 1000)),
      };
    }

    attemptTimes.push(lastNow);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return Object.freeze({ attempt });
}

function canonicalizePathAllowMissing(filePath) {
  const absolute = path.resolve(filePath);
  const root = path.parse(absolute).root;
  const pending = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let resolved = root;
  let symlinkDepth = 0;

  while (pending.length > 0) {
    const segment = pending.shift();
    const candidate = path.join(resolved, segment);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return path.resolve(candidate, ...pending);
      }
      throw new Error('APPSTATE_PATH could not be safely canonicalized');
    }

    if (stat.isSymbolicLink()) {
      symlinkDepth += 1;
      if (symlinkDepth > 40) {
        throw new Error('APPSTATE_PATH contains too many symbolic links');
      }

      let linkTarget;
      try {
        linkTarget = fs.readlinkSync(candidate);
      } catch {
        throw new Error('APPSTATE_PATH could not be safely canonicalized');
      }
      const target = path.isAbsolute(linkTarget)
        ? path.resolve(linkTarget)
        : path.resolve(resolved, linkTarget);
      const targetRoot = path.parse(target).root;
      const targetParts = target.slice(targetRoot.length).split(path.sep).filter(Boolean);
      resolved = targetRoot;
      pending.unshift(...targetParts);
      continue;
    }

    if (pending.length > 0 && !stat.isDirectory()) {
      throw new Error('APPSTATE_PATH has a non-directory path component');
    }
    resolved = candidate;
  }

  return resolved;
}

function isPathWithin(target, directory) {
  const relative = path.relative(directory, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isProductionRuntime(env = process.env) {
  const railwayKeys = ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID'];
  const isExplicitlyLocal = ['development', 'test'].includes(env.NODE_ENV);
  const hasRailwayIdentity = railwayKeys.some(key =>
    typeof env[key] === 'string' && env[key].trim() !== '',
  );
  return hasRailwayIdentity || !isExplicitlyLocal;
}

function isAppstateArray(value) {
  return Array.isArray(value) && value.length > 0 &&
    !value.some(item => item === null || typeof item !== 'object' || Array.isArray(item));
}

function fingerprintAppstateSeed(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function parseAppstateJson(raw, settingName = 'APPSTATE_JSON') {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${settingName} must contain a non-empty JSON session array`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${settingName} must contain valid JSON`);
  }

  if (!isAppstateArray(parsed)) {
    throw new Error(`${settingName} must be a non-empty array of session objects`);
  }
  return parsed;
}

function resolveAppstatePath(env = process.env) {
  if (isProductionRuntime(env)) {
    throw new Error('APPSTATE_PATH is supported only as a local development fallback');
  }

  const configured = env.APPSTATE_PATH;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new Error('Set APPSTATE_PATH to use the local development file fallback');
  }
  const target = canonicalizePathAllowMissing(
    configured,
  );
  let repositoryRoot;
  try {
    repositoryRoot = fs.realpathSync.native(path.resolve(__dirname, '..'));
  } catch {
    throw new Error('Source repository path could not be safely canonicalized');
  }

  if (isPathWithin(target, repositoryRoot)) {
    throw new Error('APPSTATE_PATH must be outside the source repository');
  }
  return target;
}

function loadAppstate(env = process.env, options = {}) {
  if (isProductionRuntime(env)) {
    if (!Object.prototype.hasOwnProperty.call(env, 'APPSTATE_JSON')) {
      throw new Error('APPSTATE_JSON is required in Railway/production; configure it and redeploy');
    }

    const seed = env.APPSTATE_JSON;
    const appstate = parseAppstateJson(seed);
    const seedFingerprint = fingerprintAppstateSeed(seed);
    const cachePath = (options && options.cachePath) || getAppstateCachePath();
    const cached = readPrivateAppstateCache(cachePath);
    if (cached && cached.seedFingerprint === seedFingerprint) {
      return { appstate: cached.appstate, source: 'cache' };
    }

    try {
      writePrivateAppstateCache(appstate, cachePath, seedFingerprint);
    } catch {
      // The environment remains usable if this ephemeral cache is unavailable.
    }
    return { appstate, source: 'environment' };
  }

  if (Object.prototype.hasOwnProperty.call(env, 'APPSTATE_JSON')) {
    return { appstate: parseAppstateJson(env.APPSTATE_JSON), source: 'environment' };
  }

  const filePath = resolveAppstatePath(env);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error('The local APPSTATE_PATH file could not be read');
  }
  return { appstate: parseAppstateJson(raw, 'APPSTATE_PATH'), source: 'file' };
}

function canWriteAppstate(env = process.env) {
  return !isProductionRuntime(env) &&
    !Object.prototype.hasOwnProperty.call(env, 'APPSTATE_JSON') &&
    typeof env.APPSTATE_PATH === 'string' && env.APPSTATE_PATH.trim() !== '';
}

function canPersistAppstate(env = process.env) {
  return isProductionRuntime(env) || canWriteAppstate(env);
}

function appstateUpdateConflictMessage(env = process.env) {
  if (isProductionRuntime(env)) {
    return 'Session updates are disabled in Railway/production. Change the APPSTATE_JSON Railway variable and redeploy.';
  }
  if (Object.prototype.hasOwnProperty.call(env, 'APPSTATE_JSON')) {
    return 'APPSTATE_JSON cannot be updated at runtime. Change the environment variable and restart the local process.';
  }
  return 'Session updates require APPSTATE_PATH in local development; configure it before retrying.';
}

function writeJsonAtomicPrivate(filePath, value) {
  const requestedTarget = path.resolve(filePath);
  const directory = canonicalizePathAllowMissing(path.dirname(requestedTarget));
  const target = path.join(directory, path.basename(requestedTarget));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  // Keep staging private without changing permissions on a shared mount root.
  const privateDirectory = path.join(directory, '.alth-private');
  try {
    fs.mkdirSync(privateDirectory, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const privateDirectoryStat = fs.lstatSync(privateDirectory);
  if (!privateDirectoryStat.isDirectory() || privateDirectoryStat.isSymbolicLink()) {
    throw new Error('Private JSON staging path must be a real directory');
  }
  fs.chmodSync(privateDirectory, 0o700);
  const canonicalDirectory = fs.realpathSync.native(directory);
  const canonicalPrivateDirectory = fs.realpathSync.native(privateDirectory);
  if (path.dirname(canonicalPrivateDirectory) !== canonicalDirectory) {
    throw new Error('Private JSON staging directory is outside the target directory');
  }

  const temporary = path.join(privateDirectory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let descriptor;

  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function writeAppstate(value) {
  if (!canWriteAppstate()) {
    throw new Error(appstateUpdateConflictMessage());
  }
  if (!Array.isArray(value) || value.length === 0 ||
      value.some(item => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Appstate must be a non-empty array of session objects');
  }
  writeJsonAtomicPrivate(resolveAppstatePath(), value);
}

function getAppstateCachePath() {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const directory = path.join(temporaryRoot, 'alth-appstate-cache');
  const repositoryRoot = fs.realpathSync.native(path.resolve(__dirname, '..'));
  if (isPathWithin(directory, repositoryRoot) || isPathWithin(repositoryRoot, directory)) {
    throw new Error('Appstate cache must remain outside the source repository');
  }
  return path.join(directory, 'appstate.json');
}

function resolvePrivateAppstateCachePath(filePath) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const canonicalDirectory = canonicalizePathAllowMissing(directory);
  const repositoryRoot = fs.realpathSync.native(path.resolve(__dirname, '..'));
  if (canonicalDirectory !== directory ||
      isPathWithin(target, repositoryRoot) || isPathWithin(repositoryRoot, target)) {
    throw new Error('Appstate cache path is not private and external to the source repository');
  }
  return target;
}

function readPrivateAppstateCache(filePath) {
  try {
    const target = resolvePrivateAppstateCachePath(filePath);
    const directory = path.dirname(target);
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        (directoryStat.mode & 0o777) !== 0o700 ||
        fs.realpathSync.native(directory) !== directory) {
      return null;
    }

    const fileStat = fs.lstatSync(target);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() ||
        (fileStat.mode & 0o777) !== 0o600) {
      return null;
    }

    const cached = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!cached || typeof cached !== 'object' || Array.isArray(cached) ||
        cached.version !== 1 ||
        typeof cached.seedFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(cached.seedFingerprint) ||
        !isAppstateArray(cached.appstate)) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

function writePrivateAppstateCache(value, filePath, seedFingerprint) {
  if (!isAppstateArray(value)) {
    throw new Error('Appstate must be a non-empty array of session objects');
  }
  if (typeof seedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(seedFingerprint)) {
    throw new Error('Appstate cache seed fingerprint is invalid');
  }

  const target = resolvePrivateAppstateCachePath(filePath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Appstate cache directory must be a real directory');
  }
  fs.chmodSync(directory, 0o700);
  if (fs.realpathSync.native(directory) !== directory) {
    throw new Error('Appstate cache directory must not contain symbolic links');
  }

  writeJsonAtomicPrivate(target, {
    version: 1,
    seedFingerprint,
    appstate: value,
  });
}

function persistAppstate(value, env = process.env, options = {}) {
  if (isProductionRuntime(env)) {
    if (!Object.prototype.hasOwnProperty.call(env, 'APPSTATE_JSON')) {
      throw new Error('APPSTATE_JSON is required in Railway/production; configure it and redeploy');
    }
    const seed = env.APPSTATE_JSON;
    parseAppstateJson(seed);
    const seedFingerprint = fingerprintAppstateSeed(seed);
    const cachePath = (options && options.cachePath) || getAppstateCachePath();
    writePrivateAppstateCache(value, cachePath, seedFingerprint);
    return true;
  }

  if (!canWriteAppstate(env)) return false;
  if (env === process.env) {
    writeAppstate(value);
    return true;
  }

  if (!Array.isArray(value) || value.length === 0 ||
      value.some(item => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Appstate must be a non-empty array of session objects');
  }
  writeJsonAtomicPrivate(resolveAppstatePath(env), value);
  return true;
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  authIsConfigured,
  passwordMatches,
  createSessionToken,
  verifySessionToken,
  getCookieToken,
  hasValidSessionCookie,
  createSessionCookieHeader,
  clearSessionCookieHeader,
  getDashboardOrigin,
  isAllowedOrigin,
  createLoginRateLimiter,
  isProductionRuntime,
  parseAppstateJson,
  loadAppstate,
  canWriteAppstate,
  canPersistAppstate,
  appstateUpdateConflictMessage,
  resolveAppstatePath,
  writeJsonAtomicPrivate,
  writeAppstate,
  persistAppstate,
};
