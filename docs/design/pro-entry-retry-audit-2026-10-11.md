# PRO entry failure retry audit — 2026-10-11

## Scope and result

Initial read-only investigation at `240e1306` on Windows, Node 24.20.0 and
Vitest 5.0.3. The owner asked whether needing Back and room-code re-entry after
a red entry error was intentional. It is not: a confirmed setup lifecycle
defect prevents some PRO retries from making a new admission request.
The owner subsequently authorized the local repair below, explicitly without
deployment. No push, merge or deployment was performed. The existing owner
hold on all production deployment remains in force.

At the investigation baseline, setup, setup-flow and session-controller paths were unchanged from
deployed `d76b1432`. The bridge clock repair on the local branch does not change
its admission role projection or failure cleanup.

## Cause

`ServerProRoomNetworkBridge.#replaceConnection` projects the compatibility role
`network.appRole = 'host'` before WebSocket OPEN. OPEN error or timeout restores
`isConnecting = false`, but leaves that role. The session controller clears the
PRO context; setup restores the code, inline error and enabled Retry button,
without restoring the setup guest role.

The manual-code Retry handler `handleSetupJoinWithRole` then returns at its
`appRole !== 'guest'` guard. No new admission request is sent. Going Back and
starting the guest flow restores `guest`, so entering the code again works.
Explicit transport cleanup sets `idle`, which also fails the same guard.

Invite-link retry without asynchronous media activation bypasses that direct
guard and can retry. With asynchronous activation, `finishGuestActivation`
requires a standard guest and returns false for both retained roles; the new
joining button can remain disabled. This is a second manifestation of the
same missing setup-state restoration, not a separate server restriction.

Earlier bootstrap/authentication/PIN/rate-limit errors that occur before the
bridge role projection do not prove this defect. Server rejection of an actual
retry while a rate-limit window remains active is a different condition.

## Reproduction and limits

| Check | Result |
| --- | --- |
| Actual bridge with the existing fake WebSocket, OPEN error and 15-second OPEN timeout | 2/2 diagnostic assertions pass: guest before connect, host during and after failure, `isConnecting = false`; explicit disconnect then produces idle. |
| Actual setup handlers and DOM buttons, admission mock projecting each observed failed role | 6/6 diagnostic assertions pass: manual Retry sends no new request, re-entering the guest flow repairs it; asynchronous invite retry remains joining; invite retry without activation sends a second request. |

These assertions reproduce the **broken baseline behavior**; they are not
passing regression tests for a repair. The two harnesses verify the real bridge
projection and real setup response separately, rather than a live end-to-end
connection. No customer room, real server or physical iPhone was used. Sixteen
copied unrelated setup cases were excluded by the diagnostic name filter;
there were no missing-tool skips in the selected eight cases. No full suite or
remote CI was rerun for that initial investigation.

Scratch sources and logs are preserved under
`scratch/pro-join-retry-2026-10-11/` (`network-bridge-role-probe` and
`setup-guest-retry-diagnostic`). Temporary test files were removed from `src`.

Existing setup recovery tests mock PRO entry as a plain rejection, without
the real role projection. Existing bridge failure tests assert socket cleanup
and busy state without continuing into setup Retry. That separation left the
combined lifecycle uncovered.

## Local repair

Product commit: `f5c7a5140c0c1392062ac911bafd0be532de7f5e`, App 8.9.3 / cache
v654, on `agent/pro-clock-calibration-budget`. The current PRO setup attempt
restores the guest setup role and clears connection busy state on failure or
cancel; its code and existing Retry UI remain intact. Attempt generation,
captured overlay cancellation and `setup.sessionStarted` fence every result.
Old failures, successes, cancellations and reload results cannot overwrite a
successor setup UI. A separate pending-attempt guard prevents repeated Enter
or start callbacks from duplicating admission before the bridge becomes busy.

The original setup role writer is shared through `restoreGuestSetupRole`.
The authority checker records its new function location; the allowed count is
unchanged (16 legacy writes across the application). Normal PRO disconnect,
reconfiguration, server authority, rate limits and admission policy are unchanged.
Terminal lazy-load failure still requires Refresh. This patch alone is App
scope; the earlier local clock and signaling fixes remain in the same branch,
so their combined release scope remains `all` under the current workflow.
No schema, binding, secret, protocol or recovery-floor changes.

Twenty-four new unit cases cover manual-code/invite/QR failure retry from both
retained roles, async activation, cancellation, duplicated entry, twelve late
result/lifecycle combinations, predecessor-versus-successor admission, and
editing the failed code to join an ordinary room. Of the first 23 new cases,
22 fail on the original implementation and one already passes (late success
after an already-started session). The final setup file has 40 passing cases.

The new browser fixture uses the real app, controller and bridge, with local
HTTP/WebSocket routes. It closes the first socket before OPEN, observes the
inline error and cleanup, clicks Retry on the same page and verifies successful
second admission as a member with no additional capabilities. No live customer
room or external API is used.

### Verification of the repair

- Focused final setup and authority-boundary suites: 51 passed, 0 failed/skipped.
- Related Chromium E2E: 21 passed, 0 failed/skipped (`pro-entry-retry`,
  `pro-entry-password`, `setup-youtube-activation`, `connection`). This run
  preceded the final shared-helper extraction and version bump; the extraction
  was independently reviewed and rechecked by the focused unit suites.
- The initial full unit run had 11,393 passes and one authority-checker failure
  from adding another direct role writer. Sharing the existing setup writer and
  updating only its reviewed location resolved that guard; no allowance count
  was increased. This initial result is superseded by final verification below.
- Independent final review: no actionable findings.

Final verification on `f5c7a5140c0c1392062ac911bafd0be532de7f5e`:

| Check | Result |
| --- | --- |
| Full local unit suite | **536 files, 11,395 passed / 0 failed / 0 skipped**, 169.68 s. jq 1.8.2 is available through the refreshed user PATH. This supersedes the initial full run; counts are not added. |
| Type checks | Main app, unit tests, E2E and Node-script TypeScript projects pass. |
| Lint and format | Scoped app/test ESLint, tooling ESLint for the authority guard and new E2E file, and changed TypeScript Prettier checks pass. |
| Production build | `npm run build:checked` passes on the committed product tree, including authority, cache-history, security, asset and transfer-budget guards. This is a local build, not a deployment or exact-main release candidate. |

Logs are under
`scratch/pro-join-retry-2026-10-11/`; the initial browser-fixture build/run logs
are in `scratch/pro-clock-fix-2026-10-11/retry-e2e*.log`.

The mobile invite case uses Chromium with an iPhone user agent and a fake
YouTube player. It validates application ordering, not physical Safari autoplay
permissions. No physical iPhone test, full-browser suite, remote CI, exact-main
candidate or production deployment was performed.
