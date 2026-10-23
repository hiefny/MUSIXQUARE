# Phase 3 배포 묶음 — 업데이트 경로와 일반방 만료 복구 (2026-10-24)

| 항목 | 범위 |
| --- | --- |
| 기준 | `f5bcafec` (9.0.4 배포 기록 main). 리뷰 반영 라운드는 main `08003954`(문서만)를 합친 트리 |
| 상태 | PR 후보. 오너 결정에 따라 Phase 3와 함께 배포하며, 이 증분의 단독 배포는 하지 않는다. |
| 현재 증분 | 일반방의 명시적 만료 뒤 자동 신호 재접속 중단, 기존 재생 보존, 내부 진단 세분화, 6렌즈 리뷰 반영(새 입장의 재접속 표시, 안내 문구·용어, 초대 버튼 상태 표시, 진단 종료 사유) |
| 제품 식별 | 이 증분은 `9.0.5` / `v774`. 9.0.5는 아직 배포하지 않았으므로 리뷰 반영 뒤 SemVer는 그대로 두고 SW 캐시 epoch만 v773에서 v774로 올렸다. Phase 3 후속 증분은 릴리스 식별 가드에 따라 올리고 최종 배포 값을 여기에 갱신한다. |
| 환경 | Windows 로컬, Node 24.20.0 / npm 12.0.2, fake WebSocket/WebRTC·Worker 및 jsdom 검사 |
| 운영 | 이 보고서의 후보는 배포하지 않았다. 실제 기기·운영 장애 주입은 미실행이다. |

이 문서는 Phase 3의 같은 배포에 실리는 증분과 QA를 함께 기록한다. 아직 작업하지 않은
SW 업데이트 경로 증분의 완료나 검증을 주장하지 않는다. 후속 Phase 3 증분은 같은 보고서에
코드 SHA와 검증 범위를 추가한다.

## 제품·런타임 증분

### 일반방의 명시적 만료

현재 소유한 Standard 게스트 소켓에서 정확히 `1012 / ROOM_EXPIRED`를 수신하면 그 입장의
자동 신호 복구를 멈춘다. 이미 예약된 재시도와 단절 안내 대기도 기존 `peer.ts` 주인이
취소한다. 공급자는 입장의 만료 사유를 보존하며 새 재시도·감시 타이머를 만들지 않는다.
만료 소켓의 뒤늦은 이벤트는 후속 소켓의 상태를 바꾸지 않는다.

기존 RTC 연결, 음악 재생, 재생목록은 이 상태 전환으로 종료하지 않는다. 이후 실제
데이터 연결이 끊기면 기존 연결 생존 판정과 종료 흐름이 처리한다. Connect 영역은 만료를
표시하며 사용자가 선택한 새 입장만 새로운 입장 상태를 만든다. 안내를 열거나 닫는
행동만으로 재생을 멈추지 않는다.

일반 연결 끊김, 다른 `1012` 사유, 명시적 만료 없는 `HOST_NOT_AVAILABLE`, PRO 복구는 기존
정책을 유지한다. WSS와 HTTPS 브리지는 동일한 종료 사유 경계를 사용한다. 종료 이유를
받지 못한 통신 오류는 만료로 추정하지 않는다.

**수용한 동작 변경:** 원래 방장이 120초 유예 뒤 같은 코드로 다시 방을 만들더라도,
명시적 만료를 받은 게스트는 자동으로 새 방에 입장하지 않는다. 살아 있는 이전 RTC는
유지하고 새 입장은 사용자 선택으로 한다. 같은 코드는 같은 방 생명주기를 보장하지 않는다.

**새 입장은 재접속(오너 결정 2026-10-24):** 만료 안내의 "새로 입장"은 방의 `/CODE` 시작
화면으로 돌아가며 재접속 표시(`reconnect: true`)를 남긴다. `HOST_DISCONNECTED` 재연결과
SW 업데이트 복귀가 쓰는 것과 같은 처리다. 만료는 방장이 유예 시간을 넘겨 없었다는 뜻이므로,
시작 화면에서 입장했는데 방장이 아직 없으면 "코드를 다시 확인해 주세요"가 아니라
`error.host_left`("방장이 세션을 종료한 것 같아요")를 보인다. 계정 활동 통계는 이 입장을
새 세션이 아니라 이어지는 세션으로 센다. 시작 화면에서 사용자가 한 번 눌러야 입장하는
흐름은 그대로다.

**안내 문구와 표시(오너 결정 2026-10-24):**

- 한국어 초대 버튼·대화상자 제목은 동작이 아닌 상태로 읽히도록 "방 연결이 끝났어요"로 바꿨다.
- 안내 본문의 마지막 문장은 42개 언어 모두 "새로 입장하면 현재 세션과 연결이 끊어지고 재생이
  멈춰요"의 뜻으로, 각 언어의 `dialog.return_home_detail` 표현을 그대로 써서 고쳤다. 고정된
  "현재 재생은 유지돼요"와 "새로 입장"은 바꾸지 않았다.
- 파일의 기존 용어에 맞췄다: fr salon, it Rientra, ro Intră din nou, uk Приєднатися знову·
  Повторне приєднання, pa ਰੂਮ, kn ರೂಮ್, fil kuwarto, gu પ્લેબૅક. gu의 "새로 입장" 버튼은
  "다시 연결" 버튼과 같은 문구였으므로 `રૂમમાં ફરી જોડાઓ`로 구분했다.
- 만료 상태의 초대 버튼은 오너가 고른 중립 회색 표시를 유지한다. 대신 복사 모드의 라이트 테마
  hover·active 규칙과 터치 기기의 hover 해제 규칙에 `data-mode='expired'`를 같은 specificity로
  더했다. 라이트 테마 hover에서 글자 대비가 약 4.15:1로 AA 기준에 못 미치던 문제와, 터치
  기기에서 안내를 닫은 뒤 hover 배경이 남던 문제가 없어지고 복사 모드와 같게 보인다.

### 내부 진단

- 클라이언트의 기존 소켓 진단에 허용 목록의 종료 사유, 최초 입장/복구 구간, RTC 생존,
  자동 재시도 차단 사유를 추가한다. 임의의 종료 문자열·방 코드·계정·PIN·인증 토큰을
  새 진단 필드에 싣지 않는다. 기존 로컬 진단 보존 정책을 사용한다.
- 허용 목록은 `ROOM_EXPIRED`, `PRO_ROOM_EPOCH_ADVANCED`, `HOST_REPLACED`, `GUEST_REPLACED`다.
  리뷰 전 목록의 `PRO_COORDINATOR_EPOCH_ADVANCED`는 2026-07-20 이후 어떤 Worker도 보내지
  않는 이름이라 실제 이름으로 바꿨다. 소스 parity 테스트가 목록의 모든 사유를 signaling
  Worker의 `1012` 종료 사유와 대조한다. 진단 전용이며, 만료 판정과 PRO epoch 처리기의 비교문은
  그대로다. Standard `1012` 사유 3개(`STANDARD_ROOM_AUTHORITY_STALE`,
  `GUEST_AUTH_RETRY_REQUIRED`, `SERVICE_MAINTENANCE`)는 초기 묶음에서 79 B(gzip)가 들어
  여유를 지키려고 넣지 않았고 `unknown`으로 남는다.
- 기존 `guest_host_unavailable` 총합을 유지하고 `reclaim_grace`, `host_auth_pending`,
  `no_active_host` 세 상태로 나눈다. 합계와 하위 상태는 한 D1 upsert로 함께 기록한다.
  DB 요청 수는 같지만 하위 상태 행의 기록량은 추가된다.
- 기존 방 정리 경로가 성공한 뒤 `standard_room_expired`를 한 번 기록한다. 게스트 수나
  장애 사용자 수를 뜻하지 않는다. 기존 비동기·best-effort 집계 정책을 유지한다.
- 새 이벤트는 관리자 API의 기존 24시간·시간별·일별 집계에 포함된다. 현재 Signals 카드의
  Host missing 합계는 유지한다. 세부 이벤트 정의와 읽을 위치(`/api/admin/metrics` JSON의
  `summary`, D1 `mxqr_metric_buckets`)는 [운영 지침](../../cloudflare/admin-dashboard-ops.md)에
  기록했다. 같은 지침은 이벤트 목록을 22개로 고치고, `guest_host_unavailable`을 admission
  시점에 거절된 새 게스트 연결로 좁혀 적었다. 인증 대기 중 방장이 사라져 거절된 경우는
  이전처럼 집계하지 않는다.

새 D1 스키마·바인딩·비밀·주기적 클라이언트 통신은 없다. 서버 상태 분류는 의도적 종료와
네트워크 장애를 확정하지 않으며, 고유 사용자·고유 영향 방 수를 산출하지 않는다. 변경 전
집계는 소급 분류할 수 없고, 이전 앱은 배포 뒤에도 갱신 전까지 기존 재시도를 할 수 있다.

## QA 라운드

### 1. 구현·독립 리뷰 (2026-10-24)

기준 `f5bcafec` 위 작업 트리에서 만료 처리, 기존 복구와의 분리, UI, 집계를 각각 검증했다.
리뷰에서 만료로 취소된 ICE 후보가 일반 오류 알림으로 전파되는 경로와 마지막 게스트
종료가 알람보다 먼저 오는 경우 만료 집계가 빠지는 경로를 발견했다. 회귀를 재현하고
수정했으며, 최종 런타임은 `2d4090be8b808887f1e35e6dd6bbfb4b8ee2a500`에 기록했다.
초기 전체 테스트 실행은 수정 전후 작업 트리를 읽었으므로 최종 후보 통과 근거로 쓰지 않는다.

### 2. 최종 코드 검증 (2026-10-24)

검증 대상 코드는 `2d4090be8b808887f1e35e6dd6bbfb4b8ee2a500`이다. 이후 이 보고서에
결과를 적는 문서 커밋은 런타임을 바꾸지 않는다. 로컬 환경은 Windows, Node 24.20.0 /
npm 12.0.2다.

| 검사 | 결과와 범위 |
| --- | --- |
| Transport 회귀 | 2파일 218 tests PASS. WSS·HTTPS 명시적 만료, 기존 RTC 보존, 일반 단절·PRO 제외, 늦은 이벤트, 새 입장, 대기·후발 ICE 후보 취소와 일반 오류 보존. 최종 파일 내용으로 검증 후 위 SHA에 기록했다. |
| Peer·health·UI·번역 | 4파일 180 tests PASS. 예약된 retry/grace 취소, 수동·foreground·늦은 이벤트 차단, 재생·시스템 오디오 상태 보존, 명시적 새 입장, 42개 언어 키. |
| Worker·관리자 API | 최종 파일 내용으로 app-worker-cors 280 + signaling-worker 318 = 598 tests PASS(리뷰가 같은 런타임의 `e63aae43`에서 재확인). 처음 기록한 597은 마지막 게스트 종료 회귀를 추가하기 전 트리다. 기존 합계와 세부 상태의 같은 upsert, 만료 정리 후 1회 집계, 관리자 API allowlist를 검증했다. |
| 타입·정적 검사 | 전체 typecheck·lint·format PASS. 수정한 Worker의 후속 타입 검사, Transport의 후속 lint·format도 PASS. import graph, dead exports, bus pairing, resource ownership, navigation, lifecycle, Standard hot path, D1·ops 계약 가드 PASS. |
| 프로덕션 빌드 | 위 SHA의 `build:checked` PASS. 초기 JS 479.7 KiB gzip, 초기 전체 556.4 KiB gzip으로 예산과 최소 여유 5% 유지. 캐시 epoch와 bootstrap 경로는 함께 v773이다. |
| Chromium 기존 재생·연결 | 위 SHA에서 `build:e2e` 후 playback-sync·reconnection 9/9 PASS. 재생·일시정지, 재생목록 동기화, 게스트 종료 뒤 호스트 상태 보존, 새 게스트 입장과 명시적 나가기. 로컬 PeerJS 기반이므로 운영 Cloudflare 만료의 실기기 검증은 아니다. |
| PR CI | [PR #471](https://github.com/hiefny/MUSIXQUARE/pull/471) head `e63aae43`의 [CI 40003267959](https://github.com/hiefny/MUSIXQUARE/actions/runs/40003267959) 11/11 jobs success. 리뷰 반영 뒤 head는 다시 CI를 받는다. 로컬·PR 결과는 배포 시 필요한 exact-main-SHA CI 후보를 대신하지 않는다. |

명시적 만료 자체의 검증은 fake WebSocket/WebRTC·Worker와 jsdom 기반이다. 실제 기기의
음향 연속성, 운영 WSS·HTTPS·백그라운드 조합은 SKIP이며 아래 배포 전 확인 범위로 남긴다.

### 3. 6렌즈 리뷰 반영 검증 (2026-10-24)

6렌즈 리뷰와 적대 검증은 P1·P2 없이 P3·P4를 냈고, 오너 결정(2026-10-24)대로 모두 반영했다.
오너가 "싸면" 넣으라고 한 Standard `1012` 사유 3개만 초기 JS 79 B가 들어 넣지 않았다.
머지 시점(지금 또는 Phase 3 준비 때)은 오너가 정한다.
반영 커밋은 `2920f9bd`(새 입장 재접속, 문구·용어, 초대 버튼 상태 표시, 번역·연결·레이아웃
테스트), `81c046f9`·`5411b2b6`(진단 허용 목록과 parity 테스트), `18c4340d`(테스트 이름),
`db0954eb`(문서), `d4849257`(SW 캐시 v774)이다. 검증 대상 코드는
`d48492572c1569aa740db2edc9e526a94e117e71`(마지막 런타임 커밋, main `08003954` 포함)이고,
이후 이 표를 적는 문서 커밋은 런타임을 바꾸지 않는다. 환경은 Windows 로컬, Node 24.20.0 /
npm 12.0.2, E2E는 로컬 Chromium·PeerJS(포트 4291/9131)다.

| 검사 | 결과와 범위 |
| --- | --- |
| 타입·정적 검사 | `typecheck`, `lint`, `format:check`, `check:workers`(D1·ops 계약 포함) PASS. `check-resource-ownership` 46 records PASS(기준 수치 변화 없음), `guard:navigation-sinks` PASS(location navigation 6). |
| 단위 전체 | `vitest run --maxWorkers=6` 643 files / 14,694 tests PASS, FAIL 0, SKIP 0. |
| Worker 전체 | `vitest.workers.config.ts` 60 files / 2,888 tests PASS. 새 parity 테스트는 Worker 소스를 읽기만 하므로 단위 전체에서 돈다. |
| 번역·연결 | `translations.test.ts`·`connect-i18n.test.ts` 2 files / 134 tests PASS. 안전 구분 테스트가 42개 언어 전체를 돌고, 열린 실패 대화상자가 같은 boundary에서 만료 대화상자로 바뀌는 테스트는 해당 분기를 지우면 실패함을 확인했다. |
| 프로덕션 빌드 | `build:checked` 전체 PASS(가드 24개, `guard:sw-cache-version` "v774 (d4849257) covers all committed PWA runtime changes", legacy TV CSS 포함). 초기 JS 491,251 B gzip(PR 491,227 B 대비 +24 B, 유지 상한 491,568 B까지 317 B), 초기 전체 569,825 B(상한 570,570 B까지 745 B). Standard `1012` 사유 3개를 넣은 빌드는 491,310 B였다. |
| Chromium | `build:e2e` 후 `test:e2e:critical` 59/59 PASS(adaptive-actions 포함), `e2e/adaptive-actions.test.ts` 단독 10/10 PASS(만료 라벨과 "새로 입장" 버튼을 42개 언어·RTL·320px·200% 글자에서 넘침 검사), playback-sync·reconnection 9/9 PASS. |
| SKIP | 실제 기기, 운영 Cloudflare WSS·HTTPS 만료, 백그라운드 복귀, 새 입장에서 방장이 없을 때의 실제 문구, `/api/admin/metrics` 새 카운터는 배포 전 범위로 남긴다. 리뷰 반영 head의 PR CI는 아직 돌지 않았다. |

## 초기 JS 예산

실제 빌드로 잰 초기 JS(gzip)는 main 490,339 B에서 이 PR 491,227 B로 888 B 늘었다. 유지 상한
491,568 B(517,440 B의 95%)까지 341 B가 남고, 9.0.4 이후 남아 있던 여유의 약 72%를 이 증분이
썼다. 초기 전체는 상한 570,570 B까지 804 B 남는다. 리뷰 반영 뒤(`d4849257`)에는 초기 JS
491,251 B로 317 B, 초기 전체 569,825 B로 745 B가 남는다(QA 라운드 3).

앞으로 들어올 Phase 3 증분(SW 업데이트 경로의 `sw-register.ts`, 각진 선택 표시의
`selection-mark.ts`)은 모두 초기 묶음에 들어간다. Phase 3 증분은 이 여유로 측정하며, 넘으면
줄이기 또는 [측정 기준 재설정](initial-bundle-loading-policy.md#reconsideration-criteria)을
오너가 정한다. 상한을 조금만 넘어도 `build:checked`가 "Initial transfer budget exceeded"로
실패하므로, 묶은 빌드의 `build:checked`를 다음 증분 착수 전에 잰다.

## 배포·회복

배포 대상은 target `all`만 가능하다. 이 증분은 App 런타임 입력(`src`, `browser`, App Worker,
`package.json`, SW 캐시)과 signaling 런타임 입력(`cloudflare/signaling-worker.ts`)을 함께
바꾼다. 그래서 부분 게이트(`verifyPartialReleaseCompatibility`)가 app 단독과 signaling 단독을
첫 배포 단계 전에 거부하고, `release.yml`에는 app+signaling 조합이 없다. 순서는 `all`의 표준
순서인 PRO room → remote-share → signaling → Developer API → App이다. Phase 3의 SW 업데이트
증분도 같은 Release 실행에 싣는다. 업데이트 창이 뜨는 배포이므로 직전에 오너 확인이 필요하고,
exact-main CI 후보는 배포 직전에 다시 확인한다.

main에 머지된 뒤 Phase 3 전에 다른 배포가 필요해지면, exact-main 규칙과 부분 게이트 때문에 이
증분을 함께 `all`로 보내거나 먼저 되돌려야 한다. 그때 어느 쪽인지는 오너가 정한다.

이 변경만으로 PRO나 개발자 API의 새 계약은 생기지 않는다. 기존 릴리스 절차와 PRO·App
forward floor를 그대로 따른다. 되돌릴 경우 이전 클라이언트 재시도와 기존 단일 집계가
돌아오며, 추가한 집계 행은 남겨도 이전 코드가 무시한다. 되돌리는 커밋도 PWA 런타임 변경이라
새 SW 캐시 bump가 필요하다.

운영·실기기에서는 정상 재생 중 명시적 만료, 일반 네트워크 단절, 만료 뒤 foreground 복귀,
WSS·HTTPS 종료 이유 전달, 안내 확인과 명시적 새 입장(방장이 없을 때 "방장이 세션을 종료한
것 같아요" 문구 포함), `/api/admin/metrics`의 새 카운터 4개를 확인해야 한다. 운영 데이터나
서비스에 장애를 주입하는 검사는 이번 로컬 검증에 포함하지 않았다.

관련 계약: [신호 생존과 복구](signaling-liveness.md#explicit-standard-room-expiry),
[자원 소유권](resource-ownership-registry.md#checked-side-flows-without-a-record),
[현재 릴리스 기록](../release-record.md).
