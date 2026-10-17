import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackButtonHistory } from '../back-button-history.ts';

type OwnedState = { mxqrGuard: { owner: string; kind: 'base' | 'guard' } };

function harness(initialState: unknown = null) {
  let state = initialState;
  let url = 'https://musixquare.com/002026';
  const events = new EventTarget();
  const history = {
    get state() {
      return state;
    },
    replaceState: vi.fn((next: unknown) => {
      state = structuredClone(next);
    }),
    pushState: vi.fn((next: unknown) => {
      state = structuredClone(next);
    }),
    back: vi.fn(),
  };
  const navigateHome = vi.fn();
  const onNavigationError = vi.fn();
  const adapter = createBackButtonHistory({
    navigateHome,
    history,
    getCurrentUrl: () => url,
    eventTarget: events,
    onNavigationError,
  });
  const pop = (next: unknown) => {
    state = structuredClone(next);
    events.dispatchEvent(new Event('popstate'));
  };
  const arm = () => {
    adapter.pushGuard();
    return {
      base: structuredClone(history.replaceState.mock.calls.at(-1)?.[0]) as OwnedState,
      guard: structuredClone(state) as OwnedState,
    };
  };
  return {
    adapter,
    history,
    events,
    navigateHome,
    onNavigationError,
    pop,
    arm,
    setUrl: (next: string) => {
      url = next;
    },
  };
}

describe('document-owned Back history', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('preserves existing state fields and reuses the current guard', () => {
    const h = harness({ route: 'connect', feature: { expanded: true } });
    expect(h.adapter.current()).toBe('foreign');
    const { base, guard } = h.arm();
    expect(base).toMatchObject({
      route: 'connect',
      feature: { expanded: true },
      mxqrGuard: { kind: 'base' },
    });
    expect(guard).toMatchObject({
      route: 'connect',
      feature: { expanded: true },
      mxqrGuard: { kind: 'guard', owner: base.mxqrGuard.owner },
    });
    expect(h.adapter.current()).toBe('guard');
    h.adapter.pushGuard();
    expect(h.history.replaceState).toHaveBeenCalledOnce();
    expect(h.history.pushState).toHaveBeenCalledOnce();
    h.pop(base);
    expect(h.adapter.current()).toBe('base');
    h.adapter.pushGuard();
    expect(h.history.replaceState).toHaveBeenCalledOnce();
    expect(h.history.pushState).toHaveBeenCalledTimes(2);
    h.adapter.dispose();
  });

  it('uses the URL at each write and never restores a previously scrubbed claim', () => {
    const h = harness();
    h.setUrl('https://musixquare.com/002026#pro-claim=private');
    h.setUrl('https://musixquare.com/002026');
    const { base } = h.arm();
    expect(h.history.replaceState).toHaveBeenCalledWith(
      expect.any(Object),
      '',
      'https://musixquare.com/002026',
    );
    h.pop(base);
    h.setUrl('https://musixquare.com/?lang=ko');
    h.adapter.pushGuard();
    expect(h.history.pushState).toHaveBeenLastCalledWith(
      expect.any(Object),
      '',
      'https://musixquare.com/?lang=ko',
    );
    expect(JSON.stringify(h.history.pushState.mock.calls)).not.toContain('private');
    h.adapter.dispose();
  });

  it('treats a previous document owner and legacy boolean markers as foreign', () => {
    const first = harness();
    const { guard } = first.arm();
    const reloaded = harness(guard);
    expect(reloaded.adapter.current()).toBe('foreign');
    const next = reloaded.arm();
    expect(next.base.mxqrGuard.owner).not.toBe(guard.mxqrGuard.owner);
    expect(reloaded.adapter.current()).toBe('guard');
    reloaded.pop(guard);
    expect(reloaded.adapter.current()).toBe('foreign');
    const legacy = harness({ mxqrGuard: true });
    expect(legacy.adapter.current()).toBe('foreign');
    for (const h of [first, reloaded, legacy]) h.adapter.dispose();
  });

  it('keeps ownership on Forward without creating a second entry', () => {
    const h = harness();
    const { base, guard } = h.arm();
    h.pop(base);
    h.pop(guard);
    expect(h.adapter.current()).toBe('guard');
    h.adapter.pushGuard();
    expect(h.history.pushState).toHaveBeenCalledOnce();
    expect(h.history.back).not.toHaveBeenCalled();
    h.adapter.dispose();
  });

  it('leaves guard then verified base and cancels fallback on a real departure', () => {
    const h = harness();
    const { base } = h.arm();
    h.adapter.leave();
    h.adapter.leave();
    h.adapter.pushGuard();
    expect(h.history.back).toHaveBeenCalledOnce();
    expect(h.history.pushState).toHaveBeenCalledOnce();
    h.pop(base);
    expect(h.history.back).toHaveBeenCalledTimes(2);
    h.events.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(2_000);
    expect(h.navigateHome).not.toHaveBeenCalled();
    h.adapter.dispose();
  });

  it('starts at base with one Back and uses a bounded fallback at the history edge', () => {
    const h = harness();
    const { base } = h.arm();
    h.pop(base);
    h.adapter.leave();
    expect(h.history.back).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(h.navigateHome).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.navigateHome).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    expect(h.history.back).toHaveBeenCalledOnce();
    expect(h.navigateHome).toHaveBeenCalledOnce();
    h.adapter.dispose();
  });

  it('does not reissue Back before the base traversal is observed', () => {
    const h = harness();
    const { guard } = h.arm();
    h.adapter.leave();
    h.pop(guard);
    h.pop(guard);
    vi.advanceTimersByTime(999);
    expect(h.history.back).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(h.navigateHome).toHaveBeenCalledOnce();
    expect(h.history.back).toHaveBeenCalledOnce();
    h.adapter.dispose();
  });

  it('uses one total deadline and never issues a third Back on repeated base events', () => {
    const h = harness();
    const { base, guard } = h.arm();
    h.adapter.leave();
    vi.advanceTimersByTime(800);
    h.pop(base);
    h.pop(base);
    h.pop(guard);
    h.pop(base);
    expect(h.history.back).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(200);
    expect(h.navigateHome).toHaveBeenCalledOnce();
    h.adapter.dispose();
  });

  it('returns home without traversing a foreign starting entry', () => {
    const h = harness({ mxqrGuard: { owner: 'old-document', kind: 'guard' } });
    h.adapter.leave();
    expect(h.navigateHome).toHaveBeenCalledOnce();
    expect(h.history.back).not.toHaveBeenCalled();
    h.adapter.dispose();
  });

  it('does not skip an unknown same-document entry during confirmed leave', () => {
    const h = harness();
    h.arm();
    h.adapter.leave();
    h.pop({ route: 'unowned' });
    expect(h.history.back).toHaveBeenCalledOnce();
    expect(h.navigateHome).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    expect(h.navigateHome).toHaveBeenCalledOnce();
    h.adapter.dispose();
  });

  it('cancels the pending continuation and fallback when the reset recovers', () => {
    const h = harness();
    const { base } = h.arm();
    h.adapter.leave();
    h.adapter.cancelLeave();
    h.pop(base);
    vi.advanceTimersByTime(2_000);
    expect(h.history.back).toHaveBeenCalledOnce();
    expect(h.navigateHome).not.toHaveBeenCalled();
    h.adapter.dispose();
  });

  it('does not resume a leave after bfcache pagehide and pageshow', () => {
    const h = harness();
    const { base } = h.arm();
    h.adapter.leave();
    h.events.dispatchEvent(new Event('pagehide'));
    h.events.dispatchEvent(new Event('pageshow'));
    h.pop(base);
    vi.advanceTimersByTime(2_000);
    expect(h.history.back).toHaveBeenCalledOnce();
    expect(h.navigateHome).not.toHaveBeenCalled();
    h.adapter.dispose();
  });

  it('falls back once if Back throws and reports a rejected home navigation safely', () => {
    const h = harness();
    h.arm();
    h.history.back.mockImplementation(() => {
      throw new Error('back unavailable');
    });
    h.navigateHome.mockImplementation(() => {
      throw new Error('home unavailable');
    });
    h.onNavigationError.mockImplementation(() => {
      throw new Error('observer unavailable');
    });
    expect(() => h.adapter.leave()).not.toThrow();
    vi.advanceTimersByTime(2_000);
    expect(h.navigateHome).toHaveBeenCalledOnce();
    expect(h.onNavigationError).toHaveBeenCalledTimes(2);
    h.adapter.dispose();
  });

  it('retains base after a failed push so retry does not replace or stack another base', () => {
    const h = harness();
    h.history.pushState.mockImplementationOnce(() => {
      throw new Error('push unavailable');
    });
    expect(() => h.adapter.pushGuard()).toThrow('push unavailable');
    expect(h.adapter.current()).toBe('base');
    h.adapter.pushGuard();
    expect(h.history.replaceState).toHaveBeenCalledOnce();
    expect(h.adapter.current()).toBe('guard');
    h.adapter.dispose();
  });

  it('disposes pending work and event handlers without changing history', () => {
    const h = harness();
    const { base } = h.arm();
    h.adapter.leave();
    h.adapter.dispose();
    h.pop(base);
    h.adapter.leave();
    h.adapter.pushGuard();
    vi.advanceTimersByTime(2_000);
    expect(h.history.back).toHaveBeenCalledOnce();
    expect(h.history.pushState).toHaveBeenCalledOnce();
    expect(h.navigateHome).not.toHaveBeenCalled();
  });
});
