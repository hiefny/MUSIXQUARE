# fix22 — 배포 전 전수조사 (6-agent parallel audit)

## 감사 범위
- **대상**: fix21 이후 전체 코드베이스 (채팅 명령어, contenteditable 전환, 입장 애니메이션 등 대량 변경 후)
- **에이전트**: 6개 병렬 Opus (Network, Audio, UI/Chat, Storage/YT, Core/State, CSS/HTML)
- **Raw 발견**: 52건 → 오탐/기존known 제거 후 **38건** (H8 + M17 + L13)

---

## HIGH (8건)

### H-1. `guest.ts:229` — handleWelcome이 chatFrozen/slowmode/filter를 false로 리셋 못 함
**도메인**: Network
**문제**: `if (data.chatFrozen)` 패턴이라 falsy 값일 때 setState 미호출. 이전 세션에서 frozen이었던 게스트가 재접속 시 영구 frozen.
**수정**: 무조건 setState 호출 — `setState('network.chatFrozen', !!data.chatFrozen)` 등

### H-2. `peer.ts:283-334` — leaveSession이 mutedPeers를 초기화하지 않음
**도메인**: Network
**문제**: 호스트가 mute 후 세션 나가고 새 세션 만들면, 같은 peer ID가 자동 mute됨.
**수정**: batchSetState에 `'network.mutedPeers': new Set()` 추가

### H-3. `peer.ts:283-334` — leaveSession이 chatFrozen/slowmode/filterEnabled 미초기화
**도메인**: Network
**문제**: H-1과 연계 — 게스트가 세션 나가도 모더레이션 상태 잔류.
**수정**: batchSetState에 3개 키 기본값 추가

### H-4. `chat.ts:260,323` — 전송 후 ghost text / command suggest가 안 지워짐
**도메인**: UI/Chat
**문제**: `input.textContent = ''`는 input 이벤트를 발생시키지 않아 updateGhost/hideSuggest 미호출.
**수정**: 클리어 후 `input.dispatchEvent(new Event('input', { bubbles: true }))` 호출

### H-5. `commands.ts:161-166` — /filter 명령이 OP 게스트에서 호스트로 전달 안 됨
**도메인**: UI/Chat
**문제**: OP 게스트가 `/filter on` 실행 시 로컬 state만 변경, 호스트에 REQUEST_CHAT_COMMAND 미전송. 실제 필터링은 호스트에서 동작하므로 효과 없음.
**수정**: cmdFreeze/cmdSlowmode와 동일 패턴 — isHost()면 직접 실행, 아니면 sendToHost

### H-6. `chat.ts:277` — slowmode가 OP 게스트를 면제하지 않음
**도메인**: UI/Chat
**문제**: freeze는 `!isHost && !isOp` 체크하는데 slowmode는 `!isHost`만 체크.
**수정**: `if (slowmode > 0 && !isHost && !isOp)` 로 변경

### H-7. `youtube/sync.ts:100-108` — 광고 감지 상태가 모드 전환 시 미초기화
**도메인**: Storage/YT
**문제**: YouTube→파일→YouTube 전환 시 `_hostAdPauseActive=true`가 잔류, 모든 YOUTUBE_STATE 메시지가 무시되어 게스트 영구 동기화 불능.
**수정**: `youtube:stop-mode` 이벤트에 resetAdDetection() 호출 추가

### H-8. `style.css:4445,4495,4512` — 정의되지 않은 CSS 변수 `--text` 사용
**도메인**: CSS
**문제**: `.stepper-btn`, `.stepper-value`, `.stepper-input`이 `color: var(--text)` 사용하나 `--text`는 미정의. `--text-main`이 올바른 변수.
**수정**: `var(--text)` → `var(--text-main)` 교체

---

## MEDIUM (17건)

### M-1. `transport.ts:297` — 오디오 전용 트랙에서 hidden video를 재생하여 CPU 낭비
**도메인**: Audio
**문제**: buffer 모드 play 시 비디오 동기화용으로 muted video를 시작하는데, 오디오 파일일 때도 실행됨.
**수정**: isVideo 체크 추가

### M-2. `transport.ts:297` + `video.ts:191-199` — 빠른 트랙 전환 시 더블 오디오 위험
**도메인**: Audio
**문제**: getCurrentAudioBuffer()가 잠깐 null이면 video unmute → 이중 재생.
**수정**: appState도 함께 체크

### M-3. `engine.ts` — destroyAudio() 미존재 (노드/리스너 미정리)
**도메인**: Audio
**문제**: 장시간 세션에서 메모리 누수 가능성.
**수정**: 전체 그래프 dispose + statechange 리스너 제거 함수 추가

### M-4. `peer.ts:283-334` — leaveSession이 lastJoinCode 미초기화
**도메인**: Network
**문제**: 세션 나가도 lastJoinCode 잔류 → 자동 재연결 시 잘못된 세션 접속 시도.
**수정**: batchSetState에 `'network.lastJoinCode': ''` 추가

### M-5. `sync.ts:31-33` — _syncSamples 게스트 연결 끊김 시 미초기화
**도메인**: Network
**문제**: 재접속 시 이전 동기화 샘플이 잔류하여 오프셋 계산 오류 가능.
**수정**: hostConn null 변경 시 리셋

### M-6. `guest.ts:153-170` — close/error 핸들러의 _errorHandled 플래그가 실제 에러 진단 삼킴
**도메인**: Network
**문제**: close가 먼저 발생하면 이후 error 이벤트의 실제 원인이 로그에 안 남음.
**수정**: 에러 로깅은 유지하되 UI 표시만 스킵

### M-7. `chat.ts:883` — beforeinput maxlength가 IME 조합을 깨뜨림
**도메인**: UI/Chat
**문제**: insertCompositionText에 preventDefault 호출 시 한글/일본어 입력 깨짐 가능.
**수정**: insertCompositionText는 maxlength 체크 스킵, compositionend 후 truncate

### M-8. `chat.ts:346-352` — 메시지 그룹핑이 표시 이름 기반 (고유 ID 아님)
**도메인**: UI/Chat
**문제**: 같은 닉네임의 다른 유저 메시지가 한 그룹으로 묶임.
**수정**: peer ID 기반 그룹핑으로 변경

### M-9. `chat.ts:873,891` — document.execCommand('insertText') deprecated
**도메인**: UI/Chat
**문제**: 향후 브라우저에서 제거될 수 있음.
**수정**: Selection/Range API 사용 (장기)

### M-10. `transfer-send.ts:100-102` — 청크당 이중 메모리 복사
**도메인**: Storage
**문제**: slice→arrayBuffer→Uint8Array→structuredClone 체인에서 불필요한 중간 복사.
**수정**: Uint8Array 래핑 제거, ArrayBuffer 직접 전송

### M-11. `preload.ts:228` — dataChannel null 시 backpressure 무시
**도메인**: Storage
**문제**: 채널 미준비 상태에서 청크 전송 → PeerJS 내부 버퍼링에 의존.
**수정**: `if (!conn.dataChannel) continue;` 가드 추가

### M-12. `transfer-receive.ts:524-527` — early chunk 버퍼 오버플로 시 현재 세션 청크 유실 가능
**도메인**: Storage
**문제**: shift()가 세션 구분 없이 가장 오래된 청크 제거.
**수정**: 세션 ID별 Map 사용 또는 필터링

### M-13. Dead CSS: ~250줄 미사용 셀렉터
**도메인**: CSS
**문제**: `.ctrl-btn-small`, `.graphic-listener`, `.graphic-line`, `.graphic-accent/host/guest`, `.setup-code`, `.nav-icon-wrapper`, `.chat-badge`, `.chat-preview-right`, `.connect-device-list`, sync popup 클래스 등
**수정**: 전부 제거

### M-14. `style.css:588` — will-change: filter 불필요
**도메인**: CSS
**문제**: YouTube 모드에서 정적 필터에 will-change → GPU 메모리 낭비.
**수정**: 제거

### M-15. `style.css:515-519` — @layer base 내 중복 미디어 쿼리
**도메인**: CSS
**문제**: desktop.css가 이미 같은 스타일 처리 → 혼란 유발.
**수정**: 제거

### M-16. `style.css:3378-3392` — .chat-empty, .list-empty-state 중복 선언
**도메인**: CSS
**문제**: 같은 셀렉터가 연속 2번 선언됨.
**수정**: 병합

### M-17. `relay.ts:369,391` — bus.emit('network:peer-relay-lost') 리스너 없음 (데드 이벤트)
**도메인**: Network
**문제**: 프로토콜 메시지(RELAY_DOWNSTREAM_LOST)는 처리되지만 로컬 버스 이벤트는 미소비.
**수정**: emit 제거 또는 핸들러 추가

---

## LOW (13건)

### L-1. `engine.ts:126-132` — 서라운드 노드 disconnect만 하고 dispose 안 함
### L-2. `effects.ts:344` — EQ 밴드 수 하드코딩 (5)
### L-3. `host.ts:370-372` — window.toggleOperator 전역 노출 (레거시)
### L-4. `sync.ts:241-243` — handleHeartbeatAck no-op 핸들러
### L-5. `peer.ts:298` — peerSlots 이중 설정 (271, 298)
### L-6. `state.ts:99` — as const 불필요 (connectionType)
### L-7. `app.ts:75` — allPassed 변수 미활용
### L-8. `chat.ts:53-56` — _formatChatDisplayName 불필요한 래퍼
### L-9. `profanity.ts:47-59` — 단어별 개별 RegExp 생성 (성능)
### L-10. `recovery.ts:96-97` — 재시도 예산 잘못된 환불 (무한 루프 가능)
### L-11. desktop.css 스크롤바 색상 하드코딩 (CSS 변수 미사용)
### L-12. `style.css:298` — header will-change: transform 상시 활성
### L-13. `style.css:4076` — .chat-yt-play-row font-family 중복 선언

---

## 통계
| 심각도 | 건수 |
|--------|------|
| HIGH | 8 |
| MEDIUM | 17 |
| LOW | 13 |
| **합계** | **38건** |

## known-accepted 추가 예정 항목
- M-9 (execCommand deprecated): 현재 대안 없음, 브라우저 제거 시 대응 → known-accepted C-9
- M-3 (destroyAudio): SPA 수명주기상 불필요 → known-accepted B-7 기존 항목과 통합
- L-3 (window.toggleOperator): 개발 편의용 → known-accepted

## Phase 2 예정
- 오탐 판별 + 수정 확정 → 유저 보고 후 Phase 3 (실제 수정) 진행
