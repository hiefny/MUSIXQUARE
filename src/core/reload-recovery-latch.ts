interface ReloadRecoveryOptions<Context> {
  present(context: Context): Promise<'accept' | 'decline'>;
  reload(context: Context, onRecovered: () => void): void;
  onDeclined(context: Context): void;
  onRecovered(context: Context): void;
  onPresentationFailure(context: Context, error: unknown): void;
}

/**
 * Keep one recovery prompt/reload attempt alive until it commits navigation
 * or explicitly reports that the old document survived. A recovery callback
 * may be delivered more than once by defensive lifecycle coordinators; only
 * its first delivery releases the latch and publishes the fallback outcome.
 */
export function createReloadRecoveryLatch<Context>(
  options: ReloadRecoveryOptions<Context>,
): (context: Context) => void {
  let activeAttempt: Promise<void> | null = null;

  return (context) => {
    activeAttempt ??= options
      .present(context)
      .then((choice) => {
        if (choice !== 'accept') {
          activeAttempt = null;
          options.onDeclined(context);
          return;
        }

        let recoveryReturned = false;
        options.reload(context, () => {
          if (recoveryReturned) return;
          recoveryReturned = true;
          activeAttempt = null;
          options.onRecovered(context);
        });
      })
      .catch((error: unknown) => {
        activeAttempt = null;
        options.onPresentationFailure(context, error);
      });
  };
}
