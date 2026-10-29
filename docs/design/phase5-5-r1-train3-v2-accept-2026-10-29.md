# Phase 5.5 R1: 구버전 제거 열차 3과 PRO 스냅샷 v2 받기 9.0.22 (2026-10-29)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 초안(2026-10-29). 구현과 증분별 검사(QA 라운드 1), 세 갈래 열차 끝 리뷰(모두 승인, 높음·중간 0), main 9.0.21 위로 옮기기, 리뷰 반영, 버전 올리기, 옮긴 부모에서 테스트 먼저 다시 돌리기와 전체 검사(QA 라운드 2 ~ 5)까지 끝났고 미병합·미배포다. 브랜치 `agent/p55-r1`은 main `3bfdffcb`(9.0.21, #522) 위의 커밋이다: 증분 21(테스트 먼저 10, 코드 10, LEAVE-1 하나), R1-11 문서 2, 9.0.22 이름 바로잡기 `513729f6`, 리뷰 반영 시험 `38c0dee2`와 문서 `b7d91b2c`, 버전 올리기 `336a5133`, 이 보고서와 릴리스 기록 커밋. 마지막 런타임 커밋은 버전 올리기 `336a5133`이고 그 뒤는 문서뿐이다. 릴리스 기록 §2의 '9.0.22 배포 전' 항목이 이 브랜치에 있다. 배포 전 운영 단계(P2 직후 운영 remote-share smoke 두 형태, F1 바닥 789, F1 직후 신호 입장 smoke), PR, PR CI, 자동 코드 리뷰, exact-main CI, 배포는 아직이다(QA 라운드 6, 7은 자리만)                                                                                                                                                                                            |
| Base               | main `3bfdffcb`(#522 squash, 9.0.21 / v794, target `app`, 이 문서를 쓸 때 배포 중). 그 앞의 main: P2 #519(`7241e89d`, 도구·문서만: remote-share smoke가 peer-open 표지 없이 실제 확인서로 방을 증명, PRO가 요구하는 앱 빌드의 릴리스 전 검사, 바닥 올리기 실패 문장), #520(시험만), #521(9.0.20 기록). 증분은 main `edd6ee94`(#518. 런타임은 9.0.20 `226219c5`, 그 위 P1 #517과 #518은 시험만) 위에서 만들었고(마지막 `c058a98a`), 2026-10-29 15:25 KST에 `3bfdffcb` 위로 옮겼다. 옮길 때 미디어 고르기 창 포커스 경쟁 한 쌍(`95051a6c` 테스트 먼저, `b612c051` 구현)은 뺐다(아래 '뺀 쌍'). 옮긴 증분 21커밋은 커밋마다 `git patch-id --stable`이 같다. R1-11 문서 두 커밋은 P2와 9.0.20 기록이 바꾼 앞뒤 줄 때문에 patch-id만 다르고 더한 줄은 같다(SHA 대응은 '옮긴 뒤 SHA' 표)                                                                                                                                                                                                                                                      |
| Version            | 9.0.22 / v795, 앱 빌드 795. 마지막 런타임 커밋 `336a5133`이 모든 거울(`package.json`, `package-lock.json` 두 곳, App Worker의 `ADMIN_ASSET_VERSION`, 관리자 스크립트의 `ADMIN_SCRIPT_VERSION`, `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 쿼리)을 올렸다. `guard:release-identity` 'MUSIXQUARE 9.0.22; service-worker cache epoch v795', `guard:sw-cache-version` 'PASS: v795 (336a5133) covers all committed PWA runtime changes'. 앱 SemVer와 SW 캐시가 바뀌므로 업데이트 창이 뜬다. F1 뒤 바닥 789 위의 9.0.16 ~ 9.0.21 탭(빌드 789 ~ 794)에는 '나중에'가 있는 보통 창이다. 795는 PRO 스냅샷 schemaVersion 2를 받는 첫 빌드이고 F2의 바닥이다                                                                                                                                                                                                                                                                                                                                                                         |
| Scope              | Phase 5.5 계획의 R1(증분 R1-1 ~ R1-11). 구버전 제거 열차 3(보내는 쪽): SESSION_FULL `message`와 OPERATOR_TOAST `text`(STD-1, STD-2), 게스트의 SFU 능력 표지와 그 메시지 종류(SAC-1, SAC-2, SAC-4), Standard 첫 offer와 모든 answer의 `iceRestartVersion`(SIG-4, SIG-3 src), signaling peer-open의 표지 넷(SIG-1, OV-F08), PRO presence/close의 재생 관찰 세 필드(PRES-1, PRES-2 문서)와 부르는 곳 없는 `leavePresence`(LEAVE-1). PRO 스냅샷 v2 받기: App이 스냅샷 schemaVersion 1과 2를 한 메모리 모양으로 읽음(A1, PSK-04 관리자 목록, PSK-12, PSK-17), PREPARE와 COMMIT의 시작 종류 `timingMode`(ZS-01), `liveExpiresAt` null인 live LAN-direct(PLE-01, M6), PRO Worker가 저장된 `timingMode`와 null LAN-direct 마감을 읽음(ZS-02, PLE-02), Worker와 App의 PRO 재생 전환 공유 시간 집(ZS-07). 문서: 바닥을 릴리스 전에 올리는 규칙(RM-03)과 release-record §4의 현재 경계 줄(M8). PRO Worker는 아직 v1과 숫자 마감만 쓴다. 저장 모양, D1, 비밀, 바인딩, Wrangler 설정, CORS, 계약 표지는 바꾸지 않는다                               |
| Deploy target      | `all`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`와 Worker별 런타임 경로로 견준 로컬 git 판정(App은 9.0.21 `3bfdffcb`, 다른 다섯은 9.0.20 `226219c5` 대비. 9.0.21은 `app`이라 다섯 Worker는 9.0.20 버전 그대로이고, 다섯을 `3bfdffcb`와 견줘도 수가 같다): App 27(`src` 21, `cloudflare/app-worker.ts`, `cloudflare/pro-room-playback-timing.ts`, `cloudflare/standard-room-pin-membership.ts`, `browser/classic-runtime/admin.ts`, `index.html`, `scripts/service-worker-asset.ts`), PRO 방 2(`cloudflare/pro-room-worker.ts`, `cloudflare/pro-room-playback-timing.ts`), signaling 2(`cloudflare/signaling-worker.ts`, `cloudflare/standard-room-pin-membership.ts`), remote-share 0, Developer API facade 0, Developer API 0. `changedAppRuntimeDependencies`는 빈 목록이다. 9.0.21이 배포됐다는 전제의 판정이라 운영 조회를 대신하지 않는다. Developer API D1 `false`, `raise_app_build_floor` `false`. 이 릴리스는 바닥을 올리지 않는다: 배포 전 F1이 789로, 배포와 기록 뒤 R2 전에 F2가 795로 따로 `set`한다 |
| Operations         | 이 열차는 아직 운영에 아무것도 하지 않았다. 배포 전 운영 단계와 dispatch 직전 다시 읽기는 '배포 조건과 순서'와 QA 라운드 6(자리)에 있다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Resource ownership | 새 복구·재시도·시간 제한·감시·생명주기 흐름이 없어 새 레코드는 없다. R1-10이 RO-03 시간 집에 공유 파일 `cloudflare/pro-room-playback-timing.ts`(전환 마감 3000 ms, COMMIT 앞섬 700 ms, 시작 종류 합집합)를 더하고 `scripts/check-resource-ownership.mts`의 시간 계약 하나를 더했다(RO-03, RO-31). RO-04(R1-2), RO-15(R1-3), RO-07(R1-9 뒤의 선택 키, 리뷰 반영 `b7d91b2c`)도 같은 변경에서 고쳤다. `node scripts/check-resource-ownership.mts`: 49 records / 446 files(새 공유 파일로 +1), 같은 값 쌍 24 → 27(보고만, 셋 모두 새 계약의 App 예산), 기준치 변화 없음                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

이 문서는 Phase 5.5의 첫 런타임 릴리스 R1의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의
Phase 5.5 계획(2026-10-28)과 그 영역 조사이고, STD, SAC, SIG, PRES, PSK, ZS, PLE, RM, OV 번호와 Q 번호는 그 노트의
번호다. 계획의 줄 번호는 `6a23c46e` 기준이라 증분마다 위치를 다시 찾았다. 증분마다 테스트를 먼저 커밋하고 부모 코드에서
새 행만 실패함을 확인했고, 옮긴 뒤 그 부모에서 다시 확인했다(QA 라운드 2). 계획 단계 이름은 P1(시험만, #517), P2(도구·문서만,
#519), F1(바닥 789), R1(이 릴리스), F2(바닥 795), R2(PRO Worker가 스냅샷 v2를 보냄, target `pro-room`), R3(App이 v1 받기를
그만둠, target `app`)이다. 영구 운영 문서(release-record §4, hotfix-procedure)에는 단계 이름 대신 SemVer와 빌드로 적었다.

## 오너 결정과 순서

- **옛 버전 정책(2026-10-25 약 16:40 KST):** 옛 앱 버전은 설계 제약이 아니다. 옛 클라이언트만 섬기던 코드는 지운다.
- **강제 업데이트(2026-10-25 약 18:30 KST):** Signaling과 PRO Worker가 입장 때 최소 앱 빌드를 검사한다. 뒤의 올리기는 그것이
  필요한 릴리스에서 따로 묻지 않는다.
- **작은 통신 필드(2026-10-26 약 00:10 KST):** 받는 쪽, 바닥, 보내는 쪽 순으로 지운다. PRO 스냅샷 v1 키, PRO 699 ms 표지,
  LAN-direct 숫자 `liveExpiresAt`은 이 순서로 Phase 5.5가 맡는다.
- **Phase 5.5 계획 질문(2026-10-28, 모두 권장 기본):** Q1 열차 3과 v2 받기를 한 릴리스(R1)에 싣는다(앱 업데이트 창 둘, 바닥
  올리기 둘). Q2 신호 표지 넷을 모두 지우고 P2가 remote-share smoke와 runbook을 고친다. Q3 뜻 없는 LAN-direct
  `liveExpiresAt`을 통신과 PRO 저장 모두 null로 한다(이 릴리스는 받기만, 쓰기는 R2). Q4 시작 종류를 최상위 선택 필드
  `timingMode`로 모든 PREPARE와 transition COMMIT에 싣는다(이 릴리스는 받기만). Q6 공유 시간 집을 이 릴리스에서 만들고, 2.3 s
  준비 예산과의 순서 시험은 앱 쪽 Phase 0d C2-1로 미룬다. Q20 R2 뒤 전경에 남은 R1 앞 탭이 그 방의 시작을 3초 늦추는 것을
  받아들인다. Q7 ~ Q19와 Q21은 기본 그대로다. 그 가운데 이 릴리스에 닿는 것: 첫 바닥 뒤 올리기가 실패하면 0이 아니라 직전에
  검증한 바닥으로 내린다(Q12, P2가 hotfix-procedure에 적음), LEAVE-1은 R1-4에 싣는다(Q15), 릴리스마다 보고서 하나(Q13).
- **Phase 5.5 승인(2026-10-29 약 04:20 KST):** 9.0.20 배포가 끝나면 따로 묻지 않고 시작한다.
- **배포 정책(2026-10-25 약 01:50 KST):** 자동 게이트가 통과하면 따로 묻지 않고 배포한다. 기기 근거는 게이트가 아니다.
- **순서:** P1(#517) → P2(#519) → 9.0.21 UI 후속 열차(#522, R1보다 먼저 9.0.21 / v794를 가져가 R1은 9.0.22 / v795가 됨) →
  9.0.21 배포 기록 → P2 직후 운영 remote-share smoke 두 형태 → F1(같은 값 787, 789)과 그 직후 신호 입장 smoke → R1 머지와
  배포(9.0.22) → R1 기록 → F2(같은 값 789, 795)와 신호 입장 smoke → R2 → R3. F1과 R1 사이, R1 머지와 R1 기록 사이에 다른
  릴리스나 머지를 끼우지 않는다.

## 바닥 789와 이 릴리스가 기대는 것

R1이 지우는 보내기를 요구하는 마지막 받는 쪽은 9.0.14(빌드 787)와 9.0.15(빌드 788)다.

| 지우는 보내기                                 | 요구하던 받는 쪽                                                    | 9.0.16 이상(빌드 789 이상)                                   |
| --------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| SESSION_FULL `message`, OPERATOR_TOAST `text` | 9.0.14의 정확한 키 검증기                                           | 9.0.15부터 둘 다 선택으로 받음(열차 2 릴리스 A, A-4)         |
| 게스트의 SFU 능력 표지                        | 9.0.14, 9.0.15 방장(읽고 LAN 피어의 SFU 가능 여부를 정함)           | 9.0.16(5B-OV2)부터 읽지 않고 모든 LAN 피어를 SFU 가능으로 봄 |
| 첫 offer와 answer의 `iceRestartVersion`       | 9.0.14 끝(첫 SDP 표지로 재시작 바인딩)                              | 9.0.15(A-3, OV-F04 1단계)부터 표지와 관계없이 묶음           |
| signaling peer-open의 표지 넷                 | 9.0.14 App(생존 감시, 확인서 요청, PIN 참여자 선택)                 | 9.0.15부터 읽지 않음                                         |
| PRO presence/close의 세 필드                  | 받는 쪽은 PRO Worker. 릴리스 W(`a3893f04`, PRO `319f6e8f`)부터 선택 | 바닥이 아니라 배포 순서와 §4 경계로 지킴(아래 R1-4)          |

그래서 바닥은 max(릴리스 A 빌드 788, 5B 빌드 789), 곧 789이고 F1이 R1 머지 직전에 올린다. `raise_app_build_floor`는 쓰지 않는다.
그 올리기는 커밋 표지 뒤에 이 릴리스 자신의 빌드(795)로만 올라 너무 늦고 너무 높다(RM-03, hotfix-procedure App Build Floor).

바닥이 거르지 못하는 곳: 바닥 읽기는 실패하면 마지막 값이나 0이고(fail-open), App의 매분 보고가 5분 넘게 멈추면 유효 바닥은
0이다. 새 isolate의 service-control 읽기가 한 번 실패하면 0을 1초 캐시한다. 그 창에서 들어온 9.0.14, 9.0.15 끝은 아래 '혼합
버전'의 손실을 겪는다(정책 수용). 이 릴리스의 signaling 배포는 Durable Object를 다시 시작해 Standard 신호 소켓을 다시 잇게
하므로, F1 전에 들어와 아직 다시 잇지 않은 787, 788 방장은 그때 바닥에서 거절된다(맺어진 P2P는 산다). Cloudflare 문서상
동작이고 이 프로젝트에서 확인하지 않았다. 릴리스 안 신호 smoke의 `legacyCompatibility.refusedBelowAppBuildFloor` 789가 그 쓸기
무렵 유효 바닥의 근거다. `admittedWithoutAppBuild`였으면 쓸기가 빠졌을 수 있고 Phase 5.5 안에는 다음 신호 배포가 없으므로, 다시
거르려면 target `signaling` 재배포가 필요하다(오너 판단).

v2 받기 쪽은 이 릴리스에 바닥이 필요 없다(받는 쪽만 넓힘, PRO Worker는 v1을 계속 보냄). 795 앞 빌드는 v2 스냅샷, `timingMode`가
든 PREPARE·COMMIT, null `liveExpiresAt`을 모두 정확한 키로 거절하므로 R2 전에 F2가 바닥을 795로 올린다.

## 증분 한눈에

부모 실패는 테스트 먼저 커밋을 그 부모 코드에서 돌린 결과(실패 / 그 파일들의 전체 행)다. 처음 만든 SHA에서 한 번(QA 라운드 1),
옮긴 SHA에서 다시 한 번(QA 라운드 2) 돌렸고 두 번 모두 같은 행이 실패했다.

| 증분    | 항목                           | 테스트 먼저 → 코드(옮긴 뒤)          | 부모 실패                     | 런타임 경로               |
| ------- | ------------------------------ | ------------------------------------ | ----------------------------- | ------------------------- |
| R1-1    | STD-1, STD-2                   | `be179131` → `43e8c7f5`              | 4 / 146                       | App                       |
| R1-2    | SAC-1, SAC-2, SAC-4            | `04e43666` → `8c09d939`              | 3 / 79                        | App                       |
| R1-3    | SIG-4, SIG-3(src)              | `ec435867` → `7992781c`              | 3 / 256                       | App                       |
| R1-5    | SIG-1, OV-F08, SIG-3 공유 주석 | `068dc4e8` → `8d532844`              | 4 / 573                       | signaling, App(공유 주석) |
| R1-4    | PRES-1, PRES-2(문서)           | `fac20e64` → `8f71de2d`              | 2 / 695                       | App                       |
| LEAVE-1 | 부르는 곳 없는 `leavePresence` | 없음 → `d456f28c`                    | 해당 없음(죽은 코드)          | App                       |
| R1-6    | A1, PSK-04, PSK-12, PSK-17     | `b95dd9c0` → `97c07685`              | 29 / 218                      | App                       |
| R1-7    | ZS-01                          | `552f4e34` → `02637ffa`              | 10 / 286                      | App                       |
| R1-8    | PLE-01, M6                     | `02a7ca93` → `3b859d3f`              | 16 / 835                      | App                       |
| R1-9    | ZS-02, PLE-02                  | `860658fc` → `455319cd`              | 6 / 603                       | PRO                       |
| R1-10   | ZS-07(Q6)                      | `aa40652a` → `e5cb955c`              | 새 묶음 불러오기 실패, 1 / 49 | PRO, App                  |
| R1-11   | RM-03, §4 현재 경계 줄(M8)     | 문서 `64ce7cf7`, `9d767021`          | 없음                          | 문서                      |
| 이름    | 열차 3을 9.0.22로              | `513729f6`(주석, 시험 제목, 문서)    | 없음                          | PRO(주석), 문서           |
| 리뷰    | 잠든 방 행, 문서 다듬기        | `38c0dee2`(시험만), `b7d91b2c`(문서) | 아래 '잠든 방 행'             | 없음                      |
| bump    | 9.0.22 / v795                  | `336a5133`                           | 없음                          | App                       |

## 증분

### R1-1 SESSION_FULL `message`와 OPERATOR_TOAST `text`를 보내지 않음 (STD-1, STD-2)

방장의 SESSION_FULL 거절 셋(정원 초과, 빈 자리 없음, 자리 배정 중 방이 참)은 `i18nKey`만, 운영자에게 가는 디코드 실패 알림은
키만 보낸다. 방장 언어 대체 글은 9.0.14 받는 쪽만 읽었다. 방장 자신의 토스트와 게스트 자신의 대체 문구는 그대로이고, 받는
쪽은 두 모양을 계속 받는다(R3 몫). 테스트 먼저는 기존 정원 초과 행을 정확한 프레임으로 바꾸고, 갈래 2(다른 id가 1 ~ 99 자리를
모두 가짐)와 갈래 3(`state:network.peerLabels` 동기 리스너가 자리 배정 중 방을 채움) 행을 더했으며, 디코드 알림 행에서 `text`를
뺐다. 부모에서는 넷 모두 남는 키 하나로만 실패했다.

### R1-2 게스트의 SFU 능력 표지와 그 종류 (SAC-1, SAC-2, SAC-4)

게스트의 `network:peer-connected` 리스너가 방장 연결마다 보내던 `SYSTEM_AUDIO_SFU_CAPABILITY`를 지웠고, 이 빌드에서 그
종류를 보내는 곳이 없으므로 종류, 검증기, 페이로드 타입, 검증기의 protocol 행도 지웠다(SAC-2). 9.0.16 ~ 9.0.21 게스트가 아직
보내는 표지는 검증기도 처리기도 만나지 않고 rate-limit 토큰 하나 뒤 조용히 버려진다. `system-audio-start.test.ts`의 원시 표지
행이 그것을 고정한다. 이 행은 `handleData`를 직접 불러 방장 역할과 `network.activeHostConnByPeerId`의 게스트 연결을 갖추고
'Ignored frame from stale guest connection' debug가 없음을 단언하므로 낡은 연결 확인에서 헛통과하지 않는다. 부모와 자식 모두에서
통과하는 짝 행이다. SAC-4는 5B 리뷰의 낮음 지적(주석이 마지막 독자를 잘못 적음)을 그 주석째 지워 닫는다. 정확한 개수는 아래
'정확한 개수 가드'.

### R1-3 첫 offer와 모든 answer의 `iceRestartVersion` (SIG-4, SIG-3 src)

Standard 게스트의 첫 데이터 offer, 방장의 첫 answer와 재시작 answer가 `iceRestartVersion`을 싣지 않는다(OV-F04 2단계). 재시작
offer는 `restartOf`와 함께 표지를 계속 싣는다(방장과 signaling Worker가 요구, SIG-K1). Worker는 첫 offer와 answer를 표지가 있든
없든 받는다(SIG-K2). PRO는 표지를 보낸 적이 없다. answer 타입과 peer-open 타입에서 읽지 않던 필드를 지웠다(SIG-3 src). 문서는
`docs/design/signaling-liveness.md`와 RO-15. 증분 검사로 C5-0 랩 `route-outage` 4개를 로컬에서 돌렸다(4 / 4).

### R1-5 signaling peer-open은 `workerVersionId`만 (SIG-1, OV-F08)

signaling Worker의 peer-open이 `signalingLivenessVersion`(방장, 게스트, PRO 멤버), `remoteShareUploadAssertionVersion`과
`remoteShareUploadAssertionKeyringVersion`(확인서 비밀을 쓸 수 있는 방장), `standardRoomPinMembershipVersion`(방장)을 더
광고하지 않는다. 9.0.15 이상 App은 하나도 읽지 않는다. `workerVersionId`는 release smoke와 진단이 읽으므로 남는다. 생존 ping과
pong, PIN 참여자 기록 버전, 확인서 비밀 검사와 발급은 그대로이고, 서명할 수 없는 Worker는 요청마다
`REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE`로 거절한다(약한 비밀 행을 이 응답 행으로 새로 씀, 양쪽 통과). 문서는
`cloudflare/standard-room-pin-ops.md`, known-accepted #12, `docs/design/signaling-liveness.md`, 그리고 hotfix-procedure의
'App을 9.0.15 아래로 내리는 비상 복구는 Signaling 먼저' 문장(아래 '되돌리기'). `cloudflare/signaling-worker.ts`는 8,421 →
8,403줄(한도 10,000)이다.

**머지 전제(세 리뷰가 같은 말):** 9.0.20 기준의 `scripts/live-remote-share-smoke.ts`는 방장 peer-open의 확인서 표지 둘을 요구했다.
P2(#519, SIG-2)가 smoke를 표지 없이 실제 확인서 요청과 전체 객체 할당으로 방을 증명하게 바꿨고, 이 브랜치는 P2가 든 main 위로
옮겼다. 옮긴 뒤 smoke 단위 시험과 R1-5 Worker 행을 다시 돌렸다(QA 라운드 3). 남은 전제는 P2 직후 운영 remote-share smoke 두 형태의
통과다(QA 라운드 6). P2 없이 이 Worker가 나갔다면 release의 strict remote-share smoke가 실패해 자동 복구가 돌았다.

### R1-4 PRO presence/close의 재생 관찰 (PRES-1, PRES-2 문서)와 LEAVE-1

확인된 `pagehide`와 명시적 나가기 시작 때 App이 보내는 `POST /presence/close`가 영수증 키, 잡아 둔 참가자와 presence 화신만
싣는다. `baseRevision`, `currentQueueItemId`, `playback`은 늘 스냅샷 revision과 null 둘이었고 PRO Worker가 읽은 적이 없다.
릴리스 W(`a3893f04`, PRO `319f6e8f`)부터 PRO Worker는 셋을 선택으로 받고, 옛 App이 보내면 여전히 검사한다. 받는 쪽이 PRO Worker라
바닥이 필요 없다. `all`은 PRO를 App보다 먼저 배포하고, 실패 복구는 App을 먼저 되돌리며, 릴리스 W 뒤 checkpoint의 PRO는 모두 W
이상이다. 그 경계는 문서로 둔다(계약 표지는 바꾸지 않음): hotfix-procedure의 PRO 입장 정책 문단 뒤와 release-record §4의
릴리스 W 항목에 '9.0.22 이상 App이 한 번이라도 live가 된 뒤에는 PRO를 W 앞으로 손으로 되돌리지 않는다'를 적었다(아래
'되돌리기').

LEAVE-1(`d456f28c`, 테스트 먼저 없음): `ProRoomApiClient.leavePresence`(DELETE `/presence/current`)는 `f3f0e9b0`(2026-07-16) 뒤
제품 호출이 없다(src, browser, scripts, cloudflare, e2e의 `git log -S`). 메서드, 인터페이스 멤버, 그것만 쓰던 시험 사용처를 함께
지웠다. PRO Worker의 그 경로는 Worker 시험이 쓰므로 남는다.

로컬 PRO Playwright 묶음 30 / 30이 통과했지만 그 고정값은 presence/close를 거치지 않으므로 레인이 돈다는 근거일 뿐이다.

### R1-6 PRO 스냅샷 schemaVersion 1과 2를 한 메모리 모양으로 (A1, PSK-04, PSK-12, PSK-17)

`parseProRoomSnapshot`이 지금 모든 PRO Worker가 보내는 schemaVersion 1과, 코디네이터 시대 키 넷(`presence.coordinatorParticipantId`,
`viewer.coordinatorEligible`, `memberIdentityVersion`, `authorityVersion`)을 뺀 schemaVersion 2를 한 메모리 모양(schemaVersion 2,
한 키 순서)으로 읽는다. 버전마다 정확한 키 집합이고, v1은 네 키의 고정값을 요구하며 v2에 하나라도 있으면 거절한다. 같은
revision의 두 와이어가 `revision.ts`에서 같게 비교되므로 v2를 보내기 시작하는 PRO Worker가 설치된 revision을 충돌로 바꾸지 않는다
(membership 경고, `PRO_ROOM_SNAPSHOT_CONFLICT`, `PRO_ROOM_PLAYLIST_SNAPSHOT_CONFLICT`). `PRO_ROOM_SNAPSHOT_SCHEMA_VERSION`은 1 → 2로
메모리 스키마를 뜻하게 됐고 export 수는 그대로다. 관리자 목록 GET, PUT, DELETE는 `{ administrators }`와
`{ authorityVersion: 1, administrators }`를 모두 받는다(PSK-04). `pro-room-invalidated`의 '시스템 오디오 호환 새로 읽기'는 그 필드를
보내던 PRO Worker가 9.0.4 표지 커밋 `d6ac67f3`보다 앞(`2fa55871`)이라 복구로도 돌아오지 않으므로 지웠다(PSK-12). 시험 도우미의
기본 출력을 v2로 바꾼 것은 테스트 먼저가 아니라 코드 커밋이다(테스트 먼저에서 바꾸면 부모에서 기존 행이 한꺼번에 실패함).

범위 이동: 이 증분이 R3-1의 일부(`snapshot.ts`의 코디네이터 검사, 잠든 방 조건의 코디네이터 절)와 R2-1의 일부
(`src/core/__tests__/pro-room-burst.test.ts`의 명단 단언)를 가져왔다. R2와 R3는 갈래를 딸 때 자기 목록을 다시 잰다.

### R1-7 PREPARE와 COMMIT의 시작 종류 `timingMode` (ZS-01)

PREPARE와 COMMIT 파서가 정확한 키 집합 옆에 최상위 선택 필드 `timingMode`를 받아 새 사건 객체에 옮긴다. 회원 티켓의 대기 PREPARE와
재생 명령 답의 PREPARE도 같은 파서라 남는다. 'zero-start'는 zero-start로, 다른 값은 scheduled-control로 읽는다(종류는 배운 시작
앞섬만 주므로 모르는 값이 사건을 버리지 않음). transition COMMIT은 필드가 있으면 앞섬과 관계없이 그 종류를 따르고, 없으면 지금
규칙(699 ms 앞섬 표지)을 따른다. direct COMMIT과 PREPARE 없는 COMMIT은 그대로 scheduled-control이다. CANCEL 파서는 그대로다.

### R1-8 마감 없는 live LAN-direct (PLE-01, M6)

`parseProRoomSystemAudioState`(하트비트, GET `/system-audio`, lease 봉투, 컨트롤러 재파싱이 모두 쓰는 파서)가 `liveExpiresAt`
null인 live LAN-direct를 읽고, 지금 모든 PRO Worker가 보내는 숫자 호환값도 null로 읽는다. 받은 값을 그대로 두지 않으므로 Worker가
공유 도중 값을 바꿔도 컨트롤러는 같은 상태로 보고(STATE_CONFLICT 없음), 공유자의 lease 하트비트가 60초 직접 유예 뒤 멈추지 않는다.
SFU live는 여전히 양의 마감이 필요하다. live 상태와 발행 정체성의 타입은 `number | null`로 넓혔고, 넓히기만 하면 `tsc`가 세 곳에서
실패하므로 SFU 설명자와 공유자 기한은 숫자인 SFU live에서만 만든다(M6). 타입을 SFU와 직접으로 나누는 것은 R3-3 몫이다.

### R1-9 PRO Worker가 저장된 시작 종류와 null LAN-direct 마감을 읽음 (ZS-02, PLE-02)

이 PRO Worker는 스냅샷 v2를 보내는 PRO Worker(R2)의 실패 자동 복구와 손 되돌리기가 돌아올 곳이다. 그래서 R2가 저장할 모양을 모두
읽되, 쓰기는 아직 v1 모양만 한다.

- 저장된 전환(`normalizeStoredPlaybackTransition`)과 outbox 기록(`normalizeStoredPlaybackBroadcastRecord`)이 선택 키 `timingMode`
  ('zero-start', 'scheduled-control')를 받는다. 새 기록도 같은 검사를 거치므로 R2의 사건이 필요로 하는 쓰기 경로도 열린다.
  저장된 전환의 종류는 도우미 하나(`playbackTransitionTimingMode`)가 읽는다: 이름이 있으면 그것, 없으면 2999 ms 마감 인코딩.
  ENDED 합치기와 COMMIT 앞섬이 그것을 읽으므로 이름 붙은 zero-start(마감 3000)도 필드 없는 COMMIT에서 699 ms 앞섬으로 나간다.
- `normalizeStoredSystemAudio`가 live LAN-direct에만 `liveExpiresAt` null을 받는다. 불러올 때(`normalizeLoadedSystemAudio`) null을
  '불러온 시각 + `SYSTEM_AUDIO_LIVE_TTL_MS`'(첫 commit과 같은 식)로 바꾸고 이주 표시를 세워 첫 prune이 저장한다. 그래서 공개 투영과
  모든 하트비트 답의 값은 795 앞 App이 요구하는 양의 정수다(Q3, R2 뒤 App을 795 아래로 내리는 비상 길의 전제).

**부모 실행이 보여 준 되돌리기 바닥(PLE-02, 계획 §4 R2 행 (3)).** 테스트 먼저 `860658fc`를 부모 `3b859d3f`에서 돌렸다. 그 부모의
`cloudflare/pro-room-worker.ts`는 9.0.20 `226219c5`(운영 PRO Worker)와 바이트가 같다. 6 / 603이 실패했고 실패 행이 곧 R1 앞 PRO
Worker의 동작이다.

1. 'keeps a stored transition that names timingMode zero-start ... across a cold restart and commits it with the 699 ms lead'와
   같은 행의 scheduled-control 판: 첫 READY가 404 `PLAYBACK_TRANSITION_NOT_FOUND`(불러올 때 기록을 null로 함, CANCEL 없음).
2. 'keeps and delivers in order a transition COMMIT and a PREPARE that name timingMode across a cold restart': 아무것도 배달되지
   않음(outbox 전체를 불러올 때 버림).
3. 'reads the start kind a stored transition names when it coalesces a duplicate ENDED': 중복 ENDED가 합쳐지지 않고 새 전환이 됨.
4. 'lets the outbox write path queue a PREPARE and a transition COMMIT that name either timingMode': enqueue가 false(쓰기 거절).
5. 'loads a live LAN-direct stored without a media deadline as the same share with the compatibility deadline': GET이 세대 1 live
   대신 세대 2 idle(null LAN-direct를 다음 세대 idle로 울타리침).

그래서 R2가 v2 기록을 쓴 뒤에는 PRO를 이 릴리스의 PRO Worker 아래로 되돌리지 않는다. 이 경계는 R2 런타임 PR이 release-record §4와
hotfix-procedure에 적는다(이 릴리스 뒤에는 아직 그 기록이 없으므로 R1 앞 PRO로 돌아가도 잃는 것이 없다). 양쪽에서 통과하는 행
하나('keeps fencing a live SFU publication stored without its media deadline')와 51ab2be3, pre-v2 고정 기록 행도 그대로 통과했다.

### R1-10 PRO 재생 전환 공유 시간 집 (ZS-07, Q6)

`cloudflare/pro-room-playback-timing.ts`(선례 `pro-room-receipt-timing.ts`)가 전환 마감 `PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS`
(3000), COMMIT 앞섬 `PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS`(700), 시작 종류 합집합 `ProRoomPlaybackTimingMode`를 둔다. 값과 와이어
모양은 그대로다. PRO Worker는 두 값을 import하고(v2 앞 인코딩 2999와 699는 Worker 안에서 공유 값으로부터 계산), App은 합집합만 타입으로
import하므로 App 번들이 같다. 699와 2999는 공유 파일에 넣지 않는다(Worker와 App이 다른 릴리스에서 그 인코딩을 지우므로 공유 export가
그 사이 죽고, PRO만·App만 릴리스가 `all`이 됨). 공유 파일은 pro-room과 app 런타임 경로, `tsconfig.cloudflare-leaves.json`, RO-03
시간 계약에 들어갔다. 2.3 s 준비 예산과의 순서 시험은 Q6대로 Phase 0d C2-1로 미룬다. SW 캐시 가드는 이 파일을 번들된 것으로 세지
않으므로(타입만 import) bump는 사람이 챙겼다. 테스트 먼저의 부모 실행에서는 새 묶음이 모듈을 찾지 못해 불러오기부터 실패했고,
`resource-ownership-guard.test.ts`의 새 행 하나(같은 이름 복사본 거절)가 실패했다.

### R1-11 바닥을 먼저 올리는 릴리스와 현재 경계 줄 (RM-03, M8)

- hotfix-procedure App Build Floor와 release-versioning: 지금 바닥이 들이는 빌드가 아직 요구하는 것을 그만 보내거나 그 빌드가 읽지
  못하는 모양을 보내기 시작하는 릴리스는 `raise_app_build_floor` 대신 릴리스 전에 standalone `set`으로 바닥을 올리고, 첫 바닥의 신호
  입장 smoke로 두 방의 방장·게스트 입장과 `refusedBelowAppBuildFloor` = 새 바닥을 본다(`appBuild.build`는 live 빌드라 더 높을 수
  있음). 그 `set`이나 smoke가 실패하면 첫 바닥의 0이 아니라 `set` 규칙을 따른다(리뷰 반영 `b7d91b2c`): 일시적이면 같은 `set` 다시,
  아니면 직전에 검증한 바닥으로 `lower`하고 smoke를 다시, 0은 방장이 여전히 거절되거나 그 `lower`가 실패할 때만.
- release-record §4 머리의 '아래 모든 항목보다 우선하는 현재 경계' 줄: (1) 저장 최소 빌드 아래로 App CLI 되돌리기 전에는 되돌릴 대상
  App 빌드로 `lower`를 먼저, (2) 9.0.22 Signaling 뒤 App을 9.0.15 아래로는 Signaling 먼저, (3) 9.0.22 이상 App이 live가 된 뒤 PRO를
  릴리스 W 아래로 손으로 되돌리지 않음, (4) 바닥을 789나 788 아래로 내렸을 때 다시 들어오는 손실. 이 줄이 9.0.17, 9.0.18의 'App만
  checkpoint로 lower 없이' 같은 옛 문장과, 곧 생길 9.0.21 항목의 같은 꼴 문장을 덮는다. R2와 R3 런타임 PR이 이 줄을 늘린다.

### 이름 바로잡기와 리뷰 반영

- `513729f6`: 이 열차를 9.0.21로 적었던 22곳(hotfix-procedure 5, release-versioning 1, release-record 11, PRO 운영 문서 4, PRO
  Worker의 presence/close 주석 하나)을 9.0.22로, 9.0.20을 '열차 앞 마지막 빌드'로 적은 곳을 9.0.21로 고쳤다. Worker 주석은 pro-room
  런타임 경로라 이 `all`에 함께 나간다.
- `38c0dee2`(시험만): 아래 '잠든 방 행'.
- `b7d91b2c`(문서만): §4 현재 경계 줄 (1)의 대상 빌드, §2 5B 호환의 OV-B05 문장(게스트는 9.0.21까지 표지를 보냈고 9.0.22부터
  보내지 않음), RM-03의 이른 `set` 실패 규칙, RO-03의 보고만 쌍(700 ms 둘과 3 s 하나, 1.5 s 문턱은 시간 집과 값을 나누지 않음),
  RO-07의 선택 키 `timingMode`와 그것을 고정하는 세 행.

### 잠든 방 행 (`38c0dee2`)

R1-6이 `parseProRoomSnapshot`의 잠든 방 조건에서 코디네이터 절을 지우면서 남은 참가자 절(`src/pro-room/snapshot.ts`
`if (value.runtime === 'sleeping' && presence.participants.length !== 0) return null;`)을 지키는 행이 없었다. 그 줄을 지워도 PRO 클라이언트
묶음이 모두 통과했다(리뷰가 확인). `domain.test.ts`에 와이어마다 한 행(schemaVersion 1과 2)을 더했다: 참가자 한 명과 맞는
`onlineDeviceCount` 1인 잠든 방은 null이다. 각 행은 먼저 같은 방을 presence 없이(개수 0) 파싱해 통과시키므로 거절은 참가자 하나에서만
온다. QA 라운드 2에서 `38c0dee2` 그대로 두 행이 통과하고, 그 한 줄을 지운 트리에서 두 행이 실패함을 다시 봤다. R1-6 부모(LEAVE-1
커밋)에서는 v1 꼴 행이 통과한다(커밋 메시지).

### 버전 올리기 9.0.22 / v795 (`336a5133`)

버전 거울 여섯 파일 일곱 줄. 올리기 전에 받은 origin/main은 `3bfdffcb`(9.0.21 / v794)다. 이 열차의 마지막 런타임 커밋이고, 그 뒤는
이 보고서와 기록 커밋(문서만)뿐이다.

## 옮긴 뒤 SHA (`edd6ee94` 위 → `3bfdffcb` 위)

| 처음       | 옮긴 뒤    | 처음       | 옮긴 뒤    | 처음       | 옮긴 뒤                    |
| ---------- | ---------- | ---------- | ---------- | ---------- | -------------------------- |
| `54e2cfa4` | `be179131` | `a34242cc` | `068dc4e8` | `a61ca007` | `02637ffa`                 |
| `8e7547ad` | `43e8c7f5` | `18aeafcb` | `8d532844` | `1abaae77` | `02a7ca93`                 |
| `c78c536b` | `04e43666` | `23956dc2` | `fac20e64` | `b995049f` | `3b859d3f`                 |
| `a102ac06` | `8c09d939` | `3e3e7ad4` | `8f71de2d` | `61d4ee8a` | `860658fc`                 |
| `1d6beede` | `ec435867` | `1bfc0a99` | `d456f28c` | `943484ba` | `455319cd`                 |
| `d120498c` | `7992781c` | `ee7ea9ea` | `b95dd9c0` | `0cf9c278` | `aa40652a`                 |
|            |            | `6ccdc2db` | `97c07685` | `fcee4ae5` | `e5cb955c`                 |
|            |            | `cd4c2cd3` | `552f4e34` | `539d7ded` | `64ce7cf7`(앞뒤 줄만 다름) |
|            |            |            |            | `c058a98a` | `9d767021`(앞뒤 줄만 다름) |

옮기기에서 뺀 것: `95051a6c`, `b612c051`(아래). 옮긴 뒤 더한 것: `513729f6`, `38c0dee2`, `b7d91b2c`, `336a5133`, 이 보고서와 기록
커밋.

## 뺀 쌍: 미디어 고르기 창 포커스 경쟁

R1 증분을 만들 때 9.0.20 기록이 '다음 App 릴리스의 런타임 고침'으로 남긴 미디어 고르기 창 포커스 경쟁을 계획 밖 증분으로 함께
고쳤다(`95051a6c` 테스트 먼저, `b612c051` 구현. 부모에서 빠른 Tab 행 2 / 217 실패, WebKit iPhone 격리 실행 20번 중 2번 실패, 고친
뒤 30 / 30). 그 사이 같은 날 9.0.21 UI 후속 열차가 자기 고침(A5, 키보드로 연 창만 창 안 컨트롤의 포커스를 지킴, 포인터로 연 창은
창 표면으로)을 싣고 먼저 나갔으므로 R1을 9.0.21 위로 옮길 때 이 쌍을 뺐다. 9.0.22의 App 범위에 포커스 변경은 없고
`src/ui/player-controls.ts`는 9.0.21 그대로다. 그 열린 항목은 9.0.21 배포 기록이 닫는다.

## 정확한 개수 가드

| 가드                       | 위치                                                                         | 전   | 뒤   | 바뀐 커밋                             |
| -------------------------- | ---------------------------------------------------------------------------- | ---- | ---- | ------------------------------------- |
| 선언된 메시지 종류         | `src/network/__tests__/protocol-validation-coverage.test.ts`                 | 102  | 101  | 테스트 먼저 `04e43666`(받아들인 예외) |
| room-authority 파일별 기준 | `scripts/check-room-authority-boundaries.mts`(`system-audio-sfu.ts` appRole) | 10   | 9    | 코드 `8c09d939`                       |
| room-authority 지문        | 같은 파일(`network:peer-connected` 리스너)                                   | 있음 | 삭제 | 코드 `8c09d939`                       |
| room-authority 총합        | `src/core/__tests__/room-authority-boundaries.test.ts`(directReads)          | 80   | 79   | 코드 `8c09d939`                       |

**받아들인 예외:** 선언된 메시지 종류의 102 → 101은 코드 커밋이 아니라 R1-2의 테스트 먼저 커밋에서 바뀌었다. 계획 R1-2 행의 '먼저
실패할 테스트' 칸이 그렇게 적고, 열차 2 릴리스 A의 A-4(103 → 102)와 같은 선례다. 그 행은 부모에서 '102를 받음'으로 실패하고 새
'더 선언하지 않음' 행과 짝을 이룬다. room-authority 세 숫자는 코드 커밋에서만 바뀌었다.

바뀌지 않은 것: dead-exports 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76(2,111 bindings), bus-pairing 203 / 203(계획의 202는
`6a23c46e`에서 잰 값이고 기준 `edd6ee94`와 `3bfdffcb`도 203), import-graph 순환 0, room-authority 구독 22·쓰기 13·PRO 읽기 0·스냅샷
읽기 0, resource-ownership 49 records(파일 445 → 446은 새 공유 파일). 줄 수: `cloudflare/pro-room-worker.ts` 18,340 → 18,405 /
20,000, `cloudflare/signaling-worker.ts` 8,421 → 8,403 / 10,000, `cloudflare/signaling-protocol.ts` 989 / 1,000(건드리지 않음),
`src/pro-room/runtime.ts` 4,175 → 4,157 / 10,000.

## 혼합 버전

F1 뒤 운영에 들어올 수 있는 빌드는 789(9.0.16) 이상이다. '789 ~ 794'는 9.0.16 ~ 9.0.21이다.

| 조합                                                                                 | 결과                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.0.22 방장, 789 ~ 794 게스트                                                        | 게스트는 `message` 없는 SESSION_FULL, `text` 없는 OPERATOR_TOAST를 받는다(788 이상 검증기가 선택으로 받음). 첫 answer와 재시작 answer에 표지가 없어도 788 이상은 표지와 관계없이 묶는다. 게스트가 보내는 SFU 능력 표지는 9.0.22 방장에서 검증기도 처리기도 만나지 않고 조용히 버려진다                                                                      |
| 789 ~ 794 방장, 9.0.22 게스트                                                        | 9.0.22 게스트가 SFU 능력 표지를 보내지 않아도 789 이상 방장은 읽지 않는다. 표지 없는 첫 offer도 788 이상 방장이 묶는다. 방장이 계속 싣는 `message`, `text`, 표지는 9.0.22 게스트가 받거나 무시한다                                                                                                                                                          |
| 9.0.22 또는 789 ~ 794 App, 9.0.22 PRO Worker                                         | Worker는 아직 v1 스냅샷, 필드 없는 PREPARE·COMMIT, 숫자 LAN-direct 마감을 보내고 모든 App이 받는다. presence/close는 세 필드가 있든 없든 200이다                                                                                                                                                                                                            |
| 9.0.22 App, 9.0.20 PRO Worker(실패 복구나 손 되돌리기 뒤)                            | 9.0.22 App은 v1과 숫자 마감을 그대로 읽는다. presence/close는 9.0.20 Worker(릴리스 W 이상)가 세 필드 없이 받는다                                                                                                                                                                                                                                            |
| 9.0.22 App, 이 릴리스 앞 Signaling(9.0.20 릴리스의 버전, 실패 복구나 손 되돌리기 뒤) | 9.0.15 이상 App은 peer-open 표지를 읽지 않고, 9.0.14 이상 Signaling은 표지 없는 첫 offer와 answer를 받는다                                                                                                                                                                                                                                                  |
| 788(9.0.15)                                                                          | F1 바닥에서 새 입장과 재접속이 거절된다. 유효 바닥 0 창이나 바닥을 789 아래로 내린 동안 들어온 9.0.15 방장은 SFU 능력 표지를 읽으므로, 표지 없는 9.0.22 LAN 게스트의 직접 통화가 실패하면 SFU 대신 STOP만 보낸다. 9.0.15는 `message` 없는 SESSION_FULL과 `text` 없는 OPERATOR_TOAST를 받고 표지와 관계없이 첫 SDP를 묶으므로 그 밖의 손실은 없다(정책 수용) |
| 787(9.0.14) 이하                                                                     | 위의 STOP에 더해, 유효 바닥 0 창이나 바닥을 788 아래로 내린 동안 '방 가득 참' 대신 일반 끊김, 관리자 알림 없음, 9.0.22 이상 끝과의 ICE 재시작 실패, 9.0.22 Signaling 아래에서 방장의 원격 공유 업로드 실패(`REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE`)와 생존 감시·PIN 참여자 선택 꺼짐(정책 수용)                                                         |

## 되돌리기

기본은 더 높은 SemVer와 캐시 epoch의 코드 되돌리기다(9.0.23 / v796 이상).

**실패 자동 복구:** `all`의 실패 복구는 여섯 Worker를 checkpoint(App은 9.0.21 `3bfdffcb`의 버전, 다른 다섯은 9.0.20 `226219c5`의
버전)로 되돌린다. 안전하다: v2를 쓰는 곳이 아직 없고, 되돌린 App은 지운 필드를 다시 보낼 뿐이며 789 이상 받는 쪽은 두 모양을 받고,
되돌린 signaling은 표지를 다시 광고할 뿐이다. 평가 단계(Cloudflare R2 정책, Worker 호환 바닥, PRO 세대 울타리)가 실패하면 일부가
앞으로 고치기로 남을 수 있다: (9.0.22 App, 9.0.22 signaling, 9.0.22 PRO), (9.0.21 App, 9.0.22 signaling, 9.0.22 PRO), (9.0.21 App,
9.0.20 signaling, 9.0.22 PRO). 셋 다 안전하다(9.0.22 PRO는 v1을 쓰면서 넓힌 입력을 받고, 표지를 광고하지 않는 9.0.22 signaling은 789
이상 App이 읽지 않음). 실패한 `all`은 PRO 세대 cutover를 disabled로 남기고 다음에 성공한 `all`만 ready로 되돌리므로, 이 릴리스를
`all`로 다시 성공시키기 전에는 관리자가 해지된 방 코드를 다시 등록하면 `PRO_ROOM_GENERATION_CUTOVER_NOT_READY` 503이다. Phase 5.5에서
이 릴리스 뒤의 릴리스는 `pro-room`, `app`이므로 이 릴리스를 버리고 다른 묶음으로 가려면 그 앞에 성공한 `all`이 하나 필요하다.

**손 되돌리기 경계:** release-record §4 머리의 현재 경계 줄이 정본이다([§4](../release-record.md#4-복구-시-주의),
[hotfix-procedure](../hotfix-procedure.md#app-build-floor)).

1. F1 뒤 App을 789 아래(9.0.15 이하)로 CLI 되돌리기 전에는 대상 빌드로 `lower`를 먼저 한다. 지금 손이 닿는 checkpoint(9.0.20 793,
   9.0.21 794)는 789 위라 `lower`가 필요 없다. F2 뒤에는 795 아래로 되돌리기 전에 `lower`가 먼저다.
2. 9.0.22 Signaling이 배포된 뒤 App을 9.0.15 아래로 내리는 비상 복구는 (a) Signaling을 표지를 광고하는 버전(9.0.22 릴리스 checkpoint의
   9.0.14 이상 버전)으로, (b) `lower`(9.0.14면 787, 그 아래면 0), (c) App 순서로만 한다. App을 먼저 되돌리면 그 사이 연 9.0.14 탭은
   원격 공유 업로드가 실패하고 방장 생존 감시와 PIN 참여자 선택이 꺼진다. hotfix-procedure의 'App 먼저'는 Signaling을 9.0.14 아래로
   내릴 때의 규칙이다. R2 배포 뒤에는 그 앞에 PRO 단계가 생기며 R2 런타임 PR이 그 가리킴을 단다.
3. 9.0.22 이상 App이 한 번이라도 live가 된 뒤에는 PRO Worker를 릴리스 W(`a3893f04`, PRO `319f6e8f`) 앞으로 손으로 되돌리지 않는다.
   그 Worker는 세 필드 없는 presence/close를 400 `INVALID_REQUEST`로 거절해 탭 닫기 잔상(presence 만료 45초까지), 새로고침과 업데이트
   적용의 넘김 대화상자, 마지막 퇴장의 정지 지연이 온다. App을 되돌려도 열린 9.0.22 탭은 새로 고칠 때까지 세 필드 없이 보낸다.
4. 9.0.22 이상 App이 live가 된 뒤 바닥을 789 아래로 내리면 위 '혼합 버전'의 788, 787 행 손실이 다시 들어온다(정책 수용).
5. R2(스냅샷 v2 쓰기) 뒤에는 이 릴리스의 PRO Worker가 DO 되돌리기 바닥이다(위 R1-9 부모 실행). 그 문장은 R2 런타임 PR이 적는다.

## 배포 조건과 순서

1. 9.0.21(#522)의 배포와 그 기록 PR이 main에 있고, 이 브랜치가 그 위에 있다(기록 PR이 문서만이면 합침만, 런타임 변화 없음).
2. P2(#519)가 main에 있고 P2 직후 운영 remote-share smoke 두 형태(`npm run smoke:live:remote-share`와 `-- --require-assertion`)가
   통과했다(QA 라운드 6).
3. F1(배포·기록 사이 창 밖, 릴리스가 돌지 않을 때): `status` → 같은 값 `set 787` → `set 789` → `status`. 마지막 `set`의 conclusion
   success와 그 뒤 `status` 789(저장·유효).
4. F1 직후 신호 입장 smoke(배포된 main 체크아웃, `MXQR_EXPECTED_SIGNALING_VERSION` 없이): `ok` true, 두 방의 방장·게스트 입장,
   `appBuild.build` 794(live, 789 이상), `legacyCompatibility.refusedBelowAppBuildFloor` 789. 일시적 502·503은 한 번 다시. 방장이
   거절되면 `lower 787`과 smoke 다시, 0은 방장이 여전히 거절되거나 그 `lower`가 실패할 때만. 값만 어긋나면(`admittedWithoutAppBuild`)
   status를 다시 읽고 smoke를 다시 돈다(App 보고가 멈췄으면 그것부터 고침). 어느 실패든 이 릴리스는 F1이 789로 성공할 때까지
   머지하지 않고, F1을 처음부터 다시 돈다.
5. 이 PR을 dispatch 직전에만 머지한다. 그때부터 이 릴리스의 기록 PR 머지까지 다른 PR을 머지하지 않는다. exact-main CI success.
6. dispatch 직전 `status`를 다시 읽어 저장·유효 789와 300초 안의 App 보고(`generatedAt - reportedAt`)를 확인하고, 바닥 실행이
   돌거나 기다리지 않음을 본다.
7. Release: target `all`, Developer API D1 `false`, `raise_app_build_floor` `false`. 'Check the App build floor the PRO Worker
   requires' 단계는 요구 값이 비어 있어 아무것도 막지 않는다(R2가 795를 적음). 모든 live smoke(PRO, 원격 공유 둘, 신호, Developer
   API, App 공개 경계, Standard HTTPS)가 돈다. 신호 smoke의 `refusedBelowAppBuildFloor`가 789인지 기록한다(쓸기 근거).
8. 기록 PR: §1과 `Last source review` 덮어쓰기, F1 요약 줄을 §1 '최소 앱 빌드' 행에(바닥 `set`은 이력 행을 더하지 않음),
   `release-history.md` 한 행, §2의 이 열차 항목을 '배포 뒤 확인'으로, §4에 이 릴리스 항목(Release와 checkpoint ID), §1 '의존성·호환'의
   보내는 쪽 문장(열차 3이 지운 것, 선언된 메시지 종류 101). 릴리스 A 항목의 '9.0.14 기기와의 혼합 방' 기기 확인은 F1 근거로 고치거나
   닫는다. 이 릴리스가 늦어지면 F1 요약 줄만 담은 작은 기록 PR을 이 PR 머지 전에 낸다.
9. 그 뒤 F2: `status` → 같은 값 `set 789` → `set 795` → `status` → 신호 입장 smoke(`appBuild.build`와 `refusedBelowAppBuildFloor`
   모두 795). 실패하면 `lower 789`와 smoke 다시(0은 위와 같은 때만). F2가 성공하고 그 smoke가 통과하기 전에는 R2를 dispatch하지
   않는다.

## 리뷰 지적과 처리

열차 끝 리뷰는 세 갈래(지금 클라이언트, 완결성, 통신과 운영)였고 셋 모두 승인했다(높음·중간 0, 낮음 15, 정보 1). 같은 지적을 묶어
적는다.

| 지적                                                                                  | 처리                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-5가 표지를 지우는데 9.0.20 기준의 remote-share smoke는 표지를 요구함(세 갈래 모두) | P2(#519)가 든 main 위로 옮김. 옮긴 뒤 smoke 단위 시험과 R1-5 Worker 행 다시 돌림(QA 라운드 3). P2 직후 운영 smoke 두 형태는 배포 조건(QA 라운드 6)                                                            |
| §4 현재 경계 줄 (1)의 '그 빌드'가 저장 바닥으로 읽힘                                  | `b7d91b2c`: '되돌릴 대상 App 빌드'                                                                                                                                                                            |
| RM-03 문장이 이른 `set` 실패 때의 규칙을 말하지 않아 첫 바닥의 0으로 읽힐 수 있음     | `b7d91b2c`: `set` 규칙(직전 검증 값으로 `lower`, smoke 다시, 0은 그때만)                                                                                                                                      |
| 잠든 방 참가자 절을 지키는 행이 없음                                                  | `38c0dee2`(시험만)                                                                                                                                                                                            |
| 선언된 메시지 종류가 테스트 먼저 커밋에서 바뀜                                        | 계획 행대로 받아들인 예외로 이 보고서에 적음('정확한 개수 가드')                                                                                                                                              |
| 9.0.21이 22곳에 적힘                                                                  | `513729f6`: 9.0.21 UI 후속 열차가 먼저 나가 9.0.22로 고침(Worker 주석 포함)                                                                                                                                   |
| §2 5B 호환의 '열차 3까지' 문장, Phase 5.5 승인 대기 문장, §4의 열차 3 항목            | 5B 문장은 `b7d91b2c`. 승인 대기 문장은 이미 남지 않음(9.0.20 기록이 승인을 적음). §4는 현재 경계 줄이 덮고, 이 릴리스의 §4 항목은 배포 기록 PR이 Release와 checkpoint ID와 함께 더함. §1 `:42`는 배포 기록 PR |
| RO-07의 '모양 동결' 문장                                                              | `b7d91b2c`: 선택 키 `timingMode`와 고정 행 셋                                                                                                                                                                 |
| RO-03이 모든 비슷한 예산을 보고만 쌍으로 적음                                         | `b7d91b2c`: 실제 셋(700 ms 둘, 3 s 하나), 1.5 s는 값을 나누지 않음                                                                                                                                            |
| R1-9 부모 실행, 계획 밖 포커스 증분, R1-6이 가져온 R2-1·R3-1 항목을 기록해야 함       | 이 보고서의 R1-9 절, '뺀 쌍', R1-6의 범위 이동                                                                                                                                                                |
| 런타임 경로 확인(App 24, PRO 2, signaling 2, 나머지 0, 계획 밖 경로는 포커스 증분뿐)  | 옮기고 포커스 쌍을 뺀 뒤 App 27(9.0.21 대비, bump 거울 넷 포함), PRO 2, signaling 2, 나머지 0                                                                                                                 |

## 스쿼시 메시지에 고칠 커밋 메시지 문장

커밋 메시지는 고치지 않았다(amend 없음). 스쿼시 메시지에서 다음을 바로잡는다: `8f71de2d`(R1-4), `8d532844`(R1-5), `455319cd`(R1-9),
`64ce7cf7`(R1-11)이 이 열차를 9.0.21로 적은 것은 9.0.22다. `04e43666`, `8c09d939`(R1-2), `7992781c`(R1-3), `8f71de2d`(R1-4)가 열차 앞
마지막 빌드를 9.0.20으로 적은 것은 9.0.21이다. `9d767021`이 F1 때 live를 9.0.20 빌드 793으로 예상한 것은 9.0.21 빌드 794다.

## 사용자가 알아챌 변화

- 업데이트 창(9.0.16 ~ 9.0.21 탭에는 '나중에'가 있는 보통 창).
- 그 밖에 화면이나 소리에 보이는 변화는 의도하지 않았다. 지운 필드는 9.0.15 이상이 읽지 않았고, v2 받기는 PRO Worker가 v2를 보내는
  R2 전에는 쓰이지 않는다. PRO presence/close 본문이 짧아진다.
- F1(이 릴리스 전 단계)부터 9.0.14와 9.0.15 탭은 새 입장과 재접속에서 거절되고 시작·전경 복귀 때 '나중에' 없는 업데이트 창을 본다.
  열린 세션은 닫히지 않는다.

## 기록과 레지스트리

- release-record §2: '9.0.22 배포 전' 항목(이 변경), 5B 호환의 OV-B05 문장(`b7d91b2c`). §4: 머리의 현재 경계 줄(`64ce7cf7`,
  `513729f6`, `b7d91b2c`), 릴리스 W 항목의 PRO 단서(`8f71de2d`). §1은 배포 기록 PR이 덮어쓴다.
- hotfix-procedure: presence/close 문단(R1-4), RM-03 문장(R1-11, `b7d91b2c`), Signaling 먼저 문장(R1-5). release-versioning: RM-03.
- known-accepted #12(R1-5), `cloudflare/standard-room-pin-ops.md`(R1-5), `docs/design/signaling-liveness.md`(R1-3, R1-5),
  `docs/design/pro-room-architecture-and-operations.md`(R1-4, `513729f6`).
- 레지스트리: RO-03, RO-31(R1-10), RO-04(R1-2), RO-15(R1-3), RO-07(`b7d91b2c`). 새 레코드는 없다.
- `docs/README.md` 증거 목록에 이 보고서. `release-history.md`는 배포 때.

## 초기 JS와 Worker 번들

bump 뒤 `build:checked`(`336a5133`): 진입 842.2 KiB raw / 247.9 KiB gzip, eager JS 456.5 KiB gzip, eager total 2,017.1 KiB raw /
534.1 KiB gzip, SW 앱 셸 95 자산. 9.0.21 bump(`a538da11`)의 eager JS 456.6 KiB gzip, eager total 2,017.4 / 534.1 KiB와 거의 같다. Worker
번들(`check:worker-bundles`, wrangler `deploy --dry-run`, 배포 없음): App 986.54 / gzip 201.52 KiB, PRO 방 832.49 / 163.22 KiB,
signaling 392.40 / 81.53 KiB, remote-share 150.40 / 33.39 KiB, Developer API 135.35 / 30.43 KiB, Developer API facade 94.26 /
21.08 KiB.

## QA 라운드

### 1. 증분별 (`edd6ee94` 위, 2026-10-29 06:28 ~ 15:11 KST, 옮기기 전)

Windows 11 로컬, Node 24.20.0 / npm 12.0.2, vitest `--maxWorkers=4`. 증분마다 테스트 먼저 커밋을 부모 코드에서 돌려 위 표의 행만
실패함을 봤고, 코드 커밋마다 계획의 기본 검사(단위 전체, typecheck, `check:workers`, lint, format, dead-exports, import-graph,
bus-pairing, lifecycle-writes, navigation-sinks, resource-ownership, room-authority-boundaries, transport-health, 핵심 커버리지, 빌드와
예산)를 돌렸다. `cloudflare/`가 바뀐 R1-5, R1-9, R1-10은 Worker 단위와 Worker 커버리지(`cloudflare/signaling-worker.ts` 85.42 /
83.27 / 95.85 / 89.22, `cloudflare/pro-room-worker.ts` 87.91 / 84.36 / 96.23 / 91.94, 모두 문턱 위)도 돌렸다. 핵심 커버리지
`src/network/system-audio-sfu.ts` 85.21 / 75.43 / 95.6 / 90.83(문턱 74 / 59 / 80 / 80), `src/pro-room/system-audio-service.ts`
66.63 / 59.10 / 70.80 / 70.44(문턱 50 / 40 / 56 / 53). 레인: R1-3·R1-5 뒤 C5-0 랩 `route-outage` 4 / 4, R1-4와 R1-6 뒤 로컬 PRO
Playwright 묶음 30 / 30(R1-6 뒤에는 고정값이 v1 와이어라 v1 → 메모리를 브라우저에서 거침). 마지막(`c058a98a`): 단위 698 files /
16,627 통과와 1 skip, Worker 69 files / 3,298, 핵심 커버리지 90 files / 3,515. `build:checked`는 `guard:sw-cache-version`에서만
멈췄다(bump 전이라 예상된 실패). R1-8의 첫 전체 실행에서 `sw-cache-version-guard.test.ts` 한 행이 git을 띄우다 15초 시간 제한에
걸렸고 혼자와 다시 돌린 전체에서 통과했다(이 열차와 무관한 흔들림).

### 2. 옮긴 부모에서 테스트 먼저 다시 (`3bfdffcb` 위, 2026-10-29 16:43 ~ 16:50 KST)

옮긴 SHA마다 임시 분리 워크트리를 테스트 먼저 커밋의 부모로 두고 그 커밋이 바꾼 파일만 얹어 그 시험 파일을 돌렸다(Node 24.22.2,
vitest `--maxWorkers=4`). 결과는 '증분 한눈에' 표와 같고 실패 행 이름도 처음 실행과 같다.

| 테스트 먼저 | 부모       | 돌린 시험 파일                                                                                       | 실패 / 전체                   |
| ----------- | ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| `be179131`  | `3bfdffcb` | `host`, `decode`                                                                                     | 4 / 146                       |
| `04e43666`  | `43e8c7f5` | `protocol-validation-coverage`, `system-audio-sfu`, `system-audio-start`                             | 3 / 79                        |
| `ec435867`  | `8c09d939` | `cloudflare-signaling`, `room-expiry-liveness`                                                       | 3 / 256                       |
| `068dc4e8`  | `7992781c` | `cloudflare-signaling-worker`, `cloudflare-signaling`                                                | 4 / 573                       |
| `fac20e64`  | `8d532844` | `api`, `pro-room-worker`, `runtime-presence-close`                                                   | 2 / 695                       |
| `b95dd9c0`  | `d456f28c` | `pro-room-burst`, `api`, `domain`, `runtime-account-lease`                                           | 29 / 218                      |
| `552f4e34`  | `97c07685` | `api`, `runtime-server-playback`                                                                     | 10 / 286                      |
| `02a7ca93`  | `02637ffa` | `api`, `pro-room-worker`, `system-audio-contract`, `system-audio-controller`, `system-audio-service` | 16 / 835                      |
| `860658fc`  | `3b859d3f` | `pro-room-signaling-delivery`, `pro-room-worker`                                                     | 6 / 603                       |
| `aa40652a`  | `455319cd` | `resource-ownership-guard`, `pro-room-playback-timing`                                               | 새 묶음 불러오기 실패, 1 / 49 |

- 실패 행은 모두 새로 넣거나 바꾼 행이다. R1-2의 원시 표지 행, R1-5의 약한 비밀 응답 행, R1-8의 null SFU live 거절 행, R1-9의 SFU 울타리
  행처럼 양쪽 통과를 뜻한 짝 행은 부모에서도 통과했다. R1-6의 29행은 `domain` 10, `api` 11, `runtime-account-lease` 1, `pro-room-burst`
  7(명단 단언 줄이 파싱한 presence의 `coordinatorParticipantId: null`을 봄)이다.
- 잠든 방 행: `38c0dee2` 그대로 `domain.test.ts` 46 / 46 통과, `snapshot.ts`의 잠든 방 참가자 절 한 줄만 지운 트리에서 44 / 46(새 두 행만
  실패).
- 임시 워크트리는 끝난 뒤 지웠다.

### 3. 옮긴 뒤 전체 검사 (`b7d91b2c`, 2026-10-29 15:38 ~ 16:11 KST, bump 전)

Node 24.22.2 / npm 12.0.2(main의 고정값), vitest `--maxWorkers=6`. `npm audit` 0, 단위 702 files / 16,684(skip 0), Worker 커버리지
69 files / 3,311(전체 86.69 / 83.54 / 94.31 / 90.96), typecheck 전체, `check:workers`, lint, `format:check`, 가드(dead-exports 0 /
20 / 76, import-graph 399 files / 2,077 edges / 순환 0, bus-pairing 203 / 203, lifecycle-writes, navigation-sinks, room-authority
79 / 22 / 13 / 0, transport-health, standard-room-hot-path, chunk-pump, resource-ownership 49 records / 446 files), 핵심 커버리지 90
files / 3,515(80.89 / 75.63 / 86.86 / 84.74), release-tooling 커버리지 14 files / 433, `guard:sw-cache-version`을 뺀 `build:checked`,
후보 E2E 19 / 19, critical E2E 98 / 98, PRO Playwright 30 / 30, C5-0 랩 `route-outage` 4 / 4, smoke 단위 시험(`live-remote-share-smoke-lifetime`,
`live-smoke-app-build`, `live-smoke-rate-limit-retry`, `live-signaling-smoke-readiness`, `tooling-contracts`, `release-deployment-state`)
6 files / 208, Worker 설정의 remote-share와 smoke 시험 3 files / 126, R1-5 Worker 행(`cloudflare-signaling-worker`, `cloudflare-signaling`,
`signaling-liveness`) 3 files / 579. 실패는 둘이고 둘 다 실제 실패가 아니다: `guard:sw-cache-version`(bump 전이라 예상됨),
`check:worker-bundles`(어떤 빌드보다 먼저 돌아 `dist/`가 없었음, 'dist/ is required for the App Worker dry-run'. 라운드 4에서 통과).

### 4. bump 뒤 검사 (`336a5133`, 9.0.22 / v795, 2026-10-29 16:11 ~ 16:21 KST)

`guard:release-identity` 9.0.22 / v795, `guard:sw-cache-version` PASS(v795 `336a5133`), `build:checked` 전체(앞의 '초기 JS와 Worker
번들' 값, SW 앱 셸 95 자산, 레거시 TV 정적 검사, prod-hooks, prod-security, 글꼴), `check:worker-bundles` 여섯 Worker, 후보 E2E 19 / 19,
단위 702 files / 16,684, Worker 69 files / 3,311, typecheck 전체, `format:check`. 모두 통과.

### 5. 보고서·기록 커밋 뒤 전체 검사 (FINAL_GATE_HEAD)

FINAL_GATE_DETAILS

### 6. 운영 전제: P2 smoke, F1, F1 신호 입장 smoke (자리, 배포 전에 채움)

- P2 직후 운영 remote-share smoke 두 형태: 돌린 main SHA, 시각, 각 마지막 JSON 줄의 `ok`, `anonymousSessionRejected`,
  `assertionRequiredBySmoke`, `assertionExplicitlyRequested`(false, true), `roomUploadAssertionMode`, `wholeObject`. (아직)
- F1 앞 공개 status(저장, 유효, revision, live, 보고 시각과 나이). (아직)
- F1 실행: `status` run ID와 요약 줄, 같은 값 `set 787` run ID와 'the stored floor is already 787; verifying it'과 요약 줄,
  `set 789` run ID와 'set to 789: changed (revision 1 before)'와 요약 줄, 뒤 `status` 요약 줄. 일시적 답 줄이 있었으면 그것도. (아직)
- F1 직후 신호 입장 smoke: 시각, 체크아웃 SHA, 종료 코드, `appBuild.build`, 두 방의 입장·재접속·offer·answer, `refusedBelowAppBuildFloor`
  789(방 코드는 적지 않음). 다시 돌렸으면 이유와 횟수. (아직)
- `lower`를 했다면 그 run과 `lower` 뒤 smoke. (해당하면)
- dispatch 직전 status 다시 읽기(저장·유효 789, 보고 나이). (아직)

### 7. PR CI, 자동 코드 리뷰, exact-main CI, 배포와 공개 확인 (자리)

PR 번호와 head, PR CI, 자동 코드 리뷰, 스쿼시 SHA, exact-main CI, Release run과 attempt, 여섯 Worker 버전, 릴리스 안 신호 smoke의
`refusedBelowAppBuildFloor`, 공개 확인(저장·유효 789, live App 795), Drift Audit. (아직)

## 오너 기기 확인 후보 (게이트 아님)

기기 확인은 블라인드로 한다. 아래 절차와 기준을 먼저 적어 두고, 확인하는 사람에게는 절차만 주고 관찰값만 받아 이 기준과 견준다.

1. PRES-1: 9.0.22 PRO 방에 두 기기로 들어가 한 기기의 탭을 닫는다. 다른 기기의 참가자 목록에서 그 기기가 언제 빠지는지 본다. 기준:
   45초 presence 만료를 기다리지 않고 곧 빠진다(9.0.21까지와 같음).
2. SAC-1 회귀 신호: 같은 LAN의 일반방에서 9.0.22 게스트가 시스템 오디오를 받는 중 직접 경로가 실패하게 한다. 기준: 방장이 SFU로
   넘긴다(STOP으로 끝나지 않음).

## 확인하지 않은 것

- 운영: P2 직후 remote-share smoke 두 형태, F1, F1 직후 신호 입장 smoke, 이 릴리스의 배포와 그 안의 smoke(QA 라운드 6, 7은 자리).
- 신호 Durable Object 재시작 쓸기는 Cloudflare 문서상 동작이고 이 프로젝트에서 확인하지 않았다.
- 실기기, iOS Safari, WebKit 레인 전체, Full E2E. 9.0.14, 9.0.15 끝과 9.0.22의 혼합 방은 바닥이 들이지 않아 돌리지 않았다(정책 수용 창의
  손실은 코드와 시험으로만 봄).
- PRO 스냅샷 v2, `timingMode`, null `liveExpiresAt`을 실제로 보내는 PRO Worker는 아직 없다(R2). 이 릴리스의 받기 쪽은 단위 시험과
  in-process Worker 왕복 행으로만 봤고, e2e PRO 고정값은 아직 v1 와이어다(R3가 v2로 바꿈).
- 2.3 s 준비 예산과 공유 시간 집의 순서 시험(Phase 0d C2-1로 미룸).
