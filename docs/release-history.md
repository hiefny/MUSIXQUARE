# 프로덕션 릴리스 이력

| Field              | Value |
| ------------------ | ----- |
| Status             | Runbook — append-only 릴리스 로그 |
| Applies to         | 프로덕션 배포와 롤백 (`Production Release` 실행, 로컬 emergency deploy, CLI rollback) |
| Last source review | 2026-10-11 |
| Executable sources | [Production Release](../.github/workflows/release.yml), [Release Recovery](../.github/workflows/release-recovery.yml), [배포 범위·복구 판정](../scripts/release-deployment-state.mts) |
| Related documents  | [현재 릴리스 기록](release-record.md), [정식 배포·복구 절차](hotfix-procedure.md), [버전 규칙](release-versioning.md) |

프로덕션을 바꿨을 수 있는 일 1건마다 표 맨 아래에 한 줄을 추가한다.

- `Production Release`는 deploy job이 시작된 실행만 쓴다. validate 단계에서 끝나
  프로덕션을 건드리지 않은 실행은 쓰지 않는다. 실패하거나 recovery job이 돈
  실행은 쓴다.
- 행은 실행이 끝나고 재시도까지 마친 뒤 쓴다. 같은 실행 ID의 재시도는 한 줄로
  쓰고, 결과 칸에 마지막 attempt와 경과를 적는다(예: `성공 (attempt 2, attempt 1
  실패)`).
- 로컬 emergency deploy와 CLI rollback도 한 줄씩 쓴다. 아래 칸 정의를 따른다.
- 이미 쓴 행은 고치지 않는다. 잘못 쓴 값이나 기록 뒤에 생긴 변화(예: 같은 실행의
  추가 재시도)는 표 아래 [정정](#정정) 목록에 날짜, 대상 행, 내용을 추가한다.

- 시각은 `Deploy validated candidate` job 완료 시각(KST)이다.
- 대상은 workflow 입력 `target`이고, 모든 행의 Developer API D1 입력은 별도
  표기가 없으면 `false`이다.
- main SHA는 배포한 exact-main candidate의 커밋이다. 릴리스 뒤에 올라간 문서 전용
  커밋은 배포 SHA가 아니다.
- emergency deploy 행: 시각은 마지막 deploy·smoke 완료 시각, 대상은
  `emergency:deploy:<target>`, main SHA는 배포한 origin/main HEAD, Release 실행
  칸은 `emergency`와 Cloudflare version ID다.
- CLI rollback 행: 시각은 `wrangler versions deploy` 완료 시각, 대상은 되돌린
  Worker 목록, main SHA는 복구한 version의 `git:` 메시지 SHA(모르면 `-`),
  Release 실행 칸은 `cli rollback`과 version ID다.
- 상세 근거는 각 행의 링크를 따른다. 링크가 보관본을 가리키면 전용 문서가 없는
  릴리스다.

| 완료 (KST)       | 버전 / 캐시   | 대상      | main SHA   | PR   | Release 실행 | 결과 | 내용 | 상세 |
| ---------------- | ------------- | --------- | ---------- | ---- | ------------ | ---- | ---- | ---- |
| 2026-09-20 23:38 | 8.6.61 / v630 | app       | `35759e8b` | [#244](https://github.com/hiefny/MUSIXQUARE/pull/244) | [35517030098](https://github.com/hiefny/MUSIXQUARE/actions/runs/35517030098) | 성공 | 대회 동결 전 마지막 배포. 8.7.0 승격의 기준 main | - |
| 2026-10-07 16:02 | 8.7.0 / v631  | all       | `e8001e93` | [#245](https://github.com/hiefny/MUSIXQUARE/pull/245) | [37584399403](https://github.com/hiefny/MUSIXQUARE/actions/runs/37584399403) | 성공 | 대회 종료 후 `mxqr_beta` 누적 변경 첫 승격 | [승격 기록](design/release-8.7.0-2026-10-07.md) |
| 2026-10-07 16:57 | 8.7.1 / v632  | app       | `f005a706` | [#247](https://github.com/hiefny/MUSIXQUARE/pull/247) | [37590255149](https://github.com/hiefny/MUSIXQUARE/actions/runs/37590255149) | 성공 | 42개 언어 YouTube 입력 안내 문구, 소스 선택 BETA 배지 | [보관본](beta-release-readiness-archive-2026-10-10.md#이전-app-패치-배포-완료--871--v632-2026-10-07) |
| 2026-10-07 17:25 | 8.7.2 / v633  | app       | `94fa5b03` | [#249](https://github.com/hiefny/MUSIXQUARE/pull/249) | [37593498828](https://github.com/hiefny/MUSIXQUARE/actions/runs/37593498828) | 성공 | YouTube 브랜드 표기 통일, YouTube BETA 배지 제거 | [보관본](beta-release-readiness-archive-2026-10-10.md#후속-app-패치-배포-완료--872--v633-2026-10-07), [전체 검증](design/full-verification-8.7.2-2026-10-07.md) |
| 2026-10-08 12:30 | 8.7.3 / v634  | app       | `10be9957` | [#263](https://github.com/hiefny/MUSIXQUARE/pull/263) | [37722846236](https://github.com/hiefny/MUSIXQUARE/actions/runs/37722846236) | 성공 | YouTube 검색 결과 제목·채널명 간격 정렬 | [보관본](beta-release-readiness-archive-2026-10-10.md#후속-app-패치-배포-완료--873--v634-2026-10-08) |
| 2026-10-08 13:54 | 8.7.4 / v635  | app       | `358b3fc3` | [#265](https://github.com/hiefny/MUSIXQUARE/pull/265) | [37729556678](https://github.com/hiefny/MUSIXQUARE/actions/runs/37729556678) | 성공 | 데스크톱 채팅 위쪽 여백 16px→12px | [보관본](beta-release-readiness-archive-2026-10-10.md#후속-app-패치-배포-완료--874--v635-2026-10-08) |
| 2026-10-08 19:42 | 8.7.4 / v635 (App 변경 없음) | signaling | `99f9103c` | [#267](https://github.com/hiefny/MUSIXQUARE/pull/267) | [37764975511](https://github.com/hiefny/MUSIXQUARE/actions/runs/37764975511) | 성공 | 시그널링 오류 전용 안전 진단 로그, sampling 100% | [보관본](beta-release-readiness-archive-2026-10-10.md#시그널링-오류-진단-보강-배포-완료--2026-10-08), [runbook](../cloudflare/config-drift-ops.md#signaling-exception-investigation) |
| 2026-10-09 05:42 | 8.7.5 / v636  | all       | `0fc46bad` | [#269](https://github.com/hiefny/MUSIXQUARE/pull/269) | [37840659848](https://github.com/hiefny/MUSIXQUARE/actions/runs/37840659848) | 성공 | 2차 30라운드 QA 확정 13건 + 추가 2건 수정 (App·PRO·API) | [수정 기록](design/beta-30-round-repair-2026-10-09.md) |
| 2026-10-09 08:14 | 8.7.6 / v640  | all       | `ff7766cc` | [#271](https://github.com/hiefny/MUSIXQUARE/pull/271) | [37857830458](https://github.com/hiefny/MUSIXQUARE/actions/runs/37857830458) | 성공 | PRO 활성화 링크 24시간, 계정 명시 확인, 닉네임, 모바일 버튼 | [보관본](beta-release-readiness-archive-2026-10-10.md#3-현재-검증과-남은-확인) |
| 2026-10-09 13:20 | 8.7.7 / v642  | app       | `18246271` | [#273](https://github.com/hiefny/MUSIXQUARE/pull/273) | [37883236502](https://github.com/hiefny/MUSIXQUARE/actions/runs/37883236502) | 성공 | 3차 QA 확정 9건 수정, 예방 보강 3건 | [수정 기록](design/beta-qa3-repair-2026-10-09.md) |
| 2026-10-09 18:02 | 8.7.8 / v643  | app       | `12ecbf71` | [#277](https://github.com/hiefny/MUSIXQUARE/pull/277) | [37908451698](https://github.com/hiefny/MUSIXQUARE/actions/runs/37908451698) | 성공 | iPhone YouTube 탭 전환 깜빡임 수정 (비활성 패널 수평 이동 제거) | [보관본](beta-release-readiness-archive-2026-10-10.md#3-현재-검증과-남은-확인) |
| 2026-10-09 21:32 | 8.7.9 / v645  | app       | `b831b932` | [#279](https://github.com/hiefny/MUSIXQUARE/pull/279) | [37930447317](https://github.com/hiefny/MUSIXQUARE/actions/runs/37930447317) | 성공 | 헤더 독립 크로스페이드, 로딩·시크 중 탭 전환 차단 제거 | [상세](design/header-crossfade-2026-10-09.md) |
| 2026-10-10 19:33 | 8.8.0 / v646  | all       | `6e59d96c` | [#281](https://github.com/hiefny/MUSIXQUARE/pull/281) | [38045004901](https://github.com/hiefny/MUSIXQUARE/actions/runs/38045004901) | 성공 | PRO 선택형 입장 암호, PRO/App forward-repair floor | [상세](design/pro-optional-entry-password-2026-10-10.md) |

## 이 표 밖의 기록

- 2026-07-15 (7.0.0/v138)부터 8.6.61 행 직전까지의 `Production Release` 실행
  445회(성공 382, 실패 59, 취소 4)는 이 표로 옮기지 않았다. GitHub Actions에서
  조회한다.

  ```bash
  gh run list --workflow release.yml --limit 500 --json databaseId,headSha,conclusion,createdAt
  ```

- 캐시 번호 v637~v639(8.7.6 준비 중 로컬에서만 사용), v641, v644는 프로덕션에
  배포되지 않았다.
- 2026-09-27~2026-10-10의 QA·준비 과정은
  [베타 배포 준비 기록 보관본](beta-release-readiness-archive-2026-10-10.md)에 있다.

## 정정

아직 없음.
