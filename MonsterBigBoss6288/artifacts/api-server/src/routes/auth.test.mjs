import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const security = require("../../../../bot/security.cjs");
const [authRouteSource, appSource, controlAuthSource] = await Promise.all([
  readFile(new URL("./auth.ts", import.meta.url), "utf8"),
  readFile(new URL("../app.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/control-auth.ts", import.meta.url), "utf8"),
]);

function withEnvironment(overrides, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("production login has no release gate when TRUST_PROXY_HOPS is missing", () => {
  withEnvironment({
    NODE_ENV: "production",
    TRUST_PROXY_HOPS: undefined,
    DASHBOARD_PASSWORD: "synthetic-password-for-tests",
    DASHBOARD_SESSION_SECRET: "synthetic-session-secret-value-long-enough-for-tests",
    DASHBOARD_ORIGIN: "https://dashboard.example.test",
  }, () => {
    assert.equal(security.authIsConfigured(), true);
    assert.equal(security.createLoginRateLimiter().attempt(1_000).allowed, true);
    assert.doesNotMatch(authRouteSource, /TRUST_PROXY_HOPS|trustProxyHops|isLoginRateLimitTopologySafe/);
    assert.doesNotMatch(controlAuthSource, /TRUST_PROXY_HOPS|trustProxyHops|parseTrustProxyHops/);
    assert.equal((authRouteSource.match(/res\.status\(503\)/g) ?? []).length, 1,
      "the only login 503 is for missing auth configuration");
  });
});

test("production login permits at most 20 attempts in any rolling 15-minute process window", () => {
  const limiter = security.createLoginRateLimiter({
    windowMs: 15 * 60 * 1000,
    globalMaxAttempts: 20,
  });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(limiter.attempt(1_000 + index * 100).allowed, true, `attempt ${index + 1}`);
  }
  const blocked = limiter.attempt(3_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 898);
  assert.equal(limiter.attempt(900_999).allowed, false);
  assert.equal(limiter.attempt(901_000).allowed, true, "the first attempt expires at 15 minutes");
});

test("forwarded IP headers cannot create limiter buckets or bypass the process-wide cap", () => {
  assert.match(authRouteSource, /const limit = loginLimiter\.attempt\(\);/);
  assert.doesNotMatch(authRouteSource, /req\.ip|req\.socket\.remoteAddress|x-forwarded-for/i);
  assert.match(appSource, /app\.set\("trust proxy", false\);/);

  const limiter = security.createLoginRateLimiter({ windowMs: 900_000, globalMaxAttempts: 20 });
  for (const forgedAddress of ["198.51.100.1", "203.0.113.200", "unknown"]) {
    assert.throws(() => limiter.attempt(forgedAddress), /Rate limiter time must be a non-negative integer/,
      "an IP string is not a limiter key or accepted argument");
  }
  for (let index = 0; index < 20; index += 1) {
    // The route deliberately passes no request or forwarded-header value to attempt().
    assert.equal(limiter.attempt(10_000 + index).allowed, true);
  }
  assert.equal(limiter.attempt(10_020).allowed, false);
});

test("HTTPS session cookies remain explicitly Secure while proxy trust is disabled", () => {
  withEnvironment({
    DASHBOARD_PASSWORD: "synthetic-password-for-tests",
    DASHBOARD_SESSION_SECRET: "synthetic-session-secret-value-long-enough-for-tests",
    DASHBOARD_ORIGIN: "https://dashboard.example.test",
  }, () => {
    const cookie = security.createSessionCookieHeader();
    assert.match(cookie, /; HttpOnly; Secure; SameSite=Strict$/);
    assert.match(cookie, /; Path=\//);
    assert.match(appSource, /app\.set\("trust proxy", false\);/);
  });
});
