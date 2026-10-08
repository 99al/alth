'use strict';

const replyRules = new Map();
const commandState = require('../command-state.cjs').defaultStore;

function loadSavedRules() {
  let saved;
  try { saved = commandState.getAll('رد'); } catch {
    console.error('[رد] تعذر قراءة الردود المحفوظة.');
    return;
  }
  for (const [threadID, entry] of Object.entries(saved)) {
    if (!entry || !Array.isArray(entry.rules)) continue;
    const rules = new Map();
    for (const pair of entry.rules) {
      if (!Array.isArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== 'string' || !pair[0] || typeof pair[1] !== 'string' || !pair[1]) continue;
      rules.set(pair[0], pair[1]);
    }
    if (rules.size) replyRules.set(threadID, rules);
  }
}

function persistRules(threadID, rules) {
  if (!rules || rules.size === 0) {
    commandState.remove('رد', threadID);
    return;
  }
  commandState.set('رد', threadID, { rules: [...rules.entries()] });
}

loadSavedRules();

module.exports = {
  name: 'رد',

  async execute(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim();

    if (body.startsWith('رد ') && body.includes('»')) {
      const content = body.slice('رد '.length);
      const sepIdx = content.indexOf('»');
      const trigger = content.slice(0, sepIdx).trim();
      const response = content.slice(sepIdx + 1).trim();
      if (!trigger || !response) {
        try { await api.sendMessage('⚠️ الصيغة: رد [كلمة]» [الرد]', threadID); } catch {}
        return;
      }

      let rules = replyRules.get(threadID);
      if (!rules) rules = new Map();
      const previous = rules.get(trigger.toLowerCase());
      rules.set(trigger.toLowerCase(), response);
      try {
        persistRules(threadID, rules);
        replyRules.set(threadID, rules);
      } catch {
        if (previous === undefined) rules.delete(trigger.toLowerCase());
        else rules.set(trigger.toLowerCase(), previous);
        await api.sendMessage('❌ تعذر حفظ الرد في التخزين الدائم.', threadID);
        return;
      }

      console.log('[رد] تم حفظ قاعدة رد تلقائي.');
      try { await api.sendMessage(`✅ عند: ${trigger}\nأرد: ${response}`, threadID); } catch {}
      return;
    }

    if (body.startsWith('رد حذف ')) {
      const trigger = body.slice('رد حذف '.length).trim().toLowerCase();
      const rules = replyRules.get(threadID);
      if (rules && rules.has(trigger)) {
        const previous = rules.get(trigger);
        rules.delete(trigger);
        try {
          persistRules(threadID, rules);
          if (!rules.size) replyRules.delete(threadID);
        } catch {
          rules.set(trigger, previous);
          await api.sendMessage('❌ تعذر حفظ حذف الرد في التخزين الدائم.', threadID);
          return;
        }
        try { await api.sendMessage(`✅ حُذف الرد: ${trigger}`, threadID); } catch {}
      } else {
        try { await api.sendMessage(`⚠️ لا رد لكلمة: ${trigger}`, threadID); } catch {}
      }
      return;
    }

    if (body === 'رد قائمة') {
      const rules = replyRules.get(threadID);
      if (!rules || rules.size === 0) {
        try { await api.sendMessage('📋 لا ردود مسجلة.', threadID); } catch {}
        return;
      }
      let list = '📋 الردود المسجلة:\n\n';
      rules.forEach((resp, trig) => { list += `• ${trig} » ${resp}\n`; });
      try { await api.sendMessage(list, threadID); } catch {}
    }
  },

  async checkAutoReply(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim().toLowerCase();
    if (!body) return;
    const rules = replyRules.get(threadID);
    if (!rules || rules.size === 0) return;
    if (rules.has(body)) {
      try { await api.sendMessage(rules.get(body), threadID); } catch {
        console.error('[رد تلقائي] تعذر إرسال الرد.');
      }
    }
  },

  getRules(threadID) {
    return new Map(replyRules.get(String(threadID)) || []);
  }
};
