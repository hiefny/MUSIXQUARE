# MUSIXQUARE — Fix Ignore List

> 10-agent 정밀 분석 (2026-03-01) 기반 — 스캔 시 아래 항목은 **의도된 동작** 또는 **구조적 한계**로 확인됨.
> 이후 스캔에서 동일 패턴이 잡히면 건너뛸 것.

---

## B. 의도된 동작 / 오탐 (수정 불필요)

### B1. innerHTML XSS 경고 (chat.ts, playlist-view.ts, i18n 등)
- `escapeHtml()` / `escapeAttr()`가 모든 untrusted 경로에 적용됨
- system message, toast, dialog는 `textContent`/`innerText` 사용
- **결론**: XSS 취약점 없음

### B2. `Tone = _Tone as any` / `Peer: any` 캐스팅
- Tone.js, PeerJS를 vendor 타입 없이 사용하는 의도적 패턴
- 자체 인터페이스(`ToneNode`, `DataConnection` 등)로 최소 타이핑 제공
- **결론**: tree-shaking 불가 트레이드오프 포함, 현재 구조에서 불가피

### B3. `YT: any` / `_youtubePlayer: any`
- YouTube IFrame API에 공식 TS 타입 없음
- `declare const YT: any`는 표준 패턴
- **결론**: 의도적

### B4. empty catch (safeDisconnect, dispose, Tone.js 관련)
- `safeDisconnect()`: Tone.js는 미연결 노드 disconnect 시 항상 throw
- `dispose()` cleanup: 부분 생성된 노드 정리 시 throw 가능
- **결론**: 주석으로 명시된 의도적 에러 삼킴

### B5. PeerJS cleanup catch (leaveSession, handleHostIncomingConnection)
- 이미 닫힌 connection에 close/destroy 호출 시 throw
- `beforeunload`에서 cleanup 실패는 무관
- **결론**: 의도적

### B6. bus.on 리스너 미정리 (init 함수들)
- 모든 `init*()` 함수는 app.ts에서 1회만 호출
- SPA 수명주기 = 리스너 수명주기
- re-init 경로 없음 → 리스너 누적 불가
- **결론**: 정리 불필요

### B7. AudioContext 미닫기
- SPA에서 AudioContext는 페이지 수명 동안 유지해야 함
- `Tone.context.close()` 호출 시 재초기화 불가
- **결론**: 의도적 설계

### B8. Worker 미종료
- sync.worker, transfer.worker 모두 bootstrap 시 1회 생성
- 페이지 언로드 시 자동 종료
- 세션 종료 시 타이머만 정지 (`STOP_ALL`)
- **결론**: SPA 패턴, 정리 불필요

### B9. `user-scalable=no` (viewport meta)
- 모바일 웹앱에서 의도적 줌 방지
- 음악 플레이어 UI에서 핀치 줌은 UX 저해
- **결론**: 의도적

### B10. `requestCurrentFile` / `requestDataRecovery` 오퍼레이터 미검증
- 모든 게스트가 파일 데이터를 수신해야 재생 가능
- 오퍼레이터 여부와 무관하게 파일 전송은 필수
- **결론**: 의도된 설계

---

## C. 구조적 한계 (대규모 리팩토링 필요, 기능적 버그 없음)

### C1. Map/Set in-place mutation without setState (peer.ts 등 11건)
- `peerSlotByPeerId`, `activeHostConnByPeerId`, `peerLabels`, `preload.sessionState`, `preload.ackSent` 등
- 모두 `getState()` 직접 읽기로 소비 — `state:*` bus listener 0건
- 수정 시 대규모 변경 필요하나 동작 차이 없음
- **결론**: reactive listener 추가 시점에 함께 수정

### C2. P2P 메시지 런타임 타입 검증 미비
- `data.value as number`, `data.chunk as ArrayBuffer` 등 캐스팅
- 친구간 사용 앱 — 악의적 peer 위협 낮음
- `escapeHtml`, `Number()`, `|| 0` 등으로 방어
- **결론**: 공개 서비스 전환 시 zod/validator 도입

### C3. Interactive div 키보드 접근성
- `.theme-opt`, `.lang-opt`, `.ch-opt`, `.ob-dot` 등에 `role="button"` / `tabindex="0"` 미설정
- 모바일 퍼스트 앱, 키보드 내비게이션 사용 비율 극히 낮음
- **결론**: 접근성 전면 개선 시 함께 처리

### C4. Tone.js tree-shaking 불가
- `import * as _Tone from 'tone'` → named import 전환 필요
- 전환 시 모든 Tone 호출부 타입 재작업 (수십 곳)
- 336KB → ~200KB 절감 예상이지만 ROI 낮음
- **결론**: 성능 최적화 단계에서 검토

### C5. OPFS 파일 세션 종료 시 미정리
- 3-30MB/세션 디스크 누적
- 브라우저 quota가 자동 관리
- `leaveSession()`에 worker 통신 추가 필요 → 복잡도 증가
- **결론**: 장기 세션 사용 패턴 확인 후 판단

### C6. 빈 aria-label 초기값 (i18n 로드 전)
- 30+ 요소에 `aria-label="" data-i18n-aria-label="key"` 패턴
- i18n 모듈 초기화 ~50ms 이내 완료
- **결론**: 실질적 temporal gap 무의미

### C7. 터치 타겟 44px 미달
- `.ctrl-btn-small` 32px, `.ob-nav-arrow` 20px, `.ob-dot` 8px 등
- 32px 버튼은 일반적 모바일 앱 수준
- `.ob-dot`, `.ob-nav-arrow`는 PC 전용 UI
- 실사용 불편 신고 0건
- **결론**: 수정 불필요

### C8. 테스트 커버리지 갭 — 브라우저 전용 API 모듈
- `opfs.ts`: `navigator.storage.getDirectory()` (OPFS API)
- `video.ts`: `HTMLVideoElement` DOM 조작
- `media-session.ts`: `navigator.mediaSession` API
- 셋 다 jsdom/vitest 환경에서 네이티브 mock 불가 또는 mock 복잡도 > 실제 코드
- Playwright/Cypress 등 E2E 테스트로만 커버 가능
- **결론**: E2E 도입 시 함께 처리

---

## D. 참고: 기존 vendor 경고 (Vite dev server)

```
[vite] Internal server error: Failed to load url /vendor/Tone.js
[vite] Internal server error: Failed to load url /vendor/peerjs.min.js
```

- `public/` 디렉토리에 vendor JS 없음 (npm으로 설치, Vite가 번들링)
- dev server에서만 발생하는 경고, production build 정상
- **결론**: 무시
