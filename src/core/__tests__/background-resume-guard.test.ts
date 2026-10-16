/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  DEFAULT_RECOVER_THRESHOLD_MS,
  DEFAULT_WARN_THRESHOLD_MS,
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

interface InitOptions {
  recoverThresholdMs?: number;
  warnThresholdMs?: number;
  shouldHandle?: (event: { hiddenMs: number }) => boolean;
}

type ResumeCallback = (event: { hiddenMs: number }) => void | Promise<void>;

describe('initBackgroundResumeGuard', () => {
  let now: number;
  let handle: BackgroundResumeGuardHandle | null;
  let recover: Mock<ResumeCallback>;
  let warn: Mock<ResumeCallback>;

  beforeEach(() => {
    now = 1_000;
    handle = null;
    recover = vi.fn<ResumeCallback>();
    warn = vi.fn<ResumeCallback>();
    setVisibility('visible');
  });

  afterEach(() => {
    handle?.dispose();
    setVisibility('visible');
  });

  function init(thresholds: InitOptions = {}): void {
    handle = initBackgroundResumeGuard({
      recover,
      warn,
      getNow: () => now,
      ...thresholds,
    });
  }

  async function visibilityCycle(hiddenForMs: number): Promise<void> {
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now += hiddenForMs;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
  }

  it('recovers silently for a brief tab swap (under the warn threshold)', async () => {
    init();
    await visibilityCycle(5_000);

    expect(recover).toHaveBeenCalledWith({ hiddenMs: 5_000 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a transient visibility bounce below the default recovery threshold', async () => {
    init();
    await visibilityCycle(DEFAULT_RECOVER_THRESHOLD_MS - 1);

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('recovers exactly at the default recovery threshold', async () => {
    init();
    await visibilityCycle(DEFAULT_RECOVER_THRESHOLD_MS);

    expect(recover).toHaveBeenCalledWith({ hiddenMs: DEFAULT_RECOVER_THRESHOLD_MS });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not treat an initially hidden bootstrap becoming visible as a resume', async () => {
    setVisibility('hidden');
    init();
    now += DEFAULT_WARN_THRESHOLD_MS;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('recovers and warns once the warn threshold is reached', async () => {
    init();
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);

    expect(recover).toHaveBeenCalledWith({ hiddenMs: DEFAULT_WARN_THRESHOLD_MS });
    expect(warn).toHaveBeenCalledWith({ hiddenMs: DEFAULT_WARN_THRESHOLD_MS });
  });

  it('skips recovery and warning when the session is no longer active', async () => {
    init({ shouldHandle: () => false });
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rechecks session ownership after asynchronous recovery before warning', async () => {
    let active = true;
    let finishRecovery!: () => void;
    recover.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    init({ shouldHandle: () => active });

    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    expect(recover).toHaveBeenCalledOnce();

    active = false;
    finishRecovery();
    await flushPromises();

    expect(warn).not.toHaveBeenCalled();
  });

  it('skips both when hidden time is below the recover threshold', async () => {
    init({ recoverThresholdMs: 2_000, warnThresholdMs: 5_000 });
    await visibilityCycle(1_500);

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs recover but holds warn between the two thresholds', async () => {
    init({ recoverThresholdMs: 1_000, warnThresholdMs: 10_000 });
    await visibilityCycle(5_000);

    expect(recover).toHaveBeenCalledWith({ hiddenMs: 5_000 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('detaches the visibility listener on dispose', async () => {
    init();
    handle?.dispose();
    await visibilityCycle(2_500);

    expect(recover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('only recovers for a resume that arrives while the previous warning is still open', async () => {
    let dismissWarning!: () => void;
    warn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          dismissWarning = resolve;
        }),
    );
    init();

    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS + 5_000);
    expect(recover).toHaveBeenCalledTimes(1);

    dismissWarning();
    await flushPromises();
    await flushPromises();

    // The open warning already covered that absence (owner decision
    // 2026-10-17): recover again, but do not show the same warning twice.
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenLastCalledWith({
      hiddenMs: DEFAULT_WARN_THRESHOLD_MS + 5_000,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('coalesces every absence that ends while the warning is open into one recovery', async () => {
    let dismissWarning!: () => void;
    warn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          dismissWarning = resolve;
        }),
    );
    init();

    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS * 3);
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS * 2);
    dismissWarning();
    await flushPromises();
    await flushPromises();

    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenLastCalledWith({ hiddenMs: DEFAULT_WARN_THRESHOLD_MS * 3 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats an absence that ends before the warning opens as covered by it', async () => {
    let finishRecovery!: () => void;
    recover.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    let dismissWarning!: () => void;
    warn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          dismissWarning = resolve;
        }),
    );
    init();

    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    // Leave again while the first recovery is still awaiting browser APIs.
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS + 5_000);
    finishRecovery();
    await flushPromises();
    expect(warn).toHaveBeenCalledTimes(1);

    dismissWarning();
    await flushPromises();
    await flushPromises();

    expect(recover).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still warns for a long follow-up absence that no warning covered', async () => {
    let finishRecovery!: () => void;
    recover.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    init();

    // A short absence recovers without a warning; a long one ends meanwhile.
    await visibilityCycle(5_000);
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS + 5_000);
    expect(warn).not.toHaveBeenCalled();

    finishRecovery();
    await flushPromises();
    await flushPromises();

    expect(recover).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({ hiddenMs: DEFAULT_WARN_THRESHOLD_MS + 5_000 });
  });

  it('warns again for a later absence after the warning was answered', async () => {
    init();

    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    await flushPromises();
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    await flushPromises();

    expect(recover).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops a queued follow-up when the guard is disposed', async () => {
    let dismissWarning!: () => void;
    warn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          dismissWarning = resolve;
        }),
    );
    init();

    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    await visibilityCycle(DEFAULT_WARN_THRESHOLD_MS);
    handle?.dispose();
    dismissWarning();
    await flushPromises();
    await flushPromises();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
