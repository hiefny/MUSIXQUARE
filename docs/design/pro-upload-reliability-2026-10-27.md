# PRO upload completion and authority feedback — 2026-10-27

| Field                 | Value                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                | [PR #503](https://github.com/hiefny/MUSIXQUARE/pull/503) open; not merged or deployed yet                                                                        |
| Base                  | Initial `cb1598516`; integrated main `5dd7cc1f6` (#502, 9.0.15 / v788) in `4a99f44ba`; 5B 기록 main `0228276e2`(#506, 운영 9.0.16 / v789)를 QA 라운드 7에서 합침 |
| Proposed identity     | 9.0.17 / v790(5B 합침 뒤 다시 올림, 그 전 PR의 9.0.16 / v790 표기는 버림); 최소 앱 빌드 787 그대로                                                               |
| Scope                 | Browser PRO uploads, completion deadlines, bounded diagnostics, Standard/PRO authority feedback                                                                  |
| Release authorization | 2026-10-27 오너가 5B 다음 순서로 이 PR의 병합·배포·기록을 정식 릴리스 절차대로 진행하도록 승인함                                                                 |

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
- **Automated review:** the [Codex review summary](https://github.com/hiefny/MUSIXQUARE/pull/503#issuecomment-6428202976)
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
- **방 용량 실패를 정확히 안내한다.** `ROOM_STATE_CAPACITY_EXCEEDED`(방 저장 상태가
  한도에 가까움)와 `ASSET_CAPACITY_EXCEEDED`(방의 파일 1,024개, 정리를 기다리는 지운 파일
  포함)는 "PRO 방에 트랙을 더 담을 수 없어요."(`pro.upload.room_capacity`)로 안내하고
  다시 시도를 내지 않는다. 트랙을 지워도 서버 정리가 돌기 전에는 자리가 나지 않기
  때문이다. 완료 단계에서 이 실패가 나면 예약은 기존처럼 만료(15분)까지 용량에 남는다.
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

테스트한 코드: `c29a4c796`에 main `0228276e2`(#506)를 합친 커밋(버전 표기는 main의
9.0.16 / v789, bump는 다음 커밋). 환경: Windows, Node 24.20.0, npm 12.0.2, Vitest
5.0.3, 로컬 실행만.

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

## Release and recovery

- App and PRO Worker changes require the normal coordinated `all` release
  after merge and exact-main CI. 2026-10-27 오너가 5B 다음 순서로 이 배포를
  승인했다(병합, 배포, 기록까지 정식 절차대로).
- No CORS change, new secret, dependency, service binding, D1 migration,
  or API response shape. The private asset and cleanup records gain the optional
  fields described above. CopyObject uses the existing
  server-only R2 credentials and its response is never exposed to browsers.
- Reverting App restores whole-file retry behavior without changing ready media.
  Prefer a forward fix for the PRO Worker when copies have uncertain outcomes:
  older Workers do not enforce the pinned source or collect late final objects
  through the new tombstone field. A Worker rollback requires accounting for
  outstanding copies and their cleanup first; unchanged object keys alone are
  not evidence that rollback is safe.
- Browser retry continuation is session-local, not a persistent resumable
  upload protocol. Closing/reloading the document discards it.
- Developer API completion still copies; this PR addresses the reported
  browser upload path.
- 배포 창과 복사 대체 경로의 회복은 아래 [복사 안전장치](#복사-안전장치-바인딩-대체-경로와-복사-진단)를 따른다.

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

The changed code is not deployed. Production success for the previously failing
large file and production CopyObject latency are not claimed. R2 internal copy
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
