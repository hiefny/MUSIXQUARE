interface ReloadRecoveryOptions<Context> {
  present(context: Context): Promise<'accept' | 'decline'>;
  reload(context: Context, onRecovered: () => void): void;
  onDeclined(context: Context): void;
  onRecovered(context: Context): void;
  onPresentationFailure(context: Context, error: unknown): void;
}

/**
 * Keep one recovery prompt/reload attempt alive until it commits navigation
 * or explicitly reports that the old document survived. The navigation owner
 * reports a reload's recovery at most once per attempt (core/session-reset.ts,
 * C6-4), so the latch keeps no repeated-delivery guard of its own (C6-13).
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

        options.reload(context, () => {
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
