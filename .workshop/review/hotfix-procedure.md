# Hotfix 절차

런칭 후 prod 환경에서 긴급 수정이 필요할 때 따르는 절차.

---

## 일반 hotfix (보안 외 일반 버그)

### 1. 코드 수정
```
git checkout main
git pull origin main
# fix 작성
git add <files>
git commit -m "fix(domain): describe the fix"
```

### 2. 검증
```
npm run typecheck
npm run lint
npm run test
npm run build
```
모두 통과 후 진행.

### 3. 배포
```
git push origin main
```
Netlify 자동 빌드 + 배포 (보통 1~3분).

### 4. 사용자 도달 시간

| 사용자 유형 | 시간 |
|---|---|
| **새 방문자** | 즉시 (network-first navigation) |
| **활성 사용자** (페이지 열어둔 상태) | 최대 60분 (SW periodic update) + 사용자 액션 |
| **PWA 백그라운드** | 다음 60분 timer 또는 사용자가 앱 재진입 |

→ 일반 fix는 60분 내 자연 전파. 강제 reload 안 함.

### 5. 사용자 알림 (선택)
- GitHub release notes
- 호스트 사용자라면 `/notice {message}` 로 broadcast

---

## 긴급 hotfix (보안 / 데이터 손실)

위의 60분 사이클이 너무 길면:

### 옵션 A: SW CACHE_VERSION bump + cooldown silent
1. `public/service-worker.js` 의 `CACHE_VERSION` 을 bump (`v109` → `v110`)
2. 변경 사항을 commit + push
3. 30초 cooldown 안에 재방문하는 사용자는 silent update
4. 60분 timer 사용자는 다음 update check 때 다이얼로그

### 옵션 B: version.json 폴링 (현재 미구현 — 필요 시 도입)
```
1. /version.json 에 build hash 저장
2. 클라이언트가 5분마다 fetch 비교
3. 변경 감지 시 자동 reload (재생 중이면 끊김)
```

도입 시:
- `public/version.json` 빌드 시 자동 생성 (vite plugin 또는 post-build hook)
- `src/sw-register.ts` 에 폴링 로직 추가 (10줄)
- 재생 중이면 다이얼로그 옵션 (UX 마찰 감소)

### 옵션 C: 강제 reload (최후 수단)
- 시그널링 서버 (`__MUSIXQUARE_PEER_SERVER__`) 메시지로 broadcast
- WebSocket 통해 active session 들에 reload 명령
- 인프라 추가 필요 (현재 미지원)

---

## 롤백 절차

배포한 변경에 문제 발견 시:

### 1. Netlify 즉시 롤백
1. Netlify 대시보드 → Deploys
2. 이전 안정 빌드 선택 → "Publish deploy"
3. 즉시 CDN propagate (~수초)

### 2. 코드 롤백
```
git revert <bad-commit-sha>
git push origin main
```
또는 hard reset (force push 주의):
```
git reset --hard <last-good-sha>
git push --force-with-lease origin main  # 주의: 다른 사람이 push 했으면 위험
```

### 3. 사용자 도달
일반 hotfix와 동일 (60분 자연 전파).

---

## 외부 의존성 다운 시

### PeerJS 시그널링 다운 (`0.peerjs.com`)
**증상**: 새 세션 못 만듦, 사용자에게 `error.signal_server_fail` toast.
**대응**:
1. 자체 PeerJS 시그널링 서버 운영 시: 즉시 fallback
2. PeerJS 공식 free 사용 중: 대기 (보통 수 시간 내 복구)
3. 단기 대안: Netlify Function 으로 자체 시그널링 서버 (PeerJS 프로토콜 호환)

### TURN 서버 다운 (Metered.ca)
**증상**: Remote peer 파일 전송 실패. 같은 LAN 사용자만 가능.
**현재 처리**: 자동 STUN-only 폴백 + 사용자 경고 토스트.
**대응**: 1~2시간 모니터, Metered.ca status 확인.

### YouTube IFrame API 다운
**증상**: YouTube 모드 안 됨. File mode 정상.
**현재 처리**: `youtube.load_fail` toast + IDLE 상태 복귀.
**대응**: YouTube 인프라 다운은 거의 없음. 수 분 내 자동 복구.

### Netlify Function 다운 (`get-turn-config`)
**증상**: TURN credential 못 받음 → STUN-only 작동.
**현재 처리**: 자동 폴백 (`peer.ts:128-160`).
**대응**: Netlify status 확인.

---

## 사후 대응 체크리스트

긴급 hotfix 적용 후:

- [ ] 사용자 신고 ↓ 확인
- [ ] 본 사고 원인 분석 (post-mortem)
- [ ] 재발 방지 코드 추가 (테스트, validator, watchdog 등)
- [ ] `.workshop/review/fixNN.md` 작성 (fix21 패턴 따라)
- [ ] 메모리 노트 업데이트 (필요 시)
