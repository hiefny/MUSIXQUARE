import { expect, test, type CDPSession, type Page } from '@playwright/test';
import {
  cleanupContexts,
  createHostGuestContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { uploadFixtures } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import {
  navigateToSubtab,
  navigateToTab,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

/**
 * Hover hint policy (src/ui/control-hint.ts): an unavailable control's reason
 * is written when its state changes, never when a pointer arrives, so keyboard
 * and screen reader users get the same reason as a description. A host who
 * has not chosen media yet has an unavailable sync button and seek bar; this
 * reads both from Chromium's accessibility tree without moving the mouse. A
 * guest whose audio settings follow the room reads each locked effect group's
 * reason as a sentence ahead of the group's section description.
 */

interface AxSummary {
  name: string;
  description: string;
  title: string | null;
  ariaDisabled: string | null;
  role: string;
  ignored: boolean;
}

async function accessibleSummary(
  page: Page,
  cdp: CDPSession,
  selector: string,
): Promise<AxSummary> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  expect(nodeId, selector).toBeGreaterThan(0);
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
    nodeId,
    fetchRelatives: false,
  });
  const node = nodes[0];
  const attributes = await page.locator(selector).evaluate((element) => ({
    title: element.getAttribute('title'),
    ariaDisabled: element.getAttribute('aria-disabled'),
  }));
  return {
    name: String(node?.name?.value ?? ''),
    description: String(node?.description?.value ?? ''),
    role: String(node?.role?.value ?? ''),
    ignored: node?.ignored ?? true,
    ...attributes,
  };
}

const normalize = (text: string | null): string => (text ?? '').replace(/\s+/gu, ' ').trim();

test.describe('Control hints for keyboard and screen reader users', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the unavailable sync button and seek bar keep their reasons as descriptions', async ({
    page,
  }) => {
    await injectPeerServer(page);
    await setupHostAndStart(page);
    await expect(page.locator('#btn-sync')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#seek-slider')).toHaveAttribute('aria-disabled', 'true');

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    await page.locator('#btn-sync').focus();

    for (const selector of ['#btn-sync', '#seek-slider']) {
      const summary = await accessibleSummary(page, cdp, selector);
      expect(summary.ariaDisabled, selector).toBe('true');
      expect(normalize(summary.title), selector).not.toBe('');
      // The reason is the description, and it is not the control's name.
      expect(normalize(summary.description), selector).toBe(normalize(summary.title));
      expect(normalize(summary.name), selector).not.toBe('');
      expect(normalize(summary.name), selector).not.toBe(normalize(summary.description));
    }
    await cdp.detach();
  });

  test('the playlist minus keeps one name, describes the mode it starts, and the count is announced', async ({
    page,
  }) => {
    await injectPeerServer(page);
    await setupHostAndStart(page);
    await uploadFixtures(page, ['test01', 'test02']);
    await waitForPlaylistCount(page, 2);
    // The selection controller loads after the list mounts and adds the
    // screen-reader status cell before anything is picked.
    const status = page.locator('#tab-playlist .playlist-selection-status');
    await expect(status).toHaveCount(1);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const minus = '#playlist-ui .playlist-entry:first-child .btn-playlist-select';
    const title = normalize(
      await page.locator('#playlist-ui .playlist-entry:first-child .track-name-text').textContent(),
    );

    const resting = await accessibleSummary(page, cdp, minus);
    expect(normalize(resting.name)).toBe(`Select ${title}`);
    expect(normalize(resting.description)).toBe('Select this track and enter selection mode');
    const statusNode = await accessibleSummary(
      page,
      cdp,
      '#tab-playlist .playlist-selection-status',
    );
    expect(statusNode.ignored).toBe(false);
    expect(statusNode.role).toBe('status');

    await page.locator(minus).click();
    await expect(page.locator(minus)).toHaveAttribute('aria-pressed', 'true');
    await expect(status).toHaveText('1 selected');
    const picked = await accessibleSummary(page, cdp, minus);
    // Same name; the pressed state alone says it is picked, and a press now
    // only picks, so no hint is described.
    expect(normalize(picked.name)).toBe(normalize(resting.name));
    expect(normalize(picked.description)).toBe('');
    const bar = await accessibleSummary(page, cdp, '.playlist-selection-bar');
    expect(normalize(bar.name)).toBe('1 selected');
    const titleButton = page.locator('#playlist-ui .playlist-entry:first-child .track-name');
    await expect(titleButton).toHaveAttribute('aria-pressed', 'true');
    await expect(titleButton).toHaveAttribute('tabindex', '-1');

    await page.locator('[data-selection-action="cancel"]').click();
    await expect(status).toHaveText('');
    await expect(titleButton).not.toHaveAttribute('aria-pressed');
    await expect(titleButton).not.toHaveAttribute('tabindex');
    await cdp.detach();
  });
});

test.describe('Locked audio settings for screen reader users', () => {
  let pair: HostGuestPair;

  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('a locked effect group reads its lock as a sentence before its description', async () => {
    const guest = pair.guestPage;
    await guest.addInitScript(() => localStorage.setItem('musixquare-lang', 'en'));
    await connectHostAndGuest(pair.hostPage, guest);
    await waitForState(guest, 'audio.settingsSyncEnabled', true);
    await navigateToTab(guest, 'settings');
    await navigateToSubtab(guest, 'audio');

    const reverb = guest.locator('#grid-reverb');
    await expect(reverb).toHaveAttribute('aria-disabled', 'true');
    // The hover hint keeps the phrase once the host's role projection is in.
    await expect(reverb).toHaveAttribute('title', 'Only room admins can change audio settings');

    const cdp = await guest.context().newCDPSession(guest);
    await cdp.send('Accessibility.enable');
    // Chromium joins the reason and the section description with one space,
    // so the reason ends its own sentence.
    const description = async () =>
      normalize((await accessibleSummary(guest, cdp, '#grid-reverb')).description);
    await expect.poll(description).toBe(
      "Only room admins can change audio settings. Adjust the sound's reverb and resonance.",
    );
    await cdp.detach();
  });
});
