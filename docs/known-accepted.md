# Known And Accepted Risks

Originally opened on 2026-05-12 after the app-state decomposition and playback
ownership refactor; later entries carry their own acceptance dates. Paths and
the continued reachability of the listed tradeoffs were statically rechecked on
2026-07-11. Static review does not replace the real-browser checks called out
below.

This document prevents future audits from repeatedly reporting intentional tradeoffs. It is not a bug backlog. Anything here should still be revisited if MUSIXQUARE becomes a larger public multi-tenant service, adds discoverable public rooms, or introduces a new app bootstrap lifecycle.

## Current Accepted Items

### 1. YouTube IFrame API Global

Files such as `src/youtube/player.ts`, `src/youtube/iframe.ts`, and `src/youtube/handlers.ts` declare the browser-provided `YT` global using the local `YTNamespace` type.

This is accepted. The YouTube IFrame API is injected at runtime by YouTube, not imported as a normal npm module. The current code no longer relies on broad `as any` escapes for this path.

### 2. Best-Effort Cleanup Around Closed Media And Network Objects

WebRTC connections, PeerJS-compatible connections, media calls, and Web Audio nodes can throw during cleanup when they are already closed, partially initialized, or browser-disconnected.

This is accepted when the cleanup path is best-effort and the owning state is already being cleared through MUSIXQUARE state/event contracts. Do not convert these paths into hard failures unless there is a concrete recovery behavior.

### 3. Long-Lived SPA Resources

The app intentionally keeps some resources for the full page lifetime:

- singleton `AudioContext`
- app-level bus listeners registered during bootstrap
- the sync worker and in-process storage bridge
- service-worker registration update timer

This is accepted under the current contract: `app.ts` bootstraps once per page lifetime. If the app ever supports runtime re-bootstrap, micro-frontends, or hot-swapping the root app without a reload, this item must be reopened.

### 4. `user-scalable=no`

`index.html` currently disables user scaling for the PWA-style music-player surface.

This is a deliberate mobile-app UX tradeoff, not an accidental viewport bug. Reopen it during an accessibility pass or if the product target shifts toward broader assistive-technology support.

### 5. File Recovery Requests Are Not Operator-Only Commands

`REQUEST_CURRENT_FILE` and `REQUEST_DATA_RECOVERY` are data-plane recovery messages, not playback-control commands. A non-operator guest still needs to request the current file or missing chunks to become playable.

This is accepted only while host/session/current-track guards remain in place. Do not "fix" this by adding operator checks; that would break late join and recovery flows.

### 6. Partial Runtime Schema Validation

P2P and transport messages are not all validated through a full schema library. The code instead treats session participants as untrusted at sensitive handlers and uses targeted connection/session/current-track checks plus numeric guards on high-risk fields.

This is accepted for the current invite-code session-room threat model. Reopen before exposing discoverable public rooms or adding server-mediated persistence.

### 7. Browser-Only API Test Gaps

Some behavior cannot be proven by jsdom unit tests alone:

- Media Session lock-screen behavior
- service-worker cache/update behavior
- real YouTube iframe state ordering
- WebRTC DataChannel and MediaStream timing
- iOS/Safari background and audio policy behavior

This is accepted as a test-layer boundary. The right mitigation is targeted Playwright/manual device verification, not over-mocking browser APIs until tests stop resembling production.

### 8. `document.execCommand` Fallbacks

Some UI paths still use `document.execCommand(...)` as a compatibility fallback for text insertion/copy behavior.

This is accepted while modern alternatives are not equivalent across the supported mobile/browser surface. Reopen if a target browser removes the API or if a specific command path fails in production.

### 9. Secondary Control Accessibility Gaps

Some small or secondary UI controls may not meet every desktop keyboard/touch-target ideal.

This is accepted as a product-priority tradeoff for the current mobile-first music-room interface. It should not block stability work, but it belongs in a future accessibility/UI polish phase.

### 10. System-Audio Entry Does Not Cancel A Debounce-Parked File Broadcast

`startSystemAudioCapture` (`src/audio/system-capture.ts`) calls `stopAllMedia({silent, cancelInFlight})` but does not call `cancelPendingBroadcast()`, unlike the local→YouTube switch (`playlist.ts` playTrack YouTube branch). A broadcast parked in the 300ms send debounce when the user confirms the screen-share picker therefore fires during system-audio mode; guests drop every frame (`isExternalOwner` gates in `transfer-receive.ts`), so the cost is one wasted full-file send to local guests, repaired after restore by the normal `REQUEST_CURRENT_FILE` recovery.

This is accepted (2026-06-13 deep-dive). The window is a sub-300ms sliver: most overlap is already closed by the load's own external-owner abort (`decode.ts` post-decode check), and the strictly larger in-flight variant — a broadcast already pumping when system-audio starts — is itself accepted by design (SA-08: "chunks we discard anyway"). Cancelling only the parked sliver would not change the switch's waste profile. If revisited (system-audio becoming a high-frequency flow, or rooms growing past the current warn thresholds), the verified fix is a single `cancelPendingBroadcast()` after the `stopAllMedia` call in `startSystemAudioCapture` — pending-only, NOT `cancelOutgoingFileTransfers` (which would also abort in-flight transfers that can still finalize on guests before SYSTEM_AUDIO_START processes), and NOT inside `stopAllMedia` (HET-6).

### 11. `startSystemAudioCapture` Mid-Init Failure Leaves The Silent-Stop Shadow Without Restore

Two early-failure points in `src/audio/system-capture.ts` — the `initAudio()` throw and the widener-unavailable return — sit after `stopAllMedia({silent})` (which parks mode/activity as the file/playing shadow) but before `claimPlaybackOwner('system-audio')`, and neither restores from `_preSysAudioState`. The host then shows a playing-shaped UI with no audio until a manual play.

This is accepted (2026-06-13 23차 triage). Reachability is near-zero (the audio graph must fail to initialize on a machine that just granted `getDisplayMedia`), recovery is one tap, and the system-audio restore semantics were deliberately settled in the 21차 SA-02 fix (force-stop = transition, restore only on explicit stop) — adding restore writes to failure paths is not worth re-opening that surface. If revisited: these two paths are provably un-superseded (synchronous within the start flow), so restoring from `_preSysAudioState` there is safe.

## Retired From The Old Draft

A previous untracked workshop draft was written against an older architecture.
These items should no longer be carried forward as accepted risks:

| Old item | Current status |
| --- | --- |
| `cleanupOPFSInWorker` listener leak | Retired. Current storage is RAM-backed; `src/storage/storage.ts` explicitly avoids `navigator.storage.getDirectory()` writes. |
| PeerJS vendor/type escape warnings | Retired. PeerJS is npm-backed and production `src` is pinned by `src/core/__tests__/type-escape-holdouts.test.ts`. |
| Broad `Peer: any` / `as any` holdouts | Retired. Current YouTube globals use local typed declarations; broad type escapes are covered by tests. |
| Peer label/slot direct mutation as accepted reactive gap | Retired as a blanket item. Critical peer maps now use `setState` with copied `Map`/object values in active paths. |
| Tone.js cleanup/tree-shaking notes | Retired. The audio layer now uses direct Web Audio helpers. |
| OPFS browser API coverage | Retired as written. The remaining browser-only test gaps are Media Session, service worker, YouTube iframe, WebRTC, and real mobile audio policy. |
| System-audio media close handlers keyed only by channel/peer ID | Retired 2026-07-19. Host and guest handlers now require exact `MediaConnection` identity, and a silent same-channel replacement has its own identity-fenced watchdog. |

## Rule For Future Audits

When a new audit finding looks similar to one of these items, verify the current code path before dismissing it. Accepted means "intentional under today's contract," not "ignore forever."
