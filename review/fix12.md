# fix12 — 12차 전수검사 감사 보고서

**일시**: 2026-03-13
**범위**: `src/` 전체 (Audio, Core, Network, Player, Storage, YouTube, UI, Cross-module)
**기준**: fix11 + 이전 fix12 수정 커밋(`938c4ec`) 이후 상태
**이전 누적 수정**: ~88건 (fix01–fix11)

---

## 요약

| 심각도 | 건수 | 설명 |
|--------|------|------|
| HIGH   | 2    | relay _originPeer 스푸핑(1), YouTube scope abort(1) |
| MEDIUM | 15   | NaN 전파(3), 타이머 이름 불일치(1), YouTube sub-seek(1), reorder overflow(1), early-chunk session(1), duplicate disconnect(1), joinSession race(1), hot-path Set 할당(1), stale map entry(1), QR race condition(1), guest slider desync(1), prevTrack desync(1), auto-play intent(1) |
| LOW    | 7    | 스테일 오디오 복구 가드(1), preload 로그 변수(1), setEQ 비정수 인덱스(1), timers Map 순회(1), sub-item stale closure(1), Space key scroll(1), sub-index seek 타이밍(1) |
| **합계** | **24** | 전부 수정 완료 ✅ |

---

## HIGH (2건)

### H-1. relay `_originPeer` 스푸핑 — 비OP가 OP 명령 실행 가능 (보안) ✅
- **파일**: `src/network/protocol.ts:170`
- **문제**: relay 노드가 downstream→upstream request 전달 시 `raw._originPeer || conn.peer`로 설정. 악의적 downstream 피어가 같은 relay에 있는 OP 피어의 ID를 `_originPeer`에 설정하면, 호스트의 `isAssignedRelay()` 체크를 통과하고 `verifyOperator`가 스푸핑된 OP를 확인 → 비OP가 OP 전용 명령(재생/정지/트랙변경 등) 실행 가능.
- **수정**: `raw._originPeer || conn.peer` → `conn.peer` (항상 실제 발신자로 덮어쓰기)

---

## MEDIUM (11건)

### H-2. YouTube IFrame API 첫 로드 시 scope abort — 플레이어 생성 불가 ✅
- **파일**: `src/youtube/iframe.ts`
- **문제**: `replaceYtScope()` → `bus.emit('player:stop-all-media')` 순서에서, stop-all-media가 동기적으로 `stopYouTubeMode()` 호출 → 방금 생성된 scope를 즉시 dispose. IFrame API 스크립트 로드 후 `onYouTubeIframeAPIReady`에서 `scope.aborted === true` → 플레이어 생성 건너뜀. 첫 YouTube 로드에만 발생 (API 미로드 상태).
- **수정**: `bus.emit('player:stop-all-media')` + `setEngineMode`를 scope 생성 이전으로 이동

---

## MEDIUM (15건)

### M-1. `handleRequestSetting` EQ — NaN 전파로 Tone.js 오디오 노드 손상 ✅
- **파일**: `src/player/playlist.ts`
- **문제**: `data.band`나 `val`이 비숫자일 때 NaN 반환 → `setEQ` 범위 체크 통과 → Tone.js 노드 손상 + 전체 피어 전파.
- **수정**: `if (!Number.isFinite(band) || !Number.isFinite(v)) break;` 추가

### M-2. `handleRequestSetting` PREAMP/STEREO/VBASS/REVERB — 동일한 NaN 전파 ✅
- **파일**: `src/player/playlist.ts`
- **문제**: M-1과 동일 패턴. 4개 case에서 `isFinite` 검증 누락.
- **수정**: 각 case에 `if (!Number.isFinite(v)) break;` 추가

### M-3. reverb 핸들러 — NaN 값이 UI 동기화 이벤트 발행 ✅
- **파일**: `src/audio/effects.ts` (mix/decay/predelay/lowcut/highcut 5개 핸들러)
- **문제**: `setReverbParam`은 내부에서 NaN 거부하지만, 호출부가 무조건 UI sync 이벤트 발행 → 슬라이더에 NaN 설정.
- **수정**: 각 핸들러 상단에 `if (!Number.isFinite(v)) return;` 추가

### M-4. recovery 타이머 이름 불일치 — 세션 이탈 시 타이머 미정리 ✅
- **파일**: `src/storage/recovery.ts:87` vs `recovery.ts:267`
- **문제**: 케밥-케이스(`recovery-backoff`)로 생성 → 카멜케이스(`recoveryBackoff`)로 클리어 시도 → 실패.
- **수정**: `clearManagedTimer('recoveryBackoff')` → `clearManagedTimer('recovery-backoff')`

### M-5. `handleRequestYouTubeSubSeek` — `playlistIdx` 무시 ✅
- **파일**: `src/youtube/handlers.ts`
- **문제**: 비활성 YouTube 재생목록 항목의 서브아이템 seek 시 `playlistIdx` 무시 → 잘못된 영상에서 seek.
- **수정**: `playlistIdx` 체크 분기 + `bus.emit('playlist:play-track')` 추가

### M-6. reorder buffer overflow — fall-through ✅
- **파일**: `src/storage/transfer-receive.ts`
- **문제**: buffer 500건 초과 시 clear + recovery 요청 후 `return` 누락 → 청크 재추가 + 잘못된 offset drain.
- **수정**: `return;` 추가

### M-7. meta-recovery early-chunk replay — 세션 ID 필터 누락 ✅
- **파일**: `src/storage/transfer-receive.ts`
- **문제**: meta-recovery 후 모든 early chunk replay — 이전 세션의 stale 청크 혼입 가능.
- **수정**: `earlyChunks.filter(ec => ec.sessionId === incomingSid)` 추가

### M-8. `handleForceCloseDuplicate` — `isIntentionalDisconnect` 미설정 ✅
- **파일**: `src/network/guest.ts`
- **문제**: 중복 커넥션 force-close 후 HOST_DISCONNECTED 에러 표시.
- **수정**: `setState('network.isIntentionalDisconnect', true);` 추가

### M-9. `joinSession` — 중복 호출 가드 미존재 ✅
- **파일**: `src/network/guest.ts`
- **문제**: 빠른 더블클릭 → 중복 커넥션 → M-8과 연쇄.
- **수정**: `if (getState('network.isConnecting')) return;` 가드 추가

### M-10. `RELAY_LOCAL_REQUESTS` hot-path 내 Set 할당 ✅
- **파일**: `src/network/protocol.ts`
- **문제**: `handleData` (모든 P2P 메시지 디스패치) 내부에서 매 호출마다 `new Set()` 생성 → 파일 전송 시 초당 수백 번 GC 부하.
- **수정**: module scope로 호이스트

### M-11. duplicate rejection 시 `activeHostConnByPeerId` 미정리 ✅
- **파일**: `src/network/host.ts`
- **문제**: 중복 커넥션 감지 → 새 conn을 map에 저장 → max-guest 초과로 거절 시 map entry 미삭제 → stale entry 잔존.
- **수정**: rejection 경로에 `cleanupConns.delete(peerId)` + setState 추가

### M-12. QR 코드 생성 비동기 race condition ✅
- **파일**: `src/ui/connect.ts`
- **문제**: `generateQR`는 async이나 staleness guard 없음. 세션 코드 변경 시 이전 호출의 stale QR SVG가 새 호출 결과를 덮어쓸 수 있음 → 만료된 세션 코드 QR 표시.
- **수정**: per-container generation counter 추가, await 후 counter 비교하여 stale 결과 폐기

### M-13. guest slider visual desync — 슬라이더 이동하나 오디오 미변경 ✅
- **파일**: `src/ui/settings.ts`
- **문제**: 비OP 게스트가 reverb/EQ 슬라이더 드래그 시 `_isGuestLocked()` early return하나 네이티브 input은 이미 시각적으로 이동 → 슬라이더 위치와 실제 파라미터 불일치.
- **수정**: `_updateHostCtrlLockUI()`에서 locked 시 range input `disabled = true` 설정

### M-14. `playPrevTrack` IDLE 상태에서 host-guest desync ✅
- **파일**: `src/player/playlist.ts`
- **문제**: 첫 트랙에서 이전 트랙 시 `play(0)` 호출하나 IDLE 상태에서는 미디어 소스 없어 silent fail. 하지만 `MSG.PLAY` broadcast는 실행 → 게스트만 재생 시작, 호스트는 IDLE 유지.
- **수정**: IDLE 상태 분기 추가 → `playTrack(currentTrackIndex)`로 파일 리로드

### M-15. `youtube:auto-play` 이벤트에서 `_ytAutoplayIntent` 미설정 ✅
- **파일**: `src/youtube/player.ts`
- **문제**: `playlist:play-track` 경로에서 `autoplay=false`로 로드 후 3초 후 `youtube:auto-play` 발행 → `player.playVideo()` 호출 → onStateChange PLAYING 감지 → `_ytAutoplayIntent=false`이므로 즉시 pause → play-then-pause 플리커.
- **수정**: `playVideo()` 호출 전 `setYtAutoplayIntent(true)` 추가

---

## LOW (2건)

### L-1. stale-audio recovery 가드 조건 오류 ✅
- **파일**: `src/player/playback.ts`
- **문제**: 스테일 오디오 버퍼 존재 시 복구 요청 안 됨 → 게스트 영구 블록.
- **수정**: 버퍼 존재 여부 → `transfer.meta.name` 이름 일치 여부로 변경

### L-2. preload 로그 stale 변수 사용 ✅
- **파일**: `src/storage/preload.ts`
- **문제**: drain 후 로그에 drain 전의 stale `session` 변수 사용.
- **수정**: `session` → `freshSession`

### L-3. `setEQ` 비정수 band index로 배열 state 오염 ✅
- **파일**: `src/audio/effects.ts`
- **문제**: `bandIdx`가 `1.5` 같은 비정수일 때 bounds 체크 통과 → `newValues[1.5] = clamped`로 배열에 문자열 키 프로퍼티 생성. NaN일 때도 `NaN < 0`이 false → 통과.
- **수정**: `Math.floor(Number(idx))` + `Number.isFinite` 가드 추가

### L-4. `clearAllManagedTimers` Map 순회 중 삭제 — 방어적 스냅샷 ✅
- **파일**: `src/core/timers.ts`
- **문제**: `_timers.keys()` 순회 중 `clearManagedTimer`가 `.delete()` 호출. ES2015+ 스펙상 안전하지만 코드베이스 내 다른 패턴(`BlobURLManager.revokeAllNow`)은 `Array.from()` 스냅샷 사용.
- **수정**: `Array.from(_timers.keys())`로 방어적 스냅샷

### L-5. playlist sub-item 클릭 시 stale `isCurrent` closure ✅
- **파일**: `src/ui/playlist-view.ts`
- **문제**: `isCurrent`가 렌더 시점에 캡처되어 클릭 시점과 불일치 가능 (debounced 렌더 사이에 트랙 변경). 잘못된 `false` → 불필요한 트랙 전환.
- **수정**: 클릭 핸들러 내에서 `getState('playlist.currentTrackIndex')`로 실시간 비교

### L-6. role badge Space 키 페이지 스크롤 ✅
- **파일**: `src/ui/player-controls.ts`
- **문제**: `roleBadge` keydown에서 Space 키 처리 시 `preventDefault()` 누락 → 액션 실행 + 페이지 스크롤 동시 발생. 같은 파일의 logo handler는 올바르게 `preventDefault()` 호출.
- **수정**: `e.preventDefault()` 추가

### L-7. guest YouTube state에서 sub-index 변경 직후 seek 타이밍 ✅
- **파일**: `src/youtube/sync.ts`
- **문제**: `YOUTUBE_STATE` 메시지에 `subIndex` 변경 + `time`이 동시에 있을 때, `playVideoAt(subIndex)` 후 즉시 `seekTo(time)` 호출. 새 비디오 미로드 상태에서 seek → 이전 비디오에 적용되거나 무시됨.
- **수정**: `subIndexChanged` 플래그 추가, 변경 시 `seekTo` 건너뜀

---

## 오탐/유보 필터링 결과

| 카테고리 | 검토 항목 | 결과 |
|----------|-----------|------|
| Bus 이벤트 일관성 | emit/on 매칭 | CLEAN |
| State 경로 | getState/setState 경로 유효성 | CLEAN |
| Protocol 메시지 | 핸들러 등록 누락 | CLEAN |
| Import 순환 | 순환 import | CLEAN |
| 재수출 | playback.ts re-exports | CLEAN |
| Audio 초기화 | initAudio 레이스 | CLEAN (fix12에서 수정됨) |
| YouTube lifecycle | 플레이어 생성/파괴 | CLEAN |
| peer-relay-lost 미청취 | relay.ts emit / orchestrator listen | 유보 (호스트 직접 close가 이미 peer-disconnected 트리거) |
| broadcastFile 참조 공유 | transfer-send.ts chunkMsg | 유보 (PeerJS structured clone 직렬화) |
| relay upstream preload recovery | relay.ts close handler | 유보 (현재 preload는 relay 경로에서 별도 세션으로 관리) |
| batchSetState re-entrant 이중 발행 | state.ts batchSetState emission | 유보 (이론적 시나리오, 리팩토링 범위 큼) |
| snapshot() 반환 타입 | state.ts snapshot | 유보 (디버그 전용, Set/Map→array/object 변환) |
| batchSetState 코드 중복 | state.ts mutation 로직 | 유보 (유지보수 위험이지만 현재 버그 아님) |
| YouTube dead handlers | REQUEST_YOUTUBE_PLAY/PAUSE | 유보 (핸들러 존재하나 전송 측 없음, 향후 확장용 유지) |
| OP 버튼 aria-label | connect.ts, settings.ts | 유보 (접근성 개선, 기능적 영향 없음) |
| repeat-one 전체 재디코딩 | playlist.ts handleEnded | 유보 (성능 최적화, handleEnded 흐름 리팩토링 필요) |
| blob URL revoke 순서 | transport.ts stopAllMedia | 유보 (실제로는 Tone.BufferSource가 blob 미참조, 방어적 개선) |
| 비디오 전용 종료 감지 | transport.ts handleEnded | 유보 (Tone 클럭 vs 비디오 duration 드리프트, 드문 케이스) |

---

## 결론

12차 전수검사에서 총 **24건** 발견 (H2 + M15 + L7), 전부 수정 완료.
이전 11차까지 88건 + 이전 fix12에서 28건 수정 후 남은 잔여 이슈.

주요 패턴:
- **보안**: relay _originPeer 스푸핑 (H-1) — 가장 심각
- **NaN 전파**: 네트워크 요청 경로의 검증 누락 (M-1~M-3)
- **네트워크 핸들러 비대칭**: 로컬/네트워크 경로 불일치 (M-5, M-8, M-9, M-11)
- **문자열 키 불일치**: 타이머 이름 케밥/카멜 (M-4)
- **transfer 엣지케이스**: overflow fall-through, session 필터 (M-6, M-7)
- **성능**: hot-path 내 불필요한 할당 (M-10)
- **UI**: QR race condition, guest slider desync, stale closure, a11y (M-12, M-13, L-5, L-6)

누적 수정: ~140건 (fix01–fix12)
`npx tsc --noEmit` — 에러 없음 ✅
