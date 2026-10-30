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

- [App 9.0.26 train: PRO system-audio LAN-direct in one round trip and the chat sheet without its Close (2026-10-30)](design/app-9-0-26-train-2026-10-30.md):
  assembled and checked locally, not merged or released; the version bump `b2ac0109` (9.0.26 / v799,
  App build 799, update dialog) is the last runtime commit, followed only by tests and docs. Target
  `app`: 50 App runtime paths (one LAN-direct file, the chat sheet's 46 and the bump's three
  mirrors), none in the other five Workers, no runtime dependency change. The branch is PR #534
  (head `b7986840` on main `f8a30068`) with the chat sheet's three commits moved on top and the
  tests-only follow-ups `5b7abd30` and `e085fad1` (LAN-direct rows for a probe channel announced
  after the receiver's pair proof). The report lists both increments with their tested SHAs
  (`d0b71a89` pins the old behaviour; the rows of `9b3ca4aa` and `de47d982` fail on their parents),
  the review findings and their handling, the QA rounds (local runs, PR #534's CI, the assembled
  tree's checks and the final check after the bump), mixed versions (a 9.0.25 or older device and a
  9.0.26 one use the SFU), the rollback to the 9.0.25 / v798 checkpoint App, the deploy conditions,
  a blind post-deploy LAN-direct check and what was not verified.
- [PRO system-audio LAN-direct in one round trip (2026-10-30)](design/pro-lan-direct-one-round-trip-2026-10-30.md):
  implemented and checked locally, not yet released; it ships in the App 9.0.26 / v799 train above
  (target `app`). On a desktop sharer with an iPhone listener on one Wi-Fi every PRO share went to
  the SFU because the two-round-trip LAN-direct negotiation (probe, then media re-offer) missed its
  single 2 s deadline (pinned by the tests-only commit `d0b71a89`). Owner decision 2026-10-30
  (option C): one offer carries the probe channel and an empty audio sender, the receiver proves
  its pair and reports it on the probe channel, and the capture track attaches only after both
  proofs; the answer must come within 2 s and the proofs within 1 s more, and the first failed
  route ends the attempt. The relay frame shape is unchanged, so no Worker changes; a 9.0.25 or
  older device and a newer one never build a route between them and use the SFU. Each route logs
  one info result line. Not device-checked yet.
- [Chat sheet without its Close (X), owner decision (2026-10-30)](design/chat-sheet-close-removal-2026-10-30.md):
  not merged or released; it ships in the App 9.0.26 / v799 train above, whose bump covers it. In
  this change, built on main `b8ae59e7` (9.0.25 / v798), the phone and tablet chat sheet loses the
  visible Close that 9.0.20 put at the start of its handle row (dialog exit item F12) and closes as
  before 9.0.20: an outside tap, a tap or a swipe down on its drag handle, Enter or Space on the
  focused handle, Escape and Back. App only (46 runtime paths; `chat.close` leaves the 42
  locales). The note lists the owner decision, the change and its guards (the chat sheet is now
  the one window whose exit is its drag handle), the tests-first commit `d5c83195` (6 unit tests in
  5 files and the new E2E fail on its parent), the checks on `d4f11e1d`, the 390x844 light and dark
  screenshots before and after (kept outside the repository for the owner; only the X's glyph
  differs), the owner step for `chat.close` translation suggestions after the release, a gap in the
  sheet's keyboard Tab cycle found on the way and left as it was (now a follow-up item in the
  release record), and what was not verified.
- [Phase 5.5 R3: the App stops reading PRO snapshot schemaVersion 1, 9.0.25 (2026-10-30)](design/phase5-5-r3-v1-receive-stop-2026-10-30.md):
  released on 2026-10-30 07:18 KST in Release 40964572017 (PR #532, squash `b8ae59e7`): the third
  and last runtime release of Phase 5.5 (9.0.25 / v798, App build 798, bump `01f1a19b`; target `app`
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
  is a forward revert at 9.0.26 / v799 or later, or the checkpoint's 9.0.24 App without `lower`
  with the PRO Worker left in place.
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
  rollback boundary (a forward revert at 9.0.26 / v799 or later now that 9.0.25 shipped, or the
  checkpoint's 9.0.23 App `dddfabe3` without `lower`). Phase 5.5 R3, where the App stops receiving
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
  boundary (a forward revert at 9.0.26 / v799 or later now that 9.0.24 and 9.0.25 shipped, or the checkpoint's 9.0.22 App `e8966418`
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
  (a forward revert at 9.0.26 / v799 or later now that 9.0.23, 9.0.24 and 9.0.25 shipped, or the checkpoint's 9.0.21 App `06e79397` and
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
  boundary (a forward revert at 9.0.26 / v799 or later now that 9.0.22 to 9.0.25 shipped, or the checkpoint's 9.0.20 App
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
