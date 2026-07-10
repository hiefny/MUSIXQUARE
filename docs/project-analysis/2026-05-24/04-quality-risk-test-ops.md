# Quality, Risk, Test, and Ops Analysis

> **Historical snapshot (2026-05-24).** Test results, CI behavior, findings,
> line numbers, and risk ratings below belong to that baseline and are not a
> current release report.

## Fast-Gate Results

Commands run on 2026-05-24:

```text
npm run typecheck
npm run lint
npm test
npm run build:checked
```

Results:

- TypeScript passed.
- ESLint passed.
- Vitest passed: 66 test files, 947 tests.
- Production build passed.
- Production hook guard passed.
- Production security guard passed.

This is a strong baseline for local static/unit/build health.

## Build Output and Warnings

Observed build output highlights:

- `index.html`: ~135 kB, gzip ~24.6 kB.
- `assets/main-*.css`: ~124 kB, gzip ~23.0 kB.
- `assets/main-*.js`: ~824 kB, gzip ~210.8 kB.
- `assets/peerjs-*.js`: ~88 kB, gzip ~24.0 kB.
- Pretendard variable font asset: ~2 MB.

Warnings:

1. `src/player/playlist.ts` is dynamically imported from several modules but statically imported from `src/app.ts` and `src/ui/player-controls.ts`. Because of the static imports, Rollup cannot move it into a separate chunk.

2. Main JS chunk exceeds 500 kB after minification.

Risk:

- This is not currently a correctness failure.
- It can affect cold load time, especially on mobile or slow networks.
- Splitting must be done carefully because many modules register singleton event handlers and import-time state.

Recommended future analysis:

- Generate a bundle visualization.
- Identify whether YouTube, system-audio, demo, or chat command surfaces can be lazy-loaded behind user action.
- Avoid splitting `playlist.ts` blindly until import-time side effects and initialization order are documented.

## Test Suite Structure

Unit tests:

- `src/audio/__tests__`
- `src/core/__tests__`
- `src/demo/__tests__`
- `src/i18n/__tests__`
- `src/network/__tests__`
- `src/network/transport/__tests__`
- `src/player/__tests__`
- `src/share/__tests__`
- `src/storage/__tests__`
- `src/ui/__tests__`
- `src/youtube/__tests__`

E2E tests:

- `e2e/*.test.ts`
- Playwright config uses one worker due to shared PeerJS/signaling behavior.
- E2E workflow is manual dispatch only.

Coverage config:

- `vitest.config.ts` includes `src/**/*.ts`.
- Several browser/API-heavy and integration-style files are excluded from coverage thresholds.
- Thresholds are moderate: lines/statements 60, functions 55, branches 45.

## CI Workflows

`.github/workflows/ci.yml`:

- Runs on push and PR to `main`.
- Uses Node 22.
- Runs:
  - `npm ci`
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run build:checked`

`.github/workflows/e2e.yml`:

- Manual dispatch only.
- Comment says Playwright suite is serial, around 30 minutes, and has stale scenarios.
- Runs:
  - `npm ci`
  - `npm run build:e2e`
  - `npx playwright install --with-deps chromium`
  - `npx playwright test`

Interpretation:

- Fast CI is intentionally the PR gate.
- E2E is not a reliable mandatory release gate at the moment.
- That matches the stale E2E findings below.

## Confirmed Finding: E2E Still Uses Removed `appState`

Severity: P1 for test reliability, not production runtime.

Confidence: confirmed by repository search.

Evidence:

- `docs/appstate-decomposition.md` says legacy `state.appState` was removed.
- `docs/state-patterns.md` says new consumers should use mode/activity and lifecycle helpers.
- `src/player/__tests__/playback-state-contract.test.ts` guards against production `appState` reintroduction.
- `src/core/state.ts` exposes the raw state getter in dev/e2e mode.
- `StateTree` does not include an `appState` path.
- E2E files still query `__MUSIXQUARE_GET_STATE__('appState')`.

Examples found:

- `e2e/late-join.test.ts`
- `e2e/playback-advanced.test.ts`
- `e2e/youtube.test.ts`
- `e2e/helpers/wait.ts`

`e2e/helpers/wait.ts` also defines `VALID_APP_STATES` that mirrors old `APP_STATE` values.

Impact:

- Current E2E assertions can fail or wait incorrectly because the state path no longer exists.
- It creates a false sense of coverage around playback state transitions.
- It explains why E2E is documented as stale/manual.

Recommended fix after permission:

- Replace raw `appState` checks with a helper that reads:
  - `playback.mode`
  - `playback.activity`
  - `playback.lifecycle`
  - selected domain state such as `youtube.isActive`, `systemAudio.isReceiving`, or transfer lifecycle when needed.
- Prefer semantic E2E helpers like `waitForPlaybackActivity(page, 'playing')` or `waitForMediaOwner(page, 'youtube')` over direct state path calls in tests.
- Keep E2E helper names aligned with production contract language.

## State Contract Risk

Severity: P2.

The production state contract is cleaner now, but it is still easy for future changes to bypass it.

Protective patterns already present:

- `src/player/ownership.ts` centralizes writes.
- `src/player/lifecycle.ts` centralizes file lifecycle transitions.
- Unit tests block broad `appState` reintroduction.
- Existing docs explain state patterns.

Recommended future guard:

- Add tests or static search guard for E2E helper migration so stale terminology does not reappear.
- Document exact state path ownership in a table.

## Runtime Race Risks

These are not necessarily current bugs; they are high-risk surfaces to preserve during future changes.

### File Transfer Receive

Files:

- `src/storage/transfer-receive.ts`
- `src/storage/transfer-send.ts`
- `src/storage/preload.ts`
- `src/share/remote-share.ts`

Risk themes:

- Stale chunks after a new session starts.
- Early chunks arriving before FILE_START.
- Remote-share wait being superseded by direct local transfer.
- Preload promotion colliding with foreground playback.
- Same-track replay while transfer state is mid-cleanup.
- Chunk watchdog timeouts differing for local and remote paths.

Existing mitigations:

- Session IDs.
- Reorder buffers.
- Early chunk buffers.
- Chunk watchdogs.
- Skip predicates.
- Pending play snapshots.
- Remote-local promotion tests.

### YouTube Synchronization

Files:

- `src/youtube/iframe.ts`
- `src/youtube/player.ts`
- `src/youtube/sync.ts`

Risk themes:

- Iframe API readiness.
- Autoplay restrictions.
- Host ad state versus guest state.
- Playlist/subitem indexing.
- Manual/rendezvous sync ordering.
- Stale sync snapshots.
- Latency calibration persistence.
- iOS player reuse requirements.

Existing mitigations:

- Two-stage autosync.
- Rendezvous constants.
- Drift thresholds and cooldowns.
- Crash detection/rebuild.
- Unavailable video heuristics.
- Unit/integration tests under `src/youtube/__tests__`.

### System Audio

Files:

- `src/audio/system-capture.ts`
- `src/network/system-audio-host.ts`
- `src/network/system-audio-guest.ts`
- `src/network/system-audio-sfu.ts`

Risk themes:

- Capture permission behavior.
- Media track ending unexpectedly.
- Switching between P2P and SFU.
- Restoring previous YouTube/file state after stop.
- Guest readiness and delayed media streams.
- Browser support gaps, especially mobile.

Existing mitigations:

- Explicit start/stop protocol.
- Previous mode snapshot/restore.
- Debug helpers.
- Unit tests for system audio guest/capture behavior.

### Leave/Cleanup

Files:

- `src/network/peer.ts`
- `src/player/transport.ts`
- `src/share/remote-share.ts`
- `src/storage/preload.ts`
- `src/player/ownership.ts`

Risk themes:

- Leaving during decode.
- Leaving during remote-share upload/download.
- Leaving during YouTube iframe loading.
- Leaving during system capture.
- Old timers firing after reset.
- Blob URLs or MediaStreams surviving longer than intended.

Existing mitigations:

- Managed timers.
- Abort controllers.
- Blob manager.
- Load/session tokens.
- State reset helpers.

## Protocol and Security Risk

Primary positive findings:

- Protocol validation is centralized.
- Inbound rate limiting exists.
- Chunk transfer is bounded.
- Remote-share max size is bounded.
- YouTube playlist/result sizes are bounded.
- Chat and settings payloads are validated.
- Host-only checks commonly verify `conn === hostConn`.
- OP control requests are verified.

Areas to keep watching:

- Any new protocol message should be added to validators and authority checks.
- Any new file/data message must respect the no-file-data-over-TURN policy.
- Any new remote-share flow must keep decryption keys out of R2.

## Cloudflare Ops Risk

Files:

- `cloudflare/wrangler.app.toml`
- `cloudflare/app-worker.js`
- `scripts/assert-production-security-config.mjs`

Observed config:

- `MXQR_TURNSTILE_DISABLED = "true"` in app Wrangler config.
- `MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK = "true"` is allowed by production security guard during Turnstile grace period.
- Build guard prints that this policy is allowed and then passes.

Interpretation:

- This is intentional and guarded, not an accidental secret leak.
- It should remain visible as an operational risk until the grace period ends.

Recommended follow-up:

- Add a dated operational note describing:
  - Why Turnstile is disabled.
  - What signal will re-enable it.
  - Who owns the switch.
  - Whether this state is acceptable for production.

## UI and DOM Risk

The app uses manual DOM rather than a component framework. That is viable but shifts risk into:

- ID/class/data-attribute drift.
- Manual listener lifecycle.
- Focus/inert behavior.
- InnerHTML safety.
- UI state not refreshing on i18n change.

Strong patterns:

- `escapeHtml` exists.
- `tHtml()` escapes interpolated params.
- Overlay stack logic is centralized.
- UI modules have unit tests.
- ARIA attributes are present in several controls.

Risks to inspect later:

- Dynamic HTML renderers such as playlist/chat/connect controls.
- Keyboard navigation through all overlays.
- Mobile viewport behavior.
- Screen reader label consistency.

## Dependency Risk

Runtime dependencies are few, which is good.

Main external runtime behavior risks:

- `peerjs`: WebRTC abstraction behavior, browser compatibility, signaling fallback.
- `qrcode`: QR rendering only; relatively low risk.
- `realtime-bpm-analyzer`: party/beat mode performance and accuracy.
- `content-shield`: depends on usage surface; inspect before security-sensitive changes.

Recommended future action:

- Run `npm audit` only as an advisory step, not as an automatic fix step, because dependency upgrades can change browser behavior.

## Performance Risk

Known performance-sensitive areas:

- Main bundle size.
- Large font asset.
- Web Audio graph and analyser/visualizer.
- YouTube iframe lifecycle.
- Large file decode memory.
- Remote-share upload/download memory.
- Long playlists and playlist UI rendering.
- Chat command/debug outputs.

Existing positive patterns:

- RAM-only storage simplifies disk cleanup.
- Blob URLs are managed.
- Beat detection is lazy and caches per buffer.
- Remote-share avoids TURN data cost.
- Preload is local-only and serialized.

Potential future work:

- Bundle analysis.
- Lazy load YouTube/search/commands/system-audio paths.
- Virtualize very large playlist UI if needed.
- Measure mobile cold start.

## Risk Register

| ID | Area | Severity | Confidence | Finding | Suggested action |
| --- | --- | --- | --- | --- | --- |
| R1 | E2E | P1 | Confirmed | E2E still checks removed `appState`. | Permission-gated E2E helper migration. |
| R2 | Build/perf | P2 | Confirmed | Main JS chunk > 500 kB and `playlist.ts` mixed static/dynamic import warning. | Bundle analysis before refactor. |
| R3 | Ops/security | P2 | Confirmed | Turnstile disabled grace-period fallback is allowed in app worker config. | Add operational owner/removal criteria. |
| R4 | Runtime | P2 | Likely | File transfer/preload/remote-share paths are race-dense. | Preserve session/token guards; add scenario tests when changing. |
| R5 | Runtime | P2 | Likely | YouTube iframe/sync behavior depends on third-party/browser timing. | Keep E2E/manual matrix; add targeted helper migration. |
| R6 | Runtime | P2 | Likely | System audio support depends on capture/media/browser behavior. | Maintain manual device matrix for releases. |
| R7 | UI | P3 | Likely | Manual DOM controller layer can drift from HTML. | Add/maintain DOM contract tests for high-value controls. |
| R8 | Maintainability | P3 | Confirmed | Several files exceed 1,000 lines. | Refactor only when changing behavior or extracting stable subcontracts. |

## Current Bottom Line

The project is healthy under fast static/unit/build gates. The most actionable confirmed issue is stale E2E state assumptions. The biggest production risk class is not ordinary syntax/type failure, but real browser/network timing across multiple devices and media backends.
