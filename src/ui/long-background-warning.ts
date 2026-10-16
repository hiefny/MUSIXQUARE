/**
 * The generic warning after a long absence from a room ("앱이 잠시
 * 백그라운드로 넘어갔어요").
 *
 * An audio recovery dialog for the same return already says the app came back
 * from the background, and its button is the gesture that restores this
 * device's sound. It therefore replaces the warning: once audio recovery owns
 * a return, the warning is skipped for the rest of it, and a warning that is
 * already on screen or queued is withdrawn (owner decision 2026-10-17).
 */

import { t } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';

export function createLongBackgroundWarning(deps: {
  /** Whether an audio recovery dialog is open or queued. */
  hasAudioRecoveryPrompt: () => boolean;
}) {
  let yielded = false;
  let openWarning: AbortController | null = null;

  return {
    /** A new return from the background: the warning may show again. */
    beginIncident(): void {
      yielded = false;
    },
    /** Audio recovery owns this return: skip or withdraw the warning. */
    yieldToAudioRecovery(): void {
      yielded = true;
      openWarning?.abort();
    },
    /** Show the warning unless this return already belongs to audio recovery. */
    async warn(): Promise<void> {
      if (yielded || deps.hasAudioRecoveryPrompt()) return;
      const abort = new AbortController();
      openWarning = abort;
      try {
        await showDialog({
          title: t('dialog.background_resume_title'),
          message: t('dialog.background_resume_message'),
          buttonText: t('dialog.got_it'),
          defaultFocus: 'primary',
          signal: abort.signal,
        });
      } finally {
        if (openWarning === abort) openWarning = null;
      }
    },
  };
}
