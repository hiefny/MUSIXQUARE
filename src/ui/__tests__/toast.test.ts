/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { StandardOperatorFileUplinkProgress } from '../../types/index.ts';
import { initToast, showToast, showLoader, updateLoader } from '../toast.ts';

let uplinkSequence = 0;

function uplinkProgress(
  overrides: Partial<StandardOperatorFileUplinkProgress> = {},
): StandardOperatorFileUplinkProgress {
  return {
    direction: 'send',
    phase: 'waiting',
    requestId: `request-${uplinkSequence}`,
    sessionId: `session-${++uplinkSequence}`,
    fileName: 'song.flac',
    loaded: 0,
    total: 100,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();

  document.body.innerHTML = `
    <div id="toast"><span id="toast-msg"></span></div>
    <header id="main-header">
      <span id="header-loading-text"></span>
      <div id="header-progress-bg" style="width: 0%"></div>
    </header>
  `;
  initToast();
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

describe('standard operator file uplink feedback', () => {
  it('shows determinate sender progress, caps assembly at 99%, and closes at 100%', () => {
    const progress = uplinkProgress();

    bus.emit('standard-room:operator-file-uplink-progress', progress);
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(document.getElementById('header-loading-text')!.innerText).toBe('Sending file\u2026');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('0%');

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'uploading',
      loaded: 50,
    });
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('50%');

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'assembling',
      loaded: 100,
    });
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('99%');

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'complete',
      loaded: 100,
    });
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(false);
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('100%');

    vi.advanceTimersByTime(400);
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('0%');
  });

  it('shows the current batch position and a bounded file name', () => {
    const progress = uplinkProgress({
      fileIndex: 1,
      fileCount: 3,
      fileName: 'a-very-long-orchestra-master-recording.flac',
    });

    bus.emit('standard-room:operator-file-uplink-progress', progress);

    expect(document.getElementById('header-loading-text')!.innerText).toBe(
      'Sending file… 2/3 · a-very-long-orch….flac',
    );
  });

  it('ignores host receive progress', () => {
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...uplinkProgress(),
      direction: 'receive',
      phase: 'uploading',
      loaded: 50,
    });

    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(false);
    expect(document.getElementById('toast')!.classList.contains('show')).toBe(false);
  });

  it('keeps a newer file loader when an older session terminates late', () => {
    const older = uplinkProgress({ fileName: 'older.flac' });
    const newer = uplinkProgress({ fileName: 'newer.wav' });

    bus.emit('standard-room:operator-file-uplink-progress', older);
    bus.emit('standard-room:operator-file-uplink-progress', newer);
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...older,
      phase: 'error',
      code: 'upload-failed',
    });

    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(document.getElementById('header-loading-text')!.innerText).toBe('Sending file\u2026');
    expect(document.getElementById('header-progress-bg')!.style.width).toBe('0%');

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...newer,
      phase: 'complete',
      loaded: newer.total,
    });
  });

  it('maps terminal errors and does not replay a duplicate terminal toast', () => {
    setState('network.isOperator', true);
    const revoked = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...revoked,
      phase: 'error',
      code: 'operator-revoked',
    });
    expect(document.getElementById('toast-msg')!.innerText).toBe('Admin permission revoked.');

    const invalid = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...invalid,
      phase: 'error',
      code: 'invalid-file',
    });
    expect(document.getElementById('toast-msg')!.innerText).toBe(
      'No supported audio files to add.',
    );

    const tooLarge = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...tooLarge,
      phase: 'error',
      code: 'file-too-large',
    });
    expect(document.getElementById('toast-msg')!.innerText).toBe('File too large (200 MB max)');

    const busy = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...busy,
      phase: 'error',
      code: 'host-busy',
    });
    expect(document.getElementById('toast-msg')!.innerText).toBe(
      'Host is processing another file. Try again soon.',
    );

    const full = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...full,
      phase: 'error',
      code: 'queue-full',
    });
    expect(document.getElementById('toast-msg')!.innerText).toBe('The playlist is full.');

    const network = uplinkProgress();
    const terminal: StandardOperatorFileUplinkProgress = {
      ...network,
      phase: 'error',
      code: 'upload-failed',
    };
    bus.emit('standard-room:operator-file-uplink-progress', terminal);
    expect(document.getElementById('toast-msg')!.innerText).toBe('A network error occurred');

    vi.advanceTimersByTime(1500);
    bus.emit('standard-room:operator-file-uplink-progress', terminal);
    vi.advanceTimersByTime(500);
    expect(document.getElementById('toast')!.classList.contains('show')).toBe(false);
  });

  it('does not duplicate the normal operator-revoked toast for an active uplink', () => {
    setState('network.isOperator', true);
    const progress = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', progress);
    setState('network.isOperator', false);
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'aborted',
      code: 'operator-revoked',
    });

    expect(document.getElementById('toast')!.classList.contains('show')).toBe(false);
  });

  it('closes quietly when the user cancels', () => {
    const progress = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', progress);
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'aborted',
      code: 'cancelled',
    });

    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(false);
    expect(document.getElementById('toast')!.classList.contains('show')).toBe(false);
  });

  it('does not duplicate the uplink listener when initialized again', () => {
    initToast();
    initToast();

    expect(bus.debug()['standard-room:operator-file-uplink-progress']).toBe(1);
  });
});

describe('standard queue mutation feedback', () => {
  it('distinguishes legacy hosts, queue conflicts, and capacity', () => {
    bus.emit('standard-room:queue-mutation-failed', 'accept-timeout', null);
    expect(document.getElementById('toast-msg')!.innerText).toBe(
      'Please update the device managing this room.',
    );

    bus.emit('standard-room:queue-mutation-failed', 'rejected', 'invalid-target');
    expect(document.getElementById('toast-msg')!.innerText).toBe(
      'The playlist changed. Please try again.',
    );

    bus.emit('standard-room:queue-mutation-failed', 'rejected', 'queue-full');
    expect(document.getElementById('toast-msg')!.innerText).toBe('The playlist is full.');
  });
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
