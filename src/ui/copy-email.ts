/** Copy delegated `[data-copy-email]` links without navigating to a mail client. */

import { copyTextToClipboard } from './dom.ts';
import { log } from '../core/log.ts';
import { showToast } from './toast.ts';
import { t } from '../i18n/index.ts';

export function initEmailCopyLinks(): void {
  document.body.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy-email]');
    if (!target) return;
    e.preventDefault();
    const email = target.getAttribute('data-copy-email') || target.textContent?.trim() || '';
    if (!email) return;
    copyTextToClipboard(email)
      .then((ok) => {
        showToast(ok ? t('toast.email_copied') : t('toast.copy_failed'));
      })
      .catch((error) => {
        log.warn('[Email] Copy failed', error);
        showToast(t('toast.copy_failed'));
      });
  });
}
