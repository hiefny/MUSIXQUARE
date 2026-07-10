/** Copy delegated `[data-copy-email]` links without navigating to a mail client. */

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
