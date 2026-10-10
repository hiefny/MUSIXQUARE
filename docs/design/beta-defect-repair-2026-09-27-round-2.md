# 베타 결함 일괄 수정 2차 — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Dated evidence — C01–C03 베타 수정·검증 기록, 프로덕션 미배포 |
| Applies to | `mxqr_beta` 2차 발굴 감사의 확정 3건 |
| Code commit | `3dd9086cdced0fc25426da82239977b6da004074` |
| Starting checkout | `3f21dee975ff8ab0b578fd7e861b60256079527b` |
| Environment | Windows, Node 24.20.0, Vitest 5, jsdom·SQLite, Playwright Chromium |
| Related documents | [발견 당시 근거](beta-defect-harvest-2026-09-27-round-2.md), [배포 준비 기록](../beta-release-readiness-archive-2026-10-10.md) |

사용자 승인에 따라 확정 3건과 같은 원인의 주변 경계를 수정했다. main 병합,
프로덕션 배포, Operations Drift Audit 재활성화는 실행하지 않는다.

## C01 — PRO 시스템 오디오 종료 후 YouTube 복귀

명시적으로 공유를 종료한 송신자와 실제 공유를 관측한 수신자가 서버의
공유 종료 상태를 확인한 뒤 **현재 PRO 재생 체크포인트**로 복귀한다.
공유 이전의 로컬 저장본이나 일반방 자동 싱크로 PRO 권한을 우회하지 않는다.
재생 중이면 참가자 자신의 준비·랑데부 절차를 사용하고, 일시정지 중이면
닫힌 플레이어를 준비한 뒤 정확한 위치에서 일시정지를 유지한다. 기존
일시정지 수동 싱크 경로와 로컬 파일의 공유 종료 후 정지 정책은 유지한다.

복귀 작업에는 방·세션·공유 세대·명시 종료 의도를 연결했다. API나 시계가
잠깐 준비되지 않으면 단일 타이머로 재시도하며 새 공유·퇴장·방 변경은
이전 작업을 취소한다. 수신자는 복귀 완료 전에 새 공유 준비가 시작되거나
중간 세대를 놓쳐도 실제 재생 중단 이력을 유지한다. 처음부터 idle이거나
성공한 공유 없이 preparing만 실패한 상황은 새 재생 동작으로 해석하지 않는다.

공유 종료 후 이미 닫힌 iframe을 복구하는 일시정지 경계와
`live → preparing → idle`, `live → idle(복귀 중) → preparing → idle`은
수정 중 독립 교차 검토에서 추가 확인했다.

- 관련 8개 파일·345개 테스트 통과. [서비스 수명·재시도](../../src/pro-room/__tests__/system-audio-service.test.ts),
  [실제 runtime 연결](../../src/pro-room/__tests__/runtime-server-playback.test.ts),
  [capture→transport→playlist endpoint→iframe 회귀](../../src/pro-room/__tests__/playback-native-preparation-cancel.test.ts)를 포함한다.
- 마지막 회귀는 실제 앱 모듈을 연결하지만 display capture 기기·YouTube API·
  lease 네트워크는 모사한다. 실제 YouTube 영상/SFU 재생이나 실기 검증은 아니다.

## C02 — 프리로드 END 순서와 실제 진행 시간 제한

일반방 Cloudflare 직결 전송의 `PRELOAD_END`를 파일 청크와 같은 bulk 채널에
넣어 종료 신호가 청크를 앞지르지 않도록 했다. broadcast와 늦게 합류한
참가자에 대한 단일 수신자 전송에 동일하게 적용된다.

구버전 송신자의 control 채널 END도 계속 받는다. END 도착만으로 시작하던
고정 10초 폐기 타이머를 없애고 기존 수신 진행 감시를 사용한다. 최초 대기
30초와 이후 유효한 연속 청크 진행의 15초 제한은 유지한다. 중복 END·START·
중복 청크·순서가 맞지 않는 청크가 이 제한을 무한히 연장하지 못한다.
현재 곡 우선 전송 때문에 대기 중인 프리로드는 기존 foreground 진행 정책을 따른다.

4개 청크가 4·8·12·16초에 도착하는 정상 수신, 실제 중단, 현재 곡으로의
인계, 중복 완료 처리 및 새·구 END 경로를 검증한다. PRO의 비공개 객체
다운로드 방식이나 파일 크기 제한을 변경하지 않는다.

- 관련 10개 파일·350개 테스트 통과. [새 송수신 회귀 9개](../../src/storage/__tests__/preload-channel-ordering.test.ts)와
  [채널 분류 회귀](../../src/network/transport/__tests__/cloudflare-signaling.test.ts)를 포함한다.
- 실제 전송 처리기·프로토콜·RAM 저장소와 모사한 ordered 채널/가상 시간을
  사용한다. 실기에서 RTCDataChannel 간 네트워크 지연을 측정한 결과는 아니다.

## C03 — 탈퇴 정리 대기 작성자의 번역 추천 차단

번역 제안 작성자가 활성 상태이며 삭제 fence가 없다는 조건을 추천 PUT과
DELETE의 사전 조회, 원자적 SQL 변경, 최종 응답 조회에 적용했다. 탈퇴가
이미 확정되고 후속 정리만 실패한 `202 pending` 계정의 제안은 추천을
수락하거나 응답으로 다시 노출하지 않는다.

현재 번역 카탈로그를 읽는 비동기 대기 이후에 최종 조회를 수행한다.
추천 변경 전에 탈퇴하면 표가 변하지 않으며, 변경 후나 카탈로그 조회
도중 탈퇴하면 이전에 읽은 제안을 응답으로 반환하지 않는다. 활성 작성자의
정상 추천·취소와 기존 제안 상태 제한은 유지한다.

실제 계정 삭제 처리기·스키마·SQLite로 정리 대기, 완전 삭제, 비활성 상태,
독립 삭제 fence, 요청 진행 중 삭제 경계를 검증했다. 개인 비공개 정보가
노출됐다는 의미는 아니며 기존 공개 제안의 탈퇴 후 경계 결함이다.

- 새 회귀는 수정 전 12개 실패·정상 대조군 4개 통과, 수정 후 번역 처리기·
  라우트 2개 파일·60개 통과. 최초 발굴 때의 별도 재현 3개도 다시 실행해 통과했다.
- [계정 삭제·추천 회귀](../../src/core/__tests__/translation-community.test.ts)는
  SQLite 기반이며 실제 운영 D1의 상태·동시 부하 테스트는 수행하지 않았다.

## 통합 검증과 배포 경계

집중 검사와 전체 검사 수치는 중복되므로 합산하지 않는다.

- 전체 Vitest: **488개 파일·10,004개 통과·기존 1개 skip**. skip은 Windows에
  `jq`가 없는 기존 배포 artifact 분류 검사다. 새 skip은 없다.
- 로컬 Chromium E2E: **5개 파일·19개 통과**. `file-transfer`, `preload`,
  `preload-queue-mode-cancellation`, `system-audio-controls`, `youtube-sync`를
  실행했다. 실제 MP3·로컬 PeerJS 및 fake YouTube player를 사용한다.
- 전체 타입·린트, 변경 TypeScript 파일 서식 검사 통과.
- 최종 App 빌드, source complexity·room authority·chunk pump·import graph·
  bus pairing·lifecycle writes·production security/hooks·initial transfer budget·
  service worker app shell의 **10개 guard** 통과.
- **6개 Worker 로컬 번들 dry-run** 통과. Worker 배포는 하지 않았다.
- 첫 통합 실행은 작성 중인 새 runtime 테스트 2개가 fixture의 시계 준비
  문제로 실패했고, 설정을 바로잡은 최종 전체 실행에서 모두 통과했다.
  작성 중 타입·린트·서식 오류도 최종 검사에서 해소했다.
- 원격 CI·실제 YouTube/SFU·iPhone 등 실기 검증은 수행하지 않았다.
  모사한 네트워크·iframe 검증을 그 결과로 계산하지 않는다.

변경 대상은 App 클라이언트와 App Worker의 번역 처리기다. 새로운 wire
메시지, D1/DO migration, binding, secret, dependency는 없다. 기존
`PRELOAD_END`의 송신 채널만 달라지며 구버전 수신 경로와 메시지 형태는
호환된다. 누적 베타의 향후 배포 계획은 `target=all`,
`apply_developer_api_d1=false`를 유지한다. 제품 버전·캐시는 `8.6.61`/`v630`을
유지하며 공개 승격 전에 증분한다. 최종 main SHA CI·실기·운영 확인은
배포 준비 기록의 미완료 항목으로 남긴다.
