'use strict';

const profiles = Object.freeze({
  first: Object.freeze({
    id: 'first',
    nm: Object.freeze({ commandName: 'nm', aliases: Object.freeze(['namemute', 'غلق', 'lockname']) }),
    jareed: Object.freeze({ commandName: 'جريد', aliases: Object.freeze(['جرائد', 'جريد البوت']) })
  }),
  second: Object.freeze({
    id: 'second',
    nm: Object.freeze({ commandName: 'nmm', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جريدة', aliases: Object.freeze(['جريدة البوت']) })
  }),
  third: Object.freeze({
    id: 'third',
    nm: Object.freeze({ commandName: 'nms', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جينو', aliases: Object.freeze(['جينو البوت']) })
  }),
  fourth: Object.freeze({
    id: 'fourth',
    nm: Object.freeze({ commandName: 'na', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جين', aliases: Object.freeze([]) })
  })
});

function getBotCommandProfile(env = process.env) {
  const requested = typeof env.BOT_COMMAND_PROFILE === 'string'
    ? env.BOT_COMMAND_PROFILE.trim().toLowerCase()
    : '';
  if (!requested || requested === 'first') return profiles.first;
  if (requested === 'second') return profiles.second;
  if (requested === 'third') return profiles.third;
  if (requested === 'fourth') return profiles.fourth;
  throw new Error('BOT_COMMAND_PROFILE must be either "first", "second", "third", or "fourth".');
}

module.exports = { getBotCommandProfile };
