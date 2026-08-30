# Known And Accepted Risks

Originally opened on 2026-05-12 after the app-state decomposition and playback
ownership refactor; later entries carry their own acceptance dates. Paths and
the continued reachability of the listed tradeoffs were statically rechecked on
2026-08-30. Static review does not replace the real-browser checks called out
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

### 4. File Recovery Requests Are Not Operator-Only Commands

`REQUEST_CURRENT_FILE` and `REQUEST_DATA_RECOVERY` are data-plane recovery messages, not playback-control commands. A non-operator guest still needs to request the current file or missing chunks to become playable.

This is accepted only while host/session/current-track guards remain in place. Do not "fix" this by adding operator checks; that would break late join and recovery flows.

### 5. Partial Standard-Room P2P Schema Validation

Standard-room P2P and browser transport messages are not all validated through
a full schema library. Every declared message type is now inventory-guarded as
either a lightweight bounded validator or an explicit handler-authority
compatibility case. Sensitive handlers still treat session participants as
untrusted and apply connection/session/current-track checks.

This is accepted only for the current temporary, invite-code standard-room threat model. PRO persistence and Worker HTTP/WebSocket boundaries have separate runtime validators, bounds, and authority checks and are outside this standard-room P2P exception; this statement does not claim that every stored envelope uses exact-key validation. Reopen this item before exposing discoverable public standard rooms, feeding partially validated standard-room messages into persistence, or changing the standard-room trust boundary.

### 6. Browser-Only API Test Gaps

Some behavior cannot be proven by jsdom unit tests alone:

- Media Session lock-screen behavior
- service-worker cache/update behavior
- real YouTube iframe state ordering
- WebRTC DataChannel and MediaStream timing
- iOS/Safari background and audio policy behavior

This is accepted as a test-layer boundary. The right mitigation is targeted Playwright/manual device verification, not over-mocking browser APIs until tests stop resembling production.

### 7. `document.execCommand` Fallbacks

Some UI paths still use `document.execCommand(...)` as a compatibility fallback for text insertion/copy behavior.

This is accepted while modern alternatives are not equivalent across the supported mobile/browser surface. Reopen if a target browser removes the API or if a specific command path fails in production.

### 8. Fixed-Scale Mobile Application Surface

The main MUSIXQUARE SPA intentionally disables browser page zoom with both
viewport metadata and an iOS gesture-cancellation fallback. This is accepted
because the product is a dense, fixed-layout playback application whose seek,
volume, drag/reorder, swipe, drawer, safe-area, and embedded-media controls
share one viewport coordinate system. Browser zoom changes that system during
interaction instead of reflowing a document.

This exception applies only to the main app shell. Preserve the remaining
accessibility contracts and direct users who require whole-screen
magnification to OS display zoom or the OS magnifier. Do not reopen this as a
generic accessibility finding without the product/design and physical-device
conditions in `docs/mobile-app-zoom-policy.md`.

## Retired Risks

These older draft findings and subsequently resolved risks should no longer be
carried forward as accepted risks:

| Old item                                                               | Current status                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanupOPFSInWorker` listener leak                                    | Retired. Current storage is RAM-backed; `src/storage/storage.ts` explicitly avoids `navigator.storage.getDirectory()` writes.                                                                                                                                                      |
| PeerJS vendor/type escape warnings                                     | Retired. PeerJS is npm-backed and production `src` is pinned by `src/core/__tests__/type-escape-holdouts.test.ts`.                                                                                                                                                                 |
| Broad `Peer: any` / `as any` holdouts                                  | Retired. Current YouTube globals use local typed declarations; broad type escapes are covered by tests.                                                                                                                                                                            |
| Peer label/slot direct mutation as accepted reactive gap               | Retired as a blanket item. Critical peer maps now use `setState` with copied `Map`/object values in active paths.                                                                                                                                                                  |
| Tone.js cleanup/tree-shaking notes                                     | Retired. The audio layer now uses direct Web Audio helpers.                                                                                                                                                                                                                        |
| OPFS browser API coverage                                              | Retired as written. The remaining browser-only test gaps are Media Session, service worker, YouTube iframe, WebRTC, and real mobile audio policy.                                                                                                                                  |
| Blanket secondary-control accessibility gaps                           | Retired 2026-08-09. Concrete selection, carousel, dialog, chat-autocomplete, focus, and pointer contracts were audited and fixed; future exceptions must be documented individually.                                                                                               |
| System-audio media close handlers keyed only by channel/peer ID        | Retired 2026-07-19. Host and guest handlers now require exact `MediaConnection` identity, and a silent same-channel replacement has its own identity-fenced watchdog.                                                                                                              |
| `startSystemAudioCapture` mid-init failure leaves a silent-stop shadow | Retired 2026-07-16. `initAudio()` now completes before the prior playback snapshot is stopped, and a missing widener calls `abortPreparedCapture()` to restore that snapshot. Direct regression tests cover both failure paths.                                                    |
| System-audio entry does not cancel a debounce-parked file broadcast    | Retired 2026-08-30. After `stopAllMediaAsync` succeeds, `startSystemAudioCapture` now calls only `cancelPendingBroadcast()`. A failed teardown preserves the pending broadcast, while already in-flight outgoing transfers remain untouched. Regression tests pin both boundaries. |
| `/debug memory` retained and rendered every sample forever             | Retired 2026-08-30. Cumulative history now compacts to a bounded min/max envelope while preserving the full time span, endpoints, extrema, exact sample count, and running maximum; polling is single-flight.                                                                      |
| Loopback browser API clients implicitly retried production             | Retired 2026-08-30. Local PRO, TURN, and Realtime calls now fail closed on the same origin unless the explicit local-production fallback flag or a validated PRO endpoint override is configured.                                                                                  |

## Rule For Future Audits

When a new audit finding looks similar to one of these items, verify the current code path before dismissing it. Accepted means "intentional under today's contract," not "ignore forever."
