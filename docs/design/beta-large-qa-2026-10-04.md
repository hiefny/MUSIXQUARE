# Beta large QA — 2026-10-04

| Field           | Value                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status          | Complete local QA — two test-oracle defects repaired; existing promotion gates remain                                                                                                              |
| Tested checkout | Baseline `mxqr_beta`, `a4802820eef62c8650109cc91a0683ca28ea4d9b`, plus the two test-only corrections identified by SHA256 below                                                                    |
| Product code    | `45c7ef7a4e0fef5b788efe11cb72d54c9b221929`, unchanged during this QA                                                                                                                               |
| Main reference  | `35759e8b07f1ee0b272afbd0af03c770a858889e`                                                                                                                                                         |
| Environment     | Windows; pinned Node 24.20.0/npm 12.0.2; Vitest 5; Playwright 1.63 Chromium/WebKit; local PeerJS; jq 1.8.2                                                                                         |
| Related records | [Living beta release record](../beta-release-readiness.md), [previous full verification](beta-full-local-verification-2026-10-03.md), [latest sequence QA](beta-sequence-qa-2026-10-03-round-7.md) |

## Result and remaining work

The initial full unit and Chromium runs each produced one failure. The unit
failure is confirmed as QA-T04, a collection-clock fixture error, and its
fixture-only correction passed the final full 10,637-case unit/coverage run. The Chromium seed
470001 failure exposed QA-T05: a source-start offset was being compared as an
ongoing timeline. Native PCM observation confirmed the false oracle, and the
test-only correction passed all 25 maintained Luna cases. Replacing those same
cases in the original four shards gives **568 unique verified Chromium passes**,
with no skipped cases or automatic retries. Initial failures remain preserved.

Critical, tooling and Worker coverage lanes passed their original gates;
Windows WebKit passed with three existing desktop-only exclusions. All 41 new
focused media/PRO cases passed and were independently replayed. Previously
recorded dependency-security and cache-history gates remain failed.

The explicit production build, eight artifact guards, six Worker dry-run
bundles and ten production-artifact browser smoke cases passed. The guarded
`build:checked` command failed at the existing cache-history gate; the explicit
build does not turn that promotion gate into a pass.

Raw evidence is under ignored `scratch/large-qa-2026-10-04/`; paths below are
relative to that directory. This record does not authorize main advancement,
production deployment or Operations Drift Audit reactivation.

## Maintained suites and verification results

The broad configuration selects all 510 maintained `src/**/__tests__/**/*.test.ts`
files; the excluded extra file is an analyzer fixture. The default Chromium
configuration selects 79 local E2E files. Its exclusions are the separately
run WebKit smoke, production candidate smoke and production-live directory.
The latter creates real deployed rooms and R2 uploads and is outside local QA.

| Lane                             | Recorded result                                                                                       | Evidence                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Full unit/broad                  | 510 files; 10,636 pass / 1 fail / skip·todo 0; exit 1                                                 | `unit/broad.json`, `.log`, `unit/results.json`                       |
| Critical coverage                | 55 files; 1,864 pass / fail·skip·todo 0; exit 0                                                       | `unit/critical.json`, `.log`, `unit/coverage-critical/`              |
| Tooling coverage                 | 13 files; 342 pass / fail·skip·todo 0; exit 0                                                         | `unit/tooling.json`, `.log`, `unit/coverage-tooling/`                |
| Worker coverage                  | 26 files; 1,726 pass / fail·skip·todo 0; exit 0                                                       | `unit/workers.json`, `.log`, `unit/coverage-workers/`                |
| Chromium                         | 79 files; 568 unique cases = 567 pass / 1 fail / skip·flaky 0; retry 0                                | `browser/chromium-shard-{1,2,3,4}-4.json`, `.log`, `*-run.json`      |
| Windows WebKit                   | 12 files; 66 pass / 3 existing skip / fail·flaky 0; retry 0                                           | `browser/webkit.json`, `.log`, `webkit-run.json`                     |
| Final full broad                 | 510 files; 10,637 pass / fail·skip·todo 0; exit 0, after QA-T04                                       | `unit-final/broad.json`, `.log`, `results.json`, `coverage-broad/`   |
| Corrected Luna file              | 25 pass / fail·skip·flaky 0; retry 0; same cases replace original Luna results                        | `media/luna-tracked-patched.json`, `.log`                            |
| Final Chromium reconciliation    | 79 files; 568 unique verified pass / fail·skip·flaky 0; automatic retry 0                             | `summary.json`; original 543 unaffected cases plus corrected Luna 25 |
| Production build/artifact        | Explicit build and eight artifact guards pass; `build:checked` exit 1 at the known cache-history gate | `production/results.json`, individual `.log` files                   |
| Worker bundles                   | Six production configs dry-run pass; command exit 0                                                   | `static/check-worker-bundles-result.json`, `.log`                    |
| Production Chromium smoke        | 9 pass / fail·skip·flaky 0; retry 0; exit 0                                                           | `browser/candidate.json`, `.log`, `candidate-run.json`               |
| Production WebKit Service Worker | 1 pass / fail·skip·flaky 0; retry 0; exit 0                                                           | `browser/webkit-sw.json`, `.log`, `webkit-sw-run.json`               |

Chromium ran in four isolated shards, each with one worker and zero retries.
Shard selections were 144/152/134/138 cases. WebKit exclusions are desktop
entrance timing, a carousel arrow hidden on mobile and desktop hover behavior;
they are not three unexplained skips. Windows WebKit is not physical iPhone
Safari/PWA or WebRTC/audio evidence.

The passing coverage percentages are statements/branches/functions/lines:

| Profile      | Statements | Branches | Functions |  Lines |
| ------------ | ---------: | -------: | --------: | -----: |
| Broad, final |     86.46% |   80.15% |    91.03% | 90.15% |
| Critical     |     81.61% |   76.13% |    87.64% | 85.77% |
| Tooling      |     78.27% |   73.87% |    87.09% | 80.14% |
| Worker       |     84.26% |   80.79% |    92.63% | 88.93% |

These profiles overlap the broad suite and are not additional unique unit
counts. A Vitest JSON `success` flag covers tests, not every coverage or process
failure; the recorded command exit and unchanged configuration hashes are also
checked. The final broad config and corrected chat fixture hashes stayed equal
before/after execution. Chromium IDs across the initial shards are unique;
corrected Luna replacements match all 25 original file/title/project keys.
Summary completion requires all four unit and seven browser JSON results;
missing files must remain visible rather than being treated as passes.
Final summary has zero missing results, zero duplicate Chromium IDs, no browser
runner errors, unchanged per-run build/config hashes and complete replacements.

Production smoke used ordinary builds without mutable test hooks, including
actual Service Worker-controlled fallback navigation. The eight artifact guards
cover legacy TV, service worker, UI kit, initial transfer budget, production
hooks/security, fonts and application shell. Worker checks used Wrangler
4.130.0 `deploy --dry-run` with credential/environment auto-loading, update
checks and telemetry disabled; all six completed without deployment. Production
`dist/index.html` and `_headers` stayed unchanged during Worker validation.

## Initial failures and QA-T04 repair

**QA-T04 — test fixture clock ordering.** The existing owner variant of
`retains a failed owner message without consuming slowmode or retry dedup`
received `chat.cmd_slowmode_wait` before reaching its intended transport-denial
branch. Its nested describe captured `Date.now()` during collection and moved
that clock forward only ten seconds. Earlier real sends could occur later than
that mocked timestamp, so production slowmode correctly rejected it.

The correction in [chat.test.ts](../../src/ui/__tests__/chat.test.ts) changes
one fixture statement, plus its comment, to
`clock = Math.max(clock, Date.now()) + 10_000`. Runtime, assertions, timeouts,
slowmode boundary checks and test count are unchanged. Corrected file SHA256:
`415F7CF8A202AFA342362D17B6BDE58AEE94FC27E2726E37AB5547C7A0560537`.
Unchanged standalone validation passed 129 cases. A deterministic 30-second
collection-clock drift failed 3/129 original cases, then passed all 129 with
the correction. The actual corrected maintained file passed 129/129, types,
lint and formatting. Root independently confirmed the drift contrast.
Details and preserved failures: `media/CHAT_QA_T04.md`, `chat-clock-30s-full.json`,
`chat-clock-30s-patched.json`, `chat-tracked-patched.json`, `root-clock-contrast.json`.
These diagnostic replays are not added to the full-suite total.

**QA-T05 — source-start offsets compared as ongoing positions.**
`luna-session-sequences.test.ts`, seed 470001, reconnect then seek/pause-toggle,
timed out waiting for the guest to follow the host seek within its existing
2.5-second tolerance. The retained state has host `pausedAt=35`, guest
`pausedAt=38.732666666666674`, matching queue identity and connected transport.
The unchanged isolated seed passed once and then three repeated executions.
These replays alone do not resolve the original observation. A controlled
browser proof observed native AudioBufferSourceNode start/stop without replacing
output, waited four seconds after seek and invoked the real local-output rejoin
boundary. The old oracle failed with the same true/false shape while native PCM
positions were 48.828/48.8311667 seconds, approximately 3.2 ms apart, and both
displayed timelines were 48.8 seconds. Even before the explicit rejoin, an
ordinary guest resync had changed its anchor to 38.3503 while native positions
agreed within approximately 3.7 ms.

The same controlled trace passed when comparing current timelines. The
maintained [Luna browser file](../../e2e/luna-session-sequences.test.ts) now samples
the two displayed current positions concurrently, retains the host's seek-anchor
verification, the ten-second timeout and the 2.5-second tolerance, and records
current timeline position in failure snapshots. Its complete 25-case recheck
passed with one worker, zero retries and no skips (4.4 minutes). Corrected file
SHA256: `33D212F2A87727A3966BA0D2A7D769B2DCD7553F14F71B4B4269A8403934FBE9`.
No runtime or production hook changed. The original full-run
artifact did not capture native PCM, so the controlled proof must not be
presented as a retrospective physical measurement of that original failure.

Evidence: shard 3 JSON/log and its `luna-seed-470001-failure.json` artifact;
`media/luna-isolated{,-repeat3}.json`, `luna-anchor-old.json` (preserved diagnostic
failure), `luna-anchor-current.json` (passing contrast), and native samples in
their artifacts. Diagnostic repetitions are not extra unique full-suite passes.

## New focused sequences and independent controls

| Scope          | Final selected result                       | Behavior checked                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Media/transfer | 2 files; 11 pass / fail·skip 0              | Early bulk END/sparse chunks around ordered START/PLAY; surviving successor preload after current removal; replacement DataConnection with lower SID and old tails; retired native suspend across queue/demo successor output and deliberate pause |
| PRO/account    | 3 files; 30 pass / fail 0; no selected skip | Held queue-mode GET with successive queue revisions and new gestures; PUT 409 plus replacement and GET 403/503; actual Worker detach/account-lease expiry/reattach or takeover during pending playback readiness                                   |

Evidence: `media/final-corrected.json`, `media/REPORT.md`, `pro/composite-all.json`,
`pro/RESULTS.md`. Root replays `media/root-independent.json` and
`pro/root-independent.json` agree and are not counted twice. PRO copies retain
343 baseline cases excluded by the name filter; those were not executed by the
new probe. Exact bytes, current CAS/playlist revision, shuffle permutation,
session/incarnation ownership and stale-result rejection are the assertions.

Initial media ordered-channel/result-shape oracles and PRO account-ID/takeover
route/readiness oracles were corrected against executable contracts. Their
original JSON remains separate in the scratch reports and is not counted as
confirmed product failure or hidden in the passing totals. Native decode/audio,
HTTP and provider boundaries remain explicitly controlled where applicable.

## Static verification and existing failed gates

Static verification plus the Worker bundle command completed 27 commands:
**25 pass / 2 known fail / skip 0**.
This includes types, lint, formatting, source/authority/contract guards and
package signatures. `npm audit signatures` verified 482 signatures and 100
attestations. The two failed commands remain visible:

- Dependency audit: 9 affected packages, high 5/moderate 4; production-only
  audit 0. The 14 direct advisories match earlier evidence and all 10 compared
  vulnerable main/beta lock entries are equal. This is not a newly introduced
  beta warning, and it remains a release gate.
- Cache-history guard: frozen `8.6.61`/`v630` still lacks the public cache
  increment required by cumulative runtime changes. `build:checked` must not
  be recorded as successful while this gate fails.

Evidence: `static/assessment.json`, `static/all-results.json`, `static/npm-audit.json`,
`static/npm-audit-production.json`, `static/npm-audit-signatures.log` and
`static/advisory-history-comparison.json`. No dependency was changed.

## Replay, limitations and release boundary

From the repository root, prepend the pinned portable Node directory
`scratch/beta-upgrade-2026-09-09/node-v24.20.0-win-x64` to PATH, set
`PLAYWRIGHT_BROWSERS_PATH` to its sibling `playwright-browsers`, and set
`MXQR_TEST_JQ_PATH` to `scratch/full-beta-repair-2026-09-27/tools/jq-windows-amd64.exe`.
The saved wrappers record exact commands, ports, exits and hashes:

```text
powershell -File scratch/large-qa-2026-10-04/run-unit.ps1
powershell -File scratch/large-qa-2026-10-04/run-final-broad.ps1
powershell -File scratch/large-qa-2026-10-04/run-browser.ps1 -Shard 1/4 -AppPort 4483 -PeerPort 9283
powershell -File scratch/large-qa-2026-10-04/run-production.ps1
npm run check:worker-bundles
powershell -File scratch/large-qa-2026-10-04/run-browser.ps1 -Kind candidate -AppPort 4491 -PeerPort 9291
powershell -File scratch/large-qa-2026-10-04/run-browser.ps1 -Kind webkit-sw -AppPort 4492 -PeerPort 9292
node node_modules/vitest/vitest.mjs run --config scratch/large-qa-2026-10-04/media/vitest.config.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config scratch/large-qa-2026-10-04/pro/vitest.config.ts --maxWorkers=1 -t LQA
```

The four browser shards use distinct local origins/PeerJS ports; builds must
not change shared `dist` while a lane is running. The corrected Luna file used
4490/9290 after the full shards, with the unchanged E2E build. Production checks
used a separately rebuilt production `dist` on 4491/9291 and 4492/9292. Own
local test servers were cleaned up; the checkout retains the production build.
No live room, real provider mutation, physical output alignment, long-session
hardware memory behavior or final Linux/main-SHA CI candidate is certified.

Only QA-T04/QA-T05's maintained tests and evidence documentation are changed.
Product source, dependencies, schema, secrets, bindings, contracts, version
and cache are unchanged. Cumulative `target=all` / Developer API D1 false and
competition freeze remain. Main, production and the disabled Operations Drift
Audit remain untouched. Known security/cache gates, final exact-main evidence
and physical-device checks stay in the living release record.
