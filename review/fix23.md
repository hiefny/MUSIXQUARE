# fix23 — fix22 회귀 검증 + 신규 기능 상호작용 감사

## 감사 범위
- **대상**: fix22 수정 후 회귀 버그 + 채팅 명령어/rename 상호작용
- **에이전트**: 1개 Opus (전체 코드베이스 크로스 도메인)
- **발견**: 6건 (H1 + M3 + L2) → 오탐 0건, **전체 수정**

---

## HIGH (1건)

### H-1. `sync.ts` — handleRequestChatCommand에 `case 'filter'` 누락 (fix22 H-5 회귀)
**문제**: fix22에서 cmdFilter에 sendToHost 추가했지만, 호스트 측 핸들러에 case 미추가.
**수정**: `case 'filter'` 추가 — setState + broadcast CHAT_SYSTEM + 로컬 피드백

---

## MEDIUM (3건)

### M-1. `sync.ts` — OP 게스트 명령 실행 시 호스트 로컬 UI 피드백 누락
**문제**: mute/unmute/slowmode/notice가 broadcast만 하고 호스트 채팅에 안 보임.
**수정**: 각 case에 `bus.emit('chat:system-message', ...)` 추가, notice는 `chat:notice-message` 이벤트 신규 추가

### M-2. `sync.ts` + `connect.ts` — rename 중복 체크에 호스트 이름 미포함
**문제**: connectedPeers만 체크 → 게스트가 호스트와 동일 이름 사용 가능.
**수정**: `getState('network.myDeviceLabel')` 대조 추가 (sync.ts + connect.ts 양쪽)

### M-3. `sync.ts` — handleRequestRename에 profanity 체크 누락
**문제**: 클라이언트 검증만 있고 호스트 측 검증 없음 → P2P 메시지 직접 전송 시 우회 가능.
**수정**: `containsProfanity(newLabel)` 체크 추가

---

## LOW (2건)

### L-1. `chat.ts` — freeze 체크에서 클라이언트 data.isOp 신뢰
**문제**: 게스트가 isOp:true로 메시지 전송하면 freeze 우회 가능.
**수정**: connectedPeers에서 실제 OP 여부 조회

### L-2. `connect.ts` — 다이얼로그 rename validator에도 호스트 이름 중복 체크 누락
**문제**: M-2와 동일 이슈의 다이얼로그 측.
**수정**: hostLabel 대조 추가

---

## 통계
| 심각도 | 건수 |
|--------|------|
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 2 |
| **합계** | **6건 수정** |
