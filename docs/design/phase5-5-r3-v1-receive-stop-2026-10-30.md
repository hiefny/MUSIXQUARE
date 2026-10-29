# Phase 5.5 R3: App이 PRO 스냅샷 schemaVersion 1 받기를 그만두고 받는 쪽을 좁힘, 9.0.25 (2026-10-30)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status             | 배포됨(2026-10-30 07:18 KST, [Release 40964572017](https://github.com/hiefny/MUSIXQUARE/actions/runs/40964572017), target `app`, attempt 1 성공). 증분 R3-1 ~ R3-7과 이 열차의 기록(release-record §2·§3·§4, hotfix-procedure, PRO 운영 문서의 되돌리기 문단, 이 보고서)을 만들고 증분별 검사(QA 라운드 1)와 기록 커밋의 전체 기본 검사(QA 라운드 2)를 했다. 그 뒤 main `d630269a`(9.0.24와 그 기록) 위로 옮기고, 버전 줄을 9.0.25 / v798로 고치고, 테스트 먼저 일곱과 R3-1·R3-4의 e2e를 옮긴 부모에서 다시 돌리고, 운영의 익명 bootstrap 두 답을 이 App의 파서로 읽고, 9.0.25 / v798 bump `01f1a19b`를 마지막 런타임 커밋으로 둔 뒤 전체 검사를 다시 했으며, 옮김과 bump를 본 리뷰 둘을 런타임 변경 없이 반영했다(QA 라운드 3). 이어 dispatch 직전 읽기(QA 라운드 4), PR CI, 자동 코드 리뷰, 머지, exact-main CI, 배포, 공개 확인, Drift Audit, 배포 직후 확인(QA 라운드 5)이 끝났다. PR #532(head `30e66813`)는 squash `b8ae59e7`(2026-10-30 07:07 KST, 부모 `d630269a`, 트리는 head와 같음)로 main에 들어갔다. 브랜치 `agent/p55-r3`은 main `d630269a` 위의 커밋 26개다: 테스트 먼저 7, 코드 9, 서버 권한 ADR 문서 1, 기록 문서 4, bump 1, bump 뒤 기록 문서 3과 교차 계약 시험 1(`5c0c6b6d`). 마지막 런타임 커밋은 bump `01f1a19b`이고 그 앞 App 런타임 커밋은 R3-6 `6c990739`다(R3-7 `85f327c5`은 릴리스 workflow의 값 하나). 릴리스 기록의 §1, §2의 이 릴리스 항목('배포 뒤 확인')과 새 'LAN-direct 2초 마감' 항목, §4의 이 릴리스 항목과 현재 경계 줄 (5), (8)의 머지 SHA·Release ID·checkpoint, hotfix-procedure의 9.0.25 문장, `release-history.md`의 9.0.25 행은 배포 기록 PR이 적었다. 배포 직후 확인(게이트 아님)은 2026-10-30 07:20 ~ 07:49 KST에 했다(유효, A, B, D2 통과, C는 공유가 SFU 경로라 'LAN-direct 미확인'이고 원인은 2초 LAN-direct 마감, D1은 하지 않음, 실패 없음, QA 라운드 5). 이 릴리스로 Phase 5.5가 끝났다 |
| Base               | main `d630269a`(9.0.24 / v797 번역 페이지 입구 열차의 기록 #531). 그 아래 9.0.24 머지 `78ec56f5`(#530, 2026-10-30 03:20 KST 배포), schemaVersion 2를 처음 보내는 PRO Worker의 기록 `a8d8f9c4`(#529)와 그 머지 `0e5a9b87`(#528, 2026-10-30 00:30 KST 배포, PRO room `ef882f7c`)가 있다. 처음 바탕은 그 PRO Worker 브랜치의 끝 `91601774`(받아들이기 전)이었고 2026-10-30에 `78ec56f5`, 이어 `d630269a` 위로 옮겼다(QA 라운드 3의 SHA 표). 운영(05:15 KST 공개 status와 `/service-worker.js`): App 9.0.24 / v797(빌드 797), PRO room R2, remote-share·signaling·Developer API facade·Developer API는 9.0.22 `71f5b96c`, 저장·유효 바닥 795                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Version            | 9.0.25 / v798(앱 빌드 798, bump `01f1a19b`, 9.0.24의 `4d74f552`와 같은 거울 여섯 파일). 9.0.24 / v797이 운영에 있으므로 다음 패치와 epoch다. 업데이트 창이 뜬다(바닥 795 위의 9.0.22 ~ 9.0.24 탭에는 '나중에'가 있는 보통 창). 새 바닥은 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Scope              | Phase 5.5 계획의 R3(증분 R3-1 ~ R3-7). App이 PRO 스냅샷 schemaVersion 1을 받지 않고 `passwordRequired`와 `playlistSlots`, 관리자 목록 답의 `{ administrators }`, bootstrap의 `passwordRequired`를 요구한다(PSK-01 ~ PSK-06의 A2, PSK-04, OV-A22, Q15). 시작 종류는 `timingMode`로만 읽고(ZS-05), 하트비트 스냅샷이 COMMIT보다 먼저 준비된 checkpoint를 내려놓으면 그 PREPARE의 종류로 시작한다(ZS-06, 의도한 동작 변화). live LAN-direct의 숫자 `liveExpiresAt`을 거절한다(PLE-04). PRO opt-in 머리글 둘을 보내지 않는다(HDR-1, PSK-07). 일반방 게스트는 SESSION_FULL과 OPERATOR_TOAST를 `i18nKey`로만 읽는다(STD-3, STD-4). 전송 계층이 은퇴한 PRO 개발자 신호 프레임을 읽지 않는다(PSK-11 클라이언트, 좁힘). Production Release의 PRO 최소 빌드 요구 값을 비운다(R3-7, Q21). Worker, D1, 비밀, 바인딩, Wrangler 설정, CORS, 계약 표지, 저장 모양은 바꾸지 않는다(`cloudflare/app-worker.ts`는 주석 하나)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Deploy target      | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, Worker별 런타임 경로, `changedAppRuntimeDependencies`로 bump 트리 `01f1a19b`를 견준 로컬 git 판정(QA 라운드 3): main `d630269a` 대비 App 18(`src/` 14, `cloudflare/app-worker.ts`(주석 하나와 관리자 자산 버전), bump의 거울 `browser/classic-runtime/admin.ts`, `index.html`, `scripts/service-worker-asset.ts`), PRO 방 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 운영 배포 SHA(App 9.0.24 `78ec56f5`, PRO room R2 `0e5a9b87`, 나머지 넷 9.0.22 `71f5b96c`) 대비도 App 18이고 나머지는 모두 0이라, live PRO Worker의 런타임 경로가 HEAD와 같다. 바뀐 시험 파일, e2e, 문서, `.github/workflows/release.yml`과 `package.json`·`package-lock.json`의 버전 줄은 어느 런타임 경로에도 없다(의존성 판정은 의존성과 운영 패키지만 봄). 공유 시간 파일 `cloudflare/pro-room-playback-timing.ts`(PRO와 App 두 목록에 듦)와 PRO Worker는 건드리지 않았다. 운영 조회인 릴리스의 부분 릴리스 호환 검사를 대신하지 않는다. 릴리스의 부분 릴리스 판정(2026-10-30 07:17:05 ~ 07:17:10 KST)과 App 배포 직전 다시 확인(07:17:48 KST)은 compatible이었다(QA 라운드 5). Developer API D1 `false`, `raise_app_build_floor` `false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Operations         | 운영 단계(바닥 `set`, `lower`)는 없었다. 운영에 닿은 것: QA 라운드 3의 인증 없는 GET(합성 코드 000000과 000001의 PRO bootstrap, 공개 바닥 status, `/service-worker.js`), #532 머지(07:07:07 KST)와 exact-main CI 40963348382 뒤 dispatch 직전 공개 상태 읽기(07:16:20 KST 생성, 저장·유효 795, QA 라운드 4), Release 40964572017이 07:16:22 ~ 07:18:21 KST에 App만 배포(`dd820d37` → `b4e8fc56`), 배포 뒤 공개 읽기(07:18:58 KST), Drift Audit 40964945920(07:19 KST), 릴리스 담당의 `000000` 확인(약 07:20 KST, 방을 만들거나 들어가지 않음), 오너가 가진 PRO 방의 배포 직후 확인(07:28 ~ 07:49 KST, 방 코드는 적지 않음). 실패가 없어 App을 되돌리지 않았다(QA 라운드 5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Resource ownership | 새 복구·재시도·시간 제한·감시·생명주기 흐름이 없어 새 레코드는 없다. R3-2가 RO-03의 699 ms 문장과 그 시간 시험의 699 고정을 고쳤다(`node scripts/check-resource-ownership.mts` 출력은 그대로). 요구 값을 비운 것은 시간 값이 아니라 P2의 사전 검사가 읽는 빌드 번호다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

이 문서는 Phase 5.5의 셋째 런타임 릴리스 R3의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의 Phase 5.5
계획(2026-10-28)과 그 영역 조사이고, PSK, ZS, PLE, HDR, STD, OV 번호와 Q 번호는 그 노트의 번호다. 계획의 줄 번호는 `6a23c46e` 기준이라
증분마다 위치를 기호로 다시 찾았다. 동작이 바뀌는 증분마다 테스트를 먼저 커밋하고 부모 코드에서 새 행과 바뀐 행만 실패함을 확인했다.
계획 단계 이름은 R1(9.0.22, [보고서](phase5-5-r1-train3-v2-accept-2026-10-29.md)), F2(바닥 795), R2(PRO 스냅샷 schemaVersion 2를
처음 보내는 PRO Worker, [보고서](phase5-5-r2-v2-send-2026-10-29.md)), R3(이 릴리스)이다. 영구 운영 문서(release-record §4,
hotfix-procedure, 설계 문서)에는 단계 이름 대신 SemVer, 빌드, 그리고 계약 문구 'PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO
Worker'로 적었다. 이 릴리스의 머지 SHA(`b8ae59e7`)와 Release ID(40964572017)는 배포 기록 PR이 채웠다. 영구 문서의 'R2'는 Cloudflare R2다.

## 오너 결정과 순서

- 옛 버전 정책, 강제 업데이트, 작은 통신 필드의 순서(받는 쪽, 바닥, 보내는 쪽), Phase 5.5 계획 질문(2026-10-28)과 시작
  승인(2026-10-29)은 [R1 보고서](phase5-5-r1-train3-v2-accept-2026-10-29.md#오너-결정과-순서)와 같다. 이 릴리스에 닿는 것:
  - 로드맵의 PRO 스냅샷 v2 순서: 클라이언트가 v2를 받음(9.0.22), 바닥 올림(795), PRO Worker가 v2를 보내고 v1을 멈춤, 클라이언트가
    v1 받기를 멈춤(이 릴리스).
  - Q4: `timingMode`는 끝까지 선택 필드다. 그래서 필드 없는 COMMIT도 재생은 되고, 예약 제어(scheduled-control)로 시작한다.
  - Q5: ZS-06(스냅샷이 COMMIT보다 먼저 온 기기의 시작 종류)을 이 릴리스의 별도 증분으로 낸다(동작 변화).
  - Q7: 이 App이 모르는 `i18nKey`의 운영자 알림은 원시 키나 방장 문구 없이 보이지 않는다.
  - Q8: 새 되돌리기 경계는 문서로만 적고 계약 표지는 바꾸지 않는다.
  - Q10: 바닥 도구와 PRO smoke는 entry-policy 머리글을 계속 보낸다(PRO Worker가 읽지 않아 결과가 같음).
  - Q15: 부르는 곳 없는 `getAdministrators`와 PSK-11의 클라이언트 잔재를 지우고 bootstrap `passwordRequired`를 필수로 한다. 신호
    Worker 쪽은 남긴다.
  - Q21: PRO 최소 빌드 요구 값은 이 런타임 PR이 지운다(R3-7).
- 배포 정책(2026-10-25): 자동 게이트가 통과하면 따로 묻지 않고 배포한다. 기기 근거는 게이트가 아니다.
- 순서: schemaVersion 2를 보내는 PRO Worker의 머지와 배포 → 그 기록 → 이 브랜치를 main 위로 옮기고 bump → 이 릴리스 머지와 배포 →
  이 릴리스의 기록 → (계획의 기본) R4 PRO 정리. 그 PRO Worker의 배포부터 이 배포까지 런타임 의존성 변경을 머지하지 않고, 이
  릴리스의 머지와 기록 사이에 다른 머지를 끼우지 않는다. 이 배포부터 PRO 정리(`pro-room`)의 배포까지도 런타임 의존성 변경
  (Dependabot 포함)을 머지하지 않는다. 그 PRO 릴리스의 부분 게이트가 고르지 않은 App의 배포 SHA와 HEAD 사이 의존성 차이를
  거절하기 때문이다(계획의 '한 번에 한 열차').

## 이 릴리스가 기대는 것

받는 쪽만 좁히므로 바닥이 더 필요 없다. 그만 받는 모양마다 그것을 보내던 쪽이 이미 운영에서 사라졌거나 바닥이 거른다.

| 그만 받는 것                                                                                                   | 보내던 쪽                                                | 이 App이 만나는 쪽                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 스냅샷 schemaVersion 1, `passwordRequired`·`playlistSlots` 없는 스냅샷, `authorityVersion`이 든 관리자 목록 답 | schemaVersion 2를 처음 보내는 PRO Worker 앞의 PRO Worker | 그 PRO Worker와 그 뒤(모든 스냅샷 답이 schemaVersion 2이고 두 필드를 스스로 실음). 교차 계약 행(`pro-room-worker.test.ts`의 `parseProRoomSnapshot` 호출, in-process Worker에 붙인 `ProRoomApiClient`)이 Worker 출력을 이 파서로 읽는다 |
| `passwordRequired` 없는 bootstrap                                                                              | 릴리스 W(`a3893f04`) 앞 PRO Worker                       | 릴리스 W 뒤 모든 PRO Worker는 모든 상태에서 싣는다                                                                                                                                                                                     |
| 699 ms COMMIT 앞섬을 zero-start로 읽기                                                                         | 같은 v2 앞 PRO Worker                                    | 그 PRO Worker는 모든 PREPARE와 transition COMMIT에 `timingMode`를 싣고 두 종류 모두 700 ms 앞섬을 쓴다                                                                                                                                 |
| live LAN-direct의 숫자 `liveExpiresAt`                                                                         | 같은 v2 앞 PRO Worker                                    | 그 PRO Worker는 null을 저장하고 답하며, 앞 Worker가 저장한 숫자를 불러올 때 null로 바꾼다                                                                                                                                              |
| SESSION_FULL `message`, OPERATOR_TOAST `text`                                                                  | 9.0.21 이하 일반방 방장(키도 함께 실음)                  | 바닥 795가 들이는 방장은 9.0.22 이상이고 키만 보낸다. 787 이상 방장은 모두 키를 싣는다                                                                                                                                                 |
| 개발자 신호 프레임(developer-command, developer-invalidation, 단독 pro-queue-addition)                         | 2026-07-20(`d4b208cc`) 앞 신호 Worker                    | 그 뒤 신호 Worker는 그 문자열이 없고 내부 개발자 경로를 409 `PRO_COORDINATOR_REMOVED`로 답한다. PRO 큐 추가 알림은 `pro-room-invalidated` 서버 사건의 `addition`으로만 온다                                                            |

이 App이 아직 받는 v1 시대 모양은 `timingMode` 없는 PREPARE와 COMMIT 하나다. Q4대로 그 필드는 끝까지 선택이라 예약 제어로
시작하고 소리는 멈추지 않는다(아래 '되돌리기'의 금지된 PRO 되돌리기에서도). 키를 함께 실은 SESSION_FULL의 `message`와
OPERATOR_TOAST의 `text`는 검증기가 절마다 보고 남는 키를 허용하므로 읽지 않는 키로 받아들인다. 그 밖의 v1 모양(스냅샷 v1 키,
presence `coordinatorParticipantId`, viewer `coordinatorEligible`, 관리자 목록의 `authorityVersion`, `passwordRequired` 없는
bootstrap, 숫자 LAN-direct 마감, 글만 있는 운영자 알림)은 모두 거절한다.

보내기를 그만두는 것은 PRO opt-in 머리글 둘뿐이다. 릴리스 W의 PRO Worker부터 어느 PRO Worker도 그 머리글을 읽지 않는다.

그래서 이 릴리스의 상대는 schemaVersion 2를 처음 보내는 PRO Worker이고, 경계는 '이 App이 배포된 뒤 PRO를 그 Worker 아래로 되돌리지
않음'이다(아래 '되돌리기'). 앱 빌드 바닥은 795 그대로다.

## 증분 한눈에

아래 SHA는 main `d630269a` 위로 옮긴 뒤의 것이다(처음 `91601774` 위에서 만든 SHA와의 대응은 QA 라운드 3의 표). 부모 실패는
테스트 먼저 커밋을 그 부모 코드에서 돌린 결과(실패 / 그 실행의 전체 행)이고, 옮긴 부모에서 다시 돌린 값이다(QA 라운드 3). 처음
바탕에서 돌린 값은 각 커밋 메시지와 QA 라운드 1에 있고, 두 바탕에서 실패한 행의 이름은 모두 같다. 실패 행은 모두 새로 넣거나 바꾼
행이고, 양쪽 통과를 뜻한 행은 부모에서도 통과했다.

| 증분      | 항목                                                             | 테스트 먼저 → 코드                                                                                                                                                                     | 부모 실패(옮긴 뒤)                                                                                                                                               | 런타임 경로                            |
| --------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| R3-1      | PSK-01 ~ PSK-06의 A2, PSK-04, OV-A22, Q15                        | `94d7bd10` → `9b675dcd`, `64a4ebc9`(`getAdministrators` 삭제)                                                                                                                          | 18 / 16,779(단위 전체 706 files, 처음 바탕은 18 / 16,685). 로컬 critical E2E는 두 커밋 모두 100 / 100, 바뀐 고정값과 bootstrap 모의를 main 것으로 돌리면 21 실패 | App                                    |
| R3-2      | ZS-05                                                            | `d07df702` → `f3ef7f9b`                                                                                                                                                                | 1 / 196(2 files)                                                                                                                                                 | App                                    |
| R3-2      | ZS-06(동작 변화)                                                 | `2f233013` → `6ea2db9b`, ADR `147dbb06`                                                                                                                                                | 2 / 19(1 file)                                                                                                                                                   | App                                    |
| R3-3      | PLE-04                                                           | `5bc163ee` → `6d3d351b`                                                                                                                                                                | 6 / 955(10 files, 처음 바탕은 954. 더한 1은 R2 받아들이기의 교차 계약 행)                                                                                        | App                                    |
| R3-4      | HDR-1, PSK-07                                                    | `d112ba5d` → `c2e45d0f`                                                                                                                                                                | 4 / 147(`api.test.ts`), 주간 Playwright `e2e/pro-entry-password.test.ts` 10 / 10(코드 커밋에서 10 통과)                                                          | App(`cloudflare/app-worker.ts`는 주석) |
| R3-5      | STD-3, STD-4                                                     | `0bdbf1d3` → `dd107a8c`                                                                                                                                                                | 5 / 70(3 files)                                                                                                                                                  | App                                    |
| R3-6      | PSK-11 클라이언트(좁힘)                                          | `afa2aaff` → `6c990739`                                                                                                                                                                | 9 / 307(3 files)                                                                                                                                                 | App                                    |
| R3-7      | Q21 요구 값 비우기                                               | 없음 → `85f327c5`                                                                                                                                                                      | 해당 없음(값 하나, 건너뜀 행은 P2가 고정)                                                                                                                        | 없음(workflow)                         |
| 기록      | §2·§3·§4, hotfix-procedure, PRO 운영 문서, 이 보고서             | `aaf0e70e`(문서), QA 라운드 2를 적은 `6bf7a96d`, 리뷰를 반영한 `3f83a12c`·`b578dc63`, 옮긴 뒤의 문서 커밋 `2262aed8`, 옮김과 bump 리뷰를 반영한 `ea227a15`(겹친 줄)과 마지막 문서 커밋 | 해당 없음                                                                                                                                                        | 없음                                   |
| bump      | 9.0.25 / v798                                                    | 없음 → `01f1a19b`(마지막 런타임 커밋)                                                                                                                                                  | 해당 없음(`guard:release-identity`, `guard:sw-cache-version` PASS)                                                                                               | App(버전 거울 넷)                      |
| 교차 계약 | bootstrap 네 상태, PIN 세션, presence 입장, 계정 분리(리뷰 반영) | 없음 → `5c0c6b6d`(시험만, bump 뒤)                                                                                                                                                     | 해당 없음(양쪽 통과 행. Worker의 suspended bootstrap에서 `passwordRequired`를 빼면 이 행이 실패함을 확인하고 되돌림)                                             | 없음                                   |

## 증분

아래 증분마다의 SHA와 부모 결과는 처음 `91601774` 위에서 만든 때의 것이다. 옮긴 SHA와 새 부모의 결과는 위 표와 QA 라운드 3에 있다.

### R3-1 스냅샷 schemaVersion 1 받기 중단 (PSK-01 ~ PSK-06의 A2, PSK-04, OV-A22)

`parseProRoomSnapshot`이 schemaVersion 2만 읽는다. schemaVersion 1 갈래와 그 키 목록(`LEGACY_SNAPSHOT_SCHEMA_VERSION`,
`parseSnapshotWireVersion`, `LEGACY_PRESENCE_KEYS`, `LEGACY_VIEWER_KEYS`, `LEGACY_SNAPSHOT_KEYS`, `OPTIONAL_SNAPSHOT_KEYS`와 presence·viewer
파서의 와이어 판 인자)을 지웠다. 코디네이터 시대 키 넷이 있든 없든 v1 와이어는 null이 되어, 그것을 실은 답은 모두
`INVALID_RESPONSE`다. `passwordRequired`와 `playlistSlots`가 정확한 키 집합에 들어가고 `ProRoomSnapshot`에서 필수가 됐다. 읽는 쪽의
대체값(없는 `passwordRequired`를 보호로 보던 것, 없는 `playlistSlots`를 null로 내던 것)과 playlist-state-manager의
`requirePlaylistSlots`, `activePlaylistSlot`을 지웠다. 남긴 것: 재생과 presence의 `coordinatorEpoch` 일치, 아무도 없는 sleeping 방만
받는 조건. 관리자 목록 PUT·DELETE 답은 `{ administrators }`만 받는다(PSK-04). bootstrap은 모든 상태에서 `passwordRequired`를 요구하고
open이면 false, pin_required면 true다(Q15). 부르는 곳 없는 `getAdministrators`는 따로 커밋에서 지웠다(`git log -S`로 `c8aa1139`에서
생긴 뒤 제품 호출이 없음. PRO Worker의 GET 경로는 그대로).

- 부모 `91601774`에서 단위 전체 16,685행 가운데 18행 실패: `domain.test.ts`(v1 와이어 셋의 거절, 두 필드 없는 스냅샷, 같은 revision과
  다음 revision의 v1 와이어), `api.test.ts`(v1 스냅샷을 실은 GET, 세션, 계정 분리, 전체 하트비트 답, `authorityVersion`이 든 관리자
  답, `passwordRequired` 없는 bootstrap의 activation_required·pin_required·suspended, `playlistSlots` 없는 스냅샷),
  `runtime-playlist-slots.test.ts`(`playlistSlots` 없는 Worker 스냅샷이 입장을 `PRO_ROOM_SNAPSHOT_INVALID`로 멈춤).
- 고정값: 스냅샷 도우미가 두 필드를 빠뜨린 고정값에 `passwordRequired` true와 playlist 하나의 `playlistSlots`를 더한다(두 와이어
  모두). 만든 스냅샷의 playlist를 바꾸는 모의 서버(약 35행, 여섯 파일)는 새 시험 도우미 `recountProPlaylist`로 활성 칸 개수를 다시
  센다. 모두 부모에서 통과한다. 제품 export는 더하지 않았다.
- e2e: PRO 고정값(`e2e/helpers/pro-room-fixture.ts`)이 `passwordRequired` true인 schemaVersion 2 스냅샷이고 bootstrap 모의
  여섯(critical-browser 셋, pro-upload-recovery, pro-activation-account, dialog-locale-layout)이 `passwordRequired`를 싣는다. 로컬
  critical E2E(`test:e2e:critical`, Chromium 98행)는 테스트 먼저 상태와 코드 커밋 `ca359032`에서 모두 98 / 98 통과했다(증분 작업
  로그).

### R3-2 시작 종류는 timingMode로만 (ZS-05, ZS-06)

ZS-05: transition COMMIT은 `timingMode`가 zero-start일 때만 zero-start로 시작하고, 종류를 싣지 않은 COMMIT은 앞섬이 몇이든 예약
제어다. 그 앞 PRO Worker가 zero-start를 표시하던 699 ms 앞섬 판독(`PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS`)을 지웠다. 필드는 선택이라
(Q4) 필드 없는 COMMIT도 진행 중 타임라인에서 재생되고, 배운 시작 앞섬만 쓰지 않는다. 부모 `ca359032`에서 1 / 196 실패(699 ms의 새
행). 700 ms와 702 ms 행은 양쪽 통과이고, 필드로 옮긴 재생 행 셋도 양쪽 통과다.

ZS-06(의도한 동작 변화, Q5): 하트비트 스냅샷 복원이나 재조정이 이 App이 준비한 PREPARE의 checkpoint를 COMMIT 프레임보다 먼저
내려놓으면, `restorePlaybackCheckpoint`가 그 PREPARE의 전환으로 커밋하면서 이제 PREPARE가 적은 종류도 싣는다. 그래서 하트비트가
COMMIT을 앞지른 기기도 방의 다른 기기처럼 zero-start로, 배운 시작 앞섬을 써서 시작한다. 맞는 PREPARE가 없거나(늦은 입장, 방이 그
revision을 다른 checkpoint로 커밋함) PREPARE가 예약 제어나 종류 없음을 적었으면 복원은 예약 제어 그대로다(ZS-09). checkpoint 시각
뒤에 도착한 복원은 늦은 COMMIT처럼 다룬다. 부모 `23efea6a`에서 2 / 19 실패(복원과 재조정의 zero-start 행), 예약 제어 넷은 양쪽
통과다. 서버 권한 ADR(`docs/design/pro-room-server-authority.md`)의 시작 종류 문단이 경로마다 어느 종류를 읽는지 적는다(`77f65ca0`).
레지스트리 RO-03의 699 문장과 그 시간 시험의 699 고정도 고쳤다(Worker가 아직 읽는 2999 ms 고정은 남김).

알려진 가장자리(리뷰 지적, 고치지 않음): ZS-06은 PREPARE를 checkpoint 필드(revision, 항목, 상태, 위치, YouTube 필드)로만 고른다.
PREPARE가 대기 중인데 같은 대상의 직접 명령이 오면(예: zero-start PREPARE가 대기 중인 같은 항목을 0에서 다시 시작) PRO Worker는
그 전환을 취소하고 같은 예약 revision에 `transitionId` 없이, 곧 예약 제어로 커밋한다. 그때 CANCEL 프레임보다 하트비트 스냅샷을 먼저
받은 기기는 그 PREPARE의 zero-start로(배운 시작 앞섬 적용), COMMIT 프레임을 받은 기기는 예약 제어로 시작한다. R3 앞에는 스냅샷
길도 예약 제어였다. 거절이 아니라 드문 기기별 시작 앞섬 차이이고, 막으려면 PREPARE의 종류를 쓰기 전에 그 전환의 CANCEL이 없었음을
따로 확인해야 한다.

### R3-3 숫자 LAN-direct 거절 (PLE-04)

`parseProRoomSystemAudioState`가 live LAN-direct를 `liveExpiresAt` null로만 읽는다. 그 앞 PRO Worker의 숫자 호환값(PLE-01부터 null로
읽던 것)은 다른 잘못된 값처럼 거절하고, SFU live는 여전히 양의 마감이 있어야 한다. 하트비트 답은 그 상태가 무효면 무효이므로 그런
답, `/system-audio` 상태, commit, lease 하트비트 답이 `INVALID_RESPONSE`다. live 타입은 그대로(`number | null`)다.

- 부모 `b6658208`에서 6 / 954 실패(계약 행, 전체·compact 하트비트, 상태·commit·lease 답, 컨트롤러의 `INVALID_STATE`).
- 파서에 닿는 LAN-direct 고정값을 모두 null로 옮겼다(시험 실행에서 옮기지 않으면 아홉 파일 104행이 고정값만으로 실패). 수신 슬롯의 S7
  승격 행과 5B-G6 두 시간 예산 행은 마감 없는 직접 live에서 시작해 SFU 서술자가 승격의 예산을 싣는 것을 그대로 본다. 모두 양쪽
  통과다.
- `pro-room-worker.test.ts`의 LAN-direct 교차 계약 행이 Worker 자신의 와이어가 null이고 App이 그 와이어를 그대로 읽음을 본다. 이
  행이 null을 보내는 Worker보다 이 거절이 main에 먼저 들어가는 것을 막는다.

### R3-4 opt-in 머리글 보내기 중단 (HDR-1, PSK-07)

`ProRoomApiClient`가 PRO 요청에 `X-MXQR-Pro-Entry-Policy: optional-v1`과 `X-MXQR-Pro-Playlist-Slots: v1`을 싣지 않는다. 릴리스 W의
PRO Worker부터 어느 PRO Worker도 읽지 않고, 그 앞 Worker는 이 App이 거절하는 schemaVersion 1을 보낸다. `X-MXQR-App-Build`는 남는다.
App facade의 소유권 이전 commit 주석을 고쳤다(app 경로의 주석뿐이라 target `app` 그대로). PRO 운영 문서의 bootstrap 문장이 9.0.25를
두 머리글을 모두 보내지 않는 첫 App으로 적는다. Worker 시험 주석 둘이 '모든 App이 보냄'을 9.0.24까지로 고쳤다.

- 부모 `77f65ca0`에서 `api.test.ts` 4 / 147 실패(소유권 이전, 공개 방 입장, PIN 변경, presence 입장과 스냅샷 읽기). 주간 Playwright
  `e2e/pro-entry-password.test.ts`의 공유 route 모의가 모든 `/api/pro-room/` 요청에서 두 머리글이 없음을 보므로, 부모의 e2e 빌드에서
  열 행이 모두 실패하고 이 커밋의 빌드에서 모두 통과했다.
- 남긴 것: PRO Worker의 CORS 허용 목록과 그 시험 행(뒤의 PRO 정리), e2e CORS 모의, 9.0.22 ~ 9.0.24 탭처럼 머리글을 보내는 Worker 시험
  고정값, 릴리스 smoke와 바닥 도구의 entry-policy 머리글(Q10. 그래서 그 도구는 이 App과 요청 모양이 다르지만 Worker의 답은 같다),
  `src/pro-room/snapshot.ts`의 `parsePlaylistSlots` 문서 주석 'Opt-in summary'(런타임 파일이라 bump 뒤에 고치지 않고 뒤의 PRO 정리에서).

### R3-5 SESSION_FULL과 OPERATOR_TOAST를 키로만 (STD-3, STD-4)

게스트가 방장의 자기 언어 대체 문구를 읽지 않는다. SESSION_FULL은 번역한 `i18nKey`를, 키가 없거나 사전에 없으면 게스트 자신의 '방
가득 참' 문구를 보이고, 검증기가 `message` 절을 지워 `message`는 읽지 않는 키다. OPERATOR_TOAST는 검증기가 `i18nKey`(128자 미만
문자열)를 요구하고 그 번역만 보인다. 이 App이 모르는 키는 아무것도 보이지 않는다(Q7). `text`는 읽지 않는 키다. ProtocolMap 타입도
따라가 `text`를 다시 넣는 송신자는 타입 검사에서 걸린다. room-authority 지문(`handleOperatorToast`의 방장·운영자 관문)은 그대로다.

- 부모 `55d8e0c7`에서 5 / 70 실패(방장 문구만 실은 room-full 프레임, `text`만 있거나 모르는 키의 운영자 알림, 열기 전 room-full,
  `protocol-validation-coverage.test.ts`의 정확 목록 비교).
- 시험 locale이 시스템 locale을 따르므로(Node의 `navigator.language`) 새 행은 글자 대신 `t(...)`를 기대하고 한국어 방장 문구를
  보낸다. 영어 시스템에서만 'Room is full'이 게스트 문구와 우연히 같다.

### R3-6 은퇴한 PRO 개발자 신호 프레임 (PSK-11 클라이언트, 좁힘)

developer-command, developer-invalidation, 단독 pro-queue-addition 신호 프레임은 브라우저 코디네이터의 것이었다. 신호 Worker는
2026-07-20 `d4b208cc`(PRO 방 권한을 서버로 옮김)에서 두 문자열을 잃었고(`git log -S`), 내부 개발자 경로는 409
`PRO_COORDINATOR_REMOVED`로 답한다(`cloudflare-signaling-worker.test.ts`가 고정). PRO 큐 추가 알림은 `pro-room-invalidated` 서버
사건의 `addition`으로만 App에 오고 `acceptProRoomRealtimeFrame`이 읽는다(RO-46).

- 지운 것: `cloudflare-signaling.ts`의 세 프레임 파싱, 호스트 소켓의 코디네이터 전용 방출, 게스트 소켓의 거절(이제 다른 모르는
  프레임처럼 무시). `transport/types.ts`의 `DeveloperCommandFrame`, `DeveloperInvalidationFrame`, 두 파서, `TransportPeer`의 세 사건.
  bus 짝 하나를 한 커밋에서: `peer.ts`가 그 전송 사건을 `network:pro-queue-addition`으로 넘기던 것, `runtime.ts`의 그 리스너,
  EventMap 항목(bus-pairing 203 / 203 → 202 / 202). 개발자 `set_effects` 명령이 유일한 제품 호출이던 App의
  `parseRoomEffectsPatch`, `RoomEffectsPatch`, `mergeRoomEffectsForTests`(남기면 dead-exports 시험 전용이 21로 늘어남. PRO Worker는
  자기 사본을 씀).
- 남긴 것: `ProQueueAdditionFrame`과 `parseProQueueAdditionFrame`(서버 사건 경로), 전송 계층 PRO 신호 모드의 티켓 role
  'coordinator'. 제품 코드는 `d4b208cc` 뒤로 전송 계층에 `proSignaling`을 넘기지 않으므로 그 PRO 모드 전체가 운영에서 쓰이지
  않는다. role만 지우면 계속 쓰이지 않을 모드의 코디네이터 호스트 행(`cloudflare-signaling.test.ts`, `pro-epoch-close-name.test.ts`)을
  다시 써야 해서, 그 모드는 뒤의 정리 한 번으로 지우도록 남겼다. 신호 Worker 쪽은 그대로다(Q15).
- 부모 `fc7b5996`에서 9 / 307 실패(세 프레임 × 일반방 호스트, 일반방 게스트, PRO member 소켓에서 오류 없이 무시. 부모는
  `UNEXPECTED_DEVELOPER_*` 오류를 냄). 코드 커밋은 코디네이터 소켓 행 넷과 두 개발자 파서 블록을 지우고 큐 추가 파서 행을
  `pro-queue-addition.test.ts`로 그대로 옮겼다. `room-effects.test.ts`는 patch 행을 지우고 상태 행을 남겼으며, 병합 행이 지키던
  `roomEffectsEqual`은 양쪽 통과 행 하나가 지킨다.

### R3-7 PRO 최소 빌드 요구 값 비우기 (Q21)

`.github/workflows/release.yml`의 'Check the App build floor the PRO Worker requires' 단계 `MXQR_PRO_ROOM_REQUIRED_APP_BUILD`를 '795'
→ ''. 그 위 주석이 왜 비었는지 적는다. 이 변경이 main에 들어온 뒤에는(9.0.25가 live로 남았는지와 관계없이) schemaVersion 2 보내기만
되돌리는 수리(이 변경 전 비상 길의 기본 출구)가 모든 PRO 방을 깨뜨리므로, App을 795 아래로 내린 뒤의 수리는 schemaVersion 2를 그대로
보내고 곧 바닥을 795로 다시 올린다. schemaVersion 1 보내기로 돌아가는 수리는 이 App 변경도 함께 되돌린다. 그래서 검사는 그
수리나, App 보고가 멈췄을 때의 뒤 PRO 릴리스를 막을 뿐이다(계획 Q21 (4)). 단계와 멈춤 출구, P2의 단위 행은 남고 값이 비면 요청 없이
건너뛴다('skips without a request while the PRO Worker requires no App build'). P2의 구조 행이 빈 값을 받아 시험은 그대로다. 어느
런타임 경로 목록에도 없어 target이 바뀌지 않고, 이 변경을 되돌리면 795가 돌아온다. bump는 하지 않았다.

### 기록

- release-record §2: 이 릴리스의 '배포 전' 항목, 'PRO 시작 시계 현장 확인'에 ZS-06, schemaVersion 2를 보내는 PRO Worker의 §2 항목에는
  되돌리기 문장 끝의 가리킴 하나(9.0.25 뒤에는 §4 현재 경계 줄 (8)대로 App을 먼저, 위 '계획과 달라진 것' 10). §3: 요구 값 문장(795 →
  비어 있음과 그 이유). §4: 머리의 현재 경계 줄((1)의 가리킴, (3)의 바닥이 (8)로 오름, (6)에 '9.0.25 뒤에는 (9)'와 main에 9.0.25의
  변경이 없을 때의 수리 출구(있으면 9.0.25가 live로 남았는지와 관계없이 (9)의 수리), 새 (8) 9.0.25 뒤 PRO를 schemaVersion 2를 처음
  보내는 PRO Worker 아래로 되돌리지 않음과 꼭 할 때의 순서, 새 (9) 합친 순서와 그 뒤 수리), 이 릴리스 항목, schemaVersion 2 PRO Worker
  항목의 코드 되돌리기와 수리 출구에 9.0.25 조건, 릴리스 W 항목의 'App 파서는 둘을 선택으로 받고'를 9.0.24까지로.
- hotfix-procedure: presence close 문단(손 PRO 되돌리기 바닥이 9.0.25 뒤 schemaVersion 2 PRO Worker로 오름), App Build Floor의 요구
  값 문장(9.0.25가 비움), schemaVersion 2 PRO Worker 문장(main에 9.0.25의 변경이 없을 때의 수리 출구, 9.0.25 뒤에는 다음 문장의
  순서, 그 변경이 머지된 뒤에는 다음 문장의 수리), 이 릴리스의 문장(PRO 손 되돌리기 금지와 꼭 할 때의 순서, 합친 순서, 그 뒤 수리와
  schemaVersion 1로 돌아가는 수리의 조건), Rollback의 CLI 문장.
- `docs/design/pro-room-architecture-and-operations.md` Rollback: 릴리스 W 앞 PRO 문단의 머리글 조건과 '파서는 둘을 선택으로'를 9.0.24까지로,
  9.0.25의 되돌리기 문단.
- `docs/README.md` 증거 목록에 이 보고서.

## 계획과 달라진 것

계획의 줄은 모두 기호로 다시 찾았다(줄은 R1, R2와 앞 증분이 밀었다). 그 밖에 계획 시점(`6a23c46e`)과 다른 것:

1. **R3 checkpoint의 App:** 계획 §4의 합친 순서는 'App을 R3 checkpoint의 R1 App으로'다. R1 뒤 9.0.23 / v796과 9.0.24 / v797이 나갔으므로 이
   릴리스의 checkpoint App은 그 직전 live App(예정으로는 9.0.24)이다. 9.0.22 이상이라 두 스키마를 모두 읽고 바닥 795 이상이라
   `lower`가 필요 없어 순서의 뜻은 같다. 영구 문서는 '9.0.25 릴리스 checkpoint의 App'으로 적었다.
2. **R3-1:** R1-6(`cc8d024b`)이 계획의 `snapshot.ts` 범위 일부(코디네이터 키 절)를 이미 지웠고, R3-1은 남은 schemaVersion 1 갈래를
   지웠다. 계획의 '참가자가 있는 sleeping 스냅샷 거부' 행은 R1-6 후속 `2e675b36`이 두 와이어로 이미 더해 다시 더하지 않았다. 관리자
   답 모의(`runtime-server-playback.test.ts`)는 R1-6 뒤 이미 `{ administrators }`라 고칠 것이 없었다. 두 필드를 필수로 하자 계획이
   보지 못한 단위 고정값(약 35행)을 맞춰야 했다. `getAdministrators`는 따로 커밋에서 지웠다(R1-4 LEAVE-1 `590c1b7d` 선례). 부모도 이미
   `passwordRequired` false 없는 open bootstrap을 거절했으므로 bootstrap의 동작 변화는 activation_required, pin_required,
   suspended뿐이다. `dialog-locale-layout`의 activation_required 모의는 요청되지 않는다(그 시험은 '/'를 연다).
3. **R3-2:** R1-10이 더한 App 699의 서술 둘(RO-03 시간 시험의 699 고정, 레지스트리 RO-03 문단)을 ZS-05 코드 커밋에서 고쳤다.
   `cloudflare/pro-room-playback-timing.ts` 머리 주석도 같은 말을 하지만 PRO와 App 두 경로에 든 파일이라 고치면 target이 `all`이 되어
   2999 읽기를 지우는 PRO 릴리스(R4)로 미뤘다. ZS-06 행은 복원만이 아니라 같은 함수를 쓰는 재조정 경로에도 두었다. 서버 권한 ADR의
   시작 종류 문단은 계획의 기록 목록에 없지만 R2-4가 쓴 그 문단이 699 판독을 적어 고쳤다.
4. **R3-3:** 계획은 숫자 LAN-direct 고정값 이동을 선택 타입 나누기의 일로 보았지만, 거절만으로 아홉 파일 104행이 고정값 때문에
   실패해 이동은 필수였다(테스트 먼저 커밋, 양쪽 통과). 선택인 live 타입 나누기는 작지 않아(런타임 타입 오류 하나, 시험 아홉 파일
   13개) 하지 않았다. 파서에 닿지 않는 숫자 고정값 둘(`session-controller.test.ts`, `system-capture-stop.test.ts`)은 남겼다.
5. **R3-4:** `e2e/pro-entry-password.test.ts:103`은 공유 route 모의에 있어 부모에서 한 행이 아니라 열 행이 모두 실패한다. App
   facade 주석은 두 곳이 틀려 통째로 다시 썼다. 계획 밖의 Worker 시험 주석 둘을 고쳤다. bus-pairing은 이 브랜치 바탕에서 계획 §5의
   202 / 202가 아니라 203 / 203이었다.
6. **R3-5:** 계획은 'Room is full'이 우연히 같다고 보았지만 시험 locale은 시스템을 따른다(위 R3-5). 닿지 않게 된
   `handleOperatorToast`의 `typeof i18nKey` 확인을 지웠다. 선택 항목(bus 타입, setup.ts 대체)은 계획의 파일 목록 밖이라 하지 않았고,
   모르는 키 행(Q7)을 더했다.
7. **R3-6 범위:** 계획의 PSK-11 클라이언트 잔재는 티켓 role 'coordinator'를 포함하지만, 전송 계층의 PRO 신호 모드 전체가
   2026-07-20 뒤로 운영 호출이 없다(제품 코드가 `proSignaling`을 넘기지 않음). role만 지우면 쓰이지 않을 모드의 코디네이터 호스트
   행을 다시 써야 해서 개발자 프레임과 bus 짝만 지웠다. 계획의 '테스트 54줄' 가운데 21줄(`cloudflare-signaling-worker.test.ts`)은
   신호 Worker를 시험하므로 Q15대로 그대로다. 개발자 명령 파서를 지우자 App의 효과 patch 파서가 죽어 함께 지웠다(dead-exports 기준치
   유지). 정리 행만이 아니라 세 프레임을 무시하는 테스트 먼저 행(9)을 두었다.
8. **기록 범위:** 계획이 적은 'the App still sends it'(PRO 운영 문서 :197-200)은 R3-4가 이미 고쳤다. 계획 밖에서 틀리게 된 문장
   셋(PRO 운영 문서 Rollback의 '9.0.14 to 9.0.21'과 '파서는 둘을 선택으로', release-record §3의 요구 값 문장)을 고쳤고, R1·R2처럼
   §2에 '배포 전' 항목을 더했다. §1 '의존성·호환'의 틀리게 되는 두 문장(8.11.33 opt-in 머리글을 'App은 계속 보내고', 릴리스 A의
   SESSION_FULL·OPERATOR_TOAST 받기)은 §1이 운영 상태라 배포 기록 PR이 고친다(§2 항목에 적음). 열차 2 보고서
   (`old-version-removal-2w-workers-2026-10-26.md`)의 같은 문장은 날짜가 붙은 근거라 두었다.
9. **가드:** bump 전에는 `guard:sw-cache-version`이 실패했고 `guard:release-identity`는 통과했다(QA 라운드 2). bump `01f1a19b`
   뒤에는 둘 다 통과한다(QA 라운드 3).
10. **main 위로 옮김과 번호(2026-10-30):** 이 브랜치는 schemaVersion 2를 보내는 PRO Worker 브랜치의 끝 `91601774`(받아들이기 전)
    위에서 만들었다. 그 PRO Worker는 squash `0e5a9b87`로 들어갔으므로 `git rebase --onto`로 R3 커밋 21개만 main으로 옮겼다. 그
    사이 번역 페이지 입구 열차가 9.0.24 / v797로 나가(`78ec56f5`, 03:20 KST) 이 릴리스는 9.0.25 / v798이 됐다. 옮기기 전에 R3가
    자기 릴리스를 적은 줄만 고쳤다: 9.0.24 / v797(빌드 797)은 9.0.25 / v798(빌드 798)로, 이 릴리스의 forward revert 번호 9.0.25 /
    v798은 9.0.26 / v799로, 'R3 앞 마지막 App'을 뜻하던 9.0.23은 9.0.24로(Worker 시험 주석 둘, PRO 운영 문서와 release-record의
    '선택으로 받는 파서', 혼합 버전 표, 이 보고서). 커밋 메시지도 같은 규칙으로 고쳤다. 충돌과 해결:
    - `src/pro-room/__tests__/pro-room-worker.test.ts`(R3-3 테스트 먼저): R2 받아들이기가 더한 예약 제어 PREPARE·마감 COMMIT 교차 계약
      행을 그대로 두고, 그 아래 LAN-direct 행의 주석만 R3 것('this Worker answers its liveExpiresAt as null')으로.
    - release-record(기록 커밋): main의 §4 현재 경계 줄에 (5)(지금 운영 App)가 생겨 R3의 (5) ~ (8)을 (6) ~ (9)로 옮겼고, R3가 다던
      가리킴을 main의 글에 맞춰 달았다((1)의 '(8)의 App이 배포된 뒤에는 (9)의 합친 순서', (3)의 '(8)로 오른다', (6)의 수리 출구).
      §1, R2와 9.0.24의 §2 항목은 main 글자 그대로 두었다. 그래서 R3가 R2의 §2 되돌리기 줄에 달던 가리킴은 빠졌다가, 옮김과 bump의
      리뷰 반영 때 그 줄 끝에 가리킴 하나로 다시 달았다(AGENTS.md: 바뀐 열린 항목에서 보고서로 잇기). §2의 R3 항목은 맨 위, §4의 R3
      항목은 9.0.24 항목 위다. 뒤의 문서 커밋 셋도 같은 번호로 옮겼다. 이 해결이 §4 schemaVersion 2 PRO Worker 항목의 코드 되돌리기
      첫 줄을 두 번 남겨, 9.0.25 조건 없이 끊긴 글머리가 하나 더 보였다. 리뷰 반영의 `ea227a15`가 그 줄을 지웠고, 그 항목의 main
      대비 차이는 가리킴과 수리 글머리의 조건뿐이다.
    - hotfix-procedure(기록 커밋): main이 R2 기록에서 더한 구체 값(9.0.22 PRO Worker `71f5b96c`·`6abc7131`, 첫 schemaVersion 2 PRO
      Worker `0e5a9b87`·`ef882f7c`, 수리 `all`에 PRO·Signaling·App의 자동 복구가 없다는 문장)과 R3 문장을 합쳤다.
    - PRO 운영 문서: main의 '클라이언트만 되돌릴 때' 문단에 9.0.25가 live가 된 뒤에는 위 App 단계가 PRO 단계보다 먼저라는 말을 더했다.
    - `docs/README.md`: 이 보고서 항목을 맨 위에.
      9.0.24의 기록(#531 `d630269a`, 문서만)이 옮기는 동안 main에 들어와 그 위로 한 번 더 옮겼다. release-record만 다시 겹쳤고 같은
      규칙으로 풀었다. 두 번 모두 R3의 문서 변경 줄과 런타임 변경은 그대로다(옮기기 전후 diff 비교).

## 정확한 개수 가드

바뀐 기준치는 없다. bump 트리 `01f1a19b`에서 다시 쟀다(QA 라운드 3). bus-pairing은 main `d630269a`의 203 / 203에서 202 / 202(R3-6이
죽은 짝 하나를 한 커밋에서 지움, 기준치가 아니라 실측). dead-exports(401 files, 2,108 bindings, 완전히 죽은 것 0, 시험 전용 20 / 기준
20, 자기 전용 76 / 기준 76, 둘 다 기준치와 같아 내릴 것이 없음), import-graph 401 files, 2,082 edges(main 2,084), 순환 0,
room-authority(직접 읽기 79, 구독 22, 쓰기 13, PRO 읽기 0, 스냅샷 읽기 0, main과 같고 `handleOperatorToast` 지문 그대로), 선언된 메시지
종류 101, resource-ownership 49 records / 448 files(main과 같음). 줄 수: `src/pro-room/runtime.ts` 4,154 / 10,000. 제품 코드 +106 /
−574줄(`src/` 14 파일과 `cloudflare/app-worker.ts` 주석, bump의 버전 줄 제외).

## 혼합 버전

바닥 795 뒤 운영에 새로 들어올 수 있는 App은 9.0.22(795) 이상이다.

| 조합                                                                                    | 결과                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.0.25 App, schemaVersion 2를 처음 보내는 PRO Worker나 그 뒤                            | 모든 스냅샷, 관리자 답, 종류 실은 PREPARE·COMMIT, null LAN-direct를 읽는다. opt-in 머리글이 없어도 Worker의 답은 같다. 하트비트가 COMMIT을 앞지른 기기도 PREPARE의 종류로 시작한다(ZS-06)                     |
| 9.0.22 ~ 9.0.24 App(열린 탭), 같은 PRO Worker                                           | 바뀌지 않는다(두 스키마를 읽음). 그 탭은 opt-in 머리글을 계속 보내고 Worker는 읽지 않는다                                                                                                                     |
| 9.0.25 App, schemaVersion 2 앞 PRO Worker(9.0.22의 PRO Worker. 손 되돌리기, (8)이 금지) | 모든 스냅샷 답이 `INVALID_RESPONSE`이고, live LAN-direct의 숫자를 거절해 그 방의 하트비트 답 전체를 버리며, 종류 없는 COMMIT을 모두 예약 제어로 시작한다(소리는 멈추지 않음). 그 탭은 새로 고칠 때까지 남는다 |
| 9.0.25 App, 그 PRO Worker가 숫자 LAN-direct를 저장한 채 한 번도 불러오지 않은 방        | 그 Worker가 불러올 때 null로 바꾸므로 답은 null이다. 그 변환은 뒤의 PRO 정리에서도 지우지 않는다                                                                                                              |
| 9.0.25 게스트, 9.0.22 이상 일반방 방장                                                  | 방장이 키만 보내므로 보이는 것이 같다                                                                                                                                                                         |
| 9.0.25 게스트, 바닥 아래 방장(유효 바닥 0 창)                                           | 9.0.21 이하 방장도 키를 함께 실으므로 번역한 키를 보인다. 키 없는 운영자 알림을 보낸 방장은 없다                                                                                                              |
| 신호 Worker                                                                             | 바뀌지 않는다. 2026-07-20 뒤 어느 신호 Worker도 개발자 프레임을 보내지 않는다                                                                                                                                 |

## 되돌리기

기본은 더 높은 SemVer와 캐시 epoch의 코드 되돌리기(9.0.26 / v799 이상)다.

**실패 자동 복구:** `app`의 실패 복구는 App만 checkpoint(dispatch 때 live인 App, 9.0.22 이상)로 되돌린다. 안전하다: 그 App은
schemaVersion 1과 2를 모두 읽고, 바닥 795 이상이라 `lower`가 필요 없다. Worker 호환 바닥 평가가 실패하면 대비 목록이 App을 건너뛰어
9.0.25 App이 실패 표시인 채 live로 남는다. schemaVersion 2 PRO Worker와 짝이 맞는 의도한 상태라 안전하고 앞으로 고친다. 다만 `app`의
배포 뒤 smoke(App generation, 익명 계정 경계, PRO 방 smoke의 health·bootstrap 카나리아 둘·익명 스냅샷 401, Standard HTTPS)는 HTTP만
보고 9.0.25 파서로 PRO 답을 읽지 않는다(배포 job은 브라우저 없이 돈다). 그래서 이 릴리스가 낼 수 있는 실패, 곧 9.0.25가 실제
schemaVersion 2 스냅샷, 하트비트, 관리자, 시스템 오디오 답을 거절해 9.0.25 탭의 모든 PRO 방이 깨지는 결함은 커밋 표지를 지나고 이
복구는 돌지 않는다. 그 결함은 배포 조건 7의 배포 직후 확인이 처음 보며, 그때는 '배포 직후 확인과 기기 확인'의 '실패하면'대로 App을
손으로 되돌린다.

**손 되돌리기 경계:** release-record §4 머리의 현재 경계 줄 (8), (9)와 §4의 이 릴리스 항목이 정본이다
([§4](../release-record.md#4-복구-시-주의), [hotfix-procedure](../hotfix-procedure.md#app-build-floor)).

1. 9.0.25가 배포된 뒤 PRO Worker를 schemaVersion 2를 처음 보내는 PRO Worker 아래로 손으로 되돌리지 않는다. 'App 9.0.25가 live인
   동안'이 아니다: App을 되돌려도 열린 9.0.25 탭은 새로 고칠 때까지 남는다. 꼭 되돌려야 하면 (a) App을 이 릴리스 checkpoint의
   App으로, (b) PRO를 9.0.22의 PRO Worker로(그 아래는 Durable Object 되돌리기 바닥이라 금지). 열린 9.0.25 탭은 (b)부터 새로 고칠 때까지
   PRO 방에서 깨진다. 그 PRO 버전은 'Rollback:' 메시지라 git 출처가 없으므로 다음 수리 릴리스는 `all`이다.
2. 합친 순서: 9.0.25 뒤 App을 9.0.22(빌드 795) 아래로 내리는 일은 (a) App을 이 릴리스 checkpoint의 App으로, (b) PRO를 9.0.22의 PRO
   Worker로, (c) 9.0.15 아래면 Signaling을 9.0.22 checkpoint의 버전으로, (d) 대상 빌드로 `lower`, (e) App 순서로만 한다. (a)가 끝난
   상태는 9.0.25 앞과 같아 (b) ~ (e)는 schemaVersion 2 PRO Worker 문장의 순서와 같다. PRO를 먼저 되돌리면 9.0.25 App이 live인 동안
   PRO가 schemaVersion 1을 보내 열린 탭과 새 페이지가 모두 `INVALID_RESPONSE`를 받는다.
3. 그 길 뒤의 수리: main의 App이 schemaVersion 1을 읽지 않으므로 수리 `all`은 schemaVersion 2를 보내는 PRO를 그대로 배포하고(그
   변경을 되돌리면 모든 PRO 방이 깨짐), 수리 직후 바닥을 795로 다시 올린다(그때의 저장 바닥으로 같은 값 `set`, `set` 795, `status`,
   신호 입장 smoke). `set`은 live App 위로 못 올리므로 수리 전에는 할 수 없고, 그 사이 열린 795 앞 탭은 PRO 방에서
   `INVALID_RESPONSE`를 본다. 요구 값이 비어 사전 검사가 이 수리를 막지 않는다(R3-7). 이 수리는 9.0.25가 live로 남았는지가 아니라
   이 변경이 main에 있는지로 정한다. 머지 뒤 `app` 실행이 smoke에서 실패해 자동 복구가 App을 9.0.24로 되돌려도 main의 App은
   schemaVersion 1을 읽지 않고 요구 값은 비어 있으므로, schemaVersion 2 PRO Worker 문장의 기본 출구(수리 PR이 schemaVersion 2
   보내기를 되돌림)는 그때부터 틀린다. schemaVersion 1 보내기로 돌아가는 수리는 이 App 변경도 함께 되돌린다.
4. 계약 표지는 바꾸지 않았다(Q8). 표지는 그 릴리스의 실패 자동 복구와 비상 배포만 막고 손 CLI 되돌리기는 막지 못하며, 바꾸면
   target `all`이 된다.

## 배포 조건과 순서

1. schemaVersion 2를 처음 보내는 PRO Worker가 머지되고 배포됐으며 그 기록 PR이 main에 있다(#528 `0e5a9b87`, 2026-10-30 00:30 KST
   배포, 기록 #529 `a8d8f9c4`). 채움: 이 브랜치를 9.0.24와 그 기록(#531)까지 든 main `d630269a` 위로 옮기고, 테스트 먼저 일곱을
   옮긴 부모에서 다시 돌려 같은 행만 실패함을 봤으며, R3-1의 로컬 critical E2E를 두 커밋에서 다시 돌리고, 9.0.25 / v798 bump
   `01f1a19b`를 마지막 런타임 커밋으로 둔 뒤 이 문서와 release-record §2 항목의 SHA를 고쳤다(QA 라운드 3). 머지 전에 main이 다시
   움직이면 다시 옮기고, 런타임이 바뀐 main이면 테스트 먼저와 전체 검사도 다시 돌린다. 그 PRO Worker를 손으로 되돌린 적이 있으면 그
   뒤의 `all` 수리 릴리스 뒤에만 낸다. 이 PR 머지 전 비상 길의 기본 출구(그 변경을 되돌리는 수리 PR)를 탔으면 바닥 795와 그 PRO Worker를
   다시 내고 기록한 뒤에만 낸다(그 전에는 교차 계약 행이 이 PR의 머지를 막는다).
2. dispatch 직전 live PRO Worker의 배포 메시지가 그 PRO Worker 머지 SHA의 `git:<sha>`(또는 그 뒤 PRO 런타임 변경이 없는 자손)다. App
   대상 부분 게이트도 PRO가 HEAD와 같은 런타임 경로인지 보고 손 되돌리기 버전에서 막지만 사람이 먼저 본다.
3. 그 PRO Worker의 배포부터 이 배포까지 런타임 의존성 변경을 머지하지 않았다. 이 배포부터 PRO 정리(`pro-room`)의 배포까지도
   런타임 의존성 변경(Dependabot 포함)을 머지하지 않는다(위 '오너 결정과 순서').
4. 이 PR은 dispatch 직전에만 머지한다. 그때부터 이 릴리스의 기록 PR 머지까지 다른 PR을 머지하지 않는다. exact-main CI success.
5. dispatch 직전 `status`를 다시 읽어 저장·유효 795와 300초 안의 App 보고(`generatedAt - reportedAt`)를 확인한다.
6. Release: target `app`, Developer API D1 `false`, `raise_app_build_floor` `false`. PRO 최소 빌드 사전 검사는 `app`에서 돌지 않는다.
7. 배포 직후(게이트 아님): 공개 최소 빌드 상태(`curl -s https://musixquare.com/api/app-build-floor`)를 읽어 저장·유효 795, live
   App 798, App 보고가 300초 안인지 보고, Operations Drift Audit을 돌린다. 그리고 아래 '배포 직후 확인과 기기 확인'의 나눠 줄
   절차 A, B, C(W = 3)와 선택 D를 합성 방(오너가 가진 PRO 방)에서 9.0.25 탭으로 하게 한다. 공개 상태, Drift Audit, 받은 관찰값을 그
   절의 판정 기준과 견준 판정을 QA 라운드 5에 적는다. 확인하는 사람에게는 판정 기준을
   건네지 않는다. 방이 뜨지 않거나 하트비트가 거절되면 그 절의 '실패하면'대로 App을 손으로 되돌린다(`app`의 smoke는 HTTP뿐이라 그
   결함에는 실패 자동 복구가 돌지 않는다).
8. 기록 PR: §1과 `Last source review` 덮어쓰기(§1 '의존성·호환'의 opt-in 머리글과 SESSION_FULL·OPERATOR_TOAST 문장 포함),
   `release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로, §4의 이 항목과 현재 경계 줄 (8)에 머지 SHA, Release ID, checkpoint
   ID, §4 현재 경계 줄 (5)를 9.0.25로(그 checkpoint App은 9.0.24 `dd820d37`), hotfix-procedure의 9.0.25 문장 옆에 머지 SHA와
   Release ID.

결과(QA 라운드 4, 5): 1은 기준 `d630269a`(#531)가 머지까지 그대로라 다시 옮기지 않았다(squash `b8ae59e7`의 부모가 `d630269a`이고
트리는 PR head `30e66813`과 같음). 그 PRO Worker를 손으로 되돌린 적과 비상 길은 없었다. 2는 dispatch 직전에 따로 읽은 근거가 없고,
릴리스의 App 대상 부분 릴리스 판정과 App 배포 직전 다시 확인이 compatible이었으며 App 배포 뒤 PRO 공개 경계 smoke가
`ef882f7c`(R2가 `git:0e5a9b87…`로 배포한 버전)를 읽었다. 3은 R2 배포부터 머지된 #529, #530, #531, #532가 런타임 의존성을 바꾸지
않았다(`package.json`과 `package-lock.json`은 버전 줄만). 이 배포부터 PRO 정리(`pro-room`)의 배포까지의 금지는 이제 유효하다. 4는
머지(07:07:07 KST) 뒤 exact-main CI success(배포 기록의 07:16:16 KST 줄)를 보고 dispatch했고(07:16:22 KST 생성), 릴리스의 'Verify
release commit is still current main'(07:16:44 KST)이 main이 그대로 `b8ae59e7`임을 확인했다. 그 사이와 이 기록까지 다른 머지는
없다. 5는 workflow `status` 실행이 아니라 공개 상태 읽기로 했다(07:16:20 KST 생성, 저장·유효 795, revision 3, live App 797, App
보고 약 33초 전). 6은 그대로 채웠다(PRO 최소 빌드 사전 검사는 `app`이라 skip). 7은 공개 상태(07:18:58 KST 읽기에서 저장·유효 795와
live App 798, 07:23:26 KST에 저장한 상태에서 보고 39초 전)와 Drift Audit(32 / 0 / 5)을 봤고, 배포 직후 확인의 A ~ C와 D2를
했다(D1은 하지 않음, 주인 기기는 Chrome 대신 Edge, A와 B는 블라인드가 아님). 실패가 없어 되돌리지 않았다(QA 라운드 5). 8은 이
릴리스의 배포 기록 PR이 했다(release-record §1, §2, §4, hotfix-procedure의 9.0.25 문장, `release-history.md`의 9.0.25 행).

## 사용자가 알아챌 변화

- 9.0.25: 하트비트 스냅샷이 COMMIT 프레임보다 먼저 온 PRO 기기가 다른 기기처럼 zero-start로 시작한다(배운 시작 앞섬 적용). 그 밖은
  지금 운영의 PRO Worker와 바닥 위 방장이 보내지 않는 모양만 거절해 보이는 변화가 없다. 업데이트 창이 한 번 뜬다.
- schemaVersion 2 PRO Worker 아래로 PRO를 손으로 되돌린 경우(금지)만: 9.0.25 탭의 PRO 방 실패(위 '혼합 버전').

## 기록과 레지스트리

- release-record §2: 이 릴리스의 '배포 전' 항목, 'PRO 시작 시계 현장 확인'의 ZS-06, schemaVersion 2 PRO Worker 항목의 되돌리기 줄
  가리킴. §3: 요구 값 문장. §4: 머리의 현재 경계 줄((1), (3), (6), 새 (8), (9))과 이 릴리스 항목, schemaVersion 2 PRO Worker 항목,
  릴리스 W 항목.
  §1은 배포 기록 PR이 덮어썼다. 그 PR이 §2의 이 항목을 '배포 뒤 확인'으로 바꾸고 'LAN-direct 2초 마감' 항목을 더했으며, §4의
  이 항목과 현재 경계 줄 (5), (8)에 머지 SHA, Release ID, checkpoint를 채웠다.
- hotfix-procedure: presence close 문단, App Build Floor의 요구 값 문장과 schemaVersion 2 PRO Worker 문장, 이 릴리스의 문장, Rollback의
  CLI 문장.
- `docs/design/pro-room-architecture-and-operations.md`(R3-4의 bootstrap 문장, 기록의 Rollback 문단),
  `docs/design/pro-room-server-authority.md`(R3-2), 레지스트리 RO-03(R3-2). 새 레코드는 없다.
- `docs/README.md` 증거 목록에 이 보고서. `release-history.md`의 9.0.25 행과 hotfix-procedure의 9.0.25 문장의 머지 SHA·Release
  ID는 배포 기록 PR이 더했다.

## QA 라운드

### 1. 증분별

`91601774` 위, 커밋 시각 2026-10-29 22:44 ~ 2026-10-30 02:18 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest
`--maxWorkers=4`. 이 라운드와 라운드 2의 SHA는 옮기기 전의 것이다(대응은 라운드 3의 표). 테스트 먼저 커밋마다 부모 코드에서 돌려
위 표의 행만 실패함을 봤다. 코드 커밋에서 돌린 것(커밋 메시지):

- R3-1 `870529a4`, `ca359032`: 단위 전체 702 files 통과(skip 1), 로컬 critical E2E 98 / 98(테스트 먼저 상태에서도 98 / 98. 그
  실행의 로그에는 HEAD 줄이 없어 트리를 확인하지 못했다. 옮긴 SHA에서 HEAD를 적어 다시 돈 결과는 라운드 3).
- R3-2 `23efea6a`, `b6658208`: pro-room과 youtube 단위.
- R3-3 `2e8a34f7`: pro-room, audio, network, core 단위.
- R3-4 `55d8e0c7`: `api.test.ts`, 이 커밋의 e2e 빌드에서 `e2e/pro-entry-password.test.ts` 10 / 10.
- R3-5 `fc7b5996`: network, player, ui 단위, `guard:room-authority-boundaries`(79, 22, 13 그대로).
- R3-6 `f72629c2`: 전송, room-effects, runtime-preload, network 단위 61 files / 1,487, `tsc`, `typecheck:tests`, eslint, prettier,
  bus-pairing 202 / 202, dead-exports 0 / 20 / 76, room-authority, import-graph, source-complexity. 테스트 먼저 `30d8cfbd`에서
  `typecheck:tests`, prettier, eslint.
- R3-7 `d965af02`: `app-build-floor-script.test.ts`와 `release-deployment-state.test.ts` 177 통과와 skip 1, prettier.

### 2. 전체 검사

기록 커밋 `39b36a0a`, 2026-10-30 02:33 ~ 02:50 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=4`. 계획의 기본
검사 전체를 한 번 돌렸다. `build:checked`는 첫 실패에서 멈추는 사슬이라 그 단계들을 하나씩 돌렸고, bump가 없어 실패하는
`guard:sw-cache-version` 하나 말고는 모든 단계가 종료 코드 0이다. 도는 동안 커밋 밖에 있던 것은 hotfix-procedure의 요구 값 문장 위치
고침 하나(이 문서 커밋에 들어감, 어느 시험도 그 문장을 읽지 않음)뿐이다.

- release target: `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`,
  `changedAppRuntimeDependencies`로 `91601774..39b36a0a`를 견줌: App 15(`cloudflare/app-worker.ts`, `src/` 14), PRO 방 0,
  remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 곧 `app`만이다.
- typecheck 전체(`types:workers:check`, `typecheck:tests`, `typecheck:browser-classic`, `typecheck:node-scripts`,
  `tsconfig.tooling.json`, `tsconfig.e2e.json` 포함), `check:workers`, lint, `format:check`.
- 가드: dead-exports(399 files, 2,104 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76), import-graph(399 files, 2,075 edges,
  순환 0), bus-pairing 202 / 202, lifecycle-writes, navigation-sinks, room-authority-boundaries(직접 읽기 79, 구독 22, 쓰기 13, PRO
  읽기 0, 스냅샷 읽기 0), transport-health, standard-room-hot-path, chunk-pump, source-complexity(`src/pro-room/runtime.ts` 4,154 /
  10,000, `.github/workflows/release.yml` 1,796 / 2,000), `node scripts/check-resource-ownership.mts`(49 records / 446 files).
- 단위 전체 702 files / 16,653 통과와 skip 1(jq가 없는 로컬에서 건너뛰는 `release-deployment-state.test.ts`의 한 행), 488 s.
- Worker 설정 커버리지 69 files / 3,320 통과. 전체 86.7 / 83.54 / 94.34 / 90.97, `cloudflare/app-worker.ts` 82.31 / 77.66 / 89.62 /
  87.46, `cloudflare/pro-room-worker.ts` 87.94 / 84.36 / 96.36 / 91.99, `cloudflare/signaling-worker.ts` 85.42 / 83.27 / 95.85 / 89.22.
- 핵심 커버리지 90 files / 3,521 통과(80.92 / 75.66 / 86.92 / 84.79), `src/network/transport/cloudflare-signaling.ts` 83.37 / 81.36 /
  85.43 / 88.56(문턱 72 / 71 / 72 / 78). release-tooling 커버리지 14 files / 432 통과와 skip 1(같은 jq 행), 79.55 / 75.24 / 86.38 /
  81.48.
- `build:checked`의 단계: `guard:release-identity` 'MUSIXQUARE 9.0.22; service-worker cache epoch v795'(버전 거울이 서로 맞아 통과),
  `guard:sw-cache-version` 'FAIL: committed PWA runtime changes are newer than v795 (16d24d89)'(bump가 없어서뿐, 릴리스 담당의 bump가
  고침), brand capitalization 996 sources, 진입 842.2 KiB raw / 247.9 KiB gzip, eager JS 455.2 KiB gzip, eager total 2,010.7 KiB raw /
  532.7 KiB gzip(9.0.22의 456.5와 2,017.1 / 534.1에서 줄어듦), SW 앱 셸 95 자산, 레거시 TV(Chromium 79) 정적 검사, prod-hooks,
  prod-security, 글꼴과 나머지 inventory·hreflang·sitemap 가드.
- 로컬 Playwright(Chromium, e2e 빌드, 02:53 ~ 02:59 KST): critical E2E(`test:e2e:critical`) 98 / 98, PRO 묶음(pro-activation-account,
  pro-entry-app-update, pro-entry-password, pro-entry-retry, pro-upload-recovery, dialog-locale-layout) 39 / 39. R3-1이 바꾼 고정값과
  bootstrap 모의, R3-4가 바꾼 route 모의의 머리글 확인을 이 커밋에서 다시 돈 것이다.
- `check:worker-bundles`는 돌리지 않았다(App Worker는 주석 하나만 바뀜).

### 3. main 위로 옮김과 bump 뒤 전체 검사

2026-10-30 04:45 ~ 06:15 KST. Windows 11 로컬(라운드 1, 2와 다른 PC), Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`, Playwright
Chromium(재시도 없음, 포트 4741 / 9741). 이 라운드가 운영에 닿은 것은 인증 없는 GET뿐이다.

**옮김.** 위 '계획과 달라진 것' 10대로 R3 커밋 21개를 `91601774`에서 main `78ec56f5`, 이어 `d630269a` 위로 옮기고 bump를 더했다.
작성자와 커미터는 모두 hiefny이고 병합 커밋은 없다. 코드 커밋 열(테스트 먼저 7, 코드 9)은 트리 변경이 그대로이고, 글자가 바뀐
것은 R3-4(Worker 시험 주석 둘과 PRO 운영 문서의 9.0.24 → 9.0.25), R3-7(workflow 주석), 기록 커밋들과 커밋 메시지다.

| 옛 SHA(`91601774` 위) | 옮긴 SHA(`d630269a` 위) | 커밋                                   |
| --------------------- | ----------------------- | -------------------------------------- |
| `559ef2f0`            | `94d7bd10`              | R3-1 테스트 먼저                       |
| `870529a4`            | `9b675dcd`              | R3-1 schemaVersion 1 받기 중단         |
| `ca359032`            | `64a4ebc9`              | R3-1 `getAdministrators` 삭제          |
| `29de4013`            | `d07df702`              | R3-2 테스트 먼저(ZS-05)                |
| `23efea6a`            | `f3ef7f9b`              | R3-2 ZS-05                             |
| `18cee3e7`            | `2f233013`              | R3-2 테스트 먼저(ZS-06)                |
| `b6658208`            | `6ea2db9b`              | R3-2 ZS-06                             |
| `79dc4836`            | `5bc163ee`              | R3-3 테스트 먼저(충돌 해결)            |
| `2e8a34f7`            | `6d3d351b`              | R3-3 PLE-04                            |
| `77f65ca0`            | `147dbb06`              | R3-2 서버 권한 ADR(문서)               |
| `d0d84b47`            | `d112ba5d`              | R3-4 테스트 먼저(메시지만 번호)        |
| `55d8e0c7`            | `c2e45d0f`              | R3-4 opt-in 머리글(번호)               |
| `4d975921`            | `0bdbf1d3`              | R3-5 테스트 먼저                       |
| `fc7b5996`            | `dd107a8c`              | R3-5 키로만                            |
| `30d8cfbd`            | `afa2aaff`              | R3-6 테스트 먼저                       |
| `f72629c2`            | `6c990739`              | R3-6 개발자 프레임                     |
| `d965af02`            | `85f327c5`              | R3-7 요구 값 비우기(번호)              |
| `39b36a0a`            | `aaf0e70e`              | 기록(충돌 해결, 번호)                  |
| `c566678d`            | `6bf7a96d`              | QA 라운드 2 기록                       |
| `62a6907a`            | `3f83a12c`              | 배포 직후 확인의 블라인드 절차         |
| `8a34261d`            | `b578dc63`              | 배포 직후 확인 실패 처리               |
| 없음                  | `01f1a19b`              | bump 9.0.25 / v798(마지막 런타임 커밋) |

**테스트 먼저 다시 돌리기.** 옮긴 테스트 먼저 커밋마다 그 커밋에서(새 시험을 옮긴 부모 코드에서) 처음 바탕과 같은 시험 파일을 돌렸다.
실패 행의 이름은 모두 처음 바탕과 같고, 늘어난 행은 그 사이 main이 더한 시험이다.

| 테스트 먼저(부모)                | 돌린 것                                                         | 결과                                                                                            |
| -------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| R3-1 `94d7bd10`(main `d630269a`) | 단위 전체 706 files                                             | 18 실패 / 16,779(domain 6, api 11, runtime-playlist-slots 1). 처음 바탕은 18 / 16,685           |
| ZS-05 `d07df702`(`64a4ebc9`)     | runtime-server-playback, pro-manual-zero-start                  | 1 / 196(699 ms 앞섬의 새 행)                                                                    |
| ZS-06 `2f233013`(`f3ef7f9b`)     | playback-snapshot-share-ownership                               | 2 / 19(복원과 재조정의 zero-start 행)                                                           |
| R3-3 `5bc163ee`(`6ea2db9b`)      | 처음과 같은 10 files                                            | 6 / 955(처음 954. 더한 1은 R2 받아들이기의 예약 제어 PREPARE·마감 COMMIT 교차 계약 행이고 통과) |
| R3-4 `d112ba5d`(`147dbb06`)      | `api.test.ts`                                                   | 4 / 147                                                                                         |
| R3-5 `0bdbf1d3`(`c2e45d0f`)      | guest-connection-type, guest-join, protocol-validation-coverage | 5 / 70                                                                                          |
| R3-6 `afa2aaff`(`dd107a8c`)      | cloudflare-signaling, developer-command, pro-epoch-close-name   | 9 / 307(세 프레임 × 소켓 셋)                                                                    |

**R3-1의 critical E2E(계획 §3.9).** `npm run build:e2e` 뒤 `test:e2e:critical`과 같은 여덟 파일을 돌리고 실행마다 HEAD를 적었다.
테스트 먼저 `94d7bd10`(새 고정값과 bootstrap 모의를 부모 코드에서) 100 / 100(5.1분), 마지막 코드 커밋 `64a4ebc9` 100 / 100(5.1분).
고정값 변경이 필요한지 보는 실행: `64a4ebc9`의 e2e 빌드에 main의 `e2e/helpers/pro-room-fixture.ts`와 bootstrap 모의 네 파일을 두고
critical-browser, pro-upload-recovery, pro-activation-account, dialog-locale-layout을 돌리면 21 실패, 15 통과다(critical-browser의
PRO 행 다섯, pro-upload-recovery 4 / 4, pro-activation-account 12 / 12. dialog-locale-layout 9 / 9는 그 activation_required 모의를
요청하지 않아 통과). 돌린 뒤 파일은 되돌렸다. 이 PC의 첫 시도(옮기기 중간의 SHA, 버리고 다시 돌림)는 Chromium 작업자가
`0xC0000142`로 죽어 9 실패 / 67 미실행이었고, 다시 돌린 위 실행에서는 같은 일이 없었다.

**R3-4의 주간 e2e.** `e2e/pro-entry-password.test.ts`(공유 route 모의가 모든 `/api/pro-room/` 요청에서 두 머리글이 없음을 봄): 테스트
먼저 `d112ba5d`의 e2e 빌드에서 10 / 10 실패(받은 값 `optional-v1`), 코드 커밋 `c2e45d0f`의 e2e 빌드에서 10 / 10 통과.

**운영 익명 답 읽기(새 근거, 2026-10-30 05:11 ~ 05:33 KST).** `app`의 배포 뒤 smoke는 HTTP뿐이라 9.0.25 파서로 PRO 답을 읽지 않는다.
인증 없이 받을 수 있는 PRO 답은 bootstrap뿐이라(스냅샷, 시스템 오디오, 설정, 큐 읽기는 presence가 있어야 해서 클라이언트가 요청
전에 `PRESENCE_IDENTITY_REQUIRED`로 멈춤) 그것을 읽었다.

- `curl`로 `GET https://musixquare.com/api/pro-room/v1/rooms/000000/bootstrap`과 `.../000001/bootstrap`(머리글
  `X-MXQR-App-Build: 797`): 둘 다 200, `Cache-Control: no-store`, 본문 `{"roomCode":"000000","status":"activation_required","passwordRequired":true}`와
  `{"roomCode":"000001","status":"pin_required","passwordRequired":true}`.
- bump 트리 `01f1a19b`의 `src`를 `git archive`로 풀어 그 `ProRoomApiClient.getBootstrap`(곧 R3의 `parseBootstrap`, 정확한 키 셋과
  상태별 `passwordRequired` 규칙)에 (가) 저장한 두 본문을 모의 fetch로, (나) 같은 클라이언트가 스스로 보낸 운영 GET 두 번(App 빌드
  머리글 797, 인증 없음)의 답을 넣었다. 넷 모두 그대로 읽혔다(`INVALID_RESPONSE` 없음). 스크립트는 공개하지 않는 작업 공간에 있다.
- 같은 때 공개 상태: `GET /api/app-build-floor`는 저장·유효 795, revision 3, live App 797, `state` valid. `/service-worker.js`는
  `CACHE_VERSION = "v797"`.

**R2 Worker의 실제 출력을 이 파서로 읽는 행.** bump 트리에서 `cloudflare/pro-room-worker.ts`는 R2 머지 `0e5a9b87`과 같다(diff 없음).
in-process 교차 계약과 workerd 행 7 files / 910 통과: `pro-room-worker.test.ts` 576(그 안의 'PRO browser parsers on the actual Worker
answers' 5행: 스냅샷, 관리자 PUT·DELETE 답, LAN-direct null, 종류 실은 PREPARE·COMMIT, 예약 제어 PREPARE와 마감 COMMIT), `pro-room-burst`
7, `pro-room-signaling-contract-workerd` 3(실제 workerd 신호 중계에서 `timingMode` 'zero-start'가 남음), `standard-room-burst` 7,
`owner-transfer-entry-password-sqlite` 3, `app-worker-cors` 282, `pro-room-signaling-delivery` 32.

**bump 뒤 전체 검사(`01f1a19b`, 05:51 ~ 06:15 KST).** 모든 단계가 종료 코드 0이다.

- `npm run security:audit`: 0 vulnerabilities.
- 단위 전체 706 files / 16,748 통과(skip 0, 이 PC에는 jq가 있어 jq 행도 돎).
- Worker 설정 커버리지 69 files / 3,322 통과, 전체 86.7 / 83.54 / 94.34 / 90.97, `cloudflare/app-worker.ts` 82.31 / 77.66 / 89.62 /
  87.46.
- `npm run typecheck`(모든 프로젝트와 `types:workers:check`), `check:workers`(declaration-ownership 10, D1 3 databases / 19 migrations,
  ops-drift 소스 계약), `check:worker-bundles`(여섯 Worker를 배포 없이 묶음), lint, `format:check`.
- 가드(하나씩): dead-exports 401 files, 2,108 bindings, 완전히 죽은 것 0, 시험 전용 20 / 20, 자기 전용 76 / 76. import-graph 401 files,
  2,082 edges, 순환 0. bus-pairing 202 / 202. lifecycle-writes, navigation-sinks(401 files), transport-health, chunk-pump,
  standard-room-hot-path, room-authority-boundaries 79 / 22 / 13 / 0 / 0, source-complexity(`src/pro-room/runtime.ts` 4,154 / 10,000,
  `cloudflare/pro-room-worker.ts` 18,378 / 20,000, `cloudflare/app-worker.ts` 16,907 / 20,000), brand capitalization 1,001 sources,
  declaration-ownership, developer-api-boundaries, d1-migrations, ops-drift-contract, playwright-api, font-assets, index-hreflang,
  sitemap, profanity-patterns, TS project coverage 1,508 files / 19 projects, authored JS·inline JS, classic-runtime,
  auxiliary-browser, service-worker, ui-kit, `guard:release-identity` 'MUSIXQUARE 9.0.25; service-worker cache epoch v798',
  `guard:sw-cache-version` 'PASS: v798 (01f1a19b) covers all committed PWA runtime changes', `node scripts/check-resource-ownership.mts`
  49 records / 448 files. 정확한 개수 가드는 모두 기준치와 같아 내린 기준치가 없다.
- 핵심 커버리지 90 files / 3,521 통과(80.92 / 75.66 / 86.92 / 84.79), release-tooling 커버리지 14 files / 433 통과(79.55 / 75.24 /
  86.38 / 81.48).
- `npm run build:checked` 한 사슬 통과: 진입 842.1 KiB raw / 247.9 KiB gzip, eager JS 455.3 KiB gzip, eager total 2,010.9 KiB raw /
  532.8 KiB gzip(5% 여유 유지), SW 앱 셸 94 자산, service worker 빌드 v798 byte-exact, 레거시 TV(Chromium 79), prod-hooks,
  prod-security, 글꼴 2,009.5 KiB.
- Playwright(Chromium): `test:e2e:candidate`(그 `build:checked` 산출물) 19 / 19, `build:e2e` 뒤 `test:e2e:critical` 100 / 100(5.0분),
  PRO 레인 39 / 39(pro-activation-account 12, pro-entry-app-update 2, pro-entry-password 10, pro-entry-retry 2,
  pro-upload-recovery 4, dialog-locale-layout 9). 끝에 운영 빌드를 다시 만들었다.
- release target(`scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`):
  main `d630269a`..`01f1a19b`는 App 18, 나머지 다섯 0, 의존성 차이 없음. 운영 SHA(App `78ec56f5`, PRO room `0e5a9b87`, 나머지 넷
  `71f5b96c`)..`01f1a19b`도 App 18, PRO 방 0, 나머지 0이다. live PRO의 런타임 경로가 HEAD와 같고 target은 `app`뿐이다.
- 옮긴 뒤 문서 커밋은 이 라운드를 적는다. 그 커밋의 트리에서 문서를 읽는 검사를 다시 돌렸다: 단위 전체 706 files / 16,748,
  brand capitalization 1,001 sources, `guard:sw-cache-version` PASS v798(bump가 그대로 마지막 런타임 커밋), 그리고 release-record,
  README, hotfix-procedure와 이 보고서에서 이 보고서로 가는 링크 14개의 앵커가 모두 있음.

**옮김과 bump의 리뷰 반영(2026-10-30 06:30 ~ 07:00 KST).** `2262aed8`을 본 리뷰 둘(승인 1, 변경 요청 1. 열차 끝 리뷰가 아님)의
지적을 bump 뒤에 반영했다. 런타임 파일은 바꾸지 않아 bump `01f1a19b`가 그대로 마지막 런타임 커밋이고 다시 만들지 않았다.

- 중간 1: 기록 커밋의 겹친 줄(위 '계획과 달라진 것' 10). `ea227a15`가 지웠고, 바뀐 문서 일곱의 연속 중복 줄 검사에서 다른 것은 없다.
- 낮음, 반영: 교차 계약 행 하나(`5c0c6b6d`, 시험만). `ProRoomApiClient`가 in-process Worker의 bootstrap을 activation_required,
  open, pin_required, suspended에서 읽어 와이어와 정확히 같고, PIN 세션, presence 입장(takeover), 계정 분리 답도 와이어와 같다.
  Worker의 suspended bootstrap에서 `passwordRequired`를 빼면 이 행이 `PRO_ROOM_API_INVALID_RESPONSE`로 실패함을 보고 되돌렸다.
  기록: 수리 갈래를 9.0.25가 live인지가 아니라 이 변경이 main에 있는지로(release-record §2·§3·§4 (6)·(9)·schemaVersion 2 PRO Worker
  항목, hotfix-procedure 두 문장, 이 보고서 R3-7과 '되돌리기' 3), schemaVersion 2 PRO Worker의 §2 되돌리기 줄 끝 가리킴, 기록 PR
  목록에 §4 현재 경계 줄 (5), 배포 뒤 공개 최소 빌드 상태와 Drift Audit(배포 조건 7, §2 조건 (6), 라운드 5 자리), 이 배포부터 PRO
  정리 배포까지의 런타임 의존성 머지 금지(순서, 배포 조건 3, §2 조건 (3)), ZS-06의 알려진 가장자리(R3-2), 남은 v1 시대 받기
  ('이 릴리스가 기대는 것').
- 낮음, 반영하지 않음: 바닥 도구와 PRO smoke의 entry-policy 머리글은 Q10의 결정이라 남기고, `parsePlaylistSlots`의 'Opt-in summary'
  주석은 런타임 파일이라 뒤의 PRO 정리로 미뤘다(R3-4 '남긴 것'). ZS-06 경쟁은 기록만 했다.
- 다시 돌린 것(Node 24.22.2, vitest `--maxWorkers=6`): `5c0c6b6d`에서 단위 전체 706 files / 16,749 통과(새 행 하나), Worker 설정
  커버리지 69 files / 3,323 통과(전체 86.7 / 83.54 / 94.34 / 90.97, 문턱 유지), 교차 계약과 workerd 행 7 files / 911 통과,
  `npm run typecheck` 전체, lint, `format:check`, dead-exports(401 files, 2,108 bindings, 0 / 20 / 76), import-graph(401 files, 2,082
  edges, 순환 0), bus-pairing 202 / 202, `node scripts/check-resource-ownership.mts` 49 records / 448 files, `guard:sw-cache-version`
  PASS v798(`01f1a19b`), `guard:release-identity` 9.0.25 / v798. 문서를 고친 트리에서 brand capitalization 1,001 sources, 문서를 읽는
  `tooling-contracts.test.ts` 5 통과, `git diff --check`, 이 보고서·hotfix-procedure·release-record로 가는 링크 앵커 검사(빠진 것 0).
  `01f1a19b` 뒤 바뀐 것은 문서와 시험 파일 하나뿐이라 `build:checked`와 Playwright는 다시 돌리지 않았다(라운드 3의 bump 트리 결과가
  그대로).

### 4. 운영 전제: dispatch 직전 읽기 (2026-10-30)

운영 공개 상태와 배포 기록(머지, exact-main CI, dispatch를 차례로 적은 릴리스 담당의 기록, 시각은 그 PC 시계)의 기록이다. 시각은
KST다(로그의 UTC를 바꿈). 이 릴리스는 받는 쪽만 좁혀 바닥 실행(`set`, `lower`)이 없었다.

- dispatch 직전 공개 상태: 배포 기록의 07:16:18 KST 줄이 exact-main CI success(07:16:16 KST 줄) 바로 뒤에 읽은 공개 상태를 적는다.
  공개 상태(07:16:20 KST 생성, 서버 시계)는 `minAppBuild` 795, `effectiveMinAppBuild` 795, revision 3(updated
  2026-10-29T15:12:41.759Z, F2의 `set`), `liveAppBuild` 797, `reportedLiveAppBuild` 797(07:15:47 KST 보고, 약 33초 전으로 300초
  안), state `valid`였다. workflow `status` 실행이 아니라 공개 상태 읽기다. revision이 F2의 3 그대로라 F2 뒤 저장 바닥을 바꾼
  실행은 없었다.
- dispatch 직전 live PRO Worker: 배포 메시지를 따로 읽은 근거는 없다. 릴리스의 부분 릴리스 판정(07:17:05 ~ 07:17:10 KST)과 App
  배포 직전 다시 확인(07:17:48 KST)이 compatible이었다. App 대상 판정은 고르지 않은 PRO가 HEAD와 같은 런타임 경로인지와
  'Rollback:' 메시지의 손 되돌리기 버전인지를 본다(배포 조건 2). App 배포 뒤 PRO 공개 경계 smoke(07:18:08 KST)가 `ef882f7c`를
  읽었고, 그 버전은 R2가 `git:0e5a9b87…`로 배포한 PRO 버전이다(release-record의 R2 기록 값).
- 런타임 의존성(배포 조건 3): R2 배포(2026-10-30 00:30 KST)부터 이 배포까지 머지된 것은 #529(문서), #530(9.0.24), #531(문서),
  #532(이 릴리스)다. `git diff 0e5a9b87 b8ae59e7 -- package.json package-lock.json`은 버전 줄 셋(`package.json` 하나,
  `package-lock.json` 둘)뿐이다.
- 그 PRO Worker의 손 되돌리기와 비상 길: 없었다(9.0.24의 기록과 이 릴리스의 Worker 기록이 R2의 `ef882f7c`를 그대로 적음).

결론: 배포 조건 1 ~ 5가 채워졌다(위 '배포 조건과 순서'의 결과).

### 5. PR CI, 자동 코드 리뷰, exact-main CI, 배포, 공개 확인과 배포 직후 확인 (2026-10-30)

검증 대상은 PR head `30e66813`과 그 squash 머지 `b8ae59e7`(부모 `d630269a`, 트리는 `30e66813`과 같음, 런타임은 bump
`01f1a19b`까지와 같음)이다. 환경은 GitHub Actions(Node 24.22.2), 운영 Cloudflare, 운영 브라우저다. 시각은 KST다(로그의 UTC를
바꿈).

- PR #532: 06:57:46 KST에 열었고 head는 `30e66813`이다(배포 기록의 06:57:50 KST 줄부터 머지까지 같음). PR CI
  [40962090260](https://github.com/hiefny/MUSIXQUARE/actions/runs/40962090260)은 `30e66813`에서 11 jobs 모두 success였다(06:57:49
  KST 생성, job 06:57:52 ~ 07:07:03 KST, 배포 기록이 07:07:01 KST에 success를 다시 읽음). 이 보고서가 받은 근거는 job별 결론과
  시각뿐이라 시험 수는 적지 않는다.
- 자동 코드 리뷰: 요약 댓글(06:57:55 KST 생성, 06:59:20 KST에 마지막으로 바뀜)이 PR을 열 때('PR opened') `30e6681` 코드 리뷰가
  06:59:19 KST에 completed, `has_any_findings`와 `has_unresolved_findings` false라고 적는다. 보안 리뷰는 돌지 않았다. 최종 head의
  결과이고, 배포 기록이 머지 직전(07:07:02 KST)에 그 상태를 다시 읽었다.
- 머지: 07:07:07 KST에 squash `b8ae59e7`(부모 `d630269a`). 스쿼시 메시지는 PR 설명이다. `git diff 30e66813 b8ae59e7`은 비어 있다.
- exact-main CI [40963348382](https://github.com/hiefny/MUSIXQUARE/actions/runs/40963348382): push, attempt 1, 11 jobs
  success(07:07:10 KST 생성, job 07:07:12 ~ 07:16:12 KST, 배포 기록이 07:16:16 KST에 success를 읽음), Node를 쓰는 10개 job 모두
  Node 24.22.2(`Static checks`는 Node를 쓰지 않음). 의존성 감사 0, registry 서명 483·attestation 108, 단위 (1/2) 353 files /
  7,723과 (2/2) 353 files / 9,025 + 기존 1 skip(`pro-grant-campaign-cli.test.ts`. Broad unit coverage ratchet 706 files / 16,748 +
  1 skip으로 합계 16,749는 리뷰 반영 뒤 로컬 단위와 같음, 전체 88.56 / 83.2 / 92.62 / 91.89), Worker 커버리지 69 files /
  3,323(전체 86.7 / 83.54 / 94.34 / 90.97), 핵심 커버리지 90 files / 3,521(80.92 / 75.66 / 86.92 / 84.79), 릴리스 도구 14 files /
  433, resource-ownership 49 records / 448 files, room-authority 79 / 22 / 13 / 0 / 0(401 files), dead-exports 0 / 20 / 76(401
  files, 2,108 bindings), bus-pairing 202 / 202, import-graph 401 files / 2,082 edges / 순환 0, navigation-sinks requester 20,
  source-complexity `cloudflare/pro-room-worker.ts` 18,378 / 20,000, Critical browser gate(Linux Chromium) 후보
  19(50.4초)·critical 100(4.9분), `guard:release-identity` 'MUSIXQUARE 9.0.25; service-worker cache epoch v798',
  `guard:sw-cache-version` 'PASS: v798 (b8ae59e7) covers all committed PWA runtime changes.', brand capitalization 1,001 sources,
  `guard:legacy-tv-build`(`main-CJ99md0i.js`, `main-Brw3e3yh.css`), 진입 842.1 KiB raw / 247.9 KiB gzip, eager JS 455.3 KiB gzip,
  eager total 2,010.9 KiB raw / 532.8 KiB gzip, SW 앱 셸 94 자산, 릴리스 manifest 807 files. 후보는 [artifact
  12936349761](https://github.com/hiefny/MUSIXQUARE/actions/runs/40963348382/artifacts/12936349761)(digest sha256
  `dc3c14dd734929931681688e96334d849bbe1b6dd0f73d20982e3575c9237e57`, 26,104,511 B)다.
- Release [40964572017](https://github.com/hiefny/MUSIXQUARE/actions/runs/40964572017): target `app`, Developer API D1 false,
  `raise_app_build_floor` false, attempt 1, success. 07:16:22 KST 생성, 검증 job 07:16:25 ~ 07:16:32, deploy job 07:16:35 ~
  07:18:21 KST, 독립 recovery job(Preserve failed-release recovery boundary) skipped. 'Verify release commit is still current
  main'(07:16:44 KST), 계약 cutover 검사 다섯, `.node-version`의 Node 24.22.2, 후보의 digest(07:16:56 KST)와 릴리스 파일 807개
  확인, 운영 보안 설정 가드, 여섯 Worker 번들 dry-run(Wrangler 4.148.0), 자격 증명과 비밀 목록 확인이 통과했다. 부분 릴리스
  판정(07:17:05 ~ 07:17:10 KST)은 compatible이다. 'Check the App build floor the PRO Worker requires'는 target `app`이라
  skip이다(요구 값도 비어 있음). checkpoint [artifact
  12938145012](https://github.com/hiefny/MUSIXQUARE/actions/runs/40964572017/artifacts/12938145012)(07:17:10 ~ 07:17:14 KST, 6
  files)이 dispatch 때의 App(9.0.24 / v797 `dd820d37`)과 Worker 호환 floor를 담았다. PRO generation readiness의 읽기·막기·복원은
  skip이다. App 대상의 D1 계약 단계 일곱(translation community, Soro article visibility, PRO retirement cursor, lifetime
  room-count, cumulative analytics, generic PRO grant, owner-transfer intent admission)은 success이고 나머지는 skip이다.
- 배포와 smoke(모두 첫 시도, 재시도 없음): App 배포 직전 다시 확인 compatible(07:17:48)과 운영이 checkpoint와 같음(07:17:49), App
  `dd820d37` → `b4e8fc56`(07:17:50 ~ 07:18:01, `dist` 867 files 가운데 새 자산 74개를 올림(731개는 이미 있음), 986.54 / gzip
  201.53 KiB, startup 4 ms), App generation(07:18:01 ~ 07:18:07, `main-CJ99md0i.js` 862,271 B, 22 assets, 세 번 연속 읽기), 익명
  계정 경계(07:18:07 ~ 07:18:08, 페이지의 최소 빌드 읽기 strict 795), App 배포 뒤 PRO 공개 경계(07:18:08 ~ 07:18:10, 12번 가운데
  첫 시도, `ef882f7c`, `000000` activation_required, `000001` pin_required와 `passwordRequired` true, 익명 스냅샷 거절), Standard
  HTTPS signaling(07:18:10 ~ 07:18:14, 빌드 798 방장·게스트 입장, offer·answer 중계, `bridgeOpenMs` 방장 876 ms·게스트 536 ms).
  target `app`이라 다른 다섯 Worker의 기록·배포·smoke는 돌지 않았다. 시각은 모두 KST다. 이 smoke는 HTTP만 보고 9.0.25 파서로 PRO
  답을 읽지 않는다(위 '되돌리기').
- 마무리: 최종 소유권 07:18:16 KST verified, 커밋 표지 artifact 12937166612(07:18:17 KST). 바닥 올리기 단계와 실패 자동 복구
  단계는 모두 skip이다. [배포 원본](https://github.com/hiefny/MUSIXQUARE/actions/runs/40964572017/artifacts/12938295266)(32
  files). 릴리스 담당의 기록에 이 SHA의 Production Release는 이 실행 하나다.
- 공개 확인(릴리스 담당, 07:18:58 KST): `/api/app-build-floor`는 저장·유효 795, live 798, 보고 798, state `valid`다.
  `/service-worker.js`는 `CACHE_VERSION = "v798"`이다(근거로 저장한 사본 38,124 B). 머리글 `X-MXQR-App-Build: 798`로 읽은
  `GET /api/pro-room/v1/rooms/000000/bootstrap`은 `{"roomCode":"000000","status":"activation_required","passwordRequired":true}`,
  `.../000001/bootstrap`은 `{"roomCode":"000001","status":"pin_required","passwordRequired":true}`로 QA 라운드 3과 같다. 근거로
  저장한 공개 상태(07:23:26 KST 생성)는 `minAppBuild` 795, `effectiveMinAppBuild` 795, revision 3, `liveAppBuild` 798,
  `reportedLiveAppBuild` 798(07:22:47 KST 보고, 39초 전), state `valid`다.
- Drift Audit [40964945920](https://github.com/hiefny/MUSIXQUARE/actions/runs/40964945920)(`b8ae59e7`, 07:19:14 KST 생성, job
  07:19:20 ~ 07:19:52, 07:19:53 KST 완료): automated-checks-passed, 32 pass / 0 fail / 5 manual-only(artifact 12937866800). App
  build floor 행은 'Stored floor 795 (enforced 795) is within the live App build 798 reported 0 s ago.'이고, 여섯 Worker의 비밀
  이름(PRO room 9개)·바인딩·subdomain·custom domain 행과 R2 CORS 셋(PRO media 포함)·lifecycle 둘 행이 PASS다.
- 배포 직후 확인 D2(릴리스 담당, 약 07:20 KST): 내장 Chromium 창(언어 ko, 로그인 없음)에서 `https://musixquare.com/000000`을
  열었다. 페이지가 service worker 아래에서 `bootstrap.js?cache=v798`과 `main-CJ99md0i.js`를 불러왔고, '시작하기' 뒤 '아직 준비
  중인 PRO 방이에요 / 방 소유자가 먼저 활성화해야 해요.' 창이 토스트 없이 떴다. '확인'으로 닫았고 방을 만들거나 들어가지 않았다.
  판정: 통과(9.0.25가 activation_required bootstrap 갈래를 읽음).
- 배포 직후 확인 A ~ C(오너가 가진 PRO 방, 07:28 ~ 07:49 KST, 방 코드는 적지 않음):
  - 누가, 무엇으로: 릴리스 담당이 오너의 Windows Microsoft Edge 156(오너가 방 주인 계정으로 로그인해 둠)을 브라우저 자동화로
    몰았고, C의 청취 기기는 오너의 휴대폰(iOS Safari, 로그아웃)이었다. 판정 기준은 실행 전에 이 보고서에 고정돼 있었고, 실행과
    판정은 릴리스 담당이 했다. A와 B는 블라인드가 아니다(관찰값은 앱 자신의 기록인 `/debug sync`와 `/debug console`의 줄).
  - 절차와 다른 점: 주인 기기가 Chrome이 아니라 Edge였다. 탭을 새로 여는 대신, 9.0.24를 들고 있던 Edge 탭이 먼저 업데이트 창을
    보였고 '적용하기'로 다시 불러 9.0.25가 됐다. 청취 폰은 C에만 들어왔다.
  - 유효: Edge의 `/debug sync` 셋째 줄이 `Client build: app=9.0.25 | cacheEpoch=v798`로 시작했다. 청취 폰의 빌드 줄은 근거에 없다.
  - A 들어가기(07:29 KST): 재생목록과 참가자 목록이 있는 방 화면, PIN을 묻지 않음(방 주인 계정), 오류 창이나 토스트 없음. 판정:
    통과. pin_required와 suspended bootstrap의 브라우저 갈래는 이 방에서 지나지 않았고, activation_required는 D2가 봤다. 첫
    들어가기 4초 뒤 콘솔 경고 하나 `[PRO] Account identity attach deferred Error: PRO_SIGNALING_START_FAILED`가 있었다(PRO 실시간
    소켓이 한 번 열리지 않아 앱이 설계대로 계정 신원 붙이기를 다음 하트비트로 미룸). 화면에 보인 글이 아니어서 기준의 '들어가는
    동안 오류 글이나 코드'에 들지 않는다. 07:35:57 KST의 깨끗한 다시 들어가기에서 20초 넘게 지켜봐도 다시 나오지 않았다. 그 소켓
    코드(`src/pro-room/network-bridge.ts`)와 신호 Worker는 9.0.25가 바꾸지 않았으므로 업데이트 다시 부르기 뒤의 일회성으로 적는다.
  - 덧붙임: 첫 디버그 명령을 치는 동안 키 입력이 페이지에 닿아 스페이스 키(재생·일시정지 단축키)가 방의 재생을 한 번
    재개했다(revision 571, 81.342초의 scheduled-control). 확인하는 동안 생긴 조작이고 9.0.25의 결함이 아니다.
  - B YouTube 시작 두 번(07:30:57 KST 재생목록 항목 누르기, 07:31:43 KST 다음 트랙): revision 572는 `playback-clock` prepare
    `selected`이고 `youtube-release` `timingMode` zero-start, 대상 0초, `rawReleaseLatenessMs` 1.2, `callToPlayingAckMs` 273이다.
    revision 573은 prepare `selected`, zero-start, 대상 0초, `rawReleaseLatenessMs` 0.07, 배운 앞섬 14.9 ms 적용,
    `callToPlayingAckMs` 287이다. 하트비트 스냅샷이 15초마다 적용됐고(`playback-clock` restore 행) `/debug console`에
    `INVALID_RESPONSE`, '[PRO] Presence heartbeat failed', 하트비트·lease 경고가 없었다. 판정: 통과(두 시작 모두 기준의
    zero-start). 후보 1의 돌아온 기기는 넣지 않았다.
  - C 공유 동안의 하트비트(W = 3): 오너가 Edge에서 시스템 오디오 공유를 시작했고 폰이 들었다. 공유 다섯 번(07:37:58, 07:41:26,
    07:44:14, 07:46:56 KST의 세대 3, 7, 9, 11과 07:48:41 KST의 관찰 실행)이 모두 SFU로 게시됐고('[ProSysAudioSFU] Published
    generation N'), 폰도 SFU로 받았다('[ProSysAudioSFU] Received stereo track', 'Subscribed to generation 11'). 오너가 3분 동안
    끊김 없이 들었고 공유하는 쪽에 하트비트·lease 경고가 없었다. 판정: 기준의 첫 단계에서 `[ProSysAudioSFU]` 줄이 있어 LAN-direct
    부분은 무효다. 다시 해도 SFU로 가서 R2 때처럼 'LAN-direct 미확인'으로 적는다. SFU 공유 동안의 하트비트에는 거절 신호가 없었다.
  - LAN-direct가 잡히지 않은 원인(Edge 탭의 WebRTC 관찰, 07:48:38 ~ 07:48:42 KST, IP는 적지 않음): LAN-direct 탐색 offer가 폰에
    닿아 answer가 0.75초에 돌아왔고, ICE가 checking 시작 0.09초 뒤 host-to-host로 연결됐다(집 Wi-Fi가 LAN-direct를 허용함). 그 뒤
    미디어 offer가 +1.0초에 나갔는데 answer가 시도의 2초 전체 마감 안에 오지 않아, 게시자가 함께 돌던 SFU 사전 준비로 갔다. 마감은
    `src/network/pro-system-audio-direct.ts`의 `DIRECT_NEGOTIATION_TIMEOUT_MS = 2_000`이고(2026-08-29 `d52b4a8d`가 5초에서 2초로
    줄임) 탐색과 미디어 왕복을 함께 덮는다. 9.0.25는 그 파일을 바꾸지 않았으므로 회귀가 아니다. release-record §2에 오너 결정
    항목으로 열었다(코드는 바꾸지 않음).
  - D1(관리자 권한 주고 거두기): 하지 않았다.
  - 실패하면: 방이 떴고 하트비트 거절 신호가 없어 해당하지 않는다. App을 되돌리지 않았다.
- 결론: 9.0.25가 운영의 schemaVersion 2 스냅샷(들어가기와 15초마다의 하트비트), 종류 실은 PREPARE·COMMIT의 두 시작,
  activation_required bootstrap을 읽었다. null LAN-direct `liveExpiresAt`, 관리자 답, pin_required·suspended bootstrap의 브라우저
  갈래, 하트비트가 COMMIT을 앞지른 기기는 운영에서 읽지 않았다.
- 건너뛴 것: 배포 직후 확인의 D1, 기기 확인 후보 1과 2, 실기기, WebKit 레인 전체, Full E2E, C5-0 랩, dispatch 직전 live PRO Worker
  배포 메시지의 따로 읽기.

## 배포 직후 확인과 기기 확인 (게이트 아님)

배포 조건 7의 배포 직후 확인(A, B, C와 선택 D)과 오너가 나중에 하는 기기 확인 후보 둘(후보 1은 백그라운드에서 막 돌아온 폰을 넣은
B, 후보 2는 10분 동안의 C)은 블라인드로 한다 ([5A 기기 절차](phase5-5a-receive-slot-2026-10-25.md#phase-5-기기-절차-오너가-나중에-쓸-것-p5-d2-a)와 같은 방식). 확인하는 사람에게는
'나눠 줄 절차'와 '받을 관찰값'만 그대로 건네고 기대값은 주지 않는다. 판정하는 쪽이 받은 값을 '판정 기준'과 견주며, 판정 기준은
건네지 않는다. 결과는 QA 라운드 5(배포 직후 확인)나 그 뒤에 더하는 QA 라운드(후보)에 적되, 방 코드와 식별자는 지우고 개수와 필요한
줄만 옮긴다.

### 나눠 줄 절차

방 코드는 따로 건넨다. 아래 `<PRO 방 코드>`를 그 코드로 바꿔 쓴다.

준비:

- 방은 오너가 가진 PRO 방이다. 고객 방은 쓰지 않고 운영 방을 새로 만들지 않는다.
- 모든 기기를 같은 Wi-Fi에 두고 VPN을 끈다. 주인 기기는 방 주인 계정으로 로그인한 데스크톱 Chrome이고, 청취자 기기는 로그아웃한 다른
  기기(폰이나 다른 브라우저)다. 기기는 모두 합쳐 넷 이하다.
- 기기마다 MUSIXQUARE 탭을 모두 닫고 새 탭에서 `https://musixquare.com/<PRO 방 코드>?mxqrLog=info`를 열어 방에 들어간다. PIN을 물으면
  넣는다. 업데이트 창이 뜨면 그 사실을 적고 '적용하기'를 누른 뒤, 그 탭을 닫고 같은 주소로 다시 연다.
- 디버그 글: 채팅에 `/debug sync`나 `/debug console`을 보내면 겹창이 뜨고 그 글이 클립보드에 한 번 복사된다. 메모에 기기 이름과 지금
  시각을 적고 그 글을 붙여 넣은 뒤 겹창 가장자리를 눌러 닫는다. 끝날 때까지 탭을 새로 고치거나 닫지 않는다.
- 메모는 확인을 맡긴 사람에게만 넘기고 공개된 곳에 올리지 않는다.

A. 들어가기(배포 직후 확인)

1. 기기마다 방에 들어간다.
2. 기기마다 `/debug sync` 글을 붙여 넣는다.

B. YouTube 시작 두 번(배포 직후 확인, 후보 1)

1. 재생목록의 YouTube 항목이 둘보다 적으면 주인 기기에서 더해 둘 이상으로 한다.
2. 주인 기기에서 재생 단추가 아니라 재생목록의 YouTube 항목을 눌러 재생을 시작하고 그 시각을 적는다.
3. 30초 넘게 지나 주인 기기에서 '다음 트랙'을 누르고 그 시각을 적는다. 다음 항목도 YouTube 항목이어야 한다.
4. 후보 1에서만: 2와 3 앞마다 청취자 폰 하나('돌아온 기기')를 홈 화면으로 1분 넘게 보냈다가 앱으로 돌아오게 하고, 돌아온 지 10초
   안에 주인 기기에서 누른다. 돌아온 시각을 적는다.
5. 3 뒤 15분 안에 기기마다 `/debug sync` 글을 붙여 넣는다.

C. 같은 Wi-Fi 공유 동안의 하트비트(배포 직후 확인은 W = 3, 후보 2는 W = 10)

1. B 뒤에 주인 기기에서 시스템 오디오 공유를 시작한다: '시스템 오디오 공유' → 소리가 나는 Chrome 탭 → '탭 오디오도 공유' 켬 → '공유'.
   그 시각을 적는다.
2. 청취자 기기마다 소리가 들리는지 보고, 끊기면 그 시각을 적는다. 어느 기기든 토스트가 뜨면 그 글과 시각을 적는다.
3. 공유를 시작하고 1분 뒤와 W분 뒤(후보 2는 5분 뒤에도) 기기마다 `/debug console` 글을 붙여 넣는다.
4. W분 뒤 주인 기기에서 공유를 멈춘다.

D. 선택(배포 직후 확인)

1. 주인 기기의 '연결'에서 청취자 기기 하나 옆의 왕관 단추(관리자 권한 부여)를 누르고, 그 기기에 관리자 표시가 생기는지 1분 동안 본다.
   생겼으면 그 관리자를 해제하고(확인 창의 '관리자 해제') 표시가 없어지는지 1분 동안 본다. 사이에 뜬 토스트를 그대로 적고 주인
   기기에서 `/debug console` 글을 붙여 넣는다.
2. 아무 기기의 새 탭에서 `https://musixquare.com/000000`을 연다. 들어가기를 요구하면 누르고, 뜬 창의 제목과 글을 그대로 적은 뒤 더
   진행하지 않고 탭을 닫는다.

### 받을 관찰값

1. 기기마다: 기기 종류와 브라우저, 업데이트 창이 떴는지, 방 화면(재생목록과 참가자 목록)이 떴는지, PIN을 물었는지, 들어가는 동안
   보인 글·오류 코드·토스트(그대로), A 2의 `/debug sync` 글.
2. B: 두 시작의 시각(후보 1은 돌아온 시각도)과 기기마다 B 5의 `/debug sync` 글.
3. C: 공유를 시작하고 멈춘 시각, 모든 기기가 같은 Wi-Fi였는지, 청취자 기기마다 소리가 끊긴 시각(없으면 '없음'), 뜬 토스트와 그
   시각, 기기마다 C 3의 `/debug console` 글.
4. D(했으면): 관리자 표시가 생기고 없어졌는지, 뜬 토스트, 주인 기기의 `/debug console` 글, `000000`에서 뜬 창의 제목과 글.

### 판정 기준 (나눠 주지 않음)

- 유효: 기기의 `/debug sync` 셋째 줄이 `Client build: app=9.0.25 | cacheEpoch=v798`로 시작한다. 아니면 그 기기의 결과는 무효이고 새
  탭에서 다시 한다.
- 들어가기: 모든 기기에 방 화면이 뜨고, 들어가는 동안 오류 글이나 코드가 없다. PIN을 물었으면 pin_required bootstrap을 지난 것이다.
  묻지 않는 방(open)에서는 이 릴리스가 바꾼 bootstrap 갈래(activation_required, pin_required, suspended) 가운데 D 2의
  activation_required만 본다.
- 시작: 시작마다, 그 시작의 `revision`에 `purpose` "prepare"이고 `outcome` "selected"인 `playback-clock` 행이 있는 기기는 같은
  `revision`의 `youtube-release` 행 `timingMode`가 "zero-start"다. 그런 행이 없는 기기(그 PREPARE를 준비하지 못함)의 예약 제어는 늦은
  입장과 같은 정해진 동작(ZS-09)이라 적기만 한다. 행은 그 시작이 COMMIT 프레임으로 왔는지 하트비트 스냅샷(ZS-06)으로 왔는지 말하지
  않는다. 9.0.25는 두 길 모두 PREPARE의 종류로 시작하므로 이 기준은 ZS-06의 회귀를 잡지만, 돌아온 기기가 그 길을 탔는지는 확인하지
  못한다. `[PRO YouTube] Zero-start playback released`는 `log.debug` 줄이라 운영 로그 수준(WARN)이나 `?mxqrLog=info`의
  `/debug console`에 나오지 않으므로 쓰지 않는다.
- 하트비트: 먼저 공유가 끝까지 LAN-direct였는지 본다. 모든 기기가 같은 Wi-Fi였고 어느 `/debug console`에도 `[ProSysAudioSFU]`,
  'Promoted LAN-direct publication to SFU', 'LAN-direct to SFU promotion failed' 줄이 없어야 하며, 아니면 이 부분은 무효라 다시 한다.
  그러면 공유 시작부터 W분 동안 기기마다 '[PRO] Presence heartbeat failed', 'Heartbeat state was not applied', 'Lease heartbeat
  failed', 'LAN-direct authority heartbeat grace elapsed' 줄이 없고 청취자 소리가 끊기지 않았으면 통과다. 9.0.25가 하트비트 답을
  거절하면(스냅샷이나 live LAN-direct의 숫자 `liveExpiresAt` 때문에 `INVALID_RESPONSE`) 답 전체가 버려지므로, 청취자에게는 '[PRO]
  Presence heartbeat failed'가 하트비트(약 15초)마다 나오고 'Heartbeat state was not applied'는 나오지 않는다. 공유자에게는 'Lease
  heartbeat failed'도 나오고, 약 60초 뒤 'LAN-direct authority heartbeat grace elapsed' 줄과 함께 공유가 멈춘다. 그 줄들이 하트비트마다
  이어지거나 어느 줄이든 `INVALID_RESPONSE`를 말하면 하트비트가 거절된 것이다. 이어지지 않는 한두 줄만 있으면 한 번 다시 한다. 읽은 글의 첫 줄 시각이 공유 시작보다 늦으면 그 앞은 300줄 고리 밖이므로
  그 기기의 개수는 그 시각부터의 개수로 적는다.
- D: 관리자 표시가 생기고 없어졌으며, '네트워크 오류가 발생했어요' 토스트와 '[Connect] Could not grant administrator', '[Connect]
  Could not revoke administrator' 줄이 없다(답을 거절해도 서버의 변경은 다음 하트비트 스냅샷으로 보일 수 있어 표시만으로는 판정하지
  않는다). `000000`에서는 '아직 준비 중인 PRO 방이에요' 창이 뜬다.

### 실패하면 (배포 직후 확인)

이 소절도 건네지 않는다. 배포 직후 확인에서 방이 뜨지 않거나 하트비트가 거절되면(위 판정 기준. D를 했다면 관리자 답이나 활성화 전
bootstrap의 거절도 같다) 9.0.25가 실제 schemaVersion 2 답을 거절하는 결함이다. 그 결함은 커밋 표지를 지났고 실패 자동 복구는 돌지
않았으므로(위 '되돌리기') 손으로 한다:

1. App을 9.0.25 릴리스 recovery checkpoint의 App(dispatch 때 live였던 App, 9.0.22 이상)으로 되돌린다. hotfix-procedure의
   [Rollback](../hotfix-procedure.md#rollback) CLI 되돌리기다(`versions deploy <그 버전 ID>@100%`,
   `--config cloudflare/wrangler.app.toml`, message `Rollback: <이유>`). 저장 바닥이 795인 동안 `lower`는 필요 없다.
2. PRO Worker는 그대로 둔다. 그 App은 schemaVersion 2를 읽고, release-record §4 현재 경계 줄 (8)대로 PRO를 schemaVersion 2를 처음
   보내는 PRO Worker 아래로 되돌리지 않는다.
3. release-record §1과 `Last source review`를 덮어쓰고 `release-history.md`에 한 행을 더한다.
4. 앞으로 고친다. 되돌린 App 버전은 `Rollback:` 메시지라 git 출처가 없으므로 다음 수리 릴리스는 `all`이고
   ([hotfix-procedure의 출처 문단](../hotfix-procedure.md#normal-hotfix)), 그 사이 다른 Worker의 부분 릴리스는 부분 게이트가 출처
   없는 App에서 막는다.

열린 9.0.25 탭은 새로 고칠 때까지 PRO 방에서 깨진 채 남는다. 시작 기준만 어긋나면 소리는 멈추지 않으므로 손으로 되돌리지 않고, QA
라운드 5에 적은 뒤 기본 되돌리기(더 높은 SemVer의 코드 되돌리기)나 앞으로 고치기로 다룬다.

### 결과 (2026-10-30)

이 소절은 확인 뒤에 더했다. 판정 기준과 '실패하면'은 바꾸지 않았다. D2는 릴리스 담당이 약 07:20 KST에, A ~ C는 2026-10-30 07:28 ~
07:49 KST에 오너가 가진 PRO 방에서 했다. 주인 기기는 Chrome 대신 오너의 Windows Microsoft Edge 156이었고 릴리스 담당이 브라우저
자동화로 몰았으며(A와 B는 블라인드가 아님, 관찰값은 앱 자신의 기록), 청취 기기는 오너의 iOS Safari 폰이었다. 유효, A, B, D2는
통과다. C는 공유 다섯 번이 모두 SFU로 가서 LAN-direct 부분이 무효이고 'LAN-direct 미확인'이다(원인은 2초 LAN-direct 마감,
release-record §2의 오너 결정 항목). D1과 후보 1, 2는 하지 않았다. 실패가 없어 App을 되돌리지 않았다. 관찰값과 판정은 QA 라운드
5에 있다.

## 확인하지 않은 것

- 운영: null LAN-direct `liveExpiresAt` 읽기와 live LAN-direct의 숫자 거절(배포 직후 확인의 공유 다섯 번이 SFU 경로라 'LAN-direct
  미확인', 원인은 2초 LAN-direct 마감, QA 라운드 5), 관리자 권한 주고 거두기의 운영 답(D1을 하지 않음), pin_required와 suspended
  bootstrap의 브라우저 갈래(운영 bootstrap 두 답은 QA 라운드 3에서 이 App의 파서로 읽었고, 브라우저로는 D2의 activation_required만
  봄), 하트비트가 COMMIT을 앞지른 기기의 시작 종류(ZS-06, 후보 1). 배포 직후 확인은 데스크톱 Edge 한 대(9.0.25)와 SFU로 듣는 폰
  하나만 봤고, A와 B는 블라인드가 아니다. dispatch 직전 live PRO Worker의 배포 메시지는 따로 읽지 않았다(QA 라운드 4).
- 오너 기기 확인 후보 둘(후보 1: 백그라운드에서 막 돌아온 폰을 넣은 B, 후보 2: 10분 동안의 C). 후보 2는 2초 LAN-direct 마감이
  정해지기 전에는 같은 Wi-Fi에서도 SFU로 가기 쉽다.
- 옮김과 bump 리뷰의 낮은 지적 가운데 ZS-06의 같은 대상 직접 명령 경쟁(위 R3-2의 알려진 가장자리)은 고치지 않았고, 바닥 도구와 PRO
  smoke의 entry-policy 머리글은 Q10대로 남겼다.
- 실기기와 iOS Safari의 PRO 방 들어가기, WebKit 레인 전체, Full E2E(로컬에서는 critical E2E와 PRO 묶음만 Chromium으로 돌림), C5-0
  랩.
- 전송 계층 PRO 신호 모드(티켓 role 'coordinator' 포함)의 정리. 2026-07-20 뒤 운영 호출이 없고 R3-6은 개발자 프레임만 지웠다.
