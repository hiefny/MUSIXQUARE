# 8.10.0 merge with 8.9.6 and review of 8.9.4–8.9.6 — 2026-10-12

Status: branch `agent/standard-room-owner-pin` (PR
[#294](https://github.com/hiefny/MUSIXQUARE/pull/294)) after merging main
`eb3d1496`, App `8.10.0` / PWA cache `v659`. Not merged or deployed;
production is App `8.9.6` / `v657` at `8307f12b`
([release record](../release-record.md)). Release target `all`.

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
