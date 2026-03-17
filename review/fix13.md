# fix13 — 13차 전수조사

## 감사 범위
- **전체 소스**: `src/` 하위 55+ 파일 전수 읽기
- **도메인**: Audio(3), Core(8), Network(8), Player(7), Storage(7), YouTube(6), UI(14), App(1)

## 감사 결과 요약
12차까지 ~140건 수정 후. **H4 + M9 + L7 = 24 인스턴스** 발견 (전체 수정 완료).

---

## 발견 항목

### H-1. `ended-advance-*` 타이머 레이스 컨디션 — `transport.ts`

**심각도**: HIGH
**문제**: 트랙 종료 시 `ended-advance-next/retry` 타이머가 stopAllMedia/togglePlay/stopPlayback에서 미해제.
**수정**: 3곳에 `clearManagedTimer` 추가.

### H-2. Stale `receivedCount` after meta-recovery — `transfer-receive.ts:617`

**심각도**: HIGH
**문제**: meta-recovery 재귀 드레인 후 outer call의 stale `receivedCount`가 state 덮어쓰기 → 전송 미완료.
**수정**: 재귀 드레인 후 `receivedCount = getState('transfer.receivedCount')` 재조회.

### H-3. Relay `unicastFile` 항상 실패 — `relay.ts:433,437` + `transfer-send.ts:154`

**심각도**: HIGH
**문제**: relay 노드가 downstream 피어에 `unicastFile` 호출 시 `canSendFileTo`가
`connectedPeers`에서 conn 검색 → downstream conn은 `relay.downstreamDataPeers`에 있어 검색 실패.
relay 파일 서빙 경로 전체가 작동 불능.
**수정**: `unicastFile`에 `skipTransportGuard` 파라미터 추가, relay 호출에서 `true` 전달.

### H-4. `network:peer-relay-lost` 무리스너 — relay→host 알림 부재

**심각도**: HIGH (구조적)
**문제**: relay 노드에서 downstream 피어 연결 끊김 시 `bus.emit('network:peer-relay-lost')` 하지만
relay는 guest이므로 호스트의 orchestrator가 이 이벤트를 수신 불가.
호스트가 relay 재할당 불가 → remote 피어 데이터 수신 중단.
**수정**: `RELAY_DOWNSTREAM_LOST` 프로토콜 메시지 신규 추가.
- `constants.ts`: `RELAY_DOWNSTREAM_LOST: 'relay-downstream-lost'` 추가
- `types/index.ts`: ProtocolMap에 `'relay-downstream-lost': { lostPeerId: string }` 추가
- `relay.ts`: downstream close 시 `sendToHost({ type: MSG.RELAY_DOWNSTREAM_LOST, lostPeerId })` 전송
- `orchestrator.ts`: `registerHandler(MSG.RELAY_DOWNSTREAM_LOST)` → `relayAssignments.delete` + `assignRelayForPeer` 재할당

### M-1~M-3. NaN 가드 누락 — `effects.ts` (setPreamp/setStereoWidth/setVirtualBass)

**심각도**: MEDIUM
**수정**: 각 함수에 `Number.isFinite()` 가드 추가.

### M-4. `skipTime` IDLE 가드 누락 — `transport.ts`

**심각도**: MEDIUM
**수정**: `if (currentState === APP_STATE.IDLE) return;` 추가.

### M-5. Backpressure 불필요 피어 체크 — `preload.ts:208`

**심각도**: MEDIUM
**수정**: `targets` → `targetsWhoNeedChunks`.

### M-6. Recovery retry count phantom 소모 — `recovery.ts:81,95`

**심각도**: MEDIUM
**수정**: 연결 불가 시 `retryCount` 복원.

### M-7. Relay timeout fallback — meta 없을 때 무응답 — `relay.ts:233`

**심각도**: MEDIUM
**문제**: relay timeout 시 meta 없으면 경고만 출력하고 종료 → 피어 무한 대기.
**수정**: `sendToHost({ type: MSG.REQUEST_CURRENT_FILE })` 추가.

### M-8. OPFS catchup pump `retryCount` 미리셋 — `relay.ts:188`

**심각도**: MEDIUM
**문제**: 성공 시 retryCount 미리셋 → 독립적 지연 5회 누적으로 스트림 영구 중단.
**수정**: 성공 콜백에 `pump.retryCount = 0` 추가.

### M-9. TOCTOU rejection `activeHostConnByPeerId` 미정리 — `host.ts:116`

**심각도**: MEDIUM
**문제**: max-guest 초과 거부 시 map entry 남아 → close 핸들러가 spurious cleanup.
**수정**: 거부 경로에 `activeHostConnByPeerId` delete 추가.

### L-1~L-3. reverb NaN 가드 4건 + non-OP stereo 토스트 + 중복 IDLE emit

**수정**: playlist.ts, effects.ts, playlist.ts 각각 수정.

### L-4~L-5. SessionScope 미dispose — `transfer-send.ts:70` + `preload.ts:258`

**수정**: early return 경로에 `scope.dispose()` 추가.

### L-6. Recovery stale index — `recovery.ts:120`

**수정**: backoff 후 index 재조회.

### L-7. Double `check()` TOCTOU — `peer-state.ts:342`

**심각도**: LOW
**문제**: timeout 콜백에서 `check()` 2회 호출 사이 state 변경 가능 (이론적).
**수정**: 결과를 `const final`에 저장 후 사용.

---

## 통계
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 0 |
| HIGH | 4 |
| MEDIUM | 9 |
| LOW | 7 패턴 (11 인스턴스) |
| **합계** | **24 인스턴스 (전체 수정)** |
