import type { Page } from '@playwright/test';

export interface E2EQueueItem {
  queueItemId: string;
}

export interface E2EQueueSnapshot {
  items: E2EQueueItem[];
  currentQueueItemId: string | null;
  revision: number;
}

export async function readQueueSnapshot(page: Page): Promise<E2EQueueSnapshot> {
  return page.evaluate(() => {
    const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
      | ((path: string) => unknown)
      | undefined;
    const items = get?.('playlist.items');
    const currentQueueItemId = get?.('playlist.currentQueueItemId');
    const revision = get?.('playlist.revision');
    return {
      items: Array.isArray(items)
        ? items.filter(
            (item): item is { queueItemId: string } =>
              !!item &&
              typeof item === 'object' &&
              typeof (item as { queueItemId?: unknown }).queueItemId === 'string',
          )
        : [],
      currentQueueItemId: typeof currentQueueItemId === 'string' ? currentQueueItemId : null,
      revision: typeof revision === 'number' ? revision : -1,
    };
  });
}

export async function readCurrentQueueItemId(page: Page): Promise<string | null> {
  return (await readQueueSnapshot(page)).currentQueueItemId;
}

export async function readCurrentQueueIndex(page: Page): Promise<number> {
  const { items, currentQueueItemId } = await readQueueSnapshot(page);
  return items.findIndex((item) => item.queueItemId === currentQueueItemId);
}

export async function setCurrentQueueItemByIndex(page: Page, index: number): Promise<void> {
  await page.evaluate((nextIndex) => {
    const root = window as unknown as Record<string, unknown>;
    const get = root.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
    const set = root.__MUSIXQUARE_SET_STATE__ as
      | ((path: string, value: unknown) => void)
      | undefined;
    const items = get?.('playlist.items');
    const item = Array.isArray(items) ? items[nextIndex] : undefined;
    const queueItemId =
      item && typeof item === 'object'
        ? (item as { queueItemId?: unknown }).queueItemId
        : undefined;
    if (set && typeof queueItemId === 'string') {
      set('playlist.currentQueueItemId', queueItemId);
    }
  }, index);
}

export async function waitForCurrentQueueIndex(
  page: Page,
  expectedIndex: number,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((path: string) => unknown)
        | undefined;
      const items = get?.('playlist.items');
      const currentQueueItemId = get?.('playlist.currentQueueItemId');
      return (
        Array.isArray(items) &&
        items.findIndex(
          (item) =>
            !!item &&
            typeof item === 'object' &&
            (item as { queueItemId?: unknown }).queueItemId === currentQueueItemId,
        ) === expected
      );
    },
    expectedIndex,
    { timeout },
  );
}

export async function waitForCurrentQueueItemId(
  page: Page,
  expectedQueueItemId: string,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((path: string) => unknown)
        | undefined;
      return get?.('playlist.currentQueueItemId') === expected;
    },
    expectedQueueItemId,
    { timeout },
  );
}
