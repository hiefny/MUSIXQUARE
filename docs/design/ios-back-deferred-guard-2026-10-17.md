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

## Limits and physical follow-up

Two animation frames are rendering opportunities, not a WebKit snapshot-release
API. Desktop Chromium/WebKit cannot prove native iOS edge-swipe rendering.
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

Pending exact-main CI candidate and Production Release. No production change
has been made by this task yet.
