# main과 mxqr beta 비교 분석

| Field | Value |
| --- | --- |
| Status | Dated evidence — 2026-10-06 비교 및 로컬 검증, 제품 수정 없음 |
| Base main | `35759e8b07f1ee0b272afbd0af03c770a858889e` |
| Reviewed beta | `1349825f00a0c767dff5fc886c1b31c190940d09` |
| Product source | `45c7ef7a4e0fef5b788efe11cb72d54c9b221929` 이후 제품 변경 없음. 그 이후 변경은 문서·QA 검사만 |
| Environment | Windows, pinned Node 24.20.0/npm 12.0.2, Vitest 5, Playwright 1.63 Chromium, local PeerJS, jq 1.8.2 |
| Executable sources | [package](../../package.json), [CI](../../.github/workflows/ci.yml), [캐시 검사](../../scripts/check-sw-cache-version.mts), 아래 변경 소스와 회귀 검사 |
| Related documents | [현재 베타 승격 기록](../beta-release-readiness.md), [앞선 전체 비교](main-beta-merge-audit-2026-10-01.md), [10월 4일 최종 QA](beta-final-qa-2026-10-04.md) |

이번 비교에서 **새로 확정한 베타 런타임 결함은 0건**이다. 베타에는 대용량
오디오 엔진과 여러 전송·재생·권한 복구 수정이 포함된다. 다만 양쪽에 공통으로
남은 개발 의존성 보안 경고와 베타의 공개 버전·PWA 캐시 검사 실패 때문에,
현재 베타를 그대로 프로덕션에 승격할 준비가 완료된 상태는 아니다.

## 브랜치와 변경 규모

원격을 fetch한 뒤 로컬·원격 main이 위 main SHA, 로컬·원격 beta가 위 beta SHA와
일치함을 확인했다. main은 beta의 조상이며 merge-base도 위 main SHA다.
main에만 있는 커밋은 0개, beta에만 있는 커밋은 **97개**다.

전체 diff는 **404파일, +59,427 / −2,865줄**이다. 파일별 분류는 런타임·공개
계약·UI 101개, 번역 42개, 테스트·fixture 187개, 문서·정책 56개, 라이선스 9개,
도구·의존성·설정 9개다. 테스트와 문서가 큰 비중을 차지하므로 전체 줄 수를
제품 코드 증가량으로 해석하지 않는다.

## 기능과 복구 동작 비교

| 영역 | main | mxqr_beta |
| --- | --- | --- |
| 로컬 오디오 | 파일 전체를 AudioBuffer PCM으로 디코딩 | 일반 곡은 기존 엔진 유지. 메모리가 큰 곡은 MP3·FLAC·AAC·PCM 구간 디코딩을 지연 로딩하여 PCM 보관량 감소 |
| 파일 전송·프리로드 | 기존 현재 곡/프리로드 경로 | 현재 곡 우선권, bulk/control 도착 순서, 지연 PREPARE의 유효 prefix, 실제 수신 진행, 취소·재접속 수명 보완 |
| YouTube 재생·수동 싱크 | 기존 시작 예약과 동기화 | 음수 보정 지연 시작, 반복 직후 입력, cue 중 최신 seek/PLAY, 새 명령의 이전 예약 취소, 공유 후 재생 의도 복원 |
| PRO 상태 복구 | 기존 서버 권한 모델 | PREPARE/COMMIT·늦은 HTTP 응답·멤버 상태 적용을 현재 세션에 한정. 권한 회수 후 설정 재발행 방지와 반복/셔플 필수 조회 재시도 |
| 기기별 실패·채팅 | 기존 실패 처리 및 전송 UI | 실패 곡 재선택 시 이전 출력 정리. PRO slowmode·mute·알려진 전송 거부에서 초안과 로컬 상태 보존 |
| UI·데모 | 기존 검색·효과·visualizer·시작 로고 | 검색 상태 배치·입력 조작, 소스/권한 변경 중 슬라이더 취소, 데모 최신 효과 복원, visualizer 연속성, 단일 로고 리빌 마스크 |
| 계정·번역 Worker | 기존 쿠키 및 번역 내보내기·투표 | 세션별 쿠키로 늦은 로그아웃 응답 보호. 적용 완료 번역을 제외한 분할 export와 탈퇴 작성자 투표 fence |
| 리버브 계약 | 공통/서버/API 파서는 최대 30초 허용 | App·PRO·Developer API·공개 OpenAPI를 최대 10초로 정렬 |
| 의존성 | 기존 의존성 | `mediabunny`, `mpg123-decoder`, `@wasm-audio-decoders/flac`, `@wasm-audio-decoders/aac` 추가 |
| 제품 버전·캐시 | `8.6.61` / `v630` | 동일. 공개 승격용 증분 미반영 |

새 오디오 엔진은 전체 File/Blob을 확보한 뒤 PCM을 구간별로 디코딩한다. 네트워크
부분 스트리밍이나 전송 용량 확대가 아니다. 대용량 Opus/Vorbis와 일부 AAC
프로필·컨테이너·edit-list는 지원 범위에서 제외되며, 실패 시 전체 PCM 디코딩으로
자동 우회하지 않는다. 작은 파일은 기존 브라우저 디코더를 계속 사용한다.
이 제한은 [엔진 계약](large-local-audio-streaming-proposal.md)에 명시된 선택이며,
새 결함으로 분류하지 않지만 main 대비 사용자 호환성 차이로 남는다.

## 확인된 잔여 문제

### 양쪽 공통 개발 의존성 보안 경고

2026-10-06 같은 registry에서 main lockfile과 현재 beta를 감사했다.
양쪽 `vulnerabilities` 객체 전체가 동일하고 **13개 패키지
(critical 1 / high 7 / moderate 5)**가 보고됐다. 직접 advisory는 고유 18개이며,
패키지 수를 독립 CVE 수로 해석하지 않는다. 모든 영향 lock 노드는 main·beta와
현재 설치 버전이 일치하며 `dev: true`다. beta의 `--omit=dev` 감사는 **0건**이다.

대상은 `brace-expansion`, `compression`, `fast-uri`, `jsdom`, `miniflare`,
`minimatch`, `postcss-selector-parser`, `proxy-addr`, `serve`, `serve-handler`,
`source-map-js`, `undici`, `wrangler`다. 앞선 10월 4일 기록의 9개보다 네 패키지가
늘었으나 베타에만 추가된 취약 의존성은 없다.

| 새로 관측된 영향 패키지 | 현재 설치 버전 | 개발 의존성 경로 | Advisory |
| --- | --- | --- | --- |
| proxy-addr, critical | 2.0.7 | peer → express | [IPv4-mapped IPv6 trust subnet](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |
| compression, high | 1.8.1 | serve | [응답 조기 종료의 메모리 누수](https://github.com/advisories/GHSA-vc2v-76pw-4v95) |
| source-map-js, high | 1.2.1 | postcss·css-tree·magicast | [indexed source-map offset](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| postcss-selector-parser, moderate | 7.1.5 | PostCSS 플러그인 | [selector parsing CPU exhaustion](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) |

위 advisory의 현재 영향 범위와 공식 기록을 확인했다. `proxy-addr`·`compression`은
GitHub Advisory Database에 10월 5일 등록됐고, 나머지 두 항목도 현재 페이지의
마지막 갱신일이 10월 5일이다. 공통 lock 항목의 새 감사 결과를 베타 코드가
도입한 결함으로 분류하지 않는다. 개발 서버의 공격 가능 조건을 실제 프로덕션
취약 경로가 확인된 것으로 확대하지 않는다.

[CI의 security audit](../../.github/workflows/ci.yml)은 high 이상을 차단하므로
현재 결과는 양쪽의 승격 차단 사유다. 관련 의존성/override 갱신 후 보안·타입·빌드·
회귀 검증이 필요하다. 이번 비교에서 의존성을 수정하지 않았다.

### 베타 공개 캐시 검사 실패

같은 `check-sw-cache-version.mts`에서 `--head main`은 exit 0,
`--head mxqr_beta`는 exit 1이다. 베타 런타임 변경이 최신 `v630` 증분 커밋보다
뒤에 있으며, 제품 버전도 양쪽 `8.6.61`로 같다. 대회 동결 중 의도적으로 남긴
승격 항목이지만 공개 전에는 버전·캐시를 증분하고 최종 커밋에서 검증해야 한다.
`build` 성공을 `build:checked` 성공으로 대신하지 않는다.

### 실기와 운영 검증

iPhone Safari/PWA·Android·Bluetooth 첫 음 정렬과 장시간 재생은 잔여 확인이다.
앞선 QA의 탐색 직후 약 2.3초 native PCM 차이는 자동 복구됐지만 원인과 실제
음향 영향이 확정되지 않았다. 이번 검토가 그 관측을 해결한 것으로 기록하지 않는다.
최종 main SHA의 CI 후보와 실제 운영 확인도 별도다.

새 D1/DO migration, secret, Wrangler binding, 프로토콜 marker 변경은 없다.
누적 공개 배포 범위는 기존 `target=all`, Developer API D1 입력 false다. 쿠키
reader가 바뀐 뒤 구 App Worker로 전체 rollback하면 새 이름을 읽지 못하는
호환성 경계도 [기존 복구 기록](../beta-release-readiness.md#5-실패복구-시-주의점)을 유지한다.

## 이번 검증 결과

| 검사 | 결과와 범위 |
| --- | --- |
| 전체 unit | 최초 510파일·10,636 pass / tooling ESLint 설정 검사 1 timeout / skip·todo 0. 같은 검사 파일을 원래 15초 기준·변경 없이 직렬 실행해 18개 모두 pass. 해당 파일 결과를 치환한 고유 합계 10,637 pass / 최종 fail·skip·todo 0 |
| 전체 타입·린트·서식 | `npm run typecheck`, `lint`, `format:check` 통과 |
| E2E 빌드 | `npm run build:e2e` 통과 |
| 선택 Chromium | 10파일·54 pass / fail·skip·flaky·runner error 0, retry 0. 파일 엔진 전환·수동 싱크·late join·재접속/큐 시퀀스·데모 효과 복구·디코딩 중 종료·프리로드 취소·operator 업로드 취소·YouTube 반복/준비 중 탐색 |
| 프로덕션 로컬 산출물 | 브라우저 종료 후 `npm run build`로 production 모드 복원. legacy TV·service worker·UI kit·초기 전송 용량·production hooks·production security·font·app shell의 기존 guard 8개 모두 통과. 실제 배포나 production smoke 아님 |
| main/beta 보안 | 양쪽 전체 감사 exit 1, 취약 객체 동일. beta prod-only exit 0 |
| main/beta 캐시 | main exit 0, beta exit 1 |
| 추가 오디오 관측 | 합성 파일 6종 × 시작/중간/끝 18관측 및 동일 샘플레이트 MPEG-2 대조 3관측. 디코딩/예약 오류 0, native 길이·채널 수 일치, 정수 샘플 지연 0. 엄격한 파형 일치 판정 아님 |

오디오 관측은 실제 WASM·Chromium Web Audio의 bounded backend를 작은 5초 fixture로
직접 실행했다. MP3 Xing 없음, MPEG-2 모노 MP3, 32kHz MP3, 모노 FLAC, PCM24 WAV,
Float32 WAV를 사용했다. 일부 fractional seek에는 resampling/파형 잔차가 있으며,
유의미한 시간 드리프트나 청크 불연속은 입증하지 못했다. 실제 대용량 엔진 선택
UI·장시간·실기 출력 검사를 대신하지 않는다.

이번 전체 unit 및 선택 Chromium을 이전 coverage·전체 E2E·WebKit·production
smoke·Worker bundle 재실행으로 확대하지 않는다. 제품·유지 테스트 코드와 검사
기준을 변경하지 않았고 결과 문서만 저장한다. main 전진·PR 생성·워크플로
재활성화·프로덕션 배포는 수행하지 않았다.

## 실행 명령과 로컬 증거

PATH 앞에 `scratch/beta-upgrade-2026-09-09/node-v24.20.0-win-x64`를 두고,
`MXQR_TEST_JQ_PATH`는 `scratch/full-beta-repair-2026-09-27/tools/jq-windows-amd64.exe`,
`PLAYWRIGHT_BROWSERS_PATH`는 `scratch/beta-upgrade-2026-09-09/playwright-browsers`를 썼다.
브라우저의 전용 App/PeerJS 포트는 4518/9318이다.

```text
git fetch origin --prune
git rev-parse main origin/main mxqr_beta origin/mxqr_beta
git merge-base main mxqr_beta
git rev-list --left-right --count main...mxqr_beta
git diff --stat main..mxqr_beta
node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=scratch/main-beta-review-2026-10-06/unit.json
node node_modules/vitest/vitest.mjs run src/core/__tests__/tooling-eslint-config.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=scratch/main-beta-review-2026-10-06/unit-tooling-rerun.json
npm run typecheck
npm run lint
npm run format:check
npm run build:e2e
node node_modules/@playwright/test/cli.js test e2e/hybrid-file-engine.test.ts e2e/local-manual-start.test.ts e2e/late-join-bootstrap-catchup.test.ts e2e/luna-session-sequences.test.ts e2e/youtube-manual-repeat.test.ts e2e/youtube-pending-seek.test.ts e2e/demo-settings-recovery.test.ts e2e/disconnect-during-decode.test.ts e2e/preload-queue-mode-cancellation.test.ts e2e/operator-upload-cancellation.test.ts --project=chromium --workers=1 --retries=0 --reporter=line,json --output=scratch/main-beta-review-2026-10-06/e2e-results
npm run build
node scripts/check-legacy-tv-build.mts
node scripts/check-service-worker-asset.mts --dist
node scripts/check-ui-kit-asset.mts --dist
node scripts/check-initial-transfer-budget.mts
node scripts/assert-production-build-clean.mts
node scripts/assert-production-security-config.mts
node scripts/check-app-font.mts --dist
node scripts/check-service-worker-app-shell.mts
npm audit --json
npm audit --package-lock-only --json --prefix scratch/main-beta-review-2026-10-06/main-lock
npm audit --omit=dev --package-lock-only --json
node scripts/check-sw-cache-version.mts --head main
node scripts/check-sw-cache-version.mts --head mxqr_beta
node scratch/audio-review-20261006/probe.mjs
node scratch/audio-review-20261006/probe-equal-rate.mjs
```

원본 unit·audit·타입·린트·서식·빌드·브라우저 로그는 ignored
`scratch/main-beta-review-2026-10-06/`, 오디오 스크립트·fixture·관측 JSON은
`scratch/audio-review-20261006/`에 남긴다. scratch 자료는 원격 저장소에 포함되지
않으며 이 기록의 재현 환경과 수치로 구분한다.
