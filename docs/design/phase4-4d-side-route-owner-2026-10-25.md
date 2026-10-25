# Phase 4 4D 배포 묶음: 보조 경로의 끊김 기한도 연결 생존 주인으로 (2026-10-25)

| 항목      | 범위                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 기준      | origin/main `a8dfd2ac`(4C 기록 #490. 런타임은 운영 9.0.10 / v783의 배포 SHA `2038b51f`와 같고, 그 뒤로는 문서만 바뀌었다). 브랜치를 자른 뒤 origin/main에 #491 `f91c538e`(문서만, #18 은퇴 기록)가 들어왔고, 보고서 커밋 뒤 `b7927afb`에서 합쳤다(문서만, 아래 QA 라운드 3).                                                                                                                                             |
| 4D 묶음   | 브랜치 `agent/phase4-4d`. D0 테스트 먼저 `ea6a5781`과 그 리뷰 반영 `72cdce0d`(테스트만), D1 C5-9 코드 `d5c66b9a`, D2 C5-10의 제어 격리 부분 `b385fad0`(가드, 테스트, 문서), 그 위에 이 보고서와 기록 커밋 `00aacf99`(문서만), #491 합침 `b7927afb`(문서만), 리뷰 반영 `6c69651b`(타입, 테스트)와 그 문서 커밋 `45653ac0`, 마지막 런타임 커밋인 bump `cf555b01`가 있다. bump 뒤 커밋은 이 보고서·기록·문서 색인만 바꾼다. |
| 상태      | 배포 전. 마지막 런타임 커밋 `cf555b01`에서 SemVer와 SW 캐시 epoch를 올렸고 bump 뒤 로컬 검증(아래 QA 라운드 4)을 마쳤다. PR CI, Codex, exact-main CI, 릴리스 smoke, 배포가 남았다. 오너 결정(2026-10-25 약 01:50 KST)대로 자동 게이트가 통과하면 따로 묻지 않고 낸다.                                                                                                                                                    |
| 현재 증분 | 보조(격리 제어) 경로 PC의 끊김 기한을 `ControlIsolation`에서 `LinkLiveness`로 옮긴다(C5-9, 중립). 끊김당 15초, 원래 경로가 끊긴 동안 미룸, 원래 경로 회복 뒤 15초로 다시 걸되 끊김 시작에서 30초 상한, 재시작할 수 없는 경로의 15초 유예가 모두 주인에게 간다. 제어 격리는 재시작 통신(시도, 창, epoch, 후보, fence, READY)만 갖고, 정적 ratchet이 옛 기한 이름 여덟을 막는다(C5-10의 제어 격리 부분).                   |
| 제품 식별 | `9.0.11` / `v784`(bump `cf555b01`, 운영은 `9.0.10` / `v783`). 올리기 직전 fetch한 origin/main은 `f91c538e`(#491, 이미 `b7927afb`에서 합침) 그대로라 다시 합칠 것이 없었다(아래 9.0.11 / v784).                                                                                                                                                                                                                           |
| 배포 대상 | 예정 target `app`, Developer API D1 `false`. 4D는 App 런타임 네 파일(`src/network/transport/`의 `control-isolation.ts`, `link-liveness.ts`, `cloudflare-signaling.ts`, `types.ts`)과 가드·테스트 설정(`scripts/check-transport-health.mts`, `vitest.critical.config.ts`)만 바꾼다. `cloudflare/`에서는 bump가 4A~4C와 같은 자리인 App Worker의 `ADMIN_ASSET_VERSION` 문자열 하나만 바꾼다.                               |
| 환경      | Windows 11 로컬, Node 24.20.0 / npm 12.0.2. 단위는 jsdom과 가짜 WebRTC다. bump 뒤에는 Playwright 1.63.0 헤드리스 Chromium으로 critical E2E와 C5-0 랩(로컬 signaling Worker와 실제 WebRTC)도 돌렸다(라운드 4). 실제 기기와 WebKit은 아직 4D 코드로 돌리지 않았다.                                                                                                                                                         |
| 운영      | 없음(배포 전).                                                                                                                                                                                                                                                                                                                                                                                                           |

이 문서는 구조 개선 Phase 4의 네 번째 앱 배포(4D)에 실리는 증분과 QA를 기록한다. 4C는 원래 경로의
유예, 재시작 문, 복귀 확인, 링크의 모든 닫힘을 `LinkLiveness` 하나로 모았고, 보조 경로의 끊김 기한은
제어 격리에 남긴 채 주인이 원래 경로의 변화를 알려 주기만 했다(registry RO-35,
[4C 보고서](phase4-4c-link-liveness-2026-10-25.md)). 4D는 그 자원에 남은 마지막 두 번째 기계를 주인으로
옮긴다. 동작을 바꾸지 않는 이동이라 테스트 커밋을 먼저 두었고, 그 테스트는 바꾸기 전 9.0.10 코드에서
통과한다. 증분마다 커밋, 검증한 코드 SHA, 환경, PASS/FAIL/SKIP과 한계를 적는다.

## 오너 결정

- **2026-10-24 약 15:20 KST(P4-D6 A):** C5-9는 Phase 4 밖이다. 보조 경로의 기한은 제어 격리에 남기는
  예외로 두고 #18이 은퇴하면 다시 본다고 적었다(registry RO-35).
- **2026-10-25 약 01:50 KST, 배포 시점과 기기 게이트:** 모든 열차는 자동 게이트(로컬 검사, 리뷰, PR CI,
  Codex, exact-main CI, 릴리스 smoke)가 통과하면 바로 내고, 기기 근거는 코드의 게이트가 아니다(4C
  보고서의 [오너 결정](phase4-4c-link-liveness-2026-10-25.md#오너-결정)). 4D도 그대로 따른다.
- **2026-10-25, #18 은퇴(PR #491, `f91c538e`):** 오너의 와이파이→LTE 실기기 확인으로 허용 위험 #18이
  은퇴했다(아래 선행 조건). 그 기록은 #18 은퇴만으로 C5-9를 일정에 올리지 않는다고 적었다(결함이
  나오지 않으면 하지 않음, P4-D6 A).
- **2026-10-25 약 16:30 KST, C5-9를 4D로:** 오너는 C5-9를 묶어서 해 보자고 했다. 네트워크 변경은 특수한
  경우라 사용자가 알아채더라도 이해할 것이고, 코드로는 위험이 높지만 쓰는 데는 위험이 높지 않다는
  판단이다. 그래서 C5-9와 그 ratchet(C5-10의 제어 격리 부분)이 4D로 나가고, Phase 4의 앱 업데이트는
  4D까지 네 번이 된다.
- **되돌리기 계획(같은 결정에서 미리 정함):** 오너가 나중에 4D를 기기로 확인해 제대로 나오지 않으면
  9.0.10의 보조 경로 동작으로 돌아가는 forward revert를 낸다(아래 배포·회복). 판정 기준은 결과를 보기
  전에 아래 기기 절차에 고정했다.
- **2026-10-25 약 16:40 KST, 옛 버전 정책:** 옛 앱 버전과의 혼합 호환은 더 이상 설계 제약이 아니고,
  필요하면 강제 업데이트로 다룬다(그 경로는 아직 없다). 기존 동결 혼합 버전 fixture는 이 정책을 들어
  일부러 은퇴시키기 전까지 회귀 테스트로 남는다. 4D는 중립 이동이라 동결 fixture
  `control-isolation-c9.ts`와 제어 격리의 두 창 리터럴을 그대로 둔다(아래 혼합 버전).

**구현 중 정한 세부(오너가 맡긴 판단, 2026-10-25).** 오너 확인을 기다린다. 배포의 게이트는 아니고, 현재 릴리스
기록의 4D 범위 항목에 남겨 두었다.

- **기한 값은 `RTC_INTERRUPTION_GRACE_MS`에서 끌어낸다.** 끊김당 한 유예(15초), 상한은 두 유예(30초)다.
  바꾸기 전 제어 격리는 끊김 기한에 자기 리터럴 `RESTART_WINDOW_MS`(15,000)와 `RESTART_CAP_MS`(30,000)를,
  재시작할 수 없는 경로의 유예에 `RTC_INTERRUPTION_GRACE_MS`를 썼다. 값은 같다. 두 리터럴은 제어
  격리에 남아 이제 peer 재시작 요청과 offer만 묶는다. 두 끝이 서로에게 강제하는 창이라 유예가 바뀌어도
  움직이면 안 된다. 그 결과 앞으로 유예를 바꾸면 이 끝의 보조 경로 끊김 창과 상한도 함께 움직이고 peer
  창은 그대로다(리뷰가 짚은 결합. registry RO-15의 타이밍 집에 적었다).
- **관리 타이머로 바꾸지 않았다.** 보조 경로 기한은 바꾸기 전처럼 끊김마다 자기 원시 타이머 하나를
  쓰고(새 관리 타이머 키 없음) 단조 시계로 잰다. 보조 PC의 닫힘과 주인의 stop이 그 타이머를 지운다.
- **원래 경로를 읽는 자리와 조건이 같다.** 주인은 원래 경로를 연결이 열리지 않았거나 멈췄거나 PC가
  없거나, PC가 connected가 아니거나, 원래 제어 채널이 열려 있지 않으면 끊긴 것으로 읽는다(옛
  `originalReady`와 같은 조건. 연결이 snapshot 포트에 `controlOpen`을 더했다). 읽는 때도 같다: 끊김 시작,
  보조 경로가 재시작 신호를 보내려 할 때, 원래 경로의 전이마다, 기한에서.

## 선행 조건: #18 은퇴 근거

허용 위험 #18(일반방 격리 제어 경로가 망 전환에서 끝남)은 2026-10-25 운영 9.0.10 / v783에서 오너
실기기 확인으로 은퇴했다(PR #491, main `f91c538e`, 문서만). 방장은 집 와이파이, 게스트는 오너 기기의
Safari 탭(`?mxqrLog=info`)이었다. 게스트가 같은 와이파이에서 현재 대기열 항목을 직접 받은 뒤(이 직접
전달이 격리 제어 경로를 만든다) 와이파이를 꺼 LTE로 옮겼다. 연결 끊김 창이 뜨지 않았고 소리가
이어졌으며, LTE에 있는 동안 방장의 일시정지와 재생이 바로 반영됐다. 게스트 `/debug console`에는
`[Transport] Restarting isolated control ICE (1/2)` 뒤 3.2초에 `[Transport] Isolated control ICE recovered`가
있었고, 원래 경로도 같은 유예 안에서 재시작해 relay 쌍으로 다시 이어졌다. Android 폰, 방장 콘솔, 같은
공유기의 다른 SSID로 옮기는 IP 변경, 원격(LTE) 게스트가 와이파이로 오는 방향은 보지 않았고, Phase 4 기기
라운드의 단계로 남았다([허용 위험 은퇴 기록](../known-accepted.md#retired-risks)).

이 확인은 기한이 아직 제어 격리에 있던 9.0.10 코드에서 했다. 그래서 4D 기기 확인의 기준선이 된다. 같은
단계를 4D에서 돌려 같은 결과가 나오는지 본다(아래 기기 절차 1).

## 제품·런타임 증분

### D0 보조 경로 끊김을 실제 연결 한 쌍으로 고정 (테스트만)

테스트 `ea6a5781`, 리뷰 반영 `72cdce0d`. 새 `src/network/transport/__tests__/side-route-outage-integration.test.ts`
(34행)는 실제 `CloudflareDataConnection` 둘을 몬다. 각 연결은 자기 실제 `LinkLiveness`와 실제
`ControlIsolation`을 갖고, 제어 레인은 순서를 지키며 경로가 끊긴 동안 프레임을 붙잡는다. 그때까지 보조
경로의 기한은 원래 경로 준비 여부를 stub한 단독 `ControlIsolation`에서만 고정돼 있었다(설계 C5-9의
testsFirst). 고정한 것:

- 원래 경로가 살아 있는 동안의 보조 경로 끊김: 각 끝이 보조 PC가 failed가 된 뒤 15초에 경고 줄 다음
  `side-failed:expired`로 닫히고, 끊긴 쪽만 닫히며, 원래 경로의 보기, 공개 마감, bulk는 그대로다. 15초
  안에 다시 이어지면 두 링크가 남는다.
- 원래 경로가 먼저 끊기고 보조가 끊김(재시작 없이 15초에 두 링크가 `original-grace-expired`로 닫힘)과
  보조가 먼저 끊기고 원래가 끊김(보조의 15초가 원래 경로 유예에 미뤄짐). 원래 PC가 disconnected일 때와
  failed일 때 모두 돈다(`72cdce0d`).
- 원래 경로가 +14초에 회복하면 그때 재시작하고 그로부터 15초(+29초)로 다시 건다. 끊김 시작에서 30초
  상한, 원래 경로가 다시 끊긴 동안에도 지키는 상한(30초에 `side-failed:expired`로 닫히고 32초에 돌아온
  경로는 아무것도 다시 열지 않음, `72cdce0d`), 짧은 원래 경로 끊김이 기한을 그 회복 뒤 15초로 옮기는 것.
- 원래 경로 회복을 건너는 진행 중 재시작은 되풀이되지 않고, 다시 건 기한이 여전히 실패한 보조를 닫는다.
- READY 전: 협상 중 실패한 보조 PC는 두 끝에서 거절하고 fallback하며 링크는 열린 채 제어가 원래 경로로
  간다. 협상 중 disconnected는 10초 협상 상한에서 fallback한다(15초 유예가 먼저 발화하지 않음). 재시작할 수
  있는 경로는 READY 전 disconnected를 READY에서 새 15초로 넘겨받는다. fence 뒤 READY 전 실패는
  `side-failed:route`로 닫힌다.
- 재시작 예산: 끊김당 두 번, 끊김마다 새 예산과 새 15초, 응답자 요청 15초 창당 두 번(12초의 요청은 거절,
  `72cdce0d`), 30초에 offer 16개까지(첫 offer 20초 뒤에도 막고 30초 뒤에 풀림, `72cdce0d`).
- 기기 근거 세 줄의 수준과 그 줄을 쓰는 끝, 그 끝의 닫힘 바로 앞의 did-not-recover 경고, 끊김 없이 다시
  이어진 보조 PC는 어느 끝에도 회복 줄을 쓰지 않는 것(`72cdce0d`).
- 동결 C9 fixture의 peer: 15초 유예가 `side-failed:route`로 닫고, 원래 경로에 미뤄지지 않으며, failed는
  곧바로 닫고, 증거 줄이 하나도 없다. 첫 유예 안(12초)의 두 번째 disconnected로 재연결이 그 유예를 지우는
  것을 보인다(`72cdce0d`).
- 벽시계가 뛰어도 기한, 다시 걸기, 상한이 움직이지 않는다(단조 시계).

테스트 먼저: 두 커밋 모두 9.0.10 코드 위에 있고 그 코드에서 통과했다. 이 보고서를 쓰기 전에
`a8dfd2ac`의 런타임 네 파일을 작업 트리에 얹고 HEAD의 같은 묶음(`72cdce0d` 뒤로 바뀌지 않음)을 다시 돌려
34/34 PASS를 확인하고 되돌렸다. `72cdce0d`의 새 행은 각자 이름 붙인 변형(만료 때 옮겨지는 상한, 상한을
넘거나 now + 15초로 다시 거는 미룸, 보조 경로에 알리지 않는 주인의 failed 분기, failed PC를 살아 있다고
읽는 원래 경로 판정)을 잡는 것을 확인했다(커밋 기록).

### D1 C5-9 보조 경로의 끊김 기한을 LinkLiveness로 (중립)

코드 `d5c66b9a`. 설계는 risk high, size L로 붙였다.

- `LinkLiveness`가 보조 PC의 끊김 기록 하나를 갖는다. 재시작하는 경로는 끊김당 15초이고, 원래 경로가
  끊긴 동안 미루며, 원래 경로가 회복하면 15초로 다시 걸되 끊김 시작에서 30초를 넘지 않는다. 기한에 보조
  PC가 connected면 끊김을 조용히 끝낸다.
- 재시작할 수 없는 경로(READY 전, 또는 재시작이 없는 C9 peer)의 갱신하지 않는 15초 유예는
  `restartable: false` 기록이다. 원래 경로가 미루지 않고, 끝나면 `ControlIsolation.setupFailed`를 불러
  바꾸기 전 의미(거절하고 fallback, 또는 `side-failed:route`로 링크를 끝냄)를 지킨다. READY가 오면 그때
  시작하는 재시작 끊김으로 넘겨받는다.
- 회복 줄과 did-not-recover 경고가 주인으로 옮겼다. 바이트, 수준, 쓰는 끝이 같다. 재시작 줄은 제어
  격리(offerer)에 남는다.
- 제어 격리는 `SideOutageOwner` 포트(`sideChanged`, `sideGraceRunning`, `sideMaySignal`, `sideClosed`)로 보조
  PC 상태를 알리고, 주인에게서 `outageStarted`, `outageEnded`, `outageExpired`, `mayRestart`를 받는다. 재시작
  통신(시도, 요청 창, offer 창, epoch, 후보, fence, READY, 재시작 줄)은 그대로 제어 격리의 것이다. 지운 것:
  끊김 기록의 기한·타이머·`originalDown`, `disconnectedTimer`, `armDeadline`, `restartExpired`,
  `endInterruption`, `beginInterruption`, `originalChanged`, `Options.originalReady`.
- 연결은 자기 `LinkLiveness`를 보조 경로의 끊김 주인으로 넘기고, snapshot 포트에 원래 제어 채널
  (`controlOpen`)을 더하며, `sideMayRestart` 포트가 `originalChanged` 대신 `mayRestart`를 부른다. 주인은
  보조 끊김을 붙잡은 채 원래 경로가 끊긴 전이에서는 포트를 부르지 않고 미룸만 적는다(옛
  `originalChanged`의 이른 반환과 같다). `controlOpen`은 리뷰 반영으로 필수 필드가 됐다(아래 QA 라운드 3).
  `types.ts`는 보기의 주석만 바뀌었다.
- registry: RO-35(보조 경로 기한이 제어 격리에 남는 예외)는 그 대상이 없어져 지웠고(48 → 47 records),
  RO-15는 `owner-in-place`가 되어 기한 주인, 타이밍 집, anchor 테스트를 고쳤다. 실시간 런타임 소유권 ADR,
  보기 타입 주석, 보조 ICE 재시작 설계 메모가 따라갔다.

테스트: D0 통합 묶음과 동결 C9 fixture는 바뀌지 않고 통과한다. 제어 격리의 기존 두 묶음
(`control-isolation.test.ts` 61행, `control-isolation-evidence-logs.test.ts` 4행)은 행 수와 `expect`가
`a8dfd2ac`와 같고, 하네스만 원래 경로 stub(`originalReady` 옵션과 `originalChanged` 호출) 대신 실제
`LinkLiveness`(`__tests__/fixtures/side-outage-owner.ts`)를 몬다. link-liveness 두 묶음
(`link-liveness.test.ts`, `link-liveness-characterization.test.ts`)의 보조 경로 알림 spy는 `originalChanged`에서
`mayRestart`로 따라갔고 단언은 같다. 새 `link-liveness-side-outage.test.ts`(15행)가 주인의 보조 기록을 따로
고정한다. 다시 걸기, 상한, 원래 경로를 읽는 자리, 제어 채널 읽기, READY 넘겨받기, 갱신하지 않는 유예,
stop, 닫힘을 하나씩 바꾸면 각각 행이 실패한다(커밋 기록). 핵심 커버리지 프로필이 두 보조 경로 묶음을 더
돌리고 `link-liveness.ts`는 100%를 유지한다. 초기 JS +181 B.

### D2 C5-10의 제어 격리 부분: 옛 기한 이름 잠금 (가드·테스트·문서)

코드 `b385fad0`. 런타임 파일은 바뀌지 않았다. 설계 비평이 C5-10을 연결 부분(4C)과 C5-9 뒤의 제어 격리
부분으로 나누라고 한 그 뒤쪽이다.

- `guard:transport-health` CHECK 3의 은퇴 이름에, C5-9 전 제어 격리가 보조 PC 기한에 쓰던 여덟을 더했다:
  `beginInterruption`, `armDeadline`, `restartExpired`, `endInterruption`, `originalReady`, `originalChanged`,
  `originalDown`, `disconnectedTimer`. `link-liveness.ts` 밖 production 파일에 나오면 발견이다(주인에는
  `originalDown` 플래그만 남는다). 9.0.10 트리(`a8dfd2ac`)에 돌리면 여덟 모두를 `control-isolation.ts`에서,
  `originalReady`와 `originalChanged`를 연결에서 잡는다. 동결 C9 fixture는 테스트 파일이라 범위 밖이고 옛
  유예 타이머를 그대로 갖는다.
- 자기 테스트: 새 describe가 여덟 이름을 모두 제어 격리(멤버, 호출, 문자열 키)에, `originalChanged`를 연결에
  다시 심어 발견을 보이고(가드 자체는 `link-liveness.ts` 밖 `src/`의 모든 production 파일에서 여덟을 잡는다),
  주석이나 다른 문자열은 세지 않으며, 주인은 그 이름을 가져도 되고, fixture는 범위 밖임을 고정한다. 실제
  트리 수치는 그 때문에만 움직인다: 은퇴 이름 16 → 24, 주인 안에서 허용되는 이름의 쓰임 6 → 13
  (`originalDown` 7회). 여덟 항목을 빼면 네 행이 실패한다.
- 문서: 실시간 런타임 소유권 ADR(가드 문단과 검증 목록에 두 보조 경로 묶음), `signaling-liveness.md`(주인이
  보조 경로 기한을 원래 경로와 따로 가짐), 보조 ICE 재시작 설계 메모(주인이 원래 경로 준비를 직접 읽음과
  가드), registry RO-15(ratchet과 그 anchor). `link-liveness.test.ts`의 낡은 RO-35 주석 둘이 C5-9를
  가리키고 단언은 같다.

### 9.0.11 / v784

마지막 런타임 커밋 `cf555b01`에서 4A의 `8a9e1772`, 4B의 `aba30ccb`, 4C의 `d52427e2`와 같은 자리를 올렸다.
`package.json`, `package-lock.json` 두 곳, App Worker의 `ADMIN_ASSET_VERSION`, 관리자 스크립트의
`ADMIN_SCRIPT_VERSION`, `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 쿼리다. 9.0.10은 배포됐으므로
둘을 함께 올렸다. 올리기 직전 fetch한 origin/main은 `f91c538e`(#491, 문서만, `b7927afb`에서 이미 합침)
그대로라 다시 합칠 것이 없었고, 그 사이 다른 앱 열차(Phase 5 포함)는 main에 들어오지 않았다.
`guard:release-identity`(MUSIXQUARE 9.0.11, cache v784)와 `guard:sw-cache-version`(v784 `cf555b01`가 커밋된
PWA 런타임 변경을 모두 덮음)이 통과했다. `git grep`으로 보면 문서 밖에 남은 `9.0.10`은 D0 통합 묶음의 머리
주석(9.0.10 코드에서 쓴 테스트)뿐이고 `v783`은 없다. bump SHA에서 `build:checked` 전체, Worker 전체,
critical E2E, C5-0 랩을 돌렸다(아래 QA 라운드 4).

## 그대로인 것

- 끊김당 15초, 원래 경로가 끊긴 동안 미룸, 회복 뒤 15초로 다시 걸고 끊김 시작에서 30초 상한, 기한에
  connected면 조용히 끝냄.
- 재시작할 수 없는 경로(READY 전, 재시작이 없는 peer)의 갱신하지 않는 15초 유예와 그 끝의 `setupFailed`
  (거절과 fallback, fence 뒤면 `side-failed:route`). 협상 상한 10초가 그보다 먼저 fallback한다.
- 재시작 시도(끊김당 `MAX_RESTART_ATTEMPTS` 2, 요청 창당 2), offer 30초에 16개, 보조 경로의 단조 시계.
- `RESTART_WINDOW_MS`와 `RESTART_CAP_MS`는 제어 격리의 리터럴이다(혼합 버전 peer가 기댄다).
- 모든 프레임, epoch, 후보, fence, READY 규칙은 제어 격리에 남고 통신은 바뀌지 않았다.
- 기기 근거 세 줄의 바이트, 수준, 쓰는 끝: `[Transport] Restarting isolated control ICE (n/m)`(info,
  offerer만), `[Transport] Isolated control ICE recovered`(info, 끊김을 본 끝),
  `[Transport] Isolated control ICE did not recover; closing its logical connection`(warn, 그 끝의 닫힘 바로
  앞). 소스 줄은 앞의 하나가 `control-isolation.ts`, 뒤의 둘이 `link-liveness.ts`에 있다.
- 닫힘 원인 낱말은 4A·4B 집합(`side-failed:<reason>`의 `expired`, `route`, `send`, `protocol`, `limit`, 원래
  경로의 `original-grace-expired` 등)이고 `[Transport] Logical connection closed (<cause>) for <peerId>` 줄도
  같다.
- 4C의 원래 경로 유예, 재시작 문, 복귀 확인, 닫힘 포트, 타이머 키, 효과 순서. 보조 경로만의 끊김은 phase를
  `recovering`으로 만들지 않아 bulk를 막지 않고 미리받기를 멈추지 않는다(4C의 C5-8 행 그대로).
- 동결 fixture `src/network/transport/__tests__/fixtures/control-isolation-c9.ts`는 `a8dfd2ac`와 같고, 그
  묶음은 증분마다 돌았다.

## QA 라운드

### 1. 갈래 (2026-10-25)

검증 대상은 각 커밋이다(기준 `a8dfd2ac`). 아래는 커밋 메시지에 남은 기록이다.

| 검사           | 결과와 범위                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D0 테스트 먼저 | `ea6a5781`, `72cdce0d`: 새 통합 묶음이 9.0.10 코드에서 PASS(테스트만). `72cdce0d`의 새 행은 이름 붙인 변형을 하나씩 잡는다.                    |
| D1 단위 전체   | `d5c66b9a`에서 666 files / 15,591 tests PASS. D0 묶음과 동결 C9 fixture 묶음은 수정 없이 통과.                                                 |
| D1 초기 JS     | 같은 기계의 프로덕션 빌드(gzip): 478,015 → 478,196 B(+181 B, peer 청크 103,382 → 103,560 B), `guard:initial-transfer-budget` PASS.             |
| D2 정적        | `tsc --noEmit`, `typecheck:tests`, `typecheck:node-scripts`, tooling tsc, `lint`, `format:check` PASS.                                         |
| D2 가드        | transport-health, dead-exports(테스트 전용 20/20, 자기만 76/76 그대로), import-graph, source-complexity, bus-pairing, resource-ownership PASS. |
| D2 단위        | 영향 묶음 11 files / 624 tests, 전체 666 files / 15,594 tests PASS. 런타임 변경이 없어 빌드하지 않았다.                                        |
| SKIP           | 실제 기기, WebKit, Playwright, C5-0 랩, `build:checked`, Worker 단위.                                                                          |

### 2. 보고서 커밋 전 다시 확인 (2026-10-25)

검증 대상은 `b385fad0`이다(런타임은 `d5c66b9a`와 같다). 환경은 위와 같다.

| 검사             | 결과와 범위                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 테스트 먼저 다시 | `a8dfd2ac`의 런타임 네 파일(`control-isolation.ts`, `link-liveness.ts`, `cloudflare-signaling.ts`, `types.ts`)을 얹고 D0 묶음 34/34 PASS. 되돌린 뒤 작업 트리 clean.                                                                                                                                                                       |
| 보조 경로 묶음   | side-route-outage-integration, link-liveness-side-outage, control-isolation, control-isolation-evidence-logs, link-liveness, link-liveness-characterization, transport-health-guard: 7 files / 277 tests PASS.                                                                                                                             |
| 기존 행          | `control-isolation.test.ts` 61행, `control-isolation-evidence-logs.test.ts` 4행으로 `a8dfd2ac`와 같고, 두 파일의 diff에 바뀐 `expect` 줄이 없다. 동결 fixture는 `a8dfd2ac`와 같다.                                                                                                                                                         |
| 단위 전체        | `vitest run --maxWorkers=6` 666 files / 15,594 tests PASS, FAIL 0(231초).                                                                                                                                                                                                                                                                  |
| 가드             | transport-health(12 files, 원시 읽기 1, 소비자 3, 은퇴 이름 24, `terminate()`는 주인의 닫힘 포트에서만), dead-exports(테스트 전용 20/20, 자기만 76/76 그대로), `check-resource-ownership`(47 records / 437 files, 타이밍 사본 6·의심 1, 같은 값 쌍 26은 보고만) PASS. records 48 → 47은 RO-35 삭제다.                                      |
| 핵심 커버리지    | `test:coverage:critical` 79 files / 3,074 tests PASS(4C의 77 files에 두 보조 경로 묶음이 더해졌다), 파일별 하한 유지. `link-liveness.ts` 176/176 줄, 160/160 분기, 29/29 함수. `cloudflare-signaling.ts` 82.6/80.36/85.16/87.58(하한 72/71/72/78). `control-isolation.ts`는 커버리지 include 밖이다(4C와 같음).                            |
| 빌드 바이트      | `npm run build` 두 번, 두 번 모두 `guard:initial-transfer-budget` PASS. 두 번째 빌드를 `measureInitialTransfer`로 재서 초기 JS 478,196 B, 진입 청크 `main-CnH4m-NG.js`(raw 364,761 B, 4C와 같음), peer 청크 gzip 103,560 B로 D1 커밋의 값과 같다(아래 초기 JS 예산).                                                                       |
| SKIP             | `build:checked`(bump 전이라 `guard:sw-cache-version`이 설계대로 실패한다), Worker 단위와 `check:workers`(`cloudflare/` 변경 없음, bump 뒤에 돌린다), `test:e2e:critical`(PeerJS 경로라 보조 경로를 타지 않는다), C5-0 랩, 실제 기기, WebKit, PR CI·Codex·exact-main CI·릴리스 smoke(이 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다). |

### 3. #491 합침과 리뷰 반영 (2026-10-25)

`00aacf99`에 대한 리뷰 두 갈래(코드: 승인, 높음·중간 없음, 낮음 3. 문서: 중간 1, 낮음 3)를 반영했다. 검증
대상은 `b7927afb`(#491 합침) 위의 리뷰 반영 `6c69651b`(문서 커밋은 그 위에 문서만 더한다)이고, 환경은 위와 같다.

- **코드 낮음 1(#491 미합침):** `b7927afb`에서 합쳤다(아래 배포 전 남은 단계).
- **코드 낮음 2(`controlOpen` 선택 필드):** `LinkSnapshot.controlOpen`을 필수로 했다. 빠뜨린 snapshot
  포트가 원래 경로를 늘 끊긴 것으로 읽어 모든 보조 끊김을 30초 상한까지 붙잡고 재시작 신호를 보내지
  않는 일을 이제 타입 오류가 막는다. 비교 `=== true`는 그대로라 내보내는 JS가 같다(`link-liveness.ts`를
  바꾸기 전과 뒤로 esbuild minify한 결과가 바이트 단위로 같음). 그래서 빌드 바이트는 라운드 2의 값
  그대로다. 이 필드를 주지 않던 테스트 snapshot 다섯 곳(`link-liveness.test.ts` 둘, 미리받기·bulk 레인
  묶음 셋)에 값을 넣었고(그 묶음들은 보조 끊김을 몰지 않아 읽히지 않는다),
  `link-liveness-side-outage.test.ts`의 '값 없음' 한 줄은 '닫힌 제어 채널'(`false`)로 바꿨다.
- **코드 낮음 3(기한 값과 유예의 결합):** 코드는 그대로 두고, 유예를 바꾸면 보조 경로 끊김 창과 상한도
  함께 움직이고 peer 창은 그대로라는 점을 registry RO-15의 타이밍 집과 위 오너 결정의 세부에 적었다.
  오너 확인을 기다리는 판단이다.
- **문서 중간(낡은 Phase 4 범위 문장):** 현재 릴리스 기록의 Phase 4 게이트 편차 항목('C5-9는 Phase 4
  밖', '4C까지 세 번')과 4C 범위 항목의 'C5-9는 싣지 않는다(Phase 4 밖)'를 4D 결정(오너 결정
  2026-10-25 약 16:30 KST, 4D까지 네 번, 실패 시 forward revert)으로 고쳤다.
- **문서 낮음(가드 자기 테스트 설명):** registry RO-15와 D2 설명을 테스트에 맞췄다. 여덟 이름은 모두
  `control-isolation.ts`에 심고, 연결에는 `originalChanged`만 심는다.
- **문서 낮음(`sideMayRestart` 설명):** RO-15를 코드에 맞췄다. 보조 끊김을 붙잡은 채 원래 경로가 끊긴
  전이에서는 포트를 부르지 않는다.
- **문서 낮음(배포 전 상태의 남은 문장):** 4A 기기 라운드의 기준선 문장은 4D 배포 기록 때 고칠 일로
  아래 남은 단계와 기록의 4D 항목에 적었다. 8.11.25 보조 연결 ICE restart 항목은 합침으로 지워졌다.
  '오너가 돌아와 다시 확인한다'는 문장은 기록의 4D 항목에 오너 확인 대기로 남겼다.

| 검사          | 결과와 범위                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 정적          | `tsc --noEmit`, `typecheck:tests` PASS. 바뀐 TS 파일 여섯의 `prettier --check`와 `eslint` PASS.                                                                                                                                                      |
| 단위 전체     | `vitest run --maxWorkers=6` 666 files / 15,594 tests PASS, FAIL 0(236초).                                                                                                                                                                            |
| 핵심 커버리지 | `vitest.critical.config.ts` 커버리지(출력은 scratch) 79 files / 3,074 tests PASS, 하한 유지. `link-liveness.ts` 176/176 줄, 160/160 분기, 29/29 함수.                                                                                                |
| 가드          | transport-health(은퇴 이름 24), dead-exports(테스트 전용 20/20, 자기만 76/76), `check-resource-ownership`(47 records / 437 files), import-graph, source-complexity, bus-pairing, lifecycle-writes PASS. release-identity는 `9.0.10` / `v783` 그대로. |
| 동결 fixture  | `control-isolation-c9.ts`는 `a8dfd2ac`와 같다. 런타임 파일은 여전히 네 개이고 `cloudflare/`는 바뀌지 않았다.                                                                                                                                         |
| SKIP          | 빌드(내보내는 JS가 같아 라운드 2의 바이트를 그대로 쓴다), 라운드 2와 같은 SKIP 전부.                                                                                                                                                                 |

### 4. bump 뒤 최종 검증 (2026-10-25)

검증 대상은 bump `cf555b01`다. 그 뒤 커밋은 이 보고서·기록·문서 색인만 바꾼다. 환경은 위 표와 같다(Playwright
1.63.0, 헤드리스 Chromium).

| 검사            | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 식별            | `guard:release-identity`(MUSIXQUARE 9.0.11, cache v784), `guard:sw-cache-version`(v784 `cf555b01`가 커밋된 PWA 런타임 변경을 모두 덮음) PASS. 올리기 직전 fetch한 origin/main은 `f91c538e` 그대로였다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 단위 전체       | `vitest run --maxWorkers=6` 666 files / 15,594 tests PASS, FAIL 0(231초). D0 통합 묶음, 기기 근거 세 줄 고정(`control-isolation-evidence-logs.test.ts`), 동결 fixture `control-isolation-c9.ts`(`a8dfd2ac`와 같음)를 쓰는 `control-isolation.test.ts`가 그 안에서 통과한다. 세 줄을 내는 소스 줄은 `control-isolation.ts` 하나와 `link-liveness.ts` 둘이고 문자열과 수준은 `a8dfd2ac`의 세 줄과 같다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Worker 단위     | `vitest run --config vitest.workers.config.ts` 60 files / 2,914 tests PASS. bump가 App Worker의 `ADMIN_ASSET_VERSION`을 바꾸므로 bump 뒤에 돌렸다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 정적            | `npm run typecheck`(모든 tsc 프로젝트와 그 가드), `typecheck:tests`, `check:workers`, `lint`, `format:check` PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `build:checked` | 전체 PASS. 빌드 앞 가드 16개(release-identity, sw-cache-version 포함), 빌드, legacy TV Chromium 79(`main-Bzl7gsk7.js`), SW 빌드(cache epoch v784), ui-kit 빌드, 초기 전송 예산, prod hooks·보안, 글꼴, SW app-shell 106 자산.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 가드            | navigation-sinks, dead-exports(테스트 전용 20/20, 자기만 76/76 그대로), bus-pairing 204/204, import-graph(395 files, 순환 0), lifecycle-writes, release-identity, sw-cache-version, transport-health(12 files, 원시 읽기 1, 소비자 3, 은퇴 이름 24, `terminate()`는 주인의 닫힘 포트에서만), chunk-pump, standard-room-hot-path, `check-resource-ownership`(47 records / 437 files, 타이밍 사본 6·의심 1, 같은 값 쌍 26은 보고만) PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 핵심 커버리지   | `test:coverage:critical` 79 files / 3,074 tests PASS, 파일별 하한 유지. `link-liveness.ts` 176/176 줄, 160/160 분기, 29/29 함수, `cloudflare-signaling.ts` 82.6/80.36/85.16/87.58로 라운드 2·3과 같다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Chromium        | `test:e2e:critical` 61/61 PASS(3.9분, flaky 0, PeerJS 경로라 보조 경로를 타지 않는다).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C5-0 랩         | `playwright.lab.config.ts --repeat-each=2` 16/16 PASS(10.7분, 재시도 0). 4D 코드로 처음 돌렸다. 보조 연결 행(PC failed 뒤 재시작 회복) 두 번: 끊김 16.08초 뒤 게스트, 15.88초 뒤 방장의 보조 PC가 failed로 먼저 보였고, 두 번 모두 offerer 한쪽에 `Restarting isolated control ICE (1/2)` 하나(끊김 +6.10초 방장, +5.79초 게스트), 양쪽에 `Isolated control ICE recovered`(restore +0.28~0.47초), 두 끝 모두 같은 보조 PC를 지켰고 did-not-recover 경고와 `Logical connection closed` 줄은 어느 콘솔에도 없다. 10초 원래 경로 끊김은 세션을 닫지 않고 restore 뒤 0.44초·0.23초에 회복. 미리받기 재개는 두 번 모두 `Paused` 하나와 `Resuming`(restore +0.24·+0.25초) 하나, `PRELOAD_START restart:true` 하나(끊길 때 30%), 그 미리받기의 `PRELOAD_ABORT` 없음, Blob SHA-256 일치. F4 두 번: 재시작 머리 +0.27·+0.24초, 본 레인 `FILE_START` +3.50·+3.62초, 그 직후 보조 제어 채널로 `PRELOAD_ABORT` 하나와 `Yielding`, `PRELOAD_END` 없음, 미리받기 청크 0 B, 본 레인 23,040,044 B. 게스트는 끊긴 동안 진행 감시로 멈춘 세션(107/352)을 놓았다. 4C 라운드 4와 같은 판정이다. |
| 빌드 바이트     | 랩 뒤 프로덕션 빌드(`npm run build`) 두 번 모두 초기 JS 478,186 B, 진입 청크 `main-Bzl7gsk7.js`(`build:checked`의 legacy TV 검사가 본 이름과 같다), peer 청크 gzip 103,559 B. `test:e2e:critical`과 랩이 `build:e2e`로 덮은 `dist`는 예산 값으로 쓰지 않았다(아래 초기 JS 예산).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SKIP            | 실제 기기, WebKit, 기본 Playwright 전체 목록(critical과 랩만 돌림), PR CI·Codex·exact-main CI·릴리스 smoke(이 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다), 운영 배포 기록을 쓰는 부분 게이트 판정(Production Release가 다시 판정한다).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 배포 전 남은 단계

- **origin/main 합침(끝남).** `b7927afb`에서 #491 `f91c538e`(문서만)를 합쳤다. registry는 RO-35의 색인
  행과 기록에서 충돌했고 삭제를 지켰다(RO-15는 `owner-in-place` 그대로). release-record의 최근 해결 근거에
  있는 #18 문단 끝('C5-9는 결함이 나오지 않으면 하지 않는다')은 4D(오너 결정 2026-10-25 약 16:30 KST)를
  가리키게 고쳤다. 리뷰 반영 커밋이 같은 기록의 Phase 4 게이트 편차 항목('C5-9는 Phase 4 밖', '4C까지 세
  번')과 4C 범위 항목의 남은 문장도 4D 결정으로 고쳤다. known-accepted와 두 #18 근거 보고서의 #491 문장은
  그대로다. 런타임 파일은 겹치지 않는다.
- **bump와 최종 검증(끝남).** 올리기 직전 fetch한 origin/main은 `f91c538e` 그대로였고, 마지막 런타임 커밋
  `cf555b01`에서 `9.0.11` / `v784`로 함께 올렸다. bump 뒤 `build:checked` 전체, Worker 단위와
  `check:workers`, 단위 전체, 핵심 커버리지, `test:e2e:critical`, C5-0 랩 행마다 두 번(보조 PC가 failed에 닿은 뒤의
  재시작 회복 행 포함)이 통과했다(QA 라운드 4). 리뷰나 CI가 런타임을 다시 바꾸면 bump를 다시 마지막에 둔다.
- **리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke, 배포.** 배포 뒤 release-record §1과 이력 한 줄을 쓴다.
  4D가 그 기기 라운드보다 먼저 나가면, 같은 기록 커밋에서 '4A 배포 뒤 실기기 확인' 항목의 '4C 위에서 처음
  재는 기준선' 문장을 4D로 고친다.

## 혼합 버전

known-accepted #13대로 버전 입장 제한이 없다. 4D에는 통신 형식, 메시지 종류, 영구 데이터 모양 변경이 없다.
오너 정책(2026-10-25 약 16:40 KST)으로 옛 버전 호환은 설계 제약이 아니지만, 4D는 중립 이동이라 옛 peer와
주고받는 것을 그대로 둔다.

| 조합                                     | 결과                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4D와 재시작이 있는 빌드(8.11.25~9.0.10)  | 프레임, 요청 15초 창, offer 30초 창이 같다. 기한 규칙은 각 끝의 로컬 판단이고 4D 끝은 9.0.10과 같은 규칙을 주인에서 돈다. 어느 끝이 먼저 닫든 원인 낱말이 같다.                                                                        |
| 4D와 재시작이 없는 빌드(동결 C9 fixture) | 활성 경로의 15초 유예(갱신하지 않음, 원래 경로가 미루지 않음)가 `side-failed:route`로 닫고, failed는 곧바로 닫으며, 증거 줄이 없다. D0의 'a peer on the frozen C9 build'와 동결 fixture를 쓰는 `control-isolation.test.ts`가 고정한다. |
| 닫힘 원인 줄과 증거 줄                   | 각 기기의 로컬 로그다. 바이트, 수준, 쓰는 끝이 9.0.10과 같다.                                                                                                                                                                          |
| PRO 방                                   | PRO 연결에는 보조 경로가 없어 이 이동이 닿지 않는다.                                                                                                                                                                                   |
| 업데이트                                 | 4D는 업데이트 기계를 바꾸지 않는다.                                                                                                                                                                                                    |

## 초기 JS 예산

실제 프로덕션 빌드로 잰 값(gzip, `measureInitialTransfer`)과 유지 상한까지의 여유다. 상한은 초기 JS
491,568 B다. 같은 코드도 빌드마다 수십 B 흔들린다.

| 트리                                                | 초기 JS   | 여유     | 진입 스크립트 | 초기 전체 |
| --------------------------------------------------- | --------- | -------- | ------------- | --------- |
| main `a8dfd2ac`(9.0.10 / v783, 런타임은 `d52427e2`) | 478,015 B | 13,553 B | 111,437 B     | 556,635 B |
| 4D `b385fad0`(런타임은 `d5c66b9a`)                  | 478,196 B | 13,372 B | 111,439 B     | 556,818 B |
| bump 뒤 `cf555b01`(9.0.11 / v784)                   | 478,186 B | 13,382 B | 111,431 B     | 556,806 B |

main 값은 4C 보고서 라운드 4의 bump 뒤 값(프로덕션 빌드 두 번 같음)이고, D1 커밋도 같은 기계에서 478,015 B로
쟀다. 4D 값은 라운드 2의 두 번째 빌드에서 쟀고 D1 커밋의 값과 같다. 늘어난 +181 B는 거의 첫 로딩에 실리는
peer 청크의 몫이다(gzip 103,382 → 103,560 B, +178 B. 연결 생존 주인과 제어 격리가 이 청크에 있다). 초기 전체
raw는 2,074,912 B다.

bump 뒤 값은 라운드 4에서 랩 뒤 프로덕션 빌드를 두 번 해 쟀고 두 번 같았다(main 대비 +171 B, peer 청크
gzip 103,559 B). 진입 청크는 `main-Bzl7gsk7.js`이고 raw 값은 진입 스크립트 364,761 B, 초기 전체 2,074,912 B로
`b385fad0`와 같다. bump는 버전 문자열만 바꾸므로 `b385fad0` 대비 −10 B는 빌드 흔들림이다.

P4-D4 A대로 막는 선은 5% 예비선(가드) 하나이고 통과했다. 로드맵의 '증분당 +300 B'는 넘지 않았다(D1
+181 B. D0와 D2는 런타임 변경이 없다). 설계 비평은 C5-9를 바이트를 되찾을 유일한 증분으로 보았지만, 지운
제어 격리 코드보다 주인의 보조 기록과 포트가 커서 순 증가다. Phase 4 전체로는 4A의 −14,367 B, 4B의 +666 B,
4C의 +419 B, 4D의 +181 B(bump 뒤 +171 B)를 합해 약 −13,100 B라 Phase 목표와 '프로그램 순 0 이하' 목표 안이다.

## 배포·회복

**배포 대상(예정).** target `app`, Developer API D1 `false`. 4D는 App 런타임 입력(`src`, bump 때의
`package.json`·App Worker·SW 캐시·`index.html`)만 바꾼다. `cloudflare/`에서 바뀌는 것은 bump의 App Worker
`ADMIN_ASSET_VERSION` 한 줄뿐이다. 새 D1 스키마·비밀·바인딩·통신 형식은 없다. bump `cf555b01`가 SemVer를
`9.0.11`, SW 캐시 epoch를 `v784`로 올렸다.
업데이트 창이 뜨는 배포이고, 오너 결정(2026-10-25 약 01:50 KST)대로 자동 게이트가 통과하면 따로 묻지 않고
낸다. 4D는 Phase 5가 함께 쓰는 데이터 PC SDP 레인(RO-16)을 건드리지 않는다(보조 경로는 따로 된 PC다).

**되돌리기(오너 결정으로 미리 정함).** 오너의 4D 기기 확인이 실패하면 forward revert를 낸다. D1
`d5c66b9a`와 D2 `b385fad0`을 함께 되돌리고(D2의 가드는 되돌린 제어 격리의 옛 이름을 잡으므로 함께 가야
한다) registry RO-35를 되살리는 커밋을, 더 높은 SemVer와 캐시 epoch로 낸다
([hotfix-procedure.md](../hotfix-procedure.md)의 Rollback). D0 통합 묶음은 9.0.10 코드에서 통과하므로 되돌린
뒤에도 남겨 9.0.10 동작으로 돌아왔는지 확인하는 데 쓴다. 급할 때의 Cloudflare App 버전 되돌리기는 9.0.10 /
v783(그 아래 9.0.9~9.0.5도)으로 할 수 있고, 모두 PRO 입장 정책 계약 표지(9.0.4부터)를 가진다. 통신·저장
형식이 같아 새 D1·비밀·저장 데이터 마이그레이션은 없다.

## 실기기로 확인하지 않은 것

4D 코드로 실제 기기를 아직 돌리지 않았다. 오너 결정(2026-10-25 약 01:50 KST)대로 기기 근거는 배포의
게이트가 아니지만, 4D는 오너가 되돌리기를 기기 확인에 걸어 두었다(약 16:30 KST). 판정 기준은 결과를 보기
전에 아래에 고정하고 결과를 본 뒤 넓히지 않는다.

**4D 기기 절차.** Windows Chrome 방장, 같은 와이파이의 iPhone Safari 게스트(할 수 있으면 Android Chrome
게스트도), 둘 다 `?mxqrLog=info`로 연 일반방, 로컬 파일 재생. 게스트가 들어온 뒤 방장이 아직 게스트에게
없는 대기열 항목을 재생해 게스트가 그 파일을 직접 받게 한다(게스트 콘솔의
`[Guest] PLAY for current queue item with no buffer/pipeline; requesting file`. 이 직접 전달이 격리 제어
경로를 만든다. 이미 재생 중인 트랙에 다시 들어오면 보조 경로가 생기지 않는다). 재시작 줄은 offerer 한쪽만
쓰므로 콘솔은 방장과 게스트를 합쳐 본다.

1. **#18 와이파이→LTE(되돌리기 판정).** 직접 받은 뒤 재생 중에 게스트의 와이파이를 꺼 LTE로 옮긴다. 통과:
   연결 끊김 창과 재접속이 없고 소리가 이어지며, LTE에 있는 동안 방장의 일시정지와 재생이 바로 반영된다.
   합친 콘솔에 `[Transport] Restarting isolated control ICE (n/2)` 다음
   `[Transport] Isolated control ICE recovered`가 있고, did-not-recover 경고 줄과 그 게스트 PeerID의
   `[Transport] Logical connection closed (side-failed:<reason>) for <peerId>` 줄이 없다. 재시작 줄에서
   회복 줄까지 초를 적어 9.0.10 기준선(3.2초)과 나란히 둔다. 창, 경고 줄, `side-failed:*` 원인 줄 중
   하나라도 있으면 실패이고, 오너 결정대로 forward revert를 낸다.
2. **15초 넘는 끊김(되돌리기 판정).** 직접 받은 뒤 게스트를 비행기 모드(와이파이와 셀룰러 모두 끔)로 약
   40초 두었다가 푼다. 두 경로가 함께 끊기므로 보조 경로의 15초는 원래 경로 유예에 미뤄지고 원래 경로
   유예가 링크를 닫는다. 통과: 방장 콘솔에 그 게스트 PeerID의 원인 줄이 하나이고 그 토큰이 원래 경로의
   것(`original-grace-expired` 기대, 4A·4B 허용표로도 판정)이며, 어느 콘솔에도 `side-failed:expired`와
   did-not-recover 경고가 없다. 게스트는 연결 끊김 창으로 끝나고, 다음 info 페이지의
   `[Transport] Previous page closed (<cause>)` 원인을 적는다(P4-D5 B). `side-failed:expired`가 원래 경로의
   원인 대신 나오면 미룸이 깨진 것이라 실패다.
3. **READY 전 경우(할 수 있으면, 기록만).** 방장이 새 항목을 재생해 게스트 콘솔에 위의 요청 줄이 보이는
   즉시 게스트의 와이파이를 끈다. 격리 제어 경로가 READY 전(협상 10초 안)에 끊길 수 있는 유일한 손
   조작이지만, READY에 닿았는지는 로그로 알 수 없다. 창이 떴는지, 원인 줄과 그 토큰, 증거 줄이 있었는지만
   적고 되돌리기 판정에는 쓰지 않는다(9.0.10과 4D 모두 fence 전 실패는 fallback, fence 뒤 READY 전 실패는
   `side-failed:route`, READY 뒤는 1단계와 같다). READY 전 의미는 단위(D0와
   `link-liveness-side-outage.test.ts`)로만 고정돼 있다.

그 밖에 확인하지 않은 것:

- Android Chrome 게스트, 같은 공유기의 다른 SSID로 옮기는 IP 변경, 원격(LTE) 게스트가 와이파이로 오는
  방향, 방장 콘솔(넷 다 #18 은퇴 때도 보지 않았다).
- 원래 경로가 끊긴 동안 미뤄졌다가 회복 뒤 다시 걸리는 경로와 30초 상한. 손 조작으로 원래 경로만
  회복시키기 어려워 단위(D0와 주인 묶음)로만 고정돼 있다.
- WebKit 레인, 운영 Cloudflare 전송 경로, 4A·4B·4C 기기 라운드(아직 없어 전후 비교 기준이 없다). 4D 코드의
  C5-0 랩은 bump 뒤 헤드리스 Chromium 로컬에서만 돌렸다(QA 라운드 4).

운영 데이터나 서비스에 장애를 주입하는 검사는 이번 로컬 검증에 포함하지 않았다.

관련 계약: [자원 소유권](resource-ownership-registry.md)(RO-15),
[실시간 런타임 소유권](realtime-runtime-ownership.md), [신호 생존](signaling-liveness.md),
[보조 ICE 재시작](control-isolation-side-ice-restart-2026-10-19.md),
[4C 보고서](phase4-4c-link-liveness-2026-10-25.md), [4B 보고서](phase4-4b-behaviour-2026-10-25.md),
[4A 보고서](phase4-4a-transport-rejoin-2026-10-24.md), [허용 위험](../known-accepted.md),
[현재 릴리스 기록](../release-record.md).
