# 일반·PRO 동시 입장 시뮬레이션 — 2026-10-13

## 범위

기준 main은 `f185b2d751a42a313f991f9c1fe437ed65af62f2`다. 오너 요청에 따라
여러 기기가 한 방에 동시에 들어오는 로컬 통합 테스트를 추가한다. 제품 코드,
정원·요청 제한·presence TTL, App 8.10.5 / cache v666은 변경하지 않는다.
Cloudflare 배포나 운영방 부하 실험도 하지 않는다.

```powershell
npx vitest run --config vitest.burst.config.ts
```

별도 자격 증명 없이 기존 개발 의존성으로 실행한다. 두 파일은 일반 `npm test`와
Worker coverage에도 포함한다. 모든 가상 참가자는 시작 barrier에 도착한 뒤
함께 요청을 시작한다. 이는 순차 입장 루프가 아니지만 물리적 패킷 도착 시각까지
동일하다는 의미는 아니다. Durable Object의 실제 직렬 처리·저장은 그대로 작동한다.

## 시나리오와 판정

| 방 | 동시 요청 | 판정 |
| --- | --- | --- |
| 일반 | 공개 30 / PIN 60 / 공개 99 / PIN 99 | 방장 1명 외 전원 입장, 각 참여자의 양방향 signaling relay |
| 일반 | 공개 110 | 최대 99명 입장, 초과 11명은 정원 또는 대기 슬롯 교체 사유로 거절 |
| 일반 | 방장 인증 전 60, 준비 후 같은 60 재시도 | 준비 전 실패, 준비 후 전원 성공 |
| 일반 | 만석 99에서 기존 30 재접속, 신규 20, 기존 30 퇴장 후 신규 30 | 기존 연결 교체, 만석 거절, 퇴장한 자리 재사용; 유령·중복 명단 없음 |
| PRO | 서로 다른 IP 30 / 60 / 99 | cold registry에서 각 기기의 session → ticket → WebSocket 전체 경로 성공 |
| PRO | 같은 IP + PIN 99 | 공유망 요청 제한을 유지하며 전원 입장·연결 유지 |
| PRO | 소유자 부재 중 신규 120 | 99명 성공 / 21명 ROOM_FULL, 소유자 예약 자리로 복귀하여 총 100명 |
| PRO | 30개 요청 ID를 각 4번, 이후 같은 30 재시도 | 120요청이 30세션으로 합쳐지고 재시도 쿠키·신원 유지 |
| PRO | 99입장 → 28퇴장 → 28신규 → 신규28퇴장 → 기존28동시복귀 | 누적128세션 보관, 최종 소유자 포함100명, 활성 Peer 번호 유일·1–100, 남은 참가자 번호 유지 |

일반방은 `peer-open` 뒤 모든 성공자가 고유 offer/answer를 방장과 왕복한다.
실제 DO의 활성 게스트·WebSocket attachment·대기자·저장된 재접속 바인딩을
함께 확인한다. 로그인 assertion과 익명 참가자를 섞는다. PRO의 성공 HTTP 응답은
실제 클라이언트 snapshot parser로 검증하고, 전체 입장 완료 후 연결 유지도 확인한다.
첫 연결의 단순 `101` 또는 인증 전에도 받을 수 있는 pong만으로 입장 성공을 선언하지 않는다.

## 로컬 실행 경계

- shipped Worker를 esbuild로 묶어 Miniflare/workerd에서 실행한다. PRO·signaling·
  service-control은 실제 SQLite Durable Object와 binding으로 연결한다.
- 일반방의 read-only 명단 endpoint, PRO registry 지연/읽기 계측, 초기 D1 데이터,
  테스트 전용 서명 키·계정 assertion만 fixture다. 입장 핸들러와 정원 판정을
  가짜 구현으로 바꾸지 않는다. PRO 활성화도 실제 HTTP와 entitlement D1 경로를 거친다.
- 외부 Worker fetch는 차단하고 시도 0건을 확인한다. 일반방 native WebSocket의
  목적지는 로컬 runtime 주소만 허용한다. 운영 자격 증명은 읽지 않는다.
- 캐시의 정상 5초 TTL 재조회와 실패를 구분한다. PRO는 오래 걸리는 실행에서
  실제 heartbeat를 보내며 presence TTL 45초를 늘리지 않는다.
- 일반방 초과 입장의 `PENDING_GUEST_SLOT_ROTATED`는 기존 대기열 정책이다.
  Node WebSocket close handshake의 기본 30초 대기가 초기 하네스 timeout과
  충돌하여 shutdown 대기를 제한했다. 실제 서버 close code/reason을 검증하며
  timeout 자체를 정상 거절로 간주하지 않는다.
- PRO 가상 기기들은 하나의 Node HTTP keep-alive 연결 풀을 공유하지 않도록
  `Connection: close`로 요청한다. 초기 동일 IP·PIN 99명 시험에서 loopback
  `ECONNRESET`이 발생해 transport를 분리했다. 독립 리뷰에서 제품 코드를 제외한
  최소 workerd DO(PBKDF2 100k회·30KB JSON)의 99동시 POST에서도 기본
  keep-alive 3회는 매회 1–3건 ECONNRESET, `Connection: close` 3회는 모두
  99성공이었다. direct dispatch에서도 재현됐으며 플랫폼 내부의 reset 원인까지
  확정한 것은 아니다. 제품의 거절
  응답이나 실패 재시도를 성공으로 바꾸지 않으며, 운영 입장 결함으로 분류하지 않는다.
- 누적 세션 160개를 만드는 초안은 기존 128개 보관 한도를 넘어 오래된 쿠키가
  제거됐다. 이는 정상 정책이므로 최종 재입장 시험은 누적128개 안에서 수행한다.
- 이 Windows PC의 동적 TCP 포트 범위가 1024–15000이어서 Node fetch 금지 포트가
  runtime 입구에 배정될 수 있었다. OS 설정을 바꾸거나 실패한 입장을 재시도하지
  않고, 사용 가능한 49152–65535 포트를 먼저 확보해 두 runtime의 입구를 지정한다.
  probe 소켓을 해제한 뒤 runtime이 bind하므로 극히 짧은 포트 선점 경합은 남으며,
  해당 실패는 숨기지 않는다.

## 검증 결과

테스트 구현 SHA는 `b1298f4d04cf611c1b10eb5f247191911712c333`, 전용 runner·타입
프로젝트·기존 inventory assertion까지 반영한 최종 코드 SHA는
`a487bfed4443876045a0e4d7fb69198f573d71d2`다. 이후 문서만 추가한다.
환경은 Windows x64, Node 24.13.1, Vitest 5.0.3, Miniflare 5.20261006.0-alpha /
workerd 1.20261006.1이다. 저장소가 요구하는 Node 24.20.0과의 차이는 남으며,
GitHub CI는 `.node-version`의 버전을 사용한다.

- 최종 port helper 포함 두 파일 직접 실행: **14 pass / 0 fail / 0 skip**, 49.49초.
- 전용 `vitest.burst.config.ts` 실행: **14 pass / 0 fail / 0 skip**, 56.61초.
- 기존 tooling/CI 품질 계약 두 파일: **22 pass / 0 fail / 0 skip**.
- 전체 typecheck·lint·format:check, 최종 테스트 TypeScript 및 전용 runner의 tooling
  TypeScript/ESLint/Prettier 통과. Worker 문법·Developer API 경계·D1·운영 계약 guard 통과.
- committed `7e2b2a9d`의 `build:checked` 통과. 마지막 코드 변경은 test inventory 한 줄이다.
  package.json에 명령을 추가한 초안은 보수적인 캐시 guard에 걸려 철회하고 전용
  Vitest config로 제공했다. guard를 완화하거나 제품/cache 버전을 올리지 않았다.
- 독립 읽기 전용 리뷰에서 PRO의 지속 연결 관측·SQLite binding·캐시 TTL과 heartbeat를
  보완했다. 최종 리뷰에서 추가 차단 항목은 없었다.

초기 전체 검사에서는 160개 보존 세션 초안의 재입장 기대가 실패했고, 다음 실행에서는
새 설정 파일을 기존 tooling inventory 기대 목록에 넣지 않은 한 항목이 실패했다.
두 항목 모두 테스트 설정을 바로잡고 관련 검사를 통과시켰다. 최종 코드 `a487bfed`에서
`npm test -- --maxWorkers=6`은 **558파일 / 12,562 pass / 0 fail / 0 skip**으로
완료했다(201.72초). 기존 로컬 jq를 `MXQR_TEST_JQ_PATH`로 지정해 복구 inventory 검사도
포함했다. 로그는 Git 제외 `scratch/session-burst-verified-unit.log`에 보존한다.
이 결과는 로컬 테스트 근거이며 exact-main 배포 후보를 대신하지 않는다.

## 한계

이 검사는 입장·신원·정원·시그널링의 로컬 회귀 검사다. 100대 실기기 브라우저,
App facade, HTTPS 쿠키 정책, OAuth 로그인, WebRTC 연결 성립, 음원 전송·오디오
동기화, 모바일 절전, 장시간 세션, Cloudflare edge의 운영 처리량을 증명하지 않는다.
일반방 metrics D1 카운터 쓰기는 fixture 범위에서 제외한다. 초 단위 실행 시간은
이 PC의 개발 검사 시간이며 서비스 지연 SLA가 아니다. 과거 고객 행사에서
발생한 입장 실패의 원인이나 당시 최대 동접자를 이번 결과로 확정하지 않는다.
