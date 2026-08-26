// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failOpenSetupBootGuard } from '../setup-boot-guard.ts';

describe('setup boot guard failure recovery', () => {
  let queuedFrame: FrameRequestCallback | undefined;

  beforeEach(() => {
    document.documentElement.className = 'setup-boot-block';
    document.body.innerHTML = `
      <div id="setup-overlay"></div>
      <nav class="app-entrance app-entrance-up" style="--entrance-delay: 400ms"></nav>
    `;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        queuedFrame = callback;
        return 1;
      }),
    );
  });

  afterEach(() => {
    queuedFrame = undefined;
    vi.unstubAllGlobals();
    document.documentElement.className = '';
    document.body.innerHTML = '';
  });

  it('waits one frame, retires prepared entrance motion, and restores a visible failure surface', () => {
    failOpenSetupBootGuard();

    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(true);
    queuedFrame?.(0);

    const nav = document.querySelector<HTMLElement>('nav');
    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(false);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
    expect(nav?.classList.contains('app-entrance')).toBe(false);
    expect(nav?.classList.contains('app-entrance-up')).toBe(false);
    expect(nav?.style.getPropertyValue('--entrance-delay')).toBe('');
  });

  it('keeps the guard handoff untouched when the queued setup overlay wins first', () => {
    failOpenSetupBootGuard();
    document.getElementById('setup-overlay')?.classList.add('active');
    queuedFrame?.(0);

    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(true);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(false);
    expect(document.querySelector('nav')?.classList.contains('app-entrance')).toBe(true);
    expect(document.querySelector('nav')?.classList.contains('app-entrance-up')).toBe(true);
  });

  it('falls back synchronously when a host cannot schedule animation frames', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => {
        throw new Error('unavailable');
      }),
    );

    failOpenSetupBootGuard();

    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(false);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
  });
});
