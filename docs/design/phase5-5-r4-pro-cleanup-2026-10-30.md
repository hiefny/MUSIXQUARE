# Phase 5.5 R4: PRO 정리, 옛 2999 ms 전환 읽기와 CORS 머리글 이름 둘 삭제, PRO Worker만 (2026-10-30)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 배포됨(2026-10-30 19:56 KST, [Release 41044220520](https://github.com/hiefny/MUSIXQUARE/actions/runs/41044220520), target `pro-room`, attempt 1 성공). 증분 R4-1, R4-2와 이 열차의 기록(이 보고서, `docs/README.md`, release-record §2·§4, PRO 운영 문서의 되돌리기 문단)을 만들고 증분별 검사(QA 라운드 1)와 기록 전 코드 커밋의 전체 기본 검사(QA 라운드 2)를 했다. 그 뒤 열차 리뷰의 지적을 코드와 대조해 반영했다(아래 '열차 리뷰와 반영': 중간 1, 낮음 5, 정보 3. 시험만인 후속 커밋 하나, 문서, 커밋 메시지의 질문 이름). 9.0.27이 오너 답을 기다리게 되어 순서를 바꿔 이 릴리스를 먼저 냈으므로 main 위로 옮김은 없었고(QA 라운드 3), 이어 dispatch 직전 읽기(QA 라운드 4), PR, PR CI, 자동 코드 리뷰, 머지, exact-main CI, 배포, 공개 확인, Drift Audit(QA 라운드 5)이 끝났다. PR #537(head `3553fd69`)은 squash `683074bc`(2026-10-30 19:45 KST, 부모 `d0248df2`, 트리는 head와 같음, 스쿼시 본문은 미리 준비한 열차 요약)로 main에 들어갔고, PRO room만 `ef882f7c` → `e7657f88`로 바뀌었다. 브랜치 `agent/p55-r4`는 main `d0248df2` 위 8커밋이다: 테스트 먼저 2, 코드 2, 기록 1, 시험만인 후속 1, 문서 2. 마지막 런타임 커밋은 R4-2 `c9f09514`다. 릴리스 기록의 §1, §2의 이 릴리스 항목('배포 뒤 확인')과 Phase 5.5 완료 항목의 런타임 의존성 동결 해제, §4의 이 릴리스 항목과 현재 경계 줄 (5)의 머지 SHA·Release ID·checkpoint, hotfix-procedure의 schemaVersion 2 PRO Worker 문단, `release-history.md`의 행은 배포 기록 PR이 적었다. 오너 질문 셋(R4-Q1 ~ R4-Q3, 아래 '오너 결정과 순서')은 답이 오기 전에 셋 모두 권장 (가)로 냈고 아침에 오너와 확인한다. 배포 직후 확인(블라인드, 게이트 아님)은 오너가 자고 있어 30분 안에 하지 못했고 다음 날 아침 늦은 확인으로 한다(아래 '배포 직후 확인'). 이 릴리스로 Phase 5.5의 계획한 릴리스가 모두 나갔다. 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다 |
| Base               | main `d0248df2`(App 9.0.26 열차의 기록 #535, 문서만). 그 아래 9.0.26(#534, squash `cbbc56d9`, 2026-10-30 13:08 KST 배포, App만), 9.0.25(#532, squash `b8ae59e7`, 07:18 KST, App만), PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker(#528, squash `0e5a9b87`, 00:30 KST, PRO room `ef882f7c`)가 있다. `cloudflare/pro-room-worker.ts`는 `0e5a9b87`과 `d0248df2`에서 같은 blob(`11c6390a`)이라 이 브랜치의 부모 PRO Worker는 dispatch 때의 운영 PRO Worker와 같은 코드다. 브랜치 `agent/p55-r4`, worktree `mxq-wt/p55-r4`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Version            | 앱 SemVer와 SW 캐시를 바꾸지 않는다(main의 9.0.26 / v799. 이 릴리스가 9.0.27보다 먼저 나가 배포 때 운영 App도 9.0.26 / v799). 업데이트 창이 없다. 바닥(저장·유효 795)을 바꾸지 않는다. Worker 전용 변경은 bump가 필요 없다(`docs/release-versioning.md`의 'A pure Worker-only change may leave both identifiers untouched', `docs/hotfix-procedure.md`의 SW 캐시 문단). 선례: PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker와 PRO 영수증 후속 열차 A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Scope              | Phase 5.5 계획의 R4(Q19 기본값, Phase 6 브리프 Q20 확인). R4-1: PRO Worker가 그 앞 PRO Worker가 저장한 대기 전환의 2999 ms 마감을 zero-start로 읽지 않는다(ZS-04 후속, M9). `timingMode` 없는 저장 전환은 그대로 불러와 예약 제어(scheduled-control)로 커밋한다(Q1 (가)). R4-2: PRO CORS 허용 목록이 `x-mxqr-pro-entry-policy`와 `x-mxqr-pro-playlist-slots`를 더 적지 않는다(PSK-07의 Worker 몫). App, 다른 다섯 Worker, 공유 시간 파일, D1, 비밀, 바인딩, Wrangler 설정(`ALLOWED_ORIGINS` 포함), 계약 표지, 쓰는 저장 모양, 의존성, PRO 최소 빌드 요구 값(빈 값)은 바꾸지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deploy target      | `pro-room`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 코드 커밋 `c9f09514`을 견준 로컬 git 판정(QA 라운드 2): main `d0248df2` 대비 PRO 방 1(`cloudflare/pro-room-worker.ts`), remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 0, App 런타임 의존성 차이 없음. 그때 release-record §4 현재 경계 줄 (5)가 적은 운영 배포 SHA(App 9.0.26 `cbbc56d9`, PRO room `0e5a9b87`, 나머지 넷 9.0.22 `71f5b96c`) 대비도 같다. 바뀐 시험 파일, e2e 모의, 문서는 어느 런타임 경로에도 없다. 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 호환 검사를 대신하지 않는다. Developer API D1 `false`. `raise_app_build_floor` 입력은 `pro-room`에 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Operations         | Production Release [41044220520](https://github.com/hiefny/MUSIXQUARE/actions/runs/41044220520)(target `pro-room`, 2026-10-30 19:56 KST)이 Worker 가운데 PRO room만 `ef882f7c` → `e7657f88`로 바꿨다. 같은 릴리스가 PRO media R2 CORS 정책을 저장소 파일(`cloudflare/r2-cors.pro-media.json`, 이 릴리스에서 바뀌지 않음) 그대로 다시 적용했고(규칙 하나), generic PRO grant D1 계약 단계를 돌렸다(35 queries, 3 rows read, 0 rows written). 릴리스의 나머지 운영 단계(checkpoint, 호환 floor, 부분 릴리스 판정, smoke)는 읽기만 했다. 그 밖에 운영에 닿은 것은 공개 GET(최소 빌드 상태, `/service-worker.js`)과 읽기만 하는 Operations Drift Audit 41044491969뿐이다(QA 라운드 4, 5). QA 라운드 1 ~ 2-1은 운영에 닿지 않았다(로컬 git과 로컬 시험만, `git fetch`는 이 브랜치를 만들 때 한 번)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Resource ownership | 새 복구·재시도·시간 제한·감시·생명주기 흐름이 없어 새 레코드는 없다. R4-1이 RO-03의 zero-start 인코딩 문장(Worker도 2999 ms 읽기를 그만둠, 공유 시간 파일 머리 주석이 낡은 채 남음)과 그 시간 시험 설명을 고쳤다. `node scripts/check-resource-ownership.mts` 출력은 부모와 글자 그대로 같다(49 records, 448 production files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

이 문서는 Phase 5.5 계획의 R4('PRO 정리', target `pro-room`)의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의
Phase 5.5 계획(2026-10-28)과 그 영역 조사, Phase 6 브리프와 오너 답(2026-10-30)이고, ZS, PSK, HDR, PLE 번호와 Q 번호(Q4, Q10, Q19,
Phase 6 브리프의 Q20)는 그 노트의 번호다. R4-Q1 ~ R4-Q3은 이 보고서가 새로 연 오너 질문이고 계획의 Q1 ~ Q3(열차 묶음, OV-F08 범위,
LAN-direct `liveExpiresAt` 저장)이나 Phase 6 브리프의 Q1 ~ Q3과 다르다. 계획의 줄 번호는 `6a23c46e` 기준이라 위치를 기호로 다시 찾았다. 증분마다 테스트를 먼저 커밋하고 부모 코드에서 바뀐 행만
실패함을 확인했다. 계획 단계 이름은 R1(9.0.22, [보고서](phase5-5-r1-train3-v2-accept-2026-10-29.md)), F2(바닥 795), R2(PRO 스냅샷
schemaVersion 2를 처음 보내는 PRO Worker, [보고서](phase5-5-r2-v2-send-2026-10-29.md)), R3(9.0.25,
[보고서](phase5-5-r3-v1-receive-stop-2026-10-30.md)), R4(이 릴리스)다. 영구 운영 문서(release-record §4, 설계 문서, 레지스트리)에는
단계 이름 대신 SemVer, 머지 SHA, 그리고 계약 문구 '9.0.25 뒤의 PRO 전용 릴리스'로 적었다. 이 릴리스는 SemVer가 없고 런타임 PR은
머지 전에 자기 머지 SHA를 모르므로 그 머지 SHA와 Release ID는 배포 기록 PR이 채운다. 영구 문서의 'R2'는 Cloudflare R2다.

## 오너 결정과 순서

- Q19(2026-10-28, 권장 기본): PRO CORS 머리글 이름 정리와 옛 2999 저장 해석 삭제를 R3 기록 뒤, Phase 6 시작 전에 target
  `pro-room` 릴리스 하나(R4)로 낸다. 손 되돌리기 경계는 R2와 같고('PRO ≥ R2') 배포 조건도 R2와 같은 꼴이다.
- Phase 6 브리프 Q20(2026-10-30 오너 답): R4는 Phase 6 앞, PRO 방 서버만, 업데이트 창 없음. 같은 답의 Q0: R4가 나가고 기록되면
  Phase 6 첫 단계(시험·검사만)를 따로 '시작' 없이 시작한다. 순서: 처음에는 9.0.27 배포·기록 → R4 배포·기록 → Phase 6 첫 단계로 잡았다. 2026-10-30 저녁 9.0.27의 열차 리뷰가 오너에게 물을
  질문(SFU 넘어가기가 최대 약 1초 늦어질 수 있음)을 열어 9.0.27이 오너 답을 기다리게 되어, 업데이트 창이 없는 R4를 먼저 낸다.
  순서: R4 배포·기록 → Phase 6 첫 단계 → 오너 답 뒤 9.0.27.
- Q10(2026-10-28): CORS 정리는 R3 뒤 첫 PRO Worker 릴리스. 바닥 도구와 PRO smoke는 entry-policy 머리글을 계속 보낸다(서버 요청이라
  CORS를 거치지 않고 Worker가 읽지 않아 결과가 같음).
- Q4(2026-10-28): `timingMode`는 끝까지 선택 필드다. 저장 전환의 선택 키와 outbox PREPARE·COMMIT의 선택 키를 남긴다.
- 배포 정책(2026-10-25): 자동 게이트가 통과하면 따로 묻지 않고 배포한다. 기기 근거는 게이트가 아니다.
- **오너 질문(2026-10-30, 셋 모두 권장 (가)로 만들어 냄, 아침에 확인).** 셋 다 화면은 그대로다. 번호는 이 보고서의 것이다(위
  머리 문단). 배포 때까지 답이 없었다: 오너는 그날 저녁 Phase 6 내부 항목에 '권장'으로 답한 뒤 잠들었고, 아래 (나) 가운데
  R4-Q1은 저장 데이터 규칙과, R4-Q2는 정한 Q20과 맞서 (가)가 일관된 유일한 선택이었다(R4-Q3 (나)는 코드 변화 없음). 아침에
  오너와 확인하고, 답이 (가)가 아니면 아래 '배포 조건과 순서' 2대로 한다.
  - R4-Q1 `timingMode` 없는 옛 저장 전환(PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker 앞의 Worker가 쓴 것)을 R4가 만나면:
    (가, 권장) 버리지 않고 예약 제어로 읽어 평소처럼 커밋한다. 그 한 번의 시작만 기기별 배운 시작 앞섬 없이 시작한다. (나) 정확한
    키로 바꿔 무효로 버린다. CANCEL 없이 null이 되어 그 시작이 일어나지 않고 로딩 표시가 다음 명령까지 남을 수 있다. **(나)는 지금
    고를 수 없다:** 저장 모양을 그만 읽으려면 그 모양이 남지 않았음을 먼저 증명해야 하는데(이 열차의 규칙, 아래 '저장 기록의 수명')
    운영 Durable Object 저장을 읽을 수 없어 그 증명을 지금 할 수 없다. 계획은 정하지 않았고, Q4(선택 필드)와 계획 ZS-04의 위험
    문단, 서버 권한 ADR의 와이어 규칙(종류 없는 COMMIT은 scheduled-control)이 (가) 쪽이다. 증명이 생겨 (나)를 고르면 R4-1의 테스트
    먼저 행과 코드가 바뀐다(불러올 때 null, COMMIT 없음).
  - R4-Q2 공유 시간 파일 `cloudflare/pro-room-playback-timing.ts`의 머리 주석(2999·699를 '각 파일이 들고 있다'): R4 뒤 낡지만
    고치면 R4가 `all`(여섯 Worker 재배포, 신호 Durable Object 재시작, 넓은 자동 복구)이 된다. (가, 권장) R4는 `pro-room` 그대로, 그
    주석은 다음 `all` 릴리스 때 고친다(이 보고서와 RO-03에 열린 항목). (나) R4를 `all`로 낸다. **(나)는 이미 정한 Phase 6 브리프
    Q20('R4는 PRO 방 서버만')을 뒤집는다.** 바꾸는 것은 동작 없는 주석 한 문단뿐이다.
  - R4-Q3 `src/pro-room/snapshot.ts`의 `parsePlaylistSlots` 문서 주석 'Opt-in summary': App 파일이라 R4에 실으면 부분 게이트가
    `pro-room`을 거절한다. (가, 권장) 준비 중인 9.0.27 또는 다음 App 업데이트에 싣는다(주석뿐, 동작 변화 없음). (나) 그대로 둔다.

## 이 릴리스가 기대는 것

| 이 릴리스가 그만두는 것                                                 | 그것을 쓰던 쪽                                                                    | dispatch 때 운영                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 저장 전환의 2999 ms 마감을 zero-start로 읽기                            | PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker 앞의 PRO Worker(그 저장 기록) | 그 PRO Worker(머지 `0e5a9b87`, PRO 버전 `ef882f7c`, 2026-10-30 00:30 KST부터 이 릴리스까지 live)는 여는 모든 전환에 `timingMode`를 저장한다. 그 앞 기록은 아래 '저장 기록의 수명'대로 남을 수 있어 버리지 않고 예약 제어로 읽는다(R4-Q1 (가)) |
| CORS 허용 목록의 `x-mxqr-pro-entry-policy`, `x-mxqr-pro-playlist-slots` | 9.0.24 이하 App(9.0.25부터 보내지 않음)                                           | 운영 App은 9.0.26(바닥 795가 들이는 9.0.22 ~ 9.0.24 탭은 남을 수 있음). 운영 App 페이지는 같은 출처 facade를 불러 preflight가 없고 PRO Worker는 공개 경로가 없다. 영향은 아래 '개발 영향'뿐이다                                               |

### 저장 기록의 수명 (R4-Q1의 근거)

모든 전환의 마감은 만든 뒤 3000 ms 이하다(불러오기 검사의 상한과 새 전환의 마감). Worker는 마감에(이미 지났으면 다음 틱에) alarm을
걸고, alarm은 방을 불러 prune을 돌며 prune은 마감이 지난 전환을 커밋한다. 모든 일반 요청도 처리 전에 prune을 돈다. 서비스 점검
중에는 60초마다 alarm을 다시 건다. 그 앞 PRO Worker가 `timingMode` 없이 저장한 전환이 남을 수 있는 방은 2026-10-30 00:30 KST 배포
순간 3초 창 안에 전환이 대기 중이었고, 그 뒤 alarm 재시도가 모두 실패했으며, 그 뒤 요청이 한 번도 오지 않은 방뿐이다. 운영
Durable Object 저장을 읽을 수 없어(이 작업은 공개 GET만 허용) 0이라고 증명하지는 못한다. 그래서 '닿지 않음 증명' 대신 '계속
받음'으로 저장 데이터가 계속 불러와지게 했다: 불러오기 검사(`normalizeStoredPlaybackTransition`의 정확한 키 집합과 선택 키
`resumeFromSleep`, `timingMode`, 3000 ms 상한)는 바꾸지 않았고, 그 기록은 전과 같이 불러와 700 ms 앞섬으로 커밋된다. 코드에서
바뀌는 것은 그 전환의 PREPARE와 COMMIT이 적는 종류(zero-start → scheduled-control)와 중복 ENDED가 그 전환에 합쳐지지 않는
것이다. outbox의 `timingMode` 없는 옛 기록은 재시도 상한 16번과 60초 간격으로 이미 끝났고, R4는 outbox 검사를 바꾸지 않는다.

**운영에서 닿는 변화는 COMMIT의 종류 표지뿐이다(열차 리뷰 정보 지적).** 남아 있을 수 있는 옛 전환은 마감이 모두 2026-10-30
00:30 KST + 3초 안이라 R4가 배포될 때 이미 지났다. 그리고 prune이 PREPARE나 ENDED에 닿는 모든 처리기보다 먼저 돈다: 방 경로
(신호 티켓, 재생 명령, 재생 READY를 포함한 일반 경로), developer·bot 내부 경로, 권한 확인 내부 경로, alarm. prune은 마감이 지난
전환을 그 자리에서 커밋한다(`prune`의 `deadlineAtMs <= nowMs` 갈래, 참여자 정리보다 앞). 불러오기 검사가 코디네이터 epoch와 재생
revision이 맞는 기록만 받으므로 그 커밋이 'stale' 취소로 끝나지도 않는다. 공개 bootstrap은 prune을 돌지 않지만 대기 전환을 읽지
않고, 자연 종료 자동 진행은 대기 전환이 있으면 돌지 않는다. 그래서 티켓과 명령 답의 PREPARE 재전송과 중복 ENDED 합치기 비교는
운영에서 그 기록을 볼 수 없고, 그 둘을 고정한 행(아래 R4-1의 시험)은 운영에서 만들 수 없는 상태를 고정하는 특성 시험이다.

## 증분 한눈에

부모 실패는 테스트 먼저 커밋을 그 부모 코드에서 돌린 결과(실패 / 그 실행의 전체 행)다. Worker 설정은 `vitest.workers.config.ts`의
69 files다. 실패 행은 모두 바꾼 행이고, 양쪽 통과를 뜻한 행은 부모에서도 통과했다.

| 증분 | 항목                                                            | 테스트 먼저 → 코드      | 부모 실패                       | 런타임 경로 |
| ---- | --------------------------------------------------------------- | ----------------------- | ------------------------------- | ----------- |
| R4-1 | ZS-04 후속, M9: 2999 ms 읽기 삭제, RO-03, ADR                   | `58579c70` → `69cbb510` | 2 / 3,322(Worker 설정 69 files) | PRO         |
| R4-2 | PSK-07의 Worker 몫: CORS 이름 둘 삭제                           | `045b183a` → `c9f09514` | 1 / 3,322(Worker 설정 69 files) | PRO         |
| 기록 | 이 보고서, README, release-record §2·§4, PRO 운영 문서 Rollback | 기록 커밋               | 해당 없음                       | 없음        |
| 후속 | 열차 리뷰: 불러온 pre-v2 기록의 티켓 PREPARE 종류(시험만)       | `ce174b41`(코드 없음)   | 1행(R2 PRO Worker blob에서)     | 없음        |
| 반영 | 열차 리뷰의 문서 반영(이 보고서, release-record, ADR)           | 반영 커밋               | 해당 없음                       | 없음        |

R4-1, R4-2와 기록 커밋의 SHA는 열차 리뷰 반영에서 커밋 메시지의 질문 이름(R4-Q1 ~ R4-Q3)과 R4-1 코드 커밋 메시지의 ADR 인용을
고치려고 같은 트리로 다시 만든 커밋이다(처음 커밋 `b3ba65ce`, `2de913e4`, `63a08154`, `32136843`, 기록 `80591cb5`와 트리가 하나하나
같고 작성자·시각도 같다. 메시지 안의 부모 SHA도 새 SHA로 고침). 그래서 그 커밋에서 돌린 QA 라운드 1과 2의 결과가 그대로 이 SHA의
결과다.

## 증분

### R4-1 PRO Worker가 저장 전환의 2999 ms 마감을 읽지 않음 (ZS-04 후속, M9)

`cloudflare/pro-room-worker.ts`에서 `PLAYBACK_ZERO_START_TRANSITION_DEADLINE_MS`와 그 주석 문단을 지웠다.
`playbackTransitionTimingMode`는 저장 전환이 적은 종류를, 없으면 scheduled-control을 돌려준다(App이 종류 없는 COMMIT을 읽는 방식과
같음. 저장 전환의 모르는 종류는 다르다: 불러오기 검사가 그 기록을 거절해 null이 되고 이 릴리스도 그대로다). 부르는 세 곳(PREPARE 사건,
중복 ENDED 합치기 비교, COMMIT)은 그대로다. `PlaybackTransition.timingMode` 주석도 고쳤다.

- 남긴 것: 저장 전환의 선택 키 `timingMode`와 그 불러오기 검사, outbox PREPARE·COMMIT의 선택 키(Q4), 3000 ms 불러오기 상한, 이
  Worker가 쓰는 모든 기록(R2와 바이트로 같음, 아래 '되돌리기'), 불러올 때 숫자 LAN-direct `liveExpiresAt`을 null로 바꾸는 변환과 그
  이주 표시(R2-3. 그 뒤 한 번도 불러오지 않은 방은 숫자를 저장한 채 남고, 지우면 9.0.25 이상 App이 그 방의 하트비트 답 전체를 버림),
  저장 `presence.coordinatorParticipantId`(null, PSK-08), 계획의 남김 목록(PRES-3, PRO-12W, HDR-2, LEAVE-1 Worker 경로, PSK-08 ~ 10,
  PSK-11 신호 쪽, SIG-K1 ~ K5, ZS-08 ~ 10, PLE-K1 ~ K3).
- 시험(테스트 먼저 `58579c70`): `pro-room-signaling-delivery.test.ts` 'stores a zero-start transition as the frozen v2 record and still
  commits a pre-v2 one after a cold restart as a scheduled control'의 old-to-new 반쪽이 2999 ms 기록을 콜드 재시작 뒤 COMMIT
  `timingMode` scheduled-control, 700 ms 앞섬, 같은 재생 상태로 커밋함을 본다. `pro-room-worker.test.ts` 'reads the start kind a stored
  transition names when it coalesces a duplicate ENDED'의 pre-v2 갈래는 중복 ENDED가 그 기록에 합쳐지지 않고 새 zero-start 전환(3000 ms
  마감, 종류 적음)을 열고 저장 전환을 CANCEL 'superseded'로 끝냄을 본다. 이름 붙은 두 갈래는 그대로다. `pro-room-playback-timing.test.ts`의
  'is what the stored zero-start deadline before schemaVersion 2 was built on'을 지웠고(장벽이 더 Worker가 읽는 마감을 들고 있지
  않음) 머리 주석을 고쳤다. 그 행만 쓰던 `__helpers__/pro-room-stored-transition-v1.ts`의 두 상수는 export를 뗐다(시험 도우미는
  dead-exports의 prod 파일이 아니라 기준치 0 / 20 / 76은 그대로). 도우미 설명은 뒤의 PRO Worker가 그 기록을 예약 제어로 읽는다고 적는다.
- 부모 `d0248df2`(PRO Worker는 `0e5a9b87`의 것)에서 Worker 설정 69 files / 3,322행 가운데 이 2행만 실패했다(COMMIT이 zero-start를 적음,
  중복 ENDED가 합쳐짐). 코드 커밋 `69cbb510`에서 3,322 모두 통과.
- 후속 시험(열차 리뷰 낮음, `ce174b41`, 시험만): 위 콜드 재시작 행이 재시작 뒤 alarm 전에 오너의 신호 티켓을 받아, 불러온 2999 ms
  기록의 PREPARE(type, transitionId, serverTimeMs, 마감 2999, basePlaybackRevision, target)가 정확히 `timingMode` scheduled-control을
  적음을 본다. pre-v2 기록이 R4에 닿는 길은 불러오기(`normalizeStoredPlaybackTransition`) 하나인데, 중복 ENDED 행의 pre-v2 갈래는
  메모리 안 기록을 고치는 원래 하네스라 그 길을 지나지 않고, 티켓·명령 답의 PREPARE에는 불러온 기록의 행이 없었다. 이 행으로
  티켓 PREPARE와 COMMIT이 불러온 기록에서 같은 종류를 읽음을 묶는다. R2 PRO Worker(blob `11c6390a`)를 넣고 돌리면 이 행이 새 단언에서
  실패하고(티켓 PREPARE가 zero-start), 이 Worker에서는 통과한다. 운영에서는 닿지 않는 상태다(위 '저장 기록의 수명').
- 양쪽 통과로 남은 행: pre-v2 scheduled-control과 깨우기의 콜드 재시작 커밋, 'keeps a stored transition that names timingMode %s across a
  cold restart' it.each, 고정 v2 기록 바이트 동일 행(`__helpers__/pro-room-playback-records-v2.ts`), 51ab2be3 outbox old-to-new 행,
  'answers a live LAN-direct without a media deadline and loads a stored numeric one as the same share without it'(R2-3 변환 유지).
- 같은 커밋의 문서: 레지스트리 RO-03(아래 '기록과 레지스트리'), 서버 권한 ADR §6의 시작 종류 문단(그 앞 PRO Worker가 쓴 종류 없는
  저장 전환은 9.0.25 뒤의 PRO 전용 릴리스부터 불러와 700 ms 앞섬의 scheduled-control로 커밋). 그 문단이 처음에 '모르는 값과 같음'이라
  적은 것은 열차 리뷰 반영에서 'App 쪽의 종류 없는 COMMIT과 같음, 모르는 종류의 저장 전환은 불러올 때 거절'로 고쳤다(모르는 값을
  scheduled-control로 읽는 것은 App의 와이어 규칙이고 Worker는 저장 전환의 모르는 종류를 거절한다).

### R4-2 PRO CORS 허용 목록에서 opt-in 머리글 이름 둘 삭제 (PSK-07의 Worker 몫, HDR-1 뒤)

`corsHeaders`의 `access-control-allow-headers`가 `content-type,idempotency-key,authorization,x-mxqr-pro-participant-id,
x-mxqr-pro-presence-incarnation,x-mxqr-pro-presence-recovery,x-mxqr-app-build`다. 계획이 함께 든 Worker 주석(`6a23c46e`의 감싸개 옆)은
R2-1이 감싸개를 지울 때 이미 없어졌다(지금 `git grep -i 'x-mxqr-pro-entry-policy' cloudflare/` 0건).

- 남긴 것: `cloudflare/wrangler.pro-room.toml`의 `ALLOWED_ORIGINS`(known-accepted #10), 바닥 도구와 PRO smoke의 entry-policy
  머리글(Q10), 9.0.22 ~ 9.0.24 탭처럼 그 머리글을 싣는 Worker 시험 고정값(서버 요청이라 같은 답).
- 같은 커밋: `e2e/helpers/pro-room-fixture.ts`의 PRO CORS 모의에서 같은 두 이름을 뺐다(일관성만, App은 9.0.25부터 보내지 않음).
  `docs/design/pro-room-architecture-and-operations.md`의 bootstrap 문장이 '허용 목록이 아직 둘을 적음'에서 '9.0.25 뒤의 PRO 전용
  릴리스부터 적지 않음, 그 머리글을 보내는 loopback 페이지는 preflight가 실패, 서버 쪽 도구는 같은 답'으로 바뀌었다.
- 시험(테스트 먼저 `045b183a`): `pro-room-worker.test.ts` 'sets credentialed CORS only for an explicit allowlisted origin'이 위
  정확한 문자열을 보고, preflight 요청 머리글에서 `x-mxqr-pro-entry-policy`를 뺐으며 'The App still sends' 주석을 고쳤다. 부모
  `69cbb510`에서 Worker 설정 3,322행 가운데 이 1행만 실패했고 코드 커밋 `c9f09514`에서 모두 통과했다.
- 양쪽 통과: `pro-room-app-build-floor.test.ts`의 loopback preflight가 `x-mxqr-app-build`를 허용하는 행, 머리글을 실은 서버 요청 행
  (burst, workerd 신호 계약, 소유자 경계, DO 진단), 도구 단위 `live-pro-room-smoke-readiness.test.ts`와 `app-build-floor-script.test.ts`.

**개발 영향(계획 §3.11, 독립 리뷰 B L14 (d)):** 운영 PRO Worker는 loopback 출처(localhost와 127.0.0.1의 3000, 5173, 4173)를 허용한다.
두 머리글을 보내는 9.0.24 이하 로컬 빌드가 운영 PRO API를 부르면 preflight가 막혀 PRO 호출이 실패한다. preflight 캐시가 86400초라
이전 답을 캐시한 브라우저에서는 최대 하루 늦게 나타날 수 있다. 그 로컬 경로는 끝까지 열어 보지 않았다. 운영 App 페이지는 같은 출처
facade를 불러 preflight가 없다.

### 기록

- 이 보고서, `docs/README.md` 증거 목록.
- release-record §2: 이 릴리스의 '배포 전' 항목(배포 기록 PR이 '배포 뒤 확인'으로 바꿈)과 Phase 5.5 완료 항목의 '남은 제약'에 이
  릴리스 보고서 가리킴. §4: 이 릴리스 항목(배포 기록 PR이 머지 SHA, Release ID, checkpoint를 채움). 이 PR은 §4 머리의 현재 경계
  줄을 바꾸지 않는다(새 경계 없음). 다만 줄 (5)의 운영 PRO('(6)의 PRO Worker(`ef882f7c`)')는 배포 사실이라 배포 기록 PR이 이
  릴리스의 PRO 버전과 머지 SHA로 고친다(9.0.24 ~ 9.0.26 기록 PR이 매번 (5)를 고친 것과 같음, 아래 '배포 조건과 순서' 8).
  §1과 `Last source review`는 배포 기록 PR이 덮어쓴다.
- `docs/design/pro-room-architecture-and-operations.md` Rollback: 9.0.25 뒤의 PRO 전용 릴리스는 PRO 스냅샷 schemaVersion 2를 처음 보내는
  PRO Worker와 같은 기록을 쓰고 그 Worker가 그 기록을 읽으므로 그 Worker가 복구 대상이자 바닥 그대로라는 한 문단.
- `docs/hotfix-procedure.md`는 이 PR에서 바꾸지 않는다(새 되돌리기 경계가 없음). schemaVersion 2를 처음 보내는 PRO Worker 문단의
  '`ef882f7c` ... it has been live since then'은 이 릴리스가 배포되면 틀리므로 배포 기록 PR이 '이 릴리스까지 live였다'로 고친다(그
  Worker가 이 릴리스의 checkpoint이자 복구 대상이라는 뜻은 그대로).

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 `6a23c46e` 기준이다. 지금 main에서 CORS 목록은 `:1727`이 아니라 `:1755-1756`, 2999 상수는 `:1396`이었고,
   계획이 든 Worker 주석 `:7967-7975`는 이미 없었다. 기호로 다시 찾았다(R3 선례).
2. **R4-Q1:** 계획은 옛 저장 전환의 처리를 정하지 않았다(ZS-04의 위험 문단은 그 해석을 지워도 된다고만 적음). 저장 데이터가 계속
   불러와지도록 권장 (가)로 만들고 오너 답을 기다린다. (가)의 결과로 중복 ENDED가 그 기록에 합쳐지지 않는 것과 티켓 PREPARE가
   scheduled-control을 적는 것도 행으로 고정했다(운영에서는 닿지 않음, 위 '저장 기록의 수명').
3. **R3이 R4로 미룬 두 주석은 싣지 않았다:** 공유 시간 파일 머리 주석(R3 보고서 '계획과 달라진 것' 3)은 PRO와 App 두 경로라 고치면
   `all`이 된다(R4-Q2). `src/pro-room/snapshot.ts`의 'Opt-in summary'(R3 보고서 R3-4 '남긴 것')는 App 런타임 경로라 부분 게이트가
   `pro-room`을 거절한다(R4-Q3). 둘 다 동작이 없는 주석이다.
4. **시간 시험 행과 도우미 export:** 계획은 `pro-room-playback-timing.test.ts`의 2999 행을 '삭제 또는 다시 씀'으로 두었다. 지웠고, 그
   행만 쓰던 도우미 상수 둘의 export를 뗐다.
5. **PRO 운영 문서 Rollback 문단:** 계획의 기록 목록(보고서, README, release-record)에 더해, 그 문서의 되돌리기 문단이 이 릴리스의
   복구 대상을 적도록 한 문단을 더했다(R2, R3 선례).

## 정확한 개수 가드

바뀐 기준치는 없다. `src/` 비시험 파일을 건드리지 않아 room-authority, bus-pairing, 선언된 메시지 종류가 그대로다.
dead-exports(401 prod files, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76), import-graph 순환 0, resource-ownership 49 records /
448 files도 그대로다. 줄 수: `cloudflare/pro-room-worker.ts` 18,378 → 18,368 / 20,000(R4-1이 줄임).

## 혼합 버전

| 조합                                                                         | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.0.22 이상 App(바닥 795가 들이는 모든 App), 이 PRO Worker                   | 바뀌지 않는다. PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO Worker의 배포(2026-10-30 00:30 KST)부터 저장된 모든 전환이 `timingMode`를 가지므로 PREPARE와 COMMIT 와이어가 R2와 같다. 9.0.25 이상은 종류만 읽고, 9.0.22 ~ 9.0.24는 필드를 앞섬보다 먼저 읽는다                                                                                                                                                                                         |
| 이 PRO Worker가 schemaVersion 2 앞 Worker의 대기 전환을 불러옴               | 버리지 않는다. 700 ms 앞섬의 예약 제어 COMMIT으로 나가고 9.0.22 이상 모든 App이 재생한다. 그 한 번의 시작만 배운 시작 앞섬이 없다. 운영에서 닿는 변화는 이 COMMIT의 종류뿐이다: 그 기록은 마감이 이미 지나 prune이 모든 처리기 앞에서 커밋하므로 PREPARE 재전송이나 중복 ENDED 합치기에 닿지 않는다(위 '저장 기록의 수명', 남아 있을 가능성은 낮음). 시험에서만 마감 전 그 기록이 티켓 PREPARE에 scheduled-control을 적고 중복 ENDED를 합치지 않는다 |
| 바닥 795 아래 탭(바닥 전에 열려 남은 탭), 이 PRO Worker                      | R2 때 받아들인 비용 그대로(Q20)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 이 PRO Worker가 쓴 상태를 R2 PRO Worker가 불러옴(실패 복구나 손 되돌리기 뒤) | 쓰는 기록이 R2와 바이트로 같아(고정 v2 기록 행이 부모와 이 Worker 양쪽에서 통과) 그대로 읽는다. R2 PRO Worker는 2999 ms도 읽고 머리글 이름의 상위집합을 허용한다                                                                                                                                                                                                                                                                                     |
| 두 머리글을 보내는 9.0.24 이하 loopback 개발 페이지                          | preflight 실패(위 '개발 영향')                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 서버 쪽 도구(바닥 도구, PRO smoke)                                           | CORS를 거치지 않고 Worker가 머리글을 읽지 않아 같은 답                                                                                                                                                                                                                                                                                                                                                                                               |
| Signaling, 다른 넷, App                                                      | 바뀌지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 되돌리기

기본은 런타임 변경(`cloudflare/pro-room-worker.ts`)을 되돌려 `pro-room`으로 다시 내는 코드 되돌리기다(SemVer와 SW 캐시 그대로).
새 되돌리기 경계는 없다. release-record §4 머리의 현재 경계 줄 (8)과 (9)가 그대로 유효하다((3)이 적듯 PRO 손 되돌리기 바닥은 이제
(8)이고, (7)은 (8)의 순서 안에서 그 아래 바닥으로 남는다).

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
2. 순서를 바꿨다(위 '오너 결정과 순서'). 9.0.27이 오너 답을 기다리므로 이 릴리스를 먼저 낸다. 이 브랜치의 바탕이 그대로 main
   `d0248df2`라 옮김이 없고, 운영 App은 9.0.26 / v799 그대로라 'App 9.0.26 / v799 그대로' 표기도 맞다. dispatch 직전 main이 그대로
   `d0248df2`인지 본다(다른 PR이 먼저 머지됐으면 그 위로 옮기고 테스트 먼저 두 커밋을 옮긴 부모에서 다시 돌린다). 새 바탕의
   `cloudflare/pro-room-worker.ts` blob은 R2 머지 `0e5a9b87`의 것(`11c6390a`)이다. 9.0.27은 이 릴리스의 기록 뒤에 그 위로 옮긴다. 오너 답이 권장 (가)가 아니면: R4-Q3 (나)는 주석을 그대로
   두는 것이라 코드가 바뀌지 않는다. R4-Q1 (나)는 옛 저장 전환이 남지 않았다는 증명이 먼저 있어야 하고(지금은 할 수 없음), 그때
   그 답대로 테스트 먼저부터 다시 한다. R4-Q2 (나)는 정한 Q20을 뒤집는 것이라 오너가 그 결정을 다시 열 때만 `all`로 다시 만든다.
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
   SHA·Release ID·checkpoint, §4 머리 현재 경계 줄 (5)의 운영 PRO('(6)의 PRO Worker(`ef882f7c`)')를 이 릴리스의 PRO 버전과 머지
   SHA로(그 줄의 운영 App과 다른 넷은 그대로 확인), `docs/hotfix-procedure.md`의 schemaVersion 2를 처음 보내는 PRO Worker 문단에서
   '`ef882f7c` ... it has been live since then'을 이 릴리스까지 live였다는 문장으로, Phase 5.5 완료 항목의 런타임 의존성 동결
   해제(근거와 함께). 그 기록이 main에 들어가면 Phase 5.5 끝 조건 5가 채워지고 Phase 6 첫 단계(시험·검사만)를 시작한다.

결과(QA 라운드 3 ~ 5): 1은 그대로였다. 2는 순서를 바꿔 이 릴리스를 먼저 냈고, 바탕 `d0248df2`가 머지 직전까지 main이라
옮기지 않았다(squash `683074bc`의 부모가 `d0248df2`이고 트리는 PR head `3553fd69`와 같음, QA 라운드 3). 9.0.27(PR #536)은 열린
채 오너 답을 기다리고 이 릴리스의 기록 위로 옮긴다. 오너 질문은 답이 오기 전에 셋 모두 권장 (가)로 냈다(위 '오너 결정과 순서').
3은 dispatch 직전에 사람이 따로 읽은 근거가 없고, 릴리스의 checkpoint, PRO 방 배포 직전 'Verified unchanged production deployment
for pro-room', 배포 단계가 바꾼 버전 `ef882f7c`(R2가 `git:0e5a9b87…`로 배포한 버전), 부분 릴리스 판정과 다시 확인의 compatible로
덮였다. 4는 바닥 실행 없이 공개 상태 읽기(19:54:50 KST 생성, 저장·유효 795, App 보고 약 3초 전)로 채웠고, 릴리스의 PRO 최소
빌드 사전 검사는 요구 값이 비어 'nothing to check'였다. 5는 머지(19:45:45 KST) 뒤 exact-main CI를 기다려 dispatch했고(19:54:52
KST 생성), 그 사이와 이 기록까지 다른 머지는 없으며, R3 배포부터 머지된 #533 ~ #535와 #537은 런타임 의존성을 바꾸지 않았다(열린
Dependabot 묶음 PR은 머지하지 않음). 6은 그대로 채웠다(PRO media R2 CORS와 PRO 방 smoke가 첫 시도에 통과). 7은 하지 않았다:
오너가 자고 있어 30분 안에 할 수 없었고 다음 날 아침 늦은 확인으로 한다(아래 '배포 직후 확인'). 8은 이 릴리스의 배포 기록 PR이
했다(release-record §1, `Last source review`, §2의 이 항목과 Phase 5.5 완료 항목의 동결 해제, §4의 이 항목과 현재 경계 줄 (5),
hotfix-procedure의 schemaVersion 2 PRO Worker 문단, `release-history.md`의 행). 그래서 Phase 5.5 끝 조건 5는 그 기록이 main에
들어갈 때 채워진다.

## 배포 직후 확인 (블라인드, 게이트 아님)

PRO 방 smoke는 CORS preflight, 대기 전환의 종류, 하트비트를 운영에서 읽지 않으므로 R2와 같은 꼴로 한 번 사람이 읽는다. 확인하는
사람에게는 '절차'만 주고, 기준은 주지 않으며, 받은 관찰값을 여기 기준과 견준다.

**이 확인이 보는 것(열차 리뷰 중간 지적 반영):** R4의 두 변경 자체는 운영에서 이 확인으로 지나지 않는다. 옛 2999 ms 전환은 운영에서
닿을 수 없고(위 '저장 기록의 수명'), 운영 App 페이지는 같은 출처 facade를 불러 preflight를 하지 않는다. 그래서 이 확인은 R4 PRO
Worker가 v2 경로(스냅샷, 하트비트, 새 전환의 zero-start PREPARE와 COMMIT)를 깨지 않았는지 보는 회귀 확인이다. zero-start 해제 줄은
YouTube 재생에서만 찍히므로(`src/youtube/player.ts`의 `[PRO YouTube] Zero-start playback released`, 업로드한 파일의 시작에는 같은 줄이
없음) 절차가 YouTube 트랙의 새 시작을 요구한다.

**절차(확인하는 사람에게 주는 것):** (1) Release run이 끝난 뒤 30분 안에 데스크톱 Chromium에서 오너가 가진 PRO 방을 주소 끝에
`?mxqrLog=debug`를 붙여 연다. (2) 오너 계정으로 들어가 보이는 것(재생 목록, 참가자 목록, 오류 창이나 토스트의 문구)을 적는다.
(3) 재생 목록에 지금 재생 중인 트랙 말고 YouTube 트랙이 없으면 YouTube 트랙 하나를 더한다. 지금 재생 중인 트랙과 다른 YouTube
트랙 하나를 골라 재생하고(재생 중이 아니면 아무 YouTube 트랙) 20초 듣는다. 고른 트랙, 소리가 났는지, 대략의 시작 시간을 적는다.
(4) (선택, 같은 LAN의 두 번째 기기가 있을 때만) 시스템 오디오 공유를 시작하고 두 번째 기기로 2분 듣는다.
(5) 채팅에 `/debug console`을 입력하고 `[PRO`로 시작하는 줄을 시각과 함께 복사한다. (6) 멈추고 나와서 적은 것, 복사한 줄, 브라우저
버전, 화면의 앱 버전을 돌려준다.

**통과 기준(주지 않음):** 방이 열리고 `INVALID_RESPONSE`나 `[PRO] Presence heartbeat failed`가 없다. (3)의 YouTube 시작에
`[PRO YouTube] Zero-start playback released`가 한 번 있고 소리가 났다. (3)의 시작이 YouTube 트랙이 아니었으면(절차와 달리 업로드한
파일을 골랐으면) 이 기준은 실패가 아니라 'zero-start 미확인'으로 적고, 같은 방에서 YouTube 트랙의 새 시작을 한 번 더 부탁한다(R2의
후속 라운드와 같음). (4)를 했고 공유가 LAN-direct로 갔으면 'Heartbeat state was not applied'와 'Lease heartbeat failed'가 없다(이것이
R2 보고서 오너 기기 확인 후보 PLE-03, LAN-direct 공유가 PRO 배포를 건너는지의 기회다). 아니면 'LAN-direct 미확인'.

**실패하면:** 첫 기준이 어긋나거나, YouTube 시작에서 소리가 나지 않았거나 해제 줄이 없고, 일시적 네트워크 오류로 설명되지 않으면
위 '손 되돌리기'대로 PRO를 R2 PRO Worker로 되돌리고 기록한다. '미확인'은 실패가 아니다. 손 되돌리기는 PRO의 git 출처를 없애 다음
수리 릴리스를 자동 복구 없는 `all`로 만들므로, 기준을 미확인과 실패로 나눈 것이 이 비용을 근거 없이 치르지 않게 한다.

**결과(배포 기록 때, 2026-10-30):** 하지 않았다. 오너가 자고 있어 절차 (1)의 '릴리스 실행 뒤 30분 안'(19:56 KST 배포)을 지킬 수
없었다. 다음 날 아침(2026-10-31) 같은 절차와 기준으로 늦은 확인을 하고 그 결과를 여기와 QA 라운드 5, release-record §2에 나중에
적는다. 늦은 확인은 배포 직후가 아니라 몇 시간 뒤의 v2 경로 회귀를 본다. 게이트가 아니다. 그때까지 이 릴리스의 운영 근거는 PRO
media CORS와 PRO 방 smoke, 공개 상태, Drift Audit뿐이다(QA 라운드 5).

## 사용자가 알아챌 변화

없다. 업데이트 창도 없다. 남아 있을 가능성이 낮은 그 앞 Worker의 대기 전환 하나는 그 한 번만 배운 시작 앞섬 없이 시작한다. 9.0.24
이하 로컬 개발 빌드로 운영 PRO API를 부르는 개발자만 preflight 실패를 본다.

## 기록과 레지스트리

- 레지스트리 RO-03: zero-start 인코딩 문장(Worker는 9.0.25 뒤의 PRO 전용 릴리스에서 2999 ms 읽기를 그만둠, 공유 시간 파일 머리
  주석은 낡은 채 남고 다음 `all` 릴리스가 고침), 시간 시험 설명에서 지운 행. 새 레코드 없음, 기준치 변경 없음.
- 서버 권한 ADR §6 시작 종류 문단, PRO 운영 문서(bootstrap 문장과 Rollback 한 문단).
- release-record §2·§4, `docs/README.md`. §1, `Last source review`, `release-history.md`는 배포 기록 PR이 쓴다.
- 열린 항목(이 릴리스가 남김): 공유 시간 파일 머리 주석(R4-Q2, 다음 `all`), `src/pro-room/snapshot.ts`의 'Opt-in summary'(R4-Q3,
  다음 App).

## 열차 리뷰와 반영

QA 라운드 2 뒤 열차 리뷰가 낸 지적 아홉(중간 1, 낮음 5, 정보 3)을 하나하나 코드와 대조했다. 모두 사실로 확인했고 버린 지적은
없다. 정보 지적 둘의 부수 주장 하나만 코드와 달라 아래에 정정을 적었다. 런타임 코드는 바꾸지 않았다.

| 지적                                                                                                                     | 등급 | 대조와 처리                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 배포 직후 확인 기준 2가 YouTube에서만 찍히는 줄을 요구하나 절차는 YouTube를 요구하지 않음                                | 중간 | 확인(`src/youtube/player.ts`에만 그 줄, 업로드 파일 시작에는 없음). '배포 직후 확인'의 절차 (3)을 YouTube 트랙의 새 시작으로, YouTube가 아닌 시작은 실패가 아니라 미확인으로, 확인이 R4의 두 변경을 지나지 않는 회귀 확인임을 적었다. release-record §2 배포 조건 (7)에도 한 문장                                                                                                                                                                                                                                                      |
| 새 오너 질문 Q1 ~ Q3이 계획과 Phase 6 브리프의 Q1 ~ Q3과 번호가 겹침                                                     | 낮음 | 확인(계획 §9.2의 Q1 ~ Q3). R4-Q1 ~ R4-Q3으로 바꾸고 머리 문단에 이 보고서의 번호임을 적었다(이 보고서, release-record §2). 아직 push 전이라 처음 다섯 커밋의 메시지도 같은 트리로 다시 만들어 고쳤다(위 '증분 한눈에' 아래 문단)                                                                                                                                                                                                                                                                                                       |
| 버전 표기 갱신, 현재 경계 줄 (5), hotfix-procedure의 'live since then'이 옮김·기록 범위에 없음, (7)을 그대로 유효로 적음 | 낮음 | 확인(release-record §4 머리 줄 (3)이 손 PRO 되돌리기 바닥을 (8)로 적음, `docs/hotfix-procedure.md`의 schemaVersion 2 PRO Worker 문단). '배포 조건과 순서' 2와 8, '기록', '되돌리기'와 release-record §2 배포 조건 (2), (8)을 고쳤다                                                                                                                                                                                                                                                                                                    |
| ADR이 종류 없는 저장 전환을 '모르는 값처럼' 읽는다고 적음                                                                | 낮음 | 확인(`normalizeStoredPlaybackTransition`의 `!isPlaybackTimingMode(value.timingMode)`가 모르는 종류의 저장 전환을 거절해 null). ADR 문장을 'App이 종류 없는 COMMIT을 읽는 것과 같음, 모르는 종류의 저장 전환은 불러올 때 거절'로, 이 보고서 R4-1 문구와 R4-1 코드 커밋 메시지를 같이 고쳤다                                                                                                                                                                                                                                             |
| R4-Q1 (나)와 R4-Q2 (나)가 이미 정한 제약과 맞섬                                                                          | 낮음 | 확인. R4-Q1 (나)에 '남은 기록 0 증명이 먼저, 지금은 할 수 없음', R4-Q2 (나)에 '정한 Q20을 뒤집음'을 적었고(이 보고서, release-record §2), 배포 조건 2의 다시 만들기 문장을 그 조건으로 좁혔다                                                                                                                                                                                                                                                                                                                                          |
| 시험이 불러온 pre-v2 기록의 티켓 PREPARE 종류를 고정하지 않음                                                            | 낮음 | 확인(중복 ENDED 행의 pre-v2 갈래는 메모리 안 기록을 고침). 시험만인 후속 커밋 `ce174b41`: 콜드 재시작 행이 alarm 전에 티켓을 받아 불러온 기록의 PREPARE가 scheduled-control임을 본다. R2 PRO Worker(blob `11c6390a`)로는 그 단언에서 실패하고 이 Worker에서는 통과한다(위 R4-1 '후속 시험')                                                                                                                                                                                                                                            |
| 운영에서 닿는 변화가 보고서가 적은 것보다 좁음(COMMIT 종류뿐)                                                            | 정보 | 확인(`prune`이 방 처리기, 신호 티켓, 재생 명령, 내부 경로, alarm에서 먼저 돌고 마감 지난 전환을 커밋, `naturalPlaybackEndAtMs`는 대기 전환이 있으면 null). '저장 기록의 수명'에 문단을 더하고 혼합 버전 행과 release-record §2·§4 문장을 좁혔다. **정정:** 지적은 참여자가 모두 만료된 방이면 prune이 커밋 대신 'room-epoch-changed'로 취소한다고 했지만, prune은 마감 지난 전환의 커밋을 세션·참여자 정리보다 먼저 한다. 그 방도 먼저 커밋되고 그 뒤 참여자 정리가 재생을 얼리고 epoch를 올린다. 결론(닿는 것은 COMMIT 종류뿐)은 같다 |
| 옛 저장 전환이 남았을 때의 한 트랙 시작(R4-Q1 (가)로 수용)                                                               | 정보 | 확인. 수정 없음(위와 같은 취소 주장 정정만 해당). (가)는 서버 권한 ADR의 와이어 규칙과 Q4에 맞고, 되돌리기 쪽 바이트 동일은 QA 라운드 2의 근거 그대로다                                                                                                                                                                                                                                                                                                                                                                                |
| R4-2의 운영 preflight 경로 확인                                                                                          | 정보 | 확인(`src/pro-room/api.ts`의 운영 끝점이 같은 출처 `https://musixquare.com/api/pro-room`, `www`는 App Worker가 308로 apex에 보냄, `cloudflare/wrangler.pro-room.toml`의 `workers_dev = false`와 route 없음, OPTIONS는 허용 출처면 204). 수정 없음. 영향은 이미 적은 loopback 개발 빌드뿐이다                                                                                                                                                                                                                                           |

## QA 라운드

### 1. 증분별

main `d0248df2` 위, 커밋 시각 2026-10-30 16:58 ~ 17:06 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`.

- R4-1 테스트 먼저 `58579c70`: 바뀐 세 파일 611행 가운데 2행 실패, 이어 Worker 설정 69 files / 3,322행 가운데 같은 2행 실패(위
  R4-1). prettier, eslint.
- R4-1 코드 `69cbb510`: Worker 설정 3,322 모두 통과, `check:pro-room-modules`, eslint, prettier, dead-exports, source complexity,
  `check-resource-ownership`(부모와 출력이 글자 그대로 같음).
- R4-2 테스트 먼저 `045b183a`: Worker 설정 3,322행 가운데 CORS 행 1 실패.
- R4-2 코드 `c9f09514`: Worker 설정 3,322 모두 통과, `check:pro-room-modules`, eslint(Worker와 e2e 모의), prettier.

### 2. 전체 검사

코드 커밋 `c9f09514`(R4-2), 2026-10-30 17:07 ~ 17:21 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`. 깨끗한
트리에서 계획의 기본 검사를 한 번 돌렸고 모든 단계가 종료 코드 0이다. 기록 커밋은 문서만 더하므로 그 뒤 `guard:brand-capitalization`과
target 판정만 다시 돌렸다(아래).

- release target: `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`,
  `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 `d0248df2..c9f09514`을 견줌: PRO 방 1(`cloudflare/pro-room-worker.ts`),
  remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 0, App 런타임 의존성 차이 없음. release-record §4 현재
  경계 줄 (5)가 그때 적은 운영 배포 SHA(App `cbbc56d9`, PRO room `0e5a9b87`, 나머지 넷 `71f5b96c`) 대비도 같다. `releaseTargetWorkers('pro-room')`는
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

### 2-1. 열차 리뷰 반영 뒤

시험만인 후속 커밋 `ce174b41`와 반영 문서 위(런타임 코드는 라운드 2의 `c9f09514`와 같음), 2026-10-30 17:45 ~ 18:05 KST. Windows 11
로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`. 위 '열차 리뷰와 반영'이 건드린 것과 기본 시험을 다시 돌렸다.

- 후속 행의 양쪽: 이 Worker에서 콜드 재시작 세 행 통과. 작업 트리에 R2 PRO Worker(blob `11c6390a`)를 넣고 돌리면 'stores a
  zero-start transition ... as a scheduled control' 한 행이 새 티켓 단언에서 실패(티켓 PREPARE가 zero-start)하고, 되돌린 뒤 트리는
  깨끗했다.
- 바뀐 세 시험 파일(signaling-delivery, worker, playback-timing) 611행 통과. Worker 설정 69 files / 3,322 모두 통과(후속은 기존 행에
  단계를 더해 행 수가 같음). 단위 전체 706 files / 16,766 모두 통과, 374 s.
- `typecheck:tests`, eslint와 prettier(바뀐 시험 파일), prettier(이 보고서, release-record, 서버 권한 ADR, `docs/README.md`),
  `guard:brand-capitalization`(1,005 sources), `node scripts/check-resource-ownership.mts`(49 records / 448 files, 종료 코드 0).
- 다시 만든 커밋 다섯은 처음 커밋과 트리가 같음을 `git rev-parse <커밋>^{tree}`로 하나하나 견줬다.

### 3. main 위로 옮김 (해당 없음)

순서를 바꿔 이 릴리스가 9.0.27보다 먼저 나갔으므로 옮기지 않았다. 바탕 `d0248df2`가 머지 직전까지 main이었다: squash
`683074bc`의 부모가 `d0248df2`이고 트리(`0524fbd0`)는 PR head `3553fd69`와 같다. 그래서 테스트 먼저 두 커밋을 다시 돌릴 새
부모가 없었다. 바탕의 `cloudflare/pro-room-worker.ts`는 R2 머지 `0e5a9b87`과 같은 blob `11c6390a`다(배포 기록 PR에서
`git rev-parse`로 다시 확인).

### 4. 운영 전제: dispatch 직전 읽기 (2026-10-30)

운영 공개 상태와 배포 기록(머지, exact-main CI, 바닥 읽기, dispatch를 차례로 적은 릴리스 담당의 기록, 시각은 그 PC 시계)의
기록이다. 시각은 KST다(로그의 UTC를 바꿈). 이 릴리스는 바닥 실행(`set`, `lower`)이 없었다.

- dispatch 직전 공개 상태(배포 조건 4): 배포 기록의 19:54:50 KST 줄이 exact-main CI success(19:54:49 KST 줄) 바로 뒤에 읽은 공개
  상태를 적는다. 공개 상태(19:54:50 KST 생성, 서버 시계)는 `minAppBuild` 795, `effectiveMinAppBuild` 795, revision 3(updated
  2026-10-29T15:12:41.759Z, F2의 `set`), `liveAppBuild` 799, `reportedLiveAppBuild` 799(19:54:47 KST 보고, 약 3초 전으로 300초
  안), state `valid`였다. workflow `status` 실행이 아니라 공개 상태 읽기다. revision이 F2의 3 그대로라 F2 뒤 저장 바닥을 바꾼
  실행은 없었다. PRO 최소 빌드 요구 값은 비어 있었다(릴리스의 'Check the App build floor the PRO Worker requires'가 19:55:54 KST에
  `[app-build-floor] the PRO Worker requires no App build (MXQR_PRO_ROOM_REQUIRED_APP_BUILD is empty); nothing to check`).
- dispatch 직전 live PRO Worker(배포 조건 3): 배포 메시지를 사람이 따로 읽은 근거는 없다. 릴리스의 checkpoint(19:55:54 ~
  19:55:56 KST에 잡고 호환 floor와 함께 19:55:59 KST까지 artifact로 남김)가 dispatch 때의 PRO를 잡았고, PRO 방 배포 직전 'Verified unchanged production deployment for pro-room'(19:56:17
  KST)이 운영이 그 checkpoint와 같음을 확인했으며, 배포 단계가 바꾼 버전이 `ef882f7c`다('pro-room production version
  ef882f7c-… -> e7657f88-…', 19:56:24 KST). 그 버전은 R2가 `git:0e5a9b87…`로 배포한 PRO 버전이다(release-record의 R2 기록 값).
  부분 릴리스 판정(19:55:47 ~ 19:55:54 KST)과 PRO 방 배포 직전 다시 확인(19:56:15 KST)은 compatible이다. `0e5a9b87..d0248df2`
  사이 PRO 런타임 경로 변경은 없다(로컬 git, QA 라운드 2).
- main과 다른 머지(배포 조건 2, 5): 머지(19:45:45 KST) 뒤 이 릴리스의 기록 PR까지 다른 머지는 없다(그 기록을 만들 때 원격
  main이 `683074bc`). 릴리스의 'Verify release commit is still current main'(19:55:18 KST)이 통과했다.
- 런타임 의존성(배포 조건 5): R3 배포(07:18 KST)부터 이 배포까지 머지된 것은 #533(문서), #534(9.0.26), #535(문서), #537(이
  릴리스)이다. `git diff b8ae59e7 683074bc -- package.json package-lock.json`은 버전 줄 셋(`package.json` 하나,
  `package-lock.json` 둘)뿐이다. 열린 Dependabot 묶음 PR은 머지하지 않았다.

결론: 배포 조건 1, 2, 4, 5가 채워졌다. 3은 사람이 dispatch 전에 읽지 않아 릴리스의 checkpoint, 'Verified unchanged', 부분
릴리스 판정과 배포 단계가 적은 이전 버전 `ef882f7c`로만 덮였고, 4는 workflow `status` 실행 대신 공개 상태 읽기로 채웠다(위
'배포 조건과 순서'의 결과).

### 5. PR CI, 자동 코드 리뷰, 머지, exact-main CI, 배포와 공개 확인 (2026-10-30)

검증 대상은 PR head `3553fd69`와 그 squash 머지 `683074bc`(부모 `d0248df2`, 트리는 `3553fd69`와 같음, 런타임은 R4-2 코드
`c9f09514`까지와 같음)다. 환경은 GitHub Actions(Node 24.22.2)와 운영 Cloudflare다. 시각은 KST다(로그의 UTC를 바꿈).

- PR #537: 19:36:43 KST에 열었고 head는 `3553fd69`다(배포 기록의 19:36:59 KST 줄부터 머지까지 같음). PR CI
  [41042017293](https://github.com/hiefny/MUSIXQUARE/actions/runs/41042017293)는 `3553fd69`에서 11 jobs 모두 success였다(19:36:47 KST 생성, job 19:36:49 ~ 19:45:34 KST, 배포 기록이
  19:45:41 KST에 success를 읽음). 이 보고서가 받은 근거는 job별 결론과 시각뿐이라 시험 수는 적지 않는다.
- 자동 코드 리뷰: 요약 댓글(19:36:58 KST 생성, 19:37:52 KST에 마지막으로 바뀜)이 PR을 열 때('PR opened') `3553fd6` 코드 리뷰가
  19:37:51 KST에 completed, `has_any_findings`와 `has_unresolved_findings` false라고 적는다. 보안 리뷰는 돌지 않았다. 최종 head의
  결과이고, 배포 기록이 머지 직전(19:45:42 KST)에 그 상태를 다시 읽었다.
- 머지: 19:45:45 KST에 squash `683074bc`(부모 `d0248df2`). 스쿼시 본문은 미리 준비한 열차 요약이고, 머지 커밋의 제목 아래
  본문이 배포 기록의 그 사본과 글자 그대로 같다. `git diff 3553fd69 683074bc`는 비어 있다. 그 본문의 'Final gate at
  `76e349a1`'(리뷰 반영 문서 커밋, 런타임은 `c9f09514`와 같음)은 QA 라운드 2-1 뒤 다시 돈 로컬 검사다: 단위 706 files / 16,766
  모두 통과(317 s. 같은 트리의 앞 실행은 PC의 다른 작업 부하로 바뀐 파일과 무관한 release-tooling 두 행이 시간 초과였고, 그 두
  파일만 다시 돌려 156 / 156 통과), Worker 커버리지 69 / 3,322, typecheck, lint, `format:check`, `check:workers`, 가드 기준치
  그대로, `build:checked` 9.0.26 / v799 'PASS: v799 (cbbc56d9)', `check:worker-bundles`(PRO 830.76 / gzip 162.54 KiB),
  Playwright `test:e2e:critical` 100 / 100.
- exact-main CI [41043119810](https://github.com/hiefny/MUSIXQUARE/actions/runs/41043119810): push, attempt 1, 11 jobs success(19:45:48 KST 생성, job 19:45:50 ~ 19:54:16 KST, 배포 기록이
  19:54:49 KST에 success를 읽음): Types and source guards, Lint and formatting, Unit tests (1/2)와 (2/2), Broad unit coverage,
  Critical runtime coverage, Worker runtime coverage, Release tooling coverage, Production release candidate, Critical browser
  gate(Linux Chromium, 19:46:58 ~ 19:54:16 KST), Static checks. 이 보고서가 받은 근거는 job별 결론과 시각뿐이라 시험 수, 커버리지,
  가드 값은 적지 않는다. 후보는 [artifact 12970902813](https://github.com/hiefny/MUSIXQUARE/actions/runs/41043119810/artifacts/12970902813)(digest sha256
  `2cb84852541ef1a7c6f36c6965cfd9ed68afb5162b0e740dc12d6834a9cc62c9`, 26,100,598 B)다.
- Release [41044220520](https://github.com/hiefny/MUSIXQUARE/actions/runs/41044220520): target `pro-room`, Developer API D1 false, attempt 1, success. 19:54:52 KST 생성, 검증 job
  19:54:55 ~ 19:55:03, deploy job 19:55:06 ~ 19:56:31 KST, 독립 recovery job(Preserve failed-release recovery boundary)
  skipped. 'Verify release commit is still current main'(19:55:18 KST), 계약 cutover 검사 다섯, `.node-version`의 Node 24.22.2,
  후보의 digest(19:55:31 KST)와 릴리스 파일 807개 확인(19:55:32 KST), 운영 보안 설정 가드('no unapproved bypass or retired
  rollout flags'), 여섯 Worker 번들 dry-run(Wrangler 4.148.0, PRO 830.76 / gzip 162.54 KiB), 자격 증명과 비밀 목록 확인이
  통과했다. 부분 릴리스 판정(19:55:47 ~ 19:55:54 KST)은 compatible이다. 'Check the App build floor the PRO Worker
  requires'(19:55:54 KST)는 요구 값이 비어 'nothing to check'다. checkpoint [artifact
  12971063046](https://github.com/hiefny/MUSIXQUARE/actions/runs/41044220520/artifacts/12971063046)(19:55:54 ~ 19:55:59 KST, 6 files)이 dispatch 때의 PRO room(R2의 `ef882f7c`)과 Worker
  호환 floor를 담았다. PRO generation readiness의 읽기·막기·복원은 skip이다. PRO 방 대상의 D1 계약 단계는 generic PRO grant
  하나가 success(35 queries, 3 rows read, 0 rows written)이고 나머지는 skip이다.
- 배포와 smoke(모두 첫 시도, 재시도 없음): PRO media R2 CORS 정책 다시 적용(규칙 하나, 19:56:03 ~ 19:56:06)과 PRO media Range
  CORS smoke('PRO media R2 Range CORS is active.', 19:56:06 ~ 19:56:07), PRO 방 배포 직전 다시 확인 compatible(19:56:15)과 운영이
  checkpoint와 같음(19:56:17), PRO room `ef882f7c` → `e7657f88-8f73-4510-9c36-801973aca7fa`(19:56:18 ~ 19:56:24, 830.76 / gzip
  162.54 KiB, startup 1 ms), PRO room smoke(19:56:24 ~ 19:56:26, 12번 가운데 첫 시도에 `e7657f88`, `000000` activation_required,
  `000001` pin_required와 `passwordRequired` true, 익명 스냅샷 거절). target `pro-room`이라 다른 다섯 Worker의 기록·배포·smoke는
  돌지 않았다. 시각은 모두 KST다. 이 smoke는 2999 경로, CORS preflight, v2 경로를 읽지 않는다(위 '되돌리기', '배포 직후 확인').
- 마무리: 최종 소유권 19:56:27 KST verified, 커밋 표지 artifact 12971592019(19:56:28 KST). 바닥 올리기 단계와 실패 자동 복구
  단계는 모두 skip이다. [배포 원본](https://github.com/hiefny/MUSIXQUARE/actions/runs/41044220520/artifacts/12971587134)(26 files). 릴리스 담당의 기록에 이 SHA의 Production Release는 이
  실행 하나다(19:56:53 KST 종료 코드 0).
- 공개 확인(릴리스 담당, 19:57 KST 무렵): 공개 최소 빌드 상태(19:57:23 KST 생성)는 저장·유효 795, revision 3, live 799, 보고
  799(19:56:54 KST, 약 29초 전), state `valid`다. `/service-worker.js`는 `CACHE_VERSION = "v799"` 그대로다.
- Operations Drift Audit [41044491969](https://github.com/hiefny/MUSIXQUARE/actions/runs/41044491969): workflow_dispatch, `683074bc`, 19:57:09 KST 생성, job 19:57:14 ~ 19:57:45 KST,
  보고서 생성 19:57:34 KST, automated-checks-passed: 32 pass / 0 fail / 5 manual-only(artifact 12970829770). App build floor 행
  'Stored floor 795 (enforced 795) is within the live App build 799 reported 47 s ago.', PRO room 비밀 이름 9개, 바인딩이
  `cloudflare/wrangler.pro-room.toml`과 같음, PRO media CORS 행이 PASS다. MANUAL 다섯(zone route, Access와 MFA, WAF와 비용 알림,
  두 번째 Git 배포 경로, main 리뷰 정책)은 앞 실행들과 같다.
- 배포 직후 확인(게이트 아님): 하지 않았다. 오너가 자고 있어 다음 날 아침 늦은 확인으로 한다(위 '배포 직후 확인'의 결과).

결론: 자동 게이트(PR CI, 자동 코드 리뷰, exact-main CI, 릴리스 smoke)가 모두 통과했고 실패 자동 복구와 손 되돌리기는 없었다.
운영에서 R4의 두 변경은 지나지 않고, v2 경로 회귀는 아침의 늦은 확인이 처음 본다.

## 확인하지 않은 것

- 운영 Durable Object에 그 앞 PRO Worker가 쓴 대기 전환이 남아 있는지(저장을 읽을 수 없음, 위 '저장 기록의 수명').
- 실제 브라우저에서 운영 PRO Worker의 CORS preflight(로컬 시험은 in-process Worker의 답만 봄)와 9.0.24 이하 loopback 개발 경로.
- e2e PRO 고정값과 route 모의는 PRO Worker를 띄우지 않으므로 로컬 Playwright는 이 Worker의 변경을 지나지 않는다(App 런타임이 main과
  같다는 레인 근거뿐).
- 실기기, iOS Safari, WebKit 레인 전체, Full E2E. 운영 smoke는 2999 경로와 CORS preflight를 읽지 않는다.
- `security:audit`(npm 레지스트리 조회)는 돌리지 않았다. 의존성은 바뀌지 않았다.
- 배포 직후 확인(블라인드): 오너가 자고 있어 하지 않았고 다음 날 아침 늦은 확인으로 한다(위 '배포 직후 확인'). 그래서
  운영에서 v2 경로(스냅샷, 하트비트, 새 전환의 zero-start)가 이 PRO Worker 아래에서 그대로인지는 이 기록까지 사람이 보지 않았다.
- 오너 질문 R4-Q1 ~ R4-Q3의 오너 답(권장 (가)로 냈고 아침에 확인).
- exact-main CI와 PR CI의 시험 수, 커버리지, 가드 값(이 보고서가 받은 근거는 job별 결론과 시각뿐).
- dispatch 직전 live PRO Worker의 배포 메시지(사람이 따로 읽지 않음, QA 라운드 4).
