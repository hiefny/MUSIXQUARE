# fix14 — 14차 감사

## 감사 범위
- **대상**: fix13 완료 후 전수 감사 (Audio, Core, Network, Player, Storage, YouTube, UI)
- **에이전트**: 3개 병렬 감사 에이전트 (Player+Storage+YT+UI / Audio+Core / Network)

## 감사 결과 요약
**H1 + M6 + L5 = 12 인스턴스** 발견 (전체 수정 완료).

---

## 발견 항목

### H-1. `sync:response`가 Guest 미디어 파괴 — `playback.ts`

**심각도**: HIGH
**문제**: Guest가 sync 버튼 누를 때 Host가 일시정지 상태면 `stopAllMedia()` 호출 → 오디오 버퍼 파괴 → 전체 재다운로드 필요.
**수정**: `stopAllMedia()` → `pause(compensatedTime)` 변경. 미디어 보존하며 일시정지만 수행.

### M-1. `skipTime` duration NaN 마스킹 — `transport.ts`

**심각도**: MEDIUM
**문제**: `_currentAudioBuffer?.duration ?? videoElement.duration` — `??`는 `null`/`undefined`만 잡고 `NaN`은 통과.
**수정**: `Number.isFinite()` 가드로 변경.

### M-2. `adjustSync` 동일 NaN 문제 — `transport.ts`

**심각도**: MEDIUM
**문제**: `adjustSync`도 동일한 `??` 패턴으로 NaN 통과.
**수정**: `Number.isFinite()` 가드로 변경.

### M-3. `showRemoteGuideUI` 무제한 인덱스 — `transfer-receive.ts`

**심각도**: MEDIUM
**문제**: `data.index`를 검증 없이 `setState('playlist.currentTrackIndex', ...)` — 범위 밖 인덱스 허용.
**수정**: `Number.isFinite(idx) && idx >= 0 && idx < playlist.length` 바운드 체크 추가.

### M-4. Downstream error+close 이중 발화 — `relay.ts`

**심각도**: MEDIUM
**문제**: PeerJS에서 `error` 후 `close`가 순차 발화 → `RELAY_DOWNSTREAM_LOST` 2회 전송 → 불필요한 relay 재할당.
**수정**: `close` 핸들러에서 peer가 `downstreamDataPeers`에 있었는지 확인 후에만 알림.

### M-5. `leaveSession` upstream relay 미종료 — `peer.ts`

**심각도**: MEDIUM
**문제**: `leaveSession()`에서 host/guest/downstream 연결은 닫지만 upstream relay 연결(`relay.upstreamDataConn`)은 미종료 → relay 노드에 stale downstream 잔존.
**수정**: downstream 정리 전에 upstream relay 연결 종료 추가.

### M-6. `RELAY_DOWNSTREAM_LOST` 발신자 미검증 — `orchestrator.ts`

**심각도**: MEDIUM
**문제**: 핸들러가 `lostPeerId`만 확인하고 발신자(`conn.peer`)가 실제 할당된 relay인지 미검증 → 스푸핑 가능.
**수정**: `relayAssignments.get(lostPeerId) === conn.peer` 검증 추가.

### L-1. Demo 경로 NaN-unsafe 인덱스 — `transfer-receive.ts`

**심각도**: LOW
**문제**: demo 경로에서 `Number(data.index)`가 NaN일 수 있음.
**수정**: `Number.isFinite()` 가드 + fallback 0.

### L-2. EQ OP 토스트 오표시 — `effects.ts`

**심각도**: LOW
**문제**: 연결 종료 중 `isOperator`가 `false`로 리셋된 상태에서 `handleEQUpdateMsg` 호출 → "오퍼레이터 권한 필요" 토스트 오표시.
**수정**: `} else {` → `} else if (!isOperator) {` 조건 추가.

### L-3. EQ/Preamp `_notifyHostChanged` 누락 — `effects.ts`

**심각도**: LOW
**문제**: `handleEQUpdateMsg`/`handlePreampMsg`에서 Host 변경 알림 토스트 누락.
**수정**: 각 핸들러 말미에 `_notifyHostChanged()` 호출 추가.

### L-4. `handleAssignDataSource` undefined targetId 무시 — `relay.ts`

**심각도**: LOW
**문제**: `targetId`가 `undefined`면 세 조건 모두 불일치 → 함수가 아무 동작 없이 반환.
**수정**: `(data.targetId) ?? null`로 undefined→null 정규화.

### L-5. `handlePongLatency` NaN 가드 불충분 — `sync.ts`

**심각도**: LOW
**문제**: `typeof data.timestamp !== 'number'`는 NaN을 통과시킴 (`typeof NaN === 'number'`).
**수정**: `Number.isFinite(data.timestamp)` 가드로 변경.

---

## 통계
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 6 |
| LOW | 5 |
| **합계** | **12 인스턴스 (전체 수정)** |

## 커밋
- `f5c030e`: fix14 — sync:response + duration NaN + index bounds (H1 + M3 + L1)
- `2c3e2e4`: fix14 — EQ OP toast + EQ/preamp hostChanged (L2 + L3)
- (pending): fix14 — network domain 5건 (M3 + L2)
