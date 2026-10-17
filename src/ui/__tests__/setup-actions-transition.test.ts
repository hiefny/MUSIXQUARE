/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/timers.ts', () => ({
  clearManagedTimer: vi.fn(),
  setManagedTimer: vi.fn(),
}));

vi.mock('../../core/platform.ts', () => ({
  isCompactLandscape: vi.fn(() => false),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../player-controls.ts', () => ({
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  showPlacementToastForChannel: vi.fn(),
}));

vi.mock('../../core/wake-lock.ts', () => ({
  activateNoSleep: vi.fn(),
}));

vi.mock('../settings.ts', () => ({
  selectStandardChannelButton: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

import { animateTransition } from '../dom.ts';
import { setupRenderActions, setupRenderActionsInTransition } from '../setup-shared.ts';

const WELCOME = [
  { id: 'btn-setup-host', textKey: 'setup.host_button' as const, kind: 'primary' as const },
  { id: 'btn-setup-guest', textKey: 'setup.guest_button' as const, kind: 'secondary' as const },
];
const waiting = [
  { id: 'btn-setup-back', ariaLabel: 'back', kind: 'icon-only' as const },
  { id: 'btn-setup-confirm', text: 'wait', kind: 'secondary' as const, disabled: true },
];
const ready = [
  { id: 'btn-setup-back', ariaLabel: 'back', kind: 'icon-only' as const },
  { id: 'btn-setup-confirm', text: 'start', kind: 'primary' as const },
];

/** The visible actions as `layout:id,id` (with each button's text). */
function describeActions(): string {
  const area = document.getElementById('setup-actions')!;
  const layout = area.classList.contains('vertical')
    ? 'vertical'
    : area.classList.contains('horizontal-with-back')
      ? 'horizontal-with-back'
      : 'row';
  const buttons = [...area.querySelectorAll('button')].map((button) =>
    button.textContent ? `${button.id}(${button.textContent})` : button.id,
  );
  return `${layout}:${buttons.join(',')}`;
}

describe('setup actions inside the area transition', () => {
  let descriptor: PropertyDescriptor | undefined;
  let updates: Array<() => void>;
  let outgoing: string[];

  beforeEach(() => {
    document.body.innerHTML = '<div id="setup-welcome-area"></div><div id="setup-actions"></div>';
    setupRenderActions(WELCOME, 'vertical');
    descriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
    updates = [];
    outgoing = [];
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      // The browser captures the outgoing screen before it runs the update.
      value: vi.fn((update: () => void) => {
        outgoing.push(describeActions());
        updates.push(update);
        return {};
      }),
    });
  });

  afterEach(() => {
    if (descriptor) Object.defineProperty(document, 'startViewTransition', descriptor);
    else Reflect.deleteProperty(document, 'startViewTransition');
  });

  it('keeps the outgoing buttons for the snapshot and swaps them with the areas', async () => {
    const onRendered = vi.fn(() => {
      expect(document.getElementById('btn-setup-confirm')).not.toBeNull();
    });

    animateTransition(() => {
      document.getElementById('setup-welcome-area')!.hidden = true;
    });
    setupRenderActionsInTransition(ready, 'horizontal-with-back', onRendered);

    expect(describeActions()).toBe(
      'vertical:btn-setup-host(setup.host_button),btn-setup-guest(setup.guest_button)',
    );
    await Promise.resolve();
    // One native transition for both changes, captured with the old buttons.
    expect(document.startViewTransition).toHaveBeenCalledOnce();
    expect(outgoing).toEqual([
      'vertical:btn-setup-host(setup.host_button),btn-setup-guest(setup.guest_button)',
    ]);
    expect(onRendered).not.toHaveBeenCalled();

    updates.forEach((update) => update());

    expect(document.getElementById('setup-welcome-area')!.hidden).toBe(true);
    expect(describeActions()).toBe('horizontal-with-back:btn-setup-back,btn-setup-confirm(start)');
    expect(onRendered).toHaveBeenCalledOnce();
  });

  it('lets a later immediate render win over one still waiting for its transition', async () => {
    const onRendered = vi.fn();

    setupRenderActionsInTransition(waiting, 'horizontal-with-back', onRendered);
    // For example, a room code that arrives before the transition runs.
    setupRenderActions(ready, 'horizontal-with-back');
    await Promise.resolve();
    updates.forEach((update) => update());

    expect(describeActions()).toBe('horizontal-with-back:btn-setup-back,btn-setup-confirm(start)');
    expect(onRendered).not.toHaveBeenCalled();
  });

  it('renders at once where the browser has no view transitions', () => {
    Reflect.deleteProperty(document, 'startViewTransition');
    const onRendered = vi.fn();

    setupRenderActionsInTransition(ready, 'horizontal-with-back', onRendered);

    expect(describeActions()).toBe('horizontal-with-back:btn-setup-back,btn-setup-confirm(start)');
    expect(onRendered).toHaveBeenCalledOnce();
  });
});
