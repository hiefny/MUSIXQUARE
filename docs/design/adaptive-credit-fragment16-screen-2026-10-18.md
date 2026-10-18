# AF19216 — 고RTT 전송 개선 후보 검증 결과

작성일: 2026-10-18. **최초8실행을 완료했지만 동적망 비교의 성능 기준을 넘어서
후보를 채택하지 않았다.** 제품 런타임 이식·배포는 없으며 운영은 그대로다.
분석기 오탐과 실제 성능 실패를 구분하고, 원본·별도 재판독·미실행 범위를 보존한다.

## 현재 판단

첫 선별에서 23,040,044 B 프리로드 완료가 **71.583→48.450초(32.32% 단축)**였고,
후보의 앱 제어 메시지 최대 지연은 1초 안이었다. `stage-1-decision.json`은
`eligible: true`, 위반 0건을 기록한다. 같은 입력을 읽은 독립 감사 출력도 이
첫 쌍의 판정과 일치하며 담당자 검토도 완료했다. 후속 일반 전송 AF19216→B128은
64.217→36.760초로 42.76% 짧아졌고 독립 감사도 통과했다. slow2는
101.610→101.614초로 사실상 같으며 제어 지연·무결성·관측 재생 보존 감사가
통과했다. 동적망은 B149.978→AF122.697초로 18.19% 짧아졌지만 **초기/전체
제어 지연 증가가 사전 예산을 넘어서 paired 성능 판정이 실패했다.** 원래 작은
tail 분석 오탐을 고친 것과 이 실제 성능 실패는 별개다. 동적망 최종 독립 감사도
같은 성능 실패를 확인했으며, 역순4회·multi/lifecycle6회·제품 이식·배포는 중단하고 미실행으로
남긴다. 파일 전송 단축은 관측됐지만 현재 후보는 출시 자격을 얻지 못했다.

운영은 `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3` / App 8.11.20 / cache v723의
논리 청크 64 KiB·로컬 기준 64 KiB·수신확인 창 128 KiB를 유지한다. 실험 기준과
후보는 둘 다 미배포 main `49a877c12d5e1efc695693797f9823d957e7d992`를 사용하며,
공통 Qlease 보호를 포함한다. **이번 B128은 현재 운영 전체 버전과 동일하다는
뜻이 아니라, 같은 main에서 전송 변경이 없는 실험 대조군이라는 뜻이다.**

## 이전 실패와 이번 가설

별도 A192 선별은 71.791→49.516초로 31.03% 짧아졌지만, 후보의 raw sync-pong
최대 1063.8 ms와 excess p95 증가 +200 ms가 사전 기준을 넘었다. 실패와 원시
자료를 보존했고 나머지 6조건은 실행하지 않았다. 이번 결과로 이를 통과로
바꾸거나 이전 B128 시간을 새 비교의 분모로 재사용하지 않는다.

그 A192의 결정적인 초기 지연은 192 KiB 확대 이전의 128 KiB 단계에 발생했다.
최대값은 약 +0.797초, p95 순위에 걸린 값은 약 +2.791초이며 첫 확대 probe는
+15.562초였다. 더 빠른 후보의 표본 수가 적어 p95의 순위도 달랐다. 따라서
당시 실패는 유효하지만, 그 값만으로 192 확대가 초기 지연을 악화시켰다고
확정하지 않는다. 큰 지연의 대부분은 native send→receive 경계에서 관측됐고,
그 앞뒤 앱 처리 시간은 작았다. SCTP·운영체제·shaper 내부 중 정확한 원인은
확정하지 않았다.

이전 F16 실험에서는 pong이 여러 native 조각 사이, 전체 논리 청크 완료 전에
도착한 근거가 있었다. 이번 가설은 그 작은 메시지 경계를 유지하면서 창을
최대 192 KiB까지만 늘려, 초기 제어 지연과 고RTT 처리량을 함께 개선할 수
있는지 확인하는 것이다. 이전 F16 실험은 다른 토폴로지·조건이라 이번의 성능
분모가 아니다. 이전 cap256 A2·AF16의 대역폭 급락 실패도 그대로 유효하다.

## 후보 구성과 변경하지 않은 계약

AF19216은 보존된 AF16 조합의 runtime 3파일을 사용한다. adapter와 fragment
codec은 이전 조합과 byte-exact이며, controller는 `ADAPTIVE_MAX_BYTES`의
256→192 KiB 한 줄만 다르다. 현재-main 기준 실제 변경은 runtime 3파일과
테스트/fixture이며, `types.ts`, storage pump, 기존 공통 backpressure helper,
Worker·의존성·스키마·비밀·바인딩은 변경하지 않는다.

| 항목 | B128 | AF19216 |
| --- | --- | --- |
| 논리 FILE/PRELOAD payload 청크 | 64 KiB | 동일 |
| 로컬 bufferedAmount 송신 대기 기준 | 64 KiB | 동일 |
| 앱 수신확인 창 | fixed 128 KiB | 협상 후 128→192 KiB, 실패 시 128로 축소 |
| native bulk 메시지 | 기존 encoded frame | 협상 후 메시지당 최대 16 KiB, 16 B envelope 포함 |
| 누적 receipt | payload 64 KiB 또는 부분 tail 20 ms | 동일, 전체 논리 frame decode 후에만 생성 |
| 제어 메시지 | bulk payload credit 밖 | 동일 |
| 수명 | 정확한 연결의 누적 S/R/A | 동일, 취소·승격으로 초기화하지 않음 |

한 논리 frame의 모든 native 조각은 동기적으로 제출한다. 마지막 조각까지
송신 성공한 후 `noteSent`를 한 번 호출하며, 수신자는 전체 frame 재조립·decode
후에만 받은 payload를 회계한다. **조각별 부분 credit이나 새 비동기 송신 pump는
도입하지 않았다.** 중간 native send 실패·손상·잘못된 조각 순서·decode 실패는
해당 연결을 종료하며 부분 frame을 성공 전송이나 앱 데이터로 노출하지 않는다.
수신 중 보관은 한 개의 제한된 assembly, 송신 timing metadata는 최대 8개다.

private 협상은 앱 입장 APPLIED 완료 후 시작한다. 로컬 ready 송신 성공과
상대의 정확한 nonce echo를 모두 확보하기 전에는 fragment/adaptive를 켜지
않는다. v1 credit 상대는 fixed128·학습 OFF다. v1 자체가 없는 구형 상대는
기존 1초 grace 후 legacy bypass를 유지한다. 이 마지막 경로를 fixed128 보호로
표현하면 안 된다. 늦은 ready는 S/A/debt를 보존하며 예전 미추적 ACK는 부채만
해제하고 새 학습에는 사용하지 않는다.

adaptive의 기존 rate·gain·age·gap·idle·cooldown·deadline은 그대로다. 최소
2초·8개 표본 블록 및 연속 블록의 보수적 처리율, 추가 byte/처리율 250 ms
조건을 사용하고, probe는 최소 20% 처리율 개선과 ACK age 증가 100 ms 이하를
요구한다. 애매한 표본·압축 ACK·악화는 128로 축소하고 30초 cooldown을 둔다.
상한은 192 KiB, 단계 watchdog은 8초다. 이 관측값은 순수 RTT나 미래 지연의
상한이 아니다. 이미 송신한 부채는 축소해도 회수되지 않는다.

제품 이식 시 구체 controller의 작은 `diagnosticSnapshot` getter는 유지하는
방향으로 합의했다. 현재 getter는 복사된 숫자·고정 문자열만 반환하고 상태,
시간, 타이머, notify, I/O를 바꾸지 않는다. 전역 hook·UI·네트워크 polling이나
공통 transport 인터페이스로 넓히지 않는다. `legacy`·`disposed`의 windowBytes는
강제되는 송신 cap을 뜻하지 않으므로 phase와 함께 해석한다. 제품 이식 때
scratch 문구를 정리하고 수동 읽기·반환 복사 변경의 무부작용 핀을 추가하되,
현재 동결 runtime은 변경하지 않는다.

## 측정·판정 계약

`root-acceptance.md`와 `execution-freeze.json`이 결과 관측 전 고정한 기준이다.
Windows / Node v24.13.1 / Chromium153.0.8010.12, 같은 PC의 실제 일반방 RTC와 storage/UI 경로,
desktop UA·manual/output offset 0, 600초 진행형 controlled YouTube를 사용한다.
실제 공급자·가청 출력 시험이 아니다. 한 host와 한 guest, 로컬 signaling,
ICE 서버 없음, 손실 주입 없음이며 guest RTC에 8 또는 2 Mbps 및 각 방향 100 ms를
설정한다. HTTP/WS는 shaping에서 제외한다.

warmup 10초→settle 2초→파일 없는 baseline 24초→전송→recovery 30초→늦은 제어
drain 15초의 구조다. 사전 bulk warmup은 없다. headline 완료시간은 첫 논리
payload의 앱 conn.send부터 마지막 payload의 앱 data emit까지이며 native
완료 경계는 회계 순서를 별도로 검증한다. recovery/drain은 별도다.

- 앱 지연은 같은 peer·type·direction·rate의 `conn.send→decoded data emit`으로
  비교한다. native 경계 ledger를 별도로 유지한다.
- `excess = max(0, raw − 해당 실행의 동일 rate/no-bulk median)`이다. baseline은
  6개 이상, paired p95는 전송 중 양쪽 표본이 각각 20개 이상일 때만 판정한다.
  부족한 표본은 N/A이며 0으로 바꾸지 않는다.
- 후보 raw 앱 제어 최대 ≤1000 ms, matched excess 최대 증가 ≤250 ms, 적격 excess
  p95 증가 ≤100 ms. H8은 두 workload·두 순서에서 완료시간 ≥20% 단축, 다른 조건은
  각 수신자 완료시간 악화 ≤10%를 요구한다.
- 파일 SHA/크기/순서/목표, 실제 nonce·native lane·협상, 실제 송신 직전 창·local64,
  최종 S=R=reported=A, ACK/READY, 전체 관측 누락·예외를 함께 확인한다.
- preload는 identity와 controlled 재생을 유지하고, 주입하지 않은 player mutation이
  없어야 한다. mutation 0만으로 정렬을 판정하지 않고 독립 시각 기반 residual도
  검토한다. 일반 전송에서 기존 YouTube 유지 판정은 N/A다.
- Qlease로 playback이 보호됐더라도 전송 지연 예산 실패를 상쇄하지 않는다.

independent observer는 제품 codec을 import하지 않고 envelope를 별도로 재구성한다.
첫 조각 직전 metadata가 admission, 마지막 조각 성공이 logical sent 완료 경계다.
native 메시지는 IP 패킷 수가 아니다. 후보에서는 관측기 자체도 양 끝에서
frame당 추가 재조립 copy를 하므로, 동일 observer 설치가 동일 비용을 뜻하지 않는다.
hook/reconstruction 비용·loop lag·long task·heap/CPU는 보조 근거로 남긴다.

## 완료된 정적·순수 검사

| 묶음 | 결과 | 범위 |
| --- | --- | --- |
| 후보 runtime/adapter/codec focused unit | 7파일 / 94 PASS / 0 FAIL / 0 SKIP | 실제 adapter·v1 fixture·재진입·late-ready·cap/shrink/debt·부분 실패·정리 |
| runtime·test TypeScript / focused lint·format | PASS | manifest의 checks exit 0; 기존 legacy fixture는 이전과 같이 focused lint 제외 |
| observer/fragment 순수 핀 | 25 PASS | 독립 envelope 재조립, 첫 metadata, 실제 lane/nonce, 부분 실패, 회계 |
| 공통 historical 분석 핀 | 10 PASS | FIFO 매칭, residual bracket·finite·identity, SHA·ACK·READY 경계 |
| credit/판정 순수 핀 | 14 PASS | local/credit admission, exact budget 경계, N/A, sparse p95 |
| 위 순수 분석 핀 합계 | **49 PASS** | 제품 94개와 구분하며 브라우저 조건 수로 세지 않음 |
| observer serialization | 별도 PASS | 실제 init script 직렬화 파싱 검사, 위 49개 합계에는 미포함 |
| stage4 validation-v2 분석기 핀 | 31 PASS | 기존 25개를 포함한 재실행; 작은 tail·16384/16385 경계·실제 nonce 순서. 앞 49개와 합산하지 않음 |

이 합계는 전체 unit suite·full E2E·exact-main CI 성공을 뜻하지 않는다. 제품
정적 가드 전체와 출시 빌드 검증은 제품 이식 이후의 별도 단계다. 실제 실험용
B128/AF19216 빌드는 executor가 만들었으며 아래 manifest로 식별한다.

## 첫 선별 결과 — H8 preload, B128→AF19216

한 실행씩의 비교다. 자체 pass는 파일/프로토콜·관측 재생 보존을, paired
`eligible`은 이 쌍의 성능 예산을 뜻한다. 전 후보·전 환경 통과와 구분한다.

| 지표 | B128 | AF19216 | 해석 |
| --- | ---: | ---: | --- |
| payload 완료 | 71.583초 | 48.450초 | 32.3163% 단축 |
| down sync-pong raw 최대 | 1126.7 ms | 858.5 ms | 후보 절대 1초 기준 충족; 기준군은 1초 초과 관측 |
| down sync-pong excess 최대 | 1014.1 ms | 743.1 ms | 후보−기준 −271.0 ms |
| down sync-pong excess p95 | 436.3 ms | 369.3 ms | −67.0 ms, n=71→48 |
| down youtube-sync raw 최대 | 848.0 ms | 399.9 ms | excess 최대 차분 −444.3 ms |
| down youtube-sync paired p95 | n=24 | n=16 | N/A: 후보가 20개 미만 |
| up sync-ping raw 최대 | 117.6 ms | 117.1 ms | excess 최대 차분 −3.1 ms |
| up sync-ping excess p95 차분 | — | −2.7 ms | n=71→48 |
| preload-end matched excess | N/A | N/A | 동일 무전송 baseline 없음; raw 값은 별도 보존 |
| payload 최종 S/R/reported/A | 각 23,040,044 B | 각 23,040,044 B | 각 352개 논리 청크, 동일 파일 해시 확인 |
| 관측 최대 payload debt | 128 KiB | 192 KiB | 후보 실제 확대 관측; 정적 설정만으로 추정하지 않음 |
| 추가 player mutation | 0 | 0 | 독립 residual과 함께 검토 |
| whole residual 범위 | +0.15…+2.10 ms | −0.55…+1.40 ms | 동일 PC 독립 시각·controlled player, 가청 오차 아님 |
| final residual | +1.35 ms | +0.05 ms | recovery 뒤 headline final; drain과 구분 |

관측 native bulk 메시지는 B128 352개, AF19216 1758개이며 논리 payload frame은
양쪽 352개다. 후보의 전체 logical native wire는 23,122,974 B이고 기준은
23,094,846 B다. 후보 fragment 재구성 관측 비용은 host 합계 12.8 ms / guest
29.1 ms, 최대 한 번 약 0.2 ms였다. 이는 **관측기 비용**이며 제품 fragment
CPU 비용이나 모든 기기의 성능을 직접 나타내지 않는다.

현재 `independent-af19216-audit.log/json`은 첫 쌍 `auditPassed: true`, 비교 위반
0, freeze 53개·source B128 2324개/AF19216 2331개·각 build 856개 hash 불일치 0을
기록한다. 이 문서는 그 독립 감사와 각 단계의 원시 기록·요약을 근거로 하며,
첫 단계 결과를 후속 단계의 검증 대신 사용하지 않는다.

이 결과는 F16와 적응형 192가 함께 들어간 후보의 결과다. 두 요소의 개별 기여율이나
SCTP 내부 원인을 한 쌍으로 분리해 확정하지 않는다. p95는 서로 다른 전송 기간의
전체 표본으로 계산했으며, 기간 단축에 따른 n·순위 차이를 유지한다. 신뢰구간이나
통계적 유의성을 주장하지 않는다.

## 두 번째 선별 결과 — H8 일반 전송, AF19216→B128

executor의 `stage-2-decision.json`과 독립 `independent-af19216-stage2-audit.*`는
모두 통과이며 감사 문제·비교 위반 0건이다. 53개 동결 입력과 소스/빌드 해시도
일치했다. 각 352개 청크, 실제 현재 파일 READY/identity 및 최종 S=R=reported=A를
확인했으며 일반 전송을 preload 최종 ACK 계약으로 바꾸어 해석하지 않았다.

| 지표 | B128 | AF19216 | 비교 |
| --- | ---: | ---: | --- |
| payload 완료 | 64.217초 | 36.760초 | 42.7566% 단축 |
| down sync-pong raw 최대 | 682.0 ms | 482.5 ms | 후보 절대 1초 기준 충족 |
| down sync-pong excess 최대 | 579.4 ms | 369.5 ms | −209.9 ms |
| down sync-pong excess p95 | 139.2 ms | 57.3 ms | −81.9 ms, n=65→37 |
| up sync-ping excess 최대 | 14.1 ms | 1.1 ms | −13.0 ms |
| up sync-ping excess p95 | 7.9 ms | 0 ms | −7.9 ms, n=64→36 |
| file-end / preload-ack matched excess | N/A | N/A | 동일 무전송 baseline 부족, raw는 보존 |
| 기존 YouTube 유지 판정 | N/A | N/A | 일반 파일 전송이며 preload 재생 보존과 혼합하지 않음 |

실제 WAV 길이는 240초이며 전체 관측은 B148.179/AF120.813초였다. 양쪽 모두
전환 pause 이후 PLAY 명령이 없었고 READY/current identity를 유지했다. 자연 EOF가
완료 비교를 오염시키지 않았다는 근거이며, 연속 파일 재생·가청 품질 검증은 아니다.

프리로드와 일반 전송의 최초 실행 순서는 서로 반대다. 이것을 각 workload의
역순 반복이 끝났다고 세지는 않는다. 별도 4회의 반대 순서 확인은 여전히 필요하다.

## 세 번째 선별 — slow2 preload, B128→AF19216

`stage-3-decision.json`과 독립 감사 모두 통과, 위반·회계·해시·관측 누락 0건이다.
후보는 전 구간 fixed128을 유지하고 192 probe를 하지 않았다.

| 지표 | B128 | AF19216 | 비교 |
| --- | ---: | ---: | --- |
| payload 완료 | 101.610초 | 101.614초 | +0.00394%, 10% 회귀 예산 충족 |
| down sync-pong raw 최대 | 1110.0 ms | 714.6 ms | excess 최대 −394.5 / p95 −39.0 ms, n101/101 |
| down youtube-sync raw 최대 | 970.6 ms | 466.4 ms | excess 최대 −504.6 / p95 −65.6 ms, n34/34 |
| up sync-ping raw 최대 | 118.0 ms | 118.7 ms | excess 최대 +0.6 / p95 약0 ms, n101/101 |
| 추가 player mutation·비재생·invalid 표본 | 각0 | 각0 | 독립 미디어 투영과 함께 검토 |

preload-end는 무전송 기준선이 없어 상대 비교 N/A이며 raw321.4/346.2 ms를 보존한다.
후보 최종 residual +13.75 ms는 전송 중 누적 오차로 해석하지 않는다. 전송 전
median부터 +13.50 ms였고 전 구간 범위 +12.65…+14.60 ms, 기준선 median 대비
최대 변화 1.10 ms였다. B 최종은 +0.20 ms다. 기존 차이를 0으로 재정의하거나
그 시작 원인을 확정하지 않는다. 원시 ping/pong 후보는 혼잡 중 큰 offset 편향을
보였으나 이 하네스에는 실제 선택 시계 register/recorder가 없어, 그것을 앱이
선택한 값이라고 주장하지 않는다. 가청 출력 증거도 아니다.

## 네 번째 선별 — 동적망 완료, paired 성능 실패

AF19216의 실제 동적망 실행은 46,080,044 B / 704개 논리 청크를 122.697초에
완료했고 파일 SHA·누적 S/R/receipt 및 추가 player mutation0이 관측됐다. 원래
scorer는 마지막 청크의 encoded8392 B(payload8236+header156)가 분할되지 않았다는
이유로 FAIL을 기록하여 B 실행 전에 중단했다. 제품은 encoded≤16384 B frame을
정상적으로 한 메시지로 보내므로 분석기의 오탐이었다.

원래 FAIL raw/summary는 보존했다. `validation-v2`만 별도로 만들고, 큰 frame의
분할 조건과 모든 확대 송신 앞 실제 네 개 nonce 협상 메시지 순서를 함께 검사했다.
31핀 통과 및 별도 읽기 검토 후 같은 원시 입력의 **파생 분석**은 통과했다.
제품·관측기·제어/속도 예산 변경, 빌드 또는 후보 물리 실행 재시도는 없었다.
이는 새 native 관측이나 동적망 paired 통과가 아니다. 이어 승인된 남은 B 실행은
149.978초에 완료했고, 같은 조건으로 비교한 `validation-v2/stage-4-decision-v2.json`은
`eligible:false`, 아래 상대 지연 위반5건을 기록했다. 이 paired 실패는 오탐 수정으로
제거되지 않는다. `independent-af19216-stage4-audit-v2.json/log`도 무결성 문제0,
같은 paired 성능 위반5건을 확인했다. 이는 전체/단계별 기준이 겹쳐 집계한
5개 판정 항목이며 서로 독립적인 사건5개가 아니다. 그 파일의 `auditPassed:true`는 독립 회계와
자료 검증 성공이며, `comparison.eligible:false`인 제품 자격 실패와 구분한다.

| 지표 / 구간 | B128 | AF19216 | 판정 |
| --- | ---: | ---: | --- |
| payload 완료 | 149.978초 | 122.697초 | 18.19% 단축, 동적망 완료시간 회귀 없음 |
| whole down sync-pong raw 최대 | 440.7 ms | 927.7 ms | 절대1초는 충족 |
| whole down sync-pong excess 최대 | 327.8 ms | 813.0 ms | +485.2 ms, +250 ms 예산 실패 |
| whole down youtube-sync excess 최대 | 321.2 ms | 660.2 ms | +339.0 ms, +250 ms 예산 실패 |
| initial down sync-pong excess 최대 차분 | — | +534.8 ms | +250 ms 예산 실패 |
| initial down sync-pong excess p95 차분 | n30 | n30 / +233.8 ms | +100 ms 예산 실패 |
| initial down youtube-sync excess 최대 차분 | n10 | n10 / +440.5 ms | 최대 예산 실패; p95는 N/A |
| 추가 player mutation / final residual | 0 / −0.30 ms | 0 / +2.90 ms | 지연 예산 실패를 상쇄하지 않음 |

slow2와 회복 구간의 상대 지연은 개선됐지만 초기/전체 실패를 평균으로 감추지
않는다. whole pong의 p95는 −2.8 ms였어도 적격 initial p95 실패는 그대로다.
독립 감사의 전체 residual은 B−0.95…+1.10 ms, AF+1.70…+3.65 ms이며 기준선
median은 각각 +0.15/+2.70 ms였다. 추가 mutation·비재생·invalid 표본은 모두0이다.

결정적인 AF pong 최대927.7 ms는 bulk+0.722초에 보낸 메시지, p95 선택값516.9 ms는
+2.716초, YouTube 최대773.9 ms는 +0.877초 메시지였다. 제어 송신 전후의 실제
bulk/sample 진단이 모두128/baseline/epoch1이며 첫192 probe 관측은 +16.723초,
accepted는 +18.795초였다. 제어 프레임 자체에 창 snapshot이 있는 것은 아니다. 따라서 **이번
실패를192 확대가 이 초기 outlier를 만들었다는 증거로 사용하지 않는다.**
최대 pong은 app→native0.1 / native 전달927.6 / native→app0 ms로 나뉜다.
첫 논리 frame 전달도 B791.6/AF1885.9 ms로 달랐고 AF의 다섯 조각은 약
767.5/1211.0/1649.5/1885.7/1885.9 ms에 도착했다. 관측 병목은 native 전달
경계이며, SCTP·운영체제·shaper 내부의 구체 원인은 미확정이다. 작은 메시지
분할이 이 모든 초기 지연을 없앤다는 주장 역시 이 결과로 지지되지 않는다.

18.19% 단축은 조건당 한 실행의 관측이며 인과 기여율·통계적 유의성·모든 망의
안정성을 뜻하지 않는다. 이 결과를 맞추기 위한 창·타이머·예산 재조정이나
선별 반복을 하지 않고, 기존 실패 및 다음 미실행 범위를 보존한다.

## 단계 현황과 아직 실행하지 않은 범위

아래는 **최초8실행과 독립 감사 완료·동적망 paired 실패 시점**의 상태다.
최종 기록을 보강하되 기존 행·원본을 덮어쓰거나 후속 선별을 재개하지 않는다.

| 단계 | 사전 순서 / 데이터 | 실행 상태 | 후속 조건 |
| --- | --- | --- | --- |
| H8 preload 선별 | B128→AF19216 / 23,040,044 B | 2실행 완료, paired eligible true·독립 감사 완료 | 개별 통과 근거 보존; 종합 자격은 실패 |
| H8 일반 전송 | AF19216→B128 / 23,040,044 B·240초/24kHz WAV | 2실행 완료, paired eligible true·독립 감사 완료 | 개별 통과 근거 보존; 종합 자격은 실패 |
| slow2 preload | B128→AF19216 / 23,040,044 B | 2실행 완료, paired eligible true·독립 감사 완료 | 개별 통과 근거 보존; 종합 자격은 실패 |
| dynamic preload | AF19216→B128 / 46,080,044 B | 2실행 완료·v2 기능 판독 통과·paired 성능 FAIL | 독립 전체 감사 동일 결론; 후속 중단 |
| H8 역순 확인 | 두 workload 각 반대 순서, 총4실행 | 미실행 | 최초8실행 자격 실패로 중단 |
| 여러 수신자 일반/preload | host+6 unlimited+H8+slow2, 두 쌍 총4회 | 준비만 완료·미실행·미동결 | 자격 실패로 실행하지 않음 |
| 취소→재추가 / preload→active 승격 | host+2 unlimited+H8, candidate 각1회 | 준비만 완료·미실행·미동결 | 자격 실패로 실행하지 않음 |
| 최종 제품 정리·전체 정적/빌드/CI | 별도 제품 변경 | 미실행 | 현재 후보 채택하지 않음 |
| 배포 | 해당 없음 | 미실행 | 기존 운영 유지 |

dynamic은 고정 drop 직전 accepted192 및 payload debt>128 KiB를 실제로 관측하고,
snapshot과 적용 사이 경계를 확인해야 한다. 그렇지 않으면 unexercised이며 통과로
세지 않는다. 실패하면 이후 조건을 진행하지 않고 실패/미실행 이유를 기록한다.
이번 후보는 전환 전후 native sequence4088이 같고 S10,747,904−A10,551,296=
196,608 B, accepted192여서 해당 노출을 충족했다. 첫128 축소 관측은 적용 후
706 ms였고 부채는 보존됐다. Node/browser 표식에는 수 ms 차이가 있었지만
전체 표식 범위와 전환/첫8초 경계의 ±10 ms 안에 제어 송신 표본이 없었다.
이는 경계 민감도 확인이며 표본을 삭제하거나 새로운 판정 여유를 준 것이 아니다.

추가 multi/lifecycle 6회는 결과 후 임의 조정하는 그리드가 아니다. 측정·동결 전에
2026-10-18 준비 범위를 여섯 빠른 수신자+고RTT 수신자+느린 수신자로 정했고,
각 peer/profile/type/direction 자체 baseline, 빠른 peer의 own-bulk/room-wide
지연을 분리한다. 기존 각 수신자 완료 ≤10% 회귀와 raw1초/excess최대250/p95100 ms
기준을 그대로 사용한다. 상세 준비 및 미실행 핀은 `multi-lifecycle/README.md`에 있다.

## 식별자·근거

아래 파일은 저장소의 `scratch/adaptive-credit-192-fragment16-experiment-2026-10-18/`
기준이며 로컬 원본 자료다. 저장소에 전체 raw를 커밋하거나 원격 CI 결과로 대체하지 않았다.
기존 A192/AF16 artifact는
각 원래 디렉터리에 보존한다. 아래 hash는 각 단계의 개별 출력 값이다. 감사가
확장되면 기존 출력도 별도 보존하고 새 식별자를 추가한다.

| 파일 / 소스 | SHA-256 또는 commit |
| --- | --- |
| 기준 main | `49a877c12d5e1efc695693797f9823d957e7d992` |
| `root-acceptance.md` | `44af0bb9f17ce5b506cc8b265f0a29befd23bdd85caf5198c1562b3ee7e19635` |
| `execution-freeze.json` / 입력53개 | `db62a48624200c1613b1230d24a40ef4ee01b30df8f998a74acf8f6a605234b4` |
| `af19216-implementation-manifest.json` | `7f5d223d1d5bc1c5116b9064f0acc774048d8f962e5d83cf04ade4f60a301d06` |
| controller | `2b73b963ea3f393b4b58e86a3d51c1407810d9e5bee78930795ebbb89b7cf637` |
| adapter | `0b1e1211d8d3bf7e1dfb2885cf6240a9e16176f9f64c6d7e76bad1139e5b8746` |
| fragment codec | `d2f1ecf6831d494fbb7a402160490698805ba84bd823713ba9332fecef82affe` |
| `af19216-runtime.patch` | `48d2086bcd2ccdf647dcdd302654e681bac1c526a2163f1b894ae6247af6d335` |
| `build-B128-manifest.json` | `98a9829b1d71001150b796b99b19d072633a586a79e59e987f5cadb4e2f7315a` |
| `build-AF19216-manifest.json` | `cefc236f58ccf1a3192ec21d49e9467192b429bee5dc0ef7e6dff0f8344879ec` |
| `screen-highrtt8-preload-B128.json` | `a647e525db8e7b2dc04f55a389b9e9d6148b67a3cebe60c223eccbcad071c323` |
| `screen-highrtt8-preload-AF19216.json` | `fe4a87de8516846c1922059f4144a5c76065db4d41c24f7262783b8c533e1e44` |
| `screen-highrtt8-active-B128.json` | `deb5f5749688e7cbbf1ad54669400fce7e7913d8bc778ab305885471e6e8d10e` |
| `screen-highrtt8-active-AF19216.json` | `acd4bff0988d2d0b51832b41bdc9282fc11813eba77a49fcc5e73db93bc961d5` |
| `stage-1-decision.json` | `6ff547cc60e06f130309160e37c8be6a41e282547b601c6d601b8a03d7434709` |
| `independent-af19216-audit.json` | `04e6ee8fdd1ce2f13cf0b1a9590f8ab04afdd7159c8bec4a997cae9bd3a8b2f1` |
| `independent-af19216-stage2-audit.json` | `95d2ba7f904d7670f212f5914a2d65d20e118cf09b086df8964cb6ea946807eb` |
| `independent-af19216-stage3-audit.json` | `4b500165101bb9ed000e8bc1e439bb71dc25967e832b4e72e69293c85d3eaa9b` |
| `stage-3-decision.json` | `0053670469fb114c53a6bb4f34e1ee7bea4ade71ecd1062864d23fcc6ba306c8` |
| `screen-dynamic-preload-AF19216.json` / 원래 FAIL 보존 | `6a00c3342a7e0428c177b28b7abd2c5a02e4133be0df8bbd00eb47d38461a0ea` |
| `validation-v2/candidate-reanalysis-final.json` / 같은 raw의 파생 분석 | `5363603eeb7a1eb173038e13270f090b3a3885d886b4d85ad95aad5a9f326d4d` |
| `validation-v2/execution-freeze-v2.json` | `84f8c46f59aa35757163a93dcf8282227340cdce94fc19c3c115e87ee92aabb3` |
| `independent-stage4-validation-final.json` | `46ea5493e4bc5bae499c846f73e038bbb59c82be7d21d7b46e3ce8298bfac8a0` |
| `validation-v2/screen-dynamic-preload-B128-v2.json` | `7ba4510d58322728fabaa95b74e809bbb6b753ac8059a79c89b0a47e101f6ab3` |
| `validation-v2/stage-4-decision-v2.json` / 실제 paired FAIL | `0495e8fb77637ef93325a71171eedffd86443a4f909e6339425f4335811d4f46` |
| `independent-af19216-stage4-audit-v2.json` | `64cc49ab714d73cd5fb18bbabcd18eb2aae14fd02b6454df90a31f0dc9d207d9` |
| `independent-stage4-startup-detail-r2.json` | `ecc8423e50628ef3e260ad293a66dfab2aff56f4e45d141cec711530afff4c11` |

추가 근거: `composition-invariants.json`, `source-base-checks.json`,
`af19216-focused-tests.json/log`, `af19216-checks.json`,
`fragment-analysis-tests.json`, `historical-analysis-tests.json`,
`harness-pins-final.log`, `observer-serialization-result.json`, 각 실행의
`*-summary.json`, `harness-contract.md`, `infrastructure-freeze.json`, stage2 EOF
및 stage3 clock/media detail, `validation-v2/repair-note.md`.
stage4 첫 세부 출력 formatter는 control row에 없는 `flowBefore`를 참조하여
JSON 작성 뒤 TypeError를 냈다. 원래 출력은 보존하고 별도 r2에서 관측 bracket
표현을 바로잡았다. 원시 실행·성능값·감사 본체 결과를 다시 실행하거나 바꾸지 않았다.

독립 감사 후 이 실험의 소유 서버만 PID·명령·생성시각을 확인해 종료했다.
해당 프로세스12개와 listener4450/4451/8850/9350의 잔여는0이며 다른 작업은
종료하지 않았다. 소스·빌드·원시 자료는 삭제하지 않았다.
`owned-server-cleanup.json` SHA256:
`a21d20596796d4bf4df04d8058e4605ae10aa773dfb081c1fd07546379af0864`.

## 유지할 한계

- 처음 통과한 세 쌍도 조건당 한 번의 선별이지 보편적 최적값이나 안정성 증명이 아니다.
- 순간 대역폭 급락 시 이미 보낸 192 KiB 부채가 남는다. 작은 native 메시지가
  이 부채나 공통 물리 링크 병목을 없애지는 않는다.
- PRO·R2·TURN·실제 모바일/무선망·백그라운드·가청 출력·live YouTube는 범위 밖이다.
- 진단 getter 유지 권고는 자격 통과를 전제로 검토했던 조건부 이식 방안이다.
  이번 실패 뒤에는 그 정리나 제품 이식도 실행하지 않는다.
- 현재는 성능 자격 실패로 제품 이식·배포하지 않으며, 정적/논리 안전성
  통과나 빠른 다운로드만으로 이 결론을 대체하지 않는다.
