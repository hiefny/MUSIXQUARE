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
import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  clickAndWaitActive,
  navigateToSubtab,
  navigateToTab,
  readState,
  waitForState,
} from './helpers/wait.ts';

let pair: HostGuestPair;

async function openAudioSettings(page: Page): Promise<void> {
  await navigateToTab(page, 'settings');
  const audioTab = page.locator('.subtab-pill[data-subtab="audio"]');
  await expect(audioTab).toBeVisible();
  await navigateToSubtab(page, 'audio');
}

async function selectSubwooferRole(page: Page): Promise<void> {
  await openAudioSettings(page);
  const subwoofer = page.locator('#grid-standard .ch-opt[data-ch="2"]');
  await expect(subwoofer).toBeVisible();
  await clickAndWaitActive(page, '#grid-standard .ch-opt[data-ch="2"]');
  await waitForState(page, 'audio.channelMode', 2);
  await expect(page.locator('#woofer-cutoff-control')).not.toHaveClass(/collapsed/);
}

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

    await openAudioSettings(pair.hostPage);

    for (let i = 0; i < 5; i++) {
      await expect(pair.hostPage.locator(`#eq-slider-${i}`)).toBeAttached();
    }

    // Dispatch through the DOM because responsive layout may hide the slider.
    const eqSlider0 = pair.hostPage.locator('#eq-slider-0');
    await eqSlider0.evaluate((el: HTMLInputElement) => {
      el.value = '6';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await waitForState(pair.hostPage, 'audio.eqValues', [6, 0, 0, 0, 0]);

    const eqValues = (await readState(pair.hostPage, 'audio.eqValues')) as number[];
    expect(eqValues[0]).toBe(6);
  });

  test('EQ preset "bright" applies correct values', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const brightBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="bright"]');
    await expect(brightBtn).toBeVisible();
    await brightBtn.click();

    await waitForState(pair.hostPage, 'audio.eqValues', [0, -2, 0, 4, 6]);
    const eqValues = (await readState(pair.hostPage, 'audio.eqValues')) as number[];
    expect(eqValues).toEqual([0, -2, 0, 4, 6]);
  });

  test('EQ preset "warm" applies correct values', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const warmBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="warm"]');
    await expect(warmBtn).toBeVisible();
    await warmBtn.click();

    await waitForState(pair.hostPage, 'audio.eqValues', [5, 3, 0, -2, -3]);
    const eqValues = (await readState(pair.hostPage, 'audio.eqValues')) as number[];
    expect(eqValues).toEqual([5, 3, 0, -2, -3]);
  });

  test('EQ preset "off" resets all bands to 0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const brightBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="bright"]');
    await expect(brightBtn).toBeVisible();
    await brightBtn.click();
    await waitForState(pair.hostPage, 'audio.eqValues', [0, -2, 0, 4, 6]);

    const offBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="off"]');
    await expect(offBtn).toBeVisible();
    await offBtn.click();

    await waitForState(pair.hostPage, 'audio.eqValues', [0, 0, 0, 0, 0]);
    const eqValues = (await readState(pair.hostPage, 'audio.eqValues')) as number[];
    expect(eqValues).toEqual([0, 0, 0, 0, 0]);
  });

  test('EQ value display updates with slider', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    // Sliders are rendered only in advanced mode.
    const advBtn = pair.hostPage.locator('#grid-eq .ch-opt[data-eq-type="advanced"]');
    await expect(advBtn).toBeVisible();
    await clickAndWaitActive(pair.hostPage, '#grid-eq .ch-opt[data-eq-type="advanced"]');

    const eqSlider2 = pair.hostPage.locator('#eq-slider-2');
    await expect(eqSlider2).toBeVisible();
    await eqSlider2.fill('-8');
    await eqSlider2.dispatchEvent('input');

    await pair.hostPage.waitForFunction(
      () => document.getElementById('eq-val-2')?.textContent?.includes('-8') ?? false,
    );

    const valText = await pair.hostPage.locator('#eq-val-2').textContent();
    expect(valText).toContain('-8');
  });

  // ── Reverb Tests ──────────────────────────────────────────────

  test('reverb mix slider changes state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    // The mix slider is rendered only in advanced mode.
    const advBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="advanced"]');
    await expect(advBtn).toBeVisible();
    await clickAndWaitActive(pair.hostPage, '#grid-reverb .ch-opt[data-rvb-type="advanced"]');

    const reverbSlider = pair.hostPage.locator('#reverb-slider');
    await expect(reverbSlider).toBeVisible();
    await reverbSlider.fill('50');
    await reverbSlider.dispatchEvent('change');

    await waitForState(pair.hostPage, 'audio.reverbMix', 0.5);
    const reverbMix = (await readState(pair.hostPage, 'audio.reverbMix')) as number;
    expect(reverbMix).toBeCloseTo(0.5, 1);
  });

  test('reverb preset "studio" applies settings', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const studioBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="studio"]');
    await expect(studioBtn).toBeVisible();
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

    const reverbMix = (await readState(pair.hostPage, 'audio.reverbMix')) as number;
    expect(reverbMix).toBeGreaterThan(0);
  });

  test('reverb preset "off" resets mix to 0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const studioBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="studio"]');
    await expect(studioBtn).toBeVisible();
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

    const offBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="off"]');
    await expect(offBtn).toBeVisible();
    await offBtn.click();

    await waitForState(pair.hostPage, 'audio.reverbMix', 0);
    const reverbMix = (await readState(pair.hostPage, 'audio.reverbMix')) as number;
    expect(reverbMix).toBe(0);
  });

  test('reverb decay slider adjusts decay time', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const advBtn = pair.hostPage.locator('#grid-reverb .ch-opt[data-rvb-type="advanced"]');
    await expect(advBtn).toBeVisible();
    await clickAndWaitActive(pair.hostPage, '#grid-reverb .ch-opt[data-rvb-type="advanced"]');

    const decaySlider = pair.hostPage.locator('#reverb-decay-slider');
    await expect(decaySlider).toBeVisible();
    await expect(decaySlider).toHaveAttribute('max', '10.0');
    const maxDecay = Number(await decaySlider.getAttribute('max'));
    await decaySlider.fill(String(maxDecay));
    await decaySlider.dispatchEvent('change');

    await waitForState(pair.hostPage, 'audio.reverbDecay', maxDecay);
    const decay = (await readState(pair.hostPage, 'audio.reverbDecay')) as number;
    expect(decay).toBe(maxDecay);
  });

  // ── Stereo Width Tests ──────────────────────────────────────

  test('stereo width toggle changes state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const initialWidth = (await readState(pair.hostPage, 'audio.stereoWidth')) as number;

    const onBtn = pair.hostPage.locator('#grid-surround .ch-opt[data-toggle="on"]');
    await expect(onBtn).toBeVisible();
    await onBtn.click();

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

    const newWidth = (await readState(pair.hostPage, 'audio.stereoWidth')) as number;
    expect(newWidth).not.toBe(initialWidth);
    expect(newWidth).toBeGreaterThan(1);
  });

  test('stereo width off resets to 1.0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const onBtn = pair.hostPage.locator('#grid-surround .ch-opt[data-toggle="on"]');
    await expect(onBtn).toBeVisible();
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

    const offBtn = pair.hostPage.locator('#grid-surround .ch-opt[data-toggle="off"]');
    await expect(offBtn).toBeVisible();
    await offBtn.click();

    await waitForState(pair.hostPage, 'audio.stereoWidth', 1);
    const width = (await readState(pair.hostPage, 'audio.stereoWidth')) as number;
    expect(width).toBe(1);
  });

  // ── Virtual Bass Tests ──────────────────────────────────────

  test('virtual bass toggle enables enhancement', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const onBtn = pair.hostPage.locator('#grid-vbass .ch-opt[data-toggle="on"]');
    await expect(onBtn).toBeVisible();
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

    const vbass = (await readState(pair.hostPage, 'audio.virtualBass')) as number;
    expect(vbass).toBeGreaterThan(0);
  });

  test('virtual bass off resets to 0', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openAudioSettings(pair.hostPage);

    const onBtn = pair.hostPage.locator('#grid-vbass .ch-opt[data-toggle="on"]');
    await expect(onBtn).toBeVisible();
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

    const offBtn = pair.hostPage.locator('#grid-vbass .ch-opt[data-toggle="off"]');
    await expect(offBtn).toBeVisible();
    await offBtn.click();

    await waitForState(pair.hostPage, 'audio.virtualBass', 0);
    const vbass = (await readState(pair.hostPage, 'audio.virtualBass')) as number;
    expect(vbass).toBe(0);
  });

  // ── Volume Tests ──────────────────────────────────────────────

  test('volume slider changes master volume', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const volumeSlider = pair.hostPage.locator('#volume-slider');
    await expect(volumeSlider).toBeVisible();
    await volumeSlider.fill('50');
    await volumeSlider.dispatchEvent('input');

    await waitForState(pair.hostPage, 'audio.masterVolume', 0.5);
    const volume = (await readState(pair.hostPage, 'audio.masterVolume')) as number;
    expect(volume).toBeCloseTo(0.5, 1);
  });

  test('volume slider at 0 mutes', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const volumeSlider = pair.hostPage.locator('#volume-slider');
    await expect(volumeSlider).toBeVisible();
    await volumeSlider.fill('0');
    await volumeSlider.dispatchEvent('input');

    await waitForState(pair.hostPage, 'audio.masterVolume', 0);
    const volume = (await readState(pair.hostPage, 'audio.masterVolume')) as number;
    expect(volume).toBe(0);
  });

  test('volume slider at 100 is full volume', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const volumeSlider = pair.hostPage.locator('#volume-slider');
    await expect(volumeSlider).toBeVisible();
    await volumeSlider.fill('100');
    await volumeSlider.dispatchEvent('input');

    await waitForState(pair.hostPage, 'audio.masterVolume', 1);
    const volume = (await readState(pair.hostPage, 'audio.masterVolume')) as number;
    expect(volume).toBe(1);
  });

  // ── Subwoofer Cutoff Tests ──────────────────────────────────

  test('subwoofer cutoff slider visible in sub mode', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await selectSubwooferRole(pair.hostPage);

    const cutoffSlider = pair.hostPage.locator('#cutoff-slider');
    await expect(cutoffSlider).toBeVisible();
  });

  test('subwoofer cutoff changes subFreq state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await selectSubwooferRole(pair.hostPage);

    const cutoffSlider = pair.hostPage.locator('#cutoff-slider');
    await expect(cutoffSlider).toBeVisible();
    await cutoffSlider.fill('200');
    await cutoffSlider.dispatchEvent('change');

    await waitForState(pair.hostPage, 'audio.subFreq', 200);
    const subFreq = (await readState(pair.hostPage, 'audio.subFreq')) as number;
    expect(subFreq).toBe(200);
  });
});
