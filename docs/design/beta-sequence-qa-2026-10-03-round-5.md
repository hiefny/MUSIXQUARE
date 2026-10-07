# Beta sequence QA, round 5 — 2026-10-03

| Field | Value |
| --- | --- |
| Status | Discovery evidence preserved below; subsequent beta repairs and verification are recorded in the [repair addendum](#repair-addendum--2026-10-03) |
| Tested checkout | `mxqr_beta`, `cf11f8a3749d567d8f47bbd5db30b3be18e0d660` |
| Product/test code | `a841b2d9315c23b71d78ca6263e3950b0a55cc82` — includes SQ07–SQ09 repairs |
| Main reference | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Environment | Windows, pinned Node 24.20.0, Vitest/jsdom, local Chromium and PeerJS; controlled service, decoder and iframe boundaries |
| Related records | [Living release record](../beta-release-readiness.md), [previous discovery and repairs](beta-sequence-qa-2026-10-03-round-4.md) |

## Result and scope

**Four new defects were confirmed.** Discovery covered local transfer/preload
ordering, pause/seek and operator resume, PRO authority/settings reconciliation,
chat during signaling recovery, YouTube host/guest offsets and end boundaries,
demo transitions, and system-audio takeover/restoration. The primary agent
independently replayed the audio, settings and YouTube reproductions; the chat
finding was reproduced in Chromium and independently source-reviewed.

| ID | Priority | Confirmed effect | Verified scope |
| --- | --- | --- | --- |
| SQ10 | P2 | File preparation loses an authoritative paused position; an operator resume can rewind the room to zero | Standard direct file, delayed route classification or paused late join |
| SQ11 | P2 | A canceled volume edit resurfaces through a fresh reverb edit and overwrites a newer room volume | PRO revoke/regrant, delayed denied PUT body, canonical GET and a new unrelated gesture |
| SQ12 | P2 | A known failed send consumes the draft and produces a local message or command success | PRO socket recovery, ordinary message, whisper and `/freeze on` |
| SQ13 | P2 | Sharing system audio during a host offset transaction restores a previously playing YouTube track paused | Standard host, manual-sync UI → system-audio picker → stop sharing |

These are four causes, not one defect per failed assertion. Earlier SQ01–SQ09
remain repaired within their tested scope. No introduction commit was bisected,
and no production incidence or physical-device prevalence was measured.
Product code and tracked tests were not changed. Only this evidence, the
documentation index and living release record are committed to beta. The
competition freeze, main, production, version/cache and disabled audit workflow
remain unchanged.

## SQ10 — file preparation discards the paused checkpoint

Two reachable sequences have the same cause:

1. An authenticated `FILE_PREPARE(B)` waits for ICE route classification while
   the ordered control channel continues with `FILE_START(B)`, `PLAY(B,12)` and
   `PAUSE(B,18)` (or a paused seek to 55). The pause correctly records 18/55.
   The pending PREPARE then resumes on the local route, stops media again and
   clears that checkpoint. Successful file reception/decoding leaves the guest
   silent, but at zero instead of the host's paused position.
2. A new participant joins a room already paused at 18. The real host bootstrap
   emits `PAUSE(B,18)`, followed by its file PREPARE/START. Even without an ICE
   wait, the later preparation resets the valid checkpoint to zero.

Three authenticated paused `SYNC_PONG`s after decoding do not restore it.
With operator authority, the real `togglePlay()` emits `REQUEST_PLAY(B,0)`.
The actual host handler accepts that request while its own checkpoint is 18,
broadcasts `PLAY(B,0)` and starts its source at zero. An ordinary guest cannot
issue that room-wide resume; its verified symptom is the incorrect local
paused position. A later valid host PLAY can recover it.

Source evidence at the audited code:

- [Playback bootstrap](../../src/player/playback.ts), around line 1253, emits
  the paused checkpoint before post-ICE file delivery.
- [File preparation](../../src/storage/transfer-receive.ts), around lines
  712–735 and 1018–1283, preserves pending PLAY across the stop but not the
  authoritative paused checkpoint.
- [Transport](../../src/player/transport.ts), line 1002, clears `pausedAt`;
  around line 2160 the operator resume serializes that local value.
- [File sync](../../src/network/sync.ts), around line 637, exits on a paused
  host before position reconciliation. The host request handler in
  [playback](../../src/player/playback.ts), around line 773, accepts the
  request's finite time.

Final composed matrix: **33 cases, 29 pass / 4 fail** for this single cause.
Real sender frames, binary transport parsing, receiver RAM assembly, authority
checks and playback entry points are composed. Normal PREPARE-before-pause,
latest PLAY, stale/unauthorized PAUSE, small/large preload handover, and remote
safety fallback followed by local promotion pass. Native audio and decoding
are controlled; the host and guest run sequentially in one jsdom harness.

Repair must preserve the latest authorized checkpoint for the exact selected
occurrence across its preparation without reviving an old track's pause,
canceling a newer PLAY, or weakening transfer/session fencing.

## SQ11 — a fresh effect edit republishes canceled volume intent

The strong reproduction uses snapshots and settings generated by actual public
PRO Worker endpoints:

1. A controller requests volume 0.4; concurrent authority revocation causes a
   real `403 CAPABILITY_REQUIRED`. Its response body is delayed in transit.
2. Presence reconciliation revokes the controller and cancels its checkpoint.
   Local volume 0.4 remains by the existing local-retention behavior.
3. The owner writes room volume 0.8 and regrants authority. The controller sees
   the new effects revision; the canonical settings GET waits behind the old PUT.
4. The controller changes **only reverb mix to 31%**. The old response finishes,
   and the GET reads volume 0.8. Reconciliation treats retained local volume 0.4
   as a still-active intent along with the new reverb edit.
5. A now-authorized PUT writes volume 0.4 plus reverb 31%, overwriting 0.8.

This is not an unauthorized server write. The server correctly rejects the old
request and accepts the later authorized one; the client misattributes which
fields belong to the new action.

[Effects reconciliation](../../src/pro-room/effects-reconciliation.ts), lines
46–52, explicitly preserves unrelated remote fields; full-state takeover is a
separate explicit OFF→ON policy. In [runtime](../../src/pro-room/runtime.ts),
lines 1706–1711 cancel the checkpoint without retiring individual field intent;
lines 1817–1838 infer intent from the old base, and lines 2036–2067 rebase all
those differences when the new gesture marks the checkpoint dirty. The full
PUT at lines 1912–1922 then carries the obsolete volume.

The strong Worker-backed client set has **4 cases, 3 pass / 1 fail**. Controls:
no fresh gesture adopts 0.8; a fresh volume 0.6 legitimately overrides it;
explicit settings OFF→ON legitimately publishes the retained full state.
Two public Worker sequences pass. The initial 403/409/503 exploration has
3 pass / 3 fail for the same cause; its arbitrary 409 path is not the public
Worker reachability proof and is not counted as a separate defect.

Repair should retire canceled field intent while retaining genuinely new
gestures and explicit full-state takeover semantics.

## SQ12 — known failed chat submission still commits local success

In a real Chromium page, the owner joins PRO, sends a successful control
message, then loses the WebSocket. The next signaling-ticket response is held
to exercise the application's actual recovery interval. The chat input remains
usable. Sending during that interval produces no outbound chat frame, and
`sendProRoomRealtime()` returns false, but:

- An ordinary message appears as a local sent bubble and its draft is cleared.
  A connection failure notice is also shown, but the text is already lost.
- A whisper appears as a local private bubble and its draft is cleared, with no
  corresponding connection failure notice in this path.
- `/freeze on` reports success and sets local `chatFrozen=true`, although the
  server received no freeze command.

Connected equivalents and successful sends after recovery pass. This is a
known synchronous send rejection, not a claim that successful WebSocket sends
guarantee durable server delivery or that the product requires new ACK policy.
It differs from repaired SQ08, which was a slowmode admission mismatch.

Source: [chat UI](../../src/ui/chat.ts), around lines 1152–1155 clears command
drafts before execution; lines 1193–1278 stamp/echo ordinary messages before
handling failure and still clear input. [Chat commands](../../src/chat/commands.ts),
around lines 277–286 and 474–520, ignore the false return before local freeze
state or whisper echo. [Network bridge](../../src/pro-room/network-bridge.ts),
lines 379–398, correctly returns false when the socket is not open.

Final browser matrix: **6 cases, 3 pass / 3 fail**, retry 0; one underlying
submission defect. The first ordinary-message-only reproduction independently
failed the same way and is not added to that final unique count. External REST
and WebSocket boundaries are controlled; actual startup, UI input, recovery and
network bridge run in the built application.

Repair should commit draft clearing, echo, dedup/slowmode bookkeeping and
command success only after local admission succeeds, without silently queuing
stale commands or changing server policy.

## SQ13 — temporary synchronization pause becomes a permanent restore state

A standard host is playing YouTube. In the actual manual-sync editor the user
enters 500 ms, commits, closes the overlay, opens media sources and starts
system-audio sharing. If the picker returns while the offset transaction is
still applying, stopping the share restores the original video **paused**.

The transaction retains playing intent but temporarily pauses the iframe.
[System capture](../../src/audio/system-capture.ts), around lines 640–654, saves
the current playback projection after picker/audio setup. Its restoration at
lines 971–987 derives autoplay from that snapshot, so the temporary pause is
treated as an intentional pre-share pause. The offset runtime's playing intent
is separate in [manual-offset runtime](../../src/youtube/standard-host-manual-offset-runtime.ts),
around lines 534–543 and the active transaction state.
The temporary pause is issued by
[host rendezvous](../../src/youtube/standard-host-rendezvous.ts), around line 77;
[iframe observation](../../src/youtube/iframe.ts), around lines 2883–2887,
projects it as paused. This finding is limited to standard rooms: PRO restores
from its server checkpoint through a different branch.

Module controls: normally playing resumes, intentionally paused stays paused,
and a settled offset resumes; applying offset fails (**3 pass / 1 fail**).
The UI composition with controlled native-picker response at 300/600 ms fails,
while 3000 ms lets the transaction settle and passes (**1 pass / 2 fail**).
These timings describe the harness, not a measured threshold on physical
devices. The primary agent reproduced all three failing cases independently.

Repair should capture semantic playback intent and a valid checkpoint before
retiring the transaction, while preserving explicit pause, newer selections,
room ownership and existing sharing policy. No native picker or acoustic
latency claim is made by the jsdom reproduction.

## Verification, evidence and limits

All evidence is based on the checkout/code SHAs above. New probes live under
ignored `scratch/qa5-2026-10-03/`; this report preserves their sequences and
interpretation, not a promise that another checkout contains scratch files.

| Execution | Final result |
| --- | --- |
| Audio composed matrix | 33 = 29 pass / 4 fail; primary replay identical |
| Strong PRO settings client + public Worker sequences | 6 = 5 pass / 1 fail; primary replay identical |
| Exploratory PRO response variants | 6 = 3 pass / 3 fail, same SQ11 cause; kept separate from strong confirmation |
| YouTube host/guest, demo and capture compositions | 67 = 64 pass / 3 fail; primary replay identical in two runs |
| PRO chat Chromium matrix | 6 = 3 pass / 3 fail; retry 0 |
| Existing focused units | 24 unique tracked files, 769 pass / 0 fail / 0 skip |
| Additional copied existing PRO Worker controls | 313 pass; actually executed in the primary replay, separate from the 2 new Worker sequences |
| Existing Chromium controls | 7 files, 24 pass / 0 fail / 0 skip / 0 flaky; retry 0 |
| E2E build | Passed; no deployment |

Repeated/intermediate results are not summed. Audio's early fixture ownership
and rate-limit setup errors, YouTube's initial legacy Stage1 expectation and
missing AudioContext mock export, and PRO's initial permission-fixture mismatch
are harness failures, not product defects. Final reproductions retain healthy
controls and fail only on the stated product expectations.

Primary replay artifacts:

- `audio/root-independent.json`, final source `audio/composed-preload.test.ts`.
- `pro/root-independent.json`: 325 total = strong 4 + exploratory 6 + public
  Worker 2 + copied existing Worker 313; 321 pass / 4 fail. Do not describe all
  325 as new probes. Strong source: `pro/settings-worker-backed.test.ts`.
- `youtube/root-boundaries.json` (64 = 63 pass / 1 fail) and `youtube/root-ui.json`
  (3 = 1 pass / 2 fail).
- `browser/offline-matrix.json` and `browser/controls.json`.

Replays use the pinned Node directory prepended to PATH and
`node node_modules/vitest/vitest.mjs run --config scratch/qa5-2026-10-03/<lane>/vitest.config.ts <test-file> --maxWorkers=1`.
Worker fixture generation uses `pro/settings-worker-sequence.test.ts` with
`-t "QA5 Worker produces"`; run it before the Worker-backed client fixture.
Browser matrix uses pinned Playwright browsers, `MXQR_E2E_APP_PORT=4211`,
`MXQR_E2E_PEER_PORT=9041` and
`node node_modules/@playwright/test/cli.js test --config scratch/qa5-2026-10-03/browser/matrix.config.ts --project=chromium --workers=1 --retries=0`.

This was not a full suite, coverage, WebKit, live-provider, native codec,
physical-device or security re-audit. Paused-file orchestration is not acoustic
sync certification. Mocked native media boundaries do not establish actual
provider behavior under all operating systems. The existing security and
public cache/version gates remain separate and unresolved. SQ10–SQ13 require
repair and regression verification before promotion; no new schema, secret,
binding, dependency or compatibility requirement is introduced by this
documentation-only round.

## Repair addendum — 2026-10-03

The owner authorized revalidation and repair after the discovery round.
Repairs began from `mxqr_beta` checkout
`292bfacd7721dc1a42696cb6082a2a2c013d8399`, with unchanged pre-repair product
code `a841b2d9315c23b71d78ca6263e3950b0a55cc82`. The original failing probes
were rerun before changes; their results remain separate from the passing
post-repair evidence below.

**Verified repair code:** `f617c80325771ef7519878c385fd24f55f90bdb3`.
The product code matches the verified working tree before this code commit;
final test-only type-import/format cleanup also passed type, lint and
formatting checks. **SQ10–SQ13 have no remaining confirmed defect
within this verification scope.** This does not clear the existing public
release gates.

### Changes and preserved boundaries

- **SQ10:** retain the latest authenticated host PAUSE checkpoint through the
  synchronous file-PREPARE media teardown. Ownership includes the exact host
  connection, room identity/epoch, queue occurrence, load epoch and file
  session. A late-join pause without a header binds to its first admitted
  session once. New PLAY, terminal end, new occurrence/session or retired
  connection/load cannot inherit it. Ready small/large preload promotion and
  recovery with already-received bytes have explicit controls. An operator's
  subsequent Play uses the retained position instead of restarting the room.
- **SQ11:** track pending room-settings gestures per field and revision,
  separately from settings retained on the device. Cancellation retires only
  the corresponding intent; canonical refresh and later unrelated gestures
  cannot republish it. A newer same-field gesture, independent EQ/reverb
  fields, transient retry and explicit settings OFF-to-ON full publication
  retain their existing semantics. This is client intent accounting, not a
  new Worker authorization or settings policy.
- **SQ12:** ordinary PRO messages, whispers and chat commands commit local
  echo, state changes, draft clearing and accepted-send bookkeeping only
  after the existing send function accepts them. Known rejection retains the
  draft and uses the existing connection-failure notice. It does not queue a
  command for automatic transmission after recovery or introduce server ACK
  guarantees. The visible BOT request also waits for local chat admission.
  Standard-room command order, local help and account-dialog focus remain
  covered by regression tests.
- **SQ13:** system-audio capture reads the active standard-host manual-offset
  transaction's semantic playing intent before retiring it. Both the gate
  and runtime validate the current player/session/room/queue/video identity.
  Explicit pause and settled/no-transaction behavior remain unchanged;
  canonical position and PRO server-checkpoint restoration keep their
  existing paths.

No new dependency, protocol, Worker, schema, binding, secret, migration or UI
layout is introduced. The App client needs a future authorized release. The
cumulative beta release still requires `target=all` with
`apply_developer_api_d1=false` for the previously documented changes.
Version `8.6.61`, cache `v630`, main and production remain frozen.

### Revalidation and adjacent cases

Original pre-edit audio 29 pass/4 fail, strong Worker-backed settings client
3 pass/1 fail, capture 4 pass/3 fail and Chromium chat 3 pass/3 fail were
reproduced. After repair the same probes passed: audio 33, settings client 4,
capture 7 and chat 6. The settings replay used freshly regenerated public
Worker fixtures (2 passing sequences; 313 copied cases excluded by its name
filter). These scratch replays overlap tracked regressions and are not added
to the final unit or browser totals.

Independent review also checked a terminal denial of the canonical GET made
by a pending settings checkpoint: an older volume gesture must retire while
a newer reverb gesture survives. Restoring only the previous outer-catch
branch through a scratch source transform made this exact regression fail
(`0.4` instead of canonical `0.8`); final code passed. This is an adjacent SQ11
path, not a fifth independent finding. An earlier scratch probe accidentally
intercepted a background refresh rather than this checkpoint GET; its invalid
expectation is excluded from defect evidence.

Tracked coverage includes 46 composed file-pause cases, 22 PRO runtime/API
cases, 8 field-tracker cases, 15 added chat-unit cases and 18 capture/identity
cases. Three new Chromium recovery cases verify ordinary message, whisper and
freeze rejection, no automatic publish on recovery, and successful explicit
retry. Existing effects tests were moved from removed difference-based helper
exports to the active field-tracker API; their unchanged-field, concurrent
field, initial hydration and explicit takeover behavior remains tested.
Two obsolete source-spelling assertions were removed. No dead-export or
complexity baseline was raised.

Evidence lives in ignored `scratch/qa5-repair-2026-10-03/`: `audio/`, `pro/`,
`pro-review/`, `youtube/`, `chat-before.json`, `chat-after.json`,
`chat-unit.json` and `chat-tracked-browser.json`. The tracked tests preserve
the executable regressions for another checkout; availability of local
scratch evidence is not assumed.

### Final verification

Windows, pinned Node 24.20.0, Vitest 5, Playwright 1.63 Chromium and actual
jq 1.8.2. Module/browser concurrency was limited to two workers. The full unit
run includes the focused regressions; totals below do not add repeated runs.

| Check | Final result |
| --- | --- |
| Full tracked unit suite | **508 files, 10,606 pass, 0 fail, 0 skip, 0 todo**; one complete run, including 97 release-state tests with jq |
| Focused Chromium | **15 files, 98 pass, 0 fail, 0 skip, 0 flaky**, retry 0; includes the 3 new PRO rejection/retry regressions |
| Types | App, unit, E2E and Node-script checks passed |
| Lint and formatting | App lint, final changed-source lint, changed E2E tooling lint and changed-source Prettier passed |
| Source guards | Authored assets/project coverage, release identity, brand/declarations, complexity, room-authority, profanity, hreflang/sitemap, chunk pump, imports, bus pairing, lifecycle, dead exports and Playwright API passed |
| Builds | Final E2E and production local builds passed |
| Production artifact guards | Legacy TV, service worker, UI kit, initial transfer budget, production hooks/security configuration, fonts and app shell — **8 passed** |
| Cache-history guard | Expected outstanding release gate: frozen v630 has subsequent runtime changes; no version/cache bump or baseline bypass was made |

Primary final artifacts: `unit-all.json`, `chromium-focused.json`,
`build-e2e-final.log`, `build-production.log`, final type/lint/format logs and
`guard-*.log` in the repair evidence directory. Browser selection covered
critical startup/PRO recovery, chat and commands/cards, file transfer,
preload, playback/advanced playback, late join/bootstrap catchup, reconnect,
YouTube synchronization, system-audio controls and demo common-start/reliability.
The initial dead-export check exposed the obsolete exported merge helper;
removing that unused API restored the existing 79 self-only binding baseline.
Initial test-import/format errors were repaired, without changing behavioral
expectations to hide a product failure. All selected final checks passed
except the explicitly retained public cache-history gate.

### Limits and recovery

The file and capture module compositions control native decoding, iframe,
picker and audio-output boundaries. The strong PRO cases use actual Worker
responses with runtime, network bridge and API body parsing, but controlled
HTTP/WebSocket delivery. Chromium exercises real startup, DOM, local peer
connections and socket recovery; provider/service responses are controlled
where the fixture declares them. This is not physical acoustic alignment
certification or a fresh full E2E, WebKit, coverage, live-service or security
audit. Existing physical-device and exact-main-SHA promotion gates remain.

Rollback requires reverting the App changes and their tests as a unit before
the eventual authorized release; no database rollback or manual data repair
is introduced. Do not reactivate Operations Drift Audit or advance main as
part of this beta repair. Public version/cache increments and existing
dependency-security remediation remain separate release work.
