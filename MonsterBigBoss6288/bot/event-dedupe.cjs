'use strict';

// Suppress repeated deliveries of the same Messenger message, not repeated text.
function createEventDeduper({ ttlMs = 2 * 60 * 1000, maxEntries = 10000, now = Date.now } = {}) {
  const seen = new Map();

  return function isDuplicate(event) {
    const rawId = event && (event.messageID || event.messageId);
    if (rawId === undefined || rawId === null || String(rawId).trim() === '') return false;

    const id = String(rawId);
    const timestamp = now();
    for (const [key, expiresAt] of seen) {
      if (expiresAt > timestamp) break;
      seen.delete(key);
    }

    const expiresAt = seen.get(id);
    if (expiresAt !== undefined && expiresAt > timestamp) return true;

    // Refresh insertion order and cap memory even during unusually high traffic.
    seen.delete(id);
    seen.set(id, timestamp + ttlMs);
    while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
    return false;
  };
}

module.exports = { createEventDeduper };
