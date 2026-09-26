/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { __resetModalStackForTests, syncOverlayState } from '../dom.ts';
import {
  closeManualSyncOverlayRuntime,
  openDemoSyncRuntime,
} from '../manual-sync-overlay-runtime.ts';

const platform = vi.hoisted(() => ({ ios: false, android: false }));
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_IOS() {
    return platform.ios;
  },
  get IS_ANDROID() {
    return platform.android;
  },
}));

function editor(): HTMLElement {
  return document.getElementById('manual-sync-value')!;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  clearAllManagedTimers();
  platform.ios = false;
  platform.android = false;
  document.body.innerHTML = `
    <button id="btn-sync">Sync</button>
    <div id="manual-sync-overlay" aria-hidden="true">
      <div role="dialog">
        <div id="manual-sync-value" contenteditable="true" tabindex="0"></div>
        <button id="btn-sync-done">Done</button>
      </div>
    </div>
    <div id="dialog-overlay" aria-hidden="true"><button id="other-dialog">OK</button></div>
  `;
  __resetModalStackForTests();
  setState('demo.active', true);
  document.getElementById('btn-sync')!.focus();
});

afterEach(() => {
  closeManualSyncOverlayRuntime();
  clearAllManagedTimers();
  __resetModalStackForTests();
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe('manual sync initial editor selection', () => {
  it.each([
    [0, '0'],
    [0.237, '+237'],
    [-0.123, '-123'],
  ] as const)(
    'selects the complete %s second offset when the desktop overlay opens',
    (offset, text) => {
      setState('sync.localOffset', offset);
      openDemoSyncRuntime();

      // syncOverlayState already focuses the first focusable child. Selection
      // must not depend on a second focus event or a deferred timer.
      expect(document.activeElement).toBe(editor());
      expect(window.getSelection()?.toString()).toBe(text);
      vi.advanceTimersByTime(0);
      expect(document.activeElement).toBe(editor());
      expect(window.getSelection()?.toString()).toBe(text);
    },
  );

  it('preserves a pointer-positioned caret after refocusing the editor', () => {
    setState('sync.localOffset', 0.237);
    openDemoSyncRuntime();
    document.getElementById('btn-sync-done')!.focus();
    editor().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    editor().focus();
    const range = document.createRange();
    range.setStart(editor().firstChild!, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    vi.advanceTimersByTime(0);

    expect(selection.isCollapsed).toBe(true);
    expect(selection.anchorOffset).toBe(2);
  });

  it('reselects the current value when the overlay opens again', () => {
    openDemoSyncRuntime();
    closeManualSyncOverlayRuntime();
    setState('sync.localOffset', -0.456);

    openDemoSyncRuntime();

    expect(document.activeElement).toBe(editor());
    expect(window.getSelection()?.toString()).toBe('-456');
  });

  it('rejects a draft for a different offset target even before the UI refreshes', () => {
    setState('playback.mode', 'file');
    setState('sync.youtubeLocalOffset', 0.75);
    openDemoSyncRuntime();
    const commits = vi.fn();
    const unsubscribe = bus.on('sync:set-manual-offset', commits);
    try {
      editor().textContent = '250';
      // This isolated runtime has no main player-controls state listener.
      setState('playback.mode', 'youtube');
      editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(commits).not.toHaveBeenCalled();
      expect(editor().textContent).toBe('+750');
    } finally {
      unsubscribe();
    }
  });

  it('does not steal focus back from a newly opened dialog', () => {
    openDemoSyncRuntime();
    const dialog = document.getElementById('dialog-overlay')!;
    dialog.classList.add('active');
    dialog.setAttribute('aria-hidden', 'false');
    syncOverlayState('dialog-overlay');
    const other = document.getElementById('other-dialog')!;
    other.focus();

    vi.advanceTimersByTime(0);

    expect(document.activeElement).toBe(other);
  });

  it.each(['ios', 'android'] as const)('preserves the Done focus target on %s', (kind) => {
    platform[kind] = true;
    openDemoSyncRuntime();

    vi.advanceTimersByTime(0);

    expect(document.activeElement).toBe(document.getElementById('btn-sync-done'));
  });
});
