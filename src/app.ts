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
import { createBackButtonGuardController } from './core/back-button-guard.ts';
import { initBackgroundResumeGuard } from './core/background-resume-guard.ts';
import { runBackgroundResumeRecovery } from './core/background-resume-recovery.ts';
import { initSyncFlightRecorder } from './diagnostics/sync-flight-recorder.ts';
import { reacquireWakeLockIfActive } from './core/wake-lock.ts';
import {
  isSessionResetPending,
  restoreSessionReset,
  scheduleDocumentReload,
  scheduleSessionReset,
} from './core/session-reset.ts';
import { createReloadRecoveryLatch } from './core/reload-recovery-latch.ts';

// ── Audio ──
import { initAudio, isAudioReady } from './audio/engine.ts';
import { applySettings, applySettingsAsync, initEffectsHandlers } from './audio/effects.ts';
import { setChannelMode } from './audio/channel.ts';
import { isPlaybackModeYouTube, isPlaybackPlayingFile } from './player/ownership.ts';
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
import { initStandardQueueMutationAuthority } from './network/queue-mutation-authority.ts';
import { initPeerHandlers, leaveSession, recoverPeerAfterBackground } from './network/peer.ts';
import { initSync } from './network/sync.ts';
import { initOrchestrator } from './network/orchestrator.ts';
import { registerSystemCaptureListeners } from './audio/system-capture.ts';
import { initStandardOperatorFileUplink } from './network/operator-file-uplink.ts';
import { getRoomContext } from './rooms/authority.ts';
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
import { getCurrentAudioBuffer, isLocalFilePaused } from './player/_state.ts';

// ── YouTube ──
import { initYouTube } from './youtube/player.ts';
import { guestRendezvousSync, initYouTubeSync } from './youtube/sync.ts';

// ── UI ──
import { initOverlayObservers, isAnyOverlayShown } from './ui/dom.ts';
import { initEmailCopyLinks } from './ui/copy-email.ts';
import { initToast } from './ui/toast.ts';
import { initDialog, showDialog } from './ui/dialog.ts';
import { initTabs } from './ui/tabs.ts';
import { initI18n } from './i18n/index.ts';
import { t } from './i18n/index.ts';
import { initAccount } from './ui/account.ts';
import { initAccountActivityStats } from './account/activity-stats.ts';
import { initAccountRoomIdentity } from './account/room-identity.ts';
import { initVisualizer } from './ui/visualizer.ts';
import { initChat } from './ui/chat.ts';
import { initPlaylistView } from './ui/playlist-view.ts';
import { initPlayerControls } from './ui/player-controls.ts';
import { initGlobalFileDrop } from './ui/file-drop.ts';
import { initClearableEditors } from './ui/clearable-editors.ts';
import { initAllCustomScrollbars } from './ui/custom-scrollbar.ts';
import { initSettings } from './ui/settings.ts';
import { initSetup } from './ui/setup.ts';
import { initDemoMode } from './demo/mode.ts';
import { initAnnouncementPolling } from './ui/announcement.ts';
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
  readonly roomKind: 'standard' | 'pro';
  readonly roomId: string | null;
  readonly roomEpoch: number;
  readonly queueItemId: string | null;
  readonly buffer: AudioBuffer;
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
let suppressLongBackgroundWarningForIncident = false;

function captureAudioRecoveryIdentity(
  intent: AudioRecoveryIdentity['intent'],
  expectedQueueItemId: string | null,
  sourceIntentIsCurrent?: () => boolean,
  foregroundRestartAttemptToken?: object,
  confirmForegroundRestart?: (attemptToken: object) => boolean,
  retry?: () => Promise<boolean>,
): AudioRecoveryIdentity | null {
  const room = getRoomContext();
  const queueItemId = getState('playlist.currentQueueItemId');
  const buffer = getCurrentAudioBuffer();
  if (
    !getState('setup.sessionStarted') ||
    getState('playback.mode') !== 'file' ||
    !queueItemId ||
    queueItemId !== expectedQueueItemId ||
    !buffer ||
    getState('files.current')?.queueItemId !== queueItemId ||
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
    roomKind: room.kind,
    roomId: room.roomId,
    roomEpoch: room.epoch,
    queueItemId,
    buffer,
    sourceIntentIsCurrent,
    foregroundRestartAttemptToken,
    confirmForegroundRestart,
    retry,
  };
}

function audioRecoveryPlaybackIdentityStillCurrent(identity: AudioRecoveryIdentity): boolean {
  const room = getRoomContext();
  return Boolean(
    document.visibilityState === 'visible' &&
    getState('setup.sessionStarted') &&
    getState('playback.mode') === 'file' &&
    (identity.intent === 'retry-failed-play' || isPlaybackPlayingFile()) &&
    !isLocalFilePaused() &&
    !isFilePipelineBusyForPlay() &&
    room.kind === identity.roomKind &&
    room.roomId === identity.roomId &&
    room.epoch === identity.roomEpoch &&
    getState('playlist.currentQueueItemId') === identity.queueItemId &&
    getState('files.current')?.queueItemId === identity.queueItemId &&
    getCurrentAudioBuffer() === identity.buffer,
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
    left.roomKind === right.roomKind &&
    left.roomId === right.roomId &&
    left.roomEpoch === right.roomEpoch &&
    left.queueItemId === right.queueItemId &&
    left.buffer === right.buffer &&
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
  const operation = showDialog({
    title: t('dialog.audio_recovery_title'),
    message: t('dialog.audio_recovery_message'),
    buttonText: t('dialog.audio_recovery_action'),
    dismissible: false,
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

async function resumeAudioForBackgroundRecovery(): Promise<void> {
  if (!isPlaybackPlayingFile()) return;

  // The app guard is registered before the lazily-created AudioContext
  // binding. Yield one task so every visibility listener can publish its
  // exact incident before the inspector captures one-shot recovery tokens.
  await delay(0);
  if (!isPlaybackPlayingFile()) return;

  const output = await inspectBackgroundFileOutput();
  if (output.status === 'stale') {
    // A native state-interruption attempt is the sole owner of its async
    // proof and any recovery prompt. Suppress the generic long-background
    // dialog while that owner is pending so the two dialogs cannot race.
    if (getPendingAudioContextRecoveryAttemptForHealth()) {
      suppressLongBackgroundWarningForIncident = true;
    }
    return;
  }
  if (output.status === 'needs-gesture') {
    const reason = output.reason === 'clock-stalled' ? 'clock-stalled' : 'context-not-running';
    suppressLongBackgroundWarningForIncident = true;
    const queueItemId = getState('playlist.currentQueueItemId');
    bus.emit('audio:output-recovery-needed', {
      reason,
      source: 'background-resume',
      queueItemId,
    });
    await requestAudioOutputRecovery(reason, 'background-resume', queueItemId);
    return;
  }
  if (output.status === 'not-applicable') return;

  // applySettingsAsync is intentionally synchronous; do not insert a
  // microtask gap between the inspector's exact source claim and rejoin.
  if (isAudioReady()) applySettingsAsync();
  if (output.isCurrent?.() !== true) return;
  const lockRecovery = recoverStalePlayLock('background-resume', Date.now(), {
    preservePlaybackState: true,
  });
  if (lockRecovery.recovered) {
    log.warn('[Audio] Foreground recovery discarded a stalled play owner', lockRecovery.snapshot);
  }
  if (output.rejoinEmitted || (!output.rejoinRequired && !lockRecovery.recovered)) return;
  const rejoinIdentityCurrent = lockRecovery.recovered
    ? output.isPlaybackCurrent?.() === true
    : output.isCurrent?.() === true;
  if (!rejoinIdentityCurrent) return;
  bus.emit('playback:local-output-rejoin', {
    reason: 'background-resume',
    mode: 'file',
    isCurrent: () =>
      output.isPlaybackCurrent?.() === true && isPlaybackPlayingFile() && !isLocalFilePaused(),
  });
}

async function recoverLongBackgroundResume(hiddenMs: number): Promise<void> {
  log.warn(`[App] Background resume (${Math.round(hiddenMs / 1000)}s): attempting recovery`);

  suppressLongBackgroundWarningForIncident = false;
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
    shouldRecoverRoom: (peerRecovery) => {
      // PRO reconciliation belongs exclusively to the server-authority
      // runtime. Its endpoints intentionally have no hostConn, so falling
      // through would broadcast a stale legacy-host snapshot.
      if (getRoomContext().kind === 'pro') return false;
      // File recovery is participant-local and room-aware. It already chose
      // host rebuild, guest authoritative sync, or PRO reconciliation above.
      if (isPlaybackPlayingFile()) return false;

      // A foreground probe owns a possibly stale guest connection. A confirmed
      // survivor resumes on its heartbeat; a stale connection follows the
      // normal HOST_DISCONNECTED path.
      return peerRecovery.status === 'not-applicable';
    },
    recoverRoom: () => {
      const hostConn = getState('network.hostConn');

      if (isPlaybackModeYouTube()) {
        if (hostConn?.open) {
          guestRendezvousSync({ silent: true });
        } else {
          // Mobile WebKit suspends interval timers while hidden. Publish a
          // fresh host snapshot instead of waiting for the next heartbeat.
          bus.emit('youtube:broadcast-sync');
        }
        return;
      }
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
  bus.on('player:buffer-changed', abortSupersededRecovery);
  bus.on('state:room.context', abortSupersededRecovery);
  bus.on('state:setup.sessionStarted', abortSupersededRecovery);
  bus.on('audio:output-recovery-needed', (event) => {
    if (event.source === 'background-resume') {
      suppressLongBackgroundWarningForIncident = true;
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

async function warnLongBackgroundResume(): Promise<void> {
  if (suppressLongBackgroundWarningForIncident) return;
  await showDialog({
    title: t('dialog.background_resume_title'),
    message: t('dialog.background_resume_message'),
    buttonText: t('dialog.got_it'),
    defaultFocus: 'primary',
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
// History API trick: when a session goes active, push one guard entry onto
// the stack. When the user presses back the browser pops that entry and
// fires `popstate` — NOT a real page unload — so the page stays intact and
// we show a custom dialog instead. On dialog confirm we call leaveSession()
// explicitly; on cancel we re-push the guard entry so the next back press
// re-fires popstate rather than escaping to the real previous page.
//
// Arming is event-driven (idle → non-idle) rather than seeded at bootstrap:
// seeding at bootstrap would make the back button in the landing/idle view
// silently consume the guard entry on first press, which looks broken.
//
// Complements (does not replace) `beforeunload`: tab close, refresh, and
// direct URL changes still route through the beforeunload confirmation.
function initBackButtonGuard(): void {
  const controller = createBackButtonGuardController({
    isSessionActive: () =>
      getState('setup.sessionStarted') && getState('network.appRole') !== 'idle',
    pushGuard: () => history.pushState({ mxqrGuard: true }, '', location.href),
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
      scheduleSessionReset(t('dialog.leaving_session'), () => {
        try {
          leaveSession();
        } catch (e) {
          log.warn('[App] leaveSession failed:', e);
        }

        // Pop both the guard and session entries. Direct-entry users have
        // no usable history target, so they fall back to a hard replace.
        const beforeUrl = location.href;
        try {
          history.go(-2);
        } catch {
          /* noop */
        }
        // Native timer by design: leaveSession() clears managed timers.
        window.setTimeout(() => {
          if (location.href === beforeUrl) window.location.replace('/');
        }, 150);
      });
    },
    onSeedError: (error) => log.warn('[App] Back-button guard seed failed:', error),
    onConfirmationError: (error) => log.warn('[App] Back-button dialog failed:', error),
  });

  // Arm only after setup actually succeeds. Provisional host/guest roles are
  // soft-cancellable and must not leave a duplicate landing history entry.
  bus.on('state:network.appRole', controller.handleSessionStateChange);
  bus.on('state:setup.sessionStarted', controller.handleSessionStateChange);
  window.addEventListener('popstate', controller.handlePopState);
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
  feature: 'connect' | 'pro-room' | 'room-session';
  error: unknown;
};

const runLazyFeatureRecovery = createReloadRecoveryLatch<LazyFeatureFailure>({
  async present() {
    const result = await showDialog({
      title: t('dialog.sw_update_title'),
      message: t('dialog.sw_update_msg'),
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
    // callback creates an update-dialog loop without changing the cached
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
  feature: 'connect' | 'pro-room' | 'room-session',
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
  safeInit('Sync', initSync);
  safeInit('SyncFlightRecorder', initSyncFlightRecorder);
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
  safeInit('PlaylistView', initPlaylistView);
  safeInit('PlayerControls', initPlayerControls);
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
      loading ??= import('./ui/connect-session-runtime.ts')
        .then(() => undefined)
        .catch((error) => {
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
  safeInit('Setup', initSetup);
  safeInit('DemoMode', initDemoMode);
  safeInit('AnnouncementPolling', initAnnouncementPolling);
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
      warn: () => warnLongBackgroundResume(),
      shouldHandle: () => hasActiveBackgroundResumeSession(),
      log,
    }),
  );
  safeInit('PageLifecycle', () =>
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
    }),
  );
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
}

// Run bootstrap

function runBootstrap(): void {
  publishBootstrapDataset('bootstrapping');
  void bootstrap().catch((e) => {
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
