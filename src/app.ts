// MUSIXQUARE-authored file: AGPLv3 section 7 terms are in ADDITIONAL_TERMS.md; trademark use is addressed separately in TRADEMARKS.md.
/**
 * MUSIXQUARE — Application Bootstrap
 *
 * Module initialization order:
 * 1. core/   — constants, log, events, state, platform, session, timers
 * 2. audio/  — engine, effects, channel
 * 3. network/ — peer, protocol, sync
 * 4. storage/ — storage, transfer, preload, recovery
 * 5. player/ — playback, playlist, video, media-session
 * 6. youtube/ — player, sync, search
 * 7. ui/     — dom, toast, dialog, tabs, i18n, visualizer, chat, playlist-view,
 *              player-controls, settings, setup
 * 8. sw-register
 */

// ── Core ──
import { log } from './core/log.ts';
import { installConsoleCapture } from './core/log-capture.ts';
import {
  BootstrapReadinessLedger,
  formatBootstrapReadinessSummary,
  runBootstrapStepAsync,
  type BootstrapReadinessSnapshot,
} from './core/bootstrap-readiness.ts';
import { bus } from './core/events.ts';
import { initPlatform } from './core/platform.ts';
import { INSTANCE_ID } from './core/session.ts';
import { getState, setState, snapshot } from './core/state.ts';
import { delay, setManagedTimer } from './core/timers.ts';
import {
  initPageLifecycleHandlers,
  markIntentionalNav,
  isIntentionalNav,
} from './core/page-lifecycle.ts';
import { createBackButtonGuardController, isGuardedSession } from './core/back-button-guard.ts';
import { createBackButtonHistory } from './core/back-button-history.ts';
import { initBackgroundResumeGuard } from './core/background-resume-guard.ts';
import { runBackgroundResumeRecovery } from './core/background-resume-recovery.ts';
import { reacquireWakeLockIfActive } from './core/wake-lock.ts';
import {
  isSessionResetPending,
  restoreSessionReset,
  scheduleDocumentReload,
  scheduleSessionReset,
  setSessionResetReleaseHandler,
} from './core/session-reset.ts';
import { createReloadRecoveryLatch } from './core/reload-recovery-latch.ts';
import { UPDATE_COMPLETION_KEY } from './core/navigation-contract.ts';

// ── Audio ──
import { initAudio, isAudioReady } from './audio/engine.ts';
import { applySettings, applySettingsAsync, initEffectsHandlers } from './audio/effects.ts';
import { setChannelMode } from './audio/channel.ts';
import { isPlaybackPlayingFile } from './player/ownership.ts';
import { inspectBackgroundFileOutput } from './audio/output-health.ts';
import {
  armForegroundAudioContextClockHealthCheck,
  confirmForegroundAudioContextRestartHealth,
  getExistingAudioContext,
  getPendingForegroundAudioContextRestartClockHealthRequirement,
  probeAudioContextHealth,
  prepareForegroundAudioContextRestartAfterClockStall,
  resumePreparedForegroundAudioContextRestartFromGesture,
  retireForegroundAudioContextRestart,
  restartAudioContextFromGesture,
} from './audio/context.ts';
import {
  cancelPendingAudioContextRecovery,
  confirmPendingAudioContextRecoveryHealth,
  escalatePendingAudioContextRecoveryToClockStalled,
  getPendingAudioContextClockHealthRequirement,
  getPendingAudioContextRecoveryAttemptForHealth,
  getPendingAudioContextInterruptionAttempt,
  hasPendingAudioContextInterruption,
  isAudioContextInterruptionAttemptCurrent,
  resumePendingAudioContextInterruptionFromGesture,
} from './audio/context-recovery.ts';

// ── Network ──
import { initProtocol } from './network/protocol.ts';
import { initHostPresence } from './network/host-presence.ts';
import { initStandardQueueMutationAuthority } from './network/queue-mutation-authority.ts';
import { initPeerHandlers, leaveSession, recoverPeerAfterBackground } from './network/peer.ts';
import { initSync } from './network/sync.ts';
import { initOrchestrator } from './network/orchestrator.ts';
import { registerSystemCaptureListeners } from './audio/system-capture.ts';
import { initStandardOperatorFileUplink } from './network/operator-file-uplink.ts';
import {
  getRoomContext,
  isStandardRoomRole,
  subscribeRoomAuthorityLifecycle,
} from './rooms/authority.ts';
// ── Storage ──
// RAM-only storage dispatches STORAGE_* commands in-process.
import { initTransfer } from './storage/transfer.ts';
import { initPreload } from './storage/preload.ts';
import { initRecovery } from './storage/recovery.ts';
import { initRemoteShare } from './share/remote-share.ts';
import {
  handleSyncWorkerFailure,
  setSyncWorker,
  setSyncWorkerFailureObserver,
} from './network/sync-worker.ts';

// ── Player ──
import { initPlayback } from './player/playback.ts';
import { initPlaylist } from './player/playlist.ts';
import { initDecodeHandlers } from './player/decode.ts';
import { isFilePipelineBusyForPlay, recoverStalePlayLock } from './player/transport.ts';
import { isLocalFilePaused } from './player/_state.ts';
import {
  captureLocalFileOutputIdentity,
  isLocalFileOutputIdentityCurrent,
  localFileOutputIdentitiesEqual,
  type LocalFileOutputIdentity,
} from './player/local-file-output-identity.ts';

// ── YouTube ──
import { initYouTube } from './youtube/player.ts';
import { initYouTubeSync } from './youtube/sync.ts';

// ── UI ──
import {
  hasOpenWindow,
  initOverlayObservers,
  isAnyOverlayShown,
  offerBackToTopWindow,
  onOverlayStackChange,
  syncOverlayStateAfterExternalLock,
  whenBackSurfaceSettled,
} from './ui/dom.ts';
import { initEmailCopyLinks } from './ui/copy-email.ts';
import { initToast } from './ui/toast.ts';
import { initDialog, showDialog } from './ui/dialog.ts';
import { createLongBackgroundWarning } from './ui/long-background-warning.ts';
import { initTabs } from './ui/tabs.ts';
import { initI18n } from './i18n/index.ts';
import { t } from './i18n/index.ts';
import { restoreAccountLoginReturnPath } from './account/login-return.ts';
import { initAccount } from './ui/account.ts';
import { initAccountActivityStats } from './account/activity-stats.ts';
import { initAccountRoomIdentity } from './account/room-identity.ts';
import { initVisualizer } from './ui/visualizer.ts';
import { initChat } from './ui/chat.ts';
import { initPlaylistView } from './ui/playlist-view.ts';
import { initHoverPointer } from './ui/hover-pointer.ts';
import { initPlayerControls } from './ui/player-controls.ts';
import { initKeepOpenNotice } from './ui/keep-open-notice.ts';
import { initGlobalFileDrop } from './ui/file-drop.ts';
import { initClearableEditors } from './ui/clearable-editors.ts';
import { initAllCustomScrollbars } from './ui/custom-scrollbar.ts';
import { initSettings } from './ui/settings.ts';
import { initSetup } from './ui/setup.ts';
import { failOpenSetupBootGuard } from './ui/setup-boot-guard.ts';
import { initDemoModeLoader } from './demo/loader.ts';
import { initProRoomBranding } from './pro-room/branding.ts';
import { initUiSounds } from './audio/ui-sounds.ts';
import { initContrastPreference } from './core/contrast.ts';

// ── Service Worker ──
import { NAVIGATION_SOURCE_EVENT, registerServiceWorker } from './sw-register.ts';
import { showToast } from './ui/toast.ts';

declare global {
  interface Window {
    __MXQR?: unknown;
  }
}

// Tee console output into a ring buffer so `/debug console` can surface it on
// iOS, where Safari Web Inspector needs a tethered Mac. Install before the rest
// of bootstrap so runtime logs (YouTube sync, errors, etc.) are captured.
installConsoleCapture();

// ── System Compatibility Check ──

function checkSystemCompatibility(): void {
  let allPassed = true;

  // HTTPS check
  if (!window.isSecureContext) {
    allPassed = false;
    showToast(t('error.https_required'));
    log.warn('[App] Not a secure context');
  }

  if (allPassed) {
    log.info('[App] System compatibility check passed');
  }
}

// ── Keyboard Shortcuts ──

function initKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // If another handler already claimed this key, don't also treat it as a global shortcut
    if (e.defaultPrevented) return;

    // Modal/fullscreen surfaces own keyboard interaction. Global playback
    // and chat shortcuts must not fire through a dialog whose focused control
    // happens not to be an input (for example a confirmation button).
    if (isAnyOverlayShown()) return;

    // Don't intercept when focused on text input elements
    const active = document.activeElement;
    const activeTag = active?.tagName;
    if (activeTag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;
    if (active && (active as HTMLElement).isContentEditable) return;

    // Don't hijack Space on interactive controls (important for a11y)
    const interactive = (e.target as Element)?.closest?.(
      'button, a, [role="button"], input, textarea, select, [contenteditable="true"]',
    );
    if ((e.key === ' ' || e.code === 'Space') && interactive) return;

    // Don't intercept modifier key combos (Ctrl+S, Cmd+P, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      bus.emit('player:toggle-play');
    }
  });

  log.info('[App] Keyboard shortcuts registered');
}

// ── Wake Lock & visibility recovery wiring ──
// The wake-lock state machine itself lives in core/wake-lock.ts (leaf
// module) so feature code (ui/setup-shared.ts) never back-imports the
// bootstrap module. app.ts only owns the visibilitychange listener
// installation. app.ts must stay import-terminal (zero exports) — enforced
// by scripts/check-import-graph.mts RULE A.

function initWakeLock(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    // Re-acquire keep-awake primitives after a visibility bounce.
    reacquireWakeLockIfActive();
  });

  log.info('[App] Wake Lock initialized (native API)');
}

interface AudioRecoveryIdentity {
  readonly intent: 'restore-playing-output' | 'retry-failed-play';
  readonly playback: LocalFileOutputIdentity;
  readonly sourceIntentIsCurrent?: () => boolean;
  readonly foregroundRestartAttemptToken?: object;
  readonly confirmForegroundRestart?: (attemptToken: object) => boolean;
  readonly retry?: () => Promise<boolean>;
}

interface AudioRecoveryRequest {
  readonly reason: 'context-not-running' | 'clock-stalled' | 'stale-play-lock';
  readonly source: 'play' | 'background-resume';
  readonly identity: AudioRecoveryIdentity;
}

interface GestureRecoveryFlightResult {
  readonly running: boolean;
  readonly rejoinEmitted: boolean;
  readonly fallbackEligible: boolean;
  readonly semanticAttemptToken: object | null;
  readonly foregroundAttemptToken: object | null;
}

let audioRecoveryPrompt: Promise<boolean> | null = null;
let activeAudioRecoveryIdentity: AudioRecoveryIdentity | null = null;
let activeAudioRecoveryAbortController: AbortController | null = null;
let activeAudioRecoveryGestureActivated = false;
let pendingAudioRecoveryRequest: AudioRecoveryRequest | null = null;
const longBackgroundWarning = createLongBackgroundWarning({
  hasAudioRecoveryPrompt: () => audioRecoveryPrompt !== null,
});

function captureAudioRecoveryIdentity(
  intent: AudioRecoveryIdentity['intent'],
  expectedQueueItemId: string | null,
  sourceIntentIsCurrent?: () => boolean,
  foregroundRestartAttemptToken?: object,
  confirmForegroundRestart?: (attemptToken: object) => boolean,
  retry?: () => Promise<boolean>,
): AudioRecoveryIdentity | null {
  const playback = captureLocalFileOutputIdentity();
  if (
    !getState('setup.sessionStarted') ||
    getState('playback.mode') !== 'file' ||
    !playback ||
    playback.queueItemId !== expectedQueueItemId ||
    isFilePipelineBusyForPlay() ||
    isLocalFilePaused() ||
    sourceIntentIsCurrent?.() === false ||
    (intent === 'retry-failed-play' && !retry) ||
    (intent === 'restore-playing-output' && !isPlaybackPlayingFile())
  ) {
    return null;
  }
  return {
    intent,
    playback,
    sourceIntentIsCurrent,
    foregroundRestartAttemptToken,
    confirmForegroundRestart,
    retry,
  };
}

function audioRecoveryPlaybackIdentityStillCurrent(identity: AudioRecoveryIdentity): boolean {
  return Boolean(
    document.visibilityState === 'visible' &&
    getState('setup.sessionStarted') &&
    getState('playback.mode') === 'file' &&
    (identity.intent === 'retry-failed-play' || isPlaybackPlayingFile()) &&
    !isLocalFilePaused() &&
    !isFilePipelineBusyForPlay() &&
    isLocalFileOutputIdentityCurrent(identity.playback),
  );
}

function audioRecoveryIdentityStillCurrent(identity: AudioRecoveryIdentity): boolean {
  return (
    identity.sourceIntentIsCurrent?.() !== false &&
    audioRecoveryPlaybackIdentityStillCurrent(identity)
  );
}

function observeAudioRecoveryOperation(operation: Promise<unknown>, source: string): void {
  operation.catch((error) => {
    log.warn(`[Audio] ${source} failed outside the recovery boundary`, error);
  });
}

function primeIosAudioFromGesture(): void {
  const primer = document.getElementById('silent-trigger') as HTMLAudioElement | null;
  if (!primer) return;
  try {
    primer.currentTime = 0;
    void primer.play().catch((error) => log.debug('[Audio] Recovery primer failed', error));
  } catch (error) {
    log.debug('[Audio] Recovery primer unavailable', error);
  }
}

async function waitForForegroundRestartClockRequirement(
  attemptToken: object,
  isCurrent: () => boolean,
  timeoutMs = 5_000,
): Promise<NonNullable<
  ReturnType<typeof getPendingForegroundAudioContextRestartClockHealthRequirement>
> | null> {
  const deadline = Date.now() + timeoutMs;
  while (isCurrent()) {
    const requirement = getPendingForegroundAudioContextRestartClockHealthRequirement();
    if (requirement?.attemptToken === attemptToken && requirement.isCurrent()) {
      return requirement;
    }
    if (Date.now() >= deadline) return null;
    await delay(50);
  }
  return null;
}

function isSameAudioRecoveryIdentity(
  left: AudioRecoveryIdentity,
  right: AudioRecoveryIdentity,
): boolean {
  return (
    left.intent === right.intent &&
    localFileOutputIdentitiesEqual(left.playback, right.playback) &&
    left.sourceIntentIsCurrent === right.sourceIntentIsCurrent &&
    left.foregroundRestartAttemptToken === right.foregroundRestartAttemptToken &&
    left.confirmForegroundRestart === right.confirmForegroundRestart &&
    left.retry === right.retry
  );
}

function requestAudioOutputRecovery(
  reason: 'context-not-running' | 'clock-stalled' | 'stale-play-lock',
  source: 'play' | 'background-resume',
  expectedQueueItemId: string | null,
  sourceIntentIsCurrent?: () => boolean,
  foregroundRestartAttemptToken?: object,
  confirmForegroundRestart?: (attemptToken: object) => boolean,
  retry?: () => Promise<boolean>,
): Promise<boolean> {
  const identity = captureAudioRecoveryIdentity(
    source === 'play' ? 'retry-failed-play' : 'restore-playing-output',
    expectedQueueItemId,
    sourceIntentIsCurrent,
    foregroundRestartAttemptToken,
    confirmForegroundRestart,
    retry,
  );
  if (!identity) return Promise.resolve(false);
  return runAudioRecoveryRequest({ reason, source, identity });
}

function runAudioRecoveryRequest(request: AudioRecoveryRequest): Promise<boolean> {
  const { reason, source, identity } = request;
  if (!audioRecoveryIdentityStillCurrent(identity)) return Promise.resolve(false);
  if (audioRecoveryPrompt) {
    if (
      activeAudioRecoveryIdentity &&
      isSameAudioRecoveryIdentity(activeAudioRecoveryIdentity, identity)
    ) {
      if (activeAudioRecoveryGestureActivated) pendingAudioRecoveryRequest = request;
      return audioRecoveryPrompt;
    }
    pendingAudioRecoveryRequest = request;
    activeAudioRecoveryAbortController?.abort();
    return audioRecoveryPrompt;
  }

  const abortController = new AbortController();
  activeAudioRecoveryIdentity = identity;
  activeAudioRecoveryAbortController = abortController;

  let operationCommitted = false;
  let operationHealthClaimed = false;
  const operationStillCurrent = (): boolean =>
    !abortController.signal.aborted &&
    (activeAudioRecoveryIdentity === identity || operationCommitted) &&
    (operationHealthClaimed && identity.intent === 'restore-playing-output'
      ? audioRecoveryPlaybackIdentityStillCurrent(identity)
      : audioRecoveryIdentityStillCurrent(identity));
  const enqueuePreparedForegroundRestart = (
    preparation: NonNullable<
      Awaited<ReturnType<typeof prepareForegroundAudioContextRestartAfterClockStall>>
    >,
  ): void => {
    const enqueue = (): void => {
      if (
        abortController.signal.aborted ||
        !preparation.isCurrent() ||
        !audioRecoveryIdentityStillCurrent(identity)
      ) {
        return;
      }
      const next: AudioRecoveryRequest = {
        reason: 'clock-stalled',
        source,
        identity: {
          ...identity,
          foregroundRestartAttemptToken: preparation.attemptToken,
        },
      };
      if (audioRecoveryPrompt) {
        pendingAudioRecoveryRequest = next;
        if (activeAudioRecoveryIdentity !== identity) {
          activeAudioRecoveryAbortController?.abort();
        }
        return;
      }
      observeAudioRecoveryOperation(runAudioRecoveryRequest(next), 'queued recovery');
    };

    if (preparation.status === 'prepared') {
      enqueue();
      return;
    }
    observeAudioRecoveryOperation(
      preparation.whenPrepared.then((prepared) => {
        if (prepared) enqueue();
      }),
      'foreground restart preparation',
    );
  };
  let gestureFlight: Promise<GestureRecoveryFlightResult> | null = null;
  let gestureSemanticAttemptToken: object | null = null;
  let gestureForegroundAttemptToken: object | null = null;
  // Whatever asked for it, this dialog explains the return from the
  // background itself, so the generic warning steps aside for this return.
  longBackgroundWarning.yieldToAudioRecovery();
  const operation = showDialog({
    title: t('dialog.audio_recovery_title'),
    message: t('dialog.audio_recovery_message'),
    buttonText: t('dialog.audio_recovery_action'),
    dismissible: false,
    // Only this tap can restart the audio; Back keeps the dialog.
    closeOnBack: false,
    defaultFocus: 'primary',
    signal: abortController.signal,
    onPrimaryActivation: () => {
      if (!operationStillCurrent()) return;
      activeAudioRecoveryGestureActivated = true;
      primeIosAudioFromGesture();
      if (identity.foregroundRestartAttemptToken) {
        gestureForegroundAttemptToken = identity.foregroundRestartAttemptToken;
        gestureFlight = resumePreparedForegroundAudioContextRestartFromGesture(
          gestureForegroundAttemptToken,
        ).then((result) => ({
          running: result.running,
          rejoinEmitted: false,
          fallbackEligible: false,
          semanticAttemptToken: null,
          foregroundAttemptToken: gestureForegroundAttemptToken,
        }));
      } else if (
        identity.intent === 'restore-playing-output' &&
        hasPendingAudioContextInterruption('file')
      ) {
        gestureSemanticAttemptToken = getPendingAudioContextInterruptionAttempt();
        if (!gestureSemanticAttemptToken) return;
        gestureFlight = resumePendingAudioContextInterruptionFromGesture().then((result) => ({
          ...result,
          semanticAttemptToken: gestureSemanticAttemptToken,
          foregroundAttemptToken: null,
        }));
      } else {
        // A failed PLAY owns its exact continuation, so do not let an older
        // semantic recovery emit a competing automatic rejoin. Claim that
        // token before resume; the exact failed-PLAY identity owns the gesture,
        // clock proof, and continuation from this point onward.
        gestureSemanticAttemptToken = getPendingAudioContextInterruptionAttempt();
        if (
          identity.intent === 'retry-failed-play' &&
          gestureSemanticAttemptToken &&
          cancelPendingAudioContextRecovery(gestureSemanticAttemptToken)
        ) {
          gestureSemanticAttemptToken = null;
        }
        gestureFlight = restartAudioContextFromGesture()
          .then(() => ({
            running: true,
            rejoinEmitted: false,
            fallbackEligible: true,
            semanticAttemptToken: gestureSemanticAttemptToken,
            foregroundAttemptToken: null,
          }))
          .catch((error) => {
            log.warn('[Audio] Gesture recovery failed', error);
            return {
              running: false,
              rejoinEmitted: false,
              fallbackEligible: false,
              semanticAttemptToken: gestureSemanticAttemptToken,
              foregroundAttemptToken: null,
            };
          });
      }
    },
  })
    .then(async (result) => {
      if (result.action !== 'ok' || !gestureFlight || !operationStillCurrent()) {
        return false;
      }
      const gestureResult = await Promise.race([
        gestureFlight,
        delay(1_000).then(() => ({
          running: String(getExistingAudioContext()?.state) === 'running',
          rejoinEmitted: false,
          fallbackEligible: false,
          semanticAttemptToken: gestureSemanticAttemptToken,
          foregroundAttemptToken: gestureForegroundAttemptToken,
        })),
      ]);
      if (!operationStillCurrent()) return false;

      let healthContext = getExistingAudioContext();
      let healthIsCurrent = operationStillCurrent;
      if (gestureResult.foregroundAttemptToken) {
        const requirement = await waitForForegroundRestartClockRequirement(
          gestureResult.foregroundAttemptToken,
          operationStillCurrent,
        );
        if (!requirement) {
          const context = getExistingAudioContext();
          const retired = retireForegroundAudioContextRestart(gestureResult.foregroundAttemptToken);
          if (retired && context && document.visibilityState === 'visible') {
            armForegroundAudioContextClockHealthCheck(context);
          }
          return false;
        }
        healthContext = requirement.context;
        healthIsCurrent = () => operationStillCurrent() && requirement.isCurrent();
      } else if (gestureResult.semanticAttemptToken) {
        if (!isAudioContextInterruptionAttemptCurrent(gestureResult.semanticAttemptToken)) {
          return false;
        }
        const requirement = getPendingAudioContextClockHealthRequirement();
        if (
          !requirement ||
          requirement.attemptToken !== gestureResult.semanticAttemptToken ||
          !requirement.isCurrent()
        ) {
          return false;
        }
        healthContext = requirement.context;
        healthIsCurrent = () => operationStillCurrent() && requirement.isCurrent();
      }

      const health = await probeAudioContextHealth({
        attemptResume: false,
        context: healthContext ?? undefined,
        isCurrent: healthIsCurrent,
      });
      const gestureReachedRunning = gestureResult.foregroundAttemptToken
        ? String(healthContext?.state) === 'running'
        : gestureResult.running;
      if (!health.healthy || !gestureReachedRunning) {
        log.warn('[Audio] Output remains unhealthy after gesture recovery', {
          reason,
          health: health.reason,
          state: health.state,
        });
        if (gestureResult.foregroundAttemptToken) {
          const retired = retireForegroundAudioContextRestart(gestureResult.foregroundAttemptToken);
          if (retired && healthContext && document.visibilityState === 'visible') {
            armForegroundAudioContextClockHealthCheck(healthContext);
          }
        } else if (gestureResult.semanticAttemptToken && health.reason === 'clock-stalled') {
          const escalation = await escalatePendingAudioContextRecoveryToClockStalled(
            gestureResult.semanticAttemptToken,
          );
          if (escalation === 'prepared' && operationStillCurrent()) {
            // A synchronous preparation event races with this still-open
            // dialog and is intentionally deduplicated. Preserve the exact
            // incident for the next actionable activation.
            pendingAudioRecoveryRequest = {
              reason: 'clock-stalled',
              source,
              identity,
            };
          }
        } else if (
          !gestureResult.foregroundAttemptToken &&
          !gestureResult.semanticAttemptToken &&
          health.reason === 'clock-stalled' &&
          healthContext &&
          operationStillCurrent()
        ) {
          const preparation =
            await prepareForegroundAudioContextRestartAfterClockStall(healthContext);
          if (preparation && operationStillCurrent()) {
            enqueuePreparedForegroundRestart(preparation);
          }
        }
        return false;
      }

      if (
        gestureResult.foregroundAttemptToken &&
        !(identity.confirmForegroundRestart
          ? identity.confirmForegroundRestart(gestureResult.foregroundAttemptToken)
          : confirmForegroundAudioContextRestartHealth(gestureResult.foregroundAttemptToken))
      ) {
        return false;
      }
      if (gestureResult.foregroundAttemptToken) operationHealthClaimed = true;

      let confirmedRecovery = {
        running: false,
        rejoinEmitted: false,
        fallbackEligible: false,
      };
      if (gestureResult.semanticAttemptToken) {
        if (identity.intent === 'retry-failed-play') {
          if (!cancelPendingAudioContextRecovery(gestureResult.semanticAttemptToken)) {
            return false;
          }
        } else {
          confirmedRecovery = confirmPendingAudioContextRecoveryHealth(
            gestureResult.semanticAttemptToken,
          );
          if (!confirmedRecovery.running) return false;
        }
        operationHealthClaimed = true;
      }
      if (!gestureResult.foregroundAttemptToken && !gestureResult.semanticAttemptToken) {
        operationHealthClaimed = true;
      }
      if (identity.intent === 'retry-failed-play') {
        const started = await identity.retry?.();
        if (
          !started ||
          !operationStillCurrent() ||
          !audioRecoveryPlaybackIdentityStillCurrent(identity)
        ) {
          log.warn('[Audio] Exact failed PLAY retry was superseded or did not start');
          if (gestureResult.foregroundAttemptToken) {
            const retired = retireForegroundAudioContextRestart(
              gestureResult.foregroundAttemptToken,
            );
            if (retired && healthContext && document.visibilityState === 'visible') {
              armForegroundAudioContextClockHealthCheck(healthContext);
            }
          }
          return false;
        }
      }
      await applySettingsAsync();
      if (!operationStillCurrent()) return false;
      operationCommitted = true;
      if (
        identity.intent === 'restore-playing-output' &&
        !gestureResult.rejoinEmitted &&
        !confirmedRecovery.rejoinEmitted
      ) {
        bus.emit('playback:local-output-rejoin', {
          reason: 'audio-recovery-gesture',
          mode: 'file',
          isCurrent: operationStillCurrent,
        });
      }
      log.info('[Audio] Local output recovered from foreground interruption', { reason });
      return true;
    })
    .catch((error) => {
      log.warn('[Audio] Recovery dialog failed', error);
      return false;
    })
    .finally(() => {
      if (audioRecoveryPrompt !== operation) return;
      if (identity.foregroundRestartAttemptToken) {
        retireForegroundAudioContextRestart(identity.foregroundRestartAttemptToken);
      }
      audioRecoveryPrompt = null;
      activeAudioRecoveryIdentity = null;
      activeAudioRecoveryAbortController = null;
      activeAudioRecoveryGestureActivated = false;
      const next = pendingAudioRecoveryRequest;
      pendingAudioRecoveryRequest = null;
      if (next) {
        queueMicrotask(() => {
          observeAudioRecoveryOperation(runAudioRecoveryRequest(next), 'follow-up recovery');
        });
      }
    });
  audioRecoveryPrompt = operation;
  return operation;
}

/**
 * Restore this device's local-file output after a background return.
 * Resolves true when audio recovery owns, or has already published, the
 * participant-local file alignment for this return, so the background-return
 * Sync must not start a competing one.
 */
async function resumeAudioForBackgroundRecovery(): Promise<boolean> {
  if (!isPlaybackPlayingFile()) return false;

  // The app guard is registered before the lazily-created AudioContext
  // binding. Yield one task so every visibility listener can publish its
  // exact incident before the inspector captures one-shot recovery tokens.
  await delay(0);
  if (!isPlaybackPlayingFile()) return false;

  const output = await inspectBackgroundFileOutput();
  if (output.status === 'stale') {
    // A native state-interruption attempt is the sole owner of its async
    // proof and any recovery prompt. Suppress the generic long-background
    // dialog while that owner is pending so the two dialogs cannot race.
    if (getPendingAudioContextRecoveryAttemptForHealth()) {
      longBackgroundWarning.yieldToAudioRecovery();
    }
    // A superseded sample belongs to that owner, a parked foreground restart,
    // or a newer playback identity. Only an early, inconclusive clock sample
    // leaves a running output whose alignment is still unowned.
    return output.reason !== 'inconclusive';
  }
  if (output.status === 'needs-gesture') {
    const reason = output.reason === 'clock-stalled' ? 'clock-stalled' : 'context-not-running';
    longBackgroundWarning.yieldToAudioRecovery();
    const queueItemId = captureLocalFileOutputIdentity()?.queueItemId ?? null;
    bus.emit('audio:output-recovery-needed', {
      reason,
      source: 'background-resume',
      queueItemId,
    });
    // The dialog's gesture publishes the rejoin that aligns this output.
    await requestAudioOutputRecovery(reason, 'background-resume', queueItemId);
    return true;
  }
  if (output.status === 'not-applicable') return false;

  // applySettingsAsync is intentionally synchronous; do not insert a
  // microtask gap between the inspector's exact source claim and rejoin.
  if (isAudioReady()) applySettingsAsync();
  if (output.isCurrent?.() !== true) return true;
  const lockRecovery = recoverStalePlayLock('background-resume', Date.now(), {
    preservePlaybackState: true,
  });
  if (lockRecovery.recovered) {
    log.warn('[Audio] Foreground recovery discarded a stalled play owner', lockRecovery.snapshot);
  }
  if (output.rejoinEmitted) return true;
  if (!output.rejoinRequired && !lockRecovery.recovered) return false;
  const rejoinIdentityCurrent = lockRecovery.recovered
    ? output.isPlaybackCurrent?.() === true
    : output.isCurrent?.() === true;
  if (!rejoinIdentityCurrent) return true;
  // The rejoin router performs the room's file alignment (PRO
  // reconciliation, guest re-sync, or a host's local rebuild).
  bus.emit('playback:local-output-rejoin', {
    reason: 'background-resume',
    mode: 'file',
    isCurrent: () =>
      output.isPlaybackCurrent?.() === true && isPlaybackPlayingFile() && !isLocalFilePaused(),
  });
  return true;
}

async function recoverLongBackgroundResume(hiddenMs: number): Promise<void> {
  log.warn(`[App] Background resume (${Math.round(hiddenMs / 1000)}s): attempting recovery`);

  longBackgroundWarning.beginIncident();
  await runBackgroundResumeRecovery(hiddenMs, {
    // Reconcile suspended RTC state before awaiting audio recovery. Mobile
    // WebKit can dispatch the queued connection-state event immediately after
    // visibilitychange, so this explicit hook owns the elapsed hidden time.
    recoverPeer: recoverPeerAfterBackground,
    reacquireWakeLock: reacquireWakeLockIfActive,
    recoverAudio: resumeAudioForBackgroundRecovery,
    onAudioRecoveryError: (error) => {
      log.warn('[App] Background audio recovery failed', error);
    },
    // Every return then performs the Sync button's room alignment. A recovery
    // dialog that is still open (for example from an earlier failed PLAY)
    // owns the file output as much as one this return opened.
    // The step only runs after a return, so it stays out of the initial bundle.
    syncRoom: async ({ peer, audio }) => {
      const fileOutputOwned = audio === true || audioRecoveryPrompt !== null;
      const { runBackgroundReturnSync } = await import('./player/background-return-sync.ts');
      runBackgroundReturnSync({ peerRecovery: peer, fileOutputOwned });
    },
  });
}

function initAudioOutputRecovery(): void {
  const abortSupersededRecovery = (): void => {
    if (
      activeAudioRecoveryIdentity &&
      !audioRecoveryIdentityStillCurrent(activeAudioRecoveryIdentity)
    ) {
      activeAudioRecoveryAbortController?.abort();
    }
  };
  bus.on('state:playback.activity', abortSupersededRecovery);
  bus.on('state:playback.mode', abortSupersededRecovery);
  bus.on('state:playlist.currentQueueItemId', abortSupersededRecovery);
  bus.on('state:files.current', abortSupersededRecovery);
  bus.on('state:demo.active', abortSupersededRecovery);
  bus.on('state:demo.currentTrackIndex', abortSupersededRecovery);
  bus.on('player:buffer-changed', abortSupersededRecovery);
  bus.on('state:room.context', abortSupersededRecovery);
  bus.on('state:setup.sessionStarted', abortSupersededRecovery);
  bus.on('audio:output-recovery-needed', (event) => {
    if (event.source === 'background-resume') {
      longBackgroundWarning.yieldToAudioRecovery();
    }
    observeAudioRecoveryOperation(
      requestAudioOutputRecovery(
        event.reason,
        event.source,
        event.queueItemId,
        event.isCurrent,
        event.foregroundRestartAttemptToken,
        event.confirmForegroundRestart,
        event.retry,
      ),
      'event-triggered recovery',
    );
  });
}

function hasActiveBackgroundResumeSession(): boolean {
  return (
    getState('setup.sessionStarted') &&
    getState('network.appRole') !== 'idle' &&
    getState('network.sessionCode').trim().length > 0
  );
}

// Global error handlers
// addEventListener (not `window.onerror = ...`) so we don't clobber any
// host-injected handler the embedding wrapper (e.g. a WebView bridge)
// might have installed before our bootstrap ran.
window.addEventListener('error', (e) => {
  log.error(`[Global] ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  log.error('[Global] Unhandled rejection:', e.reason);
});

// Page-lifecycle (beforeunload / pagehide / pageshow) handling lives in
// `core/page-lifecycle.ts`. It's dependency-injected so the branching can
// be unit-tested without dragging in the full bootstrap graph. See that
// file for the rationale behind each branch and the app-wide rule about
// `markIntentionalNav()`.

// ── Back-Button Guard ──
//
// `beforeunload` above can't actually catch the back button cleanly — by the
// time the dialog shows, the browser has already begun tearing down the
// page (the data channel / RTCPeerConnection gets pulled out from under
// us, and even if the user picks "stay", the session is unrecoverable).
//
// History API trick: while a session runs or a window is open, keep one
// guard entry on the stack. When the user presses back the browser pops that
// entry and fires `popstate` — NOT a real page unload — so the page stays
// intact. Back then closes the topmost window, like a native app. With no
// window open, a session shows a custom leave dialog instead: on confirm we
// call leaveSession() explicitly. After each UI change the common R policy
// waits for its closing surface and two frames before restoring one guard.
// Outside a room, a Back with no window continues to the previous page.
//
// Arming is event-driven (a session start or a window opening) rather than
// seeded at bootstrap: a guard on the bare landing view would only add a
// history entry for Back to pass through.
//
// Complements (does not replace) `beforeunload`: tab close, refresh, and
// direct URL changes still route through the beforeunload confirmation.
function initBackButtonGuard(): void {
  const backHistory = createBackButtonHistory({
    navigateHome: () => window.location.replace('/'),
    onNavigationError: (error) => log.warn('[App] Back navigation failed:', error),
  });
  const controller = createBackButtonGuardController({
    isSessionActive: () =>
      isGuardedSession({
        sessionStarted: getState('setup.sessionStarted'),
        role: getState('network.appRole'),
        roomId: getRoomContext().roomId,
      }),
    hasOpenWindow,
    closeTopWindow: offerBackToTopWindow,
    whenSurfaceSettled: whenBackSurfaceSettled,
    isSurfaceReady: () =>
      !getState('setup.sessionStarted') ||
      !document.getElementById('setup-overlay')?.classList.contains('active'),
    isDocumentVisible: () => document.visibilityState === 'visible',
    isNavigationPending: isSessionResetPending,
    currentHistoryPosition: backHistory.current,
    pushGuard: backHistory.pushGuard,
    navigateBack: () => history.back(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    requestLeaveConfirmation: async () => {
      const result = await showDialog({
        // Browser history may lead to the landing page, another site, or a
        // blank tab, so the copy describes the action without naming a
        // destination.
        title: t('dialog.return_home_title'),
        message: t('dialog.return_home_detail'),
        buttonText: t('common.leave'),
        secondaryText: t('common.stay'),
        defaultFocus: 'secondary',
      });
      return result.action === 'ok';
    },
    onLeaveConfirmed: () => {
      const reset = scheduleSessionReset(t('dialog.leaving_session'), () => {
        try {
          leaveSession();
        } catch (e) {
          log.warn('[App] leaveSession failed:', e);
        }

        // Rearming is deferred, so a guard may or may not exist at confirm.
        // Traverse only entries owned by this document, then leave once.
        backHistory.leave();
      });
      reset?.onRecovered(() => {
        backHistory.cancelLeave();
        controller.recoverNavigation();
      });
    },
    onSeedError: (error) => log.warn('[App] Back-button guard seed failed:', error),
    onConfirmationError: (error) => log.warn('[App] Back-button dialog failed:', error),
  });

  // Arm only after setup actually succeeds. Provisional host/guest roles are
  // soft-cancellable and must not leave a duplicate landing history entry.
  bus.on('state:network.appRole', controller.handleStateChange);
  bus.on('state:setup.sessionStarted', controller.handleStateChange);
  bus.on('state:room.context', controller.handleStateChange);
  bus.on('setup:app-entrance', controller.handleStateChange);
  onOverlayStackChange(controller.handleStateChange);
  window.addEventListener('popstate', controller.handlePopState);
  window.addEventListener('pagehide', controller.suspend);
  window.addEventListener('pageshow', controller.resume);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controller.suspend();
    else controller.resume();
  });
  // A window may already be open before this guard starts.
  controller.handleStateChange();
}

// ── Bootstrap ──

const bootstrapReadiness = new BootstrapReadinessLedger();
let bootstrapReadinessPublished = false;

type PublishedBootstrapState = BootstrapReadinessSnapshot['state'] | 'bootstrapping' | 'aborted';

function publishBootstrapDataset(
  state: PublishedBootstrapState,
  snapshot?: BootstrapReadinessSnapshot,
): void {
  try {
    const root = document.documentElement;
    root.dataset.bootstrapState = state;

    if (!snapshot) {
      root.dataset.bootstrapStepCount = '0';
      root.dataset.bootstrapFailureCount = '0';
      root.dataset.bootstrapFallbackCount = '0';
      delete root.dataset.bootstrapFailures;
      delete root.dataset.bootstrapFallbacks;
      return;
    }

    root.dataset.bootstrapStepCount = String(snapshot.total);
    root.dataset.bootstrapFailureCount = String(snapshot.failures.length);
    root.dataset.bootstrapFallbackCount = String(snapshot.fallbacks.length);
    root.dataset.bootstrapFailures = snapshot.failures.map(({ name }) => name).join(',');
    root.dataset.bootstrapFallbacks = snapshot.fallbacks.map(({ name }) => name).join(',');
  } catch (e) {
    // Observability must never become a new bootstrap dependency.
    log.warn('[App] Bootstrap state publication failed:', e);
  }
}

function publishBootstrapReadiness(): void {
  const snapshot = bootstrapReadiness.snapshot();
  publishBootstrapDataset(snapshot.state, snapshot);

  const summary = formatBootstrapReadinessSummary(snapshot);
  if (snapshot.state === 'ready') {
    log.info(summary);
  } else {
    // Production defaults to WARN, so a degraded completion remains visible.
    log.warn(summary);
  }

  bootstrapReadinessPublished = true;
}

function recordSyncWorkerFallback(): void {
  const changed = bootstrapReadiness.recordFallback('SyncWorker', 'worker');
  if (changed && bootstrapReadinessPublished) publishBootstrapReadiness();
}

function recordCachedNavigationFallback(): void {
  if (
    bootstrapReadiness.recordFallback('CachedNavigation', 'orchestration') &&
    bootstrapReadinessPublished
  ) {
    publishBootstrapReadiness();
  }
}

type LazyFeatureFailure = {
  feature: 'announcement' | 'connect' | 'pro-room' | 'room-session' | 'visualizer-spectrum';
  error: unknown;
};

const runLazyFeatureRecovery = createReloadRecoveryLatch<LazyFeatureFailure>({
  async present() {
    // Its own copy, not the waiting-worker update dialog's: this dialog can
    // open in a room (where that dialog is deferred) and says the app was
    // updated and needs a refresh to keep working. Owner decision 2026-10-11.
    const result = await showDialog({
      title: t('dialog.feature_refresh_title'),
      message: t('dialog.feature_refresh_msg'),
      buttonText: t('common.refresh'),
      dismissible: false,
      defaultFocus: 'primary',
    });
    return result.action === 'ok' ? 'accept' : 'decline';
  },
  reload(_failure, onRecovered) {
    scheduleDocumentReload(t('dialog.refreshing_session'), onRecovered);
  },
  onDeclined() {
    showToast(t('error.network_generic'));
  },
  onRecovered({ feature, error }) {
    // A WebKit reload can be cancelled or become a no-op while the old
    // document remains alive. Reopening the same modal from the recovery
    // callback creates a recovery-dialog loop without changing the cached
    // module graph. End this attempt; a later explicit feature action can
    // offer recovery again.
    log.warn(`[App] ${feature} reload recovery returned to the stale document`, error);
    showToast(t('error.network_generic'));
  },
  onPresentationFailure(_failure, dialogError) {
    log.error('[App] Lazy feature recovery dialog failed:', dialogError);
    showToast(t('error.network_generic'));
  },
});

function reportLazyFeatureLoadFailure(
  feature: 'announcement' | 'connect' | 'pro-room' | 'room-session' | 'visualizer-spectrum',
  error: unknown,
): void {
  log.error(`[App] ${feature} feature load failed; reload required:`, error);
  runLazyFeatureRecovery({ feature, error });
}

// bootstrap.js probes before the module graph, while sw-register repeats the
// probe after load. Consume both boundaries so a cache-served shell is never
// published as fully online-ready even when the first worker reply races the
// app module download.
if (document.documentElement.dataset.mxqrNavigationSource === 'cache-fallback') {
  recordCachedNavigationFallback();
}
window.addEventListener(NAVIGATION_SOURCE_EVENT, (event) => {
  if ((event as CustomEvent<{ source?: unknown }>).detail?.source === 'cache-fallback') {
    recordCachedNavigationFallback();
  }
});

async function bootstrap(): Promise<void> {
  log.info(`[App] MUSIXQUARE bootstrap (instance: ${INSTANCE_ID})`);

  /** Wrap an init call so a single failure doesn't crash the entire bootstrap. */
  function safeInit(name: string, fn: () => void): void {
    const result = bootstrapReadiness.runSync(name, fn);
    if (!result.ok) log.error(`[App] ${name} init failed:`, result.error);
  }

  // 1. Platform detection & viewport height
  safeInit('Platform', initPlatform);
  safeInit('ContrastPreference', initContrastPreference);

  // 2. Core UI init (must run before other UI modules)
  safeInit('OverlayObservers', initOverlayObservers);
  safeInit('Toast', initToast);
  safeInit('EmailCopy', initEmailCopyLinks);
  safeInit('Dialog', initDialog);
  safeInit('Tabs', initTabs);
  // A standalone PWA may relaunch at `/` with a durable PRO-room return.
  // Restore that room route before initializing its language and account state.
  safeInit('Account login return path', restoreAccountLoginReturnPath);
  await runBootstrapStepAsync(bootstrapReadiness, 'I18n', initI18n, (e) =>
    log.error('[App] I18n init failed:', e),
  );
  safeInit('Account', initAccount);
  safeInit('Account activity stats', initAccountActivityStats);
  safeInit('Account room identity', initAccountRoomIdentity);

  // 3. Player & Media
  safeInit('Playback', initPlayback);
  safeInit('Playlist', initPlaylist);
  safeInit('DecodeHandlers', initDecodeHandlers);

  // 4. Audio engine (deferred init — Web Audio API context on user interaction)
  // Engine, effects, channel register bus listeners at import time
  safeInit('EffectsHandlers', initEffectsHandlers);

  // 5. Network (registers listeners; transport startup is deferred to the
  // host/guest flow in setup.ts).
  safeInit('Protocol', initProtocol);
  safeInit('StandardQueueMutationAuthority', initStandardQueueMutationAuthority);
  safeInit('PeerHandlers', initPeerHandlers);
  safeInit('HostPresence', initHostPresence);
  safeInit('Sync', initSync);
  safeInit('Orchestrator', initOrchestrator);
  safeInit('SystemAudioCapture', registerSystemCaptureListeners);
  safeInit('StandardOperatorFileUplink', initStandardOperatorFileUplink);
  // 6. Workers & Storage
  setSyncWorkerFailureObserver(recordSyncWorkerFallback);
  try {
    const syncW = new Worker(new URL('./workers/sync.worker.ts', import.meta.url), {
      type: 'module',
    });
    syncW.onerror = (ev) => {
      log.error('[App] SyncWorker error:', ev.message || ev);
      handleSyncWorkerFailure(ev);
    };
    setSyncWorker(syncW);
    syncW.postMessage({ command: 'INIT_INSTANCE', instanceId: INSTANCE_ID });
    bootstrapReadiness.recordSuccess('SyncWorker', 'worker');
    log.info('[App] SyncWorker started');
  } catch (e) {
    log.warn('[App] SyncWorker failed:', e);
    handleSyncWorkerFailure(e);
  }

  // RAM-only STORAGE_* commands are dispatched in-process by
  // storage/storage.ts → ramstore.ts.
  // Transfer / Preload / Recovery initialize unconditionally because storage
  // dispatch is already available in-process.
  safeInit('Transfer', initTransfer);
  safeInit('Preload', initPreload);
  safeInit('Recovery', initRecovery);
  safeInit('RemoteShare', initRemoteShare);

  // 7. YouTube
  safeInit('YouTube', initYouTube);
  safeInit('YouTubeSync', initYouTubeSync);

  // 8. UI modules (binds DOM events)
  safeInit('UiSounds', initUiSounds);
  safeInit('Visualizer', initVisualizer);
  safeInit('Chat', initChat);
  safeInit('PlaylistView', () => {
    initHoverPointer();
    initPlaylistView();
  });
  safeInit('PlayerControls', initPlayerControls);
  safeInit('KeepOpenNotice', initKeepOpenNotice);
  safeInit('GlobalFileDrop', initGlobalFileDrop);
  safeInit('ClearableEditors', initClearableEditors);
  safeInit('Settings', initSettings);
  safeInit('Connect', () => {
    bus.on('app:lazy-feature-load-failed', reportLazyFeatureLoadFailure);
    let loading: Promise<void> | null = null;
    let loadFailure: unknown;
    let loadFailed = false;
    const load = (): void => {
      if (loadFailed) {
        bus.emit('app:lazy-feature-load-failed', 'connect', loadFailure);
        return;
      }
      loading ??= (async () => {
        const { connectSessionRuntimeReady } = await import('./ui/connect-session-runtime.ts');
        await connectSessionRuntimeReady;
      })().catch((error) => {
        // A failed ESM evaluation may remain cached for this document. Keep
        // this boundary terminal and offer a real reload instead of a fake
        // same-specifier retry.
        loadFailure = error;
        loadFailed = true;
        bus.emit('app:lazy-feature-load-failed', 'connect', error);
      });
    };
    bus.on('state:network.appRole', (role) => {
      if (role === 'host' || role === 'guest') load();
    });
    bus.on('ui:connect-tab-opened', load);
    const role = getState('network.appRole');
    if (role === 'host' || role === 'guest') load();
  });
  safeInit('CustomScrollbars', initAllCustomScrollbars);
  safeInit('Setup', () => {
    try {
      initSetup();
    } catch (error) {
      // The parser-time setup guard must not turn a recoverable feature-init
      // failure into a permanently blank shell. A successful setup releases
      // it only after the overlay owns the visible frame.
      failOpenSetupBootGuard();
      throw error;
    }
  });
  safeInit('DemoMode', initDemoModeLoader);
  safeInit('AnnouncementPolling', () => {
    let loading: Promise<void> | null = null;
    let loadFailure: unknown;
    let loadFailed = false;
    const load = (): void => {
      if (loadFailed) {
        bus.emit('app:lazy-feature-load-failed', 'announcement', loadFailure);
        return;
      }
      loading ??= (async () => {
        const { initAnnouncementPolling } = await import('./ui/announcement.ts');
        initAnnouncementPolling();
      })().catch((error) => {
        loadFailure = error;
        loadFailed = true;
        bus.emit('app:lazy-feature-load-failed', 'announcement', error);
      });
    };
    const loadIfActive = (): void => {
      // Standard rooms keep their role in the legacy transport projection;
      // room.context.role only becomes active for PRO rooms.
      if (
        getRoomContext().role !== 'idle' ||
        isStandardRoomRole('host') ||
        isStandardRoomRole('guest')
      ) {
        load();
      }
    };
    subscribeRoomAuthorityLifecycle(loadIfActive);
    loadIfActive();
  });
  safeInit('ProRoomBranding', initProRoomBranding);

  // 9. Service Worker
  safeInit('ServiceWorker', registerServiceWorker);

  // 10. Keyboard shortcuts, Wake Lock & Cleanup
  safeInit('KeyboardShortcuts', initKeyboardShortcuts);
  safeInit('WakeLock', initWakeLock);
  safeInit('AudioOutputRecovery', initAudioOutputRecovery);
  safeInit('BackgroundResumeGuard', () =>
    initBackgroundResumeGuard({
      recover: ({ hiddenMs }) => recoverLongBackgroundResume(hiddenMs),
      warn: () => longBackgroundWarning.warn(),
      shouldHandle: () => hasActiveBackgroundResumeSession(),
      log,
    }),
  );
  safeInit('PageLifecycle', () => {
    // Windows that opened or closed under an abandoned reset re-derive once
    // it releases its locks.
    setSessionResetReleaseHandler(syncOverlayStateAfterExternalLock);
    initPageLifecycleHandlers({
      getRole: () => getState('network.appRole'),
      // A confirmed pagehide may be the installed-PWA OAuth navigation. Keep
      // its short-lived route hint; direct/user-confirmed leaveSession calls
      // clear the hint at their explicit session-exit boundary.
      leaveSession: () => leaveSession({ preserveAccountLoginReturn: true }),
      // A pending bfcache reset is restored immediately before this callback,
      // so the coordinator can paint a fresh overlay and own reload recovery.
      reload: () => scheduleDocumentReload(t('dialog.refreshing_session')),
      hasPendingReset: isSessionResetPending,
      restorePendingReset: restoreSessionReset,
      log,
    });
  });
  safeInit('BackButtonGuard', initBackButtonGuard);

  // 12. System compatibility check (deferred to not block bootstrap)
  setManagedTimer('sys-compat-check', checkSystemCompatibility, 100);

  // 13. Expose debug helpers on window (dev only)
  if (import.meta.env?.DEV) {
    const debugObj = {
      state: snapshot,
      setState,
      bus,
      initAudio,
      isAudioReady,
      applySettings,
      setChannelMode,
      // Page-lifecycle flag bindings — exposed so devtools (and preview
      // sanity probes) touch the same module instance as the bootstrap.
      markIntentionalNav,
      isIntentionalNav,
    };
    window.__MXQR = debugObj;
  }

  publishBootstrapReadiness();
  let updateCompletion: string | null = null;
  try {
    updateCompletion = sessionStorage.getItem(UPDATE_COMPLETION_KEY);
    sessionStorage.removeItem(UPDATE_COMPLETION_KEY);
  } catch {
    // Storage denial only suppresses this one informational toast.
  }
  if (updateCompletion) showToast(updateCompletion);
}

// Run bootstrap

function runBootstrap(): void {
  publishBootstrapDataset('bootstrapping');
  void bootstrap().catch((e) => {
    failOpenSetupBootGuard();
    bootstrapReadiness.recordFailure('BootstrapOrchestrator', 'orchestration');
    const snapshot = bootstrapReadiness.snapshot();
    publishBootstrapDataset('aborted', snapshot);
    const failures = snapshot.failures.map(({ name, phase }) => `${name}[${phase}]`).join(', ');
    log.error(
      `[App] Bootstrap wiring aborted after ${snapshot.total} observed steps; failed: ${failures}:`,
      e,
    );
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runBootstrap, { once: true });
} else {
  runBootstrap();
}
