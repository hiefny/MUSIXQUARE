/** @vitest-environment jsdom */
/**
 * RO-26 owner boundary: the shared fullscreen helper in core/fullscreen.ts and
 * the two surfaces that leave top-document fullscreen through it, the YouTube
 * player (exitYouTubeFullscreen) and the screensaver entry (release()).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { exitYouTubeFullscreen } from '../../player/video.ts';
import { __resetModalStackForTests, whenBackSurfaceSettled } from '../../ui/dom.ts';
import { beginScreensaverEntry, type ScreensaverEntry } from '../../ui/screensaver-entry.ts';
import { FULLSCREEN_SETTLEMENT_MS } from '../fullscreen.ts';
import { resetState, setState } from '../state.ts';
import { clearAllManagedTimers } from '../timers.ts';

const DOCUMENT_PROPERTIES = [
  'fullscreenElement',
  'exitFullscreen',
  'webkitFullscreenElement',
  'webkitCurrentFullScreenElement',
  'webkitIsFullScreen',
  'webkitExitFullscreen',
  'webkitCancelFullScreen',
] as const;
const REQUEST_PROPERTIES = [
  'requestFullscreen',
  'webkitRequestFullscreen',
  'webkitRequestFullScreen',
] as const;

let entry: ScreensaverEntry | null = null;

function defineDocument(property: string, descriptor: PropertyDescriptor): void {
  Object.defineProperty(document, property, { configurable: true, ...descriptor });
}

/** Standard Fullscreen API whose exit never settles by itself. */
function stalledFullscreen(initial: Element | null = null) {
  let current = initial;
  const change = (element: Element | null): void => {
    current = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  defineDocument('fullscreenElement', { get: () => current });
  const exit = vi.fn(() => new Promise<void>(() => {}));
  defineDocument('exitFullscreen', { value: exit });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(() => {
      change(document.documentElement);
      return Promise.resolve();
    }),
  });
  return { exit, change };
}

/** Promise settlement and whenBackSurfaceSettled() both take a few microtask turns. */
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  clearAllManagedTimers();
  __resetModalStackForTests();
  document.body.className = '';
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
});

afterEach(async () => {
  entry?.release();
  entry = null;
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS);
  __resetModalStackForTests();
  clearAllManagedTimers();
  for (const property of DOCUMENT_PROPERTIES) Reflect.deleteProperty(document, property);
  for (const property of REQUEST_PROPERTIES)
    Reflect.deleteProperty(document.documentElement, property);
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('fullscreen settlement bound (C8-I2)', () => {
  it('is one 1.5 s constant shared by both exits', () => {
    expect(FULLSCREEN_SETTLEMENT_MS).toBe(1_500);
  });

  it('bounds a stalled YouTube exit at FULLSCREEN_SETTLEMENT_MS after room timers are cleared', () => {
    setState('playback.mode', 'youtube');
    const native = stalledFullscreen(document.querySelector('.video-wrapper'));
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    expect(native.exit).toHaveBeenCalledOnce();
    clearAllManagedTimers();
    vi.advanceTimersByTime(FULLSCREEN_SETTLEMENT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('bounds a stalled screensaver exit at FULLSCREEN_SETTLEMENT_MS after room timers are cleared', async () => {
    const native = stalledFullscreen();
    entry = beginScreensaverEntry();
    expect(entry).not.toBeNull();
    await settleMicrotasks();
    entry!.release();
    expect(native.exit).toHaveBeenCalledOnce();
    const observed = vi.fn();
    const settled = whenBackSurfaceSettled().then(observed);
    clearAllManagedTimers();
    await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS - 1);
    expect(observed).not.toHaveBeenCalled();
    expect(beginScreensaverEntry()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(observed).toHaveBeenCalledOnce();
    const retry = beginScreensaverEntry();
    expect(retry).not.toBeNull();
    retry?.release();
  });
});

// ─── One bounded exit for both callers (C8-I8) ──────────────────────

type Api = 'standard' | 'webkit' | 'legacy';

const API_NAMES = {
  standard: {
    state: 'fullscreenElement',
    exit: 'exitFullscreen',
    request: 'requestFullscreen',
    change: 'fullscreenchange',
    error: 'fullscreenerror',
  },
  webkit: {
    state: 'webkitFullscreenElement',
    exit: 'webkitExitFullscreen',
    request: 'webkitRequestFullscreen',
    change: 'webkitfullscreenchange',
    error: 'webkitfullscreenerror',
  },
  legacy: {
    state: 'webkitCurrentFullScreenElement',
    exit: 'webkitCancelFullScreen',
    request: 'webkitRequestFullScreen',
    change: 'webkitfullscreenchange',
    error: 'webkitfullscreenerror',
  },
} as const;

interface NativeFullscreen {
  readonly exit: Mock<() => Promise<void> | void>;
  change(element: Element | null): void;
}

/** One Fullscreen API flavour; standard exits stall, prefixed exits return nothing. */
function nativeFullscreen(api: Api): NativeFullscreen {
  const names = API_NAMES[api];
  let current: Element | null = null;
  const change = (element: Element | null): void => {
    current = element;
    document.dispatchEvent(new Event(names.change));
  };
  defineDocument(names.state, { get: () => current });
  const exit = vi.fn<() => Promise<void> | void>(() =>
    api === 'standard' ? new Promise<void>(() => {}) : undefined,
  );
  defineDocument(names.exit, { value: exit });
  Object.defineProperty(document.documentElement, names.request, {
    configurable: true,
    value: vi.fn(() => {
      change(document.documentElement);
      return api === 'standard' ? Promise.resolve() : undefined;
    }),
  });
  return { exit, change };
}

interface ExitCaller {
  readonly name: string;
  /** The element whose fullscreen this caller leaves. */
  element(): Element;
  /** Enters fullscreen the way the caller does, starts its exit, returns its settlement spy. */
  start(native: NativeFullscreen): Promise<Mock<() => void>>;
}

const youtubeCaller: ExitCaller = {
  name: 'YouTube player',
  element: () => document.querySelector('.video-wrapper')!,
  async start(native) {
    setState('playback.mode', 'youtube');
    native.change(youtubeCaller.element());
    const settled = vi.fn<() => void>();
    exitYouTubeFullscreen(settled);
    await settleMicrotasks();
    return settled;
  },
};

const screensaverCaller: ExitCaller = {
  name: 'screensaver entry',
  element: () => document.documentElement,
  async start() {
    entry = beginScreensaverEntry();
    expect(entry).not.toBeNull();
    await settleMicrotasks();
    const settled = vi.fn<() => void>();
    entry!.release();
    whenBackSurfaceSettled().then(settled, settled);
    await settleMicrotasks();
    return settled;
  },
};

describe.each([youtubeCaller, screensaverCaller])('bounded fullscreen exit: $name', (caller) => {
  it('settles when the native exit promise resolves, once', async () => {
    const native = nativeFullscreen('standard');
    let resolve!: () => void;
    native.exit.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const settled = await caller.start(native);
    expect(native.exit).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    resolve();
    await settleMicrotasks();
    expect(settled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS * 2);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('settles on the change event that leaves fullscreen while the promise stalls', async () => {
    const native = nativeFullscreen('standard');
    const settled = await caller.start(native);
    native.change(caller.element());
    await settleMicrotasks();
    expect(settled).not.toHaveBeenCalled();
    native.change(null);
    await settleMicrotasks();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('waits for the legacy WebKit change event after a void exit', async () => {
    const native = nativeFullscreen('legacy');
    const settled = await caller.start(native);
    expect(native.exit).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    native.change(null);
    await settleMicrotasks();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('settles on pagehide and ignores a late completion after return', async () => {
    const native = nativeFullscreen('standard');
    let resolve!: () => void;
    native.exit.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const settled = await caller.start(native);
    window.dispatchEvent(new Event('pagehide'));
    await settleMicrotasks();
    expect(settled).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('pageshow'));
    resolve();
    native.change(null);
    await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS * 2);
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(['rejects', 'throws'] as const)('settles an exit that %s', async (failure) => {
    const native = nativeFullscreen('standard');
    native.exit.mockImplementation(() => {
      if (failure === 'throws') throw new Error('unsupported');
      return Promise.reject(new Error('denied'));
    });
    const settled = await caller.start(native);
    await settleMicrotasks();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("settles only on its own exit method's error at the document or the exiting element", async () => {
    const native = nativeFullscreen('standard');
    const settled = await caller.start(native);
    document.body.dispatchEvent(new Event('fullscreenerror', { bubbles: true }));
    caller.element().dispatchEvent(new Event('webkitfullscreenerror', { bubbles: true }));
    await settleMicrotasks();
    expect(settled).not.toHaveBeenCalled();
    caller.element().dispatchEvent(new Event('fullscreenerror', { bubbles: true }));
    await settleMicrotasks();
    expect(settled).toHaveBeenCalledOnce();
  });
});

describe('exit method when only the prefixed element is set and both exits exist', () => {
  function bothExits(): { standard: Mock<() => Promise<void>>; native: NativeFullscreen } {
    const native = nativeFullscreen('webkit');
    native.exit.mockImplementation(() => native.change(null));
    const standard = vi.fn(() => Promise.resolve());
    defineDocument('exitFullscreen', { value: standard });
    return { standard, native };
  }

  it('the screensaver exits through the prefixed door it entered', async () => {
    const { standard, native } = bothExits();
    await screensaverCaller.start(native);
    expect(native.exit).toHaveBeenCalledOnce();
    expect(standard).not.toHaveBeenCalled();
  });

  it('the YouTube player exits through the same door [C8-I13, owner decision O3]', async () => {
    const { standard, native } = bothExits();
    await youtubeCaller.start(native);
    expect(native.exit).toHaveBeenCalledOnce();
    expect(standard).not.toHaveBeenCalled();
  });

  it('both owners use the standard exit while the standard element is set', async () => {
    for (const caller of [youtubeCaller, screensaverCaller]) {
      const native = nativeFullscreen('standard');
      native.exit.mockImplementation(() => {
        native.change(null);
        return Promise.resolve();
      });
      const prefixed = vi.fn();
      defineDocument('webkitExitFullscreen', { value: prefixed });
      await caller.start(native);
      expect(native.exit).toHaveBeenCalledOnce();
      expect(prefixed).not.toHaveBeenCalled();
      entry = null;
    }
  });
});

// ─── One in-flight exit for the document (C8-I9) ────────────────────

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  Object.defineProperty(document, 'hidden', { configurable: true, value: state === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('one in-flight fullscreen exit shared by both owners', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    Reflect.deleteProperty(document, 'hidden');
  });

  it('a YouTube exit of the same element joins the screensaver exit, also across a hidden page', async () => {
    const native = nativeFullscreen('standard');
    const screensaverSettled = await screensaverCaller.start(native);
    expect(native.exit).toHaveBeenCalledOnce();
    setState('playback.mode', 'youtube');
    const youtubeSettled = vi.fn();
    exitYouTubeFullscreen(youtubeSettled, { scope: 'document' });
    expect(native.exit).toHaveBeenCalledOnce();

    setVisibility('hidden');
    setVisibility('visible');
    await settleMicrotasks();
    expect(screensaverSettled).not.toHaveBeenCalled();
    expect(youtubeSettled).not.toHaveBeenCalled();
    native.change(null);
    await settleMicrotasks();
    expect(screensaverSettled).toHaveBeenCalledOnce();
    expect(youtubeSettled).toHaveBeenCalledOnce();
  });

  it('a stalled joined exit still settles every owner at the one native bound', async () => {
    const native = nativeFullscreen('standard');
    const screensaverSettled = await screensaverCaller.start(native);
    const youtubeSettled = vi.fn();
    exitYouTubeFullscreen(youtubeSettled, { scope: 'document' });
    clearAllManagedTimers();
    await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS - 1);
    expect(screensaverSettled).not.toHaveBeenCalled();
    expect(youtubeSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(screensaverSettled).toHaveBeenCalledOnce();
    expect(youtubeSettled).toHaveBeenCalledOnce();
    expect(native.exit).toHaveBeenCalledOnce();
  });
});
