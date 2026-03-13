# fix16 — 16차 전수조사

## 감사 범위
- **대상**: fix15 완료 후 전수 감사 (Audio, Core, Network, Player, Storage, YouTube, UI)
- **에이전트**: 3개 병렬 감사 (Audio+Core / Network / Player+Storage+YT+UI)
- **Raw 발견**: 16건 (H1 + M5 + L10)

---

## HIGH (1건)

### H-1. YouTube `stopVideo()` → ENDED → next-track race — `transport.ts` + `iframe.ts`

**심각도**: HIGH
**문제**: `stopPlayback()`에서 `youtube:stop-playback` emit → `player.stopVideo()` →
YouTube API가 ENDED 상태 발생 → `onYouTubePlayerStateChange`에서 host가 `playlist:next-track` emit.
명시적 Stop이 정지 대신 다음 곡 재생으로 이어짐.
**수정**: `stopPlayback`에서 `youtube:stop-playback` 전에 `appState = IDLE` 설정 →
`onYouTubePlayerStateChange`의 `currentState !== PLAYING_YOUTUBE` 가드로 무시.

---

## MEDIUM (5건)

### M-1. downstream 재연결 시 old conn close가 new pump 중단 — `relay.ts:355,367`

**심각도**: MEDIUM
**문제**: catchup pump가 peerId 키 기반 → old conn의 close 이벤트가 new conn의 pump 중단.
**수정**: `stopOpfsCatchupStream` 호출 전 `pump.conn === conn` 참조 검증.

### M-2. max-guests 축소 시 잘린 슬롯 peer 미제거 — `host.ts:329-344`

**심각도**: MEDIUM
**문제**: `releasePeerSlot`만 호출, peer는 connectedPeers에 잔류 → 정원 초과 상태.
**수정**: 잘린 슬롯의 peer를 kick 처리.

### M-3. `handleEnded` PLAYING_AUDIO를 video readyState 가드에 포함 — `transport.ts:386`

**심각도**: MEDIUM
**문제**: `usesVideoElement`에 PLAYING_AUDIO 포함 → 오디오 트랙에서 video readyState < 1이면 종료 불가.
**수정**: `usesVideoElement = currentState === APP_STATE.PLAYING_VIDEO`로 변경.

### M-4. stale-audio recovery 타이머에서 stale `currentTrackIndex` — `playback.ts:140`

**심각도**: MEDIUM
**문제**: 5초 타이머 콜백이 외부 스코프의 `currentTrackIndex` 사용 → 곡 변경 시 잘못된 인덱스로 요청.
**수정**: 타이머 콜백 내에서 `getState('playlist.currentTrackIndex')` 재조회.

### M-5. meta-recovery 시 `nextExpectedChunk` 미리셋 — `transfer-receive.ts:586-628`

**심각도**: MEDIUM
**문제**: 이전 세션의 `nextExpectedChunk` 값 잔류 → 청크 0~N-1이 reorder buffer에 적체.
**수정**: meta-recovery 경로에 `nextExpectedChunk = 0` 추가.

---

## LOW (10건)

### L-1. `safeRevoke(force)` 기존 타이머 미정리 — `blob-manager.ts:140`

**심각도**: LOW
**문제**: force 재스케줄 시 기존 타이머 ID 덮어쓰기 → orphan 타이머가 먼저 실행.
**수정**: `this._clearScheduled(url)` 호출 후 새 타이머 등록.

### L-2. OP 게스트 conn closing 시 설정 변경 silent drop — `effects.ts:347-353`

**심각도**: LOW
**문제**: `isOperator && !hostConn.open` 경로에 토스트 없음 → 사용자 혼란.
**수정**: else 분기에 connection_lost 토스트 추가.

### L-3. timeout 후 close 핸들러 중복 → 이중 토스트 — `relay.ts:282-287`

**심각도**: LOW
**문제**: timeout이 conn.close() 호출 → close 핸들러도 실행 → toast 2회.
**수정**: close 핸들러에서 `currentUpstream === null && currentUpstream !== conn` 시 early return.

### L-4. `handleAssignDataSource(null)` 무조건 recovery — `relay.ts:394-403`

**심각도**: LOW
**문제**: 전송 미활성 시에도 `storage:request-recovery` emit.
**수정**: `TRANSFER_STATE.IDLE`이면 recovery 스킵.

### L-5. `waitForGuestConnectionType` 비원자적 이중 읽기 — `peer-state.ts:325-326`

**심각도**: LOW
**문제**: `check()` 2회 호출 사이 state 변경 가능성 (실질적 위험 극히 낮음).
**수정**: 결과를 변수에 저장 후 재사용.

### L-6. `adjustSync` paused 상태 offset 이중 적용 — `transport.ts:559-571`

**심각도**: LOW
**문제**: `localOffset += val` + `pausedAt += val` → resume 시 이중 보정.
**수정**: paused 상태에서 pausedAt 수정 제거 (offset이 play()에서 적용됨).

### L-7. `opfsFilename` null 가드 누락 — `decode.ts:367`

**심각도**: LOW
**문제**: `getState('files.currentFileOpfs')`가 null이면 `.name` 접근 시 TypeError.
**수정**: `opfsFilename?.name`으로 변경.

### L-8. preload 세션 eviction 삽입 순서 — `preload.ts:52-58`

**심각도**: LOW
**문제**: Map 순회가 삽입 순서 기반 → 숫자상 가장 오래된 세션이 아닐 수 있음.
**수정**: 세션 ID 숫자 정렬 후 eviction.

### ~~L-9. relay upstream close 시 cleanup 이벤트 미발행~~ — 오탐 (hasActiveRelay 정상 동작)

### L-10. `FILE_END` 전송 전 abort 미확인 — `transfer-send.ts:127-135`

**심각도**: LOW
**문제**: 루프 종료 후 supersession 발생 시 stale FILE_END 전송.
**수정**: `scope.aborted` 재검사 추가.

---

## 통계
| 심각도 | 건수 |
|--------|------|
| HIGH | 1 |
| MEDIUM | 5 |
| LOW | 9 (L-9 오탐 제외) |
| **합계** | **15건 수정** |

## 커밋
- (pending): fix16 전수조사 15건 수정
