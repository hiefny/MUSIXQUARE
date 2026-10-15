# Host presence and keep-open guidance — 2026-10-16

## Scope and evidence

The owner reported that a Standard room "breaks" when the host's app goes to
the background: an administrator's playback commands do nothing, and chat was
suspected too. A Standard room lives in the host's browser tab, so two cases
were traced in code:

- **Host hidden but running** (a desktop tab in the background, a phone just
  switched away). The tab still answers pings and relays chat, but
  `_internalPlay` returns false while the foreground audio-clock check sees a
  hidden page. Local-file play, track changes and seeks while playing failed
  without a word. Pause worked.
- **Host frozen** (a locked phone, a suspended tab). Nothing on the host page
  runs. Guests pinged every second, but nothing watched for answers, so only a
  dropped connection plus its grace period was ever noticed. Commands and chat
  went into silence.

Owner decisions (2026-10-16):

- Refuse what cannot work and say why, instead of failing silently.
- No banner (not a design-system component) and no chat system messages. Use
  the app header loader instead, as the top-priority loader, with one text for
  both cases ("방장 응답 대기 중..."). Its bar stays at 0, like a preparing
  loader.
- The account pill must stay visible and usable while any loader shows. The
  progress fill runs behind it, and long loader text ends with an ellipsis
  before it.
- No tip toast for the host at room start, and the help card stays as it was.
- First-time visitors get one dialog asking them to keep the app open when the
  room's first media appears, with the same first-time rule as the demo
  prompt. The title uses a request tone ("앱을 켜 둔 채로 사용해 주세요").
- Copy as reviewed on the owner's screenshot review page.

## Change

Protocol (Standard rooms only; PRO rooms are untouched):

- The host adds `hostHidden: true` to each `sync-pong` while its tab is hidden.
  Every reply carries the current state, so a guest heals with the next reply
  even after a resumed host's burst of queued frames trips the inbound rate
  limit. (A one-shot "visible again" message was tried first and was lost that
  way in a two-browser run.)
- A hidden host refuses an operator's command that would start or move
  local-file audio (`request-play`, `request-track-change`, next and previous
  on a file item, and seek or skip while a file plays) and replies
  `host-command-rejected`. Pause, a paused seek, YouTube commands, playlist
  edits and chat still run. YouTube is left alone because a hidden desktop
  tab may keep playing it.
- A guest treats 5 s without any frame from its host connection as an
  unresponsive host, once the join has finished and while the guest itself is
  on screen. Until a frame arrives, `safeSend` holds room commands (playback,
  playlist edits, uploads, repeat/shuffle, kicks, demo, chat) and shows a
  toast. Pings, file chunks and recovery requests keep flowing.

Guest interface:

- The header loader shows "방장 응답 대기 중..." in front of any other loader:
  after 2 s for a hidden host, so a quick app switch does not flash it, and at
  once for a silent one. The loader the guest had before comes back when the
  host returns, with a "방장 기기가 돌아왔어요" toast. A new or closed
  connection releases the loader without a toast.
- Toasts: "방장 기기가 백그라운드에 있어요 / 방장이 앱을 다시 열면 조작할 수
  있어요" for a refused command; "메시지를 보낼 수 없었어요 / 방장 기기가
  응답하지 않아요" for held chat; "요청을 보낼 수 없었어요 / …" for other held
  commands and for queue or upload requests that time out while the host is
  silent.
- After 60 s without a frame, one dialog offers to keep waiting or leave the
  session. It closes by itself when the host answers again.

Everyone:

- First-media dialog, for visitors with no app-use record at boot: shown once
  when the room's playlist first holds media, after any running demo, in
  Standard rooms only.
- Header loader: only the logo yields to the loader. The account pill and help
  button stay; `--header-actions-inset` (measured from `.header-right`)
  shortens the loader text. The design-system loading-header sample keeps its
  pill too.

Strings: ten new keys in all 42 locales (`network.host_waiting`, four
`toast.*`, five `dialog.*`). Translations follow each locale's existing words
for host, session, sync and background, keep English line breaks, end toast
lines without periods, and follow each locale's loader ellipsis style.

Release identity: 8.10.25, cache epoch v691.

## Compatibility

- Old guests ignore `hostHidden` and `host-command-rejected`. With a new host
  they behave as before, except that a refused command is now not run (it
  failed anyway).
- New guests with an old host get the silence detection, the loader for a
  frozen host, the held-command toasts and the dialog. They never see the
  hidden-host state, because old hosts do not mark their replies.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium.

Tested source: **`cd92242a`** (8.10.25, cache epoch v691), branch
`agent/host-liveness`, clean tree. These are local and branch results, not the
exact-main release candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 566 files, **12,766 passed / 0 failed / 0 skipped**, 197.71 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed |
| `guard:dead-exports`, `guard:room-authority-boundaries`, `guard:import-graph`, `guard:bus-pairing`, `guard:lifecycle-writes`, `guard:source-complexity` | Passed |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v691 covers every runtime change) |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.3 min |

New unit coverage: `src/network/__tests__/host-presence.test.ts` (silence and
hidden states, held commands, the host's refusal through `handleData`, ping
reply marking, PRO isolation) and `src/ui/__tests__/keep-open-notice.test.ts`
(first-media dialog rules, loader timing, return toast, leave offer). Loader
priority and the pill inset are pinned in `src/ui/__tests__/toast.test.ts`.

Two-browser scenario (Korean UI; mobile dark, mobile light and desktop): a
first-time host and guest, the long-text loader beside the pill, the
first-media dialog, the hidden host (simulated by overriding
`document.visibilityState`), a refused play, the host's return, a frozen host
(simulated by pausing the host page's JavaScript with the Chrome debugger, so
the connection stays up), held play and chat, the 60 s dialog and the
recovery. All runs passed, and the owner reviewed the screenshots before
release. The capture script was temporary and is not committed.

## Limits

- No real device was tested. Phone locking, iOS page suspension and Android
  background limits were simulated, not observed.
- A hidden host does not refuse YouTube commands. Where its iframe cannot play
  in the background (typically mobile), those commands still fail silently,
  as before.
- Next and previous are refused when the current item is a local file, even
  if the next item would be YouTube, and allowed from a YouTube item even if
  the next item is a file.
- A host whose replies are delayed more than 5 s by a congested link shows the
  waiting loader briefly, followed by the return toast.
- The first-media dialog is not shown in PRO rooms (owner question open).
- Translations were not reviewed by native speakers.

## Release and recovery

App-only release (`target=app`). Recovery is the ordinary Production Release
rollback to the 8.10.24 checkpoint, which removes the loader, toasts, dialogs
and the new protocol fields together. Mixed versions stay compatible in both
directions.
