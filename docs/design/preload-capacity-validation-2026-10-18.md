# 프리로드 64 KiB 후보: 느린 망·다수 수신자·수명 검증

- Date: 2026-10-18 KST.
- Status: 성능 비교 완료·무결성 및 수명 회귀 통과. App 8.11.19/v721 배포 완료.
  느린 망·실기기 지연을 모두 해결한 릴리스는 아니다.
- Owner decision: 느린 망, 여러 수신자, 취소, 다음 곡 승격을 확인하고 문제가
  없으면 프리로드 64 KiB 최소 변경을 적용·검증·배포한다. 원인 미확정 실패는
  성공한 재실행으로 덮지 않으며 배포를 중단한다.
  추가 결과를 설명한 뒤 오너는 64 KiB를 한계와 함께 문서화해 계속 배포하고,
  간헐적인 느린 게스트의 원인과 경로 분리 필요성은 별도로 조사하도록 지시했다.
- Candidate base: `cb484879b3e8608d0191d3ecde6cd7bf136f75b9`
  (App 8.11.18 / cache v720의 배포 기록 main).
- Runtime/test candidate: `f5ea13785abb199037ed13877619dabf2418db91`.
  전체 unit 최종 실행 tree는 로컬 예비 커밋 `ddcd12a9`와 같으며 runtime/test
  파일 diff가 0임을 확인했다. 게시 전 캐시 bump와 bootstrap 수정이 하나의
  covering commit에 들어가도록 정리했다.
- Local environment: Windows, Node 24.13.1 / npm 11.8.0; native comparison
  Chromium 153.0.8010.12. CI의 고정 Node 24.20.0 환경 결과는 별도로 확인한다.
- Existing A/B builds: `256f1f92988248462de857dd69232bda8c7ea474`,
  runtime `e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b`.
  이후 main 변경은 setup UI와 관련 테스트·버전·문서이며 preload/공유 pump는 같다.
- Related: [최초 후보](preload-control-priority-investigation-2026-10-18.md),
  [Windows·Pixel 재시험과 한계](preload-local-pixel-retest-2026-10-18.md).

## 범위와 판정

제품 후보는 `src/storage/preload.ts`의 broadcast와 late-join unicast가 동일한
64 KiB capacity 기준을 사용하도록 하는 변경이다. wire 청크, 프로토콜, 수신 경계,
현재 파일 송신 정책, 30초 stall timeout, PRO/R2 경로는 변경하지 않는다.

느린 망은 native RTC echo/바이트 전송에서 제한이 실제로 작동하는지 먼저
확인한다. HTTP 요청만 제한하거나 JS 수신 handler를 늦춘 것을 느린 WebRTC 망으로
보고하지 않는다. 성능 비교 중 빌드·다른 부하 시험은 병행하지 않는다.

각 수신자의 파일 바이트·SHA·ACK와 전달 경로를 확인하고, 제어 메시지의
send→message와 message→handler를 나눠 기록한다. 여러 수신자 중 하나가 느릴 때
나머지 전송이 그 수신자의 완료를 기다리지 않는지도 확인한다. 성능 비교에서는
재생 provider가 실제인지 제어된 대역인지 구분하며 가청 싱크로 확대하지 않는다.

취소·채널 교체·다음 곡 승격은 대기 중인 송신이 오래된 session에 적용되지 않는지,
승격된 전송이 사라지지 않는지와 후속 전송이 진행하는지를 검사한다. 처리량 감소나
제어 지연 악화가 관측되면 순서·부하·경로·계측 원인을 확인하고 그대로 기록한다.
반복 검사가 처음 실패의 원인 설명을 대신하지 않는다.

## 검증 결과

예정한 native RTC 6조건·38개 수신 파일 비교와 수명 회귀 검증을 완료했다.
무결성은 모두 통과했고 상대 지연 개선을 확인했지만, 일부 수신자의 수초 지연과
느린 경로의 병목은 남았다. 아래 결과와 한계를 근거로 최소 완화를 배포했다.
기존 지연의 잔존과 변경으로 새로 생긴 회귀를 구분하며, 모든 환경에서
1–3 ms를 보장하는 것을 승인 조건으로 새로 만들지 않는다.

### 느린 RTC 망 계측의 유효성

Chromium CDP `Network.emulateNetworkConditionsByRule`의 빈 URL 패턴으로
P2P에 제한을 걸었다. HTTP/HTTPS/WebSocket 요청은 별도 무제한 규칙으로
분리했으며, RTC 생성 전 무제한 규칙을 등록하고 안정화 뒤 제한을 적용했다.
실제 RTC echo와 4 MiB 파일의 SHA를 사용해 제한과 해제를 확인했다.

| guest측 profile | echo RTT 중앙값: 전 → 제한 → 해제 | 4 MiB 완료: 전 → 제한 → 해제 | 무결성 |
| --- | --- | --- | --- |
| slow8: 각 방향 1,000,000 B/s, latency 40 ms | 1.4 → 99.6 → 0.7 ms | 277.4 → 5,060.1 → 111.8 ms | 전부 일치 |
| slow2: 각 방향 250,000 B/s, latency 100 ms | 0.8 → 220 → 1.2 ms | 3,883 → 22,249 → 117 ms | 전부 일치 |

slow2는 실제 수신 약 0.189 MB/s였다. 명목 대역폭과 실효 속도는 같지 않다.
이는 Chromium P2P 제한의 확인이며 실제 인터넷·모바일 회선의 동일성을 뜻하지
않는다. 원본은 `scratch/preload-validation-2026-10-18/`에 보존한다.

### 8명 동시 수신: 첫 비교 (256 → 64)

Windows의 한 Chromium 실행에서 host 1 + guest 8, native RTC direct, 23,040,044 B
WAV를 사용했다. YouTube는 시간이 진행하는 제어된 provider이며 실제 영상·가청
품질 비교가 아니다. 두 실행 모두 8명 각각 352청크·전체 SHA·host ACK 1회,
현재 YouTube 모드/곡/PLAYING 상태를 통과했다.

| guest | 256 KiB 최대 heartbeat 지연 | 64 KiB 최대 heartbeat 지연 | 256 파일 완료 | 64 파일 완료 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 3,157 ms | 172 ms | 6,882 ms | 4,671 ms |
| 2 | 2,091 ms | 161 ms | 4,959 ms | 4,875 ms |
| 3 | 4,035 ms | 94 ms | 7,695 ms | 4,674 ms |
| 4 | 2,681 ms | 3,706 ms | 6,305 ms | 6,581 ms |
| 5 | 1,927 ms | 3,526 ms | 4,090 ms | 6,444 ms |
| 6 | 4,917 ms | 2,854 ms | 8,253 ms | 6,350 ms |
| 7 | 4,988 ms | 20 ms | 8,299 ms | 4,349 ms |
| 8 | 2,613 ms | 24 ms | 6,214 ms | 4,819 ms |

각 peer의 native send와 receive를 peer ID + 전체 wire payload로 일대일 매칭했다.
미매칭 0, heartbeat 15개/peer이며 최댓값은 첫 청크 송신 약 1.16–1.19초 뒤
송신한 heartbeat에서 발생했다. 전송 종료 뒤에는 1–2 ms로 복귀했다. 독립
재계산도 일치했다. host event-loop lag 최대 18.2 ms, guest 최대 24.7 ms,
long task 0, 동일 PC wall−performance 기준 변동 0.9–1.1 ms여서 이 로그에서
초 단위 지연을 JS 메인 스레드나 벽시계 오차로 설명하기 어렵다.

host의 고유 selected candidate 8개 `packetsDiscardedOnSend` 합계는 2,779/7,963이다.
**연결 이후 누적값이며 전송 전후 차이가 아니다.** 첫 실행에는 전송 전 stats가
없어 전송 delta는 재구성할 수 없다. 64 KiB의 지연 큰 peer 4/5/6은 누적
138/177/112, 다른 빠른 peer는 817–2,474여서 이 합계를 특정 heartbeat 지연의
원인이나 네트워크 손실로 단정할 수 없다. 선택 후보 중복 합산은 없었다.

원본: `multi-direct8-controlled-r1-{baseline,window64,summary}.json`,
`multi-direct8-controlled-r1-run.log`, 독립 검토 `multi-independent-review.json`.
역순(64 → 256)의 8명 비교도 완료했으며 아래 별도 절에 기록한다.
첫 쌍의 guest 번호는 서로 다른 세션의
연결 순번이므로 동일한 물리 기기의 짝지은 표본으로 취급하지 않는다. 같은
broadcast의 수신자들도 독립 표본 8회가 아니다.

### 3명 중 1명 slow2 (256 → 64)

guest 3에만 위 slow2 제한을 적용했다. 각 조건 130초 관측, 180초 case 상한,
provider 길이 300초로 파일 완료 이전의 자동 종료와 측정 종료를 피했다.
6개 파일 모두 352청크·전체 SHA·host ACK 1회, 재생 모드/곡/PLAYING 유지에
통과했다. 빠른 두 수신자가 느린 수신자의 완료를 기다리지 않았다.

| 수신자 | 256 최대 heartbeat 지연 | 64 최대 heartbeat 지연 | 256 파일 완료 | 64 파일 완료 |
| --- | ---: | ---: | ---: | ---: |
| 빠른 1 | 662 ms | 3 ms | 2,480 ms | 1,372 ms |
| 빠른 2 | 1,178 ms | 2 ms | 3,061 ms | 1,350 ms |
| 느린 3 | 19,924 ms | 19,677 ms | 96,757 ms | 96,706 ms |

빠른 두 수신자의 전송 중 heartbeat 표본은 각 1개뿐이다(64는 전송 중에는
둘 다 1 ms, 위 표는 전체 관측 최댓값). 느린 수신자는 양 조건 각각 전송 중
33개 표본, 중앙값 18,382 → 17,921 ms로 기존 지연 패턴이 거의 그대로 남았다.
누적 host discard는 708 → 0이며, 0도 제어 우선순위 보장을 뜻하지 않는다.

slow2는 CDP에 packetLoss=0, packetQueueLength=0으로 설정했다. 추가 손실을
주입하지 않고 해당 옵션으로 큐 길이를 제한하지 않은 조건이며, 실제 패킷 손실이
0이거나 Chromium 내부 큐·버퍼 상한이 없다는 뜻은 아니다. 따라서 특정 Wi-Fi나
모바일망의 지연을 예측하는 수치가 아니라 통제된 P2P 대역폭·지연 조건의
A/B 결과다. 64 KiB만으로 느린 경로의 큐 지연을 해결했다고 주장하지 않는다.
원본은 `multi-mixed3-slow2-r1-{baseline,window64,summary}.json`과 실행 로그다.

### 8명 동시 수신: 역순 비교 (64 → 256)

같은 fixture·provider·native RTC 구성으로 순서만 뒤집어 각각 새 방에서
비교했다. 16개 파일의 청크·SHA·ACK·재생 상태 검증이 모두 통과했다.

| guest | 256 최대 heartbeat 지연 | 64 최대 heartbeat 지연 | 256 파일 완료 | 64 파일 완료 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2,071 ms | 2 ms | 5,846 ms | 5,655 ms |
| 2 | 2,922 ms | 770 ms | 7,462 ms | 6,174 ms |
| 3 | 1,495 ms | 41 ms | 3,508 ms | 4,336 ms |
| 4 | 3,121 ms | 3 ms | 7,586 ms | 3,491 ms |
| 5 | 2,803 ms | 9 ms | 7,250 ms | 4,886 ms |
| 6 | 1,730 ms | 1 ms | 4,611 ms | 4,603 ms |
| 7 | 2,050 ms | 487 ms | 5,782 ms | 6,009 ms |
| 8 | 3,411 ms | 15 ms | 7,696 ms | 4,462 ms |

위 770 ms는 YouTube heartbeat만의 최댓값이다. 시계 응답을 포함한 전체
제어 프레임의 최댓값은 256 **3,494 ms**, 64 **2,511 ms**였다. 시계 응답의
지연도 동기화에 중요하므로 770 ms를 모든 제어 메시지의 상한처럼 사용하지 않는다.
첫 8명 쌍의 전체 제어 최댓값은 256 5,051 ms / 64 3,706 ms다.

이번에는 preload 송신 직전 stats를 캡처했다. host 8개 PC의 선택 후보가
바뀌지 않았고 카운터는 각각 0에서 시작했다. 전송 구간 discard 증가량은
256 2,947 / 64 3,308이었다. 첫 쌍과 함께 64에서 카운터 증가가 더 큰 관측은
남기되, 이 값으로 제어 프레임의 손실·재전송 또는 앱 회귀를 확정하지 않는다.
host main-thread lag 최대는 256 17.2 ms / 64 15.8 ms였다.

이번 native RTC 비교 총 6조건, 38개 수신 파일은 모두 검증 통과, 실행 실패·skip 0,
불필요한 재생 API 호출·foreground handoff·pageerror 0이다. YouTube provider가
제어된 대역이므로 실제 YouTube 버퍼링·가청 싱크 검증을 대신하지 않는다.
정적 preview의 `/api/*` 503 및 Wake Lock 거부 등 환경 로그는 원본에 보존하며
모든 HTTP 요청이 정상이라고 주장하지 않는다.

원본: `multi-direct8-controlled-reverse-r2-{baseline,window64,summary}.json`,
전체 manifest `multi-validation-manifest.json`, 축약 비교
`multi-validation-compact-analysis.json`. 성능 실행은 순차로 진행했고 모두 종료했다.

### 취소·다음 곡 승격·기존 기능

새 `preload-capacity-lifecycle.test.ts` 8개는 첫 실행 통과했다. Broadcast/unicast
각각 64 KiB+1 대기와 정확한 경계 재개, 대기 중 취소와 늦은 구세션 청크 격리,
정확한 data channel 교체, 다음 곡 승격 뒤 후속 unicast 직렬화를 검사한다.
실제 Cloudflare adapter의 인코딩·채널 선택과 수신 protocol을 사용한다.
RTCDataChannel은 EventTarget 기반의 결정론적 facade이며 queued bytes·low-water
이벤트·채널 교체와 전달 순서를 테스트가 제어한다. 승격은 START 다음 PLAY_PRELOADED를
수신시켜 AWAITING_PRELOAD에 들어간 뒤 나머지 바이트·ACK와 decode handoff를
검사한다. 네이티브 오디오 디코더는 이 테스트의 범위 밖이다.

관련 storage 10 files / 169 tests도 첫 실행 통과했다(신규 8개 포함).
기존 256 KiB를 메모리 변환으로 주입하면 신규 8개가 모두 의도대로 실패했다.
이는 더 작은 capacity에서 기다리는 경계를 실제로 검출한다는 뜻이다. 실제 제품
소스는 64 KiB로 유지했다. 처음 변이 config의 include 병합이 전체 suite를
선택한 하네스 실수는 즉시 중단하고 exact file CLI 필터로 고쳤다. 중단 실행은
통과/실패 수치에 포함하지 않았다. 신규 파일 lint/format/type 검사도 통과했다.

첫 전체 unit 실행은 584 files / 13,054 pass / 1 fail / 0 skip이었다.
원인은 cache manifest를 v721로 갱신하면서 `index.html`의 bootstrap URL을
v720으로 남긴 릴리스 준비 누락이다. `claim-bootstrap.test.ts`의 source 문서
검사가 정확히 이 불일치를 검출했다(임시 dist 또는 네트워크 원인이 아니다).
URL을 v721로 고친 최종 tree는 **584 files / 13,055 pass / 0 fail / 0 skip**,
156.69초로 전체 재검사를 통과했다. 원본 `full-unit.log`와
`full-unit-validated.log`를 모두 보존한다. 타입·lint·format 전체 검사와 Worker
syntax·Developer API boundary·D1 migration·Operations Drift source 계약도 통과했다.

첫 `build:checked`는 bootstrap 수정 커밋이 캐시 bump 커밋보다 뒤라서 cache-history
guard에 중단됐다. 소스 기능 실패가 아니라 covering-commit 규칙의 실제 위반이었다.
아직 push하지 않은 본 작업의 두 커밋만 하나로 정리했고 제품/test tree 변화는 없다.
원본 `build-checked.log`를 보존하며 정리한 HEAD에서 `build:checked`를 통과했다
(`build-checked-validated.log`, v721 / app-shell 97개). Chunk-pump·lifecycle-writes·
standard-room-hot-path guard도 통과했다.

같은 최종 runtime tree를 `build:e2e`하여 Windows Chromium에서 `preload.test.ts`,
`preload-queue-mode-cancellation.test.ts`, `late-join.test.ts`를 실행했다.
**19 pass / 0 fail / 0 skip**, 1.9분, retries=0이다. 새 중단/승격 핀 외에
실제 브라우저의 승격 후 repeat 변경, 다음/이전 MP3 재생, 늦은 참여·메타데이터
전달을 검증했다. 원본 `e2e-targeted.log`를 보존한다. 이번 전체 serial E2E와
실제 iPhone/Android 음향 비교는 미실행이다. PR와 exact-main CI 결과는 아래에
별도로 기록한다.

## 상대 효과와 릴리스 판단

독립 검토에서도 native frame 매칭·38개 SHA/ACK·제어 프레임 전체 집계가
일치했다. 8명 두 쌍의 전체 control 최대는 5,051 → 3,706 ms,
3,494 → 2,511 ms, peer별 전체 control 최댓값 중앙값은
3,022.5 → 166.5 ms, 2,655.5 → 365.5 ms였다. 여러 peer가 하나의 broadcast를
공유하므로 독립 실험 16회나 통계적 보장으로 확대하지 않는다.

판단은 **유효한 최소 완화 + 기존 느린 망 병목 잔존**이다. 무결성·취소·승격
검사와 상대 지연 개선을 근거로 64 KiB 최소 변경을 배포했다.
앞서 첫 8명에서 관측한 잔여 지연을 신규 회귀로 단정하지 않는다. 반대로
discard 증가와 Pixel의 변동도 지우지 않으며, 모든 플랫폼에서의 개선 또는
회귀 0을 보장하지 않는다. 실제 Android 가청 싱크와 느린 연결의 제어 우선순위는
계속 열린 조사 항목이다. 추가 pacing·프로토콜·전체 큐 제어는 이번 변경에
끼워 넣지 않는다.

## 배포 범위와 복구

App 8.11.19 / cache v721의 App-only 릴리스, Developer API D1=false가 배포 범위다.
새 의존성·스키마·바인딩·비밀·서버 계약 변경은 없다. 구신 클라이언트가 동일한
파일 프로토콜을 사용한다. 성공한 exact-main CI 후보와 정식 Production Release가
필요하며 scratch/로컬/PR 검사는 그 후보를 대신하지 않는다.

## Release and recovery

PR [#397](https://github.com/hiefny/MUSIXQUARE/pull/397)의 최종 head `36a2cb19`는
[PR CI 39074385931](https://github.com/hiefny/MUSIXQUARE/actions/runs/39074385931)
11 jobs와 Codex 자동 리뷰(지적 0건)를 통과했다. 2026-10-18 07:22:30 KST에
`eea5a842c1d1b9cd51b845f95de24b1059378bae`로 squash merge됐고, 해당 tree는
검토한 PR head와 같았다.

Exact-main push [CI 39074808159](https://github.com/hiefny/MUSIXQUARE/actions/runs/39074808159)
attempt 1은 11 jobs success, unit 584 files / **13,054 pass / 0 fail / 1 skip**,
candidate browser **17 pass**, critical browser **55 pass**였다. Skip은 Linux에서
실행할 수 없는 Windows 다른 드라이브 경로 거부 검사
`pro-grant-campaign-cli.test.ts`다. 로컬 Windows에서는 해당 검사도 통과했다.
Coverage·타입·lint·정적·빌드·보안 gate도 모두 통과했다.

[Production Release 39075260878](https://github.com/hiefny/MUSIXQUARE/actions/runs/39075260878)
attempt 1은 main 동일성과 위 CI 성공을 확인한 뒤 `target=app`,
`apply_developer_api_d1=false`로 실행했다. Immutable candidate
[12116097905](https://github.com/hiefny/MUSIXQUARE/actions/runs/39074808159/artifacts/12116097905),
Node 24.20.0 / npm 11.19.0 / Wrangler 4.148.0을 사용했다.

- 07:30:21.538 KST recovery checkpoint captured
  ([artifact 12117026048](https://github.com/hiefny/MUSIXQUARE/actions/runs/39075260878/artifacts/12117026048)).
  직전 App 8.11.18/v720, `06e26645`, version `8c72ce0e-4500-4a9f-9433-dec671458490`,
  deployment `fc8c0c4f-6d19-4606-9000-7c29c839beb0`를 보존한다.
- 07:30:23.381 KST floor ready: release `d9364cd9`, generation `4c5612d5`,
  generation/entitlement true, 이전 App provenance verified-release-ancestor.
  07:30:58.887 KST 부분 릴리스 recheck compatible; 미선택 5 Worker는 그대로다.
- App version `89f8574e-88e3-4268-bc63-f16d302b535b` /
  deployment `9d3dfb4d-c050-4c6f-b69f-e424c64fd3f2`, 100%, exact Git message.
  최종 소유권 07:31:26.603 KST verified, coherent marker 기록.
- 운영 smoke **4/4 pass**: App generation, 익명 App 계정 경계,
  기존 PRO 공개 경계, Standard HTTPS signaling. 기존 App D1 7단계 통과,
  Developer API D1과 범위 밖 Worker smoke는 skip.
  Deploy job은 **07:31:33 KST** 성공, rollback 불필요·미실행,
  recovery job skipped. [배포 원본 12115924108](https://github.com/hiefny/MUSIXQUARE/actions/runs/39075260878/artifacts/12115924108),
  [coherent marker 12116228257](https://github.com/hiefny/MUSIXQUARE/actions/runs/39075260878/artifacts/12116228257).

07:31:46.747 KST 공개 GET 7개 모두 HTTP 200, exact-main 후보의 크기·SHA-256과
일치했다. 새 preload 코드가 실제 제공되는지도 포함한다.

| 공개 경로 | bytes |
| --- | ---: |
| `/` | 140,676 |
| `/service-worker.js` (v721) | 39,149 |
| `/bootstrap.js?cache=v721` | 10,196 |
| `/assets/main-C0gKKzPa.js` | 437,646 |
| `/assets/main-8_J0N3SU.css` | 324,945 |
| `/assets/preload-BxeR3twh.js` | 31,848 |
| `/assets/preload-helper-t6vPaeH_.js` | 1,599 |

배포 후 [Operations Drift Audit 39075446325](https://github.com/hiefny/MUSIXQUARE/actions/runs/39075446325)
attempt 1은 exact deployed SHA에서 **31 pass / 0 fail / 5 manual-only**,
automated-checks-passed(07:32:21 KST)다. Manual 항목과 실제 Android/전체 serial
E2E 한계는 열린 상태로 남긴다. 로컬 검사·CI·배포·공개 GET·Drift 원본은
`scratch/preload-validation-2026-10-18/`에 보존한다.

복구 시 checkpoint의 8.11.18/v720으로 돌아가면 preload 송신 기준도 256 KiB로
돌아가 이번 완화를 잃는다. 저장 데이터·wire 변경은 없다. 정식 절차로 소유권과
floor를 다시 확인해야 하며 checkpoint는 사용자 데이터 백업이 아니다.

별도 [native RTC 원인 조사](preload-control-queue-root-cause-2026-10-18.md)는
앱 없이 같은 PC의 초 단위 지연을 재현하고 별도 PC·수신 credit의 효과를 확인했다.
그 진단 프로토콜은 이번 배포에 들어가지 않았다. 후속 기록 PR만으로 추가
Production Release를 실행하지 않는다.
