/** A stylesheet loader whose attempts can be retried and abandoned. */
export interface RetryableStylesheet {
  /** Declare the sheet; resolves once it is, rejects when this attempt fails. */
  (): Promise<unknown>;
  /**
   * Give up the attempt in flight, if any: remove its link and reject it. The
   * next call retries with a fresh native link to the same emitted URL.
   */
  abandon(): void;
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

  return Object.assign(load, { abandon });
}
