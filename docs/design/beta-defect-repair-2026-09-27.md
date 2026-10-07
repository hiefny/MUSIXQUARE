# 베타 결함 일괄 수정 — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Dated evidence — B01–B04 베타 수정·검증 완료, 프로덕션 미배포 |
| Applies to | `mxqr_beta` 결함 발굴 감사의 확정 4건 |
| Code commit | `b833e2a62bd7eceaa1c9a074d463a36477b514e4` |
| Starting checkout | `49d52e4d219df958ad8151234f37ba1021f13066` |
| Environment | Windows, Node 24.20.0, Vitest 5, jsdom·SQLite, Playwright Chromium 153 |
| Related documents | [발견 당시 근거](beta-defect-harvest-2026-09-27.md), [배포 준비 기록](../beta-release-readiness.md) |

사용자가 확정 결함의 수정과 베타 푸시를 승인했다. 발견 당시 실패를 먼저
추적 회귀 테스트로 옮기고, 같은 원인의 주변 경로를 확인한 뒤 수정했다.
기존 서버 권한·파일 지원·번역 내보내기 제한을 완화하지 않았다.
대회 동결에 따라 main 병합·프로덕션 배포는 실행하지 않는다.

## 수정과 재검증

### B01 — PRO YouTube 저장본별 곡 목록

서버가 이미 보관하던 저장본별 `videoIds`를 클라이언트 큐 항목에 투영하고,
제목 캐시도 외부 `playlistId` 대신 해당 `queueItemId`로 구분했다.
화면 표시뿐 아니라 선택·PREPARE·iframe 로드·하위 곡 이동·종료 보고·
메타데이터가 같은 저장본을 읽는다. 제한된 제목 캐시에서 항목이 퇴출돼도
큐 항목의 목록을 사용하며, 현재 iframe의 다른 목록으로 덮어쓰지 않는다.
새 목록을 검색해 추가하는 Standard 조회 경로와 서버 대상 검증은 유지한다.

- 수정 전: 서로 다른 저장본 및 순서 반전 회귀 2개 실패, 동일한 저장본 대조군 1개 통과.
- 수정 후: 관련 10개 파일·237개 통과. 마지막 native 스크레이프 예약 차단 조건도
  PRO·Standard 관련 11개로 재검증했다.
- [선택·서버 대상·캐시 퇴출 회귀](../../src/pro-room/__tests__/youtube-occurrence-manifest.test.ts),
  [실제 클라이언트 처리기와 fake iframe 회귀](../../src/youtube/__tests__/pro-occurrence-manifest.test.ts),
  [지연 렌더링·제목 갱신 회귀](../../src/ui/__tests__/playlist-view.test.ts).
- 실제 YouTube 서비스의 영상 재생이나 여러 실기의 PRO 접속 검증으로 계산하지 않는다.

### B02 — 채팅 금지 후 남은 초안

프로토콜이 자신의 채팅 금지를 `network.chatMuted`로 보관하고 UI는 이 상태를
투영한다. 금지 직전 작성한 일반 메시지·귓말(`/w`, `/whisper`)·공개 BOT 요청은
전송 전에 차단하므로 내 말풍선·전송 기록을 만들거나 초안을 지우지 않는다.
금지 해제 직후 동일 초안을 보낼 수 있다. `/help`, `/users` 등 기존 명령 정책과
서버의 실제 금지 검사는 유지한다. UI가 늦게 연결되는 PRO 스냅샷과 퇴장 초기화도 포함했다.

- 수정 전: 기본 경로 7개 실패·정상 대조군 2개 통과. 주변 경로 재검토에서
  Standard·PRO 귓말 별칭 4개도 같은 문제로 실패하는 것을 확인했다.
- 수정 후: 관련 5개 파일·228개 통과.
- [실제 UI·프로토콜 통합 회귀](../../src/ui/__tests__/chat-mute.integration.test.ts)는
  입력·말풍선·초안 보존·재전송을 확인하며 네트워크 경계를 모사한다.

### B03 — 적용된 번역의 내보내기 상한 소진

승인 기록을 200개씩 고유한 `(locale, surface, translation_key)` 순서로 읽고,
이미 적용된 기록을 제외한 **실제 내보낼 초안**에 1,000개 제한을 적용한다.
커서는 제외한 기록에서도 전진한다. 기존 8MiB 최종 UTF-8 용량 제한,
오래된 승인 409, 비활성·삭제 중 계정 제외, 오류 시 부분 결과 미반환은 유지한다.
과거 승인 기록 삭제나 DB 마이그레이션은 필요하지 않다.

- 수정 전: 새 회귀 4개 실패·기존 30개 통과.
- 수정 후: 번역 처리기·라우트 2개 파일·44개 통과. 별도 검토자가 처리기 34개를 재실행했다.
- [SQLite 회귀](../../src/core/__tests__/translation-community.test.ts)는 실제 스키마·카탈로그로
  적용 기록 1,201개 뒤의 새 초안, 전부 적용된 정확한 페이지 배수,
  실제 초안 1,000/1,001개, 오래된 승인과 8MiB 초과를 확인한다.
- 로컬 workerd D1 추가 탐색은 런타임 시작 지연으로 중단했으며 성공으로 세지 않았다.
  운영 D1 상태 및 동시 승인 변경 중 스냅샷 일관성은 이번 검증 범위 밖이다.

### B04 — 매우 짧은 로컬 파일의 종료

유효한 양수 길이 파일에 종료 처리를 허용했다. 예약 시작 전 안전 폴링이
먼저 곡을 끝내지 않도록 보호하고, 100ms 이하 파일에서는 기존 5/50ms 종료
허용 오차 대신 최대 한 오디오 샘플의 오차를 사용한다. 복귀 경로도 같은
종료 판정에 위임한다. 일반 길이의 허용 오차, Standard 호스트의 정밀 종료
소유권, PRO의 서버 종료 명령 경로는 유지한다.

- 수정 전: 기본 경로 6개 실패·대조군 5개 통과. 직접 안전 폴링을 더 확인해
  예약 시작 전 종료 및 짧은 곡 시작·중간 종료의 추가 실패 3개를 확인했다.
- 수정 후: [새 회귀 16개](../../src/player/__tests__/transport-short-file-end.test.ts)를 포함해
  관련 4개 파일·177개 통과. 예약 시작·양/음수 오프셋·복귀·PRO 종료 권한·잘못된 길이를 포함한다.
- 실제 Chromium `File → decodeAudioData → AudioBufferSourceNode`로 50/100/200ms WAV가
  각각 종료 1회 후 idle이 됨을 확인했다. 실제 `playTrack`과 재생목록 종료 처리기를
  연결해 50/100ms 파일 다음의 2초 곡 재생 및 한 곡 반복의 연속 시작도 확인했다.
- 이는 로컬 Chromium 검증이며 iPhone Safari/PWA의 실기 동기화 검증을 대신하지 않는다.

## 통합 검증과 배포 경계

집중 테스트 수치는 서로 겹치는 기존 회귀가 있으므로 아래 수치와 합산하지 않는다.

- 전체 Vitest: **487개 파일·9,960개 통과·기존 1개 skip**. skip은 이 Windows에
  `jq`가 없는 배포 artifact 분류 검사이며 새 skip은 없다.
- 로컬 Chromium E2E: **51개 통과**. `chat`, `chat-commands`, `playlist`,
  `playback-advanced`, `youtube-sync` 5개 파일을 실행했다. 두 브라우저와 로컬
  PeerJS를 사용하며 MP3는 실제 디코딩, YouTube는 fake player 경계다.
  원격 CI·실제 YouTube 서비스·운영 방 검증으로 계산하지 않는다.
- 전체 타입·린트, 변경 TypeScript 서식 검사 통과.
- App 빌드 및 6개 Worker 로컬 번들 dry-run 통과. Worker 배포는 하지 않았다.
- bus pairing, source complexity, room authority, import graph, lifecycle writes,
  production hooks/security, initial transfer budget, app shell 검사 통과.
- 이 수정은 App 클라이언트와 App Worker의 `translation-community.ts`에 반영된다.
  wire/schema, D1/DO migration, binding, secret, dependency 변경은 없다.
- 누적 베타의 배포 계획은 여전히 `target=all`, `apply_developer_api_d1=false`다.
  제품 버전·캐시는 `8.6.61`/`v630`으로 유지하며 공개 승격 전에 증분한다.
  배포 준비 기록의 최종 main SHA CI·cache history·실기·운영 검증은 별도로 남는다.
