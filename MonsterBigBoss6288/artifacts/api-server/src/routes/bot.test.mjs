import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [botRouteSource, appSource, indexSource, mainSource] = await Promise.all([
  readFile(new URL("./bot.ts", import.meta.url), "utf8"),
  readFile(new URL("../app.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../../bot/index.js", import.meta.url), "utf8"),
  readFile(new URL("../../../../bot/main.js", import.meta.url), "utf8"),
]);

test("active message event logs are fixed strings without message or participant identifiers", () => {
  const callbackStart = indexSource.indexOf("const callback =");
  const callbackEnd = indexSource.indexOf("msgEmitter =", callbackStart);
  assert.notEqual(callbackStart, -1, "message callback exists");
  assert.notEqual(callbackEnd, -1, "message callback end exists");
  const callback = indexSource.slice(callbackStart, callbackEnd);

  assert.match(callback, /console\.log\(\s*'\[الث\] 📩 حدث وارد'\s*\)/);
  assert.doesNotMatch(callback, /threadID|senderID|event\.body/);
  assert.doesNotMatch(callback, /console\.log\(\s*`[^`]*\$\{/);
});

test("test-send and session failures never return exception details or thread identifiers", () => {
  const testSend = indexSource.match(/app\.get\('\/testsend'[\s\S]*?\n\}\);/);
  assert.ok(testSend, "test-send route exists");
  assert.match(testSend[0], /res\.json\(\{\s*success:\s*true\s*\}\)/);
  assert.doesNotMatch(testSend[0], /res\.json\(\s*\{[^}]*\bthreadID\b/);
  assert.match(testSend[0], /error:\s*'تعذر إرسال رسالة الاختبار\.'/);
  assert.doesNotMatch(testSend[0], /\.message\b|\.stack\b/);

  const updateCookies = indexSource.match(/app\.post\('\/updatecookies'[\s\S]*?\n\}\);/);
  assert.ok(updateCookies, "session-update route exists");
  assert.match(updateCookies[0], /error:\s*'تعذر تحديث جلسة البوت\.'/);
  assert.doesNotMatch(updateCookies[0], /\.message\b|\.stack\b/);
});

test("HTTP request logs expose only the method and status, never request paths", () => {
  const requestSerializer = appSource.match(/req\(req\)\s*\{\s*return\s*\{([\s\S]*?)\};/);
  const responseSerializer = appSource.match(/res\(res\)\s*\{\s*return\s*\{([\s\S]*?)\};/);
  assert.ok(requestSerializer, "request serializer exists");
  assert.ok(responseSerializer, "response serializer exists");
  assert.equal(requestSerializer[1].replace(/\s+/g, " ").trim(), "method: req.method,");
  assert.equal(responseSerializer[1].replace(/\s+/g, " ").trim(), "statusCode: res.statusCode,");
  assert.doesNotMatch(appSource, /\breq\.(?:url|originalUrl)\b|(?:url|originalUrl)\s*:\s*req\./);
});

test("global API errors log sanitized method/status and return a generic response", () => {
  assert.match(
    appSource,
    /logger\.error\(\s*\{\s*method:\s*req\.method,\s*status:\s*500\s*\},\s*"Request failed"\s*\)/,
  );
  assert.match(appSource, /res\.status\(500\)\.json\(\{ error: "خطأ داخلي في الخادم" \}\)/);
  assert.doesNotMatch(appSource, /logger\.(?:error|warn)\(\s*\{\s*err\b|(?:err|_err)\.(?:message|stack)\b/);
});

test("session and admin route errors/logs do not expose exceptions or admin IDs", () => {
  assert.doesNotMatch(botRouteSource, /parsed\.error\.message|(?:err|fetchErr)\.(?:message|stack)\b/);
  assert.doesNotMatch(botRouteSource, /logger\.(?:info|warn|error)\(\s*\{[^}]*\b(?:id|err|fetchErr)\b/);
  assert.doesNotMatch(botRouteSource, /res\.status\(\d+\)\.json\(\{\s*error:\s*`[^`]*\$\{id\}/);
  assert.doesNotMatch(botRouteSource, /logger\.(?:error|warn)\(\s*\{\s*(?:err|fetchErr)\b/);
});

test("main bot and API accept the same positive numeric admin ID format without leading zeros", () => {
  const pattern = "/^[1-9]\\d*$/";
  assert.ok(mainSource.includes(pattern), "main.js validates a positive numeric string");
  assert.ok(botRouteSource.includes(pattern), "API route uses the same validation pattern");

  const isValidAdminId = new RegExp("^[1-9]\\d*$");
  assert.equal(isValidAdminId.test("123456789"), true);
  for (const invalid of ["", "0", "0001", "01", "+1", " 1", "1 ", "abc"]) {
    assert.equal(isValidAdminId.test(invalid), false, `reject ${JSON.stringify(invalid)}`);
  }
});
