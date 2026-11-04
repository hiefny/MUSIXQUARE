/**
 * @vitest-environment jsdom
 */
/**
 * The `/debug sync` window (Phase 7 7A-1): the footer names the tab storage
 * the previous page's audio recovery totals come from (owner decision Q4),
 * and Chrome's output underruns are read once, when the window opens
 * (owner decision Q3 b), however often the window refreshes.
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

const recorder = vi.hoisted(() => ({
  readChromeOutputUnderruns: vi.fn<() => number | null>(() => 3),
  collectSyncFlightRecorderText: vi.fn((underruns: number | null = null) => `report ${underruns}`),
  markSyncFlightRecorderIncident: vi.fn(),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: timerMocks.setManagedTimer,
  clearManagedTimer: timerMocks.clearManagedTimer,
}));
vi.mock('../../ui/chat-render.ts', () => ({ addSystemChatMessage: vi.fn() }));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../../diagnostics/sync-flight-recorder.ts', () => recorder);

import { cmdDebug } from '../debug-console.ts';

async function flush(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

beforeEach(() => {
  timerMocks.callbacks.clear();
  recorder.readChromeOutputUnderruns.mockClear();
  recorder.readChromeOutputUnderruns.mockReturnValue(3);
  recorder.collectSyncFlightRecorderText.mockClear();
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  document.body.innerHTML = '';
});

describe('/debug sync', () => {
  it('says the window also reads tab storage', async () => {
    cmdDebug(['sync']);
    await flush();
    const overlay = document.getElementById('debug-sync-flight-overlay');
    expect(overlay?.querySelector('.debug-memory-hint')?.textContent).toBe(
      'tap edge / ESC to close | RAM + tab storage | copied once',
    );
  });

  it('reads the output underruns once, when it opens, and shows that reading on every refresh', async () => {
    cmdDebug(['sync']);
    await flush();
    recorder.readChromeOutputUnderruns.mockReturnValue(99);
    const refresh = timerMocks.callbacks.get('debug-text-overlay-poll');
    expect(refresh).toBeTypeOf('function');
    for (let second = 0; second < 3; second += 1) {
      refresh!();
      await flush();
    }

    expect(recorder.readChromeOutputUnderruns).toHaveBeenCalledTimes(1);
    expect(recorder.collectSyncFlightRecorderText.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(recorder.collectSyncFlightRecorderText.mock.calls.map(([n]) => n))).toEqual(
      new Set([3]),
    );
    expect(document.querySelector('#debug-sync-flight-overlay pre')?.textContent).toBe('report 3');
  });

  it('reads again when the window opens again', async () => {
    cmdDebug(['sync']);
    await flush();
    recorder.readChromeOutputUnderruns.mockReturnValue(null);
    cmdDebug(['sync']);
    await flush();
    expect(recorder.readChromeOutputUnderruns).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#debug-sync-flight-overlay pre')?.textContent).toBe(
      'report null',
    );
  });
});
