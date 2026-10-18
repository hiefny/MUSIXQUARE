# 전송·시계 후보 합동 검토와 격리 실험

- Date: 2026-10-18 KST.
- Status: 격리 구현·선별 완료. 전송 후보의 종합 통과안 없음. 운영64/128 유지,
  제품 채택·배포 없음.
- Source: `1428b6d0dd83b54af2a48453fdad30287573ac47`, runtime은 배포
  `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3` / App 8.11.20 / cache v723과 같다.
- Owner request: 여러 에이전트가 후보를 논의하고, 유망한 안을 실제 코드로
  구현·시험하여 전송시간·제어 지연·재생 안정성을 함께 개선할 수 있는지 판단한다.
- Isolation: 주 checkout의 제품 소스는 바꾸지 않는다. 아래 후보는 ignored
  `scratch/transport-candidate-roundtable-2026-10-18/`의 별도 소스 사본에만 있다.
  이 보고서 게시만으로 Production Release를 실행하지 않는다.
- Runtime scope: 일반방 직접 RTC 파일 전송·프리로드와 일반방 YouTube 자동
  재정렬이다. PRO/R2 전송을 수정하거나 시험한 것이 아니다.
- Related: [로컬·credit 교차 48회](receiver-credit-cross-matrix-2026-10-18.md),
  [첫 적응형 및 시계 품질 후보](receiver-credit-adaptive-design-2026-10-18.md),
  [현재 운영 상태](../release-record.md).

## 판정

전송·시계·독립 감사 담당3명과 루트가 검토하고 네 후보를 격리 구현했다.
이번 묶음의 실제 native RTC12회·수신 파일36개는 기능·순서·SHA·수신확인
검사를 통과했다. 그러나 속도와 제어 지연 기준을 모두 통과한 전송 후보는 없다.

| 후보 | 얻은 것 | 남은 문제 / 판정 |
| --- | --- | --- |
| A2 보수적 적응형 창 | 고정 고RTT 일반 전송64.626→31.028초 | 갑자기 느려진 망에서 동일 sync-pong excess max +348ms. 안전성 선별 탈락 |
| F16 작은 native 메시지 | 고정 느린 망에서 제어 지연 예산 통과 | 고RTT64.536→57.776초, 이득10.47%로 사전20% 기준 미달. 단독 속도 개선안으로 탈락 |
| AF16 조합 | 변화하는 망에서149.660→102.689초, 재생 유지 | 같은 느린 구간 sync-pong excess max +391ms. 안전성 선별 탈락 |
| Qlease 시계 품질·작업 고정 | 결정적648개 통과, 작업 중 시계 교체의 잘못된 동작 방지 | 혼잡한 망의 실제 오차를 고치는 능력·실기/가청 정확도는 미완료. 별도 후속 후보 |

위 전송시간은 조건별 비교다. 고정 고RTT는23MB, 동적 trace는46MB여서 서로
절대 시간을 직접 비교하지 않는다. 큰 debt가 남은 순간 망이 느려지면 분할을
추가해도 이미 보낸 byte를 회수할 수 없었다. 한 번의 선별은 보편적 불가능을
증명하지 않지만, 실패한 후보를 배포할 근거도 아니다. 현재 운영의 청크64 KiB /
로컬64 KiB / 수신확인 창128 KiB를 유지한다.

다음 구현 후보는 전송량 확대와 분리한 시계·자동 보정 보호다. Qlease도 아직
제품 수정으로 반영하지 않았고 전체 회귀·실기 검증이 필요하다. quiet-clock
repair나 별도 연결·전역 송신 스케줄러까지 이번에 구현·검증한 것으로 보지 않는다.

## 합동 검토와 후보 선정

전송 담당, 시계·재생 담당, 독립 검증 담당이 먼저 읽기 전용으로 검토한 뒤
서로의 반론을 전달했다. 전송 담당은 작은 변경인 A2를 우선했고, 독립 검증
담당은 A2의 rate가 회선 용량이 아니라 창에 제한된 처리량일 수 있다며 F16을
우선했다. 루트는 두 전송 후보를 각각 구현하고, Qlease를 독립적인 재생 제어 안전성
후보로 검증하도록 결정했다. 의견 일치나 단위검사만으로 최적안을 선언하지 않는다.

| 후보 | 변경하는 것 | 유지하는 것 | 주요 반론 |
| --- | --- | --- | --- |
| A2 | 충분한 delivery 증거가 있을 때만 credit128→192→256 KiB 확대 | 논리 청크64, 로컬64, receipt64, wire 계약 | ACK 압축·갑작스러운 망 변화에 안전을 보장할 수 없고, 보수적이면 속도 이득도 없어짐 |
| F16 | 인코딩된 bulk 한 건을 최대16 KiB native 메시지로 분할·재조립 | 논리 청크64, 로컬64, credit128, 완성 청크 단위 receipt | 메시지 수·복사 비용 증가. 총 대기량과 수신확인 왕복 자체는 그대로 |
| Qlease | 자동 재정렬 한 작업의 시각을 고정하고 단조시각으로 실행 | 명시적 사용자 조작과 전송 경로 | 더 좋은 시계를 만드는 것이 아니며 혼잡 중 실제 중간 크기 오차를 식별하지 못할 수 있음 |
| AF16 (후속) | 분할 협상된 연결에서만 A2+F16 결합 | v1 연결 fixed128·동일 A2 기준 | 기존 debt 회수 불가, ACK 패턴 변화로 단독 결과를 합산할 수 없음 |

별도 PeerConnection은 SCTP association 내부 간섭을 줄일 수 있지만, 공유
무선망·업링크 대기열과 연결 수 증가가 남으므로 이번 새 구현에서 제외했다.
bulk를 잠깐 쉬고 **그 뒤 새 ping**을 보내는 quiet-clock repair는 후속 설계다.
유효한 nonce·준비 확인·host 소유권·전체 방의 시간/횟수 제한이 필요하며,
과거 ping을 붙잡았다 나중에 보내는 방식은 새 시계 표본을 만들지 못한다.

## 사전 검증 기준

측정 전 `root-acceptance.md`와 `a2-spec-v1.md`를 작성했다. 기존 비교 예산을
유지하고, 속도 이득을 본 뒤 기준을 완화하지 않는다. 파일 순서·SHA·누적
S/R/A·nonce·최종 ACK/READY·관측 완전성이 우선이다. 프리로드는 재생 중인
영상과 불필요한 pause/seek/play 0개를 검사한다. 일반 전송은 파일 모드로
전환하므로 기존 YouTube 유지 조건은 해당하지 않는다.

같은 peer/type/direction의 무전송 median을 뺀 excess를 비교한다. own/room
두 구간 모두 최대 증가250ms 이하, 충분한 표본의 p95 증가100ms 이하,
raw application-control 최대1000ms 이하를 요구한다. 무전송 n≥6,
p95는 양쪽 loaded n≥20이 필요하며 부족한 값은 unavailable이다. 다른 조건의
전송시간이10% 넘게 나빠지면 평균 속도 이득으로 덮지 않는다. 고RTT 두 전송
종류·두 순서 모두20% 이상 단축해야 큰 이득으로 분류한다. 이는 실험의
선택 기준이며 제품의 보장된 SLO가 아니다.

먼저 결정적 검사, 다음 후보마다 고RTT 일반 전송·긴 느린 망 프리로드의
기준/후보4회로 걸러낸다. 통과 후보만 일반/프리로드 × 무제한8수신자/
느린 망/고RTT에 기준/후보·정역순24회와 실제 취소·승격 검사로 확대한다.
실패 시 후속 생략을 성공으로 세지 않는다.

## 구현·검증 결과

### 결정적 검사

| 후보 | 최종 focused 검사 | 추가 확인 | 의미·한계 |
| --- | --- | --- | --- |
| A2 | 3파일41 pass / 0 fail / 0 skip | 앱 타입·focused lint | slow2 확대 거절, 두 단계 전체 예산, 압축·긴 ACK 간격, 급락·cooldown·debt 보존. native 이득 증거는 별도 |
| F16 | 4파일57 pass / 0 fail / 0 skip | 앱/테스트 타입·focused lint·format | 원본 credit22 + 신규35. 실제 adapter/controller와 가짜 채널. 전체 구/신 앱 입장과 브라우저 호환 검사를 대신하지 않음 |
| Qlease | 11파일648 pass / 0 fail / 0 skip | 앱/테스트 타입·focused lint·format | 새 handler29 포함. 아래 Q-only 대조와 구분 |
| AF16 | 7파일89 pass / 0 fail / 0 skip | 앱/테스트 타입·focused lint·format | A2/F16 회귀와 실제 adapter 결합·동기 재진입 핀. native 성능 판정과 별도 |

서로 겹치는 회귀가 있어 이 수를 고유 검사 총수로 합산하지 않는다. 실제 환경은
Windows / Node24.13.1 / Vitest5.0.3이다. package engines의 Node24.20.0과
다르며 exact-main CI나 배포 후보가 아니다.

Native 환경은 Windows11 / i7-13800H(20 logical CPUs) / 약64GiB RAM,
Chromium153.0.8010.12 / Playwright1.63이다. 후보별 local frontend와 local
signaling DO를 사용한다. 고RTT는 세 수신자 중 한 기기에 각 방향1,000,000B/s·
100ms, 느린 망은250,000B/s·100ms를 적용한다. HTTP/HTTPS/WS/WSS와 P2P
shaping을 분리하며, 시간 측정 중에는 담당자만 브라우저·빌드·대형 분석을 실행한다.

A2 구현 리뷰에서는 두 측정 블록 사이의 간격도 압축/긴 공백 검사에 포함하도록
보강했다. 첫 단위검사의250ms 경계 assertion은 성장 결정 이후 gain 부족으로
retire할 때까지 실행한 fixture 오류였고, 결정 순간을 검사하도록 고쳤다.
초기 실패·중간 실행은 삭제하지 않았다. F16은 재조립 decode가 reject되기 전에
채널이 교체되는 경우 옛 오류가 새 채널을 닫지 않도록 exact-channel 가드를
추가했다. 이들은 격리 후보의 구현 보강이며 프로덕션 재현 결함으로 세지 않는다.

F16은 v1 credit 협상 다음 v2 offer와 nonce를 echo한 fragment-ready를 사용한다.
상대가 offer를 처리했음을 확인한 뒤에만 분할 송신한다. 구버전 controller는
예약된 v2 메시지를 무시하고 v1 framing/credit을 유지한다. nonce는 각 조각에
실리지 않고 handshake와 정확한 ordered 채널에 바인딩된다. 재조립은 채널당
최대81924 bytes 한 건, 여덟 수신자 합계655392 bytes로 제한한다. 일반 full
chunk는 envelope·기존 header 때문에 보통 **5개 native 메시지**가 된다.
IP 패킷이5배라는 뜻은 아니다. 부분 송신 실패는 그 연결을 종료하고 완성 청크의
credit을 잘못 반영하지 않는다.

### Qlease 대조

같은 새29개 핀을 이전 **Q-only** 실험 runtime에 적용하면18 pass /
**11 expected fail**이다. 새 Qlease는29개 모두 통과했다. 이것은 대조 실험의
예상 실패이며 현재 프로덕션이11건 고장났다는 뜻이 아니다. Q 자체의 gate와
lease는 `quality-base.patch` / `lease-after-quality.patch`로 분리해 보존했다.

정확한 시계에서 실제 ±300/±1200ms media 오차 감소, Android250ms lead 유지,
계획/버퍼/릴리스 중 물리적으로 가능한 비대칭 표본 교체, epoch reset·로컬
±60초 wall step·지각 타이머, 새로운 PAUSE/STOP/PLAY/seek와 퇴장 우선권을
검사했다. 시계 무효화나 지각 릴리스가 이미 pause한 같은 작업에서 발생하면
**보정 전 로컬 위치 + 단조시각 경과**로 복귀한다. 이전 오차가 남아도 재생을
계속하게 하는 복구이며 시계 정확도를 회복했다고 주장하지 않는다.

Q는 RTT218ms에서 실제300ms 오차도 계속 보류한다. 좋은 새 시계가 돌아온 뒤
오차를 줄이는 양성 검사와 이 한계를 모두 남긴다. 곡 끝·duration 불명·iframe
예외·관측하지 못한 원격 시계 스텝·진짜 슬립·다른 생명주기 취소까지 강제
재생하지 않는다. 가짜 iframe의 논리 잔차를 검사했으며 실기 소리를 측정하지 않았다.
사전 계약의 invalidation 복구는 같은 소유권이 유지된 시계 무효화에 대한
제한된 복구로 해석한다. 새 명령·identity·퇴장에는 새 소유자가 우선하며,
과거 작업이 다시 play하지 않는 것이 요구사항이다. 동결한 사전 계약은 수정하지 않는다.

### Native 비교

#### A2 초기 선별

기준→후보 순서의4회·12파일은 기능·SHA·순서·nonce·최종 S=R=A와 실제
동적 창 기준 admission을 독립 검산했다. frozen30파일, 기준/후보 소스 각각
2315파일, 빌드 각각856자산의 실제 바이트 해시도 일치했다.

| 조건 | 기준128 | A2 | 후보 최대 제어 지연 | 프리로드 추가 재생 조작 |
| --- | --- | --- | --- | --- |
| 고RTT 일반 전송 | 64.626초 | 31.028초 | 252ms | 해당 없음 |
| 긴 느린 망 프리로드 | 193.751초 | 193.764초 | 633ms | 0 |

고RTT 완료는51.99% 단축됐다. 느린 망은180초를 넘기는 동안128 KiB를 유지했고
완료시간은 사실상 같았다. own/room 두 구간의 최대 excess 증가 중 가장 큰 값은
+11ms, p95는+6ms로 초기 예산 위반이 없었다. 느린 망의 빠른 두 수신자는
3.661→3.935초(+7.48%), 3.694→4.002초(+8.34%)였으며 반복 여부는 별도 확인한다.

최종 preload-ack는 무전송 baseline이 없어8개 scope-group을 상대 지연으로
판정하지 못했다. ACK 정확성과 raw 상한은 확인했다. 보조 분석의7개와 차이는
후보에 있는 group만 순회했기 때문이며, 최종 커버리지는 양쪽 합집합을 사용하는
독립 감사의8개를 따른다. 적은 표본으로 p95를 평가하지 못한 group도 그대로 남긴다.
이4회는 반대 순서·다른 전송/망 조합·갑작스러운 망 변화의 통과를 뜻하지 않는다.

#### F16 초기 선별

별도의 공통 fragment observer를 기준/후보 양쪽에 설치하고 fresh B128부터
다시 측정했다. 고RTT 일반 전송은64.536→57.776초로10.47% 단축됐고, 후보
최대 application-control 지연은250ms였다. 긴 느린 망은193.800→194.086초
(+0.148%), raw 최대732→419ms, 불필요한 플레이어 조작0개였다.

독립 감사는4회·12파일의 기능·무결성·credit128·native16 KiB 경계·sequence/
offset·v2 nonce echo·입장 완료 후 협상 순서를 확인했다. frozen36개,
기준/후보 소스2315/2316개와 빌드 각각856자산의 실제 해시가 일치했다.
own/room 예산 위반은0, 가장 큰 excess 증가는 고RTT max/p95 +17/+15ms,
느린 망 +9/+1ms였다. baseline 없는 preload-ack6개 scope-group은 미평가다.

**기능은 통과했으나 단독 성능 선별은 실패**다. 고RTT 이득이 사전20% 기준에
미달하므로 작은 메시지를 보내는 것만으로 처리량 문제를 해결했다고 보지 않는다.
일반 전송 host의 native 메시지는1056→5274개로 늘었다. observer 작업 시간은
host7.9→46.4ms, shaped guest8.1→44.6ms였으며, 이 추가 계측 비용을 제품
자체 비용이라고 해석하지 않는다. 한 번의 raw 최대 감소도 효과의 재현성이나
메시지 interleaving 원인의 확정 증거는 아니다.

732→419ms는 같은 guest3/down/sync-pong(n=194, 각 no-bulk n=18)이다.
no-bulk median106/105ms를 뺀 excess max는626→314ms이나, excess p95는
316→299ms로17ms만 줄었다. 따라서 최댓값 한 번의 차이와 분포 전반의 개선을
구분한다. A2와 결합하면 좋은 효과가 그대로 합쳐진다는 보장도 없다. 조각화가
receipt 간격을 바꾸면 A2의 학습·성장·축소 판단 자체가 달라질 수 있다.

#### 추가 동적 망 검증

고정망 A2 결과를 확인한 뒤, 제품 추천에 앞서 갑작스러운 속도 하락의 위험을
추가 검증하기로 했다. 기존 기준을 바꾸거나 실패를 대체하는 재실행이 아니다.
빠른 망에서 이미 늘린 창의 debt는 느린 망으로 바뀌어도 회수할 수 없기 때문이다.
이 단계가 실패하면 고정망 초기 선별은 그대로 남기되 확대 반복은 보류한다.
사전 동결한 trace는 첫 bulk 송신 뒤30초까지8Mbps, 다음60초간2Mbps,
이후8Mbps 복귀다. 같은46MB 파일·세 수신자·100ms 각 방향 지연을 유지했다.
각 실행 안에서2/8Mbps 무전송 기준을 각각24초(+2초 settle) 확보했다.
송신 시점 phase로 자기 기준을 선택하고 전환 뒤 늦게 도착한 frame도 남겼다.
CDP 변경 시작~적용 완료 사이의 불확실성도 별도로 표시한다.

첫 B128→A2 한 쌍은149.858→104.143초, raw 최대574→790ms,
추가 플레이어 호출0개였다. 급락 직전 A2는 accepted256·실제 미확인량262144B로
사전 요구한 큰 debt 조건을 충족했다. 약0.57초 뒤128로 축소하고, 느린 구간의
재확대 없이 회복 후192→256으로 커졌다.

그러나 **독립 비교에서 추가 안전성 선별은 실패**했다. 느린 guest3/down/
sync-pong의 slow2 phase excess max는337→685ms(+348ms), whole은
424→685ms(+261ms)로250ms 예산을 넘었다. whole down/youtube-sync의
excess p95도+144ms(n=50/35)로100ms 예산을 넘었다. own/room 중복을 포함한
실패8행은 서로 다른8개 결함을 의미하지 않는다. raw 전체 최대값 차이216ms만
보면 놓치는 문제이며, phase와 자기 baseline을 맞춘 판정을 최종으로 따른다.
조건부24회 확대와 실제 취소·승격 검사는 이 후보에 실행하지 않았다.

회복 직후 처음 완료한 측정 block에는 속도 회복 전 표본도 섞여 있었다.
따라서 회복 뒤 두 block이 완료됐다는 사실과, 두 block 전체가 회복 후 표본으로만
구성됐다는 주장을 구분한다. 알고리즘에 외부 망 변경 신호가 없으며 후자를
입증하지 못했다. 이것으로 새로운 독립 결함 수를 늘리지 않는다.

whole youtube-sync p95 차이는 A2가 빨리 끝나 느린 phase의 표본 비중이
커진 효과도 포함한다. 같은 slow2 phase의 p95 차이는+5ms이므로 전부를
같은 상태의 처리 악화로 설명하지 않는다. 그래도 slow2 자체의 sync-pong
max+348ms가 별도로 예산을 넘으므로 안전성 탈락 결론은 유지한다.

### 추가 조합 후보 AF16

A2 단독의 동적 실패를 확인한 뒤 새 후보를 별도로 구현·시험했다. F16의
동일 sync-pong tail 감소가 추가 검사의 동기이며 성공을 예측하는 근거는 아니다.
A2의 rate/gain/age 기준은 유지하고, F16의 분할 협상이 완료된 연결에서만
확대를 허용한다. v1 credit을 지원하는 구버전과 v2 분할 협상 전 연결은
fixed128로 남긴다. v1 자체가 없는 peer는 기존1초 grace 뒤 legacy fallback을
유지하므로128 KiB 상한이 없으며, 적응형 학습은 하지 않는다. v1-only 상대에게도
적응형 확대를 허용하면 이미 탈락한 A2 단독이 fallback되는 문제가 남기 때문이다.
Qlease를 섞어 전송의 재생 부작용을 가리지 않는다.

새 baseline/AF16의 같은 동적 trace2회를 먼저 실행하고, 큰 debt 커버리지와
동일 예산을 통과할 때만 고RTT 일반·긴 느린 망 preload4회로 확장하도록
사전에 정했다. 기존 A2/F16 결과와 frozen artifact를 수정하지 않았다.

최종 focused89개는 모두 통과했다(초안86개에 동기 재진입3개를 추가). 앱/테스트
타입·focused lint·format도 통과했다. 실제 adapter를 쓰는 합성 전용10개 핀은
협상 전·v1·잘못된 ready의 fixed128, 늦은 ready의 기존 debt 보존과 과거 ACK
학습 제외, 중복 ready의 epoch 유지, 분할 상태 확대·축소, 부분 실패 정리를
검사한다. 독립 읽기 검토에서 A2 adaptive 본문·상수와 F16 codec은 원본과
같고 adapter는 생성자 옵션 결합 외 동일함을 확인했다. 이는 native 성능
예산이나 급락 직전 큰 debt 커버리지의 통과를 대신하지 않는다.

동적2회·6파일은 기능·SHA·순서·누적 S/R/A·분할/nonce·관측을 통과했고,
frozen77개와 소스·빌드 해시 불일치는0이었다. 기준149.660→후보102.689초
(31.4% 단축), raw 제어 최대593→833ms, 프리로드 추가 플레이어 호출0개다.
빠른 두 수신자는3.615/3.612→3.751/3.790초로10% 회귀 기준 안이었다.
급락 직전 accepted256·미확인262144B·분할 협상이 실제 ledger에서 확인됐다.
CDP 적용1ms 구간에 해당 ledger 변화가 없고 적용 뒤에도 같은 accepted epoch가
관측돼 요구한 불리한 경계를 시험했다. 경계 snapshot을 원자적 계측이라고
일반화하지 않는다.

**AF16도 안전성 선별 실패**다. guest3/down/sync-pong의 같은 slow2 phase
excess max가336→727ms(+391ms), whole은454→727ms(+273ms)로250ms
예산을 넘었다. p95는 slow2 차이0(n60/60), whole−5ms(n150/103)였다.
따라서 분포 전체가 나빠졌다고 주장하지 않지만, 사전에 정한 최대 지연 조건은
통과하지 못했다. own/room·첫8초 구간까지 겹치는 실패6행은 별개의6개 사고가
아니다. 무전송 기준이 없는4개 group은 미평가로 남긴다.

해당 peak는 대역폭 하락192ms 뒤 보낸 sync-pong이833ms 뒤 도착한 건이다.
자기 slow2 무전송 median106ms(n24)를 빼면727ms다. 창128로 되돌아간 첫
관측은 하락731ms 뒤였고 그때도192 KiB debt가 남았다. cooldown 위반과
느린 구간 재확대는 없었다. 정책상 축소와 이미 보낸 데이터의 즉시 회수는
다른 일이라는 경계를 보여주며, 전체 네트워크 내부 큐 위치를 확정하지 않는다.

고정망 후속4회, 정역순24회 확인, 실제 취소·승격 검사는 **조건 미충족으로
미실행**했다. 단위 핀 통과를 이 native 생명주기 검사의 대체로 세지 않는다.
전체 제품 unit/E2E·원격 환경에서 후보 runtime 검사도 미실행이다. 이번
문서 PR의 CI는 저장소 원본을 검사하며 ignored 후보 runtime의 원격 통과를
의미하지 않는다. 기존 실패·후속 생략을 모두 보존한다.

## 로컬 근거 식별

모든 실험 소스·패치·단위검사 로그·빌드·원시 측정과 별도 감사는 ignored
`scratch/transport-candidate-roundtable-2026-10-18/`에 보존한다. GitHub CI
artifact가 아니며, 각 후보는 별도 Git commit 대신 baseline SHA와 아래
동결 patch/manifest로 식별한다. 제품 checkout에는 문서만 반영한다.

`primary-evidence-manifest.json`은 일차 근거155개 /851262330B를 봉인하며
독립 감사의 파생 산출물은 별도 manifest로 남긴다. native 측정은17:46:58~
18:50:30 KST, 케이스 실행시간 합계2278.099초였다(중간 구현·감사 제외).
담당자가 띄운4410~4413/8803 서버는 PID·명령·생성 시각 확인 후 종료했고,
`server-cleanup.json`의 잔여 소유 프로세스/리스너0·파일 삭제0을 확인했다.

| 근거 | SHA-256 |
| --- | --- |
| 기준 `source-1428b6d0.zip` | `2e19dc588f47b7ab1199837d15a3d33d1f8a4ba34cc3c3eaa906c62f0e0dc43a` |
| A2 `factor-A2.patch` | `330fe2ed00e8feebe3ac7bffb68d35d34f9146618f05c0e90f640d9dbae0232b` |
| A2 `execution-freeze-a2.json` | `66ad0e763019118eee844581df0e9de14396397ce04e69f8779959f01bcf612f` |
| F16 `fragment/runtime.patch` | `dd8fcbfb18d85105dfd2d50237541acc27f77dff05f46571e201026db0c27f9f` |
| F16 `independent-f16-manifest.json` | `a18a89a5fd96ae28c209e87aa225493e106e4a4e4352be8d2440ad2e7638a2cf` |
| A2 동적 `execution-freeze-dynamic.json` | `1f93e64d81d854b0541f87a53b1ed6987ec4b8182ebcd917c012d8b6a053517d` |
| Qlease `clock/lease-after-quality.patch` | `f7155367c7eab4b8a7f0332bcbb4432975c8ee0daaf395800f447dfad6f4ffbe` |
| Qlease `clock/candidate-manifest.json` | `0a757457afa93780ad5c21737b5f0c91b912bcafd8d16725a5b7725adebbf3d9` |
| AF16 `combined/runtime.patch` | `11dafbb8b1acf15bf71901e70330e68db5174b051aa320212eb67a9bfcd0c602` |
| AF16 `combined/candidate-manifest.json` | `4d8f938d44b6eaff43f5711eca3e7a5515f8e674eefc1186e25b4d33cccebabc` |
| AF16 `execution-freeze-af16-dynamic.json` | `731ef1d4e9278e6284cf0c11feb180c10a5d7ae1576fc934ecea4b8a59ab449f` |
| AF16 `independent-af16-audit.json` | `0cdb094bc39782f70a00d4a525ca955f40040ca992ccce6c34b5325d4efc39ac` |
| AF16 `independent-af16-evidence-manifest.json` | `1e1827e4d074ccd28ebdda853d231cdf083797eefc20bdfeceae47b957780ed5` |
| 일차 근거 `primary-evidence-manifest.json` | `8df05a960c55e5bb930bac7dee253392a32956144009a6b5315e3f92bc9c442f` |

## 원리와 한계

F16은 청크 크기를 다시 바꾸는 안이 아니다. 저장 인덱스와 credit은64 KiB
논리 청크를 사용하고, 그 한 건을 브라우저에 전달하는 메시지 경계만 바꾼다.
RFC8831 §6.6은 메시지 interleaving이 없을 때 큰 메시지의 association
독점을 피하도록16 KB 이하를 권고한다. 이것은 후보의 근거이며 현재 사용한
Chromium153의 실제 협상 상태나 병목 원인을 증명하지 않는다.
[RFC8831](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.6)

확인한 upstream WebRTC 소스는 interleaving을 field trial로 선택한다.
시험에서는 해당 설정을 강제하지 않는다. 이 source revision과 실제 브라우저
바이너리가 같다는 주장도 하지 않는다.
[upstream transport](https://webrtc.googlesource.com/src/+/dfe1d428d65279cd6615f8a43393aff6874b7188/media/sctp/dcsctp_transport.cc)

추가로 보낸 byte는 회선이 갑자기 느려져도 회수할 수 없다. A2는 확대 전에
불리한 관측을 걸러내지만 임의의 속도 급락에서 지연 예산을 보장하지 않는다.
누적 debt인 S−A는 도착했지만 receipt가 돌아오지 않은 byte도 포함한다.
따라서 이를 물리적으로 미도착한 S−R이나 특정 내부 큐의 크기로 바꾸어 읽지 않는다.
시계 품질 gate로 잘못된 보정을 막는 것과 실제 오차를 고치는 것도 별개다.
보정 횟수가 줄었다는 이유만으로 전송 또는 정밀성 개선을 선언하지 않는다.

native RTC·저장 경로와 별개로 미디어 공급자는 진행하는 controlled YouTube다.
단일 Windows PC와 CDP P2P shaping은 실제 Android·가청 싱크·Wi-Fi·TURN·R2·
8대 초과 물리기기 성능을 증명하지 않는다. 모든 망에서 모든 문제를 해결한
모델을 얻었다고 해석하지 않는다.
