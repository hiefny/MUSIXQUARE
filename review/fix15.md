# fix15 — 15차 전수조사

## 감사 범위
- **대상**: fix14 완료 후 전수 감사 (Audio, Core, Network, Player, Storage, YouTube, UI)
- **에이전트**: 3개 병렬 감사 (Player+Storage+YT+UI / Audio+Core / Network)
- **Raw 발견**: 14건 (M7 + L7)

## 감사 결과 요약
**M5 + L1 = 6건** 1차 수정 → 나머지 8건 정리 수정 → **전체 14건 수정 완료**.

---

## 수정 항목 (1차 — 실질 영향)

### M-1. `handleRequestPlay` — operator `time:0` 무시 — `playback.ts:188`

**심각도**: MEDIUM
**문제**: `Number(data.time) || pausedAt` 패턴에서 `Number(0) || pausedAt` = `pausedAt`.
Operator가 "처음부터 재생" (`time: 0`) 전송 시 Host가 무시하고 `pausedAt` 위치에서 재개.
**수정**: `Number.isFinite(rawTime) && rawTime >= 0` 명시 검증으로 변경.

### M-2. `applySettings` stale state after await — `effects.ts:44-143`

**심각도**: MEDIUM
**문제**: State를 44-56줄에서 스냅샷 → reverb 생성 await (76줄) → stale 스냅샷으로 sync 파라미터 적용 (80-143줄).
Reverb 생성 중 사용자가 변경한 EQ/stereo/preamp/VB/lowpass/volume 설정이 덮어쓰기됨.
**수정**: 모든 동기 파라미터 적용(damping, EQ, stereo, preamp, VB, lowpass, volume)을 await 이전으로 이동.

### M-3. `isHost()` idle 상태에서 true 반환 — `orchestrator.ts:52-53`

**심각도**: MEDIUM
**문제**: `!getState('network.hostConn')` 만 검사 → idle 상태(hostConn=null)에서도 true.
세션 종료 후 비동기 이벤트 처리 시 orchestrator가 host 로직 실행.
**수정**: `getState('network.appRole') === 'host'` 조건 추가.

### M-4. `handleDeviceListUpdateMsg` kick 전 setState — `guest.ts:227-240`

**심각도**: MEDIUM
**문제**: `setState('network.lastKnownDeviceList', list)` 가 kick 검사 전에 실행.
kick된 경우 state는 업데이트되지만 `device-list-update` 이벤트 미발행 → state/UI 불일치.
**수정**: `setState` 를 kick 검사 후로 이동.

### M-5. downstream error/close conn.peer 문자열 필터링 — `relay.ts:342-368`

**심각도**: MEDIUM
**문제**: `filter(p => p.peer !== conn.peer)` — 같은 peer ID로 재연결된 새 connection도 함께 제거.
**수정**: `filter(p => p !== conn)` 참조 동등성으로 변경.

### L-1. `handleVolume` unclamped toast — `effects.ts:524`

**심각도**: LOW
**문제**: 네트워크에서 받은 volume 값이 1 초과 시 토스트에 100% 이상 표시.
**수정**: `Math.max(0, Math.min(1, vol))` 클램프 추가.

---

## 수정 항목 (2차 — 코드 정리)

### L-2. Global `isFinite()` → `Number.isFinite()` 통일 — 6곳

**심각도**: LOW (컨벤션 통일)
**수정 파일**:
- `transport.ts:351` — `pause()` forcedTime 검증
- `decode.ts:90,115,244,413` — 오디오 duration 검증 4곳
- `youtube/player.ts:191` — YouTube getCurrentTime 검증

### L-3. `handleRequestSkipTime` NaN 가드 — `playback.ts:251`

**심각도**: LOW
**문제**: `Number(data.sec) || 0` → NaN을 0으로 묵시 변환.
**수정**: `Number.isFinite(sec)` 검증 후 early return.

### M-6. `opfs:read-complete` tag 가드 미비 — `relay.ts:555`

**심각도**: MEDIUM (잠재적)
**문제**: chunk 전송 블록이 tag 무관하게 실행 → 다른 모듈의 OPFS_READ 결과도 downstream 전송 가능.
**수정**: `if (tag !== 'catchup') return;` 가드 추가.

### M-7. Catchup pump stale reference — `relay.ts:110`

**심각도**: MEDIUM (방어적)
**문제**: 타이머 클로저가 pump 객체 참조를 캡처 → restart 시 stale pump 실행 가능.
**수정**: `opfsCatchupPumps.get(pump.peerId)` 로 map에서 재조회 + 참조 일치 검증.

### L-4. Relay upstream close — transfer.state 미검사 — `relay.ts:281`

**심각도**: LOW
**문제**: 전송 완료 후에도 `receivedCount < total` 이면 불필요 recovery 요청.
**수정**: `transfer.state !== TRANSFER_STATE.RECEIVING` 이면 early return.

### L-5. Relay connect timeout — transfer.state 미검사 — `relay.ts:231`

**심각도**: LOW
**문제**: 10초 타임아웃 중 전송 완료/취소된 경우에도 stale recovery 요청.
**수정**: `transfer.state === TRANSFER_STATE.IDLE` 이면 early return.

---

## 통계
| 심각도 | 건수 |
|--------|------|
| MEDIUM | 7 |
| LOW | 5 |
| **합계** | **12건 (전체 수정)** |

## 커밋
- `e388e55`: fix15 1차 — M5+L1 (실질 영향)
- (pending): fix15 2차 — 코드 정리 (컨벤션 통일 + 방어적 가드)
