# Beta sequence QA, round 7 — 2026-10-03

| Field             | Value                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Status            | Discovery evidence; no new confirmed user-reachable defect in the tested scope                                                  |
| Tested checkout   | `mxqr_beta`, `67a4f26bec3768f002c7969d4c97758efe9c6cd7`                                                                         |
| Product/test code | `45c7ef7a4e0fef5b788efe11cb72d54c9b221929` — includes SQ14–SQ15 repairs                                                         |
| Main reference    | `35759e8b07f1ee0b272afbd0af03c770a858889e`                                                                                      |
| Environment       | Windows, pinned Node 24.20.0, Vitest 5/jsdom/local Worker fixtures, Playwright 1.63 Chromium and local PeerJS                   |
| Related records   | [Living release record](../beta-release-readiness.md), [previous discovery and repairs](beta-sequence-qa-2026-10-03-round-6.md) |

## Result

**No new confirmed defect.** The final reachable-sequence and regression
checks passed: **31 files / 1,348 module and Worker cases**, plus **5 files /
10 Chromium cases**. Fail/skip are zero within those runs; browser retries and
flaky results are also zero. The new cases comprise 137 module/Worker sequences
and 5 browser sequences. Independent replays are not added to these counts.

A separate forced-exception probe reproduces a conditional YouTube recovery
weakness. Its native trigger was not demonstrated, so its three failed
assertions are retained below without being promoted to a user-reachable
defect or hidden inside the passing totals.

Product code, maintained tests, dependencies, version `8.6.61`, cache `v630`,
server contracts, bindings, secrets and schemas are unchanged. Only discovery
evidence and release records are committed to beta. Main, production and the
disabled Operations Drift Audit workflow remain untouched. This is not an
exact-main release candidate or a new complete-suite/security/physical-device
sign-off.

## File and transfer lifetime

New probes execute real host `playTrack`, queue mutation, decode ownership,
large-resource lifetime, preload and outgoing transfer logic. They hold the
native decode or Blob-read boundary while the user changes the queue.

- Existing and large-file engine paths, cold and promoted preload, successful
  and rejected old decode: healthy control, two reorders, outgoing/future/
  selected removal, full removal, and full removal followed by the identical
  File object added as a new occurrence. **56 cases passed.** Obsolete decode
  results/errors do not replace or skip the successor; retained owners continue.
- Broadcast and unicast preload held inside `Blob.slice().arrayBuffer()`, then
  promoted to the selected track: removal, clear/re-add, unrelated deletion,
  reorder and healthy controls. **12 cases passed.** Retired streams send one
  abort and no stale chunk/end tail; valid streams complete exactly once.
- **270 existing cases passed**, covering operator upload/revoke/regrant,
  queue authority/capacity, playlist identity, transfer priority, preload lane
  ownership and large-resource lifecycle.

Ownership references: [decode](../../src/player/decode.ts),
[playlist](../../src/player/playlist.ts), [preload](../../src/storage/preload.ts).
The primary agent independently replayed all 68 new cases.

The native decoder/large reader/audio output boundaries are controlled. These
results do not certify physical codec parity, actual memory pressure or
cross-device acoustic alignment.

## PRO queue mutations during preparation and commit

**60 new cases passed:** YouTube and registered file asset × before READY /
owner READY / committed × participant compact route / internal Developer queue
route × delete previous current / delete prepared target / delete unrelated /
clear / reorder.

The probes create activation, session, playlist selection and readiness through
real [Worker request handlers](../../cloudflare/pro-room-worker.ts). Public
snapshots pass the production parser. The file path uses the existing
reservation/completion helper and fake R2 storage. Internal state is observed
to check ownership, not mutated to manufacture a failure.

Removing an owning item retires its transition; late READY cannot resurrect
it. Unrelated changes preserve preparation. Every surviving queue can select
and commit its next valid item. **312 existing Worker cases** and **258 runtime
cases** also passed, including permission changes, HTTP preparation, reconnect,
canonical playback, media observations and share restoration.

The primary agent independently replayed the 60 new Worker cases; 312 baseline
cases were filtered out of that replay and had already passed in the full
focused Worker run. They are not counted twice. No live Cloudflare/R2,
browser PRO session or actual native decode is claimed.

## YouTube, demo and UI interaction lifetimes

- **9 new reachable YouTube cases passed:** offsets −9.999 / 0 / +9.999 seconds
  followed, after the manual transaction settles, by explicit pause, full stop
  or selection of the previous different video. Real player/sync/iframe runtime
  with asynchronous native callbacks preserves the final control and occurrence.
  **371 existing cases** also passed across iframe recovery/callback ownership,
  host rendezvous, manual-offset capture, zero-start heartbeat ownership, demo
  recovery/sync and capture-stop races.
- **5 new Chromium sequences passed:** revoke an administrator while holding
  the main volume slider; exit a shared demo while holding its volume slider;
  remote demo exit with a focused positive/negative manual-sync draft followed
  by reentry; revoke/regrant during a playlist deletion selection. Actual DOM,
  pointer/keyboard and PeerJS paths retain valid values and retire stale UI
  ownership. Demo entry/exit is initiated through the same App bus events as
  its controls; demo CDN and account verdicts use explicit local fixtures.
- **5 existing Chromium controls passed** across effects drag authority,
  demo settings recovery, mobile touch reorder and seek during source change.

Browser source checks include [range drag](../../src/ui/range-drag.ts),
[manual-sync overlay](../../src/ui/manual-sync-overlay-runtime.ts),
[demo disclosure](../../src/ui/demo-inline-controls.ts),
[playlist removal](../../src/ui/playlist-removal.ts) and
[demo exit](../../src/demo/mode.ts).

## Conditional observation, not a confirmed finding

The existing [iframe watchdog](../../src/youtube/iframe.ts) rebuilds the player
after six thrown time/duration polls. Under a forced throwing getter while a
Standard host's manual-offset transaction has temporarily paused playback,
the rebuild captures the paused projection instead of the pending playing
intent. The replacement stays paused. The stronger probe uses the real Sync
button/editor/Enter handler, managed watchdog timer, replacement-player
construction and asynchronous ready/state callbacks.

Eight injected cases produced **5 pass / 3 fail**. The failures are committed,
debounced and UI-driven variants of one conditional cause. Normal playing,
intentional pause, paused-origin offset, completed offset and ordinary seek
controls pass. The primary agent independently reproduced the same failures.

**The missing evidence is the native trigger.** The official YouTube widget
script snapshot inspected here caches `playerInfo` in the parent and computes
`getCurrentTime` from that cache; `destroy` does not erase it. An inner iframe
crash alone therefore does not establish the required thrown getter. No real
process/browser failure that enters this branch was demonstrated. This remains
an unconfirmed robustness observation, not SQ16, and does not justify a product
change in this discovery round.

Primary-source snapshot: [IFrame API reference](https://developers.google.com/youtube/iframe_api_reference),
[loader](https://www.youtube.com/iframe_api),
[widget build 8ab5c328](https://www.youtube.com/s/player/8ab5c328/www-widgetapi.vflset/www-widgetapi.js).
The fetched widget file is preserved locally with SHA256
`9581398632CACA02628A42735EEF3D27BCE56371E4A344C54040AA9904D947BF`.
This conclusion is limited to inspected evidence; it is not proof that the
watchdog can never run in any browser/API revision.

## Evidence, corrections and limits

Raw evidence is under ignored `scratch/qa7-2026-10-03/`.

| Scope                            | Final result              | Evidence                                                                                                 |
| -------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| New file/transfer matrix         | 3 files, 68 pass          | `file/matrix-final.json`; independent `file/root-final.json`                                             |
| Existing file controls           | 9 files, 270 pass         | `file/controls-final.json`                                                                               |
| New PRO matrix + existing Worker | 1 file, 372 pass (60 new) | `pro/worker-matrix-final.json`; independent `pro/root-matrix.json` filters the 312 baseline cases        |
| Existing PRO runtime             | 10 files, 258 pass        | `pro/runtime.json`                                                                                       |
| New reachable YouTube controls   | 1 file, 9 pass            | `youtube/reachable-final.json`                                                                           |
| Existing YouTube/demo/capture    | 7 files, 371 pass         | `youtube/existing.json`                                                                                  |
| Conditional injected watchdog    | 1 file, 5 pass / 3 fail   | `youtube/crash-async-ui.json`; independent `youtube/root-initial.json`, excluded from confirmed findings |
| New Chromium sequences           | 1 file, 5 pass            | `browser/final.json`                                                                                     |
| Existing Chromium controls       | 4 files, 5 pass           | `browser/controls.json`                                                                                  |
| Local E2E build                  | Pass                      | `build-e2e.log`                                                                                          |

All final passing runs have zero skipped cases. Browser runs use worker 1,
retry 0 and report no flaky results. Filtered independent replays and initial
explorations are not additional test counts.

Three harness corrections are preserved rather than classified as defects:

1. The initial PRO matrix expected HTTP 409 after a transition was retired;
   the actual contract is 404 `PLAYBACK_TRANSITION_NOT_FOUND`. Correcting that
   precise status/error oracle resolved 44 initial failures.
2. The initial YouTube stop control expected the nonexistent mode `'none'`;
   the idle contract is `null`. Correcting the oracle resolved three failures.
3. A browser probe tried to focus/send Home to the main slider before the demo
   exit curtain released it, so no real user input occurred. Replacing that
   with an actionable pointer click proved the intended sequence passes. The
   initial failure and diagnostic state remain in `browser/initial.json` and
   `browser/demo-observe.json`. An intermediate probe syntax error is also
   retained separately and is not product evidence.

### Replay

Prepend `scratch/beta-upgrade-2026-09-09/node-v24.20.0-win-x64` to `PATH` and
set `PLAYWRIGHT_BROWSERS_PATH` to the absolute sibling `playwright-browsers`
directory. Scratch configs/import paths refer to this local workspace.

```text
node node_modules/vitest/vitest.mjs run --config scratch/qa7-2026-10-03/file/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa7-2026-10-03/pro/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/qa7-2026-10-03/youtube/vitest.config.ts scratch/qa7-2026-10-03/youtube/reachable-controls.test.ts --maxWorkers=1
npm run build:e2e
node node_modules/@playwright/test/cli.js test --config scratch/qa7-2026-10-03/browser/qa.config.ts --project=chromium --workers=1 --retries=0
node node_modules/@playwright/test/cli.js test e2e/effects-drag-authority.test.ts e2e/demo-settings-recovery.test.ts e2e/seek-drag-source-change.test.ts e2e/playlist-touch-reorder.test.ts --project=chromium --workers=1 --retries=0
```

The new browser run used App/PeerJS ports 4217/9047; the independent existing
browser run used 4218/9048. No competing build changed `dist` during either.
These are focused checks. The last full unit result (10,637 passing cases) is
the previous repair's evidence at the same product SHA, not rerun here. Full
E2E, WebKit, coverage, dependency audit, real YouTube playback, physical audio,
native process failure, live service and production validation were not run.
Existing security/version/cache/exact-main CI/physical-device gates remain in
the living release record. Zero new confirmed defects does not close them.
