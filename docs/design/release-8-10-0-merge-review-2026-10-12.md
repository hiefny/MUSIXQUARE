# 8.10.0 merge with 8.9.6 and review of 8.9.4–8.9.6 — 2026-10-12

Status: shipped. PR [#294](https://github.com/hiefny/MUSIXQUARE/pull/294)
merged as main `95e9092c` after merging main `eb3d1496`, App `8.10.0` / PWA cache
`v659`, released with target `all` on 2026-10-12 (see
[Production verification](#production-verification)). It replaced App `8.9.6` /
`v657` at `8307f12b` ([release record](../release-record.md)).

## Why

The owner lifted the 2026-10-11 event hold on 2026-10-12. While #294 waited,
another developer shipped three releases: 8.9.4 (#295, also carrying the
merged #293), 8.9.5 (#298) and 8.9.6 (#300), with records #296, #299 and
#301. The owner asked for a review of that work before 8.10.0 goes out.

## Merge

- Main `8307f12b` merged as `4d75fd63`. Textual conflicts were only the
  version mirrors (kept `8.10.0`), `docs/README.md` (both sides' entries kept,
  newest first) and `docs/release-record.md`. The record drops the 8.9.1
  two-step dialog item, because 8.9.4 shipped it.
- The record-only main `eb3d1496` (#301) merged without conflicts.
- The cache moves from `v658` to `v659`, because merging runtime changes needs
  a newer bump (`guard:sw-cache-version`).
- Compared with the deployed `8307f12b`, the runtime paths are signaling 3,
  app 66, and pro-room, remote-share and developer-api 0. App runtime
  dependencies are unchanged.

## Review

There were four independent read-only reviews: one each for #295, #298 and
#300, and one for semantic interactions between #294 and the merged main. No
P1 or P2 defects were found. Each item below was checked against the source.

| Item | Severity | Disposition |
| --- | --- | --- |
| The tab replaced by "Continue here" shows the reworded `pro.active_tab_title` ("이전 연결이 남아 있어요") in its reset overlay (`src/pro-room/runtime.ts`), although it is the earlier connection (#295) | P3, copy | Fixed here (`6543d247`): new key `pro.active_tab_replaced` with the earlier shipped string in all 42 locales; the handoff test pins it and fails without the fix |
| Concatenated MP3s keep a stale Xing/VBRI frame count, and fragmented MP4 (`mvex`/`moof`) reports only the `moov` portion. Either reads short and can end a track early when no controller is awake (#298, persisted per asset by #300) | P3 | 8.10.1 |
| A natural advance rolled back by the state-capacity guard keeps a past deadline, so the alarm refires immediately (#298) | P3 | 8.10.1 |
| A file probe whose asset fails the identity check at start no longer records a backoff, so the alarm refires immediately (#300) | P3 | 8.10.1 |
| Live and unavailable YouTube metadata is re-queried every 60 s with no backoff. Deleted or private videos never auto-skip (#298) | P4 | 8.10.1; owner decision below |
| A controller's duration report outlives its permission (#298, #300) | P4 | 8.10.1 |
| An unguarded `report(result)` call after a successful preparation (#300) | P4 | 8.10.1 |
| A duplicate `/duration` post on on-time transitions; a late clock reply drops the rest of its burst | P4 | Not changed (load only; still better than before #295) |

The interaction review found no semantic conflicts. It covered:

- the three-way merge of all 42 locales;
- #295's failed-entry role restore against the in-room update deferral;
- the signaling ticket change against the Standard-room PIN paths;
- the runtime path lists, the Worker test inventory, and every guard.

## Owner decisions (2026-10-12)

- Deploy 8.10.0 first. The PRO Worker follow-ups ship next as their own
  release.
- Skip deleted or private YouTube videos in PRO rooms after two "not found"
  answers spaced apart in time. A transient error is not enough to skip.

## Verification

All local runs used Windows 11 and Node from the main checkout's
`node_modules`.

- **Full local check at `9f3245c2`.** This is the merged tree before the copy
  fix, the README reflow and the reordered bump. The following passed:
  - `npm run typecheck`, `lint` and `format:check`;
  - the full unit suite: 544 files, 11,743 pass, 0 fail, 0 skip;
  - `npm run build:checked`, including every guard.
- **Copy fix.** These ran after the fix:
  - `runtime-tab-handoff`, `src/i18n` and `setup-flow`: 29 files, 490 pass;
  - the handoff test alone, which fails with the old key.
- **Final branch tree.** Identical to the checked tree plus the fix. Both
  guards pass on it: `guard:sw-cache-version` (v659) and
  `guard:release-identity` (8.10.0 / v659).

PR CI and the exact-main CI are the remote evidence for the final SHA. No
real-device, Full E2E or native-speaker review was run.

## Production verification

- PR [CI 38163808826](https://github.com/hiefny/MUSIXQUARE/actions/runs/38163808826)
  passed all eleven jobs at the PR head `938e4bc3`, attempt 1. The PR was
  squash-merged at that exact head as `95e9092c`.
- Exact-main [CI 38164204638](https://github.com/hiefny/MUSIXQUARE/actions/runs/38164204638)
  failed on attempt 1. The only failing test was
  `src/ui/__tests__/playlist-view.test.ts` ("renders active uploads as compact
  file rows"). It expects the upload spinner's delay to match `-\d+ms`, but
  received `0ms`: `-Math.round(now % period)` is `-0` when the remainder rounds
  to zero, and a template literal renders that as `0ms`.
  - The test, the spinner code and their history predate this release, and
    #294 did not touch them. Visually the delay is the same either way.
  - After rerunning the failed jobs, attempt 2 passed all eleven jobs: 544
    files, 11,742 pass, 0 fail, and 1 Linux skip of a Windows-only test.
  - The test is fixed in the next release (8.10.1).
- [Production Release 38165114764](https://github.com/hiefny/MUSIXQUARE/actions/runs/38165114764)
  ran with `target=all` and Developer API D1 `false`. It succeeded on attempt 1
  at 2026-10-11 18:50:46 UTC (2026-10-12 03:50 KST).
  - All six Workers deployed the exact-main candidate, and all ten live smoke
    steps passed.
  - It restored PRO generation readiness, verified deployment ownership,
    re-verified the signaling Custom Domain, and persisted the coherent
    production marker.
  - Every recovery and rollback step was skipped.
- Public GETs returned HTTP 200 for the landing page, which loads
  `bootstrap.js?cache=v659`, and for `/service-worker.js`, which carries the
  `v659` cache. No customer room was entered or modified.

| Worker | Deployed version |
| --- | --- |
| App | `440431c8-90fd-4da7-ab34-f079168fcd02` |
| PRO | `63d9067d-1460-4c07-a131-3eb39592a260` |
| Remote Share | `8aa39334-cf5a-452c-9f44-1ca64860347e` |
| Signaling | `185b60d0-75de-42fb-a54e-b43a4c8f10b2` |
| Developer API facade | `9caf753c-27c5-43e5-913b-0f2eb6eca776` |
| Developer API | `f8e780e0-0923-4f40-b7f8-533065a03898` |

This release did not run the entire serial E2E suite or any physical-device
test. Those remain open checks in the release record.
