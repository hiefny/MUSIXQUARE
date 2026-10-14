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
    const { bindSharingActionControls, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const args = elements();
    const binding = bindSharingActionControls(...args);
    binding.update(false);
    binding.update(true);
    const update = vi.fn();
    const create = vi.fn(() => ({ update }));
    expect(args[0].dataset.sharing).toBe('true');
    expect(args[0].dataset.motionReady).toBeUndefined();
    registerSharingActionMotion(create);
    expect(args[0].dataset.motionReady).toBe('true');
    expect(create).toHaveBeenCalledExactlyOnceWith(...args.slice(0, 3), expect.any(AbortSignal));
    expect(update).toHaveBeenCalledExactlyOnceWith(true);
    binding.update(false);
    expect(update).toHaveBeenLastCalledWith(false);
  });

  it('does not resurrect a cancelled DOM generation when room loading completes late', async () => {
    const { bindSharingActionControls, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const old = bindSharingActionControls(...elements());
    old.update(true);
    aborts[0]!.abort();
    const currentArgs = elements();
    const current = bindSharingActionControls(...currentArgs);
    current.update(false);
    const update = vi.fn();
    const create = vi.fn(() => ({ update }));
    registerSharingActionMotion(create);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      ...currentArgs.slice(0, 3),
      expect.any(AbortSignal),
    );
    expect(update).toHaveBeenCalledExactlyOnceWith(false);
    old.update(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('initializes a fresh binding synchronously once room features have already loaded', async () => {
    const { bindSharingActionControls, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const update = vi.fn();
    const create = vi.fn(() => ({ update }));
    registerSharingActionMotion(create);
    const binding = bindSharingActionControls(...elements());
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    binding.update(true);
    expect(update).toHaveBeenCalledExactlyOnceWith(true);
    registerSharingActionMotion(create);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('contains optional presentation errors without rejecting room initialization', async () => {
    const { bindSharingActionControls, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const { log } = await import('../../core/log.ts');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const args = elements();
    const binding = bindSharingActionControls(...args);
    binding.update(false);
    const error = new Error('ResizeObserver unavailable');
    expect(() =>
      registerSharingActionMotion(() => {
        throw error;
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[SharingAction] Optional motion failed', error);
    binding.update(true);
    expect(args[0].dataset.sharing).toBe('true');
    expect(args[0].dataset.motionReady).toBeUndefined();
    expect(args[1].disabled).toBe(true);
    expect(args[1].getAttribute('aria-hidden')).toBe('true');
    expect(args[1].hasAttribute('inert')).toBe(true);
    warn.mockRestore();
  });

  it('moves focus before hiding Sync without a motion factory and restores the original policy', async () => {
    const { bindSharingActionControls } = await import('../sharing-action-motion-port.ts');
    const [container, sync, media, signal] = elements();
    sync.setAttribute('aria-disabled', 'true');
    const binding = bindSharingActionControls(container, sync, media, signal);
    sync.focus();
    const focus = vi.spyOn(media, 'focus').mockImplementation(() => {
      expect(sync.disabled).toBe(false);
      expect(sync.hasAttribute('inert')).toBe(false);
      expect(sync.hasAttribute('aria-hidden')).toBe(false);
    });
    binding.update(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(container.dataset.sharing).toBe('true');
    expect(sync.disabled).toBe(true);
    expect(sync.hasAttribute('inert')).toBe(true);
    expect(sync.getAttribute('aria-hidden')).toBe('true');
    binding.update(false);
    expect(container.dataset.sharing).toBe('false');
    expect(sync.disabled).toBe(false);
    expect(sync.hasAttribute('inert')).toBe(false);
    expect(sync.hasAttribute('aria-hidden')).toBe(false);
    expect(sync.getAttribute('aria-disabled')).toBe('true');
  });

  it('prepares motion against the previous state and aborts partial effects when update throws', async () => {
    const { bindSharingActionControls, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const { log } = await import('../../core/log.ts');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const [container, sync, media, signal] = elements();
    const cleanup = vi.fn();
    const update = vi.fn((next: boolean) => {
      if (next) {
        expect(container.dataset.sharing).toBe('false');
        expect(sync.disabled).toBe(false);
        throw new Error('measurement failed');
      }
    });
    registerSharingActionMotion((_container, _sync, _media, motionSignal) => {
      motionSignal.addEventListener('abort', cleanup, { once: true });
      return { update };
    });
    const binding = bindSharingActionControls(container, sync, media, signal);
    binding.update(false);
    expect(container.dataset.motionReady).toBe('true');
    expect(() => binding.update(true)).not.toThrow();
    expect(container.dataset.motionReady).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container.dataset.sharing).toBe('true');
    expect(sync.disabled).toBe(true);
    binding.update(false);
    binding.update(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('aborts resources installed before factory failure and restores pre-existing DOM state on teardown', async () => {
    const { bindSharingActionControls, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const { log } = await import('../../core/log.ts');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const [container, sync, media, signal] = elements();
    container.dataset.sharing = 'false';
    sync.disabled = true;
    sync.setAttribute('inert', '');
    sync.setAttribute('aria-hidden', 'false');
    const cleanup = vi.fn();
    registerSharingActionMotion((_container, _sync, _media, motionSignal) => {
      motionSignal.addEventListener('abort', cleanup, { once: true });
      throw new Error('observer initialization failed');
    });
    const binding = bindSharingActionControls(container, sync, media, signal);
    binding.update(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    aborts[0]!.abort();
    binding.update(true);
    expect(container.dataset.sharing).toBe('false');
    expect(sync.disabled).toBe(true);
    expect(sync.hasAttribute('inert')).toBe(true);
    expect(sync.getAttribute('aria-hidden')).toBe('false');
    expect(cleanup).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not initialize an already aborted binding', async () => {
    const { bindSharingActionControls, registerSharingActionMotion } =
      await import('../sharing-action-motion-port.ts');
    const args = elements();
    aborts[0]!.abort();
    const create = vi.fn(() => ({ update: vi.fn() }));
    registerSharingActionMotion(create);
    bindSharingActionControls(...args).update(true);
    expect(create).not.toHaveBeenCalled();
  });
});
