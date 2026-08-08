# Runtime Scenario Verification - 2026-05-31

> **Maintained checklist.** Originally added on 2026-05-31 and revalidated on
> 2026-08-08. Physical-device and real-browser verification is the release
> confidence principle. Browser E2E remains an optional auxiliary signal: a
> failure can help locate a regression, but a pass never substitutes for the
> real-device matrix.

## Scope

This is the maintained verification order for runtime-sensitive flows across
playback, network, transfer, YouTube, and system audio.

Unit/static checks establish deterministic code confidence. Real devices then
verify the browser, audio hardware, lifecycle, and network behavior that a
headless browser cannot prove.

## Optional Browser Automation Signal

The following focused group remains available when browser automation is useful
and time-bounded:

```bash
npm run test:e2e:runtime
```

The script builds the E2E bundle first, then runs:

- `e2e/late-join.test.ts`
- `e2e/playback-sync.test.ts`
- `e2e/youtube-sync.test.ts`
- `e2e/reconnection.test.ts`
- `e2e/background-resume.test.ts`

It is not a required release gate and must not delay the physical-device pass.
Do not interpret a green focused or full E2E suite as evidence that Web Audio,
background/resume, device routing, or real WebRTC network transitions work on
the target hardware.

## First 48 Hours

### 0-2 hours: establish a safe baseline

1. Install with `corepack npm ci`; do not add production credentials to the checkout.
2. Start `npm run dev` with the default fail-closed local API boundary. Confirm
   a production-backed API path returns `503 LOCAL_API_PROXY_DISABLED`, not the
   SPA HTML and not a production response.
3. Run the smallest focused unit test for the touched area, then run
   `npm run typecheck` and `npm run check:workers` when Worker code is involved.
4. Record the devices, browser versions, audio roles, and network shapes needed
   for the touched scenarios. Capture a fresh-load memory/debug baseline.

### 2-24 hours: implement and exercise the risky path

1. Keep deterministic regression tests close to each change and run `npm test`,
   `npm run lint`, and `npm run build:checked` before device work.
2. Exercise the affected scenario on at least two physical devices when it
   crosses host/guest, WebRTC, audio routing, or background lifecycle boundaries.
3. Include the failure/recovery branch: disconnect/reconnect, background/resume,
   rapid source replacement, or denied authorization as applicable.
4. Use the memory checkpoints below and retain concise observations. Browser
   E2E may be used as a quick diagnostic signal, but it is not a prerequisite
   for continuing the real-device matrix.

### 24-48 hours: repeat, broaden, and decide

1. Repeat every touched row in the manual matrix from a clean build and fresh
   sessions; include both local-network and remote-network paths when relevant.
2. Verify cleanup and recovery after leave, hard reload, and one background or
   network interruption. Compare memory/debug state with the recorded baseline.
3. Review Worker contract/deployment guards and the rollback boundary without
   performing an ad hoc production deploy.
4. Record device/browser/network evidence and any accepted limitation. A release
   candidate is not ready when a required real-device row is untested, even if
   optional E2E is green.

### Current service-control cutover addendum

The first release containing the
[`service-control contract marker`](../cloudflare/service-control-contract-version.txt)
is a coordinated cutover:

1. Use release target `all`; the service-control owner in the PRO Worker must
   deploy before its App Worker consumer. Do not use a partial target for this
   first release.
2. After the canonical service-control state has been written, do not roll PRO
   or App back to a pre-marker/legacy App version. Repair forward with another
   compatible full release. The rollback gate and operator procedure live in
   [`hotfix-procedure.md`](hotfix-procedure.md).
3. This checklist documents release order only. Do not perform an ad hoc deploy
   from a development checkout.

Before considering that cutover healthy, collect these targeted signals:

| Check                                | Required evidence                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account completion on a slow network | On a physical mobile browser, complete the flow with its sensitive query present. Verify the query-bearing navigation is not cached, the queryless completion shell is the only offline fallback, and no query value reappears after reload/back navigation.          |
| Announcement save, clear, and expiry | From the admin UI in a controlled environment, publish an expiring notice, observe expiry, then clear it. Interrupt one post-commit response and retry the unchanged action; the UI must reuse the same request ID and produce one revision/history entry.            |
| Legacy duplicate-owner detach retry  | Run `npm exec vitest run -- src/core/__tests__/app-worker-cors.test.ts -t "detaches only the exact duplicate legacy owner and safely reconciles a signaling failure"`. The injected partial failure must converge on exact retry without changing the retained owner. |
| Cold font and offline fallback       | On a physical device with caches cleared, verify readable first paint while fonts load and that a cold font failure does not block service-worker installation. Then verify the intended offline app shell remains usable without the optional font.                  |

## Memory Snapshot Checkpoints

Use `/debug memory` during manual or browser-driven runs. The snapshot now
includes a `RamStore` section alongside file, transfer, and preload buffers.

Recommended checkpoints:

1. Fresh page load, before joining a room.
2. After host uploads a local file.
3. After one guest late-joins and receives the current track.
4. After 10 rapid next/previous actions.
5. After leaving the session.
6. After a hard reload.

Watch for monotonic growth in:

- `[Audio] live AudioBuffers`
- `[Files] currentBlob/preloadBlob`
- `[Transfer] reorderBuf/pendingEarly`
- `[Preload] reorderBuf/sessionState`
- `[RamStore] main/preload`
- `[Tracked] sum of above`

`[Tracked]` is a logical sum, not a heap measurement: shared Blob/File
references may be counted more than once, while browser and audio-engine
allocations may be absent. Diagnose component trends and whether each returns
to its baseline after cleanup rather than treating this total alone as a leak.

## Manual Runtime Matrix

Run the relevant rows on physical devices regardless of whether optional E2E
was run:

| Scenario                                                    | Expected signal                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Remote guest late-joins a local-file room                   | Guest receives the authorized whole-object remote-share handoff, then syncs near host position. |
| Local guest late-joins a local-file room                    | Guest receives the direct WebRTC file transfer, then syncs near host position.                  |
| Host rapidly switches local files while a preload is active | Guest does not play the wrong file; stale chunks do not keep transfer stuck.                    |
| YouTube load, manual sync, then stop mode                   | Guest enters and exits YouTube projection without stale play timers.                            |
| Desktop system-audio share over local P2P                   | Guest receives one stream and cleanup restores previous UI state.                               |
| Remote system-audio SFU path                                | Guest receives SFU stream, host stop clears placeholder/receiving state.                        |
| Background/resume on mobile browser                         | App attempts recovery and warns if sync may be stale.                                           |

## Exit Criteria

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build:checked`
- Manual matrix completed with recorded evidence for every browser/device class
  and network boundary touched by the release.
- Cleanup/recovery behavior returns to the expected state after leave, reload,
  and the applicable interruption case.

Optional focused or full browser E2E results may accompany this evidence as a
secondary signal. They are not an exit criterion or a production-release gate.
