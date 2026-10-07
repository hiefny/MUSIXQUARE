# 베타 개발 의존성 보안 수정 — 2026-10-06

| Field | Value |
| --- | --- |
| Status | Dated evidence — `mxqr_beta`의 개발 의존성 보안 패치와 로컬 검증 |
| Base checkout | `8beaf9027b4f6dbe2962a4022f2f54ce0677737e` 위의 package/lock 수정 작업 트리 |
| Verified dependency commit | `b0d55351aa58f4a274076d6f31ae69630d260021` — 동일 작업 트리를 검증한 뒤 커밋, 이후 변경은 SHA 기록 문서만 |
| Product source | `45c7ef7a4e0fef5b788efe11cb72d54c9b221929` 이후 제품 runtime 변경 없음 |
| Main | `35759e8b07f1ee0b272afbd0af03c770a858889e`, 변경·병합·배포 없음 |
| Environment | Windows, pinned Node 24.20.0/npm 12.0.2, Vitest 5, Playwright 1.63 Chromium, local PeerJS/Miniflare, jq 1.8.2 |
| Executable sources | [package/overrides](../../package.json), [lock](../../package-lock.json), [CI audit/signatures](../../.github/workflows/ci.yml), [Worker dry-run](../../scripts/check-worker-bundles.mts) |
| Related documents | [현재 베타 승격 기록](../beta-release-readiness.md), [수정 전 main/beta 비교](main-beta-comparison-2026-10-06.md) |

사용자의 대회 동결 지시에 따라 **베타에만 수정**했다. 수정 전 main/beta의 공통
개발 의존성 감사 13패키지(critical 1/high 7/moderate 5)는 이번 베타의 재감사에서
**0건**으로 줄었다. main은 당시 커밋을 유지하며, 이전 비교 보고서는 수정 전
13건의 증거로 보존한다. npm 감사 통과가 제품 전체의 보안 무결함을 뜻하지 않는다.

## 수정 범위와 호환성

| 하위 의존성 | 수정 전 | 수정 후 / 적용 경계 |
| --- | --- | --- |
| brace-expansion | 전역 5.0.9 | 현대 minimatch용 5.0.12, `minimatch@3`에는 함수 API를 유지하는 1.1.21 |
| undici | 전역 7.29.0 강제 | Miniflare에만 7.29.1 패치 override, jsdom은 원래 `^8.9.0` 요구에 따라 8.11.2 |
| compression | 1.8.1 | 1.8.2 |
| fast-uri | 3.1.7 | 3.1.8 |
| postcss-selector-parser | 7.1.5 | 7.1.6 |
| proxy-addr | 2.0.7 | 2.0.8 |
| source-map-js | 1.2.1 | 1.2.2 |

직접 `dependencies`/`devDependencies` 버전 선언과 운영 의존성 lock 노드 46개는
깊은 비교와 원문 바이트 비교에서 동일하다.
Wrangler 4.130.0, Miniflare 5.20260908.0-alpha, workerd 1.20260908.1도 유지한다.
변경·추가 lock 노드 11개는 모두 `dev: true`다. 구형 brace API를 위해 추가된
balanced-match 1.0.2와 concat-map 0.0.1도 개발 의존성이다.
`npm audit fix --force`나 Wrangler의 추가 업그레이드는 사용하지 않았다.

독립 검토에서는 기존 전역 brace 5 강제가 minimatch 3의 함수 호출 계약을
깨뜨리는 문제도 확인했다. `*.{js,css}` 패턴은 `expand is not a function`으로
실패하지만 일반 `**` 패턴은 통과하므로 감사 수치만으로는 드러나지 않는다.
구형 부모에만 보안 패치된 1.x를 적용해 중괄호·범위 매칭과 실제 serve 헤더
설정의 적용/제외를 확인했다. 앱 runtime의 새 결함으로 집계하지 않는다.

수정 버전 근거는 [brace 1.1.21/5.0.12 advisory](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr),
[Undici 7.29.1 릴리스](https://github.com/nodejs/undici/releases/tag/v7.29.1),
[proxy-addr 2.0.8 advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h),
[compression 1.8.2 advisory](https://github.com/advisories/GHSA-vc2v-76pw-4v95),
[selector-parser 7.1.6 advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf),
[source-map-js 1.2.2 advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)와
현재 npm registry/감사 응답이다. 부모별 override는 [npm 문서](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#overrides)의 지원 형태다.

## 설치·보안 검증

최종 lock으로 `npm ci --no-audit --no-fund`를 실행해 486패키지를 설치했다.
전체 감사, 운영 의존성 감사와 `npm run security:audit`는 모두 exit 0이며
info/low/moderate/high/critical 모두 0이다. `npm ls --all --json`도 exit 0이다.
`npm run security:signatures`는 486패키지 registry signature와 103패키지
attestation을 검증하고 exit 0으로 끝났다.

설치된 실제 의존성으로 다음 loopback 검사 **20개가 모두 통과**했다.

| 범위 | 통과 | 경계 |
| --- | --- | --- |
| Peer Express/proxy-addr | 7 | IPv4·IPv6·mapped IP와 X-Forwarded-For 신뢰 처리. PeerJS의 Express 인스턴스 사용 |
| minimatch/brace API | 2 | minimatch 3의 함수 API와 minimatch 10의 named API |
| serve CLI HTTP 응답 | 7 | 일반/gzip/HEAD/SPA, 중괄호 패턴 헤더 적용·제외 |
| undici/Miniflare | 4 | 로컬 fetch, POST dispatch, Worker 로컬 upstream fetch, HTTP ingress |

최종 실행과 serve 자식 프로세스 모두 pinned Node 24.20.0을 사용했다.
최초 Node 24.13.1 실행 20 pass는 별도 보존하고 최종 수치에 합산하지 않는다.
별도 격리 tarball API 검사 8 pass도 위 20개와 중복 합산하지 않는다.
loopback 검사 뒤 모든 자체 서버와 Miniflare를 정리했다. PeerJS 실제 신호 교환은
아래 브라우저 회귀로 검증하며, 이 Express 검사만으로 대신하지 않는다.

## 회귀 검증

전체 unit **510파일·10,637 pass / fail·skip·todo 0**를 최종 의존성에서 한 번의
전체 실행으로 확인했다. timeout 재실행이나 검사 선택·기준 변경은 없다.
전체 `npm run typecheck`, `npm run lint`, `npm run format:check`도 exit 0이다.
typecheck에는 여섯 Worker의 generated types check와 그 명령에 정의된 타입·소스 guard가
포함된다. 제품·추적 테스트·검사 설정을 바꾸지 않았다.

| 후속 검사 | 결과 |
| --- | --- |
| E2E 빌드와 선택 Chromium | build exit 0, 3파일·17 pass |
| 최종 production 빌드 | `npm run build` exit 0, E2E 산출물에서 production으로 복원 |
| Production artifact guard | legacy TV, SW, UI kit, initial transfer, prod hooks/security, font, app shell 8개 모두 exit 0 |
| Wrangler Worker dry-run | 기존 여섯 production config 모두 exit 0, 실제 배포 없음 |
| Production artifact Chromium | 공식 candidate config 2파일·9 pass |

선택 Chromium은 `critical-browser.test.ts`, `release-smoke.test.ts`,
`late-join-bootstrap-catchup.test.ts`를 사용했다. 파일 선택과 부모별 API 검사로
실제 로컬 PeerJS 교환·PRO/UI 경계·지연 파일 전달·언어 전환 회귀를 확인했다.
PRO HTTP 응답은 기존 E2E fixture에서 모사하며 실운영 PRO 서버 검증은 아니다.
production은 `playwright.candidate.config.ts`로 같은 production 산출물의
Service Worker fallback·mutable test hook 부재·UI/연결을 검사했다.
양쪽 실행의 fail·skip·flaky·runner error와 retry는 모두 0, worker 1이다.
두 profile의 중복 release smoke case를 고유 테스트 수로 합산하지 않는다.
전용 포트 4520/9320은 각 실행 뒤 자체 프로세스를 종료했고 마지막 listener 0이다.

이번에는 coverage 4종, 전체 Chromium, WebKit, 실제 기기·실운영·원격 CI를
다시 실행하지 않았다. 기존 cache-history 실패와 공개 version/cache 증분,
최종 exact-main-SHA CI 후보·실기/live 확인은 별도로 남아 있다.
`build:checked`나 최종 main CI가 성공했다고 기록하지 않는다.

## 재현 자료

원본 로그와 JSON은 Git ignored 경로에 보존했다.

- `scratch/beta-security-repair-2026-10-06/`: 최종 설치, 보안 감사, 서명,
  의존성 트리, 타입/lint/서식, unit, 빌드·브라우저·산출물·Worker 검사.
- `scratch/dev-security-2026-10-06/installed-loopback-probe.mjs`와
  `installed-loopback-result.json`: 실제 설치 의존성의 loopback 20개.
- `scratch/security-brace-review-2026-10-06/`: 보완 lock·audit 및 격리 API 8개.
- `scratch/audio-review-20261006/security-dependency-independent-audit.json`와
  `security-installed-resolution-audit.json`: dev 변경 11노드와 운영 lock 동일성,
  실제 설치의 부모별 하위 의존성 해석을 독립 확인.
- `scratch/main-beta-review-2026-10-06/audit-beta.json`: 수정 전 13패키지 감사.

검증한 최종 의존성 파일의 SHA256:

| 파일 | SHA256 |
| --- | --- |
| package.json | `6a9ef1ddc6f0dbadd4ae480b84ed5f7bc80206843406a9337987b3e1a988239a` |
| package-lock.json | `716df9c3cd7c1645d25ac27284291d24ea899704fe9343226b5a87699bd4caec` |

## 배포·복구 경계

제품·테스트 소스, schema/SQL/DO migration, secret/binding, 계약 marker와 workflow는
바꾸지 않았다. 공개 버전/cache는 8.6.61/v630이며, 기존 누적 `target=all` /
`apply_developer_api_d1=false` 판정은 유지한다. 이번 보안 수정만으로 별도 데이터
복구나 운영 배포를 수행할 필요는 없다.

의존성을 되돌릴 때에는 package.json과 lock을 함께 되돌리고 pinned `npm ci` 후
다시 검증한다. 이전 파일로 돌아가면 기존 감사 13건과 구형 brace API 문제가
다시 생길 수 있으므로, 문제가 확인되면 해당 부모의 호환성을 보존하는 선별
수정을 우선한다. 실제 main 승격·공개 배포는 동결 종료 후의 별도 절차다.
