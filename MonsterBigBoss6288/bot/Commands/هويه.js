const { createThreadRunRegistry } = require('../name-loop-registry.cjs');

const MIN_DELAY_SECONDS = 3;
const MAX_DELAY_SECONDS = 5;
const activeRuns = createThreadRunRegistry();

function randomDelay() {
  return (
    MIN_DELAY_SECONDS +
    Math.floor(Math.random() * (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS + 1))
  ) * 1000;
}

module.exports = {
  name: 'هويه',
  aliases: ['هوية'],
  description: 'تغيير كنيات أعضاء المجموعة بفاصل عشوائي 3-5 ثوانٍ',

  async execute(api, event) {
    const threadID = String(event && event.threadID || '');
    const body = String(event && event.body || '').trim();
    const prefix = body.startsWith('هوية ') ? 'هوية ' : 'هويه ';
    const nickname = body.startsWith(prefix) ? body.slice(prefix.length).trim() : '';

    if (!nickname) {
      await api.sendMessage('⚠️ الصيغة: هويه اسم الكنية (أو هوية اسم الكنية)', threadID);
      return;
    }

    const run = activeRuns.begin(threadID);
    if (!run) {
      await api.sendMessage(
        '⚠️ يوجد تغيير كنيات جارٍ في هذه المحادثة. أوقفه بالأمر «إيقاف الاسم» أولًا.',
        threadID
      );
      return;
    }

    try {
      const info = await api.getThreadInfo(threadID);
      if (!activeRuns.isActive(run)) return;

      const participants = Array.isArray(info && info.participantIDs)
        ? info.participantIDs
        : [];

      await api.sendMessage(
        `⏳ سيتم تغيير كنيات ${participants.length} عضوًا إلى «${nickname}» بفاصل عشوائي بين 3 و5 ثوانٍ.`,
        threadID
      );
      if (!activeRuns.isActive(run)) return;

      let successCount = 0;
      for (const userID of participants) {
        if (!await activeRuns.wait(run, randomDelay())) return;
        if (!activeRuns.isActive(run)) return;

        try {
          await api.nickname(nickname, threadID, String(userID));
          if (!activeRuns.isActive(run)) return;
          successCount++;
          console.log(`[هويه] ✅ تم تغيير كنية ${userID} في ${threadID}`);
        } catch (error) {
          console.error(`[هويه] خطأ في كنية ${userID}:`, error.message || error);
        }
      }

      if (!activeRuns.isActive(run)) return;
      await api.sendMessage(
        `✅ اكتمل أمر هويه: تم تغيير ${successCount}/${participants.length} كنية إلى «${nickname}».`,
        threadID
      );
    } catch (error) {
      console.error('[هويه] خطأ:', error.message || error);
      if (activeRuns.isActive(run)) {
        await api.sendMessage('❌ حدث خطأ أثناء تغيير الكنيات.', threadID);
      }
    } finally {
      activeRuns.finish(run);
    }
  },

  cancel(threadID) {
    return activeRuns.cancel(threadID);
  },

  cancelAll() {
    return activeRuns.cancelAll();
  }
};
