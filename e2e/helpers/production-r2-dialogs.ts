import { expect, type Page } from '@playwright/test';

/**
 * Fresh production contexts get two dialogs when their first files use R2.
 * The shared overlay can stay open as consent gives way to keep-open guidance;
 * identify each dialog before acting rather than treating any open overlay as
 * the original consent or clicking through an unexpected production error.
 */
export async function acceptLargeRoomUploadConsent(page: Page, timeout = 10_000): Promise<void> {
  const dialog = page.locator('#dialog-overlay');
  const title = dialog.locator('#dialog-title');
  const message = dialog.locator('#dialog-message');
  const primary = dialog.locator('#btn-dialog-ok');

  await expect(dialog).toHaveClass(/\bshow\b/u, { timeout });
  await expect(title).toHaveText('File sharing in a large room', { timeout });
  await expect(message).toContainText('Cloudflare R2', { timeout });
  await expect(message).toContainText(/(^|\D)8(\D|$)/u, { timeout });
  await expect(primary).toHaveText('Continue', { timeout });
  console.log(`[production-live] large-room consent: ${await message.innerText()}`);
  await primary.click();

  // First-media guidance is required for these fresh contexts. Do not skip it
  // based on a transient hidden overlay, which may reopen for the queued notice.
  await expect(title).toHaveText('Please keep the app open', { timeout });
  await expect(dialog).toHaveClass(/\bshow\b/u, { timeout });
  await expect(message).toContainText('Switching apps or turning off the screen', { timeout });
  await expect(primary).toHaveText('Got it', { timeout });
  console.log('[production-live] acknowledging first-media keep-open guidance');
  await primary.click();
  await expect(dialog).not.toHaveClass(/\bshow\b/u, { timeout });
}
