# PRO 행사 외부 리뷰 재검증 — 2026-10-13

| 항목 | 값 |
| --- | --- |
| 입력 | [외부 코드 리뷰](pro-event-sleep-and-capacity-code-review-2026-10-13.md), [기존 심층 감사](pro-event-admission-deep-audit-2026-10-13.md) |
| 검토·테스트 HEAD | `d279e9d3d0fc9115e36dde2dbc6e08d03627d5d7` |
| 비교 소스 | 행사 당시 `d76b1432` 전체 소스 archive |
| 환경 | Windows, Node v24.13.1, Vitest 5.0.3; 인메모리 storage/socket fixture 및 jsdom. 운영 조회·실기기 실행 없음 |
| 범위 | 보고서의 주장 독립 코드 검토, 제한된 로컬 재현. 제품·설정 변경, 커밋·푸시·배포 없음 |

외부 보고서 원문은 수정하지 않았다. 원문의 조치 제안은 승인으로 취급하지 않았다.
이번 검증 결과만 별도로 기록한다. 운영 배포 §1은 변경하지 않는다.

## 판정

1. 기존 Peer 번호/앱 parser 불일치와 공유 registry 요청 수명 결함은 기존 감사의
   근거를 유지한다. 보고서의 동의 자체를 새로운 실행 증거로 세지 않는다.
2. **추가 재현:** 정원 계산 직전의 presence 정보가 TTL 경계를 넘으면 한 요청이
   이미 만료된 자리를 세어 `ROOM_FULL`을 낼 수 있다. 보고서의 “그 경로는 없다”는
   단정은 틀렸다. 직전까지 99개의 비소유자 자리가 찬 조건의 짧은 경계 문제이며
   관찰된 12~30대만으로 이 원인이 성립했다고 주장하지 않는다.
3. 절전 이후 presence 복구에서 RAM 파일 cache를 비우고 파일을 다시 받는 경로는
   실제로 있다. 다만 빈 방 동결은 명시적 제품 정책이고, 모든 잠금이 반드시 만료·
   재다운로드·사용자 탭으로 이어진다는 주장은 성립하지 않는다.
4. 보고서의 H1–H6은 포괄적인 입장 실패 목록이 아니다. 이미 수용된 receipt/core
   용량 한도, 계정 회원 한도 등과 응답 본문을 함께 구분해야 한다.

## 1. 새로 검증한 TTL 경계의 정원 거절

현재 실제 `MusixquareProRoom.fetch()`는 핸들러 진입 전에 `prune(Date.now())`를
한 번 수행한다(`cloudflare/pro-room-worker.ts:7163`). 이후 body 처리·인증·PIN
검증 등에서 시간이 흐를 수 있다. `presenceAdmissionAvailable()`은 그 시점의
만료 여부를 다시 확인하지 않고 Map의 개수와 역할만 센다(`11781–11790`).

로컬 하니스에서 빈 공개방을 만든 뒤 HTTP로 비소유자 세션 99개를 입장시켰다.
높은 번호나 가짜 99개 presence를 직접 넣지 않았다. 공개방 활성 상태와 인메모리
storage는 fixture다. 시간은 고정하고 body 처리 경계에서 2ms 흐르게 했다.

| 단계 | 마지막 liveness 이후 시각 | 결과 |
| --- | --- | --- |
| 요청 진입·prune | 44,999ms | 아직 유효한 99개 유지 |
| body 처리·정원 판정 | 45,001ms | Map 99개, 현재 시각 기준 유효 0개인데 `409 ROOM_FULL` |
| 같은 시각에 새 요청 | 45,001ms | prune으로 정리 후 `200`, 새 presence 1개 |

처음 레거시 body 하니스를 조사 에이전트와 루트가 각각 실행했다. 루트는 별도
하니스에 현대 클라이언트의 `requestId`를 추가하고 현재·행사 당시 소스 각각에서도
동일 결과를 확인했다. 실시간 2ms 정밀 스케줄링이나 Cloudflare 처리량을 측정한
것이 아니라 **시간 경계에서 실제 핸들러가 읽는 상태**를 검증한 테스트다.

- 정상 만료 정리 자체가 고장 난 것은 아니다. 뒤 요청에서 정리된다.
- 서버가 30개를 100개로 계산했다는 결과도 아니다. 이 재현은 직전 99개를 필요로 한다.
- 수정 후보는 admission의 만료 정리·판정 시각을 일치시키는 것이다. 임의로 정원을
  늘리거나 TTL을 늘리는 조치는 이 경계의 해법이 아니다.

자료: `scratch/report-capacity-boundary-modern.mjs`; 실행은 환경 변수
`MXQR_CAPACITY_SOURCE=current` 또는 `historical`을 설정하고
`node --experimental-strip-types scratch/report-capacity-boundary-modern.mjs`.
초기 하니스는 로컬 TEMP `mxqr-capacity-review-20261013.mjs`다.

## 2. 정원·입장에 관한 나머지 정정

- “45초 안에 하트비트를 보낸 문서만 센다”보다 **최근 서버 liveness가 남은
  presence를 센다**가 정확하다. 입장 직후 WS 연결을 못 했거나 앱 parser가 실패한
  기기도 자리를 차지한다. heartbeat 외에도 자신의 liveness 갱신 경로가 있다.
- `presence/enter`의 HTTP 409만으로 `PRESENCE_ACTIVE_ELSEWHERE`를 확정할 수 없다.
  `ROOM_FULL`, `PRESENCE_IDENTITY_MISMATCH` 등 응답 본문이 필요하다. 과거 sampled HTTP
  상태 코드만으로 takeover 취소를 현장 원인으로 확정하지 않는다.
- REST와 signaling 상태 전달은 비동기다. 과거 소켓이 살아 있는 동안 presence
  방송이 늦거나 실패하면 signaling Map은 현재 REST 상태를 즉시 따라가지 못한다.
  따라서 H6이 반드시 **같은 순간 H1**을 필요로 한다는 설명은 너무 강하다.

마지막 항목은 실제 signaling Worker의 fetch·서명 ticket 검증을 사용하는 조건부
하니스로 확인했다. 초기 snapshot target 1개 뒤 후속 presence 방송과 socket close를
보류하고 더 높은 revision의 서로 다른 signed ticket 100개를 넣으면 소켓 Map이
100개가 되고 다음 입장이 `ROOM_MEMBER_LIMIT_REACHED`로 닫힌다. 새 snapshot
target 2개를 전달하면 정리되고 재시도가 성공한다. 루트가 하니스를 읽고 재실행했다.
이는 **임의로 서명한 fixture ticket과 fake socket**을 사용하는 지연 전달 조건부
검증이다. 실제 REST 발급·이탈 100회부터의 통합 재현이나 현장 장애 재현은 아니다.
기존 재시도·outbox가 있고, 발생 확률도 측정하지 않아 별도 확정 현장 원인으로 세지 않는다.
자료: 로컬 TEMP `mxqr-signaling-capacity-review-20261013.mjs`.

추가로 보고서에서 누락한 기존 제한:

- 신규 비소유자 성공 admission은 같은 IPv4 주소/IPv6 `/64`에서 200회/10분이다.
  단순 요청 수·동시 인원 수가 아니다. 멱등 replay/resume/heartbeat는 별도다.
- PIN 실패 제한은 **같은 방, 같은 정확한 IP 해시**에서 10회/시간이다. 제한 중에는
  올바른 PIN도 막힐 수 있다. 공개방은 이 경로를 생략한다. 해당 행사에서 PIN이나
  CGNAT 공유 주소가 어떤 상태였는지는 확인되지 않았다.
- session-create receipt는 공용 ledger 256개이며 비소유자는 전체 길이가 240
  미만일 때 예약할 수 있다. 나가기와 별개로 최대 10분 보존돼 여러 주소의 누적
  churn으로 `ROOM_STATE_CAPACITY_EXCEEDED`가 가능하다. 공용 core 1.2MiB 한도도
  같은 오류를 낼 수 있다. [기존 수용 정책 #11](../known-accepted.md#11-public-pro-room-seat-holding-and-join-floods)이며 신규 발견 결함으로 세지 않는다.

## 3. 절전·복귀: 사실과 정책·추정을 분리

**확인한 경로:** `runtime.ts:2820–2833`의 정확한 `PRESENCE_EXPIRED` 복구는
권한을 내리고 runtime을 다시 구성한다. `1520`에서 RAM cache를 비우고 새 manager와
cache를 생성한다. 첫 playlist rebase는 File 없는 wire row로 재구성하므로 이후
파일 PREPARE에서 R2 파일을 다시 받는 경로가 있다. 이것은 YouTube 다운로드 설명이
아니며 재다운로드 시간이 몇 초인지는 측정하지 않았다. reset 함수 자체가 호출된
순간 모든 일반 오디오를 강제로 중단한다고 단순화하지도 않는다.

동일 세션의 정확한 expiry 복구에서 immutable bytes를 잠시 보관하고 재인증·새
signed snapshot과 자산이 일치한 경우 재사용하는 개선은 검토할 가치가 있다.
권한 회수·새 incarnation 확인은 유지해야 한다. 다른 방, 퇴장·강퇴·탭 교체,
재입장 실패까지 권한과 재생을 그대로 유지하는 제안으로 넓히지 않는다.

원문에서 낮춰야 하는 단정:

- **실패 2번 = 만료:** 만료 기준은 클라이언트 실패 횟수가 아니라 마지막 서버
  liveness다. 요청이 서버에 반영된 뒤 응답만 실패할 수도 있다. API 15초 timeout,
  완료 후 15초 재예약, App 앞단 deadline도 구분해야 한다.
- **주머니에 넣는 순간 방 sleeping:** 마지막 실제 presence가 제거돼야 한다.
  화면을 가렸어도 heartbeat가 이어지면 빈 방이 아니다. 빈 방 sleep/freeze는
  [오너가 유지하기로 한 정책](pro-autonomous-playback-2026-10-12.md#decision-and-scope)이다.
- **iOS interrupted면 항상 탭 필수:** 일반 suspended/interrupted에는 자동 resume
  시도가 있다(`src/audio/context-recovery.ts:4–7`, `948–964`, `1094–1112`). 재생 중
  로컬 파일은 hidden 상태에서도 시도한다. running이지만 clock이 멎은 경로는
  더 엄격한 제스처 복구를 사용한다. 두 경로를 합쳐 필연적인 탭 요구라고 하지 않는다.
- **퇴장 기록 상당수가 TTL:** 가능한 설명이지 빈도 증거는 없다. 로컬 재현이나
  `SERVICE_RESPONSE_TIMEOUT` 세 건만으로 실제 퇴장 이유를 복원할 수 없다.

플랫폼 자료도 범위를 구분한다. [Screen Wake Lock 표준](https://www.w3.org/TR/screen-wake-lock/)
은 보이는 문서의 화면 유지용이며 백그라운드 실행 보장이 아니다.
[Chrome 타이머 정책](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/)
은 가청 상태를 구분하며, [WebKit의 관련 이슈](https://bugs.webkit.org/show_bug.cgi?id=261554)
도 iOS 버전별 회귀 사례다. 특정 행사 기기의 버전·잠금·오디오 상태를 대신 입증하지 않는다.
visibility에 따라 더 짧은 TTL·다른 정원을 주는 정책은 주머니 청취자를 더 불리하게
만들 수 있어 원문의 “더 낫다”를 그대로 채택할 수 없다.

**역사 구분:** 행사 당시 `d76b1432`에는 권한 있는 브라우저가 ENDED를 보고해야
다음 곡으로 넘어가는 별도 문제가 있었다. 서버 자동 전환은 2026-10-12 01:53 KST,
`972555c3` / 8.9.5로 배포됐다. 현재 서버 동작만으로 10월 11일 현상을 설명하면
이 이미 확인·수정한 경로가 빠진다. [릴리스 이력](../release-history.md)을 따른다.

## 4. 계측 제안의 정정

- `/debug sync`는 이미 텍스트 overlay와 1회 clipboard 복사를 제공한다
  (`src/chat/debug-console.ts:428–439`, `479–486`). 자동 서버 업로드가 없는 것이며
  내보내기 UI 자체를 새로 만들 필요가 있다는 결론은 틀렸다.
- visibility 전환과 AudioContext 상태도 recorder에 일부 있다. heartbeat 결과,
  re-entry 경과, redownload 여부 등 **빠진 정보**를 먼저 추려야 한다.
- `pro-start-observations`의 allowlist와 일반 `log-capture`를 혼동하지 않는다.
  일반 console capture에는 문자열·JSON·stack·파일명도 들어갈 수 있다.
- 설정은 PRO/App custom-log head sampling 0.1이며 PRO `invocation_logs=false`다.
  모든 HTTP 요청의 정확히 10%를 보유한다고 보증하는 설정이 아니다.
- D1 바인딩이 있어도 비용·지연은 따로 검토해야 한다. 기존 분 버킷 집계는
  이벤트마다 UPSERT하므로 “분 버킷 = 분당 1 write”가 아니다. room code 접미는
  현재 관리자 쿼리의 불필요한 행 읽기도 늘릴 수 있다. 이번에는 수집을 추가하지 않았다.

## 검증 결과와 한계

- 기존 4개 테스트 파일: **92 pass / 0 fail / 0 skip**.
  `context-recovery`, `runtime-account-lease`, `runtime-tab-handoff`,
  `runtime-session-end-reason`. 명령:
  `node node_modules/vitest/vitest.mjs run src/audio/__tests__/context-recovery.test.ts src/pro-room/__tests__/runtime-account-lease.test.ts src/pro-room/__tests__/runtime-tab-handoff.test.ts src/pro-room/__tests__/runtime-session-end-reason.test.ts --maxWorkers=2`.
- 정원 경계: 레거시 1개 시나리오와 requestId 있는 현재·행사 당시 2개 시나리오,
  총 **3개 조건의 assertion 성공**. 이는 바람직한 동작 통과가 아니라 결함의 재현 성공이다.
- signaling 지연 전달: 위 제한의 **조건부 하니스 1개 assertion 성공**.
- 전체 unit/E2E, 원격 CI, 실제 D1/Cloudflare 큐, 실기기 절전·음향·R2 다운로드
  시간은 실행하지 않았다. 어떤 결과도 운영 릴리스 후보 검증을 대신하지 않는다.
- 제품 소스·버전·설정 변경 없음. 새 열린 항목만 release record §2에 연결했다.
