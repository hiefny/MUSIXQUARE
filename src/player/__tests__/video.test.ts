/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, setManagedTimer } from '../../core/timers.ts';
import '../video.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';
import { exitYouTubeFullscreen, setEngineMode } from '../video.ts';

beforeEach(() => {
  resetState();
  clearAllManagedTimers();
  document.body.innerHTML = '<div id="youtube-player-container"></div>';
  document.body.className = '';
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  clearAllManagedTimers();
  vi.useRealTimers();
  for (const property of [
    'fullscreenElement',
    'exitFullscreen',
    'webkitFullscreenElement',
    'webkitCurrentFullScreenElement',
    'webkitIsFullScreen',
    'webkitExitFullscreen',
    'webkitCancelFullScreen',
  ]) {
    delete (document as unknown as Record<string, unknown>)[property];
  }
});

describe('native fullscreen exit settlement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
    setState('playback.mode', 'youtube');
  });

  it('keeps the closing surface pending until the native exit promise settles', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    installDocumentProperty('fullscreenElement', document.querySelector('.video-wrapper'));
    installDocumentProperty(
      'exitFullscreen',
      vi.fn(() => pending),
    );
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    resolve();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('settles on fullscreenchange even if the native promise never resolves', () => {
    installDocumentProperty('fullscreenElement', document.querySelector('.video-wrapper'));
    installDocumentProperty(
      'exitFullscreen',
      vi.fn(() => new Promise<void>(() => {})),
    );
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(settled).not.toHaveBeenCalled();
    installDocumentProperty('fullscreenElement', null);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(settled).toHaveBeenCalledOnce();
  });

  it('waits for a legacy WebKit fullscreen exit event', () => {
    installDocumentProperty('webkitCurrentFullScreenElement', document.querySelector('iframe'));
    installDocumentProperty('webkitCancelFullScreen', vi.fn());
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    expect(settled).not.toHaveBeenCalled();
    installDocumentProperty('webkitCurrentFullScreenElement', null);
    document.dispatchEvent(new Event('webkitfullscreenchange'));
    expect(settled).toHaveBeenCalledOnce();
  });

  it('shares an in-flight exit and isolates each observer', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    installDocumentProperty('fullscreenElement', document.querySelector('.video-wrapper'));
    const exit = vi.fn(() => pending);
    installDocumentProperty('exitFullscreen', exit);
    const throwing = vi.fn(() => {
      throw new Error('observer failed');
    });
    const settled = vi.fn();
    exitYouTubeFullscreen(throwing);
    exitYouTubeFullscreen(settled);
    expect(exit).toHaveBeenCalledOnce();
    resolve();
    await Promise.resolve();
    expect(throwing).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('bounds a missing promise/event even after room-managed timers are cleared', () => {
    installDocumentProperty('fullscreenElement', document.querySelector('.video-wrapper'));
    installDocumentProperty(
      'exitFullscreen',
      vi.fn(() => new Promise<void>(() => {})),
    );
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    clearAllManagedTimers();
    vi.advanceTimersByTime(1_499);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('settles on pagehide and ignores a late completion after return', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    installDocumentProperty('fullscreenElement', document.querySelector('.video-wrapper'));
    installDocumentProperty(
      'exitFullscreen',
      vi.fn(() => pending),
    );
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    window.dispatchEvent(new Event('pagehide'));
    expect(settled).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('pageshow'));
    resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('settles failed exits without retaining a pending surface', async () => {
    installDocumentProperty('fullscreenElement', document.querySelector('.video-wrapper'));
    installDocumentProperty(
      'exitFullscreen',
      vi.fn(() => Promise.reject(new Error('denied'))),
    );
    const rejected = vi.fn();
    exitYouTubeFullscreen(rejected);
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledOnce();
    installDocumentProperty(
      'exitFullscreen',
      vi.fn(() => {
        throw new Error('unsupported');
      }),
    );
    const thrown = vi.fn();
    exitYouTubeFullscreen(thrown);
    expect(thrown).toHaveBeenCalledOnce();
  });

  it('settles a fullscreen error but ignores errors from an unrelated element', () => {
    const wrapper = document.querySelector('.video-wrapper')!;
    installDocumentProperty('fullscreenElement', wrapper);
    installDocumentProperty('exitFullscreen', vi.fn());
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    document.body.dispatchEvent(new Event('fullscreenerror', { bubbles: true }));
    expect(settled).not.toHaveBeenCalled();
    wrapper.dispatchEvent(new Event('fullscreenerror', { bubbles: true }));
    expect(settled).toHaveBeenCalledOnce();
  });

  it('finishes fake fullscreen immediately with no native waiting timer', () => {
    const wrapper = document.querySelector('.video-wrapper')!;
    wrapper.classList.add('fake-fullscreen');
    document.body.classList.add('has-fake-fullscreen');
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    expect(settled).toHaveBeenCalledOnce();
    expect(wrapper.classList.contains('fake-fullscreen')).toBe(false);
    expect(document.body.classList.contains('has-fake-fullscreen')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['root', 'other'] as const)(
    'only the explicit document toggle exits %s fullscreen outside YouTube mode',
    async (kind) => {
      setState('playback.mode', 'file');
      let resolve!: () => void;
      const pending = new Promise<void>((done) => {
        resolve = done;
      });
      const element = kind === 'root' ? document.documentElement : document.body;
      installDocumentProperty('fullscreenElement', element);
      const exit = vi.fn(() => pending);
      installDocumentProperty('exitFullscreen', exit);
      const ignored = vi.fn();
      exitYouTubeFullscreen(ignored);
      expect(exit).not.toHaveBeenCalled();
      expect(ignored).toHaveBeenCalledOnce();

      const settled = vi.fn();
      exitYouTubeFullscreen(settled, { scope: 'document' });
      expect(exit).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      resolve();
      await Promise.resolve();
      expect(settled).toHaveBeenCalledOnce();
    },
  );

  it('supports a document toggle on legacy WebKit without an exposed fullscreen element', () => {
    setState('playback.mode', 'file');
    installDocumentProperty('webkitIsFullScreen', true);
    const exit = vi.fn();
    installDocumentProperty('webkitCancelFullScreen', exit);
    const settled = vi.fn();
    exitYouTubeFullscreen(settled, { scope: 'document' });
    expect(exit).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    installDocumentProperty('webkitIsFullScreen', false);
    document.dispatchEvent(new Event('webkitfullscreenchange'));
    expect(settled).toHaveBeenCalledOnce();
  });
});

function installDocumentProperty(property: string, value: unknown): void {
  Object.defineProperty(document, property, { configurable: true, value });
}

describe('setEngineMode', () => {
  it('keeps decoded file engines paused when playback is not currently playing', () => {
    setEngineMode('buffer');

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('keeps decoded file engines playing when playback is already active', () => {
    setPlaybackFilePlaying();

    setEngineMode('buffer');

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('playing');
  });

  it('always claims YouTube mode directly', () => {
    setEngineMode('youtube');

    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.activity')).toBe('playing');
    expect(document.body.classList.contains('mode-youtube')).toBe(true);
  });
});

// External sink contract: each playback mode produces a deterministic body
// class set and YouTube container visibility. Future modes added to
// PlaybackMode must extend this table; a mode falling through to the default
// (no classes, hidden container) without an explicit row is a regression.
describe('body class sink (playback.mode matrix)', () => {
  type Row = {
    mode: 'file' | 'youtube' | 'system-audio' | null;
    youtubeClass: boolean;
    systemAudioClass: boolean;
    ytContainerVisible: boolean;
  };

  const MATRIX: Row[] = [
    { mode: null, youtubeClass: false, systemAudioClass: false, ytContainerVisible: false },
    { mode: 'file', youtubeClass: false, systemAudioClass: false, ytContainerVisible: false },
    { mode: 'youtube', youtubeClass: true, systemAudioClass: false, ytContainerVisible: true },
    {
      mode: 'system-audio',
      youtubeClass: false,
      systemAudioClass: true,
      ytContainerVisible: false,
    },
  ];

  for (const { mode, youtubeClass, systemAudioClass, ytContainerVisible } of MATRIX) {
    it(`mode=${mode ?? 'null'} -> classes(${youtubeClass ? 'mode-youtube' : '-'}, ${systemAudioClass ? 'mode-system-audio' : '-'}), container ${ytContainerVisible ? 'shown' : 'hidden'}`, () => {
      // Force the bus subscriber to fire even when the target mode equals
      // the initial state by transitioning through a sentinel first. Direct
      // setState short-circuits on same-value writes.
      const sentinel = mode === 'file' ? 'youtube' : 'file';
      setState('playback.mode', sentinel);
      // Prime body with the opposite state so toggle effects are observable.
      document.body.classList.add('mode-youtube', 'mode-system-audio');

      setState('playback.mode', mode);

      expect(document.body.classList.contains('mode-youtube')).toBe(youtubeClass);
      expect(document.body.classList.contains('mode-system-audio')).toBe(systemAudioClass);

      const container = document.getElementById('youtube-player-container') as HTMLElement;
      if (ytContainerVisible) {
        expect(container.style.display).toBe('block');
        expect(container.style.opacity).toBe('1');
      } else {
        expect(container.style.display).toBe('none');
        expect(container.style.opacity).toBe('0');
      }
    });
  }

  it('keeps an existing YouTube iframe resident offscreen outside YouTube mode', () => {
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
    setState('playback.mode', 'youtube');

    setState('playback.mode', 'file');

    const wrapper = document.querySelector('.video-wrapper') as HTMLElement;
    const container = document.getElementById('youtube-player-container') as HTMLElement;
    expect(wrapper.style.display).toBe('flex');
    expect(wrapper.style.position).toBe('fixed');
    expect(wrapper.style.left).toBe('-9999px');
    expect(container.style.display).toBe('block');
    expect(container.style.width).toBe('1px');
    expect(container.style.opacity).toBe('0');
  });

  it('makes the parked wrapper inert so its fullscreen button cannot take keyboard focus outside YouTube mode', () => {
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div><button id="btn-fullscreen"></button></div>';
    setState('playback.mode', 'youtube');
    const wrapper = document.querySelector('.video-wrapper') as HTMLElement;
    expect(wrapper.hasAttribute('inert')).toBe(false);

    setState('playback.mode', 'file');
    expect(wrapper.hasAttribute('inert')).toBe(true);

    setState('playback.mode', 'youtube');
    expect(wrapper.hasAttribute('inert')).toBe(false);
  });

  it('clears fake fullscreen before parking a retained iframe for local-file playback', () => {
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
    setState('playback.mode', 'youtube');
    const wrapper = document.querySelector('.video-wrapper') as HTMLElement;
    wrapper.classList.add('fake-fullscreen');
    document.body.classList.add('has-fake-fullscreen');

    setState('playback.mode', 'file');

    expect(wrapper.classList.contains('fake-fullscreen')).toBe(false);
    expect(document.body.classList.contains('has-fake-fullscreen')).toBe(false);
    expect(wrapper.style.left).toBe('-9999px');
  });

  it('exits native fullscreen before parking the YouTube wrapper', () => {
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
    setState('playback.mode', 'youtube');
    const wrapper = document.querySelector('.video-wrapper') as HTMLElement;
    const wrapperLeftWhenExitRuns: string[] = [];
    const exitFullscreen = vi.fn(() => {
      wrapperLeftWhenExitRuns.push(wrapper.style.left);
      return Promise.resolve();
    });
    installDocumentProperty('fullscreenElement', wrapper);
    installDocumentProperty('exitFullscreen', exitFullscreen);

    setState('playback.mode', 'file');

    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(wrapperLeftWhenExitRuns).toEqual(['']);
    expect(wrapper.style.left).toBe('-9999px');
  });

  it('uses legacy WebKit fullscreen teardown for an iframe-owned fullscreen surface', () => {
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
    setState('playback.mode', 'youtube');
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const webkitExitFullscreen = vi.fn();
    installDocumentProperty('webkitFullscreenElement', iframe);
    installDocumentProperty('webkitExitFullscreen', webkitExitFullscreen);

    setState('playback.mode', 'file');

    expect(webkitExitFullscreen).toHaveBeenCalledOnce();
  });

  it('keeps player fullscreen during an in-place YouTube state update', () => {
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');
    const wrapper = document.querySelector('.video-wrapper') as HTMLElement;
    const exitFullscreen = vi.fn(() => Promise.resolve());
    installDocumentProperty('fullscreenElement', wrapper);
    installDocumentProperty('exitFullscreen', exitFullscreen);

    setEngineMode('youtube');

    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(wrapper.style.left).toBe('');
    expect(document.body.classList.contains('mode-youtube')).toBe(true);
  });

  it('does not exit an unrelated fullscreen element when YouTube mode ends', () => {
    document.body.innerHTML = `
      <div id="unrelated-fullscreen"></div>
      <div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>
    `;
    setState('playback.mode', 'youtube');
    const unrelated = document.getElementById('unrelated-fullscreen') as HTMLElement;
    const exitFullscreen = vi.fn(() => Promise.resolve());
    installDocumentProperty('fullscreenElement', unrelated);
    installDocumentProperty('exitFullscreen', exitFullscreen);

    setState('playback.mode', 'file');

    expect(exitFullscreen).not.toHaveBeenCalled();
    expect((document.querySelector('.video-wrapper') as HTMLElement).style.left).toBe('-9999px');
  });

  it('cancels a pending WebKit fake-fullscreen fallback when YouTube mode exits', () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
    setState('playback.mode', 'youtube');
    const wrapper = document.querySelector('.video-wrapper') as HTMLElement;
    setManagedTimer(
      'webkit-fullscreen-fallback',
      () => {
        wrapper.classList.add('fake-fullscreen');
        document.body.classList.add('has-fake-fullscreen');
      },
      100,
    );

    setState('playback.mode', 'file');
    vi.advanceTimersByTime(100);

    expect(wrapper.classList.contains('fake-fullscreen')).toBe(false);
    expect(document.body.classList.contains('has-fake-fullscreen')).toBe(false);
  });
});
