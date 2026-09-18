# YouTube zero-start timing observations

Reviewed on 2026-09-19 after a report that a guest sometimes starts ahead of the
host, while ordinary rendezvous sounds more accurate. The reporting device's
OS and room type were not established. Deterministic reproductions below identify
code defects; they do not establish which path ran on that physical device.

## Confirmed failure mechanisms

- Standard-room late fallback clamped elapsed canonical time before adding the
  replacement release delay. When a locally armed guest's readiness report missed
  the host's decision, it could receive an exclusion COMMIT before the host's
  start. With 700 ms remaining, the guest later released at position 0.8 seconds
  while the host was at 0.1 seconds: a 700 ms timeline lead. Projecting the
  canonical position at the replacement deadline before clamping fixes this case
  and preserves the already-late case.
- Standard calibration allowed the first TIMELINE received after two seconds to
  fill both the early and late observations. A single transient observation of
  400 ms lag taught a 400 ms lead for the next healthy start.
- PRO calibration named its two callbacks after the planned 0.8/2.0-second
  checkpoints without verifying their actual observation spacing. Collapsed
  callbacks could teach a correction from one moment; the reproduction advanced
  the next release by 25 ms.
- PRO canonical-time reading could replace a raw non-finite player time with
  zero. In the reproduction, that invalid early sample and a later 800 ms lag
  appeared stable and advanced the next release by the per-round 50 ms cap.

## Correction boundary

Late fallback projects the original canonical start at the replacement release
deadline, then applies the existing participant-local offset conversion. The
Standard PREPARE/ARMED/COMMIT protocol and PRO server authority remain unchanged.

Calibration requires valid, normally playing observations at least one second
apart. Standard checks both host sample timestamps and local observation times;
PRO supplies the actual elapsed monotonic time to its pure learner. Fractional
browser timer rounding is permitted without weakening that separation. A nominal
checkpoint label does not prove that two measurements were made at different
times. Invalid raw player time must be rejected before a
display-oriented canonical-time helper can normalize it. A rejected calibration
round leaves the previous lead intact and does not interrupt current playback.

Platform seeds, learning gains, personal offsets, warm-up, audio restoration and
the zero-start release barrier are retained. This change does not introduce
room-wide corrective pause/seek operations after every start.

## Diagnostics and verification boundary

Optional debug logs retain the already-computed play-command and PLAYING-event
timestamps, applied release lead and fallback status for Standard starts. PRO
logs retain its local canonical deadline and authority-arm release result.
These are local timing observations, not directly comparable raw clock values
across devices. Enable the existing debug level (`setLogLevel('debug')` or
`?mxqrLog=debug`) before collecting a new reproduction.

Regression tests exercise the actual controllers and PRO runtime with a
deterministic YouTube facade, including healthy starts as positive controls.
They measure scheduled calls and media-timeline progression. They do not measure
speaker onset, OS audio output latency, Bluetooth latency or physical iPhone PWA
buffering. Further platform tuning requires device evidence rather than changing
fixed OS compensation based on these simulations.
