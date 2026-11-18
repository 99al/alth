'use strict';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_EVENT_RECORDS = 256;
const MAX_TOTAL_RECORDS = 1024;
const STAGES = new Set([
  'event_received',
  'command_matched',
  'admin_allowed',
  'admin_denied',
  'command_disabled',
  'handler_missing',
  'reply_attempted',
  'reply_succeeded',
  'reply_failed',
]);
const CHAT_KINDS = new Set(['dm', 'group', 'unknown']);
const EVENT_KINDS = new Set(['message', 'message_reply', 'unknown']);
const ERROR_KINDS = new Set(['auth', 'transport', 'rate_limited', 'permission', 'remote_service', 'other']);

function chatKind(isGroup) {
  if (isGroup === true) return 'group';
  if (isGroup === false) return 'dm';
  return 'unknown';
}

function eventKind(type) {
  if (type === 'message' || type === 'message_reply') return type;
  return 'unknown';
}

function recordMessageEvent(event, reporter = diagnostics) {
  if (!event || (event.type !== 'message' && event.type !== 'message_reply')) return false;
  reporter.emit('event_received', {
    chat: chatKind(event.isGroup),
    type: eventKind(event.type),
  });
  return true;
}

function safeErrorType(error) {
  const code = error && typeof error.code === 'string' ? error.code.toUpperCase() : '';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED'].includes(code)) return 'transport';

  const status = Number(error && (error.statusCode ?? error.status));
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (Number.isInteger(status) && status >= 500 && status <= 599) return 'remote_service';

  const message = error && typeof error.message === 'string' ? error.message : '';
  if (/login_blocked|checkpoint|not logged in|unauthori[sz]ed|auth(?:entication|orization)? error/i.test(message)) return 'auth';
  if (/rate.?limit|throttl/i.test(message)) return 'rate_limited';
  if (/permission denied|access denied|not allowed/i.test(message)) return 'permission';
  if (/timeout|socket|network|connection (?:closed|refused|reset|lost)|econn/i.test(message)) return 'transport';
  if (/remote service|server error|upstream/i.test(message)) return 'remote_service';
  return 'other';
}

function createDiagnostics({ now = Date.now, write = line => console.info(line), windowMs = WINDOW_MS, maxEventRecords = MAX_EVENT_RECORDS, maxTotalRecords = MAX_TOTAL_RECORDS } = {}) {
  const startedAt = now();
  let eventRecords = 0;
  let totalRecords = 0;

  function emit(stage, { chat = 'unknown', type = 'unknown', errorType } = {}) {
    if (!STAGES.has(stage) || now() - startedAt >= windowMs || totalRecords >= maxTotalRecords) return false;
    if (stage === 'event_received') {
      if (eventRecords >= maxEventRecords) return false;
      eventRecords++;
    }
    totalRecords++;

    const safeChat = CHAT_KINDS.has(chat) ? chat : 'unknown';
    const safeEvent = EVENT_KINDS.has(type) ? type : 'unknown';
    const fields = [`stage=${stage}`, `chat=${safeChat}`, `type=${safeEvent}`];
    if (stage === 'reply_failed') fields.push(`error_type=${ERROR_KINDS.has(errorType) ? errorType : 'other'}`);
    try {
      write(`[BOT2-DIAG] ${fields.join(' ')}`);
      return true;
    } catch {
      return false;
    }
  }

  return { emit };
}

const diagnostics = createDiagnostics();
module.exports = { chatKind, eventKind, recordMessageEvent, safeErrorType, createDiagnostics, diagnostics };
