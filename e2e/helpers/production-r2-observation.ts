import { expect, type BrowserContext, type Page, type Request } from '@playwright/test';

export interface DownloadObservation {
  completed: Set<string>;
  failures: Map<string, string>;
  requestCount: number;
}

/** A response event only proves that headers arrived, not that the object arrived. */
export function observeRemoteDownloads(
  context: BrowserContext,
  hostname: string,
  label: string,
): DownloadObservation {
  const observation: DownloadObservation = {
    completed: new Set(),
    failures: new Map(),
    requestCount: 0,
  };
  const downloadPath = (request: Request): string | null => {
    if (request.method() !== 'GET') return null;
    const url = new URL(request.url());
    return url.hostname === hostname && url.pathname.startsWith('/download/') ? url.pathname : null;
  };
  const recordFailure = (path: string, error: string): void => {
    observation.failures.set(path, error);
    console.log(`[production-live] ${label} GET failed ${path}: ${error}`);
  };

  context.on('request', (request) => {
    if (downloadPath(request)) observation.requestCount += 1;
  });
  context.on('requestfailed', (request) => {
    const path = downloadPath(request);
    if (path) recordFailure(path, request.failure()?.errorText ?? 'Request failed');
  });
  // requestfinished follows the whole body. Aborted/truncated bodies take the
  // requestfailed path instead, including failures after successful headers.
  context.on('requestfinished', (request) => {
    const path = downloadPath(request);
    if (!path) return;
    request
      .response()
      .then((response) => {
        if (!response?.ok()) {
          recordFailure(path, response ? `HTTP ${response.status()}` : 'Response unavailable');
        } else {
          observation.completed.add(path);
          observation.failures.delete(path);
          console.log(`[production-live] ${label} GET complete ${response.status()} ${path}`);
        }
      })
      .catch((error: unknown) => recordFailure(path, String(error)));
  });
  return observation;
}

/** Production has no state hooks; require the selected, ready UI timeline to move. */
export async function waitForTrackPlaybackProgress(
  page: Page,
  title: string,
  timeout = 60_000,
): Promise<void> {
  let initialPosition: number | null = null;
  await expect
    .poll(
      async () => {
        const position = await page.evaluate((expected) => {
          const track = document.getElementById('track-title');
          const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
          const playButton = document.getElementById('play-btn');
          if (
            !track?.textContent?.includes(expected) ||
            playButton?.getAttribute('aria-busy') !== 'false' ||
            !slider ||
            !(Number(slider.max) > 0)
          ) {
            return null;
          }
          const seconds = Number(slider.value);
          return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
        }, title);
        if (position === null) {
          initialPosition = null;
          return 0;
        }
        if (initialPosition === null || position < initialPosition) initialPosition = position;
        return position - initialPosition;
      },
      {
        timeout,
        intervals: [250, 500, 1_000],
        message: `The ready ${title} timeline must advance by at least two seconds.`,
      },
    )
    .toBeGreaterThanOrEqual(2);
}
