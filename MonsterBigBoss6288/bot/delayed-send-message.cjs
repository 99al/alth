'use strict';

const delayedSendQueues = new Map();
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

function installDelayedSendMessage(api, options = {}) {
  if (!api || typeof api.sendMessage !== 'function') return false;
  if (api.sendMessage.__althDelayedSendMessage === true) return true;

  const sendTimeoutMs = Number.isFinite(options.sendTimeoutMs) && options.sendTimeoutMs > 0
    ? options.sendTimeoutMs
    : DEFAULT_SEND_TIMEOUT_MS;
  const typingDurationForText = typeof options.typingDurationForText === 'function'
    ? options.typingDurationForText
    : text => text.length > 50 ? 4500 : 3500;
  const postTypingDelayMs = Number.isFinite(options.postTypingDelayMs) && options.postTypingDelayMs >= 0
    ? options.postTypingDelayMs
    : 1000;
  const rawSendMessage = api.sendMessage.bind(api);

  const wrappedSendMessage = function (msg, threadID, callback, ...rest) {
    const text = typeof msg === 'string' ? msg : (msg?.body || '');
    const typingDuration = typingDurationForText(text);
    const queueKey = String(threadID ?? '');
    const previous = delayedSendQueues.get(queueKey) || Promise.resolve();

    const sendPromise = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
      if (typeof api.sendTypingIndicator === 'function') {
        try {
          Promise.resolve(api.sendTypingIndicator(threadID, true, { autoStop: false }, () => {})).catch(() => {});
        } catch {}
      }

      setTimeout(() => {
        if (typeof api.sendTypingIndicator === 'function') {
          try {
            Promise.resolve(api.sendTypingIndicator(threadID, false, { autoStop: false }, () => {})).catch(() => {});
          } catch {}
        }

        setTimeout(() => {
          let settled = false;
          const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            handler(value);
          };
          let callbackCalled = false;
          const sendCallback = (sendErr, messageInfo) => {
            if (callbackCalled) return;
            callbackCalled = true;
            if (typeof callback === 'function') {
              try { callback(sendErr, messageInfo); } catch {}
            }
            if (sendErr) finish(reject, sendErr);
            else finish(resolve, messageInfo);
          };
          const args = [msg, threadID, sendCallback, ...rest];
          const timeout = setTimeout(
            () => finish(reject, new Error(`Messenger send timed out after ${sendTimeoutMs}ms`)),
            sendTimeoutMs
          );

          try {
            const returned = rawSendMessage(...args);
            if (returned && typeof returned.then === 'function') {
              returned.then(
                value => finish(resolve, value),
                error => finish(reject, error)
              );
            } else if (returned !== undefined || rawSendMessage.length < 3) {
              finish(resolve, returned);
            }
          } catch (sendError) {
            finish(reject, sendError);
          }
        }, postTypingDelayMs);
      }, typingDuration);
    }));

    delayedSendQueues.set(queueKey, sendPromise);
    sendPromise.finally(() => {
      if (delayedSendQueues.get(queueKey) === sendPromise) {
        delayedSendQueues.delete(queueKey);
      }
    }).catch(() => {});

    return sendPromise;
  };

  Object.defineProperty(wrappedSendMessage, '__althDelayedSendMessage', {
    value: true
  });

  try {
    api.sendMessage = wrappedSendMessage;
    return api.sendMessage === wrappedSendMessage;
  } catch {
    return false;
  }
}

module.exports = { installDelayedSendMessage };
