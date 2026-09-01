import { recordServiceWorkerUpdateCompletion } from './sw-update-completion.ts';

const ACTIVATION_TIMEOUT_MS = 1_500;

/** Promote an installed update before an intentional app hard reset. */
export default async function activatePendingServiceWorkerForHardReset(): Promise<undefined> {
  const serviceWorkers = navigator.serviceWorker;
  const registration = await serviceWorkers.getRegistration('/');
  const waitingWorker = registration?.waiting;
  const previousController = serviceWorkers.controller;
  if (!previousController || !waitingWorker || waitingWorker.state !== 'installed')
    return undefined;

  return new Promise<undefined>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      serviceWorkers.removeEventListener('controllerchange', handleControllerChange);
      resolve(undefined);
    };
    const handleControllerChange = () => {
      if (serviceWorkers.controller && serviceWorkers.controller !== previousController) {
        recordServiceWorkerUpdateCompletion();
        finish();
      }
    };
    const timeout = window.setTimeout(finish, ACTIVATION_TIMEOUT_MS);
    serviceWorkers.addEventListener('controllerchange', handleControllerChange);

    // Close the tiny listener-install race if another tab activated the same
    // waiting generation while this reset was being prepared.
    handleControllerChange();
    if (settled) return;
    try {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      finish();
    }
  });
}
