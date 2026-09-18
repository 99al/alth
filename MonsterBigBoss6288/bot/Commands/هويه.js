const MIN_DELAY_SECONDS = 3;
const MAX_DELAY_SECONDS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return (MIN_DELAY_SECONDS + Math.floor(Math.random() * (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS + 1))) * 1000;
}

module.exports = {
  name: 'هويه',
  aliases: ['هوية'],
  description: 'تغيير كنيات أعضاء المجموعة بفاصل عشوائي 3-5 ثوانٍ',

  async execute(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim();
    const prefix = body.startsWith('هوية ') ? 'هوية ' : 'هويه ';
    const nickname = body.startsWith(prefix) ? body.slice(prefix.length).trim() : '';

    if (!nickname) {
      await api.sendMessage('⚠️ الصيغة: هويه اسم الكنية', threadID);
      return;
    }

    try {
      const info = await api.getThreadInfo(threadID);
      const participants = info.participantIDs || [];

      await api.sendMessage(
        `⏳ سيتم تغيير كنيات ${participants.length} عضوًا إلى «${nickname}» بفاصل عشوائي بين 3 و5 ثوانٍ.`,
        threadID
      );

      let successCount = 0;
      for (const userID of participants) {
        await sleep(randomDelay());
        try {
          await api.nickname(nickname, threadID, String(userID));
          successCount++;
          console.log(`[هويه] ✅ تم تغيير كنية ${userID} في ${threadID}`);
        } catch (error) {
          console.error(`[هويه] خطأ في كنية ${userID}:`, error.message || error);
        }
      }

      await api.sendMessage(
        `✅ اكتمل أمر هويه: تم تغيير ${successCount}/${participants.length} كنية إلى «${nickname}».`,
        threadID
      );
    } catch (error) {
      console.error('[هويه] خطأ:', error.message || error);
      await api.sendMessage('❌ حدث خطأ أثناء تغيير الكنيات.', threadID);
    }
  }
};