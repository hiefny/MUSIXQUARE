# 베타 결함 발굴 4차 및 D01 수정 — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Dated evidence — 추가 확정 0건, 기존 D01 베타 수정 |
| Applies to | `mxqr_beta`의 마지막 추가 발굴과 미해결 항목 정리 |
| Discovery checkout | `4b535bbba17dd31b7d2f405d272ccaed5a5a049b` |
| Discovery runtime | `3dd9086cdced0fc25426da82239977b6da004074` |
| Repair source | `2347760c5e5b902327a05ca216c8b72409ee72d3` |
| Environment | Windows, Node 24.20.0, Vitest 5, jsdom·모사한 미디어/네트워크, 로컬 Chromium |
| Related documents | [배포 준비 기록](../beta-release-readiness-archive-2026-10-10.md), [D01 발굴](beta-defect-harvest-2026-09-27-round-3.md) |

사용자는 추가 발굴에서 새 결함이 더 없으면 기존 미해결 항목을 수정하고
마무리하도록 요청했다. 범위를 나누어 추가 조사했으나 **새 독립 확정
결함은 0건**이었다. 이후 남아 있던 D01을 수정했다. 이미 수정한 B01–B04,
C01–C03과 D01의 같은 원인 변형을 새로운 결함으로 늘리지 않았다.

## 추가 발굴 결과

| 범위 | 검토한 경계 | 결과 |
| --- | --- | --- |
| 파일·전송 | PRO 업로드/다운로드 취소, 권한 회수, immutable asset 캐시, 선택 변경, remote foreground/preload 인계 | 새 확정 0건 |
| 입장·화면·설정 | QR 카메라 획득/인식 중 취소, 초대 링크와 iOS 활성화, OAuth/PWA 복귀, bfcache, 설정 동기화 재접속 투영 | 새 확정 0건 |
| 방·권한 | 계정/presence 재진입, 권한 회수·재부여 중 명령/큐 변경, PIN·탭 인계, 이전 접속 콜백, YouTube 추가 순서 | 새 확정 0건 |

검토한 경로에는 세대·요청 소유권·소스 identity·취소 후 재검사가 있었다.
이를 우회하는 실제 사용자 순서와 정상 대조군을 입증하지 못한 의심은
결함으로 승격하지 않았다. 일반 다이얼로그 뒤에서 다른 방으로 이동하는
가설도 유효한 사용자 경로가 부족해 제외했다.

발굴 단계 집중 회귀는 미디어 8파일/75개, 화면 7파일/137개, 방 7파일/125개
실행이 모두 통과했다. 두 담당자가 공통으로 실행한
`runtime-media-mutation-authority.test.ts`의 9개를 제외하면 **21개 파일·328개
고유 테스트**, 실패·skip 0개다. 진행 중 안내의 22파일/337개는 중복을 포함한
실행 수이며, 이전 회차 결과와 합산하지 않는다.

정확한 파일 목록 (`.test.ts`):

- `src/pro-room/__tests__/`: `media-transfer`, `media-cache`, `upload-queue`,
  `runtime-media-mutation-authority`, `runtime-preload`, `runtime-preload-reorder`,
  `runtime-account-lease`, `luna-playback-controller-ordering`, `pin-rotation`,
  `tab-handoff`, `settings-sync-retry`.
- `src/share/__tests__/`: `remote-download-lifetime`, `remote-upload`.
- `src/ui/__tests__/`: `setup-qr-scanner`, `setup-host-invite`, `setup-guest-recovery`.
- `src/account/__tests__/`: `login-return`.
- `src/core/__tests__/`: `page-lifecycle`.
- `src/audio/__tests__/`: `effects`.
- `src/network/__tests__/`: `luna-session-ordering`, `queue-mutation-authority`.

실행은 Node 24.20.0의 `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`.
로컬 원본은 `scratch/qa-harvest4-2026-09-27/{media,surface,rooms}/`에 있다.
이 결과는 유한한 코드·모듈 검토이며 모든 기기·장기 세션의 무결함 보증이 아니다.

## D01 수정

[PRO playback controller](../../src/pro-room/playback-controller.ts)에 자동
스냅샷 복원 전용 소유권을 추가했다. 현재 방의 live 공유를 관측하면
기존 복원 소유권이 영구히 무효화되고 신규 자동 복원도 차단된다.

- 시계 보정뿐 아니라 파일/iframe 준비와 commit의 비동기 경계까지 같은
  소유권을 전달한다. 뒤늦게 완료된 작업이 공유 수신 준비를 덮지 못한다.
- 공유가 재연결되는 `live → preparing` 동안은 차단을 유지한다. 현재 방의
  초기화된 `idle`을 확인하면 새 소유권을 발급한다. 그 뒤에도 공유 이전의
  시계/준비 작업은 되살아나지 않는다.
- 초기 공유 상태가 미확정이거나 처음부터 idle/preparing인 정상 입장은
  기존 경로를 유지한다. 고정 입장 대기시간을 추가하지 않았다.
- 같은 상태를 반복 조회할 때는 소유권 함수도 유지해 동일 revision의
  복원 작업이 중복되지 않게 한다. lifecycle 종료·초기화 시 이전 소유권을
  폐기하고 이벤트 구독을 정리한다.
- 명시적인 서버 PREPARE/COMMIT은 이 자동 복원 차단의 대상이 아니다.
  권한 있는 후속 곡 변경과 이전 C01의 공유 종료 후 복귀 경로를 유지한다.

실제 수신 준비의 `stopAllMedia(cancelInFlight:true)`는 기존 네이티브
파일/YouTube 준비도 취소한다. 새 guard를 이유로 모든 서버 준비 작업을
일괄 취소하거나 재생 권한을 변경하지 않았다. UI·정책 변경은 없다.

### 정식 회귀 18개

| 파일 | 수 | 확인한 경계 |
| --- | --- | --- |
| [runtime-system-audio-join](../../src/pro-room/__tests__/runtime-system-audio-join.test.ts) | 3 | 실제 입장 live→늦은 시계 완료, 정상 idle 입장, 공유 종료의 새 복원과 이전 시계 완료 분리 |
| [playback-system-audio-join](../../src/pro-room/__tests__/playback-system-audio-join.test.ts) | 2 | 실제 service/controller/playlist/iframe 모듈의 정상·지연 순서 대조 |
| [playback-snapshot-share-ownership](../../src/pro-room/__tests__/playback-snapshot-share-ownership.test.ts) | 13 | playing/paused 파일, 준비 대기, live→preparing→idle, 반복 조회, 다른 방 이벤트, stop/reset, 명시 서버 명령 및 준비 재사용 후 복구 |

발굴 당시 실제 입장/플레이어 어댑터 재현은 정상 기대치 2개 실패·대조군
1개 통과였다. 이번에는 정상 기대치를 정식 회귀로 옮겼다. 입장 경로의
부정 검사는 실제 복원 Promise가 끝난 뒤 확인하며, 단순히 호출 직후
아직 실행되지 않았다는 상태만 검사하지 않는다.

실제 RTC 트랙이 도착하기 전의 D01 경계를 검증한다. 네이티브 YouTube
API·SFU·서버 응답은 대역이고 파일 endpoint 일부도 모사한다. 실제
YouTube/SFU·iPhone 실기의 재현 또는 운영 발생 빈도를 측정한 결과는 아니다.

## 최종 검증과 배포 경계

동일 제품 소스·회귀 테스트의 작업 트리를 검증한 뒤 위 수정 커밋으로
기록했다. 최종 main SHA의 CI 후보나 프로덕션 배포 검증이 아니다.
집중 회귀와 전체 검사의 수치는 중복되므로 합산하지 않는다.

- 전체 Vitest **491파일·10,022개 통과·기존 1개 skip**. Windows에 `jq`가
  없는 기존 배포 artifact 분류 검사이며 새 skip은 없다.
- 새 정식 회귀 3파일·18개 통과. 기존 native 준비 취소·공유 서비스·권한
  회귀도 통과했고, 이후 최종 전체 스위트에 함께 포함했다.
- 로컬 Chromium **2파일·8개 통과**: `system-audio-controls`, `youtube-sync`.
  일반방 회귀이며 합성 시스템 오디오·모사한 YouTube와 로컬 PeerJS를
  사용한다. PRO 실기/SFU 검증으로 계산하지 않는다.
- 전체 타입·린트 및 변경 TypeScript 파일 Prettier 검사 통과.
- 최종 App 빌드와 9개 guard 통과: source complexity, room authority,
  import graph, bus pairing, lifecycle writes, production hooks/security,
  initial transfer budget, service-worker app shell.
- 원격 CI·실제 YouTube/SFU·iPhone 등 실기·장기 세션 검증은 수행하지 않았다.
  이번 발굴의 0건은 그 환경까지 결함이 없다는 뜻이 아니다.

최종 로그는 `scratch/qa-harvest4-2026-09-27/repair/`의 `full-unit.log`,
`e2e.log`, `typecheck.log`, `lint.log`, `build-production.log`, `guards.log`에 있다.
별도 입장 회귀 로그는 `scratch/qa-repair-d01-2026-09-27/rooms/focused.log`다.
단위 테스트 stdout의 emergency deployment 문구는 모사된 스크립트 검사
출력이며 실제 배포 실행이 아니다.

제품 변경은 App 클라이언트 한 파일이다. 새 Worker 계약·메시지·의존성·
D1/DO migration·binding·secret은 없다. 누적 베타 배포 계획은 `target=all`,
`apply_developer_api_d1=false`를 유지한다. 제품 버전·캐시는 `8.6.61`/`v630`이며
공개 승격 전에 증분한다. 이번에는 베타 커밋·푸시만 수행하며 main·PR·
프로덕션 배포·Operations Drift Audit 재활성화는 수행하지 않는다.
