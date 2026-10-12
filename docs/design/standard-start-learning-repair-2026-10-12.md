# 일반방 랑데부 학습·시계 관측 수정 — 2026-10-12

## 범위와 코드

- 코드 커밋: `f77617824c62eab6aa9c8f1c92bfb06facf4acf7`.
- 취소 관측 리뷰 후속: `b7eca9aa0f56b2b0508b3415c11ecdb62184a0d9` (아래 별도 검증).
- 시작 기준: `4806b1ca3a9b32ef97bec60ce4abba5ecde18906`.
- Windows, Node **24.20.0**, Vitest **5.0.3**. 시간 경계는 실제 `sync.ts`와
  SharedClock을 검사하되 iframe·네트워크·시간 진행은 각 테스트에서 모사한다.
- 일반방 C11과 작업별 시계 관측(5b)을 같은 코드 커밋으로 묶었다. SharedClock
  선택 관측(5a)도 포함한다. 로컬 커밋만이며 푸시·PR·병합·배포하지 않았다.
- [수정 전 재현·후보 판정](standard-start-review-2026-10-12.md)을 이어받는다.

## 학습 입력 수정

정밀 랑데부의 원래 부호 있는 host play deadline을 계획 시점의 단조시계에
대응시켜 보존한다. 버퍼가 늦게 준비되어 release timer를 0ms로 만들더라도 원래
마감을 잃지 않는다. `playVideo()` 호출 직전에 실제 지연을 측정하고 다음 식을 쓴다.

```text
uncorrectedLateness = max(0, releaseLateness − appliedCatchUp)
learningDrift = (guestPosition − hostPrediction − manualOffset) + uncorrectedLateness
nextLatency = round(clamp(currentLatency − learningDrift × 0.3, 0, 600))
```

위 식의 단위는 ms다. **이 일반방 경로의 `appliedCatchUp`은 0**이다. 준비 때
seek 한 번 후 release 때 위치를 다시 계산하거나 seek하지 않는다. 따라서 PRO의
40ms 분기를 복사하지 않는다. 회귀 검사에서 물리적 seek가 정확히 한 번인지 고정해,
나중에 위치 보정이 추가되면 이 가정도 함께 검토하도록 했다. 가상의 0이 아닌
보정 분기를 새로 만들거나 검증했다고 주장하지 않는다.

측정 callback만 늦으면 양쪽 위치가 함께 진행하므로 그 지연을 추가 보정하지 않는다.
실제 미디어 시작 지연은 계속 학습한다. 기존 localStorage 값은 강제 초기화하지
않으며, 기존 로드 범위 검사·0–600ms 상한·Android 하한은 그대로다.

학습 자격은 **계획 → 타이머 예약 → 재생 호출 → 표본 관측** 네 시점으로 판단한다.
모든 시계가 보정되어 있고 값이 유한하며 단조시각 순서가 유지되어야 한다.
offset 최대−최소는 5ms 이하, `(wall − monotonic)` 최대−최소는 50ms 이하만
허용한다. 이는 학습용 방어 기준이며 가청 임계나 SharedClock 선택 정책이 아니다.
원시/보정 후 drift의 기존 outlier 범위, stale snapshot·곡 일치·재생 상태·끝 경계·
숨김·취소 조건도 유지한다. 비유한 미디어 위치는 학습하지 않는다.

독립 검토에서 계획/호출/관측만 보는 세 점 검사의 빈틈을 찾아 핀을 추가했다.
버퍼 완료 때 offset +30ms 또는 벽시계 +75ms로 타이머를 예약한 뒤, 호출 전에
원복하면 세 점은 정상이어도 이미 예약이 앞당겨져 있다. 기존 저장값과 실제 미디어
지연이 모두 100ms인 모형에서 각각 **91ms / 78ms**로 잘못 저장되는 것을 먼저
재현했다. 이제 `waitMs` 계산에 사용한 바로 그 시계를 네 번째 검사점으로 포함하여
`clock-changed`로 제외하고 **100ms를 유지**한다. 타이머 예약 정책 자체는 바꾸지 않았다.

## 로컬 진단

- SharedClock 선택 변경: 이전/새 offset·RTT·표본 번호·나이·epoch와 변경 사유를
  기록한다. 사유는 새 표본, 동률 RTT, 만료, 용량 초과 퇴출, 리셋, rebase, 큰 시계
  스텝, 방장 역할 변경이다. 동률의 동일 offset/RTT 교체는 중복 로그를 줄인다.
- 같은 epoch의 두 유효 표본만 구간 비교한다. `intervalGapMs`는
  `max(0, abs(newOffset − oldOffset) − (oldRTT + newRTT)/2)`이며, 비중첩 판정에는
  별도 5ms 여유를 둔다. epoch가 다르면 비교값은 null이다. 불일치가 어느 네트워크
  방향의 문제인지나 참 시계를 알아냈다는 뜻은 아니다.
- wall/monotonic 불연속·rebase 관측도 기록한다. 앞선 응답이 미응답 ping의 시각을
  rebase할 수 있어 `rawSentAtMs/rawWallElapsedMs`와 계산에 쓰는
  `sentAtMs/wallElapsedMs`를 분리한다. 원래 송신시각을 보존하는 핀도 추가했다.
- 랑데부 작업별 번호로 네 시점 offset, 적용 lead/manual offset, 원래 마감, 실제
  호출/표본 시각, 미보정 지연, 원시/학습 drift, 자격·제외 사유, 저장 전후 값을 남긴다.
- clock **1,200개**, playback **512개**의 별도 메모리 ring, 단조시계 기준 최대
  **20분** 보관이다. 한쪽 로그가 다른 쪽을 밀어내지 않으며 세션 경계에 비운다.
  숫자·고정 분류만 허용하고 room/peer/video/파일/사용자 식별자는 받지 않는다.
  기존 flight recorder 복사에 두 JSONL 절로 포함하며 저장소·전송·추가 요청은 없다.

SharedClock의 60개/2분 풀, 유효 PONG 때의 age prune, min-RTT/동률 선택, 기존
100ms 연속성 검사와 큰 offset step 처리에는 동작 변경이 없다. 일반방에 PRO lease를
이식하지 않았다. 이번 작업 관측은 **guest precision rendezvous**이며, zero-start·
즉시 재생·복구 등 모든 경로에 관측을 붙였다는 뜻은 아니다.

## 검증

아래 최초 수정 검사는 코드 커밋 `f7761782`에서 실행했다. 취소 관측 리뷰 후속의
별도 결과는 다음 절에 기록한다.

| 검사 | 결과·범위 |
| --- | --- |
| 전체 Vitest | **548파일, 11,853 pass / 0 fail / 0 skip**, 148.14초. jq 경로를 지정해 해당 검사를 건너뛰지 않음 |
| 신규 랑데부 핀 포함 통합 파일 | **195/195 pass**, 기존 168 + 신규 27. 전체 Vitest에도 포함 |
| SharedClock | **26/26 pass**, 선택 변경·만료·구간 비교·rebase·원 송신시각 보존 포함 |
| Chromium E2E | `youtube-sync`·`playback-sync` **10 pass / 0 fail / 0 skip**, 40.6초. 실제 두 브라우저 context와 로컬 PeerJS, 가짜 YouTube Player 사용 |
| TypeScript | App·테스트 전체 타입 검사 통과 |
| ESLint·Prettier | 변경한 소스/테스트 파일 통과 |
| 구조 검사 | dead exports, source complexity, import graph, room authority boundaries 통과. 기준 완화 없음 |
| 프로덕션 빌드 | `npm run build`, production hook/static-header 검사, production security 검사 통과 |

전체 브라우저 E2E·WebKit·실기·원격 CI·운영 smoke는 이번 범위에서 실행하지 않았다.
`build:checked` 전체 릴리스 체인도 실행하지 않았으며, 버전 미갱신 로컬 코드를
배포 가능하다고 판정하지 않는다. Chromium 검사는 실 YouTube 네트워크나 실제
음향 출력 지연의 증거가 아니다.

최종 로그:
`scratch/standard-c11-full-vitest-green.log`,
`scratch/standard-c11-code-app-types.log`, `scratch/standard-c11-code-test-types.log`,
`scratch/standard-c11-final-lint.log`, `scratch/standard-c11-final-format.log`,
`scratch/standard-c11-production-build.log`, `scratch/standard-c11-e2e.log`.
독립 재현 로그는 `scratch/standard-clock-review-2026-10-12/`의
`tracked-regression-{red,green}.log`, `transient-scheduling-{red,green}.log`다.
scratch는 로컬 증거이며 Git에 포함되지 않는다.

검증 중 실패를 숨기지 않는다. 최초 관련 묶음에서는 기존 두 fixture의 SharedClock
mock에 새 관측용 `getClockOffset`이 빠져 12개가 실패했다. `getHostNow = Date.now`
모형과 일치하는 0 offset을 추가했으며 assertion을 완화하지 않았다. 신규 버퍼 지연
핀 하나는 fake timer의 중첩 0ms callback이 1ms 뒤 실행되는 실제 모형에 기대값을
맞췄다. 제품의 lateness 허용치를 바꾸지 않았다. 첫 전체 Vitest는 **11,851 pass /
1 fail / 0 skip**: 내부 시계 타입의 불필요한 export로 self-only export 수가 78→79로
늘어난 구조 검사였다. 해당 타입을 모듈 내부로 돌렸고 기준값은 올리지 않았다.

시간 경계 신규 27개는 순수 release 지연 30/150ms의 학습 0, 151ms 취소, 늦은
버퍼·늦은 관측, 실제 미디어 지연 100ms와 release 30ms 조합의 학습 30ms, 저장된
200ms와 실제 200ms 지연의 보존, 양/음 수동 offset, clock 5/6ms와 wall 50/51ms
경계, 예약 중 일시 변경·원복, 취소·연결 종료·미보정·NaN/Infinity를 포함한다.
수정 전 RED와 수정 후 GREEN은 scratch에 보관한다.

## 리뷰 후속: 취소된 시도의 eligible 기록

코드 `b7eca9aa`에서 플레이어 조회 뒤 소유권 확인을 `calibration.learn()` 앞으로
옮겼다. 이전 코드는 조회 중 취소된 시도에 eligible/nextLatency를 기록한 뒤,
소유권 검사에서 저장을 막을 수 있었다. 소유권 검사 자체도 `getVideoData()`를
호출하므로, 그 호출 뒤 정확한 attempt identity를 한 번 더 확인한다. 이후 learn과
저장 사이에는 다른 플레이어 호출이나 비동기 경계가 없다.

`sync-integration.test.ts`의
`does not record eligible learning after reentrant cancellation during %s`는
위치 조회와 마지막 소유권 조회 내부에서 각각 취소시키는 2개 핀이다. 두 경우 모두
수정 전 eligible 기록 1개로 실패했고, 수정 뒤 eligible 기록 없음·상태와 저장값
유지로 통과했다. 취소 사유의 새 sample을 쓰는 대신 학습 기록 전에 종료한다.
일반적으로도 eligible은 유효한 학습 표본이지 localStorage 쓰기 성공 횟수는 아니다.
같은 값의 no-op이나 저장소 접근 거절이 있을 수 있다.

검토자가 찾지 못했던 단일 seek 핀은 같은 파일의
`Standard rendezvous release-lateness calibration > learns only media delay: $scenario`다.
코드 `b7eca9aa` 기준 선언 **2783행**, `seekTo` 호출 횟수 1 검사 **2819행**,
`appliedCatchUpMs: 0` 검사 **2834행**이다. parameterized test라 개별 조건명만
검색하면 호출 횟수 assertion이 다른 곳에 있는 것으로 보일 수 있다.

- Windows / Node 24.20.0 / Vitest 5.0.3, 위 코드와 동일한 트리에서 YouTube·diagnostics
  전체 **44파일 1,137 pass / 0 fail / 0 skip** (9.26초). 새 2개 핀 포함.
- App·테스트 전체 타입 검사, 변경 파일 ESLint·Prettier 및 diff 검사 통과.
- 전체 프로젝트 Vitest·빌드·브라우저 E2E·실기·원격 CI는 이 후속에서 다시 실행하지
  않았다. 앞 절의 전체 통과는 `f7761782`에 대한 증거다.
- 로그: `scratch/standard-c11-cancel-observation-red.log`,
  `scratch/standard-c11-cancel-related-green.log`,
  `scratch/standard-c11-cancel-{app-types,test-types,lint}.log`.
- 5ms offset 게이트는 유지한다. 정상 min-RTT 선택 개선도 라운드를 제외할 수 있어,
  현장에서는 eligible 대비 `clock-changed` 비율과 네 시점의 선택값을 함께 본다.
  offset 차이를 drift에 반영하는 변경은 이번에 하지 않는다.

## 한계와 다음 배포

C13 플랫폼 추정, PRO 학습값 영속화, Android 250ms 변경, 타이머 편향 EMA·감쇠는
포함하지 않았다. iframe 모형의 media timeline은 실제 Bluetooth·YouTube 출력의
첫 음 정렬을 증명하지 않는다. C1/C7/C13은 실기기·독립 녹음과 flight recorder를
함께 측정한 뒤 판단한다. 전체 전환 종류별 관측 확대도 별도 작업이다.

App/SW 버전·서버 계약·설정·스키마·secrets·bindings는 변경하지 않았다. 후속
릴리스에서는 App/SW 버전 갱신과 정상 PR·exact-main CI·Production Release가
필요하다. 이 로컬 검증은 배포 후보가 아니다.
