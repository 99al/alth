export declare function createSameOriginApiFetch(
  originalFetch: typeof fetch,
  pageOrigin: string,
): typeof fetch;

export declare function installSameOriginApiFetch(): void;
