# 프리로드 제어 지연: 로컬 재시험과 Pixel 확인

- Date: 2026-10-18 KST.
- Status: 로컬 실제 YouTube 비교 4회 완료, 실행·파일 무결성·재생 유지
  검증 4 pass / 0 fail / 0 skip. baseline의 제어 전달 지연은 재현됐다.
  Pixel은 7개 앱 시도를 보존했다. 조건부 direct 전송 4회는 무결성/ACK 통과,
  미디어 품질은 무전송 기준부터 부적격이며 제어 지연도 두 정책 모두 크게 변했다.
  **이 조사 시점에는 64 KiB 단독 변경의 일괄 적용 권고를 보류했다.**
- Scope: 기존 256 KiB preload capacity 기준과 scratch 전용 64 KiB 변형을
  같은 빌드로 재시험한다. 제품 소스 수정·커밋·배포·릴리스 후보 검증은 없다.
- Tested source: `256f1f92988248462de857dd69232bda8c7ea474`.
  운영 runtime `e47d0bb5216c9d66bbbc7e28a0cc1cf52bb72c1b`
  (App 8.11.14 / cache v716)과 runtime·설정·package/lockfile diff 없음.
- Related: [앞선 9회 비교와 정책 후보](preload-control-priority-investigation-2026-10-18.md),
  [구신 버전 실제 공급자 비교](youtube-preload-live-ab-2026-10-18.md),
  [릴리스 기록](../release-record.md).

후속: [느린 망·다수 수신자·취소·승격 검증](preload-capacity-validation-2026-10-18.md)
뒤 오너는 잔여 병목을 문서화하고 64 KiB 최소 완화를 배포하도록 지시했다.
본 Pixel 결과와 미확정 onError 원인은 삭제하거나 성공으로 바꾸지 않는다.

## 로컬 조건과 빌드 식별

2026-10-18 06:04–06:08 KST, Windows 11 / Chromium 153.0.8010.12에서
호스트·게스트 각각 한 context, 실제 YouTube `bnh70V0yu2s`와 실제 파일 input을
사용했다. 제품 Cloudflare 어댑터·로컬 Worker/DO·direct WebRTC를 사용한다.
guest의 Android UA/touch는 분기 선택용이며 실제 Android OS가 아니다.

앞선 baseline `after-dist/`와 `experiment-limit64/dist/`를 재빌드하지 않고
그대로 사용했다. 64 KiB 변형은 preload의 broadcast/unicast capacity 기준만
낮춘다. wire 청크는 기존 64 KiB이며 이번 실행은 broadcast 경로다.
64 KiB는 hard queue cap이나 control 전달 지연 상한을 보장하는 값이 아니다.

각 크기에서 baseline → window64를 1회씩, PLAYING 확인 뒤 warmup 10초와
관측 45초를 적용했다. 별도 빌드·Pixel 부팅과 겹치지 않게 실행했다.
지연·jank·BUFFERING은 주입하지 않았다. 이번 재시험에는 preload-off 조건이나
순서 반전 반복이 없으며, 앞선 비교의 보강 자료다.

모든 경로는 ignored `scratch/preload-youtube-ab-2026-10-18/` 기준이다.
아래는 이번 사용 빌드와 변형 소스의 식별값이다. 두 조건이 서로 동일한 빌드라는
뜻이 아니라 각 조건에서 앞선 빌드를 재사용했다는 뜻이다.

| 식별 대상                                            | SHA-256                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| 원본 `src/storage/preload.ts`                        | `1455252262ae780499a2be0b7e456aa6d018bb0ed824a2f40c30e7441c7444a2` |
| 원본 `src/storage/chunk-pump.ts`                     | `0366c61bbd772cc392e28edbc03b4c1b52a31e6360b02fdc0c789b7a794a0d02` |
| window64 변형 `preload.ts`                           | `7f4805485643948489c11ed004a53e8f1424df0dfca9d82c39d84e3e22aa18b3` |
| `after-dist/index.html`                              | `c05d352a734e4f9c4aa374f66c7a1143ca18743d59bc4e2d5bceca771eae55aa` |
| `after-dist/assets/preload-BbMOPdv4.js`              | `6f6f166129c6c370b0fbe9d3e6316b4e496fa870b3c7b65dc6be891da0fa0a69` |
| `experiment-limit64/dist/index.html`                 | `80c7f8e6ddf648ee6222bad3348958571cab200adb629d499d707033069ca41d` |
| `experiment-limit64/dist/assets/preload-CrRqzCcj.js` | `09d81cce1b0e18dc77ca7459f93214be89d7a76571d6df33b3011499e2f8bed3` |
| `local-retest-runner.mts`                            | `74f032ad6023930957886f6d4773bbca6b01cd6ada245cac03128c2893df5fc5` |

원본 preload/chunk-pump hash는 검사 뒤에도 같았다. runner는 기존
`pacing-runner.mts`를 보존한 scratch 복사본이며 쉼표 구분 case 선택만 추가했다.
변형 manifest·diff·원본/변형 사본은 `experiment-limit64/`에 있다.

## 로컬 결과

제어 지연은 **native RTC send→message**이며 소리의 지연이나 가청 싱크가 아니다.
전송 시간은 첫 청크 수신부터 마지막 청크 수신까지다. 전송 중 표본은 호스트의
첫 청크 송신부터 게스트 마지막 청크 수신 사이에 송신된 heartbeat다.

| 파일 / 조건     | 전체 관측 최대 제어 지연 | 전송 중 최대 / 표본 수 | 전송 시간 | host sender discard | guest 완료 long task |
| --------------- | -----------------------: | ---------------------: | --------: | ------------------: | -------------------: |
| 23 MB baseline  |                 1,024 ms |           1,024 ms / 1 |  2,103 ms |                 322 |                 없음 |
| 23 MB window64  |                     3 ms |               1 ms / 1 |  1,026 ms |                   0 |                 없음 |
| 115 MB baseline |                 2,408 ms |           2,408 ms / 3 |  7,027 ms |                 435 |                52 ms |
| 115 MB window64 |                     1 ms |               1 ms / 2 |  5,408 ms |                   0 |                57 ms |

모든 실행에서 message→앱 handler 추가 지연은 0–1 ms였다. sender discard는
선택된 candidate-pair의 누적 통계다. 특정 폐기 패킷과 특정 heartbeat 지연을
직접 연결하는 패킷 캡처는 없으며, SCTP/UDP 내부의 정확한 원인을 확정하지 않는다.
115 MB 완료 부근의 52/57 ms long task는 별도 비용으로 남는다.

4회 모두 다음을 확인했다.

- 파일 23,040,044 bytes / 352청크 또는 115,200,044 bytes / 1,758청크와
  수신 Blob SHA-256 일치, 호스트의 preload ACK 1회 수신.
- 관측 중 mode=`youtube`, qid·video ID 유지, playerState=PLAYING.
  API 시간 진행량과 관측 경과 차이는 절대 1 ms 미만.
- BUFFERING episode, seek/pause/play/load/cue, `storage:use-preloaded`,
  앱의 파일용 native decode, pageerror, YouTube `onError` 모두 0.
- runner 종료 코드 0, 테스트 browser/context 종료 완료.

단, **console/network 전체 성공은 아니다.** 로컬 preview의
`/api/security-config`, `/api/announcement/current` 등 API 503과 YouTube 통계
요청 실패·경고가 각 raw에 64–66건 남는다. 앞선 harness와 같은 조건이며
pageerror·공급자 재생 오류와 구분한다. API 위치 진행은 디코딩된 각 프레임이나
스피커 출력의 실측이 아니다.

23 MB의 SHA-256은
`5749688e4e6306234de4add49e9191c5e8974e4d60de48671c4bd57dca4db83d`,
115 MB는
`9ff6b1b4e504e9a8fec2345dedcc3af8fa61d96dac5a2a06fd641e7556876d8d`다.
두 파일은 합성 PCM WAV이며 실제 사용자 FLAC을 사용한 검사는 아니다.

## 해석과 남은 한계

같은 Windows direct 경로에서 baseline 지연과 작은 capacity 기준의 개선이
다시 관측됐다. 이번에는 두 크기 모두 전송도 빨랐지만, 앞선 115 MB 비교에서는
window64가 더 느렸다. 따라서 파일 속도의 보편적 개선이나 최적값을 주장하지 않는다.
1–3 ms도 관측 최대값이며 제품의 보장 상한이 아니다.

실제 Android 기기·Wi-Fi·Bluetooth·가청 싱크, direct 다수 기기, late-join
unicast·취소·재접속·승격, R2/PRO, background는 이번 4회의 검증 밖이다.
전체 unit/E2E·배포 smoke를 돌린 검사가 아니며, 실제 Android 사건을 닫지 않는다.

## Pixel 에뮬레이터 단계

2026-10-18 06:09–06:26 KST, 기존 AVD `musixquare_pixel_8_api36`를 사용했다.
Android 16/API 36, 실제 Android Chrome 151.0.7922.137, 1080×2400/density420,
8 vCPU/6 GiB RAM, WHPX/host GPU다. UA의 Android 10은 축약 문자열이며 OS 판정에
사용하지 않았다. Windows 호스트는 Chromium 153.0.8010.12다. 로컬 4회가 끝난 뒤
에뮬레이터를 켰고 빌드나 다른 부하 시험을 병행하지 않았다.

`-no-snapshot-save`로 시작했으며 기존 snapshot renderer가 맞지 않아 cold boot가
진행됐다. 데이터 wipe·Chrome 업데이트·AVD 영구 설정 변경은 없다. Android Chrome은
기존 프로필의 native CDP를 썼고 autoplay 허용 플래그나 가짜 YouTube provider를
넣지 않았다. localhost preview/signaling 연결은 ADB reverse, CDP는 forward9223을
사용했다. 제품 STUN/TURN 자격증명은 사용하지 않았다.

### 연결 실패와 전송 경로를 분리한 과정

1. 최초 앱 시도는 guest data channel timeout으로 실패했다. 측정 이전 실패이며
   `pixel-baseline-first-baseline-off.*`에 원본·DOM·화면을 보존했다.
2. 최소 native RTC 진단에서 기본 mDNS 후보는 STUN 유무와 관계없이 연결되지 않았다.
   새 Windows 테스트 브라우저에만 `--disable-features=WebRtcHideLocalIpsWithMdns`를
   넣으면 STUN 없이도 양방향 두 채널이 연결됐다. 이후 모든 Pixel 앱 시험은 이
   플래그를 동일하게 사용했다. Pixel/사용자 브라우저 영구 설정은 건드리지 않았다.
3. 연결 후 무전송 기준을 45초 관측했다. 다음 자연 경로 ON 시도는 파일을 추가했으나
   **preload 청크가 0개**였다. 제품은 host/prflx 선택 쌍을 remote로 분류하며,
   이 로컬 preview에는 R2가 없어 전송되지 않았다. codec 실패나 capacity 정책의
   전송 실패로 세지 않는다. `pixel-functional-23-baseline-on.*`를 비교에서 제외했다.
4. 실제 direct pump 비교는 새 테스트 방에서만 E2E state hook으로 호스트의 해당
   peer를 local/data-target, 게스트 connectionType을 local로 지정했다. 파일 session을
   만들기 전 원래 remote 판정과 변경 결과를 저장했다. native 후보·SDP·getStats·
   WebRTC 바이트나 앱 코드를 위조/교체하지 않았다. 이는 **AVD NAT를 통과하는 실제
   RTC의 조건부 direct 시험**이지 제품 자동 라우팅 또는 실물 Android 검증이 아니다.

경로 판단 근거는 `src/network/peer-state.ts`의 `isLocalSelectedPair`/
`detectConnectionType`, `src/share/file-delivery-policy.ts`의 frozen route,
`src/storage/preload.ts`의 direct 대상 필터다. E2E 빌드에서 인터넷 STUN을 생략하는
동작과 AVD의 NAT 환경을 제품 결함으로 취급하지 않는다.

### 시계와 미디어의 사전 품질 기준

PC와 Pixel의 벽시계는 약 1.88초 달랐다. 각 역할마다 관측 전후 16회 CDP 왕복으로
`page Date.now - Node Date.now` 구간을 구하고 양쪽의 구간을 적용해 전달 지연을
산출했다. 표의 범위는 반복 측정 최솟값/최댓값이 아니라 **그 실행의 최대 지연에
대한 시계 측정 불확실성 구간**이다. timestamp 여유 2ms, 전후 구간 겹침과
벽시계/단조시계 경과 일치를 함께 확인했다. 관측은 각 기기 자체 시각으로 필터했다.
파일 SHA는 관측 종료 뒤 계산했고 실제 iframe video는 내부 타이머로 1초마다 읽었다.

미리 정한 미디어 적합성 기준은 시간 진행률 95–105%, 약2초 이상 정체 없음,
event-loop lag p95<100ms/max<500ms, visible·unpaused·readyState≥2와 실제 프레임
진행이다. **무전송 기준부터 BUFFERING 2회(합계4,164ms), 복구 pause/seek/play
2세트와 프레임/시간 정체가 있어 탈락했다.** UI 타이머 최대 지연은388.4ms,
영상 표본 최대 간격은1,064ms였다. CPU 렉 하나로 원인을 확정하지 않는다.
이 기준의 native 제어 최대 지연은3–20ms였다.

따라서 115 MB Pixel 부하 시험은 의도적으로 생략했다. 23 MB는 파일 무결성과
control 전달만 확인하고, 영상 품질 개선의 증거로 삼지 않는다. 첫 쌍의 반대 결과를
검증하기 위해 순서를 뒤집은 한 쌍만 추가했다.

### 조건부 direct 23 MB 결과

실행 순서는256→64→64→256 KiB다. 매회 새 방/호스트 context/Pixel 탭과 test origin
저장소 초기화, PLAYING 후10초 warmup, 45초 관측을 사용했다. 측정 중 앱 재생·싱크
버튼을 추가로 누르지 않았다. 두 preview의 preload asset SHA는 위 표와 일치했다.

| 실행           | 최대 native control 지연 구간 | 전송 중 송신 heartbeat | 전송 시간 | 무결성/ACK |
| -------------- | ----------------------------: | ---------------------: | --------: | ---------- |
| 기존256, 첫 쌍 |                    741–754 ms |                      7 | 19,689 ms | pass       |
| 실험64, 첫 쌍  |                5,902–5,924 ms |                      9 | 24,807 ms | pass       |
| 실험64, 역순   |                2,560–2,575 ms |                      7 | 21,154 ms | pass       |
| 기존256, 역순  |                4,361–4,377 ms |                      9 | 24,734 ms | pass       |

네 건 모두352청크/23,040,044bytes/위 fixture SHA 일치, ACK 송신과 호스트 수신
각1회다. 시계 연속성 검사는 모두 통과했고, 선택 경로는 UDP host/prflx이며 송신
discard 카운터는0이었다. 최대 지연은 모두 전송 중 송신한 heartbeat에 나타났다.
64 첫 실행은 늦은 heartbeat들이 몰려 도착했으며 message→앱 handler는0–1ms였다.
따라서 수신 후 handler 처리나 보정하지 않은 PC/Pixel 시계차로5.9초를 설명하지
않는다. 가상 NAT·SCTP·호스트 자원·망 중 정확한 원인 분리는 이 자료만으로 못 한다.

**256도0.75초와4.38초로 변했다. 64의 일관된 개선도, 64가 악화의 원인이라는
결론도 입증되지 않았다.** Windows의1–3ms 결과를 보편적 보장으로 확대하지 않는다.
전송 대기량만 줄이면 control을 충분히 보호한다는 가정은 이 조건에서 성립하지 않았다.

### 미디어 실패와 계측 한계도 보존

- 조건부 direct 네 실행 모두 미디어 적합성 gate는 통과하지 못했다. BUFFERING과
  복구 호출은 무전송 기준에도 있었으므로 횟수만으로 preload 인과를 확정하지 않는다.
- 첫256 실행에서는 **호스트 YouTube `onError(5)` → host 상태 -1 송신 → guest
  `stopVideo` → CUED/time0** 경로가 확인됐다. 오류는 파일 완료 약11.3초 뒤 발생했다.
  후속 heartbeat로 stopVideo가 반복됐으며 호스트 provider 오류의 원인은 미확정이다.
  이를 단순 에뮬레이터 렉, 파일 데이터 오염, 64 정책의 개선 근거 중 어느 것으로도
  단정하지 않는다. 다른 세 direct 실행의 host/guest provider onError는0이었다.
- 이때 영상 프레임 카운터도 리셋됐다. 원 runner의 last−first 프레임/시간 차이와
  `playbackPreserved:true`(mode/qid 동일만 검사)를 정상 미디어 재생의 증거로 쓰지 않는다.
  독립 분석에는 `stopVideo`를 포함한 모든 변경 호출·양쪽 provider 오류를 추가했다.
- 앱 실행7회는 최초 연결 실패1, OFF 관측1, 자연 ON 미전송1, 조건부 direct4다.
  4회 무결성 pass가7회 전체 성공이나 미디어 성능 pass를 뜻하지 않는다. 115 MB,
  실제 무선망/폰/Bluetooth/가청 싱크·다수 peer·PRO/R2·background는 미검증이다.

현재 판단은 **64 KiB 단독 변경의 일괄 적용을 보류하고 조건 의존성을 먼저
검증한다**는 것이다. 실제 기기·native 전송 큐의 추가 관측 없이 특정 pacing 값이나
새 큐 구조를 제품에 도입하지 않는다. 이번에는 제품 소스·버전·배포를 바꾸지 않았다.

### Pixel 원본과 정리

ignored `scratch/pixel-preload-2026-10-18/`에 `environment.json`, emulator log,
`ice-probe.mts`와 `ice-*.json`, `runner.mts`, 앱 시도7개의JSON/log/PNG,
`baseline-independent-review.json`, `functional-independent-review.json`과 분석 코드,
`served-build-verification.json`을 보존한다. 실패 DOM도 남긴다. manifest는 최종 파일
해시 목록이며 중간 runner revision이 모두 동일했다는 뜻은 아니다.

시험 종료 후 테스트 탭/호스트 browser, 소유한 preview4382/4383·Worker8797,
ADB reverse/forward9223을 정리했고 이번에 켠 Pixel도 종료했다. 기존 Chrome 탭,
사용자 데이터·AVD 설정·저장 snapshot은 유지했다. 시스템 성능 비교가 불안정하다는
사용자의 제보를 이유로 실패 원본을 삭제하거나 좋은 실행만 골라 세지 않았다.

## 재현 명령과 원본

저장된 두 preview가 baseline 4382 / window64 4383, 로컬 signaling이 8797에
준비된 상태에서 실행한다. 서버 시작 방법은 scratch `cf-README.md` 및 앞선
조사 문서를 따른다. 아래 명령은 프로덕션 서버를 사용하지 않는다.

```powershell
node scratch/preload-youtube-ab-2026-10-18/local-retest-runner.mts --case baseline,window64 --repeat 1 --observe-ms 45000 --warmup-ms 10000 --tag local-retest-23
node scratch/preload-youtube-ab-2026-10-18/local-retest-runner.mts --case baseline,window64 --repeat 1 --observe-ms 45000 --warmup-ms 10000 --fixture scratch/preload-youtube-ab-2026-10-18/real-audio-600s.wav --tag local-retest-115
node scratch/preload-youtube-ab-2026-10-18/pacing-analyze.mjs local-retest-23
node scratch/preload-youtube-ab-2026-10-18/pacing-analyze.mjs local-retest-115
```

새 재시험은 `--tag`를 바꿔 기존 증거를 덮어쓰지 않는다.
현재 원본 네 개는 `real-local-retest-{23,115}-{baseline,window64}-r1.json`과
동명 PNG다. 각 크기의 `real-local-retest-*-analysis.json`, `*-summary.json`,
`*-run.log` 및 `local-retest-manifest.json`에 결과·실행 이력·파일 hash를 보존한다.
