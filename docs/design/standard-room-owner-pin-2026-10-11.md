# Standard-room owner PIN — 2026-10-11

Status: implemented and verified locally on branch
`agent/standard-room-owner-pin` as App `8.10.0` / PWA cache `v653`. It is
based on `origin/agent/pro-pin-two-step` `32a75a00` (PR #293, App `8.9.1` /
`v652`, not on main when this was tested), which is based on main `23d2f758`.
Not merged or deployed; production remains App `8.9.0` / `v651` at `d76b1432`
([release record](../release-record.md)). Release target `all`: the signaling
Worker and the App change together.

## Owner decisions (2026-10-11)

A read-only investigation of Standard rooms preceded this change. The owner
decided:

1. The Standard-room PIN stays exactly 8 digits. No wire or format change.
2. The random generator is removed. The host types the PIN in the same
   two-step dialog as PRO, starting from an empty field.
3. No weak-PIN refusal anywhere: `0000-0000` and similar stay allowed in both
   room types. A room PIN is a soft access deterrent.
4. The PIN is hidden in both room types: protected rooms show `••••-••••` with
   the pencil (change) button. The Standard host keeps the PIN only in memory,
   as before.
5. With no other device connected, step 2 is skipped and step 1's primary
   button reads 확인 instead of 다음, in both room types.
6. Step 2 defaults to "그대로 두기".
7. "모두 재입장" removes every other device, including the owner's own other
   devices and administrators. Account-linked administrator grants are kept,
   so those people regain them when they re-enter.
8. Removed Standard guests see a notice that names "방장", then land on the
   PIN prompt of the same room (`/{code}`).
9. The signaling Worker limits wrong Standard-room PINs per room and per client
   address (IPv6 by /64), about 20 failures per 10 minutes, counting failures
   only, with a new error code that older clients treat as a permanent auth
   error.
10. Turning protection off stays immediate, with no step 2.
11. Individual kicks get no ban list; `known-accepted.md` records that a
    modified client could still come back.
12. One shared label set for both room types ("그대로 두기" / "모두 재입장" with
    the #293 descriptions). Standard removal notices say "방장"; PRO keeps
    "방 소유자/관리자".
13. Scope is the investigation's Phase A and Phase B in one release: the App
    waits for the Worker's ack; capability-gated membership fields; a kept
    set under a new key tied to the room epoch and verifier digest; keep and
    revoke semantics in the Worker; the host kicks with a reason only after
    the ack. This also fixes the stale-PIN reconnect defect.
14. No change to `cloudflare/standard-room-pin-storage-contract-version.txt`,
    room meta v2, or the guest-binding schema.
15. Fix the forced-colors language list, whose selected row rendered its text
    as blank white boxes.
16. Fix other real defects found on the way, within reason, and list them.
17. App `8.10.0`, SW cache `v653`, release target `all` (signaling deploys
    before the App).
18. Documentation as listed below.

## Contract (additive only)

- Two new Durable Object keys that older Workers never read:
  `standard-room-pin-membership-v1` (the kept set) and
  `standard-room-pin-failures-v1` (the wrong-PIN buckets). Shapes, bounds and
  lifecycles are in the
  [ops runbook](../../cloudflare/standard-room-pin-ops.md#owner-chosen-pins-kept-devices-and-the-wrong-pin-limit-app-8100).
- The host `peer-open` advertises `standardRoomPinMembershipVersion: 1`.
- `room-password-set` gains optional `existingParticipants`
  (`keep_present` | `revoke_all`) and `keptPeerIds` (keep only, at most 99),
  both allowed only with an 8-digit PIN and a `pinMutationId`. The App sends
  them only on the exact socket whose `peer-open` advertised the flag; an
  older Worker's exact-key validator would otherwise drop the whole frame.
  The applied `room-password-result` may echo `existingParticipants`.
- `host-auth` is byte-identical.
- New guest close errors, both 1008: `room-password-changed` (sent to
  admitted guest sockets on "모두 재입장") and `room-password-rate-limited`
  (with `retryAfterSeconds`). Every shipped client treats any
  `room-password-*` error as permanent: no reconnect storm.

## Change

### Signaling Worker and transport (earlier commits on this branch)

`4935f8a2` adds the pure `cloudflare/standard-room-pin-membership.ts`
(validator, normalizers, limiter, address prefix in parity with PRO, epoch
hash and attempt-key HMAC). `20068ac1` implements keep, revoke, the record
lifecycle and re-stamps, and the wrong-PIN limit in
`cloudflare/signaling-worker.ts`, with the `guest_auth_rate_limited` metric
("Password lockouts"). `71340ee3` makes `setRoomPassword(pin, membership?)`
return the Worker's commit for that exact mutation (`applied` with
`keep_present` / `revoke_all` / `legacy`, or `superseded`), sends the
membership only on a flagged socket, clears the directive after the applied
ack (so a later echo cannot revoke people who entered with the new PIN), and
carries `retryAfterSeconds` on guest errors.

### App (`964d30c8`)

- **Shared dialog** (`src/ui/connect.ts`). One builder serves both room
  types: title "방 암호 설정" or "방 암호 변경", "새 8자리 암호를 설정해 주세요.",
  the empty 8-digit field with the existing validator (no weak-PIN check).
  When another device is connected, 취소 / 다음 leads to step 2 ("현재
  참여자를 어떻게 할까요?", "그대로 두기" checked); alone, the page has
  취소 / 확인 and sends keep. The choice is fixed when the dialog opens, so a
  device that arrives meanwhile is kept. The radio group name became
  `room-pin-existing-participants`. The toggle and pencil are locked while the
  dialog or the commit wait is open, in both room types.
- **Standard host flow.** Cancel sends nothing. On OK the toggle turns on and
  `network/standard-room-pin.ts` hands the PIN and choice to the transport,
  with every device present at the decision as the kept list. It waits up to
  10 s: "방 암호를 설정했어요." / "방 암호를 변경했어요." on the commit, or
  "연결이 회복되면 새 암호가 적용돼요." when the signaling connection is down (the
  transport keeps and replays the PIN). A tab that cannot apply it restores
  the previous state and shows the generic error. Turning protection off is
  immediate and disarms any pending removal. The dialog aborts if the room,
  session code, device id or host role changes.
- **Removal after the ack.** Only when the Worker commits "모두 재입장" for that
  exact, still-current mutation in the same host session does the network
  layer emit `network:room-pin-revoke-present`. `src/network/host.ts` then
  sends `KICK_DEVICE` with reason `room-pin-enabled` or `room-pin-changed` to
  every connected device, including the owner's other devices and
  administrators, and closes the channels after 300 ms. It does not revoke
  account-linked administrator grants; anonymous grants end with the departed
  connection as before. An older Worker that commits the PIN alone still gets
  the host-side removal; a superseded change removes nobody. PeerJS hosts
  (non-public origins) have no signaling PIN and get the host-side removal.
- **Guests** (`src/network/guest.ts`, `src/ui/setup.ts`). Only a known kick
  reason from the host connection changes the copy. The notice is
  non-dismissible: title "방 암호가 설정됐어요" / "방 암호가 바뀌었어요" (shared with
  PRO), message "방장이 방 암호를 설정했어요. 암호를 입력하면 다시 들어올 수 있어요."
  or "방장이 방 암호를 바꿨어요. 새 암호를 입력하면 다시 들어올 수 있어요.". The room
  code is read when the kick arrives, and OK reopens `/{code}`, where
  auto-join asks for the PIN (`room-password-required`, not counted). An
  invalid code reloads instead. A `room-password-changed` close that arrives
  without the kick frame shows the same notice, and a second report while it
  is open is dropped. `room-password-rate-limited` shows "입장 시도가 너무
  많아요. N분 후에 다시 시도해 주세요." (minutes rounded up) or the "잠시 후"
  variant. Unknown or missing reasons keep the old 강제퇴장 dialog.
- **Masking.** Both room types show `••••-••••` when protected, with the code
  span `aria-hidden` and a new visually hidden status (`connect.room_password_on`,
  "암호 적용됨") for screen readers; the pencil path and the "방 암호 변경" label
  are shared. `index.html` carries the pencil and both status spans.
- **PRO fallback.** With step 2 skipped and the owner still alone, a PRO
  Worker that refuses `keep_present` (for example after a rollback) gets one
  legacy retry instead of the keep-unavailable dialog, which points at a row
  the owner never saw.
- **State.** The dead `network.roomPassword` (the plaintext Standard PIN in
  the global state tree) is removed; the transport keeps the PIN for replay.
- **Copy.** Three keys in all 42 locales: `connect.pin_enabled_removed_message`,
  `connect.pin_changed_removed_message` (each with the locale's own host term
  from `connect.kicked_message`) and `connect.room_password_apply_pending`.
  Six unused keys are removed: `connect.room_password_set`, `_input_aria`,
  `_refresh_aria`, `_off`, `_pending`, `_enabled`. The removal notices differ
  from the PRO ones in every locale.

### Forced colors (`25da8909`)

Chromium paints a `Canvas` backplate behind text in forced colors, so the
`HighlightText` copy of every Highlight-filled selected state vanished; the
language list's active row showed blank white boxes. Selected rows, pressed
controls and the demo "next" button keep their `Highlight` fill and border;
their text now uses `CanvasText`, and only icons and check marks (no
backplate) take `HighlightText`, as #293 did for the PIN choice rows. The
`:is(...) *` HighlightText rule is gone, and `forced-color-adjust` remains
limited to the QR code. A CSS test requires every forced-colors
`color: HighlightText` to target an `svg` or a check mark.

## Compatibility and rollback

| App \ signaling | 8.10.0 Worker | Older Worker |
| --- | --- | --- |
| 8.10.0 App | Full behavior: kept devices reconnect without the new PIN, "모두 재입장" closes guest sockets and then the host kicks with a reason, wrong PINs are limited | No flag, so the App sends the PIN alone. "그대로 두기" behaves as before (present guests re-send the old PIN on a signaling reconnect); "모두 재입장" is the host's kick only, which a modified client can ignore; no wrong-PIN limit |
| Cached 8.9.x App (host) | Random PIN as before; its frames are legacy and accepted unchanged; no removal; wrong-PIN limit applies to its guests | Unchanged 8.9.x behavior |
| Cached older App (guest) | Kicked by "모두 재입장" with the generic 강제퇴장 dialog; the two new errors show the generic join error; both are permanent auth errors | Unchanged |

- No contract marker or forward floor. A record left behind by a rollback is
  tied to the room epoch and verifier digest, so it is ignored, except that an
  X→Y→X PIN flip under an older Worker can revive an old kept set (its peers
  still need their own reconnect secrets).
- Transition: cached 8.9.x hosts that refreshed their random PIN make their
  present guests re-send the old PIN on the deploy reconnect; those failures
  count against the shared address bucket.

## Other defects fixed

- The stale-PIN reconnect defect: after a PIN refresh, connected guests
  re-sent the old PIN on a signaling reconnect, got `room-password-invalid`,
  and lost ICE-restart recovery. Kept devices now reconnect without the new
  PIN.
- The host never learned whether the Worker committed a Standard PIN; the UI
  now reports a commit, a pending change, or a failure.
- Forced-colors vanishing text on every Highlight-filled selected state,
  including the language list and the pinned demo "next" rule.
- Masked PIN rows were read as "bullet bullet …" by screen readers, in PRO
  too.
- The plaintext Standard PIN lived in the global state tree
  (`network.roomPassword`) with no reader after masking.
- Six leftover `connect.room_password_*` keys in 42 locales.
- A PRO keep-unsupported dead end that decision 5 would otherwise introduce.
- A revoke replay trap: without a one-shot directive, the transport's echo
  after a host reconnect would have closed people who entered with the new PIN
  (fixed in `71340ee3`).
- PRO connect tests decided step 2 from device lists left over by earlier
  tests (module state); they now set the room's devices explicitly.

Observed, not changed:

- The Standard WebSocket-open limit keys on the full IPv6 address, not the
  /64 (`cloudflare/signaling-worker.ts`, the per-IP open limiter).
- `getClientIp` falls back to `X-Forwarded-For` when `CF-Connecting-IP` is
  absent (the wrong-PIN limit never uses it).
- The new-room branch of host admission deletes the kept-set key but not the
  failure table. `clearRoomMeta` deletes both, and failures are written only
  in a protected room, so this was left for the Worker owner to confirm
  rather than changed here. A leftover bucket would at worst keep a lockout
  until its 10-minute window ends.

## Release identity

- App `8.9.1` to `8.10.0` (minor) in `package.json`, both
  `package-lock.json` product fields, `browser/classic-runtime/admin.ts` and
  `cloudflare/app-worker.ts`. PWA cache `v652` to `v653` with the
  `index.html` bootstrap query (`b950b381`). If main's cache moves first,
  bump again before merging.
- Against the deployed SHA `d76b1432`, `changedRuntimePaths()` finds 3
  signaling paths (`signaling-protocol.ts`, `signaling-worker.ts`,
  `standard-room-pin-membership.ts`), 62 App paths, and none for `pro-room`,
  `remote-share`, `developer-api-facade` or `developer-api`;
  `changedAppRuntimeDependencies()` is empty. Release target `all`; the
  release workflow deploys signaling before the App.
- No D1, R2, secret or binding change. The pepper also keys the attempt HMAC,
  so a pepper rotation resets the wrong-PIN windows.

## Verification

Tested code: `b950b381` on `agent/standard-room-owner-pin`
(`origin/agent/pro-pin-two-step` `32a75a00` plus `4935f8a2` membership and
limiter contract, `20068ac1` signaling Worker, `71340ee3` transport,
`964d30c8` App flow and copy, `25da8909` forced colors, `b950b381` App
8.10.0 / v653). The browser test `e2e/standard-room-owner-pin.test.ts` was
added after that SHA in the documentation commit and ran against the same
built tree. Windows 11, Node 24.13.1, npm 11.8.0, Playwright 1.63.0
Chromium, dependencies from the main checkout's `node_modules` (Vite 8.3.3,
Vitest 5.0.3) through a junction. All runs are local; none is an exact-main
CI candidate.

| Command | Result |
| --- | --- |
| `npm run typecheck` (every project, including tests and e2e) | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npm test` | 538 files, 11,460 passed, 0 failed, 1 skipped¹ |
| `npm run test:coverage:critical` | 58 files, 1,988 passed; thresholds met (81.84 / 76.50 / 88.07 / 85.95) |
| `npm run test:coverage:workers` | 38 files, 2,078 passed; thresholds met (84.89 / 81.47 / 93.14 / 89.39) |
| `guard:dead-exports` | pass (self-only 79, test-only 21: unchanged baselines) |
| `guard:release-identity` | pass; `8.10.0` / `v653` |
| `guard:sw-cache-version` | pass; `v653` (`b950b381`) covers every committed PWA runtime change |
| `guard:bus-pairing` (198/198), `import-graph`, `lifecycle-writes`, `room-authority-boundaries`, `source-complexity` (signaling-protocol 988/1000, signaling-worker 8,279/10,000), `standard-room-hot-path`, `prod-security` | pass |
| `npm run build:checked` | pass, including `guard:legacy-tv-build` (Chromium 79) |
| `npm run check:worker-bundles` (after the build) | pass, every production Worker bundled |
| `npm run build:e2e`, then `npx playwright test e2e/standard-room-owner-pin.test.ts e2e/pro-entry-password.test.ts e2e/dialog-locale-layout.test.ts e2e/device-management.test.ts --project=chromium` | 18 passed (local Chromium; Standard rooms over local PeerJS, PRO over a synthetic API fixture; outside CI by design) |

¹ The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed, as on this machine. It does not exercise this change.

The first `check:worker-bundles` in the gate script ran before the build and
stopped because `dist/` was missing; it passed once `build:checked` had
produced `dist/`.

New and changed App tests: `src/network/__tests__/standard-room-pin.test.ts`
(kept list snapshot, removal only after the applied commit with the right
reason, legacy Worker still removes, late ack after `pending`, superseded and
turned-off changes remove nobody, host-session change, PeerJS, refusals from a
guest tab, PRO room, no transport or no session); `host.test.ts` (every open
device, including the owner's other device, an account administrator and an
anonymous guest, gets `KICK_DEVICE` with the reason and is closed after
300 ms, the account grant is kept, closed channels and non-Standard rooms are
ignored); `guest-connection-type.test.ts` (only a known reason, only from the
host); `setup-network-error.test.ts` (both notices with host wording, non-
dismissible, navigation to the captured `/{code}`, reload for an invalid code,
the generic kick, one notice for the kick plus the socket close, the
`room-password-changed` close alone, lockout copy in rounded-up minutes and
"later"); `connect-i18n.test.ts` (Standard: single page when alone, step 2 with
keep by default, the pencil with "모두 재입장", a connecting peer counts as
nobody, cancel paths send nothing, the lock, pending and failure outcomes,
immediate turn-off, session change aborts, no generator; PRO: the skip, the
alone-only legacy fallback, and no fallback when someone arrived);
`contrast-accessibility.test.ts` (no forced-colors `HighlightText` text,
selected fill and border kept); the 42-locale copy checks in
`translations.test.ts`; and the browser cases in
`e2e/pro-entry-password.test.ts` and `e2e/standard-room-owner-pin.test.ts`.
The Worker, protocol and transport tests are listed in their commits.

### Screenshots and layout measurements

Captured with Playwright Chromium from the e2e build of `b950b381`'s tree,
Standard rooms over the local PeerJS server, PIN typed as `1234-5678`. Phone
sizes use touch emulation at device scale 2. Files are in the owner's local
scratch folder `stdpin-captures/` (not in the repository):

- Korean, host alone: step 1 with 취소 / 확인 (empty and typed) and the masked
  row at 390x844 and 360x640.
- Korean, host with a guest: step 1 with 다음, step 2 with "그대로 두기" checked
  and with "모두 재입장" chosen, and the masked row, at 390x844, 320x568,
  844x390 and 1280x800; the same in Arabic at 390x844.
- The guest's removal notice in Korean ("방장이 방 암호를 설정했어요. …") and
  Arabic at 390x844.
- The language list in forced colors, light and dark, at 390x844: after this
  change, and with the previous rules injected as "before".

Every dialog capture measured no horizontal overflow in the panel or the page,
a panel inside the viewport, and both actions visible and hit-testable at
their centre. The masked row read `••••-••••` with `aria-hidden="true"`, the
status "암호 적용됨", and the pencil "방 암호 변경". In forced colors the active
language row kept its `Highlight` fill; its label and English name were
`HighlightText` before (white on Chromium's white backplate in light mode,
the blank boxes) and are `CanvasText` now (black in light, white in dark),
with the check mark still `HighlightText`.

### Limits

- No real device, Safari or iOS WebKit, soft keyboard, or screen reader.
  VoiceOver and TalkBack reading of the status span and the notices is
  unverified.
- The local browser suite runs Standard rooms over PeerJS, which has no
  signaling PIN: the Worker's kept set, socket revocation, wrong-PIN limit,
  `pending` outcome and real reconnect recovery are covered by the Worker and
  transport unit tests (including one end-to-end transport run against the
  real Worker code), not by a browser against a live signaling Worker. No
  production Worker or real room was used.
- Forced colors were checked only with Chromium's emulation.
- Translations were written for this change without native-speaker review.
  Thai, Vietnamese, Turkish and Chinese use the same word for the Standard
  host and the PRO room owner, so their notices differ from PRO only in
  wording.
- Local Node 24.13.1, not the pinned 24.20.0; PR CI remains the reference.
