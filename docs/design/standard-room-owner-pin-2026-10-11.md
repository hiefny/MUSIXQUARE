# Standard-room owner PIN — 2026-10-11

Status: implemented and verified locally on branch
`agent/standard-room-owner-pin` as App `8.10.0` / PWA cache `v654`, then
`v655` for the lockout copy ([Copy follow-up](#copy-follow-up-7f69b8bd)); the
wrong-PIN limiter then changed to fail open
([Owner decision B](#owner-decision-b-fail-open-ecdc2e20), no cache change). It
is based on `origin/agent/pro-pin-two-step` `32a75a00` (PR #293, App `8.9.1` /
`v652`, not on main when this was tested), which is based on main `23d2f758`.
Not merged or deployed; production remains App `8.9.0` / `v651` at `d76b1432`
([release record](../release-record.md)). Release target `all`: the signaling
Worker and the App change together.

> **Same release (2026-10-11).** The branch also carries the
> [in-room update prompt](in-room-update-prompt-2026-10-11.md), which moves
> the PWA cache to `v656`. The `v654`/`v655` results below predate it.

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
  admitted guest sockets on "모두 재입장", with message `ROOM_PASSWORD_ENABLED`
  when the room had no PIN before and `ROOM_PASSWORD_CHANGED` otherwise) and
  `room-password-rate-limited` (with `retryAfterSeconds`). Every shipped client
  treats any `room-password-*` error as permanent: no reconnect storm.

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
carries `retryAfterSeconds` on guest errors. The [review follow-ups](#review-follow-ups)
made live wrong-PIN buckets non-evictable with one shared overflow bucket
(removed again by [Owner decision B](#owner-decision-b-fail-open-ecdc2e20)),
let devices already in the room pass a locked bucket, carried kept devices
across consecutive keep changes, and told first-enable revocations apart.

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
  is open is dropped; its Worker message `ROOM_PASSWORD_ENABLED` selects the
  "설정" notice. `room-password-rate-limited` shows "입장 시도가 너무
  많아요. N분 후에 다시 시도해 주세요." (minutes rounded up) or the "잠시 후"
  variant; the [Copy follow-up](#copy-follow-up-7f69b8bd) replaces this with
  the Standard room's own wrong-password copy. Unknown or missing reasons keep
  the old 강제퇴장 dialog.
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

### Forced colors (`25da8909`, `6c99a122`)

Chromium paints a `Canvas` backplate behind text in forced colors, so the
`HighlightText` copy of every Highlight-filled selected state vanished; the
language list's active row showed blank white boxes. Selected rows, pressed
controls and the demo "next" button keep their `Highlight` fill and border;
their text now uses `CanvasText`, and only icons and check marks (no
backplate) take `HighlightText`, as #293 did for the PIN choice rows. The
`:is(...) *` HighlightText rule is gone, and `forced-color-adjust` remains
limited to the QR code. A CSS test requires every forced-colors
`color: HighlightText` to target an `svg` or a check mark.

The sibling pass (`6c99a122`) probed every Highlight-filled element on the
five tabs, the PIN dialog and the language list in emulated light and dark
forced colors, and found three more forced-colors rules that never applied:

- `!important` declarations inside `@layer base` outrank the unlayered
  forced-colors rules. In light high-contrast themes the invite QR therefore
  drew `CanvasText` (black) modules on its black square and could not be
  scanned, and the pressed room-PIN toggle kept a transparent track instead of
  its `Highlight` fill and `HighlightText` knob. Both base rules drop the
  redundant `!important`: the QR library paints with presentation attributes,
  and the toggle's inline styles carry the same colors.
- The selected bottom-nav tab and the pressed settings option cards painted
  their icons with the accent fill (`LinkText`) on the `Highlight` fill, about
  1:1 in both emulated palettes. In forced colors they now use `currentColor`
  and take the `HighlightText` icon color.

A CSS test now fails when a base-layer `!important` color declaration shares a
selector with a forced-colors rule, and pins the icon rule.

## Review follow-ups

A review of the branch at `67ac15f6` raised seven findings. All seven were
confirmed and fixed in `e846172e` through `6f0c65a7`:

1. **No limiter ceiling past 256 address blocks (should-fix).** With a full
   table, a new block evicted the unlocked bucket that expired first, so a
   round-robin over 257 blocks (one IPv6 /56 plus one IPv4 address) reset every
   counter before its next turn: the reviewer's script accepted 51,400 wrong
   PINs in 51 s and refused none. Live buckets are now never evicted; while 256
   blocks hold one, every other block is charged to, and locked with, one
   overflow bucket under a fixed key (`e846172e`). The same script now accepts
   5,120 wrong PINs for 256 blocks and 5,140 for 257 or 1,000 blocks, the
   256 × 20 + 20 bound, which a unit test pins. The cost is item 7.
   [Owner decision B](#owner-decision-b-fail-open-ecdc2e20) later removed the
   overflow bucket: blocks past 256 are now not limited.
2. **A later keep change dropped a kept device whose binding had expired
   (minor).** The keep branch now carries a listed peer's hash over from the
   current record when the peer has no live binding, and only while that record
   still exempts it (room epoch and verifier digest match) (`e3d4bb71`). Worker
   tests cover two keep changes with the binding expiring in between, and a
   stale record that carries nothing.
3. **An admitted guest lost signaling recovery while its bucket was locked
   (should-fix).** The Worker now lets a guest whose reconnect secret matches
   its live binding pass a locked bucket. Its PIN is still checked; a wrong PIN
   on that path is counted and deletes the binding, so one binding carries at
   most one attempt past a lock (`e3d4bb71`). The fix is in the Worker, so it
   covers every App version and the shared HTTP-bridge bucket. The App still
   treats `room-password-rate-limited` as permanent, so a device whose
   signaling stayed down past the 5-minute reconnect window is treated as new
   and can still lose recovery; known-accepted #12 records this. Worker tests
   cover an IPv4 guest and a bridge guest recovering during a lock, another
   device's secret under the same peer ID still refused, and the one-attempt
   limit.
4. **The socket-close notice always said "changed" (minor).** "모두 재입장" now
   closes guests with message `ROOM_PASSWORD_ENABLED` when the room had no PIN
   before, under the same error type, and the App maps it to "방 암호가
   설정됐어요" (`e3d4bb71`, `98312ece`).
5. **The planned production check was not visible in the dashboard
   (should-fix).** The admin Signals panel now shows "Password lockouts"
   (`guest_auth_rate_limited`, last 24 hours) and has six desktop columns
   (`0de283bc`), covered by a jsdom test of the admin runtime.
6. **No recovery entry in the release record (minor).** §4 now has
   "일반방 방장 암호(배포되면 적용)".
7. **The room-wide lockout was missing from known-accepted (minor).** Item #12
   then stated it with its cost after item 1 (about 276 wrong PINs from 256
   /64s, renewable) and the remedies, and the release record asked the owner
   to decide. The owner chose fail open instead
   ([Owner decision B](#owner-decision-b-fail-open-ecdc2e20)); #12 now
   records that design.

Items 4 and 5 change PWA runtime files after `120d59e2`, so the cache advanced
to `v654` (`6f0c65a7`); the App stays `8.10.0`.

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
- Forced colors, found by the sibling pass: the invite QR was a solid black
  square in light high-contrast themes (unscannable), the pressed room-PIN
  toggle never showed its Highlight fill, and the selected tab and option icons
  were LinkText on Highlight (pre-existing since the OS contrast work).
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
  `index.html` bootstrap query (`120d59e2`), then `v654` (`6f0c65a7`) after
  the review fixes. If main's cache moves first, bump again before merging.
- Against the deployed SHA `d76b1432`, `changedRuntimePaths()` finds 3
  signaling paths (`signaling-protocol.ts`, `signaling-worker.ts`,
  `standard-room-pin-membership.ts`), 63 App paths, and none for `pro-room`,
  `remote-share`, `developer-api-facade` or `developer-api`;
  `changedAppRuntimeDependencies()` is empty. Release target `all`; the
  release workflow deploys signaling before the App.
- No D1, R2, secret or binding change. The pepper also keys the attempt HMAC,
  so a pepper rotation resets the wrong-PIN windows.

## Verification

Tested code: `6f0c65a7` on `agent/standard-room-owner-pin`
(`origin/agent/pro-pin-two-step` `32a75a00` plus `4935f8a2` membership and
limiter contract, `20068ac1` signaling Worker, `71340ee3` transport,
`964d30c8` App flow and copy, `25da8909` and `6c99a122` forced colors,
`120d59e2` App 8.10.0 / v653, `1dde0c11` browser tests, the documentation-only
`a26159ca` and `67ac15f6`, then the review follow-ups `e846172e` limiter,
`e3d4bb71` Worker, `98312ece` App notice, `0de283bc` admin Signals and
`6f0c65a7` v654). The documentation-only successor that records this run
changes no code. Windows 11, Node 24.13.1, npm 11.8.0, Playwright 1.63.0
Chromium, dependencies from the main checkout's `node_modules` (Vite 8.3.3,
Vitest 5.0.3) through a junction. All runs are local; none is an exact-main CI
candidate. A first round of these checks at `120d59e2` also passed; the table
holds the final run.

| Command | Result |
| --- | --- |
| `npm run typecheck` (every project, including tests and e2e) | pass |
| `npm run lint` | pass, zero warnings |
| `npm run format:check` | pass |
| `npm test` | 538 files, 11,470 passed, 0 failed, 1 skipped¹ |
| `npm run test:coverage:critical` | 58 files, 1,993 passed; thresholds met (81.84 / 76.50 / 88.07 / 85.95) |
| `npm run test:coverage:workers` | 38 files, 2,084 passed; thresholds met (84.87 / 81.46 / 93.16 / 89.39) |
| `npm run check:workers` | pass |
| `guard:dead-exports` | pass (self-only 79, test-only 21: unchanged baselines) |
| `guard:release-identity` | pass; `8.10.0` / `v654` |
| `guard:sw-cache-version` | pass; `v654` (`6f0c65a7`) covers every committed PWA runtime change |
| `guard:bus-pairing` (198/198), `import-graph`, `lifecycle-writes`, `room-authority-boundaries`, `source-complexity` (signaling-protocol 988/1000, signaling-worker 8,350/10,000, admin 6,663/10,000), `standard-room-hot-path`, `prod-security`, `brand-capitalization` | pass |
| `npm run build:checked` | pass, including `guard:legacy-tv-build` (Chromium 79) and `guard:sw-app-shell` |
| `npm run check:worker-bundles` (after the build) | pass, every production Worker bundled |
| `npm run build:e2e`, then `npx playwright test e2e/standard-room-owner-pin.test.ts e2e/pro-entry-password.test.ts e2e/dialog-locale-layout.test.ts e2e/device-management.test.ts e2e/accessibility-contrast.test.ts --project=chromium` | 25 passed (local Chromium; Standard rooms over local PeerJS, PRO over a synthetic API fixture; outside CI by design) |
| The reviewer's limiter script (one wrong PIN per block in turn, 1 ms apart, 200 rounds) | 256 blocks: 5,120 accepted; 257 blocks: 5,140; 1,000 blocks: 5,140 (before the fix: 51,400 accepted, 0 refused for 257); superseded by [Owner decision B](#owner-decision-b-fail-open-ecdc2e20) |

¹ The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed, as on this machine. It does not exercise this change.

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
selected fill and border kept, no base-layer `!important` color sharing a
selector with a forced-colors rule, accent-filled tab and option icons follow
`currentColor` when selected); the 42-locale copy checks in
`translations.test.ts`; and the browser cases in
`e2e/pro-entry-password.test.ts` and `e2e/standard-room-owner-pin.test.ts`.
The Worker, protocol and transport tests are listed in their commits. The
review follow-ups add `standard-room-pin-membership.test.ts` cases (no live
bucket evicted, the shared overflow bucket and its lock, a freed slot, the
round-robin bound for 256, 257 and 1,000 blocks, the normalizer's 256 + 1
bound; [Owner decision B](#owner-decision-b-fail-open-ecdc2e20) replaced the
overflow cases with fail-open ones), five Worker cases listed under
[Review follow-ups](#review-follow-ups),
the first-enable close notice in `setup-network-error.test.ts`, and the
"Password lockouts" signal in `admin-dashboard-ui.test.ts`.

### Screenshots and layout measurements

Captured with Playwright Chromium from an e2e build of the code at
`6f0c65a7` (the whole set was regenerated after the review follow-ups),
Standard rooms over the local PeerJS server, PIN typed as
`1234-5678`. Phone sizes use
touch emulation at device scale 2. Files are in the owner's local scratch
folder `scratch/standard-pin-screens/` (not in the repository), with
`measurements.json`:

- Standard host flow in Korean at 390x844 light and dark, 844x390 and
  320x568: alone, step 1 with 취소 / 확인; with a guest, the empty step 1 with
  취소 / 다음; step 2 with "그대로 두기" checked; the guest's removal notice
  ("방장이 방 암호를 설정했어요. …"); after its 확인, the PIN prompt of the same
  room ("방 암호 입력" on `/{code}`, reached by auto-join); the wrong-PIN
  lockout ("입장 시도가 너무 많아요. 9분 후에 다시 시도해 주세요."); a joining
  guest closed by the Worker on a first enable, which now reads "방 암호가
  설정됐어요" / "방장이 방 암호를 설정했어요. …" (`-08-guest-close-enabled-notice`);
  and the host's masked row.
- Standard step 2 in Arabic at 390x844 (RTL).
- PRO owner at 390x844 (synthetic PRO API fixture): step 1 with 다음 when
  another device is present, step 1 with 확인 alone, and the masked row.
- Forced colors, emulated light and dark at 390x844: the language list with
  its selected row, the PIN choice rows with each option selected, the host's
  masked row with the pressed toggle, and the invite QR.
- The admin Signals panel at 1280x900 and 390x844 with synthetic metrics
  (the page markup is the App Worker's admin template, with `admin.css` and
  `admin.js` from the build; the admin keeps its own dark theme): six signals
  including "Password lockouts", in one row of six columns on desktop and one
  column on the phone, with no item or page overflow.

After the removal notice the guest page stood in for the signaling Worker,
which the local PeerJS suite does not run: it answered the first `guest-auth`
(no PIN) with `room-password-required` and the next with
`room-password-rate-limited` and `retryAfterSeconds: 540`, so the prompt and
the lockout copy come from the real transport, setup and dialog code. For the
first-enable capture it answered `guest-auth` with `room-password-changed` and
message `ROOM_PASSWORD_ENABLED`, then closed the socket with 1008.

All 42 measured dialog and page captures (the four forced-colors language and
QR images record colors instead) measured no horizontal overflow in the page or
the panel, a panel inside the viewport with no vertical scroll, and every
visible action hit-testable at its centre. Every masked row read `••••-••••`
with `aria-hidden="true"`, the status "암호 적용됨" and the pencil "방 암호 변경".
In forced colors the selected language row and the chosen PIN row keep their
`Highlight` fill with `CanvasText` copy (the chosen label in `LinkText`) on
the backplate and a `HighlightText` check mark; the pressed toggle is a
`Highlight` track with a `HighlightText` knob; the invite QR has white modules
on its black square in both palettes.

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
- Forced colors were checked only with Chromium's emulation, not with a
  Windows high-contrast theme, Firefox or a QR scan of the inverted code.
- The PIN prompt, lockout and first-enable close captures used a page-level
  stand-in for the signaling Worker; the Worker's own refusals are covered by
  its unit tests. The admin capture used a synthetic metrics response, not
  the App Worker or D1.
- The limiter bound and the binding bypass were checked with unit and Worker
  tests and a local script, not against a live Durable Object under load.
- Translations were written for this change without native-speaker review.
  Thai, Vietnamese, Turkish and Chinese use the same word for the Standard
  host and the PRO room owner, so their notices differ from PRO only in
  wording.
- Local Node 24.13.1, not the pinned 24.20.0; PR CI remains the reference.

## Copy follow-up (`7f69b8bd`)

Owner decision (2026-10-11): the Standard-room wrong-PIN lockout must not
borrow the PRO join-throttle copy "입장 시도가 너무 많아요", which talks about
join attempts rather than a wrong password. `src/ui/setup.ts` (the
`room-password-rate-limited` branch of the guest join error) now uses two new
keys; the minute rounding, the `retryAfterSeconds` check and the inline join
error are unchanged.

| Case | Key | Korean (owner's text) | English |
| --- | --- | --- | --- |
| `retryAfterSeconds` above 0 | `dialog.room_password_rate_limited`, `count` = `ceil(seconds / 60)` | 암호를 여러 번 틀렸어요. {{count}}분 후에 다시 시도해 주세요. | You entered the wrong password too many times. Try again in {{count}} minutes. (`one`: minute) |
| no wait, or 0 | `dialog.room_password_rate_limited_later` | 암호를 여러 번 틀렸어요. 잠시 후 다시 시도해 주세요. | You entered the wrong password too many times. Try again in a little while. |

- All 42 locales have both keys. Each keeps the locale's existing wait
  sentence from `pro.join_rate_limited` / `_later` and replaces only the lead
  with "you entered the wrong password too many times", using the locale's
  room-password word and register from `dialog.room_password_*`.
- `dialog.room_password_rate_limited` is registered in `PLURAL_PARAM_BY_KEY`
  on `count` (14 keys), with the same plural forms as `pro.join_rate_limited`
  in each catalog: `one` in da, de, en, es, fr, he, it, kn, mr, nb, nl, pt-br,
  sv, ta and te; `one`/`few`/`many` in pl and ru; `one`/`other` in ro;
  `two`/`few` in ar. The other locales use one form for every count.
- PRO join throttling, including the PRO PIN-failure lockout, keeps
  `pro.join_rate_limited` / `_later` unchanged. No key became unused.
- Tests: `setup-network-error.test.ts` (600 s, 61 s, 0 s and no wait, the
  rounded-up count, and the PRO keys never used for this error);
  `plural.test.ts` (registry of 14, English singular and plural, and
  ko/de/ru/pl/ro/ar/cs counts); `factual-translation-contracts.test.ts`
  (one `{{count}}` and no number in the fallback in every locale, a lead that
  differs from the PRO copy, no English fallback, the Korean and English text,
  and the PRO Korean copy kept).
- PWA cache `v654` to `v655` with the `index.html` bootstrap query; the App
  stays `8.10.0`. Against the deployed SHA `d76b1432`, `changedRuntimePaths()`
  now finds 65 App paths (adds `src/i18n/plural-contract.ts` and
  `src/i18n/plural-en.ts`), the same 3 signaling paths and none for the other
  Workers; `changedAppRuntimeDependencies()` is still empty. Release target
  `all` and the recovery steps are unchanged.

Verification at `7f69b8bd` (same machine and dependencies as above; local,
not an exact-main CI candidate):

| Command | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | pass |
| `npx vitest run src/ui src/i18n src/network src/core/__tests__/claim-bootstrap.test.ts` | 146 files, 3,262 passed |
| `npm test` | 538 files, 11,473 passed, 0 failed, 1 skipped (the `jq` contract test, as above) |
| `guard:release-identity` | pass; `8.10.0` / `v655` |
| `guard:sw-cache-version` | pass; `v655` (`7f69b8bd`) covers every committed PWA runtime change |
| `guard:dead-exports` | pass (self-only 79, test-only 21: unchanged baselines) |
| `npm run build:checked` | pass |

The lockout screenshots `std-ko-390x844-light-06-guest-rate-limited.png` and
`std-ko-320x568-light-06-guest-rate-limited.png` in
`scratch/standard-pin-screens/` were re-captured from an e2e build of
`7f69b8bd` with the same page-level Worker stand-in
(`retryAfterSeconds: 540`). Both show "암호를 여러 번 틀렸어요. 9분 후에 다시
시도해 주세요." in the inline join error (one line at 390 px, two at 320 px),
with no page or error-box overflow. The dark and landscape lockout images in
that folder are from `6f0c65a7` and still show the replaced copy. The new
translations have no native-speaker review, and the other locales' lockout
copy was not captured.

## Owner decision B (fail open, `ecdc2e20`)

Owner decision (2026-10-11): after being told that, with IPv6, one person with
one server allocation (a routed /56 holds 256 /64s) could fill all 256 per-room
buckets and lock the shared overflow bucket with about 276 wrong PINs, and so
keep every new guest out of the room indefinitely (renewable every 10
minutes), the owner chose B: the wrong-PIN limiter fails open when its table
is full. A room PIN is a soft access deterrent, and blocking real guests from
an event is worse than a guessed PIN. [known-accepted #12](../known-accepted.md#12-standard-room-owner-pins-kicks-and-guessing)
records the accepted design and its revisit trigger.

Change (`ecdc2e20`, `cloudflare/standard-room-pin-membership.ts` and
`recordStandardPinFailure` in `cloudflare/signaling-worker.ts`):

- The shared overflow bucket and its fixed key are gone. A key that has no live
  bucket while all 256 slots hold other blocks' live buckets is not limited
  and not recorded. `standardRoomPinAttemptLockedFor` reads only the key's own
  bucket, so no attempt can lock any block but its own.
- `recordStandardRoomPinFailure` returns the input record itself for such a
  key, and the Worker then skips the storage write, so an untracked guess
  costs no write.
- Unchanged: keys with a bucket keep 20 wrong PINs per fixed 10-minute window;
  live buckets are never evicted; expired buckets are pruned on the next write
  and their slots reused; the kept-guest and live-binding bypasses; binding
  deletion on a wrong PIN; `room-password-rate-limited` with
  `retryAfterSeconds` and its copy; the `guest_auth_rate_limited` metric; and
  the single HTTP-bridge `unattributed` bucket, which is one key and is limited
  like any other.
- No other path can lock every newcomer: the normalizer bound is now 256
  entries (was 256 + 1), and a record over it or otherwise invalid reads as
  empty; a reset time beyond one window reads as expired; a storage read
  failure admits to the PIN check; a failed write is reported and refuses
  nobody; an attempt without a bucket key (a failed HMAC, or no pepper, where
  a protected room already fails closed at the PIN check itself) is not
  limited.
- The stored table is at most 22,803 bytes of JSON (256 buckets with
  43-character keys, count 20 and 13-digit reset times), down from 22,892 with
  the overflow entry; a unit test pins 256 entries and 24 KiB.
- Compatibility: no wire, key or schema change, no contract marker. This
  branch is not deployed, so no stored table has the overflow entry; if one
  did, a 257-entry table would read as empty, and an overflow entry among at
  most 256 would be an ordinary bucket that no HMAC attempt key matches,
  gone within 10 minutes.
- Release identity is unchanged: App `8.10.0`, PWA cache `v655` (no PWA runtime
  file changed; `guard:sw-cache-version` passes), the same 3 signaling paths,
  release target `all`.

Tests: `standard-room-pin-membership.test.ts` replaces the overflow cases with
fail-open cases (a 257th and later block is not counted or locked after many
wrong PINs and the record object is returned unchanged; attackers spread over
257, 276 and 1,000 blocks that each guess for 40 rounds (tracked blocks until
refused) cannot keep a fresh block out, before or after its own typo; a tracked block still locks at 20
while the table is full; an expired bucket frees a slot that a new block then
fills and can lock; an oversized in-memory table is pruned; the round-robin
locks only tracked blocks; corrupt and oversized tables, up to 10,000 entries,
read as empty; and the size bound). `cloudflare-signaling-worker.test.ts` adds
two Worker cases: 256 /64s of one /56 fill the table with one wrong PIN each,
then 25 wrong PINs from a 257th /64 are refused only as wrong, write nothing
and change nothing, fresh IPv6 and IPv4 guests are admitted with the right
PIN, and a tracked /64 still locks at 20; and a seeded table of 256 locked
buckets, or a 257-entry record, locks no newcomer, including bridge
(`unattributed`) guests. The four fail-open unit cases and both Worker cases
fail against the previous limiter (`250e455f`), and the first Worker case
fails when the skipped write is removed.

Attack scripts (the reviewer's round-robin script, one wrong PIN per block in
turn, 1 ms apart, 200 rounds; and a newcomer-lockout script written for this
decision, one wrong PIN per attacker block per round, skipping refused blocks,
then a check of a fresh block; both in the local scratch folder, not in the
repository), run against the pure limiter before and after:

| Scenario | Before (`250e455f`) | After (`ecdc2e20`) |
| --- | --- | --- |
| Round-robin, 256 blocks | 5,120 accepted, 46,080 refused | 5,120 accepted, 46,080 refused |
| Round-robin, 257 blocks | 5,140 accepted, 46,260 refused | 5,320 accepted (the 257th block unlimited), 46,080 refused |
| Round-robin, 1,000 blocks | 5,140 accepted, 194,860 refused | 153,920 accepted (744 blocks unlimited), 46,080 refused |
| 277 blocks, 1 wrong PIN each, then a fresh block | 276 accepted, 1 refused; fresh block locked for 599,979 ms | 277 accepted, 0 refused; fresh block not locked, its own wrong PIN not recorded |
| 1,000 blocks, 20 rounds, then a fresh block | 5,140 accepted; fresh block locked for 580,256 ms | 20,000 accepted; fresh block not locked |

The refusals after the change all fall on the 256 tracked blocks (256 × 20 =
5,120 accepted from them). The cost the owner accepted is visible in the 257-
and 1,000-block rows: blocks past the table guess without limit.

Verification at `ecdc2e20` (same machine and dependencies as above; local, not
an exact-main CI candidate):

| Command | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (zero warnings), `npm run format:check` | pass |
| `npx vitest run src/network src/core/__tests__/*signaling* src/core/__tests__/ci-quality-gates.test.ts` | 57 files, 1,523 passed |
| `npm test` | 538 files, 11,478 passed, 0 failed, 1 skipped (the `jq` contract test, as above) |
| `npm run test:coverage:workers` | 38 files, 2,089 passed; thresholds met (84.87 / 81.46 / 93.15 / 89.39) |
| `npm run check:workers` | pass |
| `guard:sw-cache-version` | pass; `v655` (`7f69b8bd`) still covers every committed PWA runtime change, so no cache bump |
| `guard:release-identity` | pass; `8.10.0` / `v655` |
| `npm run build:checked` | pass, including `guard:legacy-tv-build` and `guard:sw-app-shell` |

Limits: the limiter was exercised with unit tests, Worker tests against the
fake Durable Object storage and the local scripts above, not against a live
Durable Object, real IPv6 traffic or production. The HTTP-bridge
`unattributed` bucket is still shared by every bridge guest of a room, as the
decision kept it. Twenty wrong PINs over the bridge lock it, and the lock is
not limited to one window: anyone who knows the room code and can open bridge
sessions (a Standard signaling capability allows 8 opens a minute) can renew
it every 10 minutes for as long as they continue. While it holds, fresh guests
who reach the room through the HTTPS bridge fallback (both WebSocket routes
failed before admission) are refused even with the right PIN; WebSocket
newcomers, kept devices and devices with a live binding are not affected, and
the host can turn protection off. Other admission limits (the per-IP
WebSocket-open limit, pending-guest slots and the 99-guest ceiling) are
outside this change.

### Review follow-ups (decision B)

A review of `ecdc2e20` and `315260b8` raised three findings; the two in the
repository are documentation fixes, and the limiter code is unchanged.

1. **The revisit trigger could not fire on the accepted attack (should-fix).**
   known-accepted #12, the ops runbook and the release record named only
   "Password lockouts" (`guest_auth_rate_limited`) as the guessing signal. That
   event is recorded only when a key's own bucket is locked, so guesses from
   blocks past the 256-entry table, or kept under 20 per tracked block, never
   produce one; in the 1,000-block round-robin above, the 744 untracked blocks
   make 148,800 accepted guesses without a lockout. Every wrong PIN that
   reaches the PIN check records `guest_auth_failed`, shown as "Password
   failures" in the Signals panel and counted in the Operations "Password
   issues" card. The three documents now name a spike there (or abuse reports)
   as the main trigger and keep lockouts as a secondary signal. A separate
   metric for untracked guesses was not added: it would be a 19th admin event
   across the signaling Worker, the App Worker catalog, the admin runtime and
   their tests, while "Password failures" already counts those guesses.
2. **The HTTP-bridge lockout was described as lasting one window (minor).**
   The limits above, known-accepted #12 ("Shared networks") and the ops
   runbook now say that anyone who can open bridge sessions can renew it every
   10 minutes, that it refuses only fresh guests who reach the room through the
   bridge fallback, and what still works (live bindings, kept devices,
   turning protection off). The bucket itself stays as the owner decided.
3. **The PR description was stale (minor).** It still described the overflow
   bucket, the pending owner acceptance and cache `v654`; it is replaced when
   the branch is pushed. This is outside the repository.
