'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const security = require('./security.cjs');

function withTestConfig(run) {
  const before = {
    password: process.env.DASHBOARD_PASSWORD,
    secret: process.env.DASHBOARD_SESSION_SECRET,
    origin: process.env.DASHBOARD_ORIGIN,
    nodeEnv: process.env.NODE_ENV,
    appstateJson: process.env.APPSTATE_JSON,
    appstatePath: process.env.APPSTATE_PATH,
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT,
    railwayProjectId: process.env.RAILWAY_PROJECT_ID,
    railwayServiceId: process.env.RAILWAY_SERVICE_ID,
  };
  process.env.DASHBOARD_PASSWORD = crypto.randomBytes(24).toString('base64url');
  process.env.DASHBOARD_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  process.env.DASHBOARD_ORIGIN = 'https://dashboard.example.test';
  process.env.NODE_ENV = 'test';
  delete process.env.APPSTATE_JSON;
  delete process.env.APPSTATE_PATH;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.RAILWAY_SERVICE_ID;
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries({
      DASHBOARD_PASSWORD: before.password,
      DASHBOARD_SESSION_SECRET: before.secret,
      DASHBOARD_ORIGIN: before.origin,
      NODE_ENV: before.nodeEnv,
      APPSTATE_JSON: before.appstateJson,
      APPSTATE_PATH: before.appstatePath,
      RAILWAY_ENVIRONMENT: before.railwayEnvironment,
      RAILWAY_PROJECT_ID: before.railwayProjectId,
      RAILWAY_SERVICE_ID: before.railwayServiceId,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('configuration fails closed when required secrets are absent or too short', () => {
  withTestConfig(() => {
    delete process.env.DASHBOARD_PASSWORD;
    assert.equal(security.authIsConfigured(), false);
    process.env.DASHBOARD_PASSWORD = crypto.randomBytes(24).toString('base64url');
    process.env.DASHBOARD_SESSION_SECRET = 'short';
    assert.equal(security.authIsConfigured(), false);
  });
});

test('password comparison accepts only the configured password', () => {
  withTestConfig(() => {
    const expected = process.env.DASHBOARD_PASSWORD;
    assert.equal(security.passwordMatches(expected), true);
    assert.equal(security.passwordMatches(`${expected}x`), false);
    assert.equal(security.passwordMatches(null), false);
  });
});

test('signed cookie verifies, rejects tampering, and expires after its fixed lifetime', () => {
  withTestConfig(() => {
    const now = 1_800_000_000;
    const token = security.createSessionToken(now);
    assert.equal(security.verifySessionToken(token, now + 1), true);
    assert.equal(security.verifySessionToken(`${token}x`, now + 1), false);
    assert.equal(security.verifySessionToken(token, now + security.SESSION_TTL_SECONDS), false);
    assert.equal(security.hasValidSessionCookie(`other=value; __Host-alth_admin_session=${token}`, now + 1), true);
    const cookie = security.createSessionCookieHeader();
    assert.match(cookie, /^__Host-alth_admin_session=/);
    assert.match(cookie, /; HttpOnly; Secure; SameSite=Strict$/);
    assert.match(cookie, /; Path=\//);
  });
});

test('origin validation permits only the configured dashboard origin in production', () => {
  withTestConfig(() => {
    process.env.NODE_ENV = 'production';
    assert.equal(security.isAllowedOrigin('https://dashboard.example.test'), true);
    assert.equal(security.isAllowedOrigin('https://attacker.example'), false);
    assert.equal(security.isAllowedOrigin('null'), false);
    assert.equal(security.isAllowedOrigin(undefined), false);
  });
});

test('APPSTATE_JSON parses only a non-empty array of session objects without echoing malformed input', () => {
  const fixture = [{ name: 'synthetic-cookie', value: 'synthetic-only' }];
  assert.deepEqual(security.parseAppstateJson(JSON.stringify(fixture)), fixture);
  for (const raw of ['', '   ', '{"private-marker":"must-not-leak"}', 'not-json', '[]', '[null]', '[1]']) {
    assert.throws(() => security.parseAppstateJson(raw), error => {
      assert.match(error.message, /APPSTATE_JSON/);
      assert.equal(error.message.includes('private-marker'), false);
      assert.equal(error.message.includes('must-not-leak'), false);
      return true;
    });
  }
});

test('Railway/production uses APPSTATE_JSON ahead of APPSTATE_PATH and requires the secret', () => {
  const fixture = [{ name: 'synthetic-cookie', value: 'synthetic-only' }];
  const env = {
    NODE_ENV: 'production',
    APPSTATE_JSON: JSON.stringify(fixture),
    APPSTATE_PATH: '/tmp/should-not-be-read.json',
  };
  assert.equal(security.isProductionRuntime(env), true);
  assert.deepEqual(security.loadAppstate(env), { appstate: fixture, source: 'environment' });
  assert.throws(() => security.loadAppstate({ NODE_ENV: 'production', APPSTATE_PATH: '/tmp/not-read.json' }), /APPSTATE_JSON is required/);
  assert.equal(security.isProductionRuntime({ NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'staging' }), true);
  assert.equal(security.isProductionRuntime({ NODE_ENV: 'staging' }), true);
  assert.equal(security.isProductionRuntime({}), true);
});

test('local APPSTATE_PATH is a development-only file fallback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-local-appstate-test-'));
  const stateFile = path.join(directory, 'synthetic-state.json');
  const fixture = [{ name: 'synthetic-cookie', value: 'synthetic-only' }];
  try {
    fs.writeFileSync(stateFile, JSON.stringify(fixture), { mode: 0o600 });
    assert.deepEqual(security.loadAppstate({ NODE_ENV: 'development', APPSTATE_PATH: stateFile }), {
      appstate: fixture,
      source: 'file',
    });
    assert.throws(() => security.resolveAppstatePath({ NODE_ENV: 'production', APPSTATE_PATH: stateFile }), /local development fallback/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('production appstate updates conflict before any filesystem write', () => {
  withTestConfig(() => {
    process.env.NODE_ENV = 'production';
    process.env.RAILWAY_ENVIRONMENT = 'production';
    process.env.APPSTATE_JSON = JSON.stringify([{ name: 'synthetic-cookie', value: 'synthetic-only' }]);
    process.env.APPSTATE_PATH = '/tmp/production-session-must-not-be-written.json';

    const methods = ['mkdirSync', 'chmodSync', 'lstatSync', 'realpathSync', 'openSync', 'writeFileSync', 'fchmodSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync'];
    const originals = new Map(methods.map(name => [name, fs[name]]));
    let fileOperationCount = 0;
    try {
      for (const name of methods) {
        fs[name] = () => {
          fileOperationCount += 1;
          throw new Error('unexpected filesystem operation');
        };
      }
      assert.equal(security.canWriteAppstate(), false);
      assert.throws(() => security.writeAppstate([{ name: 'synthetic-cookie', value: 'new-synthetic-only' }]), /disabled in Railway\/production/);
      assert.equal(fileOperationCount, 0);
    } finally {
      for (const [name, original] of originals) fs[name] = original;
    }
  });
});

test('login limiter caps attempts process-wide across a rolling window', () => {
  const limiter = security.createLoginRateLimiter({
    windowMs: 1000,
    globalMaxAttempts: 3,
  });
  assert.equal(limiter.attempt(0).allowed, true);
  assert.equal(limiter.attempt(100).allowed, true);
  assert.equal(limiter.attempt(200).allowed, true);
  const blocked = limiter.attempt(300);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.attempt(1000).allowed, true);
  assert.equal(limiter.attempt(1100).allowed, true);
  assert.equal(limiter.attempt(1101).allowed, false);
});

test('login limiter TypeScript declaration mirrors the callable runtime shape', () => {
  const controlAuth = fs.readFileSync(
    path.join(__dirname, '../artifacts/api-server/src/lib/control-auth.ts'),
    'utf8',
  );
  const declaration = controlAuth.match(/interface LoginRateLimiter\s*\{([\s\S]*?)\n\}/);
  assert.ok(declaration, 'LoginRateLimiter interface exists');
  assert.equal(
    declaration[1].replace(/\s+/g, ' ').trim(),
    'attempt(now?: number): { allowed: boolean; retryAfterSeconds: number };',
  );

  const limiter = security.createLoginRateLimiter();
  assert.deepEqual(Object.keys(limiter), ['attempt']);
  assert.equal(limiter.attempt().allowed, true);
  assert.equal(Object.hasOwn(limiter, 'reset'), false);
});

test('unhandled rejection logging never formats or emits the rejection reason', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const handlerMatch = indexSource.match(
    /process\.on\('unhandledRejection',[\s\S]*?\n\}\);/,
  );
  assert.ok(handlerMatch, 'unhandled rejection handler exists');
  const handler = handlerMatch[0];
  assert.match(handler, /process\.on\('unhandledRejection',\s*\(\)\s*=>\s*\{/);
  assert.match(handler, /console\.error\(\s*'[^'\n]*'\s*\)/);
  assert.doesNotMatch(handler, /\breason\b|\.message\b|\.stack\b|JSON\.stringify|String\s*\(/);
  assert.doesNotMatch(indexSource, /JSON\.stringify\(err\)|\$\{body\}|\$\{ctx\.lastSeqId\}/);

  const errorLogCalls = indexSource.matchAll(/console\.(?:error|warn)\([\s\S]*?\);/g);
  for (const call of errorLogCalls) {
    assert.match(
      call[0],
      /^console\.(?:error|warn)\(\s*'[^'\n]*'\s*\);$/,
      'error and warning logs contain only a fixed string, not an error object',
    );
  }
});

test('login limiter stays bounded by its cap and does not expire attempts after clock rollback', () => {
  const limiter = security.createLoginRateLimiter({
    windowMs: 1000,
    globalMaxAttempts: 2,
  });
  assert.equal(limiter.attempt(500).allowed, true);
  assert.equal(limiter.attempt(600).allowed, true);
  assert.equal(limiter.attempt(100).allowed, false);
  assert.equal(limiter.attempt(1500).allowed, true);
});

test('local state path requires APPSTATE_PATH and remains outside the repository', () => {
  withTestConfig(() => {
    delete process.env.APPSTATE_PATH;
    assert.throws(() => security.resolveAppstatePath(), /Set APPSTATE_PATH/);
    process.env.APPSTATE_PATH = '/data/alth/appstate.json';
    assert.equal(security.resolveAppstatePath(), '/data/alth/appstate.json');
    process.env.APPSTATE_PATH = path.join(__dirname, 'project-local-state.json');
    assert.throws(() => security.resolveAppstatePath(), /outside the source repository/);
  });
});

test('private state path rejects a non-existent leaf reached through a symlink into the source tree', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-state-symlink-test-'));
  const originalAppstatePath = process.env.APPSTATE_PATH;
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  const sourceAlias = path.join(directory, 'source-alias');

  try {
    fs.symlinkSync(repositoryRoot, sourceAlias, 'dir');
    process.env.APPSTATE_PATH = path.join(sourceAlias, 'bot', 'non-existent-state.json');
    assert.throws(() => security.resolveAppstatePath(), /outside the source repository/);
  } finally {
    if (originalAppstatePath === undefined) delete process.env.APPSTATE_PATH;
    else process.env.APPSTATE_PATH = originalAppstatePath;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic JSON writer preserves an existing shared mount-root mode and creates a 0600 file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alth-state-test-'));
  const target = path.join(directory, 'synthetic-state.json');
  const fixture = [{ marker: 'synthetic-only' }];
  try {
    fs.chmodSync(directory, 0o755);
    security.writeJsonAtomicPrivate(target, fixture);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), fixture);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(directory, '.alth-private')).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('admin configuration fails closed for missing or invalid files and accepts only numeric string IDs', () => {
  const main = require('./main.js');
  const directory = fs.mkdtempSync(path.join(__dirname, '.admins-test-'));
  const configPath = path.join(directory, 'admins-config.json');
  const syntheticAdminId = '123456789012345';

  try {
    assert.equal(main.loadAdmins(configPath).size, 0);

    fs.writeFileSync(configPath, JSON.stringify({ admins: [syntheticAdminId] }));
    assert.equal(main.loadAdmins(configPath).has(syntheticAdminId), true);

    const invalidConfigs = [
      'not-json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ admins: null }),
      JSON.stringify({ admins: [123456789012345] }),
      JSON.stringify({ admins: [''] }),
      JSON.stringify({ admins: ['0'] }),
      JSON.stringify({ admins: ['0123456789'] }),
      JSON.stringify({ admins: ['not-an-id'] }),
      JSON.stringify({ admins: [syntheticAdminId, null] }),
    ];

    for (const raw of invalidConfigs) {
      fs.writeFileSync(configPath, raw);
      assert.equal(main.loadAdmins(configPath).size, 0);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('main.js logs only fixed string messages and contains no hard-coded admin ID fallback', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const logCallCount = [...mainSource.matchAll(/console\.(?:log|warn|error)\(/g)].length;
  const fixedLogCallCount = [...mainSource.matchAll(/console\.(?:log|warn|error)\(\s*'[^'\n]*'\s*\)/g)].length;

  assert.ok(logCallCount > 0);
  assert.equal(fixedLogCallCount, logCallCount);

  assert.doesNotMatch(mainSource, /\b(?:e|err|error)\.(?:message|stack)\b/);
  assert.doesNotMatch(mainSource, /['"`]\d{10,}['"`]/);
});
