import { getAccountSnapshot, getAccountStatsScope, subscribeAccount } from '../account/state.ts';
import {
  reconcileAccountLoginSession,
  requestAccountLoginPopup,
  type AccountLoginPopupOutcome,
} from '../account/session.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from '../ui/dialog.ts';

/** A UI intent only; the App independently compares it with its HttpOnly session. */
export function captureActivationAccountIntent(expectedScope: string) {
  const controller = new AbortController();
  const matches = () => {
    const account = getAccountSnapshot();
    return (
      account.status === 'authenticated' &&
      account.account?.profileComplete === true &&
      getAccountStatsScope() === expectedScope
    );
  };
  const unsubscribe = subscribeAccount(() => {
    if (!matches()) controller.abort();
  });
  if (!matches()) controller.abort();
  return {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted && matches(),
    dispose: unsubscribe,
  };
}

/** Keep the claim in the caller's closure while an isolated OAuth popup runs. */
export async function confirmProRoomActivationAccount(): Promise<string | null> {
  let popupMessage: string | null = null;
  while (true) {
    try {
      await reconcileAccountLoginSession();
    } catch {
      const retry = await showDialog({
        title: t('pro.activation_account_title'),
        message: t('pro.activation_account_unavailable'),
        buttonText: t('common.retry'),
        secondaryText: t('common.cancel'),
      });
      if (retry.action === 'ok') continue;
      return null;
    }

    const snapshot = getAccountSnapshot();
    const scope = getAccountStatsScope();
    const hasAccount =
      snapshot.status === 'authenticated' &&
      snapshot.account?.profileComplete === true &&
      !!snapshot.account.nickname &&
      scope !== null;
    // A concurrent account operation can supersede the completed session read.
    // Do not mistake an unavailable/loading projection for an anonymous user.
    if (snapshot.status === 'loading' || snapshot.status === 'unavailable') {
      const retry = await showDialog({
        title: t('pro.activation_account_title'),
        message: t('pro.activation_account_unavailable'),
        buttonText: t('common.retry'),
        secondaryText: t('common.cancel'),
      });
      if (retry.action === 'ok') continue;
      return null;
    }

    if (snapshot.status === 'authenticated' && snapshot.account?.profileComplete === false) {
      // This account is already signed in. Complete (or join) its existing
      // nickname flow instead of asking Google to authenticate it again.
      const outcome = await requestAccountLoginPopup().catch(() => 'error');
      if (outcome === 'authenticated') continue;
      if (outcome === 'cancelled') return null;
      const retry = await showDialog({
        title: t('pro.activation_account_title'),
        message: t('pro.activation_account_unavailable'),
        buttonText: t('common.retry'),
        secondaryText: t('common.cancel'),
      });
      if (retry.action === 'ok') continue;
      return null;
    }

    const loginAttempt: { current: Promise<AccountLoginPopupOutcome> | null } = { current: null };
    const openLogin = () => {
      loginAttempt.current = requestAccountLoginPopup({ forceGoogleAccountChooser: true }).catch(
        () => 'error',
      );
    };
    const intent = hasAccount ? captureActivationAccountIntent(scope) : null;
    let result;
    try {
      const message = hasAccount
        ? t('pro.activation_account_message', { name: snapshot.account!.nickname })
        : t('pro.activation_account_login_message');
      result = await showDialog({
        title: t('pro.activation_account_title'),
        message: popupMessage ? `${message}\n\n${popupMessage}` : message,
        buttonText: t(hasAccount ? 'pro.activation_account_continue' : 'pro.claim_login_button'),
        secondaryText: t(hasAccount ? 'pro.activation_account_switch' : 'common.cancel'),
        actionLayout: 'stacked',
        dismissible: true,
        defaultFocus: 'primary',
        signal: intent?.signal,
        ...(hasAccount ? { onSecondaryActivation: openLogin } : { onPrimaryActivation: openLogin }),
      });
      if (intent && !intent.isCurrent() && !loginAttempt.current) continue;
      if (hasAccount && result.action === 'ok') return scope;
    } finally {
      intent?.dispose();
    }

    if (result.action !== (hasAccount ? 'secondary' : 'ok')) return null;
    const outcome = await (loginAttempt.current ?? Promise.resolve('error'));
    if (outcome === 'authenticated') {
      popupMessage = null;
      // Sign-in never constitutes consent to register: show the chosen account.
      continue;
    }
    popupMessage = t(
      outcome === 'blocked'
        ? 'pro.claim_popup_blocked_message'
        : outcome === 'cancelled'
          ? 'account.login_cancelled'
          : 'account.login_failed',
    );
  }
}
