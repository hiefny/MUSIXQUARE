# fix13 — 13차 전수조사

## 감사 범위
- **전체 소스**: `src/` 하위 55+ 파일 전수 읽기
- **도메인**: Audio(3), Core(8), Network(8), Player(7), Storage(7), YouTube(6), UI(14), App(1)

## 감사 결과 요약
12차까지 ~140건 수정 후 코드베이스 안정적. **H2 + M6 + L6 = 18 인스턴스** 발견.

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

### H-2. Stale `receivedCount` after meta-recovery — `transfer-receive.ts:577,617`

**심각도**: HIGH
**문제**: meta-recovery 시 `_pendingEarlyChunks` 재귀 처리 후 outer call의
`receivedCount` 로컬 변수가 stale → 재귀에서 갱신된 state 덮어쓰기 →
`receivedCount >= total` 완료 체크 실패 → 전송 미완료.
**수정**: 재귀 드레인 후 `receivedCount = getState('transfer.receivedCount')` 재조회.

### M-1. `setPreamp()` NaN 가드 누락 — `effects.ts:288`

**심각도**: MEDIUM
**문제**: NaN 입력 시 Tone.js preamp 노드로 전파 → 오디오 무음.
**수정**: `if (!Number.isFinite(db)) return;` 추가.

### M-2. `setStereoWidth()` NaN 가드 누락 — `effects.ts:297`

**심각도**: MEDIUM
**문제**: NaN → widener + preamp 두 노드 감염.
**수정**: `Number(val)` + `if (!Number.isFinite(v)) return;` 추가.

### M-3. `setVirtualBass()` NaN 가드 누락 — `effects.ts:308`

**심각도**: MEDIUM
**문제**: NaN → virtual bass gain 노드 감염.
**수정**: `Number(val)` + `if (!Number.isFinite(v)) return;` 추가.

### M-4. `skipTime` IDLE 상태 가드 누락 — `transport.ts:511`

**심각도**: MEDIUM
**문제**: IDLE에서 skipTime 호출 시 무의미한 pausedAt 설정 + broadcast.
**수정**: `if (currentState === APP_STATE.IDLE) return;` 추가.

### M-5. Backpressure가 불필요한 피어 포함 체크 — `preload.ts:208`

**심각도**: MEDIUM
**문제**: backpressure 루프가 `targets`(전체 피어)를 체크하지만 실제 청크 전송은
`targetsWhoNeedChunks`(해당 파일 미보유 피어)에만 수행.
이미 파일 보유 피어의 채널 혼잡이 불필요한 preload 지연 유발 (최대 30초/청크).
**수정**: `for (const p of targets)` → `for (const p of targetsWhoNeedChunks)`.

### M-6. Recovery retry count phantom 소모 — `recovery.ts:81,95`

**심각도**: MEDIUM
**문제**: retry count가 backoff 전에 증가되지만, backoff 후 연결 불가 시
실제 요청 미전송인데 예산만 소모 → 3회 phantom 후 영구 포기.
**수정**: 연결 불가 시 `retryCount` 복원 (`currentRetry - 1`).

### L-1. reverb 파라미터 NaN 가드 누락 (4건) — `playlist.ts:545-568`

**심각도**: LOW (defense-in-depth)
**수정**: 4개 케이스에 `if (!Number.isFinite(v)) break;` 추가.

### L-2. Non-OP Guest stereo 토스트 누락 — `effects.ts:388`

**심각도**: LOW (UX 일관성)
**수정**: `else if (!isOperator)` 분기에 토스트 추가.

### L-3. 중복 IDLE 상태 설정 — `playlist.ts:777-778`

**심각도**: LOW
**수정**: `stopAllMedia()` 후 중복 IDLE 설정 2줄 제거.

### L-4. `broadcastFile` SessionScope 미dispose — `transfer-send.ts:70`

**심각도**: LOW
**문제**: eligible peers 없을 때 early return에서 `scope.dispose()` 누락.
**수정**: `scope.dispose()` 추가.

### L-5. `unicastPreload` SessionScope 미dispose — `preload.ts:258,261`

**심각도**: LOW
**문제**: 조기 반환 경로에서 scope + map entry 미정리.
**수정**: 두 early return 경로에 `scope.dispose()` + `_activePreloadUnicasts.delete()` 추가.

### L-6. Recovery stale index — `recovery.ts:77,120`

**심각도**: LOW
**문제**: backoff 대기 중 트랙 변경 시 stale `index` 전송.
**수정**: backoff 후 `pendingFileIndex`/`currentTrackIndex` 재조회.

---

## 통계
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 6 |
| LOW | 6 패턴 (10 인스턴스) |
| **합계** | **18 인스턴스** |
