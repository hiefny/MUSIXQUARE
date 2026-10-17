# YouTube 재생과 실제 파일 프리로드 동시 실행 비교

- Date: 2026-10-18 KST.
- Status: 완료. 18개 비교 실행 완료 / 미완료 0 / skip 0.
  실제 YouTube 10개, controlled provider 8개다. 전송 지연을 관측했으므로
  이 숫자는 성능 결함 0건이나 release sign-off를 뜻하지 않는다.
- Scope: 일반방의 실제 파일 프리로드가 YouTube 재생 중 전달 지연이나
  버퍼링을 만드는지 관측한다. 제품 코드 수정·배포는 하지 않는다.

후속: [64 KiB 후보의 추가 검증과 릴리스 판단](preload-capacity-validation-2026-10-18.md).
아래 결과는 원래 두 버전의 비교로 보존한다.

## 대상과 환경

| 대상    | 소스 SHA                                   | App / cache    |
| ------- | ------------------------------------------ | -------------- |
| 수정 전 | `600f60467e16e8e73610a35052f52965cd54d4ce` | 8.11.13 / v714 |
| 수정 후 | `e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b` | 8.11.14 / v716 |

수정 후 빌드 checkout은 문서 후속 커밋 `256f1f92988248462de857dd69232bda8c7ea474`다.
배포 SHA와 runtime 소스·설정·package/lockfile diff 없음도 확인했다.
각 버전의 소스를 동일한 Node 24.13.1 / npm 11.8.0 / 설치된 의존성으로
`vite build --mode e2e`하여 별도 localhost 4381/4382에서 실행했다.
배포된 production artifact를 그대로 실행한 비교는 아니다.

Windows 11 Pro(10.0.26200), i7-13800H, 논리 CPU 20개, RAM 약 63.83 GiB,
Playwright 1.63.0 / Chromium 153.0.8010.12 / Wrangler 4.148.0.
호스트와 게스트는 같은 PC의 서로 다른 fresh browser context다.
guest는 Android UA/touch를 사용해 Android 보정 분기를 실행한다.
실제 Android 하드웨어·Chrome·오디오 출력 검사는 아니다.

초기 탐색에서 기본 E2E의 PeerJS 경로와 production Cloudflare 어댑터의
채널 구성이 다름을 확인했다. 본 비교는 제품 Cloudflare 어댑터와 수정하지 않은
signaling Worker/DO를 로컬 Wrangler에서 실행했다. Standard 방 인증과 WebRTC
연결은 실제이며, `musixquare-data`와 `musixquare-control` 두 채널을 확인했다.
수정 전후 signaling/transport 코드는 동일하다.
선택된 ICE는 host/host UDP다. Cloudflare edge·TURN·R2·실제 무선 기기간 회선은
통과하지 않는다. E2E 모드는 상태 getter/bus 노출 및 TURN 조회 생략이 있고,
account session 조회만 명시적 익명 응답으로 mock했다.

## 방법

각 provider에서 버전 2종 × 프리로드 유무 × 반복 2회로 비교한다.
두 번째 반복은 순서를 뒤집으며, 매 조건마다 새 방·새 context를 사용한다.
실제 host UI의 파일 input으로 다음 트랙을 추가한다. 상태 강제 변경으로
preload 완료나 playback을 만들지 않는다. 지연·BUFFERING·main-thread 정지를
인위적으로 주입하지 않는다.

- Controlled provider: 기존 fake YouTube를 `advanceClock: true`로 사용.
  10초 warmup 뒤 30초 측정. 파일 전송·저장·동기화 제품 코드는 실제다.
- Live provider: 실제 YouTube iframe/API/media, 영상 `bnh70V0yu2s`.
  초기 PLAYING과 영상 ID 확인 뒤 10초 warmup, 45초 측정.
  YouTube 응답이나 재생 상태를 mock하지 않는다.
- 기본 파일: 합성 PCM WAV, stereo 48 kHz / 16-bit / 120초,
  **23,040,044 bytes**, SHA-256
  `5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`.
- guest에서 352개 실제 청크 수신, 완료 Blob의 SHA-256과 ACK를 확인한다.
  Blob hashing은 측정 구간 뒤에 수행한다.
- 프레임 송수신 시각, 이벤트 루프 지연, long task, native decode, mode/qid/video,
  iframe 명령, provider state, 재생 시간 진행, RTC channel/candidate 통계를 기록한다.
- live 조건에는 native `RTCDataChannel.send`와 `message` 시각도 기록하여
  앱 수신 handler에 도착하기 전·후를 구분한다. 두 브라우저는 같은 PC 시계를 쓴다.
  계측 자체의 오버헤드가 없다는 주장은 하지 않는다.

정상 프리로드 완료의 `storage:file-ready`는 background 파일에서도 발생한다.
이 이벤트만 보고 현재 재생으로 전환됐다고 판정하지 않는다.
`storage:use-preloaded`, mode/qid/video, iframe 명령을 함께 본다.
또한 mode가 YouTube로 유지되는 것과 영상 시간이 실제 진행하는 것을 구분한다.

## Controlled provider 결과

8/8 실행 완료, page error 0, skip 0. 프리로드 4/4에서 전체 바이트·해시·ACK 일치.

| 버전    | 프리로드 | 반복 1 heartbeat 최대 지연 | 반복 2 최대 지연 | 측정 중 iframe 변경 명령 |
| ------- | -------- | -------------------------- | ---------------- | ------------------------ |
| 수정 전 | 없음     | 1 ms                       | 2 ms             | 0                        |
| 수정 후 | 없음     | 2 ms                       | 2 ms             | 0                        |
| 수정 전 | 23 MB    | 697 ms                     | 1,943 ms         | 0                        |
| 수정 후 | 23 MB    | 1,901 ms                   | 686 ms           | 0                        |

전송 2,862–4,104 ms, 마지막 청크→file-ready 13–17 ms, →ACK 19–36 ms.
guest long task와 native decode 0. mode/qid 유지, `storage:use-preloaded` 없음.
파일은 현재 곡을 디코딩/교체하지 않고 RAM에 다음 트랙으로 준비됐다.
fake provider의 BUFFERING 미발생은 실제 YouTube buffering 검증을 대체하지 않는다.
이 조건은 coarse correction의 3초 경계를 넘지 않았다.

## Live provider 결과

기본 23 MB 비교 8/8 실행 완료, page error 0, provider error 0, skip 0.
프리로드 4/4의 전체 바이트·해시·ACK 일치. 초기 재생 준비 구간을 제외한
각 45초 관측 구간에서 provider BUFFERING, iframe 변경 명령,
`storage:use-preloaded`는 모두 0건이다.

| 버전    | 프리로드 | 반복 1 heartbeat 최대 지연 | 반복 2 최대 지연 | BUFFERING / iframe 변경 명령 |
| ------- | -------- | -------------------------- | ---------------- | ---------------------------- |
| 수정 전 | 없음     | 2 ms                       | 1 ms             | 0 / 0                        |
| 수정 후 | 없음     | 2 ms                       | 1 ms             | 0 / 0                        |
| 수정 전 | 23 MB    | 1,672 ms                   | 1,966 ms         | 0 / 0                        |
| 수정 후 | 23 MB    | 1,358 ms                   | 981 ms           | 0 / 0                        |

8회 모두 초기/측정 중 player state는 PLAYING(1), 영상 ID·현재 qid·YouTube mode가
유지됐고, getCurrentTime의 진행량도 약 44.75초의 샘플 경과 시간과 일치했다.
이는 IFrame API 관측이며 스피커의 실제 가청 동기화 측정은 아니다.

파일 청크 전송 2,583–3,645 ms. guest의 이벤트 루프 최대 지연은 14.9 ms 이하,
앱 main-thread long task 및 파일용 native `decodeAudioData` 호출은 0.
YouTube 자체의 영상·오디오 디코더가 동작하지 않았다는 뜻은 아니다.

지연된 heartbeat의 **native RTC send→message** 시간이 위 지연과 같았다.
message 수신 뒤 앱의 network:data handler 전달까지는 0–1 ms였다.
따라서 이 실험에서 1–2초 지연은 앱이 수신한 뒤 파일을 디코딩하거나 기다리는
지점이 아니라 RTC 송신 API와 수신 message 이벤트 사이에 있었다.
그 안의 SCTP/UDP/브라우저 내부 원인까지 분리한 것은 아니다.

반복 수가 작고 같은 전송 코드를 쓰므로 위 수치 차이를 수정본의 전송 성능 향상으로
해석하지 않는다. 23 MB 자연 부하에서는 구버전도 3초 coarse correction 조건에
진입하지 않았고 BUFFERING도 없어, 기존 잘못된 seek와 수정 효과를 다시 재현한 것은
아니다. 그 분기 검증은 [앞선 handler 재현](youtube-heartbeat-delay-reproduction-2026-10-17.md)과
[수정 회귀 검사](youtube-heartbeat-delay-fix-2026-10-17.md)에 있다.

## 더 큰 파일 확인

115,200,044 bytes / 600초 PCM WAV, SHA-256
`9ff6b1b4e504e9a8fec2345dedcc3af8fa61d96dac5a2a06fd641e7556876d8d`.
실제 YouTube 조건에서 구·신 버전 각각 75초 관측을 추가했다(각 1회).

| 버전    | 청크 / 바이트       | 청크 전송 시간 | heartbeat 최대 지연 | BUFFERING / iframe 변경 | 수신 완료 부근 long task |
| ------- | ------------------- | -------------- | ------------------- | ----------------------- | ------------------------ |
| 수정 전 | 1,758 / 115,200,044 | 6,689 ms       | 1,832 ms            | 0 / 0                   | 69 ms, 1회               |
| 수정 후 | 1,758 / 115,200,044 | 7,591 ms       | 1,899 ms            | 0 / 0                   | 74 ms, 1회               |

두 경우 모두 Blob 해시와 호스트의 ACK 수신까지 일치하고, 페이지/provider 오류 0,
파일용 native decode 0. YouTube 영상·qid·mode와 재생 시간 진행이 유지됐다.
이벤트 루프 최대 지연은 각각 45.2 / 66.8 ms였다.
긴 작업은 파일 수신 완료와 시점이 겹치지만 CPU profile을 수집하지 않았으므로
특정 Blob/GC 함수의 비용이라고 단정하지 않는다. 이 결과도 실제 Android의
수신 완료 처리 시간을 대신하지 않는다.

## 판독과 한계

실제 YouTube 10회에서 버퍼링·불필요한 seek·현재 곡의 파일 전환은 관측하지 못했다.
한편 기본 비교에서 프리로드 중 제어 프레임 전달 지연은 반복 관측됐다.
파일 데이터가 YouTube 상태를 직접 덮어쓰는 현상과 구분한다.
수정 전후의 동기화 수정은 늦은 heartbeat의 위치 해석을 고치는 것이며,
파일 전송 속도나 control 채널의 전달 시간을 바꾸는 수정은 아니다.

같은 RTC 연결의 두 채널은 완전한 자원 격리를 보장하는 구조가 아니다.
코드상 control 수신이 파일 완료를 기다리는 공용 직렬 큐는 발견하지 못했다.
sender의 `packetsDiscardedOnSend` 증가는 후보 근거지만 누적 통계이므로
특정 heartbeat의 원인을 SCTP 재전송 등으로 확정하지 않는다.

최대로 지연된 heartbeat는 마지막 청크보다 23 MB에서 약 0.76–1.31초,
115 MB에서 약 4.41–5.29초 먼저 도착했다. 대용량 완료 부근의 69/74 ms long task와
전송 중 1–2초 RTC 전달 지연은 서로 다른 시점의 관측이며 같은 원인으로 합치지 않는다.

따라서 이번 결과는 **프리로드가 제어 메시지 지연을 만들 수 있다는 로컬 실증**과
**이 조건에서는 영상 재생 방해를 관측하지 못했다는 결과**를 함께 남긴다.
구·신 버전 모두 자연 부하에서 기존 잘못된 seek 분기가 실행되지 않았으므로
이번 자연 부하 비교만으로 수정 효과의 크기를 산출하지 않는다.
프리로드 동안 control 전달 지연과 큰 파일 완료 비용의 완화는 별도 성능 조사 대상으로
남기며, 이번 turn에서 전송 정책이나 앱 동작을 바꾸지 않았다.

실제 Android의 가청 싱크, 사용자 당시 Wi-Fi 사건, Bluetooth 출력,
여러 물리 장치의 동시 부하, WAN/R2/TURN 경로, 장기/백그라운드 재생은
이 검사로 닫지 않는다. 전체 unit/E2E나 릴리스 후보 CI를 다시 돌린 QA도 아니다.

## 로컬 근거와 재실행

원본·runner는 ignored `scratch/preload-youtube-ab-2026-10-18/`에 보관했다.
`controlled-runner.mts`, `controlled-instrumentation.mts`, `controlled-analyze.mts`,
`real-runner.mts`, `real-provider-instrumentation.mts`, `real-analyze.mjs`,
`cf-wrangler.toml`, `cf-worker.ts`, `cf-methodology.md`를 함께 사용한다.

```text
node controlled-runner.mts --case all --repeat 2 --transport cloudflare --signaling-url ws://127.0.0.1:8797/api/rooms --tag cf-matrix
node real-runner.mts --case all --repeat 2 --transport cloudflare --signaling-url ws://127.0.0.1:8797/api/rooms --tag cf-matrix
```

명령은 저장소 루트에서 각 script의 전체 `scratch/...` 상대 경로로 실행한다.
`controlled-cf-matrix-*-r*.json` / `real-cf-matrix-*-r*.json`이 원본이고,
각 `*-analysis.json`은 원본에서 재생성한다. 실험용 서버는 localhost 전용이다.
운영 데이터·secret·사용자 파일을 외부로 업로드하지 않았다.
추가 대용량 실행은 `--case before-on|after-on --observe-ms 75000 --repeat 1
--fixture scratch/preload-youtube-ab-2026-10-18/real-audio-600s.wav --tag cf-large`를
사용했으며 `real-cf-large-*-r1.json`에 보관했다. setup용 provider 가능성 검사에서
진단 HTML의 괄호 누락을 먼저 수정했고, 그 무효 실행은 위 18개 비교에 넣지 않았다.
