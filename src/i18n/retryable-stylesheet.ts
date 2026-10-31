/** A stylesheet loader whose attempts can be retried, abandoned and declared again. */
export interface RetryableStylesheet {
  /** Declare the sheet; resolves once it is, rejects when this attempt fails. */
  (): Promise<unknown>;
  /**
   * Give up the attempt in flight, if any: remove its link and reject it. The
   * next call retries with a fresh native link to the same emitted URL.
   */
  abandon(): void;
  /**
   * Declare a loaded sheet again: append a clone of the link that declares it
   * and remove the old link once the clone has loaded. The browser then has
   * fresh CSS-connected faces, which it fetches on demand, in place of faces
   * whose download failed (a failed face stays in 'error' for the life of the
   * document). Returns false when the sheet is not loaded, no link declares it
   * (a development build injects style elements) or a clone is still loading.
   */
  redeclare(): boolean;
}

/** Retry an emitted CSS asset without Vite's failed-preload success cache. */
export function createRetryableStylesheet(
  sourceName: string,
  importStylesheet: () => Promise<unknown>,
): RetryableStylesheet {
  let retryLink: HTMLLinkElement | null = null;
  let attemptLink: HTMLLinkElement | null = null;
  let inFlight: Promise<unknown> | null = null;
  let rejectInFlight: ((error: Error) => void) | null = null;
  let loaded = false;
  /** The native link that declares the loaded sheet, when this loader appended it. */
  let declaredLink: HTMLLinkElement | null = null;
  let redeclaring = false;

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

  /** The first rejection belongs to Vite's import preloader: keep its exact emitted link once. */
  const captureEmittedLink = (): void => {
    if (retryLink || typeof document === 'undefined') return;
    retryLink = findEmittedLink();
    retryLink?.remove();
  };

  const retry = (failed: HTMLLinkElement): Promise<void> =>
    new Promise((resolve, reject) => {
      // Keep the build-produced URL, font-relative URLs, nonce and CORS mode.
      // A fresh native link retries CSS without evaluating or rewriting code.
      const link = failed.cloneNode(false) as HTMLLinkElement;
      attemptLink = link;
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

  const load = (): Promise<unknown> => {
    if (loaded) return Promise.resolve();
    if (inFlight) return inFlight;
    const abandoned = new Promise<never>((_resolve, reject) => {
      rejectInFlight = reject;
    });
    const attempt = Promise.race([retryLink ? retry(retryLink) : importStylesheet(), abandoned])
      .then(() => {
        loaded = true;
        declaredLink = attemptLink;
      })
      .catch((error: unknown) => {
        captureEmittedLink();
        throw error;
      })
      .finally(() => {
        if (inFlight === attempt) {
          inFlight = null;
          rejectInFlight = null;
          attemptLink = null;
        }
      });
    inFlight = attempt;
    return attempt;
  };

  const abandon = (): void => {
    if (!inFlight || !rejectInFlight) return;
    const reject = rejectInFlight;
    // The stalled request's link goes, so a late response cannot declare the
    // sheet behind the next attempt's back; the next call clones the URL.
    if (attemptLink) attemptLink.remove();
    else captureEmittedLink();
    inFlight = null;
    rejectInFlight = null;
    attemptLink = null;
    reject(new Error(`Stylesheet request abandoned: ${sourceName}`));
  };

  const redeclare = (): boolean => {
    if (!loaded || redeclaring || typeof document === 'undefined') return false;
    const current = declaredLink?.isConnected ? declaredLink : findEmittedLink();
    if (!current) return false;
    const fresh = current.cloneNode(false) as HTMLLinkElement;
    redeclaring = true;
    fresh.addEventListener(
      'load',
      () => {
        redeclaring = false;
        current.remove();
        declaredLink = fresh;
      },
      { once: true },
    );
    fresh.addEventListener(
      'error',
      () => {
        redeclaring = false;
        fresh.remove();
      },
      { once: true },
    );
    current.after(fresh);
    return true;
  };

  return Object.assign(load, { abandon, redeclare });
}
