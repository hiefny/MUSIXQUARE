# Documentation Hub

| Field              | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| Status             | Maintained index                                                      |
| Applies to         | Repository documentation and its lifecycle classification             |
| Last source review | 2026-10-13                                                            |
| Governance         | [Documentation governance](documentation-governance.md)               |
| Latest audit       | [Documentation audit — 2026-08-30](documentation-audit-2026-08-30.md) |

Use this hub to choose the current contract before following a dated audit or
prototype. “Maintained” means the document is intended to describe the present
repository boundary; it does not mean that a checked-in expectation proves the
live provider dashboard matches it.

## Start here

| Need                                      | Primary reference                                               | Then read                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Run or contribute locally                 | [Contributor guide](../CONTRIBUTING.md)                         | [Configuration reference](configuration-reference.md), [Local Worker integration](local-worker-integration.md)                              |
| Understand the product architecture       | [Root overview](../README.md)                                   | [Account/room authority](design/account-identity-and-room-authority.md), [PRO architecture](design/pro-room-architecture-and-operations.md) |
| Prepare or recover a production change    | [Production hotfix and rollback](hotfix-procedure.md)           | [Release versioning](release-versioning.md), [Runtime verification](runtime-scenario-verification-2026-05-31.md)                            |
| Check current production state            | [Release record](release-record.md)                             | [Release history](release-history.md), [production hotfix and rollback](hotfix-procedure.md)                                                |
| Operate Cloudflare services               | [Configuration drift checks](../cloudflare/config-drift-ops.md) | Owning Worker runbook below                                                                                                                 |
| Review intentional tradeoffs              | [Known and accepted risks](known-accepted.md)                   | Owning ADR and [security/performance policy](security-performance-tier-policy.md)                                                           |
| Decide whether an old document is current | [Documentation governance](documentation-governance.md)         | [Latest documentation audit](documentation-audit-2026-08-30.md)                                                                             |

## Maintained architecture and accepted decisions

These documents define current ownership or an accepted decision. Amend or
supersede them explicitly when the product boundary changes.

- [Account identity and room authority](design/account-identity-and-room-authority.md)
- [PRO room architecture and operations](design/pro-room-architecture-and-operations.md)
- [Coordinator-free PRO server authority](design/pro-room-server-authority.md)
- [Realtime runtime ownership](design/realtime-runtime-ownership.md)
- [Resource ownership registry](design/resource-ownership-registry.md)
- [Page navigation ownership](design/page-navigation-ownership.md)
- [System-audio receive ownership](design/system-audio-receive-ownership.md)
- [YouTube start ownership](design/youtube-start-ownership.md)
- [AudioContext ownership](design/audio-context-ownership.md) (accepted with Phase 7 train 7C,
  2026-11-10)
- [Signaling liveness](design/signaling-liveness.md)
- [Static asset delivery and PRO heartbeat persistence](design/static-assets-and-pro-heartbeat-optimization.md)
- [Initial bundle and lazy-loading policy](design/initial-bundle-loading-policy.md)
- [Browser media storage policy](design/browser-media-storage-policy.md)
- [Playback concurrency invariants](design/playback-concurrency-invariants.md)
- [Queue item identity and reorder](design/queue-item-identity-and-reorder.md)
- [Source complexity safety limits](design/source-complexity-ratchet.md)
- [Mobile application zoom policy](mobile-app-zoom-policy.md)
- [Security and hot-path performance policy](security-performance-tier-policy.md)
- [Known and accepted risks](known-accepted.md)

## Maintained operations and release runbooks

Before QA or a production release, start with the
[release record](release-record.md). It holds the current deployed state, open
checks, and release rules; the append-only [release history](release-history.md)
lists every production release since 8.6.61 (2026-09-20); earlier runs are
queried from GitHub Actions. Plan QA scope with the
[QA domains guide](qa-domains.md). Neither record replaces the canonical
release procedure.

| Boundary                        | Current runbooks                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release, recovery, and identity | [Production hotfix and rollback](hotfix-procedure.md), [release versioning](release-versioning.md), [runtime verification](runtime-scenario-verification-2026-05-31.md)      |
| Configuration and local routing | [Configuration reference](configuration-reference.md), [Local Worker integration](local-worker-integration.md), [Cloudflare drift checks](../cloudflare/config-drift-ops.md) |
| App, accounts, and admin        | [Account authentication](account-auth-operations.md), [admin access](admin-access.md), [admin dashboard operations](../cloudflare/admin-dashboard-ops.md)                    |
| Standard rooms                  | [Signaling liveness](design/signaling-liveness.md), [Standard-room PIN operations](../cloudflare/standard-room-pin-ops.md)                                                   |
| PRO rooms                       | [PRO architecture and operations](design/pro-room-architecture-and-operations.md), [server authority](design/pro-room-server-authority.md)                                   |
| Remote Share                    | [Remote Share operations](../cloudflare/remote-share-ops.md)                                                                                                                 |
| Developer API                   | [OpenAPI contract](../public/developers/openapi.yaml), [Cloudflare drift checks](../cloudflare/config-drift-ops.md)                                                          |

The six production Worker Wrangler configs and checked-in manifests remain the
decisive non-secret binding/schema inventories. Worker runtime secret-name
expectations are single-sourced in
[`cloudflare/ops-drift.contract.json`](../cloudflare/ops-drift.contract.json),
while workflow and operator credentials remain owned by their workflows and
runbooks. Neither belongs in a general setup document.

## Maintained engineering guides and contracts

- [Whole-project QA domains](qa-domains.md) — 30 domains and 122
  detailed scopes with criteria, source/test entry points, verification methods,
  and cross-feature sequences. This is a QA planning guide, not new pass evidence.
- [Playback state consumption](state-patterns.md)
- [AppState decomposition and surviving contract](appstate-decomposition.md)
- [System sync compensation](system-sync-compensation.md)
- [Repository-wide TypeScript migration](typescript-migration/README.md)
- [Translation guide](i18n-translation-guide.md)
- [Reusable migration audit prompt](migration-audit-prompt.md)
- [Developer API OpenAPI contract](../public/developers/openapi.yaml)
- [Font assets and verification](../fonts/README.md)
- [Public design-system guide](../public/designsystem/README.md)
- [Third-party runtime notices](../THIRD-PARTY-NOTICES.md)

## Maintained evidence and completed records

- [App 9.0.45 / v820 train: the media screens cover the Play pane to the bottom edge, and right-to-left placement of those screens and the chat drawer (2026-11-12)](design/app-9-0-45-train-2026-11-12.md):
  released on 2026-11-12 09:38 KST in Release 43128370307 (PR #588, squash `c4675c51`) as App 9.0.45 / v820 (App build
  820, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App Worker
  changed (`2af24151` to `1d5b0a8b`); the four smokes passed at the first try and the Drift Audit passed (32 pass, 0
  fail, 5 manual-only). Its post-merge Full E2E 43128771192 passed at the first attempt (`e2e` 1048 passed, this
  train's 18 rows of the two safe-area specs included; `webkit-mobile` 171 passed and 5 skipped plus the service
  worker test; the large-room R2 smoke passed). An App update after 9.0.44 / v819, on main `4ef7d422` (whose App
  runtime equals 9.0.44's `3dd9d05d`). Two fixes, both visible. The first repairs a defect that 9.0.44 introduced and
  the owner reported on 2026-11-12: in the sidebar layout the media source and YouTube address screens open over the
  Play pane but still ended at the home indicator, so once the Play pane reached the bottom edge its last row of
  actions showed in the strip below them (20 px on a 1024x768 tablet PWA). Both screens now reach the bottom edge and
  take the bottom inset as end padding; nothing inside them moves. The second is an older defect found while verifying
  the first: in right-to-left languages those two screens and the chat drawer sat 200 px to the right of the content
  pane, cut by the sidebar or covering it, because their base rules also set the right inset and a right-to-left page
  then drops `left`; `right: auto` puts all three over the content pane, and the media source screen's close button
  takes the options' inset on the side the direction puts it. Failing rows came first (12 of the 18 new rows on the
  production CSS), then seven CSS declarations. Against 9.0.44 in a real room (seventeen viewport cases, 242 scenes,
  every element with an id) only the fourteen intended scenes differ. An independent read-only review found no defect
  in the change and five further right-to-left candidates in other screens, which are not in this train. The four list
  panes still end at the home indicator in this train; after the deploy the owner decided that every screen of the
  landscape layouts reaches the bottom edge like the Play pane, which the next App update carries. Not verified on a
  physical device. Target `app`, one update dialog, floor 795 unchanged.
- [App 9.0.44 / v819 train: the sidebar-layout Play pane reaches the bottom edge, and the audio recovery owner's names (2026-11-11)](design/app-9-0-44-train-2026-11-11.md):
  released on 2026-11-11 19:55 KST in Release 43007375910 (PR #586, squash `3dd9d05d`) as App 9.0.44 / v819 (App build
  819, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App Worker
  changed (`ce3d671f` to `2af24151`); the four smokes passed at the first try and the Drift Audit passed (32 pass, 0
  fail, 5 manual-only). Its post-merge Full E2E 43007778625 passed at the first attempt (`e2e` 1030 passed, this
  train's four Play pane rows of the safe-area fixture spec included; `webkit-mobile` 165 passed and 5 skipped plus
  the service worker test; the large-room R2 smoke passed). An App update after 9.0.43 / v818 by the owner's
  decisions of 2026-11-11, on main
  `c4a3d6f0` (whose App runtime equals 9.0.43's `3b8ec6e3`). Two increments. The visible one: in the sidebar layout
  the Play pane alone reaches the bottom edge of the screen instead of ending at the home indicator, and its end
  padding grows by the same inset, so on a 1024x768 tablet PWA the last row of actions (Sync and Media) is no longer
  cut at the indicator while the composition, the scroll range and the end of the scroll stay where they were. The
  owner accepted that the row then overlaps the home indicator strip. The four list panes keep 9.0.43's contract. A
  failing real-room spec came first (five of six rows, and three of four new fixture rows), then one CSS rule. The
  other increment changes names only: the audio recovery owner's names say play request and playback scope (its own
  report is the next entry). Without a bottom inset every screen equals 9.0.43 (seventeen viewport cases, every
  element with an id, measured in a real room). Not verified on a physical iPad or iPhone. Target `app`, one update
  dialog, floor 795 unchanged.
- [Audio recovery owner names: the names increment of the App 9.0.44 train (2026-11-11)](design/audio-recovery-names-2026-11-11.md):
  carried by the App 9.0.44 train above, whose version bump follows these commits and whose report takes this one as
  that increment's section. It was prepared as draft PR #585 with no bump of its own: by the owner's decision of
  2026-11-11 it is not shipped alone. Names only, in the AudioContext recovery's one owner
  `src/audio/context-recovery.ts`: 50 of its 139 top-level names say play request and playback scope instead of the
  two former machines' words (the 61-character `getPendingForegroundAudioContextRestartClockHealthRequirement` is
  `getPlayRequestClockRequirement`), three names are merged into their one caller, and the play-request attempt's
  token keeps one name on the in-process `audio:output-recovery-needed` event outside the owner (four names, their
  own commit). The report holds the old name to new name table for the dated Phase 7 reports, why the 61-character
  function could not be merged and why the test seam keeps its seven members, and the evidence that only names
  changed: the whole unit suite test by test (18,843, none added, removed or changed), the audio recovery specs and
  the audio lab row for row, a bundle 149 B smaller, and a reverse map that leaves only the three merges. On main
  `c4a3d6f0`, after 9.0.43.
- [App 9.0.43 / v818 train: PWA safe-area layout consistency (2026-11-11)](design/safe-area-layout-consistency-2026-11-11.md):
  released on 2026-11-11 15:16 KST in Release 42971061565 (PR #583, squash `3b8ec6e3`) as App 9.0.43 / v818 (App build
  818, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App Worker
  changed (`45dade96` to `ce3d671f`); the four smokes passed at the first try and the Drift Audit passed (32 pass, 0
  fail, 5 manual-only). Its post-merge Full E2E 42971412278 passed at the first attempt (`e2e` 1026 passed, this
  train's two safe-area specs included; `webkit-mobile` 161 passed and 5 skipped plus the service worker test; the
  large-room R2 smoke passed). It shipped alone: the owner's wish of the same day to ship it in one update with the
  queued rename cleanup of the audio recovery owner reached the release after the deploy. An App update after 9.0.42 /
  v815 by the owner's decisions of 2026-11-11, on main
  `2d95d49e` (whose App runtime equals 9.0.42's `808d0d9d`), from PR #583. Two intended changes, both visible only
  where the browser reports safe-area insets (an installed iPad or iPhone PWA, a landscape phone with a cutout). The
  safe-area unification gives the header's logo, loading text and account button one clipped safe boundary while its
  background and progress fill still reach the screen edge, insets the compact layout's content pane, sidebar,
  media and YouTube overlays, the setup columns and the dialogs by the insets, converts the insets once in the scaled
  wide dashboard, separates physical left and right from inline start and end for right-to-left languages, keeps the
  chat header at the safe edge during an upward overshoot and moves the fullscreen video control inside the insets;
  the loading text keeps its directions and 1 s transition. The review then found that in a running room the four
  tab panes other than Play ignored the compact layout's fixed position, because the custom scrollbar pins an inline
  `position: relative` on a static parent and adopts those panes while they are hidden: with the new top inset they
  overflowed the page by 24 px on a tablet PWA and let the document scroll. A failing real-room spec first
  (`e2e/safe-area-runtime.test.ts`, Chromium's safe-area emulation, five of six rows failing), then one base rule
  positions every pane; the same fix ends an existing right-to-left defect where those panes sat under the sidebar.
  Without insets the left-to-right geometry equals production at eight viewport sizes (every element with an id,
  measured in a real room before and after). The epoch is v818 because the branch advanced it at each runtime
  commit; v816 and v817 were never released. Not verified on a physical iPad or iPhone. Target `app`, one update
  dialog, floor 795 unchanged.
- [App 9.0.42 / v815 train: the audio recovery's obvious defects fixed (2026-11-11)](design/app-9-0-42-train-2026-11-11.md):
  released on 2026-11-11 11:55 KST in Release 42948976516 (PR #581, squash `808d0d9d`) as App 9.0.42 / v815 (App build
  815, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App Worker
  changed (`a89ade21` to `45dade96`); the four smokes passed at the first try. Its post-merge Full E2E 42949289047 passed at the first attempt (`e2e` 970 passed, the repaired CI recovery
  spec row included; `webkit-mobile` 111 passed and 5 skipped plus the service worker test; the large-room R2 smoke
  passed), which closes the 9.0.41 open item on that spec, and the Drift Audit passed (32 pass, 0 fail, 5
  manual-only). The owner authorized
  all deploys on 2026-11-11 and withdrew the 2026-10-31 rule of dispatching update trains only while awake. A small
  App update after Phase 7 7C (9.0.41 / v814) by the owner's decisions of
  2026-11-09, 2026-11-10 and 2026-11-11, on main `7c9e4c1f` (whose App runtime equals 9.0.41's `91f6bb0c`). Four
  intended increments, each with its failing test first, a before/after table, its own section and a revert note,
  all in the one recovery owner `src/audio/context-recovery.ts`: a local file's clock-stall attempt whose own tap
  finds the clock still frozen is parked once more so the same dialog asks for one more tap (found item 1 of 7C); the
  restore tap retires a waiting non-file attempt first so it always realigns (found items 2 and 3, the Known gap 6
  edge 7C-K8 left); a stalled attempt parked already is not notified again, so the return's dialog no longer closes
  and reopens in Chromium (Known gap 3); and the dialog's ordinary branch waits up to its 5 s limit for its own
  resume still in flight after the 1 s wait, then realigns once with no new dialog (a guard for a case no device or
  browser run has shown, by the owner's choice). The CI recovery spec `e2e/demo-output-recovery.test.ts:191`, which
  failed in 9.0.41's post-merge Full E2E, is made robust: its triage found a guest room PLAY failing while the
  return's dialog was open and replacing it with the failed PLAY's dialog of the same text (11 of 20 runs under full
  CPU load; the tap's resume took 50 to 339 ms), which corrects the cause the 9.0.41 record had inferred. The
  lock-screen pause-and-play case and Known gap 6 are recorded only, and two tooling test rows get more time. Eager
  JavaScript grows by 45 B gzip (Phase 7 net 1,143 B of its 1,200 B limit); target `app`, one update dialog, floor
  795 unchanged.
- [Phase 7 train 7C: the AudioContext recovery behind one owner, and one restore tap that realigns the room (App 9.0.41 / v814, 2026-11-10)](design/phase7-7c-audio-recovery-owner-2026-11-10.md):
  released on 2026-11-11 01:14 KST in Release 42852117870 (PR #579, squash `91f6bb0c`) as App 9.0.41 / v814 (App
  build 814, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App
  Worker changed (`e61f7de9` to `a89ade21`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22
  versions, and the build floor stays 795. It is Phase 7's third and last App train, from branch `agent/p7-7c` (head
  `ff6cd456`, 53 commits) on main `f11a5cba` (#578, Phase 7 T2, tests only, whose App runtime equals 9.0.40's
  `b44cbbfb`). Five behaviour-neutral increments, each with its tests first, move the
  recovery protocol behind one owner, `src/audio/context-recovery.ts`: 7C-1 (I5) the playback scope's gesture
  recovery for the recovery dialog and the lock-screen PLAY; 7C-2 (I6) the recovery dialog's tap, its three branches
  and its 1 s and 5 s waits (`src/app.ts` keeps the iOS primer, the dialog slot, the follow-up queue, the retry, the
  settings and the realign; RO-51's early return and subscription are unchanged); 7C-3 (I7) a local-file PLAY's
  foreground clock check; 7C-4 (I9) the play-request restart, the suspend ledger, the `statechange` dispatcher and the
  recovery resume, moved byte for byte from `src/audio/context.ts` (1,473 to 238 lines), with one test seam that no
  production file imports (0 B); 7C-5 (I10) one attempt type for both recovery scopes, each keeping its own slot and
  generation, with one phase union, one retire by token and three neutral cuts. Across them every row of the
  owner-table unit files passes under the same title before and after (rows rewritten in place, renamed or
  re-described are listed apart and never counted as proof), and every Known gap row and the owner's two 2026-11-05
  keeps stay byte for byte. The one intended change, 7C-K8 (Known gap 8, C1-I6, the owner's decision of 2026-11-07):
  when a YouTube recovery attempt waits for a tap and the room switches to a local file, one tap of the file's
  recovery dialog used to wake the audio and end 'stopped'; it now also realigns the room once through the existing
  `playback:local-output-rejoin` request ('audio-recovery-gesture'). On a frozen clock the same dialog shows again,
  and when the state changes after the settle the tap still ends 'stopped' (a limit of the change). Its failing test
  (`6fc72489`) fails only the flipped row on its parent, its fix (`30d3393f`) changes the owner file only, and its
  five commits revert together (the report's §4.7 resolves the two conflicts with 7C-7 and lists the 7C-7 lines to
  edit; RO-37 stays deleted). 7C-7 records the end state: RO-01 `owner-in-place`, RO-37 deleted (the retry cancels
  inside the owner and the ordinary branch carries nothing), RO-36 unchanged after a re-check, RO-44 re-dated, the
  ownership decision record accepted, the guard self-test's block-order row made independent of RO-01's status, and
  two stale test comments rewritten in place. The bump `8cc49d34` changes the seven version lines of 9.0.40's bump
  and is the last runtime commit ('PASS: v814 (8cc49d34) covers all committed PWA runtime changes.'; 'MUSIXQUARE
  9.0.41; service-worker cache epoch v814'); only documentation follows it. Measured locally on the bump head: against
  the deployed SHAs (App `b44cbbfb`, PRO room `683074bc`, the other four `71f5b96c`) the App has 12 changed runtime
  paths (the eight runtime files and the four version mirrors), the other five Workers 0 and no runtime dependency
  change, so the local partial-release check is compatible for `app` and refuses `pro-room`; the eager first load is
  467,725 B of JavaScript (gzip), +117 B against a clean build of `f11a5cba`. The increments sum to +130 B (7C-1
  +174, 7C-2 -12, 7C-3 +36, 7C-4 +13, 7C-5 -55, 7C-K8 -26, 7C-7 0); the bump's -13 B is gzip noise (raw sizes equal)
  and, as in the earlier Phase reports, no increment, so Phase 7 stands at +1,098 B of the owner's +1,200 B, and the
  program net of Phases 0 to 7 is recorded as a note, not an owner decision. Earlier rounds ran after each of 7C-1
  to 7C-K8 the unit suite (the 7C-5 and 7C-K8 checks also had one and two tooling-row timeouts that passed alone),
  critical coverage, the guards, the CI recovery specs and the audio lab (25 rows from 7C-2), and three gates (the
  unit suite twice, `test:e2e:critical` 101 / 101, the demo spec 3 / 3, the lab three times), each followed by an
  independent review and its fixes; Chromium only (local WebKit has no AudioContext), no device. The final gate
  passed on 2026-11-10 on `7a1e98fb` (the bump and two documentation commits, the same runtime): the static checks,
  `build:checked` as one command with both lines above, every guard, the coverage lanes, the unit suite twice (786
  files, 18,833 passed, 1 skipped), `test:e2e:critical` 101 / 101, the demo spec 3 / 3, the lab three times, the
  candidate E2E 19 / 19 and the WebKit lane as advisory evidence (111 passed, 5 skipped), with the bundle and target
  `app` numbers unchanged; its independent review's fixes changed documentation only (the report's §15.11). The
  release round (the report's §15.12): PR CI 42848468504 passed all 11 jobs on `ff6cd456` and the automatic code
  review that opening the PR started ended with no findings; the merge `91f6bb0c` (01:00 KST) has the head's tree;
  exact-main CI 42850296813 passed all 11 jobs (its candidate job printed the same identity line and 'PASS: v814
  (91f6bb0c) covers all committed PWA runtime changes.', its critical browser gate 19 / 19 and 101 / 101); Release
  42852117870 passed its smokes on the first try (entry `main-Bdxv_hdi.js`, 860,084 B, the entry measured on the
  bump head); the release owner's public reads showed the floor 795 with live App 814 and the home page at bootstrap
  v814, and no one looked at production in a browser or on a device. Drift Audit 42852720012 failed its first attempt
  on one read that timed out (the demo-tracks bucket's R2 CORS; 31 pass, 0 fail, 1 error, 5 manual-only, no drift row)
  and passed on the rerun (32 pass / 0 fail / 5 manual-only, counted from the log's table). The post-merge Full E2E
  42852713897 on `91f6bb0c` failed its first attempt on one row of a CI recovery spec the train did not change
  (`e2e/demo-output-recovery.test.ts:191`, at its line 213: no `playback:local-output-rejoin` within 15 s after the
  tap on the recovery dialog; `e2e` 969 passed and 1 failed, `webkit-mobile` 111 passed and 5 skipped plus the
  service worker test, and the large-room R2 smoke passed), and the rerun of the failed job passed (`e2e` 970
  passed). Triage on a work computer ran that one row twenty times per SHA: with the machine idle, 20 of 20 on
  `91f6bb0c` and on the pre-merge main `f11a5cba`; with every CPU thread kept busy, 12 passed and 8 failed on each,
  all at line 213. So the failure is inherited and depends on load. This entry first gave its cause as the tap's
  native resume landing after the dialog's 1 s wait; that was inferred from the end state and one log line, with no
  resume time measured. The 9.0.42 train's triage corrected it: in all 11 failures of 20 runs under the same load a
  guest room PLAY failed while the return's recovery dialog was open (its resume still refused) and replaced that
  dialog with the failed PLAY's, which has the same text; the tap then retried that PLAY (a retry publishes no
  rejoin) or a newer room PLAY started the track first. The sound came back every time, and the tap's resume took
  50 to 339 ms. It was an open item in the release record's 9.0.41 section; by the owner's decision of 2026-11-11,
  App 9.0.42 made the spec robust and also guarded the unobserved late-resume case, and 9.0.42's record closed the
  item after its post-merge Full E2E 42949289047 passed the row. A failing CI recovery spec holds the next App train even when
  inherited, so that train merges only after this record has merged and carries the fix or records the owner's other
  decision. The owner's device rows (D10 to D14) and the 7C-K8 scene on a phone wait; they are not a gate. The
  release record's §2 carries the train as post-deploy items, its §4 the 9.0.41 entry and current boundary line (5),
  and the hotfix procedure's 9.0.25 bullet names 9.0.41's merge SHA, Release ID and App version. The open items
  8.11.12 and 8.11.7 link this report and stay open. The default rollback is a forward revert at 9.0.46 / v821 or the
  next free number; 7C reverted alone until another App train stacked on it, and 9.0.42 did on 2026-11-11 (it changes
  the same owner file), so 7C now reverts forward together with 9.0.42's changes; its merge ended 9.0.40's standalone revert
  window (9.0.40's patches still reverse cleanly on 9.0.41), and 7B now reverts only forward with it. Phase 7's end
  condition 7 counts 14 days without a new field report from this deploy, to 2026-11-25 01:14 KST. Known gap 3 and
  three fixable items found in the build go to the next App update (9.0.42 / v815 expected), as the owner decided on
  2026-11-09 and 2026-11-10. Not verified: real devices, Safari and WebKit audio paths, the update dialog and anything
  else in a production browser.
- [App 9.0.40 / v813 train: Korean text on the public pages at tracking 0, and the demo step label easing into its size and weight (2026-11-06)](design/app-9-0-40-train-2026-11-06.md):
  released on 2026-11-06 14:53 KST in Release 42170829938 (PR #576, squash `b44cbbfb`) as App 9.0.40 / v813 (App
  build 813, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App
  Worker changed (`4cf5e560` to `e61f7de9`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22
  versions, and the build floor stays 795. The one App update carries two parts on branch `agent/ko-tracking`
  (head `28904b5b`), on main `8b48869b` (App 9.0.39 / v812's release record, after 9.0.39's post-merge
  Full E2E passed): on 2026-11-06 the owner asked for the Korean large headings on the public pages at tracking 0
  and chose the demo label's 'D, smooth', and the release owner set the wider scope of part (1). (1) Every element
  on a public page whose text holds Hangul is drawn at letter-spacing 0, like the app, which has no negative
  tracking on Korean (its Hangul face has no optical size axis): `letter-spacing: 0` in About's existing
  `:lang(ko)` heading rules (the headline keeps its optical `margin-left: -0.03em`), a new `:lang(ko)` rule for
  About's chat bubbles (the YouTube bubble's Latin title and the chat timestamp, which now declares its own
  -0.01em, keep their tracking), and 0 in the events page's shared title rule (that page is always Korean). Text
  without Hangul (digits-only times, the Latin brand word, code) keeps its tracking in every language, so the same
  digits look the same on the Korean and English pages; every other language renders pixel for pixel as before.
  The public-page font guard now lets a `:lang(ko)` copy rule set tracking to exactly 0 and still rejects any
  other one-language tracking (the 9.0.36 rule, relaxed only that far), and a static test requires each Korean
  tracking rule to be the 0 copy of a listed negative tracking. On the events page the notice title takes two
  lines on a 390 px phone and the redeem title breaks at another word; About keeps its line breaks. The service
  check page owes nothing: its tightened headline is the English sentence in every language. Tests first: a new
  E2E spec (in Full E2E) fails if any Hangul text on a public page in a Korean browser has negative tracking, and
  a static inventory lists every negative tracking in the served sheets as kept or drawn at 0 in Korean. (2) The
  owner's 'D, smooth' from frame pictures of today and three options: as a demo step dot opens, the hidden label
  waits at the dot number's 14 px, unselected weight and line box and eases into the pill's size, the selected
  weight and the button's line box while it unrolls (0.24 s), and a folding label eases back as it fades; the
  press frame now equals the dot in size, weight and place (today +20 % stroke on phones, +34 % at 1440 px), the
  largest one-frame step is +4.3 % on phones and +5.7 % at 1440 px, and the steady row and the dots are
  pixel-identical to 9.0.39; reduced
  motion snaps. Its two commits were cherry-picked unchanged (equal patch-ids), followed by a tests-only commit
  that rewords the button label contract's demo reason. Round 2 judged the deploy target against the deployed
  SHAs (App 8 runtime paths, the other five Workers 0, no runtime dependency change; the local partial-release
  check compatible) and reran the unit half of both tests-first pairs (each fails on its parent and passes at its
  code). Round 3 ran the full local gate on the bump head; in WebKit outside the lane the new spec's
  optical-margin check met WebKit's 1/64 px layout unit, so a tests-only commit compares within one unit (35 / 35
  in Chromium and WebKit), while the demo specs cannot create a room in this PC's WebKit, which is why the lane
  leaves them out. An independent review then found that the press frame drew the number 1 CSS px above the dot
  at 320, 430, 1000 and 1280 px (the label kept the button's taller line box; round 3 had not measured vertical
  place). Round 4 applied the review's fixes: a tests-first pair puts the waiting label on the dot number's line
  box (`1b02a48c` -> `39f08cbe`), a tests-only commit pins Korean tracking to the 0 copies of listed negative
  tracking (`8471495c`), the WebKit tests-only commit moved before the bump (`7eb697df`), and the bump was rebuilt
  as the last runtime commit (`c1763d98`, the seven version lines of 9.0.39's bump; only documentation follows).
  Round 4 ran the full local gate again on that head with no failure: typecheck, lint, format,
  `build:checked` and all 37 guards one by one, the ownership guard, the full unit suite once (779 / 779 files,
  18,759 rows, the git-fixture row that timed out under load in round 3 included), 329 Chromium E2E rows (the
  production candidate, the public font specs, critical, the public page and font specs with the new spec, the
  demo specs), the WebKit lane (111 passed, 5 skipped by design) and the public specs in WebKit outside the lane
  (138 / 138); the demo specs did not run in WebKit (this PC's WebKit cannot create a room; not a pass). The demo
  frame check, now measuring vertical place, put the press frame equal to the dot in all nine scenes (Korean,
  English, Malayalam and Arabic, 320 to 1440 px) and the steady rows 0 px different from `8b48869b` and round 3's
  builds; in the first unroll frames the line box briefly clips the lowest marks of Hindi (frames 4-8),
  Vietnamese and Arabic (frame 4), which 9.0.39 does not clip, while Thai, already clipped in 9.0.39, is about the
  same (at 1x it looks the same as 9.0.39, and in motion it lasts 1-5 frames while the label unrolls). Against
  a clean build of `8b48869b` the eager first load is 1 B smaller in JavaScript and 79 B larger in all (gzip, the
  main CSS), and the deploy judgement is unchanged (App 8 runtime paths, the other five Workers 0, compatible). Each part alone reverses cleanly at the final head (part (1) with its two tests-only commits, part
  (2) with five commits), and 9.0.39's step-button runtime patches (`8fb3d9f5`, `8afced6c`) reverse after part (2);
  its test patch `ed50bc88` also needs `019091c7`'s row reversed, as 9.0.39's own rollback item says. A final
  independent verification then approved the code and its document findings were fixed. Phase 7 7C becomes a
  later App update. Round 5 records the release. PR CI 42168854190 passed on `28904b5b` and the automated review
  that opening the PR started ended with no findings; the merge `b44cbbfb` (14:41 KST) used the prepared squash body
  and its tree equals the head's; exact-main CI 42169887351 passed all 11 jobs, and the release script's log shows
  no watch error and it dispatched without a hand step; Release 42170829938 passed its smokes on the first try
  (entry `main-DO022wYO.js`, 862,659 B, the same byte count as 9.0.39's); the release owner's public reads showed
  v813, and a desktop Chromium look at `/ko/about` first got the old public CSS from the previous service worker
  (headings still tightened) and, after one reload, the three Korean headings at letter-spacing 0 with the
  digits-only time kept at -0.8 px, while `/en/about` kept its tracking; and Drift Audit 42171105068 passed (32 pass
  / 0 fail / 5 manual-only, counted from the log's table). The post-merge Full E2E 42171101581 on `b44cbbfb` passed
  on its first attempt: `e2e` 970 passed on Linux Chromium (the new `public-korean-tracking` spec's 35 rows on Linux
  for the first time, and the demo and public page specs over the new CSS), `webkit-mobile` 111 passed and 5
  skipped plus the service worker test, and the large-room R2 smoke; that first attempt also passed the chat row
  that timed out in 9.0.39's attempt 1, which closes that open item. That meets this train's part of the condition
  for the next App train, which merges once this record has merged. Phase 7 T2 (tests only, no App update) merged on
  2026-11-07 (#578), and the next App update, the 9.0.41 / v814 train with 7C, shipped on 2026-11-11 01:14 KST (above). The owner's device checks (the
  public pages on iPhone Safari and a desktop browser, the events page on a 390 px phone, the demo step buttons at
  320 px in Korean, Malayalam and a right-to-left locale, once on iPhone Safari) wait. The release record's §2
  carries the train as post-deploy items, its §4 the 9.0.40 entry and current boundary line (5), and the hotfix
  procedure's 9.0.25 bullet names 9.0.40's merge SHA, Release ID and App version. This train's merge ended 9.0.39's
  standalone revert window; 9.0.39's step-button runtime patches now reverse only after part (2), and its test patch
  `ed50bc88` also needs `019091c7`'s row reversed. The default rollback is a forward revert at 9.0.46 / v821 or the
  next free number now that 9.0.41 shipped (its merge also ended this train's standalone revert window; this train's
  patches still reverse cleanly on 9.0.41). Not verified: real devices, Safari, the opening step's frames in WebKit, and the events page
  and chat bubbles in production.
- [App 9.0.39 / v812 train: Phase 7 7B, every digit tabular and the demo step buttons (2026-11-05)](design/app-9-0-39-train-2026-11-05.md):
  released on 2026-11-05 21:22 KST in Release 42026274351 (PR #574, squash `5b3cfcb0`) as App 9.0.39 / v812 (App
  build 812, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App
  Worker changed (`984397d9` to `4cf5e560`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22
  versions, and the build floor stays 795. By the owner's decisions of 2026-11-05 the one App update carries three
  parts on branch `agent/app-9-0-39` (head `f77ff953`): the twenty Phase 7 7B commits and the seven commits of
  the digits and demo step buttons, cherry-picked unchanged onto main `51fc6fc7` (App 9.0.38 / v811's release
  record, after 9.0.38's post-merge Full E2E passed), the bump `f47ffb63` (9.0.39 / v812, the seven version lines
  of 9.0.38's bump, the last runtime commit), a tests-only commit and documentation commits. (1) Phase 7 7B, the audio recovery
  behaviour, as its own report below records; the owner kept the two changes its approved pictures did not show
  (a return dialog tapped while the audio wakes later than 0.75 s is not shown again; with UI sounds on, the press
  on an interruption dialog stays silent while the audio restarts, the play dialog's rule). (2) Every digit 0 to 9
  in the app takes one width: the app's Inter latin face, the only app face with digits, maps U+0030 to U+0039 in
  its cmap to Inter's own tabular glyphs (`zero.tf` to `nine.tf`), so the digits stay in one font run with the
  letters and Inter keeps its raised colon, case forms and `3×4`; only digit advances and the kerning next to a
  digit change (the reverb's `0.1s` gains about 1.2 px after the dot; three-digit numbers in the YouTube
  playlist's 20 px number box overflow by 0.78 px where some already overflowed by up to 1.70 px), and the
  public pages, which share the face, follow. A first proposal with a separate digits-only face was rejected
  from pictures: it lowered the colon and the case forms, lost `3×4` and could swap late on first open. (3) The
  current demo step's hidden number folds its width away, so the label sits exactly at the pill's centre and
  gains about 5.6 px at 320 px wide (Malayalam's step 1, cut off by the tabular '1' alone, fits again with 8 px
  to spare), growing back only after the old label has faded; and as a dot opens, its number becomes the label's
  own at once and the label unrolls, so the number never shows twice. Four demo step labels in the chip width
  guard's accepted list now fit with 4 px to spare and leave it. Round 1 moved the commits with only two
  `docs/README.md` conflicts (both entries kept), 25 of 27 patch-ids equal and every other file byte-identical
  to the two branches. Round 2 bumped, judged the deploy target against the deployed SHAs (App 14 runtime paths,
  the other five Workers 0, no runtime dependency change; the local partial-release check compatible), reran the
  unit half of every tests-first pair on the moved commits (each fails on its parent with the same failing rows
  and passes at its code), checked that each part alone reverses cleanly, and ran the ownership guard (50
  records, native resume and suspend 9). Round 3 reran 7B's comparison scenes after the review fix on the bump
  head's E2E build (74 rows, twice: every behaviour row as approved; only timing numbers differ, as this PC's audio
  wakes about 0.05 s sooner, and one unexplained pause in 1 of 15 runs of the locked-screen case the owner left
  unchanged) and retook the digits and demo step button captures (pixel for pixel the approved pictures). Round 4
  ran the full local gate on the record commit `a892821e` (code `f47ffb63`) with no failure: typecheck, lint,
  format, `build:checked` and all 37 guards one by one, the ownership guard, the font generators' checks, both
  coverage configs, the full unit suite twice (778 files, 18,750 passed each time), 332 Chromium E2E rows (the
  production candidate, the public font specs, critical, the CI recovery specs, the audio lab three times, the
  demo, font and public page specs), the WebKit lane (111 passed, 5 skipped by design), the deploy target (App
  14, the other five Workers 0) and the local partial-release check with the deployed SHAs (compatible); against
  a clean build of `51fc6fc7` the eager first load is 272 B larger in JavaScript and 320 B larger in all (gzip).
  Round 5 applied an independent review of the prepared branch (one medium finding, the rest low): a tests-only commit after the
  bump pins that every locale's three demo step labels start with their own step number, which the fold and the
  opening handoff rely on (126 / 126; dropping one locale's number fails it); with the digits part reversed alone
  in the work tree the demo step fold's unit tests still pass (57 / 57); and the report and record now link the
  9.0.39 report from the two changed 9.0.38 items, count the added 7B-6 rejoin in the mixed-version note, name the
  first round's tested SHA, read the one unexplained locked-screen pause as a Media Session PAUSE the browser sent
  (an inference from the trace; 7B does not change that handler) and add a right-to-left locale to the device
  checks. Round 6 records the release. PR CI 42023288690 passed on `f77ff953` and the automated review that opening
  the PR started ended with no findings; the merge `5b3cfcb0` (21:08 KST, after the owner asked that afternoon to
  assemble and ship the train and then pause the project work until next week) used the prepared squash body and
  its tree equals the head's; exact-main CI 42024586528 passed all 11 jobs, and the release script's log shows no
  watch error and it dispatched without a hand step; Release 42026274351 passed its smokes on the first try (entry
  `main-BdGnhxbL.js`, 862,659 B, as round 4 measured); the release owner's public reads showed v812 (the saved
  service worker line reads `CACHE_VERSION = "v812"`), and a desktop Chromium look showed the start screen on v812
  with the new Inter latin face served (`inter-latin-CabVWX-n.woff2`) and each digit 0 to 9 measuring 62.65 px at
  100 px weight 500 (one width); and Drift Audit 42026754870 passed (all 32 distinct rows in the evidence PASS). The
  post-merge Full E2E 42026749799 on `5b3cfcb0` failed on attempt 1: one `e2e` row outside the train
  (`e2e/chat-commands.test.ts:541`, '/freeze + late-join guest cannot chat') timed out waiting 15 s for the
  late-joining guest's frozen chat state, with 934 passed, while `webkit-mobile` (111 passed and 5 skipped plus the
  service worker test) and the large-room R2 smoke passed. The release owner reran that test 8 times and the whole
  spec 3 times locally on the train's e2e build, all passing, and it had not failed in four earlier failed Full E2E
  runs, so the record reads it as a timing flake, not a train regression (an inference: the train's changed lines
  touch no chat command, freeze or late-join code, and no chat file changed). Attempt 2, a rerun of the failed job
  only, passed (`e2e` 935 passed, 2026-11-06 00:16 KST); that rerun is this train's post-merge Full E2E. Attempt 1's
  `e2e` job ran the changed `font-baked-pixels` and the demo specs over the new face and CSS on Linux Chromium for
  the first time (its log shows them among the passing rows), and attempt 2 passed all 935 rows (its log is not in
  the evidence). The record keeps the attempt 1 failure as its own open item, closed when a later Full E2E's first
  attempt does not fail that row or a tests-only fix lands; 9.0.40's post-merge Full E2E 42171101581 passed that row on
  its first attempt, which closed the item (the 9.0.40 record). That meets this train's part of the condition for the
  next App train, which merges once this record has merged. The owner paused the project work
  until next week after this record, then asked on 2026-11-06 for the next App update, the 9.0.40 / v813 train
  (Korean text on the public pages at tracking 0 and the demo step label, released on 2026-11-06 14:53 KST,
  above); Phase 7 T2 (tests only, no App update) merged on 2026-11-07 (#578), and 7C shipped as the 9.0.41 / v814
  train on 2026-11-11 01:14 KST (above). The owner's device checks (7B's later set, the
  digits, the demo step buttons in Korean, Malayalam and a right-to-left locale, the same on iPhone Safari) wait.
  The release record's §2 carries the train as post-deploy items, its §4 the 9.0.39 entry and current boundary line
  (5), and the hotfix procedure's 9.0.25 bullet names 9.0.39's merge SHA, Release ID and App version. This train's
  merge ended 9.0.38's standalone revert window and the path that reverses 7A's patches alone; the default rollback
  is a forward revert at 9.0.46 / v821 or the next free number now that 9.0.40 to 9.0.45 shipped (9.0.40's merge also
  ended this train's standalone revert window); T2's merge on 2026-11-07 ended 7B's standalone revert window, and since
  7C (the 9.0.41 / v814 train, above) merged on 2026-11-11, 7B reverts only forward together with it.
  Not verified: real devices, WebKit for 7B (local WebKit has no AudioContext), Safari's drawing of the new cmap,
  and the opening step's first frames in WebKit or in right-to-left locales; Linux saw only the PR and exact-main CI
  gates and the post-merge Full E2E.
- [Phase 7 train 7B: the audio recovery behaviour the owner approved (2026-11-05)](design/phase7-7b-audio-recovery-behaviour-2026-11-05.md):
  released on 2026-11-05 21:22 KST in the App 9.0.39 / v812 train above (Release 42026274351, PR #574, squash
  `5b3cfcb0`), which moved its commits onto main `51fc6fc7`, bumped and recorded it. The second of the three Phase 7
  App updates (owner decision Q2), shipped as App 9.0.39 / v812 after the owner's UI tidy (9.0.38 / v811). Built on branch
  `agent/p7-7b` on main `3506dc41` (App 9.0.37 / v810's release record; its App runtime is
  production 9.0.37's `d1665230`) without a bump or a release record entry: by the owner's
  decision of 2026-11-04 (evening) it was built beside 9.0.38 and merges only after 9.0.38 is
  deployed and recorded and its post-merge Full E2E passes, when a later step moves it onto that
  main, bumps it and records it. Five intended increments, each with its failing test first,
  approved by the owner from pictures before the build (2026-11-04 early morning): 7B-2 (Q8)
  parks the play-request attempt again when something wakes the audio while its recovery dialog
  waits, so one tap plays (a tap inside that short re-park closes the dialog and the same dialog
  shows once more); 7B-3 (Q9, one unit with 7B-2) makes UI sounds ask the recovery owners first
  and stay silent, waking nothing, while one holds the context for a local file's dialog; 7B-4
  (Q6) gives each AudioContext one suspend lease and one `statechange` dispatcher in a fixed
  order, so the return check's second suspend comes after the late fence (about 1.0 s instead of
  0.75 s, the give-up at 1.75 s) and two overlapping recoveries make one suspend and one dialog
  request, the later one's; 7B-5 (Q7) gives both owners one recovery resume and lets the dialog
  wait on the owner's answer instead of a 50 ms poll, which also closes the I11/I12 known gaps (a
  return-dialog tap or lock-screen PLAY whose audio wakes after 0.75 s with its running event
  first now gets one clock check and one alignment, not a second dialog); 7B-6 (Q12, shipped in
  this train instead of its own fix train by the owner's answer) lets one lock-screen PLAY after a
  local pause rejoin the room while an interruption is pending. The case found while preparing 7B
  (screen locked, no call: the room realigns at once but the sound returns only when the app is
  opened) is pinned as a known gap and not changed, by the owner's decision. Compared with the
  approved pictures in local Chromium on the head, every row matches; four small timing
  differences and two changes the pictures did not show were listed for the owner before merge,
  and the owner kept both on 2026-11-05 (the 9.0.39 train above).
  An independent review of the head found a 7B-2 and 7B-3 regression, fixed failing test first
  within that unit: a play-request attempt whose one notice never became a dialog (the page was
  hidden, the PLAY was replaced, a forced update was pending) was parked again on every outside
  resume and kept UI sounds silent, so no later PLAY played until a reload; now only an attempt a
  dialog has taken is parked again or holds the context, and the next PLAY plays as before 7B.
  The native resume and suspend count fell from 11 to 9 and the `restartAudioContextFromGesture`
  callers from 2 to 1 because those calls moved behind the recovery resume and the suspend ledger
  in `context.ts`, not because a requester went; the review fixes pin the callers of those
  wrappers too (`requestAudioContextResume` 2, `requestRetiredAudioContextSuspendCleanup` 4,
  `requestAudioContextSuspend` 4). No new bus event (202 / 202), dead exports 20 / 75, the
  contract freeze diff is empty and the build floor stays 795. First load: eager JavaScript
  +258 B gzip against `3506dc41` (467,353 to 467,611 B); Phase 7 stands at +968 B against the
  +200 B Phase net judged after 7C. Local evidence only: after every increment the unit suite (773
  files), critical coverage, the guards, the audio lab three times (17 rows, 18 from 7B-4, 19 with
  the review) and the CI recovery specs; Chromium only (local WebKit has no AudioContext), no
  device. `guard:sw-cache-version` fails until the bump, by design. The full local gate before the
  bump is recorded (QA rounds 9 and 10, the second after the review fixes); the 9.0.39 train reran
  the comparison scenes after the review fixes and ran the bump head's full local gate (its QA rounds 3 and 4), and
  its post-merge Full E2E passed on the rerun of its one failed job, a chat row outside 7B (its round 6; the audio lab
  is outside CI). The device checks and the four open items linked to this report stay open; T2's merge on 2026-11-07
  ended 7B's standalone revert window, and since 7C (the 9.0.41 / v814 train, above) merged on 2026-11-11, 7B reverts
  only forward together with it.
- [App 9.0.38 / v811 train: the owner's UI tidy, the demo text sizes, the chat '#1', unused rules, the /debug COPY button and the phone start-screen scrollbar (2026-11-04)](design/app-9-0-38-train-2026-11-04.md):
  released on 2026-11-05 06:14 KST in Release 41913839299 (PR #572, squash `9e62c26c`) as App 9.0.38 / v811 (App build
  811, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App Worker
  changed (`80534771` to `984397d9`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22 versions,
  and the build floor stays 795. By the owner's decisions of 2026-11-04 (afternoon and evening) one App
  update (one update dialog, target `app`) carries five parts on branch `agent/app-next` (pushed as
  `agent/app-9-0-38`, head `6f15af85`): twenty-two commits
  (ten tests-first pairs, one tests-only and one comments-only commit) built and tested on `d1665230` and
  moved without conflict onto main `3506dc41` (App 9.0.37 / v810's release record), the bump `74b2cec7`
  (9.0.38 / v811, the seven version lines of 9.0.37's bump, the last runtime commit) and documentation
  commits. (1) From 720 px wide the demo tour's step title, step copy and track names take the sizes of the
  app's text in the same role (the start carousel's title and description, the playlist's track name), and its
  role switch takes `clamp(12px, 1vw, 14px)`; under the 4 px rule of 2026-10-29 the switch's icon threshold
  comes down from a 448 px to a 440 px container, so the icon newly shows in two-column windows 1101 to 1120
  px wide and phone-layout windows 525 to 532 px wide. The phone demo is byte-identical. (2) The chat join
  order '#1' is 9 px instead of 0.8em (8.8 px). (3) Two half-pixel start-screen text rules that drew nothing
  and the two `--setup-guide-desc` declarations nothing read are removed; the start carousel is
  byte-identical. (4) The `/debug` text overlays get a COPY button that copies the text on screen inside the
  tap (the Clipboard API first, a hidden textarea where it is missing or refused) and then reads COPIED; from
  720 px wide it is a 350 px button in the middle. It is the candidate fix for the release record's iPhone
  `/debug console` copy item. (5) Under 720 px wide the start screen's step areas and actions bar span the
  screen with the 56 px side spacing moved inside them, so the scrollbar sits at the screen edge instead of 30
  px in while no text or button moves; 720 px and wider is unchanged. The owner cancelled the broad 13-step
  type scale; only fixed decimal sizes are tidied. Deploy target `app`: 8 App runtime paths against production
  `d1665230` at the bump head (4 before it), the other five Workers 0, no runtime dependency change; the build
  floor stays 795. Round 1 moved the branch with every patch-id equal and the whole-train diff byte-identical.
  Round 2 bumped, judged the deploy target, checked that each part alone reverses cleanly, reran the unit half
  of every tests-first pair on the moved commits (each fails on its parent and passes at its code, with the
  same counts as before the move) and retook the pictures on the bump head's E2E build: the demo, chat and
  start carousel captures (34) are byte-identical to the pictures sent to the owner; the 24 start-screen
  scrollbar captures equal the pair's and the proposal's captures (12 of them are the pictures on the sheets the
  owner approved, the six views at rest at 390 × 600 and 320 × 568 come from the same proposal run but were not
  on the sheets, and the six 667 × 375 ones, which the owner did not see, equal the proposal's prototype
  captures); and the `/debug` COPY row is pixel-identical. Round 3 ran the full local gate on the
  documentation commit `37e2deef` after the bump (code `74b2cec7`): typecheck, lint, format, `build:checked` and all 37 guards
  one by one, both coverage configs, the full unit suite twice (777 files, 18,693 passed and 1 skipped each time), 202 E2E rows in
  29 file runs (critical, the demo, chat, `/debug` and setup specs, the production candidate) and the local partial-release check
  with the deployed SHAs (compatible); against a clean build of `3506dc41` the eager first load is 16 B smaller in JavaScript and
  60 B smaller in all (gzip), with the main CSS 195 B larger raw. Round 4 applied a two-lens review to the
  documents only (the code is still `74b2cec7`): the start-screen picture counts above, the 9.0.33 record
  sentence on the 14.5 px CJK case that this train removes, the tested heads of the sub-rounds before the move,
  the phone COPY that fills its row, and this entry's status in the deploy record's list.
  Round 5 records the release. PR CI 41875032861 passed on `6f15af85` and the automated review that opening the PR
  started ended with no findings; the merge `9e62c26c` (05:59 KST, after the owner asked to ship) used the prepared
  squash body and its tree equals the head's; exact-main CI 41911833807 passed all 11 jobs, and the release script's
  log shows no watch error and it dispatched without a hand step; Release 41913839299 passed its smokes on the first
  try (entry `main-Dri10Cxi.js`, 862,074 B, the same size as 9.0.37's, as round 3 measured); the release owner's
  public reads showed v811 (the saved service worker line reads `CACHE_VERSION = "v811"`), and a desktop Chromium
  look emulating a 375 × 812 phone showed the start screen's scroll area spanning the screen with the 56 px spacing
  inside and the usual update dialog over it; Drift Audit 41914320320 passed (the eight rows in the evidence all
  PASS); and the post-merge Full E2E 41914313865 on `9e62c26c` passed at 07:37 KST (`e2e` 935 passed,
  `webkit-mobile` 111 passed and 5 skipped plus the service worker test, the large-room R2 smoke), 8 rows more in
  both jobs than 9.0.37's, the sum of the two new specs' rows, so read as their first Linux Chromium and WebKit
  run (per-spec counts are not in the release evidence). That meets this train's part of the condition for the next
  App update, Phase 7 7B (9.0.39 / v812 planned, being built), to merge once this record has merged; the owner's
  all-digits tabular decision of 2026-11-05 (pictures first) is a later App update (both shipped, with the demo
  step buttons, in the 9.0.39 train above on 2026-11-05 21:22 KST). The owner's device checks
  (the wide demo, the chat '#1', the iPhone COPY with the keyboard up, the short-phone scroll) wait, as does the
  scrollbar in a short window in production. The release record's §2 carries the train as post-deploy items, its
  §4 the 9.0.38 entry and current boundary line (5), and the hotfix procedure's 9.0.25 bullet names 9.0.38's merge
  SHA, Release ID and App version. This train's merge ended 9.0.37's standalone revert window, and the 9.0.39
  train's merge (2026-11-05 21:08 KST) ended this train's; the default rollback is a forward revert at 9.0.42 / v815
  or the next free number now that 9.0.39 to 9.0.45 shipped.
  Not verified: real devices (the iPhone COPY with the keyboard up, touch scrolling from the side
  margins), and WebKit beyond the Playwright lanes (local, and Linux in the post-merge Full E2E, where the
  two new specs' first Linux run is read from the row counts).
- [App 9.0.37 / v810 train: Phase 7 7A, the iPhone guest YouTube return and the input design system (2026-11-04)](design/app-9-0-37-train-2026-11-04.md):
  released on 2026-11-04 13:51 KST in Release 41775435927 (PR #570, squash `d1665230`) as App 9.0.37 / v810 (App build
  810, target `app`, one update dialog); `raise_app_build_floor` false, Developer API D1 false. Only the App Worker
  changed (`385d84fe` to `80534771`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22 versions,
  and the build floor stays 795. By the owner's decision of 2026-11-04 (early morning) one App update carries three
  increments on branch `agent/app-9-0-37`:
  Phase 7 T1 (`agent/p7-t1`, tests, guards and docs only, its own release-free pull request first,
  tip `1441742e`) rebuilt on main `34dbe592` (App 9.0.36 / v809's release record), then the sixteen
  7A commits, the four iPhone fix commits and the twenty-three input system commits cherry-picked in
  that order (seven conflicts, all in documents and the design page HTML; every code and test patch
  unchanged), the bump `51be7509` (9.0.37 / v810, the seven version lines of 9.0.36's bump, the last
  runtime commit) and documentation commits. 7A (its report below) adds the owner-approved AUDIO
  RECOVERY lines to `/debug sync` and four neutral cleanups. The iPhone fix (its report below) lets
  an iPhone or iPad Standard guest that returns at the moment iOS stops the hidden YouTube iframe
  play again without a tap; the owner kept its trade-off (a pause tapped within 1 s of the return,
  without focus in the iframe, is aligned over). The input design system, approved from pictures on
  2026-11-03 and recorded only in this report, makes every text field one underline family in three
  size steps with one 12px line under it, turns the underline red (and sets `aria-invalid`) only for
  a wrong value while connection and service failures paint only the line, shows a refused password
  or a taken nickname as a red line under the field, labels the YouTube sheet's big button Search
  while a query is typed, ends the under-field copy without a full stop with one sentence per line
  in 42 languages (586 strings, the PRO room-full detail trimmed) and adds the design system's Input
  fields card. Deploy target `app`: 74 App runtime paths against production `6f9cf6f8` at the bump
  head, the other five Workers 0, no runtime dependency change; the build floor stays 795 and the
  only storage change is 7A's sessionStorage key. Round 1 moved the increments and reran the unit
  half of every tests-first pair and the E2E halves of I1 and the iPhone fix (each fails on its
  parent and passes at its code, but for 7A-6's neutral pin, as recorded), the 7A audio lab
  (17 / 17 on three trees with equal observations) and recovery specs, the iPhone spec (13 / 13)
  and the input specs. Round 2 bumped, judged the deploy target and recaptured the 139 approved input states on the
  bump head's build: 134 pixel-identical, the same five expected differences (the room-full trim and
  the host code kept at 32px), all controls identical. Not verified: real devices, Linux and WebKit,
  native readers for the 40 trimmed room-full copies outside ko and en, and Tamil's password refusal,
  which wraps at 320 px. Round 3 ran the full local gate on the bump head `631bff86` (code
  `51be7509`): typecheck, lint, format, `build:checked` and all 37 guards one by one, both coverage
  configs, the full unit suite twice (one git-fixture row over its own 30 s cap under load in the
  second run; that file alone passes twice), 433 E2E rows in 49 files (critical, the YouTube specs,
  7A's recovery specs and audio lab, the input system's setup, dialog, contrast, design page, chat
  and playlist groups, the production candidate) and the local partial-release check (compatible);
  against a clean build of `34dbe592` the eager first load grows by 1,500 B of JavaScript and
  1,875 B in all (gzip). Round 4 applied a three-lens review to the documents only: 7A's remaining
  reads before merge are merge conditions in one place (the `player.ts` gate-handler re-read done),
  the move onto T1's squash names T1's tip SHA, and the release record gains an open item for the
  new lock-screen case found while preparing 7B (record only, by the owner's decision).
  Round 5 records the release. T1 merged first as #569 (`2c6544ff`, 13:22 KST, its tree equal to `1441742e`), so the
  train's 47 commits moved onto it with the head tree byte-identical to the gated one and docs commit `87abe5e7` rewrote the
  cited SHAs; PR CI 41772916970 passed on `87abe5e7` and the automated review ended with no findings; the merge `d1665230`
  (13:36 KST) used the prepared squash body; exact-main CI 41774236913 passed all 11 jobs, and the release script's log
  shows no watch error and it dispatched without a hand step; Release 41775435927 passed its smokes on the first try (entry `main-CRPNGkCE.js`,
  862,074 B, 1,782 B larger than 9.0.36's as round 3 measured); the release owner's public reads showed v810 and a desktop
  Chromium look at the code entry screen showed the input system's values (label 13px / 600, code field 32px / 700, line
  12px / 600); Drift Audit
  41775763808 passed; and the post-merge Full E2E 41775760191 on `d1665230` passed at 15:13 KST (`e2e` 927 passed,
  `webkit-mobile` 103 passed and 5 skipped plus the service worker test, the large-room R2 smoke), the first Linux run of the
  new iPhone and input specs (per-spec counts are not in the release evidence), which met this train's part of the condition for the next App update, the owner's UI tidy
  (released as 9.0.38 / v811 on 2026-11-05 after this record merged as #571, above; then Phase 7 7B), to merge once this record had merged. The owner's device checks (the `/debug sync`
  lines, the iPhone return, the input fields) wait, and 7A's remaining pre-merge reads (PRE-15, the T0 second pull request's
  baseline, the Phase total rule) are not recorded as done. The release record's §2 carries the train as post-deploy items,
  its §4 the 9.0.37 entry and current boundary line (5), and the hotfix procedure's 9.0.25 bullet names 9.0.37's merge SHA,
  Release ID and App version; the 9.0.36 report carries dated notes for 9.0.37's merge and release. This train's merge ended
  9.0.36's standalone revert window, and 9.0.38's merge (2026-11-05 05:59 KST) ended this train's; the default rollback is a
  forward revert at 9.0.46 / v821 or the next free number now that 9.0.39 to 9.0.45 shipped (7A's patches alone could be
  reversed only until 7B merged, which happened in the 9.0.39 train on 2026-11-05 21:08 KST).
- [iPhone YouTube return at the moment of the browser stop (2026-11-03)](design/ios-youtube-return-train-2026-11-03.md):
  released on 2026-11-04 13:51 KST as one increment of the App 9.0.37 / v810 train above (PR #570, squash `d1665230`),
  moved onto T1 on main `34dbe592` and then onto T1's squash `2c6544ff` on 2026-11-04 (`872f8bc3`, `f858db58`,
  `8399355d`, patches unchanged). Built on branch
  `agent/ios-yt-return` on main `88550bc4` (App 9.0.35 / v808), tested code `e4319843e`. Owner
  device report of 2026-11-03: an iPhone guest in a Standard room that reopens
  the app at the very moment iOS stops its hidden YouTube iframe stays paused until a tap on PLAY or
  Sync. On iPhone and iPad only, a Standard guest's unowned iframe PAUSE processed while hidden, or
  within `BACKGROUND_STOP_RETURN_GRACE_MS` (1 s) after the return and before focus moves into the
  iframe, is now the browser's stop: no pause intent, the local pause bit back down, and the RO-05
  return chain aligns after it (a sub-second bounce included); the hidden period is the background
  resume guard's one reading (`getLastObservedBackgroundReturn`). Computers, Android phones, hosts,
  operators and PRO rooms are unchanged. Increments: tests first `570f47229`, the fix `a86ad57bb`,
  the review fix `e4319843e`. Local evidence only (Vitest, Playwright Chromium with an iPhone user
  agent and a fake YouTube player); no real iPhone yet and the 1 s grace is unmeasured. The owner
  answered its one question on 2026-11-04: a pause tapped within 1 s of the return on an iPhone stays
  aligned over. Its spec first ran on Linux Chromium in the train's post-merge Full E2E 41775760191, which passed
  (per-spec counts are not in the release record's evidence); a real iPhone check waits.
- [Phase 7 train 7A: on-device audio recovery counts in /debug sync and a behaviour-neutral recovery cleanup (2026-11-03)](design/phase7-7a-audio-recovery-counters-2026-11-03.md):
  released on 2026-11-04 13:51 KST as the first increment of the App 9.0.37 / v810 train above (PR #570, squash
  `d1665230`), moved onto T1 on main `34dbe592` and then onto T1's squash `2c6544ff` on 2026-11-04 with every runtime
  and test patch unchanged (bump `51be7509`, the release-record §2 9.0.37 section). The first of the three Phase 7 App updates (owner decision Q2),
  first prepared on branch `agent/p7-7a`: twelve commits on `agent/p7-t1` (the release-free Phase 7
  T0 second pull request and T1 with its review fixes, tip `42819c58`, on main `432d4ae7`) and four
  record commits; its start condition (Phase 6 6D shipped, recorded and past its post-merge Full E2E
  and its post-deploy smoke) holds. 7A-2
  gives the AudioContext recovery one timing home,
  the new leaf `src/audio/context-protocol.ts` (not `src/audio/constants.ts`, which sits in another
  eager chunk), and one prepared-state predicate; 7A-3 deletes the write-only `fallbackEligible` and
  `fallbackClaimed` and the unused reason `'stale-play-lock'`; 7A-4 makes `attemptResume` a required
  choice of `probeAudioContextHealth`; 7A-6 deletes the recovery dialog's unreachable retire and
  re-arm after a failed retry; all four are neutral. 7A-1, an intended diagnostic display the owner
  approved from pictures, counts the recovery on the device (the mock-free leaf
  `src/audio/output-recovery-counters.ts`, numbered slots, an RO-01 observer fed by one phase funnel
  per machine and by read-only owner queries) and shows it in `/debug sync` as the approved AUDIO
  RECOVERY block after the ten head lines, with Chrome's output underruns read when the window opens
  and, after a same-tab reload, the previous page's counts kept in one sessionStorage key through the
  page navigation owner's pagehide; the window's footer reads 'RAM + tab storage'. Sound and every
  other screen are unchanged. Neutral evidence: the T0 owner tables, the lock-screen pause rows, the
  T0 second pull request's files and the local Chromium audio lab pass byte for byte (lab observations
  equal to the base with timings stripped), and the T0 known-gaps list stays as it is. The guard counts
  are unchanged (native 11; indirect 4 / 2 / 5); the RO-01 timing contract gains its scalar home
  (report-only pairs 45 to 38). First load +710 B eager JavaScript gzip (+714 B before the review
  fixes, whose −4 B are hashed lazy chunk names): 7A-1 +903 B, over the +300 B increment cap even
  without its three optional parts (+580 B), which the owner kept as approved on 2026-11-03 with none
  of the three removed; the four neutral increments −189 B;
  the Phase 7 total is judged after the last train. QA rounds 1 to 3 ran
  on the first base `cd8eaf47`; round 4 moved the stack onto `432d4ae7` with all sixteen patches
  identical; round 5 ran the full local gate on code tip `dd758372` (types, lint, format,
  `build:checked` step by step with only `guard:sw-cache-version` failing for the pending bump, the
  production candidate 19 / 19, every guard, critical coverage 4,504 and Worker coverage 3,325, the
  unit suite 18,134 of 18,135 with one release-tool timeout passing alone, critical E2E 101 / 101,
  the recovery specs and the audio lab 17 / 17) and the static subset on `56d4e2dd`; round 6 took
  real `/debug sync` pictures, phone and desktop, on the code tip. Round 7 checked the record
  commit's documents, and round 8 was an independent review in two lenses (sound, screen and counts;
  plan, ownership and records) with no high finding and no sound or timing change found. Round 9
  applied its medium (this report's unfinished documents round and table padding) and its lows: a
  single race now reads '1 race watched' in `/debug sync` (its own test-first pair, code tip
  `a4d4d383`), the T1 indirect-resume ratchet also counts calls inside `src/audio/context.ts`
  (zero today, its own test-first pair), and record fixes in the registry, the report and this
  entry. Round 10 reran the full local checks on both tips with no failure but the pending bump's
  `guard:sw-cache-version` on 7A (the unit suite, critical coverage and E2E, the recovery specs, the
  audio lab with equal observations, and the size against `432d4ae7`) and retook the `/debug sync`
  pictures with the singular. The fourth record commit adds the owner's answer on the 7A-1 size. Its remaining
  pre-merge reads (PRE-15, the T0 second pull request's baseline with CI times, the Phase total rule) are not recorded as
  done in the 9.0.37 release record's evidence and stay open there.
- [App 9.0.36 / v809 train: every public page on the app's font system, and the design system Typography section (2026-11-02)](design/public-page-fonts-2026-11-02.md):
  released on 2026-11-03 22:22 KST in Release 41643392133 (PR #567, squash `6f9cf6f8`) as App
  9.0.36 / v809 (App build 809, target `app`, one update dialog; the bump `f47d5733` is the last
  runtime commit, followed only by docs commits); `raise_app_build_floor` false, Developer API D1
  false. Only the App Worker changed (`6bba4c8e` to `385d84fe`); the PRO room Worker keeps R4's
  `e7657f88`, the other four their 9.0.22 versions, and the build floor stays 795. It followed App
  9.0.35 / v808, on branch `agent/public-page-fonts` over main `88550bc4` (9.0.35's release record;
  the App runtime was production 9.0.35's `cfa81bdc`). It was planned as 9.0.35 / v808 until the
  release owner shipped the ready Phase 6 6D first on 2026-11-03; QA round 12 moved the branch
  from `432d4ae7` with each commit's non-docs patch unchanged, and Phase 7 7A followed as
  9.0.37 / v810 on 2026-11-04. Owner decision of 2026-11-02 evening: every
  public page uses the app's font system, without owner pictures; only the app is checked, and it
  must not change. About and its 42 copies, the document, translate and sitemap pages, the blog
  and the article the App Worker renders, history, the design system with its previews and UI
  kit, admin and 404 now load `/web-fonts/first.css` (Inter, MUSIXQUARE Hangul, Noto Sans KR),
  `stacks.css` and `rest.css`, which the build concatenates from the app's processed sheets, so
  they fetch the app's own font files; the events page (PRO sign-in) loads only `first.css` and
  `stacks.css`, so its deferred scripts wait for no further sheet and the scripts only `rest.css`
  holds draw with device fonts there. `/han-order.js` marks the app's Han order from the browser's
  languages. The sign-in completion page belongs to the app, the train's one app-side change: by
  the owner's decision of 2026-11-03 it keeps looking as it does today, now drawn with the app's
  faces, which its script asks for only after it has told the app that sign-in finished (measured
  in Chromium and WebKit: the message leaves when it did in 9.0.34 through the service worker and
  locally; on a first load with neither the service worker nor a cache it waits for the bytes of
  two files, which a review fix brought back near 9.0.34's size, shipping the script minified and
  the sheet without comments; with the success-window fix they are 101 B larger in gzip and 48 B
  in brotli, no later on a byte-accurate 1.6 Mbps link and 2.0 to 2.6 ms later at 400 kbps with
  gzip, down from 772 B and 3 to 16 ms), its text waiting for them, in the cancelled and error
  windows 600 ms at most after the window's sheet. The self-closing
  success window ends that wait itself 200 ms after its message, so even a slow first sign-in shows
  its text, in the device's fonts, before the window closes (registry RO-54), and the shared
  sheets turn on together once all have loaded; 6 of its 252 copies (error copies) take one more
  line, as Inter is wider than Pretendard's Latin (before and after pictures in the git-ignored
  evidence folder). The owner saw the four success-window pictures with a note that six sign-in
  error copies take one more line and that the completion signal is unchanged, and answered at
  about 19:20 KST on 2026-11-03 to go ahead, so the six longer error copies are accepted; one
  error-copy picture (phone cs) followed before dispatch, and the text appearing at once when the
  faces are ready and the WebKit phone-emulation result were not shown as pictures. The design
  system gains the Typography section on that delivery; its Korean 述 cell draws Noto Sans KR in
  any browser. The deployed Pretendard copy, the Pretendard sheets, the unused Noto Sans Cyrillic
  and Greek files and 14 unnumbered generator-input faces are deleted;
  `fonts/PretendardVariable.woff2` stays as the source of the Hangul faces. Increments I1 to I9,
  the review fixes R1 to R8, the completion window change, its review fix and the success-window
  fix (two pairs, QA round 11) are tests first,
  each test commit failing on its parent unless recorded as a regression guard. The app-unchanged proof: no
  app source path changed except the sign-in completion page's sheet and script; with content
  hashes stripped, the app's build files equal the base's but for the one expected chunk fold
  (`retryable-stylesheet.ts` into `locale-fonts`, module code identical), its service worker
  install entry, that page's sheet and script, the Pretendard file that sheet no longer names, and
  the three shared sheets its script now names;
  the app's font request lists for the en, ko and ja start screens are identical; the app's font,
  line-box, tab-header and playlist E2E specs pass, and the base's unmodified specs pass on the
  head build. A light load check of every public page joins
  the default Full E2E, opt-in labs read the faces, and the guards hold every page source and
  built page to the public page list. Before the bump every guard passed but
  `guard:sw-cache-version`; the bump `f47d5733` changes the seven version lines of 9.0.35's bump
  `b0906a93`, and on it that guard passes at v809 and `guard:release-identity` reads 9.0.36 /
  v809. QA round 13 ran the full local gate on the bump head `018e013a` (code `f47d5733`): all 37
  guards, coverage, the critical, app font and screen, public, completion-window (Chromium and
  WebKit lanes) and production candidate E2E and the labs pass; the full unit suite ran twice with
  one git-fixture row over its own 30 s cap under load each time (105 / 105 alone, twice); against a
  clean build of `88550bc4` the app's build files differ only as expected, the start screens' font
  request lists are identical and the eager first load is 90 B smaller raw (35 B in gzip). QA round
  14 applied a review in documents only and compared the completion window with 9.0.34's files in
  Playwright WebKit (the phone emulation draws the success text before the close less often than
  9.0.34 locally and more often on a slow link). Not run: real devices, Linux (no container on the
  build machine; the post-merge Full E2E is the first Linux run, the completion-window spec included
  in both its Chromium and WebKit jobs), WebKit beyond the sign-in completion window (its timing and
  its new spec ran in Playwright WebKit), the screen pixel comparison. QA round 15 records the
  release: the PR CI on head `5cc41bda` (a docs-only commit recording the owner's go-ahead) passed,
  the automated review that opening the pull request started ended with no findings, the merge
  used the prepared squash body (parent `88550bc4`), and the exact-main CI passed all 11 jobs; the
  release script's run watch ended with an error at 22:15 KST while two jobs were still running, so
  the script stopped before dispatch, no job had failed, and the release owner re-checked the run
  and dispatched by hand (that tooling, outside the repository, now re-reads a run's real status
  after a watch error). The public floor read just before dispatch showed stored and effective 795
  with an App report about 5 s old; one Production Release passed every smoke on the first try
  (932 release files, down from 1,274 as §5 measured; checkpoint artifact 13233084692 with the
  9.0.35 App `6bba4c8e`; the entry chunk `main-DCiq6YqZ.js` is 45 B smaller than 9.0.35's, as
  round 13 measured); the public service worker read v809 (the release owner's reading), `index.html` loads bootstrap v809 and
  `main-DCiq6YqZ.js`, the floor read 795 with live App 809, `/web-fonts/first.css`, `stacks.css`
  and `/account-complete.html` returned 200, and the release owner saw the start screen on v809
  and the design system's Typography section with the three shared sheets and the app faces
  loaded in production desktop Chromium (not blind). The Drift Audit 41643984565 reported
  automated-checks-passed (its App build floor row passed), and the post-merge Full E2E
  41643979180 on `6f9cf6f8` passed at 23:41 KST (`e2e` 903 passed on Linux Chromium,
  `webkit-mobile` 103 passed and 5 skipped plus the production service worker test, the
  production large-room R2 smoke passed), the first Linux run of the new public-page load spec,
  the changed `font-identity` and `about-page-layout` and the sign-in completion window spec in
  both its Chromium and WebKit jobs; it met this train's part of the condition for Phase 7 7A
  (the 9.0.37 / v810 train, merged on 2026-11-04 after this record) to merge once this record had merged. The sign-in completion window
  was not opened in production, and the owner's app check and the real-device checks wait. The
  release record's §2 carries the train as post-deploy items, its §4 the 9.0.36 entry and current
  boundary line (5), and the hotfix procedure's 9.0.25 bullet names 9.0.36's merge SHA, Release
  ID and App version; the 6D report carries dated notes for 9.0.36's merge and release. This
  train's merge ended 6D's standalone revert window, and the 9.0.37 train's merge ended this train's own; the default
  rollback is a forward revert at 9.0.46 / v821 or the next free number now that 9.0.37 to 9.0.45 shipped.
- [App 9.0.35 / v808 train: Phase 6 6D, the YouTube start recoveries in one module, the Standard host's local start wait, the PRO start tokens, the late-joining PRO device's COMMIT catch-up and one mute rule below 0.5 % master volume (2026-11-02)](design/phase6-6d-recovery-pro-arm-2026-11-02.md):
  released on 2026-11-03 16:40 KST in Release 41597588008 (PR #565, squash `cfa81bdc`) as App
  9.0.35 / v808 (App build 808, target `app`, one update dialog, the last of Phase 6's four; the bump
  `b0906a93` is the last runtime commit, followed only by three record commits);
  `raise_app_build_floor` false, Developer API D1 false. Only the App Worker changed (`b5278b0b` to
  `6bba4c8e`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22 versions, and
  the build floor stays 795. It followed App 9.0.34 / v807. The release owner decided on
  the afternoon of 2026-11-03 to ship 6D first because the public-page font train, which the
  release record had named as 9.0.35, was still being finished; that train became the App update
  after it and shipped as 9.0.36 / v809 on 2026-11-03 22:22 KST. On branch `agent/p6-6d`,
  thirty-nine commits on main `432d4ae7` (the App 9.0.34 / v807 release record): the thirteen
  commits first built on the 6C train's tip `bdb5759a`, moved patch for patch once 6B (9.0.32 /
  v805) and 6C (9.0.34 / v807) had shipped, a tests-only commit and a comment and registry commit
  from the review of the moved branch, one record commit, 6D-6's nine commits (regression rows,
  failing test, runtime change, record, post-review comments and post-review record, first built on
  the first branch's tip `e8cacdd4` and moved with its two post-review test commits folded into the
  first two, then the fallback's failing test, runtime change and record), and 6C-3's four commits
  (its open point's tests-only row `b00d79ac`, tests first `d6f7cb00`, the runtime change
  `767a5a08` and one record commit, first stacked without 6D-6 as `5ca0abf0`, `38fcedb5` and
  `7208a93d` and re-applied patch for patch after it; those first SHAs are on no ref now), the
  final local check's record commit, QA round 9's record commit, QA round 10's record commit, and
  the tests-only commit `8a0edafb` and record commit of 6D-6's review (QA round 11), the
  release preparation record `a5c49cc0` (the train's pre-deploy section in the release record,
  its open-item links and the sections that named the next App update), the bump `b0906a93`
  (9.0.35 / v808 in the same seven lines of six files as 9.0.34's `c44d4d2c`), the last runtime
  commit, a record commit for the release preparation (`3e4031f5`: the report, this entry and two
  sentences of the release record's 9.0.35 section), QA round 12's record
  commit for the bump head's full local gate (`56a7de55`), and the record commit of the release
  preparation's review (QA round 13, the pull request head `30c2145f`). 6D-1 turns the Standard guest's local zero-start recovery from a
  `player.ts` closure into the class `GuestZeroStartRecovery` in the new
  `src/youtube/zero-start-recovery.ts`, and the two
  recoveries' 0.35 s settle tolerance, 50 ms poll and 3 s bridge into three named exports of
  `src/youtube/constants.ts`; 6D-2 makes the Standard host's legacy recovery a stage beside it
  (`HostZeroStartRecovery`), the replacement fallback staying in `player.ts`; 6D-3 makes the
  Standard host's local start wait one primitive in `player.ts`; 6D-4 types the PRO arm's start kind
  with the PRO playback union and names and pins the four PRO start tokens apart, keeping the
  desired-audio pushes because a live read is not neutral; 6D-5 keeps RO-02, RO-03 and RO-12
  `duplicated` at the end of Phase 6's code, naming the machines that remain, and checks the plan's
  Phase 6 end conditions against the code. Neutral: the T0a goldens, both T0b truth tables and the
  6B and 6C rows pass byte for byte (one T0a parity row gained the three new names), the five start
  timers stay `player.ts`'s managed timers under their names, and the wire is unchanged. The
  owner's answers of 2026-11-02 night are recorded: 6C-3 (one mute rule for a master volume above
  0 and below 0.5 %, left out of 9.0.34) and 6D-6 (the fix for a late-joining PRO device's second
  effects toast and rebuilt YouTube screen, Q22 (a), seen as frames) are both yes and close this
  train, tests first, 6D-6 and then 6C-3 before the bump, 6C-3 only after its open point (whether
  a remote host PREPARE during a guest's local fallback start carries the 'rounded' intent into the
  new run) is checked and recorded. 6D-6 is built, before 6C-3, after the owner saw the pictures:
  the COMMIT catch-up of a device that missed its READY keeps that PREPARE's still-loading load, so
  one toast shows and the screen stays, also when the start arrives in a snapshot. A fallback the
  release owner added loads a first screen still not ready at the join the catch-up plans again
  there, as before 6D-6 but up to about 3 s later (about 1.1 s in the test scene), instead of
  ending 15 s after the PREPARE with the load-timeout toast; the slowest phones, whose first screen
  is merely slow, take that path too. One rarer path stays worse than before 6D-6: a start learned
  from a snapshot 12 to 15 s after the PREPARE while the first screen is still loading still ends
  with the load-timeout toast and waits for the next room-state sync (pinned by a test row; the
  owner accepted it with the size question Q29). 6C-3 is built after it as the
  train's last increment and its one intended change ([screen changes: sound and start timing only,
  iPhone, master volume between 0 and 0.5 %]): `readYouTubeAppAudio` loses its 'non-positive'
  variant, so every site mutes YouTube when the master volume rounds to 0 %, with the same frames
  and instants. Its open point was checked first and pinned: a PREPARE that takes over the guest's
  local recovery already carries the 'rounded' intent, while a PREPARE that a remote host sends
  inside its own run's timeline window comes after an ABORT, which ends the recovery, so the new run
  captures its own audio, the 'non-positive' answer until 6C-3 (the path the 6C probes hit), and
  6C-3 changes it as it changes the guest zero-start row. The new finding (both zero-start
  recoveries never seek again when a settle leaves a loaded target more than 0.35 s from the local
  zero, and give up at the end of their window, the iframe paused there with no notice) is
  recorded only, end condition 2 holds under the owner-accepted reading (a), and no T0b defect fix
  rides. The report lists the owner answers used, each increment's tests-first evidence before and
  after the move, the SHA map, the guard counts (CHECK 11 stays 20 as `player.ts`'s recovery
  writes move into the new module), the first load (+458 B eager JavaScript gzip against main
  `432d4ae7`: +294 B for 6D-1 to 6D-5, +68 B for 6D-6, +114 B for its fallback and −18 B for
  6C-3; Phase 6 total +289 B, over the +200 B cap by 89 B; on the morning of 2026-11-03 the owner
  answered Q29 to ship as is, keeping the fallback and the rare late-snapshot timeout), 6C-3's
  before/after table and timing check against the approved table, the Phase 6 end-condition
  check (condition 6's 14 days count from this release), mixed versions, rollback (checkpoint App
  9.0.34 / v807, a forward fix at 9.0.36 / v809 or the next free number, now 9.0.42 / v815 since
  the public-page font train shipped as 9.0.36, the 9.0.37 train as 9.0.37, the 9.0.38 train as 9.0.38, the 9.0.39 train as 9.0.39, the 9.0.40 train as 9.0.40 and the 9.0.41 train as 9.0.41), the blind device
  candidates, the three open items, now linked from the release record, and the Phase 7 handoff. QA rounds 1 to 4 ran on the first branch (old base `bdb5759a`). QA round 5 moved it
  onto `432d4ae7` (four docs-only conflicts, every commit's `src` and `scripts` patch unchanged)
  and reran the tests-first pairs, types, lint, format, `check:workers`, three unit directories
  with the guard self-test, the build and every guard. QA round 6, on the reviewed tip `acc22d3a`:
  types, lint and format, `check:workers`, the unit suite 755 files / 18,117 rows (nine timeouts
  in two release-tool files on a loaded PC, each file passing when run alone), four
  `--sequence.shuffle` seeds over `src/youtube`, `src/player` and `src/pro-room` (6,804 rows each,
  seed 7 rerun after an incomplete first run), critical coverage 112 files / 4,599 with the
  merged profile and Worker coverage 69 / 3,325, the build and every guard except
  `guard:sw-cache-version` (the pending bump: 10 App files newer than v807), critical E2E 101 /
  101, the ten local YouTube specs 53 / 53 and the WebKit YouTube activation spec 4 / 4 (ports
  5391 / 5392, retries 0). QA round 7, on 6C-3's tip `7208a93d` before 6D-6 was put in front of
  it: the open-point row and the tests-first pair at their commits (56 / 59 on the parent, failing
  only the three flipped 0.004 rows; 59 / 59 after), types, lint and format, the YouTube, player
  and PRO room unit directories with the guard self-test (249 files / 6,916 rows), the ownership
  check (counts unchanged), the build and every guard except `guard:sw-cache-version`, and the
  first load. QA round 8, the final local check on the head `b2ec82e3`, also before 6D-6, with
  `origin/main` still `432d4ae7`: types, lint, format, `check:workers`, the unit suite 755 files /
  18,120 rows (nine timeouts in the same two release-tool files as round 6 on a loaded PC; rerun
  alone, every timed-out row passed except one, which timed out on the base `432d4ae7` too under
  the same load), critical coverage 112 files / 4,599, the ownership check, a clean build with
  every guard except `guard:sw-cache-version`, the first load against a clean build of the base
  (+273 B eager JavaScript gzip, as in round 7), critical E2E 101 / 101, the ten local YouTube
  specs 53 / 53 and the WebKit YouTube activation spec 4 / 4 (ports 5391 / 5392, retries 0).
  6D-6 then came in front of 6C-3: shared-path rows that pass before and after it, four
  late-join rows of a device without an iframe that fail before it (two flipped, a snapshot-route
  row and a never-ready first iframe row), and an iPhone kept-iframe row that pins the judgement's
  ready-player bound. Its runtime commit has the first branch's patch-id and adds 68 B, its comment
  commit changes no build byte, and its pictures come from the first branch's real build. The
  fallback's flipped never-ready row fails before its runtime commit and passes after it; that
  commit adds 114 B, and types, lint, the three unit directories with the guard self-test and the
  ownership check pass on it. 6C-3's three code and test commits were then re-applied with the same
  patch-ids and take −18 B; round 8's full local check was rerun on the head with 6D-6 in QA round 10.
  QA round 9, on that head `b19ccffb`, checked the fallback again against the release owner's
  decision (no change) and ran the late-join, shared-path and four golden files (17, 7 and 132
  rows), the three unit directories with the guard self-test (250 files / 6,925 rows), types,
  lint, a clean build with every guard except `guard:sw-cache-version` (now 13 App files: the
  ten `src/youtube/` files plus `src/player/playlist.ts` and two `src/pro-room/` files), the
  ownership check (counts unchanged), the local deploy-target judgement (App 13, every other
  target 0, no App runtime dependency change, empty contract-freeze diff) and the first load
  (+458 B eager JavaScript gzip against `432d4ae7`, the same bytes as when it was rebuilt). The
  report's 6D-6 section now splits the visible change into the normal case the owner saw, the
  snapshot route (the same change) and the rare never-ready case (as today, up to about 3 s later), and
  6C-3's section gains one plain line for its ABORT-first case.
  QA round 10, on QA round 9's record commit `8e6bd9ab` with `origin/main` still `432d4ae7`:
  types, lint, format, `check:workers`, the unit suite 756 files / 18,129 rows (two timeouts in
  the same two release-tool files as rounds 6 and 8 on a loaded PC, both files passing when rerun
  alone), critical coverage 112 files / 4,599, the ownership check (counts and `--report`
  unchanged), a clean build with every guard except `guard:sw-cache-version` (13 App files), the
  first load against a clean build of the base (+458 B eager JavaScript gzip; Phase 6 +289 B,
  still the Q29 question), critical E2E 101 / 101, the ten local YouTube specs 53 / 53 and the
  WebKit YouTube activation spec 4 / 4 (ports 5391 / 5392, retries 0). 6D-6's frames were taken
  again on this branch, today's row on `432d4ae7` and the fixed row on the head: one toast and the
  kept first screen as approved, the pixel differences limited to the Hangul text that App 9.0.33
  redrew, the spinners and a toast fade. QA round 11 applied 6D-6's review without a runtime
  change: four tests-only rows pin both sides of the fallback's deadline (the snapshot route and
  the IFrame API script still loading at the planned join load again there; a first iframe ready
  1 ms before it is kept) and the late-snapshot path above as the branch behaves; the late-join
  file is 13 / 13 on the head, 10 / 13 without the fallback's runtime patch and 5 / 13 without
  6D-6's and the fallback's, where the late-snapshot row fails because the snapshot then loads
  again at once. The owner text now gives the fallback's trade-offs and tags Q29 (b) [screen
  changes]; the report points the 6C-3 rows at the re-applied SHAs. The three unit directories
  with the guard self-test (250 files / 6,929 rows), a clean build (the same bytes as round 10),
  every guard except `guard:sw-cache-version`, the ownership check and the local deploy-target
  judgement pass as before. At the release preparation on the afternoon of 2026-11-03 (`git fetch`
  showed main still at `432d4ae7`), on the bump head `b0906a93`: `guard:sw-cache-version` (PASS
  v808) and `guard:release-identity` (9.0.35 / v808), `npm run build:checked` as one command, the
  ownership check (49 records, 459 files), the local deploy-target judgement (App 17 with the four
  version mirrors, every other target 0, no App runtime dependency change, target `app`
  partial-release compatible), the contract-freeze diff (the seven version lines; in `cloudflare/`
  only `ADMIN_ASSET_VERSION`) and the first load (+462 B eager JavaScript gzip against `432d4ae7`,
  4 B of it the version strings) pass. QA round 12 then ran the release record's full local gate on
  the bump head's record commit `3e4031f5` (runtime of `b0906a93`, ports 5393 / 5394, retries 0,
  `origin/main` still `432d4ae7`): types, lint, format, `check:workers`, `build:checked` as one
  command and all 37 guards one by one (all passing, the version guards at v808 and 9.0.35), the
  ownership check (`--report` unchanged), critical coverage 112 files / 4,599 and Worker coverage
  69 / 3,325, the unit suite twice (756 files / 18,133 rows; the second run's one failure, a
  timeout in the same release-tool file as rounds 8 and 10, passed when that file was rerun alone),
  the production-candidate E2E 19 / 19, critical E2E 101 / 101, the ten local YouTube specs 53 / 53,
  the WebKit YouTube activation spec 4 / 4, the local deploy-target judgement (App 17, every other
  target 0) with the partial-release check, and the first load against a clean build of the base
  (+462 B eager JavaScript gzip, the same bytes as at the release preparation). QA round 13
  applied the release preparation's review in documentation only: each older release-record item
  whose substance the preparation changed now links this report, three items whose substance did
  not change keep their earlier pointer to the top of §2 for the deploy record to fix with §1, the
  fallback's deadline is described as the catch-up's late-join lead (3 s by default, at most 4 s
  on a device whose earlier local rejoins prepared slowly), and the owner's answers are
  paraphrased instead of quoted. QA round 14 records the release: the PR CI on head `30c2145f`
  passed all 11 jobs on its first run, the automated review that opening the pull request started
  ended with no findings, the merge used the prepared squash body (parent `432d4ae7`, tree equal to
  the head), the exact-main CI passed (critical coverage 112 files / 4,599 tests, the production
  candidate 19 / 19 and critical E2E 101 / 101 on Linux, release identity 9.0.35 / v808), the
  public floor read just before dispatch showed stored and effective 795 with an App report about
  60 s old, one Production Release passed every smoke on the first try (1,274 release files;
  checkpoint artifact 13212877229 with the 9.0.34 App `b5278b0b`; the entry chunk
  `main-CkxImhw8.js` is 600 B larger than 9.0.34's, as round 12 measured), the public service worker
  read v808, `index.html` loads bootstrap v808 and `main-CkxImhw8.js`, the floor read 795 with live
  App 808, the Drift Audit reported 32 pass / 0 fail / 5 manual-only, and the release owner saw
  only the start screen and the update dialog in production desktop Chromium (not blind: the
  dialog unchanged, its apply button reloading into the v808 caches and scripts). The post-merge
  Full E2E 41597953240 on `cfa81bdc` passed at 17:58 KST (`e2e` 813 passed on Linux Chromium, among them the ten YouTube specs' 53 rows, `setup-youtube-activation` 4 and the five PRO specs' 31 rows; `webkit-mobile` 94 passed and 5 skipped plus the production service worker test, among them `setup-youtube-activation` 4 and `youtube-landscape-full-bleed` 4 on Linux WebKit, not a real iPhone Safari; the production large-room R2 smoke passed), which met this train's part of the condition for the next App update, the public-page font train, to merge once this record had merged; that train merged at 22:08 KST and shipped as 9.0.36 / v809 at 22:22 KST. On the evening of 2026-11-03 the owner ran three short essential checks on 9.0.35 (overall fine, with one new finding: an iPhone guest that returns at the exact moment of the background pause stays paused without the automatic sync, under investigation and not released); the remaining blind device candidates A to D wait,
  and Phase 6 end condition 6's 14 days count from this release (to 2026-11-17 16:40 KST). The
  release record's §2 carries the train as post-deploy items (scope and status, the owner
  decisions and rule, rollback, the post-deploy check, the next steps, the Phase 6 end conditions,
  open items), its §4 the 9.0.35 entry and current boundary line (5), and the hotfix procedure's
  9.0.25 bullet names 9.0.35's merge SHA, Release ID and App version; the 6C report carries dated
  notes for 9.0.35's merge and release. This train's merge ended the standalone revert windows of
  6C and the two light-theme increments; 6D's own window closed when the next App update, the
  public-page font train, merged (2026-11-03 22:08 KST), and the default rollback is a forward
  fix at 9.0.46 / v821 or the next free number (9.0.36 to 9.0.45 shipped).
- [App 9.0.34 / v807 train: Phase 6 6C (one YouTube state router, one iframe audio owner and shared arm steps), no light-theme stroke on the dialog grey button and the selection bar, and lighter light-theme dividers (2026-11-02)](design/phase6-6c-router-iframe-audio-arm-steps-2026-11-02.md):
  released on 2026-11-02 21:20 KST in Release 41443521522 (PR #563, squash `cd8eaf47`) as App
  9.0.34 / v807 (App build 807, target `app`, one update dialog, two visible light-theme changes;
  the bump `c44d4d2c` is the last runtime commit, followed only by two record commits);
  `raise_app_build_floor` false, Developer API D1 false. Only the App Worker changed (`047e6f68` to
  `b5278b0b`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22 versions, and
  the build floor stays 795. It followed App 9.0.33 / v806 (Hangul drawn by Pretendard again,
  released 2026-11-02 13:12 KST) and was built on branch `agent/p6-6c`: thirty commits on main
  `a92bab2b` (9.0.33's release record #562; its App runtime is production 9.0.33's). Three increments ride: the third
  Phase 6 App train 6C, neutral; the owner's light-theme stroke removal, a visible change; and the
  lighter light-theme divider the owner chose from pictures, a visible change. 6C's
  twenty-one commits moved from main `7b869c35`, where QA rounds 5 to 8 ran, with every `src` and
  `scripts` patch byte-identical and nineteen of them with the same patch-id (code tip now
  `19362aa2`, record tip `12c69856`; the only conflicts, two, were in `docs/README.md`, where the
  9.0.33 entry had taken the top of this list); the light-stroke commit `c3281b45` is `d6d69bc4`
  from `agent/light-stroke` cherry-picked cleanly; two record commits follow (`1e3adfcb`, and
  `1e146488` with QA round 10); the divider commit `9fb6f1f8` is `9b269706` from
  `agent/light-divider` cherry-picked without a conflict and with the same patch-id; a record
  commit `c8a459a9` adds the divider and QA round 11; the release preparation record `3cb356af`
  adds the train's pre-deploy section to the release record; the bump `c44d4d2c` (9.0.34 / v807
  in the same seven lines of six files as 9.0.33's `d78d0d41`) is the last runtime commit; a
  record commit `1481f67a` adds QA round 12, the full local gate on the bump head; and a last
  record commit (QA round 13, documentation only) applies the documentation findings of the review
  after the bump. All four parts of the
  train's merge condition (Phase 6 plan §1.4) are met: the previous train 9.0.33 was deployed
  (Release 41386906358), its production smoke passed, it was recorded (#562), and its post-merge
  Full E2E 41396274966 on main `6ccc3f10` passed. QA round 14 records the release: the PR CI on
  head `a44d648c` passed all 11 jobs on its first run, the automated review requested on the PR
  ended with no findings, the merge used the prepared squash body (parent `a92bab2b`, tree equal
  to the head), the exact-main CI passed (critical coverage 110 files / 4,501 tests, the
  production candidate 19 / 19 and critical E2E 101 / 101 on Linux, release identity 9.0.34 /
  v807), the public floor read just before dispatch showed stored and effective 795 with an App
  report about 58 s old, one Production Release passed every smoke on the first try (1,274
  release files; checkpoint artifact 13141009365 with the 9.0.33 App `047e6f68`; the entry chunk
  `main-DVz17rkE.js` is 1,319 B smaller than 9.0.33's, as round 12 measured), the public service
  worker read v807, `index.html` loads bootstrap v807 and the floor read 795 with live App 807, the
  record's own unauthenticated GETs (21:37 to 21:38 KST) saw the production app CSS carry the
  light `--glass-border: transparent` and `--divider: #e4e6e8` (light high contrast `#d4d6d8`) and
  the production events page CSS match the repository byte for byte, the Drift Audit reported 32 pass / 0 fail / 5 manual-only, and the release owner saw
  only the light start screen and the update dialog in production desktop Chromium (not blind:
  computed `--glass-border` transparent and `--divider` `#e4e6e8`, the grey 'later' button's
  border `rgba(0, 0, 0, 0)` with no ring in the screenshot; which build's stylesheet drew the
  dialog is not in the evidence, and the start screen's values suggest v807's). The post-merge Full E2E 41443910217
  on `cd8eaf47` passed at 22:37 KST (`e2e` 813 passed on Linux Chromium, among them the ten
  YouTube specs' 53 rows, the 24 light-theme rows and the 32 selection-mode playlist rows;
  `webkit-mobile` 94 passed and 5 skipped plus the production service worker test, among them
  `setup-youtube-activation` 4, `youtube-landscape-full-bleed` 4 and `auxiliary-component-cascade` 5
  on Linux WebKit, not a real iPhone Safari; the production large-room R2 smoke passed), which meets the condition for the next App train to merge. This record named that train as the public-page
  font train with the design system Typography section (planned 9.0.35 / v808, being built on
  `agent/public-page-fonts` from `cd8eaf47`); on the afternoon of 2026-11-03 the release owner
  decided to ship the ready 6D first as 9.0.35 / v808, with the font train after it (shipped as
  9.0.36 / v809 on 2026-11-03 22:22 KST); 6D merged on 2026-11-03 16:27 KST (`cfa81bdc`) and shipped at 16:40 KST (entry above). The blind device
  candidates A to F and the owner's light-mode look G wait. The release record's §2 carries the
  train as post-deploy items (scope and status, the owner decisions and rule, rollback, the
  post-deploy check, the next steps, open items), its §4 the 9.0.34 entry and current boundary
  line (5) (which named 9.0.34 until 9.0.35 shipped), and the hotfix procedure's 9.0.25 bullet
  names 9.0.34's merge SHA, Release ID and App
  version; the 9.0.33 and 6B reports carry dated notes for 9.0.34's merge and release. This train's merge ended 9.0.33's standalone revert window; its own windows (6C and each light
  increment) closed when the next App update, 6D as 9.0.35, merged on 2026-11-03 16:27 KST, so a
  revert now goes forward at 9.0.46 / v821 or later (9.0.36 to 9.0.45 shipped too) and reverting 6C takes 6D with it.
  6C-1 turns `iframe.ts`'s fixed-order dispatch of iframe states to the start owners into a router
  with one decision per start claim kind (a kind without one does not compile) and merges the
  Standard host's held room time into one read, the pending-start predicate staying the legacy
  hold's; 6C-2 makes `src/youtube/iframe-audio.ts` the owner of the App's iframe audio writes, the
  PRO pause gate's iframe token and the holds (the gate mutes at once, parking gets the verified
  hard mute, a start owner holds only the unMute), reading the desired audio when it writes under
  today's two named mute rules; 6C-4 and 6C-5 move both arm machines' hard-mute wait, warm
  acceptance and settle into the new `src/youtube/arm-steps.ts`, each machine keeping its own
  policy, and remove the PRO arm's unused load warm. The first independent review added a host
  legacy recovery cell to the two-rule row and a stronger Phase 7 contract (a) row, made the owner
  ask the start ledger itself, and added a CHECK 12 rule that keeps the parking hold's registration
  to one top-level statement of `player.ts`. The second added five arm golden rows that pin how the
  shared settle counts its polls on both machines (passing on main's runtime too), widened that
  rule to the owner's parking slots, added `PAUSE GATE WRITERS` (only `player.ts` holds, releases
  and clears the PRO pause gate), and recorded that the arm machines' 'non-positive' audio is only
  what they capture as they start. Neutral: the T0a goldens, both T0b truth tables, the 6B rows and
  Phase 7 T0's rows pass byte for byte; one T0b row of `player.test.ts` and the truth-table
  sampler's pause-gate column ask the owner's gate query only because the runtime bridge's gate
  hook was deleted, their expected values unchanged. The owner's one-rule change below 0.5 % master
  volume (6C-3) is prepared as a before/after table and does not ride 9.0.34, because the owner has
  not answered the table question; no T0b defect fix rides.
  The light-stroke increment (owner request, 2026-11-02 afternoon): the light palette's
  `--glass-border` in `css/style.css` becomes transparent as in dark, so the dialog grey button
  (`.dialog-secondary`), the playlist selection bar and its cancel circle lose their faint grey
  edge in light only. The 1px border stays, so nothing changes size; dark, the high-contrast
  palettes and forced colors keep their values, and `public/designsystem/colors_and_type.css` only
  mirrors the value (the one public rule that reads it is on the always-dark design system page).
  The before and after pictures (72, kept outside the repository) compare pixel for pixel: the 16
  dark and light high-contrast pairs change 0 pixels, and the 8 light pairs change only inside the
  button and bar boxes, with unchanged computed sizes. The owner saw only four of them, the light
  side-by-side pictures, not the whole set. No unit test pins the light value; the stroke branch's
  own unit run kept no log, so its unit evidence is QA round 10's logged run of the same 51 files
  on `d6d69bc4` (1,447 / 1,447) and round 9's full suite on `c3281b45`.
  The divider increment (the owner's choice, 2026-11-02 around 17:40 KST, after five pictures that
  compare today's `#d4d6d8` with candidates A `#e4e6e8` and B `#eff1f3`, none of them showing the
  events page): the base light
  `--divider` in `css/style.css` becomes `#e4e6e8` (1.25:1 on white and 1.19:1 on the light page,
  against 1.46:1 and 1.38:1 before; dark `#262626` is 1.15:1 on its dialog and 1.24:1 on its page),
  so the settings, account stats, help legal, YouTube search, desktop column and settings tab lines
  get lighter in light only. The events page's own light `--divider` follows, so its header line
  between the wordmark and the event name gets lighter, and the design system mirror, its light
  board swatch and its light color preview carry the new value. Light high contrast keeps
  `#d4d6d8`, dark keeps `#262626` and forced colors keep `CanvasText`; the events page has no
  high-contrast palette, so with contrast set to more its header line is `#e4e6e8` while the app's
  dividers stay `#d4d6d8`. Real screens on `9b269706` against main `a92bab2b` (local headless
  Chromium at scale 2, 30 pairs, kept outside the repository): the 10 dark and 8 app light
  high-contrast pairs change 0 pixels, and the 10 light and 2 events high-contrast pairs change only
  inside the measured divider line boxes; five of the eight scenes with the candidate A mock equal it
  to 0 pixels, the two account dialogs differ only around the grey button ring (the stroke
  increment, not in those trees) and one YouTube search scene only at the search clear button,
  which differs between recaptures. The divider branch's own 13-file unit run kept no log; the
  logged unit evidence is QA round 11's.
  The report lists the owner answers used, each 6C increment's tests-first evidence before and
  after the first move, the SHA maps of both moves, the guard counts (CHECK 11 32 → 20), the first
  load (6C +33 B eager JavaScript gzip against main `7b869c35` and again on top of 9.0.33; the
  bump head that ships +30 B against `a92bab2b`, +38 B on the divider tip and +42 B before the
  divider, the rest moving with the renamed hashed file names; Phase 6 total −169 B), mixed
  versions, rollback (checkpoint App 9.0.33 / v806,
  build 806, deploy SHA `4faf38d9`; a manual rollback to it removes the whole train v807 and gives
  its clients a lower epoch, so the default is a forward revert of the whole train or one increment
  as 9.0.35 / v808, or the next App update's number after that if another ships first, now 9.0.42 /
  v815 since 6D shipped as 9.0.35, the public-page font train as 9.0.36, the 9.0.37 train as 9.0.37, the 9.0.38 train as 9.0.38, the 9.0.39 train as 9.0.39, the 9.0.40 train as 9.0.40 and the 9.0.41 train as 9.0.41; 6C and each light commit alone only until the next App update
  merged (6D as 9.0.35 / v808 by the release owner's 2026-11-03 decision, merged on 2026-11-03
  16:27 KST; this record named the public-page font train), as the record rules for 9.0.31, 6B and
  9.0.33, then a forward fix on the latest main; reverting 6C after 6D merged takes 6D with it), the blind device candidates
  and the owner's own light-theme look at the grey button, the selection bar and the dividers (not
  blind, since the owner has seen the pictures), the open item for
  the YouTube first-note alignment, the Phase 7
  contracts (rechecked on top of #559) and one new log-only defect. QA round 9, on the new tip
  `c3281b45` (2026-11-02 16:46 to 17:30 KST): types, lint and format; the unit suite 752 files /
  18,005 with nothing skipped or rerun; critical coverage 110 files / 4,501 (round 8's totals) and
  Worker coverage 69 files / 3,325; the build and all 37 `guard:*` scripts one by one, every one
  passing except `guard:sw-cache-version` (the pending bump: 11 App files newer than v806, the two
  CSS files and 6C's nine `src/youtube` files); the resource-ownership check OK with its `--report`
  byte-identical to round 8's; the deploy target App only against production 9.0.33 `4faf38d9`
  (every other Worker 0, no dependency change, the contract paths unchanged); critical E2E 101 /
  101, the ten YouTube Chromium specs 53 / 53 (the plan's eight 41 / 41), the WebKit YouTube
  activation spec 4 / 4, and the light-stroke specs (contrast and design system page 9 / 9, the
  seven selection-mode playlist specs 32 / 32). QA round 10 (18:27 to 18:38 KST) reran the moved
  tests-first pairs on their new SHAs, each exported with `git archive` into one scratch tree with
  its own `npm ci` (no worktree, no links): every tests-first commit fails only in the rows it
  adds, for the same missing code or guard rule, and every code commit passes, with round 5's
  counts after the first move and round 7's second-review counts (an independent review run gave
  the same counts); the light-stroke commit `d6d69bc4`'s 51 unit files pass 1,447 / 1,447 there
  too. The guard counts that differ from round 8 are shown to be main's from file sets. QA round
  11, on the divider tip `9fb6f1f8` (18:42 to 19:04 KST): the 13 unit files the divider touches
  229 / 229; the four files that failed in the divider branch's full run (git-fixture timeouts and
  two language rows, none touched by the divider) 318 / 318; after `npm run build:e2e`, the
  contrast, design system page, events and auxiliary component specs 24 / 24 and the seven
  selection-mode playlist specs 32 / 32 on ports 5391 / 5392 (a first run on the default ports
  passed the same and is not counted); the deploy target App 14 paths against 9.0.33 (every other
  Worker 0, no dependency change, the contract paths unchanged), `guard:sw-cache-version` failing
  only for the pending bump, and the size, with `guard:initial-transfer-budget` passing. QA round
  12, the full local gate on the bump head `c44d4d2c` (2026-11-02 19:31 to 20:24 KST, ports 5391 /
  5392, every step one at a time): typecheck, lint and format; `build:checked` as one command, with
  `guard:release-identity` printing 'MUSIXQUARE 9.0.34; service-worker cache epoch v807' and
  `guard:sw-cache-version` passing at v807; all 37 `guard:*` scripts one by one, every one
  passing with round 9's counts; the resource-ownership check OK with its `--report`
  byte-identical to round 9's; critical coverage 110 files / 4,501 and Worker coverage 69 files /
  3,325; the unit suite twice, 752 files / 18,005 each with nothing skipped, failed or rerun;
  `check:workers`; the production candidate specs on the `build:checked` output 19 / 19; after
  `npm run build:e2e`, critical E2E 101 / 101, the ten YouTube Chromium specs 53 / 53 (the plan's
  eight 41 / 41), the WebKit YouTube activation spec 4 / 4, the contrast, design system page,
  events and auxiliary component specs 24 / 24 and the seven selection-mode playlist specs 32 /
  32; the deploy target App 18 paths (the 14 above and the four version mirrors), every other
  Worker 0, no dependency change, the partial-release compatibility check compatible with the
  deployed SHAs injected instead of read from production, and the contract paths changed only in
  the bump's seven lines; and the first load against a clean rebuild of `a92bab2b`, +30 B eager
  JavaScript gzip, within round 11's +38 B. QA round 13 applied the documentation findings of the
  review after the bump (eleven, one medium: the release record's 9.0.33 rollback item now links
  this report; the file count, the closed 6C-3 branch, the not-blind owner check G, the events page
  missing from the owner's pictures, the owner-facing rollback sentence and stale lines), left two
  low ones for later (an events-page high-contrast palette and a test pinning the light
  `--glass-border`), and reran the checks that read the changed documents. Earlier,
  on `7b869c35`'s line: on `6998f04e`, the unit suite 750 files / 17,973 (one
  git-fixture timeout that passes alone), `src/youtube`, `src/player` and `src/pro-room` 6,693
  rows in file order and under four `--sequence.shuffle` seeds, critical coverage 110 files /
  4,496, the Phase 7 audio lab 17 / 17, the eight YouTube Chromium specs 41 / 41, critical E2E
  101 / 101 and the WebKit activation spec 4 / 4; on the code tip `a9951bfd`, those three
  directories with the guard self-test 6,801 / 6,801, the neutral pins on main's runtime 127 / 127
  and Phase 7 T0's rows with the contract rows 474 / 474; and the final check (QA round 8) on
  `f9f4a57c`, the unit suite 750 files / 17,983, those directories with `src/audio` 7,147 rows in
  file order and under the four seeds, critical coverage 110 files / 4,501, every guard except
  `guard:sw-cache-version`, critical E2E 101 / 101, the ten YouTube specs 53 / 53 and the WebKit
  activation spec 4 / 4.
- [App Hangul drawn by Pretendard again, as MUSIXQUARE Hangul (2026-11-02)](design/app-hangul-pretendard-2026-11-02.md):
  released on 2026-11-02 13:12 KST in Release 41386906358 (PR #560, squash `4faf38d9`) as App
  9.0.33 / v806 (App build 806, target `app`, one update dialog, visible change; the bump
  `d78d0d41` is the last runtime commit, followed only by the QA round 3 record commit);
  `raise_app_build_floor` false, Developer API D1 false. Only the App Worker changed (`e19b7085` to
  `047e6f68`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22 versions, and
  the build floor stays 795. Built and QA'd locally
  on branch `agent/hangul-pretendard` over main `7d60f134` (App 9.0.32 / v805's release record)
  and moved with every patch unchanged onto main `7b869c35` (#559, tests only), whose App runtime
  is production 9.0.32's. The owner decided on 2026-11-02, without a picture comparison, that
  Pretendard draws the app's Hangul again for its Hangul spacing; Inter keeps Latin and digits,
  Noto keeps Han, kana and the 98 Hangul characters Pretendard lacks that its sheet declares. 87
  harfbuzz subsets of the repository's Pretendard Variable 1.309 (`fonts/app/hangul/`, 11,277
  code points, 2,506,376 B, recorded in `fonts/hangul-faces.json`, which now also refuses a
  changed source file) keep the whole wght axis, Pretendard's outlines and its own line box
  (1950 / 494 / 0 of 2048, now `HANGUL_LINE_BOX`), which their sheet also states as descriptors,
  carry no layout feature, and are named MUSIXQUARE Hangul because Pretendard is a Reserved Font
  Name. They sit right after Inter in every stack of every UI; the Noto Sans KR sheet drops from
  120 faces to 53. Line boxes, Latin and Han sizes and tab titles measure as in 9.0.32 in
  Chromium, Hangul lines match Latin ones within 1/64 px in a WebKit that applies the overrides,
  and the 14.5 px Hangul line without overrides (Safari's reading) is now 17 px, not 18. The
  Korean start screen fetches 289,888 B instead of 249,124 B, 433,132 B instead of 466,104 B with
  the idle prefetch. `fonts/PretendardVariable.woff2` now stays as the faces' source. Against the
  deployed SHAs the change touches 165 App runtime paths before the bump (169 with the version
  mirrors) and none in the other five Workers. Section 11 maps the moved commits, describes the
  release-preparation record and the bump to 9.0.33 / v806 as the last runtime commit (the same
  seven lines in the same six files as the 9.0.32 bump), and records QA round 3, the full local
  gate on the bump `d78d0d41`, which passed (the unit suite's load and git-fixture timeouts each
  passed alone), in a documentation commit after the bump. QA round 4 (section 11.5) records the
  release: the PR CI on head `bd704404` passed all 11 jobs on its first run, the automated review
  requested on the PR ended with no findings, the merge used the prepared squash body (parent
  `7b869c35`, tree equal to the head), the exact-main CI passed (critical coverage 106 files /
  4,279 tests, the production candidate 19 / 19 and critical E2E 101 / 101 on Linux, release
  identity 9.0.33 / v806), the public floor read just before dispatch showed stored and effective
  795 with an App report about 58 s old, one Production Release passed every smoke on the first
  try (1,274 release files; checkpoint artifact 13115751050 with the 9.0.32 App `e19b7085`; the
  entry chunk `main-jGfUMtkO.js` has 9.0.32's size), the public service worker read v806,
  `index.html` loads bootstrap v806 and the floor read 795 with live App 806, the production
  Hangul sheet carries the 87 faces with their descriptors and its shard #110 matches
  `fonts/app/hangul/` byte for byte, the Drift Audit reported 32 pass / 0 fail / 5 manual-only, and
  the post-merge Full E2E 41387172877 on `4faf38d9` failed: of the 813 `e2e` rows 812 passed on Linux Chromium, among them the train's other 51 font, tab header and playlist rows, and the `font-line-boxes` WebKit row failed before opening a page because the Linux WebKit binary rejected the Chromium launch flag `--use-fake-device-for-media-stream` that the Playwright config passes (`webkit-mobile` 94 passed and 5 skipped plus the production service worker test; the production large-room R2 smoke passed). That was a test-environment fault, not the App: tests-only #561 (squash `6ccc3f10`, 2026-11-02 14:49 KST) launches that row with `args: []`, and the Full E2E 41396274966 on main `6ccc3f10` (the 9.0.33 runtime) passed at 16:06 KST (`e2e` 813 passed, among them that WebKit row and the train's 52 font, tab header and playlist rows; `webkit-mobile` 94 passed and 5 skipped plus the production service worker test; the production large-room R2 smoke passed). That was the previous-train run 6C (9.0.34 / v807) needed before it merged; 6C merged with the two light-theme changes at 21:06 KST the same day and shipped as 9.0.34 at 21:20 KST. The record is built on `6ccc3f10`. The release owner opened only
  the Korean start screen in production desktop Chromium (not blind): no request names
  pretendard, eleven MUSIXQUARE Hangul shards load, a Hangul heading's font stack starts Inter,
  MUSIXQUARE Hangul, Noto Sans KR, and the Hangul draws in Pretendard's shapes; the owner's iPhone
  Safari checks wait for the owner. The release record's §2 carries the train as post-deploy items
  (scope and status, the owner decision and delegation, rollback, the post-deploy check, the next
  steps with 6C, open items with the public-page font train's changed direction: Inter,
  MUSIXQUARE Hangul and Noto, keeping the Pretendard source file), the 9.0.31 section's 14.5 px CJK
  residual is gone for Hangul (kana and Han keep it), its §4 the 9.0.33 entry and current boundary
  line (5), and the hotfix procedure's 9.0.25 bullet names 9.0.33's merge SHA, Release ID and App
  version. The rollback boundary is a forward revert at 9.0.46 / v821 or later now that 9.0.34 to
  9.0.41 shipped; the train could be reverted alone only until 6C (9.0.34 / v807) merged, which happened
  at 21:06 KST the same day, so a fix now goes forward, and its own merge had ended 6B's
  standalone revert window; a manual rollback to the checkpoint's 9.0.32 App restores a lower
  epoch and removes 9.0.34 to 9.0.41 too, so until the open lower-epoch rule is decided it is only an explicitly reviewed CLI
  rollback. Release-note line: tabs still on 9.0.32 or earlier draw Hangul they have not loaded
  yet from the 67 removed KR shards with a device font until they reload. The report lists the
  owner questions (the name, a byte option, the public-page font train), shipped with their
  defaults.
- [Phase 6 train 6B: one YouTube start ledger and its readers (2026-11-01)](design/phase6-6b-start-ledger-readers-2026-11-01.md):
  released on 2026-11-02 05:34 KST in Release 41347347201 (PR #557, squash `3ea689b9`) as App
  9.0.32 / v805 (App build 805, target `app`, one update dialog, the second of the four Phase 6 App
  updates; the bump `582ab9d9` is the last runtime commit, followed only by three record and
  documentation commits); `raise_app_build_floor` false, Developer API D1 false. Only the App
  Worker changed (`dff554a2` to `e19b7085`); the PRO room Worker keeps R4's `e7657f88`, the other
  four their 9.0.22 versions, and the build floor stays 795. Built as
  fifteen commits on main `dda3ee18` (after the tests-only T0b pull requests #552 and #553 and
  #554, on the 9.0.30 release record), then moved with every patch unchanged onto main
  `ba28943e`, the merge of App 9.0.31 / v804, which the owner chose to ship first and which went
  out at 23:17 KST on 2026-11-01. On top came the design doc's gap list aligned with the owner's
  rewritten T0b defect list, the record of the move, the release record's pre-deploy item, the
  bump to 9.0.32 / v805 as the last runtime commit (the same seven lines in the same six files as
  the 9.0.31 bump) and a record commit. Those twenty commits were moved again, every patch
  unchanged, onto main `5a705c40`, 9.0.31's release record (#556, documentation only), where the
  bump is `582ab9d9` (before the move `8823a591`, the same tree outside `docs/`), and a record of
  that move and a documentation commit with review fixes follow: twenty-two commits on
  `5a705c40`. 6B-1 adds the start ledger
  `src/youtube/start-ownership.ts`, which answers its readers from the live queries `player.ts`
  registers for each start owner and keeps no answer, subscription or event; 6B-2 moves all 24
  start-ownership reader sites in eight modules onto it and deletes `isYouTubeZeroStartSyncOwned`
  (`zero-start-ownership.ts`) and the runtime bridge's two recovery hooks; two guard follow-ups make
  CHECK 12 count start claims per statement (one entry, the seek's mid-sync check, pinned to its two
  claims), the run's snapshot reads (8) and facade uses (2), keep the ledger pure, require
  `player.ts` to register every claim kind a derived query decides and fail start timers named
  outside `src/youtube/`; tests-only commits pin five readers in a Standard guest's calibration
  window and load `player.ts` in the shared `beforeEach` of two suites whose rows depended on test
  order. Neutral: the T0a goldens and the two T0b truth tables (81 rows) pass byte for byte, 6B
  edits 12 of T0b's 20 files only at their seams (the sampler's fallbackPending column is an accepted
  narrowing), and the wire, the readiness emitters and the 9.0.8 host speaker reference are
  unchanged. The owner has not answered the four T0b defect questions, so no defect fix rides here;
  the fourth (a host pause sometimes reaching guests twice, rows H10, H10a and H10c), recommended for
  6B, stays unbuilt. The report lists the owner answers and delegation used, each increment's
  tests-first evidence and the mutation checks, the guard counts, mixed versions, the D4 re-measure
  (RO-05 and RO-48 unchanged), the blind device candidates and rollback (alone until the next App update merges, which became 9.0.33;
  the checkpoint is App 9.0.31 / v804). QA rounds 1 to 5 ran before the move (the last on
  `e5851cd0`: unit suite 739 files / 17,704, shuffle seeds, types, lint and format, every guard but
  `guard:sw-cache-version` for the pending bump, critical coverage 99 files / 4,051 and Worker
  coverage 69 / 3,325, critical E2E 101 / 101 and the ten local YouTube specs 53 / 53). Round 6, on
  the moved commits, maps every old SHA to its new one: each tests-first commit fails the same rows
  by name on its new parent and its code commit passes, the order-fix seeds match, `src/youtube`,
  `src/player` and `src/pro-room` (239 files / 6,515) pass in file order and under seeds 3, 7 and
  4242, the 51 T0a and T0b files pass, the target is `app` (11 App runtime paths against production
  9.0.31, none in the other five Workers) and the first load is 34 B of eager JavaScript gzip and
  31 B of eager total below 9.0.31 (Phase 6 total −183 B). Round 7 ran the full local gate on the
  bump `8823a591`: types, lint and format, `build:checked` with `guard:sw-cache-version` passing for
  v805 and `guard:release-identity` 9.0.32 / v805, all 37 guards and the ownership guard, critical
  coverage 99 files / 4,051 and Worker coverage 69 / 3,325, the unit suite 741 files / 17,727 (two
  git-fixture rows that timed out under load pass with their files run alone, 158 / 158), critical
  E2E 101 / 101, the ten local YouTube specs 53 / 53 and the production candidate 19 / 19; the
  first load stays within 6B's measured delta (eager JavaScript −35 B and eager total −33 B gzip
  against `ba28943e`) and the target is `app` (15 App runtime paths with the version mirrors, none
  in the other five Workers, partial-release compatibility compatible against the deployed SHAs).
  Round 8 moved the train onto `5a705c40` (the one conflict was the release record in the commit
  that adds 6B's pre-deploy item; both sides kept) and reran on the moved head types, lint and
  format, `build:checked`, every guard (`guard:sw-cache-version` passing for v805 at `582ab9d9`),
  the ownership guard (49 / 457) and the 56 6B, T0a and T0b test files (2,554 / 2,554); the first
  load is byte for byte round 7's. 9.0.31's post-merge Full E2E 41315565486
  on `ba28943e` passed (finished at 00:29 KST on 2026-11-02), so the two merge conditions the release
  record's §2 item for 6B set (that run, and the move onto 9.0.31's release record) were met. QA
  round 9 records the release: the PR CI on head `415f77be` passed all 11 jobs on its first run, the
  automated review requested on the PR ended with no findings, the merge used the prepared squash
  body (parent `5a705c40`, tree equal to the head), the exact-main CI passed (critical coverage 99
  files / 4,051 tests, the production candidate 19 / 19 and critical E2E 101 / 101 on Linux,
  release identity 9.0.32 / v805), the public floor read just before dispatch showed stored and
  effective 795 with an App report about 21 s old, one Production Release passed every smoke on
  the first try (1,253 release files; checkpoint artifact 13099442949 with the 9.0.31 App
  `dff554a2`; the entry chunk `main-FMXWdlb7.js` matches round 8's local build by name and size),
  the public service worker read v805 and the floor 795 with live App 805, the Drift Audit
  reported 32 pass / 0 fail / 5 manual-only, and the post-merge Full E2E 41347667125 on
  `3ea689b9` passed (`e2e` 812 on Linux Chromium, among them the ten YouTube specs, 53 rows; `webkit-mobile` 94 passed and 5 skipped plus the production service worker test; the production large-room R2 smoke), the previous-train run the next train needed before it merged; that train became the Hangul one above (9.0.33, 2026-11-02 13:12 KST), not 6C. The blind device candidates (a desktop Chrome host and an
  Android Chrome guest: Sync right after a zero-start, the zero-start debug lines, seek and volume
  right after a start) wait for the owner's return and now run on 9.0.41: 9.0.33, 9.0.36, 9.0.37, 9.0.38, 9.0.39, 9.0.40 and 9.0.41 left the YouTube start code alone (9.0.39's 7B changes rare recoveries of the shared audio context and 9.0.41's 7C moves that recovery code behind one owner, not the recovery while YouTube plays), and 9.0.34's 6C and 9.0.35's 6D rebuilt the start paths and recoveries neutrally on 6B's ledger, so the candidates now also pass through 6C and 6D. The owner has not answered the four T0b defect
  questions, so the fourth stays unbuilt. The release record's §2 carries the train as post-deploy
  items (scope and status, the owner answers and the delegation, the T0b defect list, rollback,
  the blind post-deploy check, the next steps with 6C and its 6C-3 table for the owner, open
  items), its §4 the 9.0.32 entry and current boundary line (5), and the hotfix procedure's 9.0.25
  bullet names 9.0.32's merge SHA, Release ID and App version. The rollback boundary is a forward
  revert at 9.0.46 / v821 or later now that 9.0.33 to 9.0.45 shipped; 6B could be reverted alone only until
  the next App update merged, which became 9.0.33 (`4faf38d9`, 2026-11-02 12:59 KST) rather than
  6C, so a fix now goes forward on the latest main; 6B's own merge had ended the standalone revert
  windows of 9.0.31 and 6A; a manual rollback to the checkpoint's 9.0.31 App restores a lower
  epoch and removes 9.0.33 to 9.0.41 too, so until the open lower-epoch rule is decided it is only an
  explicitly reviewed CLI rollback.
- [App font line box baked into the font files, and every tab title on one baseline (2026-11-01)](design/app-font-baked-metrics-2026-11-01.md):
  released on 2026-11-01 23:17 KST in Release 41315218029 (PR #555, squash `ba28943e`) as App
  9.0.31 / v804 (App build 804, target `app`, one update dialog; the bump `566f458d` is the last
  runtime commit, followed only by two record commits), ahead of Phase 6 6B (which follows as
  9.0.32 / v805); `raise_app_build_floor` false, Developer API D1 false. Only the App Worker changed
  (`50e0527d` to `dff554a2`); the PRO room Worker keeps R4's `e7657f88`, the other four their
  9.0.22 versions, and the build floor stays 795. One App train on main `dda3ee18`, with the bump
  to 9.0.31 / v804 as its last runtime commit. Safari
  applies `size-adjust` but not the three metric overrides that keep the 9.0.29 font switch's line
  boxes, so on the owner's iPhone a 15 px Hangul line was about 20 px high instead of 18 px and,
  with several playlists, the Playlist title sat higher than the other tab titles. The owner chose
  on 2026-11-01 to fix it at the root, with no CSS `line-height` patch, and to ship it. First
  increment (the 9.0.29 report's question 8): every Inter and CJK face the app sheets keep (Inter
  7, Noto Sans KR 120, JP 120, SC 95, TC 98) is served from a copy in `fonts/app/` with the box of
  `src/i18n/font-metrics.ts` in `hhea` and the OS/2 typo metrics and `USE_TYPO_METRICS` set (Inter
  2006 / 508 / 0 of 2048 units, CJK 1013 / 257 / 0 of 1000), the win metrics, every other byte and
  the inputs unchanged; `npm run generate:app-faces` bakes, checks and records them in
  `fonts/app-faces.json`, and the font guard checks the copies. The sheets keep their descriptors
  (option K), so Chromium draws as before (Firefox applies the same descriptors and is expected to
  follow, but was not measured), and a line next to a pixel rounding boundary (a CJK line at
  14.5 px, some `clamp()` window bands) still differs by 1 px between Safari and Chromium. In
  Safari 15 and 16 and the webOS TV legacy build, which ignore `size-adjust` too, CJK lines come
  nearer the shipped box but Latin-only lines get 1 or 2 px taller at 34 of the 81 half-pixel sizes
  from 8 to 48 px. Second increment, `css/style.css` only: the Playlist switch button takes the
  title's line from the tab header row like the other tabs' titles, delete mode keeps that row,
  and the second playlist's number sits on its name's baseline, so in the 14 languages whose title
  line is taller than 36 px (Arabic, Urdu, Persian, Thai, Kannada, Telugu, Hindi, Marathi, Bengali,
  Gujarati, Punjabi, Malayalam, Hebrew, Tamil) the Playlist title moves down 0.5 to 4 px onto the
  other titles' baseline. Tests first for each fix. QA rounds 1 to 3 (the font increment) and T (the
  tab header increment) ran before the two were moved onto main `dda3ee18`, on commits whose diffs
  are byte-identical to this train's (the report maps the old SHAs to the new); round 4, on the
  combined code head `66c09b73`, reran the tests-first checks on their new parents, the font, tab
  header and playlist specs, critical E2E, typecheck, lint, format, every guard (all pass but
  `guard:sw-cache-version`, for the missing bump), the `build:checked` steps and the full unit
  suite, and swept all 42 languages at 402 x 874 and 1440 x 900: the Playlist minus Connect
  (desktop: Settings) title baseline is 0 everywhere in shipped Chromium and with the overrides
  removed as Safari reads the sheets, and the 28 other languages are pixel-identical to main in
  Chromium on the four tab headers, the start screen, the Playlist tab and the chat.
  `e2e/font-line-boxes.test.ts` opens the Korean UI only; the other UIs rest on the report's
  measurements and the sweep. Round 5 ran the full local gate on the bump
  `566f458d`: typecheck, lint, format, `build:checked` with `guard:sw-cache-version` passing for v804
  and `guard:release-identity` 9.0.31 / v804, all 37 guards and the ownership guard, the production
  candidate 19 / 19, critical coverage 94 files / 3,763 and Worker coverage 69 / 3,325, the unit suite
  739 files / 17,666 (one git-fixture row that timed out under load passes with its file run alone),
  critical E2E 101 / 101 and the font, tab header and playlist specs 51 / 51. Against origin/main the
  first load grows only within its CSS (eager total +303 B raw and +32 B gzip, the CSS +303 B and
  +56 B; entry and eager JavaScript do not grow), and the release target is `app` (453 App runtime
  paths with the version mirrors, none in the other five Workers, no App runtime dependency change). The release owner kept option K and queued option D (drop the overrides,
  which moves boundary-size lines by 1 px in Chromium) for the owner with pictures, accepted the
  repository growth (about 17.7 MB) and the JP, SC and TC files About and the app no longer share
  until the public-page font train, and leaves tabs open at release to the ignore-old-versions
  policy. QA round 6 records the release: the PR CI on head `ad8dda80` passed all 11 jobs on its
  first run, the automated review requested on the PR ended with no findings, the merge used the
  prepared squash body (parent `dda3ee18`, tree equal to the head), the exact-main CI passed
  (critical coverage 94 files / 3,763 tests, the production candidate 19 / 19 and critical E2E
  101 / 101 on Linux, release identity 9.0.31 / v804), the public floor read just before dispatch
  showed stored and effective 795 with an App report about 52 s old, one Production Release passed
  every smoke on the first try (1,253 release files; checkpoint artifact 13086827457 with the
  9.0.30 App `50e0527d`), the public service worker read v804 and the floor 795 with live App 804,
  the production Korean app sheet keeps the four descriptors and its first shard is byte-identical
  to the baked copy, the Drift Audit reported 32 pass / 0 fail / 5 manual-only, and the post-merge
  Full E2E 41315565486 on `ba28943e` passed (`e2e` 812 on Linux Chromium, among them the font, tab header and playlist specs; `webkit-mobile` 94 passed and 5 skipped plus the production service worker test; the production large-room R2 smoke), the previous-train run 6B needs before it merges. QA round 7, added by the 9.0.32 record, measured
  the owner's iPhone screenshots (2026-11-02 06:43 KST, 402 x 874 @3x, Korean UI, not committed):
  with several playlists the four tab titles sit at one height (Playlist minus the others 0.00 px,
  the same as shipped Chromium; on 9.0.30 the Playlist title sat 1.33 px higher). The iOS version
  and the app build were not recorded. The rest of the iPhone check (the second playlist's number,
  the 15 and 13 px Korean line heights, whether the baseline is whole or fractional) and the
  tall-script language on Android or desktop Chromium, the second blind check, are still to do. The release record's §2 carries the train as post-deploy items (scope and
  status, the owner decision and the release owner's answers, rollback, the blind post-deploy check,
  the next steps with 6B, open items), its §4 the 9.0.31 entry and current boundary line (5), and
  the hotfix procedure's 9.0.25 bullet names 9.0.31's merge SHA, Release ID and App version; the
  9.0.29 report's device check links this report. 6B then shipped as 9.0.32 / v805 (2026-11-02
  05:34 KST, entry above), which changes neither the fonts nor the CSS, and the Hangul train as
  9.0.33 / v806 (13:12 KST, entry above), which keeps the line box and the tab header CSS and changes
  only the Hangul faces, and the 9.0.34 / v807 train (21:20 KST, entry above), 9.0.35 / v808 (6D,
  2026-11-03 16:40 KST, entry above), 9.0.36 / v809 (the public pages and the sign-in
  completion window only, 22:22 KST, entry above), 9.0.37 / v810 (the input fields, the `/debug sync` count lines and
  the iPhone guest's YouTube return, 2026-11-04 13:51 KST, entry above) and 9.0.38 / v811 (the owner's UI tidy, 2026-11-05 06:14 KST, entry above) leave the app's fonts, line box and tab header
  alone, 9.0.39 / v812 (2026-11-05 21:22 KST, entry above) only maps the digits in the Inter latin face to Inter's
  tabular glyphs and leaves the line box, the tab header and the Hangul faces alone, and 9.0.40 / v813 (2026-11-06 14:53 KST, entry above) changes only the public pages' Korean tracking and the demo step label's opening, and 9.0.41 / v814 (2026-11-11 01:14 KST, top entry) changes neither the fonts nor the CSS, so the blind checks now run on 9.0.41 (the tab's
  number '2' is now Inter's tabular '2') and the Korean line heights now
  measure MUSIXQUARE Hangul. The rollback boundary is a forward revert at
  9.0.46 / v821 or later now that 9.0.32 to 9.0.45 shipped; the train could be reverted alone only until the next App update (6B)
  merged (`3ea689b9`, 2026-11-02 05:21 KST), so a fix now goes forward on the latest main, refitted over 9.0.33, which changed the same KR sheet and baked KR copies; a manual rollback to the checkpoint's 9.0.30 App
  restores a lower epoch and removes 6B and 9.0.33 to 9.0.41 too, so until the open lower-epoch rule is decided it is only an explicitly
  reviewed CLI rollback.
- [Phase 6 train 6A: one YouTube start timing home, owner queries for the start timers and one verified iframe audio restore (2026-10-31)](design/phase6-6a-start-constants-owner-queries-2026-10-31.md):
  released on 2026-11-01 05:17 KST in Release 41237978646 (PR #550, squash `3c098e9d`) as App
  9.0.30 / v803 (App build 803, target `app`, one update dialog; the bump `8d148fff` is the last
  runtime commit, followed only by two record commits). Only the App Worker changed (`f9c684cb` to
  `50e0527d`); the PRO room Worker keeps R4's `e7657f88`, the other four their 9.0.22 versions, and
  the build floor stays 795. The first Phase 6 App
  update (owner answers of 2026-10-30, all recommended: four App updates, each audio restore keeps
  its own rhythm, the deferred app part of Phase 0d rides in this train, a test that reproduces a
  defect pins today's behaviour) on branch `agent/p6-6a`, 21 commits plus three record commits (24
  in all), built on main `599465dd` and moved with every patch unchanged onto main `9e68a7a3`
  (after the 9.0.28 release, its record and the remaining test-order fix), then two record commits
  for the move and the release record's pre-deploy entry. The owner chose to ship the app font
  switch first (evening of 2026-10-31), so it went out as 9.0.29 / v802, and the 26 commits moved
  again, every patch unchanged, onto that release's record `e51dd292` (report QA round 7: every
  tests-first pair fails the same rows by name on its new parent, `src/youtube` and
  `src/pro-room` pass in file order and under seeds 7 and 4242, the T0a goldens pass, and the
  first load is 154 B of eager JavaScript gzip and 152 B of eager total below 9.0.29). The owner
  left at about 23:20 KST for about 40 hours with releases and tests delegated, which for that time
  replaces the rule that Phase 6 trains ship only while the owner is awake. On top come the record
  edits the bump carries (the order and Q6 sentences, the 9.0.22 item's C2-1 clause, the Android
  mixed-version sentence, the registry's release-batching sentence for Phase 6), the comment-only
  R4-Q3 fix in `src/pro-room/snapshot.ts` that Phase 5.5 R4 left for the next App update (`5b7f7e84`,
  production build byte-identical), and the bump `8d148fff` to 9.0.30 / v803 as the last runtime
  commit, followed by two record commits (33 commits on `e51dd292`). QA round 8 ran the full local
  gate on the bump: types, lint, format, `build:checked` with `guard:sw-cache-version` passing for
  v803, all 37 guards, the production candidate 19 / 19, critical coverage 94 files / 3,763 and Worker
  coverage 69 / 3,325, the unit suite 735 files / 17,540 (two git-fixture rows that time out under
  load pass with their files run alone), critical E2E 101 / 101 and the eight YouTube specs 41 / 41,
  then `check:workers` and the Worker bundle dry-runs on the same runtime tree; the release target
  is `app` (18 App runtime paths, none in the other five Workers) and the first load is 144 B of
  eager JavaScript gzip and 141 B of eager total below 9.0.29.
  6A-1 replaces the cross-file reads of the start timers' names with owner queries
  (`isYouTubeAutoSyncPending` through the player runtime bridge, and a query `sync.ts` registers
  with the native-control authority; the PRO coordinator nudge is still read by name). 6A-2 drops
  one direct timer clear that `resetYouTubeSyncState` repeats and a clear of a timer nothing sets.
  6A-3 moves the shared start timing into `src/youtube/constants.ts` (C2-1), with a parity suite
  that drives the real zero-start sender to each edge the frozen receiver takes. 6A-4 runs the six
  YouTube audio restore loops through one verified restore in the new `src/youtube/iframe-audio.ts`
  (RO-12), keeping both cadences and every fence, check, outcome, timer key and log line. Every T0a
  golden and pinned row passes unchanged, and the wire is unchanged. Each tests-first commit was
  rerun on its parent's runtime (only the changed rows fail), and the review's tests-only rows
  also pass on the pre-6A runtime. Guard baselines fall in the commits that move the counted code:
  CHECK 11 44 to 32, CHECK 12 reads 14 to 11 and clears 10 to 9 (CHECK 12 now counts each start
  timer a call covers), CHECK 5 copies 2 to 1. Before the bump, target `app` (13 App runtime
  paths, none in the other five Workers, no runtime dependency change) and
  `guard:sw-cache-version` failed only for the missing bump. 6A-3's object-shaped homes took the
  eager JavaScript 237 B gzip over the base, past the
  Phase 6 cap of +200 B, so a size follow-up (the report's recommended answer to its owner question)
  makes each start timing its own named export, with the same values and readers: the eager
  JavaScript is now 149 B gzip below the base (eager total 152 B; 114 B for both against
  `9e68a7a3` after the move). The plan's shared player-state
  names stay out of this branch, as recommended, for a later train. After the follow-up's review,
  CHECK 5 again catches a re-typed timing object beside the scalar home and checks each of its
  values by name whatever the suffix (guard only, no baseline change). It lists the QA rounds (unit
  suite 727 files, 17,218 passed and one environment skip; `src/youtube` clean under four shuffle
  seeds, while two untouched `src/pro-room` files fail the same rows on the base; critical and
  Worker coverage, every guard, and local Playwright: critical 100 / 100 and the eight YouTube
  specs 41 / 41; for the follow-up, `src/youtube` 1,907 / 1,907 in file order and under the same
  four seeds, the guards, types, lint and format; for its review, the guard suite 72 / 72, of which
  2 fail on the parent guard; after the move, every tests-first pair fails the same rows by name on
  its new parent, `src/youtube` and `src/pro-room` pass in file order and under the four seeds, and
  the T0a goldens pass), mixed versions, the rollback (alone only until 6B merges, then a forward
  revert) and a blind post-deploy check. QA round 9 records the release: before the PR opened, the
  9.0.29 runtime's Full E2E (41229806902 on main `e51dd292`) passed, which also closed the release
  record's chat Tab cycle item; the PR CI on head `a530f45e` passed all 11 jobs on its first run,
  the automated review that opening the PR started ended with no findings, the merge used the
  prepared squash body (parent `e51dd292`, tree equal to the head), the exact-main CI passed
  (critical coverage 94 files / 3,763 tests with `iframe-audio.ts` fully covered, critical E2E
  101 / 101 on Linux), the public floor read just before dispatch showed stored and effective 795
  with an App report about 46 s old, one Production Release passed every smoke on the first try
  (checkpoint artifact 13055689762 with the 9.0.29 App `f9c684cb`), the public service worker read
  v803 and the floor 795 with live App 803, and the Drift Audit reported 32 pass / 0 fail / 5
  manual-only. The owner was away, so the blind post-deploy device check has not run, the
  pre-Phase-6 device baseline (Q6) was not measured (its procedure waits in the owner's private
  question queue), and 6A's own post-merge Full E2E had not run yet; it must pass before 6B merges.
  It ran after that record: 41242666474 on `3c098e9d` failed two playlist rows on a test race that
  the tests-only #554 fixed, and 41278378387 on `dda3ee18` (the 9.0.30 runtime plus tests) passed
  before the 9.0.31 train merged (entry above), whose own post-merge Full E2E then passed before 6B
  merged and shipped as 9.0.32 / v805 (2026-11-02 05:34 KST, entry above); the blind device check
  now runs on 9.0.41 (2026-11-11 01:14 KST, top entry; 9.0.33, 9.0.36, 9.0.37, 9.0.38, 9.0.39, 9.0.40 and 9.0.41 left the YouTube start code alone and
  9.0.34's 6C and 9.0.35's 6D rebuilt the start paths and recoveries neutrally, so the check now
  also passes through 6C and 6D).
  The release record's §2 carries the train as post-deploy items (scope and status, the owner
  answers and the delegation, Q6, rollback, the post-deploy check, the next Phase 6 steps T0b and
  then 6B, open items), its §4 the 9.0.30 entry and current boundary line (5), and the hotfix
  procedure's 9.0.25 bullet names 9.0.30's merge SHA, Release ID and App version. The rollback
  boundary is a forward revert at 9.0.46 / v821 or later now that 9.0.31 to 9.0.45 shipped; a manual rollback
  to the checkpoint's 9.0.29 App restores a lower epoch (and removes 9.0.31 to 9.0.41 too), so until the open lower-epoch rule is decided it is only an
  explicitly reviewed CLI rollback, and 6A could be reverted alone only until 6B merged (`3ea689b9`,
  2026-11-02 05:21 KST), so it now reverts forward together with every later train.
- [App font switch to Inter and Noto, owner decisions (2026-10-31)](design/app-font-inter-noto-2026-10-31.md):
  released on 2026-10-31 23:39 KST in Release 41210993444 (PR #548, squash `c4667abc`) as App
  9.0.29 / v802 (App build 802, target `app`: App runtime paths only, no other Worker, no runtime
  dependency change; update dialog; the version bump `3fc54970`, the content of round 8's
  `9b93c5b3`, is its last runtime commit, followed only by docs commits). Only the App Worker
  changed (`89ad188d` to `f9c684cb`); the PRO room Worker keeps R4's `e7657f88`, the other four
  their 9.0.22 versions, and the build floor stays 795. The new third-party assets are the
  self-hosted Inter 4.001 and Noto Sans KR 2.004 files with their SIL OFL 1.1 licenses. Built on
  the branch `agent/font-switch`, rebased onto main `9e68a7a3` (App runtime equal to 9.0.28 / v801
  `aa7baad5`). The owner saw the
  final pictures and on the evening of 2026-10-31 chose to release it now as the next App update,
  ahead of Phase 6 6A, and moved the iOS 17 and 18 Safari line-height check from a release gate to
  the first check after the release because no iPhone was at hand. The release owner applied the
  recommended answers to the other owner questions, which the owner can reverse: the rare symbols
  that still draw differently in the Korean and English UIs are accepted for now with no symbol
  face download, the design-system page's wider English samples are accepted, and baking the
  line-box values into the font files waits on the iPhone check. The owner left at about 23:20 KST
  for about 40 hours with releases and tests delegated, so none of the checks after the release has
  run yet; Phase 6 6A then shipped as 9.0.30 / v803 (entry above, 2026-11-01 05:17 KST), which changes
  neither the fonts nor the CSS, so they ran on 9.0.30; the line box train then shipped as
  9.0.31 / v804 (entry above, 2026-11-01 23:17 KST), which answers question 8 by baking the line box
  into the font files, so the iPhone line-height check continues as that train's first blind check
  and the other checks now run on 9.0.41 (9.0.32 / 6B, 2026-11-02 05:34 KST, changes neither the fonts nor the CSS; 9.0.33, 13:12 KST, draws Hangul with MUSIXQUARE Hangul again and keeps the line box; 9.0.34, 21:20 KST, changes the YouTube start internals and two light-theme colors and leaves the fonts and the line box alone; 9.0.35, 2026-11-03 16:40 KST, changes the YouTube start recoveries, the late PRO join's catch-up and the mute rule below 0.5 % and leaves the fonts and the CSS alone; 9.0.36, 22:22 KST, changes only the public pages and the sign-in completion window; 9.0.37, 2026-11-04 13:51 KST, changes the input fields, the `/debug sync` count lines and the iPhone guest's YouTube return and leaves the font files, the font sheets and the line box alone; 9.0.38, 2026-11-05 06:14 KST, changes the demo tour's wide text sizes, the chat '#1', the `/debug` COPY row and the phone start screen's scroll area and leaves the fonts and the line box alone; 9.0.39, 21:22 KST, maps the digits 0 to 9 in the app's Inter latin face to Inter's tabular glyphs, changes the demo step buttons and rare audio recoveries, and leaves the line box and the Hangul faces alone; 9.0.40, 2026-11-06 14:53 KST, changes only the public pages' Korean tracking and the demo step label's opening; 9.0.41, 2026-11-11 01:14 KST, moves the audio recovery code behind one owner and changes neither the fonts nor the CSS; all three leave the app's fonts and line box alone). The release record's §2 now carries the switch as post-deploy items (scope
  and status, the checks after the release with the iPhone line-height check first, the open rule
  for manual App rollbacks to a lower epoch, and the later
  train that moves the public pages to the app fonts, since 9.0.33 Inter, MUSIXQUARE Hangul and Noto, keeping `fonts/PretendardVariable.woff2` as the Hangul faces' source), its §4
  the 9.0.29 entry and current boundary line (5) (checkpoint artifact 13045399758, App 9.0.28
  `89ad188d`), and the hotfix procedure's 9.0.25 bullet names 9.0.29's merge SHA, Release ID and
  App version. The rollback boundary is a forward revert at 9.0.46 / v821 or later now that 9.0.30
  to 9.0.41 shipped; the report
  allows a CLI rollback of the App Worker only in the first minutes, before clients take the new
  service worker, and forbids restoring a lower epoch, while the hotfix procedure allows an
  explicitly reviewed CLI rollback to a saved version. A manual rollback after those minutes to a
  checkpoint App below v802 (9.0.28 `89ad188d`, or the 9.0.28 and 9.0.27 entries' urgent targets
  `e3457d38` and `b8dc4281`) is therefore an open item for the owner or release owner; until they
  decide, the record follows the hotfix procedure: a code revert at 9.0.46 / v821 or later when
  not urgent, and only an explicitly reviewed CLI rollback when urgent. Since 9.0.30 shipped, its
  checkpoint App (9.0.29 `f9c684cb` at v802) is a lower-epoch target under the same rule, and since
  9.0.31 shipped, so is its checkpoint App (9.0.30 `50e0527d` at v803), and since 9.0.32 shipped, so is its checkpoint App (9.0.31 `dff554a2` at v804), and since 9.0.33 shipped, so is its checkpoint App (9.0.32 `e19b7085` at v805). The app draws with
  self-hosted Inter 4 (Latin, Cyrillic, Greek) and Noto (Noto Sans KR v40 shards re-encoded without the Korean
  `locl`, Noto Sans JP, SC, TC, Thai, Arabic, Hebrew and Indic), so the Korean and English UIs draw
  the same content with the same faces, widths and pixels. One startup Han order from the
  browser's languages for every UI except Japanese and Chinese; detected Japanese and Chinese text
  keeps its own order; CJK `size-adjust` 94% and the line-box overrides from one metrics home with
  a parity test; Inter's contextual alternates on; no title tracking token; file titles shown NFC.
  `src/i18n/locale-fonts.ts` is the only font owner (phases A, B and the idle prefetch C, bounded
  retries), and the Pretendard runtime, the bootstrap font scheduler and the service worker's font
  group are gone, so no resource-ownership record is needed; About and the sitemap page keep their
  original sheets, and Pretendard stays deployed for the public pages. The report lists the
  owner's decisions and the release owner's ten implementation defaults, which the owner can
  reverse, the departures from the design (separate app sheets, CJK faces cut by
  their own cmap, the prefetch reading face status because Chromium's `FontFaceSet.check()`
  answered true for unloaded shards), every visible change for the owner's pictures, the
  measurements (eager total 531.0 KiB gzip against 9.0.28's 533.1, eager fonts 0; English start screen
  72,920 B in one file, Korean 249,360 B in 12 files plus 9 prefetched shards), the tests-first
  commit pairs with their SHAs before and after the rebase, ten QA rounds (round 7
  rechecking every tests-first commit on its new parent, round 8 the final gate on the bump:
  `build:checked` and all 37 guards passing, the production candidate 19 / 19, critical E2E with
  the font identity E2E 104 / 104, the unit suite with only its known git-fixture load timeouts
  rerun alone; round 9 the first PR #548 CI, which failed `adaptive-actions` on Linux, where
  font hinting left the Filipino Sign out and Delete account pair one row more than with its
  9.0.18 typography, fixed tests first by `text-rendering: geometricPrecision` on those two buttons as
  PR #510 did for the media source options, with the bump re-laid on top and the local gate
  rerun; round 10 the release: the PR CI on the rebuilt head `3ea8ff7e` passed all 11 jobs with
  critical E2E 101 / 101 on Linux, the automated review ended with no findings, the merge used the
  prepared squash body, the exact-main CI passed, the public floor read just before dispatch showed
  stored and effective 795, one Production Release passed every smoke on the first try, the public
  service worker read v802 and the floor 795 with live App 802, a production read in desktop
  Chromium showed the Korean UI starting with Inter and Noto Sans KR and no Pretendard request, and
  the Drift Audit reported 32 pass / 0 fail / 5 manual-only), the risks, the device checks after the
  release (first the iOS 17 and 18 Safari line boxes, then iOS 16, Android, the webOS TV) and twelve
  owner questions with the owner's answer and the recommended answers applied, among them a
  self-hosted symbol face for the characters no face draws, which still draw in a different device
  font in the Korean and English UIs (☺ ℹ ∼ ≒ ◈) and are accepted for now. The font
  guard checks self-hosted faces and coverage in every text stack (KS X 1001 and the swept
  symbol blocks included, 1,270 recorded gaps), no rule that applies in only one of the Korean
  and English UIs, `calt` on and no face in the app stylesheets; the initial transfer budget
  counts fonts that eager stylesheets declare, and `e2e/font-identity.test.ts` (local) compares
  the two UIs pixel for pixel. A code review round (QA round 5) gave the font owner an attempt
  deadline, renewed retries, failed-face recovery and an app-shell install of its own chunk, made
  phase C idle-only and sheet-aware, cut Hangul and kana by script, and kept the Noto Sans KR
  copyright and license names.
- [App 9.0.28 train: the PRO SFU fallback prepared beside the LAN-direct attempt with media held, and the playlist current-row icons and PRO upload row numbers (2026-10-31)](design/app-9-0-28-train-2026-10-31.md):
  released on 2026-10-31 11:29 KST in Release 41160043955 (PR #545, squash `aa7baad5`): the next
  App update after 9.0.27 (9.0.28 / v801, App build 801, update dialog; the version bump `f3a9fcbc`
  is the last runtime commit, followed only by a docs commit). Only the App Worker changed
  (`e3457d38` to `89ad188d`); the PRO room Worker keeps R4's `e7657f88` and the other four their
  9.0.22 versions.
  Branch `agent/app-9-0-28-train` on main `599465dd` (after the 9.0.27 record #540, the Phase 6
  T0a tests #541 and #542, the T1 ownership guard #543 and the `src/youtube` test-order fix #544;
  first assembled on `682e0fcd`, then moved onto `599465dd` with every patch unchanged) carries the
  two increments' 14 commits in order (one `docs/README.md` conflict, both sides kept; three commit
  messages corrected; the tests-first commits fail the same rows on their new parents). Target
  `app`: 4 App runtime paths before the bump against the live Worker SHAs and main (8 with the
  bump's four mirrors), none in the other five Workers, no runtime dependency change; the build
  floor stays 795. After the bump the local gate passed on `682e0fcd` and again after the move onto
  `599465dd`: release identity 9.0.28 / v801 and `guard:sw-cache-version` PASS v801, every guard
  and the resource-ownership check with #543, `build:checked`, unit 724 files / 17,210 tests
  (721 / 17,194 before the move), critical coverage 92 files / 3,734, Worker coverage 69 files /
  3,323, 19 candidate, 101 critical, 5 system audio and 35 playlist E2E rows (the 'convertible in tablet
  posture' hover row, run alone, fails on this build and on a main `682e0fcd` build alike). The
  report lists the owner decisions of 2026-10-31 ("two stages", the media-less
  publisher session, the approved playlist mockups with option B, the overnight delegation) and
  the release owner's round 3 choice (9.0.27's one ordinary publish when the held fallback is
  already lost), both increments' QA rounds with their tested SHAs and limits, the moved-SHA table,
  mixed versions (the 9.0.27 blind check can run on 9.0.28 reading only its build line), rollback
  (checkpoint App 9.0.27 `e3457d38`, build 800 at or above floor 795, and the held fallback's
  rollback trigger), deploy conditions and order (Developer API D1 and `raise_app_build_floor`
  false), the blind post-deploy procedure and its withheld criteria, and four open owner questions
  (the expanded YouTube sub-row's older icon sizes, the provisional upload number during an
  administrator's playlist switch, the Worker new-session limit, the release-attach window).
  QA round 6 records the release: the PR CI on head `6f90c9f3` passed all 11 jobs on its first
  run, the automated review that opening the PR started ended with no findings on that head, the
  merge used the prepared squash body (parent `599465dd`, tree equal to the head), the exact-main
  CI passed (job conclusions plus the critical coverage log, 92 files / 3,734 tests), the public
  floor read just before dispatch showed stored and effective 795 with an App report about 59 s
  old, one Production Release passed every smoke on the first try (checkpoint artifact 13025994464
  with the 9.0.27 App `e3457d38`), the public service worker read v801, the public floor 795 with
  live App 801, and the Drift Audit 32 pass / 0 fail / 5 manual-only. It also corrects when main
  moved: #543 and #544 merged at 08:18 KST, during the assembly round, not during QA round 4. The
  owner delegated releases before going to sleep and confirmed the delegation in the morning, and
  saw pictures of the built playlist beside the approved mockups before the merge; the owner was
  away after the release, so the blind post-deploy checks (the 9.0.27 five-share check first, on
  9.0.28), the owner device checks of the playlist and the R4 late check did not run then, and the
  four owner questions have no answer yet. The App 9.0.29 / v802 font switch (2026-10-31 23:39 KST)
  the App 9.0.30 / v803 Phase 6 6A (2026-11-01 05:17 KST), the App 9.0.31 / v804 line box train
  (2026-11-01 23:17 KST), the App 9.0.32 / v805 Phase 6 6B (2026-11-02 05:34 KST), the App 9.0.33 / v806 Hangul train (2026-11-02 13:12 KST), the App 9.0.34 / v807 train (2026-11-02 21:20 KST), the App 9.0.35 / v808 train (2026-11-03 16:40 KST), the App 9.0.36 / v809 train (22:22 KST), the App 9.0.37 / v810 train (2026-11-04 13:51 KST), the App 9.0.38 / v811 train (2026-11-05 06:14 KST), the App 9.0.39 / v812 train (21:22 KST), the App 9.0.40 / v813 train (2026-11-06 14:53 KST) and the App 9.0.41 / v814 train (2026-11-11 01:14 KST, entries above) shipped before those checks, so they now run on 9.0.41, as
  none changes the system audio files (9.0.39's 7B changes the recovery of the shared audio context and 9.0.41's 7C moves that recovery code behind one owner; 9.0.40 changes only the public pages and the demo step label's CSS), reading the build line as `app=9.0.41 | cacheEpoch=v814`; the
  9.0.29 to 9.0.35 records have no result for them. On the evening of 2026-11-03 the owner ran
  three same-Wi-Fi shares on 9.0.35 with the 9.0.27 procedure's set-up (an Edge sharer and an
  iPhone Safari listener; not the full blind list): all three ended on the SFU without a break in
  the sound, none ended LAN-direct, and in the two whose lines show it the held fallback was
  released after 0 and 1 ms, so late RTP after a trackless negotiation is still unseen; the
  off-Wi-Fi shares, the rest of both blind lists, the playlist checks and the R4 late check still
  wait (the release record's 9.0.27 and 9.0.28 sections), and the 9.0.37 to 9.0.41 records add no result. The Full E2E run 41229806902 on main `e51dd292` (the 9.0.29
  runtime) passed before 6A merged and closed the chat Tab cycle item. The
  release record's §2 carries the train as post-deploy items (scope and status, the held SFU fallback
  moved from the 9.0.27 section, the post-deploy check and the open owner questions, with the
  playlist follow-up updated in place), its §4 the 9.0.28 entry and current boundary line (5), and
  the hotfix procedure's 9.0.25 bullet names 9.0.28's merge SHA, Release ID and App version. The
  rollback boundary is a forward revert at 9.0.46 / v821 or later now that 9.0.29 to 9.0.41
  shipped, or the checkpoint's 9.0.27 App without `lower` with the PRO Worker left in place, which
  now also removes the 9.0.29 font switch, 6A, the line box train, 6B, the Hangul faces, 6C with the two light-theme changes, 6D, the public-page font train, the 9.0.37 train, the 9.0.38 train and the 9.0.39 train and restores a lower service-worker epoch, so until the owner or
  release owner decides the open rule in the 9.0.29 entry above, only as an explicitly reviewed CLI
  rollback under the hotfix procedure.
  Increment notes: [held SFU fallback](design/pro-system-audio-speculative-sfu-2026-10-31.md),
  [playlist icons and upload rows](design/playlist-state-icons-upload-rows-2026-10-31.md).
- [PRO system audio: the SFU fallback prepared beside the LAN-direct attempt, media held (2026-10-31)](design/pro-system-audio-speculative-sfu-2026-10-31.md):
  the 9.0.28 increment (owner decision 2026-10-31, "two stages"), implemented and checked locally on
  the branch `agent/spec-sfu` over the 9.0.27 train (`3042b015`) and moved into the App 9.0.28
  / v801 train above, released with it on 2026-10-31 11:29 KST (target `app`, nothing on screen
  changes). Its lines were first seen in production on 9.0.35 on the evening of 2026-11-03, in
  three same-Wi-Fi shares (not the full blind list) that all ended on the SFU: the two whose sharer
  lines show the fallback read `Prepared SFU fallback … in 2407 / 1746 ms`,
  `Released SFU fallback (held 0 / 1 ms)` and `Published generation 25 / 29`, so the fallback was
  held only 0 to 1 ms and late RTP after a trackless negotiation is still unseen; no share ended
  LAN-direct, and the off-Wi-Fi shares of the blind check wait.
  The note's own Status cell keeps its pre-train text; the train report and the release record
  hold the release state. A share with LAN-direct targets starts its SFU
  publish in the same turn as the LAN-direct attempt with the sender holding no track; a proven
  LAN-direct stops it before the unchanged `lan-direct` commit, and a failed one attaches the track
  and commits the prepared descriptor at once. Owner-accepted cost: a LAN-direct share usually
  asks for one Cloudflare Realtime publisher session that never carries media, and spends one
  admission of the Worker's per-capability new-session limit. The release owner settled the
  review's three owner questions under the owner's delegation (round 3, reversible by the owner):
  a held fallback already lost when LAN-direct fails (a failed request such as a transient 502 or
  429, or a connection lost while held) leads to 9.0.27's one ordinary publish and its commit, so
  at most one SFU publish follows the LAN-direct failure as in 9.0.27, and the unchanged
  new-session limit is accepted as a rare case to observe. No wire, server, timer, retry loop or
  timing value; RO-20 extended in place. The held fallback's info lines (Prepared, Released, Closed
  unused, Cancelled, Closed released, failed) use the `[PRO SystemAudio]` prefix, so a LAN-direct
  share still logs no `[ProSysAudioSFU]` line at `?mxqrLog=info` (at debug level a failed
  tracks-close can still log one), and for a released fallback
  `[ProSysAudioSFU] Published generation N` comes only after the room committed it. Round 1:
  tests first `1b2be559`, runtime
  `17002160`; review round 2: tests first `25e029ba` (25 rows fail on round 1), runtime `4bcc52fb`;
  round 3: tests first `926a5a95` (16 rows fail on round 2), runtime `d4934909`; review round 4:
  tests only `bd58bec1` (three existing checks pinned, the runtime unchanged), and the note names
  the rollback trigger and target (9.0.27 / v800 behaviour) for the unverified late-RTP pushed
  track. In a
  Chromium harness running the real service, SFU and LAN-direct modules against a fake Cloudflare
  whose answering connection receives the media (publish modelled at 0.6, 1.7 and 3 s), the first
  RTP packet of a share whose pair never refines arrives 1.68-1.81 s sooner at 1.7-3 s (0.60-0.64 s
  at 0.6 s, after a 1.2 s hold) and of a `no-lan-candidate` share 0.11-0.18 s sooner; a LAN-direct
  pass commits at the same time and its held connection receives no RTP. Not verified on devices
  or against production Cloudflare (a pushed track whose RTP starts seconds after negotiation,
  zero-media billing).
- [Playlist current-row state icons and PRO upload row numbers, owner decision (2026-10-31)](design/playlist-state-icons-upload-rows-2026-10-31.md):
  released on 2026-10-31 11:29 KST in the App 9.0.28 / v801 train above. The owner saw pictures
  of the built app beside the approved mockups that morning, before the merge, but no owner device
  check has run yet, and the two playlist owner questions have no answer. The note's own Status
  cell keeps its pre-train text; the train report and the release record hold the release state.
  Built on main `8f171535` (QA round 1), then moved after review onto main `23f29283` (9.0.27
  / v800) without the design system page change the owner had not seen; App only (2 runtime paths).
  Beside the current row's title the pause bars draw wider in an 18px box, the play triangle in a
  20px box and the loading ring at 13px with a 2px line (the selected row's weight); a PRO upload
  row shows a provisional number (the rows shown plus 1, 2, ...), hidden from assistive technology
  like every number, and its thin ring (1.73px) in the 16px icon cell, so every title starts on one
  line; the file going up now leads the upload rows. The note gives the owner decisions, the
  pictures the owner approved described in words, the tests-first commit `829f909b` and
  implementation `61bf495e`, both QA rounds (round 2: full unit suite, typecheck, lint, format,
  guards, build guards, 101 critical and 31 of 32 playlist and design system E2E with one hover row
  that also fails on main), the review and its handling, the real e2e build pictures kept outside
  the repository, and the open items (the expanded YouTube sub-row keeps its icons, pictured for an
  owner decision; a provisional number during a playlist switch; no device check).
- [App 9.0.27 train: the iPhone listener's LAN-direct pair judgement and diagnostic lines, and chat keyboard and screen reader focus (2026-10-30)](design/app-9-0-27-train-2026-10-30.md):
  released on 2026-10-31 04:31 KST in Release 41115623163 (PR #536, squash `23f29283`): the next
  App update after 9.0.26 (9.0.27 / v800, App build 800, update dialog; the version bump `676a1670`
  is the last runtime commit, followed only by a docs commit and a test-configuration commit).
  Target `app`: 13 App runtime paths against the live Worker SHAs and main (five LAN-direct, four
  focus and the bump's four mirrors), none in the other five Workers, no runtime dependency change;
  the build floor stays 795. Only the App Worker changed (`b8dc4281` to `e3457d38`); the PRO room
  Worker keeps R4's `e7657f88` and the other four their 9.0.22 versions. The train was rebuilt on
  2026-10-31 on main `8f171535` (after Phase 5.5 R4 #537, its record #538 and the Phase 6 T0a tests
  #539) as branch `agent/app-9-0-27-rebuild`: the old train's 20 commits before its bump (the focus
  increment's eight, the LAN-direct increment's nine, the tests-only assembly commit and two docs
  commits; three docs conflicts with #537 and #538, both sides kept), then the owner answer's
  `no-lan-candidate` tests-first commit `af9553b8` and fix `447890cf`, a docs commit, the review's
  tests-first commit `f97e9349` and defensive fix `4b648904`, the bump and a docs commit naming it
  and the review, force-pushed to PR #536; the old bump `e5b8440c` and its docs commit `61e57fc2`
  were not moved. The report lists the owner decisions (nothing on screen changes) and the owner's
  two answers of 2026-10-31 to the SFU fallback question: keep the 1 s wait and add
  `no-lan-candidate` now (a route whose own end finishes ICE gathering having sent no LAN candidate
  fails at that event, since the other end can never prove it; in a Chromium harness running the
  real module the decision moves from about 1.81 s to 0.14-0.16 s when the sharer has none and to
  about 0.81 s when the listener has none, with no LAN success lost), add a speculative SFU publish
  with held media in 9.0.28, and allow that a LAN-success share then briefly opens one Cloudflare
  publisher session with no media. It also lists both increments with their tested SHAs before and
  after each move and their tests-first parent failures, the review findings and their handling,
  mixed versions (a 9.0.26 sharer and a 9.0.27 listener can go LAN-direct; a 9.0.26 listener still
  uses the SFU), the rollback to the checkpoint's 9.0.26 / v799 App `b8dc4281`, the deploy
  conditions with their results, what users notice (an unrefined host-to-prflx pair at either end,
  in any browser, now waits for the sharer's pair-proof window of 1 s after the answer instead of
  being refused at once, so the SFU fallback can come up to about 1 s later for every listener in
  that attempt; when LAN-direct engages the SFU wait disappears), the 9.0.28 plan, the QA rounds,
  what was not verified and a blind post-deploy procedure for the owner's Edge sharer and iPhone
  Safari listener (five shares with `?mxqrLog=info`; the judging criteria read the new pair-check,
  gathering and SFU subscription lines and are not handed out). QA round 6 records the release: the
  first PR CI on the force-pushed head `ab190ab9` failed the critical coverage lane because
  `src/network/pro-system-audio-direct.ts` fell below its file thresholds (lines 41.41 % < 42 %,
  branches 35.43 % < 37 %; the lane covered the grown file only through other suites, and the local
  final check had not run that lane), so the test-configuration-only commit `3042b015` enrolled the
  file's own two suites in that lane with the thresholds unchanged (92 files / 3,699 tests); then
  the PR CI on the final head `3042b015`, a no-findings automated review after a review request
  comment, the merge with the prepared squash body, the exact-main CI with job conclusions and the
  critical coverage log, the public floor read just before dispatch (stored and effective 795, App
  report about 20 s old), one Production Release whose smokes all passed on the first try, the
  public service worker at v800, the public floor at 795 with live App 800, and the Drift Audit at
  32 pass / 0 fail / 5 manual-only. The owner delegated the release before going to sleep, so the
  blind post-deploy check did not run then; it was for the morning, and 9.0.28 to 9.0.45 shipped
  first (2026-10-31 11:29 and 23:39 KST, 2026-11-01 05:17 and 23:17 KST, 2026-11-02 05:34, 13:12 and 21:20 KST, 2026-11-03 16:40 and 22:22 KST, 2026-11-04 13:51 KST, 2026-11-05 06:14 and 21:22 KST, 2026-11-06 14:53 KST, 2026-11-11 01:14 KST, entries above), so the
  rest of the blind check now runs on 9.0.41 reading only its build line; the 9.0.28 to 9.0.35 records have no result for
  it. On the evening of 2026-11-03 the owner ran three same-Wi-Fi shares with its set-up on 9.0.35
  (not the full blind list), the first production sight of the new diagnostic lines and
  `no-lan-candidate`: all three ended on the SFU without a break in the sound and none proved
  LAN-direct (two read as the reading table's row for a sharer that sent no mDNS candidate, with
  the site's camera permission granted in Edge; the third, after the site permissions were reset,
  is not in the table), so the five-share check stays open and a read-only diagnosis is running; the
  9.0.37 to 9.0.41 records add no result.
  The full E2E run that closes the chat Tab cycle item, 41229806902 on main `e51dd292` (the
  9.0.29 runtime, which carries this fix), passed on 2026-11-01 before 6A merged, so the release
  record closed that item. The release record's §2 carries the train as post-deploy items (scope and status, the
  LAN-direct pair judgement and `no-lan-candidate`, the post-deploy check, the 9.0.28 plan, now a
  pointer to the 9.0.28 section, and the chat Tab cycle follow-up, now closed), its §4 the 9.0.27 entry and
  current boundary line (5) (checkpoint artifact 13005387697, App 9.0.26 `b8dc4281`), and the
  hotfix procedure's 9.0.25 bullet names 9.0.27's merge SHA, Release ID and App version. The
  rollback boundary is a forward revert at 9.0.46 / v821 or later now that 9.0.28 to 9.0.41
  shipped, or the checkpoint's 9.0.26 App without `lower` with the PRO Worker left in place, which
  now also removes 9.0.28, the 9.0.29 font switch and 9.0.30 to 9.0.41 and restores a lower service-worker epoch
  (the same open rule as in the 9.0.28 entry).
- [Chat keyboard and screen reader focus: the sheet's Tab cycle, a hiding pinned notice, removed messages (2026-10-30)](design/chat-keyboard-focus-2026-10-30.md):
  released on 2026-10-31 04:31 KST in the App 9.0.27 / v800 train above (owner decision 2026-10-30:
  nothing on screen changes, keyboard behaviour only); the release record's chat sheet Tab cycle item
  closed with the Full E2E run 41229806902 on main `e51dd292` (2026-11-01, the 9.0.29 runtime), whose
  28 `ui-comprehensive` rows, these five among them, passed on Linux Chromium; real devices, screen
  readers and WebKit were not covered. The
  note's own Status cell keeps its pre-release text; the train report and the release record hold
  the release state. The phone and tablet chat sheet's Tab cycle skips the
  hidden pinned notice's buttons, and when a pinned notice hides or a focused message is cleared or
  pruned at the 200-row cap, focus moves to the chat drawer, which draws no ring, instead of
  dropping to the page; focus on the message log itself stays. App only (four runtime files in
  `src/ui`); screenshots before and after differ by 0 px. The note also corrects the 9.0.26 chat
  sheet note: under the repository's jsdom 30.1.2 the Tab cycle's unit rows fail on their parent.
- [PRO system-audio LAN-direct: the iPhone listener's pair judgement and diagnostic lines (2026-10-30)](design/pro-lan-direct-ios-listener-2026-10-30.md):
  implemented and checked locally on main `cbbc56d9` (9.0.26 / v799), then moved without conflicts
  into the App 9.0.27 / v800 train above and with it onto main `8f171535` (README conflicts only);
  released on 2026-10-31 04:31 KST in that train, bumped by `676a1670` (target `app`; owner
  decision 2026-10-30, nothing on screen changes). Its pair-check and gathering lines and
  `no-lan-candidate` were first seen in production on 9.0.35 on the evening of 2026-11-03, in
  three same-Wi-Fi shares of the blind check's set-up (not its full list): all three ended on the
  SFU and none proved the new pair judgement, so the five-share check stays open (the rest of it
  now runs on 9.0.41; 9.0.28 to 9.0.45 shipped first). Its post-deploy reading table now names the
  `no-lan-candidate` gathering lines the train added on the owner's answer of 2026-10-31. The
  note's own Status cell keeps its
  pre-train text; the train report and the release record hold the release state. In the 9.0.26
  post-deploy check an iPhone Safari listener judged its own LAN pair non-local about 0.5 s into its
  proof, so every share fell back to the SFU. iOS Safari, the
  ICE-controlled answerer, meets the sharer's check before resolving its mDNS name, so its native
  selected pair keeps a peer-reflexive remote while the statistics refine the same connection to the
  added host candidate; the PRO rule refused any non-host pair at once. Both ends now hold such a
  host-to-prflx pair pending and prove it only through the one transport-selected statistics pair
  refined to an added mDNS host candidate (the Standard room's check, moved unchanged into
  `src/network/ice-selected-pair.ts`); an unrefined prflx never proves and every other non-host pair
  is still refused at once. New info lines, without addresses, ports or full ids: one pair-check line
  per end and proof (rule, candidate types, address kinds, candidates sent, refused and added), a
  failed-reproof line, and the SFU listener's subscription stage times from the share notice. The
  note lists the cause and what tells the remaining causes apart, the threats kept closed, the
  tests-first commit `6eb40a04` (52 rows and the new helper file fail on its parent), the checks,
  mixed versions and a proposed post-deploy reading table. Review round 2 (tests first `10431823`):
  a refined pair survives a reproof that meets libwebrtc's consent check in flight (in-progress
  after a response), pends while a prflx connection on the same socket and port is still listed,
  and is refused when two pairs are selected; the closed line keeps the last current reading; the
  lines add the received count, the first remote add time and the SFU attempt's connection failure
  and refusals before start; the note now records the change as diagnostic plus a conditional fix
  and lists the residual risks it does not fix. Not device-checked.
- [Phase 5.5 R4: PRO cleanup, PRO room Worker only (2026-10-30)](design/phase5-5-r4-pro-cleanup-2026-10-30.md):
  released on 2026-10-30 19:56 KST in Release 41044220520 (PR #537, squash `683074bc`): the planned
  PRO cleanup before Phase 6 and the last release of Phase 5.5, PRO room Worker only (target
  `pro-room` with 1 PRO room runtime path and none in the other five Workers; the App stays 9.0.26 /
  v799, so no SemVer, service worker cache, update dialog or build floor change). Only the PRO room
  Worker changed (`ef882f7c` to `e7657f88`); the App kept 9.0.26's `b8dc4281` (until 9.0.27) and
  the other four their 9.0.22 versions. It shipped before 9.0.27 (which then waited for an owner
  answer), from main
  `d0248df2` (the 9.0.26 record, #535) without a move, while the live PRO Worker was the one that
  first sends PRO snapshot schemaVersion 2 (`0e5a9b87`, `ef882f7c`). The PRO Worker stops reading
  the 2999 ms zero-start deadline of a transition an earlier Worker stored without `timingMode`:
  such a transition still loads and commits with the 700 ms lead as a scheduled control. The PRO
  CORS allow list drops `x-mxqr-pro-entry-policy` and `x-mxqr-pro-playlist-slots`, which the App
  has not sent since 9.0.25 (a 9.0.24 or older loopback development build that calls the
  production PRO API fails its preflight). The report lists the owner decisions and the three
  owner questions R4-Q1 to R4-Q3 (its own numbers; built and shipped with the recommended (a)
  before an answer came, since the owner was asleep and two of the (b) options conflict with the
  stored-data rule and the decided Q20; to be confirmed with the owner in the morning), the
  tests-first parent failures, the storage lifetime that keeps the old record accepted (in
  production only the COMMIT's start kind changes), mixed versions, rollback to that PRO Worker
  with no new boundary, the deploy conditions and order with their results, the blind post-deploy
  check (a YouTube start; regression only), the two comments left for later releases (the shared
  timing home header and a snapshot parser comment), the train review and what it changed, QA
  rounds 1 to 5 (per increment; the full gate at `c9f09514`; after the review; round 3 no move;
  round 4 the public floor read just before dispatch, stored and effective 795 with an App report
  about 3 s old, and the release's empty PRO build requirement; round 5 the PR CI and a
  no-findings automated review on the final head `3553fd69`, the merge with the prepared squash
  body, the exact-main CI with job conclusions only, one Production Release with target
  `pro-room` whose PRO media CORS and PRO room smokes passed on the first try with the new
  version, the public service worker still at v799, the public floor at 795 with live App 799, and
  the Drift Audit at 32 pass / 0 fail / 5 manual-only) and what was not verified. The blind
  post-deploy check did not run within 30 minutes of the release because the owner was asleep; it
  is scheduled for the next morning as a late check and is not a gate. The release record's §2
  now carries the R4 post-deploy items and the Phase 5.5 completion item, which lifts the
  runtime-dependency merge freeze (Phase 5.5 end condition 5); its §4 entry and current boundary
  line (5) name the merge SHA, the Release ID, checkpoint artifact 12971063046 (the R2 PRO Worker
  `ef882f7c`) and the new PRO Worker `e7657f88`, and the hotfix procedure says the first
  schemaVersion 2 PRO Worker stayed live until this release.
- [App 9.0.26 train: PRO system-audio LAN-direct in one round trip and the chat sheet without its Close (2026-10-30)](design/app-9-0-26-train-2026-10-30.md):
  released on 2026-10-30 13:08 KST in Release 41001009672 (PR #534, squash `cbbc56d9`): the next
  App update after 9.0.25 (9.0.26 / v799, App build 799, update dialog; the version bump `b2ac0109`
  is the last runtime commit, followed only by tests and docs). Target `app`: 50 App runtime paths
  (one LAN-direct file, the chat sheet's 46 and the bump's three mirrors), none in the other five
  Workers, no runtime dependency change; the build floor stays 795. Only the App Worker changed
  (`b4e8fc56` to `b8dc4281`); the PRO room Worker keeps R2's `ef882f7c` and the other four their
  9.0.22 versions. The branch was PR #534 (head `b7986840` on main `f8a30068`) with the chat sheet's
  three commits moved on top and the tests-only follow-ups `5b7abd30` and `e085fad1` (LAN-direct
  rows for a probe channel announced after the receiver's pair proof). The report lists both
  increments with their tested SHAs (`d0b71a89` pins the old behaviour; the rows of `9b3ca4aa` and
  `de47d982` fail on their parents), the review findings and their handling, the QA rounds (local
  runs, PR #534's CI, the assembled tree's checks, the final check after the bump, and the release:
  the PR CI on the final head `0542c0db`, a no-findings automated review that ran only after a
  review request comment because further pushes to an open pull request start none, a squash
  message that is GitHub's default commit list rather than the train summary, the exact-main CI,
  one Production Release whose smokes all passed on the first try, the public service worker at
  v799, the public floor at 795 with live App 799, and the Drift Audit at 32 pass / 0 fail / 5
  manual-only), mixed versions (a 9.0.25 or older device and a 9.0.26 one use the SFU), the rollback
  to the 9.0.25 / v798 checkpoint App, the deploy conditions with their results (no floor read just
  before dispatch is recorded), the post-deploy check and what was not verified. The post-deploy
  check (not blind; three of the five shares, an Edge sharer and an iPhone Safari listener on one
  Wi-Fi) saw the answer within 0.82 to 0.94 s and the sharer prove its pair, but every share stopped
  at the listener's pair proof (`receiver-fallback` on the sharer) and fell back to the SFU with
  sound; in share 1, the one share with listener lines, the listener judged its pair non-local after
  541 ms. LAN-direct stays unverified for an iPhone Safari listener. The leading hypothesis, not
  measured, is that iOS Safari sees the Edge sharer's mDNS host candidate as peer-reflexive and the
  PRO receiver rule rejects any non-host pair, while the Standard room refines such a pair to its
  host candidate. The owner confirmed on an iPhone that the chat sheet shows no Close. Owner
  decision after the check: the next App update fixes the listener's judgement and adds diagnostic
  lines. The release record's §2 carries both increments as post-deploy items, its §4 the 9.0.26
  entry and current boundary line (5) (checkpoint artifact 12953960262, App 9.0.25 `b4e8fc56`), and
  the hotfix procedure's 9.0.25 bullet names 9.0.26's merge SHA, Release ID and App version. The
  rollback boundary is a forward revert at 9.0.46 / v821 or later now that 9.0.27 to 9.0.45 shipped, or the
  checkpoint's 9.0.25 App without `lower` with the PRO Worker left in place.
- [PRO system-audio LAN-direct in one round trip (2026-10-30)](design/pro-lan-direct-one-round-trip-2026-10-30.md):
  released on 2026-10-30 13:08 KST in the App 9.0.26 / v799 train above (target `app`). On a
  desktop sharer with an iPhone listener on one Wi-Fi every PRO share went to
  the SFU because the two-round-trip LAN-direct negotiation (probe, then media re-offer) missed its
  single 2 s deadline (pinned by the tests-only commit `d0b71a89`). Owner decision 2026-10-30
  (option C): one offer carries the probe channel and an empty audio sender, the receiver proves
  its pair and reports it on the probe channel, and the capture track attaches only after both
  proofs; the answer must come within 2 s and the proofs within 1 s more, and the first failed
  route ends the attempt. The relay frame shape is unchanged, so no Worker changes; a 9.0.25 or
  older device and a newer one never build a route between them and use the SFU. Each route logs
  one info result line. In the post-deploy check the answer came within 0.82 to 0.94 s and the
  sharer proved its pair, but every share stopped at the iPhone Safari listener's pair proof and
  fell back to the SFU; in share 1, the one share with listener lines, the listener judged its pair
  non-local. LAN-direct stays unverified for an iPhone Safari listener (train report QA round 5).
  The note's own Status cell keeps its pre-release text; the train report and the release record
  hold the release state.
- [Chat sheet without its Close (X), owner decision (2026-10-30)](design/chat-sheet-close-removal-2026-10-30.md):
  released on 2026-10-30 13:08 KST in the App 9.0.26 / v799 train above, whose bump covers it; the
  owner confirmed on an iPhone that the sheet shows no Close. The note's own Status cell keeps its
  pre-merge text; the train report and the release record hold the release state. In this change,
  built on main `b8ae59e7` (9.0.25 / v798), the phone and tablet chat sheet loses the visible Close
  that 9.0.20 put at the start of its handle row (dialog exit item F12) and closes as before 9.0.20:
  an outside tap, a tap or a swipe down on its drag handle, Enter or Space on the focused handle,
  Escape and Back. App only (46 runtime paths; `chat.close` leaves the 42 locales). The note lists
  the owner decision, the change and its guards (the chat sheet is now the one window whose exit is
  its drag handle), the tests-first commit `d5c83195` (6 unit tests in 5 files and the new E2E fail
  on its parent), the checks on `d4f11e1d`, the 390x844 light and dark screenshots before and after
  (kept outside the repository for the owner; only the X's glyph differs), the owner step for
  `chat.close` translation suggestions after the release, a gap in the sheet's keyboard Tab cycle
  found on the way and left as it was (a follow-up item in the release record, fixed in the App
  9.0.27 train and closed with the Full E2E run of 2026-11-01), and what was not verified. Its finding says jsdom focuses hidden buttons, so unit
  tests cannot catch the gap; that is wrong under the repository's jsdom 30.1.2, and the chat
  keyboard focus note corrects it without changing this note.
- [Phase 5.5 R3: the App stops reading PRO snapshot schemaVersion 1, 9.0.25 (2026-10-30)](design/phase5-5-r3-v1-receive-stop-2026-10-30.md):
  released on 2026-10-30 07:18 KST in Release 40964572017 (PR #532, squash `b8ae59e7`): the third
  runtime release of Phase 5.5 and its last App one (9.0.25 / v798, App build 798, bump `01f1a19b`; target `app`
  with 18 App runtime paths and none in the other five Workers, against main and against the live
  Worker SHAs, with the update dialog; the build floor stays 795). Only the App Worker changed
  (`dd820d37` to `b4e8fc56`); the PRO room Worker keeps R2's `ef882f7c` and the other four their
  9.0.22 versions. It was built on the head `91601774` of the change that makes the PRO Worker send
  PRO snapshot schemaVersion 2 and moved onto main `d630269a` (the 9.0.24 record) after that PRO
  Worker (`0e5a9b87`, live since 2026-10-30 00:30 KST) and 9.0.24 were deployed and recorded. The
  App refuses the schemaVersion 1 wire and requires `passwordRequired`
  and `playlistSlots` on every snapshot, `{ administrators }` alone from the administrator directory
  answers and `passwordRequired` on every bootstrap; it reads the start kind only from `timingMode`
  (a heartbeat snapshot that lands a prepared checkpoint before its COMMIT now starts with the
  PREPARE's kind, an intended behaviour change), refuses a live LAN-direct share with a numeric
  `liveExpiresAt`, stops sending the PRO entry-policy and playlist-slots opt-in headers, reads
  SESSION_FULL and OPERATOR_TOAST by their key alone, and no longer reads the retired PRO developer
  signaling frames (bus-pairing 203 to 202). The release workflow's App build requirement for PRO
  releases is empty again. With this release Phase 5.5 is complete; from this deploy until the
  planned PRO cleanup (`pro-room`) ships, no runtime-dependency change merges, Dependabot included.
  The report lists the owner decisions and order, what each refusal relies
  on, each increment with its tests-first evidence, the deviations from the plan (among them the
  narrowed PSK-11 cleanup, the checkpoint App after 9.0.23 and 9.0.24, and the move onto main with
  the release renumbered from 9.0.24 to 9.0.25), the exact-count guards, mixed versions, rollback
  (the release record's §4 current boundary line items 8 and 9: never below the first
  schemaVersion 2 PRO Worker by hand, the App to the checkpoint App first, and the merged order
  below build 795 with its repair), deploy conditions and order, user-visible changes, records, QA
  round 1 (per increment), round 2 (the full gate at the first records commit) and round 3 (the
  move onto main: the old to new SHA map, the seven tests-first commits failing the same rows on
  their new parents, the R3-1 critical E2E at both of its commits (100 each, and 21
  failures with main's fixture and bootstrap mocks), the R3-4 weekly password E2E (10 failing on its
  parent, 10 passing), the two anonymous production bootstrap answers of the synthetic codes 000000 and
  000001 read by this App's `ProRoomApiClient`, the cross-contract and workerd rows on the real R2
  Worker (910), and the full gate at the bump: npm audit 0, unit 706 files / 16,748, Worker 69 / 3,322,
  critical 90 / 3,521, release-tooling 14 / 433, typecheck, lint, format, every guard with no baseline
  change, `check:worker-bundles`, `build:checked` with `guard:release-identity` 9.0.25 / v798 and
  `guard:sw-cache-version` PASS v798, and Chromium candidate 19, critical 100 and the PRO lane 39; then
  the review fixes after the bump with no runtime change: a duplicated records line removed, a
  tests-only cross-contract row that parses the in-process Worker's bootstrap in all four states and
  its PIN session, presence entry and account detach answers (unit 16,749, Worker 3,323, cross-contract
  911), and records that key the repair on the change being on main, add the post-deploy floor read
  and Drift Audit, and keep runtime-dependency merges out until the PRO cleanup ships), round 4
  (the public floor read just before dispatch: stored and effective 795, live App 797, App report
  33 s old) and round 5 (the PR CI and a no-findings automated review on the final head `30e66813`,
  the exact-main CI on Node 24.22.2 with unit 706 files / 16,748 plus the known skip, Worker
  69 / 3,323, critical coverage 90 / 3,521 and Linux Chromium candidate 19 and critical 100, one
  Production Release with target `app` whose smokes all passed on the first try and parse no PRO
  answer with 9.0.25, the public service worker at v798, the public floor at 795 with live App 798,
  the Drift Audit at 32 pass / 0 fail / 5 manual-only, the release owner's check that 9.0.25 shows
  the not-yet-activated dialog for the synthetic room 000000, and the post-deploy check in a PRO
  room the owner owns on 2026-10-30 from 07:28 to 07:49 KST, run and judged by the release owner
  (A and B were not run blind) against the criteria fixed beforehand in Microsoft Edge on a
  Windows desktop with an iOS Safari phone listening: entry and two YouTube starts (both with the
  PREPARE selected and zero-start) passed, a one-off `PRO_SIGNALING_START_FAILED` warning after
  the update reload did not recur, all five shares took the SFU path so LAN-direct stays
  unverified, the administrator grant and revoke was not run, and nothing was rolled back), the
  post-deploy check and owner device check candidates written as a blind hand-out (procedure and
  observations, with the pass criteria kept apart), the manual App rollback to the release's
  checkpoint App when the post-deploy check fails, and what was not verified. The post-deploy
  check also found why its shares did not use LAN-direct in the observed setup (an Edge sharer
  and an iOS Safari listener on the owner's home Wi-Fi, five shares; R2's one share from Edge
  also went to SFU): the probe answer came back in 0.75 s and ICE connected host to host, but the
  media answer missed the attempt's 2 s total deadline (`DIRECT_NEGOTIATION_TIMEOUT_MS`, set on
  2026-08-29), so the publisher took the SFU preflight; it is not a 9.0.25 regression, and
  whether LAN-direct misses on the same Wi-Fi in general stays a hypothesis for the owner
  decision, since a faster answering device could fit inside 2 s. The release record's §2 now
  carries the R3 post-deploy items (scope and status, the post-deploy check with
  its results, and the owner device check candidates, which have no results), a new owner decision
  item on that 2 s deadline (no code change), and the Phase 5.5 completion item with the
  runtime-dependency merge freeze; its §4 entry and current boundary lines (5) and (8) name the
  merge SHA, the Release ID and checkpoint artifact 12938145012 (App 9.0.24 `dd820d37`), and the
  hotfix procedure's 9.0.25 sentence names the merge SHA and the Release ID. The rollback boundary
  is a forward revert at 9.0.46 / v821 or later now that 9.0.26 to 9.0.45 shipped, or the
  checkpoint's 9.0.24 App without `lower` with the PRO Worker left in place. The App 9.0.26 train
  (entry above) replaced
  the two-round-trip LAN-direct negotiation with one round trip on 2026-10-30 13:08 KST.
- [Translate page entry train 9.0.24: language default, visit statistics, sign-in result (2026-10-29)](design/translate-entry-2026-10-29.md):
  released on 2026-10-30 03:20 KST in Release 40929481142 (PR #530, squash `78ec56f5`): the next app
  update after 9.0.23 (9.0.24 / v797, App build 797, bump `4d74f552`, target `app` with 14 App runtime
  paths and none in the other five Workers, with the update dialog; the build floor stays 795). Only
  the App Worker changed (`dddfabe3` to `dd820d37`); the PRO room Worker keeps R2's `ef882f7c` and the
  other four their 9.0.22 versions. Branch `agent/translate-entry` was on main `a8d8f9c4` (Phase 5.5
  R2 `0e5a9b87` and its record #529; the R2 PRO Worker change is outside this train's runtime paths).
  It carries the owner's decisions of 2026-10-29 for the public `/translate` page,
  which had no suggestions in production, and the
  owner's follow-ups after two approving reviews: the page opens on a supported `?locale`,
  otherwise the browser language matched exactly as the App matches it (one shared
  `src/i18n/language-match.ts`), otherwise English; `?phrase` selects a catalog phrase, also after
  Retry when the first catalog load failed, and the list opens on that phrase's page; language and
  phrase changes stay in the address and both sign-in returns, so Google sign-in comes back to the
  same language and phrase; the App language dialog's Help translate link opens the page in the App
  language, as the plain `/translate` when the browser gives the same language and with
  `?locale=<App language>` otherwise, so most arrivals are queryless and counted while the analytics
  loader's query rule stays unchanged; the page loads the standalone analytics loader like FAQ (the
  same CSP as `/faq`); and a cancelled or failed sign-in shows one of the two owner-approved lines
  (with the page's typographic apostrophe) in the existing submit status and removes only
  `accountAuth` from the address, keeping the other parameters and the fragment. The report lists
  the diagnosis, the tests-first rows (18, 2, 4 and 9 failing on their parents), the gate at the
  bump tree (706 files / 16,777 unit tests, critical coverage 90 / 3,515, critical E2E 100,
  translation E2E 6, `build:checked` 9.0.24 / v797), the browser measurements of the App
  link, Retry and paging, the move onto `a8d8f9c4` (round 8: the four tests-first commits fail the
  same rows on their new parents, and at the bump 706 files / 16,782 unit tests, typecheck, lint,
  format, `build:checked` with `guard:sw-cache-version` PASS v797, and target `app` only), round 9
  (the PR CI and a no-findings automated review on the final head `29d6674e`, the exact-main CI on
  Node 24.22.2 with unit 706 files / 16,781 plus the known skip, Worker 69 / 3,317 and Linux
  Chromium candidate 19, including the translation E2E 6, and critical 100, one Production Release
  with target `app` whose smokes all passed on the first try, the public service worker at v797,
  the public floor at 795 with live App 797, the release owner's production check of `/translate`
  in Chromium (a Korean browser opens Korean, a queryless visit loads the analytics loader and the
  Cloudflare beacon script, the sign-in `returnTo` keeps the language and phrase, a cancelled
  sign-in shows its line and leaves the address without `accountAuth`, and a URL with a query gets
  no beacon), and the Drift Audit at 32 pass / 0 fail / 5 manual-only), the arrivals the loader
  still does not count (an App language that differs from the browser,
  sign-in returns, pages opened from `/translate` after its address
  gained a query, and any later arrival on an address that already carries `?locale` or `?phrase`:
  a reload, bookmark or history restore after a choice, or a shared link), and what was not verified
  (a real production submission, the Google OAuth publishing status, and whether production Web
  Analytics counts the `/translate` arrivals over the next days). The release record's §2 now
  carries the 9.0.24 post-deploy items (scope and status, post-deploy checks with owner device
  check candidates, none with results yet, and the arrivals the loader does not count) and §4 its
  rollback boundary (a forward revert at 9.0.46 / v821 or later now that 9.0.25 to 9.0.45 shipped,
  or the checkpoint's 9.0.23 App `dddfabe3` without `lower`). Phase 5.5 R3, where the App stops receiving
  PRO snapshot schemaVersion 1, shipped next as 9.0.25 / v798 on 2026-10-30 07:18 KST (entry above).
- [Phase 5.5 R2: the PRO Worker sends PRO snapshot schemaVersion 2 (2026-10-29)](design/phase5-5-r2-v2-send-2026-10-29.md):
  released on 2026-10-30 00:30 KST in Release 40901986997 (PR #528, squash `0e5a9b87`): the second
  runtime release of Phase 5.5, PRO room Worker only (target `pro-room` with 1 PRO room runtime path
  and none in the other five Workers; the App stays 9.0.23 / v796, so no SemVer, service worker
  cache or update dialog change). Only the PRO room Worker changed (`6abc7131` to `ef882f7c`); the
  App keeps its 9.0.23 version and the other four their 9.0.22 versions. The branch was rebased from
  the 9.0.22 branch head `7630b1a9` onto 9.0.23 `5a5afb0e` and again onto the 9.0.23 record
  `d3a9b66a` (#527). It shipped after Phase 5.5 F2 raised the App build floor from 789 to 795 at
  00:12 KST (floor runs 40898835905, 40898944192, 40899114265 and 40899323158, revision 3, then a
  Signaling admission smoke that admitted both rooms' host and guest at build 796 with
  `refusedBelowAppBuildFloor` 795), while the live PRO Worker was the 9.0.22 one (`6abc7131`), and
  the release's PRO floor check read stored and effective 795. Every snapshot answer is now
  schemaVersion 2 without the four coordinator-era constants and carries `passwordRequired` and
  `playlistSlots` itself, the administrator directory answer drops `authorityVersion`, every
  PREPARE and transition COMMIT names its start kind `timingMode` with the 3 s barrier and the
  700 ms lead for both kinds, and a live LAN-direct share stores and answers a null
  `liveExpiresAt`. The release workflow's App build requirement for PRO releases is 795, the build
  of the shipped 9.0.22. The report lists the owner decisions and
  order, what the 795 floor covers and where it cannot filter, each increment with its tests-first
  evidence, the frozen v2 record rows that also pass on the 9.0.22 PRO Worker (the rollback
  target), the decision to keep the `coordinatorEpoch` name, the deviations from the plan, the
  train-end review findings, the findings of the two reviews after the first rebase and what was
  done with them, the exact-count guards, mixed versions, rollback (the release record's §4 current
  boundary line items 4, 6 and 7: no lower below 795 on its own, an App report that stops counts as
  a lower to 0 for PRO rooms, the PRO step first below build 795, never below the 9.0.22 PRO
  Worker, and the repair exits without automated recovery), deploy conditions and order with their
  results, the blind post-deploy check (moved after the release to a PRO room the owner owns,
  because the release smoke's PIN room has no owner account and the other smoke room is not
  activated; no room code in the report; the owner ran it on 2026-10-30 from 00:39 to 00:55 KST in
  Microsoft Edge on a Windows desktop: the snapshot v2 apply passed, one new zero-start start
  passed, LAN-direct was not exercised as the share used SFU; no rollback), user-visible changes,
  records, QA rounds 1 to 3 (per increment; the full gate at the records commit `e90ab14d`; after
  each rebase, the three tests-first commits rerun on their new parents with the same rows failing
  and the three rollback rows rerun on the 9.0.22 PRO Worker; after the second rebase onto
  `d3a9b66a`, the full gate at `57572709`: npm audit 0, unit 705 files / 16,716, Worker 69 / 3,316,
  critical 90 / 3,515, release-tooling 14 / 433, typecheck, lint, format, every guard,
  `build:checked` still 9.0.23 / v796 with no App bump, `check:worker-bundles`, Playwright PRO lane
  30, critical 100 and candidate 19, target `pro-room` only), round 4 (F2, its admission smoke and
  the public floor read just before dispatch) and round 5 (the PR CI and a no-findings automated
  review on the final head `7aecf6ce`, the exact-main CI on Node 24.22.2 with unit 705 files /
  16,715 plus the known skip, Worker 69 / 3,316 and Linux Chromium candidate 19 and critical 100,
  one Production Release with target `pro-room` whose PRO floor check, PRO media CORS smoke and PRO
  room smoke passed on the first try, the public service worker still at v796, the public floor at
  795 with live App 796, and the Drift Audit at 32 pass / 0 fail / 5 manual-only), owner device
  check candidates and what was not verified. The release record's §2 now carries the R2
  post-deploy items (scope and status, the post-deploy check with its blind result, and the owner
  device check candidates, which have no results); its §4 entry and current boundary line (6) name the merge SHA, the
  Release ID, checkpoint artifact 12909218206 (the 9.0.22 PRO Worker `6abc7131`) and the new PRO
  Worker `ef882f7c`, and the hotfix procedure's contract sentence names the merge SHA, the Release
  ID and the new PRO Worker. With the floor at 795, the §4 lines that rolled the App back to a
  build below 795 without `lower` now take the PRO step and `lower` first.
- [UI owner decisions train 9.0.23: the items 9.0.20 left open (2026-10-29)](design/ui-owner-923-2026-10-29.md):
  released on 2026-10-29 21:22 KST in Release 40872467902 (PR #526, squash `5a5afb0e`): the next app
  update after 9.0.22 (9.0.23 / v796, App build 796, bump `060dce82`, target `app` with 57 App runtime
  paths and none in the other five Workers, with the update dialog; the build floor stays 789). Only
  the App Worker changed (`dddfabe3`); the other five keep their 9.0.22 versions. It carries the
  owner's decisions of 2026-10-29 on twelve owner items of the 9.0.20 report: the Japanese setup
  waiting pill says 準備中...; a guest with a room code reads a lost-session body that says Restart
  joins this room again (one new key in 42 locales, the owner's Korean and English); one Leave
  Session confirmation, [Stay | Leave] with Stay focused first and Leave in account deletion's danger
  tone, for the connect tab, the logo and Back, from the dialog's first frame (the host-unresponsive
  Leave session takes the same tone); Back works again after a PRO room's Refresh needed, including
  when a forced update takes over the refusal; Japanese and Chinese dialog and setup titles keep their
  words whole (Japanese phrases where the browser supports auto-phrase) and no title runs past its
  box (a shorter Tamil host-unresponsive title); the demo's step 4 icons keep 20px with shorter Tamil
  and Malayalam exits and the owner-approved Norwegian 'Sporinfo' and Swedish 'Spårinfo' (added after
  the first PR CI's Linux fonts put 'Spårinformation' 2.50px past its pill at 320px); the demo header
  loses its exit button and names the track alone on one line; and the manual sync panel is back on
  [Reset | Done], with the exit-left rule narrowed to dialog [Cancel | Action] pairs. Two items
  change tests only (the PRO registration label measured in its paired layout in 42 locales, the
  740x361 sidebar measured from the last tab pill). Branch `agent/ui-owner-920` is on main
  `10f52178` (the R1 record), rebased from `0bbd077e` with identical patches. The report lists the
  owner decisions, each increment with its rebased commits and tests-first evidence (rerun at the
  rebased SHAs), the SHA map, the review findings (the Norwegian label the owner approved, the stale
  `demo.exit` name registration removed, commit hygiene notes for the squash message, the partial
  Japanese and Chinese result; from the assembly review, Leave showing the blue primary for about
  190 ms before its danger tint when a main-app button had focus, fixed tests first in `e77eead6`,
  and the forced-update case of item 10 added to the report), visible changes, open owner items
  (native checks, the stepped PIN title, Safari Japanese, a Japanese title at three lines at 320px),
  mixed versions and rollback, and QA rounds 1 to 4: the implementation round and its review; the
  assembly round at the first bump `849df009`, which the assembly review's fix moved off the branch;
  the fix round at `060dce82` (Leave in the danger tint from 0 ms per frame in three entry paths, npm
  audit 0, unit 705 files / 16,710, typecheck, lint, format, every guard, resource ownership 49
  records / 447 files, `check:workers`, critical coverage 90 / 3,515, `build:checked` with the
  release-identity and cache-version guards and the budgets, Chromium candidate E2E 19, critical E2E
  100 and the demo, back-navigation, adaptive-actions and dialog-locale-layout files 91); and round 4
  (the first PR CI failing only in the Critical browser gate on the Swedish label, the
  owner-approved fix tests first with the tail rebuilt so the bump stays the last runtime commit, the
  PR CI on the final head `3c33888c`, an automated review with no findings on the earlier head
  `7f00b9e2` and none posted for the final head within 20 minutes, so the merge went ahead without it
  (the delta was the Swedish value, its test and docs, diffed by hand), the exact-main CI on Node
  24.22.2 with unit 705 files / 16,710 plus the known skip and Linux Chromium candidate 19 and
  critical 100, one Production Release with target `app` whose smokes all passed on the first try (a
  duplicate dispatch for the same SHA was cancelled while pending and ran no job), the public service
  worker at v796, the public floor at 789 with live App 796, and the Drift Audit at 32 pass / 0 fail /
  5 manual-only). The release record's §2 now carries the 9.0.23 post-deploy items (scope and status,
  post-deploy checks with the owner device check list, and open owner items with the owner step for
  outdated approved translation suggestions, now six keys with the Swedish one) and §4 its rollback
  boundary (a forward revert at 9.0.46 / v821 or later now that 9.0.24 to 9.0.45 shipped, or the checkpoint's 9.0.22 App `e8966418`
  without `lower`); the record closed the 9.0.20 owner items this train implemented.
- [Phase 5.5 R1: old-version removal train 3 and PRO snapshot v2 reading, 9.0.22 (2026-10-29)](design/phase5-5-r1-train3-v2-accept-2026-10-29.md):
  released on 2026-10-29 18:35 KST in Release 40850068382 (PR #524, squash `71f5b96c`): the first
  runtime release of Phase 5.5 (9.0.22 / v795, App build 795, bump `16d24d89`, target `all` with 27
  App, 2 PRO room and 2 signaling runtime paths and none in the other three Workers, with the update
  dialog). It shipped after the 9.0.21 record and after Phase 5.5 F1 raised the App build floor
  from 787 to 789 at 18:16 KST (floor runs 40848023346, 40848126333, 40848295981 and 40848436128,
  then a Signaling admission smoke that admitted both rooms' host and guest at build 794 with
  `refusedBelowAppBuildFloor` 789). All six Workers run this SHA (App `e8966418`, PRO room
  `6abc7131`, signaling `36579bdf`); the floor went to 795 (F2, 2026-10-30) before the PRO Worker
  started sending snapshot v2 (R2, released 2026-10-30 00:30 KST), and R3 (9.0.25, released 2026-10-30
  07:18 KST) completed Phase 5.5. Train 3 stops sending
  the SESSION_FULL `message` and OPERATOR_TOAST `text`, the guest SFU capability marker and its
  kind (declared message kinds 102 to 101), `iceRestartVersion` on the first Standard offer and
  every answer, the four Signaling peer-open markers (only `workerVersionId` stays) and the PRO
  presence close's three playback fields, and removes the client's unreachable `leavePresence`.
  The snapshot v2 receiving side reads PRO snapshot schemaVersion 1 and 2 into one memory shape,
  the optional start kind `timingMode` of a PREPARE and COMMIT and a live LAN-direct with a null
  `liveExpiresAt`; the PRO Worker reads a stored `timingMode` and a null LAN-direct deadline while
  it still writes only the old shapes, and one shared PRO playback transition timing home serves
  the Worker and the App (RO-03). The media picker focus race pair built with the train was dropped
  when the branch moved onto 9.0.21, which ships its own fix. The report lists the owner decisions
  and order, what the 789 floor covers and where it cannot filter, each increment with its rebased
  commits and tests-first evidence, the R1-9 parent run as rollback evidence (the pre-train PRO
  Worker nulls a stored transition that names `timingMode`, drops the whole outbox and fences a
  null LAN-direct share), the sleeping-room row added after review, the SHA map, the exact-count
  guards (the declared message kinds moved in the tests-first commit, an accepted exception), mixed
  versions, rollback (the release record's §4 current boundary line), deploy conditions and order,
  the review findings and their handling, stale commit message statements for the squash message,
  visible changes, records and registry, bundle sizes, QA rounds 1 to 5 (per increment; the
  tests-first commits rerun on their rebased parents; the gate after the move at `0ee7242f`; the
  checks after the bump at `16d24d89`; the full gate at the report commit `9f2e0513`: npm audit 0,
  unit 702 files / 16,684, Worker 69 / 3,311, critical 90 / 3,515, release-tooling 14 / 433,
  typecheck, lint, format, every guard, resource ownership 49 records / 446 files, room-authority
  79 / 22 / 13 / 0, bus-pairing 203, the smoke unit rows and the R1-5 Worker rows,
  `build:checked`, `check:worker-bundles`, candidate E2E 19, critical E2E 98, PRO Playwright 30
  and the C5-0 lab 4), round 6 (the two production Remote Share smokes right after P2 on main
  `7241e89d`, both passing with the room upload assertion required and an exact whole-v1 round
  trip, F1 and its admission smoke, and the public floor read just before dispatch) and round 7
  (the PR CI and a no-findings automated review on the final head `7630b1a9`, the exact-main CI on
  Node 24.22.2 with unit 702 files / 16,683 plus the known skip and Linux Chromium candidate 19 and
  critical 98, one Production Release with target `all` whose smokes all passed on the first try,
  the Signaling smoke refusing a host without a build at 789, the public service worker at v795, the
  public floor at 789 with live App 795, and the Drift Audit at 32 pass / 0 fail / 5 manual-only),
  the note that a 9.0.14 host under the 9.0.22 Signaling Worker loses its liveness probe and PIN
  membership choice (refused by the 789 floor anyway), owner device check candidates and what was
  not verified. The release record's §2 now carries the 9.0.22 post-deploy items (scope and
  status, the owner device checks, and the Phase 5.5 steps: F2 to build 795, R2 and R3, all done
  on 2026-10-30) and §4 its entry
  (a forward revert at 9.0.46 / v821 or later now that 9.0.23 to 9.0.45 shipped, or the checkpoint's 9.0.21 App `06e79397` and
  9.0.20 Workers); with the F1 evidence the record closed the release A item's device check of a
  mixed room with a 9.0.14 device.
- [UI follow-up train 9.0.21: transient text at 600 and chips on one line (2026-10-29)](design/ui-followup-921-2026-10-29.md):
  released on 2026-10-29 15:23 KST in Release 40828643393 (PR #522, squash `3bfdffcb`): the next
  app update after 9.0.20 (9.0.21 / v794, bump `a538da11`, target `app` with 58 App runtime paths
  and none in the other five Workers, with the update dialog; the build floor stays 787). Only the
  App Worker changed (`06e79397`); the other five keep their 9.0.20 versions. It carries the owner's
  decisions of 2026-10-29: toast text back at label 600, the screensaver track title at 600, and the
  rule that transient text (toasts, loading and waiting lines, the full-screen session message,
  progress and result lines, mode notes) and red error lines read at label 600 while text that stays
  on the screen reads at body 400 (app, `/events`, design system; the resting `/events` nickname
  hint goes from 650 to 400); and chips that fit on one line at the selected 700: a HarfBuzz width
  guard test for 14 groups in 42 locales (two direct devDependencies the lockfile already held), the
  settings and setup role chips on the demo's short role words (four `role.*` keys removed), shorter
  copy in 38 locales (152 lines; English '3. Effects'; a shortened Advanced chip says Manual, in
  Tamil the catalog's word, owner-confirmed), the demo role switch icon hidden up to a 448px
  container (phones 421 to 532px wide, two-column layouts 851 to 1120px), and 14 accepted labels
  under the 4px spare. Assembly added the help tab's role names on the chip words in 42 locales, the
  review fixes to the guard (it reads back the CSS declarations each label box comes from and the
  label letter spacing token, so a change to one of them fails, while a new rule that narrows a box
  does not; accepted labels match by screen, with the el and pt-br near misses at 720x360 listed),
  the Turkish step 4 in sentence case, the Node 24.22.2 and qs 6.16.1 security increment (Dependabot
  alert 33, GHSA-6pq8-jhm2-2vcw, expected to close once GitHub reads the lockfile on main), and the
  media picker focus race fix the 9.0.20 record left for the next App release (a keyboard open keeps
  focus that a fast Tab moved inside the picker before the 0 ms focus timer ran; a pointer open
  still focuses the picker surface). Branch `agent/ui-921` is on main `0bbd077e`, rebased twice
  with identical patches, and its assembly review moved the bump after the review fixes. The release
  record's §2 now carries the 9.0.21 post-deploy items (scope and status, post-deploy checks, open
  owner items and the owner step for outdated approved translation suggestions) and §4 its rollback
  boundary (a forward revert at 9.0.46 / v821 or later now that 9.0.22 to 9.0.45 shipped, or the checkpoint's 9.0.20 App
  `50d6557f`); the release closed the focus race item and the 9.0.20 owner decisions this train
  implemented. The report lists the owner decisions, each
  increment with its commits and tests-first evidence, the SHA map after assembly, the review
  findings, visible changes, what did not change, open owner items (among them seven native checks),
  mixed versions and rollback, what release preparation did and what is left (the squash message
  fixed three stale commit message statements; the rejection or re-review of every outdated
  approved suggestion in admin Translations is the owner's), and QA rounds 1 to 6: per increment;
  the rebase and full gate at `986f0c35`; the Chromium and WebKit comparison with main (211 weight
  pairs, 17,052 chip readings in 42 locales, 302 screenshot pairs with no unexplained difference);
  the assembly gate at `c7c50314` on Node 24.22.2; the gate after the assembly review at `a538da11`
  (npm audit 0, unit 700 files / 16,615 with no skip, typecheck, lint, format, every static-lane
  guard, `check:workers`, critical, release-tooling and Worker coverage, `build:checked` with the
  cache-version and release-identity guards and the budgets, `check:worker-bundles`, Chromium
  candidate E2E 19 and critical E2E 98, and the A5 check in Chromium and WebKit: with a Tab that
  lands before the timer, the build without the fix returned focus to the first action in 20 of 20
  opens in both engines and the fixed build kept it in 20 of 20); and round 6 (the PR CI and a
  no-findings automated review on the final head `19dc9e3a`, the exact-main CI on Node 24.22.2 with
  unit 700 files / 16,614 plus the known skip and Linux Chromium candidate 19 and critical 98, one
  Production Release with target `app` whose smokes all passed on the first try, the public service
  worker and bootstrap at v794, the public floor at 787 with live App 794, and the Drift Audit at 32
  pass / 0 fail / 5 manual-only). It also lists what was not verified (WebKit without WebRTC or Web
  Audio, real devices and iOS Safari, Linux fonts, related E2E and the full WebKit lane, a full
  serial E2E on the 9.0.21 runtime, native review, the update dialog in a production browser) and
  the owner device check list.
- [UI follow-up train 9.0.20: dialog exits, weight roles and the PRO receipt follow-ups (2026-10-29)](design/ui-followup-920-2026-10-29.md):
  one app update (9.0.20 / v793, bump `e1e638bf`, target `all`, with the update dialog; the build
  floor stays 787) on main `91aa77bb` (App 9.0.19, PRO room train A). It deletes the hidden
  settings device list and the kick icons' dead opacity (V1), describes the locked reverb, EQ and
  virtual effect groups in a sentence for screen readers (V2, translation guide rule 10), keeps
  the manual sync panel in view on short screens and lowers the compact sidebar wordmark rule from
  370px to 360px (V3), turns the member kick icon red on keyboard focus (V4), shows the room limit
  toast when a full ledger refuses a person's PRO playback command (B1, receipt item 1), splits PRO
  room capacity refusals by cause and answers a full playlist with `PLAYLIST_CAPACITY_EXCEEDED`
  (B2, receipt item 2, PRO room Worker and the shared diagnostics file, so the signaling, PRO room
  and App Workers all redeploy), documents the Developer API replay receipt windows (V5), and
  answers the PRO room registration question with its own verb in 42 locales. The dialog exits
  (owner decisions of 2026-10-28, F1 to F15 and four review fixes): no modal closes on an outside
  click except the phone chat sheet, every leavable state shows a visible exit on the left, and
  Escape does exactly what Back does on every window. Every app text takes one of five weight roles
  (title 700, selected 700, unselected 500, label 600, body 400), titles are tracked by script and
  the body is kerned, and by the owner's decision of 2026-10-29 the header loading status stays at
  label 600 beside the account pill. The report lists each increment with its final and pre-assembly commits, tests-first
  evidence and checks, the assembly fixes, the review findings and their handling, visible changes,
  19 owner items left open (two found by the assembled 42-locale sweep: the demo header track title
  wrapping after the persistent exit, and dialog titles measured for the first time), mixed
  versions and rollback, and QA rounds 1 to 6: per increment, assembly, the final checks and
  release prep at the bump (full unit 16,528 on a rerun after load timeouts, Worker and critical
  coverage, `build:checked`, worker bundles, candidate 19, critical 98 and 289 related E2E, the
  partial-release decision of App 98, PRO room 2 and signaling 1 runtime paths), the sweep
  against 9.0.19 on Windows and Linux font emulation, and round 5 (one PR CI run and a no-findings
  automated review on the final head `a40da6ff`, the exact-main CI, three Production Release runs
  on the same candidate, the first two failing at the signaling smoke (an HTTP 503 WebSocket
  upgrade, then a 1006 close) and rolled back automatically with a successful recovery boundary
  job, the third deploying all six Workers, the smokes, the public assets at v793 with the V5
  developer docs, the public floor at 787 with live App 793, and the Drift Audit), and round 6, a
  local WebKit comparison of the bump against 9.0.19 on a second Windows machine (Windows WebKit
  26.6 with iPhone 13 emulation: every 9.0.20 suite failure also fails on 9.0.19 or is fixed
  by #518; of ten probe cases worse than 9.0.19, three from the weight roles go to the owner, and
  seven titles gain a line under the 2026-10-28 title-tracking rule with no clipping; the comparison
  recommends no change to their line counts, which stay open as owner items 3, 13 and 19). PR #516
  (squash `226219c5`) was released on 2026-10-29 05:52 KST in Release 40766362722 with target `all`.
  A manual Full E2E on main `c37220df` (run 40708045873) also failed in tests this train does not
  change; #518 (`edd6ee94`, tests only) found and fixed their cause, and the Full E2E run
  40773241908 on main `edd6ee94` (the 9.0.20 runtime) passed in Linux Chromium and Linux WebKit,
  which closed that open item. The rare media source focus race the same investigation found was
  fixed in 9.0.21 (released on 2026-10-29 15:23 KST), which closed that item and, with its chip
  copy, owner item 4 and the selected-700 part of owner item 13. 9.0.23 (released on 2026-10-29
  21:22 KST) closed owner items 1a, 6, 7, 8, 9, 10, 11, 12 and 18, the Japanese and Chinese title
  word breaks and title overflow in 13 and 19, and the demo finish pair in 17.
- [PRO receipt follow-up train A (2026-10-28)](design/pro-receipt-followup-a-2026-10-28.md):
  the owner's decision of 2026-10-28 on item 3 of the receipt retention follow-ups, shipped as a
  PRO room Worker-only train (target `pro-room`; the App stays 9.0.19 / v792, so no update
  dialog). The commit that finishes an explicit delete releases the delete's pending receipt
  through the ledger owner (`releaseIdempotencyRecord`) and stores no final receipt, and
  `releaseSettledReserveReceipts` releases a reserve receipt once its asset is gone, no longer
  `reserved` or being deleted, so a completion frees its reservation's slot inside its own
  commit (RO-53, same owner, no new machine). A bulk delete no longer fills the shared 256-slot
  ledger while R2 deletes succeed, and uploads hold one two-minute receipt per file, about 256
  files a window instead of 128. Only same-key resends the App never sends get new answers
  (`ASSET_NOT_FOUND` at once, or a new reservation). The same report records the owner's
  decisions on items 1 and 2 (released in 9.0.20) and on item 4 and BOT's 24-hour Developer
  mutation receipts (kept, with the rationale in RO-53). It lists each increment with its
  commits (tested on main `1a99fe49`, then rebased onto the docs-only 9.0.19 record `2bed0a50`
  with identical runtime and tests, both SHAs listed), the tests-first evidence (12 titles, 13
  cases failing on the 9.0.18 PRO room runtime), the changed answers, QA rounds 1 to 3 with
  their tested SHAs and limits (round 3 is the PR CI, automated review, exact-main CI, release and
  public-check round: one PR CI run and a no-findings automated review on the final head
  `b0530a8f`, the `pro-room` deploy with the App and the other four Workers left as they were, the
  PRO room smoke reading the new version on its first attempt, the public assets still at v792,
  the public floor at 787 with live App 792, and the Drift Audit), the rollback to the 9.0.18 PRO
  room Worker `61e60919` with its one-off check against the `53a4f397` Worker code and the
  release's checkpoint holding that Worker, mixed versions, and the limits (bulk deletes during an
  R2 outage, a reservation that corrupt-marker load repair restores without its receipt, nothing
  run on real devices). PR #512 (squash `7824d301`) was released on 2026-10-28 22:03 KST in
  Release 40692809244 with target `pro-room`, so only the PRO room Worker changed (`a04acac1`).
  The ledger state in a production room cannot be read from outside, so the production bulk-delete
  check stays open in the release record.
- [UI bundle: the UI audit and hint-copy audit recommendations (2026-10-27)](design/ui-bundle-2026-10-27.md):
  the owner's 2026-10-27 instruction to ship every recommended direction of the two audits as one
  app update, with the owner's final decisions of 2026-10-28 (U14), which supersede the earlier
  15px / 700 label style, its narrow-slot exceptions (U12, U13 and the round 9 setup pill) and the
  12px side-by-side gap. Button labels take one of three roles as root tokens: CTA, every action
  button, 15px / 600 / 1.25 with normal tracking; chip, the choice chips, 14px; tab, the desktop
  settings section tabs, 13px (the owner's local preview of 9.0.18 at 600 is the final draft; 700
  clumped in dark mode, Korean most of all). Where the CTA role measured worse than 9.0.18 in 42
  locales at 320 to 390px, the slot stays inside the roles: `.btn-label-compact` takes the chip
  size up to 719px on Sign out and Delete account (always one size) and the media source options,
  whose labels also wrap at word boundaries (Korean keep-all, Japanese phrases), and the demo tour's
  two-per-row actions take the tab size up to 420px. Action pills sit 10px apart side by side and
  12px stacked, 56px tall, with 24px side padding on dialog pills at 360px and below; the Korean
  invite pill, administrator permissions title and demo step chips keep their 9.0.18 text. The
  final check's fix (U15) puts the startup failure Retry in the CTA role like every other action
  button (15px / 600 / 1.25, normal tracking); phrase breaking for the Japanese setup action pill
  was tried and dropped, because the wider pill pushed the Back and pill group 12.8px right of the
  screen center against the setup centering decision (8.11.16), so owner item 14 is open again. The
  PR CI fix (U16) draws the media source options, their BETA badge included, without font hinting on
  Linux (`text-rendering: geometricPrecision`, not on the play tab Sync and Media): Linux Chromium
  hinted Pretendard to whole-pixel advances, so the compact labels wrapped more than 9.0.18 in the
  second PR CI. Windows line breaks are unchanged and no owner decision changes. The
  bundle also gives every red text or icon one `--danger-foreground` role (the default themes keep
  production's `#ff3b30` and the 9.0.18 tints, the high-contrast palettes keep the 4.5:1 contract,
  account deletion keeps its 9.0.18 tints); one runtime hover gate owned by
  `src/ui/hover-pointer.ts` (convertibles hover alike in laptop and studio posture; Chromium 79 TVs
  lose hover looks only, known risk #20); a shorter playlist minus at the chevron weight; one
  control-hint owner with reasons as descriptions; a fixed minus name and a status cell for the
  selection count; noun-form names and hints in 42 locales with a locale review; the English
  `YouTube Video` kept; and the removal of an unreachable red "Disconnected" badge. PR #510
  (9.0.19 / v792 from bump `c2ef3d97`, App build 792, last code commit `af713563`, released
  2026-10-28 19:19 KST in Release 40670881163 from main `1a99fe49`, target `app` because only the
  App has runtime path changes against production, 84 paths, so the other five Workers keep their
  9.0.18 versions, with the update dialog) merged main at 9.0.18 / v791 (`6a23c46e`) in
  `2eaaf4c5`. The report lists each increment (U1 to U16, the locale review and the release-prep
  bump) with its commits, tests-first evidence and tested SHA, the U14 role table, the
  measurements against 9.0.18 (26,628 real-app cases, the two-button stack counts, the preview
  comparison), the guards added, the review findings and their handling, visible changes, owner
  decisions left open, QA rounds 1 to 14 (round 13, after the second PR CI failed on Linux font hinting and U16 rebuilt
  the chain on U15 and re-applied the bump, reproduces the CI failure with a local Linux font
  emulation, measures 0 media labels worse than 9.0.18 at every CI size, and passes the full `build:checked`, unit 16,372, the candidate E2E (19), the critical E2E (94, with the narrow-slot probe at 19 sizes) and four touched or related E2E files (61); round 14
  is the PR CI, automated review, exact-main CI, release and public-check round: the final PR CI
  and the exact-main CI pass the critical browser gate on Linux, so the U16 fix holds there; the
  automated review ran only on the first head `1524c1d4`, not on U12 to U16; the App-only deploy
  with the five other Workers left at 9.0.18, the smokes with the strict page floor read of 787
  and build-792 Standard signaling admission, no pre-deploy floor `status`, the public floor at
  787 with live App 792, and the Drift Audit), what was not verified (real devices,
  WebKit, screen readers, the production update dialog) and the owner device check list.
- [PRO room receipt retention (2026-10-27)](design/pro-receipt-retention-2026-10-27.md):
  the PRO room's shared browser receipt ledger (256 receipts) keeps each receipt only as long as
  the App can send its request again (owner decision 2026-10-27, RO-53): two minutes for edits,
  playlist switches and transfers, reservations, deletes and the BOT's browser receipts (context
  and execute); playback the same unless a longer configured presence needs more; upload
  completion until a playlist names its asset, at most until orphan cleanup collects it. Receipts
  an earlier Worker kept for 24 hours are cut at the next prune. The separate Developer ledger is
  unchanged: Developer mutation receipts (an issued key's, and BOT's internal ones that replay BOT
  additions) keep 24 hours, and Developer command receipts, BOT playback included, keep 10
  minutes. The cap stays 256 so a rollback to the 9.0.17 PRO Worker still loads the room (checked
  once against the `53a66d65` Worker code). A full ledger now shows `pro.room_state_limit`
  (42 locales) on playlist edits, switches, transfers and drag reorder instead of "The playlist
  changed" or "Couldn't move the track"; uploads keep the dialog's `pro.upload.room_state_limit`.
  PR #508 (9.0.18 / v791 from bump `faaa8735`, App build 791, released 2026-10-27 18:14 KST in
  Release 40478660296 from main `53a4f397`, target `all` because the App and PRO room Workers have
  runtime path changes against production, App 51 and PRO room 2; all six Workers were
  redeployed, with the update dialog) merged main up to the 9.0.17 record `809c9466` (#507) in
  `d572aef1`. It shipped first (a same-day order change made while the owner was away, under the
  deploy-when-ready rule, because the UI bundle was still in progress; the owner had placed it
  after the UI bundle), and the UI bundle followed as 9.0.19 / v792 on 2026-10-28. The report lists each scope's
  old and new window, the review adjustments, rollback and its one-off check, what stays as is,
  the tests-first evidence (12 Worker and 9 client tests failing on `53a66d65`; the BOT one pins
  new behaviour rather than an old defect) and QA rounds 1 to 7 with their tested SHAs and limits
  (round 3 adds the build without the cache-epoch guard and the critical, PRO and candidate E2E;
  round 4 covers the main merge; round 5, after the bump, passes the full `build:checked`, unit
  16,249, Worker 3,237, critical coverage 3,462, the critical, PRO and candidate E2E, and eager JS
  +21 B gzip against main; round 6 is documentation only after the release-prep review: the
  record's §1 order sentence, and narrower BOT, playback and upload capacity statements; round 7
  is the PR CI, automated review, exact-main CI, release and public-check round: no automated
  review findings on the final head `bfd6f49d`, the six new Worker versions, the smokes with the
  strict page floor read of 787 and build-791 Standard signaling admission, no pre-deploy floor
  `status`, the public floor at 787 with live App 791, and the Drift Audit). The first prune of
  existing 24-hour receipts in a real room was not observed, and the owner decisions the report
  leaves open stay in the record.
- [PRO upload completion and authority feedback (2026-10-27)](design/pro-upload-reliability-2026-10-27.md):
  production diagnosis, R2-internal copy without streaming a full file through the Worker,
  a binding-copy fallback with bounded copy diagnostics (RO-52), completion retry continuity,
  explicit file-limit, room-capacity and receipt-ledger feedback, and pending authority labels.
  PR #503 (9.0.17 / v790 from bump `a233dd7b`, released 2026-10-27 13:42 KST in Release
  40450793853 from main `53a66d65`, target `all` because the App, PRO room and signaling
  Workers have runtime path changes against production; all six Workers were redeployed) merged
  main up to the Phase 5 5B record `0228276e` (#506) in `d88cbb3b`; the owner approved its
  merge, release and record on 2026-10-27. The report lists each QA round with its tested SHA and
  limits, including the final local checks after the bump (unit 16,222, Worker 3,220, critical
  E2E 65/65, critical coverage 3,452, PRO upload Playwright 4/4, candidate Playwright 19/19, and
  eager JS 466,797 B, +1,145 B against production main `a930030a`) and the PR CI, automated
  review, exact-main CI, release and public-check round (no automated review findings on the first
  runtime `f2f25d90` and no automated review result for the final head `6064a195`, the six new
  Worker versions, the smokes with the strict page floor read of 787 and build-790 Standard
  signaling admission, no pre-deploy floor `status`, the public floor at 787 with live App 790,
  and the Drift Audit). It also covers the failed-release rollback of the PRO Worker, the
  App-only rollback's 5-second facade, and the room receipt-ledger limit, whose retention the
  owner decided to shorten in its own train (released 2026-10-27 as 9.0.18 / v791, ahead of the UI
  bundle after a same-day order change made while the owner was away).
- [Phase 5 train 5B: receive-slot behaviour fixes and the system-audio old-version items (2026-10-26)](design/phase5-5b-receive-slot-behaviour-2026-10-26.md):
  release evidence for the structure program's second Phase 5 app train (9.0.16 / v789 from bump
  `198b8cf8`, released 2026-10-27 10:18 KST in Release 40431540366 from main `a930030a`, target
  `app`, with the update dialog; it shipped after the forced-update train 9.0.14 / v787 with its
  client floor 787, release W and the removal train's App release A 9.0.15 / v788 in one line,
  after merging main up to release A's record `1ff7fdf2`; App 17 runtime paths and 0 for the other
  five Workers against production `5dd7cc1f`). It fixes the gaps that C4-0 pinned as today's behaviour in the system-audio receive
  slot (RO-04) in six labelled groups, each with its failing test first: the attach fence (gaps 2
  and 3), the PRO coordinator's force-stop and successor teardown (4, 5), the Standard SFU
  re-publication handoff (1), the sharer's own claim (6), the nested end's restore point (7) and
  the route closures the slot hears (11, 12). C4-13 makes the post-share restore and the
  foreground repair arm a hidden share end's return once (gap 10; RO-21 owner-in-place, RO-41
  deleted). It also removes the system-audio old-version items (OV-A04, the coordinator-era
  adopt, OV-B05, OV-B06, OV-A08) and the dead channel argument of the direct call event (SA-9).
  The report lists the owner decisions, the plan critique and its dispositions, each increment
  with its commits, tests-first evidence and fixed device expectation, what stays as is (gaps 8,
  9, 13, 14, SA-2 and an owner observation on the direct call's boundary refusal), the
  compatibility lines for the release record (one changed sent frame, the failed-direct READY
  audience) with who loses what for each old-version item, the QA rounds (per increment, a
  train-end replay of the system-audio suites at every code commit, the final checks, the lane
  checks again after each of the two main merges, the guard counts after the release A record merge,
  and the final checks after the bump: unit 16,108, Worker 3,182, critical E2E 61/61, critical
  coverage 3,444, candidate Playwright 19/19, system-audio Playwright 5/5), the PR CI, Codex,
  exact-main CI, release and public-check round (Codex with no findings on `e9dc1ed3`, App
  `317f176f` with the five unchanged release W Workers, the smokes with the strict page floor read
  of 787 and build-789 Standard signaling admission, no pre-deploy floor `status`, the public floor
  at 787 with live App 789, the Drift Audit, and one low review finding on a stale code comment
  carried to the UI bundle), the eager JS delta
  (465,652 B, -115 B against production main `5dd7cc1f`), the deploy target and rollback boundaries
  (including what relies on the 787 floor), a `guard:sw-cache-version`
  false pass on a merge commit (no tooling change) and what was not verified on devices.
- [Old-version removal train 2, release A: App compatibility code below the 787 build floor (2026-10-26)](design/old-version-removal-2a-app-2026-10-26.md):
  release evidence for the App release of the second removal train (9.0.15 / v788 from bump
  `8407046a`, released 2026-10-27 06:20 KST in Release 40403240275 from main `5dd7cc1f`, target
  `app`, with the update dialog; its Worker release W shipped first on 2026-10-27 03:34 KST and
  keeps its own report, and Phase 5 5B followed as 9.0.16 / v789 on 2026-10-27 10:18 KST). It
  removes App code that only served clients below the App build floor 787 (9.0.14), on in
  production since 2026-10-26 16:15 KST. Increment A-1, C5-12 Inc 3: after ICE
  recovery a preload yields to the main lane for the same tuple without waiting for the host's
  route re-detection, and the route-permission machine (`RestartedPreloadLane`) is gone.
  Increment A-2 (OV-F01, OV-F03): bulk credit and control isolation wait for the peer's hello
  (the 1 s fallback for 8.11.22 and older peers is gone), and no end sends the side route's
  `restart-capable` advertisement any more. Increment A-3 (OV-A19, OV-F04 stage 1, OV-A12):
  the Standard host probes its signaling socket, sends the PIN membership choice and requests
  Remote Share upload assertions without reading the Worker's peer-open markers, every Standard
  connection binds its ICE restart without the first-SDP mark, the resume challenge drops
  `guestTime`, and the Remote Share client takes only the required assertion mode. Increment A-4
  (OV-F05, OV-F06, Q4 receive side): DEMO_PLAY carries only `hostStartAt`, guests no longer send
  `FILE_R2_CAPABILITY` (declared message kinds 103 to 102), SESSION_FULL and OPERATOR_TOAST are
  accepted without their fallback text, and train 1's leftover receive allowances are cleaned
  up. Increment A-5 (OV-A20): PRO requests no longer fall back for PRO Workers below the 9.0.4
  entry-policy marker (no READY or upload-completion retry without the duration, a 404 from the
  duration route no longer switches reporting off, a refused keep-present PIN choice is an
  ordinary error), unused PRO API calls and five locale keys are gone, and known-accepted #15 is
  retired. Increment A-6 (OV-A18, OV-B09, SK-05, OV-A23): service-worker activation no longer
  scrubs runtime caches of v390 and older, the root English manifest and its app-shell entry are
  gone, three orphan locale keys go, the dev proxy drops the retired playlist-entry route, and
  the update reload fallback and the cooldown bound keep their behaviour under current wording.
  The report lists the owner's policy and the floors each increment relies on (where the 787
  floor cannot filter, such as an established P2P session or the fail-open window), each
  increment with its commits, tests-first evidence, removed lines and who loses what, the
  registry and record changes (RO-18, RO-15, RO-06, RO-22, known-accepted #12 and #15, the PIN
  and PRO recovery notes), the guard baselines, the per-increment local checks, the train-end
  lane checks (C5-0 lab, critical E2E, critical coverage), the merge with release W and the
  post-bump final checks (unit 680 files / 16,052, Worker 67 / 3,182, full `build:checked`,
  critical E2E 61/61, critical coverage 87 / 3,403, candidate Playwright 19/19, PRO Playwright
  26/26, C5-0 lab 20/20), the mixed-version table, what it skips and which train takes each item
  (release W, Phase 5 5B, train 3), the eager JS budget (465,767 B, −1,107 B against production
  main `a3893f04`), the deploy order and versions with release W and 5B, the rollback
  boundaries, the PR CI, Codex, exact-main CI, release and public-check round (Codex with no
  findings on `5b045bfc`, the App version and the five unchanged release W Workers, the smokes
  with the strict page floor read of 787 and build-788 Standard signaling admission, no
  pre-deploy floor `status`, the public floor at 787 with live App 788, the Drift Audit), and
  what is not verified.
- [Old-version removal train 2, release W: Worker request shapes below the App build floor (2026-10-26)](design/old-version-removal-2w-workers-2026-10-26.md):
  release evidence for the Workers-only release of the second old-version removal train (released
  2026-10-27 03:34 KST in Release 40378059253 from main `a3893f04`, target `all`, no SemVer or
  service-worker cache change, so production stays 9.0.14 / v787 with no update dialog; the
  same-value floor `set` 40379025557 then ran the fixed floor proofs in production). With the App build
  floor at 787 since 2026-10-26 16:15 KST, Remote Share accepts only the v3 session body and treats
  the `optional` assertion mode as invalid; the PRO Worker reports `passwordRequired` and
  `playlistSlots` without the opt-in headers, refuses or drops the request shapes and endpoints of
  Apps below the floor (the ownership-transfer `newPin` of 9.0.0 to 9.0.3 included), removes four
  expired stored-state migrations and takes the presence close's playback fields as optional; the
  Signaling Worker requires the PIN fields on `host-auth` and `room-password-set` and drops the
  `legacy-<uuid>` PIN fences; the App Worker retires the old playlist entry route, the three-field
  announcement body, the requestId-free PRO admission bypass and the opt-in pass-through. The release
  smokes and the floor tool change in the same increments (the PRO canary sends the opt-in header,
  every `host-auth` carries the PIN fields, an invalid first frame fails at once). The report lists
  the owner policy and the floor, each increment (W-1 to W-4) with its commits, tests-first evidence
  rerun on the parents, removed lines and who loses what, the lane checks, the unchanged eager JS and
  the Worker bundle deltas, the skipped items and the train that takes each, the deploy conditions
  and order, the same-value floor `set` right after the release, rollback boundaries, the PR CI,
  Codex, exact-main CI, release and W-verify round (the PR CI that started only after a close and
  reopen, the six Worker versions, the release signaling smoke as the first production proof that
  Signaling admits build-787 hosts and guests with the floor on, public checks, the Drift Audit) and
  what was not verified.
- [Forced update train 9.0.14: the App build floor and C5-12 Inc 1 (2026-10-25)](design/forced-update-9-0-14-2026-10-25.md):
  release evidence for the train that adds the forced update (9.0.14 / v787 from bump `2077ef60`,
  released 2026-10-26 16:10 KST in Release 40283632968, target `all`; the first App build floor,
  787, was set at 16:15 KST by App Build Floor run 40284593490; the 9.0.12 receive-slot train and
  the 9.0.13 old-version removal train took the earlier numbers). The App reports its build (the service-worker cache epoch) in
  Standard `host-auth` and `guest-auth`, reconnects included, and in a header on every PRO request; the Signaling and PRO Workers refuse new entries
  below the effective App build floor (the stored floor in the service-control object, bounded by
  the live App build that the App Worker reports every minute; 0 = off), and open sessions
  continue. A refused page, or one that reads a higher floor at start or on return to the
  foreground, shows the same update dialog without Later (RO-22), and the return-time dialogs
  yield to it (new record RO-51). The floor is set only through GitHub Actions OIDC (no secret;
  the admin dashboard can only lower it). C5-12 Inc 1 lets a guest awaiting a preload take the
  main header of its admitted direct session on any route. The report lists the owner's policy
  and four decisions with the ~22:00 start/resume addition, each increment with its commits and
  tests-first evidence, every caller of the gated entry points, what 9.0.13 and older clients
  show, the operations for raising, lowering and rolling back (the first floor is this train's
  own build, 787), the eager JS delta (+2,286 B against main `4d7650c0`), the final local
  verification at the bump after merging the removal train, the Codex P1 fix (the OIDC floor
  setter matches `workflow_ref`), the PR, exact-main CI, release and first-floor round (status,
  check and set runs, public checks, a 503 from the public floor status before the first App
  report), what was not verified (Signaling admitting 787 with the floor on, real older tabs) and
  the owner's device steps. Known-accepted #13 is retired by the first floor.
- [Old-version removal train 1: compatibility code below the existing client floors (2026-10-25)](design/old-version-removal-1-2026-10-25.md):
  release evidence for the first train under the owner's policy of 2026-10-25 that older app versions
  are no longer a design constraint (9.0.13 / v786, released 2026-10-26 12:41 KST in Release
  40265098681, target `app`; it shipped right after Phase 5 5A, which it merged after 5A's release). It ships only the
  items of the old-version compatibility survey that need no client floor and do not touch the
  parallel forced-update and Phase 5 5A trains' files. The existing floors (signaling 8.0.8, the
  Standard join bootstrap 8.3.16, the PRO heartbeat 9.0.0) already keep those clients' senders out.
  Standard P2P message types drop from 121 to 103, fields every current sender includes become
  required, a PRO room refuses browser data connections, local file guests are routed by room size
  alone, and side-route restarts no longer wait for the peer's advertisement. The report lists the
  owner policy and decisions, each increment (R1 to R8) with its commits, tests-first evidence,
  removed lines and who loses what (survey OV ids), the one accepted wire exception (the per-effect
  follower frames of 9.0.10 to 9.0.12 hosts), the accepted older-tab degradations, the skipped items
  and the train that takes each, review lows left as follow-ups, survey corrections, lane checks
  (C5-0 lab included, with one timing failure read from the lab evidence and a clean rerun), the
  merge with the released 5A, the final bump round, the eager JS delta (-13,610 B against the
  9.0.12 main, nine eager chunks folded into the entry), the PR, exact-main CI and release round
  (Codex had no findings on the last head) and what was not verified.

- [Phase 5 train 5A: one system-audio receive slot, behaviour-neutral (2026-10-25)](design/phase5-5a-receive-slot-2026-10-25.md):
  release evidence for the structure program's first Phase 5 app train (9.0.12 / v785,
  released 2026-10-26 10:34 KST in Release 40254651587, target `app`; since the 2026-10-26
  integration it shipped before the forced-update train, with no floor). One
  deferred-only owner, `src/network/system-audio-receive-slot.ts` (RO-04), now holds the device's
  system-audio reception: the start, the trust-boundary waits, the restore point, the receive deadline and its
  expiry, every route's source and primer, the interrupts, the delivery handoff, the PRO
  coordinator's adopt of the Standard SFU route and the end. The Standard direct call, the
  Standard SFU guest and the PRO coordinator call it, the PRO service imports no Standard receive
  adapter, the media values have one home (`system-audio-media.ts`) and the PRO publication
  teardown composes three named operations (RO-40 retired). The report lists the owner's Phase 5
  decisions, the preparation (T1 to T8, T8 negative), each increment with its commits and
  tests-first evidence, the 14 gaps left as today's behaviour for train 5B, the neutrality
  evidence (the final contract and evidence-line suites also green on the 9.0.11 runtime), the
  P5-D4 A owner question on the chunk change after C4-7 and the owner's answer (2026-10-26,
  about 09:10 KST: ship as is, so the new lazy chunk stays), the overlap with Phase 4, the eager
  JS delta (+12 B on the final bump, no code), the PR, exact-main CI and release round (the last
  head's Codex review had no result when it merged), and the Phase 5 device steps not yet run.

- [Phase 4 train 4D: the side route's outage deadline joins the link-liveness owner (2026-10-25)](design/phase4-4d-side-route-owner-2026-10-25.md):
  release evidence for the structure program's fourth Phase 4 app train (9.0.11 / v784,
  released 2026-10-25 21:30 KST in Release 40193266364, target `app`). After known-accepted #18 retired on the owner's Wi-Fi to LTE device check on 9.0.10,
  the owner chose (2026-10-25, about 16:30 KST) to ship C5-9 with a forward revert to the 9.0.10
  side-route behaviour if the later device check fails. `LinkLiveness` now also holds the side
  (isolated control) PC's outage deadline: 15 s per outage, deferred while the original route is
  down, re-armed after it recovers and capped at 30 s, and the non-renewing 15 s grace of a route
  that cannot restart. Control isolation keeps only the restart protocol, and the transport-health
  guard retires its eight former deadline names (the control-isolation part of C5-10). The report
  lists the #18 precondition, each increment with its commits and tests-first evidence (a
  two-connection suite green on the 9.0.10 code), what stays byte-identical (the three device
  evidence lines, close causes, the peer restart windows, every frame), mixed versions with the
  frozen C9 fixture, the eager JS delta (+181 B at D1, +171 B after the bump), the local
  verification after the bump (C5-0 lab included), the PR, exact-main CI and release round, and the
  owner's device procedure for 4D.

- [Phase 4 train 4C: one link-liveness owner per Cloudflare data connection (2026-10-25)](design/phase4-4c-link-liveness-2026-10-25.md):
  release evidence for the structure program's third Phase 4 app train (9.0.10 / v783,
  released 2026-10-25 14:41 KST in Release 40166305040, target `app`). One owner, `LinkLiveness`, now holds the original
  route's 15 s grace, published recovery deadline and one-restart gate (C5-6), the guest
  background-resume probe over both routes (C5-7) and every close of the link with its first
  cause (C5-10, the connection part; C5-9 and the side route's own deadline stay out). Transport
  health reads that owner's view (C5-8, the one behaviour change): while the owner holds an
  original-route interruption whose restart reads `connecting` or `new`, the peer is no longer
  bulk-writable and its preload lane stays paused until the owner's `connected`. The report lists
  each increment with its tests-first evidence, the owner's decisions (deploy as soon as the
  automated gates pass, device checks no longer a gate, no raw-versus-view log), the merge of
  4B's final main, the review lows, the eager JS delta, the PR, exact-main CI and release
  round, mixed versions, and the device procedures not yet run for C5-6, C5-7 and C5-8.

- [Phase 4 train 4B: owner-chosen transport and rejoin behaviour changes (2026-10-25)](design/phase4-4b-behaviour-2026-10-25.md):
  release evidence for the structure program's second Phase 4 app train (9.0.9 / v782,
  released 2026-10-25 10:43 KST in Release 40151618508, target `app`). After ICE recovery a resumed
  preload yields to the main file lane for the same tuple once the host has
  re-detected the guest as local (C5-12, with its known limits; a 9.0.9 guest
  still re-detecting its route takes the main header its own recovery request
  asked for, Codex P2 on #487, and older guests keep that residual), on top of one
  release call and a tuple query for both bulk lanes (reduced C5-11); error,
  failed-join and PRO epoch closes name their own close cause; a Standard guest
  keeps its last close cause across its disconnect reload for `/debug`; a PRO
  listener's visible pause ends a pending rejoin retry; and demo playback no
  longer arms the queue's canonical timeline. The report lists each increment
  with its failing test, the owner's 2026-10-25 decisions (deploy as soon as the
  automated gates pass, device checks no longer a gate), the close-cause rows
  added to the device allow table, the P4-D9 trade-off, the C5-0 lab's
  single-stream evidence, mixed-version rows, the PR, exact-main CI and release
  round, and what was not device-checked.

- [YouTube host speaker reference after a zero-start (2026-10-25)](design/youtube-host-speaker-reference-2026-10-25.md):
  9.0.8 / v780 with #483, released 2026-10-25 04:00 KST in Release 40123156024 (target `app`). Owner
  report: a Standard room's first YouTube playback stayed misaligned
  however often the host pressed Sync, until a seek. Since 8.10.2 the host kept
  its own media startup lateness out of the published room position, so every
  guest re-aligned to a position the host speaker never played. The host now
  removes only its deliberate advance, as a seek does. The report records a
  real IFrame API startup probe, the host and guest Sync path comparison,
  regression and lab evidence with tested SHAs, and the owner device check.

- [Spectrum grid colour on iOS (2026-10-25)](design/spectrum-grid-ios-color-2026-10-25.md): 9.0.8
  (released as v780 with #484 in Release 40123156024, 2026-10-25 04:00 KST) fix for the 100 Hz, 1 kHz and 10 kHz lines turning blue on iOS while paused. 8.11.40 (#442) reused one
  grid gradient object across draws. By WebKit's source, its GPU-process canvas recorder then elides that
  gradient after the batched resting line, so the grid strokes in the line's blue (not yet seen on a
  device). Each draw now creates its own gradient, pinned by unit tests that model the recorder; Chromium
  and Windows WebKit pixels are unchanged.

- [Phase 4 train 4A: transport liveness and output rejoin, behaviour-neutral (2026-10-24)](design/phase4-4a-transport-rejoin-2026-10-24.md):
  release evidence for the structure program's first Phase 4 app train
  (9.0.7 / v778, released 2026-10-24 23:26 KST in Release 40102311205, target `app`). One home each for the
  15 s RTC interruption grace, the signaling reconnect schedule, the bulk-lane
  and guest receive deadlines and the shared start and re-align values; one
  info line naming the cause of every Standard logical connection close; one
  transport-health read path with its guard; the rejoin router's dead state
  deleted; and startup leaves that take lazy-only PRO and system-audio code out
  of the first load (eager JS 491,726 -> 477,138 B gzip). The report lists each
  increment and QA round with tested SHAs, the owner's 2026-10-24 decisions
  (all recommended options, deploy delegated, device baseline deferred so the
  train's neutrality rests on automated evidence, C5-6 to C5-8 held), the
  close-cause tokens, the Phase 4 preparation evidence (C5-0 lab, the duplicate
  upload after ICE recovery, the P4-D7 to P4-D9 harness) and the gate deviation.

- [Phase 3 R2: the logo hard reset asks the update machine (2026-10-24)](design/phase3-r2-logo-reset-2026-10-24.md):
  release evidence for Phase 3 R2 (9.0.6 / v777, target `app`), released
  2026-10-24 12:24 KST in Release 40058005507. C6-10: the logo reset's prepare step asks the update machine
  through a port instead of promoting on its own, controller changes wait while
  a navigation holds the page, the quiet promotions wait for quiet page loads,
  and a new document absorbs the late activation of the generation its tab
  asked for. The report lists the C6-10 increments and QA rounds with tested
  SHAs, the owner decisions P3-8 A to P3-12 A as implemented, the behaviour-free
  eager-JS trims that restored headroom under the 5% reserve line, the review's
  four surviving mutants pinned, a real-browser two-build update check and the
  partial-release gate for target `app`.

- [Phase 3 update and Standard-room expiry recovery batch (2026-10-24)](design/phase3-update-and-expiry-recovery-2026-10-24.md):
  release evidence for Phase 3 R1 (9.0.5 / v776, target `all`), released
  2026-10-24 10:33 KST in Release 40049951071 after two runs recovered automatically. Explicit room expiry stops automatic guest signaling retries while
  preserving existing RTC playback; internal diagnostics distinguish expiry and
  observed host-unavailability state. R1 also carries the angular selection
  check and minus, the pinned-notice X aligned to its header time, the recovery
  dialog height cap and notice X keyboard ring, and C6-9 (one activation state
  and one `SKIP_WAITING` sink in the update machine, behaviour unchanged). The
  report lists each increment and QA round with its tested SHA, the owner's
  2026-10-24 decisions (two releases, R2 = C6-10 as 9.0.6 / v777; C6-15
  rejected), the final eager-JS headroom of 284 B and a real-browser check of
  a page opened after the deploy applying the update with the new machine. R2
  (C6-10) ships separately and gets its own dated report.

- [Retired Apps-in-Toss origins (Worker-only, 2026-10-24)](design/retire-toss-origins-2026-10-24.md):
  the App, signaling and remote-share Workers and the remote-share R2 CORS policy stop trusting the
  two former Apps-in-Toss origins, since the owner abandoned the Toss in-app build. The old
  unrelated-Toss-origin checks now also reject both former origins, in unit tests and in the three
  live smokes. No app version or service-worker change; three Workers change together, so the
  release needs target `all`.

- [Phase 2 page navigation and UI shell owners (9.0.4, 2026-10-23)](design/phase2-navigation-ui-shells-2026-10-23.md):
  the structure program's Phase 2 app batch. Page navigation gets one owner in
  `session-reset.ts`: one state, one exactly-once settle, a reload queue that runs reloads which
  used to be dropped and drops a queued reload only when a back-forward cache return reloads anyway,
  per-claim unload
  exemptions, a 2.5 s service-worker wait before the logo reset, the reset surface inside
  fullscreen, Back re-armed after a recovered navigation, and a navigation-sink ratchet. Fullscreen
  exits go through one in-flight exit shared by the screensaver and YouTube, with a dimmed YouTube
  button while a screensaver exit settles. Playlist drag, motion and gesture state get one lazy
  module and one gate; delete during a settle and system audio both end the gesture. Cross-tab
  account signals get one protocol home, one parser and one receiver. The batch also carries the
  PRO transfer entry-password reset (a committed transfer turns the entry password off and the link
  asks for no PIN; `OWNER_TRANSFER_PIN_REUSE` is gone) and its contract marker
  `pro-owner-transfer-pinless-v1`, so it needs target `all` and recovery repairs forward once the
  candidate may be live. Tests pinned today's behaviour first; devices are unchecked.

- [PRO outbox and duration read owners (Phase 1 PRO Worker B, 2026-10-23)](design/pro-room-outbox-duration-owners-2026-10-23.md):
  the PRO room's presence marker and playback outbox get one due time, alarm drain, epoch hook and
  load normalizer, and its two file duration readers share one pair of R2 slot predicates, one
  start and one alarm candidate, with both completion guards kept. Tests first pin every trigger's
  execution mode and two-way stored records. No behaviour change; Worker-only (target
  `pro-room`), with no app version or service-worker change.

- [One owner-transfer saga executor (Phase 1 App Worker B, 2026-10-23)](design/app-worker-saga-executor-2026-10-23.md):
  the transfer request and the minute cron finish a committed owner transfer through one post-commit
  executor in the owner's D3 order (finalize the entitlement, then `verified`, the fence clear, the
  audit, `complete`). The closing audit row comes before every terminal advance and is written once
  per transfer, so a request and cron overlap, a cron retry or a replayed request leaves one row; the
  request's HTTP answers are unchanged. Tests pinned every request answer, the cron's crash matrix
  and mixed old and new App Worker builds first. Worker-only (target `app`), with no D1 schema, app
  version or service-worker change. Production QA on October 23 completed an ownership round trip:
  both sagas reached `complete`, each transfer had one success audit row, the authority fence was
  `cleared`, and both accounts gained and lost the expected browser controls. Account deletion,
  existing API-key revocation and injected production failures remain untested.

- [App Worker saga helpers and one fence writer list (Phase 1 App Worker A, 2026-10-23)](design/app-worker-saga-fence-2026-10-23.md):
  the owner-transfer saga's entitlement identity and its four deleted-target endings each get one
  helper that keeps every site's order, and the Developer API authority fence writers take a typed
  write object, with the resource-ownership guard allowing only the activator, the clearer and the
  PRO decommission. Tests pinned each site and each writer's SQL and bindings first. No behaviour
  change; Worker-only (target `app`), with no app version or service-worker change.

- [One PRO signaling transport (Phase 1 PRO Worker A, 2026-10-23)](design/pro-room-signaling-transport-2026-10-23.md):
  the PRO room's presence, no-retry and playback broadcasts to signaling share one request builder
  with two acceptance rules. Unit fakes now refuse any body signaling would reject, and the workerd
  contract covers an epoch advance the room sends itself. No behaviour change; Worker-only (target
  `pro-room`), with no app version or service-worker change.

- [Server constant homes for the PRO and App Workers — Phase 0d, 2026-10-23](design/server-constant-homes-2026-10-23.md) —
  The PRO room's signaling retry schedule and file duration ladder, the owner-transfer saga states and
  the Developer API fence digest each get one named home, with a drift test over the three SQL copies of
  the saga states. No behaviour change; Worker-only, with no app version or service-worker change.

- [PRO SFU retry placeholder and slow gesture resume — 9.0.3, 2026-10-23](design/pro-sfu-retry-and-slow-gesture-resume-2026-10-23.md) —
  A PRO SFU retry keeps its receive placeholder, the AudioContext owner verifies a gesture resume that
  outlives its 750 ms deadline, and the AudioContext lifecycle fake; failing-first tests and device limits.

- [PRO LAN-direct receive deadline owner — 9.0.2, 2026-10-22](design/pro-direct-receive-deadline-2026-10-22.md) —
  A PRO LAN-direct listener stays in one receive placeholder so a late track attaches, and the coordinator
  owns its deadline with one connection_unstable notice per generation; failing-first tests and device limits.

- [Competing recovery flows: four ownership gaps — 9.0.1, 2026-10-22](design/ownership-gap-fixes-2026-10-22.md) —
  PRO system-audio SFU retries own their receive deadline, an explicit local YouTube pause ends the
  return re-align retries, the PRO pause gate holds through authority arming, and the session reset
  locks the page through the shared inert ledger; failing-first tests, three-lens reviews and device limits.

- [Idle computation cleanup and PRO heartbeat state — 9.0.0, 2026-10-22](design/idle-compute-optimization-2026-10-22.md) —
  Effects that are off stop computing, large files schedule quarter-second buffers, hidden or
  covered UI stops redrawing, and PRO heartbeats carry system-audio state instead of a 60 s poll;
  offline-render measurements, the compatibility marker and explicit device limits.

- [PRO playlist targets for uploads, BOT and copy/move — 2026-10-22](design/pro-playlist-targets-2026-10-22.md) —
  An upload, a BOT addition or playback command and a copy/move keep the playlist they were made for
  when another administrator switches playlists, or stop with the existing failure; a playlist
  number the room lacks is refused. Unit and real-Worker tests, PRO-before-App deploy order.

- [RAM file assembly memory reduction — 2026-10-22](design/ramstore-blob-assembly-2026-10-22.md) —
  Immutable chunk Blobs avoid a file-sized BufferSource copy at completion; transfer/preload
  regressions, native browser checks and explicit device/memory measurement limits.

- [Preload finishing progress — 2026-10-22](design/preload-finishing-progress-2026-10-22.md) —
  A selected partial preload keeps its percentage and foreground progress updates; exact-session
  ownership, retained RAM bytes and no restart on normal promotion, with local validation limits.

- [Visualizer response and screensaver optimization — 2026-10-22](design/visualizer-response-optimization-2026-10-22.md) —
  Independent time-based analysis, visibility suspension, bass response, spectrum peak coverage,
  drawing caches and conditional spectrum loading; local validation and explicit device limits.

- [Visualizer UI/UX and compatibility preflight — 2026-10-22](design/visualizer-ux-compatibility-preflight-2026-10-22.md) —
  one bounded recheck per proposal: 144 pixel-exact Canvas comparisons, 19 signal conditions, and Chromium
  lifecycle checks distinguish appearance-preserving work from changed music response; preserves two failed
  notification-count assumptions and the Windows WebKit AudioContext limitation. No product implementation.
- [Visualizer optimization audit — 2026-10-22](design/visualizer-optimization-audit-2026-10-22.md) —
  source review and 28 passing tests; isolated Chromium probes reproduce rendering behind the screensaver
  and after playback restarts while hidden. Records sample-rate-dependent bands, frame-based smoothing,
  spectrum follow-up options, and measurement limits; no product change or deployment.
- [Icon slot cell and delete sequence 8.11.39 — 2026-10-21](design/icon-slot-cell-and-delete-sequence-2026-10-21.md) —
  the current row's icon slot grew to the 18 px playing bars (auto grid tracks) and sat its icons 1 px low; it is one
  fixed 16 px cell now. Joined deleted rows leave as one run instead of breaking at their joins, and survivors and an
  emptied list's hint wait until the leaving copies have faded; the hint no longer jumps from the top.
- [Full E2E dialog and touch-input repair — 2026-10-21](design/full-e2e-dialog-touch-repair-2026-10-21.md) —
  separates the queued keep-open notice in the production R2 smoke from the synthetic touch-release and stale
  drawer-coordinate failures. Focused Windows/Linux repeats and a live R2 check pass; final full-suite checks
  were deferred before starting. Local test commits only, with no main merge or product deployment.
- [Selection clear fade, press tint and two-finger deselect 8.11.38 — 2026-10-21](design/selection-clear-fade-press-tint-two-finger-2026-10-21.md) —
  ending selection mode split every multi-row block into pills (`cancel()` cleared without capturing the drawn
  blocks); a block of several rows clearing or appearing at once now morphs as one fading shape. In selection mode the
  grey `:active` press tint gives way to the blue fill, and a two-finger pan deselects from a selected starting row
  like the check-column drag.
- [Preload recovery and current adaptive-window multi-receiver validation — 2026-10-21](design/preload-recovery-and-db256-multi-2026-10-21.md) —
  reproduces two recovery gaps, retains exact current/next residents across repeated interruptions,
  and checks ordinary/preload transfers with mixed receivers and a shared host uplink under the
  unchanged adaptive 256 KiB maximum. Local branch evidence only; deployment remains on hold.
- [Playlist selection morph, header crossfade and in-place pill exit 8.11.35 — 2026-10-21](design/playlist-selection-morph-and-header-crossfade-2026-10-21.md) —
  splitting a row off a selection block showed a square corner past the block's rounding one, which per-row fills
  cannot avoid; reshaping now draws each block as one pill keeping its radius (stretch, merge through a waist, pinch
  apart) in a lazily loaded layer whose alpha makes overlaps one shape. Entering and leaving selection mode crossfades
  the header, the pills shrink away where they were instead of jumping to the screen bottom (their start was read after
  the list had stretched), and the move action uses the "place_item" icon.
- [Playlist dialog inset, liquid selection join and delete slide 8.11.34 — 2026-10-21](design/playlist-dialog-inset-and-selection-motion-2026-10-21.md) —
  the playlist switcher and move dialogs reuse the language picker, whose buttons took their bottom inset from the
  picker's translate link, so without that footer they sat on the dialog edge; the picker dialog now owns the 30 px
  inset. Selected rows join by easing corners and the gap while a collapsed fill grows out of the block, deleted rows
  slide out as frozen copies, and survivors' glide now survives the list's second render after a delete.
- [Multiple playlists per room — 2026-10-21](design/multi-playlist-2026-10-21.md) — three playlists per room
  ("Playlist", "Playlist 2", "Playlist 3"): the tab title becomes the switcher (room-wide switch, playback stops),
  edit mode copies or moves tracks between playlists, PRO rooms show storage use, and the bot and developer API can
  address a track in a given playlist. `playlist.items` stays the active playlist on every existing wire path, so
  older clients see only that one; standard hosts announce summaries in a new frame and PRO clients opt in by header.
  [PRO implementation](design/multi-playlist-pro-2026-10-21.md)
- [Worker fetch redirect mode — 2026-10-21](design/worker-redirect-mode-2026-10-21.md) — the Workers runtime throws
  "Invalid redirect value" for `redirect: 'error'`, so the blog image R2 mirror (since 2026-09-04) and both hops of the
  PRO YouTube duration lookup (since 8.9.5) failed before any request; all three use `manual` (3xx still refused) and a
  guard test keeps the error mode out of Worker code. Hybrid convertibles in tablet posture also get the playlist hover
  affordances again through a runtime `data-hover-pointer` flag.
- [Short desktop title spacing, delete mode stability and the edit mode redesign 8.11.33 — 2026-10-21](design/short-desktop-title-and-delete-mode-stability-2026-10-21.md) —
  the 720-899 px desktop band pulled its Playlist and Settings titles up to 12 px from the top edge; they keep the
  dashboard's 32 px again. Entering delete mode changed the playlist header by 2-3 px (baseline-aligned 44 px toggle,
  hidden 36 px icon row), moving the list; header height, list position and scroll position now stay identical.
  Edit mode then replaces each row's X with a check circle, paints selected rows as one fill (lone rows as pills,
  consecutive rows as one block with pill-radius outer corners), folds YouTube playlists while it lasts, adds
  check-column drag and two-finger range selection, and turns the bottom pill's Delete/Cancel into trash and close
  icon buttons. The Help tab's tour button is blue again. Eager JS gzip headroom is now 111 B.
- [Desktop layout by viewport height — 2026-10-21](design/desktop-height-layout-2026-10-21.md) — wide viewports
  under 720 px tall now use the compact sidebar layout, and from 720 to 899 px tall the dashboard keeps its header
  over the Play column only so Playlist/Chat and Settings run full height. One module holds the bands for CSS and
  JS, and a contract test keeps them equal (unreleased).
- [Playlist and platform fixes 8.11.32 — 2026-10-20](design/playlist-and-platform-fixes-2026-10-20.md) —
  the drag ghost showed the play icon under the grip; desktop gets press-and-hold reorder; edge auto-scroll no longer
  starts from an edge-row grab and stops outside its zone; iOS long-press text selection returns after lightningcss had
  stripped every `-webkit-user-select` since 8.6.9 (CSS targets now include Safari/iOS, with a build guard); blog
  images fall back to their source when the R2 mirror fails; permission feedback says "checking" until the host
  confirms; the deletion pills sit in one container pill under the last track, and (owner decision 2026-10-21) the
  Undo window and its playback-navigation gate are gone: Delete deletes at once and only the deleting device sees
  a "Deleted N tracks" toast.
- [Background-return Sync — 2026-10-20](design/background-return-sync-2026-10-20.md) — every return from the
  background (hidden 1 s or longer) in an active room now runs the Sync button's room alignment without its panel
  or toasts: PRO full reconciliation merged into the runtime's own foreground repair, a manual broadcast on a
  Standard YouTube host, a retried rendezvous on a Standard YouTube guest (also while the connection is being
  probed), and a forced re-sync on a Standard file guest, playing or paused. Local evidence at `5e8d8623`; not
  released, real devices untested.
- [Playlist delete mode — 2026-10-20](design/playlist-delete-mode-undo-2026-10-20.md) —
  selecting rows turns the playlist title into the selected count with one Select all / Deselect all text button,
  and a red Delete and grey Cancel pill in one container pill replace the icon pill; tapping outside the list or
  changing tabs ends the mode. The 3 s Undo window was removed by owner decision on 2026-10-21: Delete runs
  `playlist:remove-tracks` at once and the deleting device alone gets a `toast.deleted_tracks` toast once the rows
  are gone. Two redesign keys use WordPress core translations in 42 locales; the toast follows each locale's
  "tracks added" toast.
- [Clock-only screensaver and Help-tab entry — 2026-10-21](design/screensaver-clock-only-help-entry-2026-10-21.md) —
  the Help tab's tour button takes the neutral invite-link look and a new accent "Turn on screensaver" button opens
  the screensaver; the screensaver keeps only the clock (no date, weather, air quality, moon, Open-Meteo or location
  request), closes on a double-click or double-tap, and brightens by at most 6% with the visualizer's bass while a
  file or system audio plays. Records translations, branch tests and limits.
- [Skip link translation — 2026-10-20](design/skip-link-translation-2026-10-20.md) —
  the keyboard skip link at the top of the app read "Skip to content" in English for all 42 locales; 8.11.31 binds
  it to `common.skip_to_content`, using the WordPress community translation of the same source string (theme
  first, core where the theme has none), with Wikipedia's "Jump to content" listed for comparison.
- [Editorial header label and redeem hint centering — 2026-10-20](design/editorial-header-and-redeem-hint-2026-10-20.md) —
  the History header said "Open app" after its 2026-08-23 rebuild while every other editorial header said "Try it
  now", and 8.11.30 matches it; the event page's redeem code hint sat 1.5–2.5 px low in Chromium, which draws the
  placeholder on the larger typed text's baseline, so the empty field now uses the hint's size (within half a pixel
  of center in Chromium and WebKit). Contract tests pin both.
- [Standard HTTPS bridge failure diagnostics — 2026-10-20](design/standard-signaling-bridge-diagnostics-2026-10-20.md) —
  after two 8.11.28 runs failed on a bare bridge-open 502, 8.11.29 makes the next one readable: the smoke prints
  role, status, allowlisted code, elapsed ms and Ray ID for any failed open/send/poll/close, and the App Worker logs
  one credential-free `standard_signaling_bridge` record per 5xx (operation, reason, upstream status and code,
  timing). The bridge object's own 502s, which the App passes through, are now told apart from App-side ones.
- [Welcome wordmark alignment — 2026-10-20](design/welcome-wordmark-alignment-2026-10-20.md) — the start
  screen wordmark is 5–12% taller than the greeting that replaces it in every layout, but only the 720–1279 px
  two-column layout left its top 2–3 px above the greeting; 8.11.28 lowers it by the phone layout's 3 px (top
  0–1 px below), after a size-scaled nudge sank the tablet mark too far.
- [Login window centering on short screens — 2026-10-20](design/login-dialog-centering-2026-10-20.md) — at
  480 px tall or less, such as a phone in landscape, the account and administrator-permissions windows stuck
  12 px from the top; 8.11.27 keeps them centered like every other dialog (844×390: 12 / 68.6 px → 40.3 /
  40.3 px), pinned by a contract test.
- [Login legal link order — 2026-10-20](design/login-legal-link-order-2026-10-20.md) — 8.11.26 lists the
  privacy policy before the terms in the login dialog, matching Google's account chooser; a markup contract test
  pins the order.
- [Stop Sharing icon and label centering — 2026-10-20](design/stop-sharing-centering-2026-10-20.md) —
  the stop square filled only the middle half of its icon box, so the visible icon and label sat 1.75–2.74 px
  right of center; 8.11.25 crops the icon box to the square with the same size and visible gap (−0.75–0 px),
  pinned by the critical layout probe for 42 locales, both directions and 200% text.
- [Preload resume after an ICE interruption — 2026-10-20](design/preload-resume-after-ice-recovery-2026-10-20.md) —
  8.11.25 pauses an interrupted preload lane instead of aborting it and restarts it from chunk 0 with
  `restart: true` when the same connection recovers; the guest releases a live partial session; PeerJS
  keeps the immediate abort. Native scenario (c): `ad900e0e` 5/5 and final `c73a52e1` 3/3 exact completions
  after 10 s and 17 s cuts; baseline `2e7d6416` 0/2; the host-only first candidate failed 1/4 on a live
  guest session; one final run lost its C3 reading to a pre-cut OS media pause.
- [Side-PC ICE restart independent verification — 2026-10-20](design/side-ice-restart-independent-verification-2026-10-20.md) —
  a separate session without the owner's field notes fixed its procedure first: 10 s outages keep both
  versions, side-PC `failed` at 17 s loses 8.11.23's session while `ee8dcd28` recovers, and 25 s ends both.
  Preload abort on disconnect is pre-existing; an IP change could not be emulated.
- [Isolated control side ICE restart — 2026-10-19](design/control-isolation-side-ice-restart-2026-10-19.md) — capability-gated bounded restart of the side PC over the original lane; unit and mutation evidence at `05551d1d`; native lab and independent verification pass on `ee8dcd28`; prepared as 8.11.24 (never deployed) and ships in 8.11.25.
- [Side-PC ICE restart native lab — 2026-10-19](design/side-ice-restart-native-lab-2026-10-19.md) — candidate `ee8dcd28` passes all five CDP P2P outage runs; production main closes on side PC failure; preload abort on disconnect is a separate pre-existing follow-up; real-device IP change and TURN remain.
- [Combined transport release — 2026-10-19](design/transport-release-bundle-2026-10-19.md) —
  8.11.23/v732 bundles #410 control isolation, the delay-based receipt window with its
  evidence bound and the transfer-time clock guard. Native round r1 passes the pre-fixed
  gates: high-RTT −33%, slow link +1.3%, collapse −21%, every control maximum under 1 s,
  zero unwanted playback corrections. Side-connection ICE restart is deferred.
- [Transfer-time clock asymmetry guard — 2026-10-19](design/transfer-clock-sync-guard-2026-10-19.md) —
  keeps the quiet min-RTT clock sample for its 120 s age, gates local-file soft resync like
  YouTube auto realignment, and restores a corroborated clock after a forced re-lock;
  unit evidence here, native evidence in the combined release record.
- [Container-native shaped A/B — 2026-10-19](design/native-shaped-credit-ab-2026-10-19.md) —
  B128, SA192 and the delay-based window through a packet-level bottleneck with Chromium 141:
  8 Mbps 61–67 / 36.6 / 27.0 s, 2 Mbps unchanged, and the 8→2 collapse transient. Not the
  team's frozen native contract.
- [Delay-based receipt window candidate — 2026-10-19](design/delay-based-credit-window-2026-10-19.md) —
  experimental replacement for #410's A192 sender policy: one-chunk growth while the
  measured credit loop shows no added queueing, a 2 s / 16-chunk evidence bound above
  128 KiB, deterministic path-model results and the model's sudden-collapse limit. Not
  native evidence or a release record.
- [Product control isolation — 2026-10-19](design/control-isolation-product-integration-2026-10-19.md) —
  product negotiation, ordered handoff, compatibility, reconnect and bounded
  adaptive credit; resumed C9 qualification passes preload, mixed versions,
  user-operated reconnect and shared uplink checks. Deployment remains withheld;
  preserved failures, measurement limits and separate-candidate review are included.
- [Control association isolation — 2026-10-19](design/control-association-isolation-2026-10-19.md) —
  sequential native transport investigation, with a separate control SCTP
  association and fixed/adaptive bulk receipt windows. Preserves failed setup instrumentation,
  exact source/build evidence and untested product-integration boundaries.
- [Startup transport delay cause — 2026-10-19](design/startup-transport-cause-2026-10-19.md) —
  frozen B128 reproduces 809/1,885 ms first-chunk states; packet/trace evidence
  connects a delivered control message's delayed ACK to unnecessary retransmission
  and reduced-congestion startup. One latency-only counterfactual corroborates
  the mechanism. Preserves diagnostic binary differences, post-window tail
  uncertainty and the separate full-transfer cost; no runtime change or release.
- [Adaptive credit with 16 KiB native messages — 2026-10-18](design/adaptive-credit-fragment16-screen-2026-10-18.md) —
  eight same-main native runs: H8 preload 71.583→48.450 seconds and ordinary
  64.217→36.760, with slow2 throughput preserved. Dynamic-network initial control
  delays failed the frozen relative budgets; preserves independent audits,
  the separate small-tail analyzer repair, and ten unexecuted followups.
  No product integration or deployment.
- [Adaptive 192 KiB credit screen — 2026-10-18](design/adaptive-credit-192-screen-2026-10-18.md) —
  same-source native preload shortened 71.791 to 49.516 seconds, but the frozen
  raw/p95 control-delay gates failed. Preserves startup timing, unequal-duration
  percentile limits, independent integrity/media verification, and six skipped
  followups; no production adoption.
- [Historical preload and playback comparison — 2026-10-18](design/historical-transfer-comparison-2026-10-18.md) —
  exact initial/month-old/yesterday/current production sources, six minimal
  native RTC runs and the first-commit setup blocker. Separates older playback
  failures from current high-RTT throughput cost; no App release.
- [Automatic realignment clock safety candidate — 2026-10-18](design/automatic-realignment-clock-safety-2026-10-18.md) —
  fixed 64/64/128 KiB transport, uncertainty-aware optional YouTube correction,
  operation clock leases and bounded local diagnostics. Ten native cases retain
  the diagnostic256 performance-budget failure separately from operating128
  safety and recovery; no production release or full all-green claim.
- [Transport candidate roundtable and isolated experiments — 2026-10-18](design/transport-candidate-roundtable-2026-10-18.md) —
  rate-gated credit, native-message fragmentation, and automatic-correction clock
  leases; separates deterministic safety, native throughput/control results,
  independent verification, and unresolved real-device limits. No App release.
- [Local buffer / receiver-credit crossed comparison — 2026-10-18](design/receiver-credit-cross-matrix-2026-10-18.md) —
  fixed 64 KiB payload, six local/credit combinations, 36 exploratory native
  RTC cases and a frozen reverse-order confirmation. Separates file integrity,
  playback preservation, control latency and observed capacity waits. No App release.
- [Adaptive receiver-credit and clock-quality experiment — 2026-10-18](design/receiver-credit-adaptive-design-2026-10-18.md) —
  isolated adaptive-window and automatic-realignment candidates, native ordinary/
  preload comparisons, retained tail-latency rejection, and long-congestion
  controls. Experimental source only; deployed 64/128 KiB policy is unchanged.
- [Receiver-credit window comparison — 2026-10-18](design/receiver-credit-window-comparison-2026-10-18.md) —
  Fixed 64 KiB local threshold with 128/256/384/512 KiB receipt windows across
  ordinary transfer/preload, eight receivers, slow links and high RTT. Records
  counterbalanced native RTC measurements, playback-preservation failures,
  lifecycle checks and the limits of choosing one fixed window. No App release.
- [Receiver-confirmed direct file flow control — 2026-10-18](design/receiver-credit-file-transfer-2026-10-18.md) —
  ordinary/preload shared credit, local 64 KiB thresholds, compatibility,
  cancellation and promotion; final product verification, high-RTT throughput
  tradeoff and App 8.11.20/v723 deployment/recovery evidence.
- [Native RTC control-queue root-cause investigation — 2026-10-18](design/preload-control-queue-root-cause-2026-10-18.md) —
  Separates the app from transport behavior using shared/separate PeerConnections
  and receiver-confirmed flow control. Records native file integrity, directional
  timing, controlled slow-link limits, and the evidence needed before a protocol change.
- [Preload capacity: slow links, multiple recipients, and lifecycle — 2026-10-18](design/preload-capacity-validation-2026-10-18.md) —
  Records 38 verified native RTC transfers, slow-link and eight-recipient comparisons,
  cancellation/channel-replacement/promotion pins, local release checks, and the remaining
  slow-receiver/control-queue limits. App 8.11.19/v721 release preparation.
- [Setup buttons swapped inside the screen transition — 2026-10-18](design/setup-actions-transition-2026-10-18.md) —
  The setup actions changed before the transition captured the outgoing screen, so the
  centered phone middle block jumped 36px and the buttons skipped the crossfade when entering
  방 만들기 or 방 참여하기 and coming back. They now swap inside the same transition. Records
  the transition frames and tests. App 8.11.18/v720.
- [Welcome carousel spacing and a fainter dark icon circle — 2026-10-18](design/setup-carousel-spacing-2026-10-18.md) —
  The first screen's carousel shows 28px from the icon circle to the title, 20px to the
  description, and 36px to the dots on phones (owner decision); the two-column panel scales
  the same ratio with its title size. Dark draws the icon circle on surface-1, as faint as in
  light. Records the measurements and tests. App 8.11.17/v719.
- [Phone portrait setup centered by its visible edges — 2026-10-18](design/setup-mobile-visible-centering-2026-10-18.md) —
  Follows 8.11.15: the bottom paddings balance the empty space inside the header and the
  middle block (the QR margin, the 84% scan button, text spacing), so the visible gaps above
  and below match within 0.5px on four phones. Records the measurements and tests. App
  8.11.16/v718.
- [Phone portrait setup with a centered middle block — 2026-10-18](design/setup-mobile-centering-2026-10-18.md) —
  On phone portrait, the first screen's carousel, the invite QR with its code, and the QR
  scanner with the code field sit midway between the header and the actions, with equal
  gaps. Records the layout measurements on five phones, tests, and limits. App 8.11.15/v717.
- [Local repeat and native Android Pixel preload comparison — 2026-10-18](design/preload-local-pixel-retest-2026-10-18.md) —
  Repeats the same scratch builds on Windows and checks native Android Chrome in
  the existing Pixel AVD. Separates transfer/message timing from an unstable
  no-preload media baseline, preserves setup failures, and records scope limits.
  Pixel results do not confirm a consistent benefit from the 64 KiB threshold.
- [Preload control-message priority investigation — 2026-10-18](design/preload-control-priority-investigation-2026-10-18.md) —
  nine actual-YouTube direct-RTC trials compare the unchanged sender, a smaller
  preload buffer threshold, and fixed pacing. Records latency/throughput tradeoffs,
  unchanged product sources, and the remaining multi-device/lifecycle checks.
- [Actual file preload during YouTube playback — 2026-10-18](design/youtube-preload-live-ab-2026-10-18.md) —
  Compares 8.11.13 and 8.11.14 with real WebRTC/RAM file transfer through the
  product Cloudflare adapter, both controlled and actual YouTube providers.
  Separates delayed control messages from buffering, playback mutation, and
  physical Android/audio claims. No product code or production change.
- [Standard YouTube heartbeat correction — 2026-10-17](design/youtube-heartbeat-delay-fix-2026-10-17.md) —
  Uses one current host position for coarse seek, Android BUFFERING recovery,
  and small-drift observation. Preserves output/manual compensation and records
  the reviewed tail-hold boundary, 13,036 local passing tests, exact-main CI,
  App 8.11.14/v716 Release 39039136092, operational smokes, public asset hashes,
  recovery checkpoint, successful automated drift checks, and device limits.
- [Host QR reveal without the double flicker — 2026-10-17](design/setup-qr-reveal-2026-10-17.md) —
  The carousel stays in the tap transition's snapshot (no empty frames), the desktop left
  panel keeps an unchanged QR stage mounted, and the QR encoder loads from the host tap.
  Records the frame captures, unit and browser tests, and limits. App 8.11.13/v714.
- [Standard YouTube delayed-heartbeat reproduction — 2026-10-17](design/youtube-heartbeat-delay-reproduction-2026-10-17.md) —
  Real handler and SharedClock with a fake iframe reproduce two incorrect seek
  paths: delayed-frame coarse correction and Android BUFFERING recovery. New
  tests: 15 pass / 6 fail / 0 skip; existing focused tests: 281 pass. No runtime
  change or deployment; actual preload causation remains unverified.
- [Deferred Back guard (R policy) — 2026-10-17](design/ios-back-deferred-guard-2026-10-17.md) —
  Owner-tested iPhone diagnostic, shared deferred history registration, actual
  window-close completion and owned-history leave. Records App 8.11.12/v712,
  exact-main CI 39008608569, Release 39009031876, public asset hashes,
  operational smokes, recovery checkpoint and successful drift audit.
  Native iOS swipe verification remains open; browser coverage is targeted.
- [One update dialog everywhere — 2026-10-17](design/update-dialog-everywhere-2026-10-17.md) —
  A waiting update gets the same dialog (적용하기 / 나중에) on every screen, rooms and the
  demo included, with copy that says what applying costs. 나중에 lasts for the page, and a
  room guest returns to the room's Start screen. Replaces the in-room notice and the 8.11.6
  apply on reopen. Records the tests, a local browser check, and limits.
- [Screensaver caption glow and combined centering — 2026-10-17](design/screensaver-caption-glow-centering-2026-10-17.md) —
  Weak blue description glow, combined weather/AQI/moon alignment, and preserved
  local Safari diagnosis; records the visual-test adjudication, local validation,
  and 8.11.10 release, public-asset, and recovery evidence.
- [Back closes the topmost window — 2026-10-17](design/back-closes-top-window-2026-10-17.md) —
  History Back closes only the topmost window, in rooms and on the setup screens; with no window
  open it asks before leaving a room or moves to the previous page. Also closes the PRO re-entry
  gap. Records the window table, local browser checks, limits, and the 8.11.9 release evidence.
- [Approved diffusion clock background — 2026-10-17](design/screensaver-diffusion-clock-2026-10-17.md) —
  Uses the selected lighter artwork for the clock, preserves other scenes and
  previous immutable image URLs, and records validation and release evidence.
- [One dialog when returning from the background — 2026-10-17](design/resume-dialog-dedup-2026-10-17.md) —
  A return from the background shows at most one dialog: a warning answered late no longer
  repeats, and the audio recovery dialog replaces the generic warning. Records both paths and the 8.11.7 release evidence.
- [Apply a waiting update on reopen — 2026-10-16](design/update-apply-on-reopen-2026-10-16.md) —
  A reload or reopen outside a room, including an invite link before Start, now applies
  a waiting update without asking again. Records the cause, the room guard, test limits, and the 8.11.6 release evidence.
  Replaced on 2026-10-17 by [one update dialog everywhere](design/update-dialog-everywhere-2026-10-17.md).
- [Screensaver caption rendering regression — 2026-10-16](design/screensaver-caption-rendering-2026-10-16.md) —
  restores whole-caption rendering after missing small-letter strokes were reported;
  records the source regression and browser-reproduction limits.
- [Image backgrounds and compatible screensaver effects — 2026-10-16](design/screensaver-image-backgrounds-2026-10-16.md) —
  The approved all-image background version, lazy immutable assets, and compatible
  foreground effects, with integration verification and release evidence.
- [Safari screensaver blur diagnosis — 2026-10-16](design/screensaver-safari-filter-diagnosis-2026-10-16.md) —
  Historical Canvas filter failure reproduced in native Windows WebKit before the
  8.11.4 compatibility repair; preserves the original probe and physical iPhone
  verification limits, with links to the subsequent repair and release evidence.

- [Maximum text weight 700 — 2026-10-16](design/max-font-weight-700-2026-10-16.md) —
  Every text weight in the project is capped at 700, including badges, code
  fields, public pages, the admin console and the static OG cards, with a
  unit test that keeps it there. Shipped App 8.11.3/v700 with exact-main CI,
  production ownership/smoke, public stylesheet, OG image and Drift Audit
  evidence.

- [Display title weight 700 — 2026-10-16](design/display-weight-700-2026-10-16.md) —
  Every display use (titles, dialog titles, invite code and the rest) moves
  from 800 to 700 in all locales, and the design system documents the same
  weight. Shipped App 8.11.2/v699 with exact-main CI, production
  ownership/smoke, public stylesheet and Drift Audit evidence.

- [Lazy ambient screensaver — 2026-10-16](design/screensaver-integration-2026-10-16.md) —
  local command, YouTube exclusion, fullscreen restoration, fading track details, scoped
  permissions, and release evidence.

- [Desktop action button width — 2026-10-16](design/desktop-action-width-2026-10-16.md) —
  Sync and Media retain their existing maximum width from the 1280px desktop
  breakpoint. Shipped App 8.10.27/v693 with exact-main CI, production
  ownership/smoke, live 1280/1360/1440px geometry and Drift Audit evidence.

- [Keep-open dialog in PRO rooms — 2026-10-16](design/keep-open-pro-2026-10-16.md) —
  First-time PRO participants also get the one-time keep-open dialog when the
  room's first media appears, without the host sentence. Shipped App
  8.10.26/v692 with exact-main CI, production ownership/smoke and Drift Audit
  evidence.

- [Host presence and keep-open guidance — 2026-10-16](design/host-presence-keep-open-2026-10-16.md) —
  Standard-room guests see a waiting loader, refusal and hold toasts, and an
  offer to leave when the host's app is in the background or frozen.
  First-time visitors get a one-time keep-open dialog, and the account pill
  stays visible while any loader shows. Shipped App 8.10.25/v691 with
  exact-main CI, production ownership/smoke and Drift Audit evidence; the first
  release attempt rolled back automatically after a signaling smoke 503.

- [Unused toast keys — 2026-10-15](design/unused-toast-keys-2026-10-15.md) —
  Twelve toast keys that no code referenced are removed from all 42 locales.
  Shipped App 8.10.24/v690 with exact-main CI, production ownership/smoke and
  Drift Audit evidence.

- [Toast line length — 2026-10-15](design/toast-line-length-2026-10-15.md) —
  Toasts stop cutting authored copy at 50 characters (921 values in 38 locales
  ended in an ellipsis), stay up longer for longer text, and 77 verbose
  translations in 20 locales are trimmed. Shipped App 8.10.23/v689 with
  exact-main CI, production ownership/smoke and Drift Audit evidence; device
  rendering checks remain.

- [Toast punctuation policy — 2026-10-15](design/toast-punctuation-policy-2026-10-15.md) —
  Toasts drop sentence-final periods and put each sentence on its own line in
  42 locales, with a guard test. Shipped App 8.10.22/v688 with exact-main CI,
  production ownership/smoke and Drift Audit evidence; device rendering checks
  remain.

- [Update notice line breaks — 2026-10-15](design/update-notice-line-breaks-2026-10-15.md) —
  The four update notices put each sentence on its own line in 42 locales,
  which also ends toast truncation for 102 of 126 values. Shipped App
  8.10.21/v687 with exact-main CI, production ownership/smoke and Drift Audit
  evidence; device rendering checks remain.

- [PRO playlist reorder feedback — 2026-10-14](design/pro-playlist-reorder-optimistic-2026-10-14.md) —
  A dropped PRO reorder shows its order at once instead of redrawing the old one
  until the server answers; a rejection restores the server order with a toast in
  42 locales. Shipped App 8.10.20/v686 with exact-main CI, production
  ownership/smoke and Drift Audit evidence; the production reproduction and
  physical-device checks remain.

- [PRO silent-endpoint transport — 2026-10-14](design/pro-silent-endpoint-transport-2026-10-14.md) —
  The transport acts on the icon it shows, so Play on a silent PRO endpoint
  rejoins only that endpoint instead of pausing the room; YouTube restores and
  local rejoins show the loading state. Shipped App 8.10.19/v685 with exact-main
  CI, production ownership/smoke and Drift Audit evidence; the production
  reproduction and physical-device checks remain.

- [YouTube rejoin synchronization — 2026-10-14](design/youtube-rejoin-sync-2026-10-14.md) —
  PRO local rejoins and late joins settle at a planned release instant instead of
  seeking during release; Standard guests re-align after late starts. Shipped App
  8.10.18/v684 with exact-main CI, production ownership/smoke and Drift Audit
  evidence, plus production before/after measurements including server seeks;
  physical-device and full E2E limits remain.

- [Sharing action failure isolation and spacing — 2026-10-14](design/sharing-action-fallback-2026-10-14.md) —
  Eager visible/accessibility state, optional motion failure cleanup and one gap
  token. Shipped App 8.10.17/v683 with exact-main CI, production ownership/smoke,
  browser update and Drift Audit evidence; full E2E and physical-capture limits remain.

- [Shared app double-tap policy — 2026-10-14](design/shared-touch-policy-2026-10-14.md) —
  Common touch default preserving existing zoom locks, inner scrolling and
  component gestures. App 8.10.16/v682; affected iOS 17.6.1 PWA displacement and
  scroll/volume/reorder checks confirmed by the owner. Broader device/update limits remain.
- [System audio sender action surface — 2026-10-14](design/system-audio-sharing-actions-2026-10-14.md) —
  Sender-only merged Stop Sharing control, stable hover motion, room/demo CSS
  readiness, accessibility and 42-locale layout verification. App 8.10.14/v680;
  optional-motion failure and shared gap-token follow-ups recorded on 2026-10-14.
- [입장 대기·장황 버튼 라벨 축약 — 2026-10-14](design/short-wait-labels-2026-10-14.md) —
  `common.wait`·`setup.joining` 28건과 2026-10-13 길이 조사의 장황 버튼 25키 222건을 칩·2버튼 행
  ≤14자, 전폭 ≤22자 관용구로 축약(31키·250건). 8.10.15/v681,
  Production Release `target=app`.
- [점검 안내 번역 14건·숨은 YouTube 패널 접근성 수정 — 2026-10-14](design/maintenance-copy-and-a11y-release-2026-10-14.md) —
  Worker 6종 공유 점검 안내 문구 14개 로케일 관용구 수정, 화면 밖에 주차된 YouTube 래퍼
  `inert`로 역방향 키보드 포커스 차단. 8.10.12/v678, Production Release `target=all`.
- [42개 로케일 번역 품질 업데이트 — 2026-10-14](design/i18n-quality-update-2026-10-14.md) —
  전수 조사 제안을 오너 결정으로 걸러 사전 값 1,718건 변경(PRO 활성화 7키 신규 번역
  70건 포함), 복수형·계정 페이지·`<bdi>` 복구, 토스트 50자 상한 보정, compact 라벨은
  CI 레이아웃 게이트에 따라 base 유지, 영어 폴백 동기화. App 범위(8.10.11/v675), 점검
  안내는 Worker 후속.
- [YouTube playlist and native administrator repair — 2026-10-14](design/youtube-playlist-native-control-repair-2026-10-14.md) —
  Complete Standard manifests, atomic PRO reentry projection, native control
  ownership and browser/release evidence with provider limitations.
- [YouTube 목록·관리자 iframe 조작 조사 — 2026-10-14](design/youtube-playlist-native-control-audit-2026-10-14.md) —
  일반방 부분 목록 채택, PRO 재입장 투영 유실, 관리자 iframe 재개·탐색 경로를
  조사했다. 실제 공급자 관측과 합성 피드백 재현의 한계를 구분하며 제품 수정·배포는 없다.
- [Component pill and cascade refactor — 2026-10-13](design/component-cascade-refactor-2026-10-13.md) —
  Component-owned shape, presentation layer precedence, retained safety guards,
  and browser comparison/release evidence.
- [YouTube popup focus repair — 2026-10-13](design/youtube-popup-focus-repair-2026-10-13.md) —
  자연 실패의 타이머·focus·키 이벤트로 후반 Tab 경합 원인을 확인하고 초기 focus
  fallback을 수정했다. 로컬·원격 전체 Chromium 각 627개와 exact-main CI를 통과하고
  8.10.8/v669로 배포했다. 반복검사의 타이머 경계 한계와 단위 회귀 근거를 함께 기록한다.

- [YouTube keyboard focus remote diagnostic — 2026-10-13](design/youtube-focus-linux-diagnostic-2026-10-13.md) —
  같은 코드의 Ubuntu·Windows 반복 검사에서 최초 focus 실패를 재현했다.
  준비 확인·실제 Tab 진입은 60회 통과했지만 전체 비교는 57 pass / 후반 Tab 3 fail이다.
  제품·main 테스트 수정이나 배포 없이 결과와 해석 한계를 기록한다.

- [YouTube input guidance — 2026-10-13](design/youtube-input-guidance-2026-10-13.md)

- [공지 외부 리뷰 후속 수정 — 2026-10-13](design/announcement-review-followup-2026-10-13.md) —
  `/clear` 서비스 공지 소유권, RTL 닫기 영역, 관리자 초안 확인, legacy 정규화 및
  플라이트 레코더 빌드 식별을 재현·수정하고 검증·배포 근거를 기록한다.

- [일반·PRO 동시 입장 시뮬레이션 — 2026-10-13](design/session-admission-burst-simulation-2026-10-13.md) —
  실제 로컬 workerd·SQLite DO에서 동시 입장, 정원 초과, 암호·공유망, 재시도·재접속,
  퇴장 후 자리 재사용을 검사한다. 반복 실행 명령과 fixture·실기기 한계를 기록한다.

- [PRO 입장 복구·서버 진단 — 2026-10-13](design/pro-admission-repair-2026-10-13.md) —
  활성/휴면 번호 분리, TTL 경계 정원 판정, 공유 조회의 수명과 제한된 서버 진단.
  수정·검증·배포 근거와 과거 행사 원인을 확정할 수 없는 한계를 기록한다.

- [PRO 행사 외부 리뷰 재검증 — 2026-10-13](design/pro-event-report-verification-2026-10-13.md) —
  정원 판정 도중 TTL이 끝나는 경계의 거절을 당시·현재 소스에서 재현했다.
  절전·재입장·캐시·계측 주장의 사실/정책/추정을 구분하고 복구 관련 92개 테스트를
  통과했다. 원문 보고서 보존, 제품 수정·운영 변경·배포 없음.

- [PRO 행사 입장·Peer 번호 심층 감사 — 2026-10-13](design/pro-event-admission-deep-audit-2026-10-13.md) —
  당시·현재 소스에서 최대 4대의 `Peer 101`과 앱 입장 응답 거부, 공유 registry 조회 취소의 후속
  요청 차단을 로컬 재현했다. 행사 방의 Cloudflare 오류·객체 통계 및 D1 카운터를
  대조했다. 현장 정원 초과 여부는 미확정이며 제품 수정·로그 추가·배포는 없다.

- [공지 철회·관리자 편집·전체보기 수정 — 2026-10-13](design/announcement-repair-2026-10-13.md) —
  공지 철회/조회 실패 구분, 오래된 서버 캐시 응답 차단, 관리자 초안·만료 처리,
  긴 공지 전체보기와 초기 알림 정책, 리뷰에서 찾은 관리자 초기 초안 경계를 수정했다.
  exact-main CI와 Release 38293505122로 8.10.4/v665 전체 Worker 배포 완료.
  운영 smoke 10종·Drift Audit 통과, 실서비스 5분 철회·PWA·실기기 한계는 별도 기록.

- [공지 전체 경로 감사 — 2026-10-13](design/announcement-full-audit-2026-10-13.md) —
  철회·조회 장애 구분·관리자 초안/만료 처리의 기능 결함 6개, 표시·알림 UX 2개를
  분리했다. 기존 선택 검사 383건, 추가 탐사 30건 및 관리자 harness로 검증.
  제품 수정·배포 없이 근거와 후속 수정 조건을 기록했다.

- [일반방 공지 초기화 수정 — 2026-10-13](design/standard-announcement-bootstrap-2026-10-13.md) —
  새 방장·참여자 앱 초기화에서 누락된 공지 로딩, 수정 전 재현과 필수 브라우저 회귀 검사.
  exact-main CI 확인 뒤 Release 38273449653으로 8.10.3/v662 App 배포 완료,
  운영 smoke 4종·사후 Drift Audit 통과, 실제 운영 일반방 공지 표시 확인.
  기존 설치 PWA·실기 확인 한계는 남는다.
  후속 운영 검증에서 공지 비활성화 후 5분 20초가 지나도 기존 배너가 남는 별도
  철회 처리 누락을 확인했다. 공지는 비활성화 상태이며 후속 로컬 수정은 위
  공지 수정 보고서에 기록했다. 추가 배포는 하지 않았다.

- [동기화 점검 배포 준비 — 2026-10-12](design/sync-maintenance-release-preparation-2026-10-12.md) —
  최신 main 통합, 리뷰 보완, 초기 로딩 경계, 강제 버전 차단 없이 점검 후 배포하는
  오너 결정과 로컬 전체 단위 12,354건·후보 17건·선택 브라우저 61건의 검증.
  exact-main CI 확인 뒤 2026-10-13 Release 38267400052로 8.10.2/v661 배포 완료, 운영 smoke 4종·사후 Drift Audit 통과. 실기 한계는 남는다.
- [Android YouTube 공통 기준·기기별 출력 보정 — 2026-10-12](design/android-youtube-output-baseline-2026-10-12.md) —
  일반·PRO의 own 250 ms, 방장 수동값 격리, 곡 끝 처리와 로컬 검증.
  실음향·구버전 혼용의 남은 한계를 구분한다. 8.10.2/v661 배포 완료(위 점검 배포 기록).
- [일반방 시계·학습 브라우저 실험 — 2026-10-12](design/standard-clock-browser-simulation-2026-10-12.md) —
  실제 일반방 P2P와 YouTube, 지연 통제 60회 및 실제 시계 모듈 150,400회 모형.
  초기 표본 교체 시 학습 제외와 안정 후 재개 확인, 제품 수정·배포 없음.
- [일반방 랑데부 학습·시계 관측 수정 — 2026-10-12](design/standard-start-learning-repair-2026-10-12.md) —
  C11 timer 지연 제외, 계획·예약·호출·측정 시계 검사, SharedClock 선택 사유와
  flight recorder 관측. 시간 경계·취소 관측 재현, 단일 seek 핀 위치와 로컬 검증. 8.10.2/v661 배포 완료(위 점검 배포 기록).
- [일반방 시작 시계·학습 제안 재검증 — 2026-10-12](design/standard-start-review-2026-10-12.md) —
  C11 영속 학습 오염 9조건 재현, C13 감지 한계, 일반방 시계·파일 보정 경계,
  관측·QA 기준. 제품 수정 없이 로컬 검증.
- [PRO 시작 시계·관측 수정 — 2026-10-12](design/pro-start-clock-safety-2026-10-12.md) —
  작업별 시계 snapshot, 미보정 COMMIT 차단, 늦은 READY 대기 분리, C11 callback
  지연 구분과 관측 전용 YouTube 표본. 리뷰 후 소켓 단절 중 확정된 시작을 보존하고
  파일·YouTube 실제 적용 경로를 재검증. 8.10.2/v661 배포 완료(위 점검 배포 기록).
- [PRO 시작 싱크 원인 후보 재검증 — 2026-10-12](design/pro-start-sync-candidate-validation-2026-10-12.md) —
  C1–C14 반박 검증, 시계 갱신·미보정 COMMIT 예약 결함 재현,
  YouTube 제어·파일 PCM 비교와 실기 측정 한계. 수정 전 분석 기록; 후속 수정은 위 보고서.
- [PRO file duration registration and backfill — 2026-10-12](design/pro-file-duration-registration-2026-10-12.md) —
  bounded upload metadata, immutable asset duration retention, late authorized
  preparation reports, legacy backfill, compatibility and verification limits.

These files contain dated measurements or completed work, while a clearly
labeled portion still supports a current guard or operating interpretation:

- [PRO duration hardening (8.10.1) — 2026-10-12](design/pro-duration-hardening-2026-10-12.md) —
  App 8.10.1 / v660 (released 2026-10-12, target `all`): stricter MP3/MP4 duration
  readers, versioned server file durations re-measured on play, ignored upload
  lengths, the 0.9x controller floor, alarm and metadata backoff fixes, and
  the two-answer skip for deleted YouTube videos; three adversarial review
  rounds plus a ship gate, and production verification. No real-device review.
- [8.10.0 merge and 8.9.4–8.9.6 review — 2026-10-12](design/release-8-10-0-merge-review-2026-10-12.md) —
  App 8.10.0 / v659 after merging 8.9.6: merge resolution, four read-only
  reviews (no P1/P2), the replaced-tab takeover copy fix, the PRO Worker
  follow-ups deferred to 8.10.1, the owner decisions on order and deleted
  YouTube videos, and the exact-main CI rerun and production verification of
  the 2026-10-12 release. No real-device review.
- [PRO autonomous natural completion — 2026-10-12](design/pro-autonomous-playback-2026-10-12.md) —
  server-owned end deadlines, bounded file headers and authenticated YouTube
  metadata, controller sleep/departure, queue transitions and rollback compatibility;
  App 8.9.5 / v656 release, exact-main CI and production verification evidence.
- [PRO PWA force-close and relaunch — 2026-10-12](design/pro-pwa-force-close-audit-2026-10-12.md) —
  missing-exit presence retention, 45-second lease probes and approved continuation
  copy in all 42 locales; App 8.9.4 / v655 release and verification evidence.
- [In-room update prompt — 2026-10-11](design/in-room-update-prompt-2026-10-11.md) —
  App 8.10.0/v659 (released 2026-10-12), same release as the Standard-room owner PIN:
  in a room (standard or PRO, including the create and join screens and PRO
  presence re-entry) or the demo, a waiting update no longer opens the
  blocking dialog. It is an automatic "나중에" with no stored dismissal and
  one local chat notice per generation ("페이지를 새로고침하면" in a tab,
  "앱을 다시 열면" in a home-screen app), never sent to peers, or a toast
  where the chat cannot be seen, followed by the chat notice once the room
  starts. Another tab's activation posts the same notice, and back on setup
  the dialog is offered once. Devices on older code (production v657) show
  the old dialog once for this update, so the first deployment must avoid
  live events. Owner decisions after the review (2026-10-11): the create and
  join screens keep the toast, and the lazy-feature recovery dialog keeps
  opening in a room (not dismissible, Refresh only) with its own copy
  ("새로고침이 필요해요" / "MUSIXQUARE가 업데이트되었어요. 정상적으로
  사용하려면 새로고침이 필요해요.", 42 locales; v658 follow-up, v659 after
  merging App 8.9.6). Local unit, coverage, build, and Chromium browser checks
  with screenshots; no real-device or native-speaker review. The chat notice, toast, and
  deferral were replaced on 2026-10-17 by [one update dialog everywhere](design/update-dialog-everywhere-2026-10-17.md).
  Note (2026-10-29): the owner reversed the Refresh-only recovery dialog on 2026-10-28; from
  9.0.20 it shows Close on the left and Refresh on the right, and closing it leaves the room as it
  is ([9.0.20 report, F10](design/ui-followup-920-2026-10-29.md#고친-것)).
- [Standard-room owner PIN — 2026-10-11](design/standard-room-owner-pin-2026-10-11.md) —
  App 8.10.0 with the signaling Worker (released 2026-10-12, target `all`; tested at
  v655, ships as v659 with the in-room update prompt):
  Standard-room hosts type the 8-digit PIN in the shared two-step dialog,
  step 2 is skipped when nobody else is in the room (both room types), the PIN
  is masked in both, "모두 재입장" closes guest sockets in the Worker before
  the host's reasoned kick, kept devices reconnect without the new PIN, and the
  Worker limits wrong PINs per room and address block (live buckets are never
  evicted; by owner decision B, blocks past 256 are not limited rather than
  sharing a bucket that could lock every newcomer, and devices already in the
  room keep their signaling recovery), and a guest locked out by wrong
  PINs sees the Standard room's own "암호를 여러 번 틀렸어요" copy instead of
  the PRO join-limit wording (v655 follow-up). Also fixes forced colors:
  selected-row text, the pressed PIN toggle, selected tab and option icons, and
  the invite QR in light high-contrast themes. Local unit, Worker, coverage,
  build and browser checks; no real-device or native-speaker review.
- [PRO entry failure retry audit — 2026-10-11](design/pro-entry-retry-audit-2026-10-11.md) —
  retained-role defect after failed PRO entry, local same-page retry repair,
  lifecycle fencing and admission regression evidence; shipped in 8.9.4.
- [PRO clock budget and concurrent admission — 2026-10-11](design/pro-clock-and-admission-races-2026-10-11.md) —
  delayed clock replies within the caller budget, still-active admission
  tickets overtaken by another arrival, and unchanged admission limits.
  Local repairs and regression evidence; shipped in 8.9.4.
- [PRO PIN two-step dialog — 2026-10-11](design/pro-pin-two-step-2026-10-11.md) —
  shipped with App 8.9.4/v655: a minimal PIN page with Cancel /
  Next, then "현재 참여자를 어떻게 할까요?" with "그대로 두기" / "모두 재입장" rows
  styled like the language list, replacing the 8.9.0 in-dialog radio group that
  clipped on small phones and in landscape. Local unit, build, browser, and
  headless Chromium layout checks with screenshots; no real-device or
  native-speaker review.
- [PRO PIN membership choice and removal reasons — 2026-10-11](design/pro-pin-member-choice-2026-10-11.md) —
  "Let them stay" / "Make everyone rejoin" on PIN enable or change, and a
  `reason` on the unchanged `SESSION_REQUIRED` 401 for kicked, disconnected,
  and PIN-revoked sessions (PRO Worker and App, 8.9.0/v651, code `4319a2a0` merged with #290
  on main `13a25ee4`). Local tests only; not merged or deployed. Real-device
  checks remain open.
- [PRO join error copy — 2026-10-11](design/pro-join-error-copy-2026-10-11.md) —
  unreleased App 8.8.1/v648 (code `8961ff46`): localized `ROOM_FULL` and
  `RATE_LIMITED` join messages in 42 locales, with the wait in whole minutes.
  Local unit, build, and headless Chromium phone-width checks; no real-device or
  native-speaker review.
- [Grouped dependency update — 2026-10-11](design/dependency-update-2026-10-11.md) —
  Dependabot PR #288 (Mediabunny 1.61.3, Vite 8.3.3, Wrangler 4.148.0) with its
  adaptations: regenerated Worker types, HLS kept out of large-audio detection for the
  Chromium 79 build, and cache v648. Local verification only; not yet deployed.
- [PRO public-room admission protection — 2026-10-11](design/pro-room-admission-protection-2026-10-11.md) —
  owner seat, dedicated admission and presence-close receipt ledgers, and soft
  join throttle (PRO Worker only, code `95fa7a88`). Local Worker tests only; not yet
  deployed. The App error-message follow-up is the unreleased
  [PRO join error copy](design/pro-join-error-copy-2026-10-11.md) change
  (8.8.1/v648); a post-deploy check remains open.
- [PRO persisted-resource lane — 2026-10-11](design/persisted-resource-lane-2026-10-11.md) —
  unreleased behaviour-neutral refactor (8.8.0/v647): shared lock and refresh flight,
  differential and mutant evidence, and the effects/queue-mode asymmetries kept on purpose.
- [PRO optional entry password — 2026-10-10](design/pro-optional-entry-password-2026-10-10.md) —
  8.8.0/v646 contract, verification, and the PRO/App forward-repair floor. Browser
  checks used synthetic API fixtures; real customer rooms and devices remain open.
- [Header-independent tab crossfades — 2026-10-09](design/header-crossfade-2026-10-09.md) —
  8.7.9/v645 change and verification; the physical iPhone Safari/PWA check is pending.
- [App 8.7.2 전체 검증 — 2026-10-07](design/full-verification-8.7.2-2026-10-07.md) —
  full unit/Chromium/WebKit verification and the closed production R2 delay
  investigation (cause undetermined; no policy relaxation).
- [8.7.0 production release — 2026-10-07](design/release-8.7.0-2026-10-07.md) —
  the promotion of the accumulated beta to all six Workers after the release freeze.
- [3차 QA 후속 수정·예방 보강 — 2026-10-09](design/beta-qa3-repair-2026-10-09.md):
  확정 9건과 승인된 예방 보강 3건의 재검증·수정·릴리스 근거. 기존 감사 판정과 provider/실기 한계를 보존한다.
- [8.7.6 follow-up third 30-round QA — 2026-10-09](design/beta-30-round-qa3-2026-10-09.md) —
  6.1 Sol/xhigh, three agents across ten sets on main `bf4912b2`; 29 complete rounds and one partially executed safety-blocked round.
  At the audit baseline, nine confirmed findings were unrepaired, with three conditional observations kept separate. The linked follow-up repair record tracks their current disposition.
  Eight findings were independently replayed; the OAuth return-origin finding uses pre-block local evidence and source review.
  Unique focused cases, first failures, parent adjudication and physical/live/security limits are recorded. Product and deployment unchanged.
- [Post-promotion 30-round repair — 2026-10-09](design/beta-30-round-repair-2026-10-09.md) —
  Repairs the 13 confirmed findings and two owner-selected behavior requirements after fresh necessity checks.
  API mutation-time credential validation and live announcement status are now explicit contracts.
  Local verification, original failures and blocked security-depth limits are recorded separately from release evidence.
- [Post-promotion independent 30-round QA — 2026-10-09](design/beta-30-round-qa-2026-10-09.md) —
  Astra Ultra, three agents across ten sets on main `e7c5529a`.
  At the audit baseline: 13 confirmed findings, 2 provisional observations and 8 excluded candidates;
  complete baseline suites, new boundary probes, first failures and independent adjudication are separated.
  Blocked security depth and physical/live limitations remain explicit. Product code and deployment unchanged.
- [Beta 30-round repair and verification — 2026-10-07](design/beta-30-round-repair-2026-10-07.md) —
  Implements the 12 confirmed findings and two separate robustness improvements
  after owner approval. The report preserves original failures, follow-up checks,
  compatibility limits and one unresolved legacy SW update liveness observation after approval.
  At that historical checkpoint, main and production were frozen.
- [Beta independent 30-round QA — 2026-10-07](design/beta-30-round-qa-2026-10-07.md) —
  Astra Ultra, three agents per set across ten sets. Post-round adjudication
  confirmed 12 distinct unresolved defects at the discovery checkpoint; two observations remained provisional
  and two candidates are rejected. Selected maintained tests total 8,716 unique
  passing cases. At that discovery checkpoint, a newly reviewed sharp advisory failed the dev security gate;
  production-only audit remained zero. Product code and main were not changed
  during discovery; the subsequent repair is recorded separately above.
- [Beta dependency security repair — 2026-10-06](design/beta-security-repair-2026-10-06.md) —
  At the October 6 repair checkpoint, beta audit warnings fell from 13 packages
  to zero, with registry signatures verified. Dev-only patches preserve each parent's Undici/brace API requirements
  and the pinned Wrangler version. Main and production remain frozen; the report
  records the changed dependency graph and its local verification.
- [Main and beta comparison — 2026-10-06](design/main-beta-comparison-2026-10-06.md) —
  No new confirmed beta runtime defect across the 97-commit diff. Full unit
  revalidation and 54 selected Chromium cases pass; an unchanged tooling timeout
  resolves on focused rerun. Audits at this baseline match at 13 vulnerable dev
  packages, including one critical warning; prod-only audit remains clean.
  The October 6 repair cleared beta's then-known dependency warnings. The October 7
  QA above records a newly reviewed warning. Beta cache
  promotion and physical-device checks remain.
- [Final requested beta QA — 2026-10-04](design/beta-final-qa-2026-10-04.md) —
  No new confirmed product defect; further discovery ends at the owner's
  request. Full unit 10,637, new module 32, selected Chromium 43 plus four
  native delay conditions, WebKit 66 with three existing skips, production
  smoke 10 and eight artifact guards pass. Source is unchanged; physical
  timing and existing security/cache promotion gates remain.
- [Follow-up beta sequence QA — 2026-10-04](design/beta-sequence-qa-2026-10-04-round-2.md) —
  63 new module cases, 18 new mobile-view browser plans and 1,014 selected
  maintained cases pass. A repeated transient native post-seek difference
  recovers automatically; an unsupported room-projection diagnostic stays
  separate with actual teardown controls. Product source is unchanged, and
  this focused round does not replace the complete verification below.
- [Large beta QA — 2026-10-04](design/beta-large-qa-2026-10-04.md) —
  Full unit/coverage and browser verification, 41 new media/PRO composite cases,
  production artifacts and six Worker dry-run bundles. Two test-oracle defects
  repaired with original failures and controls preserved; product code unchanged.
  Existing security/cache promotion gates and physical-device checks remain.
- [Full local beta verification — 2026-10-03](design/beta-full-local-verification-2026-10-03.md) —
  Complete local unit/coverage, Chromium, official WebKit, production-artifact
  and Worker bundle checks on the unchanged beta code. Functional suites pass;
  existing dependency security and cache-history promotion gates remain.
- [Beta sequence QA, round 7 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-7.md) —
  No new confirmed defect in file/queue mutations, PRO prepare/commit, YouTube
  controls and UI lifetime checks. 1,348 module/Worker and 10 Chromium cases
  pass. A conditional watchdog failure remains separate because its native
  trigger is unproven; this is focused evidence, not a complete release sign-off.
- [Beta sequence QA, round 6 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-6.md) —
  SQ14–SQ15 discovery and repair: preserve the first PRO repeat/shuffle gesture,
  retry failed required reads, and retire conflicted intent without losing a
  newer gesture. Independent native-parser/Worker-body replays, 31 new regression
  tests, full unit and focused Chromium verification retain their stated limits.
- [Beta sequence QA, round 5 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-5.md) —
  SQ10–SQ13 discovery and repair: preserve file pause checkpoints, retire PRO
  field intent correctly, retain known-rejected chat drafts, and restore
  semantic YouTube playback after sharing. Original failures and independent
  revalidation preserved, with module and Chromium regressions; native-media
  and public-release limits remain explicit.
- [Beta sequence QA, round 4 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-4.md) —
  SQ07–SQ09 discovery and repair: failed-file selection retires outgoing output,
  PRO slowmode preserves drafts, and reconnect fences stale HTTP PREPARE.
  Original failures preserved; 45 new module regressions, reconciled 10,503
  unique unit passes and 75 focused Chromium passes. Cache/version and other
  release gates remain separate from beta verification.
- [Beta sequence QA, round 3 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-3.md) —
  SQ05–SQ06 discovery and repair: failed-demo settings rollback and PRO
  one-shot observation loss before heartbeat catch-up. Preserves failing evidence,
  independent reproductions and excluded reachability candidates; records fixes,
  authority/permission controls, full unit and focused browser verification.
- [Beta sequence QA, round 2 — 2026-10-03](design/beta-sequence-qa-2026-10-03-round-2.md) —
  SQ02–SQ04 discovery and repair: late resume progress rollback, obsolete file
  recovery during system-audio takeover, and pending YouTube start overriding
  a newer seek. Preserves failing evidence and records the beta fixes,
  independent reviews, cancellation controls and regression results.
- [Beta sequence QA — 2026-10-03](design/beta-sequence-qa-2026-10-03.md) —
  fresh asynchronous sequence probes; SQ01 direct-file prefix loss confirmed
  in beta and archived main, with recovery and neighboring controls. A dated
  repair addendum records the beta fix and integrated regression evidence.
- [main → beta merge-readiness audit — 2026-10-01](design/main-beta-merge-audit-2026-10-01.md) —
  full cumulative diff review and current-SHA local verification, with dependency
  audit blockers and remaining device/exact-main release gates recorded separately.
- [Beta defect harvest — 2026-09-27](design/beta-defect-harvest-2026-09-27.md) —
  discovery-only evidence, four defects confirmed at that checkout. The
  [beta release record archive](beta-release-readiness-archive-2026-10-10.md) tracks their disposition.
- [Beta defect repair — 2026-09-27](design/beta-defect-repair-2026-09-27.md) —
  follow-up repairs and regression evidence for those four defects on beta.
- [Beta defect harvest, round 2 — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-2.md) —
  discovery-only evidence for three additional defects after those repairs;
  the [beta release record archive](beta-release-readiness-archive-2026-10-10.md)
  tracks their resolution and verification limits.
- [Beta defect repair, round 2 — 2026-09-27](design/beta-defect-repair-2026-09-27-round-2.md) —
  PRO playback restoration, ordered preload completion, and translation author deletion fences.
- [Beta defect harvest, round 3 — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-3.md) —
  one confirmed PRO late-join playback race during live system-audio sharing;
  discovery only, with focused controls and explicit reproduction limits.
- [Beta defect harvest, round 4 and repair — 2026-09-27](design/beta-defect-harvest-2026-09-27-round-4.md) —
  no additional confirmed defects in the bounded review; repairs and verifies
  the previously discovered PRO live-share snapshot restoration race.
- [Luna combination audit and ASTRA verification — 2026-09-27](design/beta-luna-combination-audit-2026-09-27.md) —
  1,250 new local probe cases with explicit composition, outcome-variant, and
  helper counts; no new confirmed defects or product changes. Native device,
  live transport, and full E2E coverage are not implied.
- [Full project audit — 2026-07-19](full-project-audit-2026-07-19.md) — dated
  defect record with a maintained residual-boundary and verification addendum.
- [Runtime scenario verification — 2026-05-31](runtime-scenario-verification-2026-05-31.md) —
  dated origin with a maintained verification checklist.
- [TypeScript migration roadmap](typescript-migration/ROADMAP.md) and
  [status](typescript-migration/STATUS.md) — completed execution evidence; the
  migration README and guards define the surviving contract.
- [Runtime v2 prototype](design/runtime-v2-prototype.md) — partial-adoption
  design evidence, not a claim that the whole prototype is current.
- [PRO heartbeat benchmark](performance/pro-room-heartbeat-benchmark.md) —
  reproducible evidence, not an uptime or latency SLO.

## Historical archive

The following files preserve a dated baseline. Their “current” wording, counts,
line numbers, proposed phases, and test totals describe that baseline unless a
clearly labeled maintained addendum says otherwise:

- [Beta release record archive — 2026-10-10](beta-release-readiness-archive-2026-10-10.md) —
  the full beta-era promotion, QA, and release record (2026-09-27 to 2026-10-10),
  superseded by the [release record](release-record.md) and
  [release history](release-history.md)
- [Documentation truth audit — 2026-08-17](documentation-truth-audit-2026-08-17.md)
- [Project analysis — 2026-05-24](project-analysis/2026-05-24/00-index.md)
- [CSS cleanup — 2026-05-30](css-cleanup-2026-05-30.md)
- [Large source-file split design — 2026-05-30](large-file-split-design-2026-05-30.md)
- [Performance and memory audit — 2026-05-30](perf-memory-audit-2026-05-30.md)
- [Type-safety audit — 2026-05-30](type-safety-audit-2026-05-30.md)
- [Device test — 2026-06-10](device-test-2026-06-10.md)
- [Domain audit — 2026-06-10](domain-audit-2026-06-10.md)
- [Scenario audit — 2026-06-10](scenario-audit-2026-06-10.md)
- [Earlier full-project audit](full-project-audit.md)
- [Manual QA checklist](design/manual-qa-checklist.md)
- [Playback state-machine design](design/playback-state-machine.md)
- [E2E coverage notes — 2026-05-30](../e2e/COVERAGE-NOTES-2026-05-30.md)

Use Git history when an exact old implementation is needed. Do not revive a
discarded plan merely because its record remains in the repository.

## Repository policy, legal, and public copy

- [Security policy](../SECURITY.md)
- [Trademark policy](../TRADEMARKS.md), [brand/fork guide](../BRAND_POLICY.md),
  and [AGPL additional terms](../ADDITIONAL_TERMS.md)
- [Third-party notices](../THIRD-PARTY-NOTICES.md)
- Hosted design-system material under
  [`public/designsystem/`](../public/designsystem/README.md)

Files under `public/**` and hosted `.workshop/**` trees are App artifact inputs,
even when their content is documentation. Follow the App version/cache/release
path rather than the repository-only publication path.

## Source of truth and publication

For behavior claims, precedence is: production source/configuration, executable
tests/guards/manifests, maintained documents above, evidence, then historical
records. Live provider state requires a live read; never infer it from a green
source-only check.

Repository-only documentation, example configuration, GitHub workflow, and
test/guard changes that feed neither an App nor Worker bundle publish with a
reviewed GitHub `main` merge. They do not require product SemVer, a PWA
cache-epoch bump, or a Cloudflare Production Release. Hosted public copy and
runtime inputs follow the separate exact-SHA path in the canonical
[hotfix procedure](hotfix-procedure.md).

Secret-bearing local operations notes live under ignored `docs/private/` and
must never be added to Git.
