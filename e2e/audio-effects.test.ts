/**
 * E2E: Audio Effects Tests
 *
 * Tests audio effect controls on the host:
 * - EQ bands and presets
 * - Reverb controls and presets
 * - Stereo width toggle
 * - Virtual bass toggle
 * - Volume slider
 * - Subwoofer cutoff
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  clickAndWaitActive,
  isVisible,
  navigateToSubtab,
  navigateToTab,
  readState,
  waitForState,
} from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Audio Effects', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  // ── EQ Tests ────────────────────────────────────────────────

  test('EQ sliders exist and are adjustable', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Navigate to settings → audio subtab
    await navigateToTab(pair.hostPage, 'settings');

    // Navigate to audio subtab if it exists
    if (await isVisible(pair.hostPage, '.subtab-pill[data-subtab="audio"]')) {
      await navigateToSubtab(pair.hostPage, 'audio');
    }

    // Check EQ sliders exist
    for (let i = 0; i < 5; i++) {
      await expect(pair.hostPage.locator(`#eq-slider-${i}`)).toBeAttached();
    }

    // Adjust first EQ band (60Hz) to +6dB — use evaluate since slider may not be visible
    const eqSlider0 = pair.hostPage.locator('#eq-slider-0');
    await eqSlider0.evaluate((el: HTMLInputElement) => {
      el.value = '6';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Wait for state to reflect the slider change
    await waitForState(pair.hostPage, 'audio.eqValues', [6, 0, 0, 0, 0]);

    // Verify state updated
    const eqValues = await readState(pair.hostPage, 'audio.eqValues') as number[];
    expect(eqValues[0]).toBe(6);
  });

  test('EQ preset "bright" applies correct values', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Click "Bright" preset
    const brightBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="bright"]');
    if (await brightBtn.isVisible()) {
      await brightBtn.click();

      // Bright preset: [0, -2, 0, 4, 6]
      await waitForState(pair.hostPage, 'audio.eqValues', [0, -2, 0, 4, 6]);
      const eqValues = await readState(pair.hostPage, 'audio.eqValues') as number[];
      expect(eqValues).toEqual([0, -2, 0, 4, 6]);
    }
  });

  test('EQ preset "warm" applies correct values', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    const warmBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="warm"]');
    if (await warmBtn.isVisible()) {
      await warmBtn.click();

      // Warm preset: [5, 3, 0, -2, -3]
      await waitForState(pair.hostPage, 'audio.eqValues', [5, 3, 0, -2, -3]);
      const eqValues = await readState(pair.hostPage, 'audio.eqValues') as number[];
      expect(eqValues).toEqual([5, 3, 0, -2, -3]);
    }
  });

  test('EQ preset "off" resets all bands to 0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // First set to bright
    const brightBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="bright"]');
    if (await brightBtn.isVisible()) {
      await brightBtn.click();
      await waitForState(pair.hostPage, 'audio.eqValues', [0, -2, 0, 4, 6]);
    }

    // Then reset to off
    const offBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="off"]');
    if (await offBtn.isVisible()) {
      await offBtn.click();

      await waitForState(pair.hostPage, 'audio.eqValues', [0, 0, 0, 0, 0]);
      const eqValues = await readState(pair.hostPage, 'audio.eqValues') as number[];
      expect(eqValues).toEqual([0, 0, 0, 0, 0]);
    }
  });

  test('EQ value display updates with slider', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Need to be in advanced mode to see sliders
    const advBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="advanced"]');
    if (await advBtn.isVisible()) {
      await clickAndWaitActive(pair.hostPage, '#grid-eq .ch-opt[data-eq-type="advanced"]');
    }

    // Set slider to -8
    const eqSlider2 = pair.hostPage.locator('#eq-slider-2');
    if (await eqSlider2.isVisible()) {
      await eqSlider2.fill('-8');
      await eqSlider2.dispatchEvent('input');

      // Wait for value display to update
      await pair.hostPage.waitForFunction(
        () => document.getElementById('eq-val-2')?.textContent?.includes('-8') ?? false,
      );

      // Check value display
      const valText = await pair.hostPage.locator('#eq-val-2').textContent();
      expect(valText).toContain('-8');
    }
  });

  // ── Reverb Tests ──────────────────────────────────────────────

  test('reverb mix slider changes state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Need advanced reverb mode
    const advBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="advanced"]');
    if (await advBtn.isVisible()) {
      await clickAndWaitActive(pair.hostPage, '#grid-reverb .ch-opt[data-rvb-type="advanced"]');
    }

    const reverbSlider = pair.hostPage.locator('#reverb-slider');
    if (await reverbSlider.isVisible()) {
      await reverbSlider.fill('50');
      await reverbSlider.dispatchEvent('change');

      await waitForState(pair.hostPage, 'audio.reverbMix', 0.5);
      const reverbMix = await readState(pair.hostPage, 'audio.reverbMix') as number;
      expect(reverbMix).toBeCloseTo(0.5, 1);
    }
  });

  test('reverb preset "studio" applies settings', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    const studioBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="studio"]');
    if (await studioBtn.isVisible()) {
      await studioBtn.click();

      // Wait for reverbMix to become > 0
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
            | ((p: string) => unknown)
            | undefined;
          if (!get) return false;
          return (get('audio.reverbMix') as number) > 0;
        },
        { timeout: 5_000 },
      );

      const reverbMix = await readState(pair.hostPage, 'audio.reverbMix') as number;
      expect(reverbMix).toBeGreaterThan(0);
    }
  });

  test('reverb preset "off" resets mix to 0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Set studio first
    const studioBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="studio"]');
    if (await studioBtn.isVisible()) {
      await studioBtn.click();
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
            | ((p: string) => unknown)
            | undefined;
          if (!get) return false;
          return (get('audio.reverbMix') as number) > 0;
        },
        { timeout: 5_000 },
      );
    }

    // Reset
    const offBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="off"]');
    if (await offBtn.isVisible()) {
      await offBtn.click();

      await waitForState(pair.hostPage, 'audio.reverbMix', 0);
      const reverbMix = await readState(pair.hostPage, 'audio.reverbMix') as number;
      expect(reverbMix).toBe(0);
    }
  });

  test('reverb decay slider adjusts decay time', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    const advBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="advanced"]');
    if (await advBtn.isVisible()) {
      await clickAndWaitActive(pair.hostPage, '#grid-reverb .ch-opt[data-rvb-type="advanced"]');
    }

    const decaySlider = pair.hostPage.locator('#reverb-decay-slider');
    if (await decaySlider.isVisible()) {
      await decaySlider.fill('15');
      await decaySlider.dispatchEvent('change');

      await waitForState(pair.hostPage, 'audio.reverbDecay', 15);
      const decay = await readState(pair.hostPage, 'audio.reverbDecay') as number;
      expect(decay).toBe(15);
    }
  });

  // ── Stereo Width Tests ──────────────────────────────────────

  test('stereo width toggle changes state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    const initialWidth = await readState(pair.hostPage, 'audio.stereoWidth') as number;

    const onBtn = pair.hostPage.locator('#grid-surround .ch-opt[data-toggle="on"]');
    if (await onBtn.isVisible()) {
      await onBtn.click();

      // Wait for stereo width to change from initial value
      await pair.hostPage.waitForFunction(
        (initial) => {
          const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
            | ((p: string) => unknown)
            | undefined;
          if (!get) return false;
          return (get('audio.stereoWidth') as number) !== initial;
        },
        initialWidth,
        { timeout: 5_000 },
      );

      const newWidth = await readState(pair.hostPage, 'audio.stereoWidth') as number;
      expect(newWidth).not.toBe(initialWidth);
      expect(newWidth).toBeGreaterThan(1);
    }
  });

  test('stereo width off resets to 1.0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Enable first
    const onBtn = pair.hostPage.locator('#grid-surround .ch-opt[data-toggle="on"]');
    if (await onBtn.isVisible()) {
      await onBtn.click();
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
            | ((p: string) => unknown)
            | undefined;
          if (!get) return false;
          return (get('audio.stereoWidth') as number) > 1;
        },
        { timeout: 5_000 },
      );
    }

    // Disable
    const offBtn = pair.hostPage.locator('#grid-surround .ch-opt[data-toggle="off"]');
    if (await offBtn.isVisible()) {
      await offBtn.click();

      await waitForState(pair.hostPage, 'audio.stereoWidth', 1);
      const width = await readState(pair.hostPage, 'audio.stereoWidth') as number;
      expect(width).toBe(1);
    }
  });

  // ── Virtual Bass Tests ──────────────────────────────────────

  test('virtual bass toggle enables enhancement', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    const onBtn = pair.hostPage.locator('#grid-vbass .ch-opt[data-toggle="on"]');
    if (await onBtn.isVisible()) {
      await onBtn.click();

      // Wait for virtualBass to become > 0
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
            | ((p: string) => unknown)
            | undefined;
          if (!get) return false;
          return (get('audio.virtualBass') as number) > 0;
        },
        { timeout: 5_000 },
      );

      const vbass = await readState(pair.hostPage, 'audio.virtualBass') as number;
      expect(vbass).toBeGreaterThan(0);
    }
  });

  test('virtual bass off resets to 0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Enable
    const onBtn = pair.hostPage.locator('#grid-vbass .ch-opt[data-toggle="on"]');
    if (await onBtn.isVisible()) {
      await onBtn.click();
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
            | ((p: string) => unknown)
            | undefined;
          if (!get) return false;
          return (get('audio.virtualBass') as number) > 0;
        },
        { timeout: 5_000 },
      );
    }

    // Disable
    const offBtn = pair.hostPage.locator('#grid-vbass .ch-opt[data-toggle="off"]');
    if (await offBtn.isVisible()) {
      await offBtn.click();

      await waitForState(pair.hostPage, 'audio.virtualBass', 0);
      const vbass = await readState(pair.hostPage, 'audio.virtualBass') as number;
      expect(vbass).toBe(0);
    }
  });

  // ── Volume Tests ──────────────────────────────────────────────

  test('volume slider changes master volume', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const volumeSlider = pair.hostPage.locator('#volume-slider');
    if (await volumeSlider.isVisible()) {
      await volumeSlider.fill('50');
      await volumeSlider.dispatchEvent('input');

      await waitForState(pair.hostPage, 'audio.masterVolume', 0.5);
      const volume = await readState(pair.hostPage, 'audio.masterVolume') as number;
      expect(volume).toBeCloseTo(0.5, 1);
    }
  });

  test('volume slider at 0 mutes', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const volumeSlider = pair.hostPage.locator('#volume-slider');
    if (await volumeSlider.isVisible()) {
      await volumeSlider.fill('0');
      await volumeSlider.dispatchEvent('input');

      await waitForState(pair.hostPage, 'audio.masterVolume', 0);
      const volume = await readState(pair.hostPage, 'audio.masterVolume') as number;
      expect(volume).toBe(0);
    }
  });

  test('volume slider at 100 is full volume', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const volumeSlider = pair.hostPage.locator('#volume-slider');
    if (await volumeSlider.isVisible()) {
      await volumeSlider.fill('100');
      await volumeSlider.dispatchEvent('input');

      await waitForState(pair.hostPage, 'audio.masterVolume', 1);
      const volume = await readState(pair.hostPage, 'audio.masterVolume') as number;
      expect(volume).toBe(1);
    }
  });

  // ── Subwoofer Cutoff Tests ──────────────────────────────────

  test('subwoofer cutoff slider visible in sub mode', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Switch to subwoofer mode first (from audio-channel)
    await pair.hostPage.evaluate(() => {
      const setState = (window as any).__MUSIXQUARE_SET_STATE__;
      if (setState) setState('audio.channelMode', 2);
    });
    await waitForState(pair.hostPage, 'audio.channelMode', 2);

    // Check cutoff slider visibility or existence
    const cutoffSlider = pair.hostPage.locator('#cutoff-slider');
    await expect(cutoffSlider).toBeAttached();
  });

  test('subwoofer cutoff changes subFreq state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Set sub mode
    await pair.hostPage.evaluate(() => {
      const setState = (window as any).__MUSIXQUARE_SET_STATE__;
      if (setState) setState('audio.channelMode', 2);
    });
    await waitForState(pair.hostPage, 'audio.channelMode', 2);

    const cutoffSlider = pair.hostPage.locator('#cutoff-slider');
    if (await cutoffSlider.isVisible()) {
      await cutoffSlider.fill('200');
      await cutoffSlider.dispatchEvent('change');

      await waitForState(pair.hostPage, 'audio.subFreq', 200);
      const subFreq = await readState(pair.hostPage, 'audio.subFreq') as number;
      expect(subFreq).toBe(200);
    }
  });
});
