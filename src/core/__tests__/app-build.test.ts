/**
 * The page's build number and the forced-update port (src/core/app-build.ts,
 * RO-22, forced update train 9.0.12). The build is the integer of the
 * service-worker cache epoch that Vite defines as __MXQR_BUILD_CACHE_VERSION__;
 * unit tests leave the define out unless a row stubs it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadAppBuild(build?: unknown): Promise<typeof import('../app-build.ts')> {
  vi.resetModules();
  if (build !== undefined) vi.stubGlobal('__MXQR_BUILD_CACHE_VERSION__', build);
  return import('../app-build.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the page build number', () => {
  it('reads the cache epoch of a production build', async () => {
    expect((await loadAppBuild('v785')).APP_BUILD).toBe(785);
  });

  it('is 0 without the define, as in unit tests', async () => {
    expect((await loadAppBuild()).APP_BUILD).toBe(0);
  });

  it.each([['785'], ['v0785'], ['v'], ['v1.2'], ['V785'], [785], ['v99999999999']])(
    'is 0 for a malformed epoch %j',
    async (epoch) => {
      expect((await loadAppBuild(epoch)).APP_BUILD).toBe(0);
    },
  );
});

describe('the forced-update port', () => {
  it('answers false while no update machine has installed its handler', async () => {
    const port = await loadAppBuild('v785');
    expect(
      port.requestForcedAppUpdate({ minAppBuild: 786, admitted: false, returnCode: null }),
    ).toBe(false);
    expect(port.isForcedAppUpdatePending()).toBe(false);
  });

  it('passes every request to the one handler and reads its pending view', async () => {
    const port = await loadAppBuild('v785');
    let pending = false;
    const request = vi.fn(() => {
      pending = true;
      return true;
    });
    port.setForcedAppUpdateHandler({ request, isPending: () => pending });

    const forced = { minAppBuild: 786, admitted: true, returnCode: '000001' };
    expect(port.isForcedAppUpdatePending()).toBe(false);
    expect(port.requestForcedAppUpdate(forced)).toBe(true);
    expect(request).toHaveBeenCalledWith(forced);
    expect(port.isForcedAppUpdatePending()).toBe(true);
  });

  it('tells each presentation subscriber once per presentation, until it unsubscribes', async () => {
    const port = await loadAppBuild('v785');
    const notify = port.setForcedAppUpdateHandler({ request: () => true, isPending: () => true });
    const first = vi.fn();
    const failing = vi.fn(() => {
      throw new Error('subscriber failed');
    });
    const last = vi.fn();
    const stopFirst = port.subscribeForcedAppUpdatePresentation(first);
    port.subscribeForcedAppUpdatePresentation(failing);
    port.subscribeForcedAppUpdatePresentation(last);

    notify();
    // A failing subscriber does not keep the others from yielding.
    expect([first.mock.calls.length, failing.mock.calls.length, last.mock.calls.length]).toEqual([
      1, 1, 1,
    ]);

    stopFirst();
    notify();
    expect([first.mock.calls.length, last.mock.calls.length]).toEqual([1, 2]);
  });
});
