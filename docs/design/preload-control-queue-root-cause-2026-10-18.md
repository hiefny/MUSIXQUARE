# 프리로드 제어 지연: native RTC 큐·연결 분리 조사

- Date: 2026-10-18 KST.
- Status: 무제한 로컬 native RTC 7조건과 느린 guest A/C 보조 2조건 완료,
  총 9 pass / 0 fail / 0 skip. 파일 전송은 각각 48/48과 6/6, 총 54/54의
  바이트·청크 수·SHA-256·최종 ACK가 일치했다.
- Scope: 앱·YouTube·시그널링 서버 없이 실제 RTCDataChannel만 사용해,
  대량 전송과 함께 발생하는 제어 지연이 연결 구조와 수신 확인에 반응하는지 조사한다.
  제품 소스 수정, 새 전송 프로토콜 적용, 실기기·가청 싱크 검사는 하지 않았다.
- Source review baseline: `eea5a842c1d1b9cd51b845f95de24b1059378bae`
  (PR [#397](https://github.com/hiefny/MUSIXQUARE/pull/397) 병합 뒤).
  이 SHA는 앱 경로를 대조한 기준이며, native harness가 이 앱을 실행했다는 뜻은 아니다.
  실행 코드는 아래 scratch runner SHA-256으로 식별한다. 로컬 결과는 exact-main CI
  후보나 Production Release 검증을 대신하지 않는다.
- Related: [64 KiB 최소 완화와 느린 망·다수 수신자 검증](preload-capacity-validation-2026-10-18.md),
  [Pixel 비교와 한계](preload-local-pixel-retest-2026-10-18.md),
  [현재 릴리스 기록](../release-record.md).

이번 결과로 **현재 앱 없이도, 같은 PeerConnection에서 bulk와 control을 함께
보내면 초 단위 지연이 재현되고, 별도 연결 또는 수신 확인 기반 전송량 제한으로
그 지연이 크게 줄어든다**는 조건부 결론을 얻었다. 특정 SCTP 내부 버그, 실제
Android 사건의 원인 전체, 모든 망에서 연결 분리가 필요하다는 결론은 아니다.
승인된 64 KiB 최소 완화와 차기 프로토콜 설계는 별도 범위다.

## 실행 환경과 증거 식별

2026-10-18 **07:17:05–07:21:16 KST**, Windows 11 / headless Chromium
`153.0.8010.12`에서 진행했다. 매 조건마다 새 브라우저를 만들고, 호스트 1개와
수신자 8개를 서로 다른 context/page로 구성했다. 8대의 물리 기기가 아니며 같은
PC의 CPU·브라우저 network service·네트워크 자원을 공유한다. 다른 build/E2E/성능
실행과 겹치지 않는 실행 슬롯을 사용했다.

- 앱 번들·합성/실제 미디어 공급자·CDP network shaping은 없다. SDP만 Node를
  통해 연결하고 실제 payload·tick·echo·ACK는 native RTC를 통과한다.
- 모든 연결은 `iceServers: []`, reliable ordered 채널이다. 결과의 선택 경로는
  전부 UDP이고, 측정 전후 selected candidate pair가 유지됐다.
- fixture는 `controlled-audio-120s.wav`, **23,040,044 bytes**, 64 KiB 청크
  352개다. SHA-256은
  `5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`다.
- `Blob.slice().arrayBuffer()`, peer별 비동기 pump, 전송 전
  `bufferedAmount <= 65536`, low-water event/50 ms fallback, 청크 0/50/100…에서
  10 ms yield를 사용한다. 제품의 직렬화/header·권한·취소·저장 lifecycle은 없다.
- 100 ms마다 peer별 control tick을 보내고 즉시 echo한다. 제품보다 높은
  **공통 진단 부하**이며 실제 서비스의 메시지 빈도나 지연 예측값이 아니다.
- 최소 30초 관측과 마지막 receipt 뒤 3초를 확보한다. 관측 상한 45초,
  setup 상한 120초, 조건 전체 watchdog 180초다. 최소 200 tick/peer,
  exact wire·echo 대응, 중복·누락 0, 채널 오류·종료 0을 통과 조건으로 삼았다.
- 파일 완료 시에는 byte receipt만 보내고, 모든 page의 측정을 종료한 뒤
  Blob 결합/SHA를 수신자별로 순차 수행한다. 최종 hash ACK까지 검증하되
  이 CPU 작업을 전송 중 control 측정에 섞지 않았다.
- `getStats()`는 측정 전후에만 실행했다. 주기적인 stats 수집은 꺼서 B의
  두 배 연결 수 때문에 관측 부하도 두 배가 되는 혼동을 피했다.

증거는 ignored `scratch/preload-validation-2026-10-18/`에 보존한다.
공유된 저장소에는 원본 scratch 파일이 포함되지 않으므로 재현 시 이 파일도
함께 보존해야 한다.

| 대상 | 파일 / SHA-256 |
| --- | --- |
| 실행 runner | `native-control-topology-probe-unshaped-r1.mts` / `48bb3ddbf0be8a18585db08a64230887679a3bd500eb3553feaec428b9a52dac` |
| 독립 집계기 | `native-topology-independent-review.mts` / `8fa34e0d351740ece8193655fd3d4fd604f64dbf68cb9ab7429d6a4b9aa74751` |
| 원본 7개 | `native-topology-unshaped-r1-{0-idle,1-A,2-B,3-B,4-A,5-C,6-C}.json` |
| 실행 로그·집계 | `native-topology-unshaped-r1-run.log`, `native-topology-unshaped-r1-summary.json` |
| 독립 집계 | `native-topology-unshaped-r1-independent-review.json` |
| 공식 소스 원문·해석 | `slow-guest-source-evidence.json`, `slow-guest-transport-design-review.json` |

당시 실행은 `node scratch/preload-validation-2026-10-18/native-control-topology-probe.mts
--tag unshaped-r1`이었다. 이 이름의 현재 파일은 후속 slow2 확장을 포함하므로
7조건을 재현할 때는 표의 `-unshaped-r1.mts` 사본과 새 tag를 사용한다. 독립 집계는 같은 디렉터리의
`native-topology-independent-review.mts unshaped-r1`이다. 원본 덮어쓰기를 거부하며,
부분 실패에서도 파생 분석 전에 raw를 먼저 저장한다. 이번 실행에는 실패·skip이
없다. 이는 아래 7조건의 결과이며 제품 전체 테스트가 모두 실행됐다는 뜻이 아니다.

## 조건과 결과

- **idle**: 동일 PC 안의 두 DataChannel, 파일 전송 없음.
- **A**: 수신자마다 하나의 PeerConnection에 bulk/control 두 DataChannel.
- **B**: 수신자마다 bulk와 control의 PeerConnection을 따로 생성한다.
  호스트의 PC 객체 수가 8개에서 16개로 증가한다.
- **C**: A와 같은 연결에 진단용 누적 수신 credit을 추가한다. 수신자는 청크마다
  누적 bytes/index를 보고하며, peer마다 `sent − confirmed <= 128 KiB`를 유지한다.
  C는 피드백과 전송 속도 모두 바뀌므로 단순히 연결만 비교하는 조건은 아니다.

순서는 **idle → A → B → B → A → C → C**다. A/B는 두 순서를 비교했고,
C 두 번은 그 뒤 연속 실행했으므로 C에 대한 완전한 순서 교차 실험은 아니다.

하행은 native host `send` 직전부터 guest `message` 진입까지다. RTT는 호스트의
단조 시계로 tick→echo를 잰 값이다. 파일 완료는 호스트 peer pump 시작부터
게스트 마지막 청크 수신까지이며 hash 시간은 제외한다.

| 조건 | 전체 하행 최대 | 전송 중 하행 p95 / 최대 | echo RTT 최대 | 파일 완료 중앙값 / 최대 | host discard 증가량 |
| --- | ---: | ---: | ---: | ---: | ---: |
| idle | 3 ms | 해당 없음 | 4.3 ms | 해당 없음 | 0 |
| A 1 | 4,051 ms | 2,899 / 4,051 ms | 4,062.9 ms | 4,296 / 6,257 ms | 2,259 |
| B 1 | 4 ms | 2 / 3 ms | 165.4 ms | 4,846 / 6,683 ms | 2,430 |
| B 2 | 39 ms | 3 / 39 ms | 179.8 ms | 3,169 / 5,264 ms | 5,283 |
| A 2 | 3,967 ms | 2,781 / 3,967 ms | 3,968.0 ms | 3,406 / 5,454 ms | 5,991 |
| C 1 | 14 ms | 11 / 14 ms | 34.1 ms | 4,767 / 4,771 ms | 0 |
| C 2 | 24 ms | 13 / 24 ms | 33.7 ms | 4,820 / 4,840 ms | 0 |

discards는 같은 host PC·selected pair의 **측정 전후 counter 차이**다.
인터넷 회선의 packet loss로 바꾸어 부르지 않는다. B에서도 discard가 남았고,
그 값의 크기만으로 control 지연이나 제품 회귀를 판정하지 않는다.

독립 집계는 harness의 요약값 대신 원본 page에서 16,912개의
host tick→guest receive→guest echo send→host echo를 다시 매칭했다.
wire·identity·timestamp 대응, 중복·누락 0과 48개 파일 무결성을 확인했다.
각 page의 `Date.now() − performance.now()` 표본 범위는 최대 약 1.2 ms였다.
같은 Windows PC의 시각이라는 전제 아래 하행 비교에 유효하며, 물리적 소리
정렬이나 다른 장치의 시계 정밀도를 검증한 것은 아니다.

호스트 loop lag 최대는 17 ms, 게스트 최대는 22.5 ms였다. A의 약 4초 지연은
**관측된 main-thread loop 정체만으로 설명되지 않는다**. 브라우저의 모든 내부
스레드 부하나 OS 자원 경합까지 배제했다는 뜻은 아니다.

B의 RTT 최악 표본은 하행 각각 1 ms, guest echo 처리 0 ms,
상행 165/179 ms였다. 따라서 “별도 PC면 왕복 모두 4 ms”라고 보고하지 않는다.
공통 진단에서 하행 지연은 크게 개선됐으나 역방향 지연은 남았다.

## 앱 경로와 원인 확정 범위

현재 [Cloudflare transport](../../src/network/transport/cloudflare-signaling.ts)의
`createDataChannel` 경로는 이미 같은 PC에 reliable ordered bulk/control
채널을 각각 만든다. `isBulkPayload`와 `send`는 파일 청크와 terminal file fence를
bulk에, 재생·동기화 등 나머지 메시지를 control에 보낸다. 별도 DataChannel이
없어서 생긴 문제는 아니다.

[preload](../../src/storage/preload.ts)의 `PRELOAD_BACKPRESSURE_LIMIT`는
전송 전 로컬 `bufferedAmount`에 적용한다. 한 번에 보내는
[청크 크기](../../src/core/constants.ts)는 별도로 64 KiB다. A/B/C 모두 관측된
최대값은 **send 직전 64 KiB, 직후 128 KiB**였다. 따라서 이번 64 KiB 변경은
전송 대기 기준이며, 모든 계층의 미전달 바이트를 64 KiB로 제한하는 hard cap이 아니다.

W3C의 [`bufferedAmount` 정의](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamount)는
하위 프로토콜 framing과 OS/네트워크 장비 buffering을 포함하지 않는다.
애플리케이션이 다음 청크를 보내도 된다고 관측한 순간에 이전 데이터가 수신자까지
도착했다는 보장은 없다. 최악 control 표본에서 control 자체의
`bufferedAmount`가 0이어도 이 아래의 대기를 배제할 수 없다.

반대로 C의 `sent − confirmed`는 실제 수신한 payload의 누적 보고를 사용하므로
미확인 payload를 peer별 128 KiB로 묶는다. A/B에는 중간 수신 확인이 없어서
runner의 `maxUnconfirmedBytes`는 사실상 누적 송신량이다. 이 값을 A/B의
정확한 in-flight bytes나 큐 점유량으로 해석하지 않는다.

확정할 수 있는 것은 다음 범위다.

1. 파일 전송 중 초 단위 control 지연은 앱의 UI·YouTube를 제거해도 재현된다.
2. 같은 송신 기준에서 PC 분리와 수신 credit 각각이 이 로컬 재현을 크게 줄였다.
3. 로컬 `bufferedAmount`만으로 수신까지의 지연이나 전체 미전달 바이트를
   보장할 수 없다. 별도 DC만으로 충분하다고 가정하는 것도 맞지 않는다.
4. 실제 현장의 단일 원인, SCTP의 특정 구현 결함, 모든 지연이 동일한 큐에서
   발생한다는 주장, 모든 물리망에서 B/C가 우수하다는 주장은 아직 확정하지 못했다.

## 표준과 Chromium 구현 대조

[RFC 8831 §5](https://www.rfc-editor.org/rfc/rfc8831.html#section-5)는 하나의
SCTP association 안의 streams가 congestion window를 공유한다고 설명한다.
채널 분리는 stream별 순서 보장을 분리하지만 association과 아래 경로까지
분리하지는 않는다. [§6.6](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.6)의
큰 메시지 독점·16 KiB 권고는 message interleaving이 없는 경우의 조건부 내용이다.
[RFC 8260](https://www.rfc-editor.org/rfc/rfc8260.html)의 I-DATA/interleaving도
공통 물리 경로의 congestion이나 모든 하위 큐를 없애는 기능은 아니다.

검토한 Chromium은 시험 브라우저와 같은 tag `153.0.8010.12`이며,
DEPS의 WebRTC revision은 `9ea5afcad008b940468c2a15aec339592cf5a935`다.
해당 [DcSctpTransport 초기화](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/media/sctp/dcsctp_transport.cc)는
message interleaving을 `WebRTC-DataChannelMessageInterleaving` field trial로
설정한다. 이번 실행의 field trial과 SCTP 협상 결과는 수집하지 않았다.
“이 실행은 interleaving이 꺼졌기 때문에 실패했다”로 확정하지 않는다.

[Chromium runtime feature 목록](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/third_party/blink/renderer/platform/runtime_enabled_features.json5)의
`RTCDataChannelPriority`는 experimental이다. JS priority 옵션 하나가 모든
지원 브라우저에서 이 문제를 해결한다고 가정하지 않는다.

### 앞선 2 Mbps 실험의 약 20초 지연과 shaping 한계

이 절은 위의 무제한 native 7조건과 구분한다. 앞선 앱 실험의
`multi-mixed3-slow2-r1-{baseline,window64}.json`은 느린 guest에 2 Mbps,
방향별 100 ms, loss 0, `packetQueueLength: 0`을 적용했다. 무부하 echo는
약 220 ms였지만 전송 중 전체 control 최대는 20,007/19,699 ms였다.

공식 [ThrottlingController](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/services/network/throttling/throttling_controller.cc)와
[P2P interceptor](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/services/network/throttling/throttling_p2p_network_interceptor.cc)를
보면 같은 throttling profile에 등록한 UDP sockets는 한 send/receive simulated
network를 공유한다. 대역폭에 따른 직렬화 대기 뒤 설정된 latency가 더해지고,
send completion은 실제 모의 전달 전에 enqueue 시점에 통지된다.

[`SimulatedNetwork`](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/test/network/simulated_network.cc)에서
queue length 0은 “대기 없음”이 아니라
[`NetworkQueue::kMaxPacketCapacity`](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/api/test/network_emulation/network_queue.h)를
사용한다. 이 revision의 내부 상한은 10,000 packets다. 설정상 무제한에 가깝게
쓰이지만 수학적인 무한 큐는 아니다. 또한 interceptor는 `packetQueueLength`를
send 설정에만 대입하며 receive 설정은 기본값을 유지한다. guest의 queue length만
줄여서 guest 수신 방향의 이 대기를 제한했다고 주장할 수 없다.

느린 guest 경로의 STUN connectivity/consent RTT는 최종 counter 기준으로
baseline `532.084초 / 58회 = 9.174초`, window64 `526.055초 / 58회 = 9.070초`
였다. 같은 실험의 빠른 두 guest는 약 0.64–0.71 ms였다.
이 counter는 [STUN 응답 RTT](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatepairstats-totalroundtriptime)이며
SCTP 메시지 왕복이 아니다. 따라서 이 느린 망 실험은 **SCTP stream/association
내부의 blocking만으로 설명되지 않고, 그 아래의 공통 경로에도 큰 지연이 있다**.
최종 누적 counter이므로 개별 STUN 지연 시각과 특정 PONG 최대치를 일대일로
대응시키지는 못한다.

앞선 baseline/window64의 마지막 native 청크 send부터 마지막 guest 청크 수신까지도
20,568/19,532 ms가 남았다. 이는 이미 앱 송신 큐를 떠난 데이터의 대기와 일치하지만
정확한 SCTP·simulator 내부 큐 점유량은 측정하지 않았다.
[`DcSctpOptions`](https://webrtc.googlesource.com/src/+/9ea5afcad008b940468c2a15aec339592cf5a935/net/dcsctp/public/dcsctp_options.h)의
기본 수신 window 5 MiB를 250,000 bytes/s로 나눈 약 20.97초는 규모가 비슷한
가설일 뿐, 실제 advertised window를 확인한 원인 확정은 아니다.

별도 PC는 SCTP association을 분리하지만 같은 CDP profile FIFO와 실제
Wi-Fi/공유기/uplink 병목을 공유할 수 있다. 공통 병목의 큐 문제를 연결 개수만으로
해결한다고 보지 않는다. [RFC 7567의 큐 관리 논의](https://www.rfc-editor.org/rfc/rfc7567.html)도
공통 병목의 긴 큐와 전송 계층의 혼잡 제어를 구분한다.

## 후속 설계 선택과 다음 단계

| 선택 | 분리하거나 제한하는 것 | 남는 비용·한계 |
| --- | --- | --- |
| 별도 DataChannel, 현행 | stream별 ordered delivery·앱 채널 큐 | SCTP association·congestion window·하위 경로는 공유 |
| 별도 PeerConnection, B | association·stream scheduler·congestion window | 추가 ICE/DTLS·재접속·TURN·종료 lifecycle, 공통 병목은 유지. 이번 상행 165/179 ms도 남음 |
| 수신 credit, C | 브라우저가 받아들였으나 수신 미확인인 payload 양 | 신규 피드백·권한/세대 검증·혼합 버전 계약 필요. 처리량 trade-off가 있으며 이번 파일이 항상 더 빨라진 것은 아님 |
| WebSocket control + RTC bulk | control을 RTC association에서 제거 | 서버 인증·권한·순서·revision·재전송·시계 경로 설계 필요. 물리 회선은 여전히 공유 가능 |

현행 PRELOAD_ACK는 저장소가 파일 최종 확정을 마친 뒤 보내는 ready 확인이다.
중간 credit로 바꾸어 쓰면 이 계약을 깨므로 별도 progress 메시지가 필요하다.
후속으로 C를 제품화한다면 다음을 먼저 설계하고 검증한다.

- connection generation, queue item, session에 묶인 누적 bytes/index를 사용하고
  단조 증가·이미 보낸 범위 이내인지 검증한다. peer별 창을 독립적으로 둔다.
- cancel, connection 교체, 전송 승격과 queue 삭제에서 오래된 credit가 다른
  전송을 진행시키지 않도록 한다. 최종 durable PRELOAD_ACK는 그대로 둔다.
- 호환 capability와 구 버전 fallback을 명시한다. 청크마다 UI를 갱신하거나
  영구 polling을 추가하지 않고 feedback 빈도와 처리 비용을 제한한다.
- 128 KiB는 이번 진단값이지 확정 제품값이 아니다. 한 64 KiB의 총바이트
  직렬화에는 2 Mbps 기준 약 262 ms가 걸린다. control이 그 뒤에 대기하면
  그 규모의 추가 지연이 가능하지만, interleaving·packet별 scheduling에 따라
  청크 전체를 기다리지 않을 수도 있다. 이 계산만으로 control 지연 하한을
  정하지 않으며 실제 전달 지연을 별도로 측정한다.
- 직접 연결뿐 아니라 relay·복수 수신자·취소·승격·저장 실패까지 검증한 뒤
  처리량과 control 지연을 함께 보고 제품 적용을 별도로 결정한다.

이번 B는 연결 분리가 도움이 되는 재현 조건을 제공했고, C는 연결을 늘리지 않고도
해당 현상을 줄일 수 있음을 보였다. 따라서 **지금 당장 연결을 둘로 나누어야만
한다는 결론은 아니다**. 우선 수신 확인 기반 제한을 작은 후속 후보로 검증하고,
공통 병목에서 부족할 때 topology 변경의 이익과 lifecycle 비용을 비교한다.
이 보고서 작성으로 어느 후보도 제품에 자동 적용하지 않는다.

WebSocket 비교를 후속 실험에 추가할 경우 현재 CDP 설정은 HTTP/HTTPS/WS/WSS를
제한에서 제외한다는 점을 먼저 해결해야 한다. 그런 조건에서 WS가 빠른 것은 제한
경로를 우회했다는 결과이지 물리 느린 망에서 WS가 우수하다는 증거가 아니다.
공통 외부 병목을 적용하거나 결과를 component-isolation으로 한정한다.

## 느린 guest native A/C 보조 비교

2026-10-18 **07:23:19–07:27:28 KST**, 같은 Windows/Chromium에서
host 1 + guest 3으로 A → C 한 쌍을 추가했다. guest 3만 앞서 검교정한
CDP `slow2`(2 Mbps up/down, 방향별 latency 100 ms, loss 0,
queue length 0, reordering false)를 적용했다. setup 중 native P2P socket에
interceptor를 연결한 뒤 조건을 적용하며, JS message handler 지연으로 느린 망을
흉내 내지 않았다. 제품·미디어 공급자는 여전히 없다.

tick을 100 ms마다 보내며 파일 전송 전에 약 3초 무부하 구간, 총 약 120초
관측을 확보했다. 원래 8 guest/30초 비교와 표본·예산이 다르므로 별도 결과로
보존한다. A/C 각 1회, B는 이번 느린 망에서 실행하지 않았다.

다음 파일은 모두 앞의 `scratch/preload-validation-2026-10-18/` 아래다.

| 대상 | 파일 / SHA-256 |
| --- | --- |
| 후속 runner | `native-control-topology-probe.mts` / `ee4c852ea6d21aef462a3110e9e9a54736af82fa67b749023ec1eb592e99d4dd` |
| shaping helper | `slow-link-shaping.mts` / `a69d4aa9cbdba7a078caa4180290a849f31cb665e17f4bce34d5ccc2334e9b75` |
| 독립 집계기 | `native-topology-slow2-independent-review.mts` / `1fe3edcb5e7583dbd0f040f5bcd0e0a22e77aa5dd323e7492d1a39f4e8e4d767` |
| A 원본 | `native-topology-slow2-r1-0-A.json` / `efffaca3c9dfb524ac2bcb9ead250e094377fb2dfd281056ec0b943c036d37b1` |
| C 원본 | `native-topology-slow2-r1-1-C.json` / `cd61074ffcb4a6f32084107625f9e5950bb04f34d6b193ac3f8a5d09164fd986` |
| 집계 | `native-topology-slow2-r1-analysis.json`, `native-topology-slow2-r1-independent-review.json` |

| 느린 guest 3 지표 | A, 현행 형태 | C, 진단용 수신 credit |
| --- | ---: | ---: |
| 전송 전 하행 최대 | 117 ms | 117 ms |
| 전송 중 하행 p95 / 최대 | 19,862 / 20,041 ms | 417 / 980 ms |
| 전송 완료 후 하행 최대 | 121 ms | 118 ms |
| echo RTT 최대 | 73,689.9 ms | 1,083.7 ms |
| 첫 청크 수신→마지막 청크 수신 | 96,663 ms | 96,449 ms |
| host pump 시작→마지막 청크 수신 | 97,479 ms | 97,222 ms |
| host 마지막 send→마지막 청크 수신 | 19,503 ms | 330 ms |
| STUN RTT 평균, 같은 pair 전후 delta | 11,066 ms | 312 ms |
| 빠른 guest 1 / 2의 전체 하행 최대 | 1,651 / 1,657 ms | 5 / 6 ms |
| host 전체 discard 증가량 | 592 | 0 |

전송 시간의 기준을 앞 표와 혼동하지 않도록 pump 시작과 첫 수신 기준을 모두
적었다. C의 빠른 guest 둘은 파일 수신 1,155/1,164 ms였고 A는
2,876/2,917 ms였다. C는 이 쌍에서 느린 guest의 처리량을 크게 잃지 않으면서
control과 마지막 송신 이후의 drain tail을 줄였다. 단일 쌍의 결과이며 모든 RTT나
대역폭에서 같은 처리량을 보장하지 않는다.

독립 매칭한 tick은 A 3,606개, C 3,603개다. 모든 native wire와 echo가 정확히
대응하고 중복·누락은 0이었다. 파일 6/6 SHA·최종 ACK가 일치했다. C는 peer마다
352개의 정확히 증가하는 누적 credit과 모든 송신 표본의 `sent − confirmed <=
131072`를 확인했다. Hash는 두 조건 모두 모든 page의 측정 종료 뒤 시작했다.
UDP·selected pair가 유지됐고, 시계 basis 범위는 최대 1.3 ms, loop lag는
최대 22.2 ms, long task는 0이었다.

A의 약 73.69초 echo RTT는 하행 최대 20.041초와 다른 표본이다.
원본 seq 227은 **하행 11,671 ms → guest echo 처리 약 0.1 ms →
상행 62,019 ms**였다. guest가 echo를 보낼 당시 control bufferedAmount는
11,807 bytes였다. 이 실행은 100 ms 주기의 진단 echo와 shaped queue를
사용하므로, 이 73.69초를 제품의 일반 heartbeat RTT로 옮겨 쓰지 않는다.
다만 하행만 보고 양방향 지연이 해결됐다고 판단해서도 안 된다.

C의 최대 표본은 하행 980 ms, guest echo 처리 0 ms, 상행 104 ms였다.
수신 확인으로 큰 backlog는 줄었지만 모든 표본이 무부하 100 ms 수준은 아니며,
sub-100 ms 보정이나 실제 가청 싱크를 달성했다는 결과가 아니다.

같은 shaped path에서 C는 STUN 평균과 파일 drain tail도 줄였다. 이는 제어
채널 이름을 바꾸지 않고 **미전달 데이터 공급량을 제한하는 개입**이 공통 경로의
대기를 낮출 수 있다는 보강 증거다. 한 쌍만으로 큐의 정확한 내부 위치나
SCTP window·scheduler 각각의 기여율을 확정하지 않는다.

이 보조 결과까지 고려해도 후속 우선순위는 receiver credit의 제품 계약·취소·승격·
호환성 설계 검토다. 별도 PeerConnection이 필수라는 결론은 아니며 이번 승인된
릴리스에는 **64 KiB 최소 완화만 포함하고 credit이나 연결 분리는 넣지 않는다**.
