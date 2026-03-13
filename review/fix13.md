# fix13 — 13차 전수조사

## 감사 범위
- **전체 소스**: `src/` 하위 55+ 파일 전수 읽기
- **도메인**: Audio(3), Core(8), Network(8), Player(7), Storage(7), YouTube(6), UI(14), App(1)

## 감사 결과 요약
12차까지 ~140건 수정 후 코드베이스 매우 안정적. **H1 + M4 + L4 = 12 인스턴스** 발견.

---

## 발견 항목

### H-1. `ended-advance-*` 타이머 레이스 컨디션 — `transport.ts`

**심각도**: HIGH
**문제**: 트랙 종료 시 `ended-advance-next`(500ms) / `ended-advance-retry`(300ms) 타이머가
`stopAllMedia`, `togglePlay`, `stopPlayback`(YT 분기)에서 미해제.
→ 사용자가 트랙 종료 직후 play/stop 조작 시 500ms 뒤 예상치 못한 다음 트랙 재생.
**수정**:
- `stopAllMedia()`: `clearManagedTimer('ended-advance-retry')` + `ended-advance-next` 추가
- `togglePlay()`: 동일 2줄 추가
- `stopPlayback()` YouTube 분기: 동일 2줄 추가

### M-1. `setPreamp()` NaN 가드 누락 — `effects.ts:288`

**심각도**: MEDIUM
**문제**: `Number(valDb)` → `Math.max/min` → `Math.pow` 체인에서 NaN 입력 시
NaN이 state 저장 + Tone.js preamp 노드로 전파 → 오디오 무음.
**수정**: `if (!Number.isFinite(db)) return;` 추가.

### M-2. `setStereoWidth()` NaN 가드 누락 — `effects.ts:297`

**심각도**: MEDIUM
**문제**: NaN 입력 시 widener + preamp 두 노드에 NaN 전파.
**수정**: `Number(val)` + `if (!Number.isFinite(v)) return;` 추가.

### M-3. `setVirtualBass()` NaN 가드 누락 — `effects.ts:308`

**심각도**: MEDIUM
**문제**: M-2와 동일 패턴. NaN → virtual bass gain 노드 감염.
**수정**: `Number(val)` + `if (!Number.isFinite(v)) return;` 추가.

### M-4. `skipTime` IDLE 상태 가드 누락 — `transport.ts:511`

**심각도**: MEDIUM
**문제**: IDLE 상태에서 skipTime 호출 시 duration=0 → target=sec →
`setState('player.pausedAt', sec)` + `broadcast(PAUSE, sec)` → 무의미한 상태 오염.
짧은 트랙 로드 후 play 시 잘못된 위치에서 시작.
**수정**: `if (currentState === APP_STATE.IDLE) return;` 추가.

### L-1. `playlist.ts` handleRequestSetting — reverb 파라미터 NaN 가드 누락 (4건)

**심각도**: LOW (defense-in-depth)
**파일**: `src/player/playlist.ts` lines 545-568
**문제**: 4개 reverb 파라미터 케이스에 `Number.isFinite()` 가드 누락.
`setReverbParam` 내부 가드가 있어 실질적 NaN 전파 낮음. 불필요한 broadcast 방지.
**수정**: 4개 케이스에 `if (!Number.isFinite(v)) break;` 추가.

### L-2. Non-OP Guest stereo width 변경 시 토스트 누락 — `effects.ts:388`

**심각도**: LOW (UX 일관성)
**문제**: reverb/vbass는 `_broadcastOrRequestSetting` 사용 → non-OP에 토스트 표시.
stereo width는 인라인 코드로 non-OP 분기에 토스트 없음.
**수정**: `else if (!isOperator)` 분기에 토스트 추가.

### L-3. 마지막 트랙 제거 시 중복 IDLE 상태 설정 — `playlist.ts:777-778`

**심각도**: LOW
**문제**: `stopAllMedia()` 호출 후 다시 `setState('appState', IDLE)` + `bus.emit('player:state-changed')`
→ `player:state-changed` 리스너 2회 발화 → CSS transition 이중 트리거 가능.
**수정**: 중복 2줄 제거 (`stopAllMedia`가 이미 IDLE 설정 + emit 수행).

---

## 통계
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 0 |
| HIGH | 1 (3곳 수정) |
| MEDIUM | 4 |
| LOW | 3 패턴 (6 인스턴스) |
| **합계** | **12 인스턴스** |
