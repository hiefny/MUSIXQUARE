# 수신확인 창 A192 격리 실험 — 2026-10-18

## 결과와 범위

고RTT 파일 프리로드를 빠르게 하되 제어 지연을 늘리지 않으려는 후속 실험이다.
후보의 파일 완료시간은 **71.791 → 49.516초, 31.03% 단축**됐다.
파일·프로토콜·관측 재생은 통과했으나 사전 제어 지연 예산 두 항목에 실패했다.
후보는 채택하지 않았고, 남은 여섯 screening 조건은 실행하지 않았다.
제품 main 런타임 수정·배포는 없으며 운영 64/64/128 설정을 유지한다.

최대 지연과 p95를 결정한 표본은 **확대 전 128KiB 시작 구간**에 있었다.
따라서 선정 실패와 “192KiB가 해당 spike의 원인”이라는 주장은 구분한다.
전체 전송 기준의 실패는 보존하며, 사후 시간 분해로 합격시키지 않는다.

## 코드·환경·변경

- 양쪽 기준: main `49a877c12d5e1efc695693797f9823d957e7d992`.
  이 main에는 미배포 자동보정 보호/Qlease가 포함되며 양쪽에 동일 적용했다.
- 실제 운영은 `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`, App8.11.20/v723이다.
  이번 격리 파일은 커밋된 새 runtime이나 exact-main 배포 후보가 아니다.
- B128은 기존 fixed128. A192는 이전 A2 소스에서 `ADAPTIVE_MAX_BYTES`
  256→192KiB 한 곳만 변경했다. 독립 바이트 비교로 이를 확인했다.
- 논리 청크64KiB / local64KiB / receipt64KiB와 partial flush20ms,
  v1 wire, 연결 수명 S/A, rate·gain·age·cooldown·watchdog 기준은 유지했다.
- 두 번의 적격 관측 후 192를 시험하고, 이득·지연 기준을 잃으면128로 돌아간다.
  축소는 이미 보낸 debt를 지우지 않는다. no-protocol legacy는 기존 fallback이다.
- 새 dependency·schema·binding·secret·Worker·PRO/R2 변경은 없다.
- Windows, 로컬 Node24.13.1 / Chromium153.0.8010.12.
  저장소의 Node24.20.0과 다르므로 정식 CI 환경 통과를 대신하지 않는다.

원본/격리 소스·실행 자료는 `scratch/adaptive-credit-192-experiment-2026-10-18/`에 있다.
고정 사전계약은 `root-acceptance.md`; 이전 결과를 바꾸지 않은 별도 실험이다.

## 사전 계약과 실행

한 host+한 guest, desktop UA, manual/output offset0, 같은 PC의 실제 RTC·storage,
로컬 signaling/ICE[], 제어된 600초 YouTube 플레이어를 사용했다.
8Mbps·각 방향100ms 지연, loss0, HTTP/WS 제외 조건이다.
파일은 23,040,044 B의 원래 120초 WAV이며 새 drift를 주입하지 않았다.
10초 warmup, 2초 settle, 24초 무전송 baseline, 전송 후30초 회복과15초 drain을 뒀다.
첫 순서는 B128→A192. 원래 사전 계획은 8조건과 통과 후 역순 확인이었다.

판정은 같은 peer/type/direction/rate의 app send→decoded data 지연을 비교한다.
excess=`max(0, raw−해당 실행의 무전송 중앙값)`이며 baseline6개 이상이 필요하다.
최대 raw≤1000ms, excess max 증가≤250ms, 양쪽20표본 이상인 p95 증가≤100ms다.
고RTT 완료시간20% 이상 개선, 다른 조건10% 이내 회귀 기준도 그대로 유지했다.
한 수신자라 own/room 전송 구간은 같고 표본을 중복 집계하지 않았다.
전송 중 보냈지만 뒤늦게 도착한 제어도 포함했다. 없는 비교군은 N/A다.

새 B128의71.791초는 역사 비교의71.817초와 비슷한 비용을 재관측한 것이다.
역사 숫자는 새 비교의 분모로 사용하지 않았고, 두 실험을 같은 반복 표본으로 합치지 않았다.

## 검증과 무결성

| 검사 | 결과 | 한계 |
| --- | --- | --- |
| Controller/base/실제 adapter 집중 검사 | 3파일46 pass, fail/skip0 | 격리 단위 검사 |
| Harness ledger/decision 핀 | 14 pass | synthetic 분석 입력 |
| 공통 분석/active READY 핀 | 10 pass | 이전 분석 계약 포함 |
| 격리 runtime 타입·대상 lint·format | pass | 로컬 Node24.13.1 |
| Native 파일·프로토콜·재생 관측 | 2조건2파일 pass | 한 수신자·제어된 provider |
| Native 비교 성능 선정 | fail2 | 아래 raw/p95 예산 |
| 후속6조건·역순·다중 수신자·취소/승격 | 미실행 | 첫 pair 탈락 후 중단 |
| 새 전체 제품 unit/E2E·원격 CI·실기·음향 | 미실행 | 이 실험으로 통과 주장 안 함 |

독립 감사는 실행 freeze46파일, B128 소스2324개/A1922325개,
양쪽 각각 build856자산을 다시 해시해 불일치0을 확인했다.
두 파일 모두352청크의 순서·정확한 크기·queue/session·원래 마지막 END/ACK를 통과했다.
각 최종 S=R=reported=A=23,040,044 B, nonce·lane·단일 연결 조건도 일치했다.
최대 미확인 payload는 B131,072/A196,608 B; 실제 송신 직전 cap을 넘지 않았다.
전체 native 파일 송신의 bufferedBefore는0이었다. local64 조건을 통과했다.
source fixture와 브라우저 resident Blob의 저장된 SHA 영수증이 일치했다.
관측 drop/예외·연결 교체·미매칭 measured control은0이었다.

## 제어 지연 결과

| 그룹 | loaded n B/A | raw max B/A (ms) | excess max Δ | excess p95 Δ |
| --- | ---: | ---: | ---: | ---: |
| down sync-pong | 71/49 | 1058.500/1063.800 | +4.900 | **+200.000** |
| down youtube-sync | 24/16 | 918.700/833.100 | −85.900 | N/A |
| up sync-ping | 72/49 | 116.900/117.100 | +1.500 | +1.200 |

후보 raw1063.8>1000과 excess p95 증가200.0002>100이 탈락 사유다.
YouTube p95는 후보16표본이라 판정하지 않았다. preload-end는 baseline이 없어 N/A다.
sync-pong baseline은 각각24개, 중앙값113.69995/114.09985ms다.
raw p95는584.59985/785.0, excess p95는470.89990/670.90015ms다.

후보 max 표본은 bulk+0.797초, p95 결정 표본은+2.791초에 송신됐다.
둘 다 앞뒤 관측에서128/baseline이다. 첫192 probe 관측은+15.562초,
accepted192는+18.511초이며 마지막 partial tail로+49.516초128로 축소됐다.
기준도+0.840초에1058.5ms를 기록했다. 1초 상한 실패가 후보에만 있는 것은 아니다.
71표본의 p95는 네 번째 큰 값,49표본에서는 세 번째 큰 값이다.
따라서 whole p95 차이를 정상 상태 패킷마다200ms 악화한 결과로 읽으면 안 된다.

사후 동일 첫49.516초에는 각각49개이며 raw p95766.8/785.0ms였다.
공통19~49초의 각30개는 raw p95244.3/187.0, max267.7/201.5ms였다.
이 보조 분해는 표본 수·시점의 영향을 설명할 뿐 사전 판정을 대체하지 않는다.

## 첫 청크·첫 pong의 native 근거

첫 논리64KiB의 실제 native 메시지는 header 포함65,690 B였다.
첫 메시지 send→native receive는 B1895.800/A1860.300ms였다.
첫 pong의 app→native는 B0.100/A0ms, native→app은 양쪽0ms로 관측됐다.
pong native 수신은 첫 완성 파일 메시지 수신보다 B3.100/A1.100ms 뒤였다.
따라서 그 표본은 app 처리보다 native 전달 경로의 대기를 의심할 근거다.
다른 채널이라도 동일 SCTP/망을 쓰지만, 이 기록만으로 내부 interleaving이나
혼잡 제어의 정확한 원인을 증명하지는 않는다.
독립 세부 수치는 `independent-a192-startup-native-detail.json`에 보존했다.

## 재생과 관측 부담

baseline 시작부터30초 회복 끝까지 signed 미디어 잔차는
B +7.600~+9.500ms(510표본), A +1.050~+3.100ms(423표본)였다.
baseline 대비 bulk 변화 최대는0.950/1.000ms, 마지막 잔차는+8.800/+2.150ms였다.
양쪽 uncommanded mutation·비재생·무효/다른 identity 표본은0이었다.
선택된 시계가 아닌 같은 PC의 host/guest 실제 미디어 위치와 단조시각을 투영했다.
가청·실제 YouTube buffering·모바일 결과가 아니며0calls만으로 정렬을 판정하지 않았다.
hook 누적 비용 B host/guest51.6/50.5ms, A50.6/49.4ms; 한 번 최대약0.4ms였다.
전체 브라우저/하네스 부담을 모두 계측한 값은 아니므로 관측 비용0을 주장하지 않는다.

## 보존 자료와 후속 경계

독립 `independent-a192-audit.{py,json,md,log}`는 원시를 다시 계산했고 이상0이었다.
freeze SHA: `cef22bf828eeba5f290b0bbabce9a118795a2a6ba16b8b83a64923bda538fc4c`.
독립 JSON SHA: `19e1f5efc561f011b21b58b3eea3049c86cdfe5e3d181055d47d892a9f752900`.
최초 감사 출력문의 괄호 오류는 별도 스크립트로 보존했다. 제품 실패 재시험은 아니다.
파일·단위 검사 통과로 성능 실패를 숨기지 않았고 main/운영에는 적용하지 않는다.
별도 AF19216 후속 실험은192 상한에 negotiated 동기 native16KiB 분할을 결합했다.
partial credit/async pump 없이 같은 예산을 적용하고 별도 원본·새 B128과 비교했다.
그8실행과 독립 감사 결과는 [별도 보고서](adaptive-credit-fragment16-screen-2026-10-18.md)에
기록한다. 후속 후보 역시 동적망의 상대 제어 지연 기준에 실패했으며, 이 A192의
원래 실패를 변경하거나 운영에 적용하지 않는다.
