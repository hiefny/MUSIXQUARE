# 일반방 전송 통합 릴리스 검증 (8.11.23 / v732)

- Date: 2026-10-19 KST.
- Status: 통합 후보의 로컬 검사와 native 라운드 r1이 사전 기준을 모두 통과했다. 이
  문서는 배포 전 검증 기록이며, 실제 배포 결과는 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이 정본이다.
- 후보: 런타임 `72c588989df33609bcfedf0ee6e29bd6fef10b5b`, 브랜치
  `agent/transport-release-bundle`. 이 보고서를 담은 다음 커밋은 문서만 바꾼다.
- Baseline: 같은 main `deb52829930d0b8a4b87e70b05f84aa7c242c799`.
  운영은 `416f5ee4`, App 8.11.20 / cache v723이다.
- 오너 요청(2026-10-19): PR #410 제어 연결 분리, 지연 기반 수신확인 창, 전송 중 시계
  보호를 일반방 릴리스 하나로 묶고, native 라운드를 한 번 직렬로 돌려 괜찮으면 배포한다.
  보조 연결 ICE restart는 그 라운드 전에 native 검증까지 끝나지 않으면 다음 릴리스로
  넘긴다는 탈출구를 미리 정했다.

## 구성

| 조각 | 출처 | 런타임 |
| --- | --- | --- |
| 제어 연결 분리(별도 RTCPeerConnection), 128→192 KiB 적응 대신 아래 창 사용 | PR #410 C9 | `6a5afaae` |
| 지연 기반 수신확인 창(128–256 KiB, 1청크씩 증감) | `agent/delay-based-credit-window` | `4b83ba14` |
| 창 근거 상한: 128 KiB 초과 창은 2초 또는 16청크 안에 새 표본이 없으면 128 KiB 복귀 | `claude/db-credit-safety-c309eb` | `efec5a89` |
| 전송 중 시계 보호: 표본 보존, 로컬 파일 보정 품질 gate, 강제 재고정 시 표본 보류 | `claude/clock-transfer-guard-f3d4c6` | `14a4a907` |
| #410 재개 검증 기록 | `agent/control-isolation-integration` | 문서 `db407305` |
| App 8.11.23 / cache v732 한 번 상향 | 이 브랜치 | `72c58898` |

[지연 기반 창](delay-based-credit-window-2026-10-19.md),
[시계 보호](transfer-clock-sync-guard-2026-10-19.md),
[제어 연결 분리 제품화](control-isolation-product-integration-2026-10-19.md)에 각 조각의
설계와 단위 근거가 있다. 신규 의존성·스키마·비밀·바인딩·Worker 프로토콜·입장 정책·
CSP 변경은 없다. 보조 연결 ICE restart(`claude/side-ice-restart-1eee23`, 런타임
`05551d1d`)는 이 후보에 넣지 않았다. 망 전환 한계는
[known-accepted #18](../known-accepted.md)에 기록했다.

## 로컬 검사

Windows, Node 24.20.0 / npm 12.0.2, 런타임 `72c58898`:
`typecheck`, `lint`, `format:check`, `build:checked` 통과. 전체 단위 597 files /
13,393 pass / 0 fail / 0 skip(181초). 세 조각을 합친 뒤 충돌은 없었다.

## Native 라운드 r1

합격 기준과 순서는 실행 전에
`scratch/transport-release-bundle-2026-10-19/README.md`에 고정했다. 하네스는 C9 검증의
모듈(실제 제품 협상·파일 입력, CDP P2P shaping, 제어된 YouTube, 수동 관측기)을 그대로
쓰고, 두 곳만 복사본으로 바꿨다.

- 분석기 복사본은 창 집합에 256 KiB를 더하고 확장 요약을 일반화했다. 나머지 판정
  로직은 같다.
- 새 시나리오 `local-file-runner.mts`: 4.8 MB(240초) 로컬 파일을 재생하면서 다음 23 MB
  파일을 프리로드한다. 호스트와 게스트가 같은 PC 시계를 쓰므로, 각 게스트 판정 시각의
  실제 호스트 위치를 직전 SYNC_PONG에서 시계 추정 없이 계산한다. 이로써 게스트의 시계
  오차와 실제 재생 위치 오차를 따로 잰다.

환경: Chromium 153.0.8010.12, baseline `infra/runs/product-r1`(4470), 후보
`infra/runs/candidate-refresh-bundle-r1`(4477, 제공 자산 해시 일치), 로컬 signaling
Worker(8870). 지연은 방향마다 100 ms, 게스트는 연결 전부터 shaping했다.

### 결과

시간은 파일 요청부터 마지막 payload 수신까지다(보조 연결 협상 포함).

| 경우 | Baseline | 후보 | 변화 | 제어 지연 최대 B → C | 재생 |
| --- | ---: | ---: | ---: | ---: | --- |
| 고RTT 8 Mbps 프리로드 | 71.628 s | 47.729 s | −33.4% | 1,224.9 → 177.3 ms | 조작 0, 오차 변화 ≤ 1.05 ms |
| 고RTT 8 Mbps 일반 전송 | 71.546 s | 47.633 s | −33.4% | 1,659.7 → 219.9 ms | 해당 없음 |
| 느린 2 Mbps 프리로드 | 102.557 s | 103.871 s | +1.3% | 1,260.6 → 345.7 ms | 조작 0, ≤ 1.00 ms |
| 급락 8→2→8 Mbps 프리로드(46 MB) | 149.608 s | 117.823 s | −21.2% | 434.3 → 556.8 ms | 조작 0, ≤ 2.65 ms |
| 로컬 파일 재생 중 프리로드, 고RTT | 65.343 s | 33.261 s | −49.1% | 270.3 → 179.4 ms | 보정 0 / 0, 위치 변화 ≤ 9.7 / 6.3 ms |
| 로컬 파일 재생 중 프리로드, 느린 망 | 98.168 s | 98.480 s | +0.3% | 539.8 → 331.6 ms | 보정 0 / 0, 위치 변화 ≤ 8.7 / 10.7 ms |

로컬 파일 두 행의 시간은 둘째 파일 요청부터 게스트 프리로드 완료까지이고, 보정과 위치
변화는 baseline / 후보 순서다. 모든 경우 파일 바이트·SHA·누적 S=R=A·READY/최종
ACK와 수집기 검사가 통과했다.

느린 망 로컬 파일 시나리오에서 98초 전송 동안 게스트의 시계 오차는 baseline이
−38 ~ +3.5 ms로 벌어졌고 후보는 −3 ~ −2 ms에 머물렀다. 60초가 넘는 전송에서 baseline은
조용한 표본을 잃고 비대칭 표본을 골랐지만 이번에는 soft resync 문턱(50 ms × 3회)에
닿지 않았다. 후보는 같은 조건에서 처음의 조용한 표본을 유지했다.
후보의 창은 고RTT와 급락에서 실제로 256 KiB까지 커졌고, 느린 망에서는 설계대로
128 KiB에 머물렀다(성장 조건 미충족). 급락 순간 후보는 창 256 KiB, 미확인 192 KiB
상태였고 1.1초 뒤 128 KiB로 내려갔다. 이때의 대기열 때문에 제어 지연 최대가
baseline보다 122.5 ms 길었지만 절대 기준 1초 안이다. 느린 망의 +1.3%는 payload
구간이 같고(101.5 s) 첫 보조 연결 협상 시간에서 생긴다.

## 판정

사전에 고정한 기준을 모두 통과했다(`results/verdict-r1.json`).

- 속도: 고RTT 프리로드 −33.4%, 일반 전송 −33.4%(기준 20% 이상 단축). 다른 조건의
  최대 증가는 느린 망 +1.3%(기준 10% 이하).
- 반응성: 측정한 모든 응용 제어 그룹의 최대가 1초 미만이다(가장 큰 값은 급락 후보의
  556.8 ms). 기록용 상대 예산(+250 / +100 ms)에도 위반이 없었다.
- 동기화: YouTube 프리로드 세 경우 모두 예기치 않은 플레이어 조작 0회, 자기 무전송
  기준 대비 위치 오차 변화 최대 2.65 ms(기준 10 ms). 로컬 파일 두 경우 후보의
  soft·hard 보정 0회, 위치 변화 최대 10.7 ms(기준 30 ms).

지연 기반 창과 시계 보호 모두 탈출구 조건에 걸리지 않았으므로 셋 다 이 릴리스에
남긴다. 2026-10-19 오너는 이 라운드가 괜찮으면 배포까지 진행하도록 요청했다.

근거 위치(무시되는 로컬 `scratch/`):
`scratch/transport-release-bundle-2026-10-19/`의 `README.md`(사전 기준, SHA256
`baa816f3a4a7a79563670ff960b9ba9855eae77584b92d79265fe7abe0be06c2`),
`results/verdict-r1.json`(SHA256
`368a50ae5b85e2fbf7a0598bda9ab55feee21f5f190c575822d9090b7d456801`)과 경우별 원시 결과,
후보 빌드 manifest `infra/runs/candidate-refresh-bundle-r1/build-candidate-manifest.json`(SHA256
`2e82d7b269a038609946abfb80f417b3cd1e72aef9556b1a3dbead37a6cafa2c`).

## 남은 실기 확인

배포 뒤 폰 두 대와 PC로 다음을 본다: 로컬 파일 재생 중 다음 곡 프리로드, YouTube 재생 중
프리로드, 프리로드 중 일시정지 반응, 같은 주소의 짧은 와이파이 끊김(회복해야 정상),
와이파이에서 LTE로 전환(known-accepted #18대로 재접속 창이 예상된다).

## 한계

- 한 PC의 데스크톱 Chromium과 CDP shaping이다. 실제 Android/iOS, 가청 동기화, live
  YouTube, TURN, 실제 Wi-Fi는 측정하지 않았다. 경우마다 1회다.
- ICE restart 세션의 단위 검사가 08:36 UTC까지 같은 PC에서 돌았다. 앞의 일곱 실행
  (고RTT 두 쌍, 느린 망 쌍, 급락 후보)은 그 부하와 겹쳤을 수 있다. baseline 수치는
  C9 검증(72.0 / 102.4 / 156.4 s)과 비슷했다.
- 이전 라운드의 상대 지연 예산(+250 ms 최대, +100 ms p95)은 이번 기준에서 판정이
  아니라 기록이다. 실행 전 README에 그렇게 고정했다.
- 혼합 버전·취소/재등록·승격·Reconnect 기능 검사는 #410 C9 결과를 재사용한다. 이번
  조각들은 연결 협상과 경로를 바꾸지 않는다.
