const ENTRANCE_CLASSES = [
  'app-entrance',
  'app-entrance-down',
  'app-entrance-up',
  'app-entrance-left',
  'app-entrance-right',
  'app-entered',
] as const;

/**
 * Fail open only after the initial setup transition has had one frame to claim
 * the screen. This keeps a recoverable setup exception from stranding the
 * parser-time boot guard or its prepared entrance transforms forever.
 */
export function failOpenSetupBootGuard(): void {
  const release = (): void => {
    try {
      if (document.getElementById('setup-overlay')?.classList.contains('active')) return;

      for (const element of document.querySelectorAll<HTMLElement>('.app-entrance')) {
        element.classList.remove(...ENTRANCE_CLASSES);
        element.style.removeProperty('--entrance-delay');
      }
      document.body?.classList.add('fouc-loaded');
      document.documentElement.classList.add('setup-boot-failed');
      document.documentElement.classList.remove('setup-boot-block');
    } catch {
      /* bootstrap failure recovery must remain best-effort */
    }
  };

  try {
    requestAnimationFrame(release);
  } catch {
    release();
  }
}
