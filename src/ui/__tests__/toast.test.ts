/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showToast, showLoader, updateLoader } from '../toast.ts';

beforeEach(() => {
  vi.useFakeTimers();

  // Set up DOM elements that toast.ts expects
  document.body.innerHTML = `
    <div id="toast"><span id="toast-msg"></span></div>
    <header id="main-header">
      <span id="header-loading-text"></span>
      <div id="header-progress-bg" style="width: 0%"></div>
    </header>
  `;
});

afterEach(() => {
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

    // First timer (1500 + 500 = 2000) should not hide — it was cleared
    vi.advanceTimersByTime(500);
    const toast = document.getElementById('toast')!;
    expect(toast.classList.contains('show')).toBe(true);

    // Second timer fires at 2000ms from second call
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

  it('falls back to console.info when DOM elements missing', () => {
    document.body.innerHTML = ''; // Remove toast elements
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
    // Not reset yet
    expect(progressBg.style.width).toBe('75%');

    vi.advanceTimersByTime(400);
    expect(progressBg.style.width).toBe('0%');
  });

  it('clears reset timer when showing again quickly', () => {
    showLoader(true);
    updateLoader(50);
    showLoader(false); // starts 400ms reset timer
    vi.advanceTimersByTime(200);

    showLoader(true); // clears the reset timer
    vi.advanceTimersByTime(400);

    // Progress bar should NOT have been reset — timer was cleared
    const progressBg = document.getElementById('header-progress-bg')!;
    expect(progressBg.style.width).not.toBe('0%');
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
});
