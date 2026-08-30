const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const YTDL_PATH = process.env.YTDL_PATH || '/home/runner/workspace/.pythonlibs/bin/yt-dlp';

function downloadAudio(query, outFile) {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch1:${query}`,
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '--no-playlist',
      '-o',
      outFile
    ];
    console.log(`[يوت] بدء تحميل نتيجة البحث إلى ملف مؤقت`);

    const child = spawn(YTDL_PATH, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        resolve();
      } else {
        const message = stderr.trim() || `yt-dlp انتهى برمز ${code ?? 'غير معروف'}`;
        console.error(`[يوت] yt-dlp stderr:`, message);
        reject(new Error(message));
      }
    });
  });
}

function cleanup(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

module.exports = {
  name: 'يوت',

  async execute(api, event) {
    const threadID = String(event.threadID);
    const body = (event.body || '').trim();

    if (!body.startsWith('يوت ')) return;
    const query = body.slice('يوت '.length).trim();
    if (!query) {
      try { await api.sendMessage('⚠️ مثال: يوت Imagine Dragons Believer', threadID); } catch (e) {}
      return;
    }

    try { await api.sendMessage(`🎵 جاري البحث عن: "${query}"...`, threadID); } catch (e) {}

    const tmpDir = path.join(__dirname, '..', 'tmp');
    const outFile = path.join(tmpDir, 'yot-' + Date.now() + '.mp3');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}

    try {
      await downloadAudio(query, outFile);

      const sizeMB = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
      console.log(`[يوت] إرسال ملف (${sizeMB} MB) إلى ${threadID}`);

      await api.sendMessage({ attachment: fs.createReadStream(outFile) }, threadID);

    } catch (err) {
      console.error(`[يوت] فشل:`, err.message);
      try { await api.sendMessage('❌ لم يُعثر علجربماًالمقطع أو فشل التحميل، جرب اسماً آخر.', threadID); } catch (e) {}
    } finally {
      cleanup(outFile);
    }
  }
};
