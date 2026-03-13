# fix15 — 15차 전수조사

## 감사 범위
- **대상**: fix14 완료 후 전수 감사 (Audio, Core, Network, Player, Storage, YouTube, UI)
- **에이전트**: 3개 병렬 감사 (Player+Storage+YT+UI / Audio+Core / Network)
- **Raw 발견**: 14건 (M7 + L7) — 이론적/이미 완화된 건 제외 후 6건 수정

## 감사 결과 요약
**M5 + L1 = 6 인스턴스** 수정 완료.

---

## 수정 항목

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

## 미수정 (이미 완화됨 / 이론적)
- Global `isFinite()` → `Number.isFinite()` (decode.ts 4곳, transport.ts 1곳, youtube/player.ts 1곳): Web Audio/YouTube API에서 항상 native number 반환 → 실질 영향 없음
- OPFS cleanup listener leak (opfs.ts): 동일 파일 반복 cleanup 시에만 발생, 매우 드뭄
- Catchup pump stale reference (relay.ts): `active=false` 플래그로 이미 완화
- `opfs:read-complete` tag guard (relay.ts): 현재 relay만 requestId 사용, 잠재적
- Relay upstream close / timeout state check (relay.ts): 불필요 recovery 전송이지만 Host가 무시

---

## 통계
| 심각도 | 수정 | 미수정 |
|--------|------|--------|
| MEDIUM | 5 | 3 (완화) |
| LOW | 1 | 5 (이론적) |
| **합계** | **6** | **8** |
