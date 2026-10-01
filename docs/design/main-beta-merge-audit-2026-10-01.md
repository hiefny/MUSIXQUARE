# main → beta 병합 준비 감사 — 2026-10-01

| Field | Value |
| --- | --- |
| Status | Dated evidence — 제품 수정 없는 병합 준비 감사 |
| Base main | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Audited beta | `c263acce89a67d7f478e9b20a34d53fbb839a70e` |
| Environment | Windows, Node 24.20.0, npm 12.0.2, 로컬 Chromium / Windows WebKit |
| Scope | `main...mxqr_beta`: 73 commits, 364 files, +47,155 / −2,540 lines |
| Executable sources | [CI](../../.github/workflows/ci.yml), [release](../../.github/workflows/release.yml), [package](../../package.json), 변경된 런타임과 회귀 검사 |
| Related documents | [현재 승격 기록](../beta-release-readiness.md), [정식 절차](../hotfix-procedure.md), [이전 전체 QA](beta-full-qa-repair-2026-09-27.md) |

## 판정

**코드 검토에서 새로 확정한 런타임 결함은 0건이다. 기능 변경은 조건부로 병합을
진행할 근거가 충분하지만, 현재 HEAD를 그대로 공개 승격할 준비가 끝난 것은 아니다.**

현재 실제 CI 차단 항목은 의존성 보안 검사다. 공개 버전·PWA 캐시 증분도 동결에
따라 의도적으로 남겨 두었다. 대회 종료 후 보안 경고 정리, 버전/cache 증분,
최종 PR 및 main SHA의 CI, 대표 실기 확인과 정식 release 절차를 완료해야 한다.
이번 감사는 대회 종료·main 병합·워크플로 재활성화·프로덕션 배포를 승인하지 않는다.

결함 0건은 이 diff와 검증 범위에서 새 결함을 확인하지 못했다는 뜻이다.
모든 파일·코덱·기기·OS·네트워크 조합에서 문제가 없다는 보장이 아니다.

## 검토 범위와 방법

main이 beta의 조상이며 merge-base도 위 main SHA다. 로컬과 원격 두 branch SHA를
확인했고 검토 시작 시 작업 트리는 깨끗했다. 제품 소스·의존성·테스트를 바꾸지
않고 현재 코드에서 실행했다. 결과 기록만 저장한다.

변경 파일을 94개 런타임/공개 계약, 42개 번역, 165개 테스트/fixture,
44개 문서/정책, 9개 라이선스 자산, 10개 도구/설정으로 분류했다.
94개 런타임 변경은 도메인별 diff와 호출부·취소/수명/권한 경계를 검토했다.
번역의 키·치환자·사용처, 테스트가 실제 경계를 검증하는지와 coverage gate,
도구·의존성·배포 계약을 대조했다. 과거 문서는 당시 증거로 보존하고 현재
코드의 통과 결과로 재사용하지 않았다. 42개 언어의 원어민 감수를 뜻하지 않는다.

| 영역 | 검토한 주요 경계 | 새 확정 동작 결함 |
| --- | --- | --- |
| 하이브리드 오디오, player 26개 파일 | native/bounded 전환, 메모리 선택, PCM 범위, 빠른 탐색, 디코더 오류·폐기, MP3 gapless, AAC LC/HE/HEv2 timing, 수동 오프셋, 기기별 실패 소유권 | 0 |
| network/storage/share/YouTube 27개 파일 | 입장 bootstrap, 현재 곡 우선권, bulk/control END 순서, watchdog, 늦은 업로드·재접속 완료, zero-start/heartbeat/명시적 명령 우선순위, PRO playlist occurrence | 0 |
| PRO/demo/audio/core 16개 파일 | 권한 회수·재부여, PREPARE/COMMIT, snapshot/checkpoint 복원, system audio 공유·중도 입장, 데모 자원·설정 복원 | 0 |
| 계정·번역 Worker 및 리버브 계약 | 세션별 쿠키와 늦은 응답, 탈퇴 fence, export keyset·상한·적용 baseline, API/PRO/App 10초 상한 일치 | 0 |
| UI·채팅·로고·기타 | source 변경 중 sync/seek draft, 채팅 금지·초안, 검색 스켈레톤·빠른 추가, RTL/마키/visualizer, 정확한 단일 리빌 mask | 0 |

독립 재검토에서는 실제 `YouTubeZeroStartController`에 결정적 scheduler와
iframe/transport 모델을 연결해 441조합을 실행했다. 방장·게스트 각각 7개
오프셋(`−9.999…+9.999`, 소수 경계 포함), 세 플랫폼 조합, 편도 지연 0/43/189ms다.
최종 canonical 잔차·플랫폼 lead·unmute·idle·남은 timer 0을 확인했다.
기존 unit/E2E 숫자와 합산하지 않는다. 실제 스피커의 음향 정렬 검사는 아니다.

로고도 별도 검토했다. authored rect 33개와 convex quadrilateral 3개가 유한한
좌표·일관된 winding·mask bounds를 가지며 마지막 획은 2540ms에 완료된다.
기하 검사는 36획 모두 통과했다. 외곽 안티앨리어싱의 무마스크 실루엣과의
픽셀 동일성은 보장하지 않으며 내부 이음선 검사와 구분한다.

## 남아 있는 승격 항목

### MA01 — 현재 의존성 보안 검사가 실패한다

`npm run security:audit`가 exit 1이다. main과 beta의 package-lock을 같은
`npm audit --package-lock-only --json` 방식으로 검사했을 때 **동일한 9개 패키지
(high 5 / moderate 4)**가 보고됐다. beta가 새로 도입한 취약점으로 분류하지 않는다.
이 숫자는 전이 의존성 영향을 포함한 패키지 수이며 서로 독립적인 CVE 9개라는 뜻이 아니다.

- 대상: `brace-expansion`, `fast-uri`, `jsdom`, `miniflare`, `minimatch`, `serve`,
  `serve-handler`, `undici`, `wrangler`.
- 주요 고정 값: `brace-expansion@5.0.9`, `undici@7.29.0` override.
- `npm audit --omit=dev --package-lock-only --json`: **0건**. 개발·검사 도구 경고를
  현재 서비스에서 확인한 공격 경로로 확대 해석하지 않는다.
- 설치된 비선택 패키지의 버전은 lockfile과 일치하며 누락도 없다. 다른 플랫폼용
  optional 패키지 누락은 설치 drift로 세지 않았다.
- registry signature 482개, attestation 100개 검증은 통과했다. 서명 검증과
  보안 advisory 검사는 별개다.

CI의 `static-types` job에서 같은 audit를 실행하므로 현재 그대로는 all-green
PR을 기대할 수 없다. 영향 패키지/override를 선별 갱신하고 타입·빌드·관련
회귀·audit를 다시 확인해야 한다. `audit fix --force` 권고를 그대로 실행하지 않는다.
이번 요청에서는 의존성을 수정하지 않았다.

### MA02 — 공개 버전과 PWA 캐시가 아직 동결 값이다

main과 beta 모두 `8.6.61 / v630`이다. `guard:sw-cache-version`은 exit 1이며
새 런타임 변경 뒤 캐시 증분을 요구한다. 이는 알려진 승격 gate이며 통과로
계산하지 않는다. 대회 종료 후 최종 기능 범위에 맞춰 버전/cache를 올리고
커밋한 상태에서 `build:checked`와 최종 CI를 실행한다.

### MA03 — 최종 main CI·운영·실기 확인은 아직 남아 있다

이 감사는 Windows 로컬에서 위 beta SHA를 검사했다. 최종 Linux PR CI,
병합된 main push SHA의 CI와 immutable production candidate를 대체하지 않는다.
`Operations Drift Audit`는 API 조회상 `disabled_manually`이며 유지했다.
동결 중 새 PR·main 전진·생산 배포·운영 데이터 쓰기를 수행하지 않았다.

Windows WebKit capability probe에서 `AudioContext`, `OfflineAudioContext`,
`AudioBuffer`, `RTCPeerConnection`, `AudioDecoder`가 모두 `undefined`였다.
WebKit UI 통과를 iPhone Safari/PWA 실제 오디오/RTC 통과로 기록하지 않는다.
대표 실기 확인은 다음 경계에 집중한다.

1. iPhone Safari/PWA와 Windows/Android가 섞인 일반방·PRO에서 작은 파일 → 큰
   MP3/FLAC/AAC → 작은 파일, 빠른 탐색과 다음/이전 곡, 다운로드 실패 후 복귀.
2. YouTube 양·음수 수동 보정 후 다음 곡/1곡 반복/곡 끝 동기화와 실제 첫 음 정렬.
3. 잠금·백그라운드·네트워크 전환·재접속, 신규 입장 중 기존 재생, 데모 종료 시
   앱의 설정·미디어 복원. 실제 Cloudflare/SFU 지연·장애도 로컬 모형과 구분한다.

## 유지되는 호환성·복구 경계

- 큰 Opus/Vorbis, 검증되지 않은 AAC 프로필/컨테이너·복수 edit list는 새 엔진의
  지원 범위 밖이다. main에서 native로 재생 가능한 큰 파일이 beta에서는 거절될
  수도 있다. 메모리 보호를 위해 전체 디코딩으로 자동 우회하지 않는 기존 결정이다.
- 여전히 원본 File/Blob 수신 완료 후 구간 PCM을 디코딩한다. 네트워크 부분
  스트리밍이나 파일 공유 용량 제한 확대가 아니다.
- 기존 `PRELOAD_END` control 수신은 남아 있고 새 송신은 bulk 순서를 따른다.
  사용자 방의 모든 탭이 배포 즉시 같은 클라이언트 버전으로 바뀌지는 않는다.
- 새 쿠키 reader를 배포한 뒤 예전 App Worker로 전체 rollback하면 로그인 영향이
  있다. 현재 자동 compatibility marker가 이를 보호하지 않으므로 reader를
  유지하는 forward fix/선별 revert와 runbook의 구체적 주의사항을 따른다.
- 리버브 상한 10초는 사용자가 실제 API 사용을 확인해 승인한 정책이다.
  새로운 `>10` 저장값 사용 증거가 생기면 effects 초기화 영향을 다시 평가한다.
- 누적 배포 범위는 `target=all`, `apply_developer_api_d1=false` 유지다.
  새 schema/secret/binding/DO migration이나 추가 수동 DB 이전은 없다.
  정식 workflow의 기존 baseline·checkpoint·검증은 계속 필요하다.
- 라이선스 텍스트 10개는 public/dist 사이 바이트 일치를 확인했다.
  상세 저작권·고정 소스 revision이 있는 루트 `THIRD-PARTY-NOTICES.md`는 GitHub에
  있고 dist에는 포함되지 않는다. public 자산으로 생성형 notice를 제공하는 것은
  배포 완성도 개선 후보다. 이번 감사는 법적 위반 판정이나 실행 결함으로 세지 않는다.

## 현재 SHA의 실행 검증

| 검사 | 현재 결과 |
| --- | --- |
| 전체 unit / broad coverage | 497파일, 최초 10,272 pass / 0 fail / 1 skip. jq 설정 후 같은 skip 항목을 포함한 97개 재검사 통과, 고유 10,273개 실행 통과 확인 |
| Broad coverage | statements 86.24% / branches 79.83% / functions 90.88% / lines 89.95%, 원래 gate 통과 |
| Critical coverage | 50파일·1,772 pass / 0 fail / 0 skip; S 81.25% / B 75.61% / F 87.46% / L 85.43%, global/per-file gate 통과 |
| Tooling coverage | 13파일·342 pass / 0 fail / 0 skip; S 78.27% / B 73.87% / F 87.09% / L 80.14%, 원래 gate 통과 |
| Worker coverage | 26파일·1,726 pass / 0 fail / 0 skip; S 84.26% / B 80.79% / F 92.63% / L 88.93%, global/per-file gate 통과 |
| Chromium 전체 | 4개 격리 shard: 144 + 146 + 134 + 134 = **558 pass / 0 fail / 0 skip / 0 flaky**, retry 0 |
| Windows WebKit 모바일 lane | **66 pass / 0 fail / 3 기존 skip / 0 flaky**, retry 0 |
| 독립 controller 조합 / 로고 geometry | 441개 / 36획 통과. 위 test totals와 별도, 실기 출력 검증 아님 |
| 타입·린트·서식·source guards·서명 등 | 23개 중 22개 통과, security:audit만 실패(MA01) |
| Cache-history gate | 별도 실행 실패(MA02), 통과 수에 포함하지 않음 |
| E2E / production build | 모두 통과. build:checked 전체 성공으로 주장하지 않음: cache gate는 별도 실패 |
| Production artifact guards | legacy-TV / service-worker / UI kit / initial transfer / prod-hooks / prod-security / fonts / SW app-shell 8개 통과 |
| Worker bundles | 6개 production config dry-run 통과, 실제 deploy 없음 |
| 동일 production 산출물 smoke | Chromium candidate 9 pass, WebKit Service Worker 1 pass; fail/skip/flaky 0 |

Chromium 전체에는 실제 native Web Audio와 minified WASM을 비교하는 MP3/FLAC/WAV
PCM 검사, AAC 15개 timing·seek·tail 검사와 native↔bounded 혼합 엔진 12개 검사가
포함된다. 서비스 응답이나 iframe을 모사하는 다른 검사는 실제 YouTube 서비스·
Cloudflare 실운영 검증으로 계산하지 않는다.

원래 assertions·timeout·coverage threshold·retry 0을 유지했다. 코드나 테스트를
통과시키기 위해 완화하지 않았다. 중복 coverage profile과 production smoke는
총 테스트 수에 합산하지 않는다.

전체 unit 첫 실행에서 Windows jq 경로 미설정으로 기존 배포 분류 1개가
skip됐다. 검증된 portable jq를 `MXQR_TEST_JQ_PATH`로 지정해 해당 파일 97개와
tooling profile 342개를 재실행하여 그 항목도 통과했다. 따라서 고유 unit
10,273개 모두 실행 통과 근거가 있지만, 최초 전체 로그의 1 skip을 숨기지 않는다.

WebKit의 3 skip은 모바일에서 해당하지 않는 데스크탑 entrance, carousel arrow,
hover 검사다. Windows의 오디오/RTC 부재를 이 3개의 skip과 혼동하지 않는다.
해당 미디어 검사는 공식 모바일 UI lane의 범위 밖이다.

재현 가능한 실행 요약:

```text
node node_modules/vitest/vitest.mjs run --coverage --maxWorkers=2
MXQR_TEST_JQ_PATH=<verified jq> + focused release-deployment-state.test.ts
vitest --coverage --config vitest.{critical,tooling,workers}.config.ts --maxWorkers=1
npm run typecheck / lint / format:check / security:audit / security:signatures
source guards + guard:sw-cache-version
npm run build:e2e
playwright test --project=chromium --shard={1,2,3,4}/4
playwright test --config=playwright.webkit.config.ts
npm run build
production artifact guards + check:worker-bundles
playwright test --config=playwright.candidate.config.ts
playwright test --config=playwright.webkit-service-worker.config.ts
```

증거는 로컬 ignored `scratch/merge-audit-2026-10-01/`의 JSON/log/coverage,
`changed-inventory.json`, main/beta lock audit, `sync/zero-start-matrix.*`,
`wordmark-independent/geometry.mjs`, `webkit-capabilities.json`에 보존한다.
fixture/테스트/실행 설정은 저장소에 있으며 scratch는 배포 자산이 아니다.
이 기록 이후 문서만 커밋한 SHA를 새 제품 코드의 전체 QA로 표현하지 않는다.
