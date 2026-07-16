/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showToast, showLoader, updateLoader } from '../toast.ts';

beforeEach(() => {
  vi.useFakeTimers();

  document.body.innerHTML = `
    <div id="toast"><span id="toast-msg"></span></div>
    <header id="main-header">
      <span id="header-loading-text"></span>
      <div id="header-progress-bg" style="width: 0%"></div>
    </header>
  `;
});

afterEach(() => {
  for (const id of ['loader-a', 'loader-b', 'remote-upload', 'removed-loader']) {
    showLoader(false, undefined, id);
  }
  showLoader(false);
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('showToast', () => {
  it('shows toast with message text', () => {
    showToast('Hello!');
    const toast = document.getElementById('toast')!;
    const msg = document.getElementById('toast-msg')!;
    expect(toast.classList.contains('show')).toBe(true);
    expect(msg.innerText).toBe('Hello!');
  });

  it('auto-hides toast after 2000ms', () => {
    showToast('Temp');
    const toast = document.getElementById('toast')!;
    expect(toast.classList.contains('show')).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('resets timer on rapid successive calls', () => {
    showToast('First');
    vi.advanceTimersByTime(1500);

    showToast('Second');
    const msg = document.getElementById('toast-msg')!;
    expect(msg.innerText).toBe('Second');

    // Crossing the first toast's original deadline must not hide the successor.
    vi.advanceTimersByTime(500);
    const toast = document.getElementById('toast')!;
    expect(toast.classList.contains('show')).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('handles null message gracefully', () => {
    showToast(null);
    const msg = document.getElementById('toast-msg')!;
    expect(msg.innerText).toBe('');
  });

  it('handles undefined message gracefully', () => {
    showToast(undefined);
    const msg = document.getElementById('toast-msg')!;
    expect(msg.innerText).toBe('');
  });

  it('converts number to string', () => {
    showToast(42);
    const msg = document.getElementById('toast-msg')!;
    expect(msg.innerText).toBe('42');
  });

  it('truncates long colon values and preserves file extensions', () => {
    showToast('File read error: This is a very very very long song filename.m4a');
    const msg = document.getElementById('toast-msg')!;

    expect(msg.innerText.length).toBeLessThanOrEqual(50);
    expect(msg.innerText).toMatch(/^File read error: /);
    expect(msg.innerText).toContain('…');
    expect(msg.innerText.endsWith('.m4a')).toBe(true);
  });

  it('truncates long quoted values per line', () => {
    showToast('Decoding "This is a very very very long song filename.mp3" took too long.');
    const msg = document.getElementById('toast-msg')!;

    expect(msg.innerText.length).toBeLessThanOrEqual(50);
    expect(msg.innerText).toContain('…');
    expect(msg.innerText).toContain('.mp3');
    expect(msg.innerText).toContain('took too long.');
    expect(msg.title).toContain('This is a very very very long song filename.mp3');
  });

  it('keeps manual toast line breaks while enforcing line length', () => {
    showToast('Remote file share failed:\nFailed because this backend error message is very long');
    const msg = document.getElementById('toast-msg')!;

    const lines = msg.innerText.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.length <= 50)).toBe(true);
  });

  it('falls back to console.info when DOM elements missing', () => {
    document.body.innerHTML = '';
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    showToast('No DOM');
    expect(spy).toHaveBeenCalledWith('[Toast]', 'No DOM');
  });
});

describe('showLoader', () => {
  it('adds loading class when show=true', () => {
    showLoader(true, 'Loading...');
    const header = document.getElementById('main-header')!;
    expect(header.classList.contains('loading')).toBe(true);
  });

  it('sets loading text', () => {
    showLoader(true, 'Downloading...');
    const loadingText = document.getElementById('header-loading-text')!;
    expect(loadingText.innerText).toBe('Downloading...');
  });

  it('removes loading class when show=false', () => {
    showLoader(true, 'Loading...');
    showLoader(false);
    const header = document.getElementById('main-header')!;
    expect(header.classList.contains('loading')).toBe(false);
  });

  it('resets progress bar width after 400ms delay on hide', () => {
    showLoader(true);
    updateLoader(75);
    showLoader(false);

    const progressBg = document.getElementById('header-progress-bg')!;
    expect(progressBg.style.width).toBe('75%');

    vi.advanceTimersByTime(400);
    expect(progressBg.style.width).toBe('0%');
  });

  it('clears reset timer when showing again quickly', () => {
    showLoader(true);
    updateLoader(50);
    showLoader(false);
    vi.advanceTimersByTime(200);

    showLoader(true);
    vi.advanceTimersByTime(400);

    const progressBg = document.getElementById('header-progress-bg')!;
    expect(progressBg.style.width).not.toBe('0%');
  });

  it('preserves background holder state and restores it after the foreground hides', () => {
    showLoader(true, 'Uploading...', 'loader-a');
    updateLoader(20, 'loader-a');
    showLoader(true, 'Downloading...', 'loader-b');
    updateLoader(70, 'loader-b');

    // Background progress is retained without repainting the foreground.
    updateLoader(45, 'loader-a');
    expect(document.getElementById('header-loading-text')!.innerText).toBe('Downloading...');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('70%');

    showLoader(false, undefined, 'loader-b');
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(document.getElementById('header-loading-text')!.innerText).toBe('Uploading...');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('45%');
  });

  it('does not let a background holder hide the foreground holder', () => {
    showLoader(true, 'Uploading...', 'loader-a');
    showLoader(true, 'Downloading...', 'loader-b');

    showLoader(false, undefined, 'loader-a');

    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(document.getElementById('header-loading-text')!.innerText).toBe('Downloading...');
  });

  it('does not promote a background holder when it reports new text or progress', () => {
    showLoader(true, 'Upload A', 'loader-a');
    updateLoader(25, 'loader-a');
    showLoader(true, 'Download B', 'loader-b');
    updateLoader(10, 'loader-b');

    showLoader(true, 'Upload A 50%', 'loader-a');
    updateLoader(50, 'loader-a');

    expect(document.getElementById('header-loading-text')!.innerText).toBe('Download B');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('10%');

    showLoader(false, undefined, 'loader-b');
    expect(document.getElementById('header-loading-text')!.innerText).toBe('Upload A 50%');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('50%');
  });
});

describe('updateLoader', () => {
  it('sets progress bar width percentage', () => {
    updateLoader(50);
    const progressBg = document.getElementById('header-progress-bg')!;
    expect(progressBg.style.width).toBe('50%');
  });

  it('sets 100% width', () => {
    updateLoader(100);
    const progressBg = document.getElementById('header-progress-bg')!;
    expect(progressBg.style.width).toBe('100%');
  });

  it('sets 0% width', () => {
    updateLoader(0);
    const progressBg = document.getElementById('header-progress-bg')!;
    expect(progressBg.style.width).toBe('0%');
  });

  it('keeps default progress behind an explicitly named foreground holder', () => {
    showLoader(true, 'Preparing...');
    updateLoader(20);
    showLoader(true, 'Uploading...', 'remote-upload');
    updateLoader(40);

    expect(document.getElementById('header-loading-text')!.innerText).toBe('Uploading...');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('0%');

    showLoader(false, undefined, 'remote-upload');
    expect(document.getElementById('header-loading-text')!.innerText).toBe('Preparing...');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('40%');
  });

  it('ignores a late explicit update after its holder was removed', () => {
    showLoader(true, 'Old operation', 'removed-loader');
    updateLoader(25, 'removed-loader');
    showLoader(false, undefined, 'removed-loader');
    vi.advanceTimersByTime(400);

    updateLoader(90, 'removed-loader');

    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(false);
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('0%');
  });
});
