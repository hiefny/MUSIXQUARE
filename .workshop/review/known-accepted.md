# Known & Accepted Issues — 재보고 방지 목록

fix15 전수조사 기준. 다음 감사 시 이 파일을 참조하여 중복 보고를 방지할 것.

---

## A. 잔존 버그 (수정 비용 > 실익)

### A-1. `cleanupOPFSInWorker` bus listener leak — `opfs.ts:95-119`

**상태**: ACCEPTED (발생 조건 극히 드뭄)
**문제**: 동일 파일에 대해 cleanup을 연속 호출하면 `setManagedTimer`가 이전 타이머를 대체하지만,
이전 `bus.on('opfs:cleanup-complete')` 리스너의 `unsub` 클로저가 orphan됨.
**이유**: 동일 파일 연속 cleanup은 실사용에서 발생하지 않음.
세션 종료 시 리스너가 자연 정리.

---

## B. 의도된 동작 / 오탐 (수정 불필요)

### B-1. innerHTML XSS 경고 (chat.ts, playlist-view.ts, i18n 등)
- `escapeHtml()` / `escapeAttr()`가 모든 untrusted 경로에 적용됨
- system message, toast, dialog는 `textContent`/`innerText` 사용
- **결론**: XSS 취약점 없음

### B-3. `YT: any` / `_youtubePlayer: any`
- YouTube IFrame API에 공식 TS 타입 없음
- `declare const YT: any`는 표준 패턴
- **결론**: 의도적

### B-4. empty catch (safeDisconnect, dispose)
- `safeDisconnect()`: Web Audio `AudioNode.disconnect()`는 미연결 노드에 대해 `InvalidAccessError`를 throw
- `dispose()` cleanup: 부분 생성된 노드 정리 시 throw 가능
- **결론**: 주석으로 명시된 의도적 에러 삼킴

### B-5. PeerJS cleanup catch (leaveSession, handleHostIncomingConnection)
- 이미 닫힌 connection에 close/destroy 호출 시 throw
- `beforeunload`에서 cleanup 실패는 무관
- **결론**: 의도적

### B-6. bus.on 리스너 미정리 (init 함수들)
- 모든 `init*()` 함수는 app.ts에서 1회만 호출
- SPA 수명주기 = 리스너 수명주기
- re-init 경로 없음 → 리스너 누적 불가
- **결론**: 정리 불필요

### B-7. AudioContext 미닫기
- SPA에서 AudioContext는 페이지 수명 동안 유지해야 함
- `audioContext.close()` 호출 시 재초기화 불가 (싱글톤 패턴, `src/audio/context.ts` 참조)
- **결론**: 의도적 설계

### B-8. Worker 미종료
- sync.worker, transfer.worker 모두 bootstrap 시 1회 생성
- 페이지 언로드 시 자동 종료
- 세션 종료 시 타이머만 정지 (`STOP_ALL`)
- **결론**: SPA 패턴, 정리 불필요

### B-9. `user-scalable=no` (viewport meta)
- 모바일 웹앱에서 의도적 줌 방지
- 음악 플레이어 UI에서 핀치 줌은 UX 저해
- **결론**: 의도적

### B-10. `requestCurrentFile` / `requestDataRecovery` 오퍼레이터 미검증
- 모든 게스트가 파일 데이터를 수신해야 재생 가능
- 오퍼레이터 여부와 무관하게 파일 전송은 필수
- **결론**: 의도된 설계

---

## C. 구조적 한계 (대규모 리팩토링 필요, 기능적 버그 없음)

### C-1. Map/Set in-place mutation without setState (peer.ts 등)
- `peerSlotByPeerId`, `activeHostConnByPeerId`, `peerLabels` 등
- 모두 `getState()` 직접 읽기로 소비 — `state:*` bus listener 0건
- fix01-15에서 핵심 경로(connectedPeers, preloadedIndexes 등) immutable 패턴으로 전환 완료
- 잔여 Map/Set mutation은 UI 미연동 내부 상태 → 동작 차이 없음
- **결론**: reactive listener 추가 시점에 함께 수정

### C-2. P2P 메시지 런타임 타입 검증 미비
- `data.value as number`, `data.chunk as ArrayBuffer` 등 캐스팅
- fix01-15에서 `Number.isFinite()` 가드, NaN 방어, 클램프 등 대폭 보강 완료
- 잔여 항목은 친구간 사용 앱 특성상 악의적 peer 위협 낮음
- **결론**: 공개 서비스 전환 시 zod/validator 도입

### C-3. Interactive div 키보드 접근성
- `.theme-opt`, `.lang-opt`, `.ch-opt`, `.ob-dot` 등에 `role="button"` / `tabindex="0"` 미설정
- 모바일 퍼스트 앱, 키보드 내비게이션 사용 비율 극히 낮음
- **결론**: 접근성 전면 개선 시 함께 처리

### C-5. OPFS 파일 세션 종료 시 미정리
- 3-30MB/세션 디스크 누적
- 브라우저 quota가 자동 관리
- `leaveSession()`에 worker 통신 추가 필요 → 복잡도 증가
- **결론**: 장기 세션 사용 패턴 확인 후 판단

### C-6. 빈 aria-label 초기값 (i18n 로드 전)
- 30+ 요소에 `aria-label="" data-i18n-aria-label="key"` 패턴
- i18n 모듈 초기화 ~50ms 이내 완료
- **결론**: 실질적 temporal gap 무의미

### C-7. 터치 타겟 44px 미달
- `.ctrl-btn-small` 32px, `.ob-nav-arrow` 20px, `.ob-dot` 8px 등
- 32px 버튼은 일반적 모바일 앱 수준
- `.ob-dot`, `.ob-nav-arrow`는 PC 전용 UI
- 실사용 불편 신고 0건
- **결론**: 수정 불필요

### C-8. 테스트 커버리지 갭 — 브라우저 전용 API 모듈
- `opfs.ts`: `navigator.storage.getDirectory()` (OPFS API)
- `video.ts`: `HTMLVideoElement` DOM 조작
- `media-session.ts`: `navigator.mediaSession` API
- jsdom/vitest 환경에서 네이티브 mock 불가 또는 mock 복잡도 > 실제 코드
- **결론**: E2E 도입 시 함께 처리

---

## 업데이트 이력
- 2026-03-13: fix15 감사 후 작성 — opfs listener leak 1건 잔존
- 2026-03-13: fixignore.md 통합 — B1-B10 의도적 동작 + C1-C8 구조적 한계 병합, C1/C2 fix01-15 반영 업데이트
- 2026-04-05: Tone.js 완전 제거 반영 — B-2 PeerJS 캐스팅만 유지, B-4/B-7 Web Audio 기준 재서술, C-4 Tone.js tree-shaking 항목 삭제
- 2026-04-05: PeerJS vendor/ 제거 반영 — PeerJS npm 전환 완료(`peerjs@^1.5.5` bundled by Vite), D 섹션(vendor 경고) 전체 삭제 — 경로가 프로젝트에 존재하지 않아 재현 불가
- 2026-04-05: B-2(`Peer: any` 캐스팅) 삭제 — `src/types/index.ts`에서 PeerJS 공식 타입을 정상 임포트(`import type { Peer, DataConnection } from 'peerjs'`) 중이며, `Peer: any`/`as any` 캐스팅이 `src/` 전역에 0건. npm 전환으로 자연 해소
