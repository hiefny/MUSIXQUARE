# 베타 결함 일괄 발굴 3차 — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Dated evidence — 발견·재검증만 수행, D01 미수정 |
| Applies to | C01–C03 수정 이후 `mxqr_beta`의 추가 결함 수집 |
| Tested checkout | `ab4220b75ba58cfec1939f8eec4169bb7f86feb7` |
| Runtime source baseline | `3dd9086cdced0fc25426da82239977b6da004074` — 이후 차이는 문서 |
| Environment | Windows, Node 24.20.0, Vitest 5, Node/jsdom·SQLite·가상 타이머 |
| Related documents | [배포 준비 기록](../beta-release-readiness-archive-2026-10-10.md), [2차 발굴](beta-defect-harvest-2026-09-27-round-2.md), [C01–C03 수정](beta-defect-repair-2026-09-27-round-2.md) |

후속 상태: 추가 발굴에서 새 결함이 확정되지 않아, 사용자 지시에 따라
D01을 베타에서 수정했다. [4차 발굴·D01 수정 기록](beta-defect-harvest-2026-09-27-round-4.md)을 참조한다.
아래 미수정·실패 표기는 발굴 당시의 관측을 보존한 것이다.

미디어·전송, 방·권한·YouTube, 데모·UI·설정, 계정·API·서비스 워커를
병렬 검토했다. **추가 확정 결함은 1건**이다. 2차에서 재현이 부족했던
PRO 공유 도중 신규 입장 경계를 이번에 입증했다. B01–B04와 C01–C03은
다시 세지 않았으며, 제품 코드와 추적 테스트를 변경하지 않았다.

## D01 — PRO 공유 도중 신규 입장자가 이전 YouTube를 다시 켬

**우선순위 P2.** 첫 시계 보정이 끝나기 전에 공유 수신 준비가 완료되고,
실제 RTC 오디오 트랙이 아직 도착하지 않은 순서에서 확인했다.
운영 발생 빈도나 모든 신규 입장의 실패를 뜻하지 않는다.

### 실제 가능한 순서

1. PRO방에서 YouTube를 재생하다가 다른 참가자가 시스템 오디오를 공유한다.
2. 새 참가자가 입장한다. 초기 재생 복원은 첫 서버 시계 보정을 기다린다.
3. 별도로 조회한 공유 상태가 먼저 `live`로 도착한다. 실제 수신 준비
   처리기가 기존 미디어를 정지하고 `systemAudioMode: receiving`을 설정한다.
4. RTC 트랙이 아직 붙지 않은 사이 시계 보정이 완료된다.
5. 대기 중이던 초기 재생 복원이 이전 YouTube 체크포인트를 적용한다.
   공유는 `live`인데 수신 안내가 YouTube 제목으로 바뀌고 iframe을 다시 재생한다.

서버가 공유 중 이전 재생 체크포인트를 유지하는 것은 복귀용 계약이다.
[2차 발굴 C01](beta-defect-harvest-2026-09-27-round-2.md)의 실제 Worker
acquire/commit/release 검증에서도 `playing` 체크포인트와 revision이
유지됐다. 그 서버 경로는 이후 C01–C03 수정에서 바뀌지 않았다.
현재 Worker의 acquire/commit과 클라이언트의 로컬 정지 경로도 재검토했다.
위 입력은 존재할 수 없는 서버 상태를 임의로 주입한 것이 아니다.

기대 동작은 공유 수신 준비를 유지하고 공유 종료 또는 이후 유효한
재생 전환에 따라 다음 미디어를 적용하는 것이다. 이 결함은 **공유 중
입장 복원**이며, 이미 수정한 C01의 **공유 종료 후 복귀 누락**과 다르다.

### 두 층의 재현과 정상 대조군

| 재현 | 실제 사용한 제품 경로 | 관측 |
| --- | --- | --- |
| 실제 입장 | `joinProRoom` → live 공유 조회 → trusted receiver → 초기 시계 대기 해제 → playback controller | 수신 준비 이후에도 이전 `playing` media commit이 1회 발생 |
| 실제 플레이어 어댑터 | system-audio service/controller → guest receiver → playback controller → playlist → YouTube player/iframe | 공유 `live`, 앱 mode·metadata `youtube`, 네이티브 플레이어 대역 `PLAYING(1)` |
| 정상 순서 대조군 | 동일 플레이어 경로에서 초기 복원을 먼저 완료한 뒤 live 공유 도착 | 수신 준비 상태 유지, YouTube iframe 없음 |

앞의 두 테스트는 **정상 동작 기대치에 실패**, 대조군 하나는 통과했다.
주 검토자가 독립 실행해 같은 결과를 확인했고, 별도 검토자가 시계 대기와
미디어 소유권 변경 사이의 취소 경계를 교차 검토했다. 두 실패를 독립
결함 두 건으로 세지 않는다.

### 원인 경로

- [runtime.ts](../../src/pro-room/runtime.ts)의 `finalizeOpenedRoom`은
  초기 공유 조회와 `restorePersistedPlayback`을 독립 실행한다.
- [playback-controller.ts](../../src/pro-room/playback-controller.ts)의
  초기 복원은 시계 대기 뒤 방·재생목록 lease를 다시 확인하지만, 그 사이
  발생한 시스템 오디오 수신 소유권 변경은 확인하지 않는다.
- [system-audio-guest.ts](../../src/network/system-audio-guest.ts)의
  `commitTrustedSystemAudioReception`은 현재 미디어를 취소하고 수신 준비로
  전환한다. 아직 시계를 기다리는 PRO 복원 작업까지 무효화하지는 않는다.
- 이후 [playlist.ts](../../src/player/playlist.ts)의 실제 prepare 경로가
  수신 메타데이터를 바꾸고 [iframe.ts](../../src/youtube/iframe.ts)가
  YouTube 모드와 재생을 다시 적용한다.

수정 시 공유 상태와 초기 복원이 같은 재생 소유권·취소 경계를 따라야 한다.
입장 전체를 임의의 고정 시간만큼 지연하는 방식으로 해결하지 않는다.
정식 회귀에는 공유 응답/시계 보정/RTC 트랙 도착의 순서, 공유 종료,
새 미디어 명령, 입장 취소·재입장을 함께 포함할 필요가 있다.

**한계:** 네이티브 YouTube API, RTC 구독·오디오 트랙, 서버 네트워크는
대역이다. 실제 SFU·두 실기·소리 출력을 연결한 E2E가 아니다.
이미 트랙이 붙어 `isReceiving=true`인 경우는 별도 소유권 방어가 있어
이번 결과를 그대로 확대하지 않는다. 뒤늦은 RTC 트랙의 trust gate 대기는
후속 의심 경로지만 이번 재현에서 트랙을 주입하지 않았으므로 수신 영구
실패나 별도 결함으로 확정하지 않았다. 일반방도 같은 문제라고 주장하지 않는다.

## 다른 영역의 판정

- **파일·하이브리드 엔진:** seek/pause/end, 오래된 출력 실패, decoder
  Worker 취소·정리, PCM 경계, 작은 곡 복귀를 검토했다. 새 확정 결함 없음.
  기존 코덱 지원 제한은 결함으로 다시 세지 않았다.
- **전송·프리로드:** 현재 곡 우선순위, 수신 재개, 소유권 변경, RAM 잔류,
  종료 순서와 진행 타이머를 검토했다. C02 외 새 확정 결함 없음.
- **데모·UI·검색·채팅·번역:** 늦은 응답, 연속 제출, 역할 변경, 초안 소유권,
  설정 표시, 계정 변경 도중 다이얼로그를 검토했다. 새 확정 결함 없음.
  같은 언어 카탈로그 재조회 순서나 전송 실패 시 낙관적 말풍선만으로는
  새로운 사용자 계약 위반을 입증하지 못해 제외했다.
- **계정·API·서비스 워커:** 계정 삭제/세션 scope, 쿠키 순서, API 권한과
  명령 취소, 원격 공유 정리, 캐시 세대 수명을 검토했다. 새 확정 결함 없음.
  활동 통계의 모호한 전송 실패를 재시도하지 않는 정책과 보수적인 캐시
  보존을 결함으로 단정하지 않았다.
- **방·권한:** 일반방 입장/bootstrap, PRO 참여자·권한 투영, YouTube
  로컬 랑데부, 이전 C01 복귀 방어를 검토했다. D01 외 새 확정 결함 없음.

이 판정은 아래 범위의 유한한 검토 결과다. 모든 실기·모든 장기 세션이나
가능한 전체 사용자 순서의 무결함을 보증하지 않는다.

## 실행한 집중 회귀

기존 테스트를 변경하지 않고 **서로 다른 46파일·1,700개 통과, 실패·skip 0개**.
이는 새로 만든 사용자 시나리오 1,700개가 아니다. 위 D01 발견용 재현
2실패·1통과는 별도이며, 기존 회귀의 녹색으로 발견 결함을 덮지 않는다.

| 담당 범위 | 파일 / 통과 | 로컬 로그 |
| --- | --- | --- |
| 미디어·전송 | 14 / 296 | `media/focused-controls.log`, `media/transport-controls.log` |
| 데모·UI·검색·채팅·번역 | 12 / 584 | `surface/focused-controls.log`, `surface/demo-controls.log` |
| 방·권한·YouTube | 8 / 180 | `rooms/controls.log` |
| 계정·API·서비스 워커 | 12 / 640 | `root/focused-controls.log`, `root/additional-controls.log` |

각 파일은 아래 경로에서 `.test.ts`를 붙여 실행했다. 공통 실행은 저장소
루트에서 Node 24.20.0으로 `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`.

- `src/player/large-audio/__tests__/`: `track-lifecycle`, `bounded-playback`,
  `codec-support`, `decoder-failure-worker-cleanup`, `pcm-chunk-guards`, `worker-call`.
- `src/player/__tests__/`: `decode`, `transport-large-file`, `large-file-source`.
- `src/storage/__tests__/`: `transfer-receive-resume`, `preload-reorder-residency`,
  `preload-channel-ordering`, `preload-overlap-progress`, `preload-lane-ownership`.
- `src/ui/__tests__/`: `player-controls`, `settings`, `chat-mute.integration`,
  `chat-bubble-segments`, `account`, `dialog-account-ownership`.
- `src/i18n/__tests__/`: `translation-community-ui`, `translation-workspace-drafts`.
- `src/demo/__tests__/`: `mode-recovery`, `mode-sync`.
- `src/chat/__tests__/`: `commands`.
- `src/youtube/__tests__/`: `search`, `host-local-rendezvous`.
- `src/network/__tests__/`: `guest-join`, `host-bootstrap-catchup`, `room-control`.
- `src/pro-room/__tests__/`: `runtime-member-projection`,
  `runtime-playback-control-authority`, `system-audio-service`,
  `playback-native-preparation-cancel`, `service-control`, `pro-room-grants`.
- `src/core/__tests__/`: `account-auth-sqlite`, `account-auth-request-lifetime`,
  `account-cookie-ordering`, `service-worker-cache`, `pro-bot-worker`.
- `src/developer-api/__tests__/`: `developer-api-facade-worker`, `developer-api-worker`.
- `src/share/__tests__/`: `remote-share-worker`.
- `src/account/__tests__/`: `activity-stats`, `session`.

로그와 새 재현은 Git에서 제외되는 `scratch/qa-harvest3-2026-09-27/`에 있다.
`rooms/late-join.test.ts`, `rooms/runtime-late-join.test.ts`가 발굴용 재현,
`rooms/probes.log`, `rooms/independent-probes.log`가 최종 결과다.
`node node_modules/vitest/vitest.mjs run --config scratch/qa-harvest3-2026-09-27/rooms/vitest.config.ts --maxWorkers=1`
로 독립 재실행했다. 초기 fixture의 메타데이터형·singleton API 대체 오류는
수정한 뒤 판정했다. 새 checkout에 재현 코드는 포함되지 않으므로 수정
단계에서 위 조건을 정식 회귀 테스트로 옮겨야 한다.

새 전체 스위트·빌드·브라우저 E2E·원격 CI·실기 검증은 이번에 실행하지
않았다. 전회 결과를 이번의 새로운 전체 검증으로 계산하지 않는다.
main·제품 버전·캐시·공개 서비스·워크플로 설정 변경은 없다. D01은 베타
승격 전에 수정 또는 명시적 처리 판단이 필요하다.
