# PRO upload completion and authority feedback — 2026-10-27

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                | 배포됨. [PR #503](https://github.com/hiefny/MUSIXQUARE/pull/503) head `6064a195`를 2026-10-27 13:28 KST에 squash `53a66d65`로 머지했고, exact-main CI 40449960573 뒤 [Release 40450793853](https://github.com/hiefny/MUSIXQUARE/actions/runs/40450793853)으로 13:42 KST에 배포했다(QA 라운드 10). 남은 것은 게이트가 아닌 배포 뒤 확인이다(release-record §2) |
| Base                  | Initial `cb1598516`; integrated main `5dd7cc1f6` (#502, 9.0.15 / v788) in `4a99f44ba`; 5B 기록 main `0228276e2`(#506, 운영 9.0.16 / v789)를 QA 라운드 7에서 합침. squash `53a66d65`의 트리는 `6064a195`와 같고 부모는 `0228276e`다                                                                                                                            |
| Identity              | 9.0.17 / v790(앱 빌드 790)로 배포됨. bump `a233dd7b7`(5B 합침 뒤 올린 `28178b15f`를 QA 라운드 9 수정 뒤에 다시 만듦, 그 전 PR의 9.0.16 / v790 표기는 버림)이 마지막 런타임 커밋이다. 최소 앱 빌드 787 그대로                                                                                                                                                  |
| Scope                 | Browser PRO uploads, completion deadlines, bounded diagnostics, Standard/PRO authority feedback                                                                                                                                                                                                                                                               |
| Release authorization | 2026-10-27 오너가 5B 다음 순서로 이 PR의 병합·배포·기록을 정식 릴리스 절차대로 진행하도록 승인함                                                                                                                                                                                                                                                              |
| Deploy target         | target `all`, Developer API D1 `false`, `raise_app_build_floor` `false`. 운영과 견준 런타임 경로 변경은 App 61, PRO room 3, signaling 1, remote-share·Developer API·Developer API facade 0이다(QA 라운드 8·9). 여섯 Worker 모두 이 SHA의 새 버전으로 배포됐다(QA 라운드 10)                                                                                   |
| Operations            | 배포 전 운영에서 한 것은 QA 라운드 1의 진단(그때 운영 9.0.14 App, 릴리스 W Worker)뿐이다. 배포 뒤: Release 40450793853(여섯 Worker `53a66d65`), 공개 GET과 최소 빌드 읽기, Operations Drift Audit 40451713399(QA 라운드 10). 실제 수정본의 운영 업로드, 실제 R2 CopyObject와 `media_copy` 기록, 실기기는 확인하지 않았다(아래 한계)                           |

## Runtime increments

1. **Keep the file copy inside R2.** Browser completion sends a bounded,
   server-authenticated CopyObject request with a durably pinned staging ETag as
   a condition. The Worker no longer reads and retransmits the full file
   unless the copy leaves no verified final object; then completion falls
   back to the 9.0.16 binding copy (see 복사 안전장치 below).
   Completion retains serialized authorization, generation, quota and
   idempotency checks, a distinct final key, and final HEAD validation.
   The copy budget is 8 seconds and the completion facade budget is 10 seconds;
   both come from `cloudflare/pro-room-media-timing.ts`. Other control requests retain
   5 seconds and the browser retains its 15-second control budget.
   Developer API completion retains its existing stream-copy path. No new
   job, polling protocol, service binding or D1 schema is introduced.
2. **Resume the existing file attempt.** The queue task owns its RAM-only
   continuation. An explicit retry uses the original asset and completion
   key/body after a successful PUT; a completed asset is reused for insertion.
   Canonical reconciliation prevents duplicate queue entries. Uncertain
   completion/insertion is left to existing server orphan cleanup, not
   immediate client deletion. Reset and authority retirement release local
   state. Upload-idle deadlines remain unchanged.
3. **Explain terminal input failures.** A zero-byte or over-limit file never
   reaches reservation/PUT, carries its reason to the dialog, and is excluded
   from retry. Other selected files continue. The header distinguishes byte
   transfer from completion confirmation. Missing/expired asset continuations
   ask for file selection instead of offering an ineffective retry, and so does
   a playlist switch before insertion, because a retained retry stays pinned to
   its original playlist (6차부터 이때 이미 올린 asset을 바로 해제한다). Each
   failed file gets one dialog sentence for the code
   the client or Worker produced. New copy is present in 42 locales. Long
   failure lists reuse the reading dialog's internal scroll; dialog height is
   bounded by its actual overlay on short/mobile screens.
4. **Pending authority is not denial.** PRO account reconciliation projects
   pending feedback with no usable capabilities; confirmed revocation remains
   denied. Standard assertion work waits for the matching signaling identity
   and a fresh host roster after its ordered grant/revoke projection. Standard
   and PRO button titles/ARIA descriptions consume the same
   permission status as blocked-action toasts and refresh when it changes.
5. **Useful bounded diagnostics.** App proxy failures identify
   `media_reserve` and `media_complete` instead of `other`.
   Existing failure sampling and credential-free allowlists remain in force.

## Design evidence and safety

Cloudflare documents CopyObject and its source ETag condition in the
[S3 compatibility reference](https://developers.cloudflare.com/r2/api/s3/api/).
The [consistency reference](https://developers.cloudflare.com/r2/reference/consistency/)
explains why a negative read does not exclude a late in-flight upload. The
separate staging/final-key contract and its existing expiry/tombstone owner
therefore remain intact: a reusable upload URL cannot replace bytes returned
by an already-issued final download URL after deletion.

`RoomAsset.completionSourceEtag` is persisted before the first copy. Retries
use that same source identity; final metadata records `mxqr-copy-source-etag`.
An uncertain response never authorizes a retry from replacement staging bytes.
`StagingTombstone.finalObjectKey` lets the existing alarm cleanup also collect
a final object committed after a timed-out copy and later deletion. These are
additive private fields, not a new storage owner or public protocol.

Completion requires the creator's active authorized presence and checks
reserved bytes, MIME, room, generation, asset, version and optional SHA metadata.
It does not newly claim to hash the body. Existing R2 objects are not migrated.
The 200 MiB per-file and 1 GiB room limits are unchanged.

The upload queue remains the owner of user retries, media-transfer performs
one stage, and the room Durable Object remains the sole metadata/cleanup owner.
No independent retry scheduler is added. Header confirmation uses the
existing named loader holder (RO-47); account reconciliation remains the source
of pending authority.

## QA rounds

### 1. Production diagnosis (unchanged 9.0.14 App / a3893f04 Workers)

- Windows in-app browser, authorized PRO room, 2026-10-27 06:10 KST.
- A 171,657,316-byte WAV reached the control completion request and the UI
  reported failure. Live App logs recorded `media.complete`,
  `upstream_timeout`, `reason=response`, HTTP 502 at 06:10:53 KST.
  The same room's heartbeat recorded a response timeout at 06:10:59 KST.
- A 757,241,205-byte FLAC was rejected locally with
  `PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID`, but the UI showed only a generic
  failure count and Retry. This is a reproduced feedback defect.
- These observations prove completion-response timeout and misleading input
  feedback. They do not separately measure copy time versus queue wait.
- No production code, CORS, credentials or deployment was changed. Neither
  attempt appended a playlist row. Screenshots and sanitized logs are private;
  the public report contains no room, account, file-name or credential data.

### 2. Development and integration checks

Environment: Windows, Node 24.20.0, npm 12.0.2, Vitest 5.0.3, local Chromium.
The integration round began at `c50a0d9c8` after incorporating main `5dd7cc1f6`.
Its full run had 675/680 files and 16,099/16,112 assertions pass. Failures exposed
stale tool/fixture expectations and one unused export: runtime path mapping,
the critical-browser script list, dialog sizing, cache bootstrap parity, and
duration-test R2 metadata/copy stubs. These were corrected before the final
runtime commit. Some corrections overlapped that diagnostic run, so it is not
an immutable candidate result.

The integrated build's critical Chromium suite passed 65/65 cases, including
four new upload cases, playback, background recovery, and host/guest flows.
The file-reason dialog was also inspected on desktop and a short mobile
viewport; long lists scroll internally and the Close action remains reachable.
This local browser run preceded the last Standard authority feedback fixes;
the final-SHA CI browser gate below covers the resulting runtime.

Independent review then found two Standard feedback regressions: a pending
account assertion must not mask an existing host grant, and a trusted explicit
host revoke must end the pending state. Both were fixed with regression cases.
The final focused authority run passed 131/131 assertions in five files.

### 3. Frozen runtime verification

Tested code: `f2f25d902c1f36b0d8df7a45f3871f9e7c563104`
(9.0.16 / v790). Environment: the pinned local toolchain above, plus GitHub CI.
Later report-only commits do not change this runtime evidence.

- **Full local unit run:** 678/680 files and 16,110/16,112 assertions passed.
  Two release-tooling tests exceeded their existing 30-second and 15-second
  wall-clock limits while other local checks were running. Both passed in an
  isolated, single-worker rerun at the same SHA (2 passed; 142 unrelated cases
  skipped because the full run had already covered them). No timeout was
  increased and no product assertion failed. Thus every one of the 16,112
  assertions passed across the full run and those two isolated reruns; the
  first full invocation itself was not green.
- **Types and static checks:** typecheck, lint, formatting, App Worker syntax,
  Developer API boundary, D1 contract, operations drift contract and resource
  ownership checks passed. The ownership registry retains 48 records; the
  room-authority guard remains at 81 reads / 22 subscriptions / 13 writes after
  integration, with only the existing feedback repaint fingerprints updated.
- **Production build:** `npm run build:checked` passed, including source,
  release identity and service-worker cache guards. Eager JavaScript is
  455.7 KiB gzip; minimum budget headroom is 5%; 96 app-shell assets were built.
  This is a local artifact, not a deployment.
- **Worker bundles:** all six Worker dry-run bundles passed on the integrated
  tree; no Worker runtime changed between that check and the frozen SHA.
- **GitHub CI:** [run 40407895179](https://github.com/hiefny/MUSIXQUARE/actions/runs/40407895179)
  tests the frozen SHA. Both unit shards, critical browser gate, production
  release candidate, static checks, lint/format, types/source guards, Worker
  runtime coverage, release-tooling coverage, critical runtime coverage and
  broad unit coverage all passed: 11/11 checks. Subsequent report-only commits
  may start another CI run; the PR check state is authoritative for that head.
- **Automated review:** the [PR #503 automated review summary](https://github.com/hiefny/MUSIXQUARE/pull/503#issuecomment-6428202976)
  records completed code review at this SHA with no findings. This is not a
  claim that a separate security review ran.

Local logs and screenshots remain in ignored private notes. Neither local
results nor PR CI replace the exact-main-SHA candidate required after merge.

### 4. 복사 안전장치 개발 검증

테스트한 코드: `13192c3cb`(9.0.16 / v790 표기 그대로, 아래
[복사 안전장치](#복사-안전장치-바인딩-대체-경로와-복사-진단)). 환경: Windows,
Node 24.20.0, npm 12.0.2, Vitest 5.0.3, 로컬 실행만. 실제 R2와 자격 증명은 쓰지
않았다.

- **테스트 먼저:** `b122e4028`의 새 경우와 바뀐 경우를 PR 코드 `7c574da7`에서
  돌리면 26개가 실패하고 나머지 506개는 통과했다(PRO 방 Worker·진단 두 파일).
  같은 테스트는 `13192c3cb`에서 532개 모두 통과했다.
- **단위:** `src/pro-room` 전체, App facade 진단(`pro-room-proxy-diagnostics`),
  `src/i18n` 전체(토스트 문구 정책 포함): 132개 파일, 3,028개 모두 통과. 업로드
  큐와 자원 소유권 가드 테스트도 따로 다시 돌려 통과했다.
- **Worker 묶음:** `vitest.workers.config.ts` 커버리지 실행이 67개 파일, 3,218개
  모두 통과했고 파일별 커버리지 하한을 지켰다.
- **정적 검사:** `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`,
  `format:check`, dead-exports, import-graph, bus-pairing, room-authority,
  resource-ownership 가드가 통과했다. room-authority 수치는 그대로이고
  resource-ownership은 RO-52를 더해 49개 기록이다.
- **돌리지 않은 것:** 전체 단위 실행, critical 브라우저 묶음, 운영 빌드, Worker
  dry-run 번들, PR CI. 실제 R2 CopyObject 응답, 운영 복사 지연, 운영 진단 출력도
  확인하지 않았다. 대체 경로 성공은 가짜 R2로만 확인했다.

### 5. 재시도·실패 안내 정리(H2)

테스트한 코드: `3dfca673c`(9.0.16 / v790 표기 그대로). 환경: Windows, Node
24.20.0, npm 12.0.2, Vitest 5.0.3, 로컬 Chromium, 로컬 실행만.

바뀐 동작:

- **재생목록 전환은 재시도하지 않는다.** 남겨 둔 재시도는 처음 업로드를 시작한
  재생목록 칸에 묶여 있다. 그래서 다른 재생목록이 활성화된 뒤의
  `PRO_ROOM_PLAYLIST_SWITCHED`는 방이 그 재생목록에 머무는 동안 다시 시도해도 같은
  이유로 실패했다. 이제 업로드 큐가 이 실패를 끝난 실패로 보고 다시 시도 버튼을 내지
  않는다. 안내는 다른 재생목록이 활성화됐으니 파일을 다시 선택하라고 말한다. 이미
  올린 asset은 기존 서버 고아 정리(15분 유예)가 치우며, 새 재시도·정리 흐름은 없다
  (6차에서 클라이언트가 바로 해제하도록 바꿨다).
- **실제로 생기는 코드만 연결한다.** 실패 안내가 어디서도 만들지 않는 코드
  (`PRO_ROOM_PLAYLIST_CAPACITY_EXCEEDED`, `PRO_ROOM_PLAYLIST_STATE_CAPACITY_EXCEEDED`)를
  보고 있어서 재생목록 가득 참과 방 상태 용량은 일반 문구로 나왔다. 이제
  `PRO_ROOM_PLAYLIST_LIMIT_REACHED`·`PLAYLIST_CAPACITY_EXCEEDED`·`REQUEST_TOO_LARGE`는
  재생목록 가득 참, `ROOM_STATE_CAPACITY_EXCEEDED`는 기존 토스트와 같은 뜻(재생목록이
  바뀌었으니 다시 시도)으로 안내한다(6차에서 방 용량 문장과 끝난 실패로 바꿨다).
  연결은 `upload-failure-dialog.ts`의
  `describeProRoomUploadFailures` 한 곳에 있고, 테스트가 그 안의 코드마다 PRO 클라이언트나
  Worker의 생성 지점이 있는지 확인한다.
- **대화상자 문장만 쓴다.** 실패 목록이 토스트 문구(마침표 없음, 문장마다 줄바꿈)와
  대화상자 문장을 섞어 썼다. 파일마다 한 줄, 이유는 대화상자 문장 하나다. 새 키 6개
  (`pro.upload.file_too_large`·`quota_exceeded`·`playlist_full`·`playlist_changed`·
  `playlist_switched`·`permission_required`)와 줄 형식 `pro.upload.failed_file`을
  42개 언어에 더했다(`playlist_changed`는 6차에서 지웠다). 일본어·중국어는 전각
  콜론, 프랑스어는 기존처럼 좁은 줄바꿈 없는 공백 뒤 콜론을 쓴다.
- **로케일 용어 맞춤.** 이 PR이 더한 업로드 문구만 고쳤다. fi·uk는 앱의 다운로드
  단어 대신 기존 업로드 단어(lähetys, надсилання), fr은 importation 대신 envoi, ko
  머리글은 행과 같은 "업로드 확정 중", bg·tr은 나머지 문구와 같은 반말 명령형이다.
  같은 종류의 어긋남이 있던 el(μεταφόρτωση 대신 αποστολή)과 pt-br(upload 대신
  envio)도 같이 맞췄다.
- **Standard 확인 중 안내 연결 테스트.** `peer.ts`의 `room-identity` 처리에서
  권한 확인으로 넘기는 연결을 전송 이벤트로 직접 검사하는 테스트를 더했다.
  일치하는 서명 신원은 확인 중을 끝내고, 만료는 유지하며, 명시 해제는 끝낸다.
  교체된 전송과 PRO 방의 신원은 무시한다.

검증:

- **테스트 먼저:** `023483776`의 새 경우를 부모 `4ae6a2a48`에서 돌리면 업로드 큐
  1개와 실패 이유 22개가 실패했다. `peer.ts` 연결 테스트 3개는 부모에서
  통과했고, 그 호출 한 줄을 지우면 2개가 실패했다(나머지 하나는 무시 경우).
  `3dfca673c`에서는 모두 통과했다.
- **단위:** `src/pro-room`·`src/i18n`(토스트 문구 정책 포함)·`src/rooms`·
  `src/network`·`src/account` 222개 파일, 5,600개 모두 통과. critical 커버리지 실행
  87개 파일 3,409개, Worker 커버리지 실행(`vitest.workers.config.ts`) 67개 파일
  3,218개도 모두 통과했고 커버리지 하한을 지켰다.
- **브라우저:** `build:e2e` 뒤 `e2e/pro-upload-recovery.test.ts` 4개가 로컬
  Chromium에서 통과했다. 섞인 실패 화면에서 파일마다 항목 하나가 보이고 두 이유가
  모두 마침표로 끝나는 문장인 것을 스크린숏으로 확인했다.
- **정적 검사:** `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`,
  `format:check`, dead-exports, import-graph, bus-pairing, room-authority,
  resource-ownership, source-complexity, sw-cache-version, release-identity 가드가
  통과했다. room-authority 수치와 자원 소유권 기록 수(49개)는 그대로다.
- **돌리지 않은 것:** 전체 단위 실행, 나머지 critical 브라우저 묶음, 운영 빌드와
  초기 전송 예산, Worker dry-run 번들, PR CI. 새 번역은 사람 검수를 거치지 않았다.

### 6. 검토 지적 정리(H1·H2 후속)

테스트한 코드: `f5d65a7e7`(9.0.16 / v790 표기 그대로). 테스트 먼저 커밋은 `c2bb9e758`.
환경: Windows, Node 24.20.0, npm 12.0.2, Vitest 5.0.3, 로컬 실행만.

바뀐 동작:

- **복사 성공은 반복 상세 예산을 쓰지 않는다.** 전에는 `media_copy` `ok`도 실패와
  같은 창별 반복 상세 예산(4개)을 썼다. 그래서 업로드가 많은 방에서는 성공 기록이
  예산을 채워, 뒤이은 실패와 대체 경로 기록이 분 요약 집계로만 남을 수 있었다. 이제
  성공은 창마다 첫 상세 기록 하나만 남기고 나머지는 분 요약에만 세며, 억제된 기록으로도
  세지 않는다. 반복 예산은 실패와 대체 경로만 쓴다.
- **재생목록 전환은 끝난 실패로 두고, 올린 asset을 바로 해제한다.** 남겨 둔 재시도는
  처음 재생목록이 다시 활성화되면 성공한다. 그런데 이 실패는 언제나 다른 재생목록이
  활성인 상태에서 관찰되고 실패 대화상자는 모달이다. 다시 시도가 통하려면 그 사이에 다른
  관리자가 처음 재생목록으로 되돌려야 하고, 그러면 파일은 사용자가 보고 있지 않은
  재생목록에 들어간다. 그래서 다시 시도 없이 파일을 다시 선택하라는 현재 문장
  (`pro.upload.playlist_switched`)을 유지한다. 다시 선택한 파일은 지금 활성인 재생목록에
  들어가므로 문장과 동작이 맞다. 대신 재생목록 상태 관리자가 이미 완료한 asset을 그
  자리에서 지우고 이어 하기 상태를 비운다. 전에는 서버 고아 정리가 15분 뒤에 치울
  때까지 방의 1 GB 용량에 남아, 바로 다시 올리면 용량 초과가 날 수 있었다. 서버는 어느
  재생목록이든 쓰고 있는 asset의 삭제를 거부하므로(`ASSET_IN_USE`), 응답을 잃은 추가가
  실제로 들어간 경우에도 지워지지 않는다. 앞선 시도가 남긴 asset을 가진 재시도가 업로드
  전에 전환을 만나는 경우도 같다.
- **방 용량 실패를 정확히 안내한다.** `ASSET_CAPACITY_EXCEEDED`(방의 파일 1,024개, 정리를
  기다리는 지운 파일 포함)는 "PRO 방에 트랙을 더 담을 수 없어요."(`pro.upload.room_capacity`)로
  안내하고 다시 시도를 내지 않는다. 트랙을 지워도 서버 정리가 돌기 전에는 자리가 나지 않기
  때문이다. 6차는 `ROOM_STATE_CAPACITY_EXCEEDED`도 방 저장 상태가 한도에 가까운 것으로 보고
  같은 문장에 묶었다. 그러나 업로드에서 이 코드는 대개 방의 영수증 원장이 가득 찬 경우라
  그 문장이 틀렸고, 라운드 9에서 따로 안내하도록 고쳤다. 완료 단계에서 이 실패가 나면
  예약은 기존처럼 만료(15분)까지 용량에 남는다.
  `RESERVATION_CAPACITY_EXCEEDED`(방 32개, 참가자당 8개인 끝나지 않은 업로드 한도)는 그
  업로드가 끝나거나 만료되면 풀리므로 다시 시도를 유지하고, "PRO 방에 끝나지 않은
  업로드가 너무 많아요. 잠시 후 다시 시도해 주세요."(`pro.upload.pending_limit`)로
  안내한다. 두 키는 42개 언어 모두에 더했고, 각 언어의 기존 PRO 방·트랙·업로드·잠시 후
  다시 시도 표현과 말투(bg·tr 반말 명령형 등)를 따랐다. 쓰지 않게 된
  `pro.upload.playlist_changed`는 지웠다. 다른 재생목록 작업에서 나는
  `ROOM_STATE_CAPACITY_EXCEEDED` 토스트(`playlist.mutation_retry`)는 main의 기존
  동작이라 이 PR에서 바꾸지 않았다.

문서만 고친 것(동작 변화 없음):

- **최악의 경우 문구.** 복사 안전장치 절이 최악의 경우가 9.0.15와 같다고 했지만,
  시간 초과 경로는 8초 복사 기한(그동안 방의 변경 대기열을 잡음)에 9.0.15의 바인딩
  전송이 더해진다. 그래서 복사가 시간 초과된 뒤 대체 경로가 2초를 넘기면 facade 시간
  초과가 보인다. 회복은 같은 키 재시도가 저장된 응답을 재생하는 것이다. 보고서,
  RO-52, Worker와 기한 상수의 주석을 고쳤다.
- **"확정된 전제 조건 불일치"의 뜻.** 이제 412 응답 자체가 아니라 바인딩 읽기가 바뀐
  원본을 보여 준 경우다(복사 안전장치 절).
- **ready 삭제 뒤의 늦은 복사.** 대체 경로로 완료한 asset을 ready 상태에서 지운 뒤
  커밋된 복사도 기존 tombstone이 치운다는 테스트를 더했다(부모에서도 통과하는 범위
  보강). 그 경계(staging 키를 놓기까지 최소 1시간, 서명 URL 8초)를 RO-52에 적었다.

검증:

- **테스트 먼저:** `c2bb9e758`의 새 경우와 바뀐 경우를 부모 `dedfc627f`에서 돌리면
  11개가 실패했다(진단 2, 재생목록 상태 관리자 2, 업로드 큐 2, 실패 안내 5). 늦은 복사
  경우와 `RESERVATION_CAPACITY_EXCEEDED` 재시도 유지 경우는 부모에서도 통과한다. 기존
  동작을 덮는 범위 보강이다. `f5d65a7e7`에서는 모두 통과했다.
- **전체 단위 실행:** `f5d65a7e7`에서 `vitest run --maxWorkers=6` 한 번으로 681개 파일,
  16,166개가 모두 통과했다(276.7초). 5차까지 돌리지 않았던 전체 실행이고, 시간 초과나
  단독 재실행은 없었다.
- **나눠 돌린 실행:** `src/pro-room`·`src/i18n`(토스트 문구 정책 포함) 131개 파일,
  3,049개 모두 통과. Worker 커버리지 실행(`vitest.workers.config.ts`) 67개 파일
  3,220개도 모두 통과했고 파일별 커버리지 하한을 지켰다.
- **정적 검사:** `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`,
  `format:check`, resource-ownership, dead-exports, import-graph, source-complexity,
  room-authority, bus-pairing 가드가 통과했다. 자원 소유권 기록 수(49개)와
  room-authority 수치는 그대로다.
- **돌리지 않은 것:** critical 브라우저 묶음, 운영 빌드와 초기 전송 예산, Worker
  dry-run 번들, PR CI. 실제 R2 CopyObject와 운영 진단 출력도 확인하지 않았다. 새
  번역은 사람 검수를 거치지 않았다.

### 7. 5B 합침(2026-10-27)

테스트한 코드: `c29a4c796`에 main `0228276e2`(#506)를 합친 커밋 `d88cbb3b8`(버전
표기는 main의 9.0.16 / v789, bump는 다음 커밋). 환경: Windows, Node 24.20.0, npm
12.0.2, Vitest 5.0.3, 로컬 실행만.

- **합친 것:** main의 세 커밋, 릴리스 A 기록 `1ff7fdf2`(#504), 5B `a930030a`(#505,
  9.0.16 / v789, 2026-10-27 10:18 KST 배포), 5B 기록 `0228276e`(#506). 5B는 시스템
  오디오 수신 슬롯과 그 옛 버전 항목을 바꿨고, 업로드 경로와 PRO Worker 소스는 바꾸지
  않았다(App Worker는 관리자 자산 버전 표기만). 그래서 이 PR의 동작, 기한, 되돌리기
  경계는 합친 뒤에도 같다.
- **글자 충돌:** 버전 표기 둘(`index.html`의 bootstrap 쿼리, `scripts/service-worker-asset.ts`의
  캐시 epoch)은 main의 v789를 따랐다(이 PR의 v790 표기는 버림). `docs/README.md`와
  `docs/release-record.md` §2는 두 쪽을 모두 남기고 이 PR 항목을 5B 배포에 맞게 고쳤다.
  `src/network/peer.ts`, `src/pro-room/runtime.ts`, `cloudflare/app-worker.ts`,
  `scripts/check-room-authority-boundaries.mts`, 자원 소유권 등록부와
  `docs/design/pro-room-architecture-and-operations.md`는 글자 충돌 없이 합쳐졌다.
- **버전 문구:** 이 PR을 9.0.16으로 적은 주석·문서(`cloudflare/pro-room-worker.ts`,
  `cloudflare/pro-room-media-timing.ts`, `cloudflare/pro-room-diagnostics.ts`, PRO 방
  Worker 테스트 주석, RO-52, 이 보고서)는 9.0.17로, 바인딩 복사를 쓰던 마지막 운영
  버전은 9.0.16으로 고쳤다(동작 변화 없음). 지난 QA 라운드의 테스트한 코드 표기는 그대로
  둔다.
- **가드 수치 다시 잼:** room-authority 직접 읽기 80, 구독 22, 쓰기 13(398개 production
  파일). 이 PR은 81이었고 5B가 `system-audio-sfu.ts`의 읽기 하나를 지워 기준이 80이
  됐다. 자원 소유권은 48개 기록, 443개 production 파일이다(이 PR의 RO-52를 더하고 5B가
  RO-41을 지움). main은 RO-52를 쓰지 않았으므로 번호는 그대로다. dead-exports,
  bus-pairing 202/202, import-graph, lifecycle-writes, navigation-sinks,
  transport-health, source-complexity도 통과했다.
- **검사:** typecheck(전체), `check:workers`, `lint`, `format:check` 통과. 영향 받는 단위
  묶음(`src/pro-room`, `src/network`, `src/rooms`, `src/account`, `src/i18n`, `src/ui`와
  room-authority·자원 소유권·배포 상태·facade 진단 도구 테스트) 320개 파일, 7,851개 모두
  통과. `guard:release-identity`는 9.0.16·v789이고, `guard:sw-cache-version`은 bump가
  필요하다고 실패한다(예상, 다음 커밋에서 올림).
- **돌리지 않은 것:** 이 커밋에서의 전체 단위 실행, Worker 묶음, 브라우저 묶음, 운영
  빌드는 bump 뒤 최종 검사(라운드 8)에서 돌린다.

### 8. bump 뒤 최종 검사(`28178b15f`, 9.0.17 / v790, 2026-10-27)

테스트한 코드: bump `28178b15f`(9.0.17 / v790, 앱 빌드 790). 그때 이 PR의 마지막 런타임
커밋이었고 그 뒤는 문서뿐이었다. 올리기 직전 fetch한 origin/main `0228276e2`는 9.0.16 /
v789 그대로였다. 환경: Windows, Node 24.20.0, npm 12.0.2, Vitest 5.0.3, 로컬 Chromium,
로컬 실행만. 이 bump는 라운드 9의 수정 뒤에 같은 내용으로 다시 만들었으므로(`a233dd7b7`)
`28178b15f`는 최종 히스토리에 없다. 아래 결과는 그 전 런타임의 기록이다.

- **버전:** 일곱 표기(`package.json`, `package-lock.json` 둘, App Worker의
  `ADMIN_ASSET_VERSION`, 관리자 스크립트의 `ADMIN_SCRIPT_VERSION`,
  `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 쿼리)를 한 커밋에서 올렸다.
  `guard:release-identity` 9.0.17·v790, `guard:sw-cache-version` PASS(bump
  `28178b15`를 읽음).
- **정적 검사:** typecheck(전체), `typecheck:tests`, `check:workers`, `lint`,
  `format:check` 통과.
- **전체 단위 실행:** `vitest run --maxWorkers=6` 한 번으로 681개 파일, 16,222개 모두
  통과(372.8초, 시간 초과나 단독 재실행 없음).
- **Worker:** `vitest.workers.config.ts` 67개 파일 3,220개가 커버리지 없이 한 번,
  커버리지와 함께 한 번 모두 통과했고 파일별 커버리지 하한을 지켰다.
  `check:worker-bundles`는 여섯 Worker의 dry-run 번들을 모두 만들었다.
- **핵심 커버리지:** `test:coverage:critical` 87개 파일 3,452개 통과, 하한 지킴.
- **빌드:** `build:checked` 통과(SW 앱 셸 96 자산, 초기 전송 예산 PASS).
- **가드:** room-authority 직접 읽기 80·구독 22·쓰기 13, 자원 소유권 48개 기록 / 443개
  파일, dead-exports, bus-pairing 202/202, import-graph(398개 파일, 순환 0),
  lifecycle-writes, navigation-sinks 통과.
- **브라우저:** critical E2E(`test:e2e:critical`, `e2e/pro-upload-recovery.test.ts`
  포함) 65/65. 같은 `build:e2e` 산출물에서 기본 설정으로 돌린
  `e2e/pro-upload-recovery.test.ts` 4/4. `build:checked`를 다시 돌린 운영 산출물에서
  후보 Playwright(`test:e2e:candidate`) 19/19. 이 PR이 더하거나 바꾼 e2e 파일은
  `e2e/pro-upload-recovery.test.ts` 하나다.
- **초기 JS:** 같은 기계에서 운영 App의 main `a930030af` 트리를 `npm run build`로,
  이 PR은 `build:checked` 산출물을 `measureInitialTransfer()`로 쟀다. main의 진입 청크
  `main-CEBZWVF6.js` 861,486 B와 첫 로딩 JS 465,652 B는 5B 보고서의 bump 값과 같다.
  첫 로딩 파일 수는 26으로 같다.

  | 값               | main `a930030a`(9.0.16, 운영) | `28178b15`(9.0.17) | 차이     |
  | ---------------- | ----------------------------- | ------------------ | -------- |
  | entry raw        | 861,486 B                     | 861,703 B          | +217 B   |
  | entry gzip       | 253,478 B                     | 253,504 B          | +26 B    |
  | eager JS gzip    | 465,652 B                     | 466,742 B          | +1,090 B |
  | eager total raw  | 2,044,988 B                   | 2,049,061 B        | +4,073 B |
  | eager total gzip | 544,115 B                     | 545,202 B          | +1,087 B |

  늘어난 첫 로딩 청크는 `toast`(+500 B gzip), `i18n`(+240 B), 영어 사전 `en`(+191 B),
  `peer`(+133 B)와 진입(+26 B)이다. 업로드 실패 문장과 권한 확인 중 안내가 첫 로딩
  청크에 들어간 것으로 본다(추론, 가르지 않음). 유지 상한 491,568 B까지 24,826 B 남는다.

- **배포 대상:** `scripts/release-deployment-state.mts`의 Worker별 런타임 경로로 운영과
  견줬다(App은 운영 App의 main `a930030a`, 나머지 다섯 Worker는 릴리스 W `a3893f04`
  기준). App 61개(의존성 변화 없음), PRO 방 3개(`cloudflare/pro-room-worker.ts`,
  `cloudflare/pro-room-diagnostics.ts`, `cloudflare/pro-room-media-timing.ts`),
  signaling 1개(`cloudflare/pro-room-diagnostics.ts`), remote-share, Developer API,
  Developer API facade는 0개다. signaling은 같은 진단 클래스를 입장 진단에 번들하므로
  묶음은 바뀌지만, 더한 것은 PRO 방만 내는 복사 사건과 범위 검사라 signaling 동작은
  그대로다. 부분 릴리스 게이트는 고르지 않은 Worker에 배포되지 않은 소스가 있으면
  막으므로, 세 Worker를 함께 내는 target은 `all`뿐이다. 계약 표지 파일, D1, wrangler
  설정, R2 정책은 바뀌지 않아 계약 cutover 검사는 해당 없고, Developer API D1과
  `raise_app_build_floor`는 false(바닥 787 그대로)다.
- **돌리지 않은 것:** PR CI, 자동 코드 리뷰, exact-main CI, 릴리스 smoke, 실제 R2
  CopyObject와 운영 진단 출력, 실기기. 로컬 결과는 exact-main-SHA 후보가 아니다. 새
  번역은 사람 검수를 거치지 않았다.

### 9. 검토 지적 정리와 다시 만든 bump(`a233dd7b7`, 9.0.17 / v790, 2026-10-27)

테스트한 코드: bump `a233dd7b7`(9.0.17 / v790, 앱 빌드 790). 런타임 커밋은 테스트 먼저
`79886708c`와 수정 `cd071fdd7`이고, 둘 다 합침 `d88cbb3b8` 바로 뒤에 두었다. 라운드 8의
bump는 이 수정 뒤에 같은 내용으로 다시 만들었으므로 bump가 여전히 마지막 런타임 커밋이고,
그 뒤는 문서뿐이다. 다시 만들기 직전 fetch한 origin/main은 `0228276e2` 그대로였다. 환경:
Windows, Node 24.20.0, npm 12.0.2, Vitest 5.0.3, 로컬 Chromium, 로컬 실행만.

바뀐 동작:

- **영수증 원장이 가득 찬 실패를 따로 안내한다.** 브라우저 업로드에서
  `ROOM_STATE_CAPACITY_EXCEEDED`는 대개 방의 변경 영수증 원장이 가득 찬 경우다. 모든
  참가자의 업로드, 재생목록 편집, 재생 명령이 원장 하나(영수증 256개)를 함께 쓰고, 업로드
  하나가 완료와 재생목록 추가에 24시간짜리 영수증 둘을 남긴다(예약은 15분, 재생 명령은
  10분). 그래서 하루 약 128개 업로드(재생목록을 고치면 더 적게)면 트랙이 1,000개보다 훨씬
  적어도 이 코드가 난다. 방 저장 상태가 한도에 가까운 경우도 같은 코드다. 6차는 이것을
  "PRO 방에 트랙을 더 담을 수 없어요."로 안내했는데, 트랙 자리 문제가 아니므로 틀린 안내였다.
  이제 새 문장 `pro.upload.room_state_limit`("지금은 PRO 방에 변경 사항을 더 반영할 수
  없어요. 잠시 후 파일을 다시 선택해 주세요.")으로 안내한다. 다시 시도는 여전히 내지
  않는다. 24시간 영수증은 대화상자가 열려 있는 동안 풀리지 않기 때문이다.
  `pro.upload.room_capacity`는 이제 `ASSET_CAPACITY_EXCEEDED`만 쓴다(파일 수 한도라 YouTube
  트랙과는 상관없다). 새 문장은 42개 언어에 더했고, 각 언어의 기존 PRO 방, 변경
  (`playlist.mutation_retry`, `toast.host_changed_setting`), 파일 다시 선택
  (`pro.upload.retry_unavailable`), 잠시 후(`pro.upload.pending_limit`) 표현과 말투(bg·tr 반말
  명령형, de·hu·ro 친근한 명령형 등)를 따랐다. 원장 한도 자체는 이 PR과 별개로 방의 하루
  업로드와 편집 수를 묶으므로 릴리스 기록 §2 운영·보안에 오너 결정 항목으로 적었다.
- **확정 단계 머리글을 행 문구와 맞춘다.** 묶음 로더의 확정 단계 문구
  (`pro.upload.confirming`, 이 PR이 더함)가 main에 이미 있던 행 문구
  (`pro.upload.confirming_file`)와 다른 동사를 쓰는 언어가 39개였다(영어 "Confirming
  upload" 대 "Finishing upload of"). 이제 각 언어의 행 문구 동사를 쓴다(영어 "Finishing
  upload 2/3"). 숫자 앞 구분자는 같은 로더의 `pro.upload.batch_progress`를 따랐다(bg·de·hu·uk
  콜론, ja 전각 콜론). ko·th·zh-hans는 이미 같았다. critical 업로드 경우의 머리글 기대값도
  "Finishing upload"로 바꿨다.
- **루마니아어 트랙 용어.** `pro.upload.playlist_switched`의 "piesă"를 이 언어가 쓰는 "pistă"로
  고쳤다(이 PR의 다른 문구와 `slot_tracks`가 쓰는 단어).

문서만 고친 것(동작 변화 없음):

- **실패한 릴리스의 자동 복구와 롤백.** 아래 Release and recovery에 적었다. 실패한 `all`
  실행이 9.0.16 PRO Worker를 자동으로 되돌리는 것을 받아들이는 이유, 그때 옛 Worker가 새
  필드를 다루는 방식과 잃는 것, 수동 CLI 롤백 전에 볼 것, App만 9.0.16으로 CLI 롤백할 때의
  facade 기한, signaling 재배포의 재연결이다. 복사 안전장치 절에도 한 줄을 더했다. 옛 PRO
  Worker 동작은 운영 PRO Worker 소스(릴리스 W `a3893f04`)를 읽고 확인했고, 테스트로
  돌리지는 않았다.
- **PRO 방 설계 문서의 대체 경로.** `pro-room-architecture-and-operations.md`가 CopyObject만
  적고 있어서, 검증된 최종 객체가 없으면 9.0.16 바인딩 복사로 대체하고 RO-52가 같은 키의
  두 번째 쓰기 주체라는 문장을 더했다.
- **받아들인 경우 둘.** 재생목록 전환 뒤 다른 실패의 다시 시도와, 계정 서비스 장애 동안
  이어지는 Standard 확인 중 안내를 아래 한계 절에 적었다. 뒤의 것은 계정 문서 §6에도 적었다.
- **자동 리뷰 표기.** 라운드 3의 자동 리뷰 링크를 PR #503 자동 리뷰 요약으로 적었다.

검증:

- **테스트 먼저:** `79886708c`의 대화상자 테스트를 부모 `d88cbb3b8`의 런타임에서 돌리면
  2개가 실패했다(코드별 이유 표의 `ROOM_STATE_CAPACITY_EXCEEDED`, 42개 언어의 문장 검사).
  `cd071fdd7`에서는 34개 모두 통과했다. 바꾼 e2e 기대값은 부모에서 돌리지 않았다.
- **버전:** `guard:release-identity` 9.0.17·v790, `guard:sw-cache-version` PASS(bump
  `a233dd7b`를 읽음).
- **정적 검사:** typecheck(전체), `typecheck:tests`, `check:workers`, `lint`, `format:check`
  통과.
- **전체 단위 실행:** `vitest run --maxWorkers=6` 한 번으로 681개 파일, 16,222개 모두
  통과(245.6초, 시간 초과나 단독 재실행 없음).
- **Worker:** `vitest.workers.config.ts` 67개 파일 3,220개가 커버리지 없이 한 번,
  커버리지와 함께 한 번 모두 통과했고 파일별 커버리지 하한을 지켰다.
  `check:worker-bundles`는 여섯 Worker의 dry-run 번들을 모두 만들었다.
- **핵심 커버리지:** `test:coverage:critical` 87개 파일 3,452개 통과, 하한 지킴.
- **빌드:** `build:checked` 두 번 통과(SW 앱 셸 96 자산, 초기 전송 예산 PASS).
- **가드:** room-authority 직접 읽기 80·구독 22·쓰기 13(398개 파일), 자원 소유권 48개 기록 /
  443개 파일, dead-exports, bus-pairing, import-graph(398개 파일, 순환 0),
  lifecycle-writes, navigation-sinks 통과.
- **브라우저:** critical E2E(`test:e2e:critical`, `e2e/pro-upload-recovery.test.ts` 포함)
  65/65. 기본 설정으로 돌린 `e2e/pro-upload-recovery.test.ts` 4/4. 두 번째 `build:checked`
  산출물에서 후보 Playwright(`test:e2e:candidate`) 19/19.
- **초기 JS:** 라운드 8과 같은 방법으로, 같은 main `a930030af` 산출물과 견줬다. 첫 로딩
  파일 수는 26으로 같다.

  | 값               | main `a930030a`(9.0.16, 운영) | `a233dd7b`(9.0.17) | 차이     |
  | ---------------- | ----------------------------- | ------------------ | -------- |
  | entry raw        | 861,486 B                     | 861,703 B          | +217 B   |
  | entry gzip       | 253,478 B                     | 253,507 B          | +29 B    |
  | eager JS gzip    | 465,652 B                     | 466,797 B          | +1,145 B |
  | eager total raw  | 2,044,988 B                   | 2,049,333 B        | +4,345 B |
  | eager total gzip | 544,115 B                     | 545,257 B          | +1,142 B |

  라운드 8보다 첫 로딩 JS가 55 B 늘었다. 새 문장과 바뀐 머리글이 든 `en`(main 대비
  +218 B gzip, 라운드 8은 +191 B)과 `i18n`(+272 B, 라운드 8은 +240 B) 청크다. 나머지는
  `toast`(+499 B), `peer`(+135 B), 진입(+29 B)이다. 유지 상한 491,568 B까지 24,771 B 남는다.

- **배포 대상:** 라운드 8과 같은 방법으로 다시 셌다. App 61개(의존성 변화 없음), PRO 방
  3개, signaling 1개, remote-share, Developer API, Developer API facade 0개라 target은
  `all` 그대로다. 수정은 App 런타임 경로(이미 바뀐 로케일 파일과 업로드 모듈)만 건드렸다.
  Developer API D1과 `raise_app_build_floor`는 false(바닥 787 그대로)다.
- **돌리지 않은 것:** PR CI, 자동 코드 리뷰, exact-main CI, 릴리스 smoke, 실제 R2
  CopyObject와 운영 진단 출력, 실기기, 옛 PRO Worker로 되돌린 상태의 실행. 로컬 결과는
  exact-main-SHA 후보가 아니다. 새 번역과 바꾼 번역은 사람 검수를 거치지 않았다.

### 10. PR CI, 자동 리뷰, exact-main CI, 배포와 공개 확인 (2026-10-27)

검증 대상은 PR head `6064a195`(마지막 런타임 커밋인 bump `a233dd7b` 뒤 문서 커밋 둘)와 그 squash 머지 `53a66d65`(트리가
`6064a195`와 같고 부모는 `0228276e`)다. 환경은 GitHub Actions(Node 24.20.0)와 운영 Cloudflare다. 시각은 KST다.

| 검사                     | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #503 CI               | 처음 런타임 `f2f25d90`의 [40407895179](https://github.com/hiefny/MUSIXQUARE/actions/runs/40407895179)는 11/11(라운드 3), 문서 head `7c574da7`의 40409214936은 success였다. 최종 head `6064a195`의 `pull_request` 실행 [40447427779](https://github.com/hiefny/MUSIXQUARE/actions/runs/40447427779)은 13:01:34에 생겨 attempt 1에서 11/11 success였다(13:08:11 완료). 이 PR 브랜치의 PR CI 실행은 이 셋뿐이다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 자동 리뷰                | 요약 댓글([PR #503 자동 리뷰 요약](https://github.com/hiefny/MUSIXQUARE/pull/503#issuecomment-6428202976))은 PR을 열 때('PR opened') head `f2f25d90` 코드 리뷰가 06:53:57에 completed, `has_any_findings`와 `has_unresolved_findings`는 false, 보안 리뷰는 돌지 않음이라고 적고, 06:54:00에 지적 없음 표시(👍) 반응이 남았다. 그 뒤 head에는 결과가 없다. 요약 댓글의 상태는 여전히 `f2f25d90`이고(마지막 수정 06:53:58), 리뷰와 리뷰 댓글(줄 댓글 포함)은 없다. 최종 head의 PR CI 완료(13:08:11)부터 머지(13:28:50)까지 약 20분 동안에도 새 결과는 없었다. 그래서 복사 대체 경로(라운드 4), 재시도·실패 안내(5, 6), 5B 합침(7), 영수증 원장 안내(9)와 bump는 자동 리뷰를 거치지 않았고, 그 검토는 라운드 6과 9의 검토 지적 정리다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 머지                     | 13:28:50 squash `53a66d65`(트리가 `6064a195`와 같고 부모는 `0228276e`). 마지막 런타임 커밋은 bump `a233dd7b`이고, 그 뒤는 문서 `94e328fc`, `6064a195`뿐이다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| exact-main CI            | [40449960573](https://github.com/hiefny/MUSIXQUARE/actions/runs/40449960573) push, attempt 1, 11 jobs 모두 success(13:28:52~13:37:33). 후보는 artifact 12710266151(digest sha256 `89b39104ed995b01923142ad0f03e5f5b5e5713f9c72ab1b18754d802e513545`)이고, 릴리스가 내려받아 이 digest와 릴리스 파일 809개를 확인했다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Release                  | [40450793853](https://github.com/hiefny/MUSIXQUARE/actions/runs/40450793853) attempt 1 성공(13:37:54 dispatch, deploy job 13:38:07~13:42:18), target `all`, Developer API D1 `false`, `raise_app_build_floor` false(올리기 단계 skip). 릴리스 커밋이 아직 main 머리인지 확인(13:38:16) 통과, 계약 cutover 검사 다섯 통과, 부분 릴리스 판정은 `all`이라 skip. checkpoint(artifact 12709897585, 13:38:42)는 여섯 Worker(PRO room `319f6e8f`, remote-share `8018b4ff`, signaling `2407c10c`, Developer API facade `19f49fa0`, Developer API `55c07e48`는 모두 릴리스 W `a3893f04`, App `317f176f`는 5B `a930030a`)와 R2 정책 셋, signaling Custom Domain 목록을 보존하고, Worker 호환 floor checkpoint는 PRO generation·entitlement floor(`ready`, release `a3893f04`, floor release `4c5612d5`)를 담는다. PRO generation readiness는 13:38:50에 `disabled`로 막았다가 13:42:10에 `ready`(release `53a66d65`)로 되돌렸다. D1 계약 적용·확인 단계 열하나 success(확인 결과 변경 0), Developer API base schema 단계 skip, schema intent는 `a3893f04`에서 확인. R2 정책 셋(remote-share CORS와 lifecycle, PRO media CORS)을 저장소의 같은 파일로 다시 적용했고 PRO media Range CORS smoke가 통과했다. 배포: PRO room `30535561`(13:39:34, 822.87 / gzip 160.22 KiB), remote-share `5a94401f`(13:39:46), signaling `2ba5a053`(13:40:19, Custom Domain 목록 fingerprint 전후 같음, 13:42:12에 다시 확인), Developer API facade `e6c6fbc7`(13:41:18), Developer API `f56aa410`(13:41:24), App `b851d58c`(13:41:50, `dist` 869 files를 읽어 새 자산 205개를 올림, 602개는 이미 있음, 986.17 / gzip 201.36 KiB). 여섯 모두 message `git:53a66d65f32d4824f23623a14e05ca1c51bdcd29`, 13:42:09 최종 소유권 verified, 커밋 표지 artifact 12709848246, 배포 원본 artifact 12710207719, recovery job skipped. remote-share, Developer API facade, Developer API는 바뀐 런타임 경로가 0이지만 `all`이라 새 버전으로 다시 배포됐다. |
| 릴리스 smoke             | PRO room(13:39:37~13:39:42, 세 번째 시도에 새 버전을 읽음, 앞 두 시도는 아직 `319f6e8f`, `000000` `activation_required`, `000001` `pin_required`와 `passwordRequired` true, 익명 스냅샷 거절), remote-share 두 번(`required`, whole-v1 왕복과 정리, 두 번째는 `--require-assertion`), signaling(13:40:24~13:40:47, `appBuild.build` 790으로 두 신호 호스트를 엇갈려 쓴 두 방에서 방장·게스트 입장, 재접속 비밀 검사, 방장 재접속, offer·answer 중계, 보호된 방의 틀린 암호 거절, 빌드 없는 방장은 787로 거절), Developer API canary, App generation(`main-CPWv7qcW.js` 861,703 B, 24 assets, 세 번 연속 읽기로 수렴, 라운드 9의 진입 raw 861,703 B와 같다), 익명 계정 경계와 페이지의 최소 빌드 읽기(13:41:59, strict, `effectiveMinAppBuild` 787), App 배포 뒤 PRO 공개 경계(`30535561`, 첫 시도), Standard HTTPS signaling(13:42:04, `appBuild.build` 790으로 방장·게스트 입장과 offer·answer 중계, `bridgeOpenMs` 방장 1,000ms·게스트 349ms) success. 503 재시도와 실패한 smoke는 없었다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 배포 직전 floor `status` | 돌리지 않았다(App Build Floor 실행 목록에 W-verify [set 40379025557](https://github.com/hiefny/MUSIXQUARE/actions/runs/40379025557) 뒤의 실행이 없다). 대신 위 신호 smoke와 Standard HTTPS smoke가 바닥 787 위에서 빌드 790 입장을, 계정 경계 smoke가 페이지 읽기 strict 787을 봤고, 아래 공개 상태와 Drift Audit이 저장·유효 787을 읽었다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 공개 자산·독립 확인      | 공개 GET(13:47) `/` 200 144,467 B(`bootstrap.js?cache=v790`, 진입 `main-CPWv7qcW.js`), `/service-worker.js` 200 38,199 B(`CACHE_VERSION = "v790"`, 9.0.16과 같은 크기). `/api/app-build-floor`: `minAppBuild` 787, `effectiveMinAppBuild` 787, revision 1(updated 2026-10-26T07:15:03.890Z), `liveAppBuild` 790, `reportedLiveAppBuild` 790(13:47:47 보고), state `valid`. `/api/app-build-floor/effective` `{"effectiveMinAppBuild":787}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Drift Audit              | [40451713399](https://github.com/hiefny/MUSIXQUARE/actions/runs/40451713399) attempt 1(`53a66d65`, 13:47:57 dispatch, 13:48:33 완료) automated-checks-passed: 32 pass / 0 fail / 5 manual-only. App build floor 행 PASS('Stored floor 787 (enforced 787) is within the live App build 790 reported 41 s ago.').                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SKIP                     | 배포 직전 floor `status`(위), 실제 수정본의 운영 PRO 업로드(171 MB 경우 포함), 실제 R2 CopyObject와 운영 복사 지연, 운영 `media_copy`·`media_copy_fallback` 기록, signaling 재배포 뒤 운영 Standard 방의 재연결, 옛 PRO Worker로 되돌린 상태, 운영 브라우저의 업데이트 대화상자(9.0.14~9.0.16 탭의 '나중에' 있는 창, 적용 뒤 재로드), 실기기, 새 번역과 바꾼 번역의 사람 검수, 9.0.17 런타임의 전체 직렬 E2E(최신 정기 Full E2E [40414428421](https://github.com/hiefny/MUSIXQUARE/actions/runs/40414428421)은 `1ff7fdf2`, 곧 9.0.15 런타임에서 success).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

로컬 결과는 exact-main-SHA CI 후보를 대신하지 않았다. 배포 뒤 확인(운영 대용량 업로드와 첫 `media_copy` 기록 읽기)은
release-record §2에 열려 있다.

## Release and recovery

- App, PRO Worker와 signaling(공유 진단 모듈) 변경이므로 병합과 exact-main CI 뒤 정식
  `all` 릴리스로 낸다(QA 라운드 8의 배포 대상). 2026-10-27 오너가 5B 다음 순서로 이
  배포를 승인했다(병합, 배포, 기록까지 정식 절차대로).
  결과: 2026-10-27 13:28 KST에 squash `53a66d65`로 머지했고, exact-main CI 40449960573 뒤
  Release 40450793853(target `all`, Developer API D1 `false`, `raise_app_build_floor`
  `false`)으로 13:42 KST에 배포했다. 여섯 Worker 모두 이 SHA의 버전이다(QA 라운드 10).
- **순서.** 이 PR은 5B 기록 #506(`0228276e`) 뒤에 머지했고(squash의 부모가 `0228276e`),
  머지부터 배포까지 main에 다른 머지는 없었다(릴리스의 'main 머리 확인' 단계 통과). 오너
  지시(2026-10-27)는 UI 묶음(UI 감사와 힌트 문구 감사의 권고)을 다음 앱 업데이트로 내고, 그다음
  PRO 방 영수증 보관 시간을 줄이는 자기 열차를 내는 순서였다. 같은 날 오너 부재 중 UI 묶음이
  아직 다른 작업에서 구현 중이라 바로 배포 원칙(오너 결정 2026-10-25)에 따라 순서를 바꿨고,
  영수증 열차가 이 PR의 배포 기록 #507 뒤 2026-10-27 18:14 KST에 9.0.18 / v791(target `all`,
  Release 40478660296)로 먼저 나갔다. UI 묶음은 2026-10-28 19:19 KST에 9.0.19 / v792(target `app`,
  Release 40670881163)로 뒤따랐고, Phase 5.5(구버전
  제거 열차 3과 PRO 스냅샷 v2)는 그 뒤 오너 승인을 기다린다(릴리스 기록 §2).
- **signaling 재배포의 재연결.** signaling 동작은 그대로지만, signaling Worker를 배포하면
  Durable Object가 다시 시작해 모든 Standard 방의 소켓이 다시 연결된다(hotfix 절차의 App
  Build Floor 절, Cloudflare 문서상 동작). 이때 최소 앱 빌드 787 아래의 방장은 재연결에서
  거절된다. 바닥은 10-26부터 켜져 있어 그런 방은 드물 것으로 본다. 미디어 복사 이유를 PRO
  전용 모듈에 두었다면 이번 signaling 재배포는 필요 없었다(이 PR에서는 바꾸지 않음).
  이번 배포의 signaling 재배포는 13:40 KST였고, 운영 Standard 방의 재연결은 관찰하지 않았다.
- No CORS change, new secret, dependency, service binding, D1 migration,
  or API response shape. The private asset and cleanup records gain the optional
  fields described above. CopyObject uses the existing
  server-only R2 credentials and its response is never exposed to browsers.
- **실패한 `all` 릴리스의 자동 복구.** 릴리스는 PRO Worker를 가장 먼저 배포한다. 그 뒤
  단계(remote-share·signaling·Developer API smoke, App 배포, App smoke)가 실패하면
  `Restore release-owned Workers after a failed release`가 recovery checkpoint의 9.0.16 PRO
  Worker를 자동으로 되돌린다. 이 PR은 forward floor나 계약 표지를 더하지 않으므로 이 되돌림을
  막지 않고, 그대로 받아들인다. 복사의 서명 URL은 8초 뒤 만료되므로, 되돌림이 도는 몇 분
  뒤에 새로 시작되는 복사는 없다. 옛 PRO Worker는 새 필드가 든 저장 상태를 그대로 읽는다.
  저장 상태 검사가 정확한 키를 요구하지 않으므로 `completionSourceEtag`와 tombstone의
  `finalObjectKey`는 읽히되 쓰이지 않는다. 최종 객체에 더해진 `mxqr-copy-source-etag`
  메타데이터도 옛 예약 검사를 막지 않고, 공개 응답에는 핀이 나가지 않는다. 되돌린 동안
  잃는 것은 둘이다. 원본 ETag가 고정된 예약도 9.0.16의 바인딩 복사로 핀 검사 없이 완료된다.
  그리고 시간 초과된 복사가 예약이나 asset을 지운 뒤 늦게 커밋한 최종 객체는 R2에 고아로
  남는다. 옛 tombstone 정리는 staging 키만 보고 조용한 창 뒤 tombstone을 지우기 때문이다
  (용량 집계 밖이고, 개수는 그 창의 시간 초과 복사 수를 넘지 않는다). 같은 릴리스를 다시
  돌리면 새 PRO Worker가 남아 있는 핀과 `finalObjectKey`를 다시 지킨다. 옛 Worker가 이미
  지운 tombstone은 되살리지 않는다.
- **수동 CLI 롤백.** 오너가 PRO Worker를 CLI로 9.0.16에 되돌려도 잃는 것은 위와 같다.
  되돌리기 전에 PRO Worker 로그의 최근 `media_copy`에 `timeout`·`network` 이유가 있었는지
  본다(늦게 커밋될 수 있는 복사). 있었다면 forward fix를 우선하고, 그래도 되돌린다면 그 뒤
  지운 업로드의 최종 객체가 R2에 남을 수 있음을 받아들인다. 객체 키가 그대로라는 것만으로는
  되돌림이 안전하다는 근거가 되지 않는다.
- **App만 되돌릴 때.** App을 CLI로 9.0.16 / v789에 되돌리는 데는 바닥 `lower`가 필요 없다
  (저장된 바닥 787 ≤ 789). 다만 되돌린 동안 옛 App facade의 5초 제어 기한이 9.0.17 PRO 복사
  경로 앞에 서므로, 배포 창과 같은 일이 그동안 계속된다. 5초를 넘는 완료(복사와 대체 경로)는
  facade 시간 초과로 보이고, 아직 열린 9.0.17 탭은 같은 키 재시도로, 9.0.16 탭은 파일 전체를
  다시 올려 회복하며, 남은 예약과 asset은 기존 서버 고아 정리가 치운다. ready 미디어는 바뀌지
  않는다. 되돌리는 릴리스는 hotfix 절차대로 운영보다 높은 번호를 쓴다. 9.0.18 / v791은 영수증
  보관 시간 열차가 썼고(2026-10-27 18:14 KST 배포), UI 묶음이 9.0.19 / v792로 나갔으므로(2026-10-28
  19:19 KST) 9.0.20 / v793 이상이다(그 전에 다른 앱 업데이트가 나가면 그다음 번호).
- Browser retry continuation is session-local, not a persistent resumable
  upload protocol. Closing/reloading the document discards it.
- Developer API completion still copies; this PR addresses the reported
  browser upload path.
- 배포 창과 복사 대체 경로의 회복은 아래 [복사 안전장치](#복사-안전장치-바인딩-대체-경로와-복사-진단)를 따른다.
- 이 릴리스는 성공해 실패 자동 복구(9.0.16 PRO Worker 되돌림)는 돌지 않았다(recovery job
  skipped). 위 경계들은 배포 기록 PR이 release-record §4 'PRO 업로드 신뢰성 9.0.17'에 옮겨
  적었다.

## 복사 안전장치: 바인딩 대체 경로와 복사 진단

서명한 CopyObject 요청은 실제 R2에서 실행된 적이 없다. 처음 PR은 결과 XML을
엄격하게 읽었고, 어떤 실패든 진단 없는 503 `MEDIA_STORAGE_UNAVAILABLE`로 끝냈다.
자격 증명 없이 이 위험을 줄이려고 브라우저 완료(`handleCompleteMedia`)에 다음을
더했다.

- **바인딩 대체 경로.** 복사가 검증된 최종 객체를 남기지 못하면 9.0.16까지 쓰던
  바인딩 복사(`PRO_MEDIA_BUCKET` get 뒤 put)로 같은 최종 키에 같은 메타데이터를
  쓰고 같은 HEAD 검증을 거친다. 메타데이터에는 고정한 원본 ETag
  (`mxqr-copy-source-etag`)도 들어간다. 대상은 200이 아닌 모든 상태(412 포함),
  네트워크 오류, 8초 기한, 읽을 수 없거나 16 KiB를 넘는 결과, 복사 뒤 HEAD 실패,
  ETag나 메타데이터 불일치, S3 자격 증명 없음이다. 다만 최악의 경우는 9.0.16과
  같지 않다. 복사가 8초 기한까지 가서 끝나면 그 8초 동안 방의 변경 대기열을 잡은 채
  9.0.16의 바인딩 전송을 이어서 한다. 그래서 대체 경로가 2초를 넘기면 완료 facade
  (10초)가 시간 초과로 답한다. 9.0.16의 바인딩 전송은 5초 제어 기한을 통째로 썼다.
  회복은 같은 키 재시도로, 앞선 완료가 끝나 저장한 응답을 그대로 돌려받는다(아래
  기한과 배포 창).
- **원본이 바뀐 경우만 쓰지 않는다.** 대체 경로는 staging을 한 번 읽고, 그 읽기의
  ETag가 고정값과 같을 때만 쓴다. 412만으로는 원본 변경을 확정하지 않는다(R2의
  ETag 형식 차이일 수도 있다). 바인딩 읽기가 변경을 보여 주면 쓰지 않고, 처음
  PR처럼 503으로 답하며 예약과 고정값을 남긴다. 같은 키 재시도는
  `UPLOAD_MISMATCH`(409)로 끝난다. 그래서 PR #503의 검토에서 말한 "확정된 전제
  조건 불일치"(definite precondition mismatch)는 이제 412 응답 자체가 아니라, 바인딩
  읽기가 고정값과 다른 원본 ETag를 보여 준 경우를 뜻한다. 412만 받고 원본이 그대로면
  대체 경로가 정상으로 완료한다.
- **대체 경로도 실패하면.** staging이 없거나, R2 읽기·쓰기·HEAD가 실패하거나, 쓴
  객체가 검증을 통과하지 못하면(이때 그 객체는 지운다) 503으로 답하고 두 키와
  고정값을 남긴다. 재시도는 최종 객체를 다시 확인하거나 대체 경로를 다시 돈다.
- **결과 파서 완화.** `CopyObjectResult` 루트 안에 ETag가 정확히 하나 있으면 결과로
  본다. XML 선언의 따옴표와 대소문자(`utf-8` 포함), 네임스페이스와 속성, 모르는
  자식 요소(체크섬 등), `&quot;`·`&#34;`·`&#x22;` 따옴표나 따옴표 없는 ETag를
  받아들인다. 뒤이은 HEAD가 이 ETag와 예약·고정 메타데이터를 그대로 확인한다.
  `<Error>` 문서, 닫힌 빈 루트, ETag 없는 결과는 여전히 실패다.
- **복사 진단.** 시도마다 방 범위 기록을 남긴다. 복사는 `media_copy`, 대체 경로가
  돌면 `media_copy_fallback`이다. 필드는 이유, 상태 코드, 경과 ms, 2의 거듭제곱 MiB
  크기 구간뿐이다. 복사 이유는 `ok`, `status_4xx`, `status_5xx`, `status_other`,
  `precondition`, `network`, `timeout`, `body`, `parse`, `head`, `etag_mismatch`,
  `metadata_mismatch`, `unconfigured`이고, 대체 경로 이유는 `ok`, `source_missing`,
  `source_mismatch`, `storage`, `verify`다. 운영 첫 기록이 필요해서 성공도 남기지만,
  복사 성공(`media_copy` `ok`)은 창마다 첫 상세 기록 하나만 남기고 나머지는 분 요약
  집계에만 센다. 키, 자격 증명, ETag, 파일 이름, 정확한 바이트 수는 넣지 않는다.
  기존 분당 상세 예산(이유마다 첫 기록, 반복 기록은 창마다 모두 합쳐 4개)은 실패와
  대체 경로만 써서, 업로드가 많은 방에서도 성공 기록이 실패 기록을 밀어내지 않는다
  (6차).

기한과 배포 창:

- 복사 기한 8초와 완료 facade 기한 10초(`cloudflare/pro-room-media-timing.ts`)는
  그대로다. 대체 경로는 9.0.16처럼 자체 기한이 없다. 복사가 8초 기한에서 끝나면
  facade 기한은 2초만 남으므로, 그보다 오래 걸리는 대체 경로는 facade 시간 초과로
  보인다(9.0.16의 바인딩 전송은 5초 제어 기한을 다 썼다). 그동안 방의 변경 대기열은
  8초에 대체 경로 시간을 더한 만큼 잡힌다. facade 시간 초과를 받은 브라우저의 같은 키
  재시도는 저장된 응답을 재생하거나 최종 객체를 다시 확인한다. 방 객체는 완료를 한
  번에 하나씩 처리하므로 재시도는 앞선 완료가 끝난 뒤에 실행된다.
- `all` 릴리스는 PRO Worker를 App Worker보다 먼저 배포한다. 그 사이에는 옛 App
  facade의 5초 제어 기한이 새 PRO 복사(8초 기한) 앞에 선다. 5초를 넘는 완료는
  9.0.16에서처럼 facade 시간 초과로 보이고, 같은 방식(같은 키 재시도나 기존 고아
  정리)으로 회복된다. App 배포가 끝나면 10초 facade가 적용된다.
- 실패한 `all` 릴리스는 9.0.16 PRO Worker를 자동으로 되돌린다. 옛 Worker는 바인딩 복사만
  쓰므로 그동안 복사와 대체 경로의 구분이 없고, 핀 검사와 `finalObjectKey` 정리가 빠진다.
  그 범위와 받아들인 이유는 위 [Release and recovery](#release-and-recovery)에 있다.
- 버려진 복사가 R2에서 늦게 커밋될 수 있으므로 대체 경로는 같은 최종 키의 두 번째
  쓰기 주체다. 그래서 [자원 소유권 RO-52](resource-ownership-registry.md#ro-52-pro-browser-completion-final-object)를
  더했다. 두 주체 모두 같은 키에 같은 고정 메타데이터를 쓰고 최종 HEAD는 어느
  쪽이 이겼는지가 아니라 메타데이터를 본다. 예약 삭제 뒤의 늦은 객체와, 대체 경로로
  완료한 asset을 ready 상태에서 지운 뒤의 늦은 객체는 기존 tombstone
  (`finalObjectKey`)이 치운다(뒤의 경우는 6차에서 테스트를 더했다). ready asset은
  staging 객체가 1시간 내내 없음을 확인한 뒤에야 staging 키를 놓고, 그 확인은 완료
  뒤 최소 60초부터 시작하므로 그 전에 지우면 tombstone이 남는다. 복사의 서명 URL은
  8초 뒤 만료되므로, 그 1시간이 지난 뒤에 커밋되는 복사는 RO-52의 모델 밖으로 둔다.
- 대체 경로를 없애는 것은 운영 `media_copy` 기록으로 복사가 믿을 만하다고 확인한
  뒤의 오너 결정이다.

## Limits and deferred live confirmation

변경 코드는 2026-10-27 13:42 KST에 9.0.17 / v790으로 배포됐다(QA 라운드 10). 그래도
이전에 실패한 대용량 파일의 운영 성공과 운영 CopyObject 지연은 아직 확인하지 않았다
(release-record §2의 배포 뒤 확인). R2 internal copy
can still fail or exceed its bounded deadline; completion then falls back to the
9.0.16 binding copy, and explicit
completion retry safely recovers a final object whose response was lost.
Deterministic Worker and browser
tests exercise those contracts locally. Copy completion remains serialized in
the existing room mutation owner, so concurrent control requests may still wait;
this PR does not claim to eliminate every heartbeat timeout. In particular,
post-merge production validation must use the final released SHA. Existing
playback behavior is covered by regression tests, not by a new multi-device
audio or mobile soak run.

복사가 8초 기한에서 끝난 뒤의 대체 경로는 9.0.16보다 facade 기한이 짧다(2초 대 5초).
자세한 내용과 회복은 위 [복사 안전장치](#복사-안전장치-바인딩-대체-경로와-복사-진단)에
있다.

라운드 9 검토에서 받아들이거나 따로 넘긴 경우:

- **재생목록 전환 뒤 다른 실패의 다시 시도.** 다시 시도는 처음 시도한 재생목록 칸에 묶인다.
  그래서 파일이 네트워크 오류처럼 다시 시도할 수 있는 이유로 실패한 뒤 다른 관리자가
  재생목록을 바꾸면(대화상자가 열려 있는 동안 포함), 대화상자는 그 파일의 다시 시도를
  내지만 누르면 `PRO_ROOM_PLAYLIST_SWITCHED`로 끝나고 두 번째 대화상자가 뜬다. 그 대화상자는
  끝난 실패이고, 이미 올린 asset은 기존 해제 경로가 바로 지운다. 그래서 잃는 것은 헛된 다시
  시도 한 번이다. 묶음이 끝날 때 칸을 견줘 미리 끝난 실패로 바꾸려면 업로드 큐와 재생목록
  상태 관리자 사이에 새 연결이 필요해 이번에는 하지 않았다.
- **계정 서비스 장애 동안의 Standard 확인 중 안내.** 계정 상태가 `unavailable`이거나 방 신원
  확인 요청이 네트워크·5xx로 계속 실패하면, 권한을 받지 않은 Standard 게스트의 막힌 동작은
  방장이 이 연결을 확인한 뒤에도 "권한 필요" 대신 "확인 중"으로 안내된다. 그동안 이
  브라우저가 권한 있는 계정인지 알 수 없으므로 의도한 동작으로 둔다. 막는 판단은 그대로이고,
  서비스가 돌아오면 기존 재시도가 확인을 끝낸다. [계정 문서 §6](account-identity-and-room-authority.md#6-capabilities-and-product-baselines)에도
  적었다.
- **방 영수증 원장 한도.** 방 하나의 변경 영수증 원장(256개, 대부분 24시간)은 이 PR과 별개로
  방의 하루 업로드와 재생목록 편집 수를 묶는다(업로드 하나에 24시간 영수증 둘). 원장이 차면
  트랙을 지우는 것도 영수증이 필요해 도움이 되지 않고, 다른 재생목록 작업은 main 그대로
  "재생목록이 변경됐어요" 토스트(`playlist.mutation_retry`)를 낸다. 한도나 보관 시간을 바꿀지는
  오너 결정이라 릴리스 기록 §2 운영·보안에 열린 항목으로 적었다. 오너는 2026-10-27 이 검토 뒤
  보관 시간을 줄이기로 정했고('보관 시간 줄이기'), 그 일은 Phase 5.5 전의 자기 열차로 했다.
  오너는 그 열차를 UI 묶음 다음에 두었으나, 같은 날 오너 부재 중 UI 묶음이 아직 구현 중이라 바로
  배포 원칙(2026-10-25)에 따라 먼저 냈다. 그 열차는 2026-10-27 18:14 KST에 9.0.18 / v791(target
  `all`, Release 40478660296)로 나갔고, UI 묶음은 2026-10-28 19:19 KST에 9.0.19 / v792로 뒤따랐다. 운영 방의 첫 prune
  같은 배포 뒤 확인과 남은 오너 결정이 있어 그 항목은 열려 있다(릴리스 기록 §2).
