'use strict';

const profiles = Object.freeze({
  first: Object.freeze({
    id: 'first',
    nm: Object.freeze({ commandName: 'nm', aliases: Object.freeze(['namemute', 'غلق', 'lockname']) }),
    jareed: Object.freeze({ commandName: 'جريد', aliases: Object.freeze(['جرائد', 'جريد البوت']) }),
    groupTitle: Object.freeze({ commandName: 'قروب' })
  }),
  second: Object.freeze({
    id: 'second',
    nm: Object.freeze({ commandName: 'nmm', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جريدة', aliases: Object.freeze(['جريدة البوت']) }),
    groupTitle: Object.freeze({ commandName: 'قروب' })
  }),
  third: Object.freeze({
    id: 'third',
    nm: Object.freeze({ commandName: 'nms', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جينو', aliases: Object.freeze(['جينو البوت']) }),
    groupTitle: Object.freeze({ commandName: 'قروب' })
  }),
  fourth: Object.freeze({
    id: 'fourth',
    nm: Object.freeze({ commandName: 'na', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جين', aliases: Object.freeze([]) }),
    groupTitle: Object.freeze({ commandName: 'قروب' })
  }),
  fifth: Object.freeze({
    id: 'fifth',
    nm: Object.freeze({ commandName: 'nm5', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جودي', aliases: Object.freeze([]) }),
    groupTitle: Object.freeze({ commandName: 'قروب' })
  }),
  sixth: Object.freeze({
    id: 'sixth',
    nm: Object.freeze({ commandName: 'nm6', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'جواد', aliases: Object.freeze([]) }),
    groupTitle: Object.freeze({ commandName: 'قروب' })
  }),
  seventh: Object.freeze({
    id: 'seventh',
    nm: Object.freeze({ commandName: 'nm', aliases: Object.freeze(['namemute', 'غلق', 'lockname']) }),
    jareed: Object.freeze({ commandName: 'جود', aliases: Object.freeze([]) }),
    groupTitle: Object.freeze({ commandName: 'عنوان' })
  }),
  eighth: Object.freeze({
    id: 'eighth',
    nm: Object.freeze({ commandName: 'nm', aliases: Object.freeze(['namemute', 'غلق', 'lockname']) }),
    jareed: Object.freeze({ commandName: 'موعد', aliases: Object.freeze([]) }),
    groupTitle: Object.freeze({ commandName: 'لقب' })
  }),
  ninth: Object.freeze({
    id: 'ninth',
    nm: Object.freeze({ commandName: 'nm9', aliases: Object.freeze([]) }),
    jareed: Object.freeze({ commandName: 'سكون', aliases: Object.freeze([]) }),
    groupTitle: Object.freeze({ commandName: 'nm9', stateKey: 'nm9' })
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
  if (requested === 'seventh') return profiles.seventh;
  if (requested === 'eighth') return profiles.eighth;
  if (requested === 'ninth') return profiles.ninth;
  throw new Error('BOT_COMMAND_PROFILE must be either "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", or "ninth".');
}

module.exports = { getBotCommandProfile };
