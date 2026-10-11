# PRO natural-completion duration hardening (8.10.1) — 2026-10-12

Status: implemented and verified locally on branch
`agent/pro-duration-hardening`, merged with main App `8.10.0` (`eb51ed73`), as
App `8.10.1` / PWA cache `v660`. Not merged or deployed. Production is App
`8.10.0` / `v659` at `95e9092c` ([release record](../release-record.md)).
Release target `all`: the PRO room Worker, the App Worker and the browser
bundle all change.

## Why

8.9.5 ([#298](https://github.com/hiefny/MUSIXQUARE/pull/298)) and 8.9.6
([#300](https://github.com/hiefny/MUSIXQUARE/pull/300)) let the PRO room
Worker end a track from server-verified media timing, so playback advances
while controllers sleep or have left. The [8.9.4–8.9.6
review](release-8-10-0-merge-review-2026-10-12.md) found P3/P4 defects in that
path. The owner decided (2026-10-12) to ship 8.10.0 first and these fixes next.
The owner also decided that a deleted or private YouTube video is skipped only
after two "not found" answers spaced apart in time.

Owner rule for this work: an unknown duration is always preferred over a
possibly-too-short one. A short duration ends a track early, which is the worst
outcome. A stall at the end of a track while no controller is awake is
acceptable for files the reader cannot measure.

## Changes

### Media readers (`cloudflare/pro-room-media-duration.ts`, `pro-room-mp4-duration.ts`)

The browser upload probe bundles these readers into the App.

- **MP3 frame counts.**
  - **When a Xing/Info/VBRI count is trusted.** That many frames at the largest
    Layer III frame size must be able to fill the audio span. A declared stream
    size must also match within FFmpeg's 1/16 tolerance, taken from the audio
    span, including for encoders that count the leading ID3v2 tag.
  - **Otherwise.** The bounded frame scan measures the whole file or returns
    unknown.
  - **Joined files.** A joined file, such as `cat a.mp3 b.mp3` or an appended
    part after a large tag, no longer reads as its first part.
- **CBR `Info` counts.** These are trusted only when the counted frames span
  the audio within one frame.
  - **Frame length.** The span uses the exact average length of the first audio
    frame after the Info frame. FFmpeg writes the Info frame itself at a higher
    bitrate for low-bitrate streams.
  - **When it applies.** With or without a stream size, and behind any leading
    tag.
  - **Effect.** A joined file with a lower-bitrate or same-bitrate tail is
    scanned to its real length.
- **VBR `Xing`/VBRI counts.** With a small leading tag, these keep the 1/16 rule
  above. They are scanned instead in two cases:
  - behind a tag larger than that tolerance, where the two byte-count
    conventions disagree;
  - without a stream size.
- **Trailing tags.** The audio span ends at recognized trailers, found from
  their footers with one bounded 8 KB tail read:
  - ID3v1;
  - up to three APEv2, Lyrics3v2 or ID3v2.4 (`3DI`) tags.

  A trailer is removed only when its size leads back to a matching header.
  Anything malformed stays in the span, which keeps the result conservative.
  This keeps tagged 320 kbps / 44.1 kHz CBR files measurable.
- **Fragmented MP4.** An MP4 with `mvex` in `moov` or any top-level `moof` is
  unknown. Before, it reported only the duration of the `moov` portion.
- **Failed reads.**
  - `readProRoomFileDuration` now rejects on:
    - R2 errors;
    - missing or resized objects;
    - short ranges;
    - read failures a parser caught;
    - the 10 s deadline and cancellation.
  - `null` now means only that the bytes carry no trustworthy duration.
  - The App's upload probe still turns any rejection into an unknown upload
    length.

### Stored durations (`cloudflare/pro-room-worker.ts`)

- **Reader version.** Server file evidence, its `measuredSeconds` floor and
  queue-cache entries carry `reader: 2` (`PRO_ROOM_FILE_DURATION_READER`).
  - Server evidence from older readers counts as absent. So does all `upload`
    evidence. These are the values 8.9.5–8.10.0 stored for joined MP3s and
    fragmented MP4s.
  - Loading a room drops old file cache entries.
  - The playing file is re-read on its first play by the existing bounded
    playback probe. There is no deploy-time sweep.
- **Upload lengths.** `handleCompleteMedia` still accepts and fingerprints a
  client `durationSeconds`, so old and new clients keep their idempotency, but
  no longer stores it. Tabs still on 8.10.0 run the old reader. The server read
  queued at completion measures the file with the current reader.
- **Controller floor.**
  - **Short reports.** A controller length below 0.9× a current server
    measurement of the same asset version is acknowledged and ignored: `{ok:true}`
    for `/duration`, and the cache is unchanged for READY.
  - **Late measurements.** A server measurement that arrives after a controller
    value becomes its floor, or replaces the value if it is below 0.9×.
  - **Unmeasured values.** These queue one bounded asset read:
    - a controller report with no measurement yet;
    - an unmeasured 8.10.0 controller value on the playing or target file.

    There is no deploy-time sweep.
  - **Retries.** A read that gets no answer is retried after 5 s, after 30 s,
    then every 5 minutes. The alarm wakes an idle room for these retries. A
    definitive unknown is not read again.
- **Alarm and probe loops.**
  - A natural advance refused by the room-state capacity guard backs off 30 s
    in instance memory, instead of re-arming at now+1.
  - A file probe whose asset fails the identity check records its retry
    backoff again. This regressed in 8.9.6.
  - A failed playback read retries after 5 s and 30 s, then every 5 minutes.
  - **Refused lookup write.** A second, probe-only write records the backoff.
    - It keeps a stored first not-found only when this answer was itself "not
      found" or unanswered.
    - The same backoff is also held in memory, tied to the exact stored probe
      it shadows, and cleared when that probe is replaced.

### YouTube metadata (`cloudflare/pro-youtube-duration.ts`, `pro-room-worker.ts`)

- **Backoff.** Live and unavailable answers back off 60 → 120 → 240 → 480 →
  900 s. Before, they repeated every 60 s, about 1,440 quota units per room per
  day. A failed lookup is not an answer about the video, so it retries after
  5 s and 30 s, then joins the backoff.
- **Not found.**
  - **Signal.** The App adds `reason: 'not-found'` to `unavailable` only for an
    empty Data API `items` list. An explicit private status stays plain
    `unavailable`.
  - **Skip rule.** The first not-found is stored on the probe (`notFoundAtMs`).
    A second one from a separate lookup at least 60 s later takes the existing
    unplayable path.
  - **What doesn't count.** Failed lookups neither count nor clear it. Live,
    finite or plain `unavailable` answers withdraw it. Live streams never skip.
  - **Older App.** An older App never sends the reason, so it degrades to
    today's no-skip behaviour.

### App and release tooling

- `src/pro-room/playback-controller.ts`: a synchronous throw from the duration
  report no longer turns a successful preparation into a failure.
- `scripts/release-deployment-state.mts`:
  - The App runtime path list now includes the two browser-bundled reader
    modules.
  - A test pins every `cloudflare/` module reachable from browser sources.
  - Before, a reader-only change was not detected as an App change.
- `src/ui/__tests__/playlist-view.test.ts`: the upload spinner phase may be
  `0ms`, because `-(now % period)` renders that way when the remainder is zero.
  This failed exact-main CI 38164204638 attempt 1 once.

## Compatibility

- **Old PRO Worker (8.10.0) reading new state.** It has no strict key validation
  for these records.
  - It keeps `reader` and `measuredSeconds` on assets until it rewrites them.
  - It drops them from cache entries.
  - After a rollback and roll-forward, durations it wrote in between are
    re-measured.
- **Old App tabs against the new Worker.** The upload length is accepted and
  ignored. Duration reports work unchanged.
- **New App against an old PRO Worker.** The App-side changes are the readers
  and a guarded report call, with no new fields.
- **Old App Worker against the new PRO Worker.** No not-found reason is sent,
  so nothing is skipped, as today.
- No secret, binding, D1 schema or recovery-floor change.

## Known limits

- **Unmeasurable files stay unknown.**
  - **Which files.** Fragmented MP4, Ogg, and files the scan would have to
    measure beyond the 16 MiB inspection budget. Examples of the last kind:
    long VBR files whose cover art exceeds 1/16 of the audio, and VBR headers
    without a stream size.
  - **Effect.** When no controller is awake they stall at the track end until
    a controller prepares them.
  - **Retries.** While they play, the file probe retries every 5 minutes. This
    predates 8.10.1.
- **Small appended parts.** A part appended to a VBR `Xing`/VBRI file within
  FFmpeg's 1/16 tolerance of the audio is still not detected, the same as in
  FFmpeg. CBR `Info` files are checked to within one frame.
- **Footerless trailing tags.** An ID3v2.3 tag appended without a footer leaves
  the file unknown.
- **Rollback.** A rollback to 8.10.0 drops a read queued for an unmeasured
  controller value when the room loads.
- **Unused upload length.** The App still computes and sends an upload length
  that the Worker ignores. Removing it is an optional later App change.

## Review

Each round used independent read-only reviewers per dimension and two skeptics
per finding. Every upheld finding is addressed above.

- **Round 1** (`eb3d1496..8f43d208`, four dimensions): 7 upheld, 2 P3 and 5 P4.
  The signing and validation of the App metadata endpoint had no findings.
- **Round 2** (`1f95500e..f7cc40f8`, three dimensions): 5 upheld, 1 P3 and 4 P4.
  The P3 was a stale count behind a large leading tag with an appended part of
  about the tag's size. None was a regression from production 8.10.0.
- **Frames-only rule** (`024950a0`): closes a pre-existing gap that the round-2
  fixer reported.
- **Round 3** (`f7cc40f8..024950a0`, three dimensions): 4 upheld, 1 P3 and
  3 P4.
  - **P3:** a lower-bitrate tail under 1/16 kept a CBR `Info` count, making
    the duration 20–66% short.
  - **P4s:**
    - FFmpeg's raised Info-frame bitrate;
    - a read memo that ran only once per instance;
    - a refused command clearing the in-memory backoff.
  - **Fixes:** `ad920fa5`, `99b5e34a` and `ec9f4856`. They were checked
    against real FFmpeg 8.0.1 output at 8–320 kbps and 8–48 kHz.
- **Ship gate** (`024950a0..6da737c8`, P1–P3 only): pending.

## Verification

To be completed with the final SHA.
