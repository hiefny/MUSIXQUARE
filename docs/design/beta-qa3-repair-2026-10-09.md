# 3차 QA 후속 수정·예방 보강 — 2026-10-09

| Field | Value |
| --- | --- |
| Status | App 8.7.7 / v642 정식 배포 완료. PR #273·exact-main CI 37882728076·Release 37883236502 성공. R26 추가 제공 원본 51pass 확인·범위별 채택, 전체 검증 공백 해소 판정은 보류. provider·실기 한계 유지 |
| Applies to | QA3 확정 9건과 사용자 승인 예방 보강 3건 |
| Last source review | 2026-10-09 |
| Executable sources | `src/player`, `src/youtube`, `src/pro-room`, `src/ui`, `src/i18n`, `browser/service-worker.ts`, `cloudflare/account-auth.ts`와 유지 회귀 검사 |
| Related documents | [발견 당시 감사](beta-30-round-qa3-2026-10-09.md), [현재 배포 기록](../beta-release-readiness.md), [정식 릴리스 절차](../hotfix-procedure.md) |

## 범위와 판정

수정 전 기준은 main `bf4912b203d07c7e48ba34d0dbf38da528257c98`, 당시 운영 참고는
`ff7766ccc0c83ab1eee15bc030347e9067764ee6` / App `8.7.6` / `v640`이다.
사용자는 확정 9건과 미확정 3건의 권고 방향을 승인하고, 수정 전 재검증·문서·주석·배포까지 요청했다.
임시 브랜치 `agent/qa3-remediation`에서 기존 QA 문서를 보존하며 수정했고,
PR #273 병합 main `18246271903a3a856fa6c9d566c4e584c9a86aac`의 정확한 CI 후보로
App `8.7.7`, PWA cache epoch `v642`를 배포했다. 제품 임시 브랜치는 로컬·원격 모두 정리했다.

미확정 3건은 자연스러운 실제 provider/브라우저 발생 조건을 입증한 것으로 승격하지 않는다.
명시적인 동작 기준을 정하고 **예방 보강**으로 처리한다. 합성 조건의 재실행 통과는
실제 YouTube 이벤트 순서나 네이티브 탭 지연의 빈도·도달성을 증명하지 않는다.

| ID | 재검증과 수정 기준 |
| --- | --- |
| A3-R13-C01 | 자연 종료 후 idle 대기 중에도 명시 STOP은 다음 곡·반복 예약을 취소한다. 등록된 MediaSession 콜백과 실제 playlist 타이머를 연결한 수정 전 검사에서 2실패/3대조 통과를 다시 확인했다. |
| A3-R16-C01 | 1,000곡 상한에서 YouTube 입력을 소비하지 않고 기존 queue-full 안내를 표시한다. |
| A3-R18-C01 | 로컬 경과 시간·대기는 단조 시계로 측정하고, 호스트와 공유하는 시각은 기존 동기화 시계 계약을 유지한다. |
| A3-R20-C01 | Standard 채팅·귓속말의 즉시 전송 거절은 초안을 유지하고 성공 말풍선을 만들지 않는다. 배달 확인 프로토콜을 새로 보장하는 변경은 아니다. |
| A3-R21-C01 | 짧은 화면에서도 PIN 모달 전체를 스크롤해 등록·취소 조작에 도달할 수 있어야 한다. 물리 모바일 키보드 검증과 구분한다. |
| A3-R22-C01 | 번역 템플릿을 한 번만 보간하며, 삽입 값 안의 placeholder 모양 문자열은 그대로 보존한다. |
| A3-R22-C02 | 열린 닉네임창의 번역 소유 문구는 언어 변경에 맞춰 갱신하며 사용자 입력은 보존한다. 호출자가 제공한 일반 literal 문구는 자동 번역하지 않는다. |
| A3-R23-C01 | 캐시된 stable asset의 백그라운드 재검증을 응답 헤더·본문 포함 5초로 제한한다. 캐시 응답은 즉시 제공하고 timeout 뒤 늦은 응답으로 캐시를 덮지 않는다. 수정 전 실제 Chromium에서 12초 지연→해제 후 갱신을 다시 관측했다. |
| A3-R26-C01 | 저장하기 전 정규화한 경로를 다시 해석해도 origin이 같아야 한다. callback도 저장된 이전 flow의 경로를 재검증한다. 수정 전 확인은 기존 실행 원본과 현재 소스 대조로 한정했다. |
| A3-R04-C01 — 예방 | 탭 인계 알림은 현재 접속을 서버에 재확인하는 신호다. 서버의 현재 접속 판정에 따라 처리하며 이전 비동기 결과가 새 입장·이동을 종료하지 않도록 한다. |
| A3-R17-C01 — 예방 | 새 플레이어는 제한 시간 내 준비 또는 실패로 끝나야 한다. 생성 예외·준비 누락·늦은 callback을 정리하되 이미 준비된 iframe 재사용에는 새 onReady를 요구하지 않는다. |
| A3-R17-C02 — 예방 | 이전 영상의 상태·metadata를 새 재생목록 항목의 상태로 전송하지 않는다. 같은 영상의 별도 occurrence, 반복과 playlist/Mix 이동을 대조한다. |

## 검증 근거와 한계

환경: Windows, 고정 Node `24.20.0`, 저장소의 Vitest/Playwright.
원본 실행·최초 실패·최종 결과는 로컬
`scratch/qa3-repair-2026-10-09/{root,youtube,ui,handoff}/`에 보존한다.
scratch는 Git에 포함되지 않으며 아래 결과를 정식 main CI 후보로 대체하지 않는다.
제품 코드 최종 로컬 빌드 SHA는 `20eb6d07b6d7c0e38f7cd28f39d80092a9b7322a`다.
아래 로컬 근거와 별도로, 정확한 main SHA의 CI·정식 배포 결과는 이 문서의
[배포 완료 기록](#877-정식-배포-완료--2026-10-09)과 living record에 기록한다.

| 검증 | 결과·해석 |
| --- | --- |
| 수정 전 필요성 | 확정8건과 예방3건은 기존 조건·정상 대조를 다시 실행. OAuth1건은 기존 원본+현재 소스 재검토로 한정. 원래 실패·관측형 pass를 보존했다. |
| 전체 단위 후 최종 영향 파일 치환 | 530파일 **10,990 pass / 기존1 skip / 최종fail0**. `unit-adjudicated.json`에 파일별 채택 원본 기록. 최초 전체 실행10,988pass/2fail/1skip는 bootstrap cache URL 누락과 실행 도중 보완된 YouTube proof 순서였고, 최종 관련 파일 재실행으로 모두 해소. 단일 최종 SHA 전체 실행이라고 표현하지 않는다. |
| YouTube 최종 전체 | 41파일1,065pass/fail·skip0. 늦은 pause, 동일 영상 occurrence, PL/RD 이동·실제 UI auto-subindex, 새 ready 누락·throw, 준비된 iframe 재사용, authority가 소비한 CUED의15초 초과 대조 포함. |
| PRO 인계 | 유지 고유184pass, 새 회귀12 포함. 강제 stale 알림 기존 실패→통과; 정상 superseded·expired·통신 실패·기존 heartbeat 중 알림·늦은 정리/이동 대조. |
| UI | 유지10파일391pass·실제 목록 보간3pass, 해당 담당자 Chromium4pass. 부모 최종 산출물 검증은 아래 별도. |
| 부모 통합 Chromium | native 파일 종료/STOP5pass; 채팅·모달·YouTube·파일/백그라운드17pass; 최종 YouTube/critical13pass(앞선 파일과 중복, 합산하지 않음). |
| production 산출물 | candidate Chromium17pass, 실제 SW 갱신2pass, WebKit SW fallback1pass. UI는 아래 fixture 진단 뒤 Chromium3+WebKit3=6pass/fail·skip·retry0로 확인했다. dist782파일을 사용했으며 정식 CI candidate와 구분한다. |
| 정적·번들 | 최종 전체 typecheck·lint·format 통과, 별도 source/policy guard12종 통과. committed `20eb6d07` build:checked·Worker6종 dry-run 통과. |
| 독립 검토 | OAuth 성공 callback의 저장 경로 재검증 누락, no-store 응답의 본문 지연 시 cache 회수 유지, authority가 소비한 CUED의 proof 해제 순서를 보완하고 재검토. 기존 QA 발견 수를 이 구현 중간 수정 수와 합산하지 않는다. |

첫 SW 테스트2건은 추가 AbortSignal을 반영하지 않은 호출 인자 기대값이었다. 결과·cache 정책
assertion은 유지했다. lint의 async fixture/미처리 promise2곳과 bootstrap cache URL 누락,
후속 runtime commit을 덮지 못한 cache history guard 실패도 로그에 보존했다. 최종 covering
epoch `v642`와 동기화된 초기 스크립트 주소로 build:checked가 통과했다.

추가 WebKit PIN2건의 첫 실패는 레이아웃 결함이나 claim 유실이 아니었다. Service Worker를
허용한 UI fixture에서 bootstrap 요청이 Playwright context route를 거치지 않아 로컬 preview의
503을 받았다. 같은 v640 baseline도 동일하게 실패했다. SW를 차단한 대조에서는 실제 account와
bootstrap 요청이 각각200으로 fixture에 도달하고 정상 account 선택→PIN→320×280 스크롤 조작이
통과했다. 해당 UI 검사는 네트워크 fixture를 고립하도록 `serviceWorkers: 'block'`을 명시한다.
실제 SW 활성화·갱신·오프라인 동작은 SW를 허용한 위 별도 Chromium/WebKit 검사로 유지한다.
이 진단은 과거 단발 dev claim-missing의 원인을 소급 설명하지 않는다.

핵심 재실행 명령(고정 Node24.20.0을 PATH에 사용):

```sh
npm run typecheck
npm run lint
npm run format:check
node node_modules/vitest/vitest.mjs run --maxWorkers 4
node node_modules/vitest/vitest.mjs run src/youtube --maxWorkers 2
npm run build:checked
npm run check:worker-bundles
npm run test:e2e:candidate
node node_modules/@playwright/test/cli.js test --config playwright.webkit-service-worker.config.ts
```

새 fixture 회귀는 `e2e/dialog-locale-layout.test.ts`·`e2e/chat.test.ts`와 유지 단위 검사에
포함했다. 원본 명령·환경 변수·단계별 JSON은 각 scratch 담당자 `repair-notes.md`와 부모 로그에 있다.

수정·배포 당시 R26에서 이전 자동 안전 검토가 중단한 심화 실행은 반복하거나 다른 세션으로
넘기지 않았다. 당시에는 기존 원본과 방어적 코드 검토를 이용하고, 수정 후 정상 OAuth 복귀와
기존 유지 회귀를 검증했다. 독립 심화 재현·실제 외부 이동·live OAuth까지 완료한 근거는 아니었다.
이후 사용자가 제공한 원본의 채택 범위와 남은 한계는 아래
[R26 제공 원본 재검토](#r26-사용자-제공-재검증-원본-검토--2026-10-09)를 따른다.

PWA 수정은 **수정된 worker가 활성화된 이후의 재검증**에 적용된다. 이미 실행 중인
v640 worker의 끝나지 않은 요청을 새 배포가 소급 취소하지 못한다. 최초 갱신이 기존 요청에
묶인 경우 요청 종료 또는 열린 앱 탭 종료 후 재진입이 필요할 수 있다. 이전 단발 legacy
갱신 정지의 원인이 이번 결함과 같았다고 결론내리지 않는다.

실기 iOS/Safari, 하드웨어 media key, 물리 키보드, 실음향, 실제 provider 사건 순서는
로컬 합성·headless 통과와 별개다. 과거 개발 claim-missing·운영 R2 관측 한계도 유지한다.

## 8.7.7 정식 배포 완료 — 2026-10-09

[PR #273](https://github.com/hiefny/MUSIXQUARE/pull/273)을 검토·병합한 뒤,
정확한 main SHA의 성공한 CI 후보로 2026-10-09 13:20 KST에 App을 배포했다.
이 절의 CI 전체 실행은 위 로컬 영향 파일 치환 집계와 별도 근거이며, 두 수치를 합산하지 않는다.

| 항목 | 실제 완료 근거 |
| --- | --- |
| PR 검토·CI | [PR CI 37882215473](https://github.com/hiefny/MUSIXQUARE/actions/runs/37882215473) 성공. 최신 PR head `6f4ea2f`의 자동 리뷰 완료, inline comments 0. 구현 중 독립 검토·보완 근거는 위에 보존 |
| 배포 main SHA | `18246271903a3a856fa6c9d566c4e584c9a86aac` |
| 정확한 main CI | [37882728076](https://github.com/hiefny/MUSIXQUARE/actions/runs/37882728076) attempt 1 성공. unit 530파일 **10,990 pass / 기존 1 skip / fail 0**, broad·critical·tooling·Worker 4종 coverage gate 통과. broad statements 86.58% / branches 80.33% / functions 91.2% / lines 90.23%. Candidate Chromium 17 + critical 22 pass |
| Immutable candidate | `production-candidate-18246271903a3a856fa6c9d566c4e584c9a86aac-37882728076-1`. 로컬에서도 782파일의 manifest hash 전체 일치 확인 |
| 정식 Release | [37883236502](https://github.com/hiefny/MUSIXQUARE/actions/runs/37883236502) attempt 1 성공. `target=app`, `apply_developer_api_d1=false`, App `8.7.7` / cache `v642` |
| App 배포 신원 | version `aee53298-c1e2-4d9b-ac37-26a6df9b9f20`, deployment `3db777f9-aa73-4c2c-abc9-da23000cdb52`, message `git:18246271903a3a856fa6c9d566c4e584c9a86aac`. 최종 소유권 검증의 expected/current 값 일치, `app-final-current.json`의 해당 version 100% 확인 |
| 유지 Worker 호환성 | PRO·remote-share·signaling·Developer API facade/backend 5종은 `ff7766ccc0c83ab1eee15bc030347e9067764ee6` 유지. 부분 배포 사전 호환성 확인·변경 직전 재확인 통과. 6종을 새 SHA로 배포한 것으로 해석하지 않음 |
| 운영 확인 | App generation, anonymous App account boundary, 현재 PRO public boundary, Standard HTTPS signaling fallback의 선택된 live smoke 4단계 모두 성공. 최종 App 소유권 확인 후 coherent-production commit marker 보존 |
| 복구·정리 | mutation 전 immutable recovery checkpoint 저장. 실패 복구 단계와 recovery job은 skipped, rollback 불필요. 제품 브랜치 `agent/qa3-remediation` 로컬·원격 삭제 및 main 복귀 완료. 배포 결과 문서는 후속 문서 전용 PR로 게시하며 제품 재배포 대상이 아님 |

CI·Release 원본은 ignored `scratch/qa3-repair-2026-10-09/root/`의
`main-ci.json`·`main-ci.log`·`release.json`·`release.log`에 보존한다.
`scratch/qa3-repair-2026-10-09/production-release/`에는 deployment·recovery checkpoint·
`partial-release-compatibility-recheck.json`·`final-verification-report.json`과
`production-committed.json`을 포함한 Release artifact를 보존한다.

이번 운영 확인은 선택된 공개 경계·배포 신원의 검증이다. live OAuth·실제 provider 사건 순서,
물리 기기·키보드·media key·음향이나 기존 운영 탭/PWA 전체 갱신을 완료했다는 뜻은 아니다.
배포 당시의 R26 심화 차단은 역사적 경위로 보존하며, 후속 제공 원본의 현재 판정은 아래 절을
따른다. 예방 3건의 실제 도달성 미입증, 과거 dev claim-missing·legacy SW 단발 정지·운영 R2
원인 미확정과 위 PWA 최초 갱신 한계는 유지한다.
이후 문서 커밋은 배포 코드 SHA와 구분하며 새로운 제품 릴리스를 요구하지 않는다.

## R26 사용자 제공 재검증 원본 검토 — 2026-10-09

사용자는 배포 후 별도 환경에서 수행한 A3-R26-C01 재검증 결과와 원본을 제공했다.
이번 검토에서는 제출된 코드·JSON·로그와 제품 소스를 읽었으며, 제공 스크립트를 실행하거나
import하지 않았다. **추가 검사 재실행 0건, 새 확정 제품 결함 0건, 제품·운영 변경 0건**이다.
제공된 **51pass / 0fail**은 원본에 기록된 결과로 확인하고 아래 범위에서 채택한다.
이는 검토자가 51건을 독립 재실행했다거나 모든 미완료 영역을 해소했다는 판정이 아니다.

원본은 ignored `scratch/qa3-r26-reverification-2026-10-09/`의
`r26-deep-reproduction.test.ts`, `r26-oauth-lifecycle.test.ts`,
`r26-browser-navigation.ts`, `vitest.r26.config.ts`, `vitest-run.json`,
`vitest-run.log`, `browser-navigation-run.json`, `browser-navigation.log`,
`summary.json`, `report.md`에 보존한다. 이번 판정은 원본의 문구·코드·결과를 수정하지 않고
이 문서에 덧붙인다. Vitest JSON·로그는 2파일 43pass이며 브라우저 8건은 별도 결과다.
검토 시점 원본 10파일의 SHA-256·집계·Git 상태는 별도 ignored
`scratch/qa3-r26-evidence-review-2026-10-09/review.json`에 기록했다.

| 제공 근거 | 채택 범위와 한계 |
| --- | --- |
| 독립 심화 재현 39pass | 수정 전 결함 메커니즘의 축약 복제 알고리즘 대조 1건과, 실제 제품 App Worker를 호출하는 통합 38건이다. 수정 전 제품 전체를 실행한 39건으로 해석하지 않는다. 취소·오류 복귀, 정상 경로 보존, 입력 경계 및 기발급 flow 쿠키의 취소 분기를 뒷받침한다. |
| 성공 OAuth 통합 4pass | 실제 제품 start·callback·토큰 처리·RS256 검증·계정 생성 경로를 사용하고, token/JWKS 응답은 로컬 합성 제공자로 대체한다. 선택한 4개 returnTo의 성공 복귀 주소, 세션 쿠키 헤더 존재, flow 쿠키 삭제 및 SQLite 계정 1개 생성을 확인했다. |
| Chromium 브라우저 8pass | 실제 App Worker를 연결한 로컬 HTTP 서버에서 시작 요청과 callback 리디렉션을 브라우저가 따라가고, 기록된 최종 URL 8개가 기대값과 일치한다. Google 인증 화면은 서버에서 취소 callback으로 대체하므로 실제 제공자 또는 브라우저의 성공 로그인 전체 흐름 검증은 아니다. |

**전체 검증 공백 해소 판정은 보류한다.** 이는 새 제품 결함 판정이 아니라, 아래 관측·주장
범위의 제한이다. 제출 보고서의 “외부 요청 시도 0건 완전 차단”과 “전체 파이프라인 100% 검증”은
그대로 채택하지 않는다.

- **브라우저 네트워크 관측:** `r26-browser-navigation.ts:158`부터의 `externalRequests`는
  `context.route` 콜백에서만 수집하고 별도의 request/response 관측을 사용하지 않는다.
  Playwright는 리디렉션에서 route handler를 첫 URL에만 호출한다고 명시한다.
  따라서 배열이 비었다는 결과가 리디렉션 각 단계의 외부 요청 시도 0건을 입증하지는 않는다.
  URL 판정도 `startsWith(serverOrigin)`여서 파싱한 origin의 정확한 동등성 판정과 다르다.
  최종 URL 8건 일치는 유효한 별도 관측으로 채택한다.
  [Playwright의 리디렉션 처리 설명](https://playwright.dev/docs/network#redirects).
- **브라우저 쿠키 경계:** 로컬 HTTP adapter는 `__Host-mxqr_` 쿠키 이름을 바꾸고 `Secure`
  속성을 제거한다(`r26-browser-navigation.ts:83`, `:100`). 이 결과는 운영 HTTPS의
  `__Host-`·Secure 쿠키 정책까지 브라우저에서 검증한 근거가 아니다.
- **기발급 flow의 성공 분기:** 심화 Group G는 비정상 returnTo를 담은 기존 쿠키를 모사해
  취소 callback 한 건을 검증했다(`r26-deep-reproduction.test.ts:274`). 성공 통합 4건은
  모두 수정된 start에서 새 쿠키를 발급받는다. 성공 callback에 이전 쿠키 경로를 재검사하는
  제품 코드는 확인했지만, 그 방어를 별도로 통과시킨 실행 근거는 이번 제공본에 없다.
- **PKCE·세션 주장:** 성공 통합은 `S256` 표기와 challenge/verifier 존재를 확인한다
  (`r26-oauth-lifecycle.test.ts:112`, `:125`). 둘의 digest 대응 관계를 직접 비교하지 않는다.
  발급 쿠키의 후속 인증 사용이나 세션 DB 행의 직접 assertion도 없으므로, “합성 제공자를
  사용한 성공 OAuth 통합 4건 통과”로 기록한다. 실제 Google 서버 통신은 미실행이며,
  로컬 서명·검증 성공을 상용 제공자 전체 검증으로 확대하지 않는다.

실행 환경은 제공본 기준 Windows / Node `24.13.1` / Playwright `1.63.0`
(Chromium headless) / Vitest `5.0.0` / `node:sqlite` in-memory다.
Node `24.13.1`은 저장소 `package.json`과 `.node-version`에 고정한 `24.20.0`과 다르다.
제출된 “엔진 24.20.0 호환”이라는 설명을 저장소 고정 환경의 검사 통과로 대체하지 않는다.

검토 기준 HEAD는 `b85148dabfba96b2dafcdb43dd6f69f97734f342`다.
배포 SHA `18246271903a3a856fa6c9d566c4e584c9a86aac`와 Git 차이는 문서 2파일뿐이어서
두 커밋의 현재 제품 소스가 같음을 확인했다. 문서 갱신 전 checkout은 clean이며 실제 추적
파일은 **1,977개 / 비Markdown 1,830개**로, 제출 보고서의 **1,967개 / 1,822개**와 다르다.
실행 전후 전체 파일 hash manifest가 제공되지 않았으므로 현재 clean 상태와 두 커밋의 비교를
과거 실행 전후 모든 파일의 불변 증명으로 소급하지 않는다.

현재 판정은 **R26의 추가 로컬 회귀 근거 확보·범위별 채택, 전체 공백 해소 보류**다.
이번 검토로 새로 확인된 제품 수정·재배포 필요성은 없다. 제품 버전과 운영 배포 SHA는 그대로
유지하며, 이 문서 보강만을 이유로 Release를 재실행하지 않는다. 실기 iOS/Safari·하드웨어·
실음향 및 예방 3건의 실제 provider 발생 조건은 이 추가 제공본의 범위 밖이다.

## 배포·복구 계약

변경은 App 브라우저 입력과 App Worker의 계정 복귀 처리다. D1 schema, secrets,
service bindings, wire protocol, 의존성 변경은 없다. 정상 절차상 배포 대상은 `app`,
`apply_developer_api_d1=false`다. App의 통상 idempotent D1 baseline 처리는 유지한다.

이번 Production Release는 PR 검토 후 병합한 정확한 main SHA의 성공 CI candidate를 사용했다.
브랜치 검사나 기존 v640 후보를 배포 증거로 대체하지 않았다. 이후 실패 시에도 워크플로의
소유권·호환성 검증과 복구 checkpoint를 따르며, 구버전 앱을 재배포할 때도 새로운
단조 cache epoch가 필요하다.
