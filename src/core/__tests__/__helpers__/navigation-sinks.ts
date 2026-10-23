/**
 * Recorded location sinks for tests that drive the page navigation owner
 * (core/session-reset.ts): the page navigation harness
 * (page-navigation-harness.ts) and the suites that reload through
 * scheduleDocumentReload without the whole shell. No app modules are imported
 * here, so a suite gets the sinks without ui/dom.ts's document listeners.
 */
import { vi, type Mock } from 'vitest';

const actualWindow = globalThis.window;

// ─── Navigation sinks ───────────────────────────────────────────────
// Models window.location.reload/replace/assign and `location.href = …` as
// recorders, through the window proxy used by
// sw-register-recovery.integration.test.ts:94-113 (jsdom's Location methods
// are unforgeable). Each call records the live URL at call time, so a test can
// see a restored claim fragment. Calibrated against the reset's own premise
// (session-reset.ts:294-296): navigation APIs return before unload begins and
// can no-op. A sink call is therefore a no-op navigation until the test
// dispatches pagehide (the commit) or lets the 2 s commit deadline pass. Leaves
// out real unload, and beforeunload fired by the navigation itself (tests fire
// it with `beforeunloadPrompts`). Other properties read through to jsdom.

export interface SinkCall {
  readonly op: 'reload' | 'replace' | 'assign' | 'href';
  readonly url: string | null;
  /** The document URL when the sink ran. */
  readonly hrefAtCall: string;
}

export interface NavigationSinks {
  readonly calls: SinkCall[];
  readonly reload: Mock<() => void>;
  readonly replace: Mock<(url: string | URL) => void>;
  readonly assign: Mock<(url: string | URL) => void>;
  count(op: SinkCall['op']): number;
}

/**
 * Stub the location sinks on a window proxy (vi.stubGlobal('window', …)); the
 * caller undoes it with vi.unstubAllGlobals().
 */
export function stubNavigationSinks(): NavigationSinks {
  const actualLocation = actualWindow.location;
  const calls: SinkCall[] = [];
  const record = (op: SinkCall['op'], url: string | null): void => {
    calls.push({ op, url, hrefAtCall: actualLocation.href });
  };
  const reload = vi.fn(() => record('reload', null));
  const replace = vi.fn((url: string | URL) => record('replace', String(url)));
  const assign = vi.fn((url: string | URL) => record('assign', String(url)));
  const locationProxy = new Proxy({} as Location, {
    get(_target, property) {
      if (property === 'reload') return reload;
      if (property === 'replace') return replace;
      if (property === 'assign') return assign;
      const value = Reflect.get(actualLocation, property, actualLocation) as unknown;
      return typeof value === 'function' ? value.bind(actualLocation) : value;
    },
    set(_target, property, value: unknown) {
      if (property === 'href') {
        record('href', String(value));
        return true;
      }
      return Reflect.set(actualLocation, property, value, actualLocation);
    },
  });
  const windowProxy = new Proxy({} as Window, {
    get(_target, property) {
      if (property === 'location') return locationProxy;
      if (property === 'setTimeout') return globalThis.setTimeout;
      if (property === 'clearTimeout') return globalThis.clearTimeout;
      const value = Reflect.get(actualWindow, property, actualWindow) as unknown;
      return typeof value === 'function' ? value.bind(actualWindow) : value;
    },
  });
  vi.stubGlobal('window', windowProxy);
  return {
    calls,
    reload,
    replace,
    assign,
    count: (op) => calls.filter((call) => call.op === op).length,
  };
}
