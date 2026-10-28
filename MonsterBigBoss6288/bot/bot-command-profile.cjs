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
  }),
  fifth: Object.freeze({
    id: 'fifth',
    nm: Object.freeze({ commandName: 'nm5', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جودي', aliases: Object.freeze([]) })
  }),
  sixth: Object.freeze({
    id: 'sixth',
    nm: Object.freeze({ commandName: 'nm6', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جواد', aliases: Object.freeze([]) })
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
  if (requested === 'fifth') return profiles.fifth;
  if (requested === 'sixth') return profiles.sixth;
  throw new Error('BOT_COMMAND_PROFILE must be either "first", "second", "third", "fourth", "fifth", or "sixth".');
}

module.exports = { getBotCommandProfile };
