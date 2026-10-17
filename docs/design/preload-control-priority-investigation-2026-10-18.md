# 일반방 프리로드와 제어 메시지 우선순위 조사

- Date: 2026-10-18 KST.
- Status: 탐색 조사 완료. 실제 YouTube 비교 9회(23 MB 6회 + 115 MB 3회)
  모두 실행·파일 무결성·재생 유지 검증 완료, 실행 실패 0 / skip 0.
  baseline의 지연은 재현됐으므로 성능 결함 0건이나 출시 승인이라는 뜻은 아니다.
  빌드와 겹친 초기 pilot 1회는 비교에서 제외하고 원본을 보존했다.
- Scope: 프리로드 송신량을 제한하면 재생 제어 메시지 지연을 안전하게 줄일 수
  있는지 조사한다. 제품 소스 수정·병합·배포나 릴리스 후보 검증은 아니다.
- Tested source: checkout `256f1f92988248462de857dd69232bda8c7ea474`.
  운영 runtime `e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b`(8.11.14/v716)과
  앱 runtime·설정·package/lockfile diff 없음. 실험 변형은 아래 별도 hash로 식별한다.
- Related evidence: [실제 YouTube·프리로드 구신 비교](youtube-preload-live-ab-2026-10-18.md),
  [현재 릴리스 기록](../release-record.md).

후속 검증과 최소 완화 릴리스 판단은
[느린 망·다수 수신자·취소·승격 검증](preload-capacity-validation-2026-10-18.md)을
따른다. 아래 수치는 당시의 탐색 실험이며 모든 환경의 지연 상한이 아니다.

## 질문과 기존 관측

앞선 실제 YouTube 비교에서 프리로드 중 heartbeat의 native RTC send→message
전달이 약 1–2초 지연됐다. message 이벤트 이후 앱 handler까지는 0–1 ms였고,
영상 버퍼링이나 불필요한 seek는 관측하지 못했다. 파일 완료 부근의 69/74 ms
long task는 최대 전달 지연과 다른 시점이므로 같은 원인으로 합치지 않는다.

이번 질문은 지연된 heartbeat의 위치 해석을 다시 바꾸는 것이 아니라,
다음 파일의 준비가 현재 재생·동기화 제어와 경쟁하는 정도를 줄일 수 있는가다.
실제 Android 사건의 전체 원인이나 가청 동기화는 아직 확정하지 않았다.

## 코드와 표준에서 확인한 구조

- `src/network/transport/cloudflare-signaling.ts`는 하나의 RTCPeerConnection에
  `musixquare-data`와 `musixquare-control` 두 ordered 채널을 만든다. 제어 메시지를
  bulk 채널에서 분리하는 처리는 이미 있다. FILE/PRELOAD END는 마지막 청크를
  추월하지 않도록 bulk 채널을 사용한다.
- `src/storage/preload.ts`의 프리로드는 수신자의 현재 파일 전송과 현재 곡으로
  승격된 preload에 양보한다. YouTube/control 혼잡에 따른 별도 송신 pacing은 없다.
- 프리로드의 capacity high-water mark는 256 KiB, wire 청크는 64 KiB다.
  공유 broadcast pump는 수신자별 50청크마다 10 ms yield를 수행한다.
  late-join unicast preload는 capacity/read/send를 반복하며 별도 주기적 yield는 없다.
- `src/storage/transfer-backpressure.ts`는 정확한 bulk 채널의 `bufferedAmount`와
  low-water 이벤트를 관측한다. 닫힘·교체·취소·timeout을 처리하지만 control
  backlog나 OS/네트워크 큐 전체를 측정하지는 않는다.

SCTP의 같은 association에 속한 stream들은 congestion window를 공유한다.
별도 data channel이 곧 완전한 전송 자원 격리는 아니다.
[RFC 8831 §5](https://www.rfc-editor.org/rfc/rfc8831.html#section-5)

`bufferedAmount`는 앱이 send로 넣은 데이터의 가시적인 대기량이다. 프로토콜
overhead와 OS·네트워크 장비의 buffering은 포함하지 않는다. 이 값이 낮다는
것만으로 수신까지의 지연 상한을 보장할 수 없다.
[W3C WebRTC bufferedAmount](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamount)

큰 메시지는 interleaving 지원이 없으면 association을 점유할 수 있으며 RFC는
그 조건에서 16 KB 메시지 상한을 권고한다. 현재 브라우저 조합의 interleaving
지원 유무나 이것이 이번 지연의 원인인지는 이 조사로 확정하지 않는다.
[RFC 8831 §6.6](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.6)

`src/network/protocol.ts`와 preload 수신 경계는 total·청크 길이를 현재 64 KiB
계약으로 검증한다. 따라서 청크 크기를 16 KiB로 바꾸는 일은 단순 송신 튜닝이
아니며 구신 호환성과 수신 계약 변경을 요구한다. 이번 실험은 wire 형식을 유지한다.

## 방 인원과 파일 전달 방식 구분

20명이 방에 있다는 가정이 20개 direct 파일 송신을 뜻하지 않는다.
`src/share/file-delivery-policy.ts`의 direct local 파일 수신자 상한은 8명이다.
파일별로 결정된 전달 방식은 전송 도중 바꾸지 않는다.

- local 수신자가 8명 이하면 direct 경로를 선택한다.
- 8명 초과이며 전원이 R2 capability를 광고했다면 전원이 R2 fanout을 사용한다.
- capability가 섞이면 미광고 수신자에 최대 8개 direct 자리를 배정하고,
  capable 수신자는 R2로 보낸다. direct 자리가 없는 미광고 수신자는 unsupported다.
- 늦은 입장과 재접속도 각 파일의 고정된 전달 정책에 따라 판단한다.

따라서 제품화 검증에는 direct 1–8명과 R2/mixed 경로를 구분해야 한다.
이번 1 host + 1 guest 실험은 direct 경로만 검증한다. PRO도 각 기기가 R2에서
파일을 받는 별도 경로이므로 이번 pacing 실험의 효과를 그대로 일반화하지 않는다.

## 실험 방법과 식별

Windows 11에서 별도 browser context의 호스트·게스트가 제품 Cloudflare
어댑터와 로컬 signaling Worker/DO로 실제 WebRTC 연결을 만든다.
실제 YouTube iframe/API/media를 사용하고 지연·BUFFERING·jank를 주입하지 않는다.
guest의 Android UA/touch는 Android 정책 분기 선택용이며 실제 Android 하드웨어나
출력 지연 측정이 아니다. 선택된 RTC 경로와 오류·해시는 각 raw 결과에서 검증한다.

기존 harness와 같은 영상 `bnh70V0yu2s`, 실제 host 파일 input을 사용한다.
PLAYING과 영상 ID를 확인한 뒤 10초 warmup, 45초 관측을 수행한다.
23,040,044 bytes PCM WAV의 SHA-256은
`5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`다.
세 조건을 2회씩 실행하고 두 번째 반복은 순서를 뒤집는다.

115,200,044 bytes / 600초 PCM WAV로 세 조건을 각각 한 번 더 실행했다.
SHA-256은 `9ff6b1b4e504e9a8fec2345dedcc3af8fa61d96dac5a2a06fd641e7556876d8d`다.
대용량도 동일하게 10초 warmup과 45초 관측을 사용했고 모두 관측 창 안에 완료됐다.
Node 24.13.1, Playwright 1.63.0 / Chromium 153.0.8010.12,
Wrangler 4.148.0이며 측정 기간은 2026-10-18 02:18–02:28 KST다.

| 조건     | 프리로드 capacity high-water mark | 청크 후 yield                   |
| -------- | --------------------------------- | ------------------------------- |
| baseline | 256 KiB                           | 기존 broadcast 50청크마다 10 ms |
| window64 | 64 KiB                            | 기존과 같음                     |
| paced8   | 64 KiB                            | 매 preload 청크 후 8 ms         |

64 KiB mark는 큐의 hard cap이 아니다. 검사 통과 후 동일한 64 KiB wire 청크와
header가 추가될 수 있다. paced8은 기존 주기적 yield를 대체하며 첫 청크 뒤에도
8 ms를 기다린다. 마지막 청크 뒤에도 같은 대기가 있어 END/ACK까지의 시간에는
그 차이가 포함될 수 있다. 타이머의 실제 대기 시간은 정확히 8 ms라고 보장되지 않는다.

`build-preload-pacing-experiments.mjs`는 Vite `enforce: pre` plugin으로 메모리에서
소스를 변형한다. 제품 파일은 쓰지 않는다. 단일 치환 anchor, 변형 적용 여부,
빌드 전후 원본 hash를 검증하고 원본·변형 사본과 diff·manifest를 scratch에 보관한다.
첫 빌드의 destructuring anchor가 두 곳에 일치해 script가 중단된 이력은 보존했다.
anchor를 좁힌 뒤 두 조건을 다시 빌드했으며 이는 앱 실행 실패가 아니다.

| 소스·변형              | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| 원본 `preload.ts`      | `1455252262ae780499a2be0b7e456aa6d018bb0ed824a2f40c30e7441c7444a2` |
| 원본 `chunk-pump.ts`   | `0366c61bbd772cc392e28edbc03b4c1b52a31e6360b02fdc0c789b7a794a0d02` |
| window64 `preload.ts`  | `7f4805485643948489c11ed004a53e8f1424df0dfca9d82c39d84e3e22aa18b3` |
| paced8 `preload.ts`    | `14b30d35f8a3da13d1f0032c848fd1148b0d5e93ebb7ffa167f08c169b945437` |
| paced8 `chunk-pump.ts` | `9fd13eaafdcac5b95a7f5b5faeb5929182b14accbfe1b1cf4b2bd232475cd1fe` |
| 실험 build script      | `592717c3ae1fe36e0e2355e41b76dd57908f511f5c256bb266feaeae90e9800e` |

window64는 preload broadcast/unicast 상한만 바꾼다. paced8의 공유 pump 옵션은
preload caller만 전달하므로 active-file caller의 기존 동작은 그대로다.
source/session/queue identity, 수신 처리, 메시지 형식과 청크 크기, PRO/R2 경로는
실험 변형에서 바꾸지 않았다. unicast도 변형하지만 이번 비교는 broadcast만 실행한다.

정식 matrix 이전 baseline pilot 1회는 빌드 작업과의 동시 부하 가능성이 있어
정식 비교에서 제외한다. `real-pacing-baseline-first-*` 파일은 삭제하지 않으며
실험 결과를 유리하게 고르는 근거로 사용하지 않는다. 정식 실행 중에는 추가 빌드나
별도 브라우저 테스트 부하를 만들지 않는다.

## 결과

native RTC send→message의 관측 최대값이다. 실제 음성의 지연을 측정한 값은 아니다.
파일 시간은 첫 청크 수신부터 마지막 청크 수신까지다.

| 파일 / 조건            | heartbeat 최대 지연 | 청크 전송 시간   | 전송 중 heartbeat 표본 | host sender discard |
| ---------------------- | ------------------- | ---------------- | ---------------------- | ------------------- |
| 23 MB baseline r1 / r2 | 1,762 / 2,037 ms    | 3,271 / 3,014 ms | 1 / 1                  | 426 / 422           |
| 23 MB window64 r1 / r2 | 1 / 1 ms            | 1,233 / 1,227 ms | 1 / 1                  | 0 / 0               |
| 23 MB paced8 r1 / r2   | 1 / 1 ms            | 3,494 / 3,606 ms | 1 / 2                  | 0 / 0               |
| 115 MB baseline        | 2,202 ms            | 6,746 ms         | 3                      | 473                 |
| 115 MB window64        | 3 ms                | 7,507 ms         | 3                      | 0                   |
| 115 MB paced8          | 2 ms                | 17,895 ms        | 6                      | 0                   |

전체 관측 창과 별도로 실제 전송 중 송신한 heartbeat를 대응시켰다.
23 MB window64의 heartbeat는 첫 송신 약266/481 ms 뒤에 발생했고,
마지막 청크 수신까지 약972/752 ms가 남아 있었다. 둘 다 같은 ms에 도착했다.
이는 시계 분해능상 0 ms라는 뜻이며 물리적 전달 시간이 0임을 보장하지 않는다.
전체 45초 관측 최대는 1 ms다. 115 MB window64도 전송 중 3표본의 최대가
3 ms였다. 파일 종료 후의 빠른 응답만 집계한 결과가 아니다.
모든 조건의 handler 추가 지연은 0–1 ms다. 세 조건은 동일한 wire 청크와
RTC 연결 구조를 쓰므로 프리로드 송신 대기량을 낮추는 개입이 이 환경의 지연을
줄였다는 근거가 된다. native SCTP/UDP 내부의 정확한 폐기·재전송 연쇄는
캡처하지 않았으므로 특정 heartbeat의 원인까지 확정하지 않는다.

9회 모두 전체 청크(23 MB 352개 / 115 MB 1,758개), 바이트 수·SHA-256과
호스트의 ACK 1회 수신이 일치했다. mode/qid/video ID가 유지됐고,
측정 중 BUFFERING·seek/pause/play/load/cue·foreground handoff는 0건이었다.
PLAYING과 IFrame API의 시간 진행도 유지됐으며 진행량과 관측 경과 시간의
차이는 각 실행에서 절대 1 ms 미만이었다. 실제 가청 싱크의 검증은 아니다.
pageerror와 YouTube onError는 0건이다. 부가 console에는 URL이 없는 resource
503 및 YouTube 통계 요청 ERR_ABORTED가 있어 모든 네트워크 요청 성공이라고
표현하지 않는다. 정확한 503 요청 경로는 이 계측으로 식별하지 못했다.

115 MB 완료 부근 long task는 baseline/window64/paced8에서 각각 58/61/59 ms로
남았다. 작은 버퍼가 파일 완료 처리 비용까지 없앤 것은 아니다. 23 MB에서는
guest long task가 없었고, 파일용 native decode는 모든 조건에서 없었다.

### 최초 구현 후보와 후속 검증에 따른 보류

**아래는 Windows 비교에서 얻은 최초 후보이며, 후속 Pixel 검증 뒤 일괄 적용 권고를 보류했다.**
같은 빌드의 Windows 재시험 4회에서는 개선이 반복됐지만, native Android Chrome의
조건부 direct 전송 4회에서는 기존 기준 최대 약 0.75/4.38초, 64 KiB 기준
약 5.92/2.57초로 일관된 개선이 없었다. Pixel의 미디어 기준선도 불안정해
버퍼링 인과는 확정할 수 없다. 전송 큐 조건별 검증 없이 이 수치만 제품에 적용하지 않는다.
[로컬 재시험·Pixel 반대 근거와 한계](preload-local-pixel-retest-2026-10-18.md).

최초 제안은 preload의 capacity 기준만 256→64 KiB로 줄이는 최소 변경이었다.
두 진입점에 같은 상수를 사용하고 기존 capacity 이벤트·timeout·취소·소유권
검사를 유지하면 새 타이머나 큐, 프로토콜을 도입할 필요가 없다. 이 환경에서는
23 MB가 더 빨라졌고 115 MB는 약761 ms(11.3%) 더 걸렸지만 제어 지연은 줄었다.
전송 속도가 모든 망에서 개선된다는 주장은 하지 않는다.

매 청크 8 ms 대기는 115 MB를17.9초까지 늦추면서 window64 대비 의미 있는
추가 지연 개선을 입증하지 못했다. 현재 자료로는 제품 기본값에 더할 이유가 부족하다.
후속 Pixel 조건에서 64 KiB만으로 충분하지 않다는 관측이 나왔으므로,
조건을 더 분리한 뒤 취소 가능한 pacing·전체 송신 예산·control 우선 gate를 검토한다.
이번에 특정 pacing 값이나 새 큐 구조의 효과가 입증된 것은 아니다.
아래 항목 중 pacing/토큰 관련 요구는 그 추가 설계를 채택할 때 적용한다.

## 제품화 전에 필요한 안전 조건

1. **현재 재생을 먼저 처리한다.** 정확한 preload가 현재 곡으로 승격되면
   speculative pacing을 재평가한다. 실험의 단순 8 ms 대기는 승격 뒤에도 남는다.
2. **두 preload 진입점을 함께 다룬다.** broadcast와 late-join unicast가 서로
   다른 정책으로 우회하지 않게 한다. source/session/connection 소유권을 유지한다.
3. **취소 가능한 대기와 제한된 backlog를 사용한다.** 취소·재접속·곡 교체 뒤
   오래된 청크나 END를 보내지 않는다. 정지·background 뒤 credit을 무제한 쌓아
   복귀 순간 burst를 만들지 않는다. 제품 대기는 operation 수명과 함께 정리한다.
4. **pacing 대기를 stall로 오인하지 않는다.** 송신의 30초 capacity timeout과
   의도된 priority 대기를 분리한다. 수신 watchdog은 START 후 30초, contiguous
   progress 후 15초이며 현재 파일의 바이트 진행만 일부 대기 연장 근거로 쓴다.
   control이 바쁘다는 이유로 무기한 정지하면 정상 preload도 폐기될 수 있다.
5. **실제 send 단위로 예산을 계산한다.** pump의 `beforeChunk`는 읽기 전후와
   capacity/priority 재확인 때 여러 번 호출된다. 매 호출마다 토큰을 차감하면
   이중 차감·예약 누수가 생긴다. 성공·취소·소유권 교체 경계를 구분해야 한다.
6. **호스트 전체 부하와 공평성을 검증한다.** direct 수신자 최대 8명 각각에
   같은 상한을 주면 호스트 총 송신량은 증가한다. 느린 한 수신자가 빠른 수신자의
   완료를 막지 않는 기존 per-peer 성질을 유지하면서 전체 예산을 검토한다.
7. **제어 메시지의 신뢰성·순서를 보존한다.** control을 unreliable/unordered로
   바꾸거나 END를 control로 이동하는 변경은 이번 최소 설계에 포함하지 않는다.
   control backlog에 양보하는 보조 gate도 native 큐 전체의 지연 보장은 아니다.

고정 8 ms는 원인 분리를 위한 실험값이며 모든 기기·망에서 사용할 최적값으로
선정한 것이 아니다. 전체 unit/E2E, slow peer, 취소·복구·승격·late join,
direct 8명·R2/mixed, background timer 제한, 실제 Android·Wi-Fi·Bluetooth·가청
싱크를 통과하기 전에는 안전한 제품 수정이나 문제 종결로 보지 않는다.

## 로컬 근거

ignored `scratch/preload-youtube-ab-2026-10-18/`에 다음을 보관한다.

- `build-preload-pacing-experiments.mjs`와 build log.
- `experiment-limit64/`, `experiment-pace8-limit64/`의 manifest, source-transform
  diff, 원본/변형 소스 사본, 실험 dist.
- `create-pacing-runner.mjs`, `pacing-runner.mts`, `pacing-analyze.mjs`.
- `real-pacing-23-*-r*.json`과 screenshots, summary/analysis 및 실행 log.
- `real-pacing-115-*-r1.json`과 screenshots, summary/analysis 및 실행 log.
- 기존 계측 helper·local Worker 설정·파일 fixture와 앞선 A/B 원본.

계측은 같은 PC 시계의 native send/message와 앱 handler 시점을 비교한다.
YouTube API 시간 진행은 실제 스피커 녹음이나 최종 가청 싱크를 대신하지 않는다.
운영 서버·사용자 데이터는 이 실험으로 변경하지 않는다.
