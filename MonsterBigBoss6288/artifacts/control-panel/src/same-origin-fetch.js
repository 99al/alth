const PATCHED = Symbol.for('alth.sameOriginApiFetchPatched');

function requestUrl(input, baseOrigin) {
  if (typeof input === 'string') return new URL(input, baseOrigin);
  if (input instanceof URL) return input;
  if (input && typeof input.url === 'string') return new URL(input.url, baseOrigin);
  return null;
}

export function createSameOriginApiFetch(originalFetch, pageOrigin) {
  const normalizedOrigin = new URL(pageOrigin).origin;
  return (input, init) => {
    let url;
    try {
      url = requestUrl(input, normalizedOrigin);
    } catch {
      return originalFetch(input, init);
    }

    if (!url || url.origin !== normalizedOrigin || !url.pathname.startsWith('/api/')) {
      return originalFetch(input, init);
    }

    return originalFetch(input, { ...init, credentials: 'same-origin' });
  };
}

export function installSameOriginApiFetch() {
  if (typeof window === 'undefined' || typeof globalThis.fetch !== 'function' || globalThis[PATCHED]) return;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createSameOriginApiFetch(originalFetch, window.location.origin);
  Object.defineProperty(globalThis, PATCHED, { value: true, configurable: false });
}

installSameOriginApiFetch();
