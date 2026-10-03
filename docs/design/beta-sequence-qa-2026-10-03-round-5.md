# Beta sequence QA, round 5 — 2026-10-03

| Field | Value |
| --- | --- |
| Status | Dated discovery evidence — SQ10–SQ13 confirmed, not repaired in this round |
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
