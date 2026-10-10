# Extreme manual synchronization repair — 2026-09-27

| Field       | Value                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Status      | Verified repair on `mxqr_beta`; no production deployment                                                                  |
| Baseline    | `f0f534b2074b8b97426398962045acf599cf04ae`; product sources `c3eae88c`                                                    |
| Environment | Windows, Node 24.20.0, Vitest 5, Chromium, local PeerJS                                                                   |
| Related     | [Original discovery evidence](extreme-manual-sync-audit-2026-09-27.md), [release readiness](../beta-release-readiness-archive-2026-10-10.md) |

The original audit remains dated discovery evidence. Its 40 failing module
combinations represent four causes, not 40 independent defects. This repair
does not change main, publish production, reactivate Operations Drift Audit,
change manual offset limits or change room/UI policy.

## Corrections

- **XS01 — Standard YouTube:** ordinary host snapshots remain fresh while the
  participant's zero-start controller or external fallback owns the iframe.
  The heartbeat and incidental iframe state reports do not seek, unmute or
  release that scheduled start. An explicit new transport state cancels the
  local owner before applying the new command, even after the host has retired
  its barrier and can no longer send the old cohort an ABORT.
- **XS02 — local files:** a requested output position below zero becomes
  participant-local silence before native or bounded PCM playback begins.
  The shared deadline, logical room position and canonical track end do not
  inherit this extra delay. Mid-hold nudges therefore cannot add it twice.
- **XS03 — PRO YouTube:** an endpoint-local pause cancels the older release and
  consumes that exact canonical commit without treating it as media failure.
  This prevents the controller's failure catch-up from undoing the pause.
  Newer room actions and explicit local rejoin retain their authority.
- **XS04 — PRO YouTube:** the release callback measures lateness against its
  planned deadline and advances the cue accordingly. Intentional local delay
  and platform timing compensation remain separate from callback lateness.

## Verification

Tested source: `c242bfd17f652f1480a6e79731d5130b5b6f6c19`. The identical runtime
sources were tested in the worktree before committing; this follow-up changes
only documentation to record that identity.
The full unit invocation ran 495 files / 10,250 cases: 10,245 passed, four timed
out and one existing release-classification case was skipped (Windows lacks
`jq`). The timed-out assertions are the dead-export analysis, configuration
comment guard, localized build-input release classification and progressive
playlist focus/rerender. Their serial, isolated replay passed all four with
unchanged assertions/time limits after the other heavy checks finished.
Thus all **10,249 non-skipped cases passed across the full run and targeted
replay**, not in one entirely green full invocation. The replay's other 173
filtered cases are not new product skips. Later edits only resolved three test TypeScript errors;
runtime source remained unchanged. The affected 163 tests, then the final
29-case PRO fixture, were rerun successfully.
The new browser file-start regression was first run against the old E2E build:
the minimum-offset guest had already started its native source instead of
remaining scheduled, reproducing XS02 through actual UI and decoded PCM.

Browser regressions passed **14/14**: four real native PCM next-file cases and
ten YouTube UI cases (nine next-start combinations plus repeat-one with an open
manual-sync editor). Native cases check both the initial silent hold and output
position after 12 seconds; a later corrective seek cannot mask an early start.
YouTube includes guest/host minimum offsets, opposite ±9,999 ms limits, smaller
negative offsets, and positive controls. The local tests ran after the final
local transport change; the YouTube build additionally includes the final
explicit-command cancellation refinement. No runtime changes followed these
checks; later fixture edits only repaired TypeScript annotations/callback `this`.

Focused tracked regressions: 448 local-file tests (96 new), 287 Standard YouTube
tests (20 new), and 67 PRO arm/integration tests (15 new), all passed. These are
subsets of the final full unit suite, not additional totals to sum with it.
The new Standard tests include a real linked host/guest controller pair where
the host barrier expires before the delayed guest, plus late pause and new
seek/precision-sync supersession. PRO uses the actual registered Media Session
handler and playback controller to assert that local pause records the applied
revision without preparing or retrying the same playing frame.

The original PRO audit matrix is now 314/314 passed. The Standard matrix is
266/266 with three old bug-presence observations corrected from early PLAYING
to the intended PAUSED in a separate replay copy. The original local matrix's
34 desired-behavior failures all pass; 24 historical observations explicitly
expecting the broken immediate source start remain unchanged in that ignored
discovery file. The tracked 96 new tests assert the corrected output contract
instead. Original red audit artifacts are retained as evidence.

Module checks use controlled clocks/player/output boundaries. Browser local-file
checks use real Chromium decoding and native `AudioBufferSourceNode` scheduling;
the instrumentation observes `start`/`stop` without replacing playback. YouTube
browser checks use the deterministic iframe substitute and real app/PeerJS
paths. These checks do not measure acoustic output, Bluetooth latency or real
YouTube/iPhone/PRO-service behavior.

The E2E and production App builds passed, as did full `npm run typecheck`
(App, tests, Workers, browser assets, scripts/tooling and E2E), App/tooling ESLint,
changed TypeScript formatting, seven additional source/identity guards and
eight production artifact guards (legacy TV, service worker, UI kit, transfer
budget, absence of test hooks, production security, fonts and app shell).
`guard:sw-cache-version` deliberately remains a release prerequisite: it rejects
the accumulated beta runtime changes because the public cache epoch is still
v630. The guard was not bypassed or weakened; increment public version/cache
when preparing the authorized main release.

Ignored local evidence under `scratch/extreme-sync-audit-2026-09-27/`:
`repair-full-unit-results.json`, `repair-timeout-replay.json`,
`repair-final-fixtures.json`, `repair-final-pro-fixture.json`,
`repair-local-e2e.log`, `repair-youtube-e2e.log`,
`repair-typecheck-complete.log`, `repair-lint.log`,
`repair-final-build-e2e.log` and `repair-production-build.log`.

## Release impact

Only App client runtime and regression tests change. No wire message, Worker,
D1 schema, migration, binding, secret, dependency or UI copy change is required
by XS01–XS04. The accumulated beta still requires the release scope documented
in the living runbook. Version/cache remain `8.6.61` / `v630` until the authorized
main promotion and production release. Physical-device checks and final-main
CI remain separate release requirements.
