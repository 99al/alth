'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const security = require('./security.cjs');

async function withTestConfig(run) {
  const names = [
    'DASHBOARD_PASSWORD',
    'DASHBOARD_SESSION_SECRET',
    'DASHBOARD_ORIGIN',
    'NODE_ENV',
    'APPSTATE_JSON',
    'APPSTATE_PATH',
    'RAILWAY_ENVIRONMENT',
    'RAILWAY_PROJECT_ID',
    'RAILWAY_SERVICE_ID',
  ];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.DASHBOARD_PASSWORD = crypto.randomBytes(24).toString('base64url');
  process.env.DASHBOARD_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  process.env.DASHBOARD_ORIGIN = 'https://dashboard.example.test';
  process.env.NODE_ENV = 'production';
  for (const name of ['APPSTATE_JSON', 'APPSTATE_PATH', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']) {
    delete process.env[name];
  }

  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function createExpressStub() {
  const routes = new Map();
  const errorHandlers = [];
  const app = {
    get(routePath, ...handlers) { routes.set(`GET ${routePath}`, handlers); },
    post(routePath, ...handlers) { routes.set(`POST ${routePath}`, handlers); },
    use(handler) {
      if (typeof handler === 'function' && handler.length === 4) errorHandlers.push(handler);
    },
  };
  const express = () => app;
  express.json = () => (_req, _res, next) => next();
  return { express, routes, errorHandlers };
}

function loadAppWithStubs() {
  const { express, routes, errorHandlers } = createExpressStub();
  const indexPath = path.join(__dirname, 'index.js');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'express') return express;
    if (request === 'ws3-fca') return { login() { throw new Error('test stub must not log in'); } };
    if (request === './main' && parent && parent.filename === indexPath) {
      return { loadCommands() {}, handleMessage() {}, handleEvent() {}, commands: new Map() };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { app } = require(indexPath);
    return { app, routes, errorHandlers };
  } finally {
    Module._load = originalLoad;
  }
}

async function dispatch(routes, method, routePath, options = {}) {
  const handlers = routes.get(`${method} ${routePath}`);
  assert.ok(handlers, 'registered route is available');
  const req = {
    headers: options.headers || {},
    body: options.body,
    query: options.query || {},
  };
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
    send(value) { this.body = value; this.headersSent = true; return this; },
  };

  async function invoke(index) {
    if (index >= handlers.length || res.headersSent) return;
    let nextPromise;
    const result = handlers[index](req, res, () => {
      nextPromise = invoke(index + 1);
    });
    await result;
    if (nextPromise) await nextPromise;
  }

  await invoke(0);
  return res;
}

test('admin page and auth routes preserve origin, cookie, rate-limit, and sanitization requirements', async () => {
  await withTestConfig(async () => {
    const { routes, errorHandlers } = loadAppWithStubs();
    const origin = process.env.DASHBOARD_ORIGIN;
    const password = process.env.DASHBOARD_PASSWORD;
    const marker = `not-a-real-password-${crypto.randomBytes(12).toString('hex')}`;

    const page = await dispatch(routes, 'GET', '/');
    assert.equal(page.statusCode, 200, 'direct page navigation succeeds without Origin');
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.ok(page.body.includes('<form id="login-form">'), 'unauthenticated page contains the static login form');
    assert.ok(page.body.includes('/api/auth/login'), 'login form uses the same-origin endpoint');

    const anonymousSession = await dispatch(routes, 'GET', '/api/auth/session');
    assert.deepEqual(anonymousSession.body, { authenticated: false });

    const badOrigin = await dispatch(routes, 'POST', '/api/auth/login', {
      headers: { origin: 'https://attacker.example' },
      body: { password },
    });
    assert.equal(badOrigin.statusCode, 403, 'login rejects an unapproved Origin');

    const missingOrigin = await dispatch(routes, 'POST', '/api/auth/login', {
      body: { password },
    });
    assert.equal(missingOrigin.statusCode, 403, 'login rejects a missing Origin');

    const originalLog = console.log;
    const originalError = console.error;
    const capturedLogs = [];
    console.log = (...args) => capturedLogs.push(args.join(' '));
    console.error = (...args) => capturedLogs.push(args.join(' '));
    let invalidLogin;
    try {
      invalidLogin = await dispatch(routes, 'POST', '/api/auth/login', {
        headers: { origin },
        body: { password: marker },
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.equal(invalidLogin.statusCode, 401, 'invalid credentials are rejected');
    assert.ok(!JSON.stringify(invalidLogin.body).includes(marker), 'invalid credentials are not echoed');
    assert.ok(capturedLogs.every(line => !line.includes(marker)), 'credential marker is absent from logs');

    const login = await dispatch(routes, 'POST', '/api/auth/login', {
      headers: { origin },
      body: { password },
    });
    assert.equal(login.statusCode, 200, 'valid credentials create a session');
    assert.deepEqual(login.body, { authenticated: true });
    const setCookie = login.headers['set-cookie'];
    assert.ok(typeof setCookie === 'string', 'login sets a session cookie');
    assert.ok(setCookie.startsWith(`${security.SESSION_COOKIE_NAME}=`), 'cookie uses the configured name');
    assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('Secure') && setCookie.includes('SameSite=Strict'), 'cookie has required security flags');
    assert.ok(setCookie.includes('Path=/'), 'cookie is scoped to the origin root');
    const cookiePair = setCookie.split(';', 1)[0];

    const authenticatedSession = await dispatch(routes, 'GET', '/api/auth/session', {
      headers: { cookie: cookiePair },
    });
    assert.deepEqual(authenticatedSession.body, { authenticated: true });

    const authenticatedPage = await dispatch(routes, 'GET', '/', {
      headers: { cookie: cookiePair },
    });
    assert.equal(authenticatedPage.statusCode, 200, 'authenticated page navigation needs no Origin header');
    assert.ok(authenticatedPage.body.includes('حالة البوت'), 'authenticated page shows minimal status');
    assert.ok(!authenticatedPage.body.includes('reconnectAttempts'), 'authenticated page omits internal counters');
    assert.ok(!authenticatedPage.body.includes('userID'), 'authenticated page omits account identifiers');

    const missingOriginSideEffect = await dispatch(routes, 'GET', '/testsend', {
      headers: { cookie: cookiePair },
      query: { thread: 'synthetic-test-id' },
    });
    assert.equal(missingOriginSideEffect.statusCode, 403, 'side-effect route requires the configured Origin');

    const publicPing = await dispatch(routes, 'GET', '/ping');
    assert.equal(publicPing.statusCode, 200, 'health route remains public');
    assert.ok(String(publicPing.body).includes('pong'), 'public health route responds');

    const deniedLogout = await dispatch(routes, 'POST', '/api/auth/logout');
    assert.equal(deniedLogout.statusCode, 403, 'logout rejects a missing Origin');

    const logout = await dispatch(routes, 'POST', '/api/auth/logout', { headers: { origin } });
    assert.equal(logout.statusCode, 200, 'logout succeeds for the configured Origin');
    assert.deepEqual(logout.body, { authenticated: false });
    const clearedCookie = logout.headers['set-cookie'];
    assert.ok(clearedCookie.startsWith(`${security.SESSION_COOKIE_NAME}=`), 'logout clears the configured cookie');
    assert.ok(clearedCookie.includes('Max-Age=0') && clearedCookie.includes('HttpOnly') && clearedCookie.includes('Secure') && clearedCookie.includes('SameSite=Strict'), 'logout uses a secure expiry cookie');
    assert.ok(!clearedCookie.includes(cookiePair.split('=', 2)[1]), 'logout response does not repeat the session value');

    assert.equal(errorHandlers.length, 1, 'a sanitized request-error handler is installed');
    const safeError = errorHandlers[0];
    const errorMarker = `private-error-${crypto.randomBytes(8).toString('hex')}`;
    const errorResponse = {
      headers: {}, headersSent: false, statusCode: 200, body: undefined,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; this.headersSent = true; },
    };
    safeError(new Error(errorMarker), {}, errorResponse, () => {});
    assert.equal(errorResponse.statusCode, 400, 'request errors use a fixed status');
    assert.ok(!JSON.stringify(errorResponse.body).includes(errorMarker), 'raw errors are not returned');
    let rawErrorForwarded = false;
    safeError(new Error(errorMarker), {}, { headersSent: true }, () => { rawErrorForwarded = true; });
    assert.equal(rawErrorForwarded, false, 'raw errors are not forwarded to the default handler');

    for (let index = 0; index < 18; index += 1) {
      const attempt = await dispatch(routes, 'POST', '/api/auth/login', {
        headers: { origin },
        body: { password: marker },
      });
      assert.equal(attempt.statusCode, 401, 'the remaining valid-origin login attempts are allowed after rejected Origins and logout');
    }

    const overLimit = await dispatch(routes, 'POST', '/api/auth/login', {
      headers: { origin },
      body: { password: marker },
    });
    assert.equal(overLimit.statusCode, 429, 'the 21st valid-origin login attempt is rate limited');
    assert.ok(Number(overLimit.headers['retry-after']) > 0, 'rate limit includes a retry delay');
    assert.ok(!JSON.stringify(overLimit.body).includes(marker), 'rate-limit response is sanitized');
  });
});
