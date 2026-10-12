# Standard room announcement bootstrap — 2026-10-13

## Scope and evidence

- Runtime/test commit: `98c690cf79ff46e97b5e7358d0b3fd4a10866f4b`.
- Baseline: `d76794c25d94128a2a08201b567941117b623684` (App 8.10.2 / v661).
- Owner authorized fixing and deploying the missing Standard-room announcement.
  The approved maintenance-complete announcement was already published through
  the admin UI at 2026-10-13 00:20:34 KST; no new notice is needed for this fix.
- Public announcement GET returned enabled and the approved text, but a fresh
  Standard-room browser did not show its pinned notice. That browser also had
  a signaling admission warning; the deterministic local reproduction below
  isolates the announcement defect from that independent observation.

## Cause and change

`app.ts` lazy-loaded announcements only when `room.context.role` was not idle.
Standard rooms keep their role in the transport projection instead, so fresh
host and guest pages never loaded the polling module. Direct announcement unit
tests initialized that module themselves and bypassed the faulty bootstrap.
The condition existed before the 8.10.2 deployment (`64e6d8b37`, 2026-08-31).

The loader now also recognizes Standard host/guest through the existing
`isStandardRoomRole` lifecycle helper. It retains the PRO condition, shared
import promise, terminal lazy-load failure handling, and existing polling
lifetime. No new authority grant or direct legacy-state read is introduced.
Initial notices remain silent; visible sessions poll every five minutes and
check on foreground return, with the existing per-document seen-ID suppression.

The blocking critical-browser suite now navigates real setup flows from fresh
host and guest pages and requires each page's own announcement request plus
the visible pinned message. A forwarded host notice cannot satisfy the guest
request assertion. Existing PRO owner-recovery coverage also asserts its
announcement, while announcement unit tests retain stale-response and
visibility checks.

## Local verification

Environment: Windows, repository Node 24.20.0, installed dependencies, local
PeerJS for Standard E2E, mocked announcement/PRO responses for deterministic
browser tests. No production payload or live room is injected into these tests.

- Before fix: new Standard bootstrap test **1 failed**, pinned notice remained
  hidden after a successful local host connection (15-second assertion).
- After fix: complete `e2e/critical-browser.test.ts` **8 passed**, no retries.
- Typecheck, lint, format, Worker syntax and Developer API/D1/operations/room-authority guards: passed.
- First full-unit run: 12,353 passed / 1 failed; build also rejected the old
  `index.html` bootstrap query (v661) after the cache bump. Corrected that mirror
  to v662 in the final runtime commit.
- Final runtime SHA `98c690cf`: **550 files / 12,354 unit tests passed, 0 failed,
  0 skipped** (local jq supplied), committed `build:checked` passed, and its
  unmodified production artifact passed **17 candidate browser tests**.
- The 8 critical-browser tests ran on the same announcement implementation
  before correcting the bootstrap cache query; exact-main CI will rerun the
  complete critical gate against the final source. The entire auxiliary Full
  E2E suite and physical Safari/PWA were not run for this bounded fix.
- Independent code review: 0 blockers, 0 required changes; review did not itself
  execute tests.

## Release and limits

Prepared version: **8.10.3 / v662**, target **app**, Developer API D1 application
**false**. Version mirrors advance together. No dependency, schema, binding,
secret, protocol, or recovery-floor changes. Keep maintenance OFF for the normal
release and live smokes. Compatible rollback baseline is the current 8.10.2 App;
its announcement omission would return on rollback.

PR CI, exact-main candidate, production release ownership/smokes, and live
announcement screenshot remain pending. Branch/local tests do not substitute
for the exact-main CI candidate. Existing open clients need their normal update
and reload path; no forced refresh or new update system is introduced. Physical
iPhone/PWA behavior and other release-record open items remain outside this fix.
