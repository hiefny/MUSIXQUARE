# PRO join error copy — 2026-10-11

Status: implemented and verified locally on branch `agent/pro-join-error-copy`.
Not merged or deployed. Production remains `8.8.0` / `v646` at `6e59d96c`
([release record](../release-record.md)).

## Scope

[PRO admission protection](pro-room-admission-protection-2026-10-11.md) (#289,
PRO Worker only) added two refusals that the App showed only as the generic
`pro.connect_failed` ("Could not connect to the PRO room."):

- `ROOM_FULL` 409 from `POST /v1/rooms/{code}/sessions` (fresh admission) and
  from `POST /presence/enter` (cookie resume). A PRO room holds at most 100
  presences and at most 99 of them may be non-owners, so a non-owner is
  refused at 99 while the owner is absent.
- `RATE_LIMITED` 429 with `Retry-After` (1–600 s) after 200 successful
  non-owner admissions per room and network in 10 minutes.

The session endpoint already returned the same `RATE_LIMITED` code for the
PIN-failure lockout (10 wrong PINs per hour and network, `Retry-After` up to
3,600 s) and, with a 60 s fallback, when the room's rate-limit ledger is full.
The existing `network.session_full*` copy describes standard rooms ("the
maximum of 100 connected devices, including the host") and is unchanged.

## Change

`describeProRoomJoinFailure(error)` in `src/pro-room/setup-flow.ts` maps a
failure of `enterProRoomFromSetup` to the setup-screen message.
`_handleProRoomJoin` in `src/ui/setup-guest.ts` passes it as the
`setup:guest-join-failure` user message. The inline error keeps its Retry
action and renders line breaks (`white-space: pre-line`).

| Failure (`ProRoomApiError.code`) | Message |
| -------------------------------- | ------- |
| `ROOM_FULL` from a fresh admission, a PIN admission, a cookie resume, or a takeover resume | `pro.room_full`, a line break, then `pro.room_full_detail` |
| `RATE_LIMITED` with `retryAfterSeconds` above 0 | `pro.join_rate_limited` with `count` = `ceil(seconds / 60)` |
| `RATE_LIMITED` without `Retry-After`, or with 0 | `pro.join_rate_limited_later` |
| Anything else: timeouts, 5xx, transport errors, other 4xx, an uncoded `HTTP_429`, untyped errors | `pro.connect_failed` (unchanged) |

- Rounding up means the shown wait is never shorter than the server's.
  `parseRetryAfter` already accepts only whole seconds from 0 to 3,600, so the
  shown wait is 1 to 60 minutes.
- The rate-limit text says "Too many join attempts" and does not name the
  network. The same code also covers the PIN lockout and the room-wide ledger
  capacity, and the wording is true for all three.
- Unchanged: pending admission-id handling (both refusals are definitive 4xx
  and already clear it), claim flows (activation, recovery, and transfer keep
  their own dialogs), chat and playlist uses of `pro.connect_failed`, and the
  standard-room `network:session-full` dialog.

`.setup-inline-error` uses `word-break: keep-all`, which forbids line breaks
inside a Japanese kana and kanji run. Without an override, the Japanese
room-full detail was laid out as one 346 px line and clipped by the setup
area at every phone width. `html:lang(ja) .setup-inline-error` now joins the
existing Japanese override group in `css/style.css` (`word-break: normal`,
`overflow-wrap: anywhere`, `line-break: strict`) that the other keep-all
setup copy already uses. This also lets existing Japanese inline errors such
as `pro.connect_failed`, which was 2 px too wide at 320 px, wrap.

### Copy

Four keys follow `pro.connect_failed` in all 42 locale files. Each locale has
its own translation in its existing register and room/owner terms.

| Key | en | ko |
| --- | -- | -- |
| `pro.room_full` | This PRO room is full | PRO 방이 가득 찼어요 |
| `pro.room_full_detail` | A PRO room holds up to 100 devices, including the owner. One spot is always kept for the owner. | PRO 방에는 방 소유자를 포함해 최대 100대까지 연결할 수 있어요. 한 자리는 항상 방 소유자를 위해 비워 둬요. |
| `pro.join_rate_limited` | Too many join attempts. Try again in {{count}} minutes. (`one`: minute) | 입장 시도가 너무 많아요. {{count}}분 후에 다시 시도해 주세요. |
| `pro.join_rate_limited_later` | Too many join attempts. Try again in a little while. | 입장 시도가 너무 많아요. 잠시 후 다시 시도해 주세요. |

`pro.join_rate_limited` is registered in `PLURAL_PARAM_BY_KEY` on `count`.
Plural overrides: `one` for en, da, de, es, fr, he, it, kn, mr, nb, nl, pt-br,
sv, ta, and te; `one`/`few`/`many` for pl and ru; `two`/`few` for ar;
`one`/`other` (`de minute`) for ro. Locales whose number and noun do not
inflect use the dictionary value only. bg, cs, el, and uk use their existing
unit abbreviations (`мин`, `min`, `λεπ.`, `хв`), as their seconds copy does.

## Release identity and compatibility

- App `8.8.0` → `8.8.1` (patch: product copy) in `package.json`, both lock
  entries, `ADMIN_ASSET_VERSION`, and `ADMIN_SCRIPT_VERSION`. Service-worker
  cache `v647` → `v648`, including the `index.html` bootstrap `?cache=` query.
  If another change takes `v648` first, renumber at merge. The Japanese
  inline-error CSS rule is in the same commit and is covered by this bump.
- App only: no Worker, D1, R2, secret, binding, protocol, contract marker, or
  dependency change. This change alone is release target `app`; the next
  release also carries the undeployed #289 PRO Worker change.
- Older cached clients keep showing `pro.connect_failed` until they update.
  Rolling the App back to 8.8.0 restores that generic message and needs no
  floor or data step.
- This addresses the release record's open item "PRO 입장 오류 문구(App 후속)".
  The record is not edited here; remove that item after merge with this report
  as evidence.

## Verification

Tested code: `8961ff4673d1ca97ef6dd6ec6c3f0c5d78eb3520` on
`agent/pro-join-error-copy`, based on main `a2ba65c6` (#289 merged). Windows
11, Node 24.13.1 / npm 11.8.0. All runs are local; none is the exact-main CI
candidate.

| Command | Result | Time |
| ------- | ------ | ---- |
| `npm run typecheck` | pass | 58 s |
| `npm run lint` | pass, zero warnings | 79 s |
| `npm run format:check` | pass | 82 s |
| `npx vitest run src/pro-room src/ui src/i18n` | 175 files, 3,519 passed, 0 failed, 0 skipped | 65 s |
| `npm test` | 535 files, 11,279 passed, 0 failed, 1 skipped¹ | 159 s |
| `npm run test:coverage:critical` | 57 files, 1,943 passed; thresholds met (all files 81.6% statements, 76.2% branches, 87.79% functions, 85.73% lines) | 55 s |
| `npm run guard:release-identity` | pass; MUSIXQUARE 8.8.1, cache epoch v648 | 1 s |
| `npm run guard:sw-cache-version` | pass; `v648` (`8961ff46`) covers all committed PWA runtime changes | 1 s |
| `npm run build:checked` | pass, including `guard:index-hreflang` (43 links), `guard:sitemap` (93 URLs), `guard:brand-capitalization` (763 copy sources), and the initial transfer budget (entry 126.5 KiB gzip) | 31 s |
| `guard:bus-pairing`, `guard:dead-exports`, `guard:import-graph`, `guard:standard-room-hot-path`, `guard:chunk-pump`, `guard:lifecycle-writes` | pass | — |
| Phone-width check of the built `dist` (headless Chromium from Playwright) | 2,350 measurements, 0 overflows² | 2 min |

¹ The `release-deployment-state` shell-plan contract test skips when `jq` is
not installed. It does not exercise this change.

² A local script served the `build:checked` output, opened each of the 42
localized app documents at 320, 360, 375, 390, and 414 px wide, and filled the
real `#setup-guest-error` and `#setup-auto-join-error` elements with the
room-full message (title and detail), the timed rate-limit message with waits
of 10 and 60 (base form and every plural variant), the untimed rate-limit
message, and `pro.connect_failed`. Each measurement compares the element's
`scrollWidth` with its `clientWidth`. An earlier run of the script, on the
build made before the CSS change and without the 60-minute and plural rows,
covered ja, ko, zh-hans, zh-hant, and en. It found 14 overflows, all Japanese:
the room-full message at all five widths in both elements (346 px of text in
a 208–302 px box), and the untimed rate-limit message and
`pro.connect_failed` at 320 px.

The translation-community catalogs (`assets/translation-catalog-*.json`) are
generated from the locale files during `vite build`, and the built catalogs
carry the four new keys. No committed catalog or `generate:*` output needs
regeneration.

New or changed tests:

- `src/pro-room/__tests__/setup-flow.test.ts`: `ROOM_FULL` from a fresh
  public-room admission, a PIN admission, and a cookie resume (pending
  admission id cleared; no PIN prompt after a refused resume). `RATE_LIMITED`
  with `Retry-After` 125 s (3 minutes) and 3,600 s (60 minutes); rounding at 1,
  59, 60, 61, 599, and 600 s; missing and zero `Retry-After`. Eight other
  failures and one other refused admission keep `pro.connect_failed`.
- `src/ui/__tests__/setup-guest-recovery.test.ts`: the setup screen shows the
  described message for `ROOM_FULL` and `RATE_LIMITED` and keeps Retry.
- `src/ui/__tests__/app-ux-contract.test.ts`: `.setup-inline-error` keeps
  `keep-all`, and `html:lang(ja) .setup-inline-error` sets `word-break:
  normal`, `overflow-wrap: anywhere`, and `line-break: strict`. The pin fails
  without the CSS change.
- `src/i18n/__tests__/plural.test.ts`: English `one`/`other`; ko, de, ru, pl,
  ro, ar, and cs minute forms at plural boundaries; plural registry 12 → 13.
- `src/i18n/__tests__/factual-translation-contracts.test.ts`: in all 42
  locales the capacity detail contains only the number 100, both room keys
  keep `PRO`, the timed message has exactly `{{count}}`, the fallback has no
  number, and no new value copies English. The standard-room detail is
  unchanged.

## Limits

- Only headless Chromium on Windows was measured; no real device, WebKit
  (iOS Safari), or Firefox. External requests were blocked, so text used the
  fonts served from the build or installed on the test machine. The check
  compared element widths and nobody reviewed screenshots. It filled the
  elements directly and did not drive a refused join through the UI.
- The width check filled `pro.join_rate_limited` and each of its plural
  variants with two-digit waits (10 and 60), whatever plural category the
  number really selects. It did not try every count from 1 to 60.
- The 41 non-English translations were written for this change and checked by
  the catalog contracts, not reviewed by native speakers.
- The refusals were not produced by a running PRO Worker. The codes and
  `Retry-After` range come from #289 and its Worker tests; `parseRetryAfter`
  is covered by the existing API tests.
- An owner whose session was demoted in place can still get `ROOM_FULL` (see
  the #289 report) and then sees this copy too.
