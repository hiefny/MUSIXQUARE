import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';

/**
 * Hover hint policy (src/ui/control-hint.ts): an unavailable control's reason
 * is written when its state changes, never when a pointer arrives, so keyboard
 * and screen reader users get the same reason as a description. A host who
 * has not chosen media yet has an unavailable sync button and seek bar; this
 * reads both from Chromium's accessibility tree without moving the mouse.
 */

interface AxSummary {
  name: string;
  description: string;
  title: string | null;
  ariaDisabled: string | null;
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
});
