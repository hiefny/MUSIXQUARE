# Phase 6 6B: YouTube 시작 장부와 그 독자 (2026-11-01)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 배포됨(2026-11-02 05:34 KST, [Release 41347347201](https://github.com/hiefny/MUSIXQUARE/actions/runs/41347347201), target `app`, attempt 1 성공, 9.0.32 / v805, App `dff554a2` → `e19b7085`). PR #557(브랜치 `agent/p6-6b`, main `5a705c40` 위 22커밋, head `415f77be`)을 2026-11-02 05:12 KST에 열었고, 그 head의 PR CI와 자동 코드 리뷰가 통과해 squash `3ea689b9`(05:21 KST, 부모 `5a705c40`, 트리는 head와 같음, 미리 준비한 요약 본문)로 main에 들어갔으며, exact-main CI 뒤 배포했다(QA 라운드 9). App 9.0.32 / v805, target `app`, 업데이트 창 한 번(Q1의 넷 가운데 둘째). 브랜치 `agent/p6-6b`는 9.0.31의 배포 기록 main `5a705c40`(#556, 문서만, App 9.0.31 / v804의 머지 `ba28943e`(#555, 2026-11-01 23:17 KST 배포) 바로 위) 위 커밋 스물둘이다: 바탕 `dda3ee18` 위에서 만든 커밋 열다섯(계획 6B-1과 6B-2의 테스트 먼저·코드 커밋 넷, CHECK 12 후속 두 번의 테스트 먼저·가드 커밋 넷, 시험만 둘(독자 창 고정, 시험 순서 의존 고침), 주석·레지스트리와 설계 문서 메모 둘, 이 보고서의 기록 커밋 셋)을 `ba28943e` 위로 패치 그대로 옮겼고(QA 라운드 6), 그 위에 설계 문서의 틈 목록 맞춤, 옮김의 기록, 릴리스 준비의 기록(release-record §2 맨 위의 이 열차 '배포 전' 항목, 6A 절의 다음 단계 항목, `docs/README.md`, 아래 '배포 조건과 순서'), 버전 올리기(계획 6B-3, 마지막 런타임 커밋)와 그 기록 커밋을 더했다. 이 스물을 2026-11-02에 `5a705c40` 위로 다시 패치 그대로 옮겼고(QA 라운드 8: 충돌은 릴리스 준비 기록 커밋의 `docs/release-record.md`뿐, 버전 올리기는 `8823a591`에서 `582ab9d9`가 됐고 런타임 트리는 같음), 그 옮김의 기록 커밋 `a7979b2d`와 검토 지적을 고친 문서 커밋(이 글)이 마지막이다. 옮긴 테스트 먼저 커밋은 새 부모에서 라운드 4와 같은 이름의 행만 실패하고 코드 커밋은 모두 통과했으며(QA 라운드 6), 버전 올리기 머리의 로컬 전체 검사가 통과했다(QA 라운드 7: typecheck, lint, 형식, `build:checked`, `guard:*` 37개, 자원 소유권, 핵심·Worker 커버리지, 단위 전체(부하 아래 git fixture 행 둘의 시간 초과는 그 파일을 따로 돌려 통과), critical E2E 101 / 101, YouTube spec 53 / 53, 후보 E2E 19 / 19, 배포 대상 App뿐). 옮긴 머리에서 typecheck, lint, 형식, `build:checked`, `guard:*` 37개, 자원 소유권, 6B·T0a·T0b 시험 파일을 다시 돌려 통과했다(QA 라운드 8). '머지 전에 할 일'은 모두 끝났다: 9.0.31의 머지 뒤 Full E2E 41315565486이 통과했고(2026-11-02 00:29 KST), 9.0.31의 배포 기록 위로 다시 옮겼다(아래 '머지 전에 할 일' 4, 5). PR, PR CI, 자동 코드 리뷰, 머지, exact-main CI, 배포와 smoke, 공개 확인, Drift Audit과 머지 뒤 Full E2E는 QA 라운드 9에 적었다(아래 '배포 조건과 순서' 5 ~ 7). 머지 뒤 Full E2E 41347667125는 통과했다(06:43 KST, `e2e` 812 passed). T0b 결함 넷째(방장이 일시정지할 때 일시정지 신호가 참가자에게 두 번 가는 경우, H10 행)의 고침은 오너 답이 없어 싣지 않았고 6B는 그 고침 없이 나갔다(아래 '오너에게' 1). 블라인드 배포 뒤 확인(아래 '배포 뒤 확인')은 이 기록까지 아직이다. 로컬과 브랜치 결과는 exact-main-SHA 후보를 대신하지 않는다 |
| Base               | `5a705c40` = main: 9.0.31의 배포 기록(#556, 2026-11-02 00:58 KST squash 머지, 문서만: release-record §1, §2, §4, `release-history.md` 한 행, 9.0.31 보고서, `docs/README.md`, `docs/hotfix-procedure.md`)이다. 그 부모 `ba28943e`가 App 9.0.31 / v804(#555, 앱 글꼴 줄 상자 굽기와 탭 제목 한 기준선)의 squash 머지이고, 그 SHA가 [Release 41315218029](https://github.com/hiefny/MUSIXQUARE/actions/runs/41315218029)(target `app`, attempt 1 성공)로 2026-11-01 23:17 KST에 운영 App이 됐다. `ba28943e..5a705c40`가 `docs/`만 바꾸므로 바탕의 App 런타임은 운영과 같다. 9.0.31이 바꾼 App 런타임(글꼴 사본 440, 앱 글꼴 시트 다섯, `css/style.css`, `src/i18n/font-metrics.ts`, `src/i18n/font-prefetch-samples.ts`, `vite.config.ts`, 버전 거울 넷)은 6B가 바꾼 11 파일과 겹치지 않고, `ba28943e` 위로 옮기며 겹친 것은 `docs/README.md`뿐(QA 라운드 6), `5a705c40` 위로 옮기며 겹친 것은 `docs/release-record.md`뿐이다(QA 라운드 8). 그 앞 바탕은 `dda3ee18`(App 9.0.30 / v803의 배포 기록 #551 위에 T0b 시험만 PR 둘(#552, #553)과 시험만 E2E·단위 고침(#554), App 런타임은 운영 9.0.30 `3c098e9d`와 같음, 바탕 빌드의 진입 청크 `main-zzIxMfb3.js` 860,802 B, QA 라운드 4·5)이었고, 처음 납품은 T0b가 main에 들기 전의 `9e72b7ce`(main `9c078f5c` 위 T0b 시험만 커밋 일곱) 위 커밋 아홉이었다. 운영 코드는 처음 납품과 바이트로 같다(`git diff 691d8fb6 418b411d -- src`에서 시험 밖 차이 없음, 9.0.31 위로 옮긴 뒤에도 파일마다 더하고 뺀 줄이 같음). 6A의 머지 뒤 Full E2E [41278378387](https://github.com/hiefny/MUSIXQUARE/actions/runs/41278378387)이 `dda3ee18`에서 통과했고(`e2e` 794 passed, QA 라운드 5), 9.0.31의 머지 뒤 Full E2E [41315565486](https://github.com/hiefny/MUSIXQUARE/actions/runs/41315565486)이 `ba28943e`에서 통과했다(2026-11-02 00:29 KST에 끝남, QA 라운드 8). 둘 다 6B의 코드를 담지 않으므로 6B의 근거가 아니라 6B 앞 런타임의 기준이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Version            | 9.0.32 / v805(App 빌드 805). 버전 올리기 `582ab9d9`(마지막 런타임 커밋, `5a705c40` 위로 옮기기 전 `8823a591`과 패치와 런타임 트리가 같음)가 9.0.31 / v804를 9.0.32 / v805로 올린다: 9.0.31의 버전 올리기(#555 squash 안의 `566f458d`)와 같은 거울 여섯 파일 일곱 줄(`package.json`, `package-lock.json` 두 줄, `ADMIN_SCRIPT_VERSION`, `ADMIN_ASSET_VERSION`, `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 캐시 쿼리). 그 뒤 `guard:release-identity` 'MUSIXQUARE 9.0.32; service-worker cache epoch v805', `guard:sw-cache-version` 'PASS: v805 (8823a591) covers all committed PWA runtime changes.'(QA 라운드 7), 옮긴 뒤 'PASS: v805 (582ab9d9) covers all committed PWA runtime changes.'(QA 라운드 8). 계획의 예상 9.0.27 / v800보다 뒤인 까닭은 '계획과 달라진 것' 8. 그 앞 커밋들은 9.0.31 / v804 그대로이고(`guard:release-identity` 'MUSIXQUARE 9.0.31; service-worker cache epoch v804'), App 런타임 경로가 바뀌어 `guard:sw-cache-version`이 그 이유 하나로 실패했다: '[sw-cache-version] FAIL: committed PWA runtime changes are newer than v804 (ba28943e).'와 아래 'Deploy target'의 App 11 파일, 'Bump CACHE_VERSION in scripts/service-worker-asset.ts after these changes, then commit the bump.'(QA 라운드 6. 옮기기 전에는 같은 글의 'newer than v803 (3c098e9d).', 라운드 4·5). 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 둘째, 창 모양은 지금 그대로). 바닥(저장·유효 795)은 바꾸지 않는다(`raise_app_build_floor` false). 2026-11-02 05:34 KST에 그대로 배포했다(Release 41347347201, App 빌드 805, QA 라운드 9). 그래서 다음 App 업데이트(6C)와 앞으로 되돌리기는 9.0.33 / v806 이상이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Scope              | 계획 §4.7의 6B-1(C2-5, SS-04)과 6B-2(C2-7, SS-05), 모두 중립. 6B-1: 새 시작 장부 `src/youtube/start-ownership.ts`가 시작 주인들이 등록한 살아 있는 질의를 물을 때마다 읽어 독자에게 답한다. 6B-2: 모든 시작 소유 독자(여덟 모듈의 24곳)가 장부에 묻고, 합성 `isYouTubeZeroStartSyncOwned`(`src/youtube/zero-start-ownership.ts`)와 런타임 다리의 복구 훅 둘이 사라진다. 그 위에 계획에 없던 CHECK 12 후속 둘(가드만), 독자 창 고정과 시험 순서 의존 고침(시험만), 주석·레지스트리와 설계 문서 메모를 더했다. 와이어, 서버, 저장 모양, 계약 표지, 의존성, 타이머 이름, 로그 줄, 준비 이벤트, 화면, 소리는 바꾸지 않는다([화면 그대로])                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Deploy target      | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 `9e72b7ce..07a9f224`를 견준 로컬 git 판정(처음 납품): App 11(`src/network/sync.ts`, `src/player/background-return-sync.ts`, `src/ui/manual-sync-overlay-runtime.ts`, `src/ui/player-controls.ts`, `src/ui/seekbar.ts`, `src/youtube/`의 `iframe.ts`, `player-runtime-bridge.ts`, `player.ts`, 새 `start-ownership.ts`, `sync.ts`, 지운 `zero-start-ownership.ts`), PRO room 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 옮긴 뒤 `dda3ee18..48bc3819`의 시험·문서·`scripts/` 밖 차이는 같은 11 파일과 `vitest.critical.config.ts`뿐이고 `guard:sw-cache-version`도 같은 11 파일을 적는다(QA 라운드 4). 운영 App 9.0.30 `3c098e9d` 대비도 같은 App 11이고, 운영 PRO room `683074bc`와 나머지 넷 `71f5b96c` 대비 그 Worker들의 런타임 경로 차이는 0이다. 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 검사를 대신하지 않는다. `raise_app_build_floor` false, Developer API D1 false(계획 RT-01). 계약 동결: `git diff --stat dda3ee18..48bc3819 -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts package.json package-lock.json index.html scripts/service-worker-asset.ts browser/`가 비어 있다. 9.0.31 위로 옮긴 뒤 같은 함수로 운영 App 9.0.31 `ba28943e`(= 바탕), PRO room `683074bc`, 나머지 넷 `71f5b96c`와 견준 머리 `aa6fd50e`도 App 11(같은 파일), 나머지 Worker 0, App 런타임 의존성 차이 없음이고, 그 배포 SHA를 넣은(운영 조회 대신) target `app`의 부분 릴리스 호환 판정이 compatible이며, 같은 계약 동결 diff `ba28943e..aa6fd50e`도 비어 있다(QA 라운드 6). `5a705c40` 위로 옮긴 머리는 `docs/` 밖 트리가 버전 올리기 `8823a591`과 같고(`git diff 8823a591 <머리> -- . ':!docs'`가 비어 있음), 같은 함수와 배포 SHA로 다시 견줘도 App 15(6B의 11과 버전 거울 넷), 나머지 Worker 0, App 런타임 의존성 차이 없음, 부분 릴리스 호환 판정 compatible이다(QA 라운드 8). 릴리스의 부분 릴리스 판정(운영 조회)과 App 배포 직전 다시 확인도 compatible이었다(QA 라운드 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Operations         | QA 라운드 1 ~ 8은 운영에 닿지 않았다(로컬 git, 로컬 시험·빌드·Playwright만). 그 라운드에는 GitHub 쓰기, push, 배포, 운영 요청이 없었다. GitHub는 바탕 `dda3ee18`의 Full E2E 실행 하나의 정보와 job 로그(QA 라운드 5), 9.0.31의 Release 실행과 그 머지 뒤 Full E2E 실행의 상태(QA 라운드 6, 7), 9.0.31의 배포 기록 PR #556의 머지와 그 Full E2E의 결론(QA 라운드 8)을 읽기만 했다. 배포가 운영의 App Worker만 바꿨다(9.0.31 `dff554a2` → 9.0.32 `e19b7085`, QA 라운드 9). 그 밖의 GitHub 쓰기와 운영 동작은 PR #557의 브랜치 push와 PR 열기(05:12 KST), 리뷰 요청 댓글, squash 머지, Production Release, Operations Drift Audit과 Full E2E의 dispatch이고, 공개 최소 빌드 상태와 `/service-worker.js`는 인증 없는 GET으로 읽었다(QA 라운드 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Resource ownership | 새 레코드 없음. 장부는 기존 자원 RO-02의 주인들을 독자에게 엮는 곳이고, 답·깃발·단계·스냅샷을 저장하지 않고 구독도 이벤트도 없이 살아 있는 질의만 읽으므로 같은 자원의 둘째 기계가 아니다(`AGENTS.md` Resource ownership, 계획 RT-11). 센 코드나 규칙을 옮긴 커밋이 같은 커밋에서 레지스트리 RO-02, 가드 항목 12, 기준치를 고쳤다: CHECK 12에 시작 주인 파사드 쓰기 2(`player.ts`, 정확), 실행 스냅샷 읽기 8(`player.ts`, 정확), 장부 합성 1(`player.ts :: seekYouTubeFromApp`, 정확, 묻는 claim 둘로 고정)과 실패 닫힘 규칙들(파생 질의가 결정하는 종류마다 `player.ts`의 등록 요구 포함)을 더했다. CHECK 11 32, CHECK 12 읽기 11과 지우기 9, CHECK 5 1 / 1 / 45는 그대로다. `node scripts/check-resource-ownership.mts`: 49 records, 457 production files(바탕과 같음, 파일 하나 더하고 하나 지움)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

이 문서는 Phase 6 계획의 둘째 App 열차 6B의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의 Phase 6
계획(2026-10-30)과 그 영역 조사, 오너 답(2026-10-30)이고, SS, RT, C2 번호와 Q 번호는 그 노트의 번호다. 계획의 줄 번호는
`78ec56f5` 기준이라 6A와 T0b가 옮긴 위치를 모두 기호로 다시 찾았고, 이 문서의 줄 번호는 `48bc3819`의 것이다(운영 코드는
`418b411d`, 처음 납품의 `07a9f224`, 브랜치 끝과 같아 줄도 같다). 앞선 Phase 6 단계는 시험만인 T0a(#539, #541, #542), 가드만인 T1(#543), 첫 App
열차 6A(#550, 9.0.30 / v803, [보고서](phase6-6a-start-constants-owner-queries-2026-10-31.md))와 시험만인 T0b(#552, #553)다. 그 뒤
Phase 6 밖의 App 열차 하나(앱 글꼴 줄 상자 굽기와 탭 제목, #555, 9.0.31 / v804,
[보고서](app-font-baked-metrics-2026-11-01.md))가 오너 결정대로 6B보다 먼저 나갔다. 이 보고서에서
'중립'은 T0a의 골든과 고정 행, T0b 참값표의 모든 칸이 바이트 그대로 통과하고, 와이어가 바뀌지 않고, 같은 프레임이 같은 시각에 나가며,
준비 이벤트가 출처마다 같은 순간에 나간다(모두에 마이크로태스크 합치기를 씌우지 않음)는 뜻이다. 6B가 독자를 옮긴 곳에서는 도달 단언이
같은 커밋에서 장부 질의로 옮겨 갈 수 있지만 약해지지 않는다.

## 오너 결정 (2026-10-30, 모두 권장)

- **Q1 넷:** Phase 6을 App 업데이트 넷(6A ~ 6D)으로 낸다. 6B는 둘째이고, 업데이트 창은 버전 올리기와 함께 한 번 뜬다.
- **Q18 결함마다 묻기:** 시험이 결함을 재현하면 오늘 동작으로 고정하고 결함마다 따로 묻는다. 6B의 새 행(장부 행, 가드 행, 독자 창
  행)은 모두 오늘 동작이나 새 규칙을 고정한 것이고 결함으로 적은 행은 없다. T0b가 찾아 2026-11-01에 따로 여쭌 결함은 넷이다(가짜
  YouTube 화면이 실제처럼 알림을 한 박자 늦게, 상태가 바뀔 때만 보내도록 해서 다시 돌려 고친 목록): 첫째 방장 기기에서 YouTube 시작이
  끝내 실패하면 아무 안내 없이 멈춰 있음(참값표 H4, H4a 행), 둘째 다음 트랙 준비가 실패한 참가자는 다음 트랙이 시작할 때까지 ▶ 모양으로
  멈춰 보임(G8pa, G8, G8p, G8a 행), 셋째 PRO 방에서는 트랙이 시작되는 동안에도 동기화 버튼과 수동 싱크 창이 열려 있음(PRO 참값표 P1, P4
  행), 넷째 방장이 일시정지할 때 일시정지 신호가 참가자에게 두 번 가는 경우가 있음(H10, H10a, H10c 행). 넷째는 권장대로면 6B의 마지막
  증분에 실을 고침이었는데, 이 기록까지 답이 없어 싣지 않았고 6B는 그 고침 없이 나간다(아래 '오너에게' 1). 첫째와 둘째는 권장대로면
  6D의 마지막 단계이고, 셋째의 권장은 기록만(6D에서 시작 중 동기화를 누르는 시험부터)이다. 고친 목록은 앞 목록의 셋째(예전 방식으로
  시작할 때 '재생' 신호가 한 번 더 감, H9, H3, H5, H6 행)를 가짜 화면의 순서로 생긴 것이라 거두었다.
- **Q26 새 모듈:** `start-ownership.ts`의 근거는 `docs/design/source-complexity-ratchet.md`의 둘이다: 여러 운영 소비자의 공유 계약(독자
  24곳, 여덟 모듈)과 순환을 끊는 좁은 포트(주인들이 엮이는 `player.ts`는 `iframe.ts`와 `sync.ts`를 가져오므로 두 독자가 `player.ts`를
  가져오면 순환이 되고 `guard:import-graph`가 막는다. 장부는 아무것도 가져오지 않는 잎이다).
- **엔지니어링 기본값(계획 §9.3, §9.4, 권장대로):** 이 열차가 기댄 것은 Q7(소유자 질의는 주인 자기 타이머를 읽는다: 레거시 claim은
  `player.ts` 자기 `'yt-auto-sync'` 타이머), Q8(시작 소유를 native 보호 목록에 넣지 않는다, `native-control-authority.ts` 그대로), Q10과
  Q24(CHECK 12는 resource-ownership 가드 안에서 정확 개수), Q11(새 test-only export 없음, `guard:dead-exports` 시험 전용 20 그대로. 그래서
  참값표의 fallbackPending 열은 아래 'T0b 파일'대로 좁아진 채 둔다), Q28(이 열차에 의존성 변경 없음), Q29(번들 상한을 넘으면 잰 숫자로
  묻는다, 아래 '번들 크기'에서 해당 없음)다.
- **Q6 기준선:** 6A 보고서대로 Phase 6 앞의 기기 기준선은 재지 않았다(오너가 자리에 없음). 그래서 아래 '배포 뒤 확인'은 기준선과
  견주지 못하고 판정 기준과만 견준다.
- **릴리스 위임:** 6A 보고서가 적은 위임(2026-10-31 23:20 KST 무렵부터 약 40시간, 오너의 허락이 꼭 필요한 일만 묻기)이 이어지는 동안의
  배포 판단은 릴리스 담당의 몫이다. 이 브랜치는 그 판단에 쓸 근거만 적는다.

## 증분 한눈에

'부모에서'는 테스트 먼저 커밋을 그 트리 그대로(런타임은 부모의 것) 다시 돌린 결과(실패 / 그 실행의 행)이고, '코드 커밋에서'는 같은
파일들을 코드 커밋에서 돌린 결과다. 모두 옮긴 커밋에서 이 검사가 임시 worktree로 다시 돌렸다(QA 라운드 4). 실패한 행은 모두 그 테스트
먼저 커밋이 더하거나 바꾼 행이고, 함께 돌린 중립 고정 38 파일(T0b 시험 18 파일 모두, T0a 골든과 고정, D4 셋 등, 2,157행)은 양쪽에서
모두 통과했다. 처음 납품에서 잰 같은 표(옮기기 전 커밋)는 QA 라운드 1에 있다. 이 표와 아래 절의 SHA는 바탕 `dda3ee18` 위의
것이다(그 아래 '9.0.31 위' 행부터는 `ba28943e` 위의 SHA). App 9.0.31의 머지 `ba28943e` 위로 옮긴 뒤의 SHA와, 옮긴 부모에서 다시 돌려
같은 이름의 행만 실패하고 코드 커밋에서 모두 통과한 결과는 QA 라운드 6의 대응표와 그 아래에 있다. 9.0.31의 배포 기록 `5a705c40` 위로
다시 옮긴 뒤의 SHA(지금 갈래의 SHA)는 QA 라운드 8의 대응표에 있다.

| 증분                         | 항목                                                        | 테스트 먼저 → 코드      | 부모에서                                                           | 코드 커밋에서              | 가드                                                                   |
| ---------------------------- | ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------- |
| 6B-1 C2-5 시작 장부          | SS-04                                                       | `bd0dd536` → `5c43edd2` | 17 / 2,174(40 files), 등가 시험 파일은 불러오기 실패               | 2,184 / 2,184              | 수 그대로                                                              |
| 6B-2 C2-7 독자 옮김          | SS-05                                                       | `371a520c` → `ca883e29` | 27 / 2,273(40 files)                                               | 2,273 / 2,273              | 파사드 쓰기 2(새, 정확), 장부 합성 규칙(새)                            |
| CHECK 12 후속                | RO-02, 가드 항목 12                                         | `9a56095d` → `027b5036` | 12 / 91                                                            | 91 / 91                    | 스냅샷 읽기 8(새, 정확), 장부 합성 1(문장마다, 정확), 시작 타이머 규칙 |
| 독자 창 고정                 | 시험만                                                      | `421cc056`              | 5 / 5 통과(6B 앞 바탕 `dda3ee18`에서도 5 / 5)                      | 해당 없음                  | 없음                                                                   |
| 주석·레지스트리              | RO-02, 가드 머리 주석                                       | `c5f7ed17`              | 해당 없음                                                          | 빌드 바이트 동일           | 없음                                                                   |
| 기록                         | 이 보고서, `docs/README.md`                                 | `6aee97c3`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 시험 순서 의존 고침          | 시험만(T0b 파일 둘)                                         | `418b411d`              | `6aee97c3`에서 seed 1 ~ 16 가운데 일곱이 실패(425행 가운데 2 ~ 12) | seed 1 ~ 32 모두 425 / 425 | 없음                                                                   |
| CHECK 12 둘째 후속           | RO-02, 가드 항목 12                                         | `2920a863` → `0d9d55c8` | 3 / 94                                                             | 94 / 94                    | 수 그대로, 허용 합성의 claim 고정, 결정한 종류의 등록 요구             |
| 설계 문서 메모               | 문서만                                                      | `48bc3819`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 기록 갱신                    | 이 보고서, `docs/README.md`                                 | `e5851cd0`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 마지막 검사 기록             | 이 보고서                                                   | `89e0b682`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 설계 문서의 틈 목록 맞춤     | 문서만(9.0.31 위)                                           | `729bdc16`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 옮김의 기록                  | 이 보고서(QA 라운드 6)                                      | `fb5ed235`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 6B-3 릴리스 준비 기록        | RT-04, RT-15                                                | `01ca3582`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 6B-3 버전 올리기             | RT-04, 9.0.32 / v805                                        | `8823a591`              | 해당 없음                                                          | 전체 검사(QA 라운드 7)     | `guard:sw-cache-version` PASS v805                                     |
| 버전 올리기 뒤 기록          | 이 보고서, release-record, `docs/README.md`                 | `9b0787bc`              | 해당 없음                                                          | 해당 없음                  | 없음                                                                   |
| 9.0.31 기록 위로 옮김의 기록 | 이 보고서, release-record, `docs/README.md`                 | `a7979b2d`              | 해당 없음                                                          | 다시 검사(QA 라운드 8)     | `guard:sw-cache-version` PASS v805(`582ab9d9`)                         |
| 검토 지적 고침               | 이 보고서, release-record, 설계 문서 형식, `docs/README.md` | 이 커밋                 | 해당 없음                                                          | 문서 검사(PR 설명)         | 없음                                                                   |

## 증분

### 6B-1 C2-5 시작 장부 (SS-04)

새 `src/youtube/start-ownership.ts`(머리 `Resource owner: RO-02`)는 시작 주인들을 독자에게 엮는 장부다. 주인마다 자기 상태, 타이머,
수명을 그대로 갖고, 장부는 아무것도 갖지 않는다.

- **claim 종류와 살아 있는 질의:** `standard-run`(zero-start 실행: in flight, protocol active, hard-muted), `standard-recovery`(실행이
  포기한 시작을 이어받는 복구: active, pending), `legacy-rendezvous`(레거시 2단계 랑데부의 Stage-2 대기, 6B-2부터 등록), `pro-arm`(PRO
  arm의 hard-muted), `pro-direct`(PRO 직접 COMMIT의 로컬 대기, 읽는 파생 질의가 없어 등록하지 않음). 질의는 위치로 둔다(속성 이름은
  처음 받는 진입 청크에 실리기 때문).
- **등록:** 주인들이 엮이는 `player.ts`만 모듈 평가 끝에서 종류마다 한 번 `registerYouTubeStartClaim(kind, queries)`로 등록한다
  (`player.ts:4771-4781`). 다른 모듈의 질의는 클로저 뒤에 두어 부를 때 그 모듈의 살아 있는 바인딩을 읽는다. 등록은 질의를 읽지 않는다.
- **파생 질의:** 6B-1은 `isYouTubeStartSyncOwned`(실행의 protocol, 그다음 복구의 pending)와 `isYouTubeStartHardMuteOwned`(실행의
  hard-mute, 복구의 active, PRO arm)를 둔다. 묻는 순서와 단락은 바꾸는 합성의 피연산자 순서 그대로다. 파생 질의는 모든 종류를
  결정해야 하고(그 종류의 질의 하나나 never `0`), 종류를 더하고 claim 타입이나 어느 파생 질의의 결정을 빠뜨리면 컴파일되지 않는다.
- **독자:** 이 증분에서는 `player.ts`의 넷이 장부로 옮긴다: seek의 mid-sync 확인(`seekYouTubeFromApp`)과 늦은 합류 bootstrap 미룸은
  `isYouTubeStartSyncOwned`, `youtube:set-volume`과 PRO 일시정지 관문 정착의 unMute 가드 둘은 `isYouTubeStartHardMuteOwned`. 나머지
  독자는 6B-2까지 옛 합성을 읽는다.
- **지킨 것:** 9.0.8 방장 스피커 기준. `onPlaybackStarted`는 `getYouTubeZeroStartSnapshot()?.releaseLeadMs`를 읽어 방장 오프셋에서
  출시 앞섬만 뺀다(`player.ts:2431`, 로그 줄 `:2442`). 장부는 실행을 끝내거나 지우거나 바꿀 수 없고 `zero-start.ts`는 이 열차에서
  바뀌지 않아(`git diff dda3ee18..48bc3819 -- src/youtube/zero-start.ts` 비어 있음) 그 콜백 때 실행과 그 스냅샷이 전처럼 살아 있다.
  PRO arm의 `onPhaseChange`는 잇지 않았다(`iframe.ts` 인스턴스 그대로). 준비 이벤트와 sync-loading 이벤트를 내는 곳은 하나도 옮기지 않았다.
- **기록(같은 커밋):** 새 [설계 문서](youtube-start-ownership.md)(Accepted, `docs/README.md`의 설계 목록), `docs/qa-domains.md`의
  QA053(대표 구현이 지운 `zero-start-ownership.ts` 대신 장부와 설계 문서), 레지스트리 RO-02(상태는 `duplicated` 그대로), 핵심 커버리지
  (`vitest.critical.config.ts`에 장부 99 / 99 / 99 / 99와 `zero-start.ts` 84 / 83 / 96 / 88, 시험 파일 다섯).
- **시험(테스트 먼저 `bd0dd536`):** 새 `start-ownership.test.ts`가 운영 export만으로 장부를 몬다: claim 자리마다의 결정, 여덟 질의의 256
  조합 모두에서 읽는 순서와 단락, 부를 때 읽음, 등록 교체. 새 `start-ownership-equivalence.test.ts`(과도기)는 두 파생 질의를 바꾸는 합성과
  실제 Standard 게스트·PRO 참가자 실행의 모든 참값표 표본 시점에서 견준다(합성이 사라지는 6B-2에서 지움).
- **부모에서 17 / 2,174 실패:** `start-ownership.test.ts` 17행 모두 실패(모듈이 아직 없음), `start-ownership-equivalence.test.ts`는
  'Failed to resolve import "../start-ownership.ts"'로 불러오기 실패(0행). 함께 돌린 중립 고정 38 파일 2,157행(T0b 시험 18 파일, T0a 골든과
  고정, 9.0.8 시험이 있는 `player.test.ts`와 `sync-integration.test.ts`, ZS-09 끝점 행의 `pro-start-kind-endpoint.test.ts` 등)은 통과했다.
  `5c43edd2`에서 40 files, 2,184 / 2,184(새 행 27 = 17 + 10).

### 6B-2 C2-7 독자 옮김 (SS-05)

- **장부에 파생 질의 넷:** `isYouTubeStartTimelineHeld`(실행 in flight, 그다음 복구 pending: `sync.ts`의 작은 drift 표본, 게스트
  하트비트와 보조 상태 보류), `isYouTubeStartArmBusy`(실행 in flight: seek 막대의 문과 `iframe.ts`의 UI 루프),
  `isYouTubeStartRecoveryActive`(복구 active: `iframe.ts`의 상태 사건 분배), `isYouTubeStartRoomStateHeld`(실행 protocol, 그다음 레거시
  랑데부의 Stage-2 대기: `iframe.ts`의 보조 `YOUTUBE_STATE` 억제). `player.ts`가 레거시 랑데부 claim을 자기 `'yt-auto-sync'` 타이머로
  등록한다(`isYouTubeAutoSyncPendingOwned`, `player.ts:863`, 런타임 다리의 `isYouTubeAutoSyncPending`도 같은 질의로 답함).
- **독자 24곳, 여덟 모듈:** `sync.ts` 11(`:377`, `:610`, `:690`, `:712`, `:1055`, `:1143`, `:1764`, `:2336`은 `isYouTubeStartSyncOwned`,
  `:1222`, `:1431`, `:2371`은 `isYouTubeStartTimelineHeld`), `player.ts` 4(6B-1), `iframe.ts` 3(`:3114` recovery, `:3368` room state,
  `:3413` arm), `manual-sync-overlay-runtime.ts` 2(`:298`, `:363`), `src/network/sync.ts:150`, `src/ui/player-controls.ts:938`,
  `src/player/background-return-sync.ts:191`(모두 `isYouTubeStartSyncOwned`), `src/ui/seekbar.ts:45`(`isYouTubeStartArmBusy`). 조건마다
  장부 질의 하나다. 묻는 주인 질의와 순서와 단락은 바꾸기 전과 같다.
- **지움:** `src/youtube/zero-start-ownership.ts`(11줄), 런타임 다리의 복구 훅 둘(`isYouTubeZeroStartExternalFallbackActiveFromIframe`,
  `isYouTubeZeroStartExternalFallbackPendingFromSync`)과 그 설정 키 둘, `player.ts`의 그 다시 내보내기 하나. 계획 §4.10 끝 조건 2의
  'zero-start-ownership.ts 없음, isYouTubeZeroStartSyncOwned 없음'이 `src`(시험 밖)에서 참이 됐다.
- **준비 이벤트:** `youtube:zero-start-readiness-changed`는 내는 곳 17·듣는 곳 3, `youtube:sync-loading`은 내는 곳 16으로 바탕과 같고,
  두 이벤트를 내는 곳은 파일마다도 같다(합쳐서 `iframe.ts` 11, `sync.ts` 11, `player.ts` 5, `retained-player-controller.ts` 4,
  `standard-host-rendezvous.ts` 2). 실행의 단계 바뀜은 동기로, 복구 깃발 바뀜은 한 마이크로태스크 뒤로 그대로 낸다(`player.ts:2421-2423`,
  `:458-470`). 장부는 이벤트를 내지도 듣지도 않고 아무것도 합치지 않는다.
- **CHECK 12(같은 커밋):** `zero-start.ts` 밖의 파사드 쓰기는 실행 claim 등록의 둘(`player.ts`, 정확)뿐이어야 하고, 다른 곳의
  `isYouTubeZeroStart*` export, 한 조건에서 장부 질의 둘을 엮는 것, 장부 export를 넘기기, 순수하지 않은 장부, 둘째 등록자는 실패한다.
  레지스트리 RO-02와 가드 절, 설계 문서의 고침이 같은 커밋에 있다.
- **시험:** 과도기 등가 시험은 합성과 함께 지웠다(지우기 전 마지막 실행인 `5c43edd2`에서 10 / 10, 어느 표본도 어긋나지 않음). 지운 기호를
  가리키던 시험 이음새는 기대 배열과 강제 값을 바꾸지 않고 장부로 옮겼다: 참값표 표본기의 열 지도, 시작 하네스의 술어, `player.ts`를
  불러오지 않는 묶음이 대역이 답하는 claim을 등록하기. 도달 단언은 같은 claim을 장부 질의로 본다(아래 'T0b 파일').
- **시험(테스트 먼저 `371a520c`):** `start-ownership.test.ts`에 새 질의 넷의 행(claim 자리마다의 결정, 256 조합의 순서와 단락, 부를 때
  읽음, room-state 보류만 레거시 랑데부를 물음), `resource-ownership-guard.test.ts`에 장부 규칙을 심은 위반 행과 양성 대조.
- **부모에서 27 / 2,273 실패:** 장부 17(새 질의 넷이 아직 없음), 가드 10(규칙이 없어 오류 줄이 비거나 'start-owner facade uses 2'가 없음).
  중립 고정 38 파일(이음새 넷 `host-local-rendezvous`, `native-control-owner-ports`, `standard-realign`, `youtube/sync` 포함)은 통과했다.
  `ca883e29`에서 40 files, 2,273 / 2,273.
- **변이 확인:** 새 질의의 claim 자리를 하나씩 틀리게 바꾸면 행이 실패한다. 옮기기 전 `07a9f224`에서(QA 라운드 1): timelineHeld가
  protocol을 읽으면 12(장부 4, Standard 참값표 8), armBusy가 protocol을 읽으면 14(seek 막대 1, load-lifecycle 1, 장부 4, 참값표 8),
  recoveryActive가 pending을 읽으면 13(장부 4, owner-boundary 3, 참값표 5, fallback-ownership 1), roomStateHeld가 레거시 claim을 빼면
  12(장부 4, owner-boundary 1, 참값표 7). 옮긴 뒤 `418b411d`의 독립 검토(QA 라운드 3)도 파생 질의마다 claim 하나를 뺀 변이 열하나를
  모두 행으로 잡았다.

### CHECK 12 후속: 문장마다 세는 시작 claim, 실행 스냅샷 읽기, 시작 타이머 (RO-02, 가드 항목 12)

6B-2의 CHECK 12는 설계 문서가 적은 것을 다 지키지 못했다: 장부 질의 둘을 `||`·`&&`·`??` 한 사슬에서만 잡아 비교, `Boolean()`, 배열,
`?:`, claim 자신의 공개 질의로 다시 엮을 수 있었고, 파사드만 세어 `getYouTubeZeroStartSnapshot`으로 소유 답을 다시 만들어도 보이지
않았으며, 장부 순수성 규칙이 모듈 수준 const·class의 저장된 답, claims Map 쓰기, 장부 자신의 등록을 놓쳤고, `player.ts` 함수 안의 등록과
`src/youtube/` 밖에서 이름을 부른 시작 타이머가 통과했다. 가드만 바꾼 `027b5036`이 이를 닫는다.

- **장부 합성, `file :: function`마다:** 장부 밖에서 시작 claim 둘 이상을 묻는 문장(장부 질의, claim 자신의 공개 질의인 다리의
  `isYouTubeAutoSyncPending`과 `iframe.ts`의 `proYouTubeAuthorityOwnsHardMute`, `player.ts`가 등록한 질의, `'yt-auto-sync'`의
  `getManagedTimer()` 읽기). 가장 가까운 문장 단위로 센다. 정확한 항목은 seek의 mid-sync 확인 하나(`player.ts :: seekYouTubeFromApp`, 1:
  `isYouTubeStartSyncOwned`와 `'yt-auto-sync'` 읽기가 같은 문장, 방장 로컬 시작·끝 보류·수동 오프셋 거래 옆)다.
- **실행 스냅샷 읽기, 파일마다:** `zero-start.ts` 밖의 `getYouTubeZeroStartSnapshot`·`getYouTubeZeroStartPendingCanonicalPosition` 참조.
  정확: `player.ts` 8(실행 claim의 hard-mute 단계 `:114`, 9.0.8 방장 스피커 기준과 그 로그 줄 `:2431`, `:2442`, 게스트 복구의 들리는 앞섬과
  실행 확인 `:2452`, `:2533`, 피어 교체 대체 둘 `:3178`, `:3194`, `local-offset.ts`에 넘기는 예약 시작 읽기 `:2268`). 다시 내보내면 실패.
- **장부 순수성:** 모듈 수준 바인딩은 `START_CLAIM_KINDS`(문자열 상수 목록)와 `claims`(빈 `Map`) 둘, 모듈 수준 class·enum·namespace 없음,
  함수 지역 바인딩 밖의 쓰기 없음, `registerYouTubeStartClaim` 밖의 claims 바꿈 없음, 장부 자신의 등록 없음.
- **등록:** `player.ts`의 최상위 문장에서만.
- **시작 타이머:** `src/youtube/` 밖에서 이름이 시작 타이머로 풀리는 `getManagedTimer()`·`clearManagedTimer()`·`setManagedTimer()`는
  실패한다(지금 0, 기준치 없음).
- **기록(같은 커밋):** 레지스트리 RO-02(수, 항목과 이유, 시작 타이머 규칙), 가드 항목 12와 '아직 검사 안 함'(문장 사이에 변수나 지역
  도우미로 엮은 claim, `src/youtube/` 밖의 풀리지 않는 타이머 이름), 설계 문서, 장부 머리 주석(주석만이라 빌드 바이트 동일).
- **시험(테스트 먼저 `9a56095d`):** `resource-ownership-guard.test.ts`에 위 규칙마다 심은 위반과 허용 행 아홉(82 → 91행). 바뀐 행은 넷(합성
  오류 문구, 순수하지 않은 장부 행이 함수 지역 밖 쓰기도 기대, 넛지 행이 접힌 `'yt-auto-sync'` 읽기와 `isYouTubeAutoSyncPending`의 같은 문장
  합성을 기대, '`src/youtube` 밖 파일' 행이 시작 타이머가 아닌 이름과 풀리지 않는 이름을 읽음).
- **부모에서 12 / 91 실패**(새 행 아홉과 바뀐 행 셋: 가드에 규칙이 없거나 옛 합성 문구), 79 통과(바뀐 '`src/youtube` 밖' 행 포함).
  `027b5036`에서 91 / 91.
- 지금 가드를 6B 앞 운영 코드(`9e72b7ce`, 바탕 `dda3ee18`과 운영 코드·가드가 같음)에 돌리면 파사드 쓰기 7(`seekbar.ts` 1, `iframe.ts` 2,
  `sync.ts` 3, `zero-start-ownership.ts` 1)과 파사드 export 넷(다리 훅 둘, `player.ts`의 다시 내보내기, 합성)으로 실패한다(QA 라운드 2).
  그래서 이 규칙들은 6B-2가 옮긴 것을 지킨다.

### 독자 창 고정 (시험만, `421cc056`)

6B-2가 옮긴 독자 가운데 여섯은 가까운 다른 질의와 가르는 행이 없었다(독자를 틀린 장부 질의로 옮겨도 모든 묶음이 통과). 두 질의가
갈리는 창은 Standard 게스트의 timeline 보정이다: zero-start가 PLAYING을 출시한 뒤 실행은 protocol active지만 in flight가 아니어서
`isYouTubeStartSyncOwned`는 참이고 `isYouTubeStartTimelineHeld`, `isYouTubeStartArmBusy`는 거짓이다.

- 새 `start-ownership-reader-windows.test.ts`(시작 하네스의 실제 게스트 all-ready 실행, 합성 방 코드 000001)가 그 창(출시 +1,422 ms 뒤 2 s,
  protocol active는 약 +4,180 ms까지)에서 독자 다섯의 오늘 결과를 고정한다: 게스트 하트비트 보류가 방장 하트비트를 통과시킴(PAUSED
  하트비트가 autoplay 의도를 지움), 게스트 보조 `YOUTUBE_STATE` 보류가 프레임을 통과시키고(제목 적용) 그 상태 동작은 현재가 아니라
  iframe에 명령이 없음, 수동 오프셋 적용이 랑데부와 토스트 없이 물러남, 수동 싱크 창이 쓸 수 없고 창이 끝나면 다시 쓸 수 있음.
- 변이 확인(QA 라운드 1, 옮기기 전 `07a9f224`): 독자를 하나씩 다른 질의로 바꾸면 정확히 그 행이 실패한다(`sync.ts:1431`과 `:2371`
  TimelineHeld → SyncOwned, `:610` `isCurrentStateAction`과 `:1055` `isCurrentManualOffsetApply` SyncOwned → ArmBusy,
  `manual-sync-overlay-runtime.ts:298` SyncOwned → ArmBusy). 늦춘 랑데부 단계의 확인(`matchesRendezvousOccurrence`, `sync.ts:712`)은 이
  창에 가르는 행이 없다: 그 창에서는 뒤따르는 단계가 `guestRendezvousSync`를 거쳐 `isYouTubeStartSyncOwned`를 다시 묻고 랑데부를 시작하지
  않는다. 작은 drift 표본(`sync.ts:1222`)도 같은 조건이 `isGuestYouTubeTransitionPending`(→ `isYouTubeStartSyncOwned`)을 함께 물어 가를 수 없다.
- 옮긴 뒤(T0b #552의 뒷받침 행이 더해진 main 위): 브랜치 끝 `48bc3819`에서 `sync.ts:712`를 TimelineHeld로 바꾸면 `sync-integration.test.ts`의
  'zero-start owner at the guest backstop gates' 두 행이 실패한다(`src/youtube`, `src/player`, `src/ui`, `src/network` 317 files 8,221행 가운데
  2, QA 라운드 4). 수동 싱크 창의 동기화 누름 확인(`manual-sync-overlay-runtime.ts:363`, `sync_not_ready` 안내)을 ArmBusy로 바꾸면 같은 묶음이
  모두 통과한다. 그래서 가르는 행이 없는 독자는 작은 drift 표본과 수동 싱크 창의 누름 확인 둘이고, 독립 검토(QA 라운드 3)의 독자 변이
  R1 ~ R19 결과와 같다. 작은 drift 표본의 timeline 보류 피연산자는 논리적으로 남는 조건이라 지워도 모든 행이 통과한다(main에도 같음, 설계
  문서 'Not covered yet').
- 다섯 행은 `421cc056`에서 5 / 5, 6B 앞 바탕 `dda3ee18`(파일만 넣어 돌린 뒤 지움)에서도 5 / 5 통과한다(QA 라운드 4). 6B가 바꾸지 않은 오늘
  동작을 고정한 것이고 결함으로 적은 행은 없다.

### 주석·레지스트리 (`c5f7ed17`)

CHECK 12는 claim의 공개 질의(`proYouTubeAuthorityOwnsHardMute`)를 장부 질의 옆에서 세지만, 같은 claim에 답하는 PRO arm의 `ownsHardMute()`를
`iframe.ts` 안에서 그 인스턴스에 부르는 것은 세지 않는다. 레지스트리 '아직 검사 안 함'과 가드 머리 주석에 적었다. 주석과 문서뿐이다.

### 시험 순서 의존 고침 (시험만, `418b411d`)

처음 납품의 마지막 검사(QA 라운드 2)가 찾은 6B-2의 시험 순서 의존이다. 6B-2부터 `iframe.ts`의 보조 상태 보류와 UI 루프 문, `sync.ts`의
주인 문이 장부에 묻고, 장부는 `player.ts`가 불러올 때 등록하는 claim만 가지며 행 사이에도 그대로 갖는다. 두 묶음이 `player.ts`를 행 안에서만
늦게 가져와서, `player.ts`를 가져오지 않는 행은 앞선 행이 가져왔을 때만 mock한 zero-start 파사드를 읽었다. 운영에는 영향이 없다:
`src/app.ts`가 `player.ts`를 정적으로 가져와 시작 때 claim이 등록되고, 그 앞에는 실행을 만드는 컨트롤러도 없어 옛 파사드도 거짓이었다.

- 고침: 두 묶음(`stale-async-guards.test.ts`, `sync-integration.test.ts`, 둘 다 T0b 파일)의 공유 `beforeEach`가 `player.ts`를 가져온다.
  기대 값과 도달 단언은 바꾸지 않았다.
- 고치기 전 `6aee97c3`에서 두 묶음을 함께 seed 1 ~ 16으로 돌리면(425행) seed 3(12 실패: `sync-integration` 10, `stale-async-guards` 2),
  6(10, `sync-integration`), 7, 8, 10, 11, 12(각 2, `stale-async-guards`)가 실패하고 나머지 아홉은 통과한다. `418b411d`에서는 seed 1 ~ 32
  모두 425 / 425다. 브랜치 끝에서 `src/youtube`, `src/player`, `src/pro-room`(239 files, 6,515행)을 seed 3, 6, 7, 31, 4242, 20261030으로
  돌려 모두 통과했다(QA 라운드 4). 같은 묶음으로 독립 검토(QA 라운드 3)도 seed 1 ~ 32 425 / 425를 봤다.
- 고침 뒤에도 `iframe.ts`의 두 독자를 빼면 두 barrier 행이, `sync.ts`의 clock-action 확인과 방장 피드백 보류를 빼면 그 뒷받침 행이 파일
  순서와 shuffle 모두에서 실패한다(커밋 메시지).

### CHECK 12 둘째 후속: 허용 합성의 claim과 결정한 종류의 등록 (가드만, `2920a863` → `0d9d55c8`)

처음 납품의 리뷰가 찾은 CHECK 12의 틈 둘이다. 운영 코드는 바꾸지 않는다.

- **허용 합성의 claim 고정:** CHECK 12는 장부 합성을 문장마다 세므로, 허용된 한 문장(seek의 mid-sync 확인)이 claim을 더 물어도 수가 1로
  남아 찾지 못했다(그 문장에 `isYouTubeZeroStartExternalFallbackActiveOwned()`를 더해도 통과). 이제 `LEDGER_COMPOSITE_BASELINE` 항목마다
  그 문장이 묻는 claim을 적는다(장부 질의는 이름, claim 질의와 타이머 읽기는 그 claim의 종류). seek 항목은 `isYouTubeStartSyncOwned`와
  `legacy-rendezvous`이고 레거시 claim은 타이머나 그 질의 둘 어느 쪽으로 물어도 같다. 허용된 함수에서 다른 claim을 묻는 문장은
  `LEDGER COMPOSITE`로 실패한다.
- **결정한 종류의 등록:** 장부는 열린 채 실패한다: 파생 질의가 결정하는데 아무도 등록하지 않은 종류는 거짓으로 답해, 그 주인이 독자에게
  보이지 않는다. CHECK 12는 남의 등록, 계산한 종류, 두 번 등록, 최상위 밖 등록은 막았지만 빠진 등록은 보지 못했다(`pro-arm`이나
  `legacy-rendezvous` 등록을 지워도 가드 통과, 행만 5와 14가 잡음). 이제 각 파생 질의가 돌려주는 결정 목록(호출 하나에 넘기는 목록 하나,
  `START_CLAIM_KINDS` 순서, `0`은 never)에서 결정하는 종류를 읽고, `player.ts`의 최상위 등록이 없는 종류(지금 `standard-run`,
  `standard-recovery`, `legacy-rendezvous`, `pro-arm`)를 `START CLAIM REGISTRATION`으로 실패시킨다. 결정을 읽을 수 없는 모양의 파생 질의도
  실패한다.
- **시험(테스트 먼저 `2920a863`):** `resource-ownership-guard.test.ts`에 행 셋(91 → 94행): 허용 합성에 복구 질의를 더함, 허용 장부 질의를
  다른 장부 질의로 바꿈, 레거시 claim 대신 PRO arm을 물음은 실패하고 레거시 claim을 타이머와 질의로 두 번 물음은 통과. `pro-arm`,
  `legacy-rendezvous`, `standard-recovery` 등록을 지우거나 함수 안으로 옮기면 결정하는 파생 질의 이름과 함께 실패. 결정을 변수에 담은
  것, 길이가 틀린 목록, export한 화살표는 읽을 수 없어 실패.
- **부모에서 3 / 94 실패**(새 행 셋, 규칙이 없음), 91 통과. `0d9d55c8`에서 94 / 94. 수(파사드 쓰기 2, 스냅샷 읽기 8, 장부 합성 1)는 그대로다.
- **기록(같은 커밋):** 가드 머리 주석, 레지스트리 RO-02와 CHECK 12 절, 설계 문서의 Rules.

### 설계 문서 메모 (`48bc3819`)

설계 문서 Verification에 `player.ts`를 행 안에서 가져오는 묶음은 공유 `beforeEach`에서 가져오거나 대역 claim을 등록해야 순서와 무관하다는
문장(위 '시험 순서 의존 고침'의 교훈)을, 'Not covered yet'에 복구의 출시 확인 창에서 unMute 가드의 복구 결정(active이지 pending이 아님)을
장부 단위 행만 고정한다는 문장을 더했다. 문서뿐이다.

### 설계 문서의 틈 목록 맞춤 (문서만, 9.0.31 위로 옮긴 뒤)

설계 문서 'Not covered yet'의 틈 목록은 2026-11-01에 고친 T0b 결함 목록보다 앞의 것이었다. 고친 목록이 거둔 H9·H3·H5·H6 줄(참값표가
'Fake ordering'으로 적은 가짜 화면의 순서)이 남아 있었고, G8 줄은 가짜 화면의 COMMIT 다시 멈춤 창을 적었다. 이제 그 목록은 오너에게
여쭌 결함 넷을 고친 목록대로 적는다: 방장 복구가 끝내 실패하면 `playback.activity`만 '재생 중'(H4, H4a), 다음 트랙 준비가 실패한
참가자는 준비가 실패한 순간부터 새 트랙 출시까지 약 2.7 s 멈춤으로 보임(G8pa, G8, G8p, G8a), PRO 방에서 시작 중 동기화 버튼과 수동
싱크 창이 열려 있음(P1, P4), 방장 일시정지가 정식 PAUSED와 iframe 자신의 PAUSED 둘을 보냄(H10, H10a, H10c). H9·H3·H5·H6은 가짜 화면만
보내는 것이라 틈이 아니라고 따로 적었다. 문서뿐이다.

## T0b 파일

T0b(main의 #552, #553, 20 파일: 시험 18과 도우미 둘) 가운데 12개를 6B가 고친다. 6B-2 코드 커밋 `ca883e29`가 11개(+151 −94, 지운 모듈과
다리 훅을 mock하거나 가져오던 이음새라 6B-2에 꼭 필요했다), 시험 순서 고침 `418b411d`가 `stale-async-guards.test.ts`와
`sync-integration.test.ts`(+16, 앞의 11개와 하나 겹침)다. 두 참값표(`youtube-start-ownership-table.test.ts` 62행, `-pro` 19행, 합 81행,
U1 ~ U14, P6p, P9, P10, 비동기 전달 a 변형, H13·H12b 이름표 포함), `fake-yt-player.ts`, T0a의 모든 골든 파일은 main과 바이트로 같다.
T0a(#539, #541, #542)와 T0b(#552, #553)가 더하거나 고친 시험·도우미 58 파일로 세면 45개가 그대로이고 13개(T0b 12와 T0a 도우미
`standard-start-harness.ts`의 술어 둘)가 바뀐다. 기대 배열과 강제 값은 바꾸지 않았고, 도달 단언은 같은 claim을 장부 질의로 본다.
`player.test.ts`에서 지운 다시 내보내기가 다리 훅과 같은
함수임을 보던 단언 하나는 그 다시 내보내기와 함께 지웠고, 'pending 참' 단언은 'ArmBusy 거짓, TimelineHeld 참'(같은 뜻)으로, 멈춘 뒤의
단언은 더 강하게 바뀌었다(QA 라운드 3).

- `src/youtube/__tests__/__helpers__/start-ownership-sampler.ts`: 참값표 열 지도만. owned, inFlight, fallback, auxHeld, beatHeld는 장부
  질의를 읽는다. unMuteHeld는 hard-mute 단계 목록을 스스로 갖고(그 복구 피연산자만 `isYouTubeStartRecoveryActive`를 읽음) 볼륨 행이 그
  열을 실제 가드의 효과와 견준다(설계 문서 Verification과 같음). 두 참값표의 기대 배열은 그대로다.
- **fallbackPending 열의 좁힘(받아들임):** main에서 이 열은 복구의 pending 질의를 그대로 읽었다(다리 훅
  `isYouTubeZeroStartExternalFallbackPendingFromSync`). 6B-2가 그 훅을 지워 지금은 `isYouTubeStartTimelineHeld() && !isYouTubeStartArmBusy()`,
  곧 pending이면서 실행이 in flight가 아닐 때만 참이다. 그래서 실행이 in flight인 동안의 pending claim은 이 열에 보이지 않고, 이 열이 시험
  대상 질의를 일부 읽는다(TimelineHeld가 복구를 빠뜨리는 변이는 G·H 행이 일부 이 열로 잡고, 실행을 빠뜨리는 변이는 두 참값표를 통과해
  #552의 `sync-integration` 뒷받침 행, `zero-start-heartbeat-ownership`의 한 행, 장부 단위 행이 잡는다, QA 라운드 3). 받아들인 이유는 셋이다.
  (1) `zero-start.ts`에서 in flight는 protocol active의 부분집합이라, pending을 묻는 모든 독자(`isYouTubeStartSyncOwned`,
  `isYouTubeStartTimelineHeld`)는 in flight인 동안 이미 실행 claim으로 참이다. 그 창의 pending은 어느 독자에게도 보이지 않는다. (2) 지금 두
  참값표 81행의 모든 표본에서 이 열은 원래 질의와 같다. 이 검사가 `player.ts`의 pending 질의를 임시로 드러내 열과 견주었더니 표본
  47,600개 넘게에서 어긋난 것이 없었고, pending이 참인 1,582개 모두 실행이 in flight가 아니었다(QA 라운드 4, 고친 두 파일은 되돌림).
  (3) 원래 질의를 열에 주려면 `player.ts`에 시험 전용 export가 필요한데, 엔지니어링 기본값 Q11(새 시험 전용 export 없음)과 어긋난다.
- `src/player/__tests__/background-return-sync.test.ts`: mock 대상을 지운 모듈에서 장부 질의로.
- `src/network/__tests__/sync.test.ts`, `src/ui/__tests__/player-controls.test.ts`, `src/ui/__tests__/seekbar.test.ts`,
  `src/youtube/__tests__/host-local-rendezvous.test.ts`, `standard-realign.test.ts`, `sync.test.ts`, `zero-start-heartbeat-ownership.test.ts`:
  `player.ts`를 불러오지 않으므로 대역이 답하는 claim을 등록.
- `src/youtube/__tests__/player.test.ts`, `sync-integration.test.ts`: 지운 다리 훅과 다시 내보내기 대신 장부 질의. `sync-integration.test.ts`와
  `stale-async-guards.test.ts`는 `418b411d`부터 공유 `beforeEach`에서 `player.ts`를 가져온다.

처음 납품은 T0b가 main에 들기 전의 T0b(19 파일) 위에서 11개를 고쳤다. T0b가 #552, #553으로 강해져 main에 든 뒤 이 원칙(기대 배열 그대로,
이음새만 장부로)대로 다시 맞췄고, 옮긴 테스트 먼저 커밋을 새 부모에서 다시 돌려 같은 이름의 행만 실패함을 봤다(위 '증분 한눈에').

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 `78ec56f5` 기준이라 모든 위치를 기호로 다시 찾았다.
2. **보조 `YOUTUBE_STATE` 억제(계획의 `iframe.ts:3372`):** 계획은 파사드에 남기고 그 줄을 기준에 넣는 길도 열어 두었다. 6B-2는 장부 질의
   `isYouTubeStartRoomStateHeld`로 옮기고 레거시 랑데부 claim을 등록했다. 그래서 `zero-start.ts` 밖의 파사드 쓰기는 실행 claim 등록의 둘뿐이다.
3. **CHECK 12 규칙:** 계획은 '장부 밖 새 `isYouTubeZeroStart*` 합성이나 `getManagedTimer('yt-…')` 소유 질의 거절'이었다. 6B-2와 그 후속 둘이
   파사드 쓰기(2), 실행 스냅샷 읽기(8), 문장마다 장부 합성(1, 묻는 claim 고정), 장부 순수성, 등록 규칙(결정한 종류의 등록 요구 포함),
   `src/youtube/` 밖 시작 타이머로 넓혔다(계획에 없던 가드 후속 증분 둘, 각각 테스트 먼저와 가드 두 커밋).
4. **남긴 합성과 claim 자신의 질의:** seek의 mid-sync 확인은 장부 질의와 `'yt-auto-sync'` 읽기를 한 문장에 둔다(다른 주인인 방장 로컬
   시작·끝 보류·수동 오프셋 거래 옆, 가드 항목 1, 묻는 claim 둘로 고정). 레거시 Stage-2 대기를 묻는 독자 셋(`sync.ts` 하트비트 보류,
   `iframe.ts`의 서브 영상 자동 넘김 확인, `native-control-authority.ts`)은 6A-1의 다리 질의 `isYouTubeAutoSyncPending`을 그대로 묻는다.
   레거시 claim이 같은 살아 있는 질의를 등록하므로 claim이 바뀌면 이 셋도 함께 옮겨진다.
5. **`pro-direct`:** 계획은 pro-arm·pro-direct claim이 `player.ts`의 transitionId 갈림을 따른다고 적었다. 읽는 파생 질의가 없고 그 2 s 로컬
   대기에 공개 주인이 없어 종류만 선언하고 등록하지 않았다(설계 문서 'Not covered yet', C2-13). T0a의 ZS-09 끝점 행
   (`pro-start-kind-endpoint.test.ts` 6 / 6)은 그대로 통과한다. 결정하는 파생 질의가 없으므로 CHECK 12의 등록 요구에도 들지 않는다.
6. **T0b 파일:** 6B가 T0b 파일 12개를 고친다(위 'T0b 파일').
7. **추가한 시험:** 독자 창 고정(`421cc056`)과 시험 순서 의존 고침(`418b411d`)은 계획에 없었다.
8. **6B-3(버전 올리기·문서):** 처음 납품에는 없었고, 릴리스 담당이 9.0.31 위로 옮긴 뒤 더했다(release-record §2의 '배포 전' 항목, 6A 절의
   다음 단계 항목, `docs/README.md`, 이 보고서의 배포 조건, 그리고 마지막 런타임 커밋인 버전 올리기). 번호는 계획의 예상 9.0.27 / v800이 아니라
   9.0.32 / v805다: 6A 앞에 다른 App 열차들이 끼어 6A가 9.0.30이 됐고, 오너 결정대로 9.0.31(앱 글꼴 줄 상자 굽기와 탭 제목)이 6B 앞에 나갔다.

## 정확한 개수 가드

바탕 값은 `dda3ee18`의 운영 코드와 가드가 처음 납품의 바탕 `9e72b7ce`와 같아 그때 잰 값이다. 브랜치 끝 값은 QA 라운드 4에서 쟀고,
라운드 5의 `e5851cd0`에서 모두 같았다(`--report` 119줄이 라운드 4와 줄마다 같음).

| 가드                                           | 바탕 `dda3ee18`                                                              | 브랜치 끝 `48bc3819`                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CHECK 11 iframe 오디오 쓰기(RO-12)             | 32                                                                           | 32(줄만 옮겨짐)                                                                            |
| CHECK 12 남의 시작 타이머 읽기 / 지우기(RO-02) | 11 / 9                                                                       | 11 / 9                                                                                     |
| CHECK 12 시작 주인 파사드 쓰기(6B-2부터)       | 규칙 없음(지금 가드로는 7과 export 넷, 실패)                                 | 2, `player.ts`(실행 claim 등록)                                                            |
| CHECK 12 실행 스냅샷 읽기(후속부터)            | 규칙 없음                                                                    | 8, `player.ts`                                                                             |
| CHECK 12 장부 합성(문장마다, 후속부터)         | 규칙 없음                                                                    | 1, `player.ts :: seekYouTubeFromApp`(claim `isYouTubeStartSyncOwned`, `legacy-rendezvous`) |
| CHECK 12 결정한 종류의 등록(둘째 후속부터)     | 규칙 없음                                                                    | 넷 모두 `player.ts`의 최상위 등록 있음                                                     |
| CHECK 5 복사 / 의심 / 같은 값 쌍(보고만)       | 1 / 1 / 45                                                                   | 1 / 1 / 45                                                                                 |
| resource-ownership                             | 49 records, 457 production files, `--report` 108줄                           | 49 records, 457 production files, `--report` 119줄                                         |
| dead-exports                                   | 410 prod files, 2,157 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76 | 410, 2,161, 0, 20, 76                                                                      |
| import-graph                                   | 410 files, 2,103 edges, 순환 0                                               | 410 files, 2,101 edges, 순환 0                                                             |
| bus-pairing                                    | 202 / 202                                                                    | 202 / 202                                                                                  |
| room-authority                                 | 79 / 22 / 13 / 0 / 0, 410 files                                              | 같음                                                                                       |

`--report`의 바뀐 줄은 새 사이트 열하나(파사드 쓰기 2, 스냅샷 읽기 8, 장부 합성 1)와 `player.ts`·`sync.ts` 사이트의 줄 번호뿐이다. 내린
기준치도 올린 기준치도 없고, 새 기준치는 그 규칙을 더한 커밋(`ca883e29`, `027b5036`)이 레지스트리 기록과 함께 더했다. 둘째 후속
(`0d9d55c8`)은 수를 바꾸지 않고 장부 합성 항목에 claim 목록을 더했다. source-complexity(YouTube 파일은 목록에 없음)도 바뀐 기준치가 없다.

## 번들 크기

같은 툴체인(Node 24.22.2, vite 8.3.3)으로 커밋마다 `npm run build`를 하고 `scripts/check-initial-transfer-budget.mts`의
`measureInitialTransfer`로 바이트를 읽었다(QA 라운드 4, 임시 worktree). 브랜치 끝은 `build:checked`의 운영 빌드로 쟀다. 처음 납품의 옮기기 전
커밋(`9e72b7ce`, `5300f565`, `4d3ba199`, `07a9f224`)에서 잰 값(QA 라운드 2)과 모두 같다. 라운드 5에서 `origin/main` `dda3ee18`의 트리를 따로
빌드하고 `e5851cd0`의 `build:checked` 빌드와 견준 값도 아래 바탕과 끝 줄과 바이트까지 같다.

| 커밋                                | 진입 청크          | 진입 raw / gzip   | eager JS gzip (부모 대비) | eager total raw / gzip (부모 대비) |
| ----------------------------------- | ------------------ | ----------------- | ------------------------- | ---------------------------------- |
| 바탕 `dda3ee18`(운영 9.0.30과 같음) | `main-zzIxMfb3.js` | 860,802 / 253,728 | 465,458                   | 2,048,366 / 543,651                |
| 6B-1 `5c43edd2`                     | `main-DQlXNnFP.js` | 861,172 / 253,860 | 465,587 (+129)            | 2,048,736 / 543,779 (+128)         |
| 6B-2 `ca883e29`                     | `main-jdcp8EDh.js` | 861,056 / 253,678 | 465,405 (−182)            | 2,048,620 / 543,597 (−182)         |
| 브랜치 끝 `48bc3819`                | `main-jdcp8EDh.js` | 861,056 / 253,678 | 465,405 (0)               | 2,048,620 / 543,597 (0)            |

- 증분별(부모 대비 eager JS gzip): 6B-1 +129, 6B-2 −182. 둘 다 증분 상한 +300 B 안이다. 테스트 먼저 커밋(`bd0dd536`, `371a520c`)은 런타임이
  부모와 같고, 6B-2 뒤 커밋(`9a56095d` ~ `48bc3819`)은 시험, 가드, 문서와 장부 머리 주석만 바꾼다.
- **6B 순증:** eager JS gzip −53 B, eager total gzip −54 B, 진입 raw +254 B, 진입 gzip −50 B. KiB로는 eager JS 454.5 KiB, eager total
  530.9 KiB gzip 그대로이고 `guard:initial-transfer-budget`을 통과한다(entry 840.9 KiB raw / 247.7 KiB gzip, eager total 2,000.6 KiB raw).
- **Phase 6 누계(계획 §4.2-6, 증분마다 부모 대비 잰 차의 합, 사이에 낀 Phase 6 밖 열차는 뺌):** 6A −149 B(그 보고서의 처음 바탕 위
  증분 차의 합) + 6B −53 B = **−202 B**로 Phase 상한 +200 B 안이다. 처음 받는 양이 운영 9.0.30보다 줄어 Q29의 멈춤 조건에 해당하지
  않는다(아래 '오너에게' 2).
- 6B-1의 +129 B는 장부 모듈과 등록, 6B-2의 −182 B는 지운 합성 모듈, 다리 훅 둘, 다시 내보내기와 독자 import의 줄어듦으로 본다[추론].

**App 9.0.31 위로 옮긴 뒤(QA 라운드 6, 지금의 근거):** 바탕 `ba28943e`(운영 App 9.0.31 그 자체)와 옮긴 6B-1, 6B-2를 같은 툴체인으로
임시 worktree에서 커밋마다 빌드하고, 옮긴 머리 `aa6fd50e`는 이 갈래의 worktree에서 빌드해 같은 함수로 쟀다. 9.0.31이 진입 청크의
`src/i18n/font-prefetch-samples.ts`를 바꿔 진입 청크 이름과 gzip 바이트가 옮기기 전과 다르고, 6B의 raw 차는 같다.

| 커밋                                    | 진입 청크          | 진입 raw / gzip   | eager JS gzip (부모 대비) | eager total raw / gzip (부모 대비) |
| --------------------------------------- | ------------------ | ----------------- | ------------------------- | ---------------------------------- |
| 바탕 `ba28943e`(운영 9.0.31 그 자체)    | `main-CYs4aHwd.js` | 860,802 / 253,723 | 465,438                   | 2,048,669 / 543,683                |
| 6B-1 `6b6807f3`                         | `main-CYJ-Q_7J.js` | 861,172 / 253,867 | 465,588 (+150)            | 2,049,039 / 543,833 (+150)         |
| 6B-2 `af9ca6b9`                         | `main-B_2lIPze.js` | 861,056 / 253,683 | 465,404 (−184)            | 2,048,923 / 543,652 (−181)         |
| 옮긴 머리 `aa6fd50e`                    | `main-B_2lIPze.js` | 861,056 / 253,683 | 465,404 (0)               | 2,048,923 / 543,652 (0)            |
| 버전 올리기 `8823a591`(`build:checked`) | `main-FMXWdlb7.js` | 861,056 / 253,683 | 465,403 (−1)              | 2,048,923 / 543,650 (−2)           |

- 증분별(부모 대비 eager JS gzip): 6B-1 +150, 6B-2 −184. 둘 다 증분 상한 +300 B 안이다.
- **6B 순증(9.0.31 대비):** eager JS gzip −34 B, eager total gzip −31 B, 진입 raw +254 B, 진입 gzip −40 B. 버전 올리기 머리는 이 값을 넘어
  늘지 않아야 하고(아래 '배포 조건과 순서'), `8823a591`에서 eager JS −35 B, eager total −33 B, 진입 raw +254 B와 gzip −40 B로 넘지 않았다
  (QA 라운드 7, 버전 문자열만 바뀌어 진입 청크 이름이 바뀜). KiB로는 eager JS 454.5 KiB, eager total 530.9 KiB gzip이다(entry 840.9 KiB raw / 247.7 KiB
  gzip, eager total 2,000.9 KiB raw).
- **Phase 6 누계(같은 방법, 9.0.31은 Phase 6 밖이라 뺌):** 6A −149 B + 6B −34 B = **−183 B**로 Phase 상한 +200 B 안이다. 처음 받는 양이
  운영 9.0.31보다 줄어 Q29의 멈춤 조건에 해당하지 않는다(아래 '오너에게' 2). 위 `dda3ee18` 위의 −53 B와 −202 B는 옮기기 전의 값이다.

## 혼합 버전

계획 §4.7의 (a) ~ (c)와 §5의 6B 행이다. 근거는 기기 혼합 행이 아니라 T0a의 프레임·시각 골든과 T0b 참값표가 바이트 그대로 통과한
것이다(Phase 5의 P5-D9 C 선례). 와이어(`src/network/protocol.ts`, `src/types/index.ts`, `src/core/constants.ts`, `cloudflare/`)는 바탕과
바이트로 같다.

| 조합                               | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 6B 방장과 옛 게스트            | 방장 하트비트 보류(`sync.ts:377` `broadcastYouTubeSync`)는 `isYouTubeStartSyncOwned`로 옛 합성과 같은 주인 질의를 같은 순서로 묻는다(실행 protocol, 그다음 복구 pending). 실행이 protocol을 놓는 때는 `zero-start.ts:862-870`의 보정 창 끝이고 이 열차에서 바뀌지 않았다. 그래서 옛 게스트가 하트비트를 받는 시점이 같고 #14 틈은 넓어지지도 좁아지지도 않는다. T0b Standard 참값표의 beatHeld·owned 열과 T0a Standard 와이어·시각 골든이 그대로다                                                                                                                                                                     |
| (b) 옛 방장과 6B 게스트            | 옛 방장의 코호트 문 `canBeginHostTransition`(`zero-start.ts:510-523`)은 게스트가 지금 연결에서 광고했는지만 보고 저장한 `ready`·`platform`(`:500`)을 읽지 않는다. 첫 CAPABILITY는 `network:peer-connected`(`player.ts:4735-4740`)에서 나가고 `advertiseCapability`(`zero-start.ts:468-494`)는 (방장, 플랫폼, ready)가 같으면 다시 보내지 않는다. 6B는 준비 이벤트를 내는 곳(17)과 그 시점, 듣는 곳(`player.ts:3174`)과 광고 경로(`:2832-2836`)를 바꾸지 않고 장부는 이벤트를 내지도 합치지도 않으므로 CAPABILITY 시각이 같다. 미뤄진 경우(첫 광고가 준비 이벤트로 미뤄짐)도 T0a CAPABILITY 시각 골든이 그대로 고정한다 |
| (c) 6B 방장의 보조 `YOUTUBE_STATE` | 억제 창(`iframe.ts:3368`)은 `isYouTubeStartRoomStateHeld`(실행 protocol, 그다음 레거시 Stage-2 대기)로 바꾸기 전의 `isYouTubeZeroStartProtocolActive() \|\| isYouTubeAutoSyncPending()`와 같은 질의를 같은 순서로 묻는다. 창이 같으므로 옛 게스트가 '방장 일시정지'로 읽을 새 프레임이 생기지 않는다. T0b 참값표의 auxHeld 열과 그 와이어 효과 행, T0a 골든이 그대로다                                                                                                                                                                                                                                                 |
| PRO 방의 옛·새 기기                | 장부는 PRO arm을 읽기만 하고 몰지 않는다. PREPARE·READY·COMMIT은 서버를 거치고 서버는 바뀌지 않으며, T0a PRO READY 시각 골든(10 / 10)과 T0b PRO 참값표(19 / 19)가 그대로다                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 바닥 795 아래의 열린 세션          | 바닥은 열린 세션을 닫지 않는다. 6B는 프레임을 얼려 그 위험을 더하거나 줄이지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

결과가 다르더라도 '방이 zero-start 대신 레거시로 시작' 같은 품질 저하이고 재생이 멈추지는 않는다고 본다(계획 §5, 추론). (a)와 (c)는
[추론]이고 T0a·T0b 표가 같으면 생기지 않는다.

## D4 다시 재기 (Phase 4의 재정렬 사슬)

계획 §4.7 6B-2와 로드맵 부록 D4('Phase 6 re-baselines Phase 4')대로 다시 쟀다. 모두 그대로다.

- **`guestRendezvousSync` 허용 목록:** 가드가 아니라 레지스트리 문장(RO-05 'Allowed requesters', 'Single-shot callers')뿐이다. 운영
  호출자는 바탕과 브랜치 끝이 같다: `src/player/background-return-sync.ts:128`, `src/player/local-output-rejoin.ts:228`,
  `src/ui/manual-sync-overlay-runtime.ts:425`, `src/youtube/iframe.ts:2709`, `:3957`, `src/youtube/sync.ts` 일곱(`:899`, `:1020`, `:1077`,
  `:1084`, `:1126`, `:1369`, `:1474`, 바탕보다 2 ~ 3줄 위). 바뀐 것은 그 안의 소유 질의가 장부 질의 `isYouTubeStartSyncOwned`가 된 것뿐이다
  (`guestRendezvousSync` 첫 문 `sync.ts:1764`).
- **pause 규칙과 앵커:** 두 사슬은 그대로 `youtube:set-local-paused`에서 끝난다(`background-return-sync.ts:155`, `local-output-rejoin.ts:408`,
  두 파일의 그 줄은 바탕과 같음). RO-05의 앵커 시험과 교차 흐름 하네스(`local-output-realign-cross-flow.test.ts`, 정의 13, 실행 25,
  `sync.ts`를 mock하지 않음)가 25 / 25, `background-return-sync.test.ts` 38 / 38, `local-output-rejoin.test.ts` 164 / 164로 통과한다(옮긴
  커밋들에서, QA 라운드 4). `local-output-rejoin.test.ts`는 `sync.ts`를 통째 mock하므로 6B-2의 `sync.ts` 변화를 보지 못하고, 그 몫은 교차
  흐름 하네스가 진다.
- **레지스트리:** RO-05와 RO-48은 바뀌지 않았다(`git diff dda3ee18..48bc3819 -- docs/design/resource-ownership-registry.md`는 RO-02 기록과
  가드 절에만 닿음). 바꿀 것이 없으므로 이 열차에서 고치지 않는다(계획 RT-11).
- **장부를 불러오지 않는 묶음:** 교차 흐름 하네스는 `player.ts`를 불러오지 않아 claim이 없고, 그래서 모든 파생 질의가 거짓이다(6B 앞
  zero-start 파사드가 거짓이던 것과 같음). 이 하네스의 행은 사슬의 동작을 보이고 문의 엮음은 장부 시험, 참값표, 도달 행이 본다(설계 문서
  Verification). `player.ts`를 행 안에서만 가져오는 묶음은 공유 `beforeEach`에서 가져와야 순서와 무관하다(위 '시험 순서 의존 고침').

## 되돌리기

기본은 더 높은 SemVer·epoch의 앞으로 고치기다. 새 되돌리기 경계는 없다: 계약 표지, D1, 저장 모양, 바닥을 바꾸지 않아 forward floor가
생기지 않는다.

- **실패 자동 복구:** target `app`의 실패 복구는 릴리스 안에서 checkpoint의 App(dispatch 때의 운영 App)으로 간다. 지금이면 9.0.31 / v804
  (앱 글꼴 줄 상자 굽기와 탭 제목, 빌드 804, App 버전 `dff554a2`, 배포 SHA `ba28943e`, Release 41315218029)이다. 바닥 795 이상이라 `lower`가 필요 없고, 와이어가
  같아 되돌린 App과 6B가 섞인 방도 같은 프레임을 같은 시각에 보낸다.
- **손 되돌리기:** 배포 뒤 checkpoint App으로 가는 손 되돌리기는 6B를 받은 클라이언트에 낮은 epoch를 돌려주므로 release-record §2 9.0.29
  절의 열린 항목('낮은 epoch로 가는 App 손 되돌리기의 규칙', 결정 전)과 `docs/hotfix-procedure.md`를 따른다. 결정 전에는 6B만 빼는 다음
  번호의 코드 되돌리기가 기본이고, 급할 때만 명시적으로 검토한 CLI 되돌리기다.
- **혼자 되돌릴 수 있는 기간:** 6C가 머지되기 전까지다(계획 §4.7, 라운드 2b 계4: 6C-1 라우터가 6B-1 장부 claim으로 갈린다). 그 뒤에는
  6B부터 가장 최근 열차까지 앞으로 되돌린다: 새 `agent/` 갈래에서 그 열차들의 커밋을 거꾸로 되돌리고, 다음 SemVer·epoch(버전 거울 여섯과
  `index.html`의 bootstrap 캐시 쿼리), 전체 게이트, App 릴리스, 기록. 앞으로 되돌리기와 앞으로 고치기는 각각 업데이트 창 하나를 Q1의 넷
  밖으로 더한다. 앞쪽도 같다: 6B가 머지되면 9.0.31 열차와 6A는 더 이상 혼자 되돌릴 수 없다(release-record §2의 9.0.31 절과 6A 절의 되돌리기).
- **되돌릴 때 가드와 시험:** 6B 커밋들이 CHECK 12 규칙·기준치와 레지스트리 RO-02를 같은 커밋에서 옮겼으므로 되돌리면 함께 돌아온다.
  CHECK 12 후속 둘(`9a56095d`, `027b5036`, `2920a863`, `0d9d55c8`)만 남기고 6B-2를 되돌리면 파사드 쓰기 규칙이 바탕 트리처럼 실패하므로
  (위 '정확한 개수 가드') 후속도 함께 되돌린다. 6B-2를 되돌리면 T0b 파일 11개의 이음새도 main의 모양으로 돌아간다. 시험 순서 고침
  (`418b411d`)은 남겨도 되돌려도 행이 같다(6B 앞에는 `iframe.ts`·`sync.ts`가 파사드를 바로 읽었음).

## 머지 전에 할 일 (릴리스 담당)

처음 납품이 적은 셋과 9.0.31이 먼저 나가 생긴 둘이다.

1. **끝남: 시험 순서 의존 고침.** `418b411d`(위 '시험 순서 의존 고침'). 두 묶음 seed 1 ~ 32 425 / 425, 세 디렉터리 seed 여섯 6,515 / 6,515.
2. **끝남: main 위로 옮기기.** T0b 시험만 PR 둘(#552, #553)과 #554가 들어간 main `dda3ee18` 위로 옮겼고, 옮긴 테스트 먼저 커밋을 새 부모에서
   다시 돌려 같은 이름의 행만 실패함을 봤다(위 '증분 한눈에', QA 라운드 4). 9.0.31의 머지 `ba28943e` 위로 다시 옮기고 같은 확인을 했다(QA
   라운드 6).
3. **싣지 않음: T0b 결함 넷째(방장이 일시정지할 때 일시정지 신호가 참가자에게 두 번 가는 경우가 있음, H10, H10a, H10c 행).** 오너 답이
   없어 6B는 이 고침 없이 나간다. 머지·배포의 조건이 아니다(아래 '오너에게' 1).
4. **끝남(머지 조건): 9.0.31의 머지 뒤 Full E2E.** [41315565486](https://github.com/hiefny/MUSIXQUARE/actions/runs/41315565486)(main
   `ba28943e`)이 통과했다(2026-11-02 00:29 KST에 끝남, 계획 §1.4, 아래 '배포 조건과 순서' 2, QA 라운드 8).
5. **끝남(머지 조건, 문서만): 9.0.31의 배포 기록 위로 다시 옮기기.** 그 기록 PR #556이 `5a705c40`으로 main에 들어왔고 이 열차의 커밋 스물을
   그 위로 옮겼다. 충돌은 릴리스 준비 기록 커밋 하나의 `docs/release-record.md`뿐이었고(양쪽 남김), 커밋마다 패치가 그대로이며 `docs/` 밖
   트리가 버전 올리기 `8823a591`과 같아 첫 로딩도 같다(아래 '배포 조건과 순서' 1, QA 라운드 8).

## 배포 조건과 순서 (릴리스 담당)

release-record §2 맨 위의 이 열차 절이 같은 조건과 그 결과를 적는다(배포 뒤 항목, QA 라운드 9).

1. 한 번에 한 열차, main 런타임이 배포본과 같을 때만: 지금 main `5a705c40`은 9.0.31의 배포 기록(#556, 문서만)이라 그 런타임이 운영 App
   9.0.31 `ba28943e`와 같다. 이 열차는 그 위로 다시 옮겼고(QA 라운드 8, 충돌은 `docs/release-record.md`뿐), 커밋마다 패치가 그대로이고
   `docs/` 밖 트리가 버전 올리기 `8823a591`과 같아 첫 로딩도 같다. 머지 전에 main이 또 움직이면 다시 옮기고, main이 런타임으로 움직이면 QA 라운드 6처럼 테스트 먼저와 크기를 다시 잰다. 이 배포까지 런타임 의존성
   변경(Dependabot 포함)을 머지하지 않는다.
2. 9.0.31 런타임의 머지 뒤 Full E2E(계획 §1.4): [41315565486](https://github.com/hiefny/MUSIXQUARE/actions/runs/41315565486)(main `ba28943e`,
   2026-11-01 23:18 KST dispatch)이 통과한 뒤에만 머지한다. 채워졌다: 세 job(`e2e`, `webkit-mobile`, 운영 large-room R2 smoke)이 모두 success로
   2026-11-02 00:29:29 KST에 끝났다(9.0.31 기록 #556의 §1: `e2e` 812 passed, `webkit-mobile` 94 passed·5 skipped와 운영 빌드 SW 시험 1, R2
   smoke 1, 실패와 불안정 표시 없음, QA 라운드 8).
3. 버전 올리기 커밋(마지막 런타임 커밋, 계획 6B-3): 9.0.31 / v804 → 9.0.32 / v805를 9.0.31의 버전 올리기(#555 squash `ba28943e` 안의
   `566f458d`)와 같은 거울 여섯 파일 일곱 줄에 적는다(`package.json`, `package-lock.json` 두 곳, `ADMIN_SCRIPT_VERSION`,
   `ADMIN_ASSET_VERSION`, `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 캐시 쿼리). 그 머리에서 typecheck, lint, `format:check`,
   `build:checked`(그 안의 `guard:sw-cache-version` PASS v805와 `guard:release-identity` 9.0.32 / v805), 모든 `guard:*`, 자원 소유권, 핵심·Worker
   커버리지, 단위 전체, `build:e2e` 뒤 critical E2E와 로컬 YouTube spec, `build:checked` 산출물의 후보 E2E, 배포 대상(App뿐). 첫 로딩(진입,
   eager JS, eager 전체 gzip)은 origin/main보다 위 '번들 크기'의 6B 차(eager JS −34 B, eager 전체 −31 B, 진입 gzip −40 B)를 넘어 늘지 않아야
   한다. 계약 동결: 바탕 main..머리의 `cloudflare/` 차이가 `cloudflare/app-worker.ts`의 버전 한 줄뿐인지 본다. `8823a591`에서 모두
   채웠고(QA 라운드 7), `5a705c40` 위로 옮긴 버전 올리기 `582ab9d9`(같은 패치)의 머리에서 런타임 트리가 같음을 보고 타입, lint, 형식,
   `build:checked`, 모든 가드, 자원 소유권, 6B와 T0a·T0b 시험 파일을 다시 돌렸다(QA 라운드 8).
4. 문서(계획 6B-3, RT-04, RT-15, §4.2-7): release-record §2에 이 열차의 '배포 전' 항목(이 보고서 링크, 오너 답과 위임, T0b 결함 목록의 상태,
   배포 조건, 되돌리기, 배포 뒤 확인, 열린 항목)과 6A 절의 다음 단계 항목, `docs/README.md`. 레지스트리 RO-02의 장부·독자 문장, 설계 문서,
   QA053 링크는 이미 이 브랜치에 있다. 계획 §6이 적은 Phase 6의 열린 항목(YouTube 첫 음 정렬, PRO 시작 시계 현장 확인, YouTube 재합류 동기화,
   Android YouTube 출력 정렬 현장 확인)은 6B가 닿지 않아 고치지 않는다. known-accepted #14의 확인 문장은 그대로다. 기기 근거 없이 열린 항목을
   지우지 않는다.
5. PR CI, 자동 코드 리뷰, dispatch 직전 머지, exact-main CI success 뒤 Release target `app`, Developer API D1 false,
   `raise_app_build_floor` false. 기록 PR을 열차 PR 머지와 deploy job 시작 사이에 머지하지 않는다.
6. 배포 직후(게이트 아님): 공개 최소 빌드 상태(저장·유효 795, live App 805)와 Operations Drift Audit, 아래 '배포 뒤 확인'. 머지 뒤 main
   SHA에서 Full E2E를 한 번 돌려 보고서의 QA 라운드에 적되 exact-main 후보로 쓰지 않는다(계획 §4.2-5). 다음 열차(6C)는 그것이 통과한 뒤에만
   머지한다. 실패하면 그 spec을 `ba28943e`(위 2로 통과한 9.0.31 런타임의 기준)에서 다시 돌려 6B의 회귀와 일시적 실패를 가른다.
7. 배포 기록 PR: release-record §1과 `Last source review` 덮어쓰기, `docs/release-history.md` 한 행, §4의 이 릴리스 항목, 다른 항목의 다음
   되돌리기 번호를 9.0.33 / v806으로, §2 맨 위 9.0.31 절을 가리키는 15곳(§1 8곳은 덮어쓰기로 사라짐, §2 4, §4 2, 9.0.31 보고서 머리
   1)을 '§2 9.0.31 절'로, `docs/hotfix-procedure.md`의 9.0.25 항목 끝에 9.0.32(빌드 805, 이 릴리스의 merge·Release·App 버전)가 9.0.31을
   이었다는 문장, §2의 이 항목을 '배포 뒤 확인'으로, 이 보고서의 상태를 배포 뒤로.

결과(QA 라운드 9): 1 ~ 7을 채웠다(6의 블라인드 배포 뒤 확인은 게이트가 아니고 아직이다, 아래 '배포 뒤 확인'). 2026-11-02 05:21 KST에 squash `3ea689b9`로 머지하고 exact-main CI 41346450901 뒤 05:34 KST에
Release 41347347201로 배포했으며, 배포 기록 PR이 7을 적었다. 6의 공개 최소 빌드 상태(저장·유효 795, live App 805)와 Drift Audit
41347664673(32 pass / 0 fail / 5 manual-only)은 봤고, 머지 뒤 Full E2E 41347667125는 통과했다(06:43:44 KST에 끝남). 그래서 다음 열차(6C)를 머지하기 전의 앞 열차 Full E2E 조건이 채워졌다.

## 배포 뒤 확인 (블라인드, 게이트 아님)

9.0.32는 2026-11-02 05:34 KST에 나갔고(QA 라운드 9) 앱 정보의 버전은 9.0.32, 빌드 805다. 이 기록까지 아래 확인은 하나도 하지 않았다(오너가 돌아온 뒤에 함). 계획 §4.7의 기기 후보(QA053, QA054, 절차는 영역 조사 pro-and-iframe-audio §4.5)다. 확인하는 사람에게는 '절차'만 주고 기준은 주지 않으며,
받은 관찰값을 여기 기준과 견준다. Phase 6 앞의 기준선(Q6)은 재지 않았다. 옛·새 빌드를 섞어 시작하는 기기 행은 두지 않는다(혼합 버전
근거는 T0a 프레임·시각 골든, P5-D9 C, 계획 §4.7). 기기가 없는 단계는 건너뛰고 '기기 없음'으로 적는다.

**절차(확인하는 사람에게 주는 것, 약 25분):** 두 기기 모두 같은 앱 버전(앱 정보의 버전 번호를 적음)이고 주소 끝에 `?mxqrLog=debug`를 붙여
연다. 새로 고치거나 다시 들어갈 때도 다시 붙인다. 각 단계 뒤 채팅에 `/debug console`을 입력하고 `[YouTube`로 시작하는 줄을 시각과 함께
복사한다.

- **A. 시작 직후 동기화(약 10분):** (1) 데스크톱 Chrome을 방장으로 일반방을 만들고 Android Chrome을 게스트로 넣는다. 재생목록에 YouTube
  트랙 둘을 넣고 볼륨은 둘 다 50. (2) 방장이 첫 트랙을 누른다. 게스트에서 소리가 난 직후(1 ~ 2초 안) 게스트가 동기화 버튼을 한 번 누르고,
  뜬 안내 문구를 그대로 적는다. 버튼이 흐린 모양이었는지도 적는다. (3) 5초 뒤 다시 한 번 누르고 무슨 일이 있었는지(소리 끊김, 위치 이동,
  안내) 적는다. (4) 다음 트랙으로 (2) ~ (3)을 한 번 더 한다.
- **B. 시작 소유 줄(약 10분):** A의 각 시작에서 방장의 `[YouTube ZeroStart] prepare-host`, `armed-guest`, `Playback released` 줄과 게스트의
  `waiting-ready`, `timeline-0.8s`, `timeline-2.0s` 줄(값 `timelineDriftMs`, `estimatedAudibleErrorMs` 포함)을 복사한다. 시작이 들리는
  순간에 두 기기의 소리가 맞았는지(맞음, 조금 어긋남, 많이 어긋남) 적는다.
- **C. 시작 직후 seek와 볼륨(약 5분):** 방장이 트랙을 시작하고 소리가 난 직후 1초 안에 재생 위치 막대를 트랙 중간으로 옮긴다. 게스트가
  따라오는지, 끊김이 있었는지 적는다. 이어 방장이 다음 트랙을 누르고 소리가 나기 전에 게스트가 볼륨을 0으로 내렸다가 2초 뒤 50으로 올린다.
  예열 소리가 샜는지, 소리가 돌아왔는지 적는다.

**통과 기준(주지 않음):**

- A: 첫 누름은 보정 창(시작 뒤 약 2.75초) 안이면 흐린 버튼과 '아직 준비 중이에요' 안내, 그 직후면 '방장의 재생 정보가 없어요' 안내가 뜰 수 있고
  저절로 다시 시도하지 않는다(known-accepted #14, 오늘과 같음). 둘째 누름은 보통 진행한다. 누르지 않았는데 소리가 튀지 않는다.
- B: 방장에 `prepare-host`, `armed-guest`, `Playback released`가 있고 게스트에 `timeline-0.8s`와 `timeline-2.0s`가 있으면 zero-start로
  풀린 것이다. 어느 기기에도 `[YouTube ZeroStart] audio-restore-timeout` 경고가 없다. `Falling back to legacy rendezvous`는 실패로 보지 않고
  적는다(느린 망에서 레거시가 이어받은 경우). 소리는 귀로 맞는다.
- C: 방장의 seek는 게스트에 전해져 게스트가 몇 초 안에 새 위치로 따라온다(오늘 동작). seek가 무시되거나 방이 멈추면 실패다. 볼륨을 바꾸는
  동안과 트랙이 시작되기 전에 예열 소리가 새지 않고, 트랙이 시작되면 마지막 설정(50)으로 들린다(hard-mute 주인이 있는 동안의 unMute 가드가 장부
  질의로 옮겼으므로 보는 단계).

**실패하면:** 일시적 네트워크로 설명되지 않는 어긋남이면 위 '되돌리기'대로 앞으로 고치기나, 급할 때만 명시적으로 검토한 CLI 되돌리기로
checkpoint App(9.0.31)을 정한다. '기기 없음'과 '미확인'은 실패가 아니다.

## 사용자가 알아챌 변화

없다. 버전 올리기와 함께 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 둘째, 창 모양은 지금 그대로). 처음 받는 코드는 gzip 기준 JS 34 B, 전체 31 B
줄어든다(운영 9.0.31 그 자체인 바탕 대비, 버전 올리기 앞, 위 '번들 크기'. 옮기기 전 9.0.30 바탕 대비로는 53 B, 54 B).

## 기록과 레지스트리

- 이 브랜치: 설계 문서 `docs/design/youtube-start-ownership.md`(Accepted, 6B-1, 6B-2, 후속 둘과 메모에서 고침)와 `docs/README.md` 설계 목록,
  QA053, 레지스트리 RO-02(장부, 허용 요청자가 장부 질의, CHECK 12 절, 허용 합성의 claim과 결정한 종류의 등록)와 가드 항목 12, '아직 검사
  안 함', 핵심 커버리지 등재, 이 보고서와 `docs/README.md` 증거 목록. 모두 센 코드나 규칙을 옮긴 커밋과 같은 커밋이다(이 보고서만 기록
  커밋이고, 마지막 기록 커밋은 설계 문서의 독자 행 문장도 고친다).
- RO-05, RO-48은 그대로다(위 'D4 다시 재기'). RO-02의 상태는 `duplicated` 그대로다(레거시 복구와 교체 대체가 아직 주인 단계가 아님, 6C ·
  6D). 레지스트리 머리의 `Last source review`는 기록을 코드와 다시 맞추는 PR이 고친다.
- 릴리스 담당이 버전 올리기 앞 기록 커밋에서: release-record §2의 6B '배포 전' 항목, 6A 절의 다음 단계 항목, `docs/README.md`의 이 보고서
  항목(위 '배포 조건과 순서' 4). 배포 뒤 기록 PR이 그 항목을 '배포 뒤 확인'으로 바꿨다(같은 절 7, QA 라운드 9).

## 오너에게

1. **[화면 바뀜: 고치면 참가자 YouTube 화면이 같은 자리로 다시 맞추는 횟수가 2번에서 1번으로] 방장이 일시정지할 때 일시정지 신호가
   참가자에게 두 번 가는 경우가 있어요. 고칠까요?** 2026-11-01에 따로 여쭌 결함 넷 가운데 넷째예요. 일반방 방장이 YouTube 트랙을 불러온 뒤
   첫 일시정지와, 재생 중 방장 YouTube 화면이 잠깐 끊겼다가(버퍼링) 이어진 뒤의 일시정지에서 참가자 기기가 이미 멈춘 화면을 같은 자리로
   한 번 더 맞춰요. 멈추는 때와 자리는 같고, 다시 재생한 뒤 하는 일시정지는 한 번만 가요. 답을 아직 못 받아 6B는 이 고침 없이 나가요
   (화면·소리를 바꾸지 않는 정리만 담음).
   - (가, 권장) 고친다: 다음 App 업데이트(6C나 6D)에 실으면 업데이트 창은 늘지 않아요. 만들기 전에 짧은 화면 녹화나 전후 시각 표를 먼저
     보여 드려요.
   - (나) 지금은 기록만 한다: 오늘 동작 그대로 시험에 고정돼 있어요.
2. **[화면 그대로] 첫 로딩 크기: 정하실 것은 없어요.** 6B는 앱을 처음 열 때 받는 양을 압축 기준 34바이트 줄여요(지금 운영 중인 9.0.31
   대비). Phase 6 전체로는 6A와 합쳐 183바이트 줄었고, 상한(늘어남 200바이트)과 멀어요.
3. **[화면 그대로] 6B를 언제 낼지: 정하실 것은 없어요. '자동 관문을 모두 통과하면 9.0.32로 낸다'로 진행해요.** 정하신 순서대로 글꼴 줄
   상자 고침(9.0.31)이 먼저 나갔고(11-01 23:17), 6B는 그 위로 옮겨 다시 확인했어요. 9.0.31 뒤에 돌린 자동 전체 화면 시험도 통과했어요(11-02
   00:29). 남은 자동 검사(PR 검사, 자동 리뷰, 머지한 main의 검사)를 통과하면 내요. 화면과 소리는 그대로이고 업데이트 창만 한 번 떠요(Phase 6 넷 가운데 둘째). 자리를 비우신 동안 맡기신 대로 릴리스 담당이 정해요.
   6B에 문제가 있어 되돌리면 9.0.31의 앱으로 돌아가요. 11-02 05:34에 9.0.32로 나갔어요(QA 라운드 9).

## QA 라운드

모두 Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, `--maxWorkers=4`(따로 적은 것 말고).

### 1. 옮기기 전 증분별: 테스트 먼저 다시 돌림 (처음 납품, 이 브랜치에 없는 커밋)

2026-11-01 16:01 ~ 16:15 KST, 다른 Windows PC에서 바탕 `9e72b7ce`(T0b가 main에 들기 전) 위 납품 커밋을 임시 detached worktree에서 다시 돌렸다. 옮긴 커밋과의
대응: `a686284a` → `bd0dd536`, `5300f565` → `5c43edd2`, `44a85664` → `371a520c`, `4d3ba199` → `ca883e29`, `cc03ecd8` → `9a56095d`,
`b1db3cc7` → `421cc056`, `acc2e755` → `027b5036`, `07a9f224` → `c5f7ed17`, `691d8fb6` → `6aee97c3`. 시험 밖 운영 코드는 짝마다 바이트로
같다. 이 라운드의 수는 옮기기 전 T0b 위의 값이라 라운드 4의 수가 대신한다.

- `a686284a` 17 / 1,809 실패 → `5300f565` 1,819 / 1,819(32 files). `44a85664` 27 / 2,068 실패 → `4d3ba199` 2,068 / 2,068(36 files).
  `cc03ecd8` 12 / 91 실패 → `acc2e755` 91 / 91. `b1db3cc7` 5 / 5, 바탕 `9e72b7ce`에서도 5 / 5. 중립 고정 30 파일(그때 T0b 참값표 37행, 12행)은
  네 부모와 네 코드 커밋에서 모두 통과했다.
- 변이 확인(`07a9f224`): 위 6B-2와 '독자 창 고정'의 결과. 파일을 바꿔 돌리고 되돌렸다.

### 2. 옮기기 전 마지막 검사 (처음 납품의 끝 `07a9f224`)

2026-11-01 15:46 ~ 16:40 KST, 라운드 1과 같은 PC에서. 이 브랜치에 없는 커밋이다(운영 코드는 브랜치 끝과 같음). 단위 전체 739 files 17,651 통과와 1 건너뜀, shuffle
(`src/youtube`, `src/player`, `src/pro-room`) seed 31, 4242, 20261030 통과와 **seed 7에서 `stale-async-guards.test.ts` 두 행 실패**(위 '시험
순서 의존 고침'의 출발점), typecheck·lint·format 통과, `build:checked` 25 단계 가운데 `guard:sw-cache-version`만 실패(버전 올리기 대기),
`guard:*` 37 가운데 36 통과, 핵심 커버리지 99 files / 4,022, Worker 커버리지 69 / 3,325, `test:e2e:critical` 101 / 101, YouTube spec 열 개 53 / 53.
번들 크기는 위 표와 같다. 이 라운드의 수는 라운드 4가 브랜치 끝에서 다시 쟀다. 지금 가드를 6B 앞 운영 코드(`9e72b7ce`)에 돌린 파사드
결과(위 'CHECK 12 후속')도 이 라운드다.

### 3. 독립 검토 (`418b411d`, 임시 사본, 갈래와 worktree는 그대로)

옮긴 뒤 `418b411d`에서 브랜치를 바꾸지 않는 임시 사본으로 한 검토다(사본은 지움).

- **중립:** 대상 45 파일 가운데 29개가 main과 바이트로 같다(두 참값표, `fake-yt-player.ts`, T0a 골든 모두). 다른 16개의 차이는 mock이나 호출
  단언 대상을 장부 claim으로 옮긴 짝, 열이나 술어를 옮김, 대역 claim 등록, 지운 export와 함께 지운 고정, 주석뿐이다. 기대 배열, 강제 값,
  동작 단언은 바뀌지 않았다. 운영 코드는 납품 `691d8fb6`과 바이트로 같다.
- **실행:** 대상 45 files / 2,373행 파일 순서 통과, 참값표 81 / 81(U1 ~ U14, P6p, P9, P10, 비동기 전달 a 변형, H13·H12b 포함). `src/ui`, audio,
  demo, chat, rooms, media, share, diagnostics를 shuffle seed 3과 7로, core, storage, account, developer-api, workers를 seed 3으로 돌려 `.git`
  디렉터리가 필요한 시험 말고는 실패가 없었다. `stale-async-guards`와 `sync-integration`은 seed 1 ~ 32 모두 425 / 425.
- **변이 31개:** 파생 질의마다 claim 하나를 뺀 것(L1 ~ L11), `player.ts` 등록(G1 ~ G5: pro-arm 없음, legacy 없음, 복구 active와 pending 바꿈,
  inFlight를 protocolActive로, 실행을 hard-mute로 등록하지 않음), 출시 앞섬 스냅샷 빼기(S1: `player.test` 21행과 가드 STALE BASELINE),
  독자를 실행 파사드로 되돌리기(R2, R6, R7: 가드 RATCHET REGRESSION과 행), 독자를 틀린 장부 질의로 바꾸거나 빼기(R1, R3, R4, R5, R9, R11,
  R12), unMute 가드 둘을 하나씩(R10, R13, R14, R15)이 모두 잡혔다. 살아남은 것은 작은 drift 표본의 timeline 보류 피연산자를 지운 하나로,
  같은 조건이 묻는 `isGuestYouTubeTransitionPending`이 이미 덮는 남는 조건이다(main에도 같음, 6B 회귀 아님).
- **가드:** `--report` 수가 코드와 같다(파사드 쓰기 2, 스냅샷 읽기 8, 합성 1). 심은 위반은 모두 닫힌 채 실패했다. 찾은 틈 둘(허용 합성의
  claim, 빠진 등록)은 위 'CHECK 12 둘째 후속'이 닫았다.
- **커버리지:** 핵심 커버리지 99 files / 4,051, `zero-start.ts` 85.79 / 84.18 / 98.4 / 89.41(문턱 84 / 83 / 96 / 88). `tsc --noEmit`과
  `tsc -p tsconfig.test.json` 종료 코드 0.

### 4. 옮긴 뒤 검사 (바탕 `dda3ee18`, 브랜치 끝 `48bc3819`)

2026-11-01 19:31 ~ 21:07 KST. 증분별 재실행과 seed는 바탕 `dda3ee18`에서 만든 임시 detached worktree(이 갈래 worktree의
`node_modules`를 연결, 같은 툴체인)에서 커밋마다 바꿔 돌렸고 끝난 뒤 깨끗했다. 마지막 검사는 이 갈래의 worktree에서 브랜치 끝 `48bc3819`
(운영 코드는 `418b411d`와 같고, 그 뒤 커밋은 가드 스크립트, 가드 시험, 문서만 바꿈)에서 했다. 같은 PC에서 다른 worktree의 vitest와
Playwright가 함께 돌았다. 앞뒤로 작업 트리는 깨끗했다.

- **증분별 테스트 먼저:** 위 '증분 한눈에'. 중립 고정 38 파일(T0b 시험 18 파일, T0a `standard-start-wire-golden` 16,
  `pro-ready-timing-golden` 10, `youtube-start-owner-boundary` 24, `youtube-audio-restore-cadence` 58, `youtube-quoted-log-lines` 13,
  `youtube-room-switch-trace` 6, `youtube-timer-owner-queries` 49, `youtube-owner-visibility` 8, `standard-start-pause-teardown` 14,
  `start-timing-parity` 10, `pro-start-kind-endpoint` 6, `pro-late-prepare-reload` 7, `playback-late-cohort-join` 8, D4 셋
  `local-output-realign-cross-flow` 25, `background-return-sync` 38, `local-output-rejoin` 164, 그 밖 `zero-start` 159,
  `zero-start-fallback-ownership` 9, `authority-arm` 82, `native-control-owner-ports` 10, `network/protocol` 81)은 2,157행이고 네 부모와 네
  코드 커밋에서 모두 통과했다. T0b 참값표는 Standard 62, PRO 19.
- **시험 순서:** 위 '시험 순서 의존 고침'의 seed 결과.
- **fallbackPending 열 견주기:** `player.ts`의 복구 pending 질의를 전역 훅으로, 표본기에 그 값과 열 값을 적는 코드를 임시로 넣고 두 참값표를
  돌렸다(81 / 81). 표본 47,600개 넘게에서 둘이 어긋난 것은 없고, pending 참 1,582개는 모두 실행이 in flight가 아니었다. 두 파일은 바로
  되돌렸다(위 'T0b 파일').
- **단위 전체(파일 순서):** 739 files, 17,704행 가운데 17,701 통과, 0 건너뜀(이 PC에는 jq가 있어 처음 납품에서 건너뛴 jq 행도 돎). 실패 3은 모두 git
  fixture 행의 시간 초과다(`release-deployment-state.test.ts` 1, `sw-cache-version-guard.test.ts` 2, 15 s 문턱). 같은 시각 다른 worktree가
  `sw-cache-version-guard.test.ts`와 Playwright를 돌렸고, 앞선 전체 실행(19:42 ~ 19:53, 이 검사의 다른 실행과 겹침)에서는 같은 두 파일의 다른
  행 다섯이 같은 식으로 시간 초과였다. 두 파일만 `--maxWorkers=1`로 다시 돌려 157 / 157 통과했다(`--maxWorkers=4`로는 다시 다른 행 둘이 시간
  초과). 6B는 이 두 파일이 보는 릴리스 도구를 바꾸지 않는다. 9.0.8 방장 스피커 시험, 장부 34 / 34, 독자 창 5 / 5, 가드 94 / 94는 통과했다.
- **shuffle(`src/youtube`, `src/player`, `src/pro-room`, seed마다 한 번):** 239 files, 6,515행. seed 3, 6, 7, 31, 4242, 20261030 모두 실패 0.
- **`npm run typecheck`**(전체 사슬, 78 s), **`npm run lint`**(app과 tooling, 117 s), **`npm run format:check`**(45 s): 모두 종료 코드 0.
- **`build:checked`의 25 단계를 하나씩:** `guard:sw-cache-version` 하나만 실패했다(위 'Version'의 글 그대로, App 11 파일). 나머지 24 단계는
  통과했다: authored JS 둘(0 remaining, 107 retired; 0 inline), TypeScript project coverage 1,564 files / 19 projects, classic runtime 15,
  auxiliary browser 2, service worker(v803), UI kit 10, release identity 'MUSIXQUARE 9.0.30; service-worker cache epoch v803', brand
  capitalization 1,035, declaration ownership 10, source complexity, room authority(79 / 22 / 13 / 0 / 0, 410 files), profanity, hreflang 43,
  sitemap 93, `npm run build`, legacy TV(Chromium 79, `main-jdcp8EDh.js`), service worker build(v803, 바이트 동일), UI kit build, initial
  transfer budget, prod hooks, prod security, 글꼴(Inter와 Noto, 44 stacks), SW 앱 셸 96 assets.
- **그 밖 `guard:*` 13개도 모두 통과**(`package.json`의 `guard:*` 37개 가운데 실패는 위 하나): bus-pairing 202 / 202, chunk-pump,
  transport-health(12 files), import-graph(410 files, 2,101 edges, 순환 0), lifecycle-writes, navigation-sinks, dead-exports(410 / 2,161 / 0 /
  20 / 76), font assets, standard-room hot path, Developer API boundaries, D1 migrations(19), ops drift contract, Playwright API.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 위 '정확한 개수 가드'(49 records, 457 production files, `--report` 119줄).
- **크기:** 위 '번들 크기'(바탕, 6B-1, 6B-2는 임시 worktree의 `npm run build`, 끝은 `build:checked`의 빌드).
- **`npm run test:coverage:critical`:** 99 files / 4,051 통과, 전체 84.1 / 79.46 / 89.98 / 87.8(문턱 73 / 66 / 80 / 78), 파일별 문턱 오류
  없음(60 s). 장부는 lcov로 함수 20 / 20, 줄 18 / 18, 분기 3 / 3(문턱 99), `zero-start.ts`는 85.79 / 84.18 / 98.4 / 89.41(문턱 84 / 83 / 96 /
  88), `iframe-audio.ts`는 함수 7 / 7, 줄 24 / 24, 분기 19 / 19다.
- **`npm run test:coverage:workers`:** 69 files / 3,325 통과, 86.7 / 83.54 / 94.34 / 90.97(68 s).
- **`npm run build:e2e` 뒤 로컬 Playwright(Chromium, 포트 4693 / 9693):** `test:e2e:critical`의 여덟 파일 101 / 101(5.3분), YouTube spec 열 개
  (`e2e/youtube*.test.ts`) 53 / 53(12.5분). 그 가운데 계획 §4.2-3의 여덟(`youtube-sync` 6, `youtube-manual-zero-start` 10, `youtube-output-delay`
  3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1, `youtube-pending-seek` 4, `youtube` 9)은 41 / 41로 6A의
  41과 같고, 나머지 둘(`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은 12 / 12다. 실패, 다시 시도, 불안정 표시는 없다.
- **독자 변이 둘(임시 worktree, 끝에 되돌림):** 위 '독자 창 고정'의 `sync.ts:712`와 `manual-sync-overlay-runtime.ts:363` 결과.
- **배포 대상과 계약 동결:** 위 'Deploy target'.

### 5. 마지막 검사 (`e5851cd0`, 그 뒤는 이 기록 커밋뿐)

2026-11-01 21:15 ~ 22:02 KST, 이 갈래의 worktree에서. 운영 코드는 `418b411d`와 라운드 4의 `48bc3819`와 같고, `e5851cd0`은 이 보고서,
`docs/README.md`, 설계 문서만 바꾼다. 원격 main은 그대로 `dda3ee18`이다. 같은 PC에서 다른 worktree의 Playwright가 함께 돌았다. 검사를
시작할 때 작업 트리는 깨끗했고, E2E가 도는 동안부터는 이 기록 커밋의 보고서 고침만 있었다.

- **단위 전체(파일 순서):** 739 files, 17,704 / 17,704 통과, 0 건너뜀(8.7분). 라운드 4의 git fixture 시간 초과는 이번에 없었다. 그 안에서
  장부 34 / 34, 독자 창 5 / 5, 가드 94 / 94, T0b 참값표 62 / 62와 19 / 19, T0a 골든 16 / 16과 10 / 10, 순서를 고친 두 묶음
  (`stale-async-guards` 182 / 182, `sync-integration` 243 / 243, 9.0.8 방장 스피커 행 포함)이 통과했다.
- **shuffle(`src/youtube`, `src/player`, `src/pro-room`, seed마다 한 번):** 239 files, 6,515행. seed 7, 31, 4242, 20261030 모두 6,515 / 6,515.
- **`npm run typecheck`**(93 s), **`npm run lint`**(134 s), **`npm run format:check`**(46 s): 모두 종료 코드 0.
- **`build:checked`의 25 단계를 하나씩:** `guard:sw-cache-version` 하나만 실패했다(위 'Version'의 글 그대로, App 11 파일). 나머지 24 단계는
  통과했다: release identity 'MUSIXQUARE 9.0.30; service-worker cache epoch v803', service worker(v803), room authority(79 / 22 / 13 / 0 / 0,
  410 files), brand capitalization 1,035, `npm run build`, legacy TV(Chromium 79, `main-jdcp8EDh.js`), initial transfer budget(entry 840.9 KiB
  raw / 247.7 KiB gzip, eager JS 454.5 KiB gzip, eager total 2,000.6 KiB raw / 530.9 KiB gzip), 글꼴(44 stacks), SW 앱 셸 96 assets 등.
  그 밖 `guard:*` 13개도 통과했다: bus-pairing 202 / 202, transport-health(12 files), import-graph(410 files, 2,101 edges, 순환 0),
  dead-exports(410 / 2,161 / 0 / 20 / 76), D1 migrations(19) 등. `package.json`의 `guard:*` 37개 가운데 실패는 위 하나다.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 49 records, 457 production files, CHECK 11 32, CHECK 12 읽기 11·지우기 9,
  파사드 쓰기 2, 스냅샷 읽기 8, 장부 합성 1, CHECK 5 1 / 1 / 45. `--report` 119줄은 라운드 4와 줄마다 같다.
- **크기(`origin/main` 대비):** `dda3ee18`의 트리(`git archive`)를 같은 툴체인으로 따로 빌드한 값과 `e5851cd0`의 `build:checked` 빌드를
  `measureInitialTransfer`로 견줬다. 바탕 `main-zzIxMfb3.js` 860,802 / 253,728, eager JS gzip 465,458, eager total 2,048,366 / 543,651. 끝
  `main-jdcp8EDh.js` 861,056 / 253,678, 465,405, 2,048,620 / 543,597. 차는 eager JS gzip −53 B, eager total gzip −54 B, 진입 raw +254 B, 진입
  gzip −50 B로 위 '번들 크기'와 같다.
- **`npm run test:coverage:critical`:** 99 files / 4,051 통과, 전체 84.1 / 79.46 / 89.98 / 87.8, 파일별 문턱 오류 없음(85 s). 장부는 lcov로
  함수 20 / 20, 줄 18 / 18, 분기 3 / 3, `zero-start.ts`는 85.79 / 84.18 / 98.4 / 89.41(문턱 84 / 83 / 96 / 88).
- **`npm run build:e2e` 뒤 로컬 Playwright(Chromium, 포트 4697 / 9697, trace 끔):** `test:e2e:critical`의 여덟 파일 101 / 101(5.3분), YouTube
  spec 열 개(`e2e/youtube*.test.ts`) 53 / 53(12.4분). 계획 §4.2-3의 여덟(`youtube-sync` 6, `youtube-manual-zero-start` 10,
  `youtube-output-delay` 3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1, `youtube-pending-seek` 4,
  `youtube` 9)은 41 / 41, 나머지 둘(`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은 12 / 12다. 실패, 다시 시도, 불안정
  표시는 없다.
- **중립 다시 보기:** T0b 20 파일 가운데 8개(두 참값표, `fake-yt-player.ts`, `playlist.test.ts`, `load-lifecycle.test.ts`,
  `native-control-iframe-integration.test.ts`, `sync-heartbeat-broadcast.test.ts`, `sync-pro-promotion-offset.test.ts`)와 T0a 골든 둘
  (`standard-start-wire-golden.test.ts`, `pro-ready-timing-golden.test.ts`)은 바탕과 바이트로 같다. 바뀐 T0b 12개와 T0a 도우미
  `standard-start-harness.ts`의 차이를 줄마다 다시 읽었다: mock·대역 등록·도달 단언을 같은 claim의 장부 질의로 옮긴 이음새, 열 지도와 술어,
  지운 다시 내보내기의 단언, 두 묶음의 공유 `beforeEach` 불러오기, 주석뿐이고 기대 배열과 강제 값은 그대로다(위 'T0b 파일').
- **바탕의 Full E2E(6A의 머지 뒤):** [41278378387](https://github.com/hiefny/MUSIXQUARE/actions/runs/41278378387)(`workflow_dispatch`, main
  `dda3ee18`, 14:49:06 KST 생성, attempt 1) success: `e2e`(Ubuntu 러너, Playwright Chromium, 14:49:10 ~ 15:57:03 KST) 794 passed,
  `webkit-mobile`(14:49:09 ~ 14:54:55 KST) 94 passed·5 skipped와 운영 빌드 SW 시험 1 passed, 운영 large-room R2 smoke(14:49:09 ~ 14:50:32
  KST) 1 passed이고 실패와 불안정 표시는 없다. 실행 정보와 job 로그를 읽기만 했다. 6B의 코드를 담지 않으므로 6B 앞 런타임의 기준이다(위
  '배포 조건과 순서' 5).

### 6. App 9.0.31 머지 `ba28943e` 위로 옮김과 재확인

2026-11-01 23:20 ~ 23:41 KST, Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, `--maxWorkers=6`(JSON 보고). 옮김, 옮긴 머리의
단위 검사, 가드, 머리 빌드는 이 갈래의 worktree에서, 테스트 먼저 다시 돌리기, seed, 바탕과 증분 빌드는 `ba28943e`에서 따로 만든 detached
worktree(이 갈래 worktree의 `node_modules`를 연결, 런타임 의존성은 바탕과 같음)에서 커밋마다 detached로 바꿔 했다. 두 worktree의 일이
함께 돌았고, 끝난 뒤 두 트리는 깨끗했다.

- **옮김:** App 9.0.31 / v804(#555, 앱 글꼴 줄 상자 굽기와 탭 제목 한 기준선)가 2026-11-01 23:03 KST에 squash `ba28943e`로 main에
  들어가 23:17 KST에 [Release 41315218029](https://github.com/hiefny/MUSIXQUARE/actions/runs/41315218029)(target `app`, attempt 1 성공)로
  나갔다. `git fetch origin` 뒤 열다섯 커밋을 `git rebase`로 `dda3ee18`에서 `ba28943e`로 옮겼다(지난 main 커밋은 그 하나). 충돌은 기록 커밋
  둘의 `docs/README.md`에서만 났다(`6aee97c3`, `e5851cd0`의 6B 항목과 main의 9.0.31 항목, 둘 다 증거 목록 맨 위에 더함). 양쪽을 남겨 6B
  항목을 맨 위에, 9.0.31 항목을 그 바로 아래에 두었다(`e5851cd0`에서는 6B 항목만 그 커밋의 새 글로). 나머지는 저절로 합쳐졌다. 옮기며 새
  커밋을 더하지 않았고 버전, SW 캐시, 기록 글을 바꾸지 않았다.
- **그대로 옮겼음:** 열다섯 모두 커밋 메시지가 바이트로 같다. 열셋은 `git range-diff`에서 패치가 같고(`=`), 기록 커밋 둘(`docs/README.md`
  충돌)은 더하고 뺀 줄이 같고 문맥만 움직였다. `git diff ba28943e..aa6fd50e`의 36 파일은 파일마다 더하고 뺀 줄이 `git diff dda3ee18..89e0b682`와
  같다.
- **대응표**(옮긴 뒤 ← 옮기기 전, 오래된 것부터. 옮기기 전 SHA는 위 표와 절의 SHA다):

  | 옮긴 뒤    | 옮기기 전  | 커밋                                                       |
  | ---------- | ---------- | ---------------------------------------------------------- |
  | `2802cd9b` | `bd0dd536` | 6B-1 테스트 먼저                                           |
  | `6b6807f3` | `5c43edd2` | 6B-1 시작 장부                                             |
  | `fe0b0256` | `371a520c` | 6B-2 테스트 먼저                                           |
  | `af9ca6b9` | `ca883e29` | 6B-2 독자 옮김                                             |
  | `5a745ef5` | `9a56095d` | CHECK 12 후속, 테스트 먼저                                 |
  | `1a64dc81` | `421cc056` | 시험만: 독자 창 고정                                       |
  | `ed07d6ec` | `027b5036` | CHECK 12 후속, 가드만                                      |
  | `9aa62681` | `c5f7ed17` | 주석·레지스트리                                            |
  | `e7378e28` | `6aee97c3` | 기록: 이 보고서(`docs/README.md` 충돌, 양쪽 남김)          |
  | `7223046c` | `418b411d` | 시험만: 시험 순서 의존 고침                                |
  | `bf10724d` | `2920a863` | CHECK 12 둘째 후속, 테스트 먼저                            |
  | `0664386e` | `0d9d55c8` | CHECK 12 둘째 후속, 가드만                                 |
  | `2815ca67` | `48bc3819` | 설계 문서 메모                                             |
  | `e577ec6e` | `e5851cd0` | 기록: 옮김과 마지막 검사(`docs/README.md` 충돌, 양쪽 남김) |
  | `aa6fd50e` | `89e0b682` | 기록: 라운드 5와 고친 T0b 결함 목록                        |

- **테스트 먼저(라운드 4와 같은 방법과 파일 묶음):** 다섯 쌍 모두 새 부모의 실패 행이 라운드 4의 실패 행과 이름까지 같고(정렬해 견줌,
  둘째 후속은 라운드 4의 JSON이 없어 그 커밋이 더한 행 셋과 견줌), 코드 커밋은 모두 통과했다. 6B-1 `2802cd9b` 17 / 2,174(40 files,
  `start-ownership.test.ts` 17행 모두와 등가 시험의 불러오기 실패 'Failed to resolve import "../start-ownership.ts"') → `6b6807f3` 2,184 /
  2,184. 6B-2 `fe0b0256` 27 / 2,273(장부 17, 가드 10) → `af9ca6b9` 2,273 / 2,273. CHECK 12 후속 `5a745ef5` 12 / 91 → `ed07d6ec` 91 / 91.
  독자 창 `1a64dc81` 5 / 5, 6B 앞 바탕 `ba28943e`(파일만 넣어 돌린 뒤 지움)에서도 5 / 5. CHECK 12 둘째 후속 `bf10724d` 3 / 94(새 행 셋,
  규칙이 없음) → `0664386e` 94 / 94. 중립 고정 38 파일 2,157행은 6B-1·6B-2의 부모와 코드 커밋 넷에서 모두 통과했다.
- **시험 순서 고침:** 고치기 전 `e7378e28`에서 두 묶음(`stale-async-guards.test.ts`, `sync-integration.test.ts`, 425행)을 seed 1 ~ 16으로
  돌리면 seed 3(12 실패: `sync-integration` 10, `stale-async-guards` 2), 6(10, `sync-integration`), 7, 8, 10, 11, 12(각 2,
  `stale-async-guards`)가 실패하고 나머지 아홉은 425 / 425로 라운드 4와 같다. `7223046c`에서는 seed 1 ~ 32 모두 425 / 425다.
- **옮긴 머리 `aa6fd50e`(그 뒤 설계 문서 맞춤 `729bdc16`은 문서만):**
  - `src/youtube`, `src/player`, `src/pro-room` 파일 순서 239 files, 6,515 / 6,515. `--sequence.shuffle` seed 3, 7, 4242에서도 모두 6,515 /
    6,515다(9.0.31은 이 셋에 시험을 더하지 않아 라운드 4·5와 같은 수).
  - T0a·T0b 시험 51 files(T0a #539, #541, #542와 T0b #552, #553이 더하거나 고친 시험 파일) 2,402 / 2,402. 그 안에서 Standard 참값표 62 / 62,
    PRO 참값표 19 / 19, Standard 와이어 골든 16 / 16, PRO READY 시각 골든 10 / 10. 두 참값표, `fake-yt-player.ts`, 두 골든은 main `ba28943e`와
    바이트로 같다.
  - `node scripts/check-resource-ownership.mts`: 49 records, 457 production files, CHECK 11 32, CHECK 12 읽기 11·지우기 9, 파사드 쓰기 2,
    스냅샷 읽기 8, 장부 합성 1. `--report` 119줄은 라운드 4와 줄마다 같다.
  - `guard:release-identity` 'MUSIXQUARE 9.0.31; service-worker cache epoch v804'. `guard:sw-cache-version`은 버전 올리기를 기다리는 이유
    하나로 실패한다(위 'Version'의 글, 'newer than v804 (ba28943e)'와 App 11 파일).
  - 배포 대상: 위 'Deploy target'의 함수로 운영 배포 SHA(App `ba28943e`, PRO room `683074bc`, 나머지 넷 `71f5b96c`)와 견주면 App 11, 나머지
    다섯 Worker 0, App 런타임 의존성 `[]`이고, 그 SHA를 넣은 `verifyPartialReleaseCompatibility('app', …)`가 compatible(다섯 Worker 모두
    compatible, 바뀐 경로 0)이다. 계약 동결 diff `ba28943e..aa6fd50e`는 비어 있다.
  - 크기: 위 '번들 크기'의 9.0.31 위 표.
- **GitHub 읽기만:** 9.0.31의 Release 41315218029(23:14 KST dispatch, 'Deploy validated candidate' 23:17:47 KST success, 실패 복구 job
  skipped, 배포 메시지 `git:ba28943e…`)와 9.0.31의 머지 뒤 Full E2E
  [41315565486](https://github.com/hiefny/MUSIXQUARE/actions/runs/41315565486)(`workflow_dispatch`, main `ba28943e`, 23:18:49 KST 생성, 이 기록
  때 in_progress). 이 Full E2E는 6B의 머지 조건이다(위 '배포 조건과 순서').

### 7. 버전 올리기와 로컬 전체 검사 (`8823a591`, 2026-11-01 23:48 ~ 2026-11-02 00:22 KST)

Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, vite 8.3.3, Playwright Chromium. 이 갈래의 worktree에서 버전 올리기 머리
`8823a591`(마지막 런타임 커밋)을 그대로 두고 돌렸다. 앞 갈래(타입, lint, 형식, `build:checked`, 크기, `guard:*` 37개, 후보 E2E)와 뒤 갈래(자원
소유권, 핵심·Worker 커버리지, 단위 전체)를 함께 돌린 뒤 `build:e2e`와 로컬 Playwright를 따로 돌렸다.
앞뒤로 작업 트리는 깨끗했다.

- **버전 올리기:** `8823a591`이 9.0.31의 버전 올리기와 같은 거울 여섯 파일 일곱 줄만 바꾼다(`package.json`, `package-lock.json` 두 줄,
  `browser/classic-runtime/admin.ts`의 `ADMIN_SCRIPT_VERSION`, `cloudflare/app-worker.ts`의 `ADMIN_ASSET_VERSION`,
  `scripts/service-worker-asset.ts`의 `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 `/bootstrap.js?cache=v805`, 7 / 7줄). 계약 동결 diff
  `ba28943e..8823a591`는 그 일곱 줄뿐이고 `cloudflare/`는 `ADMIN_ASSET_VERSION` 한 줄이다.
- **`npm run typecheck`**(136 s), **`npm run lint`**(app과 tooling, 경고 0, 167 s), **`npm run format:check`**(68 s): 모두 종료 코드 0.
- **`npm run build:checked`**(81 s): 25 단계 모두 통과. `guard:sw-cache-version` 'PASS: v805 (8823a591) covers all committed PWA runtime
  changes.', `guard:release-identity` 'MUSIXQUARE 9.0.32; service-worker cache epoch v805', service worker(v805, 바이트 동일), TypeScript
  project coverage 1,572 files / 19 projects, brand capitalization 1,038, room authority(79 / 22 / 13 / 0 / 0, 410 files), legacy TV(Chromium 79,
  `main-FMXWdlb7.js`), initial transfer budget(entry 840.9 KiB raw / 247.7 KiB gzip, eager JS 454.5 KiB gzip, eager total 2,000.9 KiB raw /
  530.9 KiB gzip), 글꼴(44 stacks, 굽은 앱 면 포함), SW 앱 셸 96 assets.
- **`guard:*` 37개를 하나씩**(`build:checked`의 산출물 위): 37 통과, 0 실패. bus-pairing 202 / 202, import-graph(410 files, 2,101 edges, 순환
  0), dead-exports(410 / 2,161 / 0 / 20 / 76), transport-health(12 files), chunk-pump, lifecycle-writes, navigation-sinks, D1 migrations(19),
  ops drift contract, standard-room hot path, Developer API boundaries, font assets, Playwright API 등. 바탕 `ba28943e`의 수(dead-exports 410
  / 2,157, import-graph 2,103 edges, bus-pairing 202 / 202, room authority 같음)는 `dda3ee18`과 같다(9.0.31은 센 코드를 바꾸지 않음).
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 49 records, 457 production files, CHECK 11 32, CHECK 12 읽기 11·지우기 9, 파사드
  쓰기 2, 스냅샷 읽기 8, 장부 합성 1. `--report` 119줄은 라운드 4, 6과 줄마다 같다.
- **`npm run test:coverage:critical`:** 99 files / 4,051 통과, 전체 84.1 / 79.46 / 89.98 / 87.8, 파일별 문턱 오류 없음(62 s). 장부는 lcov로
  함수 20 / 20, 줄 18 / 18, 분기 3 / 3, `zero-start.ts`는 85.79 / 84.18 / 98.4 / 89.41(문턱 84 / 83 / 96 / 88).
- **`npm run test:coverage:workers`:** 69 files / 3,325 통과, 86.7 / 83.54 / 94.34 / 90.97(89 s).
- **단위 전체(파일 순서, `--maxWorkers=6`):** 741 files, 17,727행 가운데 17,725 통과, 0 건너뜀(410 s, 9.0.31이 시험 파일 둘을 더함). 실패
  2는 모두 git fixture 행의 시간 초과다(`release-deployment-state.test.ts`의 'blocks an unselected app when a localized build input changes'
  30 s, `sw-cache-version-guard.test.ts`의 'treats a Worker module the App bundle reaches through a dynamically imported module as PWA
  runtime' 15 s). 같은 시각 앞 갈래의 `build:checked`와 가드가 돌았다. 두 파일만 다시 돌려 158 / 158(105와 53) 통과했다. 6B는 이 두 파일이
  보는 릴리스 도구를 바꾸지 않는다.
- **크기(`build:checked`의 운영 빌드, `measureInitialTransfer`):** 진입 `main-FMXWdlb7.js` 861,056 / 253,683, eager JS gzip 465,403, eager
  total 2,048,923 / 543,650. 바탕 `ba28943e` 대비 진입 raw +254 B와 gzip −40 B, eager JS gzip −35 B, eager total gzip −33 B로, 위 '번들
  크기'의 6B 차(−34 B, −31 B, −40 B)를 넘어 늘지 않는다(버전 문자열만 바뀌어 청크 이름이 바뀜).
- **`npm run test:e2e:candidate`**(`build:checked` 산출물, 포트 4991 / 9991): 19 / 19(58 s).
- **`npm run build:e2e` 뒤 로컬 Playwright(Chromium, 포트 4991 / 9991, trace 끔):** `build:e2e`(17 s) 뒤 `test:e2e:critical`의 여덟 파일 101 / 101(5.3분), YouTube spec 열 개(`e2e/youtube*.test.ts`) 53 / 53(13.3분). 그
  가운데 계획 §4.2-3의 여덟(`youtube-sync` 6, `youtube-manual-zero-start` 10, `youtube-output-delay` 3, `youtube-end-transition` 6,
  `youtube-native-operator` 2, `youtube-manual-repeat` 1, `youtube-pending-seek` 4, `youtube` 9)은 41 / 41, 나머지 둘
  (`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은 12 / 12다. 실패, 다시 시도, 불안정 표시는 없다.
- **배포 대상:** 위 'Deploy target'의 함수로 운영 배포 SHA(App `ba28943e`, PRO room `683074bc`, 나머지 넷 `71f5b96c`)와 견주면 App 15(6B의
  11과 버전 거울 넷), 나머지 다섯 Worker 0, App 런타임 의존성 `[]`, 그 SHA를 넣은 target `app`의 부분 릴리스 호환 판정 compatible이다.
- **GitHub 읽기만:** 9.0.31의 머지 뒤 Full E2E 41315565486은 이 검사 동안 `webkit-mobile`과 운영 large-room R2 smoke가 success, `e2e` job이
  in_progress였다. 6B의 머지 조건이다(위 '배포 조건과 순서' 2).
- 이 라운드 뒤 기록 커밋(`9b0787bc`)은 문서만 바꾼다. 그 머리에서 문서를 읽는 검사(단위 전체, `guard:brand-capitalization`,
  `guard:sw-cache-version`, `guard:release-identity`, 자원 소유권, 배포 대상)를 다시 돌린 결과는 PR 설명에 적는다.

### 8. 9.0.31 배포 기록 `5a705c40` 위로 다시 옮김과 재확인

2026-11-02 04:30 ~ 04:45 KST, Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, vite 8.3.3, `--maxWorkers=6`(JSON 보고). 옮김과
검사는 모두 이 갈래의 worktree 하나에서 했고(따로 만든 worktree 없음), 검사는 옮긴 머리 `485369b9`(이 라운드의 기록 커밋 `a7979b2d` 앞, `docs/` 밖 트리가
`a7979b2d`와 같음)에서 차례로 돌렸다. 검사 동안 작업 트리에는 `a7979b2d`가 될 `docs/` 고침만 있었고 그 밖은 깨끗했다.

- **옮김:** 9.0.31의 배포 기록 PR #556이 2026-11-02 00:58 KST에 squash `5a705c40`(부모 `ba28943e`)으로 main에 들어왔다.
  `git diff --stat ba28943e 5a705c40`은 `docs/`의 다섯 파일뿐이다(release-record, `release-history.md` 한 행, 9.0.31 보고서,
  `docs/README.md`, `docs/hotfix-procedure.md`). `git fetch origin` 뒤 스무 커밋을 `git rebase`로 `ba28943e`에서 `5a705c40`으로 옮겼다.
  충돌은 릴리스 준비 기록 커밋(`01ca3582`)의 `docs/release-record.md` 두 곳뿐이었다. (1) §2 맨 위: 그 커밋이 더한 6B '배포 전' 절과 main이
  '배포 뒤 확인'으로 바꾼 9.0.31 절의 머리가 맞닿았다. 6B 절을 맨 위에 두고, 그 커밋이 지우려던 9.0.31 '배포 전' 머리 대신 main의 9.0.31
  '배포 뒤 확인' 절을 그대로 그 아래에 남겼다. (2) 6A 절의 다음 단계 항목 (3): main(9.0.31 배포와 앞 열차 Full E2E 조건 41315565486)과 그
  커밋(6B 준비와 §2 맨 위 6B 절 가리킴)이 같은 문장을 고쳐 두 고침을 합쳤다. `docs/README.md`는 저절로 합쳐졌다. 9.0.31 기록의 §1, §4,
  `release-history.md`는 이 갈래가 건드리지 않는다(§1은 6B 배포 뒤의 기록 PR이 덮어씀). 옮기며 버전, SW 캐시, 런타임, 시험을 바꾸지 않았다.
- **그대로 옮겼음:** 스무 커밋 모두 커밋 메시지와 작성자·작성 시각이 바이트로 같다. `git range-diff`에서 열일곱은 패치가 같고(`=`), 셋은
  문서만 다르다(`e7378e28`, `e577ec6e`는 `docs/README.md`의 문맥만, `01ca3582`는 위 충돌). 스무 쌍 모두
  `git diff <옮기기 전> <옮긴 뒤> -- . ':!docs'`가 비어 있다. 버전 올리기 `582ab9d9`가 마지막 런타임 커밋이고 `git diff 8823a591 485369b9 -- . ':!docs'`가 비어 있다.
- **대응표**(옮긴 뒤 ← 옮기기 전, 오래된 것부터. 옮기기 전 SHA는 라운드 6의 대응표와 그 뒤 기록의 SHA다):

  | 옮긴 뒤    | 옮기기 전  | 커밋                                                            |
  | ---------- | ---------- | --------------------------------------------------------------- |
  | `37120a36` | `2802cd9b` | 6B-1 테스트 먼저                                                |
  | `06487012` | `6b6807f3` | 6B-1 시작 장부                                                  |
  | `ab6bd3f2` | `fe0b0256` | 6B-2 테스트 먼저                                                |
  | `aa9a79bc` | `af9ca6b9` | 6B-2 독자 옮김                                                  |
  | `cd3e71b2` | `5a745ef5` | CHECK 12 후속, 테스트 먼저                                      |
  | `1667bee4` | `1a64dc81` | 시험만: 독자 창 고정                                            |
  | `5d99e3f8` | `ed07d6ec` | CHECK 12 후속, 가드만                                           |
  | `bfd8670d` | `9aa62681` | 주석·레지스트리                                                 |
  | `18811d22` | `e7378e28` | 기록: 이 보고서(`docs/README.md` 문맥만 움직임)                 |
  | `660a50be` | `7223046c` | 시험만: 시험 순서 의존 고침                                     |
  | `4f1601c2` | `bf10724d` | CHECK 12 둘째 후속, 테스트 먼저                                 |
  | `eb538469` | `0664386e` | CHECK 12 둘째 후속, 가드만                                      |
  | `60d1f6c3` | `2815ca67` | 설계 문서 메모                                                  |
  | `f7fb6cc6` | `e577ec6e` | 기록: 옮김과 마지막 검사(`docs/README.md` 문맥만 움직임)        |
  | `04a0a134` | `aa6fd50e` | 기록: 라운드 5와 고친 T0b 결함 목록                             |
  | `35c84948` | `729bdc16` | 설계 문서의 틈 목록 맞춤                                        |
  | `f6a407ba` | `fb5ed235` | 기록: `ba28943e` 위로 옮김(라운드 6)                            |
  | `2caccbdf` | `01ca3582` | 6B-3 릴리스 준비 기록(`docs/release-record.md` 충돌, 양쪽 남김) |
  | `582ab9d9` | `8823a591` | 6B-3 버전 올리기(마지막 런타임 커밋)                            |
  | `485369b9` | `9b0787bc` | 버전 올리기 뒤 기록                                             |

- **GitHub 읽기만:** 9.0.31의 머지 뒤 Full E2E [41315565486](https://github.com/hiefny/MUSIXQUARE/actions/runs/41315565486)(main
  `ba28943e`)은 completed / success다. 세 job 모두 success: 운영 large-room R2 smoke(2026-11-01 23:18:51 ~ 23:20:13 KST), `webkit-mobile`
  (23:18:52 ~ 23:24:34 KST), `e2e`(23:18:52 ~ 2026-11-02 00:29:29 KST). 행 수(`e2e` 812 passed, `webkit-mobile` 94 passed·5 skipped와 운영
  빌드 SW 시험 1 passed, R2 smoke 1 passed, 실패와 불안정 표시 없음)는 9.0.31 기록(#556)의 §1이 적은 것이다. PR #556은 MERGED,
  머지 커밋 `5a705c40`. 이 둘로 위 '머지 전에 할 일' 4와 5가 끝났다.
- **옮긴 머리 `485369b9`:**
  - `npm run typecheck`(90 s), `npm run lint`(app과 tooling, `--max-warnings=0`, 134 s), `npm run format:check`(45 s): 모두 종료 코드 0.
  - `npm run build:checked`(53 s): 25 단계 모두 통과. `guard:sw-cache-version` 'PASS: v805 (582ab9d9) covers all committed PWA runtime
    changes.', `guard:release-identity` 'MUSIXQUARE 9.0.32; service-worker cache epoch v805', initial transfer budget eager JS 454.5 KiB gzip,
    eager total 2,000.9 KiB raw / 530.9 KiB gzip, SW 앱 셸 96 assets, TypeScript project coverage 1,572 files / 19 projects, brand
    capitalization 1,038.
  - **`guard:*` 37개를 하나씩**(`build:checked`의 산출물 위): 37 통과, 0 실패. dead-exports 410 / 2,161 / 0 / 20 / 76, import-graph 410 files,
    2,101 edges, 순환 0, bus-pairing 202 / 202, room authority 79 / 22 / 13 / 0 / 0(410 files). 라운드 7과 같은 수다.
  - `node scripts/check-resource-ownership.mts`: 49 records, 457 production files, CHECK 11 32, CHECK 12 읽기 11·지우기 9, 파사드 쓰기 2,
    스냅샷 읽기 8, 장부 합성 1. `--report` 119줄은 라운드 6, 7과 줄마다 같다.
  - **6B·T0a·T0b 시험 파일(파일 순서):** T0a(#539, #541, #542)와 T0b(#552, #553)가 더하거나 고친 시험 51 files와 6B가 더하거나 고친 시험 16
    files(겹침 11)를 함께 돌려 56 files, 2,554 / 2,554 통과(59 s). 그 안에서 T0a·T0b 51 files 2,402 / 2,402(라운드 6과 같음), 6B 16 files
    1,283 / 1,283, Standard 참값표 62 / 62, PRO 참값표 19 / 19, Standard 와이어 골든 16 / 16, PRO READY 시각 골든 10 / 10이다. 두 참값표,
    `__helpers__/fake-yt-player.ts`, 두 골든은 main `5a705c40`과 바이트로 같다.
  - **크기(`build:checked`의 운영 빌드, `measureInitialTransfer`):** 진입 `main-FMXWdlb7.js` 861,056 / 253,683, eager JS gzip 465,403, eager
    total 2,048,923 / 543,650으로 라운드 7의 `8823a591`과 바이트까지 같다(위 '번들 크기'의 9.0.31 위 표).
  - **배포 대상:** 위 'Deploy target'의 함수로 운영 배포 SHA(App `ba28943e`, PRO room `683074bc`, 나머지 넷 `71f5b96c`)와 견주면 App 15(6B의
    11과 버전 거울 넷), 나머지 다섯 Worker 0, App 런타임 의존성 `[]`, 그 SHA를 넣은 target `app`의 부분 릴리스 호환 판정 compatible(다섯
    Worker 모두 compatible, 바뀐 경로 0)이다. 계약 동결 diff `5a705c40..485369b9`는 일곱 버전 줄뿐이고 `cloudflare/`는
    `ADMIN_ASSET_VERSION` 한 줄이다.
- 다시 돌리지 않은 것: 핵심·Worker 커버리지, 단위 전체, `build:e2e`와 로컬 Playwright(critical E2E, YouTube spec, 후보 E2E), 테스트 먼저
  다시 돌리기, seed, 변이 확인. 모두 `docs/` 밖 트리가 같은 `8823a591`(라운드 7)과 `ba28943e` 위 커밋(라운드 6)의 결과가 그대로 선다고 본다.
- 이 라운드 뒤 기록 커밋 `a7979b2d`와 검토 지적을 고친 문서 커밋(이 글)은 문서만 바꾼다. 각 머리에서 다시 돌린 검사의 결과는 PR
  설명에 적는다.

### 9. PR CI, 자동 코드 리뷰, 머지, exact-main CI, 배포와 smoke, 공개 확인, Drift Audit과 머지 뒤 Full E2E (2026-11-02)

2026-11-02 05:12 ~ 06:43 KST. 근거는 GitHub의 실행 기록과 로그, 릴리스 담당의 배포 기록(시각은 KST), 인증 없는 공개 GET이다. 이
라운드의 코드는 PR head `415f77be`(런타임은 버전 올리기 `582ab9d9`와 같음)와 그 squash `3ea689b9`(트리가 head와 같음)다. 환경은
GitHub의 Linux 러너와 운영 Cloudflare다.

- **PR:** PR #557(브랜치 `agent/p6-6b`, main `5a705c40` 위 22커밋, head `415f77be`)을 05:12:11 KST에 열었다. PR CI
  [41345634896](https://github.com/hiefny/MUSIXQUARE/actions/runs/41345634896)(`pull_request`, 05:12:15 KST 생성, job 05:12:18 ~
  05:21:00 KST)가 첫 실행에 11 jobs 모두 success였다(근거는 job 결론과 시각).
- **자동 코드 리뷰:** PR을 연 뒤의 리뷰 요청 댓글(05:12:18 KST)로 돌았고, 요약 댓글이 head `415f77be`의 코드 리뷰를 05:15:46 KST에
  completed, `has_any_findings`와 `has_unresolved_findings` false로 적었다(05:15:44 KST의 리뷰 댓글도 큰 문제를 찾지 못했다고 적음).
  보안 리뷰는 돌지 않았다.
- **머지:** 배포 스크립트가 PR CI success(05:21:29 KST)와 head의 리뷰 상태(05:21:31 KST)를 다시 읽고 05:21:35 KST에 squash
  머지했다: `3ea689b9`, 부모 `5a705c40`, 트리는 head `415f77be`와 같다. 머지 커밋의 제목 아래 본문은 미리 준비한 요약 본문과 글자
  그대로 같다(본문은 PR을 열기 전에 써서 PR CI, 리뷰, exact-main CI의 결과를 적지 않는다). 머지까지 main은 `5a705c40`에서 움직이지
  않았고, 이 기록까지 다른 머지는 없다.
- **Exact-main CI:** [41346450901](https://github.com/hiefny/MUSIXQUARE/actions/runs/41346450901)(push, attempt 1, 05:21:37 KST 생성,
  job 05:21:40 ~ 05:31:45 KST)의 11 jobs가 모두 첫 시도에 success였다. Critical runtime coverage(05:21:40 ~ 05:24:10 KST): 99 files /
  4,051 tests, 84.1 / 79.46 / 89.98 / 87.8(statements / branches / functions / lines), 파일별 기준치 오류 없음. Production release
  candidate(05:21:40 ~ 05:23:35 KST): 'Resolved .node-version as 24.22.2', 'MUSIXQUARE 9.0.32; service-worker cache epoch v805',
  'PASS: v805 (3ea689b9) covers all committed PWA runtime changes.'(05:22:50 KST). Critical browser gate(Linux Chromium, 05:23:37 ~
  05:31:45 KST): 운영 후보 smoke 19 / 19(53.7초)와 critical E2E 101 / 101(5.5분), 재시도·flaky 없음. 그 밖의 job은 결론만 근거다.
  후보는 artifact 13099208732(digest sha256 `c5c70958…`, 43,884,978 B)이고, 배포 기록이 05:32:06 KST에 success를 읽었다.
- **dispatch 직전 공개 상태**(배포 기록이 05:32:08 KST에 읽음, 05:32:09 KST 생성): `minAppBuild` 795, `effectiveMinAppBuild` 795,
  revision 3, `liveAppBuild` 804, `reportedLiveAppBuild` 804(05:31:47 KST 보고, 약 21초 전), state `valid`.
- **릴리스:** [Production Release 41347347201](https://github.com/hiefny/MUSIXQUARE/actions/runs/41347347201)(workflow_dispatch,
  05:32:11 KST 생성, target `app`, Developer API D1 false, `raise_app_build_floor` false, attempt 1) success. Validate 05:32:15 ~
  05:32:25 KST, Deploy 05:32:28 ~ 05:34:50 KST, 'Preserve failed-release recovery boundary' skipped. 'Verify release commit is still
  current main'(05:32:50 KST) 통과, 후보를 내려받아 digest와 릴리스 파일 1,253개 확인, Node 24.22.2, 여섯 Worker 번들 dry-run
  통과(Wrangler 4.148.0, App 986.54 / gzip 201.53 KiB), 부분 릴리스 판정 compatible(05:33:25 ~ 05:33:32 KST), checkpoint artifact
  13099442949(05:33:32 ~ 05:33:37 KST, 6 files, App 9.0.31 `dff554a2`), D1 계약 단계 일곱 success(05:33:37 ~ 05:34:06 KST), PRO
  최소 빌드 사전 검사와 다른 다섯 Worker의 단계는 target `app`이라 skip. App 단계(05:34:06 ~ 05:34:27 KST): 다시 확인
  compatible(05:34:14 KST), 'Verified unchanged production deployment for app', `dist`의 1,313 files를 읽어 새 자산 74개를
  올림(1,177개는 이미 있음), App `e19b7085-8f1c-49fb-ada6-c569523bf52c`(05:34:25 KST, startup 4 ms), 'app production version
  dff554a2-… -> e19b7085-…'. smoke: App generation(05:34:27 ~ 05:34:33 KST, `main-FMXWdlb7.js` 861,056 B, 22 assets, 세 번 연속
  읽기, 라운드 8의 로컬 운영 빌드와 이름과 크기가 같음), 익명 계정 경계와 페이지의 최소 빌드 읽기(strict, 795), PRO 공개 경계(R4의
  `e7657f88`, 12번 가운데 첫 시도, 합성 방 000000의 `activation_required`와 000001의 `pin_required`·`passwordRequired` true, 익명
  스냅샷 거절), Standard HTTPS signaling(빌드 805, 방장·게스트 입장, offer·answer 중계, `bridgeOpenMs` 방장 1,138 ms·게스트
  504 ms)이 모두 첫 시도에 통과했고 503·502 재시도는 없었다. 최종 소유권 05:34:42 KST verified, 커밋 표지 artifact 13099827446,
  배포 원본 artifact 13099976948(32 files). 바닥 올리기 단계와 실패 복구 단계는 skip이다. 릴리스 담당의 배포 기록이 05:35:13 KST에
  종료 코드 0을 적었다.
- **공개 확인(인증 없는 GET):** `/service-worker.js`의 `CACHE_VERSION = "v805"`(릴리스 담당이 05:36 KST 무렵 읽음). 공개 최소 빌드
  상태(05:35:36 KST 생성): 저장·유효 795, revision 3, `liveAppBuild` 805, `reportedLiveAppBuild` 805(05:34:48 KST 보고, 약 49초
  전), state `valid`.
- **Drift Audit:** [41347664673](https://github.com/hiefny/MUSIXQUARE/actions/runs/41347664673)(workflow_dispatch, `3ea689b9`, 05:35:46
  KST 생성, job 05:35:51 ~ 05:36:22 KST, 보고서 생성 05:36:11 KST) automated-checks-passed: 32 pass / 0 fail / 5 manual-only(artifact
  13099543194). App build floor 행은 'Stored floor 795 (enforced 795) is within the live App build 805 reported 29 s ago.'이고,
  MANUAL 다섯은 앞 실행들과 같다.
- **머지 뒤 Full E2E:** [41347667125](https://github.com/hiefny/MUSIXQUARE/actions/runs/41347667125)(workflow_dispatch, `3ea689b9`,
  05:35:48 KST 생성, attempt 1). success: `e2e`(Ubuntu 러너, Playwright Chromium, 05:35:51 ~ 06:43:44 KST) 812 passed, `webkit-mobile`(05:35:51 ~ 05:41:43 KST) 94 passed·5 skipped와 운영 빌드 SW 시험 1 passed, 운영 large-room R2 smoke(05:35:51 ~ 05:37:12 KST) 1 passed이고 실패와 불안정 표시는 없다. 그 `e2e`에서 YouTube spec 열 개(`e2e/youtube*.test.ts`) 53행이 Linux Chromium에서 통과했다(라운드 7의 Windows Chromium 53 / 53과 파일마다 같은 수: `youtube-sync` 6, `youtube-manual-zero-start` 10, `youtube-output-delay` 3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1, `youtube-pending-seek` 4, `youtube` 9, `youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8). 이 통과가 앞 열차의 머지 뒤 Full E2E가 다음 열차를 머지하기 전에 통과한다는 Phase 6 계획 §1.4의 조건을 6C에 대해 채운다. 이 실행은 exact-main 후보가 아니다.
- **하지 않은 것:** 위 '배포 뒤 확인'의 블라인드 기기 후보(데스크톱 Chrome 방장과 Android Chrome 게스트), 운영 브라우저의 업데이트 창,
  실제 기기와 iOS Safari, 로컬 WebKit E2E 레인. 오너는 자리를 비운 채라 T0b 결함 넷의 답도 없고, 넷째의 고침은 짓지 않았다.
- **배포 기록 PR(문서만):** release-record §1과 `Last source review`를 덮어쓰고, §2 맨 위 이 열차의 '배포 전' 절을 배포 뒤 항목(범위와
  상태, 기댄 오너 답과 위임, T0b 결함 목록, 되돌리기, 배포 직후 확인, 다음 단계, 열린 항목)으로 바꾸고, §4에 이 릴리스 항목과 현재
  경계 줄 (5)를 적고, 다른 항목의 다음 되돌리기 번호를 9.0.33 / v806으로 옮기고, '§2 맨 위 9.0.31 절'을 가리키던 곳을 '§2 9.0.31
  절'로 고치고, 9.0.31 절과 6A 절의 혼자 되돌리기 창이 6B의 머지로 닫혔다고 적고, 다른 절의 기기 확인이 이제 9.0.32에서 한다고
  적었다. `docs/release-history.md`에 한 행, hotfix-procedure의 9.0.25 문단에 9.0.32 문장을 더하고, `docs/README.md`의 이 보고서
  항목을 배포됨으로 고쳤다. 로컬과 브랜치 결과는 exact-main-SHA 후보를 대신하지 않았다.

## 하지 않은 것과 확인하지 않은 것

- **PR, 머지, 배포:** QA 라운드 9에 적었다(PR #557, squash `3ea689b9`, Release 41347347201). release-record §2의 '배포 전' 항목과 버전 올리기 `8823a591`(옮긴 뒤 `582ab9d9`)은 릴리스
  담당이 이 갈래에 더했다. 라운드 1 ~ 8은 GitHub에 쓰지 않았다(라운드 5는 바탕의 Full E2E 실행 정보를, 라운드 6과 7은 9.0.31의 Release와 Full E2E 실행 상태를,
  라운드 8은 #556의 머지와 그 Full E2E의 결론을 읽기만 함).
- **T0b 결함 넷째의 고침:** 오너 답 전이라 싣지 않았다(위 '오너에게' 1). 화면에 닿는 고침([화면 바뀜])은 묻지 않고 싣지 않는다.
- **옮긴 커밋의 변이 확인:** QA 라운드 4, 5, 6, 8에서 다시 하지 않았다(라운드 4의 독자 변이 둘 말고). 옮기기 전 `07a9f224`(QA 라운드 1)와
  `dda3ee18` 위로 옮긴 뒤 `418b411d`의 독립 검토(QA 라운드 3) 결과를 적었다. 9.0.31 위로 옮긴 커밋은 운영 코드의 더하고 뺀 줄이 파일마다
  같아(QA 라운드 6), 9.0.31의 배포 기록 위로 다시 옮긴 커밋은 `docs/` 밖 트리가 그대로라(QA 라운드 8) 그 결과가 그대로 선다고 본다.
- 실기기, iOS Safari, WebKit 레인(`setup-youtube-activation.test.ts` 포함, 계획 §4.2-4는 `iframe.ts`의 prime·활성화 경로를 건드린 6C·6D에만
  요구), 블루투스. 6B 런타임의 PR CI, exact-main CI와 머지 뒤 Full E2E는 QA 라운드 9다. 기기 확인은 배포 뒤 블라인드로 하며 게이트가 아니다. Phase 6 앞의 기기 기준선(Q6)은 재지
  않았다.
- `check:workers`와 Worker 묶음 dry-run: `cloudflare/` 차이가 0이라 따로 돌리지 않았다. Worker의 타입 검사(`typecheck:workers`,
  `types:workers:check`)는 `npm run typecheck` 사슬 안에서 돌았고 Worker 단위 커버리지도 돌렸다.
- 가를 행이 없는 독자: 작은 drift 표본의 timeline 보류와 수동 싱크 창의 동기화 누름 확인(위 '독자 창 고정'), 그리고
  복구의 출시 확인 창(pending이지만 active가 아님)에서 `isYouTubeStartSyncOwned` 독자가 `isYouTubeStartArmBusy`와 갈리는 곳은 자기 독자
  행이 없다. 같은 창에서 unMute 가드의 복구 결정(active이지 pending이 아님)은 장부 단위 행(`start-ownership.test.ts`)만 고정하고, 그 창에
  볼륨 행은 없다(설계 문서 'Not covered yet').
- CHECK 12가 보지 않는 것: 문장 사이에 변수나 지역 도우미로 엮은 claim(`sync.ts`의 작은 drift 표본이 timeline 보류를 `isCurrentStateAction`,
  `isGuestYouTubeTransitionPending` 옆에서 물음), 주인의 인스턴스에 부른 claim 질의(PRO arm의 `ownsHardMute()`), 세는 스냅샷 읽기가 무엇을
  끌어내는지, `src/youtube/` 밖의 풀리지 않는 타이머 이름. 리뷰로 본다.
- 참값표 fallbackPending 열은 실행이 in flight인 동안의 pending을 보지 못한다(위 'T0b 파일'에서 받아들인 좁힘).
- T0a 시험 `youtube-start-owner-boundary.test.ts`의 머리 주석(21 ~ 23줄)이 지운 합성과 다리 훅 이름을 아직 적는다. 표본은 시작 하네스를
  거쳐 장부를 읽으므로 동작과 행은 맞다. 주석만이라 다음 시험만 커밋에서 고친다.
- 참값표가 오늘 동작으로 고정한 결함 넷(고친 목록의 첫째 H4·H4a, 둘째 G8pa·G8·G8p·G8a, 셋째 P1·P4, 넷째 H10·H10a·H10c, 위 'Q18')은
  장부가 답을 바꾸지 않아 그대로다.
- 영역 조사의 대략적 기기 시간(약 25분)은 추정이다.
