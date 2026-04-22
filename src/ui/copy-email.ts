/**
 * MUSIXQUARE — Email Copy Handler
 *
 * Delegated click listener for [data-copy-email] anchors (e.g. the contact
 * email in legal.content_html). Copies the address to the clipboard and
 * shows a toast instead of opening the user's mail client.
 */

import { copyTextToClipboard } from './dom.ts';
import { showToast } from './toast.ts';
import { t } from '../i18n/index.ts';

export function initEmailCopyLinks(): void {
  document.body.addEventListener('click', async (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy-email]');
    if (!target) return;
    e.preventDefault();
    const email = target.getAttribute('data-copy-email') || target.textContent?.trim() || '';
    if (!email) return;
    const ok = await copyTextToClipboard(email);
    showToast(ok ? t('toast.email_copied') : t('toast.copy_failed'));
  });
}
