# Account cookie response ownership — 2026-09-27

This follow-up resolves the delayed account-cookie response finding left open
by [beta QA21](beta-qa-2026-09-27-round-21.md). It is a beta-only server change;
the competition freeze still applies.

## Failure and fix

All logins previously shared `__Host-mxqr_account`. A logout, invalid-session
read or account-deletion response created for session A could arrive after a
new login B and clear or replace B's browser cookie. Server revocation itself
worked: B's database session remained valid while its browser became anonymous.

New OAuth logins now receive distinct host-only, Secure, HttpOnly, SameSite=Lax
cookie names. A name binds the opaque token's session hash and creation time
with the existing session pepper and a separate HMAC purpose. Cleanup and
deletion-proof responses target only the cookie names that their request saw.
Cookie names contain neither the raw session token nor an account identifier;
the token remains HttpOnly and the signing secret remains server-side.

When several account cookies arrive together, the resolver verifies names
before ordering them. A revoked newest session is still an authenticated
ordering fence: older presented sessions are retired before that fence can be
cleared, so they cannot silently restore an earlier account. A database failure
during retirement fails closed and retains the fence. Equal-time independent
logins have a deterministic hash tie-break; a login replacing an observed
predecessor is strictly newer even if worker time moved backwards.

The monotonic timestamp belongs to session issuance only. Account row updates
and deletion-tombstone expiry sweeps use wall time, preventing a future session
timestamp from breaking immediate profile edits or expiring unrelated proof.
New session insertion and exact predecessor retirement share the existing D1
transaction. Retirement precedes the 128-session cap, preserving unrelated
devices when re-login replaces its own slot.

## Compatibility and boundaries

- Existing fixed-name cookies continue to authenticate without read-time
  reissuance, forced logout or a waiting period. The next successful login uses
  the scoped format and retires its presented predecessor.
- There is no schema migration, new binding or new secret. Session tokens,
  `statsScope`, client APIs, room authority and UI are unchanged.
- New session cookies use an absolute expiry matching their stored 30-day
  session deadline. Deletion proof retains the original cookie name and token
  with an absolute ten-minute deadline; read responses do not refresh either.
- Parsing is bounded to 16 account-cookie entries and a 16 KiB Cookie header.
  Overflow and conflicting duplicate values fail closed rather than selecting
  a truncated candidate set. Unauthenticated cookie metadata grants no priority.
- Logout does not cancel independently pending explicit OAuth attempts. Such a
  callback can still complete later, as before; this change prevents old cleanup
  responses from destroying a newer completed login.

## Verification

Regression tests exercise the actual OAuth start/callback handlers, signed
provider tokens, state/nonce verification and the tracked SQLite schema. Only
the external identity provider is substituted. Coverage includes delayed
logout, logout-all, invalid session reads, failed authorization reads and
account deletion, each with legacy and scoped request cookies, plus normal
logout, legacy compatibility, revoked-newest fallback prevention, database
failure, parsing bounds and unrelated-device preservation.

A separate local Chromium probe applies real response headers to its native
cookie store. The five delayed-response schedules fail against the previous
implementation and pass with scoped cookies; the healthy-order control also
passes. Redirect navigation is driven by the local fixture, and no production
request is sent. These are controlled interleavings, not a claim to exhaust
every browser or OAuth interaction.

Final checks:

- Full unit run: **483 files, 9,915 tests passed, one existing skip**. The local
  deployment-artifact classifier case still requires unavailable `jq`; no new
  test was skipped, assertion weakened or timeout extended.
- The new OAuth/SQLite ordering suite passed all **29 cases**. The four final
  clock/profile, tombstone and session-cap cases also failed when the prior
  defective behavior was restored only in an ignored probe bundle.
- Native Chromium: all five delayed-response schedules and the healthy-order
  control passed through the actual OAuth handlers. Independent session-boundary
  browser and resolver probes also passed, including immediate profile writes
  after clock rollback. These focused counts overlap the regression coverage.
- Full repository typecheck and app/tooling lint passed. App Worker and test
  project typechecks were rerun after the final source/test refinements.
- Seven source guards passed: import graph, dead exports, source complexity,
  room authority, developer API boundaries, D1 migration contract and the
  source-only operations drift contract. All six production Worker bundles
  passed local dry-runs without deployment. Formatting and diff checks passed.

Local logs remain under ignored
`scratch/account-cookie-ownership-2026-09-27/` and
`scratch/qa-beta-round21-2026-09-27/`.

## Publication

After the owner ends the freeze, merge the reviewed beta changes and publish
the App Worker through the normal release workflow. `cloudflare/account-auth.ts`
already belongs to the release classifier's App runtime paths. A Git merge or
static-asset-only deployment does not by itself update the running auth server.
There is no migration window to wait out. Until that release, production keeps
its previous behavior. App 8.6.61 and cache v630 are unchanged by this beta task.
`main`, `origin/main` and remote main remain at
`35759e8b07f1ee0b272afbd0af03c770a858889e`; Operations Drift Audit remains
`disabled_manually`. This task publishes only the beta commit, with no PR or
production deployment.
