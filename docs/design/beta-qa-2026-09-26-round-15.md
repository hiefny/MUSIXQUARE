# Beta QA — 2026-09-26, round 15

Baseline: `mxqr_beta` at `259d36ed`. Scope: settings and authority changes
overlapping playback, demo, and asynchronous metadata work. This round preserves
the competition freeze, UI design, room-control policy, and app/cache versions.

## Confirmed findings

### 1. A late YouTube title response could replace demo now-playing metadata

Adding a YouTube chat link starts a background oEmbed request. Entering demo
before that request finishes keeps the selected queue ID but publishes synthetic
demo track metadata. The old title callback checked only the selected queue ID,
so it updated both the legitimate queue row and the unrelated current demo title
and artist.

The regression uses the real chat-link add handler, bounded HTTP body reader,
and demo entry. A streamed response body finishes after entry, during either
demo loading or ready playback. Both cases failed before the fix, while ordinary
YouTube ownership passed. Physical audio output and demo decoding are mocked;
the delayed boundary is the HTTP body, not an artificially suspended synchronous
application function. The demonstrated defect is metadata corruption, not an
audio restart.

The now-playing write now also requires YouTube playback mode. Queue metadata
and its broadcast still update. Paused YouTube still owns its metadata, and the
existing playlist sub-video exception remains intact. Demo exit deliberately
clears a previous YouTube playback snapshot rather than restoring old metadata;
later explicit playback reads the updated row.

Five regressions/controls pass: loading demo, ready demo, demo exit before the
response, active YouTube, and locally paused YouTube.

### 2. An effects slider could keep moving after administrator revocation

The shared range handler captured a pointer while a permitted drag was active.
Revocation disabled the range and restored canonical room settings, but native
pointer capture continued delivering movement. The drag handler then changed
the disabled thumb. The effects handler correctly rejected the unauthorized
edit, leaving the thumb inconsistent with the audio and label.

This was reproduced with actual Chromium mouse capture and two local RTC peers,
using the ordinary administrator grant/revoke UI: canonical reverb decay and
label remained 5 seconds while the disabled thumb moved to 9. No synthetic
events were dispatched to the disabled element. Unit regressions also reproduced
the shared path for reverb and EQ; there was no unauthorized room publication.

The shared range handler now retires a captured drag on movement while disabled
and does not synthesize a change commit on disabled release/cancel/capture loss.
It preserves the canonical value without adding effects-specific rollback logic.
Six unit cases cover reverb/EQ revocation, authorized commits, release without
another move, and successful interaction after regrant. The native browser
regression also checks that regrant restores normal editing.

## Other investigation

- Standard effects, reverb timer coalescing, volume, settings toasts, settings
  UI, and range controls: 160 focused tests passed, including the six new cases.
  Locked volume already repaints from canonical audio state.
- Manual sync, player controls, range direction, and audio channel initialization:
  221 focused tests passed. The historical audio-buffer accessor already returns
  both complete and bounded file resources; it does not exclude the hybrid engine.
- YouTube iframe callbacks, parked players, source changes, and demo restoration:
  256 existing focused tests passed, plus the five new metadata cases.
- PRO effects reconciliation, request serialization, authority generation, and
  room/session replacement: 113 selected tests passed across six files; 75
  unrelated cases were excluded by the focused selector. No additional defect
  was confirmed. Existing opt-out and full-publish policies remain unchanged.

## Verification

- Independent review confirmed both causes and the narrow production changes.
- The first full unit run passed 9,782 tests but failed the existing search
  scrollbar coalescing test (one existing test skipped). That test expected a
  real animation frame to have run after a 40 ms wall-clock sleep. Independent
  and root isolated runs both passed all 61 search tests; the exact scheduling
  cause of the first failure was not established. The test now owns its RAF
  queue, asserts one scheduled callback and zero early reveals, then delivers
  that frame and checks one reveal. It drains earlier/cleanup frames rather
  than abandoning the module's pending flag. No search product code changed.
  All 72 final focused tests passed after this test correction.
- Final full unit run: **477 files passed; 9,783 tests passed, 1 skipped**.
  The existing deployment-artifact classifier test skips locally without `jq`;
  its CI path does not permit that skip. All eleven new unit cases ran.
- Local Chromium: nine selected checks passed, covering the new native pointer
  regression, demo native playback/late join/download replacement, reverb
  projection, locked volume, and RTL range geometry. The first post-fix run
  passed eight checks and the revocation assertions, but its regrant control
  reused coordinates after the canonical reset collapsed the advanced section.
  Reopening that section and reading its current geometry fixed the test; the
  targeted rerun passed without further application changes.
- Full repository typecheck and app/tooling lint passed. Final E2E typecheck,
  changed TypeScript formatting, and `git diff --check` passed.
- Seven source guards passed: import graph, dead exports, bus pairing, lifecycle
  writes, source complexity, room authority, and chunk pump.
- Production build and eight artifact guards passed: production hooks/security,
  legacy TV, service worker, UI kit, initial transfer budget, fonts, and app shell.

## Limits

Browser checks use local Chromium, local signaling/RTC, and fixture audio. PRO
checks use controlled request/runtime fixtures, not live Cloudflare traffic.
No physical iPhone/Safari or acoustic timing measurement is claimed. The unit
pointer-capture model is supplemented by the real Chromium failure and recovery.

Work stays on `mxqr_beta`; app **8.6.61** and cache epoch **v630** stay unchanged.
No main advancement, production deployment, pull request, or Operations Drift
Audit re-enablement is part of this round.
