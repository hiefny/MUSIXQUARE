# 접은 토스 인앱 출처의 신뢰 제거 (Worker 전용, 2026-10-24)

| 항목     | 범위                                                                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기준 SHA | `08003954` (main, 9.0.4 배포·실기 QA 기록본)                                                                                                                                                                            |
| 코드 SHA | `3e058623` (Worker·설정·테스트·smoke. 뒤 커밋은 문서만)                                                                                                                                                                 |
| 후보     | App·signaling·remote-share Worker와 remote-share R2 CORS. target `all`(아래 배포 범위). App 버전·SW 캐시(9.0.4 / v772)와 브라우저 런타임은 그대로. main `717d32d4`(PR #472)로 2026-10-24 04:46 KST 배포(아래 운영 배포) |
| 열차     | 토스 출처 정리 하나(Worker 런타임 증분 하나). QA 라운드는 아래 로컬 검사 한 번                                                                                                                                          |
| 환경     | Windows 11, Node 24.20.0, npm 12.0.2, Vitest 5.0.3(node), Worker 테스트 `vitest.workers.config.ts`                                                                                                                      |

## 왜 고쳤나

오너는 토스 인앱(Apps in Toss, `mxqr_toss` 브랜치) 버전을 오래전에 접었다(2026-10-24 확인). 그런데
`3850c59d`(2026-08-26, 시그널링 권한 울타리와 토스 출처)에서 넣은 두 앱 전용 출처
`https://musixquare.apps.tossmini.com`(운영)과 `https://musixquare.private-apps.tossmini.com`(QR 테스트)이
세 Worker와 remote-share R2 CORS 정책에 남아 있었다. 그 출처에서 뜬 페이지는 App API의 CORS 응답을 읽고,
시그널링 WebSocket 출처 검사를 통과하고, remote-share 세션과 R2 직접 PUT의 브라우저 CORS를 통과할 수
있었다. 권한 토큰, Turnstile·작업 증명, 방 업로드 assertion 같은 다른 검사는 그대로였으므로 이것만으로
뚫리는 것은 아니다. 다만 운영하지 않는 출처에 대한 신뢰는 필요 없는 공격면이라 지운다.

## 바뀐 것

- **App Worker.** `TOSS_WEBVIEW_ORIGINS`를 지웠다. CORS 신뢰(`trustedCors`)와, 설정값
  `MXQR_TURNSTILE_ALLOWED_HOSTNAMES`가 없을 때의 기본 Turnstile 호스트 허용(`isAllowedTurnstileHostname`)에서
  두 출처가 빠진다. 같은 출처, `musixquare.com`·`*.musixquare.com`, localhost, 설정한 신뢰 출처는 그대로다.
- **signaling Worker.** `isAllowedOrigin`의 tossmini 정규식 두 개를 지웠다.
- **remote-share Worker.** `DEFAULT_ALLOWED_ORIGINS`, `ALLOWED_ORIGINS` 값(`wrangler.remote-share.toml`과
  `.example.toml`), 생성 타입 `cloudflare/types/remote-share.generated.d.ts`(`wrangler types`로 다시 만듦),
  `cloudflare/r2-cors.remote-share.json`에서 두 출처를 지웠다.
- **회귀 검사.** 원래 있던 "무관한 토스 출처 거부" 검사를 지우지 않고 옛 두 출처까지 거부하도록 넓혔다.
  - 단위: App CORS(옛 두 출처와 무관한·루트 토스 출처 403), Turnstile 호스트(옛 두 호스트에서 푼 토큰은
    `TURNSTILE_FAILED`, 허용 예시는 `musixquare.com`·`www.musixquare.com`), 시그널링 WebSocket(옛 두 출처도
    Durable Object 조회 전 403), remote-share(R2 CORS 파일과 Worker preflight가 옛 두 출처를 거부, 두 Wrangler
    설정에 `tossmini.com`·`toss.im`·`toss-internal.com`이 없음). 전송 설정 테스트의 예시 호스트는
    `preview.musixquare.com`으로 바꿨다(`getPublicSignalingUrlForHost`는 호스트를 가리지 않는 함수라 런타임은
    그대로).
  - 운영 smoke 세 개가 이제 옛 두 출처와 무관한 미니앱 출처 `https://unrelated.apps.tossmini.com`을 모두
    찔러 본다(`REJECTED_TOSS_ORIGINS`). App 공개 경계는 `get-turn-config`가 셋 모두에 401/403이고 출처를
    돌려주지 않아야 하고, signaling은 셋 모두 WebSocket HTTP 403이어야 하며, remote-share는
    `/security-config`가 셋 모두 403이고 R2 업로드 preflight가 셋 중 어느 것도 돌려주지 않아야 한다(R2 정책
    전파는 기존처럼 45초까지 기다린다). 결과 필드는 `unrelatedTossOriginRejected`에서
    `tossOriginsRejected`로(R2 쪽은 `corsTossOriginsRejected`) 바뀌었다. 이 필드를 읽는 워크플로나 스크립트는
    없다.
  - 세 smoke는 지금처럼 새 버전을 확인한 뒤에 출처를 찔러 본다. signaling은 기대한 배포를 두 별칭에서 확인한
    뒤, remote-share는 기대한 Worker 버전 준비를 기다린 뒤, App 공개 경계는 App generation smoke가 새 자산
    수렴을 확인한 뒤에 돈다. 옛 버전은 옛 두 출처를 허용하므로 이 순서가 배포 중 오판을 막는다.
- **문서.** [remote-share 운영](../../cloudflare/remote-share-ops.md)의 R2 CORS 문단을 고쳤다.

## 그대로 둔 것

- 브라우저 런타임(`src/`): `src/ui/connect.ts`의 `(Toss in-app)` 주석과 CSS의 디자인 출처 주석은 두었다.
  그래서 `guard:sw-cache-version`이 버전 올림 없이 통과한다.
- 동결 기록: `docs/beta-release-readiness-archive-2026-10-10.md`와, 머리말이 동결 증거라고 밝힌 4월 출시 전
  점검표 [manual-qa-checklist.md](manual-qa-checklist.md)의 "토스 웹앱 사본 smoke" 출시 기준은 당시 기록이라
  고치지 않았다.
- Cloudflare 대시보드의 Turnstile 위젯 호스트 목록은 저장소 밖이다. 거기에 tossmini 호스트가 남아 있어도 이제
  App Worker가 그 호스트에서 푼 토큰을 거절한다. 정리는 선택이다.

## 호환성

- 토스 인앱 앱을 운영하지 않으므로 영향을 받는 사용자는 없다. 남은 토스 WebView가 있다면 API·시그널링·원격
  공유가 CORS 또는 403으로 막힌다(의도한 결과).
- 통신 형식, D1 스키마, 비밀, 바인딩 변경 없음. remote-share의 문자열 변수 `ALLOWED_ORIGINS` 값만 줄었다.
  새 계약 표지나 복구 floor도 없다.

## 배포 범위

App·signaling·remote-share 세 Worker의 런타임 경로가 함께 바뀌므로, 부분 릴리스 호환성 게이트
(`release-deployment-state.mts compatibility`)가 어느 단독 target도 막는다. 선택하지 않은 Worker에 미배포
변경이 남기 때문이다. 그래서 target `all`이다. `all`은 R2 정책(remote-share CORS 포함)을 적용하고 읽어서
확인하며, PRO room·Developer API facade·Developer API는 같은 코드를 다시 배포한다. PRO room 재배포는 살아 있는
PRO 방 Durable Object를 다시 시작하므로 행사 시간은 피한다. 앱 SemVer·SW 캐시가 그대로라 업데이트 창은 뜨지
않는다.

배포 전에 앱을 바꾸는 PR(#471 등)이 main에 들어가면 `all` 릴리스가 그 앱 변경까지 싣게 되므로, 이 변경은 그
PR보다 먼저 배포하거나 그 앱 묶음과 함께 나간다. 매일 Drift Audit은 운영 R2 CORS를 저장소 파일과 비교하므로,
병합과 배포 사이를 짧게 둔다.

되돌리면 토스 두 출처의 신뢰가 돌아올 뿐이다. R2 CORS는 release의 R2 정책 복구가 checkpoint 값으로 되돌린다.
기존 복구 경계(PRO room·App은 입장 정책 계약 표지 아래로 되돌리지 않음)는 그대로다.

## 검증과 한계

- 새 거부 검사가 옛 코드를 잡는지: Worker 코드·R2 CORS·Wrangler 설정만 `08003954`로 되돌리고 새 테스트를
  돌리면 7건이 실패한다(App CORS 1, Turnstile 호스트 2, 시그널링 WebSocket 2, remote-share CORS·Wrangler 2).
  새 코드에서는 모두 통과한다.
- 로컬 전체 검사(코드 `3e058623`, 일부는 문서 커밋만 더한 `2e8ee073`에서), 모두 통과:

  | 검사                                                  | 결과                                                     |
  | ----------------------------------------------------- | -------------------------------------------------------- |
  | `npm run typecheck`(테스트·Worker 타입 포함)          | 통과                                                     |
  | `npm run lint`, `npm run format:check`                | 통과                                                     |
  | 단위 `vitest run --maxWorkers=6`                      | 642 files / 14,666 pass                                  |
  | Worker `vitest run --config vitest.workers.config.ts` | 60 files / 2,867 pass                                    |
  | `npm run check:workers`                               | 통과                                                     |
  | `node scripts/check-resource-ownership.mts`           | 통과(기준선 변화 없음)                                   |
  | `npm run build:checked`                               | 통과. `guard:sw-cache-version`은 v772(`d6ac67f3`)로 PASS |

  브라우저 앱이 바뀌지 않아 e2e·브라우저 검사는 돌리지 않았다. Skip 없음.

- 운영 smoke는 배포 때 처음 운영 Worker에 닿는다. 로컬에서는 가짜 응답으로 판정 함수만 확인했다.

## 운영 배포 (2026-10-24)

- main `717d32d4`(PR #472 squash, 트리는 PR head `8d8c6663`와 같음). Exact-main push
  [CI 40012251278](https://github.com/hiefny/MUSIXQUARE/actions/runs/40012251278) 11 jobs success 후보로
  [Release 40013297969](https://github.com/hiefny/MUSIXQUARE/actions/runs/40013297969) attempt 1을
  target `all`, Developer API D1 끔으로 돌렸다. deploy job은 04:46:09 KST에 성공했고 독립 recovery job은 skip됐다.
- 운영 smoke가 처음으로 운영 Worker에서 거부를 확인했다. remote-share는 두 번(일반, 방장 assertion 경로) 모두
  `/security-config`가 세 토스 출처에 403이고 R2 업로드 preflight가 출처를 돌려주지 않았다
  (`tossOriginsRejected`, `corsTossOriginsRejected`). signaling은 세 출처 모두 WebSocket 403, App 공개 경계는 세
  출처 모두 `get-turn-config`에서 거부했다(`originBoundary.tossOriginsRejected`). 나머지 smoke(PRO room, PRO
  media CORS, Developer API canary, App generation, PRO 공개 경계, Standard HTTPS signaling)도 모두 성공했다.
- App generation smoke는 `main-CiWZ0MKN.js` 423,030 B·33 assets로 9.0.4와 같은 번들에 수렴했고, 배포 뒤 공개
  `/`(145,201 B, `bootstrap.js?cache=v772`), `/service-worker.js`(39,517 B, `v772`),
  `/bootstrap.js?cache=v772`(10,196 B)는 9.0.4 배포 때와 크기까지 같다. 업데이트 창은 뜨지 않는다.
- 배포 뒤 [Drift Audit 40014180851](https://github.com/hiefny/MUSIXQUARE/actions/runs/40014180851): 31 pass /
  0 fail / 5 manual-only. remote-share R2 CORS가 새 파일과 일치한다.
- 실제 토스 WebView에서의 확인은 하지 않았다(운영하지 않는 앱이다). Cloudflare 대시보드의 Turnstile 위젯 호스트
  목록 정리는 여전히 선택이다.
