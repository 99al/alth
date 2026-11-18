const fs = require('fs');
const path = require('path');
const privateChatDiagnostics = require('../private-chat-diagnostics.cjs');

const CONFIG_PATH = path.join(__dirname, '..', 'commands-config.json');

function isEnabled(name) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config[name]?.enabled !== false;
  } catch {
    return true;
  }
}

function getAliases(command) {
  if (Array.isArray(command.config?.aliases)) return command.config.aliases;
  if (Array.isArray(command.aliases)) return command.aliases;
  return [];
}

module.exports = {
  name: 'اومر',
  aliases: ['أوامر', 'اومر البوت', 'أوامر البوت'],
  description: 'عرض أوامر البوت الموجودة وحالتها',

  async execute(api, event, chatDiagnostics = privateChatDiagnostics.diagnostics) {
    const threadID = String(event.threadID);
    const diagnosticContext = {
      chat: privateChatDiagnostics.chatKind(event.isGroup),
      type: privateChatDiagnostics.eventKind(event.type),
    };
    const sendReply = async message => {
      chatDiagnostics.emit('reply_attempted', diagnosticContext);
      try {
        await api.sendMessage(message, threadID);
        chatDiagnostics.emit('reply_succeeded', diagnosticContext);
      } catch (error) {
        chatDiagnostics.emit('reply_failed', {
          ...diagnosticContext,
          errorType: privateChatDiagnostics.safeErrorType(error),
        });
        throw error;
      }
    };
    const { commands } = require('../main');
    const loadedCommands = [...commands.values()];

    if (loadedCommands.length === 0) {
      await sendReply('📋 لا توجد أوامر محمّلة حاليًا.');
      return;
    }

    const lines = loadedCommands.map((command) => {
      const name = command.name || 'أمر بدون اسم';
      const aliases = getAliases(command);
      const aliasText = aliases.length > 0 ? ` (${aliases.join('، ')})` : '';
      const status = isEnabled(name) ? '✅' : '⛔';
      const description = command.description || command.config?.description || 'بدون وصف';
      return `${status} ${name}${aliasText}\n   ${description}`;
    });

    const message = [
      '📚 أوامر بوت الث:',
      '',
      ...lines,
      '',
      '✅ مفعّل   ⛔ معطّل'
    ].join('\n');

    await sendReply(message);
  }
};
