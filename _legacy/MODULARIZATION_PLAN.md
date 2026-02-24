# MUSIXQUARE 2.0 모듈화 마스터플랜

## 개요
12,018줄 모놀리스 `app.js` → 18개 ES 모듈로 분리
EventBus 패턴으로 순환 의존성 해결, Vite 빌드

---

## Phase 1: 기반 (의존성 없음)
> Opus 1세션 | ~30K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 1 | `src/core/constants.js` | 150 | MSG, DELAY, APP_STATE, TRANSFER_STATE |
| 2 | `src/core/log.js` | 50 | 로그 레벨 + console 래퍼 |
| 3 | `src/core/events.js` | 80 | EventBus (on/off/emit/once) |
| 4 | `src/core/state.js` | 250 | 중앙 상태트리 + setState/getState |
| 5 | `src/core/platform.js` | 200 | IS_IOS, IS_ANDROID, 뷰포트, CSS vars |
| 6 | `src/core/session.js` | 80 | 세션 ID 생성/검증 |
| 7 | `src/core/blob-manager.js` | 200 | BlobURLManager (self-contained) |
| 8 | `src/core/timers.js` | 80 | managedTimers 레지스트리 |

**체크포인트**: `vite build` 통과, 각 모듈 import 확인

---

## Phase 2: 오디오 엔진
> Sonnet `/fast` | ~40K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 9 | `src/audio/engine.js` | 400 | Tone.js 그래프 초기화, masterGain |
| 10 | `src/audio/effects.js` | 250 | Reverb, EQ, VirtualBass, StereoWidth |
| 11 | `src/audio/channel.js` | 200 | 채널모드 (L/R/Stereo/Sub/7.1 Surround) |

**의존**: constants, state, events, log
**체크포인트**: `initAudio()` → Tone.js 노드 생성 확인

---

## Phase 3: 네트워크
> Sonnet `/fast` | ~50K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 12 | `src/network/peer.js` | 350 | PeerJS 초기화, 연결 관리, 슬롯 |
| 13 | `src/network/protocol.js` | 400 | 메시지 라우터 (MSG 타입 → 핸들러) |
| 14 | `src/network/sync.js` | 200 | 하트비트, 레이턴시, 시간 보정 |
| 15 | `src/network/relay.js` | 150 | 릴레이 체인 (업스트림/다운스트림) |

**의존**: constants, state, events, log, session
**체크포인트**: 2기기 P2P 연결 + 메시지 송수신

---

## Phase 4: 파일 전송 & 스토리지
> Sonnet `/fast` | ~50K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 16 | `src/storage/opfs.js` | 300 | transfer.worker 래퍼, 명령/응답 |
| 17 | `src/storage/transfer.js` | 500 | 청크 수신, 세션 관리, 상태머신 |
| 18 | `src/storage/preload.js` | 400 | 프리로드 세션, 다음 트랙 준비 |
| 19 | `src/storage/recovery.js` | 200 | 파일 복구 요청, 재시도 로직 |

**의존**: constants, state, events, network, blob-manager, timers
**체크포인트**: 호스트→게스트 파일 전송 완료

---

## Phase 5: 재생 엔진
> Opus (복잡) | ~60K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 20 | `src/player/playback.js` | 600 | play/pause/stop/seek, 버퍼 관리 |
| 21 | `src/player/state-machine.js` | 250 | APP_STATE 전이, cleanup |
| 22 | `src/player/video.js` | 300 | videoElement 관리, 비디오 싱크 |
| 23 | `src/player/playlist.js` | 300 | 플레이리스트, repeat/shuffle |

**의존**: audio, storage, network, state, events, blob-manager
**체크포인트**: 오디오 파일 로드 → 재생 → 일시정지 → 탐색

---

## Phase 6: YouTube
> Sonnet `/fast` | ~40K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 24 | `src/youtube/player.js` | 500 | YT IFrame API, 임베드/제어 |
| 25 | `src/youtube/sync.js` | 300 | YT 싱크, 자막 매핑 |
| 26 | `src/youtube/search.js` | 200 | YT 검색/프리뷰 |

**의존**: player/state-machine, network, state, events
**체크포인트**: YouTube URL 로드 → 재생 → 멀티기기 싱크

---

## Phase 7: UI 레이어
> Sonnet `/fast` | ~60K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 27 | `src/ui/dom.js` | 200 | DOM 유틸, 쿼리 캐시 |
| 28 | `src/ui/toast.js` | 100 | 토스트 알림 |
| 29 | `src/ui/dialog.js` | 200 | 모달/다이얼로그 시스템 |
| 30 | `src/ui/overlay.js` | 150 | 오버레이 매니저 |
| 31 | `src/ui/setup.js` | 500 | 셋업 플로우, 역할/채널 선택 |
| 32 | `src/ui/settings.js` | 400 | 설정 패널, 테마, EQ/리버브 UI |
| 33 | `src/ui/player-controls.js` | 300 | 재생 버튼, 슬라이더, 진행바 |
| 34 | `src/ui/playlist-view.js` | 300 | 플레이리스트 표시, 하이라이트 |

**의존**: 거의 모든 모듈 (UI는 최상위)
**체크포인트**: 전체 UI 인터랙션 동작

---

## Phase 8: 통합 & 부트스트랩
> Opus | ~40K tokens

| # | 모듈 | 예상 LOC | 설명 |
|---|------|---------|------|
| 35 | `src/app.js` | 300 | 부트스트랩, 모듈 초기화 순서 |
| 36 | `src/sw-register.js` | 100 | Service Worker 등록 |
| 37 | `index.html` (수정) | - | ES module script 태그로 교체 |

**체크포인트**: 풀 E2E — 접속 → 파일전송 → 재생 → 싱크

---

## 순환 의존성 해결 전략

```
문제: Playback ↔ StateMachine ↔ Network ↔ FileTransfer

해결: EventBus 패턴
┌──────────┐     bus.emit()     ┌──────────┐
│ Playback │ ───────────────→  │ EventBus │
└──────────┘                    └────┬─────┘
                                     │ bus.on()
                               ┌─────▼──────┐
                               │  Network   │
                               └────────────┘

모듈간 직접 import 금지 → bus를 통해 이벤트로 통신
```

---

## 모델 사용 전략

| Phase | 모델 | 이유 |
|-------|------|------|
| 1 기반 | **Opus** | 아키텍처 결정, 패턴 확립 |
| 2 오디오 | Sonnet | Tone.js 코드 복붙+수정 |
| 3 네트워크 | Sonnet | PeerJS 코드 마이그레이션 |
| 4 스토리지 | Sonnet | Worker 래퍼, 단순 이전 |
| 5 재생 | **Opus** | 가장 복잡, 의존성 多 |
| 6 YouTube | Sonnet | 비교적 독립적 |
| 7 UI | Sonnet | DOM 조작, 반복적 |
| 8 통합 | **Opus** | 전체 와이어링, 디버깅 |

---

## 예상 토큰 소모

| Phase | Input | Output | 합계 |
|-------|-------|--------|------|
| 1 기반 | 20K | 10K | 30K |
| 2 오디오 | 25K | 15K | 40K |
| 3 네트워크 | 30K | 20K | 50K |
| 4 스토리지 | 30K | 20K | 50K |
| 5 재생 | 40K | 25K | 65K |
| 6 YouTube | 25K | 15K | 40K |
| 7 UI | 40K | 25K | 65K |
| 8 통합 | 30K | 15K | 45K |
| **합계** | **240K** | **145K** | **~385K** |

> ⚠ 디버깅/수정 포함 시 최대 ~550K

---

## 파일 구조 최종

```
src/
├── app.js                    # 부트스트랩
├── sw-register.js            # SW 등록
├── core/
│   ├── constants.js          # MSG, DELAY, 상수
│   ├── events.js             # EventBus
│   ├── state.js              # 중앙 상태
│   ├── log.js                # 로거
│   ├── platform.js           # OS/뷰포트
│   ├── session.js            # 세션 ID
│   ├── blob-manager.js       # Blob URL 관리
│   └── timers.js             # 타이머 레지스트리
├── audio/
│   ├── engine.js             # Tone.js 그래프
│   ├── effects.js            # 리버브/EQ/VB
│   └── channel.js            # 채널 라우팅
├── network/
│   ├── peer.js               # PeerJS 관리
│   ├── protocol.js           # 메시지 라우팅
│   ├── sync.js               # 시간 동기화
│   └── relay.js              # 릴레이 체인
├── storage/
│   ├── opfs.js               # Worker 래퍼
│   ├── transfer.js           # 파일 전송
│   ├── preload.js            # 프리로드
│   └── recovery.js           # 복구
├── player/
│   ├── playback.js           # 재생 제어
│   ├── state-machine.js      # 상태 전이
│   ├── video.js              # 비디오
│   └── playlist.js           # 플레이리스트
├── youtube/
│   ├── player.js             # YT 플레이어
│   ├── sync.js               # YT 싱크
│   └── search.js             # YT 검색
└── ui/
    ├── dom.js                # DOM 유틸
    ├── toast.js              # 토스트
    ├── dialog.js             # 다이얼로그
    ├── overlay.js            # 오버레이
    ├── setup.js              # 셋업 플로우
    ├── settings.js           # 설정
    ├── player-controls.js    # 재생 UI
    └── playlist-view.js      # 리스트 UI
```

---

## 작업 규칙

1. **Phase 순서 엄수** — 하위 Phase는 상위에 의존
2. **모듈간 직접 import 금지** — `events.js` 통해서만 통신
3. **각 Phase 끝에 빌드 체크** — `vite build` 통과 필수
4. **1.0 코드 원본 보존** — `js/app.js`는 건드리지 않음
5. **점진적 전환** — index.html은 마지막에 교체
