'use strict';

function loginPromiseApi(login, credentials, options) {
  if (typeof login !== 'function') {
    return Promise.reject(new TypeError('FCA login must be a function'));
  }

  return Promise.resolve()
    .then(() => login(credentials, options))
    .then(context => {
      const api = context && context.api;
      if (!api || typeof api !== 'object') {
        throw new Error('FCA login returned no API context');
      }
      return api;
    });
}

module.exports = { loginPromiseApi };
