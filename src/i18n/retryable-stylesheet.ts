/** Retry an emitted CSS asset without Vite's failed-preload success cache. */
export function createRetryableStylesheet(
  sourceName: string,
  importStylesheet: () => Promise<unknown>,
): () => Promise<unknown> {
  let retryLink: HTMLLinkElement | null = null;
  let inFlight: Promise<unknown> | null = null;
  let loaded = false;

  const findEmittedLink = (): HTMLLinkElement | null => {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      const url = new URL(link.href, document.baseURI);
      if (url.origin !== location.origin) continue;
      const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
      if (
        name === `${sourceName}.css` ||
        (name.startsWith(`${sourceName}-`) && name.endsWith('.css'))
      )
        return link;
    }
    return null;
  };

  const retry = (failed: HTMLLinkElement): Promise<void> =>
    new Promise((resolve, reject) => {
      // Keep the build-produced URL, font-relative URLs, nonce and CORS mode.
      // A fresh native link retries CSS without evaluating or rewriting code.
      const link = failed.cloneNode(false) as HTMLLinkElement;
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener(
        'error',
        () => {
          link.remove();
          reject(new Error(`Unable to load stylesheet: ${link.href}`));
        },
        { once: true },
      );
      document.head.appendChild(link);
    });

  return () => {
    if (loaded) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (retryLink ? retry(retryLink) : importStylesheet())
      .then(() => {
        loaded = true;
      })
      .catch((error: unknown) => {
        // The first rejection belongs to Vite's import preloader. Capture its
        // exact emitted link once; later attempts belong to this native loader.
        if (!retryLink && typeof document !== 'undefined') {
          retryLink = findEmittedLink();
          retryLink?.remove();
        }
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
