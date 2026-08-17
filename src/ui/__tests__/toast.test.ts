/**
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection, StandardOperatorFileUplinkProgress } from '../../types/index.ts';
import { initToast, showToast, showLoader, updateLoader } from '../toast.ts';

let uplinkSequence = 0;

function headerLoaderText(): string {
  return document.querySelector<HTMLElement>('.header-loading-text-content')?.textContent ?? '';
}

function headerProgressPercent(): number {
  const transform = document.getElementById('header-progress-bg')?.style.transform ?? '';
  const scale = Number.parseFloat(transform.match(/^scaleX\(([^)]+)\)$/)?.[1] ?? '0');
  return scale * 100;
}

function expectHeaderProgress(percent: number): void {
  expect(headerProgressPercent()).toBeCloseTo(percent, 4);
}

function installAnimationFrameHarness(): {
  request: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  pending: () => number;
  step: (timestamp: number) => void;
} {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    callbacks.delete(id);
  });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));

  return {
    request,
    cancel,
    pending: () => callbacks.size,
    step: (timestamp: number) => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(timestamp));
    },
  };
}

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
  // Keep legacy behavior assertions synchronous; focused animation tests
  // install a real frame queue and opt back into motion explicitly.
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  resetState();

  document.body.innerHTML = `
    <div id="toast"><span id="toast-msg"></span></div>
    <header id="main-header">
      <span id="header-loading-text">
        <span class="material-elastic-spinner header-loading-spinner" aria-hidden="true">
          <svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18"></circle></svg>
        </span>
        <span class="header-loading-text-content"></span>
      </span>
      <div id="header-progress-bg" style="transform: scaleX(0)"></div>
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('standard operator file uplink feedback', () => {
  it('shows determinate sender progress, caps assembly at 99%, and closes at 100%', () => {
    const progress = uplinkProgress();

    bus.emit('standard-room:operator-file-uplink-progress', progress);
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(headerLoaderText()).toBe('Sending file\u2026');
    expectHeaderProgress(0);

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'uploading',
      loaded: 50,
    });
    expectHeaderProgress(50);

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'assembling',
      loaded: 100,
    });
    expectHeaderProgress(99);

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...progress,
      phase: 'complete',
      loaded: 100,
    });
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(false);
    expectHeaderProgress(100);

    vi.advanceTimersByTime(400);
    expectHeaderProgress(0);
  });

  it('shows the current batch position and a truncated file name', () => {
    const progress = uplinkProgress({
      fileIndex: 1,
      fileCount: 3,
      fileName: 'a-very-long-orchestra-master-recording.flac',
    });

    bus.emit('standard-room:operator-file-uplink-progress', progress);

    expect(headerLoaderText()).toBe('Sending file… 2/3 · a-very-long-orch….flac');
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
    expect(headerLoaderText()).toBe('Sending file\u2026');
    expectHeaderProgress(0);

    bus.emit('standard-room:operator-file-uplink-progress', {
      ...newer,
      phase: 'complete',
      loaded: newer.total,
    });
  });

  it('maps terminal errors and does not replay a duplicate terminal toast', () => {
    setState('network.appRole', 'guest');
    const hostConnection: DataConnection = {
      peer: 'host',
      open: true,
      send: vi.fn(),
      close: vi.fn(),
      on: () => undefined,
    };
    setState('network.hostConn', hostConnection);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['asset.upload']);
    const revoked = uplinkProgress();
    bus.emit('standard-room:operator-file-uplink-progress', {
      ...revoked,
      phase: 'error',
      code: 'operator-revoked',
    });
    expect(document.getElementById('toast-msg')!.innerText).toBe(
      'Media management permission required.',
    );

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

    bus.emit('standard-room:queue-mutation-failed', 'rejected', 'unauthorized');
    expect(document.getElementById('toast-msg')!.innerText).toBe(
      'Media management permission required.',
    );
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
  it('keeps header progress text-only and removes reintroduced spinners', () => {
    const spinner = document.createElement('span');
    spinner.className = 'material-elastic-spinner header-loading-spinner';
    document.getElementById('main-header')?.appendChild(spinner);

    showLoader(true, 'Uploading 1/3');

    expect(document.querySelector('#main-header .material-elastic-spinner')).toBeNull();
    expect(headerLoaderText()).toBe('Uploading 1/3');
  });

  it('adds loading class when show=true', () => {
    showLoader(true, 'Loading...');
    const header = document.getElementById('main-header')!;
    expect(header.classList.contains('loading')).toBe(true);
  });

  it('sets loading text', () => {
    showLoader(true, 'Downloading...');
    expect(headerLoaderText()).toBe('Downloading...');
  });

  it('removes loading class when show=false', () => {
    showLoader(true, 'Loading...');
    showLoader(false);
    const header = document.getElementById('main-header')!;
    expect(header.classList.contains('loading')).toBe(false);
  });

  it('resets progress bar transform after 400ms delay on hide', () => {
    showLoader(true);
    updateLoader(75);
    showLoader(false);

    expectHeaderProgress(75);

    vi.advanceTimersByTime(400);
    expectHeaderProgress(0);
  });

  it('clears reset timer when showing again quickly', () => {
    showLoader(true);
    updateLoader(50);
    showLoader(false);
    vi.advanceTimersByTime(200);

    showLoader(true);
    vi.advanceTimersByTime(400);

    expect(headerProgressPercent()).not.toBe(0);
  });

  it('preserves background holder state and restores it after the foreground hides', () => {
    showLoader(true, 'Uploading...', 'loader-a');
    updateLoader(20, 'loader-a');
    showLoader(true, 'Downloading...', 'loader-b');
    updateLoader(70, 'loader-b');

    // Background progress is retained without repainting the foreground.
    updateLoader(45, 'loader-a');
    expect(headerLoaderText()).toBe('Downloading...');
    expectHeaderProgress(70);

    showLoader(false, undefined, 'loader-b');
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(headerLoaderText()).toBe('Uploading...');
    expectHeaderProgress(45);
  });

  it('does not let a background holder hide the foreground holder', () => {
    showLoader(true, 'Uploading...', 'loader-a');
    showLoader(true, 'Downloading...', 'loader-b');

    showLoader(false, undefined, 'loader-a');

    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(headerLoaderText()).toBe('Downloading...');
  });

  it('does not promote a background holder when it reports new text or progress', () => {
    showLoader(true, 'Upload A', 'loader-a');
    updateLoader(25, 'loader-a');
    showLoader(true, 'Download B', 'loader-b');
    updateLoader(10, 'loader-b');

    showLoader(true, 'Upload A 50%', 'loader-a');
    updateLoader(50, 'loader-a');

    expect(headerLoaderText()).toBe('Download B');
    expectHeaderProgress(10);

    showLoader(false, undefined, 'loader-b');
    expect(headerLoaderText()).toBe('Upload A 50%');
    expectHeaderProgress(50);
  });
});

describe('header loader layout contract', () => {
  it('forbids loading spinners throughout the app header', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const headerSpinnerRules =
      stylesheet.match(
        /#main-header \.material-elastic-spinner,\s*#main-header \.header-loading-spinner\s*\{([^}]*)\}/,
      )?.[1] ?? '';

    expect(headerSpinnerRules).toMatch(/display:\s*none\s*!important;/);
    expect(stylesheet).not.toMatch(/header\.loading \.header-loading-spinner/);
  });

  it('keeps the portrait loading text on the logo rail below the iOS safe area', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const compactStart = stylesheet.indexOf('@media (min-width: 720px) and (max-width: 1279px) {');
    expect(compactStart).toBeGreaterThanOrEqual(0);

    const baseStyles = stylesheet.slice(0, compactStart);
    const headerRules = baseStyles.match(/\n\s*header\s*\{([^}]*)\}/)?.[1] ?? '';
    const baseLoaderRules = baseStyles.match(/\.header-loading-text\s*\{([^}]*)\}/)?.[1] ?? '';

    // The fixed header includes the iOS status-bar inset in its total height,
    // while its logo is centered only inside the content area below that inset.
    // The loader must use that same vertical rail instead of centering across
    // the status bar (which would move it up by half the safe-area height).
    expect(headerRules).toMatch(/height:\s*var\(--header-height\);/);
    expect(headerRules).toMatch(/padding:\s*var\(--safe-top\)/);
    expect(baseLoaderRules).toMatch(/top:\s*var\(--safe-top\);/);
    expect(baseLoaderRules).toMatch(/height:\s*calc\(100% - var\(--safe-top\)\);/);
  });

  it('uses the whole header while preserving a single-line compact sidebar rail', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    expect(parsed.getElementById('header-loading-text')?.parentElement?.id).toBe('main-header');
    expect(
      parsed.querySelector('#header-loading-text > .header-loading-text-content')?.textContent,
    ).toBe('Loading...');

    const compactStart = stylesheet.indexOf('@media (min-width: 720px) and (max-width: 1279px) {');
    const compactEnd = stylesheet.indexOf('/* iPad PWA portrait', compactStart);
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);

    const baseLoaderRules =
      stylesheet.slice(0, compactStart).match(/\.header-loading-text\s*\{([^}]*)\}/)?.[1] ?? '';
    const compactStyles = stylesheet.slice(compactStart, compactEnd);
    const compactLoaderRules =
      compactStyles.match(/\.header-loading-text\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(baseLoaderRules).toMatch(/left:\s*calc\(24px \+ var\(--safe-left\)\);/);
    expect(baseLoaderRules).toMatch(/right:\s*calc\(24px \+ var\(--safe-right\)\);/);
    expect(baseLoaderRules).toMatch(/width:\s*auto;/);
    expect(compactLoaderRules).toMatch(/top:\s*calc\(10px \+ var\(--safe-top\)\)\s*!important;/);
    expect(compactLoaderRules).toMatch(/left:\s*29px\s*!important;/);
    expect(compactLoaderRules).toMatch(
      /right:\s*calc\(16px \+ var\(--safe-right\)\)\s*!important;/,
    );
    expect(compactLoaderRules).toMatch(/width:\s*auto\s*!important;/);
    expect(compactLoaderRules).toMatch(/height:\s*54px\s*!important;/);
    expect(compactLoaderRules).toMatch(/line-height:\s*18px;/);
    expect(compactLoaderRules).toMatch(/white-space:\s*nowrap;/);
    expect(compactLoaderRules).toMatch(/overflow-wrap:\s*normal;/);
    // Unlike the portrait header, the compact header is the full-height
    // sidebar. A downward exit would therefore stay visible across its nav;
    // moving through the sidebar's clipped top edge keeps the swap on the
    // logo rail.
    expect(compactStyles.match(/\n\s*header\s*\{([^}]*)\}/)?.[1] ?? '').toMatch(
      /overflow:\s*hidden\s*!important;/,
    );
    expect(compactLoaderRules).toMatch(/transform:\s*translateY\(-100%\);/);
    expect(compactLoaderRules).not.toMatch(/transform:\s*translateY\(100%\);/);
  });

  it('keeps every responsive header loader on one line with ellipsis overflow', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const loaderRuleBodies = [...stylesheet.matchAll(/\.header-loading-text\s*\{([^}]*)\}/g)].map(
      (match) => match[1] ?? '',
    );
    const baseLoaderRules = loaderRuleBodies[0] ?? '';
    const contentRules = stylesheet.match(/\.header-loading-text-content\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(baseLoaderRules).toMatch(/white-space:\s*nowrap;/);
    expect(baseLoaderRules).toMatch(/overflow:\s*hidden;/);
    expect(contentRules).toMatch(/flex:\s*1 1 auto;/);
    expect(contentRules).toMatch(/min-width:\s*0;/);
    expect(contentRules).toMatch(/max-width:\s*100%;/);
    expect(contentRules).toMatch(/overflow:\s*hidden;/);
    expect(contentRules).toMatch(/white-space:\s*nowrap;/);
    expect(contentRules).toMatch(/text-overflow:\s*ellipsis;/);
    expect(loaderRuleBodies.some((rules) => /white-space:\s*normal;/.test(rules))).toBe(false);
    expect(loaderRuleBodies.some((rules) => /overflow-wrap:\s*anywhere;/.test(rules))).toBe(false);
  });

  it('uses a full-width compositor fill without a width transition', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const progressRules = stylesheet.match(/\.header-progress-bg\s*\{([^}]*)\}/)?.[1] ?? '';
    const logoRules = stylesheet.match(/\.header-default-content\s*\{([^}]*)\}/)?.[1] ?? '';
    const loadingTextRules = stylesheet.match(/\.header-loading-text\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(progressRules).toMatch(/width:\s*100%;/);
    expect(progressRules).toMatch(/transform:\s*scaleX\(0\);/);
    expect(progressRules).toMatch(/transform-origin:\s*left center;/);
    expect(progressRules).toMatch(/will-change:\s*transform;/);
    expect(progressRules).toMatch(/transition:\s*opacity 0\.4s ease;/);
    expect(progressRules).not.toMatch(/transition:[^;]*width/);
    expect(logoRules).toMatch(/transform 1s cubic-bezier\(0\.08, 0\.82, 0\.17, 1\)/);
    expect(loadingTextRules).toMatch(/transform 1s cubic-bezier\(0\.08, 0\.82, 0\.17, 1\)/);
  });
});

describe('updateLoader', () => {
  it('sets progress bar transform percentage', () => {
    updateLoader(50);
    expectHeaderProgress(50);
  });

  it('sets 100% scale', () => {
    updateLoader(100);
    expectHeaderProgress(100);
  });

  it('sets 0% scale', () => {
    updateLoader(0);
    expectHeaderProgress(0);
  });

  it('keeps default progress behind an explicitly named foreground holder', () => {
    showLoader(true, 'Preparing...');
    updateLoader(20);
    showLoader(true, 'Uploading...', 'remote-upload');
    updateLoader(40);

    expect(headerLoaderText()).toBe('Uploading...');
    expectHeaderProgress(0);

    showLoader(false, undefined, 'remote-upload');
    expect(headerLoaderText()).toBe('Preparing...');
    expectHeaderProgress(40);
  });

  it('ignores an unowned no-ID update while a named holder owns the surface', () => {
    showLoader(true, 'Named operation', 'loader-a');
    updateLoader(20, 'loader-a');

    updateLoader(85);

    expectHeaderProgress(20);
  });

  it('ignores a late explicit update after its holder was removed', () => {
    showLoader(true, 'Old operation', 'removed-loader');
    updateLoader(25, 'removed-loader');
    showLoader(false, undefined, 'removed-loader');
    vi.advanceTimersByTime(400);

    updateLoader(90, 'removed-loader');

    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(false);
    expectHeaderProgress(0);
  });

  it('follows targets with a time-normalized 160ms EMA without restarting in flight', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Loading...', 'loader-a');
    updateLoader(80, 'loader-a');

    expectHeaderProgress(0);
    expect(raf.pending()).toBe(1);

    const start = performance.now();
    const firstTimestamp = start + 1000 / 120;
    raf.step(firstTimestamp);
    const firstAlpha = 1 - Math.exp(-(1000 / 120) / 160);
    const firstProgress = 80 * firstAlpha;
    expect(headerProgressPercent()).toBeCloseTo(firstProgress, 4);

    // A new target reuses the existing time origin instead of starting a new
    // CSS easing curve. One 120 Hz frame therefore advances by one 120 Hz dt.
    updateLoader(60, 'loader-a');
    expect(raf.pending()).toBe(1);
    raf.step(firstTimestamp + 1000 / 120);
    const secondProgress = firstProgress + (60 - firstProgress) * firstAlpha;
    expect(headerProgressPercent()).toBeCloseTo(secondProgress, 4);
    expect(raf.request).toHaveBeenCalledTimes(3);
  });

  it('only keeps an animation frame while a visual gap remains', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Loading...', 'loader-a');

    updateLoader(50, 'loader-a');
    updateLoader(75, 'loader-a');
    expect(raf.pending()).toBe(1);

    let timestamp = performance.now();
    for (let frame = 0; frame < 200 && raf.pending() > 0; frame += 1) {
      timestamp += 1000 / 60;
      raf.step(timestamp);
    }

    expectHeaderProgress(75);
    expect(raf.pending()).toBe(0);
  });

  it('smoothly follows legitimate downward targets', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Loading...', 'loader-a');
    const start = performance.now();
    updateLoader(100, 'loader-a');
    expectHeaderProgress(0);
    raf.step(start + 160);
    const firstProgress = 100 * (1 - Math.exp(-1));
    expect(headerProgressPercent()).toBeCloseTo(firstProgress, 4);

    updateLoader(25, 'loader-a');
    expect(raf.pending()).toBe(1);
    raf.step(start + 320);

    const expected = firstProgress + (25 - firstProgress) * (1 - Math.exp(-1));
    expect(headerProgressPercent()).toBeCloseTo(expected, 4);
    expect(headerProgressPercent()).toBeGreaterThan(25);
    expect(headerProgressPercent()).toBeLessThan(firstProgress);
  });

  it('uses the restored foreground target when an older frame is already pending', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Background A', 'loader-a');
    updateLoader(20, 'loader-a');
    showLoader(true, 'Foreground B', 'loader-b');
    updateLoader(80, 'loader-b');
    updateLoader(40, 'loader-a');
    expect(raf.pending()).toBe(1);

    showLoader(false, undefined, 'loader-b');
    const start = performance.now();
    raf.step(start + 160);

    expect(headerLoaderText()).toBe('Background A');
    expect(headerProgressPercent()).toBeGreaterThan(0);
    expect(headerProgressPercent()).toBeLessThan(40);
  });

  it('cancels an old surface frame when the progress element is replaced', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Loading...', 'loader-a');
    updateLoader(70, 'loader-a');
    const oldProgress = document.getElementById('header-progress-bg')!;
    expect(raf.pending()).toBe(1);

    const replacement = document.createElement('div');
    replacement.id = 'header-progress-bg';
    replacement.style.transform = 'scaleX(0)';
    oldProgress.replaceWith(replacement);
    updateLoader(40, 'loader-a');

    expect(raf.cancel).toHaveBeenCalledOnce();
    expect(raf.pending()).toBe(1);
    const start = performance.now();
    raf.step(start + 160);
    expect(
      Number.parseFloat(replacement.style.transform.match(/\(([^)]+)\)/)?.[1] ?? '0'),
    ).toBeCloseTo(0.4 * (1 - Math.exp(-1)), 5);
    expect(oldProgress.style.transform).toBe('scaleX(0)');
  });

  it('follows terminal completion with the same EMA through hide and delayed reset', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Loading...', 'loader-a');
    updateLoader(90, 'loader-a');

    let timestamp = performance.now();
    for (let frame = 0; frame < 200 && raf.pending() > 0; frame += 1) {
      timestamp += 1000 / 60;
      raf.step(timestamp);
    }
    expectHeaderProgress(90);
    expect(raf.pending()).toBe(0);

    updateLoader(100, 'loader-a');
    expectHeaderProgress(90);
    expect(raf.pending()).toBe(1);

    showLoader(false, undefined, 'loader-a');
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(false);
    expectHeaderProgress(90);
    expect(raf.pending()).toBe(1);

    const completionStart = performance.now();
    raf.step(completionStart + 160);
    const afterOneTau = 90 + (100 - 90) * (1 - Math.exp(-1));
    expect(headerProgressPercent()).toBeCloseTo(afterOneTau, 4);
    expect(headerProgressPercent()).toBeLessThan(100);

    raf.step(completionStart + 399);
    const beforeReset = 90 + (100 - 90) * (1 - Math.exp(-399 / 160));
    expect(headerProgressPercent()).toBeCloseTo(beforeReset, 4);
    expect(raf.pending()).toBe(1);

    vi.advanceTimersByTime(399);
    expect(headerProgressPercent()).toBeCloseTo(beforeReset, 4);
    vi.advanceTimersByTime(1);
    expectHeaderProgress(0);
    expect(raf.pending()).toBe(0);
  });

  it('keeps one frame and time origin for duplicate visible completion targets', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Loading...', 'loader-a');
    const start = performance.now();

    updateLoader(100, 'loader-a');
    expectHeaderProgress(0);
    expect(raf.pending()).toBe(1);
    raf.step(start + 80);
    const afterHalfTau = 100 * (1 - Math.exp(-0.5));
    expect(headerProgressPercent()).toBeCloseTo(afterHalfTau, 4);

    const requestsBeforeDuplicate = raf.request.mock.calls.length;
    updateLoader(100, 'loader-a');
    expect(headerProgressPercent()).toBeCloseTo(afterHalfTau, 4);
    expect(raf.pending()).toBe(1);
    expect(raf.request).toHaveBeenCalledTimes(requestsBeforeDuplicate);

    raf.step(start + 160);
    expect(headerProgressPercent()).toBeCloseTo(100 * (1 - Math.exp(-1)), 4);
  });

  it('retargets the active terminal frame when a new holder opens during the fade', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Finishing', 'loader-a');
    updateLoader(90, 'loader-a');

    let timestamp = performance.now();
    for (let frame = 0; frame < 200 && raf.pending() > 0; frame += 1) {
      timestamp += 1000 / 60;
      raf.step(timestamp);
    }
    expectHeaderProgress(90);

    updateLoader(100, 'loader-a');
    showLoader(false, undefined, 'loader-a');
    const completionStart = performance.now();
    raf.step(completionStart + 160);
    const terminalDisplayed = 90 + (100 - 90) * (1 - Math.exp(-1));
    expect(headerProgressPercent()).toBeCloseTo(terminalDisplayed, 4);

    vi.advanceTimersByTime(200);
    const requestsBeforeReopen = raf.request.mock.calls.length;
    showLoader(true, 'Next operation', 'loader-b');
    updateLoader(30, 'loader-b');
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
    expect(headerProgressPercent()).toBeCloseTo(terminalDisplayed, 4);
    expect(raf.pending()).toBe(1);
    expect(raf.request).toHaveBeenCalledTimes(requestsBeforeReopen);

    raf.step(completionStart + 320);
    const retargeted = terminalDisplayed + (30 - terminalDisplayed) * (1 - Math.exp(-1));
    expect(headerProgressPercent()).toBeCloseTo(retargeted, 4);
    expect(headerProgressPercent()).toBeGreaterThan(30);

    // The new show cancels the old completion reset rather than zeroing the
    // active operation when the original 400 ms deadline arrives.
    vi.advanceTimersByTime(400);
    expect(headerProgressPercent()).toBeCloseTo(retargeted, 4);
    expect(document.getElementById('main-header')!.classList.contains('loading')).toBe(true);
  });

  it('restores a background holder without flashing terminal 100', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Background', 'loader-a');
    updateLoader(40, 'loader-a');

    let timestamp = performance.now();
    for (let frame = 0; frame < 200 && raf.pending() > 0; frame += 1) {
      timestamp += 1000 / 60;
      raf.step(timestamp);
    }
    expectHeaderProgress(40);

    showLoader(true, 'Foreground', 'loader-b');
    updateLoader(90, 'loader-b');
    const foregroundStart = performance.now();
    raf.step(foregroundStart + 160);
    const foregroundDisplayed = 40 + (90 - 40) * (1 - Math.exp(-1));
    expect(headerProgressPercent()).toBeCloseTo(foregroundDisplayed, 4);

    updateLoader(100, 'loader-b');
    expect(headerProgressPercent()).toBeCloseTo(foregroundDisplayed, 4);
    showLoader(false, undefined, 'loader-b');
    expect(headerLoaderText()).toBe('Background');
    expect(headerProgressPercent()).toBeCloseTo(foregroundDisplayed, 4);

    raf.step(foregroundStart + 320);
    const restored = foregroundDisplayed + (40 - foregroundDisplayed) * (1 - Math.exp(-1));
    expect(headerProgressPercent()).toBeCloseTo(restored, 4);
    expect(headerProgressPercent()).toBeGreaterThan(40);
    expect(headerProgressPercent()).toBeLessThan(foregroundDisplayed);
  });

  it('clamps progress while preserving legitimate holder decreases', () => {
    showLoader(true, 'Loading...', 'loader-a');

    updateLoader(-20, 'loader-a');
    expectHeaderProgress(0);
    updateLoader(180, 'loader-a');
    expectHeaderProgress(100);
    updateLoader(25, 'loader-a');
    expectHeaderProgress(25);
  });

  it('keeps a pre-holder compatibility tick across an immediate show', () => {
    const raf = installAnimationFrameHarness();

    updateLoader(55);
    expectHeaderProgress(55);
    expect(raf.pending()).toBe(0);

    showLoader(true, 'Loading...');
    expectHeaderProgress(55);
    expect(raf.pending()).toBe(0);
  });

  it('retains an unpainted target through hide and a quick reopen', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'First');
    updateLoader(65);
    expect(raf.pending()).toBe(1);

    showLoader(false);
    // The fill keeps converging under the 400 ms opacity fade. A quick reopen
    // therefore resumes the same time origin instead of losing the target.
    expect(raf.pending()).toBe(1);
    vi.advanceTimersByTime(200);
    showLoader(true, 'Second');
    expect(raf.pending()).toBe(1);

    const start = performance.now();
    raf.step(start + 160);
    expect(headerProgressPercent()).toBeGreaterThan(40);
    vi.advanceTimersByTime(400);
    expect(headerProgressPercent()).toBeGreaterThan(40);
  });

  it('snaps without scheduling frames for reduced motion or background tabs', () => {
    const raf = installAnimationFrameHarness();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    showLoader(true, 'Reduced', 'loader-a');
    updateLoader(45, 'loader-a');
    expectHeaderProgress(45);
    expect(raf.request).not.toHaveBeenCalled();

    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    updateLoader(70, 'loader-a');
    expectHeaderProgress(70);
    expect(raf.request).not.toHaveBeenCalled();
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  });

  it('finishes an active visual target when the page moves to the background', () => {
    const raf = installAnimationFrameHarness();
    showLoader(true, 'Loading...', 'loader-a');
    updateLoader(65, 'loader-a');
    expect(raf.pending()).toBe(1);

    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));

    expectHeaderProgress(65);
    expect(raf.pending()).toBe(0);
    expect(raf.cancel).toHaveBeenCalledOnce();
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  });

  it('snaps safely when requestAnimationFrame is unavailable', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('cancelAnimationFrame', undefined);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    showLoader(true, 'Fallback', 'loader-a');

    updateLoader(35, 'loader-a');

    expectHeaderProgress(35);
  });
});
