# 릴리스 기록 (현재 상태)

| Field              | Value                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Runbook — 현재 릴리스 상태. 프로덕션 배포·롤백마다 §1을 덮어쓰고, 열린 항목이 바뀌면 §2를 고친다                                                                                                                |
| Applies to         | 프로덕션 App·Worker 6종의 현재 배포 상태, 열린 확인 항목, 릴리스·QA 때 지킬 기준                                                                                                                                |
| Last source review | 2026-10-26 (배포 SHA `dd9c9d4d`, Release `40283632968` attempt 1 성공)                                                                                                                                          |
| Executable sources | [CI](../.github/workflows/ci.yml), [Production Release](../.github/workflows/release.yml), [배포 범위·복구 판정](../scripts/release-deployment-state.mts), [D1 계약](../cloudflare/d1-migrations.manifest.json) |
| Related documents  | [릴리스 이력](release-history.md), [정식 배포·복구 절차](hotfix-procedure.md), [버전 규칙](release-versioning.md), [QA 범위 설계](qa-domains.md), [허용한 위험](known-accepted.md), [작업 지침](../AGENTS.md)   |

QA를 시작하기 전과 main 병합·프로덕션 릴리스를 준비하기 전에 이 문서를 읽는다.
아래 값은 표에 적힌 커밋과 확인일 기준이다. 배포 직전에는 실제 Git·CI·Cloudflare
상태와 다시 맞춘다. 배포 승인은 오너가 하고, 절차는
[hotfix-procedure.md](hotfix-procedure.md)를 따른다. 이 문서는 근거를 모을 뿐
승인이나 절차를 대신하지 않는다.

```bash
npm run version:status
gh run list --workflow release.yml --limit 5
gh run list --workflow ops-drift-audit.yml --limit 3
gh run list --workflow e2e.yml --branch main --limit 3
```

## 1. 현재 운영 상태

아래는 2026-10-26 16:10 KST 배포 후 첫 최소 앱 빌드(16:15 KST)·공개 자산·Drift Audit까지의 상태다. 후속 기록 PR은 배포된 코드 SHA나 exact-main 후보를 대신하지 않는다. 다음 배포 전 Git·CI·Cloudflare 상태를 다시 확인한다.

| 항목                   | 값                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App 버전 / SW 캐시     | `9.0.14` / `v787` (강제 업데이트 열차: 런타임 최소 앱 빌드와 '나중에' 없는 업데이트 창, C5-12 Inc 1, 업데이트 창이 뜬다). 빌드 번호는 787이다. 9.0.13은 배포됐으므로 마지막 PWA 런타임 커밋인 bump `2077ef60`에서 SemVer와 SW 캐시 epoch를 함께 올렸다(올리기 직전 fetch한 origin/main은 `4d7650c0`). 그 뒤의 런타임 변경은 Cloudflare Worker 파일뿐이라(Codex P1 반영 테스트 `345ca05e`, 수정 `66c90420`) 다시 올리지 않았다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 마지막 프로덕션 변경   | 2026-10-26 16:10:43 KST deploy job 완료, [Release 40283632968](https://github.com/hiefny/MUSIXQUARE/actions/runs/40283632968) attempt 1 성공, target=all, Developer API D1=false, `raise_app_build_floor`=false. 이어 16:15:03 KST에 App Build Floor workflow로 첫 최소 앱 빌드 787을 켰다(아래 '최소 앱 빌드'). 오너 결정(2026-10-25 약 01:50 KST): 자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과하면 따로 묻지 않고 배포하고, 기기 근거는 게이트가 아니다. 이번에는 Codex가 PR을 연 head `401d3196`에서 P1 하나를 냈고 테스트 먼저로 고쳐 답했으며, 그 뒤의 마지막 head `ceb96ea0`에는 머지 스크립트의 20분 상한 안에 아무것도 올리지 않았다(아래 검증 범위). 오너 정책(2026-10-25 약 16:40 KST)으로 옛 앱 버전은 더 이상 설계 제약이 아니고 필요하면 강제 업데이트로 올린다. 네 결정(약 18:30 KST의 Q1 장치, Q2 첫 최소 빌드는 이 열차 빌드, Q3 C5-12 Inc 1만 이 열차, Q4 작은 통신 필드는 그대로), 약 22:00 KST 시작·복귀 확인 추가와 설계 Q-A A를 따랐다. 통합 순서 변경(2026-10-26 약 05:10 KST)으로 5A(9.0.12)와 구버전 제거 열차 1(9.0.13)이 먼저 나가 이 열차는 9.0.14 / v787이다. 강제 업데이트 열차([#498](https://github.com/hiefny/MUSIXQUARE/pull/498)): 클라이언트가 빌드 번호(SW 캐시 epoch 정수)를 Standard `host-auth`·`guest-auth`(재접속 포함)의 선택 키 `appBuild`와 모든 PRO 요청의 헤더 `X-MXQR-App-Build`에 싣고, Signaling Worker(첫 인증 프레임, 입장 전)와 PRO 앞문(bootstrap, sessions, presence/enter)이 유효 최소 빌드보다 낮은 새 입장을 거절한다(signaling은 그 소켓에만 `app-update-required` 오류 프레임과 close 1008, PRO는 426). 유효 최소 빌드는 service-control 객체의 저장값과 App Worker가 매분 보고하는 live App 빌드 중 낮은 값이고 보고가 5분 넘으면 0이다(registry RO-50). 맺어진 세션은 닫지 않는다. 거절되거나 시작·전경 복귀 때 읽은 최소 빌드(`GET /api/app-build-floor/effective`, 엣지 캐시 30초)보다 낮은 9.0.14+ 페이지는 같은 업데이트 대화상자를 '나중에' 없이 연다(RO-22, 복귀 창 하나는 새 기록 RO-51). 설정은 GitHub Actions OIDC(`app-build-floor.yml`, 릴리스 입력 `raise_app_build_floor`)로만 하고 관리자 대시보드는 내리기만 한다. C5-12 Inc 1: 미리받기를 기다리는 9.0.14 게스트는 방장이 직접 허락한 자기 세션의 본 레인 머리를 어느 경로에서든 받는다(RO-18 경로 2와 '요청 전' 틈이 새 게스트에게서 닫힘). 여섯 Worker 모두 런타임 경로가 바뀌어 target `all`이고(부분 릴리스 판정 단계는 skip), `all`은 `appBuild`를 받는 Signaling을 그것을 보내는 App보다 먼저 배포했다. 이 SHA의 실패한 실행은 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 배포 main SHA          | `dd9c9d4d6493c50c86a7fc0240ae4ccf2b16cd99`, PR [#498](https://github.com/hiefny/MUSIXQUARE/pull/498) squash(2026-10-26 15:56 KST). Exact-main push [CI 40282742255](https://github.com/hiefny/MUSIXQUARE/actions/runs/40282742255) attempt 1의 후보 [artifact 12633430234](https://github.com/hiefny/MUSIXQUARE/actions/runs/40282742255/artifacts/12633430234)(digest sha256 `3f615cb5d1b795aefe7f654b00f0505e1fb12e740cea9d7643336153d323ee6e`)를 사용했고, 릴리스가 내려받아 이 digest와 릴리스 파일 810개를 확인했다. 11 jobs 모두 첫 시도 success. main 트리는 CI를 통과한 PR head `ceb96ea0`와 같다(마지막 PWA 런타임 커밋은 bump `2077ef60`, 그 뒤는 Worker 파일 `345ca05e`·`66c90420`과 문서). Node 24.20.0. PR·로컬 결과를 exact-main 후보로 대체하지 않았다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Worker                 | 여섯 모두 이번 실행의 버전, 100%, message=`git:dd9c9d4d6493c50c86a7fc0240ae4ccf2b16cd99`: PRO room `b1dbff00-2094-40cc-987a-06c8e6f50f23`(16:07:29 KST), remote-share `ff994510-2da0-4ad4-a749-ed19ba3af874`, signaling `8b169bcd-eefc-4ce0-976c-5f058d15717e`(16:08:19 KST), Developer API facade `a0e7e311-926e-4632-958a-be90c8fe9919`, Developer API `7525abf0-40f5-4ef0-b383-e23d05a997ec`, App `7dc40d51-8615-484a-8504-7ab952048a0c`(16:10:11 KST). 최종 소유권 16:10:34 KST 여섯 모두 verified. PRO generation readiness는 배포 동안 `disabled`로 room-code 재사용을 막았다가 `ready`(release `dd9c9d4d`, floor release `4c5612d5`)로 되돌렸다. Developer API schema intent는 `572880a2`에서 확인했다(D1 변경 없음). [배포 원본](https://github.com/hiefny/MUSIXQUARE/actions/runs/40283632968/artifacts/12633234073)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 운영 smoke / 공개 자산 | App(generation `main-CaKT24Ie.js` 862,421 B·24 assets 수렴, 익명 계정 경계와 페이지의 최소 빌드 읽기 strict `effectiveMinAppBuild` 0, PRO 공개 경계 `b1dbff00`), Worker별 smoke(PRO room, remote-share 두 번, signaling, Developer API canary)와 Standard HTTPS signaling(`bridgeOpenMs` 방장 789ms·게스트 512ms, 503 재시도 없음) success. 후보 빌드 smoke: signaling과 Standard HTTPS smoke는 이 릴리스의 signaling 버전을 기대해 `appBuild` 787을 실은 `host-auth`(`signalingMode` candidate, `hostAuthShape` appBuild)로 입장했다. signaling 배포 전에 돈 remote-share smoke는 옛 signaling(9.0.5)을 만나 설계대로 한 번 `appBuild` 없이 다시 했다. 이 smoke들 때 최소 빌드는 0이었다. 배포 뒤 공개 GET(16:22 KST) 200: `/` 144,467 B(`bootstrap.js?cache=v787`), `/service-worker.js` 39,136 B(`CACHE_VERSION = "v787"`). 배포 직후 공개 상태 `GET /api/app-build-floor`는 첫 매분 보고 전까지 503이었다(사용자 영향 없음, §2 낮음 항목). 이번에는 운영 브라우저의 업데이트 대화상자와 강제 창을 확인하지 않았고, 실기기 확인도 아직이다(§2). [보고서](design/forced-update-9-0-14-2026-10-25.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 최소 앱 빌드           | 787(첫 최소 빌드, 오너 결정 Q2, 이유 'First App build floor at 9.0.14 / v787 (owner decision Q2, 2026-10-25)'). App Build Floor workflow: [status 40284433812](https://github.com/hiefny/MUSIXQUARE/actions/runs/40284433812)(stored 0, effective 0, live App 787, 보고 새것), [check 40284513979](https://github.com/hiefny/MUSIXQUARE/actions/runs/40284513979)(`GitHub OIDC check passed for hiefny/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/main`, 실제 토큰의 첫 증명), [set 40284593490](https://github.com/hiefny/MUSIXQUARE/actions/runs/40284593490)(`set to 787: changed (revision 0 before)`, 이어 공개 상태, PRO 786 거절·787 입장, Signaling 786 거절, 그 변경보다 새 cron 보고, 페이지 읽기 787을 확인하고 16:16:29 KST 성공). 요약 줄: `App build floor: stored 787, effective 787, revision 1, updated 2026-10-26T07:15:03.890Z; live App 787, reported 787 at 2026-10-26T07:16:24.985Z; client read 787`. 독립 확인(16:22 KST): 공개 상태 `minAppBuild` 787, `effectiveMinAppBuild` 787, revision 1, `liveAppBuild` 787, state `valid`. 페이지 읽기 `{"effectiveMinAppBuild":787}`. 가짜 방 000001의 PRO bootstrap은 빌드 786과 헤더 없음에 426 `APP_UPDATE_REQUIRED`(`minAppBuild` 787), 빌드 787에 200 `pin_required`. 9.0.13 이하는 새 입장과 재접속에서 거절되고 다시 열면 회복한다. Signaling이 운영에서 787 방장을 입장시키는 것은 아직 보지 않았다(`set`의 확인은 786 거절만, §2 오너 확인). 바꾸기는 [운영](hotfix-procedure.md#app-build-floor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 복구                   | 성공한 실행은 rollback 불필요·미실행, 독립 recovery job skipped. 배포 전 [checkpoint](https://github.com/hiefny/MUSIXQUARE/actions/runs/40283632968/artifacts/12633460397)는 9.0.13 App `4d7650c0`(version `c0828777-106d-46f5-a324-c8e995ddc1dd`)과 9.0.5 `572880a2`의 다섯 Worker(PRO room `49fc11aa`, remote-share `0f49a77a`, signaling `23b823eb`, Developer API facade `fc2e0910`, Developer API `a4e576d3`)를 보존하고, Worker 호환 floor checkpoint는 PRO generation·entitlement floor(floor release `4c5612d5`)를 담는다. 이 열차의 되돌리기 경계는 §4의 '9.0.14 최소 앱 빌드' 항목이다: App을 저장 최소 빌드(787) 아래로 되돌리기 전에 `lower`, 9.0.14 이상 App이 live인 동안 Signaling을 9.0.14 아래로 되돌리지 않음, PRO Worker를 9.0.14 아래로 되돌리면 모든 Worker의 최소 빌드가 꺼짐. App rollback 대상은 같은 PRO 입장 정책 표지를 가진 9.0.5 이상이고(9.0.4 아래는 불가), 787 아래 App(9.0.13 이하)으로 내리기 전에는 `lower` 0을 먼저 한다. 새 D1·비밀·바인딩·저장 데이터 마이그레이션은 없고, service-control 객체에 최소 빌드 키 셋(상태, 요청 journal, live 보고)이 더해졌다(옛 PRO Worker는 읽지 않고 남김). 기본 되돌리기는 더 높은 SemVer의 코드 되돌리기다([보고서의 배포·회복](design/forced-update-9-0-14-2026-10-25.md#배포회복)). 오너가 미리 정한 4D forward revert 계획(D1 `d5c66b9a`와 D2 `b385fad0`을 함께 되돌리고 registry RO-35를 되살림)은 §2 4D 항목에 그대로 열려 있고, 구버전 제거 열차 1의 R8이 같은 파일을 바꿨으므로 그 위에서 다시 맞춰야 할 수 있다. checkpoint는 사용자 데이터 백업이 아니다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 활성 복구 floor        | 앱 버전 최소 빌드 787(위 '최소 앱 빌드'). target `all`이라 PRO generation floor를 읽고 지켰다(floor release `4c5612d5`, 배포 동안 room-code 재사용을 막고 끝에 `ready`). 이미 있는 바닥 셋(신호 8.0.8, 일반방 입장 bootstrap 8.3.16, PRO 하트비트 9.0.0)은 그대로이고 최소 빌드가 그 위에 있다. PRO 입장 정책 계약 표지 `pro-room-optional-entry-password-v1+pro-owner-transfer-pinless-v1`(9.0.4부터), 9.0.0의 시스템 오디오 계약 표지 `single-stereo-v3+heartbeat-state-v1`(그대로), 8.11.33의 다중 재생목록 파일 앞으로만 복구(§4)와 기존 service-control·Soro·PRO 선택형 입장 암호 계약 유지                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 검증 범위              | Exact-main CI success(attempt 1, 11 jobs). PR #498 head `ceb96ea0` [CI 40279823254](https://github.com/hiefny/MUSIXQUARE/actions/runs/40279823254) 11/11 통과. Codex는 PR을 연 2026-10-26 14:43 KST에 head `401d3196`를 리뷰해 14:46 KST에 P1 하나를 남겼다(`cloudflare/github-actions-oidc.ts`: 두 호출자 job은 재사용 workflow가 아니어서 `job_workflow_ref`가 아니라 `workflow_ref`로 workflow를 밝히므로 진짜 토큰이 `OIDC_TOKEN_FORBIDDEN`으로 거절됨). 지적이 맞아 테스트 먼저 `345ca05e`(바탕에서 두 파일 119행 중 22 FAIL) → 수정 `66c90420`(119 PASS)로 고치고 그 스레드에 답했다. 그 뒤 push한 head에는 Codex가 리뷰를 다시 돌리지 않았고(자동 리뷰는 PR을 열 때만), 머지 스크립트의 20분 상한 뒤 15:56 KST에 squash 머지했다. 기록 시점(16:33 KST)에도 Codex 요약은 `401d319` completed, `has_unresolved_findings` true이고(스레드는 outdated, 해결 표시 없음) `ceb96ea0`의 결과는 없다. 수정은 배포 뒤 floor workflow `check`의 실제 토큰으로 처음 증명됐다(위 '최소 앱 빌드'). 릴리스 deploy job의 토큰(`raise_app_build_floor`)은 아직 쓰지 않았다. 테스트 먼저: 강제 업데이트 증분 일곱은 코드 부분을 치운 바탕에서 새 행이 FAIL했고, C5-12 Inc 1은 테스트 `7ee16397`의 새 기대 여섯이 부모에서 FAIL한 뒤 `21e20806`에서 PASS다(보고서 QA 라운드 1·2). 독립 리뷰 셋(라운드 3)과 릴리스 준비 리뷰 둘(라운드 5)의 높음·중간은 모두 반영했다. 로컬 Windows 최종 `2077ef60`(bump, 구버전 제거 열차 1 합침 `63027a68` 뒤): release-identity(9.0.14, v787)·sw-cache-version, unit 680 files 16,038 pass, Worker 67 files 3,152 pass, critical coverage 87 files 3,405 pass, typecheck(테스트 포함)·`check:workers`·lint·format·`build:checked` 전체(초기 JS 466,874 B로 유지 상한까지 24,694 B, main `4d7650c0` 대비 +2,286 B), 가드 묶음(resource-ownership 48 records / 442 files, navigation-sinks `SKIP_WAITING` 보내기 2·sink 호출 4, room-authority 직접 읽기 82, dead-exports, bus-pairing, import-graph), critical E2E 61/61, PRO 426 Playwright 2/2, 후보 Playwright 19/19(시작·복귀 확인 2행 포함), C5-0 랩 전체 `--repeat-each=2` 20/20(`forced-update.lab.ts` 4/4). Codex 반영 `66c90420`: unit 680 files 16,062, Worker 67 files 3,176, `build:checked` PASS. 실기기, 운영 브라우저의 강제 창, 실제 옛 탭의 거절, 최소 빌드가 켜진 운영 Signaling의 787 입장은 아직이다(§2). [보고서](design/forced-update-9-0-14-2026-10-25.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 잔여 성능 조사         | 리버브 팝 원인은 실기기에서 미확정이다(9.0.0 이후 변화 없음). 9.0.0으로 리버브 Off의 계산은 거의 0이 됐고 켠 상태에서도 가상 저음·익사이터 몫이 빠졌다. 제보 기기 재확인은 §2에 유지한다. 허용 위험 #18은 2026-10-25 운영 9.0.10의 오너 실기기 확인으로 은퇴했다([은퇴 기록](known-accepted.md#retired-risks), §2 최근 해결 근거)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Operations Drift Audit | 배포와 첫 최소 빌드 뒤 [40285137773](https://github.com/hiefny/MUSIXQUARE/actions/runs/40285137773) attempt 1, `dd9c9d4d`, automated-checks-passed: 32 pass / 0 fail / 5 manual-only. 새 App build floor 행 PASS('Stored floor 787 (enforced 787) is within the live App build 787 reported 39 s ago.'). 매일 03:37 UTC 일정과 §3 수동 항목 유지                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Full E2E               | 매주 월 18:17 UTC. 이번에 전체 직렬 E2E를 재실행하지 않았다. 최신 정기 main 실행은 여전히 [39334520177](https://github.com/hiefny/MUSIXQUARE/actions/runs/39334520177)(`3d409c9a`, failure)이고, 그때 확인한 `playlist-delete-mode-layout` 실패는 #444에서 고쳤다. 이번 브라우저 근거는 exact-main CI의 candidate·critical browser와 로컬 critical 61/61, PRO 426 2/2, 후보 19/19, C5-0 랩 20/20(위 검증 범위)이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 의존성·호환            | 신규 의존성·D1 스키마·비밀·바인딩·Wrangler 설정 변경 없음. 운영 9.0.13과 견준 바뀐 런타임 경로는 여섯 Worker 모두에 있다(remote-share 2, signaling 4, PRO room 4, Developer API facade 2, Developer API 2, App 24). 새 것: App Worker 경로 넷(공개 상태 `/api/app-build-floor`, 페이지 읽기 `/api/app-build-floor/effective`, 관리자 `/api/admin/app-build-floor`, ops `POST /api/ops/app-build-floor`), 기존 매분 cron의 live App 보고, `.github/workflows/app-build-floor.yml`, Production Release 입력 `raise_app_build_floor`와 deploy job의 `id-token: write`, service-control 객체의 최소 빌드 키 셋. 통신: 클라이언트가 보내는 쪽에만 더했다(Standard `host-auth`·`guest-auth`의 선택 키 `appBuild`, PRO 헤더 `X-MXQR-App-Build`). 거절은 거절되는 소켓에만 가는 새 `error` 프레임과 close 1008, PRO 426 `{"error":"APP_UPDATE_REQUIRED","minAppBuild":N}`이고, 옛 클라이언트가 정확한 키로 읽는 몸통·프레임에는 필드를 더하지 않았다. 9.0.14 App의 방장은 9.0.14 이상 Signaling에만 붙는다(옛 Signaling의 정확한 키 검증이 `appBuild`를 거절, §4). 초기 JS 466,874 B(+2,286 B), SW 앱 셸 97 자산 그대로, 새 첫 로딩 청크 없음. 혼합 방: known-accepted #13(버전 입장 제한 없음)은 첫 최소 빌드로 은퇴했다([은퇴 기록](known-accepted.md#retired-risks)). 최소 빌드 787부터 9.0.13 이하(5A와 구버전 제거 열차 1 포함)는 새 입장과 재접속에서 거절되고, 이미 맺어진 P2P 세션과 PRO presence는 계속되며 다시 열면 새 버전으로 들어간다. Worker는 방장의 빌드를 기록하지 않으므로 9.0.14 게스트는 낮은 방장이 이미 연 방에 그 방장의 다음 `host-auth`까지 들어갈 수 있다. 그래서 구버전 제거 열차 1(9.0.13)의 통신 변화(일반방 P2P 메시지 종류 121 → 103, 지금 모든 송신자가 넣는 필드를 필수로, PRO 방의 브라우저 데이터 연결 거절, 로컬 파일 게스트를 방 크기로만 나눔, 보조 경로가 READY 뒤 모든 상대와 재시작)와 그 R4 통신 예외(9.0.10~9.0.12 방장의 효과별 뒤따름 프레임 14개를 버림), 수용한 옛 탭의 나빠짐(오너 정책)은 이제 첫 최소 빌드 전에 맺어진 세션에서만 닿는다. 9.0.12 이하가 아직 요구하는 DEMO_PLAY `hostPlayAt`, FILE_R2_CAPABILITY, `restart-capable`은 계속 보낸다. 보내는 쪽 제거(OV-F05·F06·F03)의 조건(클라이언트 바닥 9.0.13 이상)은 새 입장에서 채워졌고, 오너 결정 Q4의 순서(받는 쪽, 최소 빌드, 보내는 쪽)로 뒤 열차가 한다. C5-12 Inc 3(방장 경로 허락 기계 제거)도 Q3대로 최소 빌드가 켜진 뒤의 열차다. 5A의 시스템 오디오 수신 슬롯(동작, MSG 리터럴과 프레임, 계약 표지, 판독 줄, 타이머 이름 그대로, 지연 청크 `system-audio-receive-slot`), 4D의 보조 경로 기한 규칙(끊김당 15초, 30초 상한, `RTC_INTERRUPTION_GRACE_MS`에서 끌어냄, 세부는 오너 확인 대기, §2), 4C의 C5-8 규칙(원래 경로 재시작 창에서 bulk를 막고 미리받기를 주인의 `connected`까지 멈춤, 보조 경로만의 끊김은 막지 않음), 4B의 C5-12 규칙(9.0.14 게스트는 Inc 1로 넓어짐), 9.0.9의 탭 sessionStorage 진단 키 `mxqr-prev-close`, 9.0.5의 개발 의존성 보안 overrides와 일반방 `1012 / ROOM_EXPIRED` 처리, 9.0.4의 통신 변화(PRO 이전 PREPARE의 `newPin`은 선택), 9.0.0의 호환 변경, 8.11.37 프리로드 복구 정책, 8.11.33 PRO 저장 키·opt-in 헤더·Developer API 1.1 유지. 이 열차는 새 sessionStorage 키 `mxqr-forced-apply`(강제 Apply 재로드 루프 막기)를 더한다 |

## 2. 열린 확인 항목

해결하면 근거(커밋, 실행 ID, 문서)를 PR 설명에 적고 이 목록에서 지운다. 근거
없이 완료로 표시하지 않는다.

### 구버전 호환 코드 제거 열차 2 릴리스 A(9.0.15/v788, 배포 전): 바닥 787 아래만 섬기던 앱 쪽 호환 코드

- [ ] 범위와 상태(오너 정책 2026-10-25 약 16:40 KST, 바닥 결정 약 18:30 KST, 작은 통신 필드 2026-10-26 약 00:10 KST, 5B와 병렬 약 14:10 KST): 최소 앱
      빌드 787(2026-10-26 16:15 KST부터 켜짐) 뒤에야 지울 수 있는 앱 쪽 호환 코드. 브랜치 `agent/old-version-removal-2a`(origin/main `dd9c9d4d`에서
      시작, 릴리스 W 배포 뒤의 origin/main `a3893f04`(#499, #500)를 합침 `bbc4d9bd`에서 받음)의 앱 증분 여섯마다 테스트 먼저, 코드, 기록 커밋이 있고, 마지막 런타임
      커밋은 bump `8407046a`(9.0.15 / v788, 앱 빌드 788, 올리기 직전 fetch한 origin/main `a3893f04`는 9.0.14 / v787)다. A-1 C5-12 Inc
      3(`23690c92`, 복구 뒤 미리받기가 방장의 경로 재판정 없이 같은 짝의 본 레인에 물러나고 경로 허락 기계를 지움, 기기 근거 세 줄은 바이트가 같음), A-2(`e1d4a25a`, bulk
      수신확인과 제어 격리가 상대 hello를 기다리고 1초 대체를 지움, `restart-capable` 광고를 보내지 않음), A-3(`59cdda6d`, 신호 클라이언트가 Worker peer-open 표지와
      첫 SDP 재시작 표지를 읽지 않음, 재개 확인 ping의 `guestTime` 삭제, 원격 공유 확인서는 'required'만), A-4(`18fd2d85`, DEMO_PLAY `hostPlayAt`과
      `FILE_R2_CAPABILITY` 보내기 중단으로 일반방 메시지 종류 103 → 102, SESSION_FULL `message`와 OPERATOR_TOAST `text`를 선택으로 받음, 열차 1이 남긴
      받기 허용 정리), A-5(`ac04a57c`, PRO 클라이언트의 9.0.4 표지 아래 PRO Worker용 재시도·대체와 부르는 곳 없는 PRO API, 문구 키 다섯 삭제), A-6(`789848bc`,
      SW 활성화의 옛 runtime 캐시 청소와 루트 영문 매니페스트, 고아 문구 키 셋, 개발 프록시의 playlist-entry 경로 삭제, 업데이트 재로드 대체 갈래와 쿨다운 상한은 말만). 잃는 것:
      운영의 787 이상 클라이언트는 없다. 787 아래 상대는 유효 바닥이 0인 창에서만 미리받기 뒤 '파일 요청 중' 멈춤, 8.11.22 이하와의 bulk 멈춤, 8.11.25~9.0.12와의 보조 경로 끊김
      때 닫힘, 9.0.12 이하 데모 게스트의 데모 시작 실패, 9.0.12 이하 방장의 아홉째 로컬 게스트 REMOTE_FILE_UNAVAILABLE을 겪는다(오너 정책이 수용). 릴리스 W는
      2026-10-27 03:34 KST에 배포됐고([Release 40378059253](https://github.com/hiefny/MUSIXQUARE/actions/runs/40378059253),
      target `all`, `a3893f04`) W 직후 같은 값 `set`
      [40379025557](https://github.com/hiefny/MUSIXQUARE/actions/runs/40379025557)이 통과했다(stored 787, effective 787, live
      App 787, client read 787). 로컬 검증: 테스트 먼저(여섯 테스트 커밋이 부모 코드에서 의도한 행만 FAIL), 증분마다 typecheck(테스트
      포함)·`check:workers`·lint·format·가드 묶음(room-authority 직접 읽기 82 → 81로 내림)과 단위, 열차 끝 레인 검사(`d184518c`)의 C5-0 랩
      `--repeat-each=2` 19/20(보조 경로 행의 한 반복이 회복 뒤 보조 채널 첫 데이터를 기다리다 일시정지 3초 창을 넘김, 앱 오류·유실 없음, 열차 1과 같은 랩 시간 여유 문제로 판독, 그
      행만 다시 이 갈래 4/4와 main `dd9c9d4d` 4/4), 합친 트리(`bbc4d9bd`)의 typecheck·단위·가드 다시 검사(기준치 변화 없음). bump 뒤 최종 검사(`8407046a`,
      2026-10-27): `guard:release-identity`(9.0.15, v788)·`guard:sw-cache-version` PASS, typecheck(테스트
      포함)·`check:workers`·lint·format, 단위 680 files / 16,052, Worker 67 files / 3,182, `build:checked` 전체 PASS(SW 앱 셸 96
      자산), 가드 묶음(room-authority 직접 읽기 81·구독 22·쓰기 13, resource-ownership 48 records / 442 files, dead-exports 20/76,
      bus-pairing 202/202), critical E2E 61/61, 핵심 커버리지 87 files / 3,403, 후보 Playwright 19/19, PRO Playwright 26/26, C5-0
      랩 `--repeat-each=2` 20/20(보조 경로 행 2/2, 회복 뒤 보조 채널 첫 수신 0.5~2.5초), 초기 JS 465,767 B(운영 main `a3893f04` 466,874 B 대비
      −1,107 B, 유지 상한까지 25,801 B). 운영 `a3893f04`와 견준 런타임 경로 변경은 App 79개, 다른 다섯 Worker 0개라 target `app`이다. 남은 것: 릴리스 W 기록
      PR(문서만)이 main에 들어오면 다시 합침(bump는 그대로), 배포 직전 `status`로 바닥 787 이상 확인(요약 줄을 보고서에), 열차 끝 세 렌즈 리뷰, PR CI, Codex,
      exact-main CI, Release(target `app`, Developer API D1 false, `raise_app_build_floor` false), 기록 PR. 기록 PR은 §1을 덮어쓰며
      '의존성·호환'에서 4B C5-12의 혼합 버전 남은 위험 문장(9.0.4~9.0.8 게스트, 이제 바닥 아래)을 빼고 `release-history.md`에 한 행을 더한다. 열차 3(보내는 쪽)의 바닥은
      max(릴리스 A 빌드 788, 5B 빌드)다. 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다.
      [보고서](design/old-version-removal-2a-app-2026-10-26.md).
- [ ] 배포 뒤 실기기 확인(게이트 아님, 2026-10-25 약 01:50 KST 결정): 와이파이에서 LTE로 바꾸는 중 미리받기(A-1,
      `?mxqrLog=info`, 본 레인이 이미 그 짝을 잡은 경우 방장 줄은 `Resuming` 없이 `Paused`와 `Yielding`만), 강제 업데이트
      창의 적용 뒤 방장의 제자리 재로드가 창 없이 끝나는지(A-6), 9.0.14 기기와의 혼합 방 두 방향(로컬 파일 재생과 미리받기,
      데모 시작, 방 가득 참, 관리자 알림, 보조 경로 재시작).
      [확인하지 않은 것](design/old-version-removal-2a-app-2026-10-26.md#확인하지-않은-것).

### 구버전 호환 코드 제거 열차 2 릴리스 W(Worker만, 배포 전): 최소 빌드 787 아래 앱의 요청 모양을 Worker에서 정리

- [ ] 범위와 상태(오너 정책 2026-10-25 약 16:40 KST·약 18:30 KST, 작은 통신 필드 2026-10-26 약 00:10 KST, 열차 2와
      5B 병렬 2026-10-26 약 14:10 KST): 최소 앱 빌드 787(2026-10-26 16:15 KST, App Build Floor `set` 40284593490)이 켜져
      787 아래 앱은 새 입장과 재접속에서 거절된다. 이 릴리스는 그 아래 앱만 보내던 요청 모양을 Worker 넷에서 지운다. 브랜치
      `agent/old-version-removal-2w`(origin/main `dd9c9d4d`에서 시작): W-1 Remote Share(OV-W04) `a121040c` → `cc83cfa7`,
      W-2 PRO(OV-W01, OV-F07 PRO 쪽, presence/close 세 필드 선택 받기) `6b03ed43` → `6812c8b1`(리뷰 반영 `074c0f70`,
      `4e86ab7d`, `f9c4f804`), W-3 Signaling(OV-W03, smoke·floor 도구의 옛 Signaling Worker 재시도 갈래) `430da8c6` →
      `6f5b4aea`(리뷰 반영 `4b0a8e14`, `9754402a` → `7a683476`), W-4 App Worker(OV-W02의 SK-12·13·15·16, OV-F07 facade,
      지표 이름표) `e2cb7dd9` → `110ac9dd`, 열차 끝 리뷰 반영 `d5385500` → `a0b858fc`(PIN이 든 만료 대기 이전 레코드를
      남기고 PIN만 버림), `b3f9c69d`(9.0.14 App Worker와의 혼합 버전 saga 행). 바뀌는 것: Remote Share는 v3 세션 본문만
      받고 `optional` 확인서 모드는 무효 설정(503)이다. PRO는 opt-in 머리글 없이도 `passwordRequired`와 `playlistSlots`를
      싣고, 임시 PIN 활성화, `{pin}` 입장, 이전 PREPARE의 `newPin`, 참가자 id 내보내기, 제어 버전 ticket 본문을 400으로,
      `/effects`, 명령 ACK, `DELETE /sessions/current`를 404로 답하며, presence/close의 `baseRevision`,
      `currentQueueItemId`, `playback`을 선택으로 받는다(있으면 검사, fingerprint 바이트 그대로). 기록이 모두 만료된 저장
      이주 셋을 지웠고, 9.0.4 전 PRO가 쓴 PIN이 든 대기 이전 레코드는 남기며 그 PIN만 읽지 않고 지운다(만료된 대기
      레코드는 지우는 곳이 없어 새 PREPARE나 commit 전까지 이전 소유자 연결을 들고 있다). Signaling은 `host-auth`에
      `desiredRoomPassword`와 `pinMutationId`, room-password-set에 `pinMutationId`를 요구하고 `legacy-<uuid>` PIN 울타리를
      지웠다. App Worker는 `/api/youtube-playlist-entry`를 내리고(404), 세 필드 관리자 공지 본문과 `newPin` 이전 본문을
      400으로 거절하며, `{pin}` 입장에도 5초 기한을 두고, 이전 commit에 opt-in 머리글을 넘기지 않는다. 9.0.14 이상 App의
      요청과 답은 그대로다. release smoke와 floor 도구는 같은 증분에서 고쳤다(PRO 카나리아와 floor PRO 증명이 opt-in
      머리글을 보내고 `000001`의 일관된 쌍을 받음, 모든 `host-auth`가 PIN 두 필드를 실음, 첫 프레임 무효는 두 원인을 적고
      재시도 없이 즉시 실패. 신호 smoke 출력에서 `appBuild.hostAuthShape`가 빠져 hotfix 절차의 첫 바닥 증명 문장을 고침).
      SemVer와 SW 캐시는 그대로라(`guard:release-identity` 9.0.14·v787, `guard:sw-cache-version` PASS) 업데이트 창이 없다.
      운영 `dd9c9d4d`와 견준 런타임 경로 변경은 remote-share 1, signaling 3, PRO room 2, App 3(`app-worker.ts`와 App
      경로에도 든 신호 파일 둘), Developer API facade·API 0이라 target `all`이다. 계약 표지, D1, 비밀, 바인딩 변경은 없다.
      로컬 검증(`110ac9dd`, 2026-10-27): 테스트 먼저(테스트 커밋 다섯이 부모 코드에서 새 행만 FAIL, W-2는 `074c0f70`
      고정값 정정을 얹어. 고정값 커밋 둘은 부모에서도 PASS),
      `npm run typecheck`·`typecheck:tests`·`check:workers`·lint·format, 단위 680 files / 16,065, Worker 67 files / 3,176,
      smoke·floor 묶음 22 files / 585, `build:checked` 전체(직접 읽기 82, SW 앱 셸 97 자산, 초기 JS 변화 0, 진입 청크
      `main-CaKT24Ie.js`가 운영 9.0.14와 같음), 가드(dead-exports 20/20·76/76, bus-pairing 202/202, import-graph,
      lifecycle-writes, navigation-sinks, transport-health, resource-ownership 48 records / 442 files 그대로),
      커버리지(critical 87 files / 3,406, Worker 67 / 3,176, 도구 14 / 419), critical E2E 61/61, `e2e/youtube.test.ts`
      9/9, Worker 번들 dry-run(raw 기준 PRO −12.83 KiB, App −5.85 KiB, remote-share −1.63 KiB, signaling −0.91 KiB). 가드
      기준치와 registry 기록 수는 바뀌지 않았다(RO-07·RO-09 문장만). 열차 끝 리뷰(`4f6be4c8`, safety·quality-docs 렌즈)
      반영 뒤(`a0b858fc` 런타임, 2026-10-27): `d5385500`이 `4f6be4c8` 코드에서 새 두 행만 FAIL, 단위 680 files / 16,069,
      Worker 67 files / 3,180, 혼합 버전 saga 14/14(9.0.14 빌드 양방향 포함), 정적·lint·format과 위 가드 PASS,
      `check-resource-ownership` 출력이 `dd9c9d4d`와 바이트가 같음. 남은 것: origin/main `9e02d2df`(#499, 문서만) 합침과
      검사 다시, PR CI, Codex, exact-main CI, 배포 직전 floor `status`(저장·유효 787 이상, live App 보고 새것),
      Release(target `all`, Developer API D1 false, `raise_app_build_floor` false), 아래 같은 값 `set`, 기록 PR. 순서: 이
      릴리스를 App 릴리스 A보다 먼저 낸다. PR은 배포 직전에만 머지하고, 그 머지부터 배포와 기록 PR 머지까지 5B와 릴리스
      A는 머지·릴리스하지 않는다(이 PR이 main에 있고 배포 전이면 두 App 열차는 부분 릴리스 게이트에서 거절된다). 기록 PR은
      §1을 덮어쓰며 Worker마다 배포된 기준으로 이 릴리스의 머지된 main SHA(여섯 모두)를 적고(`dd9c9d4d`는 배포 전
      checkpoint이자 되돌리기 대상이다), §4에 이 릴리스의 되돌리기 경계(PRO만 W-2 앞으로 되돌리고 App Worker를 W-4에 두면
      이전 링크 답에 `passwordRequired`와 `playlistSlots`가 빠짐, 9.0.14 아래 Signaling에서는 smoke와 floor 도구가 즉시
      실패)를 더하고, §4 'PRO 공개방 입장 보호' 문단의 공유 원장 presence-close 영수증 문장(이제 로드가 아니라 보통의
      prune이 푼다)을 고친다. 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다.
      [릴리스 W 보고서](design/old-version-removal-2w-workers-2026-10-26.md).
- [ ] 배포 직후 floor 도구 운영 확인(W-verify, 기록 PR 전): Release run과 smoke가 끝나고 같은 동시성 그룹에 돌거나
      기다리는 실행이 없을 때 `app-build-floor.yml`을 `set`, `min_app_build=787`(같은 값)로 dispatch한다. 저장값이 같아
      'the stored floor is already 787; verifying it' 뒤 `verifyFloor`(opt-in 머리글을 보낸 PRO 카나리아 쌍, PIN 필드를 실은
      Signaling 탐침의 786 거절, cron 보고, 클라이언트 읽기)만 돈다. 상태를 바꾸지 않는 검증이라 묻지 않는다. run ID와 요약
      줄을 기록 PR에 적는다. 실패하면 바닥은 787 그대로이고, floor 도구를 앞으로 고친 뒤 같은 실행을 다시 한다. 열차 3의 바닥
      올리기는 이것이 통과할 때까지 하지 않는다. 이 릴리스의 신호 smoke는 바닥 787이 켜진 운영에서 빌드 787 입장과 빌드 없는
      방장의 정확한 거절을 처음 보므로, 기록 PR은 그 결과를 §2 강제 업데이트 항목의 'Signaling의 787 입장' 근거로 인용할 수
      있다. [배포·회복](design/old-version-removal-2w-workers-2026-10-26.md#배포회복).
- [ ] 배포 뒤 확인(게이트 아님): 운영에서 일반방 방장 암호 설정과 '모두 재입장'이 그대로인지, PRO 탭을 닫으면 참가자
      목록에서 바로 빠지는지(presence/close) 본다. PRO 소유권 이전 링크 확인은 아래 Phase 2 9.0.4 묶음의 소유권 이전 항목에 적힌
      오너 결정대로 다음 실제 이전 때 한다. [확인하지 않은 것](design/old-version-removal-2w-workers-2026-10-26.md#확인하지-않은-것).

### 강제 업데이트 열차(9.0.14/v787) 배포 뒤 확인: 최소 앱 빌드와 C5-12 Inc 1

- [ ] 범위와 상태(오너 정책 2026-10-25 약 16:40 KST, 결정 약 18:30 KST의 Q1~Q4, 약 22:00 KST 시작·복귀 확인 추가,
      설계 Q-A는 A): 클라이언트가 빌드 번호(SW 캐시 epoch 정수)를 Standard `host-auth`·`guest-auth`(재접속 포함)의 선택 키
      `appBuild`와 모든 PRO 요청의 헤더 `X-MXQR-App-Build`에 싣고, Signaling Worker(첫 인증 프레임, 입장 전)와 PRO
      앞문(bootstrap, sessions, presence/enter)이 유효 최소 빌드보다 낮은 새 입장을 거절한다(signaling은 그 소켓에만
      `app-update-required` 오류 프레임과 close 1008, PRO는 426). 유효 최소 빌드는 service-control 객체의 저장값과 App
      Worker가 매분 보고하는 live App 빌드 중 낮은 값이고 보고가 5분 넘으면 0이다(registry RO-50). 맺어진 세션은
      닫지 않는다. 거절되거나 시작·전경 복귀 때 읽은 최소 빌드(`GET /api/app-build-floor/effective`, 엣지 캐시 30초)보다
      낮은 9.0.14+ 페이지는 같은 업데이트 대화상자를 '나중에' 없이 연다(RO-22. Back으로 닫히지 않음, 방·데모는
      `/CODE`로, worker가 없으면 `registration.update()` 뒤 재로드, sessionStorage `mxqr-forced-apply`로 재로드 루프
      막음). 복귀 때 창은 강제 창 > 오디오 복구 창 > 오래 백그라운드 경고 하나다(새 기록 RO-51). 설정은 GitHub
      Actions OIDC(`app-build-floor.yml`, Production Release 입력 `raise_app_build_floor`)로만 하고 관리자 대시보드는
      내리기만 한다. 새 비밀·바인딩·D1 스키마는 없다. C5-12 Inc 1: 미리받기를 기다리는 이 열차 게스트는 방장이 직접
      허락한 자기 세션의 본 레인 머리를 어느 경로에서든 받는다(RO-18 경로 2와 '요청 전' 틈이 새 게스트에게서 닫힘,
      옛 게스트와 방장은 그대로). 브랜치 `agent/forced-update`(`244aca48` 위): Inc 1 `beb3369c`, Inc 2 `93aa4f5f`,
      Inc 3 `20b446c3`, Inc 4 `45754035`, Inc 5 `2229356e`(리뷰 `fa55e2a0`·`2c0a55ed`), Inc 6 `ebf4c0ff`, Inc 7
      `c8b2cf38`, C5-12 Inc 1 `7ee16397` → `21e20806`, 5A 합침 `ac114b37`(글자 충돌 없음)과 5A 기록 #495 합침
      `f66195cd`(문서만), 리뷰 반영 `efd2ed11`(floor 도구), 구버전 제거 열차 1 합침 `63027a68`(문서 둘의 글자 충돌, 두
      열차 항목을 모두 둠), 이름 커밋 `3c301881`(보고서 이름과 주석·문서의 번호, 런타임 동작 없음), 마지막 PWA
      런타임 커밋인 bump `2077ef60`, 문서(구버전 제거 열차 1 기록 #497 합침 `ac29f691`, §2 제목 하나만 충돌), Codex
      P1 반영(ops 경로의 OIDC가 호출 workflow를 `workflow_ref`로 확인하고 재사용 workflow 안에서 만든 토큰은 거절)
      테스트 `345ca05e` → 수정 `66c90420`(Worker 파일만이라 다시 올리지 않음. 단위 680 files / 16,062, Worker 67 files /
      3,176, `build:checked` PASS, 보고서 라운드 6)는 PR #498 squash `dd9c9d4d`(2026-10-26 15:56 KST, 트리는 PR head
      `ceb96ea0`와 같음)로 main에 들어갔다.
      5A가 9.0.12 / v785를(2026-10-26 10:34 KST 배포), 구버전 제거 열차 1이 9.0.13 / v786을(#496,
      Release 40265098681로 배포, 기록 #497) 먼저 썼으므로 bump `2077ef60`에서 `9.0.14` / `v787`로 SemVer와 SW 캐시 epoch를 함께
      올렸다(올리기 직전 fetch한 origin/main은 `4d7650c0`). bump 뒤 최종 로컬(`2077ef60`): release-identity(9.0.14,
      v787)·sw-cache-version, 단위 680 files / 16,038, Worker 67 files / 3,152, critical coverage 87 files / 3,405,
      typecheck(테스트 포함)·`check:workers`·lint·format, `build:checked` 전체, 가드 묶음(resource-ownership 48 records /
      442 files, navigation-sinks의 `SKIP_WAITING` 보내기 2·sink 호출 4, 직접 읽기 82), critical E2E 61/61, PRO 426
      Playwright 2/2, 후보 Playwright 19/19(시작·복귀 확인 2행 포함), C5-0 랩 전체 `--repeat-each=2` 20/20
      (`forced-update.lab.ts` 4/4) PASS. 초기 JS 466,874 B(main `4d7650c0` 464,588 B 대비 +2,286 B, 유지 상한까지
      24,694 B). 오너 결정대로 자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과해 따로
      묻지 않고 2026-10-26 16:10 KST [Release 40283632968](https://github.com/hiefny/MUSIXQUARE/actions/runs/40283632968)
      (target `all`, Developer API D1 false, `raise_app_build_floor` false, attempt 1)로 배포했다(§1). 여섯 Worker
      모두 이 SHA의 버전이고 Signaling이 App보다 먼저 나갔다. 배포 전 기준은 App `4d7650c0`, 나머지 다섯 Worker는 9.0.5
      `572880a2`였고 checkpoint가 그대로 보존한다. signaling smoke 503 실패는 없었다. PR head의 Codex는 PR을 연 head
      `401d3196`에서 P1 하나(OIDC `workflow_ref`)를 냈고 위 테스트 먼저 쌍으로 고쳐 답했으며, 마지막 head `ceb96ea0`에는
      결과가 없다(§1 검증 범위). 그 수정은 배포 뒤 floor workflow `check`의 실제 토큰으로 처음 증명됐다. 첫 최소 빌드
      787은 16:15 KST에 켰다(§1 '최소 앱 빌드', §2 최근 해결 근거). 이 열차의 복구 경계는 §4에 더했다. 로컬 결과는
      exact-main-SHA 후보를 대신하지 않는다. exact-main CI, Release 실행, 배포 SHA는 §1에 있다. 설계 질문 Q-B(60분
      업데이트 확인 tick에서도 최소 빌드를 읽을지)는 오너가 2026-10-26 약 14:05 KST에 기본 No 유지로 답했고, 구현 세부(보고서의 '구현과 리뷰
      중 정한 세부')는 오너 확인을 기다린다(게이트 아님). [보고서](design/forced-update-9-0-14-2026-10-25.md).
- [ ] 오너 확인(게이트 아님, 첫 최소 빌드 뒤): 최소 빌드 787이 켜진 운영에서 9.0.14 기기가 방장으로 Standard 방을
      만들고 게스트가 들어오는지(Signaling의 787 입장) 본다. 방장 쪽은 오너가 2026-10-26 약 16:33 KST에 확인했다(9.0.14로
      일반방을 만들고 정상으로 들어감, [오너 기기 확인 A](design/forced-update-9-0-14-2026-10-25.md#오너-기기-확인-게이트-아님)의
      결과). 게스트 입장과 아래 옛 탭 거절은 아직이다. `set` 40284593490의 확인은 Signaling에서 786 거절만 보고
      787 입장은 보지 않으며(PRO는 786 거절과 787 입장을 모두 봄), 릴리스 smoke의 787 입장은 최소 빌드가 0일 때였다.
      runbook의 `set` 직후 Signaling smoke(`npm run smoke:live:signaling`, 빌드 787 방장·게스트 입장, 빌드 없는 방장은
      787에서 거절) 결과는 이 기록에 없다. 지금 근거는 코드(`cloudflare/signaling-worker.ts`: `appBuild`가 유효 최소
      빌드 이상이면 거르지 않음)와 Worker 단위 테스트뿐이다. 방장이 거절되면 곧바로 `lower` 0이다
      ([운영](hotfix-procedure.md#app-build-floor)). 함께 실제 9.0.13 이하 탭(업데이트하지 않은 탭)이 방 만들기나 입장에서
      일반 오류를 한 번 보이고, 닫고 다시 열면 새 버전으로 들어가는지 본다. 그 거절은 아직 코드 읽기와 랩(빌드 없는 날
      소켓)으로만 확인했다. [오너 기기 확인 A](design/forced-update-9-0-14-2026-10-25.md#오너-기기-확인-게이트-아님).
- [ ] 배포 뒤 실기기 확인(게이트 아님): 맺어진 세션 유지(첫 최소 빌드 전에 연 방이 계속 재생하고 9.0.14 게스트가
      들어갈 수 있음), 그리고 다음 올리기 때 홈 화면 앱·Android·Windows의 복귀 강제 창(나중에 없음, Back으로 닫히지
      않음, 방에서 `/CODE`, 방장은 제자리, 오프라인 복귀는 창 없음, 1분 안 여러 번 오가도 창 하나, 60초 넘은 방 복귀는
      강제 창 하나). 실제 PWA 복귀, 운영 브라우저의 강제 창, 여러 colo의 엣지 캐시, 릴리스 deploy job의 OIDC 토큰(올리기
      입력)은 아직 확인하지 않았다. GitHub OIDC 끝까지(floor workflow의 토큰, `check` 40284513979)와 운영 매분 cron 보고
      (`status` 40284433812와 `set`의 새 보고), 한 colo의 페이지 읽기(`set`의 client read 787)는 첫 최소 빌드에서 확인했다.
      [오너 기기 확인](design/forced-update-9-0-14-2026-10-25.md#오너-기기-확인-게이트-아님).
- [ ] (낮음) 배포 직후 공개 최소 빌드 상태의 503: 배포 세션이 본 대로 App 배포(16:10:11 KST) 뒤
      `GET /api/app-build-floor`가 16:11:17, 16:11:48, 16:12:19 KST에 503 `APP_BUILD_FLOOR_UNAVAILABLE`이었고, 첫 매분
      cron 보고(그때 본 `reportedAt` 07:12:47Z) 뒤 16:12:49 KST에 200이 됐다. 그동안 페이지 읽기는 `effectiveMinAppBuild`
      0을 답했다(최소 빌드가 0이었으므로 사용자 영향 없음). 코드 판독: 보고가 한 번도 없는 객체도 HEAD 상태에 유효한
      헤더(`revision` 0, 최소 0, `updatedAt`·live 빌드·보고 시각 `null`, state `valid`)를 싣고,
      `appBuildFloorFromHeaders`(`cloudflare/service-maintenance.ts`)가 그것을 live로 받아 상태 경로(`handleAppBuildFloorStatus`,
      `cloudflare/app-worker.ts`)가 200과 `reportedLiveAppBuild` null을 답한다. 실제 객체로 도는 단위 테스트('treats ... as
      no live build and reads it again later')가 그 경로다. 그래서 '보고 없음' 자체는 원인이 아니다. 상태 경로는 읽기가
      live가 아닐 때만 503이고, 그것은 객체가 floor 헤더 없이 답하거나(404·405면 floor 경로가 없는 옛 객체로 보고
      unsupported) 실패, 2초 시한 초과, 헤더 검증 실패일 때다. 가설: PRO Worker 배포(16:07:29 KST) 뒤 몇 분 동안
      service-control Durable Object가 9.0.14 전 코드(floor 경로 없음)로 답했고, 같은 까닭으로 그 전의 매분 보고도
      실패했으며, 객체가 새 코드로 다시 시작한 뒤 첫 보고가 들어갔다. 확인하지 않음: App Worker 로그의
      `[App build floor] live App build report failed` 경고와 그 시각 객체의 응답 상태. 같은 창에서는 Signaling과 PRO
      앞문도 최소 빌드를 0으로 읽는다(fail-open). 그래서 다음에 PRO Worker를 함께 배포하는 릴리스가
      `raise_app_build_floor`를 켜면 커밋 표지 뒤의 올리기가 이 창에 닿아 실패할 수 있고(릴리스는 커밋된 채 남고
      standalone `set`으로 다시 함), 최소 빌드가 켜진 동안 PRO Worker를 배포하면 그 몇 분 동안 강제가 꺼질 수 있다(둘
      다 추론). 코드는 바꾸지 않았다. 다음 PRO 배포 때 App 로그와 공개 상태를 함께 보면 가설을 가를 수 있다.
      [보고서 QA 라운드 7](design/forced-update-9-0-14-2026-10-25.md#7-pr-ci-exact-main-ci-배포와-첫-최소-빌드-2026-10-26).

### 구버전 호환 코드 제거 열차 1(9.0.13/v786) 배포 뒤 확인: 이미 있는 바닥 아래만 섬기던 호환 코드

- [ ] 범위와 상태(오너 정책 2026-10-25 약 16:40 KST, 병렬 결정 약 22:30 KST, 통합 순서 변경 2026-10-26 약 05:10
      KST): 옛 앱 버전은 더 이상 설계 제약이 아니다. 이 열차는 옛 버전 호환 조사(2026-10-25)의 항목 가운데
      클라이언트 바닥이 필요 없고 강제 업데이트·5A 열차의 파일과 겹치지 않는 것만 실었다(OV-A01~A03, OV-A05~A17(A08은
      시스템 오디오 밖, A12는 신호 파일 밖, A15는 방장 쪽), OV-A21·A24, OV-B01·B02 1단계·B03·B04·B07 1단계·B08, TR-15는
      다시 보고 남김). 이미 있는 바닥 셋(신호 8.0.8,
      일반방 입장 bootstrap 8.3.16, PRO 하트비트 9.0.0)이 대상 송신자를 막고 있어 강제 업데이트 없이 지웠다. 브랜치
      `agent/old-version-removal-1`(origin/main `244aca48`에서 시작, `2d605739`를 `9a05077b`로, 5A와 그 기록 `dea1432a`를 `0ea38375`로 합침)는
      PR #496 squash `4d7650c0`로 main에 들어갔다. 증분 여덟(R1~R8)마다
      테스트 먼저와 코드 커밋, 이 열차 자신의 마지막 런타임 커밋 `e37c7992`. 마지막 런타임 커밋 bump `3acfefc8`에서
      `9.0.13` / `v786`로 올렸고 2026-10-26 12:41 KST [Release 40265098681](https://github.com/hiefny/MUSIXQUARE/actions/runs/40265098681)(target `app`)에 배포됐다(§1). 통합 순서 변경으로 5A와 이 열차는 준비되는 대로 나갔고, 5A가 `9.0.12` / `v785`로 같은 날 10:34 KST 먼저, 이 열차가 바로 다음이었다. 바뀌는 것:
      일반방 P2P 메시지 종류 121 → 103(코디네이터 시대 PRO 메시지 넷, 원자적 설정 동기화 전의 효과별 메시지 14),
      지금 모든 송신자가 넣는 필드(PAUSE `reason`, FILE_PREPARE `size`, DEVICE_LIST 행, OPERATOR_GRANT 목록,
      REMOTE_FILE_* `delivery: 'r2'`, 유튜브 `hostClock`, zero-start v2)를 필수로, PRO 방이 브라우저 데이터 연결을 거절
      (보안 강화), 로컬 파일 게스트를 방 크기로만 나눔(8명 이하 direct, 9명 이상 R2, 아홉 번째 게스트가 잠깐
      REMOTE_FILE_UNAVAILABLE을 받던 경쟁 제거), 보조 경로 재시작이 상대 광고를 기다리지 않음(광고는 계속 보냄).
      통신: 9.0.10·9.0.11이 보내는 프레임은 모두 받고, 이 빌드가 보내는 프레임은 그 빌드들이 모두 받는다(5A의
      9.0.12는 이 열차가 건드린 프레임의 송신 코드를 바꾸지 않는다). 예외 하나는 그 방장들이 설정 스냅샷 뒤에 붙이는 효과별 프레임 14개를 이 게스트가 모르는 종류로 버리는
      것이고, 같은 값의 스냅샷이 먼저 적용되므로 값은 같다. 어느 방향이든 잃는 것은 오래됐거나 같은 순서 번호로 충돌해 거부된
      스냅샷 뒤의 재적용뿐이고(이 빌드의 방장은 그 프레임을 보내지 않는다), 방장 페이지가 바뀌면 게스트도 새 세션이라 설정 기억이 새로 시작하므로 지금은 닿는 길이
      없다(보고서 R4). 수용한 옛 탭의 나빠짐(오너 정책): 8.3.16~8.6.52의
      PLAY 시각(약 200 ms 일찍 시작 뒤 드리프트 보정), 8.3.16~8.6.53 데모 방장의 데모를 새 게스트가 따라가지 못함,
      8.4.58 이하 방장의 같은 파일 약 3초 먼저, 8.11.23 전 방장의 START를 앞지른 미리받기 청크 버림(느린 트랙 전환),
      8.3.30 전 탭의 id 없는 펄스 무시, 8.11.23 상대와의 보조 경로 끊김이 최대 15초 늦게 `side-failed:expired`로 닫힘.
      §1 '의존성·호환'에 보조 경로가 이제 READY 뒤 모든 상대와 재시작한다는 것과 위 통신 예외, 나빠짐을 실었다.
      로컬 검증(`e37c7992`, 열차 끝 리뷰 반영 테스트 한 행 `fe77b416` 뒤 단위·가드 다시 PASS): 테스트 먼저(테스트 커밋 여덟이 부모 코드에서 의도한 행만 FAIL),
      `npm run typecheck`·`typecheck:tests`·`check:workers`·lint·format, 단위 666 files / 15,524, Worker 60 files /
      2,914, 핵심 커버리지 79 files / 3,072, 가드(dead-exports 20/20·76/76 그대로, bus-pairing 204/204, import-graph,
      room-authority-boundaries 직접 읽기 84 → 83·쓰기 16 → 13으로 내림, resource-ownership 47 records / 437 files
      그대로), `build:checked`(bump 전이라 `guard:sw-cache-version`만 설계대로 FAIL, 나머지 PASS), critical E2E 61/61,
      C5-0 랩 `--repeat-each=2` 16/16, 초기 JS 464,581 B(main 478,186 B 대비 −13,605 B, 유지 상한까지 26,987 B).
      5A 합침(`0ea38375`): 충돌 세 곳(`browser/classic-runtime/admin.ts`는 main의 버전 줄, 문서 둘은 두 열차의
      항목을 모두 남김)을 풀고, 텍스트 충돌 없이 FAIL하는 room-authority 직접 읽기 기준치를 83에서 82로 내렸다(두
      갈래가 서로 다른 읽기를 하나씩 지움). 합친 트리에서 typecheck(테스트 포함)·`check:workers`·lint·format, 단위
      672 files / 15,637, 가드(직접 읽기 82, dead-exports 20/20·76/76, bus-pairing 202/202, resource-ownership 46
      records / 439 files) PASS. bump 뒤 최종 로컬(`3acfefc8`): release-identity(9.0.13, v786)·sw-cache-version, 단위
      672 files / 15,637, Worker 60 files / 2,914, 핵심 커버리지 87 files / 3,276, typecheck(테스트 포함)·`check:workers`·
      lint·format·`build:checked` 전체, 가드(직접 읽기 82, dead-exports 20/20·76/76, bus-pairing 202/202,
      resource-ownership 46 records / 439 files), critical E2E 61/61, C5-0 랩 `--repeat-each=2` 첫 실행 15/16(보조 PC
      회복 뒤 보조 채널 데이터가 약 3초 늦어 랩 행의 일시정지 3초 창을 넘김, 앱 오류 없음, main 9.0.12에서도 같은 지연,
      보고서 라운드 7) 뒤 다시 돌려 16/16, 초기 JS 464,588 B(운영 9.0.12 main `dea1432a` 478,198 B 대비 −13,610 B, 유지
      상한까지 26,980 B). 코드 주석과 registry RO-06의 '9.0.12 and older'는 이 열차가 5A 바로 다음 9.0.13으로 나갔으므로 맞다.
      오너 결정대로 자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과해 따로 묻지 않고
      target `app`, Developer API D1 `false`로 배포했다(부분 릴리스 판정과 재판정 compatible, 운영 `78e9ee98` 대비 다른
      Worker의 런타임 경로 변경 0). PR head `01cccb0d`의 Codex 리뷰는 지적이 없었다(§1 검증 범위).
      건너뛴 항목(강제 업데이트·5A 파일, 바닥이 필요한 OV-F, Worker OV-W)과 맡을 열차, 리뷰 낮음 후속은 보고서에 있다.
      로컬 결과는 exact-main-SHA 후보를 대신하지 않는다. exact-main CI, Release 실행, 배포 SHA는 §1에 있다.
      [구버전 제거 열차 1 보고서](design/old-version-removal-1-2026-10-25.md).
- [ ] 구버전 제거 열차 1 배포 뒤 확인(게이트 아님, 2026-10-25 약 01:50 KST 결정): 이 열차는 2026-10-26 12:41 KST에
      배포됐지만 이 열차 코드로 실제 기기와 실제 옛 빌드를 아직 돌리지 않았다. 현재 클라이언트 혼합 방을 두 방향,
      9.0.12(없으면 9.0.11) 방장과 9.0.13 게스트, 그리고 9.0.13 방장과 9.0.12(없으면 9.0.11) 게스트로 열어(옛 쪽은
      업데이트 창에서 '나중에'를 고른 탭) 로컬 파일 재생·일시정지, 설정 변경(효과·EQ·리버브), 유튜브 동기화, 운영자 승격과 업로드가
      그대로인지, 로컬 게스트 9명 이상 방이 처음부터 R2로 받는지, 데모 시작이 따라가는지를 본다. 첫 최소 빌드
      787(2026-10-26 16:15 KST, 맨 위 강제 업데이트 항목) 뒤로는 9.0.13 이하 탭이 새 입장에서 거절되므로 이 혼합 방을
      운영에서 새로 열 수 없다(최소 빌드를 내리지 않는 한). 9.0.14는 이 열차 코드를 담으므로 혼합 방이 아닌 단계는
      9.0.14 기기끼리의 방으로 볼 수 있다. 혼합 방 단계를 어떻게 닫을지는 오너가 정한다.
      [확인하지 않은 것](design/old-version-removal-1-2026-10-25.md#확인하지-않은-것).

### 구조 개선 Phase 5 5A(9.0.12/v785) 배포 뒤 확인: 시스템 오디오 수신 슬롯을 주인 하나로, 동작 그대로

- [ ] 5A 범위(오너 결정 2026-10-25 약 04:00 KST, Phase 5 추천안 전부. 배포 시점은 약 01:50 KST 결정, 순서는
      약 22:30 KST 결정): 앱 업데이트 두 번(P5-D3 A) 가운데 첫째인 중립 열차다. `9.0.12` / `v785`(마지막
      런타임 커밋 `96c1b83f`)로 2026-10-26 10:34 KST [Release 40254651587](https://github.com/hiefny/MUSIXQUARE/actions/runs/40254651587)(target `app`)에 배포됐다(§1). 기기 하나의 시스템 오디오
      수신 자리(registry RO-04)에 지연 전용 주인 `src/network/system-audio-receive-slot.ts`를 두고(P5-D4 A),
      일반방 직접 통화, 일반방 SFU 게스트, PRO 코디네이터가 시작, 경계 대기, 붙이기, interrupt, handoff,
      마감 만료, adopt, 끝을 그 슬롯으로 부른다(C4-2~C4-8. C4-6은 버스 쌍 둘을 슬롯 입력으로, P5-D7 A).
      매체 값은 `src/network/system-audio-media.ts` 한 집으로(C4-1), PRO 발행 정리는 이름 붙인 연산
      셋으로(C4-12, registry RO-40 삭제). PRO 서비스는 Standard 수신 어댑터를 import하지 않는다(import-graph
      RULE D). 동작, MSG 리터럴과 프레임, 계약 표지, 기기 판독 줄, `/debug sa`, 타이머 이름은 그대로이고,
      C4-0이 오늘 동작으로 고정한 틈 14개는 5B 몫이다(P5-D5 A, C4-13은 P5-D11 B로 5B). 브랜치
      `agent/phase5-5a`(`bd94075c`에서 시작, origin/main을 `aa62fe34`·`aab3628b`·`c344b46f`에서 합침)는
      PR #494 squash `78e9ee98`로 main에 들어갔다. 준비 T2·T3 `8b34a24e`, T4 `c30c17a5`, T5 `470227ca`, T6 `8244531f`, 증분마다 테스트 먼저와 코드 한
      쌍(C4-1 `da3ff369`, C4-2 `d1f22a61`, C4-3 `ab5bc996`, C4-4 `830bfb2d`, C4-5 `a7735b92`, C4-6
      `3233ac10`, C4-7 `bde907e0`, C4-8 `e9a9e731`, C4-12 `cc2510ce`). 로컬 검증(`c344b46f`): 단위 672
      files / 15,706, 핵심 커버리지 87 files / 3,277(슬롯 96.02/91.3/100/97.77), typecheck(전체)·lint·
      format, 가드(resource-ownership 46 records / 439 files와 수신 슬롯 쓰기 3·3·3·1, dead-exports
      20/20·76/76 그대로, bus-pairing 202/202, import-graph RULE D, room-authority-boundaries 직접 읽기 83),
      빌드와 초기 전송 예산(초기 JS 478,210 B, 같은 기계의 main `2d605739` 478,186 B 대비 +24 B, 코드 없음,
      유지 상한까지 13,358 B), SW 앱 셸 106 PASS. 최종 계약 묶음 넷(116 tests)과 판독 줄·튜닝·START 묶음
      다섯(47 tests)은 main `2d605739`의 9.0.11 런타임에서도 PASS다. 리뷰 반영 `f45b6a70`(마감 만료가 경로
      반응의 예외를 버스처럼 가둠, RO-04 문구): 단위 672 files / 15,707, 핵심 커버리지 87 files / 3,278(슬롯
      96.07/91.3/100/97.82), 같은 가드, 초기 JS 478,190 B, SW 앱 셸 106 PASS. `guard:sw-cache-version`은 bump
      전이라 설계대로 FAIL이다. C4-7 뒤 청크 변화(새 지연 청크 `system-audio-receive-slot` gzip 약 2.9 KB,
      첫 로딩 +4 B는 미리 읽기 목록의 청크 이름이고 코드는 없음, 시스템 오디오 늦은 청크 셋 합 +322 B)는
      P5-D4 A 선택지의 다시 묻기 조건('새 청크가 생기거나 첫 로딩이 늘면 멈추고 수치를 들고 다시 묻는다')에
      걸렸고, 오너가 2026-10-26 약 09:10 KST에 '이대로 배포'로 답했다. 그래서 `manualChunks` 다른 안은 쓰지
      않고 배포를 막던 다시 묻기 항목은 지웠다([P5-D4 A 다시 묻기와 오너 답](design/phase5-5a-receive-slot-2026-10-25.md#p5-d4-a-다시-묻기와-오너-답)).
      오너가 맡긴 판단으로 정한 그 밖의 세부(PRO 코디네이터는 경로 하나, 경로마다 정한 수신 시작 규칙,
      붙이기는 다시 prime하지 않음, `RECOVERY_DELAY_MS`는 나누지 않음)는 보고서에 있고 오너 확인을
      기다리지만 게이트는 아니다. 출시 순서는 2026-10-26 통합에서 바뀌어 5A가 강제 업데이트 열차보다 먼저
      나갔고 9.0.11 다음 번호를 썼다(약 22:30 KST 결정의 '9.0.12와 그 floor가 먼저'를 바꿈). 그래서 5A는
      floor 없이 나갔고, 혼합 방은 그때 known-accepted #13 그대로였으며 5A는 프레임을 바꾸지 않는다. 강제 업데이트
      열차와 옛 버전 제거 1차는 5A 뒤에 main을 합치기로 했다(같은 파일 registry,
      `scripts/check-room-authority-boundaries.mts`와 그 테스트, `src/types/index.ts`, `vite.config.ts`,
      `docs/qa-domains.md`, `file-prepare-pause.test.ts`는 시험 합침에서 글자 충돌이 없었지만 그쪽 가드 수를
      다시 맞춰야 할 수 있음). 옛 버전 제거 1차는 5A와 그 기록을 `0ea38375`로 합치고(room-authority 직접 읽기
      기준치 82) 9.0.13 / v786으로 2026-10-26 12:41 KST 배포됐다(위 항목). 강제 업데이트 열차는 9.0.14 / v787로
      2026-10-26 16:10 KST 배포됐고 첫 최소 빌드 787이 16:15 KST에 켜졌다(맨 위 항목). 9.0.11은 배포됐으므로 SemVer와 SW 캐시 epoch를 마지막 런타임 커밋
      `96c1b83f`에서 `9.0.12` / `v785`로 함께 올렸다(올리기 직전 fetch한 origin/main은 여전히 `2d605739`).
      bump 뒤 최종 로컬(`96c1b83f`): release-identity(9.0.12, v785)·sw-cache-version, 단위 672 files /
      15,707, Worker 60 files / 2,914, 핵심 커버리지 87 files / 3,278(슬롯 96.07/91.3/100/97.82),
      typecheck(테스트 포함)·`check:workers`·lint·format·`build:checked` 전체, 가드(dead-exports 20/20·76/76,
      bus-pairing 202/202, resource-ownership 46 records / 439 files, 직접 읽기 83, transport-health 은퇴 이름
      24), critical E2E 61/61, 프로덕션 빌드 두 번의 초기 JS 478,198 B(main `2d605739` 478,186 B 대비 +12 B,
      코드 없음, 유지 상한까지 13,370 B) PASS. 오너 결정대로 자동 게이트 가운데 로컬 검사, 리뷰, PR CI,
      exact-main CI, 릴리스 smoke가 통과해 따로 묻지 않고 target `app`, Developer API D1 `false`로 배포했다. PR head `fbd1dc6b`의 Codex
      리뷰는 머지 스크립트의 20분 상한 안에 끝나지 않아 결과 없이 머지했고, 그 뒤로도 끝나지 않았다(2026-10-26
      13:42 KST에도 Codex 요약은 `fbd1dc6b`를 running으로 두고 PR에 리뷰와 리뷰 댓글이 없다). 그 대신 배포된
      변경을 독립 검토 넷이 다시 읽었고 결함이 없었다(5A 보고서 QA 라운드 6). 로컬 결과는
      exact-main-SHA 후보를 대신하지 않는다. exact-main CI, Release 실행, 배포 SHA는 5A 보고서의 QA 라운드 5와
      [릴리스 이력](release-history.md)에 있다. [5A 보고서](design/phase5-5a-receive-slot-2026-10-25.md).
- [ ] 5A 배포 뒤 실기기 확인(게이트 아님, 2026-10-25 결정): 5A 코드로 실제 기기를 아직 돌리지 않았다.
      Phase 5 기기 절차(2-8 기록 추가, Set 5S, Set 5P)는 Phase 4 세션 2에 붙여 오너가 고르는 때에 한다(P5-D2
      A). 5A 전 기기 기준선이 없어 전후 비교는 없고, 첫 세션 값이 '5A 뒤 값'(5B 기준선)이 된다. 혼합 버전 기기
      행은 하지 않는다(P5-D9 C). 이 절 아래의 시스템 오디오 열린 항목(9.0.3 G6, 9.0.2 G5, 9.0.1의 PRO 구독
      실패 지속 부분, 9.0.0 PRO 하트비트, D01, 8.11.25 공유 중지 버튼, 4A 항목의 PRO 시스템 오디오 부분)은
      5A가 배포됐으므로(2026-10-26 10:34 KST) 이제 5A 코드로 확인하게 된다. C4-13의 기기 보조 근거(flight recorder의 같은 revision 두 줄)는 준비
      T8에서 음성이라 없다. 판정 기준은 결과 전에 고정해 따로 보관한다.
      [실기기로 확인하지 않은 것](design/phase5-5a-receive-slot-2026-10-25.md#실기기로-확인하지-않은-것).

### 구조 개선 Phase 4 4D(9.0.11/v784) 배포 뒤 확인: 보조 경로의 끊김 기한도 연결 생존 주인으로

- [ ] 4D 범위(오너 결정 2026-10-25 약 16:30 KST): 허용 위험 #18이 오너의 와이파이→LTE 실기기 확인(운영
      9.0.10, 2026-10-25, #491)으로 은퇴한 뒤, 오너가 Phase 4 밖(P4-D6 A, registry RO-35)에 두었던 C5-9를
      그 ratchet(C5-10의 제어 격리 부분)과 함께 네 번째 앱 열차 4D로 내기로 했다. 코드로는 위험이 높지만 쓰는
      데는 위험이 높지 않다는 판단이고, 나중의 기기 확인이 실패하면 9.0.10의 보조 경로 동작으로 돌아가는
      forward revert를 낸다(미리 정한 되돌리기 계획). `9.0.11` / `v784`(마지막 런타임 커밋 `cf555b01`)로
      2026-10-25 21:30 KST [Release 40193266364](https://github.com/hiefny/MUSIXQUARE/actions/runs/40193266364)(target `app`)에 배포됐다(§1). 바뀌는 것(중립): 보조(격리 제어) 경로 PC의 끊김
      기한(끊김당 15초, 원래 경로가 끊긴 동안 미룸, 원래 경로 회복 뒤 15초로 다시 걸되 끊김 시작에서 30초
      상한, READY 전처럼 재시작할 수 없는 경로의 15초 유예와 그 끝의 거절·fallback)이 `ControlIsolation`에서
      `LinkLiveness`로 옮기고, 제어 격리는 재시작 통신(시도, 창, epoch, 후보, fence, READY)만 갖는다. 기기
      근거 세 줄(`Restarting isolated control ICE (n/m)`, `Isolated control ICE recovered`,
      `Isolated control ICE did not recover; closing its logical connection`)은 바이트·수준·쓰는 끝이
      같고, 닫힘 원인 낱말, `RESTART_WINDOW_MS`·`RESTART_CAP_MS` 리터럴, 통신은 그대로이며, 동결 fixture
      `control-isolation-c9.ts`는 바뀌지 않았다. registry RO-35는 지웠고 RO-15가 `owner-in-place`가 됐다. 브랜치 `agent/phase4-4d`
      (origin/main `a8dfd2ac`에서 시작)는 PR #492 squash `244aca48`로 main에 들어갔다. D0 테스트 먼저 `ea6a5781`·`72cdce0d`(9.0.10 코드에서 통과하는 두 연결
      통합 묶음 34행), D1 C5-9 `d5c66b9a`, D2 가드 `b385fad0`(transport-health 은퇴 이름 16 → 24). 로컬
      검증(`b385fad0`): D0 묶음을 9.0.10 런타임 파일 위에서 다시 34/34, 단위 666 files / 15,594, 핵심 커버리지
      79 files / 3,074(`link-liveness.ts` 100), 가드(transport-health, dead-exports 20/20·76/76 그대로,
      resource-ownership 47 records / 437 files), 빌드 두 번과 초기 전송 예산(초기 JS 478,196 B, main
      478,015 B 대비 +181 B, 유지 상한까지 13,372 B) PASS. origin/main #491은 `b7927afb`에서 합쳤다(registry
      RO-35는 삭제를 지키고, 최근 해결 근거의 #18 문단 끝을 4D로 고침). 리뷰(코드 승인, 문서 지적) 반영으로
      snapshot의 `controlOpen`을 필수 필드로 하고(타입만, 내보내는 JS 같음), 이 기록의 Phase 4 게이트 편차와
      4C 범위 항목을 4D 결정에 맞추고, registry RO-15 문장을 코드와 가드 테스트에 맞췄다(단위 666 files /
      15,594, 핵심 커버리지 79 files / 3,074, 가드 PASS, 보고서 QA 라운드 3). 구현 중 정한 세부(기한 값을
      `RTC_INTERRUPTION_GRACE_MS`에서 끌어내 유예를 바꾸면 보조 경로 끊김 창과 상한도 함께 움직이고 peer 창은
      그대로임, 관리 타이머로 바꾸지 않음, 원래 경로를 읽는 자리)는 오너가 맡긴 판단이고 오너 확인을 기다린다
      (게이트 아님). 9.0.10은 배포됐으므로 SemVer와 SW 캐시 epoch를 마지막 런타임 커밋 `cf555b01`에서
      `9.0.11` / `v784`로 함께 올렸다(올리기 직전 fetch한 origin/main은 여전히 `f91c538e`). bump 뒤 최종 로컬
      검증(`cf555b01`): release-identity(9.0.11, v784)·sw-cache-version, 단위 666 files / 15,594(D0 묶음, 기기
      근거 세 줄 고정, 동결 C9 fixture 포함), Worker 60 files / 2,914, typecheck(테스트 포함)·`check:workers`·
      lint·format, `build:checked` 전체, 가드(dead-exports 20/20·76/76 그대로, transport-health 은퇴 이름 24,
      resource-ownership 47 records / 437 files), 핵심 커버리지 79 files / 3,074(`link-liveness.ts` 100),
      critical E2E 61/61, C5-0 랩 `--repeat-each=2` 16/16(보조 PC failed 뒤 offerer의 재시작 줄 하나와
      회복 줄, did-not-recover 경고와 닫힘 원인 줄 없음. F4는 두 번 모두 본 레인 23,040,044 B 한 번, 미리받기
      청크 0 B, `PRELOAD_END` 없음, 제어 채널 `PRELOAD_ABORT` 하나), 초기 JS 478,186 B(랩 뒤 프로덕션 빌드 두 번
      같음, main 478,015 B 대비 +171 B, 유지 상한까지 13,382 B) PASS. 오너 결정대로 자동 게이트(로컬 검사,
      리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과해 따로 묻지 않고 target `app`, Developer API D1
      `false`로 배포했다. PR head `1f0620c9`의 Codex 리뷰는 지적이 없었다(§1 검증 범위). 4D가 아래 4A 기기
      라운드보다 먼저 나갔으므로 이 기록에서 그 항목의 기준선 문장을 4D로 고쳤다. 로컬 결과는 exact-main-SHA
      후보를 대신하지 않는다. exact-main CI, Release 실행, 배포 SHA는 §1에 있다.
      [4D 보고서](design/phase4-4d-side-route-owner-2026-10-25.md).
- [ ] 4D 배포 뒤 실기기 확인(게이트는 아니지만 되돌리기 판정, 오너 결정 2026-10-25 약 16:30 KST): 4D
      코드로 실제 기기를 아직 돌리지 않았다. Windows Chrome 방장과 같은 와이파이의 iPhone Safari 게스트(`?mxqrLog=info`, 할 수 있으면 Android Chrome도)로,
      게스트가 대기열 항목을 직접 받은 뒤(격리 제어 경로가 생김) (1) 와이파이→LTE: 창 없이 재생과 조작이
      이어지고 합친 콘솔에 재시작 줄 다음 회복 줄, did-not-recover 경고와 `side-failed:*` 원인 줄 없음(9.0.10
      기준선은 재시작 뒤 3.2초에 회복), (2) 비행기 모드 약 40초: 그 게스트의 원인 줄이 하나이고 원래 경로
      토큰(`original-grace-expired` 기대), `side-failed:expired`와 경고 없음, (3) 할 수 있으면 직접 받기
      시작 직후 끊어 READY 전 경우를 기록만 한다. (1)이나 (2)가 실패하면 forward revert를 낸다. 기준은 결과
      전에 보고서에 고정했다.
      [실기기로 확인하지 않은 것](design/phase4-4d-side-route-owner-2026-10-25.md#실기기로-확인하지-않은-것).

### 구조 개선 Phase 4 4C(9.0.10/v783) 배포 뒤 확인: Cloudflare 데이터 연결마다 연결 생존 주인 하나

- [ ] 4C 범위(오너 결정 2026-10-25 약 01:50 KST): 4A 때 기기 근거를 기다리며 보류한 C5-6·C5-7·C5-8(P4-D6 A, P4-D13 A)은 오너
      결정(2026-10-25 약 01:50 KST)으로 기기 근거가 코드의 게이트가 아니게 되어 4B 다음 자기 열차(4C)로
      갔다. 4C는 C5-10의 연결 부분을 함께 싣고 C5-9는 싣지 않았다. C5-9는 그때 Phase 4 밖이었고(RO-35), #18
      은퇴 뒤 오너 결정(2026-10-25 약 16:30 KST)으로 4D로 갔다(9.0.11 / v784로 2026-10-25 21:30 KST 배포됨, 위
      4D 항목). `9.0.10` / `v783`(마지막
      런타임 커밋 `d52427e2`)으로 2026-10-25 14:41 KST [Release 40166305040](https://github.com/hiefny/MUSIXQUARE/actions/runs/40166305040)(target `app`)에 배포됐다(§1). 브랜치
      `agent/phase4-4c`(4B 브랜치 끝 `b1962ed5`에서 시작, origin/main `9fca1cad`를 `c23f3057`로 합침,
      리뷰 낮음 반영 `ab4ba114`)는 PR #489 squash `2038b51f`로 main에 들어갔다. 9.0.9는 배포됐으므로 SemVer와 SW 캐시
      epoch를 마지막 런타임 커밋 `d52427e2`에서 `9.0.10` / `v783`으로 함께 올렸다(올리기 직전 origin/main은
      여전히 `9fca1cad`. bump는 C5-6~C5-10의 런타임 변경 전체를 덮는다). 오너 결정대로
      자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과해 따로 묻지 않고
      target `app`, Developer API D1 `false`로 배포했다. PR head `9d9a801f`의 Codex 리뷰는 지적이 없었다(§1
      검증 범위). 바뀌는 것: 원래 경로의 15초 유예, 공개하는 복구
      마감, 끊김당 ICE 재시작 하나의 문(C5-6), 게스트 백그라운드 복귀 확인(C5-7), 링크의 모든 닫힘과 첫
      원인(C5-10)을 `LinkLiveness` 하나가 갖고(중립, 타이머 키·마감·효과 순서·원인 낱말 그대로), 전송 상태
      읽기가 그 주인의 보기를 읽는다(C5-8, 동작 위험). C5-8 뒤로는 주인이 원래 경로의 끊김을 쥔 채 경로가
      `connecting`·`new`로 읽히는 재시작 창에서 그 peer가 bulk-writable이 아니어서 새 본 레인·미리받기
      스트림이 그 peer를 빼고(게스트는 disconnected 때처럼 자기 복구 요청에 기댐), 미리받기 레인은 주인의
      `connected`(`ice-recovered`)까지 멈춘 채 있다가 청크 0부터 다시 시작한다(그 전의 선택 쌍 보고로는
      재개하지 않음). 보조 경로만의 끊김은 전처럼 bulk를 막지 않고, 원시 `iceConnectionState` 행은 그대로이며,
      원시와 주인 보기의 불일치 로그는 넣지 않았다(Phase 4 계획 v3 기본값 2). 모든 `CloudflareDataConnection`
      (PRO 포함)이 주인을 갖지만 PRO 방의 영구 재생목록 미디어는 레인을 쓰지 않는다. 통신 형식, 메시지
      종류, 영구 데이터 모양, 타이밍 값, 타이머 키, 기존 로그 문자열은 그대로이고, #18과 미리받기 재개
      판정이 읽는 다섯 줄과 `[Transport] Logical connection closed (<cause>) for <peerId>` 줄은 바이트가
      같다. 동결 fixture `control-isolation-c9.ts`는 바뀌지 않았다. 혼합 버전(known-accepted #13): 변화는
      방장 기기 안의 재시작 창 판단이고, 옛 게스트는 같은 프레임과 복구 요청 경로를 쓴다. 되돌리기는 더
      높은 SemVer의 코드 되돌리기가 기본이고, 급할 때 Cloudflare App을 9.0.9·9.0.8·9.0.7·9.0.6·9.0.5로
      되돌려도 PRO 입장 정책 표지는 유지된다. 로컬 검증(`ab4ba114`): 테스트 먼저(테스트 커밋 넷이
      바꾸기 전 소스에서 통과, C5-8의 새 21행이 `76ecc766` 소스에서 실패), 단위 664 files / 15,531,
      typecheck(테스트 포함)·lint·format, 가드(dead-exports 20/20·76/76 그대로, transport-health 은퇴 이름
      16, resource-ownership 48 records / 437 files), 핵심 커버리지 77 files / 3,025(`link-liveness.ts`·
      `transport-health.ts` 100), 빌드 두 번과 초기 전송 예산(초기 JS 478,019 B, 같은 기계의 main 477,600 B
      대비 +419 B, 유지 상한까지 13,549 B), critical E2E 61/61, C5-0 랩 8/8(F4는 본 레인 23,040,044 B 한
      번, 미리받기 청크 0 B, `PRELOAD_END` 없음, 제어 채널 `PRELOAD_ABORT` 하나) PASS. 두 번째 리뷰
      반영(`8582e71c`, C5-12 물러남·철회 행을 실제 주인 보기로도 돌리는 테스트 11행과 문서, 런타임 그대로) 뒤
      단위 664 files / 15,542 PASS. bump 뒤 최종 로컬 검증(`d52427e2`): release-identity(9.0.10, v783)·
      sw-cache-version, 단위 664 files / 15,542(기기 근거 다섯 줄 고정 포함), Worker 60 files / 2,914,
      typecheck(테스트 포함)·`check:workers`·lint·format, `build:checked` 전체, 가드(dead-exports 20/20·76/76
      그대로, transport-health, resource-ownership 48 records / 437 files), 핵심 커버리지 77 files / 3,025,
      critical E2E 61/61, C5-0 랩 8/8(F4는 본 레인 23,040,044 B 한 번, 미리받기 청크 0 B, `PRELOAD_END` 없음,
      제어 채널 `PRELOAD_ABORT` 하나), 초기 JS 478,015 B(프로덕션 빌드 두 번 같음, main 477,600 B 대비 +415 B,
      유지 상한까지 13,553 B) PASS. 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다. exact-main CI, Release
      실행, 배포 SHA는 §1에 있다.
      [4C 보고서](design/phase4-4c-link-liveness-2026-10-25.md).
- [ ] 4C 배포 뒤 실기기 확인(게이트 아님, 2026-10-25 결정): 4C 코드로 실제 기기를 아직 돌리지 않았다. 원래
      경로의 짧은 끊김과 15초 넘는 끊김(원인 줄), 와이파이→LTE의 원래 경로 재시작(2026-10-25 #18 확인에서
      Safari 게스트 콘솔에 재시작 줄이 한 번 보였고 원래 경로는 relay 쌍으로 다시 이어졌다. 방장 콘솔과
      Android는 아직이다. 아래 최근 해결 근거), iPhone Safari 게스트의 15초 넘는 백그라운드 복귀(방장이 있을
      때와 없을 때), 미리받기 재개 단계에서 `Resuming preload`가 방장 원래 PC의 connected 뒤에 나오는지와 재시작 창의 새 트랙 받기, WebKit 레인, 운영 Cloudflare 전송 경로, 브라우저의 PRO
      방이 남았다. 4A·4B 기기 라운드도 아직 없어 전후 비교 기준이 없다. 기기 절차는 보고서에 고정했다.
      [실기기로 확인하지 않은 것](design/phase4-4c-link-liveness-2026-10-25.md#실기기로-확인하지-않은-것).

### 구조 개선 Phase 4 4B(9.0.9/v782) 배포 뒤 확인: 오너가 고른 연결·재합류 동작 변경

- [ ] 4B 범위(오너 결정 2026-10-25 약 01:35 KST, 배포 시점은 약 01:50 KST 결정): 4B는 Phase 4의 두
      번째 앱 배포이고 오너가 고른 동작 변경만 싣는다. `9.0.9` / `v782`(마지막 런타임 커밋 `f207d094`)로
      2026-10-25 10:43 KST [Release 40151618508](https://github.com/hiefny/MUSIXQUARE/actions/runs/40151618508)(target `app`)에 배포됐다(§1). 통합 브랜치
      `agent/phase4-4b`(세 갈래 합침 `65391edb`, 9.0.8 / v780 main `47b9a273` 위)는 PR #487 squash
      `aa23172a`로 main에 들어갔다. bump 커밋
      `aba30ccb`에서 `9.0.9` / `v781`로 올렸고, 그 뒤 PR #487의 Codex P2 반영(`4a319b62` 테스트,
      `bfd84f6a` 게스트 받기 규칙)이 런타임을 바꿨으므로 SemVer 9.0.9는 두고 SW 캐시 epoch만
      `f207d094`에서 v782로 다시 올렸다(올리기 직전 origin/main은 여전히 `47b9a273`). 자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI,
      릴리스 smoke)가 통과해 따로 묻지 않고 target `app`, Developer API D1 `false`로 배포했다. 마지막
      PR head의 Codex 리뷰는 20분 안에 오지 않아 그 상한 뒤 머지했다(§1 검증 범위). 바뀌는 동작: ICE 복구 뒤 방장이 그 게스트를
      local로 다시 판정해 알린 다음 본 레인이 같은 (연결, 대기열 항목, 세션)을 가져가면 재개한
      미리받기가 물러나 `PRELOAD_ABORT` 하나와 `[Preload] Yielding preload for <peer> ...` info 줄을
      남긴다(C5-12, P4-D10 A. 그 밖의 경우는 9.0.8처럼 두 레인이 보낸다). 미리받기를 기다리는 9.0.9
      게스트는 경로가 아직 `unknown`이어도 자기 `REQUEST_DATA_RECOVERY`의 정확한 (연결, 대기열 항목,
      세션)인 본 레인 머리를 받는다(Codex P2: 방장의 `local` 알림은 제어 채널, 머리는 대용량 채널이라
      머리가 먼저 닿을 수 있음). 그래도 남은 경우에는 게스트가 본 레인 머리를 버려 미리받기 대기에 머물
      수 있다(9.0.9 게스트는 자기 판정이 `remote`로 끝난 경로 2만, 9.0.4~9.0.8 게스트는 두 경로 모두.
      기존 진행 감시가 남아 있고 그 다시 요청의 머리가 닿을 때 받을 수 있으면 그 요청까지), RO-18의
      알려진 한계). 오류로 시작한 닫힘·입장
      실패·PRO epoch 일괄 닫힘의 원인 줄이 `intentional` 대신
      `transport-error`·`join-bootstrap-failed`·`pro-epoch-advanced`가 된다(`pro-epoch-advanced`는
      클라이언트와 Worker의 epoch 닫힘 이름이 달라 아직 기기에서 닿지 않는다). 일반방 게스트는 끊김
      창의 다시 읽기를 건너 마지막 닫힘 원인과 시각을 sessionStorage `mxqr-prev-close`에 두고, info를
      찍는 다음 페이지가 `[Transport] Previous page closed (<cause>) at <HH:MM:SS> UTC`를 한 번 보인다
      (P4-D5 B). PRO 청취자의 보이는 iframe 일시정지가 남은 재합류 재시도를 끝낸다(P4-D7 B). 데모
      재생은 대기열 정준 시간선을 켜지 않아 데모 방장이 자기 오디오 시계 위치를 보고한다(P4-D9).
      P4-D9의 대가: 대기열 항목이 선택된 데모 방장도 숨김 멈춤 뒤 자기 위치에서 다시 재생하고 그
      위치를 보고하므로, 방장과 2초 넘게 차이 나는 게스트가 방장 쪽으로 강제 다시 맞춘다(선택 항목이
      없을 때 이미 그랬던 동작. 게스트 쪽은 코드 읽기). 이 대가는 보고서로 오너에게 알린다. 통신 형식,
      메시지 종류, 영구 데이터 모양(탭 sessionStorage 진단 키 `mxqr-prev-close` 하나가 새로 생김),
      타이밍 값, 타이머 키, 기존 로그 문자열(원인 줄의 원인 낱말만 바뀜)은 그대로이고, #18과 미리받기
      재개 판정이 읽는 다섯 줄은 바이트가 같다. `cloudflare/` 변경은 없다(bump의 App Worker
      `ADMIN_ASSET_VERSION`만). 혼합 버전(known-accepted #13): 9.0.4~9.0.8 게스트는 경로가 `local`일
      때만 본 레인 머리를 받으므로(9.0.0의 받기 코드) Codex P2의 경로 1이 옛 게스트에는 열려 있다.
      게스트가 이미 보내는 어떤 값(복구 요청 포함)도 방장에게 게스트 버전을 알려 주지 않아, 방장은 통신
      형식 변경 없이 둘을 가를 수 없고 P4-D10 A의 물러남을 유지한다. 그 옛 게스트 몫은 혼합 버전 기간의
      남은 위험으로 둔다. 9.0.8 이하 방장은 계속 두 스트림을 보내고, 9.0.9 게스트가 `unknown`일 때 자기
      요청에 답한 머리를 받으면 9.0.8의 `local` 게스트처럼 본 레인을 재생한다. 나머지
      변경은 기기 안의 로그·탭 저장·재시도 판단이다. 되돌리기는 더 높은 SemVer의 코드 되돌리기가
      기본이고, 급할 때 Cloudflare App을 9.0.8·9.0.7·9.0.6·9.0.5로 되돌려도 PRO 입장 정책 표지는
      유지된다(9.0.4 아래는 불가). 로컬 검증(`65391edb`): 단위 663 files / 15,382, typecheck·
      `typecheck:tests`·lint·format·`check:workers`, 가드(dead-exports 20/20·76/76 그대로, bus-pairing
      204/204, resource-ownership 48 records / 436 files), 핵심 커버리지 75 files / 2,862, 빌드와 초기
      전송 예산(초기 JS 477,501 B, main 대비 +567 B), critical E2E 61/61, C5-0 랩 8/8(F4는 본 레인
      23,040,044 B 한 번, 미리받기 청크 0 B, `PRELOAD_END` 없음, 제어 채널 `PRELOAD_ABORT` 하나) PASS.
      bump 뒤 최종 로컬 검증(`93fb3d66`, 런타임은 bump `aba30ccb`): release-identity(9.0.9, v781)·
      sw-cache-version, 단위 663 files / 15,382, Worker 60 files / 2,914, `build:checked` 전체, 같은
      가드 값, 핵심 커버리지 75 files / 2,862, critical E2E 61/61, C5-0 랩 8/8(F4 같은 전선 결과), 초기
      JS 477,516 B(프로덕션 빌드 두 번 같음) PASS. Codex P2 반영 로컬 검증(`bfd84f6a`, v782 bump 전):
      테스트 먼저(`4a319b62`가 `b1962ed5` 소스에서 23행 중 5행 실패), 단위 663 files / 15,388, `tsc`·
      `typecheck:tests`·lint·format, 같은 가드 값(dead-exports 20/20·76/76, bus-pairing 204/204,
      resource-ownership 48 records / 436 files), 초기 JS 477,607 B(빌드 한 번, main 대비 +673 B) PASS.
      v782 bump 뒤 최종 로컬 검증(`40210903`, 런타임은 v782 bump `f207d094`): release-identity(9.0.9,
      v782)·sw-cache-version, 단위 663 files / 15,388(기기 근거 다섯 줄 고정 포함), Worker 60 files /
      2,914, typecheck·`typecheck:tests`·`check:workers`·lint·format, `build:checked` 전체, 같은 가드
      값, 핵심 커버리지 75 files / 2,862, critical E2E 61/61, C5-0 랩 8/8(F4 같은 전선 결과), 초기 JS
      477,600 B(프로덕션 빌드 두 번 같음, main 대비 +666 B) PASS. 로컬 결과는 exact-main-SHA 후보를
      대신하지 않는다.
      갈래 라운드는 보고서에 있다. exact-main CI, Release 실행, 배포 SHA는 §1에 있다.
      [4B 보고서](design/phase4-4b-behaviour-2026-10-25.md).
- [ ] 4B 배포 뒤 실기기 확인(게이트 아님, 2026-10-25 결정): 4B 코드로 실제 기기를 아직 돌리지 않았다.
      ICE 복구 뒤 같은 트랙 받기(재생까지 초, 받는 표시, 방장의 `Paused`·`Resuming`·`Yielding` 줄),
      운영 Cloudflare 전송 경로의 새 원인 토큰, iPhone Safari·Android Chrome 게스트의 이전 페이지 닫힘
      줄(운영 기본 레벨은 WARN이고 끊김 창의 다시 읽기는 `?mxqrLog=info`를 잃으므로, 끊기기 전에
      localStorage `mxqr:logLevel`을 `info`로 두거나 다시 읽힌 뒤 같은 탭에서 `/<코드>?mxqrLog=info`로
      다시 열고, 게스트가 방에 들어오자마자 `/debug console`을 연다), iPhone·Android PRO 청취자의 보이는
      일시정지와 잠금 화면 PLAY, 데모 방장의 숨김 멈춤과 게스트 다시 맞춤, WebKit 레인, 브라우저의 PRO
      방이 남았다. 4A 기기 라운드도 아직 없어 전후 비교 기준이 없다. 4B 뒤 라운드의 원인 허용표에
      더한 줄(`transport-error`는 망을 잃어 끝나는 단계에서 허용, `join-bootstrap-failed`는 창을 띄운
      연결에서 허용 밖, `pro-epoch-advanced`는 일반방 단계에서 허용 밖)은 결과 전에 고정했다.
      [실기기로 확인하지 않은 것](design/phase4-4b-behaviour-2026-10-25.md#실기기로-확인하지-않은-것).

### 구조 개선 Phase 4 4A(9.0.7/v778) 배포 뒤 확인: 연결 생존·출력 재합류 중립 재구성

- [ ] 4A 범위(오너 결정 2026-10-24 약 15:20 KST, 추천안 전부, 배포 위임): 4A는 Phase 4의 첫 앱
      배포이고 동작을 바꾸지 않는다. `9.0.7` / `v778`(마지막 런타임 커밋 `8a9e1772`)로 2026-10-24 23:26 KST
      [Release 40102311205](https://github.com/hiefny/MUSIXQUARE/actions/runs/40102311205)(target `app`)에 배포됐다(§1). RTC 끊김 유예 15초(`RTC_INTERRUPTION_GRACE_MS`), 신호
      재접속 간격, 전송 레인과 게스트 수신 마감, 공유 시작·재정렬 시간 값을 각각 한 곳에
      두었다(C5-1·C5-2·C5-3·C3-I1). 일반방 논리 연결이 끝날 때마다 원인 한 줄을 info로 남기고
      (C5-5, `[Transport] Logical connection closed (<cause>) for <peerId>`), 전송 상태 읽기를 한
      경로와 `guard:transport-health`로 모으고(C5-4), 재합류 라우터의 죽은 상태를 지웠다. 타이밍,
      순서, 상태 전이, 통신 형식, 영구 데이터 모양, 타이머 키, 기존 로그 문자열은 그대로이고,
      아래 #18·미리받기 재개 판정이 읽는 다섯 줄(보조 연결 셋, 미리받기 Paused·Resuming)은 바이트가
      같다. 오류로 시작한 방장·게스트 닫힘과 PRO epoch의 일괄 닫힘은 합의한 토큰이 없어
      `intentional`로 읽힌다(4B에서 `transport-error`·`join-bootstrap-failed`·`pro-epoch-advanced`로
      바뀐다, 위 4B 항목). 데모 시작 기준,
      PRO API 오류, 활성 업로드 대기열 포트, Opus 스테레오 SDP 도우미를 시작 잎 모듈로 옮겨, 두
      갈래를 합친 491,726 B(유지 상한 491,568 B를 158 B 넘음)였던 초기 JS가 477,138 B(여유
      14,430 B, 초기 전체 555,760 B)가 됐다. 대신 게으른 PRO 런타임 청크가 +10,182 B,
      `system-audio-service`가 +3,684 B, `system-audio-sfu`가 +448 B 커져 PRO 방 입장의 JS 합은
      거의 같다(−255 B). C5-6·C5-7·C5-8은 아래 #18과 미리받기 재개가 근거로 닫히거나 면제될
      때까지 보류했다(P4-D6 A, P4-D13 A). 오너 결정(2026-10-25 약 01:50 KST) 뒤로는 기기 근거가
      코드의 게이트가 아니어서 셋은 4B 다음 자기 열차로 진행한다(4C, C5-10의 연결 부분과 함께
      9.0.10 / v783으로 2026-10-25 14:41 KST 배포됨. 위 4C 항목,
      [4C 보고서](design/phase4-4c-link-liveness-2026-10-25.md)). 배포 대상은 target `app`, Developer API D1 `false`다.
      App 런타임 입력만 바뀌고, `cloudflare/`에서는 bump가 App Worker의 `ADMIN_ASSET_VERSION`
      문자열 하나만 바꾼다. 운영 배포 기록을 기준으로 부분 게이트 판정을 로컬에서 돌리면 다른
      다섯 Worker의 런타임 경로 변경과 App 운영 의존성 변화가 0이다(실제 게이트는 Production
      Release가 다시 판정). 업데이트 창이 뜨는 배포이고 오너가 배포를 맡겼다. 새 D1
      스키마·비밀·바인딩·통신 형식은 없다. 혼합 버전(known-accepted #13): 9.0.6과 9.0.7은 같은
      프레임을 주고받고 원인 줄은 각 기기의 로컬 로그에만 생긴다. 보조 연결의
      `RESTART_WINDOW_MS`·`RESTART_CAP_MS`는 두 끝이 서로 강제하는 값이라 리터럴로 남겼다.
      되돌리기는 더 높은 SemVer의 코드 되돌리기가 기본이고, 급할 때 Cloudflare App을 9.0.6이나
      9.0.5로 되돌려도 PRO 입장 정책 표지는 유지된다(9.0.4 아래는 불가). 로컬 검증(`b8bc42c4`):
      단위 658 files / 15,206, 4A·#478 묶음 42 files / 1,631, 가드(dead-exports 20/20·76/76 그대로,
      resource-ownership 46 records, transport-health 원시 읽기 1), 빌드와 초기 전송 예산 PASS.
      문서 리뷰 정리(`1320eea6`, 런타임 소스 같음)가 오너 결정 P4-D8 A·P4-D9 A를 registry 허용 예외
      RO-48·RO-49로 적어 resource-ownership이 48 records가 됐고, 그 SHA에서 단위 658 files /
      15,206과 그 가드가 다시 PASS했다. 갈래 라운드의 critical E2E 61/61(네트워크 갈래
      `9a0fea2a`)과 커버리지는 보고서에 있다. bump SHA `8a9e1772`에서 critical E2E 61/61과 4A 코드의 C5-0 랩 16/16(두 번 반복)이 통과했다.
      exact-main CI, Release 실행, 배포 SHA는 §1에 있다.
      [4A 보고서](design/phase4-4a-transport-rejoin-2026-10-24.md),
      [4B 보고서의 오너 결정](design/phase4-4b-behaviour-2026-10-25.md#오너-결정-2026-10-25).
- [ ] Phase 4 게이트 편차(오너 결정 2026-10-24): 로드맵의 Phase 4 게이트는 아래 #18 보조 연결 ICE
      재시작과 미리받기 재개를 근거로 닫거나 면제하고, C5-0을 green으로 하고, QA007·QA036·QA040
      기준선을 먼저 재는 것이다. C5-0 랩은 2026-10-24 main(`fa256db2` 런타임, #478 `b4293768`)에서
      24/24로 통과했다. 기기 부분은 면제가 아니라 미뤘다. 오너는 기기 기준선 없이, R2 배포 7일
      안에 4A를 배포해도 된다고 했고, 배포와 기기 평가를 맡기고 자리를 비웠다(P4-D11 예외). Phase
      3 실기기 확인 전에 배포하는 것은 그 위임 아래의 판단이다(P4-D11 A는 Phase 3 기기 확인 통과를
      조건으로 둔다). 그래서 4A의 중립성은 기기 전후 비교가 아니라 자동 근거(단위,
      특성화 테스트, C5-0 랩)에 기대고, 기준선은 4A 위에서 처음 잰다. #18은 2026-10-25 운영
      9.0.10에서 오너 실기기 확인으로 닫혔다(아래 최근 해결 근거). 미리받기 재개는 아래 실기기
      확인에 열린 채로 둔다. Phase 3 시계는 다시 시작하지 않고, 4A 뒤 업데이트 경로
      제보는 Phase 3 몫으로 본다(P4-D11 A). Phase 4의 앱 업데이트는 4A와 4B 두 번이다(P4-D3 A).
      오너 결정(2026-10-25 약 01:50 KST)이 시점 부분을 대신해, 4B는 4A 배포 7일 뒤나 4A 기기
      라운드를 기다리지 않고 자동 게이트가 통과하면 바로 나가며 기기 근거는 코드의 게이트가
      아니다. 4B는 축소 C5-11, C5-12, 새 종료 원인 토큰, P4-D5 B, P4-D7 B, P4-D9 좁은 수정을 싣고
      C5-6·C5-7·C5-8은 4B 다음 자기 열차로 간다(4C로 2026-10-25 14:41 KST 배포됨. C5-10은 연결 부분만
      실었다, [4C 보고서](design/phase4-4c-link-liveness-2026-10-25.md)). #18이 은퇴한 뒤 오너 결정(2026-10-25
      약 16:30 KST)으로 C5-9와 C5-10의 제어 격리 부분이 네 번째 앱 열차 4D로 갔다(9.0.11 / v784로 2026-10-25
      21:30 KST 배포됨. 기기 확인이 실패하면 9.0.10의 보조 경로 동작으로 forward revert, 위 4D 항목,
      [4D 보고서](design/phase4-4d-side-route-owner-2026-10-25.md#오너-결정)). 그래서 Phase 4의 앱 업데이트는
      P4-D3 A의 두 번이 아니라 4D까지 네 번이 됐다. ICE 복구 뒤 같은 파일을 두 레인으로 보내는
      경우(F4)는 단위 테스트와 랩 17초 끊김에서 재현했고(10초 끊김은 한 번 실행에서 미재현),
      오너는 본 레인이 이기게 했다(P4-D10 A, 2026-10-25, 4B의 C5-12).
      [4A 보고서의 오너 결정](design/phase4-4a-transport-rejoin-2026-10-24.md#오너-결정-2026-10-24),
      [4B 보고서의 오너 결정](design/phase4-4b-behaviour-2026-10-25.md#오너-결정-2026-10-25).
- [ ] 4A 배포 뒤 실기기 확인: 결과 전에 고정한 블라인드 절차로 #18(와이파이→LTE와 회귀), 미리받기
      재개, QA036 원격 게스트, QA040 연결 생존, QA007 YouTube·로컬 복귀, 홈 화면 앱을 iPhone
      Safari·Android Chrome 게스트와 Windows Chrome 방장으로 잰다. 기준선을 4A 위에서 처음 재므로 4A
      전후 비교는 없다. #18은 2026-10-25 Safari 게스트의 와이파이→LTE 한 번으로 닫혔다(아래 최근 해결
      근거). 이 라운드의 그 단계는 닫는 조건이 아니라 기준선과 회귀로 남고, Android Chrome 게스트, 같은
      공유기의 다른 SSID로 옮기는 IP 변경, 원격(LTE) 게스트가 와이파이로 오는 방향, 방장 콘솔은 아직
      보지 않았다. 2026-10-25 결정대로 4B(2026-10-25 10:43 KST), 4C(14:41 KST), 4D(21:30 KST)가 이 라운드
      전에 나갔으므로 이 라운드는 4D 위에서 처음 재는 기준선이 되고 4B·4C·4D 전후 비교도 없다. 창으로 끝나는 단계마다 방장
      콘솔(`?mxqrLog=info`)에 그 게스트 PeerID의 원인 줄이 하나 있고 그 토큰이 미리 고정한 단계별
      허용표 안인지 본다. 운영 Cloudflare 전송 경로, iOS, 브라우저의 PRO 방(입장, 업로드 대기열,
      시스템 오디오)은 4A 코드로 아직 실행하지 않았다. CI는 exact-main 후보와 push 뒤 WebKit
      레인을 본다. [남은 확인](design/phase4-4a-transport-rejoin-2026-10-24.md),
      [4B 보고서의 오너 결정](design/phase4-4b-behaviour-2026-10-25.md#오너-결정-2026-10-25).

### Phase 3 R1(9.0.5/v776)·R2(9.0.6/v777) 배포 뒤 확인

- [ ] R1 범위(오너 결정 2026-10-24, 빠른 경로): Phase 3는 R1과 R2 두 번 배포한다. R1은 `9.0.5` /
      `v776`이다. 9.0.5는 미배포라 SemVer는 그대로 두고 SW 캐시 epoch만 올렸다. `6ea4fab4`에서 v775로
      올린 뒤, 같은 날 공개된 개발 도구 의존성 보안 공지(undici, fast-uri, body-parser) 때문에 CI의
      `npm audit --audit-level=high`가 실패해 `overrides`를 패치 버전으로 올렸고(`f7f55e4c`, 개발 의존성만,
      앱 번들 변화 없음), package.json이 PWA 런타임 입력이라 `26c807d6`에서 v776으로 한 번 더 올렸다
      (마지막 런타임 커밋). R1은 네 증분을 함께 싣는다. (1) 일반방 명시적 만료 복구와 내부
      진단(#471, main `b19eca9f`). 오너 결정(2026-10-24): 현재 일반방 게스트 연결에서 정확한
      `1012 / ROOM_EXPIRED`를 받으면 그 입장의 자동 신호 재접속을 멈춘다. 기존 RTC·재생은 유지하고,
      일반 연결 끊김과 PRO 복구는 유지한다. 사용자의 새 입장만 만료 상태를 해제한다. 오너
      결정(2026-10-24, 리뷰 반영): 새 입장은 재접속으로 표시해 방장이 없으면 "방장이 세션을 종료한
      것 같아요"를 보이고, 활동 통계는 이어지는 세션으로 센다. 만료 초대 버튼은 중립 회색을
      유지한다. 내부 클라이언트 진단은 인식한 종료 이유·입장/복구 구간·RTC 생존을, 서버 집계는
      호스트 유예·인증 대기·그 외 부재를 구분한다. 의도적 종료나 장애 원인으로 단정하지 않는다.
      (2) 각진 선택 체크·마이너스(`selection-mark.ts` 하나)와 머리글 시각에 맞춘 고정 공지 X.
      (3) 신호 복구 대화상자의 높이 상한(짧은 가로 화면에서 화면 밖으로 나가던 문제)과 공지 X
      키보드 링. (4) C6-9: 업데이트 기계의 활성화 상태 하나와 `SKIP_WAITING` 출구 하나로, 동작은
      9.0.4와 같다.
      배포 대상은 target `all`만 가능하다. #471이 App 런타임과 signaling Worker를 함께 바꿔 부분
      게이트가 app 단독과 signaling 단독을 첫 배포 단계 전에 거부하고, `release.yml`에
      app+signaling 조합은 없다. 순서는 PRO room → remote-share → signaling → Developer API → App,
      Developer API D1은 `false`다. 업데이트 창이 뜨는 배포라 직전에 오너 확인이 필요하고,
      exact-main 후보는 배포 직전에 확인한다. #471은 이미 main에 있으므로 R1 전에 다른 배포가
      필요하면 이 증분을 함께 `all`로 보낼지 먼저 되돌릴지 오너가 정한다. 새 D1
      스키마·비밀·바인딩·통신 형식은 없다.
      혼합 버전: 서버는 새 카운터를 내고 앱은 만료 처리를 적용하므로, 이전 앱은 갱신 전까지 기존
      재시도를 계속할 수 있다. 업데이트 적용 주체(리뷰 정정): 새 워커는 설치 뒤 대기하고 페이지
      이동은 네트워크 우선이라, 배포 뒤 새로 연 페이지는 v772 controller 아래에서 9.0.5 코드로 돌고
      그 페이지의 C6-9 기계가 대화상자와 Apply를 처리한다. 그래서 C6-9 기계의 첫 운영 적용은 R1
      때다. 9.0.4 기계로 적용하는 것은 배포 전부터 열려 있던 탭과 네트워크가 3초 안에 답하지 않아
      캐시된 화면으로 연 페이지뿐이다. 다음 문서 표지의 키와 값은 그대로다.
      로컬 최종 검증(`6ea4fab4`): 단위 645 files / 14,794, Worker 60 files / 2,889, `build:checked`
      전체, critical E2E 61/61, 두 빌드의 실제 Chromium 업데이트 네 장면 PASS. 리뷰 반영 라운드
      8에서 배포 뒤 새로 연 페이지(B 문서가 A controller 아래에서 Apply)도 PASS. 첫 로딩 JS는
      491,284 B로 유지 상한 491,568 B까지 284 B, 초기 전체는 상한 570,570 B까지 661 B 남는다.
      R1은 2026-10-24 10:33 KST [Release 40049951071](https://github.com/hiefny/MUSIXQUARE/actions/runs/40049951071)로 배포됐다(같은 SHA의 앞선 두 실행은 smoke
      WebSocket 503으로 실패해 자동 복구, §1). 운영 데스크톱 Chromium에서 배포 전 탭(9.0.4 기계)의 대화상자와
      "나중에", 배포 뒤 새 탭(C6-9)의 "적용하기"(새로고침 한 번, v776), 방 밖 옛 탭의 자동 새로고침을 확인했다.
      실기기 확인(대기): 만료(정상 재생 중 만료, 일반 단절, foreground 복귀, WSS·HTTPS 종료 이유,
      방장이 없을 때 새 입장 문구, `/api/admin/metrics` 새 카운터 4개), 업데이트(배포 뒤 새로 연
      페이지의 대화상자와 Apply는 C6-9 기계라 iPhone Safari 포함, 배포 전부터 열린 탭의 Apply는
      9.0.4 기계, 방 게스트의 `/CODE` 복귀 한 번, 실제 방에서 다른 탭이 적용할 때 한 번만 묻는지,
      Later, 대기 업데이트가 있을 때 로고), 화면(각진 표시·공지 X 정렬, 짧은 가로
      화면의 만료 대화상자, 공지 X 키보드 링, 실제 Windows 고대비), CI(새 잉크 정렬 테스트의 Linux
      첫 결과, push 뒤 WebKit 레인). 실제 WSS·HTTPS 연결과 백그라운드 복귀에서 재생 유지·새 입장은
      미검증이다. [변경·QA·배포 범위](design/phase3-update-and-expiry-recovery-2026-10-24.md).

- [ ] R2 범위와 밤사이 배포 승인(오너 결정 2026-10-24): R2는 C6-10(로고 재설정이 업데이트 기계에
      묻기)으로 `9.0.6` / `v777`이다(마지막 런타임 커밋 `7d14ff10`). 2026-10-24 12:24 KST
      [Release 40058005507](https://github.com/hiefny/MUSIXQUARE/actions/runs/40058005507)(target `app`)로 배포됐다. 운영 데스크톱 Chromium에서 배포 뒤 새 탭의
      대화상자와 "적용하기"(새로고침 한 번, v777), "나중에", 방 밖 옛 탭 둘의 자동 새로고침을 확인했고,
      로고 재설정은 방 안에서만 동작해 운영에서 확인하지 못했다(§1).
      로고는 대기 업데이트를 기계의 출구 하나로 묻지 않고 적용하고(Later는 그 페이지에만), 진행 중인
      Apply에는 두 번째 `SKIP_WAITING`을 보내지 않는다. 이동이 페이지를 잡은 동안의 controller 변경은
      그 이동이 페이지를 놓을 때만 결정하고, 조용한 승격은 페이지 로드가 잠잠할 때만 보내며, 이 탭이
      요청한 세대를 이미 돌리는 새 문서는 늦은 활성화를 흡수한다(오너 결정 P3-8 A~P3-12 A). 기계 시간
      초과 뒤의 임시 대체 승격은 깨끗한 운영 업데이트 두 번 뒤 Phase 3의 다음 배포에서 지운다.
      배포 대상은 target `app`, Developer API D1 `false`다. R2는 App 런타임 입력만 바꾸고, 배포된 R1
      `572880a2`를 기준으로 부분 게이트 판정을 로컬에서 돌리면 다른 다섯 Worker의 런타임 경로 변경과
      App 운영 의존성 변화가 0이다(실제 게이트는 Production Release가 다시 판정). 초기 JS는 C6-10을
      그대로 얹으면 491,541 B로 유지 상한 491,568 B까지 27 B였다. 오너가 5% 예비를 지키고 C6-15를
      쓰지 않기로 해 동작을 바꾸지 않는 줄이기 넷(`fed41e70`)으로 bump 뒤 491,481 B(여유 87 B, 초기
      전체 570,109 B로 461 B)가 됐다. 다음 앱 증분에는 여유가 넉넉하지 않다. R2는 자동 게이트
      (exact-main CI 후보와 Production Release의 배포 검사)가 통과하면 실기기 확인 없이 밤사이에
      배포해도 된다. Phase 3 종료 조건은 R1·R2의 실기기 확인과 R2 배포 뒤 14일 무제보다. C6-15는
      기각했다([RO-43](design/resource-ownership-registry.md#ro-43-update-prompt-stays-eager)). 토스
      인앱은 범위 밖이다. 혼합 버전: R2 배포 뒤 새로 연 페이지는 v776 controller 아래에서 9.0.6 코드로
      돌아 C6-10 코드가 v777을 적용하고 로고 경로를 돈다. 배포 전부터 열린 9.0.5 탭은 C6-9 기계로
      적용한다. 다음 문서 표지의 키는 그대로다. 로컬 최종 검증(`7d14ff10`): 단위 645 files /
      14,829, Worker 60 files / 2,889, `build:checked` 전체, critical E2E 61/61, 두 빌드의 실제
      Chromium 업데이트 확인 아홉 장면 PASS(배포 뒤 새로 연 페이지의 Apply·로고, 멈춘 Apply 뒤
      로고의 흡수 포함). 실기기 확인(대기): 배포 뒤 새로 연 페이지의 대화상자·Apply·Later·로고
      (iPhone Safari 포함), 방 게스트의 `/CODE` 복귀, 바쁜 방에서의 로고, 실제 방에서 다른 탭이
      적용할 때 한 번만 묻는지, 임시 대체 승격의 운영 사용 여부. 리뷰가 남긴 작은 항목(기계 없는
      승격의 요청 표지, 오래 남는 흡수 표지, 멱등인 중복 `SKIP_WAITING` 두 길)은 동작 변경이라 R2에서
      고치지 않았다. [R2 보고서](design/phase3-r2-logo-reset-2026-10-24.md).

### Phase 2 앱 묶음 9.0.4 배포 뒤 확인(페이지 이동·화면 셸·이전 시 입장 암호 끄기)

- [ ] 구조 개선 Phase 2를 앱 업데이트 한 번으로 묶었다(오너 결정 1~13, 2026-10-23). 페이지 이동은
      `session-reset.ts` 주인 하나로 모였고 재로딩 바쁨 규칙이 바뀌어 예전에 버려지던 재로딩이 이제
      실행된다. 뒤로 가기 캐시 복귀가 어차피 재로딩할 때만 대기 중인 재로딩을 버린다. 로고 재설정은
      SW 승격을 최대 2.5초 기다리고, 재설정 화면은 전체 화면 안에 뜬다. 전체 화면 나가기는 화면 보호기와
      YouTube가 진행 중인 나가기 하나를 함께 쓰고, 그동안 YouTube 전체 화면 버튼이 흐려진다. 재생목록은
      제자리로 돌아가는 중 삭제와 시스템 오디오 전환이 동작을 즉시 끝낸다. 계정 신호의 바이트는 그대로다.
      오너 승인으로 2026-10-24 01:56 KST
      [Release 39990279349](https://github.com/hiefny/MUSIXQUARE/actions/runs/39990279349)(target `all`,
      PRO 먼저)로 배포했다. 2026-10-24 오너가 운영에서 iPhone Safari·Windows Chrome으로 업데이트 적용,
      iPhone 뒤로 가기 캐시 복귀(재로딩 한 번), 설치한 앱의 뒤로 가기·구글 로그인 뒤 돌아오기, 화면 보호기
      중 YouTube 전체 화면 버튼 흐림, 재생목록 끌어 놓은 직후 삭제를 확인했다
      ([실기 QA](design/phase2-navigation-ui-shells-2026-10-23.md#운영-실기-qa-2026-10-24-오너)). 남은 것은
      TV 빌드 전체 화면과 보고서의 작은 미확인 항목(SW 업데이트가 걸린 로고 재설정, YouTube 전체 화면의
      뒤로 가기·다음 트랙, 일반방 게스트 관리자의 삭제, 끌기 중 시스템 오디오)이다.
      첫 로딩 JS는 478.0 → 478.8 KiB(gzip)로 예산 안이다(오너가 수용한 478.7보다 0.1 KiB 큼).
      [묶음 보고서](design/phase2-navigation-ui-shells-2026-10-23.md),
      [페이지 이동 계약](design/page-navigation-ownership.md).
- [ ] PRO 소유권 이전 시 입장 암호 끄기(같은 묶음): 오너 결정(2026-10-23)대로 이전이 커밋되면 방
      설정의 "암호 끄기"와 같은 상태로 입장 암호가 꺼지고, 이전 링크는 암호를 묻지 않는다.
      `OWNER_TRANSFER_PIN_REUSE`(이전 소유자 PIN 확인 수단, 소비되지 않은 링크에 "새 링크 요청"
      안내)와 재생 PIN 비교를 없앴다. 결정 전 앱(9.0.4 전)의 `newPin`과 PIN이 든 옛 대기 레코드는
      받고 무시한다. 소유권 이전 입장 암호 끄기는 9.0.4와 함께 target `all`(PRO room 먼저)로
      배포됐고, PRO 입장 정책 계약 표지
      `pro-room-optional-entry-password-v1+pro-owner-transfer-pinless-v1`이 운영에 올라가 이제 자동
      복구가 PRO·App을 표지 아래로 되돌리지 않고 앞으로 고친다(§4). 구버전 호환 코드 제거 열차 2의
      릴리스 W(배포 전)가 배포되면 App facade가 그 `newPin` 본문을 이전 의도를 기록하기 전에 400으로
      거절하고(PRO도 400, 그런 앱은 최소 앱 빌드 787 아래), PIN이 든 옛 대기 레코드는 계속 받되 그
      PIN을 읽지 않고 지운다(만료된 대기 레코드는 새 PREPARE나 commit 전까지 남아 이전 소유자 연결을
      들고 있다). 남은 것은 테스트 방에서 이전
      링크가 암호를 묻지 않는지, 새 소유자 설정에 암호 꺼짐이 보이고 켤 수 있는지, 이전 때 있던
      참여자가 코드만으로 들어오는지 확인하는 것이다. 오너 결정(2026-10-24): 운영자가 직접 하는 드문
      작업이라 이 확인은 다음 실제 이전 때 한다.
      [변경·호환·한계](design/phase2-navigation-ui-shells-2026-10-23.md#pro-소유권-이전-시-입장-암호-끄기),
      [구버전 제거 열차 2 릴리스 W 보고서](design/old-version-removal-2w-workers-2026-10-26.md).

### Phase 1 서버 주인 합치기 배포 뒤 확인

- [ ] Phase 1 네 단계가 2026-10-23에 모두 배포됐다(C7-3 10:19, C7-8·C7-11 12:50, C7-9 14:33, C7-4·C7-6
      14:49 KST). 동작이 바뀐 것은 C7-9(소유권 이전 사가의 D3 순서와 감사 중복 제거)뿐이다.
      오너가 승인한 테스트 방의 운영 소유권 왕복 이전은 같은 날 15:14·15:26 KST에 완료했다.
      App `10a5f32e` / PRO `19dfae1a`에서 두 사가 `complete`, 이전별 성공 감사 각 1행,
      펜스 `cleared`, 양쪽 권리 이동·복원과 새 소유자의 재생·설정 및 이전 소유자의 UI 권한 상실을
      확인했다. 기존 PIN을 재사용한 첫 시도는 거절됐으며 그 `intent`는 `superseded`로 정리됐고
      권리 이동은 없었다. 원래 소유자로 복원했으며 키가 없던 방이라 기존 키 폐기의 실효는 미검증이다.
      로드맵의 계정 삭제·삭제된 소유자 방 이전 확인은 수행하지 않아 열린 항목으로 유지한다.
      운영 장애 주입·요청/크론 충돌 검증은 이번 왕복 범위 밖이며 기존 Worker 테스트가 근거다.
      배포 창에 옛 App Worker가 마지막에 쓴 행은 성공 감사 줄이 둘일 수 있다.
      [사가 실행기](design/app-worker-saga-executor-2026-10-23.md),
      [아웃박스·길이 읽기](design/pro-room-outbox-duration-owners-2026-10-23.md).

### 9.0.3 PRO SFU 재시도의 수신 대기 유지·느린 제스처 재개 확인

- [ ] App 9.0.3/v771은 2026-10-23 03:07 KST [Release 39828174957](https://github.com/hiefny/MUSIXQUARE/actions/runs/39828174957)로 배포했다(target `app`). 아래 9.0.2를 함께 실었다(오너 결정 2026-10-23). PRO SFU 재시도가 같은 발행이면 수신 대기를
      유지해 재생 정지 처리와 수신 시작 알림을 다시 돌지 않는다. 750ms보다 늦게 끝난
      제스처 재개는 오디오 컨텍스트 주인이 시계를 확인해 회복한다. 실기기(PRO SFU 구독
      실패 지속, iOS 블루투스·경로 전환의 느린 재개)는 미검증이다.
      [변경·검증·한계](design/pro-sfu-retry-and-slow-gesture-resume-2026-10-23.md).

### 9.0.2 PRO 같은 네트워크 직접 수신의 마감 주인

- [ ] App 9.0.2/v770은 따로 배포하지 않고 9.0.3에 실어 2026-10-23 03:07 KST에 배포했다.
      PRO LAN-direct 수신도 게스트 30초 감시
      없이 수신 대기에 들어가고, 늦게 온 트랙이 붙는다. 마감은 코디네이터가 가져
      트랙이 붙지 않으면 "연결이 불안정"을 발행 세대마다 한 번 알린다. 실기기(늦게
      들어온 청취자, 잠들었던 배포자 페이지)는 미검증이다.
      [변경·검증·한계](design/pro-direct-receive-deadline-2026-10-22.md).

### 9.0.1 경쟁하는 복구 흐름 사이의 틈 4건

- [ ] App 9.0.1/v769는 2026-10-22 18:25 KST [Release 39755032853](https://github.com/hiefny/MUSIXQUARE/actions/runs/39755032853)로 배포했다(target `app`). 9.0.0 회귀인 PRO 시스템 오디오 구독
      백오프와 게스트 30초 수신 감시의 충돌, 화면 복귀 재정렬이 게스트의 YouTube
      일시정지를 다시 푸는 문제, PRO 일시정지 게이트를 무시하던 YouTube 권한 준비
      경로, 세션 리셋이 화면 잠금(`inert`)을 직접 쓰던 문제를 고쳤다. 실기기(PRO
      시스템 오디오 구독 실패 지속, iPhone Safari 화면 복귀 직후 일시정지와 복귀 뒤
      일시정지 상태로 남지 않는지, PRO 일시정지 대기 중 다른 전환, 리셋 중 열린
      대화상자)는 미검증이다. [변경·검증·한계](design/ownership-gap-fixes-2026-10-22.md).

### 9.0.0 유휴 계산 정리·PRO 하트비트 계약

- [ ] App 9.0.0/v768은 2026-10-22 07:34 KST [Release 39686757595](https://github.com/hiefny/MUSIXQUARE/actions/runs/39686757595)로 배포했다(target `all`). 꺼진 리버브·가상 저음·익사이터의 입력을
      끊고, 반사 지연을 DelayNode로 옮기고, 공유자의 분석 노드는 캡처에서 받는다.
      모노 파일을 양쪽으로, 5.1을 표준 다운믹스로 내보낸다. 큰 파일은 0.25–0.5초
      버퍼로 예약하고, 가려진 화면과 화면 보호기의 낭비를 없앴다. YouTube·PRO
      타이머를 정리했고, [PRO 재생목록 대상 유지](design/pro-playlist-targets-2026-10-22.md)
      4건과 8.11.40·8.11.41 후보를 함께 실었다. PRO 하트비트 응답이 시스템 오디오
      상태를 싣는 호환 변경이라 9.0.0 이전 앱은 PRO 방에서 빠졌다가 새로고침하면
      복구된다(오너 수용). 시스템 오디오 계약 표지는
      `single-stereo-v3+heartbeat-state-v1`이며 `all` 릴리스가 필수이고, 표지
      이전으로 부분 롤백하지 않는다. 실기기(S25 Chrome·블루투스·Android 백그라운드,
      iPhone Safari의 화면 보호기·효과 게이트)와 실제 PRO 서버의 하트비트 교체는
      미검증이다. [변경·측정·한계](design/idle-compute-optimization-2026-10-22.md).

### 비주얼라이저·화면 보호기·프리로드 표시 후보

- [ ] App 8.11.40/v766은 [PR #442](https://github.com/hiefny/MUSIXQUARE/pull/442)로
      main `264fd5db`에 병합했으며 9.0.0으로 함께 배포했다(2026-10-22, Release 39686757595). 저음 반응 확대, 독립 시간 기반 smoothing,
      가림/동작 줄이기 처리, 스펙트럼 peak 집계와 조건부 로딩을 수정한다.
      미완료 프리로드 선택 시 완료 대기 문구와 진행 막대가 같은 세션의
      퍼센트를 이어서 표시한다. 정상 선택의 받은 바이트 재사용을 유지한다.
      신규 의존성·서버 계약·스키마·비밀·바인딩 변경 없음. 최초 미캐시
      스펙트럼 선택에는 추가 로딩이 가능하며 설치 완료 후 offline 자산을 보존한다.
      병합 SHA의 [main CI 39646353420](https://github.com/hiefny/MUSIXQUARE/actions/runs/39646353420)
      11 jobs가 통과했으며 배포하지 않았다. 물리 기기의 음악별
      시각 체감·전력/GPU 및 Safari 오디오 확인은 남는다.
      8.11.40 초기 JS는 유지 상한보다 30 B 작고 별도 5% reserve는 유지한다. 후속 변경은
      용량을 다시 측정해야 한다.
      [비주얼라이저 변경·검증 한계](design/visualizer-response-optimization-2026-10-22.md),
      [프리로드 표시 수정·검증](design/preload-finishing-progress-2026-10-22.md).

### 수신 파일 조립 메모리

- [ ] App 8.11.41/v767 후보: 수신 청크를 작은 Blob으로 보관하고 완료 시 Blob
      조각을 합쳐 파일 크기의 BufferSource 재복사를 줄인다. 전체 encoded 원본
      보관·디코더·이어받기·프리로드 소유권과 기존 메모리 장부 예산은 유지한다.
      신규 의존성·서버 계약·스키마·비밀·바인딩·최소 브라우저 요구사항 변경 없음.
      실제 iPhone Safari/PWA의 대용량 수신·재생과 물리 메모리 한계는 미검증이며
      데스크톱 결과로 닫지 않는다. 700 MiB 비교의 전체 메모리 최대는 감소했지만
      관측 Proxy 없는 비교에서도 Chromium 쓰기 구간은 약 1.68초 늘었다.
      완료 호출은 두 엔진 모두 단축됐다. 최초 Proxy 포함 시간은 제품 자체
      비용에서 제외한다. 각 1회인 모듈 측정이며 실제 망/기기 성능 확인은 남는다.
      초기 JS gzip은 491,523 B로 유지 상한보다
      45 B 작으며 별도 5% reserve는 유지한다. 9.0.0으로 함께 배포했다(2026-10-22, Release 39686757595).
      [변경·검증·측정 한계](design/ramstore-blob-assembly-2026-10-22.md).

### YouTube 목록·관리자 iframe 조작

- [ ] 실제 공급자·실기 확인: 원래 사용자 제보의 자연 반복/정지 경로는 캡처가
      없어 원인 전체를 확정하지 못했다. 합성 provider 회귀로 검증한 수정이 실제
      사건의 경로였다고 단정하지 않는다. 실제 YouTube 키보드·미디어 키, 광고,
      모바일 WebView, 가청 싱크와 제보 목록의 모든 영상 재생 가능 여부는 미검증이다.
      재발 시 새 원인 근거를 수집하며, 이번 배포 성공으로 이 한계를 닫지 않는다.
      [수정·검증 한계](design/youtube-playlist-native-control-repair-2026-10-14.md),
      [원인 조사](design/youtube-playlist-native-control-audit-2026-10-14.md).

### 일반방 직접 파일 전송·프리로드의 남은 실기 한계

App 8.11.20/v723에서 일반 직접 전송·프리로드의 local threshold를 64 KiB로
통일하고, 지원하는 양쪽 연결에 128 KiB 누적 수신확인 창을 적용했다.
최종 runtime `fd1ce373`의 실제 제품 RTC 8조건·26파일 SHA가 통과했으며 혼합 버전
입장·취소/재등록·승격을 확인했다. 구현·재현된 입장 호환 결함은 해결됐고,
아래 확인 항목은 유지한다.
[설계·검증·배포 근거](design/receiver-credit-file-transfer-2026-10-18.md).

- [ ] 실제 Android/무선망 제보의 인과관계와 가청 동기화: Windows 제어·해시
      검증으로 원래 사건 전체를 확정하지 않는다. Pixel 에뮬레이터는 무전송 때부터
      버퍼링이 있어 품질 비교에 부적격이었고, 한 실행의 YouTube onError(5) →
      guest stop 원인은 미확정이다. 실제 기기/live 공급자에서 재확인한다.
      [Pixel 한계](design/preload-local-pixel-retest-2026-10-18.md),
      [실제 공급자 비교](design/youtube-preload-live-ab-2026-10-18.md),
      [두 재생 오염 경로 수정](design/youtube-heartbeat-delay-reproduction-2026-10-17.md).
- [ ] 실제 망의 지연·처리량·기기 부하: 고RTT 8 Mbps 실험에서 23 MB 완료가
      24.495→64.540초로 늘었다. 이는 제어 대기열을 줄이는 고정 창의 대가이며
      첫 파일 대기나 다음 곡 준비가 늦어질 수 있다. 원격 이력의 한 달 전·어제·현재
      각 배포 SHA의 원본 소스를 로컬 빌드한 최소 6회에서도 고RTT 완료가 어제25.352초→
      현재71.817초로 늘었고, 2 Mbps에서는 어제101.683초→현재97.275초였다.
      한 달 전에는 제어 최대20.077초와 약19.6초 재생 오차가 관측돼 지연 자체를
      최근 구조만의 문제로 단정할 수 없다. 단일 수신자·각1회·제어된 공급자이며
      최초 커밋은 원본 입장 예외로 정식2조건 미실행이다. 전송 무결성6회 통과는
      재생 품질 전체 통과가 아니며 운영값·기존 실기 한계를 유지한다.
      [역사 비교 근거](design/historical-transfer-comparison-2026-10-18.md).
      별도 같은-main A192 선별은 71.791→49.516초로 단축했지만 raw 최대1초와
      전체구간 p95 증가 예산에 실패해 채택하지 않았다. 결정 표본은192 확대 전
      시작 구간이며, 전송 길이에 따른 p95 표본 비중 차이를 별도로 기록했다.
      후속6조건은 미실행이고 운영값을 바꾸지 않았다.
      [A192 실패·원시 경계 근거](design/adaptive-credit-192-screen-2026-10-18.md).
      이어진 AF19216(협상된 native16 KiB+적응형 최대192 KiB) 8실행은 고RTT
      preload71.583→48.450초·일반64.217→36.760초, 느린 망101.610→101.614초를
      기록했다. 동적망149.978→122.697초 단축에도 초기 상대 제어 지연 예산을
      넘어서 채택하지 않았다. 결정 표본은192 확대 전128 단계였고 native 전달
      내부 원인은 미확정이다. 작은 tail 분석 오탐은 별도 수정·재판독했지만
      실제 성능 실패를 없애지 않으며, 역순4회·다중/수명6회는 미실행이다.
      [AF19216 실패·독립 감사](design/adaptive-credit-fragment16-screen-2026-10-18.md).
      후속 동일 B128 진단에서 첫 청크 809/1,885ms 상태를 재현했고, 느린 실행은
      이미 도착한 제어 메시지의 지연 ACK가 재전송 타이머와 경합해 전송량이
      줄어든 뒤 bulk를 시작하는 패킷·소스 근거를 확보했다. 지연만 100→80ms로
      바꾼 비교의 계획 관측 구간에서는 같은 경합이 없었다. 이는 새 재현의
      시작 지연 설명이며 과거 모든 실패·72초 전체 비용·실제 현장 원인의
      확정이 아니다. 전체 파일은 미완료인 8초 진단이고, 비교 실행의 관측 종료
      후 재전송 원인은 미확정으로 보존한다. 후보 실패·운영값·배포 보류를
      유지하며 [시작 전송 원인 조사](design/startup-transport-cause-2026-10-19.md)를
      다음 검증에 사용한다.
      후속 제어 연결 분리 실험에서 고정 256 KiB 창은 느린 망 상대 p95 예산에
      실패해 제외했다. 별도 실제 RTC 제어 연결+기존 적응형 128→192 KiB 후보는
      고RTT preload 73.103→40.193초, 연결 전부터 고RTT를 적용한 별도 비교에서
      72.375→40.108초로 단축했다. 후자의 sync-pong 최대는 1,254.3→152.7ms다.
      느린 망은 128 KiB를 유지하며 101.608→97.476초, 동적 8→2→8Mbps는
      151.276→115.623초였고 각 적용 가능한 제어·무결성·재생 관측 게이트를
      독립 판독했다. 서로 다른 느린 망·고RTT 수신자 2대에 동시 전송한 비교도
      일반 파일 65.667→39.912초, preload 66.214→40.084초로 고RTT 쪽이 단축됐고,
      느린 쪽 시간 증가는 각각 0.291%/0.224%였다. 각 수신자의 전체 방 전송구간
      제어 지연까지 적용 가능한 예산을 통과했다. 호스트 업링크는 제한하지 않았다.
      후보의 취소/재등록·다음 곡 승격·의도적 보조 연결 종료도 각각 단일 실행으로
      독립 감사했다. 종료된 쪽의 미확인 debt·미도착 제어는 보존하며 다른 수신자는
      기존 연결로 파일을 완료했다. 살아 있는 전송 중 경로 전환·재접속 검증은 아니다.
      이는 미배포 Qlease가 같은 두 로컬 빌드의 실험이며
      운영 버전 직접 A/B나 실제 Android·음향 검증이 아니다. 제품의 인증된
      보조 연결 협상·재접속·모바일 비용은 아직 구현·검증하지 않았으며
      운영 128 KiB와 배포 보류를 유지한다.
      [제어 연결 분리 실험·검증 범위](design/control-association-isolation-2026-10-19.md).
      2026-10-19 오너가 실제 앱 통합·협상/재접속·일반/프리로드 검증 뒤 조건부
      배포를 승인했으나, 안전 중단 후 같은 날 검증만 재개하며 배포는 명시적으로
      보류했다. 별도 delay-based credit 브랜치는 읽기 전용 검토 대상으로 두며
      현재 검증 후보에 섞지 않는다. App 8.11.22/v731 후보는 제품 내부 협상과 전환 순서 보호,
      최대 8개 별도 제어 PC, 분리 성공 시에만 128→192 KiB 적응을 구현했다.
      신규 의존성·스키마·비밀·바인딩·입장 정책 변경 없이 App만 배포할 계획이며,
      이전 Qlease 미배포 변경도 범위에 포함된다. v728의 첫 실제 제품 고RTT 일반
      전송 비교는 73.879→66.498초(9.99%)로 사전 20% 개선 기준에 실패했다.
      파일·경로·제어 지연 예산은 통과했지만, 단일 2초 확대 표본의 19.44% 이득이
      거절되어 30초 cooldown이 발생했다. 산술·이식 결함은 확인되지 않았다.
      첫 확대 관측만 균일하게 4초로 늘리고 안전·합격 기준을 유지하는 별도 후보를
      검증하며 원래 실패를 보존한다. v729의 일반 전송은 73.634→52.706초로
      기준을 통과했지만 프리로드 쌍 비교는 기존 버전 준비 실패로 중단했다.
      후속 진단에서 READY 전 같은 곡 replay가 시작 예약을 잃는 별도 경계를
      재현해 v730에서 보완했지만, 실제 재검증에서 READY 재생 뒤 지연 cue가
      덮는 잔여 경계가 나왔다. v731은 같은 곡 재요청 시 기존 로드를 유지하고
      시작 의도만 갱신한다. 최초 오류의 원시 유실과 재현된 실패를 구분하며,
      C9(`6a5afaae`)의 남은 로컬 검증은 완료했다. 실제 제품 RTC 고RTT preload는
      72.041→51.454초, 느린 망은 102.444→103.770초, 동적 망은 156.439→126.724초로
      각 사전 기준을 통과했다. 구·신 버전·취소/재등록·승격 6조건 10파일과 실제
      Reconnect→Start 3파일도 독립 기능 검증을 통과했다. 호스트 단일 4Mbps 업로드를
      공유한 두 수신자는 완료시간 증가가 +0.962%/+1.502%였고, 방 전체 관측의 최대
      제어 지연은 2,184.0→375.2ms로 줄었다. 두 창은 128KiB를 유지했다.
      시험 조작 순서와 판독기 오류의 최초 실패, 구버전 초기 재생이 겹친 baseline,
      희소 통계 N/A·export 구간 무효 표본은 보존한다. 실제 기기·가청 싱크·live 공급자
      한계는 그대로이며, 재개 중 제품 코드를 추가 수정하거나 다른 후보를 섞지 않았다.
      실제 제품 검증·exact-main CI·배포가 끝나기
      전에는 실험 통과를 운영 완료로 바꾸지 않는다.
      [제품화·검증 기록](design/control-isolation-product-integration-2026-10-19.md).
      같은 날 오너는 #410·지연 기반 창(128–256 KiB, 근거 상한)·전송 중 시계 보호를
      한 릴리스로 묶고, 사전에 고정한 native 라운드가 괜찮으면 배포하도록 요청했다.
      App 8.11.23/v732 후보 `72c58898`의 r1은 고RTT 프리로드·일반 전송 71.6→47.7초
      (−33%), 느린 망 +1.3%, 급락 8→2→8 −21%, 로컬 파일 재생 중 프리로드 65.3→33.3초로
      기준을 통과했다. 모든 응용 제어 최대는 1초 미만(급락 557ms)이고 재생 조작·로컬
      보정은 0이었다. 보조 연결 ICE restart는 다음 릴리스로 미뤘고, 망 전환 시 연결 종료는
      허용 위험 #18에 두었다(2026-10-25 [은퇴](known-accepted.md#retired-risks), 아래 최근 해결
      근거). 2026-10-19 18:14 KST Release 39228199282로 배포했다. 실기 Android/iOS·
      가청 싱크·live 공급자는 여전히 미검증이다.
      [통합 릴리스 검증](design/transport-release-bundle-2026-10-19.md).
      오너는 같은 날 운영 8.11.23에서 직접 파일을 받은 폰을 와이파이→LTE로 바꿔 연결 끊김을
      재현했다. 8.11.24/v733 후보(`ee8dcd28` + 식별자)는 보조 연결 ICE restart를 더한다.
      8.11.24는 배포하지 않고 아래 미리받기 재개, 공유 중지 버튼 정렬 수정과 묶어 8.11.25/v734
      (`e371df6b`)로 2026-10-20 04:04 KST Release 39307533720에서 배포했다.
      구현 세션 랩과 기대값 없이 수행한 독립 검증 모두, 짧은 끊김은 두 버전 다 유지하고
      보조 연결이 failed에 닿으면 8.11.23만 세션을 잃으며, 원래 연결의 15초 유예를 넘는
      끊김은 두 버전 모두 끝난다는 같은 결과였다. IP 변경은 랩에서 흉내 낼 수 없어 배포 뒤
      실기 확인으로 남긴다. 두 랩 모두 미리받기가 원래 연결 disconnected 감지 즉시 중단되고
      복구 뒤 다시 시작하지 않는 기존 동작을 확인했다. 8.11.25는 끊긴 레인을 ABORT 없이 멈춰
      두었다가 같은 연결이 복구되면 처음부터 다시 보내고(`restart` 표시), 게스트는 남은 부분 세션을
      놓고 재시작한다. 같은 (c) 조건의 2차 5회와 최종 런타임 3회가 모두 정확한 파일로 완료했다. 방장만
      고친 1차 후보는 4회 중 1회 실패했고, 그 원인을 게스트 재시작으로 고쳤다. 최종 3회 중 1회는 끊김 전에
      들어온 운영체제 미디어 일시정지로 재생 기준(C3)을 계산하지 못했다. PeerJS 연결은 복구를 알리지
      않으므로 기존처럼 바로 취소한다.
      [미리받기 재개 근거](design/preload-resume-after-ice-recovery-2026-10-20.md)
      [독립 검증](design/side-ice-restart-independent-verification-2026-10-20.md),
      [구현 랩](design/side-ice-restart-native-lab-2026-10-19.md).
      이전에 수행한 128/256/384/512 KiB
      비교에서 일반 전송과 프리로드의 고RTT 경로를 모두 반복 측정했다. 256 이상은
      이 조건에서 빨랐지만, 2 Mbps 프리로드에서는 파일 완료시간 이득 없이
      재생 중 자동 재정렬을 일으켜 고정 기본값 확대 후보에서 제외했다.
      후속 적응형 128→192→256 KiB 후보도 고RTT 완료시간은 약55% 줄였지만,
      느린 망 일반 전송의 동일 sync-pong 추가 최대 지연이 274ms 늘어 사전
      비교 예산 250ms를 넘었다. 채택·배포하지 않았으며 운영 128 KiB를 유지한다.
      로컬 기준 64/128/256 × 수신확인 창 128/256 KiB 후속 교차 36회와
      선택 조합 역순 12회도 완료했다. 파일 224개는 모두 무결성·receipt 검사를
      통과했지만, 창256의 느린 망 프리로드 3회는 재생 유지에 실패했다.
      로컬256/창128의 고RTT 전송은 역순에서도 약65초로 같았고, 느린 망
      프리로드의 동일 sync-pong 추가 최대 지연은 기준보다 +279/+289ms로
      두 순서 모두 예산을 넘었다. 무제한 망 일반 전송의 첫 속도 이득도 역순에는
      재현되지 않았다. 대체 기본값을 채택하지 않고 운영64/128을 유지한다.
      후속 합동 검토에서 보수적 적응형A2, native16 KiB 분할F16, 둘의 조합AF16을
      격리 구현했다. native12회·36파일은 기능/무결성을 통과했으나, A2·AF16은
      갑작스러운8→2 Mbps 하락 구간의 동일 sync-pong excess max가 기준보다
      +348/+391ms 늘어250ms 예산을 넘었다. F16은 고RTT 이득10.47%로
      사전20% 기준에 미달했다. 종합 통과 후보가 없어 확대 확인은 생략했고,
      후보 runtime은 미배포다. 이 결과로 모든 망에서 개선이 불가능하다고
      단정하지 않으며 운영64/128과 기존 실기 한계를 유지한다.
      구버전 송신자는 기존 지연이 남고(혼합 검사 최대 2.483초), 실기 CPU/메모리·
      8대 초과 실기·TURN은 미검증이다. PRO/R2는 변경 대상이 아니다.
      128 KiB는 payload 미확인량 상한이며 전체 네트워크 대기/지연 상한이 아니다.
      [네 창의 비교·선택 근거](design/receiver-credit-window-comparison-2026-10-18.md),
      [적응형 후보의 지연 예산 실패](design/receiver-credit-adaptive-design-2026-10-18.md),
      [로컬·수신확인 교차 48회와 역순 재검증](design/receiver-credit-cross-matrix-2026-10-18.md),
      [후속 합동 후보·동적 망 선별](design/transport-candidate-roundtable-2026-10-18.md),
      [범위·tradeoff](design/receiver-credit-file-transfer-2026-10-18.md),
      [이전 64 KiB 완화](design/preload-capacity-validation-2026-10-18.md),
      [독립 native 조사](design/preload-control-queue-root-cause-2026-10-18.md).
- [ ] 창 확대 전 시계·자동 보정의 혼잡 내성: 256/384/512 KiB 실험 후보의
      2 Mbps 프리로드에서는 정상 파일 수신과 별개로 불필요한 pause→seek→play가
      각 두 번씩 재현됐다. 첫 사례는 좋은 시계 표본의 개수 제한 퇴출 이후
      비대칭 대기열이 섞인 표본 선택→드리프트 오판→자동 재정렬 경로로 분석했다.
      128 KiB는 같은 두 반복에서 재생을 유지했다. 이는 확대 후보의 통제 실험
      결과이며 운영 128 KiB나 원래 Android 사건의 발생 증거로 바꾸지 않는다.
      후속 약178초 실제 RTC 혼잡에서도 현재 128 KiB는 재생을 유지했다.
      고정256 대조군은 추가 재생 조작 5개(완료한 보정 1회와 미완료 1회)가
      발생했고, 시계 품질로 자동 정밀 보정을 제한한 별도 후보는 0개였다.
      메시지 지연은 986→989ms로 거의 같아 전송 개선으로 해석하지 않는다.
      당시 보호는 격리 실험 소스에만 있었다. 후속 Qlease 후보는 자동 재정렬 한 작업의
      시각을 고정하고, 시계 무효화/지각 릴리스 후 같은 소유권이 유지되면 보정 전
      로컬 타임라인으로 복귀한다. 새 handler29개를 포함한 결정적648개가 통과했고,
      같은29개를 이전 Q-only에 적용하면18 pass/11 expected fail이었다.
      이는 실험 후보 간 대조이며 운영 결함11건을 뜻하지 않는다. 실제300ms
      오차도 고RTT 품질 부족 때 보류하는 한계가 남고, 복귀는 재생 지속 보호이지
      정확도 회복이 아니다. 미배포이며 수동 조작·3초 초과 별도 보정·실기/가청
      정확도·실제 슬립·관측하지 못한 원격 시계 변화까지 해결한 것으로 보지 않는다.
      더 큰 창이나 적응형 창을 검토한다면 시계 추정·자동 보정까지 함께 검증한다.
      후속 교차 시험도 창256의 세 로컬 기준에서 첫 불필요한 자동 재정렬을
      재현했다. 5개 호출인 사례는 완료 보정1회와 관측 종료 전 미완료 시도1회이며,
      두 번째 시도까지 모두 불필요했다고 분류하지 않는다.
      제품 후보 후속은 운영64/64/128을 유지하고 `m>=150ms && m>2U`의
      시계 불확실성 gate, 관측부터 실행까지 같은 lease, 새 명령 우선과
      제한된 로컬 진단을 추가했다. App8.11.21/v725 후보이며 아직 미배포다.
      로컬 전체 단위13,231 pass와 PR CI11 jobs, 관련 브라우저34개를 통과했다.
      native10회·24파일 및 독립 검산에서 운영128의 전송·재생 보존과 실제
      ±300/±1200ms 복구를 확인했다. 별도256 진단은 잘못된 첫 보정을 차단했지만
      빠른 수신자 두 대의 완료시간이+13.88/+14.71%로 사전10% 예산을 넘었고
      원인은 미확정이다. 전체 사전 계약 통과가 아닌 운영128 한정 빌드 후보다.
      고RTT 처리량·실기 한계는 유지하며 배포하지 않았다. 환경·skip·exact-main
      후보의 완료 여부는
      [후속 제품 후보 검증](design/automatic-realignment-clock-safety-2026-10-18.md)에
      따르며, 실제 오차의 장기 보류·실기/가청 한계를 이 변경만으로 닫지 않는다.
      통합 후보 8.11.23/v732는 같은 gate를 로컬 파일 soft resync에도 적용하고, 용량을
      넘으면 RTT가 큰 표본부터 지워 조용한 표본을 120초 나이 제한까지 유지하며, 강제
      재고정 때 기존 표본을 바로 버리지 않는다. r1 느린 망 로컬 파일 시나리오의 98초
      전송 동안 baseline 시계 오차는 −38ms까지 벌어졌고 후보는 −3ms 안에 머물렀다.
      고RTT 경로에서는 2U보다 작은 로컬 드리프트 보정을 보류하는 대가가 있다.
      [전송 중 시계 보호](design/transfer-clock-sync-guard-2026-10-19.md).
      [재현·원시 시각 재구성·한계](design/receiver-credit-window-comparison-2026-10-18.md#candidate-interruption-queue-biased-clock-and-automatic-realignment),
      [추가 설계·장시간 비교·미배포 범위](design/receiver-credit-adaptive-design-2026-10-18.md),
      [교차 시험의 실패 보존·독립 검산](design/receiver-credit-cross-matrix-2026-10-18.md),
      [작업 시계 고정 후보·대조와 한계](design/transport-candidate-roundtable-2026-10-18.md#qlease-대조).

### 최근 해결 근거

강제 업데이트 열차의 '첫 최소 빌드' 항목(오너 결정 Q2)을 닫고 허용 위험 #13(버전 입장 제한 없음)을 은퇴한다.
2026-10-26 16:10 KST 9.0.14 / v787 배포([Release 40283632968](https://github.com/hiefny/MUSIXQUARE/actions/runs/40283632968),
target `all`, smoke와 공개 자산 확인) 뒤 App Build Floor workflow를 차례로 dispatch하고 각 결론을 읽었다.
[status 40284433812](https://github.com/hiefny/MUSIXQUARE/actions/runs/40284433812)(16:13 KST, success):
`App build floor: stored 0, effective 0, revision 0, updated never; live App 787, reported 787 at 2026-10-26T07:12:51.567Z; client read 0`.
[check 40284513979](https://github.com/hiefny/MUSIXQUARE/actions/runs/40284513979)(16:14 KST, success):
`GitHub OIDC check passed for hiefny/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/main`. Codex P1 수정
`66c90420`(`workflow_ref`) 뒤의 실제 토큰 첫 증명이다.
[set 40284593490](https://github.com/hiefny/MUSIXQUARE/actions/runs/40284593490)(16:15~16:16 KST, success, `-f
min_app_build=787`): `set to 787: changed (revision 0 before)`, 이어 공개 상태, PRO 앞문의 786 거절과 787 입장,
Signaling의 786 `host-auth` 거절, 그 변경보다 새 매분 보고, 페이지 읽기 787을 확인했다. 요약 줄
`App build floor: stored 787, effective 787, revision 1, updated 2026-10-26T07:15:03.890Z; live App 787, reported 787 at 2026-10-26T07:16:24.985Z; client read 787`은
§1 '최소 앱 빌드' 행에 있다. 독립 확인(16:22 KST): 공개 상태 `minAppBuild` 787·`effectiveMinAppBuild` 787·revision 1·
`liveAppBuild` 787, 페이지 읽기 `{"effectiveMinAppBuild":787}`, 가짜 방 000001의 PRO bootstrap은 `X-MXQR-App-Build`
786과 헤더 없음에 426 `{"error":"APP_UPDATE_REQUIRED","minAppBuild":787}`, 787에 200 `pin_required`.
[Drift Audit 40285137773](https://github.com/hiefny/MUSIXQUARE/actions/runs/40285137773)의 App build floor 행 PASS.
그래서 버전 입장 제한이 운영에서 켜졌고 #13은 은퇴했다([은퇴 기록](known-accepted.md#retired-risks)). 이력 행은
더하지 않았다(배포 기록과 같은 PR). runbook의 `set` 직후 Signaling 787 입장 smoke 결과는 이 기록에 없다. 대신 오너가
16:33 KST에 9.0.14로 일반방을 만들고 정상으로 들어갔다(787 방장 입장). 게스트 입장과 실제 옛 탭의 거절은 위 강제 업데이트
항목의 오너 확인으로 남는다.
[보고서 QA 라운드 7](design/forced-update-9-0-14-2026-10-25.md#7-pr-ci-exact-main-ci-배포와-첫-최소-빌드-2026-10-26),
[운영](hotfix-procedure.md#app-build-floor).

허용 위험 #18(일반방 격리 제어 경로가 망 전환에서 끝남)은 오너 실기기 확인(2026-10-25, 운영 9.0.10 / v783)으로
은퇴하고, 8.11.25 보조 연결 ICE restart 실기기 항목을 닫는다. 일반방에서 방장은 집 와이파이에 두고, 게스트는
오너 기기의 Safari 탭을 `?mxqrLog=info`로 열었다(기종은 적지 않음). 게스트가 같은 와이파이에서 현재 대기열
항목을 직접 받은 뒤(이 직접 전달이 격리 제어 경로를 만든다) 와이파이를 꺼 LTE로 옮겼다. 연결 끊김 창이 뜨지
않았고 소리가 이어졌으며, LTE에 있는 동안 방장의 일시정지와 재생이 기기에 바로 반영됐다. 게스트
`/debug console`(UTC, KST는 +9시간): 06:55:22.341 `[Peer] ICE (try 1): local=host, remote=host`, 06:55:22.342
`[Peer] Connection type: local`, 06:55:22.451
`[Guest] PLAY for current queue item with no buffer/pipeline; requesting file`, 와이파이 끔, 06:56:05.155
`[Transport] Restarting isolated control ICE (1/2)`, 06:56:05.378 `[HostPresence] ok -> unresponsive (host)`,
06:56:05.703 `[Transport] Restarting established Standard-room ICE within disconnect grace`, 06:56:08.356
`[Transport] Isolated control ICE recovered`, 06:56:08.565 `[Peer] ICE (try 8): local=relay, remote=srflx`,
06:56:09.389 `[HostPresence] unresponsive -> ok (host)`. 보조 경로는 재시작 시작 뒤 3.2초에 회복했고 원래 경로도
같은 유예 안에서 재시작해 relay 쌍으로 이어졌다. 닫는 조건(창·재접속 없이 재생과 조작이 이어지고 게스트 콘솔에
`Restarting isolated control ICE` 다음 `Isolated control ICE recovered`)을 채운다. 같은 세션의 앞선 시도는
트랙이 이미 재생 중일 때 다시 들어와 직접 전달이 없었고(보조 경로가 생기지 않음) 원래 경로의 재시작 줄만
남았으므로 근거에서 뺐다. 확인하지 않은 것: Android 폰, 방장 콘솔, 그리고 닫는 조건과 별도로 회귀로 보던
두 단계인 같은 공유기의 다른 SSID로 옮기는 IP 변경과 원격(LTE) 게스트가 와이파이로 오는 방향(기록에 이미
복구됨으로 적힌 방향). 다른 SSID 단계는 오너 결정 P4-D15 A대로 범위를 적고 닫는다. 이 회귀들은 따로 열린
항목을 두지 않고 Phase 4 기기 라운드(위 4A 배포 뒤 실기기 확인)의 단계로 남는다. 이 확인은 보조 경로의 기한과
재시작이 아직 제어 격리에 있던 9.0.10 코드에서 했다. 은퇴 기록(#491)은 C5-9를 결함이 나오지 않으면 하지
않는다고 적었지만(P4-D6 A), 같은 날 오너 결정(약 16:30 KST)으로 C5-9와 C5-10의 제어 격리 부분이 네 번째 앱 열차
4D로 갔고(9.0.11 / v784, 2026-10-25 21:30 KST 배포), 이 확인이 4D 기기 확인의 기준선이 된다(위 4D 항목,
[4D 보고서](design/phase4-4d-side-route-owner-2026-10-25.md#오너-결정)).
[허용 위험 은퇴 기록](known-accepted.md#retired-risks),
[독립 검증](design/side-ice-restart-independent-verification-2026-10-20.md),
[통합 릴리스 검증](design/transport-release-bundle-2026-10-19.md#남은-실기-확인).

App 9.0.8/v780의 두 수정은 오너 실기기 확인(2026-10-25, 오너 보고 "실기결과 완벽. 유튜브도 눈금선도",
기기·OS 목록은 받지 않음)으로 닫는다. 일반방 YouTube 첫 재생 뒤 방장 스피커 기준(PR
[#484](https://github.com/hiefny/MUSIXQUARE/pull/484))과 iOS 멈춤 화면 스펙트럼 눈금선 색(PR
[#483](https://github.com/hiefny/MUSIXQUARE/pull/483))은 exact-main `8c3fdcab`의
[CI 40122288691](https://github.com/hiefny/MUSIXQUARE/actions/runs/40122288691),
[Release 40123156024](https://github.com/hiefny/MUSIXQUARE/actions/runs/40123156024) attempt 1로 2026-10-25
04:00 KST에 배포했다(앞선 실행의 일시 브리지 502는 자동 복구, §1). 보고서에 적은 한계(게스트 시작 리드가 직전
방장 시작을 따라감, 게스트 fallback이 예정 시각을 노림, iOS 원인은 WebKit 소스 근거)는 그대로다.
[YouTube 근거](design/youtube-host-speaker-reference-2026-10-25.md),
[눈금선 근거](design/spectrum-grid-ios-color-2026-10-25.md).

App 8.11.37/v762의 두 프리로드 복구 결함은 PR [#436](https://github.com/hiefny/MUSIXQUARE/pull/436),
exact-main `56721c76`의 [CI 39580783569](https://github.com/hiefny/MUSIXQUARE/actions/runs/39580783569),
[Release 39581781117](https://github.com/hiefny/MUSIXQUARE/actions/runs/39581781117) attempt 1로 배포했다.
원본의 두 실패를 재현한 뒤 37개 복구 검사·관련 3,623개 검사와 native 4조건·8파일을 검증했고,
최종 로컬 단위 13,681 pass, main 단위 13,680 pass / 1 Windows-only skip, 브라우저 73 pass,
운영 smoke 4/4·최종 소유권·coherent marker·공개 7자산 해시·Drift 31 pass / 5 manual-only를 확인했다.
64 KiB 청크·로컬 기준 및 적응형 최대 256 KiB는 유지하며, 위 실기·대규모·실제 공급자 한계는 닫지 않는다.
[복구·다중 수신·배포·한계 근거](design/preload-recovery-and-db256-multi-2026-10-21.md#production-release-and-recovery).

App 8.11.20/v723의 일반 직접 파일·프리로드 수신확인 제어는 PR
[#399](https://github.com/hiefny/MUSIXQUARE/pull/399), exact-main `416f5ee4`의
[CI 39081289549](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081289549),
[Release 39081701815](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815)
attempt 1의 운영 smoke 4종·최종 소유권·부분 릴리스 호환성·coherent marker,
공개 8 GET 후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포를
완료했다. 테스트 중 발견한 private hello의 입장 순서 결함도 재현·수정·재검증했다.
실제 Android 사건·고RTT 처리량·혼합 버전 성능 한계는 위 열린 항목에 유지한다.
[설계·실패 원인·검증·배포·복구](design/receiver-credit-file-transfer-2026-10-18.md#release-and-recovery).

App 8.11.19/v721의 프리로드 64 KiB 최소 완화는 PR
[#397](https://github.com/hiefny/MUSIXQUARE/pull/397), exact-main `eea5a842`의
[CI 39074808159](https://github.com/hiefny/MUSIXQUARE/actions/runs/39074808159),
[Release 39075260878](https://github.com/hiefny/MUSIXQUARE/actions/runs/39075260878)
attempt 1의 운영 smoke 4종·최종 소유권·부분 릴리스 호환성·coherent marker,
공개 7 GET 후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비를
완료했다. 실제 Android 사건과 심한 느린 망 지연은 위 열린 항목에 유지한다.
[변경·검증·배포·복구](design/preload-capacity-validation-2026-10-18.md#release-and-recovery).

App 8.11.18/v720의 시작 화면 버튼 전환 크로스페이드(오너 지적·결정 2026-10-18)는 PR
[#395](https://github.com/hiefny/MUSIXQUARE/pull/395), exact-main `06e26645`의
[CI 39067630261](https://github.com/hiefny/MUSIXQUARE/actions/runs/39067630261),
[Release 39068051083](https://github.com/hiefny/MUSIXQUARE/actions/runs/39068051083)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 헤드리스 프레임 캡처와 단위·브라우저 테스트만 있으므로 실제 기기 확인은 아래
실기기 항목에 남긴다.
[원인·변경·검증·배포·복구](design/setup-actions-transition-2026-10-18.md#release-and-recovery).

App 8.11.17/v719의 시작 화면 캐러셀 간격·다크 아이콘 원(오너 결정 2026-10-18)은 PR
[#393](https://github.com/hiefny/MUSIXQUARE/pull/393), exact-main `ee9cd197`의
[CI 39063986797](https://github.com/hiefny/MUSIXQUARE/actions/runs/39063986797),
[Release 39064457697](https://github.com/hiefny/MUSIXQUARE/actions/runs/39064457697)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 스크린샷 픽셀 측정과 브라우저 테스트만 있으므로 실제 기기 확인은 아래 실기기 항목에
남긴다.
[요청·변경·검증·배포·복구](design/setup-carousel-spacing-2026-10-18.md#release-and-recovery).

App 8.11.16/v718의 휴대폰 세로 시작 화면 보이는 기준 가운데 정렬(오너 지적 2026-10-18)은 PR
[#391](https://github.com/hiefny/MUSIXQUARE/pull/391), exact-main `6a934577`의
[CI 39056172118](https://github.com/hiefny/MUSIXQUARE/actions/runs/39056172118),
[Release 39056678732](https://github.com/hiefny/MUSIXQUARE/actions/runs/39056678732)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 스크린샷 픽셀 측정과 브라우저 테스트만 있으므로 실제 기기 확인은 아래 실기기 항목에
남긴다.
[원인·변경·검증·배포·복구](design/setup-mobile-visible-centering-2026-10-18.md#release-and-recovery).

App 8.11.15/v717의 휴대폰 세로 시작 화면 가운데 정렬(오너 요청 2026-10-18)은 PR
[#389](https://github.com/hiefny/MUSIXQUARE/pull/389), exact-main `d51eb367`의
[CI 39053792906](https://github.com/hiefny/MUSIXQUARE/actions/runs/39053792906),
[Release 39054268521](https://github.com/hiefny/MUSIXQUARE/actions/runs/39054268521)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 헤드리스 Chromium 측정과 브라우저 테스트만 있으므로 실제 기기 확인은 아래 실기기
항목에 남긴다.
[변경·검증·배포·복구](design/setup-mobile-centering-2026-10-18.md#release-and-recovery).

App 8.11.14/v716의 일반방 YouTube 지연 heartbeat 보정은 PR
[#387](https://github.com/hiefny/MUSIXQUARE/pull/387), exact-main `e47d0bb5`의
[CI 39038651880](https://github.com/hiefny/MUSIXQUARE/actions/runs/39038651880),
[Release 39039136092](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039136092)
attempt 1 성공·운영 smoke 4종·공개 6 GET 후보 해시 일치·최종 소유권·Drift 31 pass로
배포 준비 항목을 닫았다. 실제 Android 프리로드 사건의 인과관계는 위 항목에 남긴다.
[수정·재현·배포 근거](design/youtube-heartbeat-delay-fix-2026-10-17.md).

App 8.11.13/v714의 방 만들기 QR 깜빡임 수정(오너 요청 2026-10-17)은 PR
[#385](https://github.com/hiefny/MUSIXQUARE/pull/385), exact-main `600f6046`의
[CI 39033815131](https://github.com/hiefny/MUSIXQUARE/actions/runs/39033815131),
[Release 39034289195](https://github.com/hiefny/MUSIXQUARE/actions/runs/39034289195)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
Codex P2 1건(앞선 QR 라이브러리 로드 실패 시 재시도 없음)은 `f8548a9a`에서 고치고 회귀
테스트로 고정했다. 헤드리스 Chromium 프레임 확인과 단위·브라우저 테스트만 있으므로 실제 기기
확인은 아래 실기기 항목에 남긴다.
[변경·검증·배포·복구](design/setup-qr-reveal-2026-10-17.md#release-and-recovery).

App 8.11.11/v711의 업데이트 대화상자 어디서나(오너 결정 2026-10-17)는 PR
[#381](https://github.com/hiefny/MUSIXQUARE/pull/381), exact-main `019d5101`의
[CI 39004078601](https://github.com/hiefny/MUSIXQUARE/actions/runs/39004078601),
[Release 39004520681](https://github.com/hiefny/MUSIXQUARE/actions/runs/39004520681)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
Codex P2 2건은 `d1a3995d`에서 고치고 회귀 테스트로 고정했다. 2026-10-11 방 안 안내와
8.11.6 재접속 적용의 실기기 항목은 그 동작이 사라져 같은 PR에서 8.11.11 항목으로
바꿨다. 로컬 데스크톱 Chromium 확인과 단위 테스트만 있으므로 실제 기기 확인은 아래
실기기 항목에 남긴다.
[변경·검증·배포·복구](design/update-dialog-everywhere-2026-10-17.md#release-and-recovery).

App 8.11.10/v709의 설명 글로우·묶음 중앙 정렬(오너 결정 2026-10-17)은 PR
[#379](https://github.com/hiefny/MUSIXQUARE/pull/379), exact-main `68fb3f9c`의
[CI 38995509028](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995509028),
[Release 38995961690](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995961690)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker,
공개 19 GET의 후보 해시 일치로 배포 준비 항목을 닫았다. 자동 리뷰 P2 1건은
효과 전 글자 경계와 alpha 임곗값 경계가 다른 점을 독립 확인하고 테스트 기준을
교정해 처리했으며 제품 정렬을 다시 이동하지 않았다. 역사 진단은 원문을 보존했다.
기록 작성 시점인 11:46 KST에 로컬/원격 main은 `68fb3f9c`로 같고 checkout은 clean이다.
이 기록 병합 뒤 최종 fast-forward·diff 확인을 수행한다. 실제 iPhone·live 공급자·성능
한계는 유지한다. [변경·검증·배포·복구](design/screensaver-caption-glow-centering-2026-10-17.md#release-and-recovery).

App 8.11.9/v708의 뒤로가기로 맨 위 창 닫기(오너 결정 2026-10-17)는 PR
[#377](https://github.com/hiefny/MUSIXQUARE/pull/377), exact-main `5cbfaadf`의
[CI 38977359502](https://github.com/hiefny/MUSIXQUARE/actions/runs/38977359502),
[Release 38978044549](https://github.com/hiefny/MUSIXQUARE/actions/runs/38978044549)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
로컬 데스크톱 Chromium 확인과 단위 테스트만 있으므로 실제 기기의 뒤로 버튼·제스처는 아래
실기기 항목에 남긴다.
[변경·검증·배포·복구](design/back-closes-top-window-2026-10-17.md#release-and-recovery).

App 8.11.8/v707의 승인된 diffusion 01 시계 배경은 PR
[#375](https://github.com/hiefny/MUSIXQUARE/pull/375), exact-main `e0d71731`의
[CI 38950054085](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950054085),
[Release 38950797624](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950797624)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker,
공개 19 GET의 후보 해시 일치로 배포 준비 항목을 닫았다. 새 이미지 7개는 승인된
처리 결과와 동일하고 이전 이미지 7개도 보존했다. 물리 화면의 밴딩 부재를 보장하지
않으며 실기기 항목은 유지한다.
[변경·검증·배포·복구](design/screensaver-diffusion-clock-2026-10-17.md#release-and-recovery).

App 8.11.7/v705의 백그라운드 복귀 대화상자 하나만(오너 결정 2026-10-17)은 PR
[#373](https://github.com/hiefny/MUSIXQUARE/pull/373), exact-main `4d1e0011`의
[CI 38944217887](https://github.com/hiefny/MUSIXQUARE/actions/runs/38944217887),
[Release 38945082862](https://github.com/hiefny/MUSIXQUARE/actions/runs/38945082862)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 4 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
단위 테스트만 있으므로 실제 방의 백그라운드 복귀는 아래 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/resume-dialog-dedup-2026-10-17.md#release-and-recovery).

App 8.11.6/v704의 재접속 때 대기 업데이트 적용(오너 결정 2026-10-16)은 PR
[#371](https://github.com/hiefny/MUSIXQUARE/pull/371), exact-main `1a2fb442`의
[CI 38933446890](https://github.com/hiefny/MUSIXQUARE/actions/runs/38933446890),
[Release 38934335022](https://github.com/hiefny/MUSIXQUARE/actions/runs/38934335022)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 4 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
데스크톱 앱 브라우저 창의 로컬 preview 실측(첫 화면 1.2초, 초대 링크 1.4초 적용)은
실제 기기·운영 환경의 다시 열기를 대신하지 않으므로 아래 실기기 항목을 유지한다.
[수정·검증·배포·복구](design/update-apply-on-reopen-2026-10-16.md#release-and-recovery).

App 8.11.5/v702의 작은 캡션 획 손실 대응은 오너의 Windows 수정 비교판 정상 확인,
PR [#369](https://github.com/hiefny/MUSIXQUARE/pull/369), exact-main `a8b37386`의
[CI 38916351290](https://github.com/hiefny/MUSIXQUARE/actions/runs/38916351290),
[Release 38917295260](https://github.com/hiefny/MUSIXQUARE/actions/runs/38917295260)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 Worker 호환성·coherent marker, 공개 144 GET의 후보 해시 일치·16/16 검사 통과로 배포 준비 항목을 닫았다.
캡션은 글자별 소형 텍스처 대신 묶음 canvas를 사용한다. 격리 Chromium 16·Windows
WebKit 16건과 앱의 12개 caption sample에서 내부 획 누락을 찾지 않았지만,
원래 하드웨어 현상의 자동 재현이나 모든 GPU·물리 iPhone 검증을 뜻하지 않는다.
아이폰 실기 항목은 유지한다.
[수정·검증·배포·복구](design/screensaver-caption-rendering-2026-10-16.md#release-and-recovery).

App 8.11.4/v701의 화면 보호기 이미지 배경·호환 전경은 PR
[#367](https://github.com/hiefny/MUSIXQUARE/pull/367), exact-main `813a0220`의
[CI 38909124622](https://github.com/hiefny/MUSIXQUARE/actions/runs/38909124622),
[Release 38909891395](https://github.com/hiefny/MUSIXQUARE/actions/runs/38909891395)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker와
공개 144개 자산의 exact-main 후보 해시 일치(20/20 검사)로 배포 준비 항목을 닫았다.
139개 배경 이미지는 지연 로딩되며 앱 초기 shell에 들어가지 않는다.
Windows WebKit 외형 비교는 아이폰 실기 검증을 대신하지 않아 아래 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/screensaver-image-backgrounds-2026-10-16.md#release-and-recovery).

App 8.11.3/v700의 글자 굵기 최대 700(오너 결정 2026-10-16)은 PR
[#365](https://github.com/hiefny/MUSIXQUARE/pull/365), exact-main `0041d5be`의
[CI 38875238552](https://github.com/hiefny/MUSIXQUARE/actions/runs/38875238552)(의존성 설치 실패 작업만 attempt 2 재실행),
[Release 38876050306](https://github.com/hiefny/MUSIXQUARE/actions/runs/38876050306)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v700·공개 CSS·페이지의 700 초과 0건·공개 OG 이미지 해시를 확인해 배포 준비 항목을 닫았다.
Drift 31 pass / 0 fail / 5 manual-only를 확인했다.
[수정·검증·배포·복구](design/max-font-weight-700-2026-10-16.md#release-and-recovery).

App 8.11.2/v699의 제목 굵기 700 통일(오너 결정 2026-10-16)은 PR
[#363](https://github.com/hiefny/MUSIXQUARE/pull/363), exact-main `c6ccfa03`의
[CI 38866050515](https://github.com/hiefny/MUSIXQUARE/actions/runs/38866050515),
[Release 38866744699](https://github.com/hiefny/MUSIXQUARE/actions/runs/38866744699)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v699·공개 CSS의 700 단일 정의·공개 디자인 시스템 견본을 확인해 배포 준비 항목을 닫았다.
Drift 31 pass / 0 fail / 5 manual-only를 확인했다.
[수정·검증·배포·복구](design/display-weight-700-2026-10-16.md#release-and-recovery).

App 8.11.1/v698 화면 보호기 후속은 PR [#361](https://github.com/hiefny/MUSIXQUARE/pull/361),
exact-main `cedc0b04`의 [CI 38835888083](https://github.com/hiefny/MUSIXQUARE/actions/runs/38835888083),
[Release 38836510116](https://github.com/hiefny/MUSIXQUARE/actions/runs/38836510116)의 운영 smoke·최종 소유권·
미선택 5 Worker 호환성·coherent marker 및 공개 운영 근거로 배포 준비 항목을 닫았다.
Drift 31 pass / 0 fail / 5 manual-only를 확인했다.
컴포넌트와 공급자·실기 검증 한계는 유지한다.
[배포·복구 근거](design/screensaver-integration-2026-10-16.md#follow-up-release-and-recovery).

App 8.11.0/v696 화면 보호기는 PR [#360](https://github.com/hiefny/MUSIXQUARE/pull/360),
exact-main `49347201`의 [CI 38829164350](https://github.com/hiefny/MUSIXQUARE/actions/runs/38829164350),
[Release 38829782253](https://github.com/hiefny/MUSIXQUARE/actions/runs/38829782253)의
운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker와 공개 자산의
candidate 해시 일치로 초기 배포 준비 항목을 닫았다. 운영 자산의 격리된 같은 출처
컴포넌트 7 checks·160/320/1280/1920px 시각 확인과 Drift 31 pass / 0 fail / 5 manual-only를
확인했다. 실제 방·live 날씨·실기 검증을 뜻하지 않으며 후속 제어·전환·전체 화면 조정의 배포 근거는 별도로 기록했다.
[배포·복구 근거](design/screensaver-integration-2026-10-16.md#release-and-recovery).

App 8.10.27/v693의 데스크톱 동기화·미디어 버튼 너비 수정(오너 결정 2026-10-16)은
PR [#358](https://github.com/hiefny/MUSIXQUARE/pull/358), exact-main `0d08447c`의
[CI 38814552948](https://github.com/hiefny/MUSIXQUARE/actions/runs/38814552948),
[Release 38815146392](https://github.com/hiefny/MUSIXQUARE/actions/runs/38815146392)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v693·운영 Standard 방의 1280/1360/1440px 버튼 160×56px 실측으로 배포 준비
항목을 닫았다. 1280px 운영 캡처를 시각 확인했으며 실기기·운영 공유 캡처 검증을
대신하지 않는다.
[수정·검증·배포·복구](design/desktop-action-width-2026-10-16.md#release-and-recovery).

App 8.10.26/v692의 PRO 첫 미디어 안내(오너 결정 2026-10-16)는 PR
[#356](https://github.com/hiefny/MUSIXQUARE/pull/356), exact-main `476e42b1`의
[CI 38805172538](https://github.com/hiefny/MUSIXQUARE/actions/runs/38805172538),
[Release 38806931867](https://github.com/hiefny/MUSIXQUARE/actions/runs/38806931867)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v692·공개 번들의 PRO 본문 키를 확인해 배포 준비 항목을 닫았다.
[수정·검증·배포·복구](design/keep-open-pro-2026-10-16.md#release-and-recovery).

App 8.10.25/v691의 방장 기기 상태 안내(오너 결정 2026-10-16)는 PR
[#354](https://github.com/hiefny/MUSIXQUARE/pull/354), exact-main `45850f44`의
[CI 38797375114](https://github.com/hiefny/MUSIXQUARE/actions/runs/38797375114),
[Release 38799143891](https://github.com/hiefny/MUSIXQUARE/actions/runs/38799143891)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v691·공개 청크의 새 코드를 확인해 배포 준비 항목을 닫았다. 선행
[Release 38798391865](https://github.com/hiefny/MUSIXQUARE/actions/runs/38798391865)는 Standard HTTPS signaling smoke의 일시적
503으로 이전 App version에 자동 복구됐다. 실기기 확인은 §2 실기기 항목에 남는다.
[수정·검증·배포·복구](design/host-presence-keep-open-2026-10-16.md#release-and-recovery).

App 8.10.24/v690의 사용하지 않는 토스트 키 정리(오너 결정 2026-10-15)는 PR
[#352](https://github.com/hiefny/MUSIXQUARE/pull/352), exact-main `31c3b19c`의
[CI 38726918203](https://github.com/hiefny/MUSIXQUARE/actions/runs/38726918203),
[Release 38727700806](https://github.com/hiefny/MUSIXQUARE/actions/runs/38727700806)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v690·영어 번들에서 지운 키가 사라진 것을 확인해 배포 준비 항목을 닫았다.
[수정·검증·배포·복구](design/unused-toast-keys-2026-10-15.md#release-and-recovery).

App 8.10.23/v689의 토스트 전체 표시·장황한 번역 다듬기(오너 결정 2026-10-15)는 PR
[#350](https://github.com/hiefny/MUSIXQUARE/pull/350), exact-main `5903ed41`의
[CI 38715121084](https://github.com/hiefny/MUSIXQUARE/actions/runs/38715121084),
[Release 38715714880](https://github.com/hiefny/MUSIXQUARE/actions/runs/38715714880)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v689·운영 토스트 함수의 전체 표시와 표시 시간 확인으로 배포 준비 항목을 닫았다.
실기 확인은 하지 않았다.
[수정·검증·배포·복구](design/toast-line-length-2026-10-15.md#release-and-recovery).

App 8.10.22/v688의 토스트 마침표 정책(오너 결정 2026-10-15)은 PR
[#348](https://github.com/hiefny/MUSIXQUARE/pull/348), exact-main `2e05b070`의
[CI 38701042285](https://github.com/hiefny/MUSIXQUARE/actions/runs/38701042285),
[Release 38701766660](https://github.com/hiefny/MUSIXQUARE/actions/runs/38701766660)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v688·번들 문구·토스트 렌더링 확인으로 배포 준비 항목을 닫았다. 운영에서 실제 사용
흐름으로 토스트를 띄우지는 않았고 실기 확인도 하지 않았다.
[수정·검증·배포·복구](design/toast-punctuation-policy-2026-10-15.md#release-and-recovery).

App 8.10.21/v687의 업데이트 안내 줄바꿈(오너 결정 2026-10-15)은 PR
[#346](https://github.com/hiefny/MUSIXQUARE/pull/346), exact-main `a1d52c99`의
[CI 38692452260](https://github.com/hiefny/MUSIXQUARE/actions/runs/38692452260),
[Release 38693244484](https://github.com/hiefny/MUSIXQUARE/actions/runs/38693244484)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v687·영어 번들 문구 확인으로 배포 준비 항목을 닫았다. 실기 렌더링은 확인하지
않았다.
[수정·검증·배포·복구](design/update-notice-line-breaks-2026-10-15.md#release-and-recovery).

App 8.10.20/v686의 PRO 재생목록 순서 변경 깜빡임 수정(오너 제보 2026-10-14)은 PR
[#344](https://github.com/hiefny/MUSIXQUARE/pull/344), exact-main `27dceedc`의
[CI 38593021162](https://github.com/hiefny/MUSIXQUARE/actions/runs/38593021162),
[Release 38593965412](https://github.com/hiefny/MUSIXQUARE/actions/runs/38593965412)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v686 확인으로 배포 준비 항목을 닫았다. 운영 PRO 방에서 순서 변경을 재현한 것은
아니며 실기 확인은 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/pro-playlist-reorder-optimistic-2026-10-14.md#release-and-recovery).

App 8.10.19/v685의 무음 기기 재생 버튼 수정(오너 결정 2026-10-14)은 PR
[#342](https://github.com/hiefny/MUSIXQUARE/pull/342), exact-main `6afd9187`의
[CI 38579109391](https://github.com/hiefny/MUSIXQUARE/actions/runs/38579109391),
[Release 38580171440](https://github.com/hiefny/MUSIXQUARE/actions/runs/38580171440)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v685 확인으로 배포 준비 항목을 닫았다. 재생 중인 방에서 무음 기기 버튼과 로딩
스피너를 운영에서 재현한 것은 아니며 실기 확인은 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/pro-silent-endpoint-transport-2026-10-14.md#release-and-recovery).

App 8.10.18/v684의 YouTube 재합류 동기화는 PR
[#339](https://github.com/hiefny/MUSIXQUARE/pull/339), exact-main `cb81a89c`의
[CI 38565478458](https://github.com/hiefny/MUSIXQUARE/actions/runs/38565478458),
[Release 38566206816](https://github.com/hiefny/MUSIXQUARE/actions/runs/38566206816)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v684 확인으로 배포 준비 항목을 닫았다. 배포 후 같은 방법의 운영 측정에서 PRO
중도참여·동기화·포그라운드 복귀가 release 순간 seek 없이 −62~−84ms로 시작했고
(배포 전 무음, −1062ms, −149·−343ms), 일반방 중도참여는 −5~−12ms였다(배포 전
−386·−877ms). 내장 Chromium 한 대의 측정이며 실기·실제 스피커 확인은 실기기
항목에 남긴다.
[측정·배포·복구](design/youtube-rejoin-sync-2026-10-14.md#release-and-recovery).

App 8.10.17/v683의 공유 모션 실패 후속과 간격 중복은 PR
[#337](https://github.com/hiefny/MUSIXQUARE/pull/337), exact-main `75fceac1`의
[CI 38549772729](https://github.com/hiefny/MUSIXQUARE/actions/runs/38549772729),
[Release 38550430599](https://github.com/hiefny/MUSIXQUARE/actions/runs/38550430599)의
운영 smoke 4종·App 100% 최종 소유권·미선택 5 Worker 호환성·coherent marker,
공개 v683/CSS 및 기존 홈 탭의 정상 업데이트 적용 확인으로 닫았다. Standard/PRO의
factory·update 예외 단위 회귀와 실제 앱의 합성 캡처 Chromium 검사를 포함한다.
운영 PRO SFU·실제 OS picker·모든 PWA를 검증한 것은 아니다.
[수정·검증·복구 근거](design/sharing-action-fallback-2026-10-14.md#release-and-recovery).

2026-10-14 오너가 8.10.16/v682 적용 후 iOS 17.6.1 설치 PWA의 기존 화면 밀림이
사라졌고, 추가 확인한 목록 스크롤·볼륨 드래그·재생목록 재정렬도 정상이라고
직접 보고하여 해당 실기 확인 항목을 닫았다. 자동화 결과로 대체한 판정이 아니며
다른 OS·모든 권한 조합·열려 있던 모든 PWA의 갱신까지 검증한 것은 아니다.
[실기 보고·범위](design/shared-touch-policy-2026-10-14.md#owner-verification--2026-10-14).

App 8.10.15/v681의 입장 대기·장황 버튼 라벨 축약은 PR [#330](https://github.com/hiefny/MUSIXQUARE/pull/330),
exact-main `19f1d27b`의 [CI 38518466482](https://github.com/hiefny/MUSIXQUARE/actions/runs/38518466482),
[Release 38518475226](https://github.com/hiefny/MUSIXQUARE/actions/runs/38518475226)의 운영 smoke 4종·App 100%
최종 소유권·미선택 5 Worker 호환성·coherent marker 및 공개 v681 확인으로 배포를 기록했다.
열린 항목을 닫는 변경은 아니며 원어민 검수·실기 화면 확인은 하지 않았다.
[범위·검증·배포·복구](design/short-wait-labels-2026-10-14.md#release-and-recovery).

App 8.10.14/v680의 공유 송신자 버튼 준비는 PR
[#331](https://github.com/hiefny/MUSIXQUARE/pull/331), exact-main
`75842130`의 [CI 38515483411](https://github.com/hiefny/MUSIXQUARE/actions/runs/38515483411),
[Release 38517124902](https://github.com/hiefny/MUSIXQUARE/actions/runs/38517124902)의 운영 smoke
4종·App 100% 최종 소유권·미선택 5 Worker 호환성·coherent marker 및 공개 v680
확인으로 닫았다. 실제 OS picker·실음향·Safari 실기·운영 PRO SFU를 검증했다는
뜻은 아니다. [수정·검증·배포·복구](design/system-audio-sharing-actions-2026-10-14.md#release-and-recovery).

8.10.12의 초기 전송 예산 잔여 66 B 항목은 초기 로딩 정책의 측정 검토와
8.10.14 정식 배포로 닫았다. legacy layer 변환은 공통 CSS를 함께 처리해야 하므로
CSS 분할 실험은 채택하지 않았고, 컨트롤러만 방 진입에 맞춰 지연 로드한다.
aggregate 상한 3종에 5% 유지 공간을 추가하되 보호 여유 5%·entry 상한·eager font
0은 유지했다. eager gzip 544,507 B는 새 유지 상한 570,570 B보다 26,063 B 작다.
동일 조건 5쌍의 cold-start 표본에서 회귀 근거는 없었으나 통계적 동등성 또는
남은 예산의 자유로운 소진을 보장하지 않는다.
[용량 결정](design/initial-bundle-loading-policy.md#2026-10-14-sender-actions-and-aggregate-maintenance-capacity),
[실측·검증 근거](design/system-audio-sharing-actions-2026-10-14.md).

App·Worker 8.10.12/v678의 점검 안내 번역 후속과 숨은 YouTube 패널 접근성 항목은 PR
[#328](https://github.com/hiefny/MUSIXQUARE/pull/328), exact-main `d9364cd9`의
[CI 38508327514](https://github.com/hiefny/MUSIXQUARE/actions/runs/38508327514),
[Release 38508866905](https://github.com/hiefny/MUSIXQUARE/actions/runs/38508866905)의 운영 smoke·최종 소유권
6종·coherent marker 및 공개 v678 갱신 확인으로 닫았다. 새 프로토콜·데이터 마이그레이션은
없다. [수정·검증·배포·복구](design/maintenance-copy-and-a11y-release-2026-10-14.md#release-and-recovery).

2026-10-14 오너 결정으로 열린 항목을 정리했다. 결정이 끝난 동작·전환기 한계·조건부
감시·문체 결정은 [허용한 위험 #14~#17](known-accepted.md#14-standard-room-youtube-zero-start-sync-readiness-gap)로,
재현 계획이 없는 관찰 6건은 [종료한 관찰](known-accepted.md#retired-observations)로
옮겼다. Drift Audit 수동 5항목과 일반방 방장 암호 감시는 §3 정기 수동 점검으로
바꿨다. 외부 보안 업체 점검으로 이미 해결된 보안 재실행 항목은 삭제했고, 그 접근
프로그램 이름은 재점검 작업을 막는 장벽이 되어 문서 전체에서 제거했다.

App 8.10.10/v673 배포 대기는 PR [#323](https://github.com/hiefny/MUSIXQUARE/pull/323),
exact-main `414ce19d`의 [CI 38444452325](https://github.com/hiefny/MUSIXQUARE/actions/runs/38444452325),
[Release 38445343194](https://github.com/hiefny/MUSIXQUARE/actions/runs/38445343194)의
운영 smoke 4종·최종 소유권·coherent marker 및 공개 v673 갱신 확인으로 닫았다.
일반방의 완결 목록 확보·부분 캐시 복구와 PRO 재입장 manifest 보존, 관리자 iframe
재개·직접 탐색·프로그램 seek 소유권을 수정했다. 새 프로토콜·데이터 마이그레이션은
없다. 실제 자연 반복 원인과 공급자·실기 한계는 위 열린 항목에 유지한다.
[수정·검증·배포·복구](design/youtube-playlist-native-control-repair-2026-10-14.md).

App 8.10.9/v671 준비는 PR #321, exact-main `16c6b219`의 CI 38425972188 및
Release 38427573214의 운영 smoke 4종·최종 소유권·coherent marker 확인으로
닫았다. 선행 Release 38426762796의 오래된 status 응답·자동 rollback과 독립
복구도 같은 보고서와 릴리스 이력에 보존한다. 조회의 세부 원인은 미정이고
소유권 안전 검사는 유지했다. 최초 로컬 seed 470021 실패와 실기기 확인은
해결한 것으로 처리하지 않는다.
[구현·검증·실패·배포·복구](design/component-cascade-refactor-2026-10-13.md).

YouTube 최초 focus 검사와 후반 Tab 실패 항목은 PR #319, exact-main `dc69bda0`의
CI 38364448487 및 Release 38365146388 성공으로 닫았다. 진입 검사는 준비 상태와
실제 Tab 이동을 확인하도록 바꿨고, 자연 실패 세 건의 timer-fire·focus stack·키
이벤트로 확인한 100ms 초기 focus 경합은 `594fbc5d`에서 수정했다. 타이머 경계의
단위 RED→GREEN, 로컬·원격 전체 Chromium 627 pass와 WebKit 결과를 확보했다.
두 OS 반복 60회는 모두 100ms 전 닫힌 정상 흐름 검증이라는 한계를 유지한다.
[원인·수정·검증·배포 근거](design/youtube-popup-focus-repair-2026-10-13.md).

8.10.7 YouTube 입력 안내 배포 준비는 PR #316, exact-main `6b159667`의 CI
38336374232와 Release 38336912131 성공으로 닫았다. 42개 언어의 URL 힌트·아래
링크/검색어 안내·입력 삭제 뒤 복원을 수정하고 공개 6언어 응답을 확인했다.
변경 전 Full E2E에서 발견한 최초 키보드 focus 실패는 위 8.10.8 근거로 후속 해결했다.
[검증·배포·복구 근거](design/youtube-input-guidance-2026-10-13.md).

8.10.6 App-only 후속 수정은 PR #314, exact-main `f0ea308b`의 CI 38319346829와
Release 38319913652 성공으로 닫았다. `/clear` 서비스 공지 유실, 닫기 영역 겹침,
자동 갱신 초안 유실, legacy 입력 정규화 불일치를 재현·수정하고 실행 JS의
App/cache 식별도 레코더에 추가했다. 관리자 초안은 자동 갱신에서 보존되지만 null
revision 저장은 계속 차단하고, 수동 Refresh는 확인 후 폐기·서버 원본 재조회한다.
기존 "첫 조회 실패 후 초안 유실 해결" 기록은 이 경계까지 보장한 것이 아니었다.
신규 의존성·스키마·바인딩·비밀 없음. 실기기 확인은 아래에 유지한다.
[후속 수정·검증·복구 범위](design/announcement-review-followup-2026-10-13.md).

PRO 정원 판정의 TTL 경계, 취소된 최초 요청에 묶인 공유 registry 조회 수명,
휴면 세션·계정 detach에 따른 Peer 101 이상 생성과 클라이언트 응답 거부의 세
확정 결함은 PR [#311](https://github.com/hiefny/MUSIXQUARE/pull/311)의 재현·회귀,
exact-main `08df0606` CI와 6종 Worker의 Release 38313333407 성공으로 닫았다.
공통 점검·공지 조회의 실제 context 전달과 늦은 응답·만료 TTL 경계도 함께 수정했다.
정원 100·presence TTL 45초·권한·엄격한 클라이언트 계약은 유지한다.
[수정·검증·배포·복구 근거](design/pro-admission-repair-2026-10-13.md).
행사 원인의 확정과 진단 로그의 한계는 아래에 남긴다.

공지의 네 배포 대기 항목은 PR #309의 재현·회귀, exact-main CI, App·PRO를 포함한
Release 38293505122 성공으로 닫았다. 관리자 초기 초안의 미관측 revision 채택과
첫 조회 실패 후 초안 유실도 리뷰에서 재현·수정했다.
[해결 근거](design/announcement-repair-2026-10-13.md#프로덕션-배포--2026-10-13).
PRO 방장 공지의 중도 참여 복원은 별도 정책이며 이번 서비스 공지 수정에 포함하지 않았다.

### 실기기 확인

사용자의 실제 기기가 필요하다. 브라우저 자동화 결과로 대신하지 않는다.

- [ ] 일반방 전송 통합(8.11.23 이후): 폰 두 대(Android·iPhone)와 PC로 로컬 파일 재생 중 다음 곡
      프리로드, YouTube 재생 중 프리로드, 프리로드 중 일시정지 반응, 같은 주소의 짧은 와이파이
      끊김(회복해야 정상)을 확인하고, 보조 연결이 하나 더 생기는 데 따른 배터리·발열도 본다.
      데스크톱 Chromium native 라운드만 있다.
      [남은 실기 확인](design/transport-release-bundle-2026-10-19.md#남은-실기-확인)
- [ ] 8.11.25 미리받기 재개: 호스트 노트북은 와이파이에 두고, 폰이 다음 곡을 미리받는 중(다음 곡
      준비 로더가 보일 때)에 와이파이를 몇 초 껐다 켜거나 LTE로 바꾼다. 8.11.23에서는 미리받기가
      취소된 뒤 다시 시작하지 않았다(오너 확인 2026-10-19). 8.11.25에서 연결이 돌아오면 미리받기가
      이어서 끝나고, 다음 곡으로 넘어갈 때 다시 받지 않고 바로 재생되면 닫는다. `?mxqrLog=info`로
      연 호스트의 `/debug console`에 끊긴 동안 `Paused preload`, 복구 뒤 `Resuming preload`가 보인다.
      C5-0 랩은 2026-10-24 main(`fa256db2` 런타임, #478 `b4293768`)에서 같은 재개를 재현했다(그
      게스트 PeerID로 Paused·Resuming 한 번씩,
      ABORT 없음, 정확한 SHA-256). 실기 근거는 아직 없고, 이 항목이 열린 채 4A를 배포했다(위 Phase 4
      게이트 편차). 오너 결정(2026-10-25 약 01:50 KST)으로 4B와 그 뒤 C5-6·C5-7·C5-8 열차도 이
      항목이 열린 채 나간다. 4B의 C5-12 뒤로는 복구 뒤 방장이 그 게스트를 local로 다시 판정해 알린
      다음 본 레인이 같은 트랙을 가져가면 재개한 미리받기가 멈추고 방장에 `Yielding preload for` 줄이
      하나 더 남는다(`Paused`·`Resuming` 줄은 바이트가 같고 그대로 남는다). 구버전 제거 열차 2 릴리스
      A(배포 전)의 C5-12 Inc 3 뒤로는 방장이 경로 재판정을 기다리지 않는다. 본 레인이 같은 트랙을
      가져가면 재개한 미리받기가 멈추고, 복구 때 본 레인이 이미 그 짝을 잡고 있으면 미리받기를 다시
      시작하지 않아 `Resuming` 없이 `Paused`·`Yielding`만 남는다(세 줄의 바이트는 같다). 4C의 C5-8(9.0.10 / v783, 2026-10-25 14:41 KST 배포)
      뒤로는 방장의 원래 경로가 ICE 재시작 중 `connecting`으로 읽히는 동안에도 미리받기가 멈춘 채
      있고, `Resuming` 줄은 그 경로의 `connected`(연결 생존 주인의 `ice-recovered`) 뒤에 나온다.
      그 전의 선택 쌍 변경 보고로는 재개하지 않는다(줄 바이트는 같다).
      [native 근거](design/preload-resume-after-ice-recovery-2026-10-20.md),
      [4A 보고서](design/phase4-4a-transport-rejoin-2026-10-24.md),
      [4B 보고서의 C5-12](design/phase4-4b-behaviour-2026-10-25.md#c5-12-ice-복구-뒤-튜플-하나에-스트림-하나-동작-p4-d10-a),
      [4C 보고서](design/phase4-4c-link-liveness-2026-10-25.md),
      [구버전 제거 열차 2 보고서의 A-1](design/old-version-removal-2a-app-2026-10-26.md#a-1-c5-12-inc-3-ov-f02)
- [ ] 8.11.25 공유 중지 버튼 정렬: 시스템 오디오 공유를 켤 수 있는 기기(PC 브라우저·데스크톱 앱)에서
      공유를 켜고, "공유 중지" 버튼의 정지 사각형과 글자가 버튼 가운데에 보이는지(오른쪽 치우침 없음),
      사각형 크기와 글자 간격이 전과 같은지 다크·라이트에서 본다. 헤드리스 Chromium 측정과 브라우저
      테스트만 있다. [근거](design/stop-sharing-centering-2026-10-20.md)
- [ ] 8.11.18/v720 시작 화면 버튼 전환: iPhone Safari·홈 화면 PWA, Android Chrome, Windows·macOS
      데스크톱에서 첫 화면 → 방 만들기·방 참여하기와 뒤로 가기 때 가운데 덩어리가 튀지 않고 제자리에서
      크로스페이드되는지, 버튼도 함께 서서히 바뀌는지, 방 참여하기의 시작하기 버튼이 전과 같이 동작하는지
      확인한다. 헤드리스 Chromium 프레임 캡처와 단위·브라우저 테스트만 있다.
      [범위·한계](design/setup-actions-transition-2026-10-18.md#verification)
- [ ] 8.11.17/v719 시작 화면 캐러셀 간격: iPhone Safari·홈 화면 PWA, Android Chrome(세로·가로),
      태블릿, Windows·macOS 데스크톱에서 첫 화면 캐러셀의 아이콘 원→제목, 제목→본문, 본문→점 간격이
      휴대폰 28·20·36px과 같은 비율로 보이는지, 다크 테마의 아이콘 원이 라이트처럼 은은한지,
      슬라이드를 넘겨도 점 위치가 흔들리지 않는지, 첫 화면 가운데 덩어리가 계속 머리글과 버튼 사이
      가운데에 오는지 확인한다. 헤드리스 Chromium 측정과 브라우저 테스트만 있다.
      [범위·한계](design/setup-carousel-spacing-2026-10-18.md#verification)
- [ ] 8.11.15–8.11.16(v717–v718) 휴대폰 세로 시작 화면 가운데 정렬: iPhone Safari·홈 화면 PWA와
      Android Chrome에서 첫 화면, 방 만들기, 방 참여하기의 가운데 덩어리가 보기에 머리글과 버튼 사이
      가운데에 오는지(8.11.16부터 QR 여백·스캔 버튼 안쪽·글자 행간까지 맞춤), 머리글 위와 버튼 아래
      여백이 전과 같은지, 작은 화면에서 전처럼 스크롤되는지, 방 참여하기에서 키보드를 열고 닫을 때
      코드 입력칸이 가려지지 않는지 확인한다. 헤드리스 Chromium 측정과 브라우저 테스트만 있다.
      [범위·한계](design/setup-mobile-centering-2026-10-18.md#verification),
      [보이는 기준 보정](design/setup-mobile-visible-centering-2026-10-18.md#verification)
- [ ] 8.11.13/v714 방 만들기 QR: iPhone Safari·홈 화면 PWA, Android Chrome, Windows·macOS
      데스크톱 브라우저에서 앱을 처음 열고 방 만들기를 누를 때 캐러셀 자리가 검게 비지 않고
      흐린 QR로 바로 넘어가는지, 코드가 뜰 때 진짜 QR이 한 번만 부드럽게 나타나는지, 데스크톱에서
      가운데 스피너가 처음부터 다시 돌지 않는지, 방 참여하기도 검게 비지 않는지 확인한다. 코드가
      0.3초 안에 오면 첫 전환이 끊기는 점프는 남아 있다. 헤드리스 Chromium 프레임 확인과
      단위·브라우저 테스트만 있다.
      [범위·한계](design/setup-qr-reveal-2026-10-17.md#verification)
- [ ] 8.11.11 업데이트 대화상자(기기가 `v711` 코드를 실행한 뒤 다음 업데이트가 와야 볼 수 있다):
      iPhone Safari 탭, iPhone 홈 화면 PWA, Android Chrome(탭과 설치 앱), Windows·macOS
      데스크톱에서 첫 화면, 만들기·참여 화면, 초대 링크의 시작 화면, 일반방 방장·참여자, PRO 방,
      데모 중에 같은 "업데이트" 대화상자가 뜨는지, 문구가 방 밖은 "적용하면 페이지를
      새로고침해요", 일반방 방장은 "방을 다시 열어야 해요", 그 밖의 방 참여자는 "방에 다시
      입장해야 해요"인지 확인한다. "나중에" 뒤 같은 페이지에서는 다시 뜨지 않고 다시 열면 다시
      뜨는지, 참여자가 "적용하기"를 누르면 그 방의 시작 화면으로 돌아가 "시작하기"로 다시
      들어가는지, 다른 탭이 적용하면 방에 있는 탭은 새로고침되지 않고 대화상자를 한 번 띄우는지,
      PRO 방에서 휴대폰을 45초 넘게 잠갔다가 깨워도 새로고침되지 않는지, 채팅·토스트 업데이트
      안내가 더는 뜨지 않는지도 본다. iPhone 홈 화면 앱이 다시 열 때 이전 화면을 이어 쓰면
      다음 실제 실행까지 이전 코드가 남을 수 있다. 단위 테스트와 로컬 데스크톱 Chromium 확인만
      있다.
      [범위·한계](design/update-dialog-everywhere-2026-10-17.md#verification)
- [ ] 8.11.12/v712 R 뒤로가기(8.11.9 창 정책 후속): Android Chrome·설치 앱의 뒤로 버튼·제스처와 iPhone Safari/PWA 뒤로
      스와이프에서 방 밖(언어 선택)과 방 안(미디어 선택, YouTube 링크, 데모, 화면 보호기,
      채팅 시트, 확인창)의 맨 위 창만 닫히는지, 창이 없을 때만 "세션 나가기"가 뜨거나 이전
      페이지로 가는지, "오디오가 잠시 멈췄어요"는 뒤로가기로 닫히지 않는지 확인한다.
      2026-10-17 오너의 별도 iPhone 진단에서 즉시 재등록 I는 약 3초 지연,
      R은 단계별 Back 정상으로 확인되어 공통 R 적용·배포를 승인했고 PR #383과
      Release 39009031876으로 배포했다. 이 진단과 데스크톱 검사는 제품 실기 확인을
      대신하지 않는다. 제품의 초기 입장·닫기 완료 후
      재등록·연속 Back·실제 이전 문서 퇴장은 별도 검증한다.
      [R 구현·검증·한계](design/ios-back-deferred-guard-2026-10-17.md),
      [기존 창 정책](design/back-closes-top-window-2026-10-17.md#verification)
- [ ] 8.11.7 백그라운드 복귀 대화상자: iPhone Safari/PWA와 Android에서 방(로컬 파일
      재생 중)을 1분 넘게 백그라운드에 두었다가 돌아오면 대화상자가 하나만 뜨는지,
      경고를 닫지 않은 채 다시 1분 넘게 나갔다 오면 경고가 다시 뜨지 않는지, 소리가
      복구되지 않을 때는 "오디오가 잠시 멈췄어요" 하나만 뜨고 "오디오 다시 켜기"로
      소리가 돌아오는지 확인한다. 단위 테스트만 있다.
      [범위·한계](design/resume-dialog-dedup-2026-10-17.md)
- [ ] 8.11.4 화면 보호기: 실제 iPhone Safari/PWA에서 글로우·디렉셔널 블러·숫자
      전환과 가로·세로 회전, 진입·종료·전체화면 복원, 재생 유지·장시간 메모리 추세를
      확인한다. Windows WebKit 7개 외형 비교와 합성 lifecycle 검사는 실기 검증이 아니다.
      [범위·한계](design/screensaver-image-backgrounds-2026-10-16.md#verification)

- [ ] 8.10.4 공지: 새 클라이언트가 적용된 운영 일반방·PRO에서 게시 후 철회와 5분/
      foreground 반영, 실제 iPhone Safari/PWA·VoiceOver 및 Android/TalkBack의 전체보기/
      짧은 화면 스크롤·닫기. 이번에는 운영 공지를 재게시하지 않았고 기존 설치 PWA는
      새로고침 전 구 코드가 남을 수 있다. [증거·한계](design/announcement-repair-2026-10-13.md)
      8.10.6 적용 후 호스트 `/clear`에도 서비스 공지가 남는지 함께 확인한다.
      [후속 회귀·실기기 한계](design/announcement-review-followup-2026-10-13.md)

- [ ] 8.7.9 헤더 크로스페이드: iPhone Safari/PWA에서 로딩 시작·종료, 시크 직후
      탭 왕복. [상세](design/header-crossfade-2026-10-09.md)
- [ ] 8.10.25 방장 기기 상태 안내: 일반 방 방장을 iPhone Safari/PWA·Android에서
      백그라운드로 보내거나 화면을 잠갔을 때 게스트 로더가 뜨고 복귀하면 풀리는지,
      관리자 재생이 거절 토스트로 끝나는지, 좁은 화면에서 계정 필 앞 말줄임.
      브라우저에서 숨김·정지를 흉내 낸 결과만 있다.
      [범위·한계](design/host-presence-keep-open-2026-10-16.md)
- [ ] 8.8.0: 실제 고객방의 소유권·암호 지정·변경·해제, 기존 열린 탭·설치 PWA의
      새 코드 적용. [상세](design/pro-optional-entry-password-2026-10-10.md)
- [ ] 혼합 방(iPhone Safari/PWA + Android + Windows): 작은 곡 → 큰 MP3/FLAC/AAC
      → 작은 곡, host와 guest가 서로 다른 엔진을 쓰는 경우.
- [ ] 장시간 세션: 시작, 빠른 시크, 이전/다음, 곡 끝 반복, 중간 참가, 프리로드
      재정렬, 큰 수동 싱크, 네트워크 끊김·재참가, 잠금·복귀, 메모리 추세.
- [ ] 시크 직후 약 2.3초 native PCM 차이(자동 회복). PLAY 수신 시 clock·anchor,
      실제 오디오 시작, 회복 시간을 기록한다. 브라우저의 2.5초 수렴 허용치는 귀로
      듣는 정렬 기준이 아니다. [상세](design/beta-final-qa-2026-10-04.md)
- [ ] YouTube 첫 음 정렬(S01–S02, XS01–XS04): 일반·PRO, host·guest, 양·음 offset,
      다음 곡·반복·중간 참가·취소, 실제 YouTube, iPhone Safari/PWA, Bluetooth.
      [S01–S02](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27),
      [XS01–XS04](design/extreme-manual-sync-repair-2026-09-27.md)
- [ ] YouTube 재합류 동기화(8.10.18 배포 뒤): iPhone Safari/PWA와 Android에서 PRO
      동기화 버튼·중도참여·잠금 복귀가 release 순간 seek 없이 시작하는지
      (`/debug sync`의 youtube-release·youtube-sample), 한 번도 재생하지 않은
      iPhone에 TAP TO PLAY가 뜨고 탭 뒤 준비되는지, 일반방 자동 재랑데부가 과하게
      반복되지 않는지와 실제 스피커의 가청 싱크를 확인한다.
      [상세](design/youtube-rejoin-sync-2026-10-14.md)
      8.10.19 배포 뒤에는 복원·재합류 중 재생 버튼 스피너와, 소리가 안 나는 기기의
      재생 버튼이 방을 멈추지 않고 그 기기만 다시 붙이는지도 함께 본다.
      [버튼 수정](design/pro-silent-endpoint-transport-2026-10-14.md)
- [ ] PRO 재생목록 순서 변경(8.10.20 배포 뒤): iPhone·Android 터치와 데스크톱
      마우스로 곡을 옮겼을 때 이전 순서로 깜빡이지 않고 새 순서가 유지되는지, 다른
      기기에도 같은 순서로 보이는지 확인한다.
      [상세](design/pro-playlist-reorder-optimistic-2026-10-14.md)
- [ ] D01 PRO 공유 중 참가: 실제 SFU와 실기.
- [ ] 계정: 기존 로그인 유지, 다른 탭의 새 로그인과 늦게 도착한 로그아웃·탈퇴
      응답, 익명·로그인 입장, 계정 API. 실제 Google OAuth와 운영 HTTPS 쿠키로 확인한다.
- [ ] 리버브 10초 경계(일반방, PRO, API)와 데모 종료 뒤 표시되는 설정이 실제
      효과와 같은지.
- [ ] 물리 키보드, 미디어 키, 실제 음향 출력(QA055 음향 테스트 포함).
- [ ] PRO 암호 참여자 선택·퇴장 사유(8.9.0, 두 단계 대화상자는 8.9.4로 배포):
      iPhone Safari/PWA와 Android에서 암호 지정·변경의 두 단계(암호 입력 뒤 "다음",
      "현재 참여자를 어떻게 할까요?"의 "그대로 두기"(기본)·"모두 재입장", "이전"으로
      돌아가도 입력한 암호 유지, 두 번 탭해도 바로 확인되지 않음), 소프트 키보드가
      열린 1단계와 가로 모드 2단계에서 버튼이 보이는지, "다음"을 눌러도 제목이 제자리에
      있는지, VoiceOver·TalkBack으로 행을 터치하면 행 전체가 선택 대상으로 잡히고
      라벨·설명을 한 번씩 읽는지, 강퇴·기기 연결 끊기·암호 변경 안내 문구, 안내 뒤 홈
      이동과 같은 탭에서 다시 열었을 때의 일반 입장, 320·360·390px과 가로 모드(중국어
      줄바꿈 포함), RTL 배치를 확인한다.
      [상세](design/pro-pin-member-choice-2026-10-11.md),
      [두 단계](design/pro-pin-two-step-2026-10-11.md)
- [ ] 일반방 방장 암호와 공통 암호 흐름(8.10.0 배포 뒤): iPhone Safari/PWA, Android,
      Windows에서 두 방 종류 모두 1단계 버튼이 혼자일 때 "확인", 다른 기기가 있을 때
      "다음"인지, 2단계 "그대로 두기"(기본)·"모두 재입장", 일반방 암호가 빈 칸에서
      시작하고 "••••-••••"와 연필 버튼으로만 보이는지, VoiceOver·TalkBack이 점 대신
      "암호 적용됨"을 읽는지 확인한다. "그대로 두기"로 남은 참여자가 백그라운드 전환,
      네트워크 변경, 시그널링 재연결 뒤 새 암호 없이 ICE 재시작으로 회복되는지,
      "모두 재입장" 뒤 참여자에게 "방장이 방 암호를 …" 안내가 한 번 뜨고 같은 방의 암호
      입력 화면으로 가는지, 아직 갱신되지 않은 이전 App 참여자가 "강제퇴장" 문구를 보는지,
      오답 20회 뒤 기다릴 시간이 분 단위로 보이는지, 강제 색상 모드(Windows 고대비 밝은·어두운
      테마)에서 언어 목록과 선택된 행의 글자, 선택된 탭 아이콘, 켜진 암호 스위치가 보이고
      초대 QR이 휴대폰 카메라로 스캔되는지, 320·360·390px, 가로 모드, RTL 배치를 함께 본다.
      [상세](design/standard-room-owner-pin-2026-10-11.md)

### 운영·보안

- [ ] PRO 공개방 입장 보호(8.9.0 배포 뒤): 실제 공개방에서
      일반 입장·재입장·탭 닫기 후 복귀가 `RATE_LIMITED`나 `ROOM_FULL` 없이 되는지,
      PRO Worker 로그에서 두 응답이 평소보다 늘지 않는지 확인한다. 입장 throttle
      카운터는 Durable Object 메모리에만 있어 운영에서 직접 볼 수 없고, 주소별 키
      파생(IPv4, IPv6 /64)은 front door 단위 테스트로만 검증했다.
      [상세](design/pro-room-admission-protection-2026-10-11.md)
- [ ] Standard HTTPS signaling 브리지 열기의 일시 5xx: 2026-10-16 8.10.25 배포에서 503 한 번, 2026-10-20 8.11.28
      배포에서 502 두 번(방장·게스트 열기) smoke가 실패했고, 자동 복구나 재시도 뒤 통과했다. 원인은 미확정이다.
      8.11.29(2026-10-20 15:38 KST 배포)부터 smoke 실패 줄에 역할·HTTP 상태·오류 코드·경과 ms·Ray ID가, App Worker
      로그에 `standard_signaling_bridge` 진단(operation·reason·브리지 객체 코드·시간)이 남는다. 통과한 smoke는 브리지
      열기 시간(`bridgeOpenMs`)을 남기며 첫 배포에서 방장 878ms·게스트 393ms였다. 다음 실패 때 둘을 Ray ID로 맞춰
      어느 Worker의 어떤 실패인지 좁힌다. 5초 제한과 smoke 재시도 변경은 오너가 정한다.
      [진단·읽는 법](design/standard-signaling-bridge-diagnostics-2026-10-20.md)

### 후속 작업과 유지 결정

- [ ] 구조 개선 배포 묶음(오너 결정 2026-10-23): Phase 1(서버, Worker만)은 단계마다 배포하고 앱 업데이트 창은
      없다. Phase 2~7의 앱 변경은 작은 단위로 main에 머지하되 앱 업데이트는 Phase마다 한 번(7일을 넘기지 않음)으로
      묶는다. Phase 3(SW 업데이트 경로)은 새 경로 확인용 배포가 한 번 더 필요하다. PRO·App Worker 소스를 함께 바꾸는
      변경은 부분 릴리스 게이트 때문에 target `all`로 낸다. 묶음마다 보고서 하나와 실기기 확인을 둔다.
      오너 결정(2026-10-24, P4-D3 A): Phase 4는 앱 업데이트 두 번이다. 4A(중립 재구성)와 4B(위험·동작 변경)다.
      오너 결정(2026-10-25 약 01:50 KST)이 시점 부분을 대신한다: 모든 열차는 자동 게이트(로컬 검사, 리뷰, PR CI,
      Codex, exact-main CI, 릴리스 smoke)가 통과하면 바로 내고, 7일 간격(4B의 '4A 배포 7일 뒤' 포함)과 기기
      라운드를 기다리지 않는다. 열차 보고서마다 기기로 확인하지 않은 것을 적는다. 같은 결정으로 C5-6·C5-7·
      C5-8이 4B 다음 자기 열차로 가서 Phase 4는 4C까지 앱 업데이트 세 번이 된다. 4C는 C5-6, C5-7, C5-8과
      C5-10의 연결 부분을 싣고 C5-9는 처음엔 Phase 4 밖이었다(RO-35). #18이 은퇴한 뒤 오너 결정(2026-10-25
      약 16:30 KST)으로 C5-9와 C5-10의 제어 격리 부분이 네 번째 앱 열차 4D로 가서(9.0.11 / v784, 2026-10-25
      21:30 KST 배포) Phase 4는 4D까지 앱 업데이트 네 번이 됐다(기기 확인이 실패하면 9.0.10의 보조 경로 동작으로
      forward revert, RO-35는 4D에서 지움). 오너 결정(2026-10-25, P5-D3 A): Phase 5도 앱 업데이트 두 번이다.
      5A(수신 슬롯 이동, 동작 그대로, 9.0.12 / v785로 2026-10-26 10:34 KST 배포됨)와 5B(오너가 고르는 동작
      변경, 각자 실패 테스트 먼저)다.
      [결정 근거](design/resource-ownership-registry.md#consolidation-phases),
      [게이트에 막힌 실행](design/server-constant-homes-2026-10-23.md#호환성),
      [4A 보고서](design/phase4-4a-transport-rejoin-2026-10-24.md#오너-결정-2026-10-24),
      [4B 보고서](design/phase4-4b-behaviour-2026-10-25.md#오너-결정-2026-10-25),
      [4C 보고서](design/phase4-4c-link-liveness-2026-10-25.md#오너-결정),
      [4D 보고서](design/phase4-4d-side-route-owner-2026-10-25.md#오너-결정),
      [5A 보고서](design/phase5-5a-receive-slot-2026-10-25.md#오너-결정).
- [ ] 8.11.32 배포 뒤 실기 확인(2026-10-21 03:41 KST 배포됨): iPhone에서 재생목록 길게 누르기가 글자를 선택하지
      않는지, 데스크톱 길게 클릭·끌기 가장자리 자동 스크롤, 백그라운드 복귀마다 Sync(일반방 YouTube 방장이 돌아올 때마다
      게스트가 최대 3초에 한 번 다시 맞춘다), 권한 확인 중 안내, 화면 보호기 두 번 탭 종료·저음 밝기를 실제 기기로 본다.
      초기 JS 예산 여유는 약 1.9 KB다.
      [묶음 보고서](design/playlist-and-platform-fixes-2026-10-20.md),
      [삭제 모드](design/playlist-delete-mode-undo-2026-10-20.md),
      [백그라운드 복귀](design/background-return-sync-2026-10-20.md),
      [화면 보호기](design/screensaver-clock-only-help-entry-2026-10-21.md),
      [화면 높이 레이아웃](design/desktop-height-layout-2026-10-21.md)
- [ ] 42개 로케일 번역 업데이트 배포 뒤 화면 확인(8.10.11/v675, 2026-10-14 11:55 KST 배포됨): 사전 값
      1,718건이 바뀌었고 PRO 활성화 7키가 40개 로케일에 새로 번역됐다. 2026-09-06
      감사 방식의 42언어×4폭 자동 레이아웃 재측정은 하지 않았다. 배포 뒤 실제
      기기에서 PRO 활성화 다이얼로그, 연결 탭 강제퇴장 다이얼로그, 설정 탭, About
      페이지를 긴 로케일(de·fi·hu·el·ta·ml)과 RTL(ar·he·fa·ur)로 훑어 넘침·잘림이
      없으면 닫는다.
      [적용 범위·오너 결정·검증·한계](design/i18n-quality-update-2026-10-14.md)
- [ ] 일반방 YouTube C11 현장 관측(8.10.2/v661 배포 뒤): 원래 deadline의
      미보정 callback 지연과 계획·예약·호출·측정 사이 시계 변경을 학습 입력에서
      제외하는 수정은 `72a6e780`, Release `38267400052`로 배포됐다. 기존 저장값은
      초기화하지 않는다. 실제 세션에서 flight recorder의 eligible 대비
      `clock-changed` 비율과 작업별 시계 선택값을 확인한다. UA/플랫폼 모두 Linux인
      기기를 터치만으로 Android로 추정하지 않으며 PRO 학습값 영속화도 보류한다.
      [수정·검증·한계](design/standard-start-learning-repair-2026-10-12.md),
      [수정 전 재현·판정](design/standard-start-review-2026-10-12.md),
      [배포 근거](design/sync-maintenance-release-preparation-2026-10-12.md)
- [ ] PRO 시작 시계 현장 확인(8.10.2/v661 배포 뒤): 작업별 시계 snapshot,
      playing COMMIT의 유효 시계 확보, 늦은 응답의 후보 보관, 조기 COMMIT 처리와
      C11 callback 지연 학습 분리는 `72a6e780`, Release `38267400052`로 배포됐다.
      자연 소켓 단절 중 이미 받은 COMMIT은 유지하고 명시적 퇴장·소켓 교체는 폐기한다.
      실제 현장 오차의 원인은 아직 미확정이다. 원시 시계·실제 선택값·YouTube 관측
      전용 표본을 현장에서 수집하고 재개 startup 지연은 독립 음향 측정과 함께 본다.
      [수정·검증·한계](design/pro-start-clock-safety-2026-10-12.md),
      [14개 후보 판정·재현·한계](design/pro-start-sync-candidate-validation-2026-10-12.md),
      [배포 근거](design/sync-maintenance-release-preparation-2026-10-12.md)
- [ ] Android YouTube 출력 정렬·혼합 버전 현장 확인(8.10.2/v661 배포 뒤):
      오너가 Android 태블릿 2대·Galaxy 5대·Xiaomi에서 확인한 음성 250ms 지연을
      기준으로 PRO·일반방 각 기기에 자신의 +250ms와 수동값을 합성하는 수정은
      `72a6e780`, Release `38267400052`로 배포됐다. 일반방 방장은 실제 적용한
      로컬 보정을 제외한 공통 시각을 송신한다. 실제 수정본의 음향 정렬은 실측 대상이다.
      UA와 UA-CH 모두 Linux로 숨기는 기기는 추측하지 않는다. capability v2는
      그대로여서 Android 방장에서 구·신 코드가 섞이면 zero-start가 ±250ms 어긋날
      수 있다. 오너가 승인한 기존 점검 모드로 배포했고 강제 버전 차단·호환
      마이그레이션은 추가하지 않았다. 기존 탭 잔존과 점검 해제 뒤 재입장을 수용했다.
      점검이 사용자 0명이나 동일 코드 실행을 보장하지 않는다.
      [구현·검증·호환 한계](design/android-youtube-output-baseline-2026-10-12.md),
      [점검·배포 근거](design/sync-maintenance-release-preparation-2026-10-12.md),
      [수용했던 전환기 한계(2026-10-26 은퇴, 옛 #13)](known-accepted.md#retired-risks)
- [ ] iPhone Safari/PWA 실기 재입장: 8.9.4의 이전 연결 안내와 "여기서 계속",
      같은 코드로 입장 실패 후 재시도를 확인한다. 종료 알림이 누락되면 마지막 생존
      확인 뒤 45초 동안 presence가 남을 수 있고 명시적 이어하기 정책은 유지한다.
      42개 언어 문구·재시도 복원은 배포 완료했으며, 자동화가 실기 강제 종료를 대신하지
      않는다. [PWA·배포 근거](design/pro-pwa-force-close-audit-2026-10-12.md),
      [재시도 근거](design/pro-entry-retry-audit-2026-10-11.md)
- [ ] PRO 자율 재생 실기: 재생 권한 기기 절전·퇴장 후 일반 참여자만 남은 방에서
      파일·YouTube·플레이리스트 서브인덱스의 연속 전환, 전원 퇴장·복귀를 확인한다.
      서버 자연 종료 경로를 추가했으며, 길이를 검증할 수 없는 파일·라이브·조회가
      불확실한 YouTube는 임의 종료하지 않는다. 실기 확인은 자동화로 대신하지 않는다.
      [구현·검증·한계](design/pro-autonomous-playback-2026-10-12.md)
      등록 시 길이 확보와 기존 파일의 점진적 보완도 같은 실기 확인 대상이다.
      분석 불가 형식은 권한 기기의 준비 완료 전까지 미확정으로 남는다.
      [등록·보완 근거](design/pro-file-duration-registration-2026-10-12.md)
- [ ] PRO 자동 넘김 길이 판독(8.10.1 배포 뒤): 운영 PRO Worker 로그에서
      `Automatic completion metadata unavailable`(특히 `METADATA_LOOKUP_FAILED`)와 YouTube
      메타데이터 조회가 평소보다 늘지 않는지 본다. 8.9.5–8.10.0 판독기가 저장한 서버·업로드
      길이는 재생 때 다시 재므로, 이어 붙인 MP3·조각난 MP4는 짧게 넘어가는 대신 컨트롤러가
      준비할 때까지 곡 끝에서 멈출 수 있다(오너 규칙: 짧은 길이보다 미확정). 삭제·비공개
      YouTube 영상은 60초 이상 떨어진 두 번의 "없음" 응답 뒤에만 건너뛴다. 남은 한계:
      VBR 파일의 1/16 미만 이어 붙임은 FFmpeg처럼 감지하지 못하고, 16 MiB를 넘는 스캔
      대상과 꼬리말 없는 ID3v2.3 뒤 태그는 미확정이다. 실기 확인은 위 "PRO 자율 재생 실기"
      항목과 함께 한다. [상세](design/pro-duration-hardening-2026-10-12.md)

## 3. 릴리스·QA 기준

- QA 범위, 우선순위, 결과에 남길 최소 증거는 [QA 범위 설계](qa-domains.md)를
  따른다.
- 배포 대상은 매번 live SHA와 서버 의존성으로 다시 판정한다
  ([release-deployment-state.mts](../scripts/release-deployment-state.mts)).
  partial-release gate는 선택하지 않은 Worker에 남는 runtime 차이를 거부한다.
- Developer API D1 `false`는 데이터 계층을 건드리지 않는다는 뜻이 아니다. `all`은
  idempotent D1 baseline, R2 정책, room-code 재사용 fence를 적용하고 검증한다.
  `app`도 App 쪽 D1 baseline(번역 커뮤니티 등)은 적용·검증하지만, R2 정책과
  room-code fence는 건너뛴다. 대상별 단계 조건은
  [release.yml](../.github/workflows/release.yml)이 정본이다. 이미 끝난
  launch-cleanup SQL은 다시 실행하지 않는다.
- 날짜가 붙은 QA 결과는 현재 상태가 아니다. 실제로 실행한 환경과 코드 SHA를
  기록하고, 예전 통과 결과를 옮겨 적지 않는다. 같은 검사를 여러 번 돌린 숫자를
  합산하지 않고, 재실행·치환 집계는 그렇다고 밝힌다.
- 실기 확인과 Full E2E는 배포 gate와 별개다. CI의 E2E subset과 coverage는
  생략하지 않는다.
- Full E2E의 production large-room job은 `continue-on-error`라서, workflow가
  성공해도 그 probe가 통과했다는 뜻이 아니다.
- 원격 CI의 1 skip은 기존 상태다. pro-grant-campaign CLI의 Windows 전용 "다른
  드라이브 거부" 검사라서 Linux runner에서는 항상 skip된다.
- 릴리스 뒤 main에 올라간 문서 전용 커밋은 배포 SHA가 아니다. 문서와 감사
  도구만 바꾼 변경은 merge만으로 게시하고 Cloudflare 릴리스를 하지 않는다
  ([documentation-governance](documentation-governance.md#publication-boundary)).
- 시그널링 observability 설정은
  [wrangler.signaling.toml](../cloudflare/wrangler.signaling.toml)과
  [config-drift-ops.md](../cloudflare/config-drift-ops.md)가 소유한다.

### 정기 수동 점검

자동 감사가 통과해도 아래는 사람이 봐야 한다. 열린 항목이 아니라 주기 점검이며(오너
결정 2026-10-14), 이상이 없으면 기록하지 않고 이상이 있으면 §2에 항목을 연다.

- 분기 1회(Drift Audit manual-only 5건): Worker zone routes, `/admin` Cloudflare
  Access+MFA, WAF rate limit과 Worker/R2/D1 비용 알림, 두 번째 Git 배포 경로가
  없음, main review·필수 체크 정책. zone routes는 저장소 시크릿 `CLOUDFLARE_ZONE_ID`와
  `CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN`을 추가하면 자동 감사로 넘어간다.
- 월 1회(일반방 방장 암호): 관리자 대시보드 Operations → Signals의 Password
  lockouts(`guest_auth_rate_limited`, 최근 24시간)가 평소 0에 가까운지, Password
  failures(`guest_auth_failed`)·Password issues 카드 급증·신고가 없는지 본다. 추측
  공격이 보이면 게스트 암호 시도 앞에 봇 확인이나 작업 증명을 검토한다.
  [운영](../cloudflare/standard-room-pin-ops.md),
  [허용 위험](known-accepted.md#12-standard-room-owner-pins-kicks-and-guessing)

## 4. 복구 시 주의

기본 절차는 [hotfix-procedure.md](hotfix-procedure.md)다. checkpoint는 사용자
데이터 백업이 아니고, 더 새로운 외부 배포를 덮어쓰지 않으며, 소스를 revert해도
버전과 캐시 번호는 앞으로만 올린다. 아래는 지금 유효한 복구 경계다. PRO 선택형
입장 암호 floor의 정본은 hotfix-procedure의 "Optional PRO entry passwords"
문단이고, 아래는 요약이다.

- **9.0.14 최소 앱 빌드(2026-10-26 배포 뒤, 최소 빌드 787):** App·PRO·remote-share·signaling·Developer API
  facade·Developer API를 `all`로 배포했다(Release 40283632968). 정본은
  [hotfix-procedure의 App Build Floor](hotfix-procedure.md#app-build-floor)다.
  - App을 저장 최소 빌드(지금 787) 아래로 CLI로 되돌리기 전에 App Build Floor workflow `lower`를 그 빌드로(9.0.13
    이하면 0) 먼저 하고 그 실행의 성공을 확인한다. 하지 않으면 그 빌드의 새 입장이 다음 App 보고까지(최대 1분,
    보고하지 않는 9.0.13 이하는 최대 5분) 거절된다. Cloudflare 대시보드 되돌리기는 막을 수 없고 보고가 같은 방식으로
    강제 값을 live App으로 묶으며, 매일 Drift Audit이 저장값이 live App보다 높으면 알린다.
  - 9.0.14 이상 App이 live인 동안 Signaling Worker를 9.0.14 아래로 되돌리지 않는다. 옛 Signaling의 정확한 키 검증이
    `appBuild`를 실은 모든 `host-auth`를 `HOST_AUTH_FIRST_FRAME_INVALID`로 거절해 9.0.14 방장이 방을 만들거나 다시
    붙지 못한다(게스트는 영향 없음, 옛 대기 게스트 검증은 다른 키를 무시). App을 먼저 되돌린다(자동 복구도 그 순서).
  - PRO Worker를 9.0.14 아래로 되돌리면 최소 빌드를 담은 service-control 객체(`MusixquareServiceControl`, PRO Worker
    스크립트에 있고 다른 Worker는 `script_name = "musixquare-pro-room"`으로 묶음)가 floor 경로에 404를 답해 Signaling을
    포함한 모든 Worker의 최소 빌드가 꺼진다(모든 소비자가 0으로 읽음). floor workflow와 관리자 화면도 PRO Worker를
    앞으로 배포할 때까지 최소 빌드를 읽지도 바꾸지도 못하고, 저장값은 남아 앞으로 배포하면 돌아온다.
  - 급히 내리기: App Build Floor workflow `lower`(0이면 끔, `gh workflow run app-build-floor.yml --ref main -f
action=lower -f min_app_build=<build> -f reason="<why>"`). Production Release가 같은 동시성 그룹을 잡고 있거나
    GitHub Actions를 쓸 수 없으면 오너가 관리자 대시보드(Maintenance, App build floor 판, 내리기만)에서 내린다.
  - 새 D1 스키마·비밀·바인딩은 없다. 자동 실패 복구는 바꾸지 않았다(올리기는 커밋 표지 뒤나 같은 동시성 그룹의
    standalone workflow에서만 일어나므로, 자동 장치만으로는 저장값이 복구 checkpoint의 App 빌드를 넘지 않는다).
    [보고서의 배포·회복](design/forced-update-9-0-14-2026-10-25.md#배포회복)
- **9.0.0(배포 뒤):** App·PRO·remote-share·signaling·Developer API facade·Developer API를 `all`로 배포했다
  (Release 39686757595). 시스템 오디오 계약 표지가 `single-stereo-v3+heartbeat-state-v1`로 바뀌어, 그 후보가 한
  부분이라도 올라간 뒤에는 PRO·signaling·App을 표지 이전으로 부분 롤백하지 않고 앞으로 고친다. 9.0.0 앱은 시스템
  오디오 상태가 없는 하트비트 응답을 거부하고, 이전 앱은 새 응답을 거부한다. BOT 계획의 `playlist` 필드는 PRO room이
  받으므로 PRO만 되돌리면 BOT의 추가·재생 명령이 실패한다(데이터 손상 없음). App만 8.11.39로 되돌리면 꺼진 효과의
  상시 계산, 모노 왼쪽 재생, 가려진 화면의 다시 그리기, 60초 시스템 오디오 GET, PRO 재생목록 대상 결함이 돌아온다.
  새 비밀·바인딩·D1 스키마와 저장 데이터 마이그레이션은 없다. [보고서](design/idle-compute-optimization-2026-10-22.md)
- **8.11.39(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·프로토콜·floor는 없다. 8.11.38로 되돌리면 재생 중인 줄의
  아이콘이 다시 1 px 아래로 밀리고, 삭제 때 묶인 블록이 줄마다 잘려 나가며, 남은 줄 이동과 빈 목록 안내가 나가는
  복사본과 겹친다. 저장 데이터 마이그레이션은 없다. [보고서](design/icon-slot-cell-and-delete-sequence-2026-10-21.md)
- **8.11.38(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·프로토콜·floor는 없다. 8.11.37로 되돌리면 선택 모드를 끝낼 때
  여러 줄 블록이 pill로 갈라지며 사라지고, 선택 모드에서 누른 줄이 회색으로 남으며, 두 손가락 스크롤이 해제를 하지
  못하고, 다중 목록 창 부제가 이전 문구("곡 세트")로 돌아간다. 저장 데이터 마이그레이션은 없다.
  [보고서](design/selection-clear-fade-press-tint-two-finger-2026-10-21.md)
- **8.11.37(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·프로토콜·floor는 없다. 직전 배포 8.11.35/v760으로
  되돌리면 우선순위 대기 중 끊긴 프리로드와 재개 후 반복 중단의 복구 공백, 원격 목록 재그리기 중 선택 pill의
  위치 오류가 돌아온다. 저장 데이터 마이그레이션은 없다. 기존 8.11.33 이하의 복구 제한은 유지한다.
  [보고서](design/preload-recovery-and-db256-multi-2026-10-21.md#production-release-and-recovery)
- **8.11.35(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·floor는 없다. 8.11.34로 되돌리면 선택 블록이 행마다
  따로 모양을 바꾸며(해체 때 네모 모서리가 잠깐 보임), 머리글이 한 번에 바뀌고, 선택 막대가 화면 아래로 점프한 뒤
  사라지며, 아이콘이 이전 것으로 돌아간다. 저장 데이터 마이그레이션은 없다. [보고서](design/playlist-selection-morph-and-header-crossfade-2026-10-21.md)

- **8.11.34(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·floor는 없다. 8.11.33으로 되돌리면 다중 목록·곡 이동 창의
  버튼이 다시 아래 끝에 붙고, 선택 블록은 즉시 붙으며, 삭제한 행은 연출 없이 사라진다. 저장 데이터 마이그레이션은 없다.
  [보고서](design/playlist-dialog-inset-and-selection-motion-2026-10-21.md)

- **8.11.33 다중 재생목록(배포 뒤):** App·PRO·Developer API를 함께 `all`로 배포했다(Release 39525250036). PRO room
  Worker가 Developer API facade·공개 Worker보다 먼저 살아 있어야 새 경로가 400/503을 내지 않는다(기존 경로는 순서
  무관). 첫 실행 39524104567은 PRO room 배포 9초 뒤 remote-share smoke가 PRO Worker 안의 service-control 제한기에서
  503 `rate limit unavailable`을 받아 자동 복구됐다. remote-share·service-control 코드는 바뀌지 않아 배포 직후
  Durable Object 재시작과 겹친 것으로 보며 확정하지는 않았다. 같은 후보의 재시도는 통과했다. 되돌린 뒤 다시 배포할
  때도 같은 일이 생기면 새 실행으로 재시도한다.
  새 비밀·바인딩·D1 마이그레이션은 없고, PRO 저장소에 `pro-room:v2:slots`와 `pro-room:v2:slot-item:<id>` 키가
  더해진다(기존 활성 재생목록 배치는 그대로). **되돌리기는 파일에 대해 앞으로만 간다:** 이전 PRO Worker는 활성
  재생목록만 읽으므로 15분 유예 뒤 비활성 재생목록에만 있는 파일을 정리해 지운다. Worker를 되돌리면 그 파일 손실을
  감수하거나 앞으로 고친 배포를 해야 한다. 다음 정방향 배포는 자산이 사라진 비활성 항목을 불러올 때 지워 편집이
  막히지 않게 한다. 일반방은 호스트 메모리에만 있어 되돌려도 저장 데이터가 없다.
  [설계](design/multi-playlist-2026-10-21.md), [PRO 구현](design/multi-playlist-pro-2026-10-21.md)

- **8.11.32(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·floor는 없다. 8.11.30 이하로 되돌리면 화면 보호기가
  날씨·공기·달 장면과 위치 요청으로 돌아가고(배경 이미지는 되돌린 App 산출물에 들어 있다), iPhone 길게 누르기
  글자 선택 회귀와 블로그 사진 404가 다시 나타나며, 재생목록 삭제는 예전 즉시 삭제 아이콘 pill로 돌아간다.
  저장 데이터 마이그레이션은 없다. [묶음 보고서](design/playlist-and-platform-fixes-2026-10-20.md)

- **PRO 파일 길이 저장(8.9.6):** App·PRO 함께 `all`로 배포한다. 새 비밀·바인딩·D1
  마이그레이션·복구 floor는 없다. 기존 파일의 private asset metadata를 점진적으로
  보완하고 업로드나 재생목록을 초기화하지 않는다. 추가 길이 보고는 실패해도 재생을
  막지 않는다. 9.0.4의 PRO 입장 정책 표지 뒤로는 PRO를 이 변경 이전(8.9.5 이하)으로
  되돌리지 않는다(아래 'PRO 소유권 이전 입장 암호 끄기'). 그래서 구버전 호환 제거
  열차 2 릴리스 A부터 App은 업로드 완료가 400 `INVALID_REQUEST`를 받아도 길이
  필드를 빼고 다시 보내지 않으며, 길이 보고 경로의 404 `NOT_FOUND`도 보고를 끄지
  않고 다른 실패처럼 다음 준비 때 다시 보낸다. 그 전 App은 400이면 한 번 길이 없이
  재시도했고 404면 그 클라이언트 수명 동안 보고를 껐다.
  [상세](design/pro-file-duration-registration-2026-10-12.md),
  [보고서](design/old-version-removal-2a-app-2026-10-26.md)

- **PRO 자율 재생(8.9.5):** App과 PRO를 함께 배포(`all`)한다. 새
  `PRO_YOUTUBE_METADATA` 서비스 바인딩은 기존 App의 YouTube 키와 기존 공유
  assertion secret을 쓰며, 새 비밀·D1 마이그레이션·호환 floor는 없다. PRO를 먼저
  배포했을 때 이전 App의 내부 경로 404는 미확정으로 처리하고 재시도한다.
  9.0.4의 PRO 입장 정책 표지 뒤로는 PRO를 이 변경 이전으로 되돌리지 않는다. 그래서
  구버전 호환 제거 열차 2 릴리스 A부터 App은 파일 READY가 400 `INVALID_REQUEST`를
  받아도 길이 필드를 빼고 다시 보내지 않는다(그 전 App은 한 번 재시도했다). App만
  롤백해도 기존 파일 근거는 유지되지만 새 YouTube 길이 조회는 복구 전까지 미확정이
  된다.
  [상세](design/pro-autonomous-playback-2026-10-12.md),
  [보고서](design/old-version-removal-2a-app-2026-10-26.md)

- **PRO 선택형 입장 암호:** `passwordRequired: false` / `pin: null`이 저장될 수
  있는 배포 이후에는 이 계약을 모르는 구 PRO/App 조합으로 자동 복구하지 않는다.
  구 Worker는 공개방 입장을 막거나, PIN 변경 뒤에도 모르는 false 플래그를 남겨
  재업그레이드 때 방을 다시 공개할 수 있다. forward repair나 검증된 같은 시점
  코드·데이터 복구를 쓰고, 계약을 아는 이후 기준선(예: 8.8.x에서 8.8.0으로)으로는
  일반 rollback이 가능하다. 임의 PIN 주입이나 플래그 삭제로 우회하지 않는다.
  [계약](design/pro-optional-entry-password-2026-10-10.md)
- **PRO 소유권 이전 입장 암호 끄기(9.0.4, 2026-10-24부터 적용):** PRO 입장 정책 계약 표지가
  `pro-room-optional-entry-password-v1+pro-owner-transfer-pinless-v1`로 바뀌었다. 이 릴리스의
  PRO나 App 후보가 기준선을 대체한 뒤에는 release와 독립 recovery 워크플로가 둘을 표지
  아래로 되돌리지 않고 후보에 남긴다(`forward-repair-required`). 손으로도 되돌리지 말고
  target `all`로 앞으로 고친다. 옛 PRO는 `pin` 없는 대기 이전 레코드를 무효로 버려 진행 중인
  이전의 방을 `ownership_transfer_pending` 정지로 남기고 재시도·크론이 끝내지 못하며, 새 앱의
  `newPin` 없는 본문도 400 `INVALID_REQUEST`로 거절한다(링크는 소비되지 않음). 옛 App
  facade도 캐시된 새 앱의 본문을 400으로 거절한다. 후보가 올라가기 전에 실패한 릴리스와 이
  표지를 가진 이후 기준선으로는 일반 rollback이 된다. 이전으로 꺼진 방 상태 자체는 선택형
  입장 암호 계약의 모양이다.
  [호환성](design/phase2-navigation-ui-shells-2026-10-23.md#호환성과-배포-순서)
- **쿠키 reader 호환:** 세션별 쿠키를 발급한 뒤 이전 App Worker로만 되돌리면 이전
  코드가 새 이름을 읽지 못해 사용자가 익명으로 보일 수 있다. 이 경계는 자동
  rollback marker로 보호되지 않는다. 지금은 8.8.0 floor가 그 이전 App으로의
  복구를 막고 있지만, floor가 바뀌면 다시 검토한다. 새 cookie reader를 유지하는
  forward fix나 선별 revert를 우선한다. 구 버전 전체 복구가 필요하면 재로그인
  영향과 남은 scoped 쿠키 처리를 함께 검토하고, 재로그인만으로 해결된다고 가정하지
  않는다. 이 문제를 D1 세션 데이터 유실과 혼동하지 않는다.
- **리버브 상한 일치:** App, PRO, API 중 일부만 복구해 서로 다른 리버브 상한이
  남지 않게 한다. 대상별 복구 순서를 새로 만들지 않고 정식 절차를 따른다.
- **PRO 공개방 입장 보호(배포되면 적용):** 이 변경 이전 PRO Worker로 되돌려도
  core의 `sessionCreateIdempotency`(입장 영수증 최대 256개, 약 108 KiB)와
  `presenceCloseIdempotency`(presence-close 영수증 최대 128개, 약 52 KiB)
  필드는 그대로 보존되지만, 이전 Worker는 둘 다 읽지도 정리하지도 alarm
  대상으로 삼지도 않는다. 되돌린 동안에는 방장 좌석 예약, 입장 throttle, 두
  전용 원장이 모두 적용되지 않는다. 8.8.0은 presence-close 영수증을 다시 공유
  participant 원장에 쓰므로, 그 원장이 차서 방장 큐·재생·미디어 제어가 막히는
  문제도 그동안은 다시 생길 수 있다. 다시 앞으로 배포하면 공유 원장의
  presence-close 영수증은 로드할 때 해제되고, 전용 원장의 만료됐거나 세션이
  사라진 영수증은 정리된다. 그 사이 10분 안의 입장 재시도는 세션이 남아 있으면
  deterministic recovery로 같은 세션에 수렴하고, 이미 닫힌 세션이면 새 입장으로
  처리된다. 상대 Worker가 읽지 않는 원장에 영수증이 있는 presence close 재시도는
  상태 변화 없는 409를 받고, App은 이를 무시한다. 계약 marker는 없고 rollback
  floor도 바뀌지 않는다.
  [상세](design/pro-room-admission-protection-2026-10-11.md)
- **PRO 암호 참여자 선택·퇴장 사유(배포되면 적용):** 9.0.4의 PRO 입장 정책 표지
  뒤로는 PRO를 이 변경 이전(8.9.0 전) Worker로 되돌리지 않는다. 그런 Worker는
  `existingParticipants`가 든 `POST /pin`을 400 `INVALID_REQUEST`로 거절한다.
  구버전 호환 제거 열차 2 릴리스 A부터 App은 그 거절을 다른 실패처럼 일반 오류로
  보이고("그대로 두기를 지금 쓸 수 없음" 안내는 없앴다), 모두를 내보내는 쪽으로
  대신 시도하지 않는 것은 그대로다([보고서](design/old-version-removal-2a-app-2026-10-26.md)).
  "모두 재입장"(8.9.0은 "모두 다시 입장하게 하기")은 참여자 선택 없는 `{pin}`
  요청이다. core의
  `sessionRevocationNotices`(최대 256개, 약 36 KiB)는 이전 Worker가 그대로
  보존하지만 읽거나 정리하지 않으며, 그동안
  퇴장 사유는 붙지 않는다(코드는 계속 `SESSION_REQUIRED`). 다시 앞으로 배포하면
  인증 epoch·room generation이 맞지 않거나 만료된 항목은 첫 prune에서 정리된다.
  App만 이전으로 되돌리면 사유를 무시하고 예전처럼 동작한다. 계약 marker는 없고
  rollback floor도 바뀌지 않는다.
  [상세](design/pro-pin-member-choice-2026-10-11.md)
- **일반방 방장 암호(8.10.0 배포 뒤):** 9.0.14 이상 App이 운영 중이면 시그널링을
  9.0.14 아래로 되돌리지 않는다. 그 아래 Worker는 `appBuild`가 든 `host-auth`를 모두
  거절한다([절차](hotfix-procedure.md#app-build-floor)). 그래서 8.10.0 이전 Worker는
  App도 9.0.14 아래로 함께 되돌리고 최소 앱 빌드를 내린 비상 복구에서만 만난다. 이전
  Worker는 `standard-room-pin-membership-v1`과 `standard-room-pin-failures-v1`을 읽지
  않고 기능 플래그도 알리지 않아, 그 App(9.0.13 이하)은 암호만 보낸다. 그동안 "그대로
  두기"는 8.10.0 이전처럼 동작해 재연결 때 옛 암호를 다시 보내는 결함이 돌아오고,
  "모두 재입장"은 방장의 강퇴뿐이라 수정된 클라이언트는 시그널링에 남을 수 있다. 오답
  제한도 꺼지는데 방장이 고른 약한 암호는 계속 허용된다. 구버전 호환 제거 열차 2
  릴리스 A부터 App은 기능 플래그를 읽지 않고 참여자 선택을 늘 싣지만, 9.0.14 아래
  Worker에는 방장으로 들어가지 못해 그 프레임을 버리는 Worker와 만나지 않는다
  ([보고서](design/old-version-removal-2a-app-2026-10-26.md)). 그래서 forward fix를
  우선하고, 되돌려야 하면 App도 함께 되돌린다(8.9.x의 무작위 암호로 돌아간다).
  되돌린 동안 같은 방에서 암호를 X→Y→X로 바꾸면, 다시 앞으로 배포했을 때 X 때의
  유지 목록이 되살아난다(그 기기도 자기 재연결 비밀이 있어야 한다). App만 8.10.0
  아래로 되돌리려면 먼저 최소 앱 빌드를 내려야 하고(위 '9.0.14 최소 앱 빌드'), 구버전
  제거 열차 2 릴리스 W(2026-10-27) 뒤의 시그널링은 PIN 두 필드(`desiredRoomPassword`,
  `pinMutationId`)가 없는 `host-auth`를 첫 프레임 무효로 거절한다. 되돌리기 전에 저장된 유지 목록은 방
  epoch와 verifier에 묶여 있어 그 경우 말고는 무시되고, 오답 기록은 10분 안에
  만료된다. 계약 marker는 없고 rollback floor도 바뀌지 않는다.
  [상세](design/standard-room-owner-pin-2026-10-11.md),
  [운영](../cloudflare/standard-room-pin-ops.md#rollback)
- **PRO 파일 길이 근거(8.10.1 배포 뒤):** PRO Worker를 8.10.0으로 되돌려도 floor는
  없다. 이전 Worker는 asset 길이 근거의 `reader`·`measuredSeconds`를 엄격히 검사하지
  않아 다시 쓸 때까지 그대로 두고, 큐 캐시에서는 지운다. 되돌린 동안에는 이전 판독기와
  업로드 길이가 다시 저장되어 이어 붙인 MP3·조각난 MP4가 짧게 읽힐 수 있다. 다시 앞으로
  배포하면 그 값들은 `reader: 2`가 없으므로 재생 때 다시 잰다. App만 되돌리면 업로드
  길이를 보내지만 새 Worker는 저장하지 않는다. 계약 marker는 없다.
  [상세](design/pro-duration-hardening-2026-10-12.md#compatibility)

## 5. 갱신 방법

**프로덕션 배포나 롤백 뒤 (같은 기록 PR에서):** `Production Release` 실행뿐 아니라
로컬 emergency deploy와 CLI rollback도 해당한다.

1. §1 전체(표의 모든 행)와 머리말 표의 `Last source review`를 새 값으로
   덮어쓴다. 이전 값은 남기지 않는다. 강제 업데이트 열차(9.0.14) 배포부터
   §1 표에 '최소 앱 빌드' 행을 두고 floor 스크립트의 요약 줄(저장·유효 값,
   revision, live·보고 App 빌드, 페이지 읽기)을 적는다. 배포 사이에 workflow로
   바꾼 최소 빌드는 그 행(과 그 변경이 닫는 §2 항목, 허용한 위험)을 고치는 작은
   기록 PR로 적고 이력 행은 더하지 않는다
   ([운영](hotfix-procedure.md#app-build-floor)).
2. [release-history.md](release-history.md) 표 맨 아래에 한 줄을 추가한다.
3. 릴리스 상세 근거는 `docs/design/<주제>-<날짜>.md`에 쓰고 §1과 이력 행에서
   링크한다.
4. 이번 배포로 해결된 §2 항목은 근거와 함께 지우고, 새로 생긴 한계는 추가한다.

**릴리스 열차(한 번의 프로덕션 배포에 실리는 변경 묶음)를 준비할 때** (테스트·문서·
가드·감사 도구만 바꾼 변경은 2번만 해당):

1. 열차마다 `docs/design/<주제>-<날짜>.md` 보고서 하나를 쓴다(오너 결정
   2026-10-22). 열차에 실린 QA 라운드와 제품·런타임 변경마다 실행한 코드 SHA,
   환경, pass/fail/skip과 한계를 적는다. 그 보고서를 [문서 허브](README.md)의
   "Maintained evidence and completed records" 목록 맨 위에 추가한다.
2. 배포 대상, 의존성·자산, 데이터·secret·binding, API·프로토콜·쿠키 호환성,
   버전·캐시 요구, 열린 항목, 복구 조건, 오너의 승인·보류 결정 중 하나라도
   바뀌었으면 같은 변경에서 §1~§4를 고친다. 새로 열거나 바꾼 §2 항목에는 보고서를
   링크한다. 바뀐 것이 없으면 이 문서를 고치지 않는다.
3. §2 항목을 닫을 때는 근거 보고서·커밋·실행을 PR 설명에 적는다. 같은 기록 PR에서
   새 이력 행을 추가할 때만 그 행의 내용 칸에도 적고, 이미 쓴 이력 행은 고치지
   않는다.

**지킬 것:**

- 문서만 수정한 커밋은 마지막으로 검증한 코드 SHA를 바꾸지 않는다.
- secret 값, 세션 쿠키, 개인정보는 넣지 않는다.
- 이 문서는 현재 상태만 담는다. 날짜별 경과를 쌓지 말고, 길어지면 근거 문서로
  옮긴 뒤 링크만 남긴다.

2026-09-27~2026-10-10의 베타 승격·QA·배포 원문은
[보관본](beta-release-readiness-archive-2026-10-10.md)에 있다.
