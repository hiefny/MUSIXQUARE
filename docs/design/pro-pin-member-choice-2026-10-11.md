# PRO PIN membership choice and removal reasons — 2026-10-11

Status: implemented and verified locally on branch
`agent/pro-pin-member-choice`, based on main `13a25ee4` (#288), as App `8.9.0`
/ PWA cache `v650`. Not merged or deployed; production remains `8.8.0` /
`v646` at `6e59d96c` ([release record](../release-record.md)). Release target
`all` (PRO Worker first, App last). Standard rooms do not change.

## Owner decisions (2026-10-11)

For PRO rooms only:

1. When the owner enables or changes the room PIN, they choose between
   keeping the people in the room now (the default) and making everyone
   re-enter with the new PIN.
2. A member removed because the owner chose "everyone re-enters" is told why.
3. A member removed by the owner or an administrator (`/presence/kick`,
   `/presence/kick-device`) sees a clear "removed" message and is not
   silently re-admitted to a public room on reload.

### What happened before this change

- Enabling or changing the PIN always advanced `authEpoch`, deleted every
  session except the owner's requesting one, and reset presence to the owner.
  Disabling kept everyone.
- A removed member's next heartbeat (within 15 s) got 401 `SESSION_REQUIRED`.
  The App showed "Refreshing session..." and reloaded the room URL; a PIN room
  then showed the generic PIN prompt.
- After a kick, the reload landed on the invite screen. Tapping Start tried
  the cookie (401), then the no-PIN probe, and a public room admitted the
  browser as a new member with no message: a one-tap silent rejoin, not a
  zero-tap one.
- No Developer API, BOT, or facade route can change the PIN. The Worker
  assigns it only on owner removal, ownership transfer, activation, and
  `POST /pin`.

## Contracts

### `POST /v1/rooms/{code}/pin`

| Request body | Header `x-mxqr-pro-entry-policy` | Result | Response |
| --- | --- | --- | --- |
| `{pin: "12345678"}` | absent | revoke everyone else (unchanged) | `{"ok":true}` |
| `{pin: "12345678"}` | `optional-v1` | revoke everyone else (unchanged) | `{"ok":true,"passwordRequired":true}` |
| `{pin: null}` | `optional-v1` | disable, keep everyone (unchanged) | `{"ok":true,"passwordRequired":false}` |
| `{pin, existingParticipants: "revoke_all"}` | `optional-v1` | same state change as the legacy body | `{"ok":true,"passwordRequired":true,"existingParticipants":"revoke_all"}` |
| `{pin, existingParticipants: "keep_present"}` | `optional-v1` | keep present sessions, revoke the rest | `{"ok":true,"passwordRequired":true,"existingParticipants":"keep_present"}` |
| the field without the header, with `pin: null`, any other value, or an extra key | any | none | 400 `INVALID_REQUEST` |

The owner check runs first, so a member gets 403 `OWNER_REQUIRED` whatever
the body says. The App sends the field only for "keep"; "make everyone
rejoin" keeps the legacy `{pin}` body so it works against a rolled-back
Worker.

`keep_present` keeps the requesting owner session and every session bound to
a presence entry that is live after the request-start prune (same
participant and presence incarnation). It revokes every other session:
dormant devices of kept accounts, dormant controllers (their grant stays, but
they need the PIN), dormant anonymous administrators, the owner's dormant
devices (they re-enter through the verified owner account), and anyone who
left. It leaves `authEpoch`, presence (including the coordinator fence and
its epoch), playback, and any pending transition unchanged, so signaling
closes no socket. It purges session-create receipts (a kept device's retry
converges through deterministic recovery) and clears the in-memory admission
throttle only after its commit succeeds. People it keeps stay signed in on
that device, without the PIN, until they leave, are removed, or their
30-day session expires; this is what lets a reload or a `PRESENCE_EXPIRED`
recovery work after "keep".

### Removal reasons

A session removed on purpose answers with
`401 {"error":"SESSION_REQUIRED","reason":R}`:

| R | Written by |
| --- | --- |
| `PIN_ENABLED` | a PIN enable (public room → protected), keep or revoke-all; never for owner devices |
| `PIN_CHANGED` | a PIN rotation, keep or revoke-all; never for owner devices |
| `REMOVED` | `/presence/kick` (every device of the member, dormant ones included) and a non-sibling `/presence/kick-device` |
| `DEVICE_REMOVED` | `/presence/kick-device` from a verified sibling device of the same account, owner devices included |

- The code stays `SESSION_REQUIRED`, which the 8.8.0 App already treats as
  terminal; it ignores the extra key. No new error code.
- Only the `!auth` branch of `requireSession` adds a reason. The
  alive-session/no-presence `SESSION_REQUIRED` never does, and neither does
  any other removal: leave, fenced close, capacity eviction, expiry, account
  purge, suspension, owner recovery, transfer, or activation.
- The reason is not one-shot and the 401 sets no cookie, so both the live
  recovery and the post-reload resume see it.

The reasons come from a new core ledger, `sessionRevocationNotices`
(`Record<tokenHash, {reason, authEpoch, roomGeneration, expiresAtMs}>`):

- At most 256 entries, about 140 bytes each, so at most about 36 KiB. A full
  ledger evicts invalid entries, then the one that expires first; writing a
  notice never fails a removal.
- `expiresAtMs = min(session expiry, now + 7 days)`.
- A notice applies only while its reason is known, its `authEpoch` and
  `roomGeneration` match the room, it has not expired, the room is active, and
  no live session holds the hash. Activation resets `authEpoch` to 1, so it
  also clears the ledger.
- Initialized to `{}`, normalized on load (a non-object becomes `{}`),
  bounded by `assertBoundedRoomState`, alarmed, and pruned (expired,
  mismatched, malformed, unknown-reason, and live-hash entries), the same way
  #289's ledgers are.
- Public traffic cannot write it. Each notice is written while a far larger
  session record (about 530 bytes) is deleted.

### App

- PIN dialog: enabling is titled "Set room password", changing keeps "Change
  room password"; the message is now just "Set a new 8-digit password." A
  radio group, "People in the room now", offers "Let them stay" (default) and
  "Make everyone rejoin" with one-line details. The success toast says the
  password was set or changed. A Worker that refuses "keep" (400) shows "The
  password wasn't changed..." and the toggle stays as it was; the App never
  falls back to revoking everyone.
- Live removal (`recoverTerminalSession`): for `REMOVED` / `DEVICE_REMOVED`
  the App replaces the room URL with `/`, shows a non-dismissible dialog,
  marks the removal acknowledged for this tab (`sessionStorage`
  `mxqr_pro_removed_ack` = room code), and leaves for home. It never reloads
  the room URL. For `PIN_ENABLED` / `PIN_CHANGED` a non-owner sees an
  explanation, then the existing refresh. An owner, or no reason, is
  unchanged. A `PRESENCE_EXPIRED` re-entry that finds the session gone keeps
  the server's error and reason. A successor open or leave aborts a pending
  dialog.
- Entry (`setup-flow`): a cookie-resume miss with `REMOVED` /
  `DEVICE_REMOVED` and no acknowledgement for this room in this tab shows the
  same dialog and goes home without admitting. With the acknowledgement the
  ordinary probe runs: a deliberate second open is an ordinary, throttled
  admission, never a ban. After a PIN-change removal the no-PIN probe still
  runs (the verified owner gets in without a prompt), and the first PIN
  prompt says why; retries use the usual retry message. A successful entry
  clears the acknowledgement. Claim, recovery, and transfer flows ignore
  reasons.
- Shared dialog: a generic native `choiceField` (fieldset, legend, 44 px
  rows, logical properties for RTL, `accent-color`, focus-visible ring). Each
  radio is named by its label span (`aria-labelledby`) and described by its
  detail (`aria-describedby`); the wrapping `<label>` keeps the whole row
  clickable. While a choice is shown, the dialog is described by the message
  text alone (`#dialog-message-text`), so opening it does not read every
  option; other dialogs keep `#dialog-message`. The checked radio is one Tab
  stop between the input and the actions; Enter on a radio confirms after the
  input validator passes; copy refreshes on locale change.
- Chinese dialog copy wraps between characters: `.dialog-message` keeps
  `word-break: keep-all`, and zh-Hans and zh-Hant now share the Japanese
  override (`word-break: normal; overflow-wrap: anywhere; line-break:
  strict`). Without it the unpunctuated zh `pro.device_removed_message` ran
  past the dialog at every width.
- Copy: 15 new keys and a shorter `pro.pin_change_message`, translated in all
  42 locales in each locale's existing PIN register (Korean 해요체). PRO copy
  names the room owner and administrators (방 소유자 / 관리자), not the
  standard room's host or "forced kick".

## Compatibility

| App \ PRO Worker | Earlier Worker (8.8.0 or #289) | This Worker |
| --- | --- | --- |
| Cached App before 8.9.0 | unchanged | PIN changes use the legacy body: revoke-all and the exact legacy response. Removed members get 401 `SESSION_REQUIRED` (the reason is ignored): the generic refresh, and a kicked member can still rejoin a public room with one Start tap until the App updates. |
| This App | "Make everyone rejoin" works (legacy body). "Let them stay" gets 400 and shows "The password wasn't changed..."; nothing changes. No reasons arrive, so removals show the generic refresh. | Full behaviour. |

- Rolling the PRO Worker back keeps `sessionRevocationNotices` in the core
  verbatim (an earlier Worker loads `{...storedV2.core}`) and ignores it; the
  ledger fits its byte check. Rolling forward prunes stale entries on the
  first request or alarm. No contract marker or recovery floor is needed; the
  current floor in the [release record](../release-record.md) is unchanged.
- No D1, secret, binding, Durable Object migration, R2, or signaling change.
  App SemVer moves to `8.9.0` (a backward-compatible feature) in every
  mirror, and the PWA cache to `v650`: main already ships `v648` (#288) and
  the open `agent/pro-join-error-copy` branch holds 8.8.1 / `v649`. If the
  merge order changes or main's cache moves again first, renumber both just
  before merging, keeping the bump commit after every runtime commit.

## Verification

Tested code: `4319a2a0` on `agent/pro-pin-member-choice`, rebased onto main
`13a25ee4` (#288). Code commits: `bedd9b3d` (Worker), `c0bb1efe` (API client),
`203e3edd` (copy), `1776288e` (dialog), `de0bb4fc` (App flows), `eb9e6e9c` and
`4bb5f165` (lint and dead-export guard follow-ups), `d749e0c6` (e2e),
`ca4c9001` (Chinese dialog wrapping), `f0e62a26` (choice accessible names and
dialog description), `4319a2a0` (App 8.9.0, PWA cache v650). Windows 11 local
run, Node 24.13.1 / npm 11.8.0, with dependencies installed by `npm ci` from
the rebased lockfile (Vite 8.3.3, Wrangler 4.148.0) and the code equal to that
commit; only documentation differed. All runs are local; none is an
exact-main CI candidate.

| Command | Result |
| --- | --- |
| `npm run check:pro-room-worker` | pass (module check and production-security guard) |
| `npx vitest run src/pro-room src/ui src/i18n src/core/__tests__/app-worker-cors.test.ts src/core/__tests__/ci-quality-gates.test.ts` | 178 files, 3,844 passed, 0 failed, 0 skipped |
| `npm run typecheck` | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npm test` | 536 files, 11,316 passed, 0 failed, 1 skipped¹ |
| `npm run test:coverage:workers` | 37 files, 2,021 passed; all thresholds met. `pro-room-worker.ts` 85.67% statements, 81.47% branches, 95.44% functions, 89.96% lines (thresholds 83 / 78 / 94 / 88); `pro-room-worker.test.ts` alone has 405 tests (381 before) |
| `npm run test:coverage:critical` | 58 files, 1,958 passed; all thresholds met (81.77 / 76.39 / 88.03 / 85.90) |
| `npm run guard:source-complexity` | pass; `pro-room-worker.ts` 15,911 of 20,000 lines, `runtime.ts` 3,972 of 10,000 |
| `npm run guard:room-authority-boundaries` | pass |
| `npm run guard:sw-cache-version` | pass; `v650` (`4319a2a0`) covers every committed PWA runtime change |
| `npm run guard:release-identity` | pass; `8.9.0` / `v650` |
| `npm run guard:bus-pairing`, `guard:import-graph`, `guard:dead-exports`, `guard:lifecycle-writes`, `guard:brand-capitalization` | pass |
| `npm run build:checked` | pass (every pre-build guard, the build, and every post-build guard) |
| `npm run build:e2e`, then `npx playwright test e2e/pro-entry-password.test.ts e2e/dialog-locale-layout.test.ts --project=chromium` | 8 passed (5 entry-password, 3 dialog layout and locale; local Chromium, synthetic API fixture; outside CI by design) |
| Chromium layout probe: the real stylesheet, the real dialog markup, and the new PRO messages and choice copy for zh-Hans, zh-Hant, ja, ko, th, and en at 360, 390, and 1280 px | 8 horizontal overflows before `ca4c9001` (zh `pro.device_removed_message` 11 to 94 px at every width, zh `pro.pin_keep_unavailable` 19 px at 360 px), 0 after |
| Chromium accessibility probe: computed name and description of the choice markup before and after `f0e62a26` | radio name "Let them stayPeople connected now can stay." became "Let them stay" (description unchanged); dialog description "Set a PIN Eight digits People in the room now" became "Set a PIN"; clicking the row still checks the radio |

¹ The `release-deployment-state` shell-plan contract test skips when `jq`
is not installed; it was not installed on this machine. It does not exercise
this change.

The two probes are throwaway Playwright scripts, not committed tests; the
committed tests pin the CSS rule and the ARIA wiring (`dialog.test.ts`).

New and changed tests:

- Worker (`pro-room-worker.test.ts`): a new 24-test block covers the validation
  matrix and exact response bytes; keep in a public room (anonymous and
  account members, anonymous administrator, account controller, owner sibling
  device, pending rendezvous; unchanged epoch, presence, playback, and
  transition; one presence event; `pin_required` bootstrap); live system
  audio from the owner's other device; dormant revocation (expired and closed
  presence, a kept account's dormant device, a dormant controller, a dormant
  owner device, a stale-incarnation entry); the rotation variant; receipt
  purge with the dedicated and legacy shared ledgers; reload, expiry
  recovery, and explicit leave after keep; rollback of a failed commit with
  the throttle untouched; revoke-all notices and an exact state diff between
  the explicit and legacy bodies; no reason after leave, fenced close,
  capacity eviction, expiry, account purge, suspension, owner recovery, or
  the alive-session branch; notice lifetime, durable alarm pruning, epoch and
  generation fences, live-hash release, activation reset, alarm scheduling;
  both cap paths; load normalization; and restart and older-Worker leftovers.
  Existing PIN and kick tests now pin the reason, the #289 budget test adds a
  saturated notice ledger, and the throttle test covers keep.
- App: API reason allow-list and keep bodies (`api.test.ts`); a new
  `runtime-session-end-reason.test.ts`; setup-flow acknowledgement, PIN
  prompt, and no-reason cases; the dialog choice field (semantics, label-only
  accessible names, the message-only dialog description, keyboard, focus
  trap, teardown, abort, locale refresh, CSS, and the zh/ja wrapping rule);
  connect titles, default, both choices, toasts, and the keep-unavailable
  dialog; and translation checks for every new key in all 42 dictionaries.

Limits:

- Before the rebase, a full run on an intermediate commit, while other guards
  ran at the same time, failed twice: the dead-export ratchet (two newly
  exported types used only in their own module, fixed in what is now
  `4bb5f165`) and one 30-second timeout in `release-deployment-state` ("blocks
  an unselected app when a localized build input changes"). That test touches
  no code in this change and passed in every later full run, including the
  one above.
- Local Node is 24.13.1, not the pinned 24.20.0, and npm warns that jsdom
  30.1.2 expects ^24.15.0, as in the
  [dependency update record](dependency-update-2026-10-11.md). PR CI on the
  pinned Node remains the reference.
- No real device, real customer room, or production Worker was used. The
  browser test uses a synthetic API fixture. The 390 px and RTL layout of the
  choice field is checked through CSS assertions and the 390 px e2e run, and
  the Chinese wrapping through the desktop Chromium probe, not on a phone or
  in Safari.
- Translations were written for this change without native-speaker review.
- The open 8.8.1 branch (`agent/pro-join-error-copy`) is not merged, so this
  branch is not rebased onto it. A trial merge conflicts on every version
  mirror (8.8.1 / `v649` against 8.9.0 / `v650`) and in
  `src/pro-room/__tests__/setup-flow.test.ts`; whichever merges second must
  resolve them, keep the later numbers with the bump after every runtime
  commit, and rerun the suite.

## Open after merge

Recorded in the [release record](../release-record.md) §2: real-device checks
on iPhone Safari/PWA and Android, the transitional behaviour of Apps before
8.9.0, and the rollback note.
