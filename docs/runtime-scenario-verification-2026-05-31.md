# Runtime Scenario Verification - 2026-05-31

> **Maintained checklist.** Originally added on 2026-05-31 and revalidated on
> 2026-07-11. The focused command and all five named E2E files still exist. This
> subset is a fast signal; it does not replace the full serial E2E suite for a
> production release.

## Scope

This is a low-risk verification prep pass for runtime-sensitive flows. It does
not change playback, network, transfer, YouTube, or system-audio behavior.

The focused group keeps the highest-risk cross-domain scenarios easy to run and
inspect alongside the full suite for the current decomposed playback model.

## Added Fast E2E Group

Use this focused command for the cross-domain runtime scenarios that should run
before a release-confidence pass:

```bash
npm run test:e2e:runtime
```

The script builds the E2E bundle first, then runs:

- `e2e/late-join.test.ts`
- `e2e/playback-sync.test.ts`
- `e2e/youtube-sync.test.ts`
- `e2e/reconnection.test.ts`
- `e2e/background-resume.test.ts`

This group intentionally avoids the full serial E2E suite. It is meant as a
focused signal during development and incident verification.

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

Run these manually when the focused E2E group is green:

| Scenario | Expected signal |
| --- | --- |
| Remote guest late-joins a local-file room | Guest receives the encrypted remote-share handoff, then syncs near host position. |
| Local guest late-joins a local-file room | Guest receives the direct WebRTC file transfer, then syncs near host position. |
| Host rapidly switches local files while a preload is active | Guest does not play the wrong file; stale chunks do not keep transfer stuck. |
| YouTube load, manual sync, then stop mode | Guest enters and exits YouTube projection without stale play timers. |
| Desktop system-audio share over local P2P | Guest receives one stream and cleanup restores previous UI state. |
| Remote system-audio SFU path | Guest receives SFU stream, host stop clears placeholder/receiving state. |
| Background/resume on mobile browser | App attempts recovery and warns if sync may be stale. |

## Exit Criteria

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build:checked`
- `npm run test:e2e:runtime`
- Manual matrix completed for any browser/device class touched by the release.

The full `npm run test:e2e` suite remains the broader production-release gate.
