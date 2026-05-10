/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LONG_BACKGROUND_RESUME_MS,
  initBackgroundResumeGuard,
  type BackgroundResumeGuardHandle,
} from '../background-resume-guard.ts';

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('initBackgroundResumeGuard', () => {
  let now: number;
  let handle: BackgroundResumeGuardHandle | null;
  let atRisk: boolean;
  let recover: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    now = 1_000;
    handle = null;
    atRisk = true;
    recover = vi.fn();
    warn = vi.fn();
    setVisibility('visible');
  });

  afterEach(() => {
    handle?.dispose();
    setVisibility('visible');
  });

  function init(longHiddenMs = DEFAULT_LONG_BACKGROUND_RESUME_MS): void {
    handle = initBackgroundResumeGuard({
      isAtRisk: () => atRisk,
      recover,
      warn,
      getNow: () => now,
      longHiddenMs,
    });
  }

  it('does nothing when hidden time is below the threshold', async () => {
    init();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += DEFAULT_LONG_BACKGROUND_RESUME_MS - 1;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('recovers and warns after a long hidden interval while at risk', async () => {
    init();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += DEFAULT_LONG_BACKGROUND_RESUME_MS;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).toHaveBeenCalledWith({ hiddenMs: DEFAULT_LONG_BACKGROUND_RESUME_MS });
    expect(warn).toHaveBeenCalledWith({ hiddenMs: DEFAULT_LONG_BACKGROUND_RESUME_MS });
  });

  it('tracks hidden time even if risk appears while hidden', async () => {
    atRisk = false;
    init();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += DEFAULT_LONG_BACKGROUND_RESUME_MS;
    atRisk = true;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).toHaveBeenCalledWith({ hiddenMs: DEFAULT_LONG_BACKGROUND_RESUME_MS });
    expect(warn).toHaveBeenCalledWith({ hiddenMs: DEFAULT_LONG_BACKGROUND_RESUME_MS });
  });

  it('skips warning when risk disappears before resume', async () => {
    init();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += DEFAULT_LONG_BACKGROUND_RESUME_MS;
    atRisk = false;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('detaches the visibility listener on dispose', async () => {
    init();
    handle?.dispose();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += DEFAULT_LONG_BACKGROUND_RESUME_MS;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
