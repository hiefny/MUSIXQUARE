# 끊긴 미리받기의 복구 후 재개 (2026-10-20)

- Status: 8.11.25 / v734 런타임 변경과 native 검증 기록이다. 배포 기록이 아니다.
- Baseline: main `2e7d6416` (8.11.24 / v733, 미배포). 수정 `f7ab3c0f`. native 2차는 PeerJS 제한을
  더하기 전의 `ad900e0e`로, 3차는 `c73a52e1`(수정 + 8.11.25 / v734 식별자)로 했다. 릴리스 런타임
  `4e2a26df`는 여기에 [공유 중지 버튼 정렬](stop-sharing-centering-2026-10-20.md)(HTML·CSS만)을 더한다.
- Related: [보조 연결 ICE restart 독립 검증](side-ice-restart-independent-verification-2026-10-20.md),
  [구현 세션 랩](side-ice-restart-native-lab-2026-10-19.md).

## 문제

게스트가 다음 곡을 미리받는 중에 P2P 경로가 끊기면(와이파이 끄기, 망 전환), 방장의 청크
펌프는 그 게스트 연결이 `disconnected`가 되는 즉시 레인을 빼고 PRELOAD_ABORT를 보냈다. 연결이
돌아와도 미리받기를 다시 시작하는 경로가 없어서, 게스트는 다음 곡 차례가 되어서야 파일을 처음부터
받았다. 오너가 운영 8.11.23에서 확인했고, 두 native 랩(구현 세션·독립 검증)의 (c) 시나리오에서도
두 버전 모두 같은 결과였다.

복구 때 다시 보내기만 하면 되지 않는 이유가 두 가지 있다.

- 끊긴 동안 보낸 ABORT는 복구 뒤에야 도착하고, 제어 경로(8.11.23부터 보조 RTCPeerConnection)로
  간다. 재전송의 START는 대용량 경로(원래 연결)로 간다. 두 연결 사이에는 순서 보장이 없고, 망
  전환에서는 보조 연결의 ICE restart가 원래 연결을 통해 신호를 주고받으므로 원래 연결이 먼저
  살아난다. START가 먼저 도착하면 게스트는 진행 중인 세션의 중복 START로 보고 무시하고, 뒤늦은
  ABORT가 그 세션을 버려 재전송 바이트가 모두 버려진다.
- 복구 시점에 게스트가 부분 세션을 아직 갖고 있는지는 방장이 알 수 없다. 게스트는 15초 동안 진행이
  없으면 스스로 세션을 버리는데, 복구 뒤 첫 청크가 2~6초 늦게 오기 때문에(SCTP 재전송 대기로
  보인다) 10초 끊김에서도 버린 경우와 아직 가진 경우가 섞였다(아래 1차 결과).

## 변경

`src/storage/preload.ts`, `src/network/host.ts`, `src/network/protocol.ts`, `src/player/playback.ts`,
`src/types/index.ts`, `src/network/transport/types.ts`, `src/network/transport/cloudflare-signaling.ts`.

- 방장 펌프가 레인을 뺄 때 그 연결이 아직 열려 있고 현재 연결이며 데이터 채널이 열린 채로 ICE가
  `disconnected`(또는 ICE restart 대기 중인 `failed`)이면, ABORT 대신 레인을 **일시 정지**로 기록한다.
  복구를 알리는 연결(`reportsIceRecovery`, Cloudflare 데이터 연결)만 해당한다. PeerJS 어댑터는
  `ice-recovered`를 내지 않으므로 기존처럼 바로 ABORT한다(PR 리뷰 지적). PRO 방과 그 밖의 제외
  사유(정체 30초, 채널 닫힘, 연결 교체)도 기존처럼 바로 ABORT한다.
- 방장은 그 정확한 연결의 ICE 복구를 새 버스 이벤트 `network:peer-ice-recovered`로 알린다. 같은
  연결의 일시 정지 레인이 있고 같은 Blob·queue item·session이 아직 상주하면(`preload.ready`, 또는
  그대로 승격된 `files.current`) 기존 늦은 참가자용 unicast로 0번 청크부터 다시 보내며, START에
  `restart: true`를 붙인다. 연결이 아직 쓸 수 없는 상태에서 온 복구 신호(선택 후보 쌍 변경)는
  무시하고 다음 신호를 기다린다.
- 게스트는 같은 튜플의 살아 있는 부분 세션을 갖고 있을 때 `restart: true` START를 받으면 그 세션을
  놓고 처음부터 받는다. 이미 버린 세션은 기존 명시적 재시도 경로로 받는다. 완료된 세션은 그대로
  둔다. 구버전 게스트는 이 필드를 무시하고 1차 후보와 같이 동작한다(검증기는 모르는 필드를 막지
  않는다). `restart`는 boolean만 통과한다.
- 그 곡을 이미 기다리는 게스트(끊긴 동안 다음 곡으로 넘어간 경우)는 재시작된 같은 세션의 진행을
  새 시작점부터 센다. 전에는 이전 최고 진행률을 넘어야만 진행으로 보아 10초 대기 타이머가 중복
  복구를 요청할 수 있었다.
- 그 튜플을 버리는 모든 경로는 미뤄 둔 ABORT를 보낸다: 미리받기 취소(현재 곡으로 넘어간 전송을
  보존하는 경우 제외), 전송 owner 종료·원본 읽기 실패, 수신 권한 초기화, 같은 게스트의 더 새 레인
  일시 정지, 복구 시점에 튜플이 더 이상 상주하지 않는 경우. 연결이 끊기거나 교체되면 기록만 지운다.

비용과 범위: 재전송은 처음부터 보내므로 게스트가 이미 받은 앞부분만큼 더 전송한다(아래 실험에서
약 7 MB). 끊긴 동안 새로 시작한 미리받기(그 게스트가 처음부터 빠진 경우)는 이번 범위가 아니다.

## 단위 근거

새 동작 테스트 13개: `src/storage/__tests__/preload-lane-ownership.test.ts` 10개(방장 8·게스트 2),
`src/network/__tests__/host.test.ts`, `src/network/__tests__/protocol.test.ts`,
`src/player/__tests__/concurrency-invariants.test.ts` 각 1개. 원래 코드(`2e7d6416`)에서는 새 동작
8개가 실패한다(복구 후 재전송과 `restart` 표시, 쓸 수 없는 복구 신호 대기, 승격 뒤 재개, 교체된 연결
무시, 정확한 연결에만 복구 알림, `restart` 값 검증, 게스트의 살아 있는 세션 재시작, 재시작된 세션의
대기 진행). 기존 동작 고정 5개(취소 시 ABORT, 상주하지 않으면 ABORT, 연결된 채 정체한 레인은 바로
ABORT, 복구를 알리지 않는 PeerJS형 연결은 바로 ABORT, 완료된 세션은 재시작 무시)는 원래 코드와 최종
코드 모두 통과한다. PeerJS형 고정은 리뷰 지적 전 후보 `ad900e0e`에서는 실패한다. Cloudflare 데이터
연결이 `reportsIceRecovery`를 내는지는 transport 테스트에 고정했다.

PR CI의 critical runtime coverage는 preload.ts에 `preload.test.ts`만 돌려, 처음에는 함수 커버리지
83.92%로 기준 84%에 못 미쳤다. 같은 일시 정지·재개·미뤄 둔 ABORT 경로를 그 파일에도 2개 더했다.

`c73a52e1`, Windows 11, Node 24.20.0 / npm 12.0.2: typecheck·lint·format:check 통과, 전체 단위
597 files / 13,437 pass / 0 fail / 0 skip, `build:checked`(v734 cache guard 포함)와
bus-pairing·dead-exports·chunk-pump·import-graph·lifecycle-writes·standard-room-hot-path 가드 통과,
critical runtime coverage 통과(preload.ts 함수 86.6%).

## Native 검증

### 방법

독립 검증 세션의 하네스(`interruption-runner.mts`, `ice-probe.mts`, `interruption-analysis.mts`)를
바이트 그대로 복사해 시나리오 (c)를 같은 방식으로 실행했다. Windows 11, headless Chromium
153.0.8010.12, 한 PC의 호스트·게스트 페이지, 실제 제품 협상과 파일 입력. 파일 A(240초, 4.8 MB)를
직접 전송으로 재생하는 중에 파일 L(23.0 MB)을 다음 곡으로 넣고, 게스트가 L의 30% 이상을 받은 순간
게스트 페이지의 P2P만 CDP `offline` 규칙으로 10초 또는 17초 끊은 뒤 복구했다(시그널링 유지, 100 ms /
1 MB/s). 복구 후 100초까지 완료를 기다린 뒤 일시정지·재생을 네 번 눌렀다. 두 빌드는 정확한 커밋에서
e2e 모드로 만들어 루프백에서 띄웠다. 10초 끊김은 게스트의 15초 진행 감시보다 짧고, 17초는 길다.

판정 기준 정정: 실행 전 절차서는 주 기준을 "분석기 C5: 게스트가 L을 정확한 바이트·SHA로 갖는다"로
적었지만, 분석기의 C5는 모든 청크가 한 번씩만 도착해야 통과한다(독립 검증에서 "재개 없이 완료"를 뜻한
기준). 처음부터 다시 보내는 후보는 구조적으로 이를 통과할 수 없다. 2번째 실행 직후, 나머지 결과를
보기 전에 이 불일치를 기록하고 원시 기록의 `waitOutcome = completed`와 `blobMatched = true`(정확한
바이트·SHA-256)로 판정을 고정했다. 분석기 C1–C4(대화상자·연결 유지·재생 지속·조작 전달)와 유효성은
그대로 쓴다. 분석기 C5 판정은 모두 기록해 둔다.

### 1차: 방장만 고친 후보 (`be95b45a`)

| 실행 | 결과 | 정확한 파일 | 복구 후 완료 | 받은 청크 / 바이트 | START / ABORT / END |
| --- | --- | --- | --- | --- | --- |
| 10초 baseline | 시간 초과 | 아니요 | - | 110 / 7.2 MB | 1 / 1 / 0 |
| 10초 후보 | 완료 | 예 | 51.3초 | 462 / 30.2 MB | 2 / 0 / 1 |
| 17초 후보 | 완료 | 예 | 49.2초 | 461 / 30.2 MB | 2 / 0 / 1 |
| 17초 baseline | 시간 초과 | 아니요 | - | 109 / 7.1 MB | 1 / 1 / 0 |
| 10초 후보 반복 | **시간 초과** | 아니요 | - | 461 / 30.2 MB | 2 / 0 / 1 |
| 17초 후보 반복 | 완료 | 예 | 46.9초 | 463 / 30.3 MB | 2 / 0 / 1 |

6회 모두 유효했고 C1–C4는 모두 통과했다. 후보 하나가 실패했다. 그 실행에서는 복구 뒤 첫 청크가
3.4초에 와서 게스트가 부분 세션(109/352)을 아직 갖고 있었고, 재전송 START를 중복으로 무시한 채
7.1 MB 앞부분을 다시 받는 15초 넘게 진행이 없어 게스트 감시가 T0+31.9초에 세션을 버렸다. 나머지 세
후보 실행은 감시가 먼저 세션을 버려 재전송을 명시적 재시도로 받았다. 이 1차 후보의 동작은 새 방장과
구버전 게스트 조합의 동작과 같다.

### 2차: 게스트 재시작을 더한 후보 (`ad900e0e`)

| 실행 | 결과 | 정확한 파일 | 복구 후 완료 | 받은 청크 / 바이트 | 게스트 경로 |
| --- | --- | --- | --- | --- | --- |
| 10초 a | 완료 | 예 | 48.4초 | 463 / 30.3 MB | 살아 있는 세션을 restart START로 놓고 재시작 |
| 17초 a | 완료 | 예 | 47.5초 | 463 / 30.3 MB | 감시가 먼저 세션을 버림 → 명시적 재시도 |
| 10초 b | 완료 | 예 | 47.6초 | 462 / 30.2 MB | 살아 있는 세션 재시작 |
| 17초 b | 완료 | 예 | 46.6초 | 462 / 30.2 MB | 명시적 재시도 |
| 10초 c | 완료 | 예 | 52.4초 | 462 / 30.2 MB | 살아 있는 세션 재시작 |

실행 전에 정한 기준(5회 모두 유효, C1–C4 통과, 정확한 파일로 완료)을 통과했다. 1차에서 실패한 경로
(재전송 때 게스트가 부분 세션을 아직 가진 경우)를 10초 세 번 모두 탔고 모두 완료했다. 모든 후보
실행에서 PRELOAD_ABORT는 0회, START는 2회(원래·재전송), END는 1회였다. 재전송의 대가로 약 7 MB를
더 받았고, 이 1 MB/s·100 ms 조건에서 복구 뒤 완료까지 46.6~52.4초였다. 같은 조건의 baseline은 복구 뒤
100초 안에 완료하지 못했다(1차). 분석기 C5는 중복 청크 때문에 모두 실패로 기록돼 있다.

### 3차: 최종 런타임 (`c73a52e1`)

PR 리뷰 지적(PeerJS는 `ice-recovered`를 내지 않아 일시 정지된 레인이 영영 풀리지 않을 수 있음)을
반영해 복구를 알리는 연결에서만 일시 정지하게 했다. Cloudflare 경로의 동작은 2차와 같아야 하므로,
그 표시가 실제 제품 연결에서 보이고 일시 정지가 그대로 걸리는지 확인했다.

| 실행 | 결과 | 정확한 파일 | 복구 후 완료 | START / ABORT / END | C1–C4 |
| --- | --- | --- | --- | --- | --- |
| 10초 | 완료 | 예 | 48.1초 | 2 / 0 / 1 | **C3 실패**(아래) |
| 17초 | 완료 | 예 | 47.1초 | 2 / 0 / 1 | 통과 |
| 10초 보조 | 완료 | 예 | 50.2초 | 2 / 0 / 1 | 통과(재생 오차 최대 7.3 ms, 보정 0) |

세 실행 모두 실제 제품 연결에서 일시 정지가 걸렸고(ABORT 0, START 2) 정확한 파일로 완료했다. 다만
실행 전에 정한 3차 기준(2회 모두 C1–C4 통과)은 10초 실행의 C3 때문에 실패다. 그 실행에서 게스트는
파일 A 재생 약 11초째, 끊김과 다음 곡 추가보다 앞선 조용한 구간에 MediaSession `pause` 동작을 받아
로컬 일시정지 상태가 됐고, 이후 동기 판정이 모두 `local-pause`로 건너뛰어져 C3 잔차를 계산할 수
없었다. 이 플래그를 켜는 곳은 MediaSession 일시정지 처리 두 곳뿐이고, 이번 변경은 MediaSession·로컬
일시정지·동기 코드를 건드리지 않는다. 같은 PC에 들어온 운영체제 미디어 컨트롤 입력으로 판단해 기록을
그대로 두고, 실행 전에 선언한 보조 실행 1회를 더했다. 보조 실행은 C1–C4를 모두 통과했다.

## Release and recovery

- PR [#413](https://github.com/hiefny/MUSIXQUARE/pull/413) squash merge → main `e371df6b`. 최종 PR head `20ae6dae`의 CI 39305102783
  11 jobs 통과. main 트리는 PR head와 같고, 런타임은 로컬 검사한 `4e2a26df`와 같다(차이는 문서뿐).
  첫 PR CI의 critical runtime coverage 실패(preload.ts 함수 83.92%)는 테스트를 더해 고쳤다.
- Exact-main push CI [39306522982](https://github.com/hiefny/MUSIXQUARE/actions/runs/39306522982) 12 jobs 통과: unit 597 files /
  13,436 pass / 0 fail / 1 Windows-only skip, candidate browser 17 + critical browser 55 pass.
  후보 artifact 12213268474.
- [Production Release 39307533720](https://github.com/hiefny/MUSIXQUARE/actions/runs/39307533720) attempt 1 성공, target=app,
  Developer API D1=false. 2026-10-20 04:04:24 KST deploy job 완료. App version
  `50b772a9-5081-4333-b681-f39e4babc713` / deployment `53a6e14e-4ccd-4f2a-a6bd-f11c381cb1aa`, 최종 소유권
  04:04:19.249 KST verified, 부분 릴리스 recheck compatible, smoke 4/4, 기존 App D1 계약 7단계
  apply/verify 성공.
- 04:04 KST 공개 8 GET 모두 HTTP 200, exact-main 후보와 크기·SHA 일치(서비스 워커 v734, 미리받기 청크
  `preload-Cq_e08I6.js` 포함). 배포 직후 Drift Audit 39308004289: 31 pass / 0 fail / 5 manual-only.
- 복구: 04:03:04.101 KST checkpoint 12215170019가 App 8.11.23/v732(`2f9cd799`, version `a72fa56e` /
  deployment `95fab3bb`)를 보존한다. 롤백은 미실행이다. 롤백하면 새로고침한 클라이언트는 보조 연결 ICE
  restart, 끊긴 미리받기 재개, 공유 중지 정렬을 잃는다. 저장 데이터 마이그레이션은 없다.
- 남은 확인: 오너 실기 와이파이→LTE(허용 위험 #18), 미리받기 중 끊김, 공유 중지 정렬. 릴리스 기록 §2의
  실기기 항목에 있다.

## 한계

한 PC 루프백 Chromium과 CDP `offline` 규칙이다. 실제 Wi-Fi·LTE 전환, IP 변경, TURN, Android/iOS는
배포 뒤 오너 실기 확인으로 남긴다. 끊긴 동안 다음 곡으로 넘어간 경우, 구버전 게스트, 취소·교체 경로,
PeerJS 연결의 즉시 취소는 단위 테스트와 1차 결과로만 확인했다. 재전송은 앞부분을 다시 보내므로 느린 링크에서 완료가 그만큼
늦다. 근거는 무시되는 로컬 `scratch/preload-resume-2026-10-20/`(`PROCEDURE.md`, `NOTES.md`,
`results/`)에 있다.
