# 전송 중 비대칭 시계 표본에 대한 일반방 재생 보호

- Date: 2026-10-19 KST.
- Status: 구현과 결정적 단위 검사 완료. native 하네스는 실행하지 않았다. 통합
  라운드에서 다른 조각과 함께 직렬로 실행한다. **배포하지 않았다.**
- Base: main `deb52829930d0b8a4b87e70b05f84aa7c242c799`. 검사한 코드:
  `14a4a90780624eb95bb5c550614dd2dde7fb91c6`, 브랜치 `claude/clock-transfer-guard-f3d4c6`.
  이 보고서를 담은 다음 커밋은 문서만 바꾼다.
- 버전: App 8.11.21 / cache v725 그대로다. 버전과 캐시는 통합에서 한 번만 올린다.
- 범위: 2026-10-19 오너 계획의 일반방 통합 릴리스 네 조각(PR #410 제어 연결 분리,
  delay-based receipt window, 시계 보호, 보조 연결 ICE restart) 가운데 시계 보호다.
  `src/network/transport/**`, `src/player/playback.ts`, `src/player/playlist.ts`,
  `src/youtube/player.ts`, `docs/release-record.md`는 바꾸지 않았다.
- Related: [#405 자동 재정렬 시계 안전성](automatic-realignment-clock-safety-2026-10-18.md),
  [제어 연결 분리 실험](control-association-isolation-2026-10-19.md),
  [운영 상태](../release-record.md).

## 결합 경로

전송 속도와 동기화의 실제 결합은 제어 지연이 아니라 긴 전송 중의 비대칭 시계 표본이다.

1. 게스트는 1초마다 `SYNC_PING`을 보낸다. 호스트가 그 게스트에게 파일을 보내는 동안
   `SYNC_PONG`은 파일 데이터 뒤에 줄을 서지만 ping은 그렇지 않다. 중간점 offset은 두
   방향 지연이 같다고 가정하므로, 응답만 E ms 더 늦으면 그 표본은 호스트 시계를 약
   E/2 늦게 추정한다.
2. 선택은 최대 60개·120초 표본 중 최소 RTT였고, 용량을 넘으면 가장 오래된 표본을
   지웠다. 1 Hz에서 연속 전송이 약 60초 이어지면 조용한 표본이 모두 밀려나고 혼잡한
   표본의 최솟값이 선택된다.
3. YouTube 자동 재정렬은 #405의 품질 gate가 막지만, 로컬 파일 soft resync(같은 방향
   50 ms 이상 3회)는 gate 없이 이 치우침을 실제 드리프트로 보고 소스를 재시작했다.
4. preserveClock 없는 `sync:force-resync`(수동 Sync, 로컬 출력 재합류, 같은 곡 0초 재생)는
   모든 표본을 지우고 다음 응답 하나로 다시 고정했다. 전송 중이면 그 응답이 혼잡할 수 있다.

아래 새 검사 26개 가운데 16개가 base 소스에서 이 경로를 재현한다.

## 변경

### 1. 표본 보존 (`src/network/shared-clock.ts`)

용량을 넘으면 RTT가 가장 큰 표본(같으면 가장 오래된 것)을 지우고, 가장 최근 응답은
지우지 않는다. 그래서 120초 나이 창 안의 최소 RTT 표본은 나이 제한에 걸릴 때까지 남아
계속 선택된다. 이전에는 최근 60개, 즉 1 Hz에서 약 60초 안의 최소였다. 최근 응답을 남기는
이유는 품질 판단의 응답 신선도(5초)와 진단의 `newestSampleAgeMs`가 계속 실제 마지막
응답을 뜻하게 하기 위해서다.

120초 나이 제한, 60개 상한, 2초+불확실성 clock-step flush, 로컬 시계 rebase, epoch,
`getClockCorrectionQuality`의 의미는 그대로다.

대가는 코드 주석에도 남겼다. 선택 offset의 나이 상한이 약 60초에서 120초로 늘어 기기 간
시계 drift가 최대 두 배 쌓인다(합계 100 ppm이면 약 12 ms). 감지되지 않은 2초 미만 호스트
시계 step을 최소 RTT 선택이 붙잡는 시간도 최대 120초로 늘어난다. 둘 다 기존 120초 제한이
상한이다. 선택 표본이 용량 때문에 사라지는 일이 없어졌으므로 clock-selection 사유
`capacity`는 더 이상 생기지 않는다. 진단 허용 목록의 항목은 남겼다.

#405 문서의 "120초 동안 좋은 표본을 붙잡는 retention 정책은 추가하지 않는다"는 결정은
이번 오너 계획으로 바뀌었다. 과거 문서는 고치지 않는다.

### 2. 로컬 파일 soft resync 허가 (`src/network/sync.ts`)

YouTube 자동 재정렬과 같은 허가를 쓴다. 품질이 eligible이고 관측 드리프트 |m|이 2U보다
커야 한다. U는 선택 RTT/2 + 5 ms다. 기존 50 ms 기준, 같은 방향 3회 확인, 10초 cooldown은
그대로다. 허가되지 않은 표본은 YouTube heartbeat streak처럼 같은 방향 확인을 처음부터
다시 시작하고, `sync:diagnostic-standard-decision`에 `decision: 'skipped'`와
`reason: 'clock-uncertainty'` 또는 `clock-<품질 사유>`(예: `clock-discontinuity`)로 기대·로컬
위치와 함께 남는다.

- 혼잡 표본만 남으면 그 치우침은 최대 RTT/2, 즉 U − 5 ms라서 2U를 넘지 못한다. 치우침만으로는
  soft 교정이 허가되지 않는다.
- 조용한 LAN: RTT 40 ms 이하면 2U ≤ 50 ms라서 50 ms를 넘는 드리프트는 이전처럼 교정된다.
  RTT 40 ms에서 정확히 50 ms인 경계값만 달라진다. RTT 40~90 ms에서는 50 ms 이상 2U 이하
  구간을 보류한다.
- 2초 hard resync, initial 재고정, bootstrap은 바꾸지 않았다. 시계 오차만으로 hard resync가
  나려면 선택 RTT가 약 4초 이상이어야 하고(응답 만료 5초), 120초 안의 모든 응답이 그래야
  한다. 바꿀 구체적 근거는 찾지 못했다.
- YouTube 확인은 같은 epoch·offset을 이어서 요구하지만, 로컬 파일은 표본마다 허가한다.
  교정은 세 번째 표본의 측정만 쓰므로 그 표본의 허가가 이 모델의 잔차 상한을 보장한다.

### 3. 재고정 경로 (`src/network/shared-clock.ts`)

preserveClock 없는 force-resync는 이전처럼 즉시 cold가 된다(`isClockCalibrated()` false,
표본 0). 다만 표본을 버리지 않고 따로 둔다. 받아들여진 첫 응답이 따로 둔 표본을 확인하면
되돌린다. 조건은 각 표본이 120초 안이고 wall/monotonic 경과 차이가 100 ms 이하이며, 새 응답과
따로 둔 최소 RTT 표본의 중간점 구간이 겹치는 것이다. 즉 |Δoffset| ≤ (r_new + r_best)/2 + 5 ms로,
선택 진단과 같은 비교다. 되돌리면 clock-selection 사유 `restore`를 남긴다. epoch은 reset 때
이미 올라갔고 restore는 더 올리지 않는다.

- 전송 중 혼잡한 첫 응답은 구간이 넓어 확인을 통과하므로 재고정은 조용한 시계로 계산된다.
- 정밀한 새 응답이 이전 시계를 반증하거나(호스트 시계 step), 로컬 wall step이 관측되거나,
  따로 둔 표본이 120초를 넘었거나, `resetClockState`(호스트 연결 교체·세션 종료)가 오면
  이전처럼 cold로 시작한다. 이때 그 응답은 새 시계의 첫 표본이 된다.
- post-PLAY initial 재고정(`sync:arm-initial` 1초 뒤 첫 응답)은 시계를 지우지 않으므로 1번
  덕분에 120초 안에서는 조용한 시계를 쓴다. 같은 곡 0초 재생의 재고정은 force-resync라서
  위 경로를 탄다.

## 결정적 검사

환경은 Windows 11 Pro 10.0.26200, Node 24.13.1(저장소 engines 24.20.0과 다름), npm 11.8.0,
Vitest 5.0.3이다. 로컬 검사이며 원격 CI나 exact-main 후보를 대신하지 않는다. 제품
shared-clock과 sync handler를 가상 시각에서 직접 구동했고, 호스트 시계·호스트 미디어
위치·게스트 오디오 위치를 따로 모델링했다. 전송 지연은 한 방향만 250~700 ms를 기다리는
고정 규칙이다. 실제 브라우저·RTC·SCTP·음성 출력은 쓰지 않았다. 같은 PC에서 다른 두
세션이 작업 중이었다.

| 실행 | 결과 | 판독 |
| --- | --- | --- |
| 새 검사 26개, base 소스 | 10 pass / 16 fail / 0 skip | 16개는 결함 재현. 10개는 보존할 동작의 대조(호스트 step flush, cold 시작 4종, 조용한 LAN 교정 4종, 호스트 step 뒤 수동 Sync) |
| 새 검사 26개, 후보 | 26 pass / 0 fail / 0 skip | 아래 (a)~(c) |
| 기존 관련 9파일 첫 실행 | 290 pass / 4 fail / 0 skip | 4건 모두 용량 퇴출로 좋은 표본을 없애던 시나리오, 아래 (d) |
| 시나리오를 고친 4파일 | 132 pass / 0 fail / 0 skip | 단언 유지 |
| 전체 단위 1회차(타입·린트·포맷 동시 실행) | 593 files, 13,254 pass / 3 fail / 0 skip | 실패 3건은 30 s·15 s timeout과 workerd `fetch failed` |
| 전체 단위 2회차, `14a4a907` | 593 files, 13,249 pass / 8 fail / 0 skip | 1회차와 다른 8건, 15~30 s timeout(실제 workerd burst 2, 전송 재개 4, YouTube zero-start 2) |
| 두 회차 실패 파일 7개 재실행 | 1회차 3파일 555 pass / 1 fail, 2회차 4파일 183 pass / 0 fail | 남은 1건(release-deployment-state, git 다수 실행)은 그 검사만 단독으로 16.5 s pass |
| 전체 단위 3회차, `14a4a907`, 6 workers | 593 files, 13,257 pass / 0 fail / 0 skip | 926.5 s. 부하를 줄인 단일 실행에서 전부 통과 |
| typecheck / lint / format:check | pass / pass / pass | 각 exit 0 |
| `build:checked`, `14a4a907` | `guard:sw-cache-version` 거부(exit 1) | 지시대로 캐시를 올리지 않아 생기는 예상 거부 |
| 그 뒤 단계 12개 개별 실행 | 모두 exit 0 | build, legacy-TV build, 서비스 워커·UI kit build, 초기 전송 예산, prod hooks·security, font, app shell |

`build:checked`는 `[sw-cache-version] FAIL: committed PWA runtime changes are newer than v725
(ac354035)`에서 멈췄다. 그 앞의 guard는 모두 통과했다. 통합에서 App 버전과 cache를 한 번
올리면 이 guard가 다시 판정한다.

### (a) 100초 전송 중 offset 치우침

`shared-clock-transfer-retention.test.ts`. 조용한 10초(RTT 8 ms) 뒤 100초 동안 응답 또는
ping만 250~700 ms 기다렸다. 대기 표본 하나하나는 125~350 ms 치우쳤지만 선택 offset 오차는
0 ms였고(상한 4 ms), U는 9 ms, 품질은 계속 fresh였다. base는 같은 시나리오의 약 60초
지점에서 선택이 −125 ms(ping 대기는 +125 ms)로 바뀌어 실패했다. 130초까지 이으면 마지막
조용한 표본이 120초가 되는 순간(120.385초 뒤)에만 대기 표본으로 넘어가고, 그때 U(134 ms
이상)가 드러난다. base는 60.475초 뒤에 넘어갔다.

### (b) soft resync 보류와 조용한 시계 교정

`sync-transfer-clock-guard.test.ts`는 실제 `SYNC_PING`/`SYNC_PONG`과 `handleSyncPong`을 거친다.

- 정렬된 로컬 파일 재생 중 다음 파일이 100초 전송될 때(pong 대기, ping 대기 각각) 교정 0회,
  결정 100개 모두 observe였다. base는 soft 교정 1회.
- 150초 전송: 120초 뒤 대기 표본만 남은 구간은 `clock-uncertainty`로 보류, 교정 0회. 전송
  뒤 조용한 응답으로 정확한 시계가 돌아와도 교정이 없었다. base는 soft 교정.
- 전송 70초 지점에 넣은 실제 −120 ms 드리프트는 세 번째 표본에서 교정, 잔차 0.5 ms 미만.
- 조용한 LAN RTT 4/10/20/40 ms에서 실제 51 ms 드리프트는 세 번째 표본에서 교정(base와 같음).
- RTT 110 ms(2U = 120 ms): 118 ms는 4회 모두 보류, 122 ms는 교정. 보류된 표본은 같은 방향
  확인을 다시 시작했다.
- 105 ms 로컬 wall step이 rebase로 해소되지 않은 동안 `clock-discontinuity`로 보류했다. base는
  이 시계 착시로 105 ms 교정을 했다.

### (c) 전송 중 수동 Sync와 post-PLAY 재고정

- 전송 30초 지점 수동 Sync, 강제 ping의 응답이 600 ms 대기: 재고정 잔차 0.5 ms 미만,
  `restore` 1회. base는 300 ms 어긋난 위치로 재고정했다.
- 전송 70초 지점 post-PLAY initial 재고정: 잔차 0.5 ms 미만. base는 그 전에 soft 교정이 났다.
- 호스트 시계 300 ms step 뒤 정밀 응답으로 수동 Sync: cold로 시작, 잔차 0.5 ms 미만(base와 같음).

### (d) 기존 검사

기존 3파일 4건이 가장 오래된 표본부터 지우는 순서로 좋은 표본을 없애는 시나리오였다. 오너
계획 1번이 바로 그 순서를 바꾸므로, 좋은 표본이 용량 대신 120초 나이로 빠지게 시나리오만
바꾸고 단언은 그대로 두었다.

- `shared-clock.test.ts`: 선택 표본의 `capacity` 진단 기록 검사가 정밀 표본이 용량 초과를
  버틴 뒤 120초에 `expired`로 바뀌는 검사가 되었다. 선택 표본의 용량 퇴출 자체가 없어졌으므로
  이 한 건은 의미가 바뀐다.
- `shared-clock-correction-quality.test.ts`: 좋은 표본이 사라진 뒤 불확실성을 숨기지 않는다는
  검사. 60개 시점의 좋은 표본 유지를 추가로 확인하고, 150개(120초) 뒤 기존 단언을 확인한다.
- `standard-realign-clock-lease.test.ts`: 선택 표본이 ±200 ms 바뀌어도 정렬된 재생을 건드리지
  않는다는 검사. 대기 표본을 60개에서 300개(약 121초)로 늘렸다.
- `standard-realign-clock-quality.test.ts`: 주석만 정정했다.

나머지 sync, #405의 YouTube 품질·lease·자동 재정렬(70 + 72), clock-step 재생, flight recorder
검사는 수정 없이 통과했다. force-resync 직후 cold를 확인하는 기존
`drops stale shared-clock samples before forced resync ping`도 그대로 통과한다.

## 남은 한계

- 단위 모델 검사다. 실제 망의 지연 분포, PR #410의 별도 제어 연결과의 조합, 실기기 시계
  drift, 음성 출력은 검증하지 않았다.
- 120초를 넘는 전송에서는 선택이 대기 표본으로 넘어가고 soft 교정은 보류된다. 그 사이 2U
  이하의 실제 드리프트는 조용한 응답이 돌아올 때까지 남는다. YouTube와 같은 한계다.
- 전송 중 입장·재접속처럼 조용한 기준이 없는 cold 시작은 첫 고정이 치우칠 수 있다. 조용한
  응답이 돌아오면 실제 오차를 한 번 교정한다.
- 혼잡한 첫 응답은 구간이 넓어서, 그 사이 2초 미만 호스트 시계 step이 있었다면 이전 시계로
  되돌릴 수 있다. 그 오차는 최소 RTT 선택의 기존 한계처럼 이전 표본이 120초에 만료될 때까지
  남는다.
- hard resync는 gate 밖이다(위 근거).
- 기본 병렬도의 전체 단위 실행 두 번은 공유 PC 부하로 서로 다른 timeout이 났다. 실패한 검사는
  단독 실행에서 모두 통과했고 6 workers 실행은 전부 통과했지만, 원격 CI가 다시 판정해야 한다.

## 통합 라운드에 추가할 native 시나리오

직렬 통합 라운드의 기존 게이트(재생 잔차와 원치 않는 교정 0회, 제어 최대 1,000 ms, 기존
속도 규칙)에 아래를 더한다.

1. 느린 2 Mbps 프로필과 고RTT 프로필 각각에서, 게스트가 로컬 파일 A를 재생하는 동안 다음
   로컬 파일 B가 그 게스트에게 프리로드된다. 전체 프리로드 구간을 보며 드리프트는 넣지 않는다.
2. `sync:diagnostic-standard-decision`을 결정별로 센다. `soft`, `hard`, `initial`, `bootstrap`,
   그리고 `skipped` 중 `clock-` 사유를 따로 센다. 게이트는 프리로드 동안 soft 0, hard 0,
   재생 잔차는 기존 게이트 안이다. clock-selection 사유 `expired`와 `restore`도 남긴다.
3. 가능하면 같은 프리로드 중 수동 Sync를 한 번 눌러 `initial` 1회, `restore` 1회와 그 뒤
   잔차를 확인한다. 2 Mbps에서 프리로드가 120초를 넘으면 `clock-uncertainty` 보류 경로도
   관측된다.

## 로컬 근거

저장소 밖 로컬 자료이며 원격에 보존되지 않는다. 이 세션 묶음의 노트 폴더 아래
`clock-transfer-guard-2026-10-19/`에 실행 결과 JSON과 로그를 두었다.

| 파일 | 내용 | SHA256 |
| --- | --- | --- |
| `before-new-tests.json` | base 소스로 돌린 새 검사 26개 | `6da3dff3a3ac85f488e39f979ba8ac2a0c85391037187b7f95db590217ccc52b` |
| `full-unit.json` | 전체 단위 1회차 | `29f5c429294c38e478f2bc87addd8af6654c9acc902c464cbe5167ab3e29a7ec` |
| `full-unit-r2.json` | 전체 단위 2회차, `14a4a907` | `1a10e261012818d6d54293613de63e514cf570a08f970df55ec8bec6ef17a571` |
| `full-unit-r3.json` | 전체 단위 3회차, `14a4a907`, 6 workers | `918c27e552b29d1638e07b5e0c17bdf8bb53771735e940cd5bea89ae2fce7939` |
| `rerun-three.json` | 1회차 실패 3파일 재실행 | `e1af1e62b852af3e68817e36d50eb3ce37eaa9dc07474a8915c2f5f97cfb4a64` |
| `rerun-release-alone.json` | release-deployment-state 1건 단독 | `7c7c266a66c541a3436029f8e4b609698a11741537fd660ad505b3066a35c02e` |
| `rerun-r2-a.json` | 2회차 실패 중 전송 재개·YouTube player 2파일 | `8a79b02247e631756886963cc1454c0ed755151476664af68c9f5de1ab510532` |
| `rerun-r2-b.json` | 2회차 실패 중 실제 workerd burst 2파일 | `8c7a29838300a6fc48940f3c8d2f093e93defac1b333609115b617da3b5d1dee` |
| `build-checked.log` | `build:checked` 전체 출력 | `35473e332495ad8cf49366ddaf3328f9373d9527963c034a7e830124ac94885c` |
| `build-rest-summary.log` | cache guard 뒤 12단계 exit 코드 | `f4255fc5203de307f9e440acd53059d0f4edcb2e9f54fb0c3d17e84b185d7d16` |

타입·린트·포맷 로그(`typecheck.log`, `lint.log`, `format.log`)와 `build-rest.log`도 같은 폴더에 있다.
