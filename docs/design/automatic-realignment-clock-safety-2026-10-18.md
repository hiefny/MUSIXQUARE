# 일반방 YouTube 자동 재정렬의 시계 안전성 후보

- Date: 2026-10-18 KST.
- Status: 제품 후보 구현·로컬 회귀·PR CI·native 비교와 독립 검산 완료.
  운영64/64/128 후보는 검사 범위에서 통과했다. 진단256의 재생 보호는
  확인했지만 빠른 수신자 두 대의 완료시간 비교 예산은 초과했다.
  **배포하지 않았다.**
- Base: `b977ca0bf2ecc8f5148af9eb6653a88a9c537a2e`. Native 비교에 고정한 후보는
  `fbbc5e1c9e68881988a348c587c9a81395aa986f`, App 8.11.21 / cache v725다.
  [PR #405](https://github.com/hiefny/MUSIXQUARE/pull/405)의 결과를
  base 자체의 결과나 exact-main CI로 해석하지 않는다.
- 운영 기준: runtime `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`,
  App 8.11.20 / cache v723. 이 보고서 작성으로 운영 배포가 바뀌지 않는다.
- Owner request: 운영의 논리 청크64 KiB / 로컬 송신 기준64 KiB /
  수신확인 창128 KiB를 유지하며, Qlease와 자동 보정 보호를 제품 빌드 후보까지
  발전시키고 검증한다. 이번 작업에는 프로덕션 배포 승인이 포함되지 않는다.
- Related: [앞선 격리 후보의 결과](transport-candidate-roundtable-2026-10-18.md),
  [첫 시계 품질 후보](receiver-credit-adaptive-design-2026-10-18.md),
  [운영 상태](../release-record.md).

## 수정하는 문제와 범위

앞선 확대 credit 실험에서는 파일의 순서·SHA·수신확인이 정상이어도,
혼잡으로 비대칭이 커진 시계 표본을 선택한 뒤 정렬된 YouTube를 잘못
pause→seek→play하는 경로가 관찰됐다. 이는 확대 실험의 증거이며,
운영128 KiB나 원래 Android 제보에서 같은 결함이 발생했다는 증거로 바꾸지 않는다.

이번 후보는 시계 선택 알고리즘이나 파일 전송량을 바꾸지 않는다. 일반방
YouTube의 선택적 자동 정밀 보정이 관측 불확실성을 넘는지 확인하고,
허가한 한 작업의 시각·명령·플레이어 소유권을 실행 끝까지 유지한다.
더 좋은 시계 추정치나 빠른 네트워크를 만든다는 주장이 아니다.

자동 보정의 안전성 강화와 전송 개선은 별도다. A2·F16·AF16의 확대/분할 코드를
이 후보에 섞지 않으며, 앞선 실패와 선별 기준도 그대로 보존한다.
자동 조작 횟수가 줄어도 실제 메시지 지연이나 파일 완료시간이 좋아졌다고
판정하지 않는다.

## 자동 보정의 허가 조건

관측한 드리프트의 절댓값을 `m`, 선택 표본 RTT를 `r`, 시각 분해능 여유를
5ms라고 하면 `U = r / 2 + 5ms`다. 최종 후보는 두 조건을 모두 요구한다.

```text
m >= 150ms
m > 2U
```

150ms는 기존 자동 보정의 최소 동작 기준이고, `2U`는 시계 불확실성에 대한
엄격한 개선 조건이다. 두 값을 더하지 않는다. 예를 들어 RTT218ms이면
U114ms이고, **관측** 드리프트300ms는 새 조건을 통과한다. 앞선 격리 Q의
`m > 150ms + 2U`에서는 같은 값이 보류됐다. 이는 이번에 승인한 정책 변경이며,
과거 보고서와 실행 결과를 새 식으로 소급 수정하지 않는다.

이 모델은 동일한 고정 시계 상태, 정확한 타임스탬프, 비음수 전송 지연을
가정한다. 시계 오차를 `e`, 실제 미디어 오차를 `d`라 하면 관측값은 `d-e`다.
시계 오차의 크기가 U 이하일 때 보정 전 실제 오차의 하한은 `m-U`, 관측값을
전부 보정한 뒤의 시계 오차 성분 상한은 U다. 따라서 `m>2U`이면 이 모델에서
보정 뒤의 상한이 보정 전 하한보다 작다. iframe 명령 처리·관측 지연, 스피커의
출력 지연, 실제 소리를 포함한 보장은 아니다.

선택 표본과 최신 응답의 나이, wall/monotonic 경과의 일치, epoch도 검사한다.
선택 표본은120초 미만, 최신 응답은5초 이내여야 한다. 품질 조회는 순수 관측으로,
샘플을 퇴출하거나 선택값을 바꾸거나 ping을 추가하지 않는다. 기존 min-RTT,
60개/2분 표본 정책은 유지한다. 120초 동안 좋은 표본을 붙잡아 문제를 미루는
새 retention 정책도 추가하지 않는다.

관측값은 실제 오차와 다를 수 있다. 실제±300ms 오차가 있어도 같은 부호의
시계 편향100ms가 관측 크기를200ms로 줄이면, RTT204ms의 U107ms에서
2U=214ms를 넘지 못해 보류한다. 이는 성공적인 동기화가 아니다.
해당 잔차와 보류 시간을 남겨야 한다.
품질이 회복되면 새로 적격인 heartbeat 두 번으로 다시 판단한다. 품질이 계속
나쁘면 중간 크기의 실제 오차가 계속 남을 수 있으며, 이를 이번 후보의 한계로 둔다.

## 한 작업의 시각과 소유권

자동 보정은 플레이어를 읽기 전에 시계 lease를 잡아 관측과 목표 계산의 기준을
고정한다. 그 관측을 만들었던 host snapshot과 명령 세대를 admission까지
같이 전달한다. 플레이어 getter가 새 PAUSE·STOP·seek·leave를 발생시키거나
선택 시계/epoch가 바뀌면, 오래된 측정으로 새 작업을 소유하거나 물리적으로
pause하지 않는다. pause 직전에 저장할 위치는 유한한0 이상 값이어야 한다.

이미 허가한 작업의 목표 위치, buffer deadline, release 및 fallback은 같은
lease를 쓴다. 이후 같은 epoch의 일반 표본 선택 변경이 목표를 다시 해석하지
않도록 한다. local wall/monotonic 경과가50ms 넘게 달라지거나 epoch가 바뀌면
lease를 무효화한다. 이중 시계는 불연속 감지 수단이며, 원격 시계가 관측 사이에
바뀌지 않았다는 증명은 아니다. 선택 표본의 나이 연속성 검사는100ms,
짧은 작업 lease의 wall/monotonic 검사는50ms를 쓴다. 따라서 표본 품질이 아직
적격이어도 lease가 보수적으로 작업을 포기할 수 있으며 두 허용치를 같다고 쓰지 않는다.

작업이 실제로 pause한 뒤 lease가 무효화되거나 release 타이머가 허용치 넘게 늦으면,
같은 플레이어·방·곡·명령의 소유권이 남아 있고 재생 의도도 유효한 경우에만
보정 직전 로컬 위치에 단조시각 경과를 더해 복원한다. 이는 자동 보정이 일으킨
중단을 풀기 위한 동작이며, 원래 있던 드리프트까지 고쳤다는 뜻이 아니다.
정상 release와 buffer timeout에서도 provider getter **이후** 소유권과
lease를 다시 검사한다. 새 사용자/호스트 명령은 오래된 복원보다 우선한다.

이 복원은 임의의 iframe 예외, 재생 불가 영상, 곡 끝, 이미 떠난 세션까지
강제로 재생시키는 보장이 아니다. 기존30초 cooldown과 곡 발생 단위 최대3회
자동 보정 예산을 유지하며, 품질 거절을 성공한 보정이나 소모한 시도 횟수로
세지 않는다. 자동 재정렬은 별도의 무한 follow-up 재시도를 만들지 않는다.

## 제한된 로컬 진단

자동 보정의 blocked/admitted/recovery를 기존 Standard flight recorder에
기록한다. 선택 offset·RTT·epoch·표본 나이·U·관측 드리프트·사유가 포함된다.
recovery 기록은 복구 `playVideo()` 요청이 반환됐다는 뜻이며, 실제 PLAYING
상태 도달이나 음성이 다시 나왔다는 확인이 아니다.
건강한 heartbeat마다 새 관측을 남기지 않으며, 같은 곡의 같은 blocked 사유는
20초에 한 번으로 제한한다. 내부 중복 제거는 현재 곡 키 하나와 고정된6개
blocked 사유만 보존하고, 원시 방·peer·queue·video 식별자를 기록에 넘기지 않는다.

기존20분 보존·clock1200개/playback512개 ring, 허용 필드·사유 필터를 사용한다.
서버 업로드, localStorage 영속화, 새 타이머/ping 또는 콘솔 출력 루프를 추가하는
장치가 아니다. 아래 native 비교는 전송·제어 지연과 재생 조작을 관측하며,
CPU/메모리 프로파일링이나 실기 부하 검사를 대신하지 않는다.

## 결정적 검사 근거

실행 환경은 Windows / Node24.13.1 / Vitest5.0.3이다. 저장소 engines의
Node24.20.0과 다르며, 원격 CI나 exact-main release 후보 검사를 대신하지 않는다.
실제 제품 handler·shared-clock 코드와 가상 시각에서 진행하는 fake iframe을
사용했다. 실제 YouTube 공급자·음성 출력·실기 Android/iOS 결과가 아니다.

| 실행 | 결과 | 판독 범위 |
| --- | --- | --- |
| 기존 후보의 release/getter 재진입 반증17개 | 1 pass / 16 fail | 새 명령 우선·무효 lease 복원 계약의 재현. 16개의 서로 다른 운영 사건을 뜻하지 않음 |
| 이전 합산식의 새 정책 요구4개 | 0 pass / 4 expected fail | RTT218에서 실제±300ms, 기본/Android. 새 정책을 요구한 대조이며 역사적 제품 결함 수가 아님 |
| 수정 후 lease handler70개 | 70 pass / 0 fail / 0 skip | 원본29 + release 경계17 + 새 정책4 + admission/비대칭 회복20 |
| 품질·기존 자동 보정72개 | 72 pass / 0 fail / 0 skip | shared-clock 품질10 + YouTube 품질26 + 기존 자동 재정렬36 |
| 로컬 진단17개 | 17 pass, 후속 전체 단위 실행에도 포함 | bounded ring/허용 필드와 사유·중복 제한. 별도 집중 실행은 담당 도구 출력, 전체 실행은 `full-unit-r2.json`에 보존 |
| 테스트 타입·소유 lease 파일 lint/format | pass | `tsconfig.test.json`, ESLint, Prettier. 최종 전체 타입/린트와 구분 |
| 전체 단위 검사 최초 실행 | 13,226 pass / 5 fail / 0 skip | `full-unit.json`. 아래 두 원인을 고친 후 전체 재검사를 진행했다 |
| 최초 실패 두 파일의 수정 후 집중 검사 | 56 pass / 0 fail / 0 skip | `unit-failures-fixed.json`; 기존 assertion을 약화하지 않았다 |
| 전체 타입·린트·포맷 | pass | `typecheck.log`, `lint.log`, `format.log`와 각각 exit=0 |
| 수정 후 전체 단위 재검사 | 13,231 pass / 0 fail / 0 skip | `full-unit-r2.json`, `1aa90b54`의 runtime tree·진단17개 포함. 뒤의 배열 호환 변경 전 실행 |
| 배열 호환 변경 후 집중 검사 | 132 pass / 0 fail / 0 skip | `legacy-compatibility-fix.json`, shared-clock·자동 보정·lease 4파일 |
| 최종 committed build:checked | pass | `fbbc5e1c`, `build-checked-r3.log` / exit=0. 예산·보호 검사 완화 없음 |
| 로컬 production artifact browser | 17 pass / 0 fail / 0 skip | `fbbc5e1c`, `production-candidate-browser.json`, retries=0 |
| 로컬 관련 Chromium E2E | 34 pass / 0 fail / 0 skip | `fbbc5e1c`, 9.0분, `targeted-browser.json`, retries=0. sync·preload·YouTube sync/output-delay/manual-zero-start 5파일 |
| PR Linux CI | 11 jobs success | [39119692353](https://github.com/hiefny/MUSIXQUARE/actions/runs/39119692353), 아래 SHA/환경·skip 구분 참조 |

최초 전체 실행의 실패5개는 원인이 확인됐다. PRO bootstrap 검사1개는 cache를
v724로 올리면서 `index.html`의 bootstrap 참조가v723에 남은 누락이었다.
참조를v724로 맞췄다. zero-start fallback 소유권 검사4개는 시계를 통째로 mock한
기존 fixture가 새 `getClockCorrectionQuality` export를 제공하지 않아 heartbeat
handler가 예외로 반환한 것이었다. 동일한 보정된0-offset 시계를 표현하도록
mock을 완성했고, 재생 위치/상태/소유권의 기대값은 그대로 유지했다.
프로덕션에서 새로 발견한5개의 동기화 결함으로 세지 않으며, 최초 실행을
삭제하거나 통과로 바꾸지 않는다.

첫 committed `build:checked`는 legacy-TV 검사에서 새 품질 getter의
`Array.prototype.at` 사용을 거부했다(`build-checked.log`). 최신 표본 접근을
동일한 배열 인덱스로 바꾸고 집중 검사132개 및 최종 빌드를 통과했다. 구형 브라우저 보호 검사를 완화하거나
polyfill 의존성을 추가하지 않았다.
후속 compatibility 커밋이 최초v724 cache bump보다 뒤에 생겨 두 번째 빌드의
cache-history guard가 이를 거부했다(`build-checked-r2.log`). 최종 cache와
bootstrap 참조를v725로 올려 마지막 runtime 변경 뒤에 배치했다.

위는 실행 묶음별 수치다. 이전 격리 후보의648개, 대조 실패, 후속 전체 suite는
서로 겹치므로 고유 테스트 총수로 합산하지 않는다.

PR CI는 head `fbbc5e1c`의 merge ref
`18b3c4c403e20d014542ea09d3726f3aa089c091`를 Linux / Node24.20.0에서 검사했다.
591개 파일·13,230 pass / 0 fail / 1 skip, production browser17와 critical browser55가
통과했다. skip은 Linux에서 실행할 수 없는 Windows 다른 드라이브 경로 거부 검사다
(`pro-grant-campaign-cli.test.ts`); 같은 로컬 Windows 전체 실행에서는 통과했다.
전체 serial E2E를 다시 돌린 결과가 아니며, PR artifact
[12133068896](https://github.com/hiefny/MUSIXQUARE/actions/runs/39119692353/artifacts/12133068896)는
최종 exact-main 배포 후보를 대신하지 않는다.

최종 runtime diff의 독립 읽기 리뷰 두 건에서 새 P1/P2/P3 지적은 없었다.
[GitHub Codex 자동 리뷰](https://github.com/hiefny/MUSIXQUARE/pull/405)는
`fbbc5e1c`에서 2026-10-18 10:44:56 UTC 완료, findings 없음으로 확인했다.
이 리뷰는 native 결과나 실제 음성 동기화 검증을 대신하지 않는다.

70개에는 실제±300/±1200ms의 정밀 시계 복구, Android250ms 유지,
시계 선택 변경 중 target 고정, epoch/wall 변경·늦은 release의 원래 로컬
타임라인 복원, 새 PAUSE/STOP/seek/leave, admission getter의 시계 교체,
비유한/음수 interrupted position 거부를 포함한다. 추가20개는 수정 이후
처음 실행했으므로 원본 실패를 재현한 검사로 세지 않는다. 품질 부족이
실제 오차를 보류한 뒤 정밀 표본과 두 새 확인으로 복구되는 것도 별도로 검사했다.

가상190초 지속 혼잡 검사는 실제190초 네트워크 측정이 아니다. 품질 gate는
선택 창 만료 이후에도 불확실한 표본을 자동 보정에 쓰지 않는지를 검사하며,
파일 전송의 혼잡·시계 선택·실제 미디어를 함께 보는 native 결과와 구분한다.

로컬 근거 루트는 `scratch/automatic-realignment-candidate-2026-10-18/`다.
scratch는 ignored 로컬 산출물이므로 아래 경로가 원격 저장소에 보존된 것으로
해석하지 않는다.

- `lease-before-evidence.json`: 원본 실패·새 정책 대조의 분류와 SHA.
  `lease-reentrancy-before-r2.json`은17개 선택 검사만 실행했고33개는 이름 필터
  제외다. `lease-policy-before.json`은4개만 실행했고46개는 필터 제외다.
  플랫폼 skip이 아니다.
- 최초 `lease-reentrancy-before.json`도 보존했다. 그 실행의 seek 기대는
  명시적 새 seek에 속한 정상 queued play까지 금지해 과도했다. r2에서 새 명령의
  play 한 번을 허용하고 오래된 두 번째 play만 금지하도록 바로잡았다.
- `lease-reentrancy-before-source.ts`, `lease-reentrancy-before-clock.ts`,
  `lease-reentrancy-before-lease.ts`, `lease-reentrancy-tests-before.ts`:
  원본 대조용 소스·검사 snapshot.
- `lease-after-r1.json` / `.log`, `lease-tested-r1.ts`,
  `lease-validation-r1.json`: 수정 후70개·타입/lint 결과와 검사 snapshot.
  테스트 SHA256은
  `9b90c98a35fe795cfe98f7c403fbc5f824860f4ada10fc957bf55a1c44e16851`,
  결과 JSON SHA256은
  `785782d1c22eb327581b1849fd8996385f298c0f99272494daa0fbc0128fc28b`다.
- `quality-after.json` / `.log`: 품질·기존 자동 보정72개 실행 원본.
- `native-qa-plan.md`: 아래10회 실행 전 계약. 측정 결과 파일이 아니다.

## Native 비교 결과

운영128 기준과 후보를 같은 관측 부하로 비교한다. 실제 제품 signaling/RTC,
파일 전송·시계·자동 handler를 쓰되 YouTube 공급자는 독립적으로 진행하는
통제된 fixture다. 타이밍 관측은 선택된 guest 시계 자체를 정답으로 삼지 않고,
host/guest 단조시각과 실제 미디어 위치로 잔차를 계산한다. 수동 offset과
Android250ms 기대 위치를 포함하며 가청 정확도로 표현하지 않는다.

| 블록 | 실제 실행 순서 | 목적 |
| --- | --- | --- |
| P | B128→Q128 | 무전송4게스트에 실제+300/−300/+1200/−1200ms를 각각 주입하여 진짜 오차 복구 확인 |
| L | Q128→B128 | 2Mbps 느린 수신자를 포함한3게스트·긴 preload,180초 초과 혼잡에서 정렬된 재생 유지 |
| H | B128→Q128 | 고RTT preload 후 실제+300ms 주입, 실제 U로 적격/보류를 나누고 품질 회복 뒤 잔차 확인 |
| D | Q128→B128 | 8→2→8Mbps 변화망에서128 credit과 정렬된 재생을 유지하는지 확인 |
| N | B256→Q256 | 별도 고정256 진단 대조에서 기존 오보정이 실제 재현될 때만 후보의 차단 효과 주장 |

이 순서의10회를2026-10-18 10:53:30.178–11:28:54.654 UTC에 실행했다.
진단 정지를 포함한 벽시각35분24.476초, 순수 case 합34분5.367초다.
Windows11 build26200 / Node24.13.1 / Playwright1.63.0 /
Chromium153.0.8010.12이며 한 조건당1회다. 공식 실행 전 한 게스트+300ms
preflight는 독립 잔차 계산과 주입을 확인하는 용도였고10회에 포함하지 않는다.
별도 역순 반복·분포 또는 통계적 유의성을 주장하지 않는다.

실행기 자체의 기능/재생 판정은9 PASS와 예상한 B256 오보정 재현 대조1 FAIL이다.
이 수치는 아래 독립 paired 전송 예산 판정과 다르며 **전체10회가 모든 기준에서
통과했다는 뜻이 아니다.** 실제 파일24개 모두 SHA·청크 순서·READY·최종 ACK,
누적 확인량≤수신량≤송신량 및 고정 credit 상한 검사를 통과했다.
기준/후보의 전송·storage 소스 바이트는 같고, 관측 패치는 양쪽에 동일하게
적용했다. 256 진단만 고정 credit 상수를 바꾼다. 실제 로드된 lazy asset 해시도
측정 뒤 확인했다.

| 블록 | 기준 B → 후보 Q | 실제 재생·복구 결과 |
| --- | --- | --- |
| P | 각 게스트 한 번의 pause/seek/play | 실제±300/±1200ms 네 오차 모두 약7초 내 복구. Q 마지막 논리 잔차−7.2~−7.1ms, 이후5초 안정·추가 조작 없음 |
| L | 가장 느린 파일193.805→193.804초 | 180초 초과 혼잡에서도 두 버전 모두 조작0회. 느린 게스트 마지막 잔차+2.30→+0.10ms |
| H | 가장 느린 파일65.024→65.303초 | 전송 중 정렬 유지. 전송을 모두 비운 뒤 느린 게스트에+300ms 주입, 양쪽 한 번씩 보정. 후보의 실제 admission과 회복을 아래에서 확인 |
| D | 가장 느린 파일150.140→150.297초 | 8→2→8Mbps 변화 중 양쪽 조작0회, 느린 게스트 마지막 잔차 양쪽+1.60ms |
| N | 가장 느린 파일193.819→193.795초 | B256은 정렬된 재생을 잘못 보정, Q256은 전체 조작0회·마지막 잔차+3.30ms. 빠른 두 수신자의 전송시간 예산은 별도로 실패 |

P의 같은 게스트 회복 표본 시각은 +300ms에서7.412→7.296초,
−300ms에서7.298→7.197초, +1200ms에서7.171→7.060초,
−1200ms에서7.108→7.126초였다. 후보의 최대 증가는18ms로 사전+3초
예산 이내다. 이는1초 표본에서 처음 적격으로 관측된 시각의 차이이며,
회복 시간을18ms 정밀도로 측정했다는 뜻이 아니다.

P는 논리 잔차≤75ms, H는 실제 U와 고정 관측 여유75ms를 구분해 평가한다.
H에서 실제300ms를 주입했다고 자동 적격으로 간주하지 않는다. 품질이 충분하면
고RTT에서도 복구해야 하고, 부족하면 보류와 남은 오차를 기록해야 한다.
150ms 미만 잔차는 기존 동작 기준 아래의 잔차로 수치 그대로 남긴다.
이번 H 후보에서는 관측 드리프트300.5ms / 선택 RTT204ms / U107ms로 실제
admission 한 번이 기록됐다. 따라서 m>2U를 만족했고, 첫 play 이후 독립 잔차는
−2.70ms로 U+75ms인182ms 이내였다. 마지막 잔차는−2.15ms였다.
단순히 나중에 망을 풀었더니 회복된 결과를 고RTT 적격 성공으로 대신하지 않았다.
이 native H는+300ms 한 부호만 검사한다. 반대 부호는 P와 결정적 handler 검사의
범위이며 native 고RTT 양방향 검증으로 쓰지 않는다.

### N: 잘못된 첫 보정의 대조와 별도 성능 실패

B256의 첫 조작1ms 전 native heartbeat snapshot에서 독립 잔차는+4.10ms였다.
가장 가까운 이전1초 periodic 표본의+3.90ms와는 다른 표본이다. 선택 시계
offset−298.5ms / RTT811ms가 섞인 관측에서는 약299ms의 드리프트처럼 보였고,
pause→seek→play 한 번 뒤 실제 잔차가−296.40ms로 커졌다.
기록된 총5개 호출은 완료한 첫 보정3개와 마지막 미완료 pause/seek2개다.
마지막 시도 때는 시계가 offset+2ms / RTT216ms로 회복했고 실제−297.30ms가
남아 있었으므로, 두 번째 시도까지 잘못된 보정으로 분류하지 않는다.

Q256은 전체 측정에서 uncertainty 사유의 제한된 차단 기록7개와 물리적 조작0개가
확인됐다. 차단 표본의 실제 잔차는+2.90~+4.20ms, 마지막 잔차+3.30ms였다.
모두 m≤2U였으며, 같은 추정 시계로 계산한 잔차를 정답으로 쓰지 않았다.
차단 로그는20초 제한이 있어7개가 모든 거절 heartbeat의 개수는 아니다.
compact 결과의 L/D/N 진단 수는 주입 이후만 센 값이므로 전체 로그 수로 쓰지
않았고, 독립 감사는 원본 recorder 전체를 다시 읽었다.

그러나 N의 빠른 두 수신자는 완료시간이 각각3.610→4.111초(+13.88%),
3.502→4.017초(+14.71%)로 늘어 사전10% 예산을 넘었다. 느린 수신자와
파일 무결성이 통과했다고 이 실패를 지우지 않는다. 한 쌍만으로 자동 보정 보호가
약0.5초 증가의 원인이라고 확정할 수 없으며 원인은 미확정이다. N의 전송 성능은
종합 통과가 아니고, 256 확대를 채택하거나 속도·안정성 문제를 모두 해결했다고
판정하지 않는다. 이 대조는 잘못된 보정 차단의 근거로만 사용한다.

### 운영128 전송 보존의 독립 감사

운영 L/H/D의6개 원본·18개 파일을 별도 분석기로 재계산했다. 동일
peer/type/direction의 무전송 median을 빼고, own/room 두 bulk 구간 및 구간 중
송신된 늦은 수신을 포함했다. baseline 최소6개, p95는 양쪽20개 이상일 때만
비교했다. 상대 excess max 증가≤250ms, 적격 p95 증가≤100ms,
raw 제어 지연≤1000ms, 각 수신자 완료시간 증가≤10%의 사전 예산을 유지했다.
105개 중 겹치는 scope를 포함한97개 max 적격·60개 p95 적격 비교가 통과했다.
전체6,744개 application delivery를 다시 짝지어 누락·음수 지연이 없음을
확인했다. 이 숫자들은 독립 실험 횟수가 아니다. 파일 감사는 browser가 계산해
기록한 수신 SHA와 fixture SHA·길이·순서의 일치를 확인한 것이며, 원본 payload
전체를 독립적으로 다시 해시한 것은 아니다. credit/nonce 전체 검증은 실행기의
기능 검사 근거와 구분한다.

| 운영128 블록 | excess max 증가 최댓값 | 적격 p95 증가 최댓값 | 후보 raw 제어 최대 |
| --- | ---: | ---: | ---: |
| L | +9ms | +22ms | 727ms |
| H | +12ms | +9ms | 713ms |
| D | +6ms | +9ms | 595ms |

D를 송신 시각 기준 변화 단계·적용 중 구간·첫8초로 나눈 비교에서도 max 증가
최대+36ms로 통과했다.9개 수신자별 완료시간 비교는 모두 통과했고, 가장 큰
증가는 H의 빠른 guest2에서1.878→1.982초(+5.54%)였다.
비교 불가8행은 무전송 baseline이 없는 preload-ack(중복 scope 포함)다.
정기 sync-ping/sync-pong/youtube-sync의 max 비교는 모두 가능했다.
baseline 없는 그룹이나 표본20개 미만의 p95를 통과로 꾸미지 않는다.
raw 최대치는 실험값이며 실제 망의 지연 상한을 보장하지 않는다.

### 근거 고정과 보존

공식 baseline은b977ca0b /8.11.20-v723, 후보는fbbc5e1c /8.11.21-v725다.
candidate source archive SHA256은
`56045bc95e1126e7aa193ce26021e97145d5ca34d07128490c5087ff6b09e5b8`다.
서버를 띄운 archive와 실제 빌드 metadata의 SHA를 일치시키고, 소스/빌드/설정/
runner3476개 파일을 실행 전에 고정했다. 반복 빌드·사전 검사는 공식 타이밍에
포함하지 않았으며, root/다른 에이전트는 native 실행 동안 CPU 부하 작업을
중단했다. 종료 뒤 소유권을 확인한5개 서버와 관련 프로세스만 정리했다.

로컬 scratch의 원본 JSON10개 합계는542,697,249B이며, 이전 실패·대조·preflight를
모두 남겼다. 아래 manifest는 ignored 로컬 자료에 대한 인덱스이며 GitHub에
원본을 업로드했다는 뜻이 아니다.

- `execution-freeze.json`: SHA256
  `9e59059beb09c062ec750274ab7c42c97a936913d644d30dd4552fdea0e263b7`.
- `matrix-native.json`: SHA256
  `172f95ae0f5a9b9967a1774ee152f793726fa9a8dc67aa7c493e57e737369ff5`.
- `primary-evidence-index.json`: SHA256
  `9f5d3ed3db9a2756d75d20203e1ce728b0819c310f820b1e8f9f3689dfcbc1ea`.
  공식 raw10개·제외 preflight1개와 소형 metadata31개를 연결한다.
- `executor-summary.{json,md}`, `executor-test-matrix.csv`,
  `execution-environment.json`, `owned-server-cleanup.json`: 실행·환경·정리 기록.
- `final-realignment-audit.{py,json,md}`와 manifest: P/H/N·전체 로컬 진단의
  독립 재계산. JSON SHA256
  `380a1abf11a142c195f70c31cc5931ad297617a1dc7cc675170ff0191355359c`.
- `final-transport-audit.{py,json,md}`: 운영128의 수신 metadata·paired 지연·
  완료시간 독립 재계산. JSON SHA256은
  `aa7df5af41d0d08a79efa469af3d32d5564cb7f0f56386dc686a8e5781068dd0`.
- `final-transport-coverage.{py,json}`와 `final-transport-manifest.json`:
  전체 관측 matching 및 N256 완료시간 예산 위반을 별도 보존한다.
  coverage JSON SHA256은
  `b44314e3b25abe18fbac4f7247972fc59087b1ad3b222fd91cc589dc3efbb816`.
  N의 상대 latency 예산까지 독립 통과 판정한 자료는 아니다.

## 남은 범위와 승격 조건

이번 후보는 명시적 PLAY/PAUSE/STOP/seek·수동 Sync·기존 상태 복구·3초 초과
coarse seek·PRO 정책을 이 품질 gate로 막지 않는다. 주변 공통 함수를 사용하므로
이 경로의 회귀 검사는 여전히 필요하다. 파일 전송64/64/128 유지와 수동/PRO
비영향은 소스 비교·관련 검사로 확인하고, 아직 실행하지 않은 범위를 완료로 쓰지 않는다.

실제 공급자의 광고/버퍼링, 원격 시계 변화, 시스템 sleep/resume의 플랫폼별
단조시각 동작, 실기 Android/iOS·모바일 백그라운드, 실제 음성 정렬과 기기 부하는
열린 항목이다. 품질이 지속적으로 낮으면 진짜 중간 크기 오차의 보류가 길어질 수
있다. 별도 clock repair나 quiet bulk probe는 구현하지 않았다.

제품 후보의 범위는64/64/128을 그대로 둔 자동 보정 안전성에 한정한다.
그 범위의 회귀와 native 보존·복구 검사는 통과했고, 256 진단의 재생 보호 효과와
별도 성능 예산 실패는 모두 남긴다. 고RTT23MB 전송이 여전히 약65초 걸리는
처리량 문제는 해결하지 않았다. 일반 활성 파일 전송의 새 처리량 행렬도 실행하지
않았으며, 전송 소스 불변과 기존 회귀 검사를 새 네트워크 측정으로 표현하지 않는다.
N에도 원래 all-peer10% 기준이 적용됐으므로, 이번 전체 사전 계약을 통과한 것은
아니다. 독립 검토 후 운영128로 한정해 빌드 후보를 남기는 범위 결정이며,
N의 성능 gate를 소급 면제하거나 원인 미확정 편차를 해결한 것으로 쓰지 않는다.
**진단 N의 성능 기준 미충족을 남긴 배포 전 후보**이지 전체 all-green 또는
배포 준비 완료 판정은 아니다.
병합 후 별도의 exact-main CI가 성공하면 그 SHA의 불변 빌드 후보를 확보한다.
그 성공도 위 진단 성능 실패를 닫거나 별도의 배포 판단을 대신하지 않는다.
프로덕션 배포, 운영 smoke, release ownership 확인을 수행했다고 주장하지 않는다.
