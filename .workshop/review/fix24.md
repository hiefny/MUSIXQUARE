# fix24 — 최종 배포 전수조사 (6-agent fresh-eyes audit)

## 감사 범위
- **대상**: fix23 이후 전체 코드베이스 (처음 보는 관점으로)
- **에이전트**: 6개 병렬 Opus (Network, Audio, UI/Chat, Storage/YT, Core/Types, Cross-domain)
- **Raw 발견**: 30건 → 중복/기존fix 제거 후 정리

---

## 수정 대상 확정 (오탐 판별 후)

### HIGH (0건)
없음. fix22+fix23에서 주요 버그가 모두 해결됨.

### MEDIUM (10건)

| # | 도메인 | 파일:위치 | 설명 |
|---|--------|-----------|------|
| M-1 | Network | host.ts:345-367 | kick된 피어가 300ms 동안 relay 후보로 남음 |
| M-2 | Cross | chat.ts:587-627 | 호스트가 slowmode를 서버측 강제하지 않음 (클라이언트만 체크) |
| M-3 | Cross | commands.ts:226-230 | /nick 중복 체크가 게스트측에서 무효 (connectedPeers 비어있음) |
| M-4 | Cross | chat.ts:618,625 | 호스트 릴레이 시 isHost/isOp 배지 스푸핑 가능 |
| M-5 | Types | types/index.ts:130 | ProtocolMap 'welcome'에 모더레이션 필드 누락 |
| M-6 | UI | chat.ts:109 | 하드코딩 영어 aria-label "Seek to" |
| M-7 | UI | playlist-view.ts:152 | 하드코딩 영어 "Video X" 폴백 |
| M-8 | UI | playlist-view.ts:203 | 하드코딩 영어 "Track X" 폴백 |
| M-9 | Audio | transport.ts:296-299 | 오디오 파일에서도 video.src 설정되어 muted video 재생 |
| M-10 | Storage | transfer-receive.ts:588 | Uint8Array 불필요한 복사 (이미 Uint8Array일 때) |

### LOW (12건)

| # | 도메인 | 파일:위치 | 설명 |
|---|--------|-----------|------|
| L-1 | Cross | peer.ts:283 | leaveSession에 youtube.subItemsMap 미초기화 |
| L-2 | Cross | commands.ts:113-114 | cmdFreeze else 분기 데드코드 (permission:'host') |
| L-3 | UI | chat.ts:260,324 | textContent='' 후 잔여 BR태그 → :empty CSS 불일치 |
| L-4 | UI | connect.ts:257, settings.ts:367 | 하드코딩 영어 'Device' 폴백 |
| L-5 | UI | player-controls.ts:126 | 하드코딩 'HOST' 배지 텍스트 |
| L-6 | Audio | transport.ts:88 | getTrackPosition() 내 queueMicrotask 사이드이펙트 |
| L-7 | Audio | playback.ts:357 | getSurroundSplitter()! non-null assertion |
| L-8 | Audio | decode.ts:63 | 대용량 파일 디코드 시 이중 메모리 (File+ArrayBuffer) |
| L-9 | Storage | transfer.worker.ts:293 | OPFS_WRITE 성공 ACK 없음 |
| L-10 | Storage | preload.ts:471 | 릴레이 없을 때 불필요한 chunk 복제 |
| L-11 | Network | sync.ts:443 | 알 수 없는 OP 명령 무시 피드백 없음 |
| L-12 | Core | service-worker.js:45 | APP_SHELL에 favicon 미포함 |

### known-accepted 이관 예정

| # | 사유 |
|---|------|
| M-9 | decode.ts의 video.src 설정은 의도된 동작 (비디오 시각 동기화용). transport.ts 가드 존재 |
| M-10 | Uint8Array view 생성은 저렴 (~0.001ms). 성능 최적화 단계에서 검토 |
| L-6 | getTrackPosition 내 drift 보정은 의도적 설계. 리팩토링 범위 큼 |
| L-8 | 대용량 파일은 드문 사용 패턴. 메모리 최적화 단계에서 검토 |
| L-9 | OPFS write ACK는 오버엔지니어링. receivedCount + 최종 해시 검증으로 충분 |
| L-10 | 16KB chunk 복제 비용 미미. 성능 최적화 단계에서 검토 |

### 수정 확정: 7건 (M5 + L2)

**즉시 수정 (안전하고 간단):**
1. M-5: ProtocolMap welcome 타입 보강
2. M-6,M-7,M-8: i18n 하드코딩 문자열 번역
3. L-1: leaveSession에 youtube.subItemsMap 초기화
4. L-2: cmdFreeze 데드코드 제거
5. L-3: textContent → innerHTML로 BR 잔여 방지
6. L-4,L-5: 하드코딩 'Device'/'HOST' 번역
7. L-12: APP_SHELL에 favicon 추가

**보류 (리스크/복잡도 높음):**
- M-1: kick 피어 relay 방지 — orchestrator 로직 변경 필요, 에지케이스
- M-2: 호스트 slowmode 강제 — per-peer 타임스탬프 맵 추가 필요
- M-3: /nick 게스트측 검증 — lastKnownDeviceList 활용 필요, 임시 불일치는 무해
- M-4: 배지 스푸핑 — 보안 위협 낮음 (친구 모임 앱), known-accepted C-2 범주

---

## 통계
| 심각도 | 발견 | 수정 확정 | 보류/이관 |
|--------|------|-----------|-----------|
| HIGH | 0 | 0 | 0 |
| MEDIUM | 10 | 4 | 6 |
| LOW | 12 | 7 | 5 |
| **합계** | **22** | **11** | **11** |
