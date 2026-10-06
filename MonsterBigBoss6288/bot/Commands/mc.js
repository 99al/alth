'use strict';

async function sendNotice(api, message, threadID) {
  if (api && typeof api.sendMessage === 'function') {
    await api.sendMessage(message, threadID);
  }
}

module.exports = {
  name: 'mc',

  async execute(api, event) {
    const threadID = String(event && event.threadID || '');
    const reply = event && event.messageReply;
    const messageID = String(reply && reply.messageID || '');

    if (!threadID || !messageID) {
      if (threadID) {
        await sendNotice(api, 'ردّ على رسالة البوت التي تريد حذفها ثم اكتب mc.', threadID);
      }
      return false;
    }

    if (!api || typeof api.getCurrentUserID !== 'function') {
      await sendNotice(api, 'تعذر التحقق من مالك الرسالة، لذلك لم يتم حذفها.', threadID);
      return false;
    }

    const botID = String(api.getCurrentUserID() || '');
    const senderID = String(reply && reply.senderID || '');
    if (!botID || !senderID || senderID !== botID) {
      await sendNotice(api, 'يمكن استخدام mc فقط بالرد على رسالة أرسلها البوت.', threadID);
      return false;
    }

    if (typeof api.unsendMessage !== 'function') {
      await sendNotice(api, 'ميزة سحب الرسائل غير متاحة حاليًا.', threadID);
      return false;
    }

    try {
      await api.unsendMessage(messageID, threadID);
      return true;
    } catch {
      await sendNotice(api, 'تعذر سحب الرسالة. تأكد أن البوت ما زال يملك صلاحية حذفها.', threadID);
      return false;
    }
  }
};
