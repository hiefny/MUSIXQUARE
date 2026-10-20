# 백그라운드 복귀 시 항상 동기화 (2026-10-20)

- Status: 제품 런타임 변경과 로컬 검증 기록이다. 배포되지 않았고 버전·서비스 워커 캐시도 올리지 않았다. 배포
  결과의 정본은 [릴리스 기록](../release-record.md)과 [릴리스 이력](../release-history.md)이다.
- 계기: 오너 요청(2026-10-20). 일반 방과 PRO 방, YouTube와 로컬 파일 모두에서 앱이 백그라운드 복귀를 감지하면
  항상 사용자가 동기화 버튼을 누른 것과 같은 동작을 내부에서 실행한다.
- 커밋: `5e8d8623` (브랜치 `agent/background-resume-sync`).

## 바뀌기 전

복귀 처리(`core/background-resume-guard.ts` → `app.ts` `recoverLongBackgroundResume`)는 일부 경우에만 방을
맞췄다.

- 일반 방 게스트 파일: 출력이 깨졌을 때만 rejoin으로 재동기화했고, 정상 재생·일시정지 상태로 돌아오면 아무것도
  하지 않았다.
- 일반 방 게스트 YouTube: 15초 이상 숨어 있다가 연결이 살아 있으면 전송 계층이 `monitoring`을 돌려줘서 방
  동기화를 건너뛰었다. 실행할 때도 `guestRendezvousSync({ silent: true })` 결과(busy, 오래된 스냅숏의
  no-data)를 무시해 재시도가 없었다.
- 일반 방 호스트 YouTube: 버튼의 수동 방송이 아닌 일반 heartbeat 방송(`youtube:broadcast-sync` →
  `broadcastYouTubeSync(false)`)이라 중복 제거·자동 동기화·nudge 가드에 막힐 수 있었다.
- PRO 방: 런타임의 visibility 처리기가 YouTube만 재적용(`youtubeOnly: true`)해서 파일은 정상·일시정지
  복귀 때 맞추지 않았다.

## 변경

`player/background-return-sync.ts`의 `runBackgroundReturnSync`가 복귀 복구의 마지막 단계(peer → wake lock →
오디오 출력 복구 뒤)로 매번 실행된다. 버튼과 같은 갈래를 고르되 nudge 패널, 토스트, 버튼의 진행 표시는 쓰지
않는다.

| 방 | 미디어 | 역할 | 복귀 때 실행 |
| --- | --- | --- | --- |
| PRO | 파일·YouTube | 누구나(운영자 포함) | 전체 재조정(`youtubeOnly: false`, rendezvous) |
| 일반 | YouTube | 호스트 | `broadcastYouTubeSync(true)` (버튼과 같은 수동 방송) |
| 일반 | YouTube | 게스트 | `guestRendezvousSync`, busy·no-data·스냅숏 대기면 재시도 |
| 일반 | 파일 | 게스트 | `sync:force-resync` (재생·일시정지 모두) |
| 일반 | 파일 | 호스트 | 방 전체 동작 없음(버튼도 패널만 연다). 출력이 깨지면 기존 로컬 재구성 유지 |
| - | 시스템 오디오·데모·미디어 없음 | - | 없음(동기화 버튼이 없거나 해당 없음) |

- PRO: 런타임의 기존 visibility 복구를 넓힌다(`requestProRoomBackgroundReturnSync`). 화면이 보이는 순간
  YouTube 전용 재적용이 먼저 돌고, 오디오 검사 뒤 같은 복귀의 복구를 전체 범위로 바꾼다. 이미 재적용한 복귀는
  다시 하지 않고, 진행 중인 재적용에는 합류하며, 처리 중 다시 숨었다 돌아오면 새 복귀로 한 번 더 맞춘다.
  재시도는 기존 1·3·10·15초 간격이고 전체 범위는 그 4번까지만, 그 뒤 YouTube 항목은 기존의 무제한 재시도로
  돌아간다.
- 게스트 YouTube 재시도: local-output rejoin과 같은 250·750·1500·3000·5000ms, busy는 rendezvous가 알려주는
  대기 시간을 쓴다. 새 복귀가 이전 재시도 사슬을 대체한다. `deferMissingHostSnapshot`으로 살아 있는 호스트
  스냅숏을 기다린다.
- `monitoring`(15초 이상 숨은 뒤 연결 확인 중): rendezvous는 게스트 로컬 동작이라 호스트에 아무것도 보내지
  않고 10초 이내 스냅숏으로만 실행된다. 15초 넘게 숨은 뒤에는 정지 전 스냅숏이 모두 오래돼서 살아 있는
  연결의 heartbeat를 받은 뒤에만 실행되므로 바로 시작해도 안전하다. 연결이 끊긴 것으로 판정되면
  (`stale-connection-closed` 또는 hostConn 교체) 실행·재시도하지 않고 HOST_DISCONNECTED 재접속 경로에 맡긴다.
- 오디오 복구 우선: 이번 복귀의 파일 출력을 오디오 복구가 맡은 경우(복구 대화상자의 탭 대기, 대기 중인 native
  AudioContext 복구, 이미 낸 `playback:local-output-rejoin`, 이전에 열린 복구 대화상자) 파일 동기화는 건너뛴다.
  이들은 출력이 돌아온 뒤 같은 정렬(PRO 재조정, 게스트 재동기화, 호스트 로컬 재구성)을 스스로 한다. 대화상자는
  복귀 흐름이 탭을 기다리므로 동기화는 탭 뒤에 판단한다. 긴 백그라운드 경고는 동기화 뒤에 그대로 뜬다.
- 잠재 버그 수정: rejoin 라우터가 `background-resume`·`audio-recovery-gesture` 요청을 YouTube에서도 파일
  일시정지 비트로 판단하던 것을 모드별 일시정지 비트로 고쳤다(현재 YouTube로 오는 요청은 없어 동작 변화 없음).

## 임계값 결정

복귀로 보는 기준은 기존 가드의 1초(`DEFAULT_RECOVER_THRESHOLD_MS`)이고 그 밖의 최소 시간은 없다. 1초 미만의
visibility 깜빡임(탭 미리보기, DevTools, 브라우저 UI)은 백그라운드 복귀가 아니고, 일반 방 호스트의 동기화는
모든 게스트를 다시 rendezvous시키기 때문이다. 짧은 반복 복귀는 긴 임계값 대신 가드의 single flight와 합쳐진
후속 1회, PRO 재조정 병합, 게스트 rendezvous 쿨다운(3초), 하나의 재시도 사슬로 흡수한다. 1초 미만 복귀의 PRO
YouTube 재적용은 전과 같다.

## 검증

- 단위(새 `background-return-sync.test.ts`): 가드 → 복구 → 동기화를 실제로 연결해 방{일반, PRO} × 미디어{파일,
  YouTube} × 역할{호스트, 게스트} × {재생, 일시정지} 16가지가 복귀마다 정확히 한 번(두 번째 복귀에서 다시 한
  번) 버튼 동작을 실행하는지, 시스템 오디오는 실행하지 않는지 확인한다. 1초 미만 복귀 무시, 복구 중 빠른
  숨김·표시 4회가 후속 1회로 합쳐짐, 오디오 복구 소유 시 파일 건너뜀, `monitoring` 중 실행·스냅숏 대기 재시도,
  연결 종료 시 재시도 중단, busy 대기·재시도 상한, 새 복귀의 사슬 대체, zero-start·데모·세션 밖 건너뜀도 있다.
- 단위(PRO 런타임): visibility 재적용이 이미 끝난 YouTube 복귀는 다시 적용하지 않음, 진행 중인 재적용에
  합류(heartbeat·commit 1회), 파일 항목은 YouTube 전용 단계에서 그대로 두고 동기화 요청 뒤 재생·일시정지
  checkpoint를 한 번 재적용. 앞의 두 검사는 중복 방지 줄을 지운 변이에서 실패한다.
- 갱신: `background-resume-recovery.test.ts`(방 단계 → 동기화 단계), `local-output-rejoin.test.ts`(모드별
  일시정지 판단). 동기화 버튼 자체는 바뀌지 않아 player-controls 테스트는 그대로다.
- 로컬 Windows, Node 24.20.0, 커밋 `5e8d8623`: `npm run typecheck`·`npm run lint`·`npm run format:check`
  통과, unit 601 files / 13,512 pass / 0 fail / 0 skip, `guard:bus-pairing`·`guard:dead-exports`·
  `guard:import-graph`·`guard:room-authority-boundaries`·`guard:source-complexity`·`guard:standard-room-hot-path`·
  `guard:lifecycle-writes` 통과. 로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## 검증하지 못한 것

- 실기기(iOS·Android의 실제 백그라운드 정지, BT 출력, 실제 R2 파일의 PRO 재조정)는 확인하지 않았다. PRO 파일
  재적용은 mock 미디어 endpoint로만 확인했다.
- Playwright e2e(`e2e/background-resume.test.ts` 포함)와 `build:checked`는 실행하지 않았다. 그 e2e의 일반 방
  단독 호스트 파일 시나리오는 이번 변경에서 실행 동작이 없어서 기대값이 그대로다.
- 복귀마다 실제 동기화가 일어나므로 호스트가 탭을 자주 오가면 게스트의 YouTube가 그때마다 다시 맞춰진다(최대
  3초마다 1회). 오너 요청의 의도된 결과다.
