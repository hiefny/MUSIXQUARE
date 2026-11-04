/**
 * @vitest-environment jsdom
 */
/**
 * The COPY button of the /debug text overlays (owner decision 2026-11-04).
 * iPhone Safari refuses the one-shot copy that runs when an overlay opens: it
 * starts after the console's lazy import and an await, when the tap that sent
 * the command is over. COPY copies the text on screen inside its own tap: the
 * Clipboard API write starts before any await, and where the API is missing,
 * throws or rejects, a hidden textarea copies with execCommand('copy') in the
 * same tap. The button then reads COPIED, or COPY FAILED, because a toast
 * would sit under the overlay. The copy on open stays as it was, except that
 * it no longer replaces what a tap already copied. A tap before the first
 * sample is on screen copies nothing. The COPY click reaches the page like
 * any button click, and focus that a click put on COPY goes back to where it
 * was when the overlay closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const timerMocks = vi.hoisted(() => {
  const callbacks = new Map<string, () => unknown>();
  return {
    callbacks,
    setManagedTimer: vi.fn((name: string, callback: () => unknown) => {
      callbacks.set(name, callback);
    }),
    clearManagedTimer: vi.fn((name: string) => {
      callbacks.delete(name);
    }),
  };
});

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  writeText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
  report: { text: 'report 1' },
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: timerMocks.setManagedTimer,
  clearManagedTimer: timerMocks.clearManagedTimer,
}));
vi.mock('../../ui/chat-render.ts', () => ({ addSystemChatMessage: vi.fn() }));
vi.mock('../../ui/toast.ts', () => ({ showToast: mocks.showToast }));
vi.mock('../../diagnostics/sync-flight-recorder.ts', () => ({
  readChromeOutputUnderruns: vi.fn(() => null),
  collectSyncFlightRecorderText: vi.fn(() => mocks.report.text),
  markSyncFlightRecorderIncident: vi.fn(),
}));
vi.mock('../../network/system-audio-debug.ts', () => ({
  collectSystemAudioDebugText: vi.fn(async () => 'system audio report'),
}));

import { collectSystemAudioDebugText } from '../../network/system-audio-debug.ts';
import { cmdDebug } from '../debug-console.ts';

interface ExecCall {
  readonly command: string;
  readonly value: string | null;
  readonly readOnly: boolean | null;
}

const execCalls: ExecCall[] = [];
let execResult = true;

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

function installClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

function overlay(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`${id} is not open`);
  return element;
}

function copyButton(id: string): HTMLButtonElement {
  const button = overlay(id).querySelector<HTMLButtonElement>(
    '.onboarding-diagnostics-actions > button.onboarding-diagnostics-action',
  );
  if (!button) throw new Error(`${id} has no COPY button`);
  return button;
}

async function openSync(): Promise<HTMLButtonElement> {
  cmdDebug(['sync']);
  await flushMicrotasks();
  return copyButton('debug-sync-flight-overlay');
}

/**
 * Holds the next two system audio samples, which the overlay asks for when it
 * opens: the first refresh's, then the copy on open's. Each call of the
 * returned function hands out the next one.
 */
function holdSystemAudioSamples(): (text: string) => void {
  const pending: Array<(text: string) => void> = [];
  const held = () =>
    new Promise<string>((resolve) => {
      pending.push(resolve);
    });
  vi.mocked(collectSystemAudioDebugText).mockImplementationOnce(held).mockImplementationOnce(held);
  return (text) => {
    const release = pending.shift();
    if (!release) throw new Error('no system audio sample is waiting');
    release(text);
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  timerMocks.callbacks.clear();
  mocks.showToast.mockClear();
  mocks.writeText.mockReset();
  mocks.writeText.mockImplementation(() => Promise.resolve());
  mocks.report.text = 'report 1';
  installClipboard({ writeText: mocks.writeText });
  execCalls.length = 0;
  execResult = true;
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (command: string) => {
      const active = document.activeElement;
      execCalls.push({
        command,
        value: active instanceof HTMLTextAreaElement ? active.value : null,
        readOnly: active instanceof HTMLTextAreaElement ? active.readOnly : null,
      });
      return execResult;
    },
  });
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'execCommand');
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('/debug overlay COPY', () => {
  it('sits below the text of every text overlay, named COPY', async () => {
    for (const [sub, id] of [
      ['console', 'debug-console-overlay'],
      ['sync', 'debug-sync-flight-overlay'],
      ['screen', 'debug-screen-overlay'],
      ['sa', 'debug-system-audio-overlay'],
    ] as const) {
      cmdDebug([sub]);
      await flushMicrotasks();
      const element = overlay(id);
      const button = copyButton(id);
      expect(button.type, id).toBe('button');
      expect(button.textContent, id).toBe('COPY');
      expect(element.querySelector('pre')?.nextElementSibling, id).toBe(button.parentElement);
      expect(button.parentElement?.nextElementSibling?.className, id).toBe('debug-memory-hint');
    }
    expect(document.querySelectorAll('.onboarding-diagnostics-action')).toHaveLength(1);
  });

  it('keeps the copy when the overlay opens', async () => {
    cmdDebug(['sync']);
    await flushMicrotasks();
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith('report 1');
    expect(mocks.showToast).toHaveBeenCalledOnce();
  });

  it('writes the text on screen at the moment of the tap before any await', async () => {
    const button = await openSync();
    mocks.report.text = 'report 2';
    timerMocks.callbacks.get('debug-text-overlay-poll')?.();
    await flushMicrotasks();
    expect(overlay('debug-sync-flight-overlay').querySelector('pre')?.textContent).toBe('report 2');
    mocks.writeText.mockClear();

    button.click();
    // Called inside the click, before the listener returned.
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith('report 2');
    expect(button.textContent).toBe('COPY');
    await flushMicrotasks();
    expect(button.textContent).toBe('COPIED');
    expect(execCalls).toEqual([]);
    expect(document.getElementById('debug-sync-flight-overlay')).not.toBeNull();
  });

  it('copies with a hidden textarea inside the tap when the Clipboard API rejects', async () => {
    const button = await openSync();
    mocks.writeText.mockImplementation(() =>
      Promise.reject(new DOMException('Not allowed', 'NotAllowedError')),
    );
    button.focus();
    let macrotaskRan = false;
    setTimeout(() => {
      macrotaskRan = true;
    }, 0);

    button.click();
    await flushMicrotasks();

    // In the microtasks right after the click listener, before any task.
    expect(macrotaskRan).toBe(false);
    expect(execCalls).toEqual([{ command: 'copy', value: 'report 1', readOnly: true }]);
    expect(button.textContent).toBe('COPIED');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('copies with a hidden textarea at once when the Clipboard API is missing or throws', async () => {
    const button = await openSync();
    installClipboard(undefined);
    button.click();
    expect(execCalls).toEqual([{ command: 'copy', value: 'report 1', readOnly: true }]);
    expect(button.textContent).toBe('COPIED');

    installClipboard({
      writeText: () => {
        throw new TypeError('blocked');
      },
    });
    button.textContent = 'COPY';
    button.click();
    expect(execCalls).toHaveLength(2);
    expect(button.textContent).toBe('COPIED');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('says COPY FAILED when neither way copies', async () => {
    const button = await openSync();
    mocks.writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    execResult = false;
    button.click();
    await flushMicrotasks();
    expect(execCalls).toHaveLength(1);
    expect(button.textContent).toBe('COPY FAILED');
  });

  it('leaves the tap-to-close screen overlay open', async () => {
    cmdDebug(['screen']);
    await flushMicrotasks();
    const button = copyButton('debug-screen-overlay');
    button.click();
    await flushMicrotasks();
    expect(document.getElementById('debug-screen-overlay')).not.toBeNull();
    expect(button.textContent).toBe('COPIED');

    overlay('debug-screen-overlay').click();
    expect(document.getElementById('debug-screen-overlay')).toBeNull();
  });

  it('copies nothing while no sample is on screen yet', async () => {
    const nextSample = holdSystemAudioSamples();
    cmdDebug(['sa']);
    await flushMicrotasks();
    const button = copyButton('debug-system-audio-overlay');
    expect(overlay('debug-system-audio-overlay').querySelector('pre')?.textContent).toBe('');

    // An empty copy would wipe the clipboard and still read COPIED.
    button.click();
    await flushMicrotasks();
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(execCalls).toEqual([]);
    expect(button.textContent).toBe('COPY');

    nextSample('sample 1');
    await flushMicrotasks();
    button.click();
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith('sample 1');
    await flushMicrotasks();
    expect(button.textContent).toBe('COPIED');
  });

  it('keeps what a tap copied when the copy on open finishes later', async () => {
    const nextSample = holdSystemAudioSamples();
    cmdDebug(['sa']);
    await flushMicrotasks();
    const button = copyButton('debug-system-audio-overlay');
    nextSample('sample 1');
    await flushMicrotasks();
    button.click();
    await flushMicrotasks();
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith('sample 1');
    expect(button.textContent).toBe('COPIED');

    // The copy on open collects its own sample, which can arrive after the tap.
    nextSample('sample 1, collected again');
    await flushMicrotasks();
    expect(mocks.writeText).toHaveBeenCalledOnce();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('still copies on open when no tap came first', async () => {
    const nextSample = holdSystemAudioSamples();
    cmdDebug(['sa']);
    nextSample('sample 1');
    nextSample('sample 1, collected again');
    await flushMicrotasks();
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith('sample 1, collected again');
    expect(mocks.showToast).toHaveBeenCalledOnce();
  });

  it('lets the COPY click reach the page, as every button click does', async () => {
    cmdDebug(['screen']);
    await flushMicrotasks();
    const button = copyButton('debug-screen-overlay');
    const reached: Array<EventTarget | null> = [];
    const onClick = (event: Event): void => {
      reached.push(event.target);
    };
    // src/audio/ui-sounds.ts plays the button sound from a document listener.
    document.addEventListener('click', onClick);
    try {
      button.click();
      await flushMicrotasks();
    } finally {
      document.removeEventListener('click', onClick);
    }
    expect(reached).toEqual([button]);
    // The tap-to-close screen overlay still stays open.
    expect(document.getElementById('debug-screen-overlay')).not.toBeNull();
    expect(button.textContent).toBe('COPIED');
  });

  it('gives focus back to where it was when the overlay closes with focus inside', async () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    const button = await openSync();
    // Chromium and Firefox on Windows focus a button when it is clicked.
    button.focus();
    button.click();
    await flushMicrotasks();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('debug-sync-flight-overlay')).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('leaves focus alone when it is outside the overlay at close', async () => {
    const field = document.createElement('input');
    const other = document.createElement('input');
    document.body.append(field, other);
    field.focus();
    await openSync();
    other.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('debug-sync-flight-overlay')).toBeNull();
    expect(document.activeElement).toBe(other);
  });

  it('drops a result that arrives after the overlay closed', async () => {
    const button = await openSync();
    let settle: (() => void) | undefined;
    mocks.writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = () => resolve();
        }),
    );
    button.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('debug-sync-flight-overlay')).toBeNull();
    expect(settle).toBeTypeOf('function');
    settle?.();
    await flushMicrotasks();
    expect(button.textContent).toBe('COPY');
  });
});
