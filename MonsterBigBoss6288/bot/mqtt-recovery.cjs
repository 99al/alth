'use strict';

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_RECOVERY_COOLDOWN_MS = 60_000;

function errorSignalText(error) {
  const parts = [];
  const seen = new Set();

  function collect(value, depth) {
    if (value == null || depth > 2) return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    for (const key of ['message', 'error', 'code', 'errno', 'cause', 'reason']) {
      try {
        collect(value[key], depth + 1);
      } catch {}
    }
  }

  collect(error, 0);
  return parts.join(' ');
}

function classifyMqttTransportFailure(error) {
  const signal = errorSignalText(error);
  if (/(?:connection\s+refused|econnrefused)/i.test(signal)) {
    return 'connection_refused';
  }
  if (/(?:timeout waiting for ack|messenger send timed out|econnreset|econnaborted|etimedout|ehostunreach|enetunreach|socket hang up|websocket (?:is )?(?:closed|not open)|not connected|mqtt client is not initialized|connection (?:closed|reset|lost|unavailable)|connect(?:ion)? timed? out)/i.test(signal)) {
    return 'connection_unavailable';
  }
  return null;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createMqttSendRecovery(options = {}) {
  const threshold = positiveInteger(options.threshold, DEFAULT_FAILURE_THRESHOLD);
  const windowMs = positiveInteger(options.windowMs, DEFAULT_FAILURE_WINDOW_MS);
  const cooldownMs = positiveInteger(options.cooldownMs, DEFAULT_RECOVERY_COOLDOWN_MS);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onRecovery = typeof options.onRecovery === 'function' ? options.onRecovery : () => {};
  let failures = [];
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  let recoveryInFlight = false;

  function recordFailure(error) {
    const category = classifyMqttTransportFailure(error);
    if (!category) {
      failures = [];
      return { category: null, count: 0, triggered: false };
    }

    const currentTime = Number(now());
    failures = failures.filter(timestamp => currentTime >= timestamp && currentTime - timestamp <= windowMs);
    failures.push(currentTime);
    const failureCount = failures.length;

    if (failureCount < threshold || recoveryInFlight) {
      return { category, count: failureCount, triggered: false };
    }

    if (currentTime - lastRecoveryAt < cooldownMs) {
      failures = [];
      return { category, count: failureCount, triggered: false };
    }

    failures = [];
    lastRecoveryAt = currentTime;
    recoveryInFlight = true;

    let recoveryResult;
    try {
      recoveryResult = onRecovery({ category, failureCount });
    } catch (errorDuringRecovery) {
      recoveryResult = Promise.reject(errorDuringRecovery);
    }

    const completion = Promise.resolve(recoveryResult)
      .catch(() => {})
      .finally(() => {
        recoveryInFlight = false;
      });

    return { category, count: failureCount, triggered: true, completion };
  }

  return {
    threshold,
    recordFailure,
    recordSuccess() {
      failures = [];
    }
  };
}

function stopMqttListener(listener) {
  if (!listener || typeof listener !== 'object') return Promise.resolve();

  if (typeof listener.stopListeningAsync === 'function') {
    try {
      return Promise.resolve(listener.stopListeningAsync());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  if (typeof listener.stopListening === 'function') {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      try {
        const result = listener.stopListening(() => finish());
        if (result && typeof result.then === 'function') {
          result.then(() => finish(), error => finish(error));
        }
      } catch (error) {
        finish(error);
      }
    });
  }

  return Promise.resolve();
}

module.exports = {
  classifyMqttTransportFailure,
  createMqttSendRecovery,
  stopMqttListener
};
