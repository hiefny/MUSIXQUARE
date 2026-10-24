/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  describe('at the production log level', () => {
    // Production logs at WARN. Info is on only through ?mxqrLog=info,
    // ?logLevel or localStorage 'mxqr:logLevel'. A joined guest's address
    // becomes '/', so the page after its disconnect reload logs at WARN; the
    // owner's procedure (Rule R) then opens /<code>?mxqrLog=info in the same tab.
    const KEPT = 'peer-left 1792897445678'; // 2026-10-25 03:04:05.678 UTC
    const LINE = '[Transport] Previous page closed (peer-left) at 03:04:05 UTC';

    /** A fresh page at `path`, with the real log level gate in front of console.info. */
    async function loadProductionPage(path: string) {
      history.replaceState(null, '', path);
      vi.resetModules();
      return import('../last-link-close.ts');
    }

    beforeEach(() => {
      vi.stubEnv('PROD', true);
      localStorage.clear();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      localStorage.clear();
      history.replaceState(null, '', '/');
    });

    it('leaves the kept close on a page that logs no info lines, for the next page that does', async () => {
      sessionStorage.setItem('mxqr-prev-close', KEPT);
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      (await loadProductionPage('/')).reportPreviousPageClose();
      expect(consoleInfo).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('mxqr-prev-close')).toBe(KEPT);

      const ruleR = await loadProductionPage('/123456?mxqrLog=info');
      ruleR.reportPreviousPageClose();
      ruleR.reportPreviousPageClose();
      expect(consoleInfo.mock.calls).toEqual([[LINE]]);
      expect(sessionStorage.getItem('mxqr-prev-close')).toBeNull();
    });

    it('logs the kept close at once when the tab stores the info level', async () => {
      sessionStorage.setItem('mxqr-prev-close', KEPT);
      localStorage.setItem('mxqr:logLevel', 'info');
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      (await loadProductionPage('/')).reportPreviousPageClose();
      expect(consoleInfo.mock.calls).toEqual([[LINE]]);
      expect(sessionStorage.getItem('mxqr-prev-close')).toBeNull();
    });
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
