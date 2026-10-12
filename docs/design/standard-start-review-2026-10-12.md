# 일반방 시작 시계·학습 이식 제안 재검증 — 2026-10-12

## 범위와 상태

- 검토·실행 코드: `94f79101d9af612b7600037ee2d9dd0968680a43`.
- Windows, 고정 Node 24.20.0, Vitest 5.0.3, jsdom/fake timer 및 실제 시계 함수.
- 일반방 제안의 타당성 검토다. 제품 코드·상수·저장 정책·플랫폼 감지는 수정하지
  않았다. 푸시·PR·배포 없이 로컬 증거와 QA 기준만 기록한다.
- 현장의 특정 기기 오차 원인이나 실제 Android 출력 지연을 이번 모형으로 확정하지 않는다.

## 확정: 일반방 C11의 학습 오염과 영속 저장

`src/youtube/sync.ts`의 guest precision rendezvous는 원래 play deadline에서 최대
150ms 늦은 callback까지 재생하며, 800ms 뒤 `guest − host − manualOffset`을
학습한다. 이 경로에는 release 때 위치 따라잡기가 없고, callback 지연 제거도 없다.
현재 EMA는 `current − driftMs × 0.3`이며 값은 localStorage의
`musixquare-yt-play-latency`에 기록된다. `core/state.ts`는 다음 초기화 때 이를 읽는다.

실제 `sync.ts`를 기존 통합 fixture의 가짜 iframe/host clock과 연결해 시간 변수를
분리했다. 플레이어는 실제 테스트 시각에 맞춰 위치를 진행하고, state와 localStorage,
`resetState()` 뒤 복원값을 함께 검사했다. 저장값·유효 lead가 0인 시작 조건이다.

| 주입한 조건 | 현재 코드의 결과 |
| --- | --- |
| 지연 없음 | 학습 0ms, 새 저장 없음 |
| play callback만 30ms 늦음 | 9ms 저장, 상태 초기화 뒤 9ms 복원 |
| play callback만 150ms 늦음 | 45ms 저장, 상태 초기화 뒤 45ms 복원 |
| play callback이 151ms 늦음 | 기존 deadline guard가 재생 취소, 학습 없음 |
| 측정 callback만 100ms 늦음 | 학습 0ms; 양쪽 위치가 계속 진행하므로 늦은 측정 자체는 오차가 아님 |
| play callback 30ms + 모형의 미디어 시작 지연 100ms | 39ms 저장: 두 원인이 섞임 |
| 수동 offset +0.4초 또는 −0.4초, play callback 30ms | 각각 9ms 저장; 수동 offset 제외는 작동 |
| 첫 buffer 확인이 늦어 원래 play deadline보다 30ms 지나서 0ms release timer 등록 | 9ms 저장; 0으로 자른 timer 대기 시간만으로는 지연을 복원할 수 없음 |

9개 scratch probe가 현재 결함을 명시한 기대값과 일치했다. 이는 수정 성공 검사가
아니다. Android의 `max(stored, 250)`과 clamp 때문에 모든 기기에서 30ms → 저장값
+9ms가 되는 것은 아니다. 위 숫자는 중립 조건이며, 이후 깨끗한 표본은 잘못 배운
값을 줄일 수 있다. 영속 저장과 영구 회복 불가는 구분한다.

수정 방향은 아래로 좁힐 수 있다.

1. 원래 **부호 있는** play deadline을 단조시계에 대응시켜 실제 호출 지연을 잰다.
   buffer-ready가 이미 늦은 경우도 포함한다. `max(0, waitMs)` 이후를 기준으로
   만들면 마지막 재현이 빠진다.
2. 이 경로의 drift 부호에서는 `learningDrift = observedDrift + releaseLateness`가
   맞다. 현재는 위치 따라잡기가 없으므로 PRO의 40ms 보정 분기를 복사하지 않는다.
3. 실제 미디어 지연 학습, 수동 offset 제외, outlier·상태·곡 identity·끝 경계는
   유지한다. 측정 timer 지연을 추가로 빼지 않는다.
4. 변경 가능한 host offset이나 벽시계 이동을 callback 지연으로 오인하지 않도록
   작업 중 시계 연속성을 별도 검증한다. 미디어 위치/계산값의 유한성 방어도 확인한다.

## C13: 명시적 Android 힌트 보완과 데스크톱 모드 추정은 다르다

`core/platform.ts`의 `IS_ANDROID`는 UA 정규식만 검사한다. UA에 Android가 없어도
명시적 `userAgentData.platform === 'Android'`가 남는 경우는 보완 가능하다.
그러나 [Chrome 공식 데스크톱 모드 설명](https://developer.chrome.com/blog/desktop-mode)은
UA와 플랫폼 Client Hint가 모두 Linux로 바뀌는 경우를 명시한다. 이 경우는 힌트
한 줄 추가로 해결되지 않는다. Linux/Windows + touch 또는 `mobile: false`만으로
Android를 단정하면 정상 데스크톱에 보정을 잘못 적용할 수 있다.

공통 상수는 음향 외에도 capture 지원·입력·viewport에 쓰인다. 명시적 힌트를 넣더라도
Windows 등 다른 판별과의 상호 배타성, 기존 iPad 예외를 함께 검증해야 한다.
데스크톱 모드 전체를 작은 수정으로 안전하게 해결한다는 판정은 보류한다.

누락된 보정의 크기 역시 모든 경로에서 250ms가 아니다. 일반방 랑데부는
`max(stored, 250)`여서 저장값이 이미 크면 변화가 없고, zero-start는 host/guest의
플랫폼 seed 차이를 사용한다. PRO scheduled-control은 원래 플랫폼 lead가 0이며,
PRO 학습값은 일반방 localStorage 값과 별도의 방·epoch별 메모리다.

## 기존 구조가 더 낫다는 주장에 붙는 조건

- 정확히 같은 PRO C2/C4 경로는 없다. `shared-clock.ts`는 READY round를 닫거나
  refresh 한 표본으로 풀을 초기화하지 않고, 유효 PONG을 하나의 min-RTT 풀에 넣는다.
  다만 새 최저/동률 RTT, 표본 만료·리셋·rebase로 전역 선택값은 바뀐다. 일반방
  전체에 작업 중 값 변경 위험이 없다는 증거는 아니다.
- 60개·2분 제한의 age prune은 **유효 PONG 수신 시** 실행된다. 무응답 2분 경과가
  곧 `isClockCalibrated() === false`라는 뜻은 아니다. 기존 100ms wall/monotonic 검사,
  host로 뒷받침한 local step rebase, `2000ms + RTT 불확실성` 초과 flush도 있다.
- 파일 PLAY는 이미 수신 시 단조시계 deadline을 고정한다. 미보정 shared-start는
  로컬 수신 +200ms로 시작하고 PING을 요청한다. 예약/재생 lock 및 초기 1초 arm
  조건을 지난 유효 PONG에서 보정하므로 반드시 첫 응답 즉시는 아니다.
- 파일의 정상 drift 보정은 hard >2초, soft ≥50ms 같은 방향 3표본과 성공 후
  10초 cooldown이다. 조건을 통과한 보정 수치이지 실제 음향 정렬 보장이 아니다.
- “일반방은 모든 시작에 Android 250ms 적용하므로 C1이 없다”는 설명은 과하다.
  guest/host precision rendezvous, 상대 플랫폼 seed를 쓰는 zero-start, legacy 예약,
  즉시 재생·timeout fallback의 적용 경로는 다르다. 이 차이 자체만으로 모두 결함이라고
  정하지 않으며, 같은 작업 종류끼리 측정해야 한다.

## 계측과 QA 기준

새 네트워크 요청 없이 표본의 send/receive 벽시각·단조시각과 선택 기록을 남길 수
있다. 하지만 일반방은 선택값 자체가 min-RTT 후보이므로 **선택값과 현재 최솟값을
비교하면 항상 같은 값**이다. 이전 선택값 대 새 후보, 또는 작업이 고정한 값 대
이후 후보를 비교해야 한다. 같은 ID의 rebase도 값 변경이므로 기록해야 한다.

기존 recorder는 1초마다 시계 요약과 wall/monotonic 차이를 기록한다. 원시 왕복과
선택 표본 ID는 없고 event ring은 240개다. 동률 RTT로 초마다 선택 ID가 바뀌면
4분 만에 event ring을 채울 수 있어 coalescing 또는 별도의 유한 ring이 필요하다.
세션 경계 초기화, 숫자·분류값 whitelist, 개인정보 제외, 로컬 메모리 전용을 유지한다.
구간 비중첩은 고정 offset/비음수 전송 지연 가정의 불일치 증거이며 원인 확정은 아니다.

작업별 값 고정, 조기 확정 뒤 늦은 표본, 형제 경로 보정, 일회성 지연 학습,
lease 유지와 신규 획득 자격의 분리를 `qa-domains.md`의 공통 검토 기준에 추가했다.
이번 우선순위는 C11 재현 회귀와 최소 수정 → 일반방 관측 → 실기 측정이다.
C13은 명시적 증거만 쓰는 감지 보완과 불확실한 기기의 처리를 별도 검토한다.

## 실행 결과와 한계

- 원본 코드 C11 scratch probe: **9 pass / 0 fail / 0 skip**, 1.65초.
  `scratch/standard-clock-review-2026-10-12/make-probe.mjs`가 기존 fixture에서
  독립 재현을 생성한다. `probe.test.ts`, `vitest.config.ts`, `probe.log`는 로컬에만 있다.
- 기존 shared-clock, file-play-timing, network sync: 3파일
  **107 pass / 0 fail / 0 skip**, 고정 Node에서 6.12초.
  로그: `scratch/standard-clock-review-2026-10-12/existing-tests.log`.
- 같은 107개를 기본 Node 24.13.1에서도 먼저 실행했으나 합산하지 않았다.
- 전체 suite·E2E·빌드·실기 음향은 미실행. 제품 코드를 수정하지 않았으며,
  이미 열어 둔 PRO/실기 항목을 이번 조사로 닫지 않는다.
