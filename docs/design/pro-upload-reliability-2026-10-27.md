# PRO upload completion and authority feedback — 2026-10-27

| Field                 | Value                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Status                | [PR #503](https://github.com/hiefny/MUSIXQUARE/pull/503) open; not merged or deployed yet                        |
| Base                  | Initial `cb1598516`; integrated main `5dd7cc1f6` (#502, 9.0.15 / v788) in `4a99f44ba`                            |
| Proposed identity     | 9.0.16 / v790 in the PR; the bump is redone at merge on the then-current main; App build floor unchanged         |
| Scope                 | Browser PRO uploads, completion deadlines, bounded diagnostics, Standard/PRO authority feedback                  |
| Release authorization | On 2026-10-27 the owner authorized Claude to merge, ship and record this PR through the normal release procedure |

## Runtime increments

1. **Keep the file copy inside R2.** Browser completion sends a bounded,
   server-authenticated CopyObject request with a durably pinned staging ETag as
   a condition. The Worker no longer reads and retransmits the full file
   unless the copy leaves no verified final object; then completion falls
   back to the 9.0.15 binding copy (see 복사 안전장치 below).
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
   its original playlist. Each failed file gets one dialog sentence for the code
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
  `PRO_ROOM_PLAYLIST_SWITCHED`는 다시 시도해도 같은 이유로 실패했다. 이제 업로드
  큐가 이 실패를 끝난 실패로 보고 다시 시도 버튼을 내지 않는다. 안내는 다른
  재생목록이 활성화됐으니 파일을 다시 선택하라고 말한다. 이미 올린 asset은 기존
  서버 고아 정리(15분 유예)가 치우며, 새 재시도·정리 흐름은 없다.
- **실제로 생기는 코드만 연결한다.** 실패 안내가 어디서도 만들지 않는 코드
  (`PRO_ROOM_PLAYLIST_CAPACITY_EXCEEDED`, `PRO_ROOM_PLAYLIST_STATE_CAPACITY_EXCEEDED`)를
  보고 있어서 재생목록 가득 참과 방 상태 용량은 일반 문구로 나왔다. 이제
  `PRO_ROOM_PLAYLIST_LIMIT_REACHED`·`PLAYLIST_CAPACITY_EXCEEDED`·`REQUEST_TOO_LARGE`는
  재생목록 가득 참, `ROOM_STATE_CAPACITY_EXCEEDED`는 기존 토스트와 같은 뜻(재생목록이
  바뀌었으니 다시 시도)으로 안내한다. 연결은 `upload-failure-dialog.ts`의
  `describeProRoomUploadFailures` 한 곳에 있고, 테스트가 그 안의 코드마다 PRO 클라이언트나
  Worker의 생성 지점이 있는지 확인한다.
- **대화상자 문장만 쓴다.** 실패 목록이 토스트 문구(마침표 없음, 문장마다 줄바꿈)와
  대화상자 문장을 섞어 썼다. 파일마다 한 줄, 이유는 대화상자 문장 하나다. 새 키 6개
  (`pro.upload.file_too_large`·`quota_exceeded`·`playlist_full`·`playlist_changed`·
  `playlist_switched`·`permission_required`)와 줄 형식 `pro.upload.failed_file`을
  42개 언어에 더했다. 일본어·중국어는 전각 콜론, 프랑스어는 기존처럼 좁은
  줄바꿈 없는 공백 뒤 콜론을 쓴다.
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

## Release and recovery

- App and PRO Worker changes require the normal coordinated `all` release
  after merge and exact-main CI. The owner authorized this release on 2026-10-27
  (Claude merges, ships and records it).
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

- **바인딩 대체 경로.** 복사가 검증된 최종 객체를 남기지 못하면 9.0.15까지 쓰던
  바인딩 복사(`PRO_MEDIA_BUCKET` get 뒤 put)로 같은 최종 키에 같은 메타데이터를
  쓰고 같은 HEAD 검증을 거친다. 메타데이터에는 고정한 원본 ETag
  (`mxqr-copy-source-etag`)도 들어간다. 대상은 200이 아닌 모든 상태(412 포함),
  네트워크 오류, 8초 기한, 읽을 수 없거나 16 KiB를 넘는 결과, 복사 뒤 HEAD 실패,
  ETag나 메타데이터 불일치, S3 자격 증명 없음이다. 그래서 최악의 경우가 9.0.15
  동작과 같다.
- **원본이 바뀐 경우만 쓰지 않는다.** 대체 경로는 staging을 한 번 읽고, 그 읽기의
  ETag가 고정값과 같을 때만 쓴다. 412만으로는 원본 변경을 확정하지 않는다(R2의
  ETag 형식 차이일 수도 있다). 바인딩 읽기가 변경을 보여 주면 쓰지 않고, 처음
  PR처럼 503으로 답하며 예약과 고정값을 남긴다. 같은 키 재시도는
  `UPLOAD_MISMATCH`(409)로 끝난다.
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
  `source_mismatch`, `storage`, `verify`다. 운영 첫 기록이 필요해서 성공도 남긴다.
  키, 자격 증명, ETag, 파일 이름, 정확한 바이트 수는 넣지 않는다. 기존 분당 상세
  예산(이유마다 첫 기록, 반복 기록은 창마다 모두 합쳐 4개)과 분 요약 집계를 함께
  쓴다.

기한과 배포 창:

- 복사 기한 8초와 완료 facade 기한 10초(`cloudflare/pro-room-media-timing.ts`)는
  그대로다. 대체 경로는 9.0.15처럼 자체 기한이 없어서 큰 파일이면 facade 기한을
  넘길 수 있다. 그러면 브라우저는 facade 시간 초과를 받고, 같은 키 재시도가 저장된
  응답을 재생하거나 최종 객체를 다시 확인한다. 방 객체는 완료를 한 번에 하나씩
  처리하므로 재시도는 앞선 완료가 끝난 뒤에 실행된다.
- `all` 릴리스는 PRO Worker를 App Worker보다 먼저 배포한다. 그 사이에는 옛 App
  facade의 5초 제어 기한이 새 PRO 복사(8초 기한) 앞에 선다. 5초를 넘는 완료는
  9.0.15에서처럼 facade 시간 초과로 보이고, 같은 방식(같은 키 재시도나 기존 고아
  정리)으로 회복된다. App 배포가 끝나면 10초 facade가 적용된다.
- 버려진 복사가 R2에서 늦게 커밋될 수 있으므로 대체 경로는 같은 최종 키의 두 번째
  쓰기 주체다. 그래서 [자원 소유권 RO-52](resource-ownership-registry.md#ro-52-pro-browser-completion-final-object)를
  더했다. 두 주체 모두 같은 키에 같은 고정 메타데이터를 쓰고 최종 HEAD는 어느
  쪽이 이겼는지가 아니라 메타데이터를 본다. 예약 삭제 뒤의 늦은 객체는 기존
  tombstone(`finalObjectKey`)이 치운다.
- 대체 경로를 없애는 것은 운영 `media_copy` 기록으로 복사가 믿을 만하다고 확인한
  뒤의 오너 결정이다.

## Limits and deferred live confirmation

The changed code is not deployed. Production success for the previously failing
large file and production CopyObject latency are not claimed. R2 internal copy
can still fail or exceed its bounded deadline; completion then falls back to the
9.0.15 binding copy, whose slow cases behave as they did on 9.0.15, and explicit
completion retry safely recovers a final object whose response was lost.
Deterministic Worker and browser
tests exercise those contracts locally. Copy completion remains serialized in
the existing room mutation owner, so concurrent control requests may still wait;
this PR does not claim to eliminate every heartbeat timeout. In particular,
post-merge production validation must use the final released SHA. Existing
playback behavior is covered by regression tests, not by a new multi-device
audio or mobile soak run.
