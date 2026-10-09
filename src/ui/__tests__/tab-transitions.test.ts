/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { animateTransition, runWithoutViewTransitions } from '../dom.ts';
import { switchTab } from '../tabs.ts';
import { showLoader } from '../toast.ts';

interface PendingTransition {
  headerPreservedAtCapture: boolean;
  update: () => void;
  finish: () => void;
  reject: (reason: Error) => void;
  skip: ReturnType<typeof vi.fn>;
}

let originalTransition: PropertyDescriptor | undefined;
let transitions: PendingTransition[];
let nativeTransition: ReturnType<typeof vi.fn>;

function preservesHeader(): boolean {
  return document.documentElement.classList.contains('tab-header-transition');
}

async function flushTransitionTasks(): Promise<void> {
  // Native capture and completion handlers are promise jobs, not loader timers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  resetState();
  bus.clear();
  transitions = [];
  document.documentElement.classList.remove('tab-header-transition');
  document.body.innerHTML = `
    <style>.demo-curtain { opacity: 0; }</style>
    <header id="main-header">
      <div id="header-loading-text"><span class="header-loading-text-content"></span></div>
      <div id="header-progress-bg" style="transform: scaleX(0)"></div>
    </header>
    <nav class="bottom-nav">
      <button class="nav-item active" data-tab="play">Play</button>
      <button class="nav-item" data-tab="settings">Settings</button>
      <button class="nav-item" data-tab="connect">Connect</button>
    </nav>
    <div id="tab-play" class="tab-content active"></div>
    <div id="tab-settings" class="tab-content"></div>
    <div id="tab-connect" class="tab-content"></div>
    <div id="dialog-overlay" class="dialog-overlay"></div>
    <div id="demo-curtain" class="demo-curtain" aria-hidden="true"></div>
  `;

  originalTransition = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
  nativeTransition = vi.fn((update: () => void) => {
    let finish!: () => void;
    let reject!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, rejectPromise) => {
      finish = resolve;
      reject = rejectPromise;
    });
    const skip = vi.fn(() => finish());
    transitions.push({ headerPreservedAtCapture: preservesHeader(), update, finish, reject, skip });
    return {
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      finished,
      skipTransition: skip,
    };
  });
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: nativeTransition,
  });
});

afterEach(async () => {
  transitions.forEach((transition) => transition.finish());
  await flushTransitionTasks();
  showLoader(false);
  clearAllManagedTimers();
  bus.clear();
  if (originalTransition) {
    Object.defineProperty(document, 'startViewTransition', originalTransition);
  } else {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
  document.documentElement.classList.remove('tab-header-transition');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tab transitions during header loading', () => {
  it.each(['start', 'stop', 'redundant stop'] as const)(
    'keeps native tab crossfade immediately after loader %s',
    async (operation) => {
      if (operation !== 'redundant stop') showLoader(true, 'Preparing audio');
      if (operation !== 'start') showLoader(false);

      switchTab('settings');
      await flushTransitionTasks();

      expect(nativeTransition).toHaveBeenCalledOnce();
      expect(transitions[0].headerPreservedAtCapture).toBe(true);
      transitions[0].update();
      expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
      expect(document.querySelector('[data-tab="settings"]')?.getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(preservesHeader()).toBe(true);

      transitions[0].finish();
      await flushTransitionTasks();
      expect(preservesHeader()).toBe(false);
    },
  );

  it('retains root crossfade when a modal already covers the header', async () => {
    document.getElementById('dialog-overlay')!.classList.add('show');
    showLoader(true, 'Preparing audio');

    switchTab('settings');
    await flushTransitionTasks();

    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(transitions[0].headerPreservedAtCapture).toBe(false);
    transitions[0].update();
    expect(preservesHeader()).toBe(false);
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
  });

  it('returns a newly opened modal and the header to normal root compositing', async () => {
    bus.on('ui:settings-tab-opened', () => {
      document.getElementById('dialog-overlay')!.classList.add('show');
    });

    switchTab('settings');
    await flushTransitionTasks();

    expect(transitions[0].headerPreservedAtCapture).toBe(true);
    transitions[0].update();
    expect(preservesHeader()).toBe(false);
    expect(document.getElementById('dialog-overlay')?.classList.contains('show')).toBe(true);
    expect(nativeTransition).toHaveBeenCalledOnce();
  });

  it.each([
    'webkitFullscreenElement',
    'webkitCurrentFullScreenElement',
    'webkitIsFullScreen',
  ] as const)(
    'retains root crossfade during Safari fullscreen reported by %s',
    async (property) => {
      const original = Object.getOwnPropertyDescriptor(document, property);
      Object.defineProperty(document, property, {
        configurable: true,
        value: property === 'webkitIsFullScreen' ? true : document.getElementById('tab-play'),
      });
      try {
        switchTab('settings');
        await flushTransitionTasks();

        expect(nativeTransition).toHaveBeenCalledOnce();
        expect(transitions[0].headerPreservedAtCapture).toBe(false);
        transitions[0].update();
        expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
        expect(preservesHeader()).toBe(false);
      } finally {
        if (original) Object.defineProperty(document, property, original);
        else Reflect.deleteProperty(document, property);
      }
    },
  );
});

describe('batched and overlapping tab transitions', () => {
  it('preserves the header when all updates in one batch are tab switches', async () => {
    switchTab('settings');
    switchTab('connect');
    await flushTransitionTasks();

    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(transitions[0].headerPreservedAtCapture).toBe(true);
    transitions[0].update();
    expect(document.getElementById('tab-connect')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(false);
  });

  it.each(['before', 'after'] as const)(
    'uses normal root compositing when a non-tab update is batched %s a tab switch',
    async (order) => {
      const otherUpdate = vi.fn();
      if (order === 'before') animateTransition(otherUpdate);
      switchTab('settings');
      if (order === 'after') animateTransition(otherUpdate);
      await flushTransitionTasks();

      expect(nativeTransition).toHaveBeenCalledOnce();
      expect(transitions[0].headerPreservedAtCapture).toBe(false);
      transitions[0].update();
      expect(otherUpdate).toHaveBeenCalledOnce();
      expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
      expect(preservesHeader()).toBe(false);
    },
  );

  it.each(['finish', 'reject'] as const)(
    'keeps the newer header group when the superseded transition receives %s',
    async (outcome) => {
      switchTab('settings');
      await flushTransitionTasks();
      transitions[0].update();

      switchTab('connect');
      await flushTransitionTasks();
      transitions[1].update();
      expect(preservesHeader()).toBe(true);

      if (outcome === 'finish') transitions[0].finish();
      else transitions[0].reject(new Error('The newer transition superseded this transition'));
      await flushTransitionTasks();
      expect(preservesHeader()).toBe(true);

      transitions[1].finish();
      await flushTransitionTasks();
      expect(preservesHeader()).toBe(false);
      expect(document.getElementById('tab-connect')?.classList.contains('active')).toBe(true);
    },
  );

  it('clears a prior tab group before an unrelated transition captures the page', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    expect(preservesHeader()).toBe(true);

    const otherUpdate = vi.fn();
    animateTransition(otherUpdate);
    await flushTransitionTasks();
    expect(transitions[1].headerPreservedAtCapture).toBe(false);
    transitions[1].update();
    expect(otherUpdate).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);
  });
});

describe('the permanently mounted demo curtain', () => {
  it.each(['1', '0.4'])(
    'keeps root crossfade while the curtain is visible at opacity %s after demo mode exits',
    async (opacity) => {
      document.getElementById('demo-curtain')!.style.opacity = opacity;

      switchTab('settings');
      await flushTransitionTasks();

      expect(nativeTransition).toHaveBeenCalledOnce();
      expect(transitions[0].headerPreservedAtCapture).toBe(false);
      transitions[0].update();
      expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
      expect(preservesHeader()).toBe(false);
    },
  );

  it.each([
    { phase: 'running', playState: 'running', pending: false, preservesHeader: false },
    { phase: 'pending', playState: 'idle', pending: true, preservesHeader: false },
    { phase: 'finished', playState: 'finished', pending: false, preservesHeader: true },
  ])(
    'handles a $phase curtain animation whose current opacity is zero',
    async ({ playState, pending, preservesHeader: expected }) => {
      const curtain = document.getElementById('demo-curtain')!;
      // WAAPI can begin covering the page at opacity 0, or retain a finished
      // reveal with fill: forwards. A static DOM-presence check conflates them.
      Object.defineProperty(curtain, 'getAnimations', {
        configurable: true,
        value: vi.fn().mockReturnValue([{ playState, pending }]),
      });

      switchTab('settings');
      await flushTransitionTasks();

      expect(nativeTransition).toHaveBeenCalledOnce();
      expect(transitions[0].headerPreservedAtCapture).toBe(expected);
      transitions[0].update();
      expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
      expect(preservesHeader()).toBe(expected);
    },
  );
});

describe('overlays appearing while a tab crossfade is running', () => {
  it('ends the snapshot presentation when a modal opens after the tab update', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    await flushTransitionTasks();
    expect(preservesHeader()).toBe(true);

    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushTransitionTasks();

    expect(transitions[0].skip).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('dialog-overlay')?.classList.contains('show')).toBe(true);
  });

  it('stops observing overlays when the transition has already finished', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    transitions[0].finish();
    await flushTransitionTasks();

    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushTransitionTasks();

    expect(transitions[0].skip).not.toHaveBeenCalled();
    expect(preservesHeader()).toBe(false);
  });

  it('ends the snapshot presentation when the curtain starts covering after a tab update', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    await flushTransitionTasks();
    expect(preservesHeader()).toBe(true);

    const curtain = document.getElementById('demo-curtain')!;
    Object.defineProperty(curtain, 'getAnimations', {
      configurable: true,
      value: vi.fn().mockReturnValue([{ playState: 'running', pending: false }]),
    });
    // animateDemoCurtain writes the starting inline opacity before animate().
    // The mutation arrives while the first animation frame can still be zero.
    curtain.style.opacity = '0';
    await flushTransitionTasks();

    expect(transitions[0].skip).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
  });

  it('ends only the latest snapshot presentation when an overlay opens after supersession', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();

    switchTab('connect');
    await flushTransitionTasks();
    transitions[1].update();
    await flushTransitionTasks();
    const oldSkipCalls = transitions[0].skip.mock.calls.length;

    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushTransitionTasks();

    expect(transitions[0].skip).toHaveBeenCalledTimes(oldSkipCalls);
    expect(transitions[1].skip).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);
    expect(document.getElementById('tab-connect')?.classList.contains('active')).toBe(true);
  });
});

describe('tab transition fallback and cleanup', () => {
  it('removes header isolation when the native transition rejects', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    expect(preservesHeader()).toBe(true);

    transitions[0].reject(new Error('Document became hidden'));
    await flushTransitionTasks();

    expect(preservesHeader()).toBe(false);
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
  });

  it('applies the tab change once and clears header isolation when native start throws', async () => {
    const changed = vi.fn();
    bus.on('ui:tab-changed', changed);
    nativeTransition.mockImplementationOnce(() => {
      expect(preservesHeader()).toBe(true);
      throw new Error('Native view transitions are unavailable in this document');
    });

    switchTab('settings');
    await flushTransitionTasks();

    expect(changed).toHaveBeenCalledExactlyOnceWith('settings');
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
    expect(preservesHeader()).toBe(false);
  });

  it('keeps unsupported browsers synchronous even immediately after loading', () => {
    Reflect.deleteProperty(document, 'startViewTransition');
    showLoader(true, 'Preparing audio');
    switchTab('settings');

    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
    expect(nativeTransition).not.toHaveBeenCalled();
    expect(preservesHeader()).toBe(false);
  });

  it('keeps first-paint scopes synchronous and permits the next tab crossfade', async () => {
    runWithoutViewTransitions(() => switchTab('settings'));
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
    expect(nativeTransition).not.toHaveBeenCalled();
    expect(preservesHeader()).toBe(false);

    switchTab('connect');
    await flushTransitionTasks();
    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(transitions[0].headerPreservedAtCapture).toBe(true);
    transitions[0].update();
    expect(document.getElementById('tab-connect')?.classList.contains('active')).toBe(true);
  });
});
