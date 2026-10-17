# Deferred Back guard (R policy) — 2026-10-17

## Decision and evidence

The owner approved implementation and production release after comparing a
standalone diagnostic on physical iPhones. The original issue affected both
Safari and installed PWA sessions: Back displayed an old setup/input snapshot
for about three seconds before the leave confirmation appeared.

The diagnostic separated initial history registration from registration after
Back. Immediate re-registration (I) reproduced the delay; deferred R allowed
windows to close one level at a time. E did not register another guard after
Back: opening it directly appeared to disable swiping only because there was
no preceding document. With the supplied preceding page, E could leave.
The owner therefore chose one R policy for entry and subsequent Back actions.
These reports are evidence about the standalone diagnostic, not the deployed
application or every iOS version.

## Implementation

- One controller applies the UI action first, waits for actual app-owned
  closing surfaces, then allows two requestAnimationFrame callbacks before
  restoring one owned guard. No synchronous pushState in popstate, no
  button-specific gesture blocker, and no repeating polling timer.
- Initial room entry waits for the setup DOM to disappear, not the complete
  decorative entrance animation. An existing owned guard is reused.
- Back closes the topmost window before asking to leave a session. Required
  dialogs consume Back without dismissing. A Back on the leave confirmation
  means Stay. Explicit close buttons keep their existing semantics.
- A closing owner reports completion: View Transition finished, screensaver
  removal, demo curtain reveal, chat drawer transition, CSS window/disclosure
  closing transitions, and native fullscreen exit. Existing cancellation and bounded completion paths release the same
  token. New closing work supersedes pending frames; listener exceptions do
  not retain a token indefinitely.
- History entries carry a document-specific owner and base/guard kind. Forward
  and foreign/duplicate events do not close another window. URL cleanup keeps
  history state. No saved room URL or activation fragment is replayed.
- Confirmed Leave cancels re-registration. It traverses an owned guard to its
  owned base only if present, then goes Back once. A pagehide cancels fallback;
  one 1-second fallback goes home if navigation does not leave. There is no
  unconditional go(-2) or 150ms same-URL comparison. Reset recovery restores
  the controller, and hidden/pagehide documents cannot register a late guard.

No room authority, audio/playback, network protocol, persisted user data,
translations, dependencies, permissions, schema, secrets or bindings change.
Release scope is App, Developer API D1=false. Rollback is the prior compatible
App artifact and restores immediate history registration and its known iOS
symptom; it does not require any data rollback.

Product/cache identifiers advance to **8.11.12 / v712**. The Back regression
suite is included in the blocking Chromium critical-browser command and the
desktop WebKit selection. No gate or byte budget was raised.

## Verification

Base: `24be2ec3` (main including the 8.11.11/v711 deployment record).
Local environment: Windows, Node 24.13.1, npm 11.8.0.
Tested runtime code SHA: `012c44ac3acb4d504532bbffdd67c7c78861dd7c`.
Local and PR checks are not the exact-main CI release candidate.

Initial focused results:

- Controller/history unit tests: 39 pass after independent review fixes for
  duplicate popstate cancellation, initially hidden documents and failed
  navigation recovery.
- Real browser History API tests: Chromium 9 pass; desktop WebKit 7 pass,
  2 explicit platform skips (PeerJS/real-file paths unsupported in the Windows
  WebKit runner). Both skipped paths pass in Chromium. No retries.
- UI completion tests cover actual completion, successor close, required
  dialogs, cancelled transitions, callback failures and existing fallbacks.

Initial static checks caught an unnecessary exported type (self-only count
78 vs baseline 77), test fixture typing and floating-promise lint issues.
Those were corrected without raising budgets.

An early whole-unit run overlapped review edits and is not final-tree evidence:
573 files passed, 3 failed. The failed files were the export ratchet, the newly
added callback-exception pins before their implementation completed, and the
maximum-font-weight guard. The latter recursively included two ignored
October 9 `cloudflare/scratch/**/app-bundle/app-worker.js` build copies. The
current authored source did not contain their weight-800 declarations. Its
file discovery now matches the existing authored inventory: Git tracked plus
nonignored untracked source. A temporary-Git fixture proves that tracked files
matching an ignore pattern and newly authored files remain in scope. The
700 limit and matching patterns were not relaxed; no old files were deleted.
Final results follow below.

Final local verification (runtime source fixed before this run):

- Complete unit suite: **578 files / 12,973 pass / 0 fail / 0 skip**, 335.53s.
- Committed-HEAD `build:checked` passes at `012c44ac`: App 8.11.12/v712,
  97 app-shell assets; entry 427.0 KiB raw / 126.6 KiB gzip, eager JS
  466.1 KiB gzip, eager total 2019.9 KiB raw / 540.8 KiB gzip. Every positive
  budget preserves its existing 5% reserve; production hooks/security, legacy
  TV, font, service-worker and asset identity checks pass.
- Full typecheck (including Worker declarations and E2E), full lint and
  formatting pass. Worker syntax, Developer API boundary, D1/ops contracts,
  import graph, dead exports, event pairing, room authority, chunk pump and
  lifecycle guards pass.
- Existing blocking Chromium paths plus app entrance: **51 pass**, 3.5m.
- Back History API suite: **Chromium 10 pass** (21.6s), **WebKit 8 pass /
  2 explicit platform skips** (30.1s). The skipped real-peer/file paths passed
  in Chromium. No retry setting was enabled.
- The new normal-motion WebKit assertion initially counted both opening and
  closing opacity events. A diagnostic repetition reproduced 7 failures and
  1 pass: the extra event had `show:true`, opacity 1 and elapsedTime 0.28;
  the actual close had `show:false`, opacity 0 and elapsedTime 0.2. It arrived
  before the closing helper was installed, so this was a test observation
  boundary error, not evidence of early guard registration. Awaiting the
  actual opening event before observing close fixed **8/8 repetitions** and
  both complete browser lanes without changing the application or build.
  The closing-event-before-push assertion remains strict.
- Independent code reviews covered the controller/history adapter, native
  fullscreen completion, CSS owners and exception/cancellation cleanup; no
  remaining P1/P2 was identified.

Final remote verification used the merged main SHA
`336e80cdcad1ef35ce063540297a99e2e331d841` from
[PR #383](https://github.com/hiefny/MUSIXQUARE/pull/383).
[Exact-main CI 39008608569](https://github.com/hiefny/MUSIXQUARE/actions/runs/39008608569)
passed all 11 jobs. Its unit shards total **578 files / 12,972 pass / 1 skip /
0 fail**. The Linux skip is the Windows-only other-drive artifact-path test in
`pro-grant-campaign-cli.test.ts`; that test passed in the local Windows suite.
Production-candidate browser checks passed **17/17** (35.8s), and the blocking
critical-browser selection, including the ten Back tests, passed **55/55**
(3.2m). The final PR-head CI also passed, and GitHub Codex review of `16d25f3`
reported no findings. The release used the exact-main candidate, not the PR
build or local output.

## Limits and physical follow-up

Two animation frames are rendering opportunities, not a WebKit snapshot-release
API. Desktop Chromium/WebKit cannot prove native iOS edge-swipe rendering.
Browser verification covered the blocking and targeted selections above; the
complete browser E2E suite was not run for this release.
The owner must verify the deployed app in Safari and installed PWA: room entry,
media/notice nesting, Stay and repeated Back, required recovery dialogs,
animated close, and a real preceding page.

During a deferred re-registration interval there may be no guard. This design
is not a guarantee that arbitrarily fast repeated navigation cannot leave;
existing browser beforeunload behavior remains browser-controlled. It does not
remove foreign or earlier-document history, or guarantee that an already-owned
pre-entry snapshot will be replaced. No extra hidden safety records are added.
Existing scroll, pinch/zoom policy, gestures inside lists, and onscreen controls
are unchanged.

## Release and recovery

[Production Release 39009031876](https://github.com/hiefny/MUSIXQUARE/actions/runs/39009031876)
attempt 1 succeeded for `target=app`, `apply_developer_api_d1=false`. The deploy
job completed at **2026-10-17 15:13:55 KST (06:13:55 UTC)**. App **8.11.12 /
cache v712** was deployed from main `336e80cdcad1ef35ce063540297a99e2e331d841`,
using [immutable candidate artifact 12092440097](https://github.com/hiefny/MUSIXQUARE/actions/runs/39008608569/artifacts/12092440097).
Candidate tools were Node 24.20.0, npm 11.19.0 and Wrangler 4.148.0.

- App Worker version: `b57a7ba8-75c6-4524-bf9a-a0e6146453eb`.
- App deployment: `bc566df4-8229-4e17-b705-d5b1a781a24a`.
- Final release ownership was verified at 06:13:50.886 UTC against that exact
  version, deployment and Git SHA. The coherent production marker was saved.
- All four applicable operational smokes passed: App generation, anonymous
  App account boundary, current PRO public boundary, and Standard HTTPS
  signaling fallback. Unselected Worker smokes were skipped; those Workers
  were not redeployed and passed the partial-release compatibility recheck.
- [Operations Drift Audit 39009160344](https://github.com/hiefny/MUSIXQUARE/actions/runs/39009160344)
  succeeded: **31 pass / 0 fail / 5 manual-only** at 06:14:41.509 UTC;
  its audit job completed at 06:14:51 UTC.
- Evidence: [deployment/verification artifact 12092242363](https://github.com/hiefny/MUSIXQUARE/actions/runs/39009031876/artifacts/12092242363)
  and [coherent marker artifact 12092356263](https://github.com/hiefny/MUSIXQUARE/actions/runs/39009031876/artifacts/12092356263).

At 06:14:15.253 UTC, all four public asset GETs returned HTTP 200 and matched
the immutable candidate in both byte length and SHA-256:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `/` | 140,676 | `0fa8abcc441b396b8190abbcba6e8092450c419d7c2ff38f26252dfdbacc8c38` |
| `/service-worker.js` | 39,149 | `419b7eb1d360796a0e08bc07c349114274a29c91fe8c77b5f2202cc7c89816e2` |
| `/bootstrap.js?cache=v712` | 10,196 | `23c52fb5e68902dae1411a342209c381dc607f0e35ebec423fa2c098962cdf51` |
| `/assets/main-B1mHvDXw.js` | 437,229 | `5d9387ddeaecac620ba719b2695119ea2121b080288580030628845c2100f38d` |

Rollback was unnecessary and was not executed. The
[immutable recovery checkpoint 12091219796](https://github.com/hiefny/MUSIXQUARE/actions/runs/39009031876/artifacts/12091219796)
was captured at 06:13:00.566 UTC before deployment. It preserves prior App
**8.11.11 / v711**, Git SHA `019d510118dbe04df40bc78d6fd4d183ce18bc56`, Worker
version `fc121774-ec25-43d0-a1aa-6a71f4cd327e` and deployment
`15842e2c-10e2-4e1b-8015-3abf93b6520f`. A rollback would restore immediate Back
guard registration and the known iOS symptom, with no persisted-data rollback.
The release procedure must revalidate ownership and compatibility before any
recovery. The checkpoint is not a user-data backup.

The deployed-app physical iOS follow-up above remains open. Successful CI,
public asset checks, operational smokes and drift checks do not close it.
