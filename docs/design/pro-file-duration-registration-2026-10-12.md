# PRO file duration registration and backfill — 2026-10-12

## Decision

The owner chose to obtain file lengths during registration and retain them for
autonomous PRO playback. Existing uploaded libraries must survive unchanged;
ordinary listeners must not gain playback or timing authority. Product 8.9.6 /
cache v657 builds on 8.9.5's server-owned natural-completion reducer.

## Implementation

- Browser metadata inspection overlaps the R2 PUT. It has a five-second total
  budget and at most a 250 ms post-PUT tail. Failure or unknown duration never
  fails the upload. The adapter uses bounded Blob slices and the existing pure
  structural reader; no AudioContext, PCM decoding, external URL or new dependency.
- Upload completion accepts optional `durationSeconds` only from a creator who
  also has `playback.control`. An upload-only participant cannot set the ending
  boundary. Missing metadata queues one bounded R2 inspection, including files
  completed through the Developer API. Registration lookups are serialized,
  persisted, and run outside the room mutation lane.
- Private asset evidence carries version, byte length, room generation, source,
  timestamp and duration. It survives the 64-entry queue cache's eviction and a
  new occurrence of the same asset. Decoded controller evidence wins over server
  evidence, which wins over upload headers. Header lengths retain two seconds
  of end grace; decoded lengths do not add grace.
- Existing rooms move matching verified queue evidence onto assets lazily.
  Unmeasured files are learned through active server inspection or successful
  authorized preparation. There is no deployment-time scan of every room,
  reupload, file deletion, playlist reset or quota reset.
- A separate authenticated `POST /media/:assetId/duration` closes the READY
  deadline gap for slow preparation, late joins, local reconciliation and
  cancelled-checkpoint recovery. It requires active presence and
  `playback.control`, and checks the exact asset identity. Browser reporting is
  fire-and-forget, bounded to six seconds and 128 cached/in-flight records;
  transient failure may retry on later preparation after a 30-second backoff.
  Stale, cancelled, failed, replaced-source and ordinary-listener preparations
  do not report.
- Optional evidence and pending probe entries preserve 8 KiB of room-state
  headroom. A nearly-full legacy room remains loadable even when optional
  backfill cannot be retained. Metadata never becomes a public asset field.

## Limits and compatibility

The bounded reader supports the same unambiguous MP3, FLAC, PCM/RF64 WAV,
M4A/MP4 and AAC ADTS metadata as 8.9.5. Ogg and other unsupported/ambiguous
containers remain unknown until an authorized playback preparation supplies
the actual duration. A raw Ogg final-granule shortcut was rejected: nonzero
initial PCM offsets can make the final position differ from stream length
([Opus RFC 7845 §4.5](https://www.rfc-editor.org/rfc/rfc7845.html#section-4.5)).
Inspection budgets also mean some unindexed large files remain unknown.

This does not guarantee controller-free progression through every previously
unmeasured file. If both server inspection and authorized preparation are
unavailable, the server still does not guess an ending boundary. Empty-room
freeze, ordinary-listener permissions, YouTube timing policy and Standard rooms
are unchanged.

Deploy App and PRO together (`all`); no secret, binding, D1 schema or recovery
floor changes. Old clients continue bodyless completion. A new client retries
completion once without metadata only after explicit 400 `INVALID_REQUEST`;
ambiguous failures do not trigger that fallback. The optional late report
cannot fail playback, and old-server 404 `NOT_FOUND` disables it until lifecycle
reset. Rolling PRO back to 8.9.5 leaves its existing queue-cache/metadata/READY
behavior in place; newly persisted private asset fields are not used there.

## Verification

Implementation and verification are in progress on the temporary
`agent/pro-file-duration-registration` branch based on
`a873629715cbe1b9889b5a31d338455c0344765c`.
Environment: Windows, pinned Node 24.20.0 / npm 12.0.2, jq 1.8.2.
Final tested source SHA and pass/fail/skip counts will be recorded before merge.
Local/branch tests are not a successful exact-main-SHA production candidate.
Physical iPhone/Android playback and actual customer rooms remain manual checks.
