/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('room-only sharing action motion binding', () => {
  const aborts: AbortController[] = [];

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div><button>Sync</button><button>Media</button></div>';
  });

  afterEach(() => {
    for (const abort of aborts.splice(0)) abort.abort();
  });

  function elements(): [HTMLElement, HTMLButtonElement, HTMLButtonElement, AbortSignal] {
    const abort = new AbortController();
    aborts.push(abort);
    return [
      document.querySelector('div')!,
      document.querySelectorAll('button')[0]!,
      document.querySelectorAll('button')[1]!,
      abort.signal,
    ];
  }

  it('waits for the room boundary, then seeds only the latest state without an intermediate animation', async () => {
    const { bindSharingActionMotion, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const args = elements();
    const binding = bindSharingActionMotion(...args);
    binding.update(false);
    binding.update(true);
    const update = vi.fn();
    const create = vi.fn(() => ({ update }));
    expect(args[0].dataset.sharing).toBeUndefined();
    registerSharingActionMotion(create);
    expect(create).toHaveBeenCalledExactlyOnceWith(...args);
    expect(update).toHaveBeenCalledExactlyOnceWith(true);
    binding.update(false);
    expect(update).toHaveBeenLastCalledWith(false);
  });

  it('does not resurrect a cancelled DOM generation when room loading completes late', async () => {
    const { bindSharingActionMotion, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const old = bindSharingActionMotion(...elements());
    old.update(true);
    aborts[0]!.abort();
    const currentArgs = elements();
    const current = bindSharingActionMotion(...currentArgs);
    current.update(false);
    const update = vi.fn();
    const create = vi.fn(() => ({ update }));
    registerSharingActionMotion(create);
    expect(create).toHaveBeenCalledExactlyOnceWith(...currentArgs);
    expect(update).toHaveBeenCalledExactlyOnceWith(false);
    old.update(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('initializes a fresh binding synchronously once room features have already loaded', async () => {
    const { bindSharingActionMotion, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const update = vi.fn();
    const create = vi.fn(() => ({ update }));
    registerSharingActionMotion(create);
    const binding = bindSharingActionMotion(...elements());
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    binding.update(true);
    expect(update).toHaveBeenCalledExactlyOnceWith(true);
    registerSharingActionMotion(create);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('contains optional presentation errors without rejecting room initialization', async () => {
    const { bindSharingActionMotion, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const { log } = await import('../../core/log.ts');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    bindSharingActionMotion(...elements());
    const error = new Error('ResizeObserver unavailable');
    expect(() =>
      registerSharingActionMotion(() => {
        throw error;
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      '[SharingAction] Optional motion initialization failed',
      error,
    );
    warn.mockRestore();
  });

  it('does not initialize an already aborted binding', async () => {
    const { bindSharingActionMotion, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const args = elements();
    aborts[0]!.abort();
    const create = vi.fn(() => ({ update: vi.fn() }));
    registerSharingActionMotion(create);
    bindSharingActionMotion(...args).update(true);
    expect(create).not.toHaveBeenCalled();
  });
});
