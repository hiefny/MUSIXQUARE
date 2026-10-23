# Phase 3 배포 묶음 — 업데이트 경로와 일반방 만료 복구 (2026-10-24)

| 항목 | 범위 |
| --- | --- |
| 기준 | `f5bcafec` (9.0.4 배포 기록 main) |
| 상태 | PR 후보. 오너 결정에 따라 Phase 3와 함께 배포하며, 이 증분의 단독 배포는 하지 않는다. |
| 현재 증분 | 일반방의 명시적 만료 뒤 자동 신호 재접속 중단, 기존 재생 보존, 내부 진단 세분화 |
| 제품 식별 | 이 증분은 `9.0.5` / `v773`. Phase 3 후속 증분은 릴리스 식별 가드에 따라 올리고 최종 배포 값을 여기에 갱신한다. |
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

### 내부 진단

- 클라이언트의 기존 소켓 진단에 허용 목록의 종료 사유, 최초 입장/복구 구간, RTC 생존,
  자동 재시도 차단 사유를 추가한다. 임의의 종료 문자열·방 코드·계정·PIN·인증 토큰을
  새 진단 필드에 싣지 않는다. 기존 로컬 진단 보존 정책을 사용한다.
- 기존 `guest_host_unavailable` 총합을 유지하고 `reclaim_grace`, `host_auth_pending`,
  `no_active_host` 세 상태로 나눈다. 합계와 하위 상태는 한 D1 upsert로 함께 기록한다.
  DB 요청 수는 같지만 하위 상태 행의 기록량은 추가된다.
- 기존 방 정리 경로가 성공한 뒤 `standard_room_expired`를 한 번 기록한다. 게스트 수나
  장애 사용자 수를 뜻하지 않는다. 기존 비동기·best-effort 집계 정책을 유지한다.
- 새 이벤트는 관리자 API의 기존 24시간·시간별·일별 집계에 포함된다. 현재 Signals 카드의
  Host missing 합계는 유지한다. 세부 이벤트 정의와 읽을 위치는
  [운영 지침](../../cloudflare/admin-dashboard-ops.md)에 기록한다.

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
| Worker·관리자 API | 2파일 597 tests PASS 후 마지막 게스트 종료 회귀를 추가한 Worker 318 tests PASS. 기존 합계와 세부 상태의 같은 upsert, 만료 정리 후 1회 집계, 관리자 API allowlist를 검증했다. |
| 타입·정적 검사 | 전체 typecheck·lint·format PASS. 수정한 Worker의 후속 타입 검사, Transport의 후속 lint·format도 PASS. import graph, dead exports, bus pairing, resource ownership, navigation, lifecycle, Standard hot path, D1·ops 계약 가드 PASS. |
| 프로덕션 빌드 | 위 SHA의 `build:checked` PASS. 초기 JS 479.7 KiB gzip, 초기 전체 556.4 KiB gzip으로 예산과 최소 여유 5% 유지. 캐시 epoch와 bootstrap 경로는 함께 v773이다. |
| Chromium 기존 재생·연결 | 위 SHA에서 `build:e2e` 후 playback-sync·reconnection 9/9 PASS. 재생·일시정지, 재생목록 동기화, 게스트 종료 뒤 호스트 상태 보존, 새 게스트 입장과 명시적 나가기. 로컬 PeerJS 기반이므로 운영 Cloudflare 만료의 실기기 검증은 아니다. |
| PR CI | [PR #471](https://github.com/hiefny/MUSIXQUARE/pull/471)의 최종 head checks를 따른다. 로컬·PR 결과는 배포 시 필요한 exact-main-SHA CI 후보를 대신하지 않는다. |

명시적 만료 자체의 검증은 fake WebSocket/WebRTC·Worker와 jsdom 기반이다. 실제 기기의
음향 연속성, 운영 WSS·HTTPS·백그라운드 조합은 SKIP이며 아래 배포 전 확인 범위로 남긴다.

## 배포·회복

Phase 3 전체의 App·signaling 변경을 포함하는 대상과 exact-main CI 후보를 최종 확인한다.
이 변경만으로 PRO나 개발자 API의 새 계약은 생기지 않는다. 기존 릴리스 절차와 PRO·App
forward floor를 그대로 따른다. 되돌릴 경우 이전 클라이언트 재시도와 기존 단일 집계가
돌아오며, 추가한 집계 행은 남겨도 이전 코드가 무시한다.

운영·실기기에서는 정상 재생 중 명시적 만료, 일반 네트워크 단절, 만료 뒤 foreground 복귀,
WSS·HTTPS 종료 이유 전달, 안내 확인과 명시적 새 입장을 확인해야 한다. 운영 데이터나
서비스에 장애를 주입하는 검사는 이번 로컬 검증에 포함하지 않았다.

관련 계약: [신호 생존과 복구](signaling-liveness.md#explicit-standard-room-expiry),
[자원 소유권](resource-ownership-registry.md#checked-side-flows-without-a-record),
[현재 릴리스 기록](../release-record.md).
