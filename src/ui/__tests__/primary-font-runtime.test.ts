/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const RUNTIME_SOURCE = readFileSync(resolve('public/primary-font-loader.js'), 'utf8');

describe('primary font recovery runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as Window & { __mxqrPrimaryFontRuntime?: unknown }).__mxqrPrimaryFontRuntime;
    document.documentElement.removeAttribute('data-mxqr-font-recovery');
    document.head.replaceChildren();
  });

  it('switches inherited root font variables to a separately loaded family after CSS failure', async () => {
    vi.useFakeTimers();
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
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => fontBody,
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('FontFace', RecoveryFontFace);

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
      if (node instanceof HTMLLinkElement && node.hasAttribute('data-mxqr-primary-font')) {
        queueMicrotask(() => node.onerror?.(new Event('error')));
      }
      return appended;
    });

    Function(RUNTIME_SOURCE)();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(fetchMock).toHaveBeenCalledWith(
      '/designsystem/fonts/PretendardVariable.woff2',
      expect.objectContaining({ credentials: 'same-origin', signal: expect.any(AbortSignal) }),
    );
    const recoveryFace = fontSet.add.mock.calls[0]?.[0] as RecoveryFontFace;
    expect(recoveryFace.family).toBe('MUSIXQUARE Pretendard Recovery');
    expect(document.documentElement.dataset.mxqrFontRecovery).toBe('true');
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--font-primary').trim(),
    ).toBe("'MUSIXQUARE Pretendard Recovery'");
  });
});
