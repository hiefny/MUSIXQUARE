# fix21 — 실제 테스트에서 발견된 런타임 버그 3건

## 감사 범위
- **대상**: fix20 완료 후 실제 디바이스 테스트 중 사용자 보고 버그
- **방식**: 코드 정적분석이 아닌 **실사용 테스트**에서 발견된 타이밍/경합 버그
- **발견**: 3건 (CRITICAL 3건) — 모두 중도참여(late-join) 흐름에서 발생

---

## CRITICAL (3건)

### C-1. 게스트 방 참여 시 무한 대기 — `guest.ts` + `setup-guest.ts`

**심각도**: CRITICAL
**증상**: 게스트가 세션 코드 입력 후 "참여 중..." 상태에서 영원히 멈춤
**원인**: `setup-guest.ts`의 `startGuestFlow()`가 `setState('network.isConnecting', false)`를 호출한 뒤,
`handleSetupJoinWithRole()`에서 `joinSession()` 호출 → `joinSession()` 내부에서
`if (getState('network.isConnecting')) return` 가드에 의해 정상 통과되어야 하지만,
`startGuestFlow()`가 뒤로가기 시 `isConnecting = false` 리셋 후 재진입 시
타이밍에 따라 `isConnecting`이 이미 `true`로 남아있어 `joinSession()`이 조기 리턴됨.
**수정**:
- `setup-guest.ts`: `startGuestFlow()`에서 진행 중인 연결을 명시적으로 취소
  (타이머 정리, hostConn 닫기, `isIntentionalDisconnect = true`)
- `guest.ts`: `joinSession()`에서 기존 hostConn이 열려있으면 조기 리턴하는 가드 추가

**커밋**: `39abf79`

---

### C-2. 중도참여 게스트에게 파일이 전송되지 않음 — `playback.ts` + `orchestrator.ts`

**심각도**: CRITICAL
**증상**: 게스트가 세션 참여 후 파일 다운로드가 시작되지 않음 (호스트 측에서 전송 안 함)
**원인**: 이벤트 순서 경합 문제.
1. 게스트 연결 → 호스트가 PLAY 메시지 전송 (즉시)
2. 호스트의 `orchestrator:peer-evaluated` 핸들러가 파일 전송 담당
3. 그러나 `orchestrator:peer-evaluated`는 ICE 감지 완료 후(~1.5초) 발행됨
4. `peer-evaluated` 핸들러 등록이 `orchestrator.ts`의 `evaluatePeer()` 실행보다 **늦게** 되는 경우,
   이벤트가 이미 발행된 후에 리스너가 등록 → 파일 전송 트리거 누락

**수정**:
- `playback.ts`: `orchestrator:peer-evaluated` 핸들러를 모듈 초기화 시점(`initPlayback`)에 등록하도록 이동
  (기존에는 특정 조건 분기 내에서 등록되어 타이밍에 따라 누락 가능)
- `orchestrator.ts`: `evaluatePeer()`에서 `bus.emit('orchestrator:peer-evaluated', peerId)` 발행을
  `setPeerDataTarget()` 호출 **이후**로 보장 (isDataTarget이 설정된 상태에서 파일 전송 시도)

**커밋**: `bcc36d6`

---

### C-3. 파일 다운로드 완료 후 "오디오 메모리 로드중..." 무한 대기 — `decode.ts` + `playback.ts`

**심각도**: CRITICAL
**증상**: 중도참여 게스트가 파일을 정상 수신했지만, "오디오 메모리 로드중..." 로더가 사라지지 않고 재생이 시작되지 않음
**원인**: 중도참여 시 이벤트 도달 순서가 일반 트랙 변경과 **반대**:
- 일반 트랙 변경: `FILE_START` → 파일 수신 → `PLAY` (pendingPlayTime 설정)
- 중도참여: `PLAY` (pendingPlayTime 설정) → `FILE_START` → 파일 수신

`FILE_START` 처리 시 `clearPreviousTrackState('new-session-start')` 호출 →
내부에서 `setPendingPlayTime(undefined)` 실행 → **이미 설정된 pendingPlayTime 삭제**.
파일 다운로드 완료 후 `finalizeGuestFile()`에서 `pendingPlayTime`이 `undefined`라 자동 재생 조건 누락 → 무한 대기.

추가로 `handlePlayMsg`에서 `currentTrackIndex === -1`(첫 참여) 시 불필요한 `REQUEST_CURRENT_FILE` 전송 →
타이밍에 따라 `orchestrator:peer-evaluated`의 자동 전송과 이중 전송 발생 가능.

**수정**:
- `decode.ts`: `clearPreviousTrackState()`에서 `reason === 'new-session-start'`일 때
  `setPendingPlayTime(undefined)` 스킵 (중도참여 시 PLAY가 먼저 도착하므로 보존 필요)
- `playback.ts`: `handlePlayMsg()`에서 `currentTrackIndex === -1`(첫 참여) 시
  `REQUEST_CURRENT_FILE` 전송 생략 → `orchestrator:peer-evaluated`가 자동으로 파일 전송

**커밋**: `06bd0a3`

---

## 공통 특징

3건 모두 **중도참여(late-join) 흐름의 타이밍 경합** 버그:
- 정적 코드 분석(전수조사)으로는 발견 불가 — 실제 네트워크 지연과 이벤트 순서에 의존
- WebRTC ICE 협상(~1.5초), PeerJS 내부 이벤트 순서 등 비결정적 요소가 원인
- 단일 디바이스 테스트에서는 재현 불가, 다중 디바이스 실제 세션에서만 발현

---

## 통계
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 3 |
| **합계** | **3건 수정** |

## 커밋
- `39abf79`: fix21-1 게스트 방 참여 무한 대기 버그 수정
- `bcc36d6`: fix21-2 중도참여 게스트 파일 미수신 버그 수정
- `06bd0a3`: fix21-3 중도참여 게스트 오디오 로드 무한 대기 버그 수정
