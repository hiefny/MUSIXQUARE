# Full local beta verification — 2026-10-03

| Field                                | Value                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Status                               | Local verification complete; security/cache promotion gates remain; competition freeze active                         |
| Tested checkout                      | `0912b8aec322084bffd594618a49140aa4566345`, `mxqr_beta`                                                               |
| Product and maintained test revision | `45c7ef7a4e0fef5b788efe11cb72d54c9b221929`                                                                            |
| Main reference                       | `35759e8b07f1ee0b272afbd0af03c770a858889e`                                                                            |
| Environment                          | Windows, Node 24.20.0, npm 12.0.2, Vitest 5.0.0, Playwright 1.63.0                                                    |
| Browser builds                       | Chromium 153.0.8010.12 / revision 1243; WebKit 26.6 / revision 2359                                                   |
| Related                              | [Living release record](../beta-release-readiness.md), [last discovery round](beta-sequence-qa-2026-10-03-round-7.md) |

The owner requested an end to exploratory QA and execution of every maintained
verification suite feasible on this local machine. This is a test execution
record, not a new discovery audit. Runtime, maintained tests, dependency pins,
coverage thresholds and browser retry settings are unchanged.

## Unit and coverage results

All four profiles completed on their first invocation with exit 0, with two
workers per profile. The full broad-coverage invocation executes the complete
unit selection; it was not replaced by a focused subset. Portable jq 1.8.2 was
selected through `MXQR_TEST_JQ_PATH`, so its Windows fixture was also executed.

| Profile                             | Files |   Pass | Fail / skip | Statements | Branches | Functions |  Lines |
| ----------------------------------- | ----: | -----: | ----------- | ---------: | -------: | --------: | -----: |
| Full unit + broad coverage          |   510 | 10,637 | 0 / 0       |     86.46% |   80.15% |    91.03% | 90.15% |
| Critical runtime coverage           |    55 |  1,864 | 0 / 0       |     81.61% |   76.13% |    87.64% | 85.77% |
| Release/operations tooling coverage |    13 |    342 | 0 / 0       |     78.27% |   73.87% |    87.09% | 80.14% |
| Worker coverage                     |    26 |  1,726 | 0 / 0       |     84.26% |   80.79% |    92.63% | 88.93% |

The focused profiles overlap the full unit suite; the unique unit count is
10,637, not the sum of the rows. Original aggregate and per-file thresholds
passed. All four configuration hashes were compared before and after execution
and remained identical. No timed-out or failed attempt needed a rerun.

## Static and security results

The static lane ran 23 independent commands: 22 passed, with only
`security:audit` failing. This includes the complete typecheck, both lint and
format stages, source guards, Worker syntax, Developer API boundaries, D1
migration history, and the source-only Operations Drift Audit contract.
The typecheck includes all six Worker generated binding checks and referenced
TypeScript projects. Package signatures passed: 482 signatures and 100
attestations verified.

The dependency audit still reports the previously recorded **nine affected
packages: five high and four moderate**. Root packages are development-only
`brace-expansion@5.0.9`, `fast-uri@3.1.7`, and `undici@7.29.0`. The separate
`npm audit --omit=dev --audit-level=high --json` passed with zero vulnerabilities.
No automatic dependency update was performed. The full CI security gate remains
unresolved even though the production-only dependency selection is clean.

The separate `guard:sw-cache-version` also failed as expected: beta contains App
changes after the last committed cache epoch, while the owner has frozen public
release identity at App 8.6.61 / cache v630. This is a remaining promotion step,
not a passed gate. Its failure did not suppress execution of the other build
guards and browser suites.

## Browser and build results

| Run                                             | Result                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| E2E build                                       | Pass                                                            |
| Complete default Chromium selection             | 79 files, 568 distinct tests; 568 pass, 0 fail, 0 skip, 0 flaky |
| Official iPhone WebKit selection                | 12 files, 69 tests; 66 pass, 0 fail, 3 existing skips, 0 flaky  |
| Production build                                | Pass                                                            |
| Production artifact guards                      | All eight pass                                                  |
| Production Worker bundles                       | All six local Wrangler dry-runs pass; no deployment             |
| Production-artifact Chromium smoke              | 9 pass, 0 fail, 0 skip, 0 flaky                                 |
| Production-artifact WebKit Service Worker smoke | 1 pass, 0 fail, 0 skip, 0 flaky                                 |

The complete Chromium selection ran as two isolated CLI shards with their own
preview and PeerJS ports, output directories and JSON reports. Each kept one
worker and zero retries. Both exited 0, with 296 and 272 passes; their combined
test IDs contain no duplicates. The longer shard took 28.4 minutes. WebKit also
exited 0 with zero retries. Its existing skips are desktop entrance timing,
mobile-hidden carousel arrows and desktop hover in a touch-only context. Those
three skips do not stand in for unsupported audio/RTC tests.

All preview/PeerJS listeners were cleaned up. The E2E `dist/index.html` and both
Playwright configurations retained identical before/after hashes throughout
these browser runs. No test needed a manual rerun or a relaxed assertion.

Only after the E2E/UI browser runs and servers exited was the shared `dist/`
rebuilt in production mode. The eight artifact guards cover legacy TV,
Service Worker, UI kit, initial transfer budget, absence of test hooks,
production security, fonts, and the Service Worker app shell. The six Worker
bundles use the existing compile-only dry-run script, which removes credential
environment inputs and does not deploy. The final Chromium and WebKit SW
checks reused that production build, both with exit 0 and no retries.

The expanded `build:checked` stages were executed independently: its source
checks, cache-history guard, production build and eight artifact guards all
ran. The aggregate release gate is **not green**, because the separately
recorded cache-history guard fails. Security audit is the other known remaining
gate. Neither failure was hidden by changing a threshold, cache epoch or
dependency pin. No functional test failed during this full verification.

## Limits and retained evidence

The maintained test inventory was compared with `package.json`, `ci.yml`,
`e2e.yml`, and the contributor verification ladder. Duplicate unit/browser
subsets need not be counted or rerun separately when their full selection runs.
Production live-room, real R2/SFU/provider, protected account and remote drift
checks are excluded from this local-only request. No deployment or remote
application mutation is part of these checks.

A fresh browser capability probe used an intercepted HTML page at a loopback
secure context. This Chromium provides Web Audio, OfflineAudioContext,
AudioDecoder, and RTCPeerConnection. This Windows WebKit provides neither Web
Audio nor WebRTC; it cannot validate actual iPhone audio output or network
handoff. Physical iOS/Android behavior, Bluetooth latency and real background
OS suspension remain outside local automation evidence.

Raw logs, JSON reports, coverage/lcov summaries, configuration hashes, command
exit codes, browser metadata and the capability probe are retained in ignored
`scratch/full-local-2026-10-03/`. Subdirectories separate `unit`, `static`,
`browser`, `build`, and `production`. The report and living release record are
the tracked evidence summary; generated artifacts are not committed.

Beta evidence is not a successful exact-main-SHA CI release candidate. The
competition freeze, main reference, production state and disabled Operations
Drift Audit remain unchanged.
