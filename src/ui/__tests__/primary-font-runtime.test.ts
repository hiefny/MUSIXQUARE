import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

async function primaryFontRuntime(): Promise<string> {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'primary-font-loader.js',
  );
  if (!asset) throw new Error('Classic primary-font runtime is missing from the manifest.');
  return (await compileClassicRuntimeAsset(resolve('.'), asset)).code;
}

interface PendingTimer {
  callback: TimerHandler;
  delay: number;
}

describe('primary font recovery runtime', () => {
  it('switches inherited root font variables to a separately loaded family after CSS failure', async () => {
    // Compile in the Node realm, then execute the generated classic script in an
    // isolated browser realm. Importing Vite/esbuild under Vitest's jsdom realm
    // breaks esbuild's Uint8Array platform invariant.
    const script = await primaryFontRuntime();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://musixquare.com/',
    });
    const { document } = dom.window;

    try {
      const fontSet = {
        add: vi.fn(),
        load: vi.fn(async () => []),
      };
      Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: fontSet,
      });

      class RecoveryFontFace {
        constructor(
          readonly family: string,
          readonly source: ArrayBuffer,
          readonly descriptors: FontFaceDescriptors,
        ) {}

        async load(): Promise<this> {
          return this;
        }
      }

      const fontBody = Uint8Array.from([119, 79, 70, 50]).buffer;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => fontBody,
      }));
      Object.defineProperty(dom.window, 'fetch', { configurable: true, value: fetchMock });
      Object.defineProperty(dom.window, 'FontFace', {
        configurable: true,
        value: RecoveryFontFace,
      });

      let nextTimerId = 1;
      const pendingTimers = new Map<number, PendingTimer>();
      Object.defineProperty(dom.window, 'setTimeout', {
        configurable: true,
        value: (callback: TimerHandler, delay = 0): number => {
          const timerId = nextTimerId++;
          pendingTimers.set(timerId, { callback, delay });
          return timerId;
        },
      });
      Object.defineProperty(dom.window, 'clearTimeout', {
        configurable: true,
        value: (timerId: number): void => {
          pendingTimers.delete(timerId);
        },
      });

      const style = document.createElement('style');
      style.textContent = `
        :root { --font-primary: 'Pretendard'; }
        :root[data-mxqr-font-recovery='true'] {
          --font-primary: 'MUSIXQUARE Pretendard Recovery';
        }
      `;
      document.head.appendChild(style);

      const nativeAppendChild = document.head.appendChild.bind(document.head);
      vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
        const appended = nativeAppendChild(node);
        if (
          node instanceof dom.window.HTMLLinkElement &&
          node.hasAttribute('data-mxqr-primary-font')
        ) {
          void Promise.resolve().then(() => node.onerror?.(new dom.window.Event('error')));
        }
        return appended;
      });

      dom.window.eval(script);
      await vi.waitFor(() => {
        expect([...pendingTimers.values()].some(({ delay }) => delay === 1_000)).toBe(true);
      });

      const retryTimer = [...pendingTimers.entries()].find(([, { delay }]) => delay === 1_000);
      expect(retryTimer).toBeDefined();
      const [retryTimerId, { callback }] = retryTimer!;
      pendingTimers.delete(retryTimerId);
      expect(callback).toBeTypeOf('function');
      if (typeof callback === 'function') callback();

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await vi.waitFor(() => {
        expect(fontSet.add).toHaveBeenCalledOnce();
        expect(document.documentElement.dataset.mxqrFontRecovery).toBe('true');
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/designsystem/fonts/PretendardVariable.woff2',
        expect.objectContaining({
          credentials: 'same-origin',
          signal: expect.any(dom.window.AbortSignal),
        }),
      );
      const recoveryFace = fontSet.add.mock.calls[0]?.[0] as RecoveryFontFace;
      expect(recoveryFace.family).toBe('MUSIXQUARE Pretendard Recovery');
      expect(
        dom.window
          .getComputedStyle(document.documentElement)
          .getPropertyValue('--font-primary')
          .trim(),
      ).toBe("'MUSIXQUARE Pretendard Recovery'");
    } finally {
      dom.window.close();
    }
  });
});
