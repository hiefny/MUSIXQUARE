# PRO Signaling Query-Ticket Cutover

This runbook retires the cached-client `?ticket=` WebSocket credential without
putting a bearer, URL, room code, participant ID, IP address, or User-Agent in
logs or metrics. The supported protocol is the stable
`mxqr.pro-signaling.v1` marker plus the non-selected `mxqr.ticket.<bearer>`
subprotocol token.

The authentication grace ends at **2026-09-09 00:00:00 UTC**. Runtime rejects
the query credential at that instant. The production-security guard also blocks
the first source deployment at or after that instant until the now-dead query
admission branch is removed.

## Signals

Two fixed-name D1 counters are exposed in the admin metrics inventory:

| Event                                     | Meaning                                                                                                        | Suitable evidence                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pro_ticket_legacy_query_used`            | A cryptographically valid query ticket reached the edge before cutoff.                                         | Pre-cutover cached-client cohort and the seven-zero-day gate.                                                                  |
| `pro_ticket_legacy_query_update_required` | A structurally plausible legacy query request reached the edge after cutoff and received the refresh contract. | A privacy-safe compatibility-demand signal; it is not authentication truth and can be inflated by a deliberately shaped probe. |

The pre-cutoff event is emitted only after the valid ticket completes a 101
admission. The post-cutoff event is capped at 10 writes per IP-derived limiter
key per hour; that limiter key is not written to D1.

Both events store only UTC minute bucket, fixed event name, and aggregate count.
Do not add dimensions. In particular, never add the request URL, ticket, room,
participant, IP, colo, User-Agent, or a hash of any of those values.

Use the raw D1 buckets when evaluating the gate:

```powershell
npm run wrangler -- d1 execute musixquare-admin-metrics --remote --config cloudflare/wrangler.signaling.toml --json --command "SELECT date(bucket_minute * 60, 'unixepoch') AS utc_day, event, SUM(count) AS uses FROM mxqr_metric_buckets WHERE event IN ('pro_ticket_legacy_query_used', 'pro_ticket_legacy_query_update_required') AND bucket_minute >= unixepoch('now', '-14 days') / 60 GROUP BY utc_day, event ORDER BY utc_day, event;"
```

An absent row is zero. Save the command output with the release evidence; do not
copy request logs or browser network exports containing a ticket.

## Before 2026-09-09 UTC

1. Deploy App and signaling together through the normal release workflow. Do
   not use an ad hoc Worker deploy.
2. Confirm new browser WebSockets have no query and offer exactly
   `mxqr.pro-signaling.v1, mxqr.ticket.<redacted>` while the server selects only
   `mxqr.pro-signaling.v1`.
3. Confirm the admin dashboard includes both counters and that a controlled
   legacy test increments `pro_ticket_legacy_query_used` by one without adding
   any new D1 columns or custom-log fields.
4. Require seven consecutive complete UTC days with zero
   `pro_ticket_legacy_query_used` before treating the cached cohort as gone. A
   release that changes the App cache epoch restarts this observation window.
5. Keep signaling `invocation_logs = false` and automatic traces disabled.

## At the cutoff

An exact `?ticket=<nonempty value>` request receives HTTP 426 with this
credential-free contract and is never verified or routed. A bounded parse of
the public payload and signature shape filters malformed noise before the
aggregate D1 counter, but does not establish authenticity. Treat the counter
only as a cached-client recovery signal, never as a security or billing fact:

```json
{
  "error": "PRO_SIGNALING_CLIENT_UPDATE_REQUIRED",
  "action": "refresh",
  "requiredWebSocketProtocol": "mxqr.pro-signaling.v1"
}
```

The response also carries `X-MXQR-Client-Action: refresh` and `Cache-Control:
no-store`. Current clients map the equivalent authenticated WebSocket close or
error contract to the existing mandatory update dialog and session-safe reload.

The browser WebSocket API does not expose a failed-upgrade response body to the
old JavaScript that created it. A genuinely pre-cutover cached bundle can
therefore show its historical generic connection failure before the existing
service-worker update prompt appears. Its supported recovery is Refresh in that
prompt or a hard refresh. Do not weaken the cutoff or echo the ticket in a close
reason to work around this browser limitation.

Run the targeted checks before release approval:

```powershell
npm exec vitest run -- src/network/transport/__tests__/cloudflare-signaling-worker.test.ts src/pro-room/__tests__/network-bridge.test.ts src/ui/__tests__/setup-guest-recovery.test.ts src/core/__tests__/pro-signaling-ticket-cutover.test.ts
npm run guard:prod-security
npm run check:workers
```

## First post-cutoff source deployment

The runtime date already rejects admission, but dead authentication code must
not remain indefinitely. Remove all of the following in one reviewed change:

- `PRO_SIGNALING_LEGACY_QUERY_ACCEPT_UNTIL_MS`;
- the return shape with `transport: 'legacy-query'`;
- reading the query value for ticket verification; and
- tests that expect query-ticket admission before the historical cutoff.

Retain only the exact query-shape detector, HTTP refresh response, and
`pro_ticket_legacy_query_update_required` counter during the recovery-observation
window. The production-security guard intentionally fails after the cutoff
while the admission return shape remains, so an emergency deploy cannot carry
the dead verifier forward unnoticed.

Treat the structurally plausible update counter as advisory only: it parses an
untrusted payload shape but performs no signature or authenticity verification.
After seven consecutive complete UTC days with zero events, and after
corroborating that result with controlled release/support evidence, remove the
query detector, refresh-only edge branch, both temporary metric inventory
entries, and their source tests. A nonzero result may be probe noise and must
not veto removal by itself; operators may proceed when bounded support and
release evidence shows that maintained clients have crossed the cutoff.
Historical D1 rows may age out under the normal 90-day retention policy; no
deletion migration is needed.

## Invocation logs and traces

The checked-in signaling config keeps automatic invocation URL logs and traces
off throughout both observation windows. They must not be enabled merely
because the calendar cutoff passed: stale requests still contain a fresh bearer
in their URL even though authentication rejects it.

Only after the entire query detector is removed and the final zero-use evidence
is reviewed may an operator consider changing `cloudflare/wrangler.signaling.toml`.
The guard permits that change only when no ticket-query reader remains. Before
enabling either facility:

1. review what Cloudflare will capture for standard room query fields and room
   paths;
2. update the Privacy Policy and its executable policy tests if the public
   telemetry statement changes;
3. use the lowest sampling rate and retention needed;
4. inspect a controlled PRO join and verify no credential appears; and
5. deploy through the normal release workflow, then re-run the privacy smoke.

Leaving both facilities disabled is the safe default and requires no follow-up
configuration change.
