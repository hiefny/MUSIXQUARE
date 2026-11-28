/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  afterViewTransitions,
  animateTransition,
  finishOverlayExit,
  isInsideViewTransitionUpdate,
  runWithoutViewTransitions,
  startOverlayExit,
  whenBackSurfaceSettled,
} from '../dom.ts';
import { initTabs, switchTab } from '../tabs.ts';
import { showLoader } from '../toast.ts';

interface PendingTransition {
  headerPreservedAtCapture: boolean;
  /** <html> had the owner's in-transition mark when the browser was asked to capture. */
  markedAtCapture: boolean;
  update: () => void;
  finish: () => void;
  reject: (reason: Error) => void;
  skip: ReturnType<typeof vi.fn>;
}

/** The owner's <html> class from a transition's update until its release, read from its home. */
const VIEW_TRANSITION_CLASS =
  /const VIEW_TRANSITION_CLASS = '([^']+)';/u.exec(readFileSync('src/ui/dom.ts', 'utf8'))?.[1] ??
  '';

let originalTransition: PropertyDescriptor | undefined;
let transitions: PendingTransition[];
let nativeTransition: ReturnType<typeof vi.fn>;
let reducedMotion: boolean;
let visibility: DocumentVisibilityState;

function preservesHeader(): boolean {
  return document.documentElement.classList.contains('tab-header-transition');
}

function marked(): boolean {
  return document.documentElement.classList.contains(VIEW_TRANSITION_CLASS);
}

function activeTab(): string | null {
  return document.querySelector('.tab-content.active')?.id ?? null;
}

async function flushTransitionTasks(): Promise<void> {
  // Native capture and completion handlers are promise jobs, not loader timers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function flushReleaseFrame(): void {
  vi.advanceTimersToNextFrame();
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? reducedMotion : true,
    })),
  );
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  resetState();
  bus.clear();
  transitions = [];
  document.documentElement.classList.remove('tab-header-transition', VIEW_TRANSITION_CLASS);
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
    transitions.push({
      headerPreservedAtCapture: preservesHeader(),
      markedAtCapture: marked(),
      update,
      finish,
      reject,
      skip,
    });
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
  flushReleaseFrame();
  showLoader(false);
  clearAllManagedTimers();
  bus.clear();
  if (originalTransition) {
    Object.defineProperty(document, 'startViewTransition', originalTransition);
  } else {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
  Reflect.deleteProperty(document, 'visibilityState');
  document.documentElement.classList.remove('tab-header-transition', VIEW_TRANSITION_CLASS);
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
      // Kept for one frame after vt.finished so WebKit finishes tearing down
      // the view-transition tree before removing live-chrome isolation.
      expect(preservesHeader()).toBe(true);
      flushReleaseFrame();
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

  it('retains root crossfade while a closed dialog still plays its exit', async () => {
    const dialog = document.getElementById('dialog-overlay')!;
    dialog.classList.add('show');
    // Closed, so not shown, but its backdrop still covers the header.
    expect(startOverlayExit(dialog)).toBe(true);

    switchTab('settings');
    await flushTransitionTasks();

    expect(transitions[0].headerPreservedAtCapture).toBe(false);
    transitions[0].update();
    expect(preservesHeader()).toBe(false);
    transitions[0].finish();
    await flushTransitionTasks();

    // Once the exit is over the header is lifted again.
    finishOverlayExit(dialog);
    switchTab('play');
    await flushTransitionTasks();
    expect(transitions[1].headerPreservedAtCapture).toBe(true);
  });

  it('ends the presentation when a tab listener opens a modal inside the update', async () => {
    bus.on('ui:settings-tab-opened', () => {
      document.getElementById('dialog-overlay')!.classList.add('show');
    });

    switchTab('settings');
    await flushTransitionTasks();

    expect(transitions[0].headerPreservedAtCapture).toBe(true);
    transitions[0].update();
    // The live header and nav would paint over the modal, and their old
    // images are hidden: dropping only their names would blink them, so the
    // transition ends and the modal shows in its own stack at once.
    expect(transitions[0].skip).toHaveBeenCalledOnce();
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

describe('one native view transition at a time', () => {
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

  it('joins a tab change made before the running update into that update', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    expect(nativeTransition).toHaveBeenCalledOnce();

    // The browser has not run the update yet: the change waits for it, and
    // stays out of the old image.
    switchTab('connect');
    await flushTransitionTasks();
    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(activeTab()).toBe('tab-play');

    transitions[0].update();
    expect(activeTab()).toBe('tab-connect');
    expect(preservesHeader()).toBe(true);
    expect(transitions[0].skip).not.toHaveBeenCalled();
  });

  it('applies a tab change made after the update in place, inside the running fade', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();

    let insideUpdate: boolean | null = null;
    bus.on('ui:connect-tab-opened', () => {
      insideUpdate = isInsideViewTransitionUpdate();
    });
    switchTab('connect');
    // As at rest, the caller's own code runs before the change.
    expect(activeTab()).toBe('tab-settings');

    // The new image is live, so the change shows in this frame without a
    // second capture that would skip the running fade.
    await Promise.resolve();
    expect(activeTab()).toBe('tab-connect');
    expect(insideUpdate).toBe(true);
    expect(isInsideViewTransitionUpdate()).toBe(false);
    await flushTransitionTasks();
    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(transitions[0].skip).not.toHaveBeenCalled();
    expect(preservesHeader()).toBe(true);
  });

  it('shows an area after its caller’s own code whether or not a fade runs', async () => {
    // The guest join step shows its area and then focuses the code field
    // (setup-guest.ts): the field is still hidden then, at rest and during a
    // running fade alike, so iOS never opens its keyboard only by timing.
    const area = document.createElement('div');
    area.hidden = true;
    document.body.append(area);
    /** Shows the area, and says whether it was still hidden when its caller went on. */
    const showThenGoOn = (): boolean => {
      animateTransition(() => {
        area.hidden = false;
      });
      return area.hidden === true;
    };

    expect(showThenGoOn()).toBe(true);
    await flushTransitionTasks();
    transitions[0].update();
    expect(area.hidden).toBe(false);

    area.hidden = true;
    expect(showThenGoOn()).toBe(true);
    await Promise.resolve();
    expect(area.hidden).toBe(false);
    expect(nativeTransition).toHaveBeenCalledOnce();
  });

  it('keeps a change applied in place from throwing into its caller', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();

    expect(() =>
      animateTransition(() => {
        throw new Error('a listener failed');
      }),
    ).not.toThrow();
    switchTab('connect');
    await Promise.resolve();
    // The change after the one that threw still applies.
    expect(activeTab()).toBe('tab-connect');
    expect(isInsideViewTransitionUpdate()).toBe(false);
  });

  it('applies changes still waiting in place before the transition settles', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    transitions[0].finish();

    const close = vi.fn();
    animateTransition(close, { closingWindow: true });
    const observed = vi.fn(() => expect(close).toHaveBeenCalledOnce());
    const observation = whenBackSurfaceSettled().then(observed);
    await flushTransitionTasks();
    await observation;
    expect(observed).toHaveBeenCalledOnce();
    expect(nativeTransition).toHaveBeenCalledOnce();
  });

  it.each(['finish', 'reject'] as const)(
    'keeps the header group until the transition that applied both changes settles (%s)',
    async (outcome) => {
      switchTab('settings');
      await flushTransitionTasks();
      transitions[0].update();
      switchTab('connect');
      expect(preservesHeader()).toBe(true);

      if (outcome === 'finish') transitions[0].finish();
      else transitions[0].reject(new Error('Document became hidden'));
      await flushTransitionTasks();
      expect(preservesHeader()).toBe(true);
      flushReleaseFrame();
      expect(preservesHeader()).toBe(false);
      expect(activeTab()).toBe('tab-connect');
    },
  );

  it('clears a prior tab group before an unrelated transition captures the page', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    transitions[0].finish();
    await flushTransitionTasks();
    // The first transition settled; its release frame has not come yet.
    expect(preservesHeader()).toBe(true);

    const otherUpdate = vi.fn();
    animateTransition(otherUpdate);
    await flushTransitionTasks();
    expect(nativeTransition).toHaveBeenCalledTimes(2);
    expect(transitions[1].headerPreservedAtCapture).toBe(false);
    transitions[1].update();
    expect(otherUpdate).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);

    // The older release frame must not take the newer transition's mark.
    flushReleaseFrame();
    expect(marked()).toBe(true);
    transitions[1].finish();
    await flushTransitionTasks();
    flushReleaseFrame();
    expect(marked()).toBe(false);
  });

  it('never starts a second transition for arrow keys pressed on the tab list during one', async () => {
    initTabs();
    const nav = (tab: string) =>
      document.querySelector<HTMLElement>(`.bottom-nav .nav-item[data-tab="${tab}"]`)!;
    const press = (tab: string, key: string) =>
      nav(tab).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

    press('play', 'ArrowRight');
    await flushTransitionTasks();
    // Before the update has run, and again while the fade runs.
    press('settings', 'ArrowRight');
    await flushTransitionTasks();
    transitions[0].update();
    expect(activeTab()).toBe('tab-connect');
    press('connect', 'ArrowLeft');
    await flushTransitionTasks();
    expect(activeTab()).toBe('tab-settings');

    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(transitions[0].skip).not.toHaveBeenCalled();
    expect(nav('settings').getAttribute('aria-selected')).toBe('true');
  });

  it('applies a programmatic screen change in place and ends the presentation for its window', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();

    // As a session-full or reconnect fallback does while a tab fades in.
    animateTransition(() => {
      document.getElementById('dialog-overlay')!.classList.add('show');
    });
    await flushTransitionTasks();
    expect(document.getElementById('dialog-overlay')?.classList.contains('show')).toBe(true);

    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(transitions[0].skip).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);
  });

  it.each(['before', 'after'] as const)(
    'settles a window closed %s the running update with that transition, not at once',
    async (when) => {
      switchTab('settings');
      await flushTransitionTasks();
      if (when === 'after') transitions[0].update();

      const close = vi.fn();
      animateTransition(close, { closingWindow: true });
      const observed = vi.fn();
      const observation = whenBackSurfaceSettled().then(observed);
      expect(close).not.toHaveBeenCalled();
      if (when === 'before') transitions[0].update();
      await flushTransitionTasks();
      expect(close).toHaveBeenCalledOnce();
      // The held old image still shows the closing window.
      expect(observed).not.toHaveBeenCalled();

      transitions[0].finish();
      await observation;
      expect(observed).toHaveBeenCalledOnce();
      expect(nativeTransition).toHaveBeenCalledOnce();
    },
  );

  it('runs every update of a shared transition when one of them throws', async () => {
    animateTransition(() => {
      throw new Error('a setup update failed');
    });
    switchTab('settings');
    await flushTransitionTasks();

    expect(() => transitions[0].update()).not.toThrow();
    expect(activeTab()).toBe('tab-settings');
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
    flushReleaseFrame();
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

  it('ends the presentation once when an overlay opens after a tab change applied in place', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    switchTab('connect');
    await flushTransitionTasks();

    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushTransitionTasks();

    expect(nativeTransition).toHaveBeenCalledOnce();
    expect(transitions[0].skip).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);
    expect(document.getElementById('tab-connect')?.classList.contains('active')).toBe(true);
  });

  it('keeps work waiting after an overlay ends the presentation until the update has run', async () => {
    // A browser runs the update of a skipped transition and settles it after.
    let finish!: () => void;
    const skip = vi.fn();
    let update!: () => void;
    nativeTransition.mockImplementationOnce((callback: () => void) => {
      update = callback;
      return {
        ready: Promise.reject(new Error('skipped')),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        skipTransition: skip,
      };
    });
    switchTab('settings');
    await flushTransitionTasks();
    const waiting = vi.fn(() => activeTab());
    afterViewTransitions(waiting);

    document.getElementById('dialog-overlay')!.classList.add('show');
    await flushTransitionTasks();
    expect(skip).toHaveBeenCalledOnce();
    expect(preservesHeader()).toBe(false);

    flushReleaseFrame();
    expect(waiting).not.toHaveBeenCalled();
    update();
    finish();
    await flushTransitionTasks();
    flushReleaseFrame();
    expect(waiting).toHaveBeenCalledOnce();
    expect(waiting).toHaveReturnedWith('tab-settings');
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
    flushReleaseFrame();

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
    // Waiting work runs only once the update has been applied.
    const waiting = vi.fn(() => activeTab());
    afterViewTransitions(waiting);
    await flushTransitionTasks();

    expect(changed).toHaveBeenCalledExactlyOnceWith('settings');
    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
    expect(preservesHeader()).toBe(false);
    expect(marked()).toBe(false);
    expect(waiting).toHaveReturnedWith('tab-settings');
  });

  it('keeps unsupported browsers synchronous even immediately after loading', () => {
    Reflect.deleteProperty(document, 'startViewTransition');
    showLoader(true, 'Preparing audio');
    switchTab('settings');

    expect(document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
    expect(nativeTransition).not.toHaveBeenCalled();
    expect(preservesHeader()).toBe(false);
  });

  it('starts no native transition under reduced motion, and settles a closing window with its update', async () => {
    reducedMotion = true;
    switchTab('settings');
    const close = vi.fn();
    animateTransition(close, { closingWindow: true });
    const observed = vi.fn();
    const observation = whenBackSurfaceSettled().then(observed);
    // The batch applies after its callers' task, where a transition's update
    // would, so callers see the same order as with motion.
    expect(activeTab()).toBe('tab-play');
    expect(close).not.toHaveBeenCalled();

    await flushTransitionTasks();
    expect(activeTab()).toBe('tab-settings');
    expect(close).toHaveBeenCalledOnce();
    await observation;
    expect(observed).toHaveBeenCalledOnce();
    expect(nativeTransition).not.toHaveBeenCalled();
    expect(preservesHeader()).toBe(false);
    expect(marked()).toBe(false);
    // Nothing waits for a transition that never started.
    const waiting = vi.fn();
    afterViewTransitions(waiting);
    expect(waiting).toHaveBeenCalledOnce();
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

  it('marks <html> from the update until one frame after the transition, then runs waiting work', async () => {
    let insideUpdate = false;
    let markedInUpdate = false;
    switchTab('settings');
    animateTransition(() => {
      insideUpdate = isInsideViewTransitionUpdate();
      markedInUpdate = marked();
    });
    // Waiting from the batch on: nothing has started yet.
    const waiting = vi.fn();
    afterViewTransitions(waiting);
    const cancelled = vi.fn();
    const cancel = afterViewTransitions(cancelled);
    const failing = vi.fn(() => {
      throw new Error('waiting work failed');
    });
    afterViewTransitions(failing);
    cancel();
    await flushTransitionTasks();

    // The old image is captured without the mark.
    expect(transitions[0].markedAtCapture).toBe(false);
    transitions[0].update();
    expect(insideUpdate).toBe(true);
    expect(markedInUpdate).toBe(true);
    expect(isInsideViewTransitionUpdate()).toBe(false);
    expect(marked()).toBe(true);

    transitions[0].finish();
    await flushTransitionTasks();
    expect(marked()).toBe(true);
    expect(waiting).not.toHaveBeenCalled();

    flushReleaseFrame();
    expect(marked()).toBe(false);
    expect(failing).toHaveBeenCalledOnce();
    expect(waiting).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();

    // With nothing pending the work runs at once.
    const later = vi.fn();
    afterViewTransitions(later);
    expect(later).toHaveBeenCalledOnce();
  });

  it('releases at once when the transition settles on a hidden page, which runs no frames', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    const waiting = vi.fn();
    afterViewTransitions(waiting);

    // The browser skips the transition when the page hides.
    setVisibility('hidden');
    transitions[0].reject(new Error('Document became hidden'));
    await flushTransitionTasks();

    expect(preservesHeader()).toBe(false);
    expect(marked()).toBe(false);
    expect(waiting).toHaveBeenCalledOnce();
  });

  it('releases at once when the page hides during the release frame', async () => {
    switchTab('settings');
    await flushTransitionTasks();
    transitions[0].update();
    transitions[0].finish();
    await flushTransitionTasks();
    expect(preservesHeader()).toBe(true);

    setVisibility('hidden');

    expect(preservesHeader()).toBe(false);
    expect(marked()).toBe(false);
    // The frame that comes once the page shows again finds nothing to release.
    setVisibility('visible');
    switchTab('play');
    await flushTransitionTasks();
    transitions[1].update();
    flushReleaseFrame();
    expect(preservesHeader()).toBe(true);
  });

  it('defines normal-alpha root crossfade, tab-scoped bottom-nav isolation, and the transition scrollbar rule', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(
      /::view-transition-old\(root\)\s*\{[^}]*animation:\s*none;[^}]*mix-blend-mode:\s*normal;/su,
    );
    expect(css).toMatch(
      /::view-transition-new\(root\)\s*\{[^}]*animation:\s*view-transition-fade-in 0\.25s ease both;[^}]*mix-blend-mode:\s*normal;/su,
    );
    expect(css).toMatch(
      /html\.tab-header-transition \.bottom-nav\s*\{[^}]*view-transition-name:\s*bottom-nav;/su,
    );
    expect(css).not.toMatch(
      /(?:^|[\r\n])\s*\.bottom-nav\s*\{[^}]*view-transition-name:\s*bottom-nav;/su,
    );
    // The host QR spinner stays out of the page's images instead of taking a
    // layer of its own (src/ui/setup-host-invite.ts).
    expect(css).not.toContain('host-qr-spinner');
    // One rule, owned by animateTransition(), turns every custom scrollbar's
    // own fade off while a transition's new image is live.
    expect(VIEW_TRANSITION_CLASS).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
    expect(css).toMatch(
      new RegExp(
        `html\\.${VIEW_TRANSITION_CLASS} \\.cscroll-track\\s*\\{\\s*transition: none !important;\\s*\\}`,
        'u',
      ),
    );
  });
});
