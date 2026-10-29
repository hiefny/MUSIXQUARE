/**
 * MUSIXQUARE — the one "Leave Session" confirmation.
 *
 * The connect tab's Leave Session buttons, the logo's return home and the
 * Back guard ask through it, so its labels, focus and tone cannot drift apart
 * again (owner decision 2026-10-29): [Stay | Leave], Stay focused first on
 * the left as the exit, Leave on the right in the danger tone. Each caller
 * keeps its body.
 */

import { t } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';

/**
 * `start-screen` says the start screen comes next (connect tab, logo).
 * `history` leaves through browser history, which may lead to the landing
 * page, another site or a blank tab, so it names no destination (Back).
 */
type LeaveSessionBody = 'start-screen' | 'history';

/** Resolves true only when the person chose Leave. */
export async function confirmLeaveSession(body: LeaveSessionBody): Promise<boolean> {
  const result = await showDialog({
    title: t('dialog.return_home_title'),
    message:
      body === 'start-screen'
        ? `${t('dialog.return_home_msg')}\n${t('dialog.return_home_detail')}`
        : t('dialog.return_home_detail'),
    buttonText: t('common.leave'),
    secondaryText: t('common.stay'),
    defaultFocus: 'secondary',
    tone: 'danger',
  });
  return result.action === 'ok';
}
