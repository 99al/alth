import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSameOriginApiFetch } from './same-origin-fetch.js';

test('forces same-origin credentials for same-origin API calls', async () => {
  const calls = [];
  const fetchStub = async (input, init) => {
    calls.push({ input, init });
    return { ok: true };
  };
  const wrapped = createSameOriginApiFetch(fetchStub, 'https://panel.example.test');

  await wrapped('/api/bot/status', { credentials: 'omit', headers: { Accept: 'application/json' } });
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json' });

  const request = new Request('https://panel.example.test/api/bot/admins', { credentials: 'omit' });
  await wrapped(request);
  assert.equal(calls[1].init.credentials, 'same-origin');
});

test('does not add cookies to other origins or non-API same-origin resources', async () => {
  const calls = [];
  const fetchStub = async (input, init) => {
    calls.push({ input, init });
    return { ok: true };
  };
  const wrapped = createSameOriginApiFetch(fetchStub, 'https://panel.example.test');
  const omit = { credentials: 'omit' };

  await wrapped('https://other.example.test/api/bot/status', omit);
  await wrapped('/assets/logo.svg', omit);
  assert.equal(calls[0].init, omit);
  assert.equal(calls[1].init, omit);
});
