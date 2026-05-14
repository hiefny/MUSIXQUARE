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
  let recover: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    now = 1_000;
    handle = null;
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
      recover,
      warn,
      getNow: () => now,
      longHiddenMs,
    });
  }

  it('does nothing when hidden time is below a custom threshold', async () => {
    const threshold = 10_000;
    init(threshold);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += threshold - 1;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('recovers and warns immediately after the page returns from the background', async () => {
    init();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).toHaveBeenCalledWith({ hiddenMs: 0 });
    expect(warn).toHaveBeenCalledWith({ hiddenMs: 0 });
  });

  it('recovers and warns after a hidden interval', async () => {
    const hiddenMs = 2_500;
    init();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += hiddenMs;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).toHaveBeenCalledWith({ hiddenMs });
    expect(warn).toHaveBeenCalledWith({ hiddenMs });
  });

  it('detaches the visibility listener on dispose', async () => {
    init();
    handle?.dispose();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += 2_500;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
