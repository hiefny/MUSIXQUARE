# Runtime Scenario Verification - 2026-05-31

> **Maintained checklist.** Originally added on 2026-05-31 and revalidated on
> 2026-08-15. Exact-SHA automated CI is the ordinary production release gate.
> Physical-device verification is an optional, risk-based confidence pass for
> browser, audio-hardware, lifecycle, and network behavior that automation
> cannot reproduce faithfully.

## Scope

This is the maintained verification order for runtime-sensitive flows across
playback, network, transfer, YouTube, and system audio.

Unit/static checks and the blocking browser subset establish deterministic
release confidence. Use the real-device matrix when a change or incident needs
additional browser, audio-hardware, lifecycle, or network observations.

## Optional Browser Automation Signal

The following focused group remains available when browser automation is useful
and time-bounded:

```bash
npm run test:e2e:runtime
```

The script builds the E2E bundle first, then runs:

- `e2e/late-join.test.ts`
- `e2e/playback-sync.test.ts`
- `e2e/youtube-sync.test.ts`
- `e2e/reconnection.test.ts`
- `e2e/background-resume.test.ts`

This larger focused group is not a required release gate. Do not interpret a
green focused or full E2E suite as proof that Web Audio, background/resume,
device routing, or real WebRTC network transitions work on specific hardware;
run the optional physical matrix when that assurance is needed.

## First 48 Hours

### 0-2 hours: establish a safe baseline

1. Install with `corepack npm ci`; do not add production credentials to the checkout.
2. Start `npm run dev` with the default fail-closed local API boundary. Confirm
   a production-backed API path returns `503 LOCAL_API_PROXY_DISABLED`, not the
   SPA HTML and not a production response.
3. Run the smallest focused unit test for the touched area, then run
   `npm run typecheck` and `npm run check:workers` when Worker code is involved.
4. Record the devices, browser versions, audio roles, and network shapes needed
   for the touched scenarios. Capture a fresh-load memory/debug baseline.

### 2-24 hours: implement and exercise the risky path

1. Keep deterministic regression tests close to each change and run `npm test`,
   `npm run lint`, and `npm run build:checked` before device work.
2. If the change warrants optional physical QA, exercise the affected scenario
   on at least two devices when it crosses host/guest, WebRTC, audio routing, or
   background lifecycle boundaries.
3. In that optional pass, include the applicable failure/recovery branch:
   disconnect/reconnect, background/resume, rapid source replacement, or denied
   authorization.
4. Use the memory checkpoints below and retain concise observations when
   diagnosing runtime behavior.

### 24-48 hours: repeat, broaden, and decide

1. When physical QA was selected, repeat every touched row in the manual matrix
   from a clean build and fresh sessions; include both local-network and
   remote-network paths when relevant.
2. In that pass, verify cleanup and recovery after leave, hard reload, and one
   background or network interruption. Compare memory/debug state with the
   recorded baseline.
3. Review Worker contract/deployment guards and the rollback boundary without
   performing an ad hoc production deploy.
4. Record device/browser/network evidence and any accepted limitation when the
   operator elected to require the physical-device gate for that release.

Worker boundary changes must preserve the bounded-read contract. App, account,
Developer API/facade, PRO grant/BOT, and remote-share JSON request readers use a
10-second deadline and route-specific byte caps. Newly hardened downstream
service/provider readers use route-specific 5-15-second budgets; the existing
playlist-manifest path retains its named 45-second ceiling. The BOT path has one
35-second total envelope that includes preflight and response-header wait.
Stalled streams must cancel and fail closed. HMAC/signing/pepper secrets
documented by the owning Wrangler file or runbook must also fail closed below 32
characters; provider-issued API keys retain their provider-defined formats.

### Historical v1 service-control cutover addendum (2026-05-31)

At the time of the original 2026-05-31 verification, the first release
containing the exact
`admin-announcement-v1+abuse-rate-v2+session-idempotency-v1`
service-control marker was a coordinated cutover. This subsection preserves the
v1 launch record; it does not describe the current marker. Use the live
[`service-control contract marker`](../cloudflare/service-control-contract-version.txt)
and [`hotfix-procedure.md`](hotfix-procedure.md) for current rollout and recovery
rules:

1. Use release target `all`. The release order is PRO, remote-share, signaling,
   Developer API facade/API, then App, so the service-control owner exists
   before every cross-script consumer. Do not use a partial target for this
   first release.
2. Remote-share allocation, signaling admission, and paid-resource limits use
   the shared service-control Durable Object for atomic decisions. The retired
   remote-share KV counter must not be reintroduced, and a missing production
   service-control binding must fail closed.
3. After the canonical service-control state has been written, do not roll PRO
   or App back to a pre-marker/legacy App version. Repair forward with another
   compatible full release. The rollback gate and operator procedure live in
   [`hotfix-procedure.md`](hotfix-procedure.md).
4. This checklist documents release order only. Do not perform an ad hoc deploy
   from a development checkout.

The `session-idempotency-v1` suffix coordinates the App/browser request body
and PRO Durable Object receipt contract. New clients send an opaque
`requestId`; PRO durably replays the same deterministic session credential for
the same actor and exact body after an uncertain App timeout. PRO continues to
accept the legacy exact `{ pin }` body during the cached-client rollout, but it
does not collapse those requests by IP or User-Agent because doing so would
merge distinct devices behind one NAT. Deploy PRO before App through target
`all`, then repair forward rather than partially rolling either side behind the
marker.

Before considering that cutover healthy, collect these targeted signals:

| Check                                | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account completion on a slow network | On a physical mobile browser, complete the flow with its sensitive query present. Verify the query-bearing navigation is not cached, the queryless completion shell is the only offline fallback, and no query value reappears after reload/back navigation.                                                                                                                                                                        |
| Announcement save, clear, and expiry | From the admin UI in a controlled environment, publish an expiring notice, observe expiry, then clear it. Interrupt one post-commit response and retry the unchanged action; the UI must reuse the same request ID and produce one revision/history entry.                                                                                                                                                                          |
| Atomic abuse-rate serialization      | Run `npm exec vitest run -- src/core/__tests__/app-worker-cors.test.ts src/share/__tests__/remote-share-worker.test.ts src/network/transport/__tests__/cloudflare-signaling-worker.test.ts -t "barrier-concurrent"`. Every same-budget concurrent burst must admit no more than the configured limit.                                                                                                                               |
| URL credential privacy               | In browser network tools, verify a PRO socket URL has no search string, offers exactly the stable `mxqr.pro-signaling.v1` marker plus one bearer protocol token, and receives only the stable marker. A controlled request carrying any URL search string must receive `INVALID_PRO_SIGNALING_TICKET` without Durable Object lookup. Verify no metric or custom log contains the URL, ticket, room, participant, IP, or User-Agent. |
| Platform observability               | Confirm all six production Wrangler configs keep sampled custom logs enabled while `invocation_logs = false` and automatic traces disabled. Any change requires an intentional config, policy-test, and privacy review. Inspect a controlled OAuth callback and PRO join and verify no credential-bearing full URL appears in the custom log schema.                                                                                |
| Legacy duplicate-owner detach retry  | Run `npm exec vitest run -- src/core/__tests__/app-worker-cors.test.ts -t "detaches only the exact duplicate legacy owner and safely reconciles a signaling failure"`. The injected partial failure must converge on exact retry without changing the retained owner.                                                                                                                                                               |
| Cold font and offline fallback       | On a physical device with caches cleared, verify readable first paint while fonts load and that a cold font failure does not block service-worker installation. Then verify the intended offline app shell remains usable without the optional font.                                                                                                                                                                                |

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

## Optional Manual Runtime Matrix

Run the relevant rows when a change, incident, or explicit release choice needs
physical-device confidence beyond the automated gate:

| Scenario                                                    | Expected signal                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Remote guest late-joins a local-file room                   | Guest receives the authorized whole-object remote-share handoff, then syncs near host position. |
| Local guest late-joins a local-file room                    | Guest receives the direct WebRTC file transfer, then syncs near host position.                  |
| Host rapidly switches local files while a preload is active | Guest does not play the wrong file; stale chunks do not keep transfer stuck.                    |
| YouTube load, manual sync, then stop mode                   | Guest enters and exits YouTube projection without stale play timers.                            |
| Desktop system-audio share over local P2P                   | Guest receives one stream and cleanup restores previous UI state.                               |
| Remote system-audio SFU path                                | Guest receives SFU stream, host stop clears placeholder/receiving state.                        |
| Background/resume on mobile browser                         | App attempts recovery and warns if sync may be stale.                                           |

## Exit Criteria

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build:checked`
- When the optional physical-device release gate is selected, complete and
  record its declared browser/device and network rows before dispatching the
  release.

Optional focused or full browser E2E results may accompany this evidence as a
secondary signal. They are not an exit criterion.

## Persisting Production Release Evidence

When a release intentionally opts into physical-device evidence, complete the
matrix and dispatch
`.github/workflows/real-device-qa.yml` on the current `main` commit. The tester
must supply the exact 40-character SHA, completion timestamp, HTTPS environment
that served that commit, HTTPS detailed evidence link, and the physical device
matrix. Every standard-room, PRO-room, media-source, and background/resume
attestation must be explicitly checked. The current canonical v2 artifact is a
full-matrix attestation, so an operator selecting this optional gate must also
check adaptive proof-of-work performance even when the production adaptive
flag remains off. The linked log must record difficulty-16 cold and warm
p50/p95 results on a supported iPhone and a desktop browser on a Korean
connection, plus the build SHA, timestamp, Cloudflare colo, sample count,
timeout/failure behavior, invite-code timing, and full RTC-readiness timing
required by the security performance policy.

The workflow verifies that the attested SHA is still current `main`, records the
authenticated GitHub actor, creates a canonical JSON document, and retains the
immutable exact-SHA artifact for 90 days. It is an evidence recorder, not a test
runner: do not check a row that was not actually exercised, and keep device,
browser, network, observations, and screenshots in the linked detailed log.
The free-form device matrix is not a substitute for those measurements; it
must identify the tested models and browser/OS versions, while `evidence_url`
points to the retained raw observations.

`.github/workflows/release.yml` uses this artifact only when
`require_real_device_evidence` is selected. It then downloads the successful
unexpired exact-SHA artifact by source run ID and verifies its canonical
contents, repository, run attempt, and 14-day freshness before any production
mutation. With the option left off, the immutable exact-SHA CI candidate and
the workflow's automated production checks are sufficient; an older device
artifact is never silently reused.
