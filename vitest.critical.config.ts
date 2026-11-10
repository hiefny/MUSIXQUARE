import { defineConfig } from 'vitest/config';

/**
 * Coverage ratchet for high-risk runtime paths that the broad historical
 * report excluded. This profile complements the broad unit KPI and keeps the
 * real-time/request-lifetime modules instrumented as they evolve.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/core/__tests__/network-guard.setup.ts'],
    include: [
      'src/core/__tests__/capability-pow.test.ts',
      'src/core/__tests__/request-lifetime.test.ts',
      'src/core/__tests__/fullscreen.test.ts',
      'src/ui/__tests__/fullscreen-handoff.test.ts',
      'src/network/__tests__/*system-audio-sfu.test.ts',
      // The system-audio receive slot (RO-04): its four contract suites, the
      // guest receiver and the G1 watchdog harness, enrolled in Phase 5 prep
      // (T4) before the slot moves.
      'src/network/__tests__/system-audio-receive-slot-{contract,lifecycle-contract}.test.ts',
      'src/pro-room/__tests__/system-audio-receive-slot-{pro-contract,pro-transport-contract}.test.ts',
      'src/network/__tests__/system-audio-guest.test.ts',
      'src/pro-room/__tests__/system-audio-subscriber-watchdog.test.ts',
      // The routes' shared media home, enrolled with it in Phase 5 C4-1.
      'src/network/__tests__/system-audio-media.test.ts',
      // The PRO publication's teardown entry points (RO-20), pinned in Phase 5
      // C4-12 before the service names its three teardown operations.
      'src/pro-room/__tests__/system-audio-publication-teardown.test.ts',
      // The PRO LAN-direct route and the shared selected-pair helper, enrolled
      // in 9.0.27 when the route gained its pair-check and early-fallback rules.
      'src/network/__tests__/{pro-system-audio-direct,ice-selected-pair}.test.ts',
      'src/audio/__tests__/{context-health,context-recovery,foreground-output-health,output-health,system-capture,system-capture-stop}.test.ts',
      // The AudioContext output-recovery owners (RO-01), enrolled in Phase 7
      // prep (T0) before the structural plan's C1 merges their two machines:
      // the owner-boundary harness, the UI sound suite, and the boundary,
      // holding and parity tables; since Phase 7 7C-2 the recovery dialog's
      // tap through the owner's entry, since 7C-3 a local-file PLAY's
      // foreground clock check, since 7C-4 the owner's one test seam, since
      // 7C-5 its two attempt scopes on one context, and since 7C-K8 a
      // restore's tap while a YouTube attempt waits.
      'src/audio/__tests__/{audio-context-ownership,ui-sounds}.test.ts',
      'src/audio/__tests__/audio-output-recovery-{attempt-type,boundary,dialog,file-start,holding,parity,restore-tap,test-seam}.test.ts',
      'src/pro-room/__tests__/{api,heartbeat-single-flight,media-transfer,playlist-state-manager,session-controller}.test.ts',
      'src/pro-room/__tests__/{playback-duration-reporting,upload-duration}.test.ts',
      'src/pro-room/__tests__/device-failure-sequence-qa.test.ts',
      'src/pro-room/__tests__/runtime-*.test.ts',
      'src/player/__tests__/{busy-guard,concurrency-invariants,load-epoch-initial,local-output-rejoin,playback,playback-extended,playback-queue-identity,playback-replay-resync,playback-remote-wait,playlist,transport-position}.test.ts',
      // The Media Session gesture path into the same owners (Phase 7 prep, T0).
      'src/player/__tests__/{media-session,media-session-lock-screen-pause}.test.ts',
      // A local-file PLAY's foreground clock check over the same owners: its
      // `/debug sync` counts path by path (Phase 7 7C-3).
      'src/player/__tests__/output-recovery-play-counts.test.ts',
      'src/storage/__tests__/preload.test.ts',
      'src/network/transport/__tests__/{cloudflare-signaling,cloudflare-signaling-worker}.test.ts',
      // The link-liveness owner (RO-15): enrolled in Phase 4 C5-6, the resume probe since C5-7,
      // the side route's outage deadline since C5-9 (its owner unit suite and the
      // two-connection side-route suite).
      'src/network/transport/__tests__/{link-liveness,link-liveness-characterization,link-liveness-side-outage,side-route-outage-integration}.test.ts',
      'src/network/__tests__/transport-health.test.ts',
      'src/youtube/__tests__/{search,search-style}.test.ts',
      // The verified YouTube iframe audio restore (RO-12), enrolled with its
      // module in Phase 6 6A-4, and the module's App writes, pause gate and
      // holds since it became their owner in Phase 6 6C-2.
      'src/youtube/__tests__/{iframe-audio,iframe-audio-owner}.test.ts',
      // The YouTube start ledger (RO-02) and its zero-start run owner, enrolled
      // with the ledger in Phase 6 6B-1: the ledger's suite, the controller's
      // own suites and the Standard start-ownership truth table.
      'src/youtube/__tests__/{start-ownership,zero-start,zero-start-fallback-ownership,zero-start-heartbeat-ownership,youtube-start-ownership-table}.test.ts',
      // The shared arm steps (RO-03) and the PRO arm, enrolled in Phase 6
      // 6C-4: the steps' suite, the arm's own suite and the golden that runs
      // the arm and the zero-start run on one scripted iframe.
      'src/youtube/__tests__/{arm-steps,arm-steps-golden,authority-arm}.test.ts',
      // The zero-start recoveries: the guest's (RO-33 under RO-02), enrolled
      // with its class in Phase 6 6D-1, and the host's legacy recovery beside
      // it since 6D-2 (RO-02): the classes' suite and the golden that runs
      // them on the real wiring.
      'src/youtube/__tests__/{zero-start-recovery,zero-start-recovery-golden}.test.ts',
      'src/account/__tests__/{api,session,login-return}.test.ts',
      'src/ui/__tests__/announcement.test.ts',
      'src/share/__tests__/r2-client.test.ts',
      // The page navigation owner (RO-23) and the service-worker update path
      // (RO-22), enrolled in Phase 3 (C6-9) as Phase 2 decision 13 deferred.
      'src/core/__tests__/{session-reset,page-navigation-owner.integration,page-lifecycle,navigation,document-reload}.test.ts',
      'src/core/__tests__/{sw-register,sw-register-recovery.integration,sw-update-transitions.integration}.test.ts',
      'src/core/__tests__/{sw-hard-reset,sw-update-completion,sw-update-coordination}.test.ts',
    ],
    environment: 'node',
    globals: true,
    // Keep initialization calls available to assertions; Vitest 5 clears them by default.
    clearMocks: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: 'coverage/critical-runtime',
      include: [
        'src/core/capability.ts',
        'src/core/request-lifetime.ts',
        'src/core/fullscreen.ts',
        'src/network/system-audio-sfu.ts',
        'src/network/pro-system-audio-sfu.ts',
        'src/network/system-audio-guest.ts',
        'src/network/pro-system-audio-direct.ts',
        'src/network/system-audio-media.ts',
        'src/network/system-audio-receive-slot.ts',
        'src/pro-room/system-audio-service.ts',
        'src/audio/system-capture.ts',
        'src/pro-room/api.ts',
        'src/pro-room/media-transfer.ts',
        'src/pro-room/playback-controller.ts',
        'src/pro-room/runtime.ts',
        'src/pro-room/persisted-resource-lane.ts',
        'src/pro-room/playlist-state-manager.ts',
        'src/player/transport.ts',
        'src/player/local-output-rejoin.ts',
        'src/audio/context-recovery.ts',
        'src/audio/context.ts',
        'src/storage/preload.ts',
        'src/network/transport/cloudflare-signaling.ts',
        'src/network/transport/link-liveness.ts',
        'src/network/transport-health.ts',
        'src/youtube/oembed.ts',
        'src/youtube/iframe-audio.ts',
        'src/youtube/start-ownership.ts',
        'src/youtube/zero-start.ts',
        'src/youtube/arm-steps.ts',
        'src/youtube/authority-arm.ts',
        'src/youtube/zero-start-recovery.ts',
        'src/account/api.ts',
        'src/account/session.ts',
        'src/ui/announcement.ts',
        'src/share/r2-client.ts',
        'src/core/session-reset.ts',
        'src/core/document-reload.ts',
        'src/core/navigation.ts',
        'src/sw-register.ts',
        'src/sw-update-coordination.ts',
        'src/sw-prompt-lock.ts',
        'src/core/sw-hard-reset.ts',
        'src/core/sw-update-completion.ts',
      ],
      exclude: ['src/**/__tests__/**'],
      thresholds: {
        // Two consecutive Node 24 runs on 2026-08-15 produced the same
        // baseline: statements 74.84, branches 67.68, functions 81.76,
        // lines 79.07. Retain at least a one-point instrumentation margin
        // while preventing the expanded critical coverage from disappearing.
        statements: 73,
        branches: 66,
        functions: 80,
        lines: 78,
        // Aggregate coverage can hide a regression in one hotspot behind an
        // improvement in another. These independent file floors sit roughly
        // one percentage point below the stable 2026-08-15 Node 24 baseline.
        'src/account/api.ts': {
          statements: 92,
          branches: 88,
          functions: 93,
          lines: 92,
        },
        'src/account/session.ts': {
          statements: 91,
          branches: 82,
          functions: 91,
          lines: 94,
        },
        'src/audio/context-recovery.ts': {
          // The identity-fenced iOS recovery state machine was expanded on
          // 2026-08-21 (Node 24 baseline 84.15, 78.67, 89.65, 87.71). With
          // the AudioContext owner suites enrolled on 2026-11-02 (Phase 7
          // prep, T0), two identical Node 24 runs on main 7d60f134 measured
          // 90.99, 88.66, 88.57, 93.37: about one point below each. Since
          // Phase 7 7C-4 it also holds the play-request restart and the
          // suspend ledger; two identical Node 24 runs on 2026-11-08 measured
          // 91.94, 88.72, 94.11, 94.15.
          statements: 90,
          branches: 87,
          functions: 93,
          lines: 93,
        },
        // The shared AudioContext, enrolled with the owner suites on
        // 2026-11-02 about one point below two identical Node 24 runs on main
        // 7d60f134: 89.53, 84.36, 95.52, 91.68. Since Phase 7 7C-4 it keeps
        // the singleton and its primitives only (the play-request restart
        // moved into the owner): 92.98, 92.1, 100, 92.59 in two identical
        // Node 24 runs on 2026-11-08.
        'src/audio/context.ts': {
          statements: 91,
          branches: 91,
          functions: 99,
          lines: 91,
        },
        'src/audio/system-capture.ts': {
          statements: 80,
          branches: 76,
          functions: 73,
          lines: 82,
        },
        'src/core/capability.ts': {
          statements: 77,
          branches: 69,
          functions: 77,
          lines: 81,
        },
        'src/core/request-lifetime.ts': {
          statements: 87,
          branches: 74,
          functions: 87,
          lines: 93,
        },
        'src/network/pro-system-audio-sfu.ts': {
          statements: 73,
          branches: 54,
          functions: 80,
          lines: 79,
        },
        'src/network/system-audio-sfu.ts': {
          statements: 74,
          branches: 59,
          functions: 80,
          lines: 80,
        },
        // The system-audio receive slot's route adapters, enrolled on
        // 2026-10-25 (Phase 5 prep T4) about one point below two identical
        // Node 24 runs on agent/phase5-5a aa62fe34. The service and the PRO
        // direct transport are measured only through the suites enrolled
        // above (the receive-slot contracts and the G1 harness); their own
        // unit suites stay outside this profile.
        'src/network/system-audio-guest.ts': {
          statements: 90,
          branches: 80,
          functions: 97,
          lines: 93,
        },
        'src/network/pro-system-audio-direct.ts': {
          statements: 37,
          branches: 37,
          functions: 52,
          lines: 42,
        },
        'src/pro-room/system-audio-service.ts': {
          statements: 50,
          branches: 40,
          functions: 56,
          lines: 53,
        },
        // The routes' shared media home (Phase 5 C4-1) is fully covered by
        // system-audio-media.test.ts on 2026-10-25.
        'src/network/system-audio-media.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        // The receive slot (Phase 5 C4-2), measured through the suites
        // enrolled above (the guest receiver's trusted-reception pins, the
        // receive-slot contracts and the G1 harness) on 2026-10-25: 93.75,
        // 86.36, 100, 96.59. What stays uncovered are the defensive re-checks
        // the move kept (a start committing between the boundary wait's two
        // placeholder checks, a commit that finds the placeholder up).
        'src/network/system-audio-receive-slot.ts': {
          statements: 92,
          branches: 85,
          functions: 99,
          lines: 95,
        },
        'src/network/transport/cloudflare-signaling.ts': {
          statements: 72,
          branches: 71,
          functions: 72,
          lines: 78,
        },
        // The link-liveness owner (Phase 4, C5-6 and C5-7) is fully covered
        // by link-liveness.test.ts on 2026-10-25, and its side-route outage
        // deadline (C5-9) by link-liveness-side-outage.test.ts.
        'src/network/transport/link-liveness.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        // The transport-health read path (Phase 4, C5-4) is fully covered by
        // transport-health.test.ts on 2026-10-24.
        'src/network/transport-health.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        'src/player/local-output-rejoin.ts': {
          statements: 80,
          branches: 73,
          functions: 93,
          lines: 84,
        },
        'src/player/transport.ts': {
          statements: 59,
          branches: 52,
          functions: 79,
          lines: 62,
        },
        'src/pro-room/api.ts': {
          statements: 81,
          branches: 77,
          functions: 94,
          lines: 85,
        },
        'src/pro-room/media-transfer.ts': {
          statements: 84,
          branches: 81,
          functions: 86,
          lines: 86,
        },
        'src/pro-room/playlist-state-manager.ts': {
          statements: 87,
          branches: 80,
          functions: 97,
          lines: 89,
        },
        // Playback authority moved out of runtime.ts on 2026-08-17, and the
        // persisted-resource lock/refresh lane on 2026-10-11. Preserve the
        // pre-extraction logical-unit floor, then keep every file on an
        // independent floor so none can hide a regression in another.
        'src/pro-room/{runtime,playback-controller,persisted-resource-lane}.ts': {
          statements: 66,
          branches: 58,
          functions: 69,
          lines: 70,
        },
        // Fully covered by runtime-persisted-resource-lane.test.ts on
        // 2026-10-11 (Node 24: 100 statements, branches, functions, lines).
        'src/pro-room/persisted-resource-lane.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        'src/pro-room/playback-controller.ts': {
          statements: 80,
          branches: 72,
          functions: 87,
          lines: 85,
        },
        'src/pro-room/runtime.ts': {
          statements: 61,
          branches: 51,
          functions: 65,
          lines: 65,
        },
        'src/share/r2-client.ts': {
          statements: 75,
          branches: 69,
          functions: 80,
          lines: 81,
        },
        'src/storage/preload.ts': {
          statements: 68,
          branches: 59,
          functions: 84,
          lines: 71,
        },
        'src/ui/announcement.ts': {
          statements: 85,
          branches: 79,
          functions: 99,
          lines: 93,
        },
        'src/youtube/oembed.ts': {
          statements: 77,
          branches: 59,
          functions: 92,
          lines: 80,
        },
        // The verified iframe audio restore (Phase 6 6A-4) is fully covered
        // by iframe-audio.test.ts on 2026-10-31, and the App writes, pause
        // gate and holds (6C-2) by iframe-audio-owner.test.ts on 2026-11-02.
        'src/youtube/iframe-audio.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        // The YouTube start ledger (Phase 6 6B-1) is fully covered by
        // start-ownership.test.ts on 2026-11-01.
        'src/youtube/start-ownership.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        // The zero-start run owner, enrolled with the ledger on 2026-11-01
        // about one point below two identical Node 24 runs: 85.56, 84.05,
        // 97.6, 89.28.
        'src/youtube/zero-start.ts': {
          statements: 84,
          branches: 83,
          functions: 96,
          lines: 88,
        },
        // The shared arm steps (Phase 6 6C-4) are fully covered by
        // arm-steps.test.ts and arm-steps-golden.test.ts on 2026-11-02.
        'src/youtube/arm-steps.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        // The PRO arm, enrolled with the shared steps on 2026-11-02 about one
        // point below two identical Node 24 runs: 87.71, 81.92, 98.52, 92.3.
        'src/youtube/authority-arm.ts': {
          statements: 86,
          branches: 80,
          functions: 97,
          lines: 91,
        },
        // The zero-start recoveries (Phase 6 6D-1), enrolled with the guest's
        // class on 2026-11-02 about one point below the Node 24 run: 99.44,
        // 97.14, 100, 100; with the host's stage beside it (6D-2) the same
        // day, 99.29, 96.98, 100, 100. What stays uncovered are defensive
        // fallbacks (a video id the iframe does not report, a cued iframe at
        // a settled check, a cleanup or a timeout a newer recovery fenced).
        'src/youtube/zero-start-recovery.ts': {
          statements: 98,
          branches: 96,
          functions: 99,
          lines: 99,
        },
        // The page navigation owner and the service-worker update path,
        // enrolled on 2026-10-24 (Phase 3, C6-9) at about one point below two
        // Node 24 runs on main 08003954 plus the C6-9 boundary tests.
        'src/core/session-reset.ts': {
          statements: 94,
          branches: 90,
          functions: 95,
          lines: 96,
        },
        'src/core/document-reload.ts': {
          statements: 88,
          branches: 82,
          functions: 83,
          lines: 99,
        },
        'src/core/navigation.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        'src/sw-register.ts': {
          statements: 86,
          branches: 84,
          functions: 74,
          lines: 88,
        },
        'src/sw-update-coordination.ts': {
          statements: 91,
          branches: 91,
          functions: 99,
          lines: 94,
        },
        'src/sw-prompt-lock.ts': {
          statements: 91,
          branches: 99,
          functions: 99,
          lines: 91,
        },
        'src/core/sw-hard-reset.ts': {
          statements: 88,
          branches: 83,
          functions: 99,
          lines: 95,
        },
        'src/core/sw-update-completion.ts': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
      },
    },
  },
});
