# 일반방 YouTube 자동 재정렬의 시계 안전성 후보

- Date: 2026-10-18 KST.
- Status: 제품 빌드 후보 구현·집중 검사 진행 중. 최종 커밋, 전체 회귀,
  빌드 및 native 비교 결과는 아직 확정하지 않았다. **배포하지 않았다.**
- Base: `b977ca0bf2ecc8f5148af9eb6653a88a9c537a2e`, 작업 브랜치
  `agent/automatic-realignment-clock-safety`의 미커밋 변경을 검사했다.
  아래 검사 결과를 base 자체의 결과나 exact-main CI로 해석하지 않는다.
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
시계 편향100ms가 관측 크기를200ms로 줄이면, RTT204ms의 U107ms 아래에서는
보류한다. 이는 성공적인 동기화가 아니다. 해당 잔차와 보류 시간을 남겨야 한다.
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
장치가 아니다. 실제 브라우저에서의 추가 CPU/메모리 비용은 아래 native 검사의
관측 대상이며 아직 측정 완료로 주장하지 않는다.

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
| 로컬 진단17개 | 17 pass, 독립 담당 실행 보고 | bounded ring/허용 필드와 사유·중복 제한. 별도 원본 로그 위치 미확정, 최종 전체 실행 원본으로 루트가 보완 |
| 테스트 타입·소유 lease 파일 lint/format | pass | `tsconfig.test.json`, ESLint, Prettier. 최종 전체 타입/린트와 구분 |
| 전체 단위 검사 최초 실행 | 13,226 pass / 5 fail / 0 skip | `full-unit.json`. 아래 두 원인을 고친 후 전체 재검사를 진행했다 |
| 최초 실패 두 파일의 수정 후 집중 검사 | pass | `unit-failures-fixed.json`; 기존 assertion을 약화하지 않았다 |
| 전체 타입·린트·포맷 | pass | `typecheck.log`, `lint.log`, `format.log`와 각각 exit=0 |
| 수정 후 전체 단위 재검사 | 13,231 pass / 0 fail / 0 skip | `full-unit-r2.json`, 최종 runtime 및 진단17개 포함 |

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
동일한 배열 인덱스로 바꾸고 다시 검사한다. 구형 브라우저 보호 검사를 완화하거나
polyfill 의존성을 추가하지 않았다.
후속 compatibility 커밋이 최초v724 cache bump보다 뒤에 생겨 두 번째 빌드의
cache-history guard가 이를 거부했다(`build-checked-r2.log`). 최종 cache와
bootstrap 참조를v725로 올려 마지막 runtime 변경 뒤에 배치했다.

위는 실행 묶음별 수치다. 이전 격리 후보의648개, 대조 실패, 후속 전체 suite는
서로 겹치므로 고유 테스트 총수로 합산하지 않는다. 최종 커밋 기준 전체 회귀
총수·환경·pass/fail/skip은 루트의 완료 기록으로 보완한다.

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

## Native 비교 계획 — 아직 결과 아님

운영128 기준과 후보를 같은 관측 부하로 비교한다. 실제 제품 signaling/RTC,
파일 전송·시계·자동 handler를 쓰되 YouTube 공급자는 독립적으로 진행하는
통제된 fixture다. 타이밍 관측은 선택된 guest 시계 자체를 정답으로 삼지 않고,
host/guest 단조시각과 실제 미디어 위치로 잔차를 계산한다. 수동 offset과
Android250ms 기대 위치를 포함하며 가청 정확도로 표현하지 않는다.

| 블록 | 예정 비교 | 목적 |
| --- | --- | --- |
| P | B128→Q128 | 무전송4게스트에 실제+300/−300/+1200/−1200ms를 각각 주입하여 진짜 오차 복구 확인 |
| L | Q128→B128 | 2Mbps 느린 수신자를 포함한3게스트·긴 preload,180초 초과 혼잡에서 정렬된 재생 유지 |
| H | B128→Q128 | 고RTT preload 후 실제+300ms 주입, 실제 U로 적격/보류를 나누고 품질 회복 뒤 잔차 확인 |
| D | Q128→B128 | 8→2→8Mbps 변화망에서128 credit과 정렬된 재생을 유지하는지 확인 |
| N | B256→Q256 | 별도 고정256 진단 대조에서 기존 오보정이 실제 재현될 때만 후보의 차단 효과 주장 |

총10회 계획이며 아직 통과/실행 완료 수치가 아니다. N의256은 원인 분석용
실패 재현용 대조이고 제품 기본값 후보가 아니다. B256에서 오보정이 없으면 coverage
미확보로 남기며, 몰래 재실행하거나 운영128 결함의 증거로 쓰지 않는다.
사전 제외 preflight, 파일 SHA/순서/최종 ACK·credit, 동일 peer/type/direction의
제어 지연, phase별 변화망과 늦게 도착한 메시지 보존 기준은 계획 파일에 있다.

P는 논리 잔차≤75ms, H는 실제 U와 고정 관측 여유75ms를 구분해 평가한다.
H에서 실제300ms를 주입했다고 자동 적격으로 간주하지 않는다. 품질이 충분하면
고RTT에서도 복구해야 하고, 부족하면 보류와 남은 오차를 기록해야 한다.
150ms 미만 잔차는 기존 동작 기준 아래의 잔차로 수치 그대로 남긴다.
모든 native 결과·최종 source/build/runner hash와 원격 CI 상태는 후속 기록 대상이다.

## 남은 범위와 승격 조건

이번 후보는 명시적 PLAY/PAUSE/STOP/seek·수동 Sync·기존 상태 복구·3초 초과
coarse seek·PRO 정책을 이 품질 gate로 막지 않는다. 주변 공통 함수를 사용하므로
이 경로의 회귀 검사는 여전히 필요하다. 파일 전송64/64/128 유지와 수동/PRO
비영향은 소스 비교·관련 검사로 확인하고, 아직 실행하지 않은 범위를 완료로 쓰지 않는다.

실제 공급자의 광고/버퍼링, 원격 시계 변화, 시스템 sleep/resume의 플랫폼별
단조시각 동작, 실기 Android/iOS·모바일 백그라운드, 실제 음성 정렬과 기기 부하는
열린 항목이다. 품질이 지속적으로 낮으면 진짜 중간 크기 오차의 보류가 길어질 수
있다. 별도 clock repair나 quiet bulk probe는 구현하지 않았다.

최종 후보 커밋·전체 회귀·로컬/원격 환경 차이·빌드 검사와 승인된 native 결과를
확정한 뒤 제품 채택 여부를 판단한다. 현재 문서는 해당 검토의 중간 근거다.
프로덕션 배포, 운영 smoke, release ownership 확인을 수행했다고 주장하지 않는다.
