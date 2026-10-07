/** Hold the origin-wide native lock until this prompt finishes or its document closes. */
export function acquireServiceWorkerPromptLock(
  identity: string,
): Promise<false | null | (() => void)> {
  return new Promise((resolve) => {
    try {
      const locks = globalThis.navigator?.locks;
      if (!locks) {
        resolve(null);
        return;
      }
      void locks
        .request(`mxqr-sw-prompt:${identity}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          return new Promise<void>((release) => resolve(release));
        })
        .catch(() => resolve(null));
    } catch {
      // Restricted/older browsers retain the storage election and availability fallback.
      resolve(null);
    }
  });
}
