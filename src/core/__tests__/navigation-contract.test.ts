import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOT_SPLASH_CONTINUITY_BOX_KEY,
  BOOT_SPLASH_CONTINUITY_KEY,
  LEAVE_FALLBACK_MS,
  NAVIGATION_COMMIT_TIMEOUT_MS,
  NAVIGATION_PREPARE_TIMEOUT_MS,
  PREVIOUS_AUDIO_RECOVERY_KEY,
  PREVIOUS_LINK_CLOSE_KEY,
  RECONNECT_TARGET_KEY,
  RESET_FIRST_FRAME_LIMIT_MS,
  RESET_PAINT_FALLBACK_MS,
  SW_CONTROLLER_CONFIRMED_KEY,
  SW_UPDATE_KEY,
  UPDATE_COMPLETION_KEY,
} from '../navigation-contract.ts';

describe('page navigation timing contract (RO-23, RO-30)', () => {
  it('runs the Back leave fallback inside the reset commit window', () => {
    // A confirmed Back leave runs inside a reset: history.back(), then the
    // fallback navigation home after LEAVE_FALLBACK_MS. The fallback must start
    // before the reset gives up on the traversal and makes the page
    // interactive again, or the page leaves after it looked recovered.
    expect(LEAVE_FALLBACK_MS).toBeLessThan(NAVIGATION_COMMIT_TIMEOUT_MS);
  });

  it('runs the reset action well inside the commit window when frames are suspended', () => {
    // Without frames the reset waits RESET_PAINT_FALLBACK_MS beyond its
    // screen's fade-in, whose length lives in css/style.css (session-reset.ts
    // reads it from the computed style).
    const css = readFileSync('css/style.css', 'utf8');
    const shown = /\.session-reset-overlay\.show \{([^}]*)\}/u.exec(css)?.[1] ?? '';
    const fadeIn = /opacity ([\d.]+)s/u.exec(/transition:([^;]*);/u.exec(shown)?.[1] ?? '')?.[1];
    expect(fadeIn, '.session-reset-overlay.show has no opacity transition').toBeDefined();
    const fadeInMs = Number(fadeIn) * 1000;
    expect(fadeInMs).toBe(200);
    expect(RESET_PAINT_FALLBACK_MS + fadeInMs).toBeLessThan(LEAVE_FALLBACK_MS);
  });

  it("waits longer for a visible page's first frame, still well inside the commit window", () => {
    // A visible page whose first frame comes late waits for it up to
    // RESET_FIRST_FRAME_LIMIT_MS (owner decision 2026-11-20): past the
    // no-frame fallback, so a busy page shows the whole screen, and short of
    // LEAVE_FALLBACK_MS like that fallback.
    const css = readFileSync('css/style.css', 'utf8');
    const shown = /\.session-reset-overlay\.show \{([^}]*)\}/u.exec(css)?.[1] ?? '';
    const fadeInMs =
      Number(/opacity ([\d.]+)s/u.exec(/transition:([^;]*);/u.exec(shown)?.[1] ?? '')?.[1]) * 1000;
    expect(RESET_FIRST_FRAME_LIMIT_MS).toBe(800);
    expect(RESET_FIRST_FRAME_LIMIT_MS).toBeGreaterThan(RESET_PAINT_FALLBACK_MS + fadeInMs);
    expect(RESET_FIRST_FRAME_LIMIT_MS).toBeLessThan(LEAVE_FALLBACK_MS);
  });

  it("leaves the hard reset's activation wait room inside the prepare window (C6-8)", () => {
    // The lazy hard-reset chunk keeps its own ACTIVATION_TIMEOUT_MS (an eager
    // import would split this module into its own chunk), so its copy is read
    // here. The prepare window covers that wait plus loading the chunk, so a
    // stalled activation still ends inside it and the logo navigates home.
    const source = readFileSync('src/core/sw-hard-reset.ts', 'utf8');
    const match = /const ACTIVATION_TIMEOUT_MS = ([\d_]+);/u.exec(source);
    expect(match).not.toBeNull();
    const activationTimeoutMs = Number(match![1]!.replaceAll('_', ''));
    expect(activationTimeoutMs).toBe(1_500);
    expect(NAVIGATION_PREPARE_TIMEOUT_MS - activationTimeoutMs).toBeGreaterThanOrEqual(1_000);
  });
});

describe('next-document sessionStorage markers', () => {
  it('keeps the key strings that the previous and the next version read and write', () => {
    // Version N writes these during the very update reload that installs
    // version N+1, which reads them; a renamed key silently drops the marker.
    expect({
      RECONNECT_TARGET_KEY,
      SW_UPDATE_KEY,
      SW_CONTROLLER_CONFIRMED_KEY,
      UPDATE_COMPLETION_KEY,
      PREVIOUS_LINK_CLOSE_KEY,
      PREVIOUS_AUDIO_RECOVERY_KEY,
      BOOT_SPLASH_CONTINUITY_KEY,
      BOOT_SPLASH_CONTINUITY_BOX_KEY,
    }).toEqual({
      RECONNECT_TARGET_KEY: 'mxqr_reconnect_target',
      SW_UPDATE_KEY: 'sw-updated-at',
      SW_CONTROLLER_CONFIRMED_KEY: 'sw-controller-confirmed-at',
      UPDATE_COMPLETION_KEY: 'mxqr-swu',
      PREVIOUS_LINK_CLOSE_KEY: 'mxqr-prev-close',
      PREVIOUS_AUDIO_RECOVERY_KEY: 'mxqr-prev-audio-recovery',
      BOOT_SPLASH_CONTINUITY_KEY: 'mxqr-boot-continuity',
      BOOT_SPLASH_CONTINUITY_BOX_KEY: 'mxqr-boot-continuity-box',
    });
  });
});
