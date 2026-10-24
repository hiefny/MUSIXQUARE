/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh page: the module keeps this page's last close in memory only. */
async function loadPage() {
  vi.resetModules();
  const [lastLinkClose, { log }] = await Promise.all([
    import('../last-link-close.ts'),
    import('../../core/log.ts'),
  ]);
  return { ...lastLinkClose, info: vi.spyOn(log, 'info').mockImplementation(() => undefined) };
}

describe("the guest's last close across its disconnect reload (P4-D5 B)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps nothing when this page closed no logical connection', async () => {
    const page = await loadPage();
    page.keepLinkCloseForNextPage();
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps the last close and shows its whole UTC seconds once on the next page', async () => {
    const first = await loadPage();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 25, 23, 59, 59, 999));
    first.noteLinkClose('original-grace-expired');
    first.noteLinkClose('side-failed:expired');
    now.mockRestore();
    first.keepLinkCloseForNextPage();

    const next = await loadPage();
    next.reportPreviousPageClose();
    next.reportPreviousPageClose();

    expect(next.info.mock.calls).toEqual([
      ['[Transport] Previous page closed (side-failed:expired) at 23:59:59 UTC'],
    ]);
    expect(sessionStorage.length).toBe(0);
  });

  it('logs nothing and keeps the value when it cannot remove it', async () => {
    sessionStorage.setItem('mxqr-prev-close', 'channel-closed 1792897445678');
    const page = await loadPage();
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    page.reportPreviousPageClose();
    removeItem.mockRestore();
    // Logging without removing would repeat the line on every later page.
    expect(page.info).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr-prev-close')).toBe('channel-closed 1792897445678');
  });

  it.each([
    ['a time past the year 2286', 'channel-closed 99999999999999'],
    ['an upper-case token', 'Channel-closed 1792897445678'],
    ['extra fields', 'channel-closed 1792897445678 123456'],
    ['an empty value', ''],
  ])('drops a kept value with %s', async (_label, value) => {
    sessionStorage.setItem('mxqr-prev-close', value);
    const page = await loadPage();
    page.reportPreviousPageClose();
    expect(page.info).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
});
