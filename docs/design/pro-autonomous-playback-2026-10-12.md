# PRO autonomous natural completion — 2026-10-12

## Decision and scope

The owner confirmed that an awake, authorized browser was the missing link in
the observed PRO end-of-track stall, and authorized continuing the playlist
while any participant remains. Explicit pause still wins; an empty room retains
its existing sleep/freeze behavior. Standard rooms and system-audio publications
keep their existing lifecycle. This is product 8.9.5 / cache v656.

The previous server-authoritative command reducer still required a browser with
`playback.control` to submit ENDED. Ordinary listeners could reach the end and
keep showing the canonical `playing` state indefinitely; repeated local ENDED
attempts also produced authority warnings. Granting listeners control would not
solve the missing server responsibility and would weaken the permission boundary.

## Implementation

- The room stores bounded, identity-fenced duration evidence and a durable
  metadata probe. An asynchronous lookup runs outside the mutation queue, then
  revalidates room generation, target identity, and probe before writing.
- The existing Durable Object alarm includes the canonical end deadline. After
  pruning stale presence, it executes the existing ended/unavailable reducer,
  PREPARE/COMMIT, and durable broadcast outbox. It does not mutate playback from
  an independent timer or accept an ordinary participant's declaration of length.
- Pause, seek, selection, a pending transition, live system audio, last-listener
  departure and a newer revision supersede the previous ending deadline. Cold
  restart restores persisted evidence; failed durable writes roll back before
  publishing and retain a retryable alarm.
- Repeat-one, repeat-all, shuffle and exact YouTube playlist occurrences use the
  same queue traversal as authorized controls. Duplicate video IDs retain their
  distinct subindices. A legacy playlist without a traversal manifest settles
  as paused rather than issuing an endless end-alarm loop.
- A playback-authorized browser may attach its decoded **file** length to the
  exact transition READY. The server independently checks permission, pending
  target and source identity. YouTube iframe `getDuration()` and ordinary member
  assertions do not become authoritative evidence. These decoded lengths use no
  grace; server container/YouTube lengths use a two-second rounding/padding grace.
  Authorized browser ENDED can still advance at the original precise boundary.
- Expected local end notifications from ordinary listeners are consumed quietly.
  Their explicit playback commands still have the same authority checks.

## Trusted metadata and bounds

Files are read through the canonical R2 binding, never a supplied URL. Each read
is at most 512 KiB; the probe is capped at 16 MiB, 256 reads and ten seconds.
Stalled/late bodies are cancelled, and size mismatch, truncation and overrun fail
closed. No audio is decoded on the server.

| Format | Accepted timing evidence |
| --- | --- |
| MP3 | Xing/Info or VBRI frame count; otherwise an exact bounded MPEG frame scan |
| FLAC | STREAMINFO sample rate and sample count; other metadata is not parsed |
| WAV/RF64 | Validated PCM/IEEE-float sample rate, block alignment and data extent |
| M4A/MP4 | Bounded, unambiguous audio-track timing headers and edit lists, without sample tables |
| AAC ADTS | Exact bounded frame/sample-rate scan |

Unindexed scans are capped at 100,000 frames. Ogg, Matroska, compressed WAV,
ID3v2.2, multiple MP4 audio tracks and files exceeding inspection budgets return unknown in this server
reader. Existing browser playback support is unchanged, and an authorized READY
can provide their decoded file length. If no authorized browser prepares such
a file and no server length is available, autonomous completion is unavailable;
the server does not guess. File lookup retries are spaced five minutes apart.

During review, a proposed generic demux path was rejected: a custom read callback
does not prevent a library allocating from an untrusted requested length before
calling that callback, and MP4 sample tables can expand a tiny declaration into
enormous work. The shipped path uses structural readers only. MP4 limits are
2,048 boxes, depth four, and 256 edit entries; `mdat`, sample tables and fragment
sample runs are not traversed. The leading-edit fixture's conservative header
end is 6 seconds (the previous demux calculation was 5.999229 seconds).
The browser's large-file engine selects its primary audio track by pairing,
default disposition and bitrate, rather than always taking the first `soun`
track. A multi-audio file therefore returns unknown instead of risking a shorter
server deadline for a longer selected track; READY supplies the decoded result.

YouTube metadata comes through the new `PRO_YOUTUBE_METADATA` PRO→App service
binding. A purpose-separated HMAC using the existing shared assertion secret
protects the internal path; the existing App YouTube API key remains server-only.
The service call is capped at four seconds, its Google request at three seconds,
and JSON at 32 KiB. The App cache holds at most 256 entries. The room's 64-entry
evidence cache binds queue occurrence and asset/version or video ID/subindex;
YouTube finite evidence expires after one hour and is refreshed before use.

Live/upcoming videos, missing/private metadata, API failure and unknown lengths
do not authorize a skip. Only explicit non-embeddability or terminal upload
failure does. A fully unplayable repeat queue stops after a bounded pass instead
of looping indefinitely. A later live classification invalidates a formerly
finite end deadline. Country-specific playback restrictions and actual browser
autoplay failure are not inferred from a global API response.

## Verification

Final runtime source: `8f6a31b9e97b8e47e0a6c0c710ff65f3ae07a956`.
Environment: Windows, pinned Node 24.20.0 / npm 12.0.2, jq 1.8.2.
Logs are retained locally under `scratch/pro-autonomous-2026-10-12/`.

Focused verification during implementation (overlapping counts, not additive):

- PRO Worker + independent natural-completion integration: 430 pass, zero skip.
- Independent integration exercises file→YouTube playlist→file→idle after owner
  departure, duplicate subindices, repeat/shuffle, seek/pause precedence, pending
  PREPARE, coincident last-presence expiry, cold restart, durable-write failure,
  delayed metadata, live refresh, source replacement, and all-unplayable queues.
- Bounded file/MP4 readers: 37 pass, including actual MP3/FLAC/M4A/AAC fixtures,
  large logical FLAC/RF64 objects, adversarial MP4 sample tables and edit counts,
  resource limits, late/stalled/truncated response bodies and ambiguous audio tracks.
- Client API + playback runtime: 222 pass, including optional file attestation,
  no YouTube/member attestation and old-server READY compatibility.
- Chromium browser subset: 10 pass, zero skip (YouTube near-end repeat/seek/file
  transitions with 0/240 ms player delay, manual sync after repeat, background
  resume, manual/invite PRO retry).
- Full typecheck passed; updated Worker/test TypeScript checks also passed after
  the bounded-reader replacement. App lint and tooling lint passed. An initial
  tooling run found a missing rejection handler in probe restart and a generated
  dry-run bundle under the lint scan; the handler was fixed and the generated
  artifact moved to the ordinary scratch directory. One format mismatch was
  corrected. The first full run at `53c018c5` had 11,503 passes and one failure:
  the bootstrap URL still carried v655. `6599c3cd` aligns it with v656. A second
  full run overlapped the final multi-audio test/code edit and is not accepted
  as stable-source evidence. These initial runs are not represented as successful.

Final local results:

| Check | Result and code |
| --- | --- |
| Full unit suite, four workers | 540 files / 11,507 pass / 0 fail / 0 skip, 225.98 s at `6316a958` |
| Source consolidation | `4b69c2f5` has a byte-identical tree to tested `6316a958`; unpublished intermediate commits were consolidated so the PWA changes and cache increment share one commit |
| Final YouTube signature path | 42/42 pass after `8f6a31b9` changes the internal signature domain capitalization to satisfy the source guard; both signing ends use the same new string |
| Production build | `build:checked` passed at `8f6a31b9`, including cache history, authority, source ownership, asset budget, security and app-shell guards |
| Worker bundles | All six production Workers bundled in dry-run mode; new PRO→App metadata binding present; no deployment performed by this check |
| Format | Full App/tooling format check passed |
| Contracts | Developer API boundary, D1 migration contract, source complexity and Operations Drift source contract passed |

The consolidated source differs after the full local run only in the tested
signature-domain spelling. The exact-main CI below covers the final tree. Local
or branch results are not an exact-main-SHA release candidate.

## Rollout and recovery

Deploy App and PRO together through `target=all`; no new secret, D1 schema or
rollback floor is introduced. The existing release order deploys PRO before
App. The old App's 404 for the signed metadata path is treated as uncertainty
and retried, never as evidence to skip a video.

Old clients still report READY without optional duration. A cached new App
against a rolled-back PRO retries once without that optional field only after
400 `INVALID_REQUEST`; authorization/conflict/server errors are not retried this
way. Old PRO code ignores the new timing cache and returns to controller-driven
completion. An App-only rollback makes fresh YouTube metadata unavailable until
the service path is restored. Existing compatibility floors remain authoritative.

Not verified by these tests: actual iPhone/Android suspension and audible output,
real YouTube embedding behavior, country/account restrictions, a large live
customer room, or indefinite uninterrupted playback. A device suspended by its
OS cannot be made audible by a server alarm. Finite metadata is required for
owner-independent natural completion, and normal PREPARE can still wait for its
existing bounded readiness deadline. Physical verification remains open in the
[release record](../release-record.md).

## Production evidence — 2026-10-12

PR [#298](https://github.com/hiefny/MUSIXQUARE/pull/298) merged as
`972555c307037c8b3a969d330f5857d3f37dd47f`. PR
[CI 38156034680](https://github.com/hiefny/MUSIXQUARE/actions/runs/38156034680)
and exact-main
[CI 38156513400](https://github.com/hiefny/MUSIXQUARE/actions/runs/38156513400)
each passed all eleven jobs. The exact-main run used Ubuntu and Node 24.20.0:

- Full unit suite: 540 files, 11,506 pass, zero failures, one skip. Linux skips
  `pro-grant-campaign-cli.test.ts`'s Windows-only cross-drive rejection case;
  this is not a missing jq dependency. The Windows local suite has zero skips.
- Production candidate/service-worker Chromium tests: 17 pass; critical
  Chromium tests: 22 pass. These are 39 test executions, not a full E2E or
  WebKit run.
- Broad, critical runtime, Worker and release-tooling coverage gates all passed.
  Their tests overlap the full unit suite and are not additional independent totals.

[Production Release 38156993930](https://github.com/hiefny/MUSIXQUARE/actions/runs/38156993930),
attempt 1, completed its deploy job at **2026-10-12 01:53:32 KST** with
`target=all` and `apply_developer_api_d1=false`. It reused that exact-main
candidate, passed all ten live smoke steps, verified ownership of all deployed
Workers, restored PRO generation readiness and persisted the coherent production
commit marker. The failed-release recovery job was skipped; no recovery was needed.

| Worker | Deployed version ID |
| --- | --- |
| App | `ca678ef8-9674-4c2e-986d-648ad86e71c5` |
| PRO room | `cb415dd7-2698-4342-a41d-674581426914` |
| Remote share | `e4b31787-f1d1-4b1f-825c-99dfe40b037a` |
| Signaling | `51e4cb53-c4e6-4a37-ade3-d797312b45dd` |
| Developer API facade | `0c523024-f233-450b-80c6-df1561e0f530` |
| Developer API | `71585dff-c88a-4498-98af-7d1fdfad9fd9` |

Independent public GETs returned HTTP 200 for the landing page and service worker,
with `bootstrap.js?cache=v656` and cache `v656`. The deploy log confirms
`PRO_YOUTUBE_METADATA` targets `musixquare-app`. The live smoke checks do not
demonstrate a physical sleeping phone or actual YouTube playback; those limits
remain open above and in the release record.

Post-deployment
[Operations Drift Audit 38157373545](https://github.com/hiefny/MUSIXQUARE/actions/runs/38157373545)
passed at the same source SHA: **31 pass, zero fail, five manual**. Its source
contract includes 64 bindings, and every actively serving Worker's non-secret
bindings matched its checked-in configuration, including the new PRO service
binding. This closes the pending post-release automated-audit item from the
previous deployment; the five manual controls remain open and were not queried.
