# Standard HTTPS 시그널링 브리지 실패 진단 (2026-10-20)

- Status: 8.11.29 진단 추가·검증 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 2026-10-20 8.11.28 Production Release의 두 실행
  [39371044098](https://github.com/hiefny/MUSIXQUARE/actions/runs/39371044098)(방장 열기)과
  [39371530082](https://github.com/hiefny/MUSIXQUARE/actions/runs/39371530082)(방장 열기 성공 뒤 게스트 열기)이
  Standard HTTPS signaling smoke의 `POST /api/standard-signaling/v1/bridge/open`에서 HTTP 502를 받아 실패했고, 각각
  자동 복구가 App을 8.11.27로 되돌렸다. 세 번째 실행
  [39374155277](https://github.com/hiefny/MUSIXQUARE/actions/runs/39374155277)은 통과했다. 2026-10-16 8.10.25의
  [38798391865](https://github.com/hiefny/MUSIXQUARE/actions/runs/38798391865)도 같은 열기에서 503을 받은 뒤 재시도로
  통과했다. smoke는 상태 코드만 출력했고 App Worker는 이 경로에서 아무 로그도 남기지 않아, 어느 Worker의 어떤 실패인지
  좁힐 수 없었다.
- 커밋: `71c5166d`(진단과 릴리스 식별자 8.11.29 / v738).

## 502가 나올 수 있는 곳

브리지 열기마다 App Worker가 `PRO_SIGNALING_ROOMS` 바인딩으로 시그널링 Worker(`musixquare-signaling`)의 새 브리지
객체(`MusixquareRoom`)를 부르고, 그 객체가 다시 해당 방 객체에 WebSocket 연결을 연다. 코드상 502는 두 Worker 모두에서
나온다.

- App Worker: 브리지 객체 호출이 5초(poll은 18초) 안에 끝나지 않거나, 호출이 거부되거나, 본문을 읽지 못하거나
  96 KiB를 넘거나, UTF-8이 아니면 `STANDARD_SIGNALING_BRIDGE_UNAVAILABLE`, `Content-Type`이 JSON이 아니면
  `STANDARD_SIGNALING_BRIDGE_INVALID_RESPONSE`.
- 시그널링 브리지 객체: 방 객체 호출이 거부되거나 소켓 수락·저장에 실패하면 `STANDARD_HTTP_BRIDGE_UPSTREAM_UNAVAILABLE`,
  방 객체가 101이 아닌 상태로 답하면 `STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED`(둘 다 502 JSON). App은 이 JSON 5xx를
  그대로 전달한다. 방 객체는 연결 전에 서비스 점검 상태(서비스 제어 객체, 2초 제한)와 방 상태를 확인한다.
- 게스트 열기는 방 객체에서 PIN 시도 키 계산과 게스트 수락을 기다리고, 방장 열기는 대기 목록에 바로 넣는다. 두 번째
  실패가 게스트 열기였던 점과 맞을 수도 있지만 근거는 없다.

## 변경

### smoke

`scripts/live-standard-http-signaling-smoke.mts`의 브리지 open·send·poll·close 요청이 실패하면 한 줄을 남긴다.

```text
HTTP signaling bridge open failed (role=guest; HTTP 502; code=STANDARD_SIGNALING_BRIDGE_UNAVAILABLE; elapsedMs=5012; ray=8d1f2c3b4a5e6f70-ORD)
```

- `code`: App과 브리지 객체의 기계 코드 25개 허용 목록에 있으면 그 값, 목록에 없는 문자열은 `unknown`, `error` 필드가
  없으면 `none`. 쓸 수 있는 JSON이 오지 않으면 `timeout`(smoke의 20초 제한), `network-error`, `body-error`,
  `oversized`(128 KiB 초과), `non-json`(엣지 HTML 오류 페이지 등). send는 기존처럼 `cseq`와 프레임 종류도 붙인다.
- `elapsedMs`는 요청 시작부터 본문을 다 읽거나 실패할 때까지다. `ray`는 응답의 `cf-ray`이고 형식이 맞지 않으면 `none`이다.
- 세션 토큰, capability 토큰, peer ID, 방 번호, 프레임 내용, 응답 문구는 넣지 않는다. Ray ID는 요청 하나를 가리키는
  Cloudflare 식별자이고 자격 증명이 아니다.
- close 실패는 경고로 출력만 하고 smoke 결과는 그대로다(정리는 best-effort, lease가 최종 정리). 통과한 실행은 마지막
  JSON 줄에 `bridgeOpenMs`(방장·게스트 열기 시간)를 남겨 5초 제한까지의 여유를 릴리스마다 볼 수 있게 했다.
- 재시도와 제한 시간은 바꾸지 않았다. 둘 다 오너가 정할 일이다.

### App Worker

- `callStandardSignalingBridge`가 `fetchServiceBindingResponse`에 `onFailure`를 넘기고, 첫 실패 사유와 호출 시간,
  제한 시간을 함께 돌려준다. `fetchServiceBindingResponse`는 `fetch`·`body` 실패 때 거부 값을 두 번째 인자로 넘기며,
  요약에만 쓰인다. 기존 호출부(PRO facade)는 이 인자를 쓰지 않는다.
- `standardSignalingBridgeUpstreamResponse`가 5xx를 돌려줄 때마다 `console.error` 한 번을 남긴다. 응답 본문, 상태,
  제한 시간은 바뀌지 않았다. 정상 응답과 4xx 프로토콜 응답은 로그를 남기지 않는다.

| 필드 | 값 |
| --- | --- |
| `diagnostic`, `schema` | `standard_signaling_bridge`, `1` |
| `operation` | `open`, `send`, `poll`, `close` |
| `reason` | 쓸 수 있는 응답 없음: `response_timeout`(응답 머리 대기), `body_timeout`, `fetch`(호출 거부), `body`(본문 읽기 실패·크기 초과). 응답 있음: `invalid_utf8`, `content_type`, `upstream_status`(브리지 객체의 5xx JSON을 그대로 전달). `unknown`은 도달하지 않는 방어값 |
| `status` | 클라이언트가 받은 상태(502, 또는 전달한 5xx) |
| `upstreamStatus`, `upstreamContentType` | 응답이 있으면 그 상태와 media type(파라미터 제외, 헤더가 없으면 `none`, 형식이 이상하면 `invalid`), 없으면 `null` |
| `upstreamError` | `upstream_status`일 때 브리지 객체의 5xx 코드 4개(`STANDARD_HTTP_BRIDGE_UNAVAILABLE`, `_UPSTREAM_UNAVAILABLE`, `_UPSTREAM_REJECTED`, `_SEND_FAILED`) 중 하나, 아니면 `unknown` |
| `errorType`, `retryable`, `overloaded`, `remote` | `fetch`·`body` 실패의 오류 이름(허용 목록, 아니면 `unknown`)과 Cloudflare 오류 속성 세 개. 거부 값이 없으면 `null`과 `false` |
| `elapsedMs`, `timeoutMs` | 브리지 객체 호출 시간과 그 제한(open·send·close 5000, poll 18000) |
| `rayId` | 요청의 `CF-Ray`. smoke 줄의 `ray`와 같은 값으로 두 기록을 잇는다 |

방 번호, peer ID, 세션 ID, 토큰, IP, URL, 오류 메시지와 응답 본문은 넣지 않는다. App Worker는 Workers Logs가 켜져
있어(`head_sampling_rate = 1`, `invocation_logs = false`) 이 기록이 대시보드 로그에 남는다.

## 다음 실패를 읽는 법

smoke 줄의 `ray`로 Cloudflare 대시보드의 `musixquare-app` 로그(Observability)에서 `diagnostic =
standard_signaling_bridge` 기록을 찾는다. 로컬 wrangler 토큰은 `workers_tail` 권한뿐이라 지난 로그 조회는 대시보드에서
한다.

| smoke `code` | App `reason` | 뜻과 다음 단계 |
| --- | --- | --- |
| `STANDARD_SIGNALING_BRIDGE_UNAVAILABLE` | `response_timeout`, `elapsedMs` 약 5000 | 브리지 객체가 5초 안에 응답 머리를 보내지 않았다. 시그널링 Worker 쪽 지연이고, 5초 제한 조정은 오너 결정이다 |
| 같음 | `fetch` | 바인딩 호출 자체가 거부됐다. `overloaded`·`retryable`이면 플랫폼 쪽, `remote`이면 시그널링 코드의 예외라 시그널링 Worker의 `[SignalingDiagnostic]` 로그와 맞춰 본다 |
| 같음 | `body`, `body_timeout`, `invalid_utf8` | 응답은 왔지만 본문을 쓸 수 없었다. `errorType`과 `elapsedMs`를 본다 |
| `STANDARD_SIGNALING_BRIDGE_INVALID_RESPONSE` | `content_type` | JSON이 아닌 응답이다. `upstreamStatus`·`upstreamContentType`으로 플랫폼 오류 페이지인지 본다 |
| `STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED` | `upstream_status` | 방 객체가 WebSocket 연결을 101이 아닌 상태로 거절했다. 그 상태는 브리지 객체가 버리므로 더 좁히려면 시그널링 Worker에 기록을 더하는 별도 릴리스가 필요하다 |
| `STANDARD_HTTP_BRIDGE_UPSTREAM_UNAVAILABLE` | `upstream_status` | 방 객체 호출이 거부됐거나 소켓 수락·저장에 실패했다. 시그널링 Worker 로그를 본다 |
| `RATE_LIMIT_UNAVAILABLE`(503) 등 입구 코드 | 기록 없음 | App 입구의 rate-limit·capability·점검 단계다. 이번 App 진단 범위 밖이고 smoke 코드로만 구분된다 |
| `timeout`, `network-error`, `non-json` | 대개 기록 없음 | App이 답하기 전 구간(GitHub runner, Cloudflare 엣지)이다. `ray`가 있으면 그 요청을 조회한다 |

## 검증

- 로컬 Windows 11, Node 24.20.0 / npm 12.0.2(고정 툴체인), 커밋 `71c5166d`.
- 새 `standard-signaling-bridge-diagnostics.test.ts` 16개: smoke 클라이언트를 실제 App Worker에 프로세스 안에서 붙이고
  브리지 객체만 바꿔 실패를 강제한다. 같은 실패에서 smoke 줄(역할·상태·코드·경과 ms·Ray ID)과 App 기록(operation·reason·
  코드·시간)을 정확히 비교하고, 기록 전체에 방 번호·peer ID·IP·capability 토큰·`Bearer`·오류 문구가 없음을 확인한다.
  5초 열기 제한과 18초 poll 본문 제한은 가짜 타이머로 양쪽 `elapsedMs`가 5000·18000인지 본다. 정상 흐름과 409는 기록이
  없고, 로거가 예외를 던져도 502 응답은 같다.
- `live-standard-http-signaling-smoke.test.ts` 20개(새 12개, 기존 send 실패 4개와 성공 흐름 1개 갱신): 허용·미허용·
  누락 코드, HTML·초과·중단 본문, 네트워크 오류, 20초 제한, poll 실패, close 경고, 성공 줄의 `bridgeOpenMs`.
- 일부러 깨뜨린 확인: App이 실패 사유를 버리게 하면 새 테스트 7개, 브리지 객체 5xx 기록을 끄면 4개가 실패했다.
- 커밋 `e34f923a`: `npm run typecheck`, 린트, 포맷, committed `build:checked` 통과(`guard:sw-cache-version`은 v738이
  런타임 커밋을 덮는다고 판정). PR head `3bf6ab2c`(그 뒤로는 테스트 주석만 바뀜): unit 598 files / 13,468 pass /
  0 fail / 0 skip, Worker coverage 51 files / 2,642 pass(`app-worker.ts` 80.25 / 76.27 / 87.08 / 85.43, 기준 75 / 71 /
  82 / 80), `node --check cloudflare/app-worker.ts`와 가드 developer-api-boundaries·d1-migrations·ops-drift-contract·
  bus-pairing·dead-exports·import-graph·brand-capitalization 통과.
- 새 worktree의 첫 전체 실행(`71c5166d`)은 13,466 pass / 2 fail이었다. 둘 다 무거운 도구 검사(`ci-quality-gates`의
  Worker suite 목록 검사, `tooling-eslint-config`의 `admin.ts` 타입 기반 린트)의 15초 시간 초과였고, 따로 실행하면
  통과했으며 위 재실행에서도 통과했다.
- 로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## 한계

- 원인은 아직 모른다. 이번 변경은 다음 실패의 위치와 시간을 남길 뿐이고, 한 번의 실패가 원인 전체를 확정하지는 않는다.
- App 기록은 브리지 응답 경로의 5xx만 다룬다. 입구의 503(`RATE_LIMIT_UNAVAILABLE`, `CAPABILITY_NOT_CONFIGURED`, 점검)은
  smoke 코드로만 구분된다.
- `STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED`이면 방 객체의 실제 상태는 알 수 없다. 시그널링 Worker 변경은 이번 App 릴리스
  범위 밖이다.
- 두 Worker 모두 `invocation_logs = false`, traces 꺼짐이라 요청 단위 플랫폼 기록(CPU·wall time, outcome)은 없다. 시그널링
  Worker는 예외만 `[SignalingDiagnostic]`으로 남긴다.
- 운영 로그에 이 기록이 실제로 남는 모습은 다음 실패 때 처음 확인된다. 배포 smoke가 통과하면 진단 경로는 운영에서 실행되지
  않고, 운영에서 일부러 실패를 만들지 않는다.
- 이번에 대시보드로 지난 로그를 보려 했으나 이 PC의 내장 브라우저는 Cloudflare 로그인 확인에 막혀 열지 못했다. 다만 위
  설정에서는 시그널링 객체가 예외를 던진 경우가 아니면 지난 실패의 기록이 원래 남지 않는다.
