# 베타 결함 일괄 발굴 — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Dated evidence — 발견·재검증만 수행, 제품 수정 없음 |
| Applies to | QA21 이후 `mxqr_beta`의 독립 결함 수집 |
| Tested checkout | `7538e9d75e197dd4eb903e83051433de81903911` |
| Runtime source baseline | `c663f89f29d65fcf92c15df4d66dc3d27ced4338` — 이후 차이는 문서 |
| Environment | Windows, Node 24.20.0, Vitest 5, jsdom·SQLite·설치된 Playwright Chromium |
| Related documents | [배포 준비 기록](../beta-release-readiness.md), [QA21](beta-qa-2026-09-27-round-21.md) |

사용자 요청에 따라 하나를 찾자마자 고치는 작업을 중단하고, 여러 영역을
병렬로 조사한 뒤 다른 검토자가 근거와 대조군을 확인했다. 이번 결과는
**확정된 독립 결함 4개**다. 코드상 의심만 남은 후보와 지원 범위의 한계를
확정 결함에 합산하지 않았다. 제품·추적 테스트·설정은 변경하지 않았다.

**후속 기록:** 이후 사용자 승인으로 B01–B04를 베타에서 수정했다.
[수정·회귀 검증 기록](beta-defect-repair-2026-09-27.md)을 참고한다.
이 문서 아래의 실패·미수정 표기는 발견 당시 상태를 보존한 것이다.

## 진행 방식

1. 기준 SHA를 고정하고 재생·전송, 방·권한·YouTube, 데모·설정·채팅,
   계정·번역·관리자, 서비스 워커·재로딩을 나눠 살폈다.
2. 첫 결함을 발견해도 해당 영역 조사를 계속했다. 개수 목표는 두지 않았다.
3. 각 후보에서 실제 진입 경로, 기존 방어 로직, 정상 대조군을 확인했다.
   실제 구현의 재현 또는 처리기 실행이 없는 가설은 별도로 남겼다.
4. 주 검토자가 확정 4개의 원인 코드를 읽고 재현을 독립적으로 다시 실행했다.
   같은 원인의 UI 증상·서버 오류·타이머 누락을 여러 결함으로 세지 않았다.
5. 수정은 별도 작업이다. 다음 수정 시 아래 조건을 회귀 테스트로 옮기고,
   이 기록의 발견 당시 결과를 덮어쓰지 말고 해결 커밋을 연결한다.

## 확정 목록

우선순위는 영향과 발생 조건을 함께 판단한 작업 순서이며, 운영에서 실제
발생한 빈도를 측정한 값이 아니다. 네 건 모두 이번 감사에서는 미수정이다.

| ID | 영역 | 조건과 사용자 영향 | 우선순위 |
| --- | --- | --- | --- |
| B01 | PRO YouTube 재생목록 | 같은 외부 플레이리스트의 서로 다른 저장본을 추가하면, 일부 하위 곡 표시·선택이 다른 저장본과 섞이고 서버가 재생 명령을 거부 | P2 |
| B02 | 일반방 채팅 | 초안을 쓴 뒤 채팅 금지를 당하고 전송하면, 상대에게 전달되지 않는데 내 말풍선은 생기고 초안은 사라짐 | P2 |
| B03 | 번역 승인 내보내기 | 이미 적용한 승인 기록도 1,000개 제한에 포함돼, 새 번역이 1개뿐이어도 내보내기 전체가 막힘 | P2·누적 운영 조건 |
| B04 | 로컬 파일 종료 | 정상 디코딩되는 100ms 이하 파일은 소리가 끝나도 재생 상태가 끝나지 않아 자동 다음 곡·반복이 진행되지 않음 | P2·매우 짧은 파일 조건 |

### B01 — PRO 플레이리스트 저장본별 곡 목록 충돌

재현 순서:

1. 외부 YouTube 플레이리스트 P의 `[A, B]`를 PRO 대기열 Q1에 저장한다.
2. 외부 목록이 `[A, C]`로 바뀐 뒤 새로 조회해 Q2로 다시 추가한다.
   두 행은 서로 다른 `queueItemId`이며, 서버는 저장본별 목록을 유지한다.
3. Q1의 두 번째 하위 곡을 선택한다.
4. Q1과 Q2의 순서를 바꾸면 잘못된 목록을 사용하는 행도 바뀐다.

클라이언트는 저장본의 고유 ID 대신 외부 `playlistId` 하나로 하위 곡을
저장한다. 마지막 저장본이 앞선 저장본을 덮으면서 Q1의 1번 인덱스에
B 대신 C를 실어 명령을 보낸다. 서버는 Q1에 저장된 B와 비교해
`400 INVALID_PLAYBACK_TARGET`을 반환한다. 서버 검증이 잘못된 것이 아니다.

근거:

- [목록 투영](../../src/pro-room/youtube-manifest-policy.ts): `hydrateProRoomYouTubeManifests`의 `playlistId` 키 공유.
- [추가·저장](../../src/pro-room/playlist-state-manager.ts): 추가마다 새 `queueItemId`, 저장본의 `videoIds` 유지.
- [명시적 추가](../../src/youtube/player.ts): PRO 추가 시 목록을 조회한 뒤 새 행 추가.
- [하위 곡 표시](../../src/ui/playlist-view.ts), [선택 명령](../../src/player/playlist.ts): 같은 공유 맵 사용.
- [서버](../../cloudflare/pro-room-worker.ts): `targetPlayback`이 선택된 행의 목록과 요청 ID를 대조.

검증은 두 층으로 했다. 실제 투영·선택·서버 target 처리기로 충돌과 순서
반전을 확인했고, 실제 Worker HTTP 처리기로 두 저장본의 추가가 각각 200으로
허용되며 수정 없이 보관됨을 확인했다. 잘못된 Q1/C 선택은 400, 올바른
Q1/B 선택은 202 PREPARE였다. 단일 저장본 및 내용이 같은 중복 저장본은 정상이다.

사용자 정의 관측 테스트 **2개 파일·5개 통과**. 여기서 통과는 현재의 결함
동작을 관측했다는 뜻이며 수정 완료를 뜻하지 않는다. 실시간 YouTube 서버나
영상 재생을 호출하지 않고, 미디어 로딩 이전의 선택 실패를 검증했다.

### B02 — 채팅 금지 직전 초안의 허위 전송 표시·유실

일반방 게스트가 초안을 쓴 상태에서 방장이 그 게스트를 채팅 금지한다.
입력란은 편집 불가능해지지만 전송 버튼은 계속 동작한다. 버튼을 누르면
내 말풍선 생성 → 전송 호출 → 입력란 비우기가 실행된다. 호스트의 실제
채팅 금지 검사는 메시지를 폐기한다.

따라서 **금지 우회가 아니라 잘못된 전송 표시와 초안 유실**이다.
금지 전 입력한 글이 있는 순서가 필요하며, 빈 입력란에서 아무 글이나
새로 작성할 수 있다는 주장은 아니다.

근거:

- [채팅 UI](../../src/ui/chat.ts): `sendChatMessage`는 기존 텍스트를 읽지만 금지 여부를 검사하지 않는다. `chat:muted-state-changed`는 편집 가능 여부만 바꾼다.
- [스타일](../../css/style.css): 비활성 처리는 입력란에만 적용되고 전송 버튼에는 적용되지 않는다.
- [수신 처리](../../src/chat/protocol.ts): 호스트는 `mutedPeers`로 실제 메시지를 차단한다.

실제 `index.html`, `initChat`, 프로토콜 처리기, 렌더러를 사용하고 전송·환경
경계만 모사했다. 정상 기대치를 검사한 재현은 **1개 실패**했고, 관측값은
`sentCount=1`, `draftAfterSend=""`, `.chat-bubble.mine` 존재였다.
금지 전 정상 전송, 호스트 차단, 금지 해제 후 전송의 **대조군 3개는 통과**했다.
실제 두 기기 간 네트워크 전달을 시험한 결과로 표현하지 않는다.

### B03 — 이미 반영한 승인 번역이 내보내기 상한을 소진

[번역 내보내기](../../cloudflare/translation-community.ts)의 `exportApproved`는
승인 상태 행을 최대 1,001개 읽고, 1,000개를 넘으면 즉시 413을 반환한다.
이미 서비스 문구에 반영한 행을 제외하는 `display.applied` 검사는 그 뒤에
있다. 적용 후에도 DB 상태는 `approved`이므로 과거 적용 기록이 상한을 차지한다.

실제 auth 스키마·SQLite, 실제 번역 카탈로그, 실제 내보내기 처리기로 확인했다.

| 활성 계정의 승인 기록 | 실제로 내보낼 새 번역 | 결과 |
| --- | --- | --- |
| 이미 적용 999개 + 새 승인 1개 | 1개 | 200, drafts 1개 |
| 이미 적용 1,000개 + 같은 새 승인 1개 | 동일한 1개 | 413 `EXPORT_TOO_LARGE` |

이는 내보낼 새 번역 1,001개를 제한하는 정상 정책과 다르다.
[관리자 UI](../../browser/classic-runtime/admin.ts)는 적용된 항목의 승인·거절
버튼도 숨기므로 보통의 화면 조작으로 적용 기록을 치워 해결하기 어렵다.
운영 DB의 현재 승인 수를 조회한 것은 아니며, 지금 프로덕션에서 이미
막혔다고 단정하지 않는다. **누적 시 발생하는 재현된 결함**이다.

### B04 — 100ms 이하 로컬 파일의 종료 경계

유효한 50ms·100ms·200ms PCM WAV를 생성해 실제 File로 넣고, 실제
`loadAndBroadcastFile → decodeAudioData → play → AudioBufferSourceNode`를
Chromium에서 실행했다. 디코더·오디오 소스·타이밍·종료 처리기는 모사하지 않았다.

| 길이 | 로딩·재생 시작 | 네이티브 ended | `player:ended` | 450ms 후 앱 상태 |
| --- | --- | --- | --- | --- |
| 50ms | 성공 | 발생 | 0회 | playing, 위치 0.05초 |
| 100ms | 성공 | 발생 | 0회 | playing, 위치 0.1초 |
| 200ms 대조군 | 성공 | 발생 | 1회 | idle |

[transport](../../src/player/transport.ts)의 `armStandardFileCanonicalEnd`는
`duration <= 0.1`이면 종료 타이머를 만들지 않는다. 일반방 호스트는 정밀
타이머가 종료를 담당하도록 네이티브 종료 콜백을 무시하고, `handleEnded`
자체도 같은 길이를 제외한다. 세 위치는 동일한 종료 누락을 만드는 하나의 결함이다.
[재생목록](../../src/player/playlist.ts)의 `player:ended` 이후 자동 이동·반복
경로가 실행되지 않는다. 수동으로 다음 곡을 고르는 것은 가능하다.

일반적인 수분 길이 음악이나 대용량 FLAC 전반의 종료 문제로 확대 해석하지
않는다. 단일 브라우저의 실제 네이티브 오디오 경계 검증이며, 두 기기 동기화
재현을 했다는 뜻은 아니다.

## 검토 범위와 확인 수준

| 영역 | 이번에 확인한 경계 | 결과·한계 |
| --- | --- | --- |
| 로컬·하이브리드 오디오 | reader 정리, PCM 소유권, seek 취소, 소스 교체, 종료·수동 오프셋 | B04 확인. 전체 코덱·기기 조합이나 장기 메모리 soak은 미실행 |
| 파일 전송·프리로드 | 현재 곡 우선, 프리로드 중복 START, 재정렬·수신 재개 | 관련 기존 방어 검사 통과. 실제 복수 data channel 지연 조합은 미실행 |
| 일반방 입장·권한 | bootstrap/APPLIED, 권한 투영, 연결 교체, 참여 순서 | 검토 경로에서 새 결함 미확정. 실제 무선망 전환은 미실행 |
| PRO 상태·YouTube | 세션 갱신·탈퇴 소유권, queue/repeat/shuffle, rendezvous, 저장 목록 | B01 확인. 외부 YouTube 실제 영상 재생은 미실행 |
| 데모·설정·검색·채팅 | 데모 진입·종료, 효과 복원, 수동 싱크, 검색 응답 취소, 채팅 조작 순서 | B02 확인. 화면·보조기술·모바일 IME 전체 조합 검증은 아님 |
| 계정·번역·관리자 | 계정 응답·통계 소유권, 번역 편집·투표·검토, 관리자 요청 수명 | B03 확인. 운영 계정·DB 변경 없음 |
| PWA·페이지 수명 | cache/provenance, worker 교체, reload 취소·bfcache, lazy load 실패 | 새 결함 미확정. 실제 iOS 중단·복귀와 CacheStorage 퇴거는 미검증 |

기존 집중 회귀는 아래와 같이 **32개 파일·1,041개 통과**했다. 전체 스위트를
다시 돌린 것이 아니다. 재현 도구의 결함 관측·의도된 실패와도 합산하지 않는다.
녹색 결과가 위 네 결함을 부정하지 않는다. 이 조합·경계는 기존 검사에 없었다.

| 실행 묶음 | 파일 / 테스트 | 주요 대상 |
| --- | --- | --- |
| 미디어 | 7 / 164 | large-audio track-lifecycle·bounded-playback, transport-large-file, large-file-source, preload-overlap-progress·queue-io-boundaries, transfer-receive-resume |
| 방·권한 | 7 / 169 | standard-room-member-request, luna-session-ordering, session-controller, runtime-queue-mode-authority, system-audio-controller, host-local-rendezvous, queue-native-playlist-ownership |
| 데모·UI | 6 / 324 | demo mode-recovery·mode-sync, settings, manual-sync-focus, YouTube search, chat |
| 계정·번역 | 5 / 190 | account session·activity-stats, UI account, translation-community·route |
| SW·재로딩 | 7 / 194 | service-worker-cache, sw-register·recovery.integration, document-reload, reload-recovery-latch, page-lifecycle, session-reset |

## 확정 목록에 넣지 않은 것

- **PRO 시스템 오디오 종료 후 YouTube 복귀:** 종료 복원이 기존 호스트의
  cue/자동 싱크 경로를 거치지만 PRO에서는 그 자동 싱크 함수가 즉시 반환한다.
  서버 timeline과 복원된 플레이어가 달라질 가능성이 있다. 다만 전체 runtime의
  후속 snapshot·heartbeat가 교정하는지 확인하지 못했다. 두 참가자의 실제
  시작 → 공유 → 종료 → 다음 상태 관측 재현이 필요하며 아직 결함으로 세지 않는다.
  파일을 paused로 복원하는 것 자체는 [기존 정책](../appstate-decomposition.md)이다.
- **서로 다른 채널의 프리로드 순서:** 다른 preload의 reorder 버퍼 정리 또는
  foreground watchdog 취소가 의심되지만 실제 sender 우선순위·채널 순서로
  도달하는 전체 wire trace가 없다. 임의 패킷 배열만으로 확정하지 않았다.
- **방 이동 뒤 채팅 금지 잔류:** 실제 일반방 종료는 재로드한다. raw helper만
  호출한 테스트의 잔류를 사용자 결함으로 세지 않았다.
- **SW 재시작 뒤 상태 누락:** 기존 cache-status probe가 클라이언트 상태를
  다시 받는다. 진행 중인 방의 업데이트 유예도 명시된 정책이다.
- **최초 대용량 엔진의 완전 오프라인 로딩:** precache 보장 범위 밖의 지연
  모듈이라는 한계는 있으나 이번에 재현·제품 계약 위반을 확정하지 않았다.
- **계정 통계 전송 재시도 없음:** 불명확한 성공 뒤 이중 집계를 피하는 명시된
  at-most-once 정책이다. 과거 쿠키 reader rollback 경계도 기존 기록을 유지한다.

## 재현 자료와 다음 작업

로컬 재현 파일은 Git에서 제외되는 `scratch/qa-batch-discovery-2026-09-27/`에
보관했다. 이 문서만 내려받은 새 checkout에는 아래 도구가 없으며, 제품 회귀
테스트에 이미 추가됐다고 간주하면 안 된다. 위 입력·처리 경로·관측값이
후속 회귀 테스트의 재구성 기준이다.

- B01: `rooms/manifest-collision.test.ts`, `rooms/worker-admission.test.ts`, `rooms/vitest.config.ts`.
- B02: `surface/chat-mute.test.ts`, `surface/vitest.config.ts`.
- B03: `root/translation-export-cap.mjs` — 실제 카탈로그를 이용한 SQLite 경계 비교.
- B04: `media/native-boundary-probe.mjs`, `media/native-boundary-results.json`.
- 각 영역 보고서와 주 검토자의 독립 실행 로그도 같은 디렉터리에 있다.

로컬 명령 예시(Node 24.20.0이 PATH에 있을 때):

```powershell
node node_modules/vitest/vitest.mjs run --config scratch/qa-batch-discovery-2026-09-27/rooms/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scratch/qa-batch-discovery-2026-09-27/surface/vitest.config.ts
node scratch/qa-batch-discovery-2026-09-27/root/translation-export-cap.mjs
node scratch/qa-batch-discovery-2026-09-27/media/native-boundary-probe.mjs
```

현재 재현용 테스트의 녹색을 수정 완료로 표시하지 않는다. 수정 작업에서는
정상 기대치로 회귀를 만들고 먼저 실패를 확인한 뒤 구현을 바꾸는 순서가 필요하다.
제품 수정·main 병합·프로덕션 배포·운영 감사 재활성화는 이번에 하지 않았다.
