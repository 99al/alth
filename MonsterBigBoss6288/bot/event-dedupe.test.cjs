'use strict';

const assert = require('node:assert/strict');
const { createEventDeduper } = require('./event-dedupe.cjs');

let now = 1000;
const isDuplicate = createEventDeduper({ ttlMs: 100, maxEntries: 2, now: () => now });
assert.equal(isDuplicate({ messageID: 'm1', body: 'hello' }), false);
assert.equal(isDuplicate({ messageID: 'm1', body: 'hello' }), true, 're-delivery of an ID is suppressed');
assert.equal(isDuplicate({ messageID: 'm2', body: 'hello' }), false, 'same body with a distinct ID is kept');
assert.equal(isDuplicate({ messageID: 'm3', body: 'hello' }), false, 'distinct messages are kept');
assert.equal(isDuplicate({ messageID: 'm1', body: 'hello' }), false, 'evicted IDs are not retained indefinitely');
assert.equal(isDuplicate({ body: 'hello' }), false, 'events without an ID are not suppressed');
now += 101;
assert.equal(isDuplicate({ messageID: 'm3', body: 'hello' }), false, 'expired IDs can be processed again');
assert.equal(isDuplicate({ messageId: 'alt-id' }), false, 'alternate messageId spelling is recognized');
assert.equal(isDuplicate({ messageId: 'alt-id' }), true);
console.log('event-dedupe tests passed');
