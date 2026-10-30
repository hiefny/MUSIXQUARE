# Phase 5.5 R4: PRO 정리, 옛 2999 ms 전환 읽기와 CORS 머리글 이름 둘 삭제, PRO Worker만 (2026-10-30)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 초안, 미병합·미배포. 증분 R4-1, R4-2와 이 열차의 기록(이 보고서, `docs/README.md`, release-record §2·§4, PRO 운영 문서의 되돌리기 문단)을 만들고 증분별 검사(QA 라운드 1)와 기록 전 코드 커밋의 전체 기본 검사(QA 라운드 2)를 했다. 오너 질문 셋(Q1 ~ Q3, 아래 '오너 결정과 순서')은 답을 기다리고, 이 브랜치는 셋 모두 권장 (가)로 만들었다. main 위로 옮김(9.0.27 배포·기록 뒤, QA 라운드 3), dispatch 직전 읽기(QA 라운드 4), PR, PR CI, 자동 코드 리뷰, 머지, exact-main CI, 배포, 배포 직후 확인(QA 라운드 5)은 아직이다. 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다                                                                                                                                                                                      |
| Base               | main `d0248df2`(App 9.0.26 열차의 기록 #535, 문서만). 그 아래 9.0.26(#534, squash `cbbc56d9`, 2026-10-30 13:08 KST 배포, App만), 9.0.25(#532, squash `b8ae59e7`, 07:18 KST, App만), PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker(#528, squash `0e5a9b87`, 00:30 KST, PRO room `ef882f7c`)가 있다. `cloudflare/pro-room-worker.ts`는 `0e5a9b87`과 `d0248df2`에서 같은 blob(`11c6390a`)이라 이 브랜치의 부모 PRO Worker는 운영 PRO Worker와 같은 코드다. 브랜치 `agent/p55-r4`, worktree `mxq-wt/p55-r4`                                                                                                                                                                                                                                                         |
| Version            | 앱 SemVer와 SW 캐시를 바꾸지 않는다(main의 9.0.26 / v799. 9.0.27이 먼저 나가면 그 값 그대로). 업데이트 창이 없다. 바닥(저장·유효 795)을 바꾸지 않는다. Worker 전용 변경은 bump가 필요 없다(`docs/release-versioning.md`의 'A pure Worker-only change may leave both identifiers untouched', `docs/hotfix-procedure.md`의 SW 캐시 문단). 선례: PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker와 PRO 영수증 후속 열차 A                                                                                                                                                                                                                                                                                                                                            |
| Scope              | Phase 5.5 계획의 R4(Q19 기본값, Phase 6 브리프 Q20 확인). R4-1: PRO Worker가 그 앞 PRO Worker가 저장한 대기 전환의 2999 ms 마감을 zero-start로 읽지 않는다(ZS-04 후속, M9). `timingMode` 없는 저장 전환은 그대로 불러와 예약 제어(scheduled-control)로 커밋한다(Q1 (가)). R4-2: PRO CORS 허용 목록이 `x-mxqr-pro-entry-policy`와 `x-mxqr-pro-playlist-slots`를 더 적지 않는다(PSK-07의 Worker 몫). App, 다른 다섯 Worker, 공유 시간 파일, D1, 비밀, 바인딩, Wrangler 설정(`ALLOWED_ORIGINS` 포함), 계약 표지, 쓰는 저장 모양, 의존성, PRO 최소 빌드 요구 값(빈 값)은 바꾸지 않는다                                                                                                                                                                                    |
| Deploy target      | `pro-room`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 코드 커밋 `32136843`을 견준 로컬 git 판정(QA 라운드 2): main `d0248df2` 대비 PRO 방 1(`cloudflare/pro-room-worker.ts`), remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 0, App 런타임 의존성 차이 없음. release-record §4 현재 경계 줄 (5)가 적은 운영 배포 SHA(App 9.0.26 `cbbc56d9`, PRO room `0e5a9b87`, 나머지 넷 9.0.22 `71f5b96c`) 대비도 같다. 바뀐 시험 파일, e2e 모의, 문서는 어느 런타임 경로에도 없다. 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 호환 검사를 대신하지 않는다. Developer API D1 `false`. `raise_app_build_floor` 입력은 `pro-room`에 없다 |
| Operations         | 없음. 운영에 닿은 것은 없다(로컬 git과 로컬 시험만, `git fetch`는 이 브랜치를 만들 때 한 번)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Resource ownership | 새 복구·재시도·시간 제한·감시·생명주기 흐름이 없어 새 레코드는 없다. R4-1이 RO-03의 zero-start 인코딩 문장(Worker도 2999 ms 읽기를 그만둠, 공유 시간 파일 머리 주석이 낡은 채 남음)과 그 시간 시험 설명을 고쳤다. `node scripts/check-resource-ownership.mts` 출력은 부모와 글자 그대로 같다(49 records, 448 production files)                                                                                                                                                                                                                                                                                                                                                                                                                                        |

이 문서는 Phase 5.5 계획의 R4('PRO 정리', target `pro-room`)의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의
Phase 5.5 계획(2026-10-28)과 그 영역 조사, Phase 6 브리프와 오너 답(2026-10-30)이고, ZS, PSK, HDR, PLE 번호와 Q 번호는 그 노트의
번호다. 계획의 줄 번호는 `6a23c46e` 기준이라 위치를 기호로 다시 찾았다. 증분마다 테스트를 먼저 커밋하고 부모 코드에서 바뀐 행만
실패함을 확인했다. 계획 단계 이름은 R1(9.0.22, [보고서](phase5-5-r1-train3-v2-accept-2026-10-29.md)), F2(바닥 795), R2(PRO 스냅샷
schemaVersion 2를 처음 보내는 PRO Worker, [보고서](phase5-5-r2-v2-send-2026-10-29.md)), R3(9.0.25,
[보고서](phase5-5-r3-v1-receive-stop-2026-10-30.md)), R4(이 릴리스)다. 영구 운영 문서(release-record §4, 설계 문서, 레지스트리)에는
단계 이름 대신 SemVer, 머지 SHA, 그리고 계약 문구 '9.0.25 뒤의 PRO 전용 릴리스'로 적었다. 이 릴리스는 SemVer가 없고 런타임 PR은
머지 전에 자기 머지 SHA를 모르므로 그 머지 SHA와 Release ID는 배포 기록 PR이 채운다. 영구 문서의 'R2'는 Cloudflare R2다.

## 오너 결정과 순서

- Q19(2026-10-28, 권장 기본): PRO CORS 머리글 이름 정리와 옛 2999 저장 해석 삭제를 R3 기록 뒤, Phase 6 시작 전에 target
  `pro-room` 릴리스 하나(R4)로 낸다. 손 되돌리기 경계는 R2와 같고('PRO ≥ R2') 배포 조건도 R2와 같은 꼴이다.
- Phase 6 브리프 Q20(2026-10-30 오너 답): R4는 Phase 6 앞, PRO 방 서버만, 업데이트 창 없음. 같은 답의 Q0: R4가 나가고 기록되면
  Phase 6 첫 단계(시험·검사만)를 따로 '시작' 없이 시작한다. 순서: 9.0.27 배포·기록 → R4 배포·기록 → Phase 6 첫 단계.
- Q10(2026-10-28): CORS 정리는 R3 뒤 첫 PRO Worker 릴리스. 바닥 도구와 PRO smoke는 entry-policy 머리글을 계속 보낸다(서버 요청이라
  CORS를 거치지 않고 Worker가 읽지 않아 결과가 같음).
- Q4(2026-10-28): `timingMode`는 끝까지 선택 필드다. 저장 전환의 선택 키와 outbox PREPARE·COMMIT의 선택 키를 남긴다.
- 배포 정책(2026-10-25): 자동 게이트가 통과하면 따로 묻지 않고 배포한다. 기기 근거는 게이트가 아니다.
- **오너 질문(2026-10-30, 답 대기, 이 브랜치는 셋 모두 권장 (가)로 만듦).** 셋 다 화면은 그대로다.
  - Q1 `timingMode` 없는 옛 저장 전환(PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker 앞의 Worker가 쓴 것)을 R4가 만나면: (가, 권장) 버리지 않고 예약
    제어로 읽어 평소처럼 커밋한다. 그 한 번의 시작만 기기별 배운 시작 앞섬 없이 시작한다. (나) 정확한 키로 바꿔 무효로 버린다.
    CANCEL 없이 null이 되어 그 시작이 일어나지 않고 로딩 표시가 다음 명령까지 남을 수 있다. 계획은 정하지 않았고 Q4와 서버 권한
    ADR('모르는 값은 scheduled-control')이 (가) 쪽이다. (나)를 고르면 R4-1의 테스트 먼저 두 행과 코드가 바뀐다(불러올 때 null, COMMIT
    없음).
  - Q2 공유 시간 파일 `cloudflare/pro-room-playback-timing.ts`의 머리 주석(2999·699를 '각 파일이 들고 있다'): R4 뒤 낡지만 고치면
    R4가 `all`(여섯 Worker 재배포, 신호 Durable Object 재시작, 넓은 자동 복구)이 된다. (가, 권장) R4는 `pro-room` 그대로, 그 주석은
    다음 `all` 릴리스 때 고친다(이 보고서와 RO-03에 열린 항목). (나) R4를 `all`로 낸다.
  - Q3 `src/pro-room/snapshot.ts`의 `parsePlaylistSlots` 문서 주석 'Opt-in summary': App 파일이라 R4에 실으면 부분 게이트가
    `pro-room`을 거절한다. (가, 권장) 준비 중인 9.0.27 또는 다음 App 업데이트에 싣는다(주석뿐, 동작 변화 없음). (나) 그대로 둔다.

## 이 릴리스가 기대는 것

| 이 릴리스가 그만두는 것                                                 | 그것을 쓰던 쪽                                                                    | 지금 운영                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 저장 전환의 2999 ms 마감을 zero-start로 읽기                            | PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker 앞의 PRO Worker(그 저장 기록) | 그 PRO Worker(`0e5a9b87`, 2026-10-30 00:30 KST부터 live)는 여는 모든 전환에 `timingMode`를 저장한다. 그 앞 기록은 아래 '저장 기록의 수명'대로 남을 수 있어 버리지 않고 예약 제어로 읽는다(Q1 (가)) |
| CORS 허용 목록의 `x-mxqr-pro-entry-policy`, `x-mxqr-pro-playlist-slots` | 9.0.24 이하 App(9.0.25부터 보내지 않음)                                           | 운영 App은 9.0.26(바닥 795가 들이는 9.0.22 ~ 9.0.24 탭은 남을 수 있음). 운영 App 페이지는 같은 출처 facade를 불러 preflight가 없고 PRO Worker는 공개 경로가 없다. 영향은 아래 '개발 영향'뿐이다    |

### 저장 기록의 수명 (Q1의 근거)

모든 전환의 마감은 만든 뒤 3000 ms 이하다(불러오기 검사의 상한과 새 전환의 마감). Worker는 마감에(이미 지났으면 다음 틱에) alarm을
걸고, alarm은 방을 불러 prune을 돌며 prune은 마감이 지난 전환을 커밋한다. 모든 일반 요청도 처리 전에 prune을 돈다. 서비스 점검
중에는 60초마다 alarm을 다시 건다. 그 앞 PRO Worker가 `timingMode` 없이 저장한 전환이 남을 수 있는 방은 2026-10-30 00:30 KST 배포
순간 3초 창 안에 전환이 대기 중이었고, 그 뒤 alarm 재시도가 모두 실패했으며, 그 뒤 요청이 한 번도 오지 않은 방뿐이다. 운영
Durable Object 저장을 읽을 수 없어(이 작업은 공개 GET만 허용) 0이라고 증명하지는 못한다. 그래서 '닿지 않음 증명' 대신 '계속
받음'으로 저장 데이터가 계속 불러와지게 했다: 불러오기 검사(`normalizeStoredPlaybackTransition`의 정확한 키 집합과 선택 키
`resumeFromSleep`, `timingMode`, 3000 ms 상한)는 바꾸지 않았고, 그 기록은 전과 같이 불러와 700 ms 앞섬으로 커밋된다. 바뀌는 것은
그 COMMIT과 그 전환의 PREPARE가 적는 종류(zero-start → scheduled-control)와 중복 ENDED가 그 전환에 합쳐지지 않는 것뿐이다.
outbox의 `timingMode` 없는 옛 기록은 재시도 상한 16번과 60초 간격으로 이미 끝났고, R4는 outbox 검사를 바꾸지 않는다.

## 증분 한눈에

부모 실패는 테스트 먼저 커밋을 그 부모 코드에서 돌린 결과(실패 / 그 실행의 전체 행)다. Worker 설정은 `vitest.workers.config.ts`의
69 files다. 실패 행은 모두 바꾼 행이고, 양쪽 통과를 뜻한 행은 부모에서도 통과했다.

| 증분 | 항목                                                            | 테스트 먼저 → 코드      | 부모 실패                       | 런타임 경로 |
| ---- | --------------------------------------------------------------- | ----------------------- | ------------------------------- | ----------- |
| R4-1 | ZS-04 후속, M9: 2999 ms 읽기 삭제, RO-03, ADR                   | `b3ba65ce` → `2de913e4` | 2 / 3,322(Worker 설정 69 files) | PRO         |
| R4-2 | PSK-07의 Worker 몫: CORS 이름 둘 삭제                           | `63a08154` → `32136843` | 1 / 3,322(Worker 설정 69 files) | PRO         |
| 기록 | 이 보고서, README, release-record §2·§4, PRO 운영 문서 Rollback | 기록 커밋               | 해당 없음                       | 없음        |

## 증분

### R4-1 PRO Worker가 저장 전환의 2999 ms 마감을 읽지 않음 (ZS-04 후속, M9)

`cloudflare/pro-room-worker.ts`에서 `PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS`와 그 주석 문단을 지웠다.
`playbackTransitionTimingMode`는 저장 전환이 적은 종류를, 없으면 scheduled-control을 돌려준다(서버 권한 ADR이 모르는 값을 읽는 방식과
같음). 부르는 세 곳(PREPARE 사건, 중복 ENDED 합치기 비교, COMMIT)은 그대로다. `PlaybackTransition.timingMode` 주석도 고쳤다.

- 남긴 것: 저장 전환의 선택 키 `timingMode`와 그 불러오기 검사, outbox PREPARE·COMMIT의 선택 키(Q4), 3000 ms 불러오기 상한, 이
  Worker가 쓰는 모든 기록(R2와 바이트로 같음, 아래 '되돌리기'), 불러올 때 숫자 LAN-direct `liveExpiresAt`을 null로 바꾸는 변환과 그
  이주 표시(R2-3. 그 뒤 한 번도 불러오지 않은 방은 숫자를 저장한 채 남고, 지우면 9.0.25 이상 App이 그 방의 하트비트 답 전체를 버림),
  저장 `presence.coordinatorParticipantId`(null, PSK-08), 계획의 남김 목록(PRES-3, PRO-12W, HDR-2, LEAVE-1 Worker 경로, PSK-08 ~ 10,
  PSK-11 신호 쪽, SIG-K1 ~ K5, ZS-08 ~ 10, PLE-K1 ~ K3).
- 시험(테스트 먼저 `b3ba65ce`): `pro-room-signaling-delivery.test.ts` 'stores a zero-start transition as the frozen v2 record and still
  commits a pre-v2 one after a cold restart as a scheduled control'의 old-to-new 반쪽이 2999 ms 기록을 콜드 재시작 뒤 COMMIT
  `timingMode` scheduled-control, 700 ms 앞섬, 같은 재생 상태로 커밋함을 본다. `pro-room-worker.test.ts` 'reads the start kind a stored
  transition names when it coalesces a duplicate ENDED'의 pre-v2 갈래는 중복 ENDED가 그 기록에 합쳐지지 않고 새 zero-start 전환(3000 ms
  마감, 종류 적음)을 열고 저장 전환을 CANCEL 'superseded'로 끝냄을 본다. 이름 붙은 두 갈래는 그대로다. `pro-room-playback-timing.test.ts`의
  'is what the stored zero-start deadline before schemaVersion 2 was built on'을 지웠고(장벽이 더 Worker가 읽는 마감을 들고 있지
  않음) 머리 주석을 고쳤다. 그 행만 쓰던 `__helpers__/pro-room-stored-transition-v1.ts`의 두 상수는 export를 뗐다(시험 도우미는
  dead-exports의 prod 파일이 아니라 기준치 0 / 20 / 76은 그대로). 도우미 설명은 뒤의 PRO Worker가 그 기록을 예약 제어로 읽는다고 적는다.
- 부모 `d0248df2`(PRO Worker는 `0e5a9b87`의 것)에서 Worker 설정 69 files / 3,322행 가운데 이 2행만 실패했다(COMMIT이 zero-start를 적음,
  중복 ENDED가 합쳐짐). 코드 커밋 `2de913e4`에서 3,322 모두 통과.
- 양쪽 통과로 남은 행: pre-v2 scheduled-control과 깨우기의 콜드 재시작 커밋, 'keeps a stored transition that names timingMode %s across a
  cold restart' it.each, 고정 v2 기록 바이트 동일 행(`__helpers__/pro-room-playback-records-v2.ts`), 51ab2be3 outbox old-to-new 행,
  'answers a live LAN-direct without a media deadline and loads a stored numeric one as the same share without it'(R2-3 변환 유지).
- 같은 커밋의 문서: 레지스트리 RO-03(아래 '기록과 레지스트리'), 서버 권한 ADR §6의 시작 종류 문단(그 앞 PRO Worker가 쓴 종류 없는
  저장 전환은 9.0.25 뒤의 PRO 전용 릴리스부터 불러와 700 ms 앞섬의 scheduled-control로 커밋, 모르는 값과 같음).

### R4-2 PRO CORS 허용 목록에서 opt-in 머리글 이름 둘 삭제 (PSK-07의 Worker 몫, HDR-1 뒤)

`corsHeaders`의 `access-control-allow-headers`가 `content-type,idempotency-key,authorization,x-mxqr-pro-participant-id,
x-mxqr-pro-presence-incarnation,x-mxqr-pro-presence-recovery,x-mxqr-app-build`다. 계획이 함께 든 Worker 주석(`6a23c46e`의 감싸개 옆)은
R2-1이 감싸개를 지울 때 이미 없어졌다(지금 `git grep -i 'x-mxqr-pro-entry-policy' cloudflare/` 0건).

- 남긴 것: `cloudflare/wrangler.pro-room.toml`의 `ALLOWED_ORIGINS`(known-accepted #10), 바닥 도구와 PRO smoke의 entry-policy
  머리글(Q10), 9.0.22 ~ 9.0.24 탭처럼 그 머리글을 싣는 Worker 시험 고정값(서버 요청이라 같은 답).
- 같은 커밋: `e2e/helpers/pro-room-fixture.ts`의 PRO CORS 모의에서 같은 두 이름을 뺐다(일관성만, App은 9.0.25부터 보내지 않음).
  `docs/design/pro-room-architecture-and-operations.md`의 bootstrap 문장이 '허용 목록이 아직 둘을 적음'에서 '9.0.25 뒤의 PRO 전용
  릴리스부터 적지 않음, 그 머리글을 보내는 loopback 페이지는 preflight가 실패, 서버 쪽 도구는 같은 답'으로 바뀌었다.
- 시험(테스트 먼저 `63a08154`): `pro-room-worker.test.ts` 'sets credentialed CORS only for an explicit allowlisted origin'이 위
  정확한 문자열을 보고, preflight 요청 머리글에서 `x-mxqr-pro-entry-policy`를 뺐으며 'The App still sends' 주석을 고쳤다. 부모
  `2de913e4`에서 Worker 설정 3,322행 가운데 이 1행만 실패했고 코드 커밋 `32136843`에서 모두 통과했다.
- 양쪽 통과: `pro-room-app-build-floor.test.ts`의 loopback preflight가 `x-mxqr-app-build`를 허용하는 행, 머리글을 실은 서버 요청 행
  (burst, workerd 신호 계약, 소유자 경계, DO 진단), 도구 단위 `live-pro-room-smoke-readiness.test.ts`와 `app-build-floor-script.test.ts`.

**개발 영향(계획 §3.11, 독립 리뷰 B L14 (d)):** 운영 PRO Worker는 loopback 출처(localhost와 127.0.0.1의 3000, 5173, 4173)를 허용한다.
두 머리글을 보내는 9.0.24 이하 로컬 빌드가 운영 PRO API를 부르면 preflight가 막혀 PRO 호출이 실패한다. preflight 캐시가 86400초라
이전 답을 캐시한 브라우저에서는 최대 하루 늦게 나타날 수 있다. 그 로컬 경로는 끝까지 열어 보지 않았다. 운영 App 페이지는 같은 출처
facade를 불러 preflight가 없다.

### 기록

- 이 보고서, `docs/README.md` 증거 목록.
- release-record §2: 이 릴리스의 '배포 전' 항목(배포 기록 PR이 '배포 뒤 확인'으로 바꿈)과 Phase 5.5 완료 항목의 '남은 제약'에 이
  릴리스 보고서 가리킴. §4: 이 릴리스 항목(배포 기록 PR이 머지 SHA, Release ID, checkpoint를 채움). §4 머리의 현재 경계 줄은 바꾸지
  않는다(새 경계 없음). §1과 `Last source review`는 배포 기록 PR이 덮어쓴다.
- `docs/design/pro-room-architecture-and-operations.md` Rollback: 9.0.25 뒤의 PRO 전용 릴리스는 PRO 스냅샷 schemaVersion 2를 처음 보내는
  PRO Worker와 같은 기록을 쓰고 그 Worker가 그 기록을 읽으므로 그 Worker가 복구 대상이자 바닥 그대로라는 한 문단.
- `docs/hotfix-procedure.md`는 바꾸지 않는다(새 되돌리기 경계가 없음).

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 `6a23c46e` 기준이다. 지금 main에서 CORS 목록은 `:1727`이 아니라 `:1755-1756`, 2999 상수는 `:1396`이었고,
   계획이 든 Worker 주석 `:7967-7975`는 이미 없었다. 기호로 다시 찾았다(R3 선례).
2. **Q1:** 계획은 옛 저장 전환의 처리를 정하지 않았다. 저장 데이터가 계속 불러와지도록 권장 (가)로 만들고 오너 답을 기다린다.
   (가)의 결과로 중복 ENDED가 그 기록에 합쳐지지 않는 것도 행으로 고정했다.
3. **R3이 R4로 미룬 두 주석은 싣지 않았다:** 공유 시간 파일 머리 주석(R3 보고서 '계획과 달라진 것' 3)은 PRO와 App 두 경로라 고치면
   `all`이 된다(Q2). `src/pro-room/snapshot.ts`의 'Opt-in summary'(R3 보고서 R3-4 '남긴 것')는 App 런타임 경로라 부분 게이트가
   `pro-room`을 거절한다(Q3). 둘 다 동작이 없는 주석이다.
4. **시간 시험 행과 도우미 export:** 계획은 `pro-room-playback-timing.test.ts`의 2999 행을 '삭제 또는 다시 씀'으로 두었다. 지웠고, 그
   행만 쓰던 도우미 상수 둘의 export를 뗐다.
5. **PRO 운영 문서 Rollback 문단:** 계획의 기록 목록(보고서, README, release-record)에 더해, 그 문서의 되돌리기 문단이 이 릴리스의
   복구 대상을 적도록 한 문단을 더했다(R2, R3 선례).

## 정확한 개수 가드

바뀐 기준치는 없다. `src/` 비시험 파일을 건드리지 않아 room-authority, bus-pairing, 선언된 메시지 종류가 그대로다.
dead-exports(401 prod files, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76), import-graph 순환 0, resource-ownership 49 records /
448 files도 그대로다. 줄 수: `cloudflare/pro-room-worker.ts` 18,378 → 18,368 / 20,000(R4-1이 줄임).

## 혼합 버전

| 조합                                                                         | 결과                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.0.22 이상 App(바닥 795가 들이는 모든 App), 이 PRO Worker                   | 바뀌지 않는다. PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker의 배포(2026-10-30 00:30 KST)부터 저장된 모든 전환이 `timingMode`를 가지므로 PREPARE와 COMMIT 와이어가 R2와 같다. 9.0.25 이상은 종류만 읽고, 9.0.22 ~ 9.0.24는 필드를 앞섬보다 먼저 읽는다               |
| 이 PRO Worker가 schemaVersion 2 앞 Worker의 대기 전환을 불러옴               | 버리지 않는다. 700 ms 앞섬의 예약 제어 COMMIT으로 나가고 9.0.22 이상 모든 App이 재생한다. 그 한 번의 시작만 배운 시작 앞섬이 없다. 그 전환에 중복 ENDED가 오면 합치지 않고 CANCEL 'superseded'와 새 zero-start 전환을 낸다(위 '저장 기록의 수명', 남아 있을 가능성은 낮음) |
| 바닥 795 아래 탭(바닥 전에 열려 남은 탭), 이 PRO Worker                      | R2 때 받아들인 비용 그대로(Q20)                                                                                                                                                                                                                                            |
| 이 PRO Worker가 쓴 상태를 R2 PRO Worker가 불러옴(실패 복구나 손 되돌리기 뒤) | 쓰는 기록이 R2와 바이트로 같아(고정 v2 기록 행이 부모와 이 Worker 양쪽에서 통과) 그대로 읽는다. R2 PRO Worker는 2999 ms도 읽고 머리글 이름의 상위집합을 허용한다                                                                                                           |
| 두 머리글을 보내는 9.0.24 이하 loopback 개발 페이지                          | preflight 실패(위 '개발 영향')                                                                                                                                                                                                                                             |
| 서버 쪽 도구(바닥 도구, PRO smoke)                                           | CORS를 거치지 않고 Worker가 머리글을 읽지 않아 같은 답                                                                                                                                                                                                                     |
| Signaling, 다른 넷, App                                                      | 바뀌지 않는다                                                                                                                                                                                                                                                              |

## 되돌리기

기본은 런타임 변경(`cloudflare/pro-room-worker.ts`)을 되돌려 `pro-room`으로 다시 내는 코드 되돌리기다(SemVer와 SW 캐시 그대로).
새 되돌리기 경계는 없다. release-record §4 머리의 현재 경계 줄 (7), (8), (9)가 그대로 유효하다.

- **실패 자동 복구:** `pro-room`의 실패 복구는 checkpoint의 PRO room(dispatch 때 live인 R2 PRO Worker: 머지 `0e5a9b87`, PRO 버전
  `ef882f7c`)을 되돌린다. 안전하다: 이 Worker가 쓰는 저장 기록은 그 Worker와 바이트로 같고(R4-1의 고정 v2 기록 행이 부모 `d0248df2`의
  그 Worker 코드와 이 Worker 양쪽에서 통과), 그 Worker는 2999 ms도 읽으며 머리글 이름의 상위집합을 허용한다. 다만 PRO 방 smoke는
  bootstrap 카나리아 둘과 익명 스냅샷 401만 보므로 Worker CORS preflight와 2999 경로의 결함은 커밋 표지까지 가고 이 복구는 돌지
  않는다. 평가 단계(Cloudflare R2 정책, Worker 호환 바닥)가 실패하면 대비 목록이 PRO를 건너뛰어 이 Worker가 실패 표시인 채 남는다.
  쓰는 모양이 같아 안전하고 앞으로 고친다.
- **손 되돌리기:** 결함이 커밋 표지를 지났으면 PRO를 이 릴리스 checkpoint의 R2 PRO Worker(`ef882f7c`)로 `versions deploy`한다
  (`--config cloudflare/wrangler.pro-room.toml`). App은 그대로라 `lower`가 필요 없다. 그 버전은 'Rollback:' 메시지라 git 출처가
  없으므로 다음 App 릴리스는 부분 게이트가 PRO에서 막고 다음 수리 릴리스는 `all`이다(hotfix-procedure의 출처 문단). 그 `all`은
  출처 없는 PRO 때문에 forward repair 판정이 참이 되어 PRO, Signaling, App의 자동 복구가 없으므로 손 되돌리기를 준비한 뒤에
  dispatch한다. 손 되돌리기도 배포라 기록 PR과 이력 한 행을 낸다.
- **R2 PRO Worker 아래로는 되돌리지 않는다:** 현재 경계 줄 (8) 그대로다(9.0.25 App이 배포됐으므로). 꼭 해야 하면 그 줄의 순서(App
  먼저)를 따른다. App을 795 아래로는 (9)의 합친 순서다.
- 계약 표지는 바꾸지 않았다.

## 배포 조건과 순서

1. (충족) R3(9.0.25, #532)의 배포와 그 기록(#533)이 main에 있다.
2. 오너 답(2026-10-30)대로 9.0.27의 배포와 기록 뒤에 이 릴리스를 낸다. 그때 이 브랜치를 그 기록 위로 옮기고, 테스트 먼저 두 커밋을
   옮긴 부모에서 다시 돌려 같은 행만 실패함을 보며, 이 보고서와 release-record 항목의 SHA를 고친다(QA 라운드 3). 9.0.27이 PRO
   Worker를 바꾸지 않았는지(`0e5a9b87..` 새 바탕의 `cloudflare/pro-room-worker.ts` blob이 `11c6390a`인지) 다시 본다. 바뀌었으면 되돌리기
   근거 행을 그 Worker로 다시 돈다. 9.0.27이 런타임 의존성을 바꿨으면 부분 게이트가 거절하므로 이 릴리스는 낼 수 없다(그때는
   오너와 다시 정함). Q1 ~ Q3의 답이 (가)가 아니면 그 답대로 고친 뒤 테스트 먼저부터 다시 한다.
3. dispatch 직전 live PRO Worker의 배포 메시지가 R2 머지 `git:0e5a9b87126aef7a5da0305cd4281fd3e36802ba`(PRO 버전 `ef882f7c`)이거나 그
   뒤 PRO 런타임 변경이 없는 자손이다(`0e5a9b87..d0248df2` 사이 PRO 런타임 경로 변경 없음을 로컬 git으로 확인함). 릴리스가 그 버전을
   checkpoint로 잡고 실패 복구는 거기로 간다. 다른 다섯 Worker의 `git:<sha>`와 런타임 경로는 부분 게이트가 본다.
4. 바닥 올리기 없음. dispatch 직전 공개 status로 저장·유효 795와 300초 안의 App 보고(`generatedAt - reportedAt`)를 확인한다(권장).
   PRO 최소 빌드 요구 값은 비어 있어 사전 검사는 지나간다. 다시 채우지 않는다.
5. 한 번에 한 열차: main 런타임이 배포본과 같을 때만 낸다. 이 PR은 dispatch 직전에만 머지하고 이 릴리스의 기록 PR 머지까지 다른
   PR을 머지하지 않는다. 이 배포까지 런타임 의존성 변경(Dependabot 포함)을 머지하지 않는다. 열린 Dependabot 묶음 갈래는 머지하지 않는다.
6. exact-main CI success 뒤 Release target `pro-room`, Developer API D1 `false`. live smoke는 PRO media R2 CORS와 PRO 방 smoke뿐이다.
7. 배포 직후(게이트 아님): 아래 '배포 직후 확인'의 블라인드 절차.
8. 기록 PR: §1과 `Last source review` 덮어쓰기, `release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로, §4의 이 항목에 머지
   SHA·Release ID·checkpoint, Phase 5.5 완료 항목의 런타임 의존성 동결 해제(근거와 함께). 그 기록이 main에 들어가면 Phase 5.5 끝
   조건 5가 채워지고 Phase 6 첫 단계(시험·검사만)를 시작한다.

## 배포 직후 확인 (블라인드, 게이트 아님)

PRO 방 smoke는 CORS preflight, 대기 전환의 종류, 하트비트를 운영에서 읽지 않으므로 R2와 같은 꼴로 한 번 사람이 읽는다. 확인하는
사람에게는 '절차'만 주고, 기준은 주지 않으며, 받은 관찰값을 여기 기준과 견준다.

**절차(확인하는 사람에게 주는 것):** (1) Release run이 끝난 뒤 30분 안에 데스크톱 Chromium에서 오너가 가진 PRO 방을 주소 끝에
`?mxqrLog=debug`를 붙여 연다. (2) 오너 계정으로 들어가 보이는 것(재생 목록, 참가자 목록, 오류 창이나 토스트의 문구)을 적는다.
(3) 재생 중이면 다른 트랙으로 바꾸고, 아니면 첫 트랙을 재생해 20초 듣는다. 소리가 났는지와 대략의 시작 시간을 적는다. (4) (선택,
같은 LAN의 두 번째 기기가 있을 때만) 시스템 오디오 공유를 시작하고 두 번째 기기로 2분 듣는다. (5) 채팅에 `/debug console`을
입력하고 `[PRO`로 시작하는 줄을 시각과 함께 복사한다. (6) 멈추고 나와서 적은 것, 복사한 줄, 브라우저 버전, 화면의 앱 버전을 돌려준다.

**통과 기준(주지 않음):** 방이 열리고 `INVALID_RESPONSE`나 `[PRO] Presence heartbeat failed`가 없다. 그 시작에
`[PRO YouTube] Zero-start playback released`가 한 번 있고 소리가 났다. (4)를 했고 공유가 LAN-direct로 갔으면 'Heartbeat state was not
applied'와 'Lease heartbeat failed'가 없다(이것이 R2 보고서 오너 기기 확인 후보 PLE-03, LAN-direct 공유가 PRO 배포를 건너는지의
기회다). 아니면 'LAN-direct 미확인'.

**실패하면:** 첫 두 기준 가운데 하나라도 어긋나고 일시적 네트워크 오류로 설명되지 않으면 위 '손 되돌리기'대로 PRO를 R2 PRO Worker로
되돌리고 기록한다.

## 사용자가 알아챌 변화

없다. 업데이트 창도 없다. 남아 있을 가능성이 낮은 그 앞 Worker의 대기 전환 하나는 그 한 번만 배운 시작 앞섬 없이 시작한다. 9.0.24
이하 로컬 개발 빌드로 운영 PRO API를 부르는 개발자만 preflight 실패를 본다.

## 기록과 레지스트리

- 레지스트리 RO-03: zero-start 인코딩 문장(Worker는 9.0.25 뒤의 PRO 전용 릴리스에서 2999 ms 읽기를 그만둠, 공유 시간 파일 머리
  주석은 낡은 채 남고 다음 `all` 릴리스가 고침), 시간 시험 설명에서 지운 행. 새 레코드 없음, 기준치 변경 없음.
- 서버 권한 ADR §6 시작 종류 문단, PRO 운영 문서(bootstrap 문장과 Rollback 한 문단).
- release-record §2·§4, `docs/README.md`. §1, `Last source review`, `release-history.md`는 배포 기록 PR이 쓴다.
- 열린 항목(이 릴리스가 남김): 공유 시간 파일 머리 주석(Q2, 다음 `all`), `src/pro-room/snapshot.ts`의 'Opt-in summary'(Q3, 다음 App).

## QA 라운드

### 1. 증분별

main `d0248df2` 위, 커밋 시각 2026-10-30 16:58 ~ 17:06 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`.

- R4-1 테스트 먼저 `b3ba65ce`: 바뀐 세 파일 611행 가운데 2행 실패, 이어 Worker 설정 69 files / 3,322행 가운데 같은 2행 실패(위
  R4-1). prettier, eslint.
- R4-1 코드 `2de913e4`: Worker 설정 3,322 모두 통과, `check:pro-room-modules`, eslint, prettier, dead-exports, source complexity,
  `check-resource-ownership`(부모와 출력이 글자 그대로 같음).
- R4-2 테스트 먼저 `63a08154`: Worker 설정 3,322행 가운데 CORS 행 1 실패.
- R4-2 코드 `32136843`: Worker 설정 3,322 모두 통과, `check:pro-room-modules`, eslint(Worker와 e2e 모의), prettier.

### 2. 전체 검사

코드 커밋 `32136843`(R4-2), 2026-10-30 17:07 ~ 17:21 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`. 깨끗한
트리에서 계획의 기본 검사를 한 번 돌렸고 모든 단계가 종료 코드 0이다. 기록 커밋은 문서만 더하므로 그 뒤 `guard:brand-capitalization`과
target 판정만 다시 돌렸다(아래).

- release target: `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`,
  `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 `d0248df2..32136843`을 견줌: PRO 방 1(`cloudflare/pro-room-worker.ts`),
  remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 0, App 런타임 의존성 차이 없음. release-record §4 현재
  경계 줄 (5)의 운영 배포 SHA(App `cbbc56d9`, PRO room `0e5a9b87`, 나머지 넷 `71f5b96c`) 대비도 같다. `releaseTargetWorkers('pro-room')`는
  PRO room 하나다. 운영을 조회하지 않았다.
- 정적 확인(계획 §3.12 끝 조건 2): `src`, `cloudflare`, `scripts`의 `*.ts`, `*.mts`(`__tests__`와 `*.test.ts` 제외)에서
  `PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS` 0건이고 끝 조건 2의 다른 아홉 이름도 0건이다. `git grep -i 'x-mxqr-pro-entry-policy'
cloudflare/`와 `x-mxqr-pro-playlist-slots`도 0건.
- typecheck 전체(`types:workers:check`, `typecheck:tests`, `tsconfig.tooling.json`, `tsconfig.e2e.json` 포함), `check:workers`(ops drift
  계약 포함), lint(app과 tooling), `format:check`.
- 가드: dead-exports(401 prod files, 2,108 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76), import-graph(401 files, 2,082 edges,
  순환 0), bus-pairing 202 / 202, lifecycle-writes, chunk-pump, navigation-sinks, room-authority-boundaries(직접 읽기 79, 구독 22, 쓰기
  13, PRO 읽기 0, 스냅샷 읽기 0), transport-health, standard-room-hot-path, developer-api-boundaries, prod-security, source-complexity
  (`cloudflare/pro-room-worker.ts` 18,368 / 20,000), `guard:sw-cache-version`('PASS: v799 (cbbc56d9) covers all committed PWA runtime
  changes', bump 없음), `guard:release-identity`('MUSIXQUARE 9.0.26; service-worker cache epoch v799'), `node
scripts/check-resource-ownership.mts`(49 records / 448 files, 부모와 출력이 같음).
- 단위 전체 706 files / 16,766 모두 통과, 333 s.
- Worker 설정 커버리지 69 files / 3,322 통과. 전체 86.7 / 83.54 / 94.34 / 90.97, `cloudflare/pro-room-worker.ts` 87.94 / 84.35 /
  96.36 / 91.98(문턱 83 / 78 / 94 / 88). 핵심 커버리지 90 files / 3,522 통과(80.83 / 75.7 / 86.67 / 84.65). release-tooling 커버리지
  14 files / 433 통과(79.55 / 75.24 / 86.38 / 81.48).
- `build:checked` 전체: brand capitalization 1,004 sources, 진입 842.0 KiB raw / 247.8 KiB gzip, eager JS 455.2 KiB gzip, eager total
  2,009.8 KiB raw / 532.6 KiB gzip, 레거시 TV(Chromium 79) 정적 검사, prod-hooks, prod-security, 글꼴(2,009.5 KiB), SW 앱 셸.
- `check:worker-bundles` 여섯 Worker(wrangler `deploy --dry-run`, 자격 증명 없이, 배포 없음): PRO 방 830.76 / gzip 162.54 KiB(R2의
  831.08 / 162.66에서 줄어듦), App 986.54 / 201.53, signaling 392.40 / 81.53, remote-share 150.40 / 33.39, Developer API 135.35 /
  30.43, Developer API facade 94.26 / 21.08 KiB.
- 되돌리기 근거: 부모 `d0248df2`의 `cloudflare/pro-room-worker.ts`는 R2 머지 `0e5a9b87`의 것과 같은 blob(`11c6390a`)이다. R4-1 테스트
  먼저 커밋을 그 코드에서 돌린 실행(라운드 1)에서 바꾼 두 행 밖의 모든 행, 곧 고정 v2 기록 바이트 동일 행, 콜드 재시작 old-to-new 행,
  51ab2be3 outbox 행이 통과했고, 같은 행이 이 Worker에서도 통과한다. 이것이 이 릴리스의 실패 자동 복구와 R2 PRO Worker로의 손
  되돌리기가 이 Worker의 기록을 지킨다는 근거다.
- 로컬 Playwright(Chromium, 포트 4647 / 9647, `build:e2e` 뒤, 17:21 ~ 17:28 KST): PRO 묶음(pro-activation-account, pro-entry-app-update,
  pro-entry-password, pro-entry-retry, pro-upload-recovery, dialog-locale-layout) 39 / 39, `test:e2e:critical` 100 / 100. R4-2가 두
  이름을 뺀 PRO CORS 모의(`e2e/helpers/pro-room-fixture.ts`)로 돈 것이다. e2e는 PRO Worker를 띄우지 않으므로 App 런타임이 main과
  같다는 레인 근거다(아래 '확인하지 않은 것').

### 3. main 위로 옮김 (9.0.27 배포·기록 뒤, 자리)

아직이다. 위 '배포 조건과 순서' 2.

### 4. 운영 전제: dispatch 직전 읽기 (자리)

아직이다. 위 '배포 조건과 순서' 3 ~ 5.

### 5. PR CI, 자동 코드 리뷰, exact-main CI, 배포, 공개 확인과 배포 직후 확인 (자리)

아직이다.

## 확인하지 않은 것

- 운영 Durable Object에 그 앞 PRO Worker가 쓴 대기 전환이 남아 있는지(저장을 읽을 수 없음, 위 '저장 기록의 수명').
- 실제 브라우저에서 운영 PRO Worker의 CORS preflight(로컬 시험은 in-process Worker의 답만 봄)와 9.0.24 이하 loopback 개발 경로.
- e2e PRO 고정값과 route 모의는 PRO Worker를 띄우지 않으므로 로컬 Playwright는 이 Worker의 변경을 지나지 않는다(App 런타임이 main과
  같다는 레인 근거뿐).
- 실기기, iOS Safari, WebKit 레인 전체, Full E2E. 운영 smoke는 2999 경로와 CORS preflight를 읽지 않는다.
- `security:audit`(npm 레지스트리 조회)는 돌리지 않았다. 의존성은 바뀌지 않았다.
