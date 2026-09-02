# 시나리오 오디트 — 재생/네트워크/프리로드 교차 상태 분석 (2026-06-10)

> **역사적 감사 기록.** 발견·수정 상태와 코드 위치는 2026-06-10 및 문서에
> 적힌 후속 커밋 기준이다. 현재 버그 목록이나 현재 릴리스 판정으로 사용하지
> 말고, 재사용 전 최신 코드와 실행 테스트로 다시 검증한다.

> 목적: "예상치 못한 사용 방식" 대비. 모드 전환 × 반복/셔플 × 프리로드 생명주기 × 역할(호스트/게스트/OP) 조합을
> 교차시켜 시나리오 단위로 깨지는 지점을 추적한 결과. 커밋 단위 sweep(1~20차 오디트)과 달리
> **상태 기계 교차곱** 관점의 분석. 5건 모두 사용자 검증으로 실제 이슈 확정 (2026-06-10).
>
> 분석 범위: src/player/* 전체, src/network/sync.ts·system-audio-host.ts, src/youtube/sync.ts·handlers.ts·_state.ts,
> src/storage/preload.ts·transfer-receive.ts(부분), src/audio/system-capture.ts. 약 9,000줄 정독.

## 상태: SA-01~05 + SA-08 수정 완료 (2026-06-10, 3개 그룹 커밋)

| # | 제목 | 심각도 | 상태 |
|---|------|--------|------|
| SA-01 | 셔플+반복OFF 무한 재생 (프리로드 random fallback) | P2 (행동) | ✅ 수정 (Group A: random fallback 제거 → nextIdx=-1) |
| SA-02 | 시스템오디오 공유 중 트랙 클릭 → 복원 로직이 새 선택을 짓밟음 | P2 | ✅ 수정 (Group C: force-stop=복원 금지, 명시적 stop만 복원) |
| SA-03 | 다운로드 중이던 게스트, 시스템오디오 종료 후 영구 무음 | P2 | ✅ 수정 (Group C: PLAY 수신 시 no-buffer+IDLE/FAILED → REQUEST_CURRENT_FILE) |
| SA-04 | play() 진입점 6곳 파이프라인-busy 가드 누락 | P3 (F-1701 sibling) | ✅ 수정 (Group B: 6곳 가드 + play() 소스레벨 pendingPlayTime 큐잉 + busy-guard.test.ts ratchet) |
| SA-05 | 호스트 프리로드 활성화 실패 후에도 PLAY 브로드캐스트 | P3 | ✅ 수정 (Group A: loadPreloadedTrack→boolean, 호스트 실패 시 markFailedAndAdvance) |

SA-08(시스템오디오 START watchdog 비대칭)도 Group C에서 함께 수정
(`cancelIncomingFileTransfer('system-audio-start')` — 유튜브 전환과 대칭).

**후속 라운드 (같은 날)**: 사용자 정책 확정으로 3건 추가 수정 —
- SA-09 ✅: **정책 확정 "방이 일시정지면 게스트도 resume 불가"**. media-session play 핸들러가
  `isLocalFilePaused()`일 때만 로컬 resume 허용 (로컬 일시정지=호스트 재생 중인 경우만).
  유튜브 쪽은 이미 같은 정책(rendezvous host-paused 분기)이라 파일 모드만 정렬.
- SA-12 ✅: repeat-one 타이머가 fire 시점에 currentTrackIndex 재읽기.
- SA-13 ✅: 데모 진입 시 `cancelOutgoingFileTransfers()`.

미수정 잔여: SA-06/07/10/11 (자가치유/의도된 트레이드오프, 기록 유지).

**Phase 4(대규모 리팩터링) 평가 결과**: stopAllMedia를 stopForTransition/stopTerminal로
분리하는 옵션을 검토했으나 기각 — `silent` 플래그가 이미 '전환' 의미를 인코딩하고 있고,
force-stop 의미론 수정이 그 의미를 시스템오디오까지 일관 확장하는 root fix.
50+ 호출처 리팩터링은 리스크 대비 가치 부족.

---

## SA-01 — 셔플 + 반복 OFF는 영원히 끝나지 않음

**시나리오**: 로컬 파일 2개 이상, 셔플 ON, 반복 OFF. 전곡 청취 후 "재생목록 끝"이 떠야 하는데
마지막 곡이 끝나면 임의의 곡이 계속 재생됨. 트랙 2개로도 재현 (A↔B 무한 교대).

**경로**:
1. 마지막 셔플 순번 곡 재생 중 `preloadNextTrack()` 실행
2. `src/storage/preload.ts:226` — `getShuffleNextIndex()`가 -1 반환 (패스 끝 + repeat OFF)
3. → **랜덤 픽 fallback**으로 떨어져 임의 곡을 프리로드 (`do { random } while (== current)`)
4. 곡 자연 종료 → `playNextTrack` → `src/player/playlist.ts:728` `advanceToShuffleNextIndex(preload.nextTrackIndex)`
5. `playlist.ts:133-141` preferredIndex 분기는 반복 모드/패스 종료를 안 보고 유효하면 무조건 채택
6. → `handleEndOfPlaylist('shuffle-end')` 도달 불가

랜덤 픽이 유튜브 트랙이면 프리로드가 비어 정상 종료되는 **비결정성**도 있음.

**수선 방향**: hinted === -1이면 랜덤 픽 대신 `clearPreloadCacheState()` 후 return
(시퀀셜 모드의 `nextIdx = -1` 처리와 대칭).

## SA-02 — 시스템오디오 공유 중 로컬 트랙 클릭 → 공유 전 유튜브가 부활

**시나리오**: 유튜브 재생 → 시스템오디오 공유 시작 → 공유 중 플레이리스트에서 로컬 파일 클릭.
기대: 공유 종료 + 클릭한 파일 재생. 실제: 공유 전에 보던 유튜브 영상이 방 전체에 다시 로드되고
클릭한 파일의 디코드는 abort됨.

**경로**:
1. `playTrack`이 새 index/메타 세팅 후 `stopAllMedia({silent:true})` 호출
2. `src/player/transport.ts:255` — `system-audio:force-stop` emit이 **동기적으로** `stopSystemAudioCapture()` 실행
3. `src/audio/system-capture.ts:311` → `restorePreSystemAudioPlaybackState()` — "새 트랙 선택 진행 중"을 모름
4. 스냅샷이 youtube → `youtube:restore-room-playback` (`src/youtube/player.ts:515`)이
   currentTrackIndex를 옛 값으로 되돌리고 + YOUTUBE_PLAY(옛 영상) 브로드캐스트 + youtube ownership 클레임
5. `playTrack` 후속의 `loadAndBroadcastFile` 디코드 완료 시 `src/player/decode.ts:176`
   `isExternalOwner()` 가드에 걸려 abort

**변종**:
- 스냅샷이 file이면: restore가 `setPlaybackTrackMeta(옛 메타)`로 새 메타를 덮어씀 →
  새 곡이 옛 곡 제목으로 재생 (`loadAndBroadcastFile`은 currentTrackMeta를 다시 안 씀)
- 공유 중 현재 트랙 ❌삭제 → `playlist.ts:1440` needsPlayRestart → playTrack → 동일 경로
- UI 가드 없음 확인: `src/ui/playlist-view.ts:149` (호스트 클릭 그대로 통과)

**수선 방향**: "전환" 맥락의 stopAllMedia에서는 `_preSysAudioState` 무효화 + 복원 스킵.
(force-stop emit에 reason 전달 or playTrack 진입 시 스냅샷 클리어.)
근본적으로 stopAllMedia가 '정지'와 '전환' 두 의미로 쓰이는데 시스템오디오 복원만 그 구분을 못 받는 구조.

## SA-03 — 다운로드 중이던 게스트, 시스템오디오 종료 후 영구 무음

**시나리오**: 게스트가 파일 수신 중 → 호스트 시스템오디오 공유 시작 → 종료 → 호스트 play.
해당 게스트만 무음, 호스트가 다른 트랙으로 바꿀 때까지 복구 경로 없음.

**경로**:
1. START: 게스트 `stopAllMedia` + `claimPlaybackOwner('system-audio', {pending})` (`src/network/system-audio-guest.ts:717`)
2. 이후 도착 청크는 `src/storage/transfer-receive.ts:127` `shouldSkipIncomingFile()` 외부 owner 체크로 전부 폐기 → 다운로드 사망
3. STOP: `cleanupGuestSystemAudio` → `setPlaybackIdle()` (lifecycle=IDLE, 버퍼 없음)
4. 호스트 PLAY 도착 → index 일치라 index-mismatch 복구 분기 못 탐 →
   `src/player/playback.ts:320` pendingPlayTime 저장만 하고 끝
5. SYNC_PONG 부트스트랩도 버퍼 없음 → `src/network/sync.ts:385` skip → 무한 대기

**부가**: 시스템오디오 START 경로는 (유튜브 전환의 `cancelInFlightTransfer`와 달리)
`chunkWatchdog`/`prepareWatchdog`를 안 지움 → 공유 중 watchdog가 REQUEST_DATA_RECOVERY를 쏘고
호스트가 재전송해도 게스트가 다 버리는 낭비 루프 가능 (재시도 상한은 있음).

**수선 방향**: 게스트 STOP 정리부에서 "버퍼 없음 + currentTrackIndex 유효"면 REQUEST_CURRENT_FILE 1회,
또는 handlePlayMsg 버퍼-없음 분기에서 index 일치여도 복구 요청 허용.

## SA-04 — play() 진입점의 파이프라인-busy 가드 누락 (재스윕으로 6곳 확정)

**시나리오**: 호스트 트랙 전환 중 (3s 대기 + 디코드), OP 게스트가 시크바 드래그 — 또는 호스트 본인이
시크바 드래그 / Prev 버튼 / 장기 백그라운드 복귀. 호스트는 **이전 트랙 버퍼**를 재생하며
**새 index**로 PLAY 브로드캐스트.

**경로**: 16차 오디트 F-1701에서 `handleRequestPlay`(`playback.ts:459`), `togglePlay`(`transport.ts:694`),
`handlePlayMsg`(`playback.ts:216`)에는 `isFilePipelineBusyForPlay` 가드가 들어갔으나,
**2026-06-10 재스윕(play() 호출처 전수 매트릭스)으로 누락 지점 6곳 확정**:

| # | 진입점 | 도달 경로 | 비고 |
|---|--------|-----------|------|
| 1 | `seekTo` — `transport.ts:386` | 호스트 시크바 드래그 (seekbar.ts:84 — UI 가드 없음 확인) + OP→host | play+broadcast |
| 2 | `skipTime` — `transport.ts:843` | media-session seekforward/backward + REQUEST_SKIP_TIME | play+broadcast |
| 3 | `handleRequestSeek` — `playback.ts:516` | OP 게스트 시크 | play+broadcast |
| 4 | `playback:refresh-current-position` 핸들러 — `playback.ts:594` | 호스트 장기 백그라운드 복귀 (app.ts:242) | 로컬 play만 |
| 5 | `playPrevTrack` restart-current 분기 — `playlist.ts:827` (셔플) | busy 중 Prev: pos=0이라 pos>3 분기 못 타고, 셔플 패스 시작점이면 `!isQueueIdle()` → play(0)+broadcast | play+broadcast |
| 6 | `playPrevTrack` restart-current 분기 — `playlist.ts:848` (시퀀셜 첫 트랙) | busy 중 Prev + currentTrackIndex=0 + repeat≠all | play+broadcast |

공통 원인: 트랙 전환 중 `stopAllMedia({silent})`가 mode=file/playing을 의도적으로 유지하므로
`isPlaybackPlayingFile()`/`!isQueueIdle()`이 통과. 게스트는 자기 lifecycle 게이트가 막아줘서
호스트-로컬 증상 위주. 당시의 지연 시작이 뒤늦게 상태를 덮어써 자가 치유됐지만,
그 전까지 이전 곡이 잘못 재생되는 문제가 있었다.

**P4 변형 (브로드캐스트만, 로컬 재생 없음)**: 호스트 sync 버튼(`player-controls.ts:505-519`
`handleMainSyncBtn`)도 busy 중 `getTrackPosition()`=0으로 PLAY/PAUSE(time=0, 새 index)를 브로드캐스트.
같은 가드를 공유하면 함께 닫힘.

**수선 방향**: 6개 진입점에 동일 가드 1줄 (+ sync 버튼). 사각 ⑤ 재발 방지로
"play()를 부르는 모든 제어 핸들러는 busy 가드 필수"를 guard:* 스크립트로 ratchet 권장 —
이번 재스윕이 그 ratchet의 초기 화이트리스트 목록이 될 수 있음.

**전수 매트릭스에서 안전 확인된 진입점** (가드 불필요, 기록):
`togglePlay`·`handleRequestPlay`·`handlePlayMsg`(기존 가드), `adjustSync` 넛지(게스트 전용 +
busy 시 buffer null이라 차단), `handleAutoSync`(게스트, mode=pending이라 차단),
SYNC_PONG bootstrap/drift(lifecycle 3-state 게이트), same-file resident 검증,
preload/finalize의 pendingPlayTime 소비(새 buffer 직후), demo 내부(자체 토큰),
`audio:surround-toggled`(UI 미연결 cold storage — 재활성화 시 가드 필요 주석 권장).

## SA-05 — 호스트 프리로드 활성화 실패 후에도 PLAY 브로드캐스트

**시나리오**: 호스트(특히 iOS Safari)가 프리로드된 다음 곡으로 전환했는데 해당 파일이 호스트 기기에서
디코드 실패. (프리로드는 blob만 준비, 디코드는 활성화 시점 — 호스트도 이때가 첫 디코드.)
게스트들은 정상 재생, 호스트만 무음 + 엉뚱한 "미디어를 추가해주세요" 토스트.

**경로**:
1. `src/player/playlist.ts:472-474` preloaded fast-path: `await loadPreloadedTrack()` 실패 여부를 안 봄 (catch가 throw 안 함)
2. 실패 시 버퍼는 디코드 전에 null로 비워진 상태 → `play(0)`은 empty_hint 토스트 후 return
3. 다음 줄 `broadcast(PLAY)`는 무조건 발사 → 게스트만 재생
4. `loadAndBroadcastFile` 실패와 달리 `markFailedAndAdvance` 자동 진행 없음.
   decode.ts catch의 `sendToHost(REQUEST_CURRENT_FILE)`는 호스트에선 no-op
5. 같은 자리 토큰 재검사도 없음 → 빠른 연속 클릭 시 낡은 invocation이 stale PLAY(옛 index) 발사 가능

**수선 방향**: `loadPreloadedTrack`이 성공 여부 반환 → fast-path에서 실패/토큰 불일치 시
play+broadcast 스킵하고 `markFailedAndAdvance`로 위임.

---

## 마이너 (기록만, 수정 보류)

| ID | 내용 | 비고 |
|----|------|------|
| SA-M1 | 호스트 deselected(-1) 상태에서 비현재 트랙 삭제 → 게스트 `playlist.ts:960` `idx===-1 → 0` 강제로 0번 하이라이트 desync | 다음 PLAY에서 교정 |
| SA-M2 | repeat 토글 시 `clearPreloadState`가 peers' preloadedIndexes 캐시 와이프 + repeat-one self-preload → 이미 가진 현재 곡 전체를 전 게스트에 재전송 | 기능 무해, 모바일 데이터 낭비 |
| SA-M3 | OP의 반복/셔플 토글 낙관적 로컬 적용 → verifyOperator 거절 시 일시 desync | 브로드캐스트로 수렴 |

## 패턴 (재발 방지 관점)

다섯 건 모두 "정상 경로는 완벽, **fallback 또는 동시 진행 중인 다른 플로우가 끼어들 때**" 깨짐:
- SA-01: fallback(랜덤 픽)이 상위 의미론(end-of-playlist)을 모름
- SA-02: 복원 로직이 동시 진행 중인 신규 선택 플로우를 모름 (stopAllMedia의 '정지' vs '전환' 의미 분리 부재)
- SA-03: 모드 전환이 데이터 플레인(전송)을 죽였는데 복구 트리거 누락
- SA-04: 사각 ⑤ sibling sweep 미스 (같은 가드의 형제 누락)
- SA-05: async 헬퍼의 실패가 호출자에게 전파 안 됨 (사각 ⑧ Cancel/Error semantics 유사)

---

## 2차 스윕 — 잔여 전 도메인 (같은 날, 2026-06-10)

> 범위: storage 전체(transfer-send/receive·recovery·ramstore·storage), youtube 전체(iframe·player·search),
> network 전체(peer·peer-state·host·guest·protocol·orchestrator·shared-clock·system-audio-sfu/guest),
> share(remote-share·r2), player 잔여(media-session·video), demo, chat 핸들러, audio effects 핸들러, core(events·timers).
> 누적 약 22,000줄 정독.
>
> **결론: 신규 P2/P3 0건.** 이 도메인들은 9~20차 오디트가 집중적으로 다진 표면이라 가드 밀도가 높음
> (모든 네트워크 핸들러 isHostBroadcast/verifyOperator, validator + rate-limit, scope/token/generation 삼중 가드).
> 버그 수율은 1차 스윕의 "상태 기계 교차곱" 영역(player/preload/모드전환)에 집중돼 있었음 — 그쪽은
> 커밋 단위 sweep으로는 한 번도 교차 분석된 적이 없던 차원이라는 메타 관찰.

### P4 / 관찰 (수정 보류, 기록만)

| ID | 내용 | 비고 |
|----|------|------|
| SA-06 | **후발 게스트 이중 전송 reorder 비대**: broadcastFile 시작 직전에 join한 게스트는 eligiblePeers 스냅샷에 포함되고 bootstrap unicastFile도 받음 → 같은 sid의 두 스트림이 offset되면 이미 drain된 인덱스의 중복 청크가 `fileReorderBuffer`에 잔류 (drain 루프는 nextExpectedChunk 이후만 소비) → 큰 파일에서 MAX_REORDER_BUFFER(500) 초과 → 불필요한 recovery 1사이클 | **해결 (2026-08-04)**: exact connection·queueItemId·sessionId 송신 lane, recovery 인계, PREPARE/FILE_START 수신 fence, drain 완료 중복 청크 폐기로 단일 스트림을 보장. sync E2E 20회 반복 180/180 통과. |
| SA-07 | **빈 플레이리스트 + 디코드 인플라이트 유령 버퍼(게스트)**: `cancelIncomingFileTransfer`는 RECEIVING만 취소. PROCESSING(finalizeGuestFile 디코드 중)에 playlist-emptied가 오면 디코드 완료 후 buffer/currentFileBlob/transfer=READY가 빈 플레이리스트 위에 재발행됨 (lifecycle은 IDLE stay라 무해, 단 media-session 로컬 resume이 유령 재생 가능) | finalize에 load-session 가드는 있으나 빈-플레이리스트 이벤트가 세션을 안 올림. transfer-receive.ts:1486, decode.ts:951 |
| SA-08 | (SA-03 부가에서 승격 기록) 시스템오디오 START가 chunkWatchdog/prepareWatchdog를 안 지움 → 공유 중 헛 REQUEST_DATA_RECOVERY 루프 가능 (재시도 상한으로 수렴) | youtube 전환의 cancelInFlightTransfer와 비대칭. system-audio-guest.ts:717 |
| SA-09 | **non-OP 게스트 잠금화면 'play' (호스트 일시정지 중)**: media-session play → 로컬 단독 재생 시작. 호스트가 paused면 SYNC_PONG 교정 분기 자체가 안 돌아서 (`isSyncPongPlayingFile` false) 다음 호스트 PLAY/PAUSE까지 단독 재생 지속 | 로컬-pause 기능의 역방향 비대칭. 반쯤 의도된 UX로 볼 여지 있음. media-session.ts:116 |
| SA-10 | **호스트 stuck 휴리스틱에 BUFFERING(3) 포함**: 유효한 영상도 연속 버퍼링 18초( UNAVAILABLE_STUCK_THRESHOLD_MS)면 "unavailable"로 강제 스킵. 아주 느린 회선에서 오탐 가능 | 의도된 트레이드오프로 판단, 임계값 충분히 큼. iframe.ts:1454 |
| SA-11 | **데모 진입이 트랙 전환 디코드와 겹칠 때**: captureSnapshot이 (옛 buffer + 새 index) 쌍을 캡처 → 종료 복원 시 미스매치. 서브초 윈도우 | 12차 데모 가드 위에 남은 잔여 edge. demo/mode.ts:130 |
| SA-12 | **repeat-one 자연종료 300ms 윈도우 중 비현재 트랙 삭제 → stale index 브로드캐스트**: `player:ended` 리스너가 `currentTrackIndex`를 const로 캡처(playlist.ts:1236)하고 remove-track은 `_endedAdvanceToken`을 안 올림 → 300ms 뒤 `broadcast(PLAY, index=옛값)`. 오디오는 정상(같은 buffer), 게스트만 index-mismatch 복구 1회 낭비 | 좁은 윈도우 + 수렴. timer fire 시 fresh index 재읽기 또는 remove-track에서 토큰 bump로 해소 |
| SA-13 | **호스트 demo 진입 시 outgoing broadcastFile 미취소**: stopPlaybackForDemoEntry는 cancelInFlight(수신/디코드)만 — 진행 중이던 송신 브로드캐스트는 demo 동안 계속 스트리밍 (게스트는 lifecycle 게이트로 폐기) | 대역폭 낭비만. demo/mode.ts:205에 `cancelOutgoingFileTransfers()` 1줄 |

### 깨끗하게 통과한 표면 (체크 완료 기록)

- **protocol.ts**: validator 커버리지 + 토큰버킷 rate-limit + FILE_CHUNK/PRELOAD_CHUNK 예외 — 견고
- **ramstore/storage**: sid+name 이중 키, 2-tier 무결성 게이트(청크 수 + 바이트), finalize 후 chunks drop — 견고
- **recovery.ts**: backoff 중 트랙변경/세션변경/연결변경 재검사 전부 있음
- **host/guest 연결 수명주기**: 중복 연결 교체, TOCTOU 재검사, 슬롯 회수, stale close 가드 — 견고
- **shared-clock**: NaN/Infinity 거부, 클록 스텝 감지 플러시, 샘플 age 상한 — 견고
- **remote-share**: 14~15차 fix 전부 살아있음 (cancel propagation, stale-track 가드, 디스크립터 TTL 마진)
- **youtube sync/rendezvous**: 16~17차 fix 보존 (M1~M7, autoplay intent, 캘리브레이션 가드 4종)
- **chat/effects 핸들러**: isHostBroadcast/verifyOperator 전수 적용 확인
- **events/timers/state**: 누수 없는 구조 (BusScope, name-keyed timer, once-wrapper off 처리)
