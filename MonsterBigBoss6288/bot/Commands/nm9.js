'use strict';

// Dedicated Bot 9 entry point for /nm9. Reuse the group-title implementation
// used by Bot 8, including durable name protection and manual cancellation.
const { getBotCommandProfile } = require('../bot-command-profile.cjs');
const profile = getBotCommandProfile();
if (profile.id !== 'ninth' || profile.groupTitle.commandName !== 'nm9') {
  throw new Error('The nm9 command module is reserved for the ninth bot profile.');
}

// The command loader supports reloading modules, so refresh the shared handler
// here as well rather than retaining another profile's cached command name.
const implementationPath = require.resolve('./قروب.js');
delete require.cache[implementationPath];
module.exports = require(implementationPath);
