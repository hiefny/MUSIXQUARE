# 베타 → main → 프로덕션 배포 준비 기록

| Field              | Value                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Runbook — 운영 App `8.7.5` / `v636`, Worker6종 `0fc46bad` 배포 완료. 2026-10-09 QA 후속 15건 반영, PR #269·exact-main CI `37839818477`·Release `37840659848` 성공. 운영 smoke10·최종6Worker 소유권·PRO ready 확인. QA032 합의한 로컬 범위 완료; 실기·기존 미확정 운영 관측 한계 유지 |
| Applies to         | `mxqr_beta` 누적 승격과 후속 App·시그널링 패치의 프로덕션 배포 결과·현재 상태·남은 확인 |
| Last source review | 2026-10-09 |
| Executable sources | [CI](../.github/workflows/ci.yml), [Production Release](../.github/workflows/release.yml), [배포 범위·복구 판정](../scripts/release-deployment-state.mts), [D1 계약](../cloudflare/d1-migrations.manifest.json) |
| Related documents  | [작업 지침](../AGENTS.md), [정식 배포·복구 절차](hotfix-procedure.md), [버전 규칙](release-versioning.md), [문서 관리 규칙](documentation-governance.md)                                                        |

다음 배포 담당자는 이 문서부터 읽는다. 각 QA의 상세 보고서를 대체하지 않고,
**배포에 필요한 현재 상태와 남은 작업**을 한곳에 모은다. 아래 관측값은 해당
커밋·확인일의 기록이며, 배포 직전에 실제 Git·CI·Cloudflare 상태와 다시 맞춘다.

## 1. 현재 상태

| 항목                                | 확인된 상태                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| 8.7.5 정식 릴리스 — 2026-10-09 | 사용자 명시 승인 후 PR #269·PR CI `37839097247` 성공, main `0fc46bad9233db6e7c9f7790d84052afbd53b6d8`의 push CI `37839818477` attempt1 및 immutable candidate 검증. Release `37840659848` attempt1 성공, `all`/Developer API D1 false. App `8.7.5`/`v636`·Worker6종 모두 같은 git SHA·100% version·최종 소유권 확인. main unit522파일10,881pass/기존1skip/fail0·4종coverage·핵심 browser 통과. 782파일 후보 hash 불일치0, release smoke10 통과·PRO ready·coherent marker 보존·rollback 불필요. 자동 Codex PR 리뷰는 사용 한도로 미실행; 최종 소스 검토·기존 독립 API 검토 완료. [정식 배포 후속 기록](design/beta-30-round-repair-2026-10-09.md#875-정식-배포-후속-기록--2026-10-09) |
| QA032 추가 제공 결과 검토 — 2026-10-09 | 제공 tested SHA `fa33c660d811ac51e0177a54738d5a814ca3857a`, 검토 HEAD `f271002ca35436837cc81a6aa67536013123ec4d`와 차이는 문서2파일뿐. 원본 JSON4파일집계·19검사파일 고유434pass(기존23+통합3+보조16/392), fail·skip0 확인. 실제 protocol→main/preload receiver→storage→완료 Blob 및 역순 조립 통합3이 직접 RAM 쓰기/완료 없이 통과, 보조 원본 JSON·로그/보고서 명령 확인. 합의한 로컬 QA032 범위 완료·앞선 근거 보류 해소. binary codec/실제 WebRTC/live 검증 아님. 현재clean/추적1,964·비Markdown1,819 hash가 기존 manifest와 동일; 실행 전체의 전후hash는 별도 미제공. 부모 재실행/검사수정0·새 확정 제품 결함0·제품/main/운영/배포 변경0. [후속 판정](design/beta-30-round-repair-2026-10-09.md#qa032-추가-통합-근거의-읽기-전용-재검토--2026-10-09) |
| API 인증 후 키 수명 재검증 — 2026-10-09 | `2a6e481250137fa1e5eeb0a60aabf38317c72b2f`, 새 GPT-6 Luna/high 세션과 부모 독립 확인, Windows/Node24.20.0. 최종 고유8pass/fail·skip0/retry0: 실제 초기 인증→Request reader 대기→회수/만료→본문 완료를 명시한 queue-mode·원래 queue-add 각4대조. 정상200/201·회수/만료 기존·새 요청401/PRO 저장 불변·epoch409. 원본4pass는 pull 자동 호출로 인증 후 순서 증거가 부족해 합산하지 않음; 최초 fixture 오류 보존. API는 직접 거절 없이 중단됐던 항목으로 분류 정정, 이번 서비스 거절0·새 확정0. 추적1,964/dist782 불변, 제품/main/배포 변경0. QA032의 현재 판정은 위 후속 제공 근거 행을 따름. [근거·한계](design/beta-30-round-repair-2026-10-09.md#api-키-수명-로컬-재검증-완료--2026-10-09) |
| 새 세션 마지막 독립 검증 — 2026-10-09 | `44ef6a789112c23f1c63c843853eca9d86054e45`, 로컬 GPT-6.1 Sol/xhigh·Windows/Node24.20.0. 새 scratch43pass(API11·공개 요청14·번역8·관리자10) 및 기존17파일966pass, 최종fail·skip0/자동retry0. 최초40pass/1fail은 삭제 fence의 HTTP 기대값 차이; 실제200/voted:false·DB 무쓰기와 원본 보존. 새 확정0. QA032는 기존 제한/공식 설명 확인만, API 스트리밍 수명도 미실행. 검증 전후 추적1,964/dist782 hash 불변, 이번 신규 보안 거절0. 임시 캐시 삭제는 실행 정책 거절로 scratch에 보존. 제품/main/배포 변경 없음. [범위·한계](design/beta-30-round-repair-2026-10-09.md#새-세션의-마지막-독립-검증--2026-10-09) |
| 현재 일반 모델 후속 검증 — 2026-10-09 | `865bd58800302c6a20c2b1320bef8277b8de6424`, 사용자 선택 GPT-6.1 Sol/xhigh의 현재 도구에서 기존 회귀17파일966pass/fail·skip0. 공개 요청303·계정/관리자103·번역106·API/PRO454 및 방어적 소스 검토. 새 확정 결함0. 별도 Daybreak 요청·거절된 프로브 실행 없음; 기존 전체 검사와 중복, 심화 재현 완료로 세지 않음. 제품/검사 코드1,819파일 불변·미배포. [결과·한계](design/beta-30-round-repair-2026-10-09.md) |
| Daybreak 심화 재시도 — 2026-10-09 | 대상 `8ff6fd12` → 문서 후속 `b24609f4`, 제품 입력 동일. 정식 Daybreak 모델 접속 뒤 실제 심화 단계는 계정 보안 등록·FIDO2 하드웨어 키 요구로 차단. 사용자 변경 모델 `GPT-6.1 Sol / xhigh`의 접근 재확인에서도 현재 카탈로그는 standard만 표시하고 Daybreak 요청은 403. 신규 보안 검사0건. R17·QA094·QA109·QA086·QA032 미완료 유지. 일반 모드의 모든 점검 거절로 확대하지 않음. 제품/검사 코드·main·배포 변경 없음. [재시도·정확한 한계](design/beta-30-round-repair-2026-10-09.md#daybreak-보안-심화-재시도--2026-10-09) |
| 2차 QA 후속 수정 — 2026-10-09 | 제품 `8c14f0d6da9d351588116e3c7114a213685cd608`, 임시 `agent/qa2-repairs-2026-10-09`. 기존 13건+사용자가 기준을 선택한 2건 수정. 14건 수정 전 새 재현/API 1건 소스 재검토. `8.7.5`/`v636`, unit10,882·4종coverage·Chromium67/최종19·WebKit66+기존3skip 통과. production build·Worker6·candidate17/WebKit SW1 통과. 추가 QA helper 경합만 수정·경계4통과, 제품 입력/산출물782파일 불변. schema/secrets/bindings/deps 변경 없음, 미배포. [수정·검증 기록](design/beta-30-round-repair-2026-10-09.md) |
| 2차 독립 30라운드 — 2026-10-09 | main `e7c5529a3273c7132880dd0ad4572b2463405c87`, Astra Ultra 3×10세트. 발견 당시 확정 13건(P1 0/P2 9/P3 4) 미수정·미확정 2·제외 8. 현재 수정 상태는 위 후속 수정 행을 따름. 전체 unit10,810/Chromium581/WebKit66+기존3skip/production17 및 4종coverage 통과. 보안 심화 실행 일부 차단·실기/운영 미검증 한계 유지. 제품 변경·배포 없음. [2차 30라운드·독립 재판정](design/beta-30-round-qa-2026-10-09.md) |
| 시그널링 오류 진단 보강 — 2026-10-08 | `99f9103c` / main CI `37763992689` attempt 2 / Release `37764975511` 성공. 로컬 unit 10,810·Worker coverage 1,752 및 운영 smoke 통과, 대시보드 sampling 100%·invocation/traces off 확인. 과거 예외 원인은 미확정. App `8.7.4`/`v635` 유지. 아래 전용 절 참조 |
| 종료·승격 승인                      | 2026-10-07 사용자가 대회 종료·main 병합·프로덕션 배포·Operations Drift Audit 재활성화를 명시 승인. 정상 PR·릴리스 절차 적용 |
| 승격 전 기준 main                   | `35759e8b07f1ee0b272afbd0af03c770a858889e` — 당시 main·운영 App 기준으로 보존 |
| 승격 준비 기준 checkout             | `efce531a690857790509fde5f851a9b72db1ee05` — 아래 검증 코드 이후 QA 근거를 보완한 문서 커밋. 새 제품 코드 검증 SHA로 대체하지 않음 |
| 검토한 베타 코드 | `4a605791b7f4680cc85d4718117d8db231c1d772` — 동일 작업 트리 검증 후 커밋. 확정12건 수정·별도 안정성 보강2건과 전체 단위·4종 coverage, 전체 Chromium+최종 영향 범위 검증 완료. 비Markdown1,809파일의 검증 중 동일성 확인. [코드·산출물 근거](design/beta-30-round-repair-2026-10-07.md) |
| 이전 발견 감사                     | Luna 조합 탐사 1,250개 통과·당시 새 확정 0건. D01 및 S01–S02 기본 수정 반영. 이후 극단값 감사에서 XS01–XS04 확정, 이번에 수정 |
| 후속 수동 싱크 수정                | S01 참가자별 시작 지연·S02 반복 직후 입력 대기를 `c3eae88c`에 반영. 이번 XS01·XS03 수정에서 긴 대기의 소유권·취소 경계 보완. 실기 첫 음 정렬은 별도 확인 대상. [기본 수정](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27) |
| 극단값 수동 싱크 수정              | XS01 시작 예약/일반 상태·새 명령 우선권, XS02 로컬 파일 실제 출력 지연, XS03 PRO 기기 자체 일시정지 유지, XS04 늦은 타이머 위치 보정. [수정·검증 기록](design/extreme-manual-sync-repair-2026-09-27.md) |
| 후속 전체 QA / 수정 상태           | FQA01 외부 시작 복구·PLAYING 응답 대기까지 동기화 소유권 유지. QA-T01 정확한 큐 수렴 대기, QA-T02–03 coverage 파일 선택 수정. 전체 E2E에서 발견한 반복 중 싱크 창 닫힘도 수정. 단위 10,264개·4종 coverage gate·Chromium 552개·WebKit 60개·프로덕션 smoke 10개 통과. [수정·검증 기록](design/beta-full-qa-repair-2026-09-27.md) |
| 후속 UI 수정                       | YouTube 상태 문구를 입력창 바로 뒤로 이동. 스켈레톤은 surface-3·불투명도 25–50%·1.6초 반복. 베타 반영 완료 |
| 시작 로고 후속 수정                | 분리된 획 대신 완성 실루엣·정확한 단일 nonzero 마스크로 리빌. 오버스캔 제거, 기존 순서·타이밍 유지. 단위 88개·Chromium 21개·WebKit 6개·프로덕션 산출물 smoke 9개 통과. 전체 스위트 재실행 아님 |
| 최신 전체 diff 감사                | 2026-10-06, main `35759e8b` → beta `1349825f`의 97 commits·404 files. 새 확정 런타임 결함 0건. 전체 unit 후 시간 초과 파일의 원래 기준 재검증으로 고유 10,637 pass, 선택 Chromium 54 pass·retry/skip 0. 전체 타입·lint·서식·production build·artifact guard 8개 통과. coverage·전체 E2E·실기 재검증은 아님. [최신 비교](design/main-beta-comparison-2026-10-06.md) |
| 후속 시퀀스 QA / 수정 — 2026-10-03 | main에도 재현된 SQ01 수정·검증 완료. 늦은 PREPARE에도 같은 활성 전송의 prefix만 유지. 통합 회귀 100개·관련 단위 2,896개·Chromium 33개 통과. [수정 근거](design/beta-sequence-qa-2026-10-03.md#repair-addendum--2026-10-03) |
| 최신 시퀀스 QA 2차 수정 — 2026-10-03 | SQ02–SQ04 재현 후 수정 완료. 전체 단위 실행 후 영향 범위 재검증으로 고유 10,425 pass, 최종 fail/skip 0. Chromium 12파일·62 pass, fail·skip·flaky 0 (retry 0). [발견·수정 근거](design/beta-sequence-qa-2026-10-03-round-2.md#repair-addendum--2026-10-03) |
| 최신 시퀀스 QA 3차 수정 — 2026-10-03 | SQ05 최신 적용 음향 설정 보존, SQ06 현재 적용 revision의 오류·종료 관측 전달 수정 완료. 고유 단위 10,458 pass, 최종 fail/skip 0. Chromium 9파일·50 pass, fail·skip·flaky 0 (retry 0). [발견·수정 근거](design/beta-sequence-qa-2026-10-03-round-3.md#repair-addendum--2026-10-03) |
| 최신 시퀀스 QA 4차 수정 — 2026-10-03 | SQ07 실패 곡 재선택 시 이전 출력 정리, SQ08 PRO slowmode 초안 보존, SQ09 재접속 전/중 HTTP PREPARE 수명 검증 완료. 전체 단위 후 영향 파일 재검증으로 고유 505파일·10,503 pass, fail/skip 0. Chromium 12파일·75 pass, fail·skip·flaky 0 (retry 0). [수정·검증·한계](design/beta-sequence-qa-2026-10-03-round-4.md#repair-addendum--2026-10-03) |
| 최신 시퀀스 QA 5차 발견 — 2026-10-03 | SQ10 정지 위치 손실, SQ11 취소된 볼륨 의도 재발행, SQ12 복구 중 채팅 허위 성공, SQ13 공유 종료 후 YouTube 임시정지 복원. 새 확정 4건·미수정. 기존 집중 단위 769개·추가 Worker 313개·Chromium 24개 통과; 실패 재현·독립 확인 별도. [증거·한계](design/beta-sequence-qa-2026-10-03-round-5.md) |
| 최신 시퀀스 QA 5차 수정 — 2026-10-03 | SQ10 정지 체크포인트 보존, SQ11 설정 필드별 의도 수명, SQ12 전송 거부 시 초안·로컬 상태 보존, SQ13 공유 전 재생 의도 복원. 전체 단위 508파일·10,606 pass, Chromium 15파일·98 pass; fail·skip 0, 브라우저 retry·flaky 0. [최종 검증·한계](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03) |
| 최신 시퀀스 QA 6차 발견 — 2026-10-03 | SQ14 PRO 반복·셔플 최초 조회 복구 시 새 조작 손실, SQ15 필수 조회 일시 실패 후 저장 재시도 누락. 새 확정 2건·미수정. PRO 새 프로브19 pass/4 fail(두 원인의 반복·셔플 변형), 실제 Worker 본문으로 독립 재현 일치. 파일343·YouTube/데모309·기존 PRO219·UI/계정403·Chromium18 pass. [증거·한계](design/beta-sequence-qa-2026-10-03-round-6.md) |
| 최신 시퀀스 QA 6차 수정 — 2026-10-03 | SQ14 최초 반복·셔플 의도 보존, SQ15 필수 조회 실패의 제한된 재시도, 충돌 후 조회 실패 시 거절된 의도 정리·새 조작의 최신 기준 조회. 전체 단위 510파일·10,637 pass, Chromium 3파일·11 pass; fail·skip 0, 브라우저 retry·flaky 0. [최종 검증·한계](design/beta-sequence-qa-2026-10-03-round-6.md#repair-addendum--2026-10-03) |
| 최신 시퀀스 QA 7차 — 2026-10-03 | 새 확정 0건. 파일·큐 변경·PRO 준비/COMMIT·YouTube 수동 싱크 후 제어·UI 수명 검사: 모듈/Worker 31파일·1,348 pass, Chromium 5파일·10 pass; 최종 fail/skip 0. 별도 강제 예외 주입 5 pass/3 fail은 실제 발생 경로 미입증 후보 1개로 분리. 제품 변경 없음. [증거·한계](design/beta-sequence-qa-2026-10-03-round-7.md) |
| 이전 전체 로컬 검증 — 2026-10-03 | 제품·검사 변경 없이 전체 unit 510파일·10,637 pass 및 4종 coverage gate, Chromium 79파일·568 pass, WebKit 66 pass/기존 3 skip, production smoke 10 pass. 기능 실패·retry·flaky 0. 전체 타입/lint/서식·소스 guard·산출물 guard 8개·Worker dry-run 6개 통과. 보안·cache-history gate 미통과 유지. [전체 결과·한계](design/beta-full-local-verification-2026-10-03.md) |
| 최신 대규모 QA — 2026-10-04 | 최초 unit/Chromium 각 1 fail을 QA-T04 시계·QA-T05 현재 위치 판정 오류로 입증·검사만 수정. 최종 전체 unit 510파일·10,637 pass 및 4종 coverage gate, Chromium 고유 568 pass(동일 Luna 25개 재검증 치환), WebKit 66 pass/기존 3 skip, production smoke 10 pass. 새 미디어/PRO 복합 프로브 41 pass·독립 확인. 정적 27명령 중 25 pass/기존 gate 2 fail, artifact guard 8개·Worker dry-run 6개 통과. [전체 결과·원본 실패·한계](design/beta-large-qa-2026-10-04.md) |
| 최신 후속 시퀀스 QA — 2026-10-04 | 새 모듈63 pass·독립 재실행 일치, 기존 선택18파일·고유1,014 pass, 새 Chromium18계획 pass/자동 retry·skip 0. 탐색 후 약2.3초 PCM 차이의 반복·자동복구 관측, FIFO2.3초 지연 대조3회 pass. 실제 teardown을 생략한 projection 진단1 fail은 공개 경로 미입증으로 분리; 실제 종료 대조군 통과. 제품 변경·새 확정 결함 없음, 전체 스위트 재실행 아님. [범위·관측·한계](design/beta-sequence-qa-2026-10-04-round-2.md) |
| 마지막 요청 QA — 2026-10-04 | 새 확정 제품 결함0건으로 추가 발굴 종료. 전체 unit510파일·10,637 pass, 새 모듈32 pass·독립 일치, Chromium선택43+native지연4 pass, WebKit66 pass/기존3 skip, production smoke9+1·artifact guard8개 pass. FIFO3.2초 지연에서 실제 hard 보정 후 수렴 관측; 이전 nominal transient 원인·실기 음향은 미확정. 제품·유지 검사 변경 없음. [최종 범위·증거·한계](design/beta-final-qa-2026-10-04.md) |
| 현재 보안 승격 gate | **통과 — 2026-10-07 후속 수정.** Miniflare의 sharp를 0.35.5로 패치해 전체/prod-only 감사 0건. 486개 registry 서명·103개 attestation과 분리된 새 설치/native 실행 검증. 기존 high3 패키지/단일 advisory 경고는 발견 기록에 보존. [후속 수정](design/beta-30-round-repair-2026-10-07.md) |
| 최신 보안 수정 QA — 2026-10-06 | 의존성 수정 `b0d55351`의 동일 작업 트리 검증 후 커밋. 전체 unit 510파일·10,637 pass, 선택 Chromium 17 pass, production artifact Chromium 9 pass; fail/skip/todo·browser retry/flaky 0. 타입·lint·서식·E2E/production build·artifact guard 8개·Worker dry-run 6개·installed loopback 20개 통과. coverage·전체 E2E·WebKit·실기/live·exact-main CI 재검사 아님. [상세 근거](design/beta-security-repair-2026-10-06.md) |
| 최신 독립 QA — 2026-10-07 | 발견 당시 Astra Ultra3×10세트·30/30완료, 확정12(P1 1/P2 8/P3 3)·미확정2·제외2. 선택365파일·고유8,716 pass. 당시 미수정 기록을 보존하고 현재 수정 상태는 다음 행을 따른다. [발견·최종 판정](design/beta-30-round-qa-2026-10-07.md) |
| 30라운드 후속 수정 — 2026-10-07 | 확정12건 수정·별도 보강2건. 최종 unit517파일·10,730 pass/4종coverage gate; 초기 빌드 Chromium83파일·580 pass, 최종 빌드 영향18/production17 pass, WebKit66 pass/기존3skip. R26 중복 안내 수정은 검증했으나 최초 legacy 승인 뒤 갱신 정지1회는 원인 미확정; 추가진단10/10통과로 지우지 않음. [수정·검증·한계](design/beta-30-round-repair-2026-10-07.md) |
| 제품 버전 / PWA 캐시                | 현재 App `8.7.5` / `v636` 배포 완료; 2차 QA 후속15건 및 QA helper 반영. 정확한 main CI candidate·버전/캐시 일치·운영 App generation/초기 asset graph 검증 통과 |
| 완료한 배포 범위                    | 최신 `target=all` / `0fc46bad`; App·PRO·remote-share·signaling·Developer API facade/backend6종 모두 exact git provenance 및100% version 최종 확인. PRO room-generation readiness는 같은 release SHA의 ready로 복구 |
| Developer API D1 입력               | `apply_developer_api_d1=false`; App의 일반 idempotent baseline·번역 등 기존 계약 적용·검증과 구분 |
| Operations Drift Audit              | `active` 유지; 최신 `8.7.2` 전체 검증의 `37595270795` 성공, 31 pass/0 fail/5 manual-only. 이전 `8.7.0` 배포 전후 실행 `37583844459`·`37584995408`은 과거 근거로 보존 |
| 최신 App main SHA / CI 후보 / 배포 실행 | `0fc46bad9233db6e7c9f7790d84052afbd53b6d8` / main CI `37839818477` attempt1 및 immutable candidate / Release `37840659848` attempt1 성공. 782파일 후보 hash·10개 운영 smoke·최종6Worker 소유권 확인 |
| 후속 App 패치 | `8.7.4`/`v635` 완료 — 1280px 이상 데스크톱 채팅 위쪽 여백 16px→12px, 모바일·다른 패딩 유지. 제품 `86ea0e8e` → PR #265/main `358b3fc3`, `app`/D1 false. 로컬 unit 10,781·production CSS 레이아웃 16조합·공개 CSS/SW hash 및 fresh ko 검증 통과 |
| 8.7.2 전체 검증·검사 보완 — 2026-10-07 | 테스트만 보완한 `716c37af`: 로컬 unit 518파일·10,781 pass, 원격 PR CI 10,780 pass/Windows 전용 1 skip·4종 coverage·candidate17·critical22, 실제 9게스트 R2 로컬/원격 통과. 기준 `61cedbc6` 전체 Chromium은 로컬/원격 각각581 pass; 최종 원격 WebKit66/기존3skip·SW1도 통과. 최초 R2 8/9 원인은 미확정. 최종 원격 Chromium도 581 pass/실패·retry 0. PR #251로 테스트·문서 게시, 제품·배포 변경 없음. [결과·실패·한계](design/full-verification-8.7.2-2026-10-07.md) |

**배포된 App은 `8.7.5` / `v636`, 배포 main SHA는 `0fc46bad`이다.** 6개 Worker를 같은
정확한 main CI 후보로 배포하고 모든 운영 smoke·최종 소유권·PRO ready를 확인했다.
이전 App8.7.4/시그널링99f9103c 기록은 이력으로 보존한다. [정식 배포 결과](design/beta-30-round-repair-2026-10-09.md#875-정식-배포-후속-기록--2026-10-09)를 따른다.

**2026-10-07 저녁 운영 R2 재검사:** `a1543f8b`의 유지 검사로 새 방 3회 중 2 pass / 1 fail.
추가 수동 관찰 진단 1회에서도 연결 9개·R2 경로는 정상이었으나 게스트 1개가 HTTP 200
후 본문 수신을 120초 안에 끝내지 못했다. 기존 90초 비활동 감지·1회 재시도 관련 120개와
혼합 전송 정책 14개는 통과했으며, 본문 미완료를 제품의 무한 대기로 단정하지 않는다.
과거 전체 검사 통과를 이 후속 실행의 올그린으로 표현하지 않는다. 제품·배포 변경 없음.
마지막 XHR 바이트 진단 1회는 GET 18개·다음 곡 재생·추가 GET 없음까지 통과했다.
현재 곡 수신은 기기별 약 2.1–69.6초로 차이가 컸다. 서로 다른 새 방 총 5회 중
3 pass / 2 fail이며, 성공한 방의 바이트 진행으로 이전 실패 원인을 소급 확정하지 않는다.
[운영 재검사·원본 증거](design/full-verification-8.7.2-2026-10-07.md#운영-r2-후속-재검사--2026-10-07-저녁).

**2026-10-07 운영 R2 원인 추적:** `aba657ed` 기준 추가 shared Chromium 진단은
게스트 1개의 현재 곡·프리로드 수신 합계가 126.590초여서 원래 120초 조건에 실패했다.
실패 순간에도 바이트가 증가했고 같은 요청이 뒤이어 완료됐다. 이 실행의 무한 대기는
아니지만, 앞선 두 본문 실패의 원인은 여전히 소급 확정 불가다. HTTP/2와 지연의
상관관계만 있으며 원인 입증은 아니다. 관련 tail 18 GET는 모두 200·outcome `ok`였다.
과거 유지 원격 job은 12개 중 10 success / 2 ICE 사전 조건 failure이며, 전체 workflow
초록불과 개별 비차단 R2 job 성공을 구분한다. 독립 프로세스 진단은 입장 20초 조건에서
실패한 뒤 약 8초 늦게 입장이 완료돼 전송 비교는 미완료다. 한 PC의 호스트 1·게스트 19
진단도 다운로드 120초 조건에서 fail: 게스트 2·9가 늦었으나 같은 요청으로 실패 후
약 8.1·27.8초에 프리로드까지 완료했고 최종 GET 38개를 모두 받았다. 다음 곡 전환은
미검사다. 정적 파일 대조는 HTTP/2·HTTP/3 모두 약 1초였으므로 프로토콜만으로
설명할 수 없다. 지연은 실제 관측한 품질 문제이며 물리 20기기·발생 확률 검증은 아니다.
새 확정 런타임 결함·제품 수정·배포는 없으며 timeout·정책을 완화하지 않았다.
[원인 추적·한계](design/full-verification-8.7.2-2026-10-07.md#운영-r2-원인-추적--2026-10-07).

**2026-10-07 앱을 제외한 R2 대조:** `233b478e`에서 준비한 같은 인증 객체의 native
XHR 직접 수신은 37 GET 중 34개 전체 완료·3개 180초 측정 timeout이었다. timeout도
종료 직전까지 바이트가 증가했다. 앱·미디어·동기화 없이 지연이 재현됐으나 브라우저·
네트워크·Cloudflare/R2 중 하위 원인은 미확정이다. 전부 실제 HTTP/2·초기 우선순위
`High`였고, 원래 120초 검사를 바꾸지 않았다. 스크립트 exit 0은 전체 전송 성공이 아니다.
원격 R2 job만 attempt 2로 재실행한 결과는 PUT 2개·완료 GET 18개·다음 곡 통과;
첫 PUT부터 마지막 본문까지 3.006초였다. 전체 suite 재실행이나 로컬 실패 해소는 아니다.
독립 browser 9개 대조도 2.251–94.764초 편차를 재현했고 단일 수신도 131.188초가
걸려 동시성·한 browser 공유가 필수 조건은 아니었다. 이후 사용자가 인터넷 경로를
바꾼 동일 객체 대조에서 핫스팟의 독립 9개는 전부 1.609–3.436초(HKG/NRT),
원래 Wi-Fi 복귀 후에는 3개가 99–146초·1개가 180초 측정 timeout(LAX)이었다.
원래 접속 경로와의 강한 연관성은 확인했지만 공유기·통신사·라우팅·Cloudflare/R2
중 정확한 원인 구간은 미확정이다. 제품·배포 변경 없이 측정 기록만 보완한다.
[직접 수신 대조·한계](design/full-verification-8.7.2-2026-10-07.md#앱을-제외한-r2-전송-대조--2026-10-07).

**2026-10-07 원격 신규 방 3회:** GitHub Ubuntu의 기존 운영 R2 job만 미리 정한
3회 재실행해 서로 다른 방 3/3 pass·자동 retry 0·PUT 6개/전체 GET 54개·다음 곡
승격 및 추가 GET 없음 통과. 각 방 호스트 1/게스트 9, 검사 SHA `716c37af`와 조사
시작 main `76e19a43` 사이의 차이는 문서뿐이다. 집 Wi-Fi의 장시간 지연은 이번
원격에서 미재현이나 물리 다기기·다중 지역·집 회선 원인 확정은 아니다. 전체 suite
재실행·제품·배포 변경 없음. [새 3회 결과·한계](design/full-verification-8.7.2-2026-10-07.md#github-원격-신규-방-3회-대조--2026-10-07).

**2026-10-08 한 세션 순차 수신:** 준비 SHA `aff88adb`, 기존 집 Wi-Fi·Windows·
Chromium에서 browser/context/page 각 1개를 유지해 같은 2,153,280바이트 파일을
캐시 없이 6회 순차 다운로드했다. 6/6 완료·SHA-256 일치·실패/timeout 0,
0.764–1.814초였다. 첫 HTTP/2 이후 HTTP/3 연결을 재사용했고 모두 LAX다.
이전과 객체·시각·프로토콜 상태가 달라 동시성이 유일한 원인이라고 확정하지 않는다.
제품·유지 테스트·배포 변경 없음. [결과·한계](design/full-verification-8.7.2-2026-10-07.md#한-세션의-순차-반복-수신--2026-10-08).

**2026-10-08 변인 대조:** 준비 SHA `7e025a94`, 집 Wi-Fi·H2·같은 객체/권한을
각 실험 안에서 유지했다. 한 세션의 순차/동시 ABBA는 36/36 완료·동일 연결/LAX,
9개 전체 구간 6.412/2.573/2.535/6.156초였다. 후속 한 세션/9세션 동시 대조도
36/36 완료했지만 같은 S 연결에서 53.991→16.916초, 중간 M은 13.912/15.146초였다.
빠른 CDP 헤더 뒤 본문 전달 지연을 관측했으나 정확한 하위 원인은 미확정이다.
최초 관측기 중단은 별도 보존하며 제품·유지 테스트·설정·배포 변경 없음.
[변인 대조·계측 한계](design/full-verification-8.7.2-2026-10-07.md#http2-고정-변인-대조--2026-10-08).

**2026-10-08 Worker 우회 대조:** 준비 SHA `f05b3779`, 집 Wi-Fi·Node H2에서 같은
소유 객체를 Worker와 Cloudflare R2 관리 API로 각각 수신했다. S3 직결 검사는 아니다.
기본 수신창 실행은 Worker 51/47초·관리 API 4.3/4.4초였지만, 스트림·연결 수신창을
각각 16MiB로 명시한 후속 실행은 3.3/2.5초·2.2/2.1초였다. 각 실행 본 36개·준비
2개 모두 전체 바이트/hash 일치·정리 성공. 관리 API의 후속 준비 수신 8.7초도 보존한다.
검사 클라이언트 조건과 LAX/ICN 경로 차이를 구분하며, 이전 Chromium 지연 원인은
미확정이다. 추측에 따른 제품 수정은 보류하고 제품·설정·배포를 유지했다.
[경로 대조·한계](design/full-verification-8.7.2-2026-10-07.md#동일-객체의-worker관리-api-경로-대조--2026-10-08).

**2026-10-08 합성 Worker 주소 대조:** 준비 SHA `5f857cc4`, 집 Wi-Fi·Chromium H2에서
앱·R2 없는 동일 Worker를 기존 도메인 임시 Route와 workers.dev로 비교했다. 본48+준비2
전체 수신/hash 일치, 두 주소 모두 LAX·동시9개 완료 약2.1–2.4초였다. 직후 기존 R2 대조도
본36+준비1 전부 완료·LAX·동시9개 2.594/2.817초로 빨랐다. 임시 Route·Worker 및 자체
R2 객체 정리 성공; DNS/인증서 생성 없음. 이번 시간대에 지연 미재현이며 과거 실패 해소나
원인 확정은 아니다. 다른 계정 비교는 미실행·추측성 제품 수정 보류 유지. App 배포 없음.
[합성 Worker·후속 R2 결과](design/full-verification-8.7.2-2026-10-07.md#앱저장소를-제외한-worker-주소-대조--2026-10-08).

**2026-10-08 두 계정 라우팅 대조:** 준비 SHA `8f30c5b9`, 같은 집 Wi-Fi·Chromium H2에서
기존 계정과 playground 계정의 동일 합성 Worker를 workers.dev로 비교했다. 새 브라우저
2회·두 번째 계정 순서 반전, 본96+준비4 모두 전체 수신/hash 일치·양쪽 모두 LAX였다.
동시9개 완료는 기존 1.832–2.652초·playground 2.222–2.401초. 계정별 각 회차 연결1개를
재사용했으므로 100개의 독립 경로 관측은 아니다. 양쪽 임시 Worker 삭제 확인, 운영 변경·
App 배포 없음. 계정 이전으로 ICN이 된다는 가설을 지지하지 않으며 과거 지연 원인은
미확정 유지. [계정 대조·준비 오류·한계](design/full-verification-8.7.2-2026-10-07.md#두-계정의-workersdev-라우팅-대조--2026-10-08).

**2026-10-08 원래 운영 앱 검사 1회 재확인:** 준비 SHA `0cee146f`, 같은 집 회선·Windows에서
호스트1·게스트9의 원래 R2 검사를 1회만 실행해 pass·retry0. PUT2·GET18 전체 수신,
현재 곡 2.757–4.599초·프리로드 1.161–3.347초, 다음 곡 재생/추가 GET 없음도 통과했다.
원래 제한 유지·지연 미재현이며 과거 실패와 하위 원인 미확정 판정은 유지한다. 제품·배포
변경 없음. [결과·한계](design/full-verification-8.7.2-2026-10-07.md#원래-운영-앱-검사-최종-1회-재확인--2026-10-08).

**2026-10-08 지연 이슈 최종 코드 검토·조사 종료:** `a221f2a4`의 클라이언트 전송·
프리로드/복구·Worker/R2·설정·SW·검사/실험 코드를 심층 검토했다. 이번 본문 지연을
설명할 새 확정 코드 결함0건, 관련 로컬19파일594pass/fail·skip0. 90초 정지 감시가
진행 중 수신을 허용하는 정책과 실제 느린 전송 원인은 구분한다. 원인 미확정/과거 실패를
보존하고 사용자 요청대로 조사 종료; 새 실험·제품 수정·배포 없음.
[최종 판단·검토 범위](design/full-verification-8.7.2-2026-10-07.md#최종-코드-심층-검토-및-조사-종료--2026-10-08).

**이전 `8.7.0` / `v631` 승격·배포 기록:** PR #245의 준비 SHA `fe0b0230`을
main `e8001e93`으로 병합하고, 그 정확한 SHA의 CI candidate를 `all`로 배포했다.
6개 Worker의 최종 소유권·PRO generation readiness·coherent-production marker와
모든 workflow smoke가 통과했다. 공개 자산 45개 hash·HTML 경로 10개·영어/한국어
fresh Chromium 확인도 통과했다. [배포·검증 기록](design/release-8.7.0-2026-10-07.md)은
최초 검사 실패와 후속 결과, 베타·PR·main·문서 후속 커밋의 역할을 구분한다.

R26의 중복 안내 수정은 검증했지만 최초 legacy Refresh 승인 뒤 갱신 정지 1회는
원인 미확정이다. 추가 진단 10/10 통과는 최초 관찰을 설명하지 못한다. 실제 기기
음향·혼합 방·기존 운영 탭/PWA·인증 경로의 미완료 확인과 drift 수동 5항목을 남긴다. 과거 QA의
발견 당시 실패·후속 수정·동결 상태는 3절과 누적 이력에 날짜별 증거로 보존한다.
이전 8.7.0 배포 종료 시에는 6개 Worker의 메시지를 모두 `git:e8001e93...`로 확인했다.
이 문서만 보완하는 후속 main 커밋을 새로운 배포 SHA로 해석하지 않는다.

### 시그널링 오류 진단 보강 배포 완료 — 2026-10-08

- 사용자가 최근 24시간 Worker 예외 3건, 최근 7일 10건을 확인한 뒤 안전한 진단
  보강을 승인했다. 과거 오류의 원인·사용자 영향·QA 연관성은 미확정이며,
  이번 변경을 그 원인의 수정이나 서비스 무결성 입증으로 표현하지 않는다.
- `signaling`만 배포한다. App `8.7.4` / `v635`와 다른 Worker는 유지하며
  앱 업데이트 모달·프로토콜·연결/재시도 정책·D1 schema·secret·binding 변경은 없다.
  Developer API D1 적용은 false. 이전 시그널링 기준은 `e8001e93`이다.
- fetch/메시지/close/error/alarm/초기화 및 기존 background 경고에 오류 전용
  `[SignalingDiagnostic]`을 추가한다. 원래 오류 객체와 동기 auth/PIN 수신 순서를
  보존한다. 로그는 정적 operation/object family/처리 여부, 버전 UUID, 허용된
  오류 분류·provider flag·제한된 코드 좌표만 포함한다. 민감정보 원문은 출력하지 않는다.
- 시그널링만 sampling 0.1→1, invocation 로그·자동 traces는 계속 비활성화한다.
  provider 자체 uncaught 기록·보존 한계는 별도다. 한 오류의 초기화/전파/재시도
  기록이 여러 개일 수 있어 고유 사고·사용자 수로 합산하지 않는다.
  상세 운영 지침은 [오류 진단 runbook](../cloudflare/config-drift-ops.md#signaling-exception-investigation)을 따른다.
- `target=signaling`에도 Standard HTTPS fallback smoke를 배포 gate로 포함한다.
- 런타임 `b55f2e55`, 후속 소스 가드 `4374dcd95aba1e6349d7f58cb825b5b64c8ab92d`.
  Windows/Node24.20.0/npm12.0.2에서 최종 전체 unit 519파일·10,810 pass,
  fail/skip 0. Worker coverage 27파일·1,752 pass 및 전체/개별 기준 통과
  (statement 84.32%, branch 80.84%, function 92.76%, line 88.97%).
  타입·lint·서식·Worker 경계·D1/ops-drift 계약·6개 Worker dry-run 통과.
  추가 테스트는 오류 주입/원본 재전파·즉시 ingress·정상 close/error·poll abort499·
  bounded privacy summary·배포 및 소스 가드 우회 방지를 검증한다.
- 최초 전체 unit은 10,803 pass/2 fail이었다. 진단 wrapper 도입 후 기존 소스 가드가
  공개 라우터 본문 대신 wrapper를 검사한 원인으로, wrapper의 정확한 구조를 검증한
  뒤 실제 본문에 기존 검사를 적용하도록 수정했다. guard 19개 및 최종 전체 unit으로
  재검증했으며 assertion 제거·timeout 완화는 없다. 독립 런타임 리뷰의 내부 cleanup
  중복 기록과 AggregateError 배열 메서드 신뢰 문제도 수정·검증했다.
- 로컬 근거는 ignored `scratch/signaling-diagnostics-2026-10-08/`에 보존한다.
  최종 커밋의 `build:checked`도 통과했다. 전체 브라우저 E2E·실기·실제 운영 오류
  재현은 수행하지 않았다. 원격에서는 필수 browser/candidate gate를 통과했다.
- [PR #267](https://github.com/hiefny/MUSIXQUARE/pull/267)의
  [CI `37763147383`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37763147383)는
  11개 job 모두 성공했다. 원격 전체 unit은 10,809 pass/Windows 전용 기존 1 skip이며,
  로컬의 10,810 pass와 구분한다. 독립 리뷰에서 병합 차단 사항은 없었다.
- 정확한 main `99f9103c7e5da24e990082b071897eccb80ad504`의
  [CI `37763992689`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37763992689)는
  attempt 1의 Types job이 검사 실행 전 Corepack의 npm 12.0.2 registry 조회 중
  `UND_ERR_SOCKET` / `other side closed`로 실패했다. 코드 변경 없이 실패 job만
  재실행한 attempt 2에서 전체 11개 job 성공. 통과한 sibling 결과와 동일 run의
  immutable candidate를 보존한 정상 절차이며 최초 실패를 없었던 것으로 취급하지 않는다.
- [Release `37764975511`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37764975511)
  성공, 2026-10-08 19:42:24 KST 완료. `target=signaling` / Developer API D1 false.
  시그널링 deployment `8ebd4423-0823-44cc-aeab-95774f874981`, 100% version
  `09342092-1e16-4f12-ab62-9b568592591b`, 메시지 `git:99f9103c7e5da24e990082b071897eccb80ad504`.
  WebSocket smoke·Remote Share host assertion·Standard HTTPS fallback 모두 첫 실행에
  통과했다. 최종 deployment 소유권·Custom Domain·부분 배포 호환성 확인도 성공.
  recovery는 skip, rollback은 없었다. 배포 뒤 다른 5개 Worker의 deployment ID를
  개별 조회해 모두 이전 값과 동일함을 확인했다.
- 배포 후 운영 대시보드에서 Workers logs 활성·대시보드 보존 활성·sampling 100%,
  invocation 로그 꺼짐·traces 꺼짐·Issues 감지 꺼짐을 직접 확인했다. 코드 가드만으로
  live 설정을 확인했다고 표현하지 않는다. 추후 오류가 생기면 안전한 diagnostic과
  provider 예외를 같은 시각·버전으로 대조한다. 과거 10건의 원인과 실제 영향은 여전히 미확정.
- 복구 기준은 이전 시그널링 `e8001e93` / version `440b001f-986d-44ae-8ebd-ee2d3fb00cc9`이며
  immutable checkpoint와 canonical hotfix 절차를 따른다. 복구 시 로그 sampling도
  복구한 코드의 Wrangler 계약과 일치하는지 확인하고 invocation/traces off를 유지한다.
  이 후속 기록은 문서만 변경하며 새 App 또는 Worker 배포를 요구하지 않는다.

### 후속 App 패치 배포 완료 — 8.7.4 / v635, 2026-10-08

- 코드 `86ea0e8efb25ba2fe6fef2030999c606e68963e0`: 1280px 이상 데스크톱의
  `.chat-drawer-messages` 위쪽 패딩을 16px에서 12px로 줄여 메시지 사이 간격과 맞춘다.
  일반·시스템 메시지 모두 같은 컨테이너 규칙을 적용한다. 모바일 위쪽 패딩 16px,
  좌우·아래 패딩 16px, 메시지 간격 12px와 시스템 말풍선 내부 위아래 패딩 10px는 유지한다.
- Windows/Node24.20.0/npm12.0.2에서 위 코드의 전체 unit 10,781개(fail/skip 0),
  타입·lint·서식·Worker 경계·D1/ops-drift 계약·문법 검사와 `build:checked` 통과. 해당 production CSS를
  사용한 격리된 offline Chromium DOM에서 1280/1440px 데스크톱과 1279/390px 모바일,
  LTR/RTL·dark/light의 16조합을 모두 통과했다. 위쪽 여백은 데스크톱 12px·모바일 16px,
  메시지 간격 12px·시스템 내부 위아래 10px·좌우/아래 16px 유지, page error 0을 확인했다.
  이 레이아웃 검증은 격리된 DOM의 CSS 검사이며 전체 앱 E2E·실기 검증으로 해석하지 않는다.
  JSON·PNG 근거는 ignored `scratch/chat-top-spacing-2026-10-08/layout-2026-10-08T04-37-35.442Z/`에 보존한다.
- 배포 범위는 `app`/Developer API D1 false. 의존성·정책·DB migration·secret·binding·
  미디어/서버 계약 변경 없음. 복구 기준은 이전 App `8.7.3`/`v634`의
  `10be9957c1e586d315f36bff1edf95191ddf1656`이며 다른 5개 Worker는 `e8001e93`을 유지한다.
- [PR #265](https://github.com/hiefny/MUSIXQUARE/pull/265)의
  [CI `37728546626`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37728546626)와
  정확한 main `358b3fc39c08b3442aa495d4fa52c1eb0a97a871`의
  [CI `37729046851`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37729046851)는
  각각 11개 job 모두 성공했다. 그 main의 immutable candidate를 배포했다.
- [Release `37729556678`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37729556678)
  성공, 2026-10-08 13:54:37 KST 완료. 최종 App deployment
  `e0a08a0e-10b7-4ac4-8b27-c3a3523acf64`, 100% version
  `1a8bf0fc-7775-4b47-aba8-2d26e5494708`, 메시지 `git:358b3fc39c08b3442aa495d4fa52c1eb0a97a871`.
  App 최종 소유권·선택된 release smoke·다른 5개 Worker의 deployment/version 유지와
  부분 배포 호환성 확인을 통과했다. 정상 성공으로 recovery job은 skip, rollback 없음.
- 공개 확인은 첫 실행에서 통과했다. fresh Chromium ko-KR/1280px에서 bootstrap 52/0fail/0fallback,
  page error 0·E2E hook 부재·active SW/cache `v635`, 실제 위쪽 패딩 12px·간격 12px·
  좌우/아래 패딩 16px를 확인했다. `/assets/main-DeZptvTU.css` 241,159바이트와 전체 SW의
  SHA-256이 로컬 production 산출물과 각각 일치했다. JSON·PNG 및 배포 근거는 ignored
  `scratch/chat-top-spacing-2026-10-08/`의 `public-2026-10-08T04-54-53.397Z/`와
  `release-artifacts/`에 보존한다. 기존 실기·기존 운영 탭/PWA 한계와 R2 원인 미확정/조사 종료는 유지한다.

### 후속 App 패치 배포 완료 — 8.7.3 / v634, 2026-10-08

- 코드 `08ea35d32b44118366f420db1527776171ca05e3`: YouTube 검색의 한 줄 제목에도
  두 줄 높이를 예약하던 스타일을 메타데이터 묶음의 최소 높이로 옮겼다. 제목과 채널명은
  기존 4px 간격으로 붙이고 함께 가운데 정렬한다. 행·썸네일 높이, 긴 제목의 두 줄 제한,
  스켈레톤 색·모션·행 높이는 유지한다.
- Windows/Node24.20.0/npm12.0.2에서 Chromium 검색 E2E 7개 통과(fail/skip/retry0).
  데스크톱·모바일·RTL의 짧은/긴 제목, 스켈레톤 전후 행·썸네일 안정성을 검증하고
  스크린샷을 확인했다. 전체 타입·lint·서식·Worker 경계 검사와 커밋 후 `build:checked`
  통과. 전체 unit 518파일 실행은 10,780 pass/0 fail/1 skip(jq 경로 미설정)이었고,
  기존 로컬 jq를 지정해 그 1개를 통과시켜 고유 10,781개를 확인했다. 최초 로컬 검사
  runner의 Windows 로그 경로 오류로 누락된 서식/경계 4명령도 경로를 고쳐 전부 통과했다.
- 배포 범위 `app`/Developer API D1 false. 새 의존성·DB·secret·binding·미디어/서버
  계약 변경 없음. 이전 App `94fa5b03`/8.7.2가 복구 기준이며 다른 5개 Worker의
  `e8001e93` 기준은 유지한다. R2 지연 원인 미확정/조사 종료와 기존 실기 한계는 유지한다.
- [PR #263](https://github.com/hiefny/MUSIXQUARE/pull/263)의
  [CI `37721971690`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37721971690)와
  정확한 main `10be9957c1e586d315f36bff1edf95191ddf1656`의
  [CI `37722363300`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37722363300)는
  각각 11개 job 모두 성공했다. 전체 unit/4종 coverage·critical browser·production
  candidate 검증을 포함하며, 이번 로컬 검색 E2E를 전체 E2E/실기 검사로 해석하지 않는다.
- [Release `37722846236`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37722846236)
  성공, `app`/D1 false. 배포 job은 2026-10-08 12:30:16 KST 완료.
  최종 App deployment `59f0f7fa-9174-4b75-8846-9eca2e7c6021`, 100% version
  `5616405f-8e02-422f-885e-e919ea97e80d`, 메시지 `git:10be9957c1e586d315f36bff1edf95191ddf1656`.
  mutation 전 이전 App `94fa5b03`의 checkpoint를 보존했고 다른 5개 Worker의
  `e8001e93` deployment/version 유지·부분 배포 호환성 재확인·최종 App 소유권 검사가
  통과했다. App generation·익명 계정 경계·현재 PRO 공개 경계·Standard HTTPS signaling
  fallback smoke와 coherent-production marker 확인. scope 밖 smoke는 skip이며 rollback 없음.
- 공개 확인: fresh native Chromium ko-KR에서 bootstrap 52/0fail/0fallback, page error0,
  E2E hook 부재, HTML/SW/cache `v634`, 새 메타데이터 배치 규칙을 확인했다. 실제 수신한
  `/assets/main-DMB19Xjx.css` 241,142바이트의 SHA-256이 동일 코드의 로컬 production
  산출물과 일치했다. 최초 조회기는 legacy CSS의 `:not(#\#)` 선택자 확장을 처리하지
  못했으나 실제 CSS hash는 이미 일치했고, 조회기만 보완한 재검사에서 통과했다.
  실제 기존 탭/PWA 업데이트·기기별 렌더링은 별도이며 새 R2 지연 실험은 하지 않았다.
  로컬 근거는 ignored `scratch/youtube-search-spacing-2026-10-08/`에 보존한다.

### 후속 App 패치 배포 완료 — 8.7.2 / v633, 2026-10-07

- 코드 `7ac402139147d91d3f86a12cb6d9e6ab49d639bf`: 사용자 요청으로 YouTube BETA
  배지와 그 전용 배치 CSS 제거. 한국어의 브랜드 표기 4곳을 `YouTube`로 통일;
  다른 41언어는 이미 같은 표기다. 입력 힌트 줄바꿈과 기존 제한 안내는 유지한다.
  시스템 오디오·언어 선택의 기존 BETA 배지는 유지하며 개수 검사를 2개로 맞췄다.
- `8.7.2`/`v633`, 배포 범위 `app`/Developer API D1 false. 새 의존성·DB·secret·
  binding·서버/미디어 계약 변경 없음. 이전 App `f005a706`/8.7.1이 복구 기준이며,
  다른 5개 Worker의 `e8001e93` 기준과 기존 실기·운영 미확인 항목은 유지한다.
- Windows/Node24.20.0/npm12.0.2에서 동일 코드의 관련 단위 8파일 153개 통과.
  전체 타입·lint·서식과 커밋 후 `build:checked` 통과. 최종 production 산출물의
  좁은 화면 5조합도 통과했다. 이 로컬 결과는 전체 스위트·실기 검증과 구분한다.
- [PR CI `37592284335`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37592284335)
  성공 뒤 [PR #249](https://github.com/hiefny/MUSIXQUARE/pull/249)를 main
  `94fa5b03695122d1cf6b39d9e7a5374ec6e11e09`으로 병합했다. 정확한 main의
  [CI `37592984640`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37592984640)도
  성공: unit 10,729 pass/기존 Windows 전용 1 skip, 4종 coverage gate,
  Chromium 17+22 pass. candidate는
  `production-candidate-94fa5b03695122d1cf6b39d9e7a5374ec6e11e09-37592984640-1`,
  manifest SHA-256은 `5c88d037c5e2478db104cba0a5a46ba86c9ca691cfe06040d4404d514c5b723a`다.
- [Release `37593498828`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37593498828)
  성공, `target=app`/D1 false. 배포 job 완료는 2026-10-07 08:25:48 UTC
  (17:25:48 KST). 최종 App deployment `fbace026-da5f-45ca-aaa4-36fb150aa6ce`,
  100% version `08821e3c-3a6f-408c-b0e4-e53af03d3585`, 메시지
  `git:94fa5b03695122d1cf6b39d9e7a5374ec6e11e09`의 소유권 검사가 통과했다.
  mutation 전 checkpoint에 이전 App deployment `eeab1ac4-cd94-415a-a179-a320930b468d`,
  version `dfc661b6-b8d3-45e5-88c6-308dde8f6c14`/`git:f005a706...`를 보존했다.
  다른 5개 Worker의 deployment·version·`git:e8001e93...`는 그대로이며 부분 배포
  호환성 재확인이 통과했다. App generation·익명 계정 경계·현재 PRO 공개 경계·
  Standard HTTPS signaling fallback smoke와 최종 소유권 검사가 통과했고,
  `app`/`94fa5b03` coherent-production marker를 보존했다. 선택하지 않은 Worker의
  별도 smoke와 PRO generation readiness 복원은 scope상 skip이며 rollback은 없었다.
  Release 첨부의 `app-final-current.json`, `partial-release-compatibility-recheck.json`,
  `final-verification-report.json`, `recovery-checkpoint.json`, `production-committed.json`이 원본 근거다.
- 공개 검증: locale JSON 40개를 포함한 45개 자산 SHA-256이 정확한 CI candidate와
  일치했고 ko/ja/ar HTML 3경로가 200이었다. fresh native Chromium en-US/ko-KR에서
  소스 이름 `YouTube`, YouTube BETA 제거, 한국어 힌트 `YouTube 링크 또는 검색어`,
  placeholder `white-space: normal`, bootstrap ready·page error 0·E2E hook 부재와
  `v633` static/optional/runtime cache를 확인했다. 실제 기존 탭/PWA 업그레이드·
  방 동작·인증·실기 확인을 대신하지 않는다. R26 미확정 관찰·운영 수동 5항목은 유지한다.

### 이전 App 패치 배포 완료 — 8.7.1 / v632, 2026-10-07

- 코드 SHA `10feecac148291dbb54f4cb436fc6dc64d9e6490`: 42개 언어의 YouTube
  입력 힌트를 링크·검색어 모두 안내하는 짧은 문구로 변경. 기존 자연스러운 줄바꿈을
  유지하며 말줄임·줄 수 제한은 추가하지 않았다. 소스 선택의 호환 모드 표기는 기존
  디자인의 BETA 배지로 대체하고 역할·음향 효과 제한 안내는 유지했다.
  좁은 소스 선택 버튼에서는 배지가 다음 줄로 내려가 이름이 글자 단위로 쪼개지는
  것을 피한다. 입력창의 줄바꿈에는 새 제한이 없다.
- `8.7.1`/`v632`와 bootstrap cache query·admin 버전 mirror를 함께 변경했다.
  배포 범위는 `target=app`, `apply_developer_api_d1=false`. 8.7.0의 누적 `all`
  배포는 완료됐으며 이번 패치에 다시 적용하지 않는다. 새 의존성·DB·secret·binding·
  미디어/서버 계약 변경은 없다. Operations Drift Audit은 active를 유지한다.
- Windows/Node 24.20.0/npm 12.0.2에서 번역·UI·검색·release identity 관련
  7파일 142개, 기존 Chromium 검색 E2E 7개가 통과했다(배지 줄바꿈 CSS 보완 전
  `5929e9a4`). 42언어 320px 및 대표 7언어 390/1440px의 렌더링 56조합에서
  입력 힌트의 정상 줄바꿈·넘침 없음과 배지 디자인·RTL을 확인했다. 최초 320px의
  YouTube 이름 쪼개짐은 배지 줄바꿈 CSS로 보완하고 3언어×4폭 12조합을 재확인했다.
  기존 중국어 2종 설명문의 본문 경계 초과 15px는 화면 내 표시되며 이번 변경과
  무관해 보존했다. 렌더링 검사는 작성된 창을 DOM으로 표시한 검사이며 실기·방
  동작 검증이 아니다. E2E build·전체 타입·lint·서식과 `10feecac` 커밋 후
  `build:checked` 통과. 최종 production 산출물도 CSS 주입 없이 4조합 통과했다.
  최초 PR CI `37588348701`에서 기존 branding 검사의 배지 개수 2개 기대가 1건
  실패했다. 요청한 새 배지로 3개가 된 점에 맞춰 기존 검사만 수정했고, 관련
  3파일 44개를 재검증했다(위 142개와 일부 중복). 새 유지 테스트는 추가하지 않았다.
  이 로컬 검증을 전체 스위트와 최종 main SHA 검증으로 확대 해석하지 않는다.
- 수정 후 [PR CI `37589034344`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37589034344)
  성공 뒤 [PR #247](https://github.com/hiefny/MUSIXQUARE/pull/247)을 main
  `f005a70645fb6b115a3465346b5f22d4d83d4e1a`으로 병합했다. 정확한 main의
  [CI `37589560758`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37589560758)도
  성공: unit 10,729 pass/기존 Windows 전용 1 skip, 4종 coverage gate,
  Chromium 17+22 pass. candidate는
  `production-candidate-f005a70645fb6b115a3465346b5f22d4d83d4e1a-37589560758-1`,
  manifest SHA-256은 `c1b0008b33015b70425951c3ed7e42582b82305cd2aaa1ccffc6cfef1ea672c9`다.
- [Release `37590255149`](https://github.com/hiefny/MUSIXQUARE/actions/runs/37590255149)
  성공, `target=app`/D1 false. 배포 job 완료는 2026-10-07 07:57:14 UTC
  (16:57:14 KST), run 최종 갱신은 07:57:15 UTC다. 최종 App deployment
  `eeab1ac4-cd94-415a-a179-a320930b468d`, 100% version
  `dfc661b6-b8d3-45e5-88c6-308dde8f6c14`, 메시지
  `git:f005a70645fb6b115a3465346b5f22d4d83d4e1a`를 최종 소유권 검사로 확인했다.
  mutation 전 recovery checkpoint를 첨부·보존했고, 기존 App version
  `6b0fe9bc-4382-4944-9c92-e9afe109668a`/`git:e8001e93...`를 기록했다.
  PRO·remote-share·signaling·Developer API facade/backend 5개 Worker는 기존
  deployment·version·메시지가 그대로이며 배포 직전 호환성 재확인도 통과했다.
  App generation·익명 계정 경계·현재 PRO 공개 경계·Standard HTTPS signaling
  fallback smoke가 통과하고 `app`/`f005a706` coherent-production marker를 보존했다.
  선택하지 않은 Worker의 별도 smoke와 PRO generation readiness 복원은 scope상
  skip이며 rollback은 없었다. Release 첨부의 `app-final-current.json`,
  `partial-release-compatibility-recheck.json`, `final-verification-report.json`,
  `recovery-checkpoint.json`, `production-committed.json`에 원본 근거가 있다.
- 공개 검증: locale JSON 40개를 포함한 45개 자산의 SHA-256이 정확한 CI candidate와
  일치했고 ko/ja/ar HTML 3경로가 200으로 응답했다. fresh native Chromium
  en-US/ko-KR 모두 bootstrap ready, fallback·실패·page error 0, 변경된 입력
  힌트·소스 이름·BETA와 placeholder `white-space: normal`, `v632`의
  static/optional/runtime cache, E2E hook 부재를 확인했다. 이전 8.7.0의 최초
  공개 fetch 문제는 이번에 관측되지 않았다. 실제 기존 탭/PWA 업그레이드·방 동작·
  인증·실기 확인을 대신하지 않는다.
- 기존 8.7.0의 R26 미확정 관찰·실기·수동 운영 확인 한계는 그대로다. 이번 문구
  패치 복구 기준은 이전 8.7.0 App과 정식 workflow의 소유권·호환성 checkpoint다.
  아래 베타 누적 범위·과거 검증은 8.7.0 승격 당시의 기록이다.

## 2. 이전 8.7.0 베타 승격에 함께 반영한 범위

| 변경 묶음                              | 배포 시 반영·확인할 것                                                                                                                        | 근거                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 30라운드 후속 확정12·보강2 | App의 재생/시계/포커스/검색/언어·폰트/PWA/진단·파일 수신과 번역 편집기 변경. 같은 빌드의 hashed locale JSON 40개를 App과 함께 배포. Miniflare 하위 sharp 패치. 새 D1·secret·binding·서버 API 변경 없음. | [후속 수정·검증](design/beta-30-round-repair-2026-10-07.md), [언어 진입/복구 계약](localized-app-entry.md), [번역 제출 계약](account-auth-operations.md#translation-community-tables) |
| 대용량 로컬 오디오 하이브리드 엔진     | 일반 파일은 기존 엔진, 큰 파일만 구간 디코딩. 새 지연 로딩 번들·WASM·라이선스 자산을 App 빌드에 포함. 작은 곡 복귀와 서로 다른 엔진 조합 확인 | [엔진 구현·검증 기록](design/large-local-audio-streaming-proposal.md), [RAM-only 정책](design/browser-media-storage-policy.md), [서드파티 고지](../THIRD-PARTY-NOTICES.md) |
| 파일 전송·프리로드·동기화·세션 수명 QA | 현재 곡 우선 전송, 이전 작업 취소, 신규 참여·재접속·권한 변경, 수동 싱크·곡 끝 경계 등을 최신 App에 반영                                      | [시퀀스 QA](design/sequence-qa-2026-09-23.md), [QA20](design/beta-qa-2026-09-27-round-20.md), [QA21](design/beta-qa-2026-09-27-round-21.md), 나머지 회차는 같은 디렉터리   |
| 데모·설정 UI·YouTube 검색              | 데모 스펙트럼 고정과 앱 설정 분리, 효과 UI 복원, 입력 포커스·검색 스켈레톤·빠른 추가, 마키 변경 포함                                          | [초기 베타 QA](design/beta-qa-2026-09-26.md), 관련 `e2e/` 회귀 테스트                                                                                                      |
| 시작 로고 리빌                        | App HTML·CSS·기존 `/wordmark-anim.js`를 함께 반영. 한 마스크로 획 연결부를 그리며 미진행 획으로 확장하지 않음. 새 의존성·Worker 계약 없음 | [런타임](../browser/classic-runtime/wordmark-anim.ts), [브라우저 회귀](../e2e/wordmark-reveal.test.ts) |
| 리버브 최대 10초                       | App, PRO Worker, Developer API backend/facade, 공개 OpenAPI를 함께 반영. 예전 30초 검증기가 남지 않도록 확인                                  | [공통 효과](../src/core/room-effects.ts), [PRO 효과](../cloudflare/pro-room-effects.ts), [OpenAPI](../public/developers/openapi.yaml)                                      |
| 로그인 쿠키 응답 소유권                | App Worker 배포가 필요. 늦은 로그아웃·탈퇴 응답이 새 로그인을 지우는 문제 수정. 기존 쿠키 읽기 호환 유지                                      | [쿠키 수정·검증](design/account-cookie-ownership-2026-09-27.md), [계정 운영](account-auth-operations.md)                                                                   |
| 일괄 발굴 결함 B01–B04                 | PRO YouTube 저장본 구분, 채팅 금지 후 초안 보존, 번역 내보내기, 짧은 파일 종료. 클라이언트와 App Worker를 함께 반영                           | [수정·회귀 기록](design/beta-defect-repair-2026-09-27.md) |
| 2차 발굴 결함 C01–C03                 | PRO 공유 종료 후 YouTube 복귀, 일반방 프리로드 종료 순서·진행 시간 제한, 탈퇴 작성자 추천 차단. App 클라이언트와 App Worker 반영 | [2차 수정·회귀 기록](design/beta-defect-repair-2026-09-27-round-2.md) |
| 3차 발굴 결함 D01                     | PRO live 공유 중 신규 입장의 오래된 스냅샷 복원 취소. App 클라이언트만 추가 변경 | [4차 발굴·D01 수정](design/beta-defect-harvest-2026-09-27-round-4.md) |
| YouTube 수동 싱크 S01–S02             | 다음 곡·반복 시작에서 음수 보정 유지, 일반방 반복 직후 입력의 새 snapshot 대기. App 클라이언트만 변경; UI·메시지·서버 계약 유지 | [발견·수정·검증](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27) |
| 극단값 수동 싱크 XS01–XS04           | 예약 시작과 일반 동기화/새 명령의 소유권, 로컬 파일 음수 출력 대기, PRO 기기 일시정지·늦은 시작 보정. App 클라이언트만 추가 변경; UI·공유 시각·서버 계약 유지 | [후속 수정 기록](design/extreme-manual-sync-repair-2026-09-27.md) |
| 전체 QA 후속 FQA01·QA-T01–QA-T03      | YouTube 외부 복구·재생 응답 대기의 동기화 소유권, 새 명령·재진입·중도 입장 경계 보완. E2E 큐 수렴 대기와 coverage 파일 선택 수정. App 클라이언트·검사만 추가 변경; 일반 UI·정책·Worker 계약 유지 | [전체 QA 후속 수정 기록](design/beta-full-qa-repair-2026-09-27.md) |
| 직결 파일 수신 SQ01                  | 같은 활성 수신의 지연 PREPARE가 받은 파일 앞부분을 지우지 않도록 App 수신 상태 보존. 이전 미디어 정지·START 검증 유지. UI·프로토콜·Worker 계약 변경 없음 | [시퀀스 QA 수정 근거](design/beta-sequence-qa-2026-10-03.md#repair-addendum--2026-10-03) |
| 이어받기·외부 전환·YouTube 준비 SQ02–SQ04 | 늦은 RESUME의 실제 진행 보존, 외부 소스로 전환한 파일 복구 수명 종료, 준비 중 최신 탐색·재생 의도 보존. App 클라이언트만 변경; UI·정책·메시지·서버 계약 유지 | [2차 시퀀스 수정 근거](design/beta-sequence-qa-2026-10-03-round-2.md#repair-addendum--2026-10-03) |
| 데모 실패 복원·PRO 관측 SQ05–SQ06 | 데모 진입 실패 시 새로 적용된 방 음향 설정 보존, PRO 현재 미디어의 오류·종료 관측을 snapshot 지연 중에도 전달. 이전 revision·권한·세션 보호 유지. App 클라이언트만 변경; UI·정책·서버 계약 유지 | [3차 시퀀스 수정 근거](design/beta-sequence-qa-2026-10-03-round-3.md#repair-addendum--2026-10-03) |
| 실패 곡 재선택·PRO 채팅·재접속 SQ07–SQ09 | 일반방 실패 곡 선택은 이전 출력만 정리하고 재디코딩하지 않음. PRO 일반 채팅 UI를 기존 서버 slowmode 정책과 일치시키고, 오래된 HTTP PREPARE의 복구 후 부활 차단. App 클라이언트·검사만 추가 변경; UI 구성·서버 정책·프로토콜 유지 | [4차 시퀀스 수정 근거](design/beta-sequence-qa-2026-10-03-round-4.md#repair-addendum--2026-10-03) |
| 정지 위치·설정 의도·채팅 거부·공유 복원 SQ10–SQ13 | 같은 유효 파일 세션의 PAUSE 보존, PRO 취소 필드의 재발행 방지, 알려진 전송 거부 시 초안 보존, YouTube 임시정지와 실제 재생 의도 구분. App 클라이언트·검사만 추가 변경; UI 구성·서버 정책·프로토콜 유지 | [5차 시퀀스 수정 근거](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03) |
| 반복·셔플 조회 복구 SQ14–SQ15 | 최초 조회의 필드별 조작 보존, 필수 GET의 제한된 재시도, 충돌 거부 의도 정리와 새 의도의 최신 기준 조회. App runtime·검사만 추가 변경; UI·서버 정책·계약 유지 | [6차 시퀀스 수정 근거](design/beta-sequence-qa-2026-10-03-round-6.md#repair-addendum--2026-10-03) |
| 운영 감사의 빈 도메인 목록 처리        | 수정된 감사 스크립트가 main에 들어간 뒤 원격 감사 재확인. 이 수정만으로는 App 배포·업데이트 모달이 필요하지 않음                              | `9255269f`, [감사 스크립트](../scripts/audit-ops-drift.mts)                                                                                                                |
| 개발 의존성 보안 패치 — 2026-10-06 | 감사 13패키지 → 0. 부모별 Undici/brace 호환 버전과 나머지 하위 패치 적용. 운영 lock 46노드·직접 의존성·Wrangler/Miniflare/workerd 유지. 별도 데이터/서버 계약·배포 대상 추가 없음 | [보안 수정·재검증](design/beta-security-repair-2026-10-06.md) |

8.7.0 승격 전 서버 코드 차이는 `account-auth.ts`, `translation-community.ts`, `pro-room-effects.ts`,
`developer-api-worker.ts`, `developer-api-facade-worker.ts`였다. 당시 App만 배포하면
리버브 검증 계약이 일부 서버에 남으므로 워크플로의 단일 실행으로 모두
반영하기 위해 **`all`**을 사용했다. 변경이 없는 signaling·remote-share도 그 실행에
포함되므로, 최종 대상과 복구 checkpoint는 정식 워크플로가 검증하게 한다.
partial-release gate는 선택하지 않은 Worker에 남는 runtime 차이도 거부한다.
후속 8.7.1·8.7.2는 1절의 `app` 범위를 따르며, 이후 새 배포는 live SHA와 서버 의존성으로
범위를 다시 판정한다.

### 데이터·호환성 경계

- 위 코드 기준 새 D1 SQL/manifest, DO migration, Wrangler binding, secret,
  계약 버전 marker 변경은 없다. **이번 베타 때문에 새로 실행할 수동 DB
  마이그레이션은 없다.** 정식 release의 기존 baseline·검증 단계는 유지한다.
  `all`은 기존 D1 baseline과 R2 정책 적용·검증, room-code reuse 일시 fence도
  수행하므로 데이터 계층을 전혀 건드리지 않는 배포라는 뜻은 아니다.
  완료된 과거 launch-cleanup SQL을 수동으로 재실행하지 않는다.
- 쿠키 변경은 새 secret·DB 이전·대기 기간·전체 강제 로그아웃을 요구하지 않는다.
  기존 고정 이름 쿠키는 계속 읽고 새 로그인부터 세션별 이름을 발급한다.
- 리버브 과거 값 이전은 사용자가 실제 API 사용자를 확인한 뒤 불필요하다고
  결정해 제거했다(`d84323d3`). 임의 보정·일괄 데이터 변경을 다시 추가하지 않는다.
  이후 새로 보고된 API 사용이 있는지 확인한다. 실제 `>10` 저장값이 있으면
  현재 PRO 재로드 검증은 전체 effects를 기본값으로 돌리는 경계가 있으므로,
  그런 증거가 생길 때 배포 영향과 처리 결정을 다시 기록한다.
- 하이브리드 엔진은 전체 원본 File/Blob 수신 후 PCM 보관량을 줄인다. 미디어
  OPFS/IndexedDB 저장이나 네트워크 부분 수신으로 바뀐 것이 아니다. 원격/PRO의
  기존 파일 용량 제한을 이 배포에서 확대하지 않는다.
- 새 엔진의 큰 Opus/Vorbis 지원은 이번 범위가 아니다. 지원 코덱도 모든 기기에서
  성공한다고 보장하지 않는다. 준비 실패 시 큰 파일 전체 디코딩으로 자동 우회하지 않는다.
- 프리로드의 기존 `PRELOAD_END`가 청크와 같은 bulk 채널을 사용한다. 메시지
  형식 변경은 없으며 control 채널 END를 보내는 구버전도 계속 수신한다.
  PRO 공유 종료 복귀는 현재 서버 체크포인트로 참가자 자신을 복구하며 새
  방 재생 명령·권한 완화·파일 공유 종료 정책 변경은 없다.

## 3. 현재 검증과 남은 확인

**2차 독립 QA — 2026-10-09:** main `e7c5529a3273c7132880dd0ad4572b2463405c87`를
Windows·Node24.20.0/npm12.0.2·Astra Ultra 3×10세트로 검토했다. 30라운드/122개 기본 QA ID를
분류했고, 발견 당시 확정 13건(P1 0/P2 9/P3 4)·미확정 2·제외 8이었다. 후속 수정은 아래 체크리스트와 수정 기록을 따른다.
전체 unit519파일·10,810 pass, Chromium581 pass, WebKit66 pass/기존3skip, production17 pass,
4종coverage·정적14명령·E2E/production build 및 산출물 guard 통과. 새 실패·교정·재현은 별도
보존하며 반복/프로필 결과를 합산하지 않는다. 의존성 전체/prod-only 감사0·서명486/attestation103을
새로 확인했고 새 설치는 하지 않았다. QA094 신규 보안 실행 및 QA109 심화는 Daybreak/계정 보안
등록 조건으로 차단돼 소스 검토와 일반 기능 검사 범위를 구분했다. 과거 legacy PWA 승인 뒤 갱신
정지1회·운영 R2 미확정 기록과 실기 확인 한계는 유지한다. 코드·유지 검사·의존성·버전/cache·
schema/secrets/bindings·배포 변경 없음. 원격 exact-main-SHA CI candidate로 대체하지 않는다. [2차 30라운드·독립 재판정](design/beta-30-round-qa-2026-10-09.md).

- [x] 30라운드 보고서 수집·후보 중복 제거·최종 독립 판정 및 코드/불변 산출물 동일성 확인.
- [x] 이번 확정 13건과 추가 요구 2건 구현·개별 경계 회귀. [수정 기록](design/beta-30-round-repair-2026-10-09.md); 최종 unit10,882·4종coverage·Chromium67/최종19·WebKit66+기존3skip 통과.
- [x] 미확정 2건의 기대 동작을 사용자가 승인: API 변경 직전 개별 키 검사, 관리자 공지 만료 시 본문 상태 자동 갱신. 이미 최종 인증을 통과해 진행 중인 작업을 분산 롤백하는 계약은 아님.
- [x] 통합 unit·4종 coverage·영향 Chromium·최종 WebKit 및 정적 검사 통과.
- [x] 제품 커밋 `8c14f0d6`에서 production build·Worker6·candidate Chromium17/WebKit SW1 통과. QA helper 관측 경합은 별도 재현 후 검사만 수정, 782파일 산출물 불변.
- [x] 정확한 main `0fc46bad`의 CI `37839818477`/immutable candidate 및 Release `37840659848` 성공. App8.7.5/v636·all/D1 false·운영 smoke10·최종6Worker 소유권·PRO ready 확인. [배포 기록](design/beta-30-round-repair-2026-10-09.md#875-정식-배포-후속-기록--2026-10-09).
- [x] 새 세션의 일반 방어 경계 검증: `44ef6a78`, 새 로컬43·기존17파일966 통과, 새 확정0. 기존 전체/심화 검증과 합산하지 않음. [마지막 독립 검증](design/beta-30-round-repair-2026-10-09.md#새-세션의-마지막-독립-검증--2026-10-09).
- [x] API 스트리밍 키 수명: `2a6e4812`, 실제 초기 인증 뒤 회수·만료를 적용한 queue-mode/queue-add 고유8대조 통과. API 자체 거절 없이 중단됐던 항목을 기존 QA032 거절과 구분해 일반 로컬 회귀로 확인. [최종 근거·관측 한계 보완](design/beta-30-round-repair-2026-10-09.md#api-키-수명-로컬-재검증-완료--2026-10-09).
- [x] QA032 사용자 제공 부분 실행 근거 검토: `fa33c660`, JSON23pass와 source의 guard/dispatch 검사 대응 확인. 부모 런타임 재실행0·원본 보존. [읽기 전용 검토](design/beta-30-round-repair-2026-10-09.md#qa032-사용자-제공-결과의-읽기-전용-검토--2026-10-09).
- [x] QA032 합의한 로컬 수신 무결성 범위: 추가 제공 통합3이 실제 main/preload receiver와 저장·완료 Blob/역순 조립을 검증하며 테스트 직접 RAM 쓰기/완료 없음. 보조16/392 원본·로그와 중복 없음 확인, 기존23 포함 고유434pass/fail·skip0. 앞선 세 공백 해소; binary codec·실제 WebRTC/live·실행 전후 전체hash는 별도 관측 한계다. 부모 재실행0·기존 거절 기록 보존. [완료 근거·정확한 범위](design/beta-30-round-repair-2026-10-09.md#qa032-추가-통합-근거의-읽기-전용-재검토--2026-10-09).
- [ ] 실제 기기 검증 및 기존 미확정 기록은 각 전제 충족 후 별도 확인.

다음 QA 결과는 각 날짜·코드 SHA의 증거다. 당시 동결·보안 경고·버전 상태를 현재
상태로 해석하지 않는다. 현재 승인·배포 결과는 1절과 마지막 실행 기록을 따른다.

**이전 8.7.0 공개 승격·배포 — 2026-10-07:** main `e8001e93c9390ec20b359b015d3dff890f2b5304`의
정확한 CI `37583802398`과 Release `37584399403`이 성공했다. Linux 전체 unit은
517파일·10,729 pass/기존 Windows 전용 1 skip, 원래 4종 coverage 통과. production
Chromium 17개·필수 Chromium 22개, 타입/lint/서식·source/artifact guard·6개 Worker
bundle·security audit 0건·서명 487/attestation 104 검증. 6개 Worker 배포·live smoke·
최종 소유권·PRO ready와 공개 fresh 확인을 완료했다. 원본 실패, 정확한 후보·도구 버전,
Worker ID·checkpoint·감사 수동 범위·구형→신형 업그레이드 한계는
[정식 배포 기록](design/release-8.7.0-2026-10-07.md)에 보존한다.

**최신 후속 수정 — 2026-10-07:** `4a605791b7f4680cc85d4718117d8db231c1d772` — Windows,
Node 24.20.0/npm 12.0.2에서 동일 작업 트리 검증 후 커밋. 확정 12건 수정과
별도 보강 2건의 구현·로컬 검증 완료. 최종 unit517파일·10,730 pass, fail/skip/todo0,
기존4종 coverage gate 통과. 초기 빌드 전체 Chromium83파일·580 pass 후 최종 호환성
보완 빌드의 영향18개와 production17개 pass, WebKit66 pass/기존3skip. 자동retry0이며
전체/집중 실행의 중복을 합산하지 않는다. 전체 타입/lint/서식·source16/산출물8 guard·
Worker dry-run6 통과. 전체/prod-only 감사0, registry서명486·attestation103·분리된새설치와
nativeSharp/esbuild/Miniflare 검증. 초기 단위10726pass/도구계약1fail은 신규tooling 등록과
기대목록 불일치로 수정한 뒤 전체 재실행했다. R26 중복 안내 수정과 최초 승인 뒤 갱신
미관측1회를 구분한다. 추가 진단10/10통과로 최초 관찰 원인을 설명하지 못했으므로
미확정으로 보존한다. 실기/live·cache-history·exact-main CI·공개 승격은 별도다.
[후속 결과·초기 실패·소스/빌드 근거](design/beta-30-round-repair-2026-10-07.md).

**수정 전 독립 QA — 2026-10-07:** tested SHA `9afc36b4d8bccc575a923b0dfaadd103145ba09f`,
Windows/Node24.20.0/npm12.0.2, Astra Ultra 3×10세트. 30라운드와 사후 독립 재분석 완료.
확정12건 미수정, 미확정2건, 제외2건. 기존 선택 Vitest를 중복 제거해365파일·8,716개
최종pass, 공유 파일을 쓰는1개는 제외했다. 새 실패 재현은 별도이며 전체 unit/coverage
통과 주장이 아니다. 122도메인 중120은 제한된 실험 수행, QA055실제음향 미실행,
QA122운영 실행은 소스/모형 검토만 수행. production/E2E build·artifact guard8개·
Worker dry-run6개 통과. 전체audit high3패키지/단일advisory로exit1, prod-only0.
새 제품·유지 검사·의존성·schema/secrets/bindings·버전/cache 변경 없이 QA 문서만 갱신.
발견 시점에는 수정 및 회귀가 남아 있었다. 현재 수리는 후속 기록을 따르며 아래 실기/live·cache-history·최종main SHA CI 확인은 계속 남는다. [30라운드·최종 판정](design/beta-30-round-qa-2026-10-07.md).

**최신 보안 의존성 수정 — 2026-10-06:** 의존성 코드
`b0d55351aa58f4a274076d6f31ae69630d260021`. 기준 checkout `8beaf902` 위
동일 package/lock 작업 트리를 검증한 뒤 커밋했고 이후 SHA 기록은 문서만 변경,
제품 runtime `45c7ef7a` 그대로. Windows·pinned Node24.20.0/npm12.0.2·
Vitest5/jsdom·Playwright1.63 Chromium·local PeerJS/Miniflare·jq1.8.2.
전체 audit와 `security:audit`, prod-only audit 모두 **0건 / exit0**,
486 registry signatures·103 attestations 검증, dependency tree exit0.
변경/추가 dev lock11노드, 운영 lock46노드·직접 의존성·Wrangler toolchain 동일.
구형 brace 함수 API도 부모별 패치로 복구했다. 전체 unit 첫 실행
**510파일·10,637 pass / fail·skip·todo0**, 선택 Chromium3파일·17 pass,
최종 production artifact Chromium2파일·9 pass; browser fail·skip·flaky·runner
error·retry0, worker1. 중복 profile 수치는 합산하지 않는다.
전체 타입·lint·서식, E2E/production build·artifact guard8개·Worker dry-run6개,
설치 의존성 loopback20개 통과. 최종 dist는 production, 전용4520/9320 listener0.
coverage·전체Chromium·WebKit·실기/live·exact-main CI는 이번 재실행이 아니다.
main·워크플로·제품/검사 소스·schema/secrets/bindings·계약·버전/cache·복구·
누적all / D1 false·동결 유지. 보안 gate는 해결됐고 기존 cache-history 및
최종 승격 확인은 남아 있다. [수정·검증·한계](design/beta-security-repair-2026-10-06.md).

**최신 main/beta 비교 — 2026-10-06:** main `35759e8b` → checkout
`1349825f`, 제품 `45c7ef7a` 이후 변경은 문서·QA 검사만.
Windows·pinned Node24.20.0/npm12.0.2·Vitest5·Playwright1.63·local PeerJS·jq1.8.2.
새 확정 런타임 결함0건. 전체 unit 최초510파일·10,636 pass/도구 검사1 timeout,
skip·todo0; 동일 파일의 원래15초 기준18개를 직렬 재검증해 모두 pass.
같은 case 결과를 치환한 고유 **10,637 pass / 최종 fail·skip·todo0**이다.
선택 Chromium **10파일·54 pass / fail·skip·flaky·runner error0, retry0**.
전체 타입·lint·서식과 E2E/production 빌드·artifact guard8개 통과.
E2E 뒤 production 산출물로 복원했으며 전용4518/9318 listener0.
추가 bounded 오디오21관측은 디코딩 오류·
유의미한 시간 드리프트 미확인이나 일부 파형 잔차가 있어 엄격한 PCM 일치 판정은 아니다.
main/beta 감사는 취약 객체 동일13패키지, 모두dev·설치 버전 동일,
beta prod-only0. cache guard는main pass/beta fail.
coverage4종·전체Chromium·WebKit·production smoke·Worker bundle·실기/live는
이번 재실행이 아니며, 누적all / D1 false·계약·버전·복구·동결 유지.
[분석·원본 timeout·검증 범위·보안 근거](design/main-beta-comparison-2026-10-06.md).

**마지막 요청 QA — 2026-10-04:** checkout
`36deb60d2ee415fed0a06a11a51d61562b7f014e`, 제품 `45c7ef7a` 그대로.
Windows·Node24.20.0/npm12.0.2·Vitest5/jsdom/local Worker·Playwright1.63
Chromium/Windows WebKit·로컬 PeerJS. 새 확정 제품 결함0건으로 추가 발굴 종료.
전체 unit **510파일·10,637 pass / fail·skip·todo0**, 새 미디어12·PRO8·UI12로
**32 pass**, 주 에이전트 최종 프로브 독립 재실행 일치. PRO 복사 baseline323개는
이름 필터 제외이며 실제 원본은 전체 unit에 포함; 다른 새 모듈 filter/skip 없음.
기존 media265·UI376 선택은 전체 unit 부분집합으로 중복 합산하지 않는다.
유지 Chromium **6파일·43 pass** 및 native FIFO지연 **4조건 pass**, WebKit UI
**66 pass / 기존 desktop-only3 skip**, production artifact Chromium9+WebKitSW1
pass. 브라우저 fail·runner error·flaky·자동retry0. E2E/production build·원래
artifact guard8개 통과, production index는 앞선 산출물과 같은 SHA256으로 복원.
Native 측정은 seek helper 전부터20ms 간격으로 시작. FIFO3.2초 조건에서는 새
출력 차이3.210초와 실제 hard 보정을 관측한 뒤 최종1초50쌍이3.167ms 이내로
수렴했다. 네 조건 최종 최대6.833ms. 이는 실제 음향·이전 nominal transient의
원인·PLAY 수신 순간 선택clock 보정을 입증하지 않는다. 이전 진단·실기 확인
항목은 유지하며 무결함·프로덕션 준비 완료로 확대하지 않는다.
제품·유지 검사·의존성·계약·버전/cache·복구 변경 없음, 보호1129파일 hash비교와
baseline diff 비어 있음, 전용4500–4504/9300–9304 listener0. 전체Chromium568·
coverage4종·static/security·Worker bundle6은 이번 재실행 아님. 기존 보안/cache
gate·exact-main CI·실기/live 확인·누적 all / D1 false·동결은 유지한다.
[최종 범위·초기 실패·재실행·관측](design/beta-final-qa-2026-10-04.md).

**앞선 후속 시퀀스 QA — 2026-10-04:** checkout
`1dc2d9115d0f81202f22dd84b7d817b27bf23c51`, 제품 `45c7ef7a` 그대로.
Windows·Node24.20.0/npm12.0.2·Vitest5/jsdom·Playwright1.63 Chromium/PeerJS.
새 미디어10·PRO/계정/Worker18·YouTube/capture/demo/UI35로 **63 pass**,
주 에이전트 독립 재실행 일치. 기존 선택 **18파일·고유1,014 pass**, 중복0.
PRO 복사 baseline340개·다른 Worker302개는 필터 제외로 미실행.
YouTube 계열 전체 원문36개는35 pass/1 projection 진단 fail이며, 실제
`leaveSession` 종료·실제 rendezvous 대조군을 검증한 뒤 그 진단1개만 명시적으로
제외했다. 실제 사용자 경로 결함으로 확정하지 않았고 실패 원문을 보존한다.
새 모바일 화면 Chromium **18계획 pass / fail·skip·flaky·자동 retry0**.
별도 같은 seed 반복3회·연속 관측3회·FIFO2.3초 지연 대조3회도 통과,
기본18계획 수치에 중복 합산하지 않는다. 실제 native PCM101 playing 표본 중
1개에서2.365초 차이, 나머지100개는23.3ms 이내. 연속 관측에서2.330초 차이를
재현했고 관측 시작328ms 후2.167ms 이내로 자동 복구·유지했다.
원래2.5초 convergence 기준 안이며 지속 실패는 확인하지 못했다. PLAY 수신 순간의
선택된 clock offset이 없어 source fallback 원인 추정은 미확정으로 남긴다.
지연 대조군은 UI 수렴 후부터 측정해 초기 최대 차이를 직접 입증하지 않는다.
E2E 준비 빌드·최종 production 복원·prod-hooks guard 통과; 제품·유지 검사 변경 없음.
새 확정 제품 결함0건. 전체 unit/coverage/E2E·WebKit·static/security·Worker bundle·
production smoke는 앞선 대규모 QA 근거를 유지하고 이번에 전체 재실행하지 않았다.
실기/latency 확인 대상에 탐색 후 일시 차이 관측을 추가한다. 기존 보안/cache gate,
누적 all / D1 false·schema/secrets/bindings·버전·복구·동결은 그대로.
[새 경로·관측·원문·한계](design/beta-sequence-qa-2026-10-04-round-2.md).

**앞선 대규모 QA — 2026-10-04:** 기준 checkout
`a4802820eef62c8650109cc91a0683ca28ea4d9b`, 제품 코드
`45c7ef7a4e0fef5b788efe11cb72d54c9b221929`와 동일한 런타임.
Windows·Node 24.20.0/npm 12.0.2·Vitest 5·Playwright 1.63·로컬 PeerJS·jq 1.8.2.
**새 확정 런타임 결함 0건**, 검사 판정 오류 QA-T04–05 두 건 수정.
최초 unit 10,636 pass/1 fail, Chromium 567 pass/1 fail을 보존했다.
QA-T04는 수집 시계가 앞선 실제 송신보다 뒤로 가는 조건을 30초 지연 대조군으로
재현했다. `Math.max(clock, Date.now()) + 10_000`으로 fixture만 보정한 뒤
전체 unit **510파일·10,637 pass / fail·skip·todo 0**, 원래 4종 coverage gate 통과.
QA-T05는 재동기화 후 시작 오프셋이 달라도 현재 native PCM 위치가 약 3.2ms 이내인
상태에서 기존 판정의 실패를 재현했다. 현재 타임라인 비교로 검사만 수정하고
원래 host seek 확인·2.5초 허용값·10초 timeout을 유지했다.
해당 Luna 25개 모두 pass, 원본의 동일 case 치환 후 **Chromium 고유 79파일·568 pass**,
fail·skip·flaky·자동 retry 0. 최초 실패 순간의 PCM을 직접 측정한 것으로 해석하지 않는다.
WebKit **66 pass/기존 desktop 전용 3 skip**, production artifact Chromium9+WebKitSW1 pass.
새 파일 전송/미디어11·PRO/실제 Worker 경로30개는 독립 재실행도 통과했고 중복 합산하지 않는다.
정적27명령 중25 pass/기존 보안·cache gate2 fail, E2E·production 빌드,
artifact guard8개·Worker dry-run6개 통과. `build:checked`는 기존 cache-history에서 exit1.
수정된 chat/Luna 검사 SHA256과 config·산출물 전후 hash, 실제 명령·exit는
[상세 QA](design/beta-large-qa-2026-10-04.md)에 기록했다.
제품·의존성·schema·secret·binding·버전/cache·복구 절차·동결 변경 없음.
누적 `target=all` / `apply_developer_api_d1=false` 그대로. 실기 iOS/Android·Bluetooth·
실운영 서비스·원격 drift·최종 exact-main-SHA CI 승격 확인은 남아 있다.

**이전 7차 시퀀스 QA — 2026-10-03:** checkout
`67a4f26bec3768f002c7969d4c97758efe9c6cd7`, 제품 코드
`45c7ef7a4e0fef5b788efe11cb72d54c9b221929`. Windows·Node 24.20.0·Vitest 5/jsdom·
로컬 Worker fixture·Playwright 1.63 Chromium/PeerJS. **새 확정 결함 0건**.
파일/전송338개(새68), PRO630개(새60), YouTube/데모/공유380개(새9)가 통과했다.
고유 **31파일·1,348 pass / fail·skip 0**, Chromium **5파일·10 pass / fail·skip·flaky 0**
(새5, retry0). 새 파일68·PRO60 및 별도 YouTube 의심 경로는 주 에이전트가 독립 재실행했다.
강제 watchdog 예외 주입 8개 중 **5 pass/3 fail**은 재생 의도 복구의 조건부 약점이지만,
실제 API에서 예외가 생기는 경로가 미입증이라 확정에서 제외하고 성공 집계와 분리했다.
공식 API 스크립트 snapshot·주입 증거·초기 프로브 오라클 오류를 보존했다.
E2E 로컬 빌드 통과. 제품·추적 테스트·배포 범위·계약·동결 변경 없음.
전체 unit/E2E·WebKit·coverage·보안·실기·라이브 검증을 다시 한 것은 아니다.
[상세 범위·재현·제외 근거](design/beta-sequence-qa-2026-10-03-round-7.md).

**이전 SQ14–SQ15 수정 검증 — 2026-10-03:** 코드
`45c7ef7a4e0fef5b788efe11cb72d54c9b221929`, Windows·Node 24.20.0·Vitest 5·jq 1.8.2.
수정 전 실제 Worker 본문 기반 재현 6 pass/4 fail을 확인한 뒤 수정했다.
인접 충돌 후 GET 503/403에서도 거절된 의도가 재발행되는 경로와,
중간 수정본의 오래된 CAS 기준 때문에 새 조작이 손실되는 경로를 독립 재현·보완했다.
새 회귀 **31개**, Worker 본문 재검증 **10개**, 기존 queue authority **10개** 통과.
전체 단위 **510파일·10,637 pass / fail·skip·todo 0**이며 새 회귀를 포함한다.
별도 집중 재실행은 합산하지 않는다. Chromium **3파일·11 pass / fail·skip·flaky 0**
(retry 0), App/테스트 타입·변경 소스 lint/서식·복잡도/권한 경계 guard,
E2E·프로덕션 로컬 빌드와 산출물 guard 8개 통과. 브라우저 검사는 일반방 UI/PeerJS
회귀이며 PRO 원인 검증은 실제 runtime/API 파서와 제어된 HTTP/Worker 본문으로 했다.
전체 E2E·WebKit·coverage·live·실기·의존성 보안 재감사는 수행하지 않았다.
이전 보안·cache-history gate는 남아 있고 `build:checked` 전체 성공으로 기록하지 않는다.
UI·Worker·DB·secret·binding·의존성·버전/cache·동결·배포 입력 변경 없음.
[원본 재현·최종 검증·한계](design/beta-sequence-qa-2026-10-03-round-6.md#repair-addendum--2026-10-03).

**수정 전 6차 발견 QA — 2026-10-03:** checkout `1341bafb`, 제품 코드
`f617c80325771ef7519878c385fd24f55f90bdb3`. Windows·Node 24.20.0·Vitest/jsdom에서
실제 API 파서와 로컬 Worker 응답으로 SQ14–SQ15를 확정했다. Chromium/PeerJS는
별도 UI 회귀에 사용했다. 새 PRO 프로브 **19 pass / 4 fail /
skip 0**이며, 네 실패는 두 원인의 반복·셔플 변형이다. 실제 로컬 Worker 공개 API가
만든 본문을 사용하는 10개 재검증도 **6 pass / 4 fail**, 주 에이전트 독립 실행 일치.
파일343개(신규32 포함), YouTube·공유·데모309개(신규65 포함), 기존 PRO219개,
UI·계정403개와 Chromium18개(신규6 포함)는 통과했다. fail/skip 0,
브라우저 retry/flaky 0; 같은 재현을 다시 실행한 결과는 합산하지 않는다.
E2E 로컬 빌드 통과. 제품·추적 테스트는 변경하지 않았으며 전체 스위트·실기·
라이브 서비스·의존성 보안 재검증이 아니다. 초기 모사 경계 오류는 결함에서 제외하고
[상세 기록](design/beta-sequence-qa-2026-10-03-round-6.md)에 보존했다.

**이전 SQ10–SQ13 수정 검증 — 2026-10-03:** 코드
`f617c80325771ef7519878c385fd24f55f90bdb3`, Windows·Node 24.20.0·jq 1.8.2.
수정 전 네 결함을 다시 재현했고, SQ11의 지연된 설정 조회 거부와 새로운 조작이
겹치는 인접 경로도 이전 분기 실패/최종 코드 통과로 독립 확인했다.
전체 단위 **508파일·10,606 pass / fail·skip 0**을 한 번의 최종 전체 실행에서
확인했다. 실제 jq를 지정해 관련 97개도 실행했다. 최종 E2E 빌드의 Chromium
**15파일·98 pass / fail·skip·flaky 0** (retry 0). 원본 scratch 재현과 별도
집중 재실행은 중복 합산하지 않는다. App·단위·E2E·Node-script 타입,
App/변경 tooling lint·서식·소스 guard, E2E·프로덕션 로컬 빌드 및 산출물
guard 8개 통과. 불필요해진 이전 설정 병합 export를 제거했으며 검사 기준을
늘리지 않았다. cache-history guard는 v630 이후 누적 변경 때문에 여전히 실패하며,
`build:checked` 전체 성공으로 기록하지 않는다. 공개용 버전/cache 증분은
동결 종료 후 별도로 필요하다. 전체 E2E·WebKit·coverage·live·실기 음향·보안
재감사는 수행하지 않았다. 새 Worker·DB·secret·binding·의존성 변경 없음.
[수정·회귀·실행 한계](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03).

**수정 전 5차 시퀀스 발견 QA — 2026-10-03:** checkout
`cf11f8a3749d567d8f47bbd5db30b3be18e0d660`, 제품 코드
`a841b2d9315c23b71d78ca6263e3950b0a55cc82`, Windows·Node 24.20.0.
SQ10–SQ13 **4건 미해결**을 확정했다. 오디오 33개=29 pass/4 fail,
강한 PRO 설정·공개 Worker 프로브 6개=5 pass/1 fail,
YouTube/데모/공유 67개=64 pass/3 fail, Chromium 채팅 6개=3 pass/3 fail.
같은 원인의 초기 PRO 상태코드 탐사 6개=3 pass/3 fail은 별도로 보존한다.
주 에이전트가 오디오·PRO·YouTube를 독립 재실행했고, 실제 브라우저 채팅은
별도 소스 검토와 정상 연결/복구 대조군으로 확인했다.
기존 집중 단위 고유 **24파일·769개**, 추가 복사본 기존 Worker **313개**,
기존 Chromium **7파일·24개**는 전부 통과했다. 이들 통과가 새 실패를 상쇄하지 않는다.
최종 실행 skip 0, 브라우저 retry/flaky 0. E2E 빌드 통과.
제품·추적 테스트 수정 없이 기록만 갱신했으며 전체 스위트·coverage·WebKit·
실운영·실기 음향·보안 재검증은 하지 않았다. UI 모듈 재현의 native iframe,
picker, decoder와 외부 통신 경계는 제어된 모델이다.
[재현 순서·원인·정상 대조·남은 수정](design/beta-sequence-qa-2026-10-03-round-5.md).

**최신 SQ07–SQ09 수정 검증 — 2026-10-03:** 코드
`a841b2d9315c23b71d78ca6263e3950b0a55cc82`, Windows·Node 24.20.0·jq 1.8.2.
수정 전 실패를 다시 재현했고, 관련 R2·PLAY_PRELOADED 실패 곡 경로와 복구 중
시작한 HTTP 요청·중첩 재접속도 보완했다. 새 추적 단위 회귀 **45개**가 통과했다.
전체 단위 최초 실행은 505파일·10,499 pass / 4 fail / skip 0. 실패한 기존 3파일은
이전 선택 유지·수신 모듈의 직접 정리 호출을 기대하던 검사였고, 새 소유권 경계에
맞췄다. 실제 합성 회귀에는 watchdog 제거·loader 종료 및 정상 wire 청크를 검증했다.
최종 영향 6파일·236개 독립 재실행을 해당 파일 결과와 치환한 고유 합계는
**505파일·10,503 pass / fail·skip 0**이며 재실행 수를 중복 합산하지 않는다.
최종 E2E 빌드의 Chromium **12파일·75 pass / fail·skip·flaky 0** (retry 0),
App/단위/E2E/Node-script 타입, App/변경 tooling lint·서식·소스 guard 통과.
E2E·프로덕션 로컬 빌드와 산출물 guard 8개도 통과했다. `build:checked`는 동결된
v630 이후 누적 runtime 변경 때문에 cache-history gate에서 멈췄다. 전후 검사는
별도 통과했지만 `build:checked` 전체 성공으로 기록하지 않는다. 최종 공개용
version/cache 증분과 exact-main-SHA 검증이 필요하다. 전체 E2E·WebKit·coverage·
live·실기·보안 재감사는 수행하지 않았다. 새 Worker/DB/secret/binding/의존성 변경 없음.
[원본 발견·수정·실행 한계](design/beta-sequence-qa-2026-10-03-round-4.md#repair-addendum--2026-10-03).

**수정 전 발견 QA 4차 — 2026-10-03:** checkout
`ed6552805d57ccd30bfc64a5dfa474ba0378c729`, 제품·테스트 코드
`d4dd4bbb94c58624f50887d12dc5dd017fb95f7a`. Windows·Node 24.20.0에서
SQ07–SQ09 새 결함 **3건**을 확인하고 독립 재검증했다. 신규 실행 모듈 프로브는
52개 중 45 pass / 7 fail이며 세 원인의 중복 재현을 포함한다. 이 중 데모·설정
실제 모듈/UI 조합 28개는 모두 통과했고 새 결함은 없었다. PRO Worker 공개 API의
명령 교체·ticket 경로 1개 통과; 같은 파일 나머지 312개는 이름 필터 제외로 미실행.
기존 집중 단위/Worker 고유 30파일·975 pass, fail·skip 0. Chromium 새 검색 취소
조합 8개 + 기존 검색·채팅·큐·재접속 37개 = **45 pass / fail·skip·flaky 0** (retry 0).
E2E 빌드 통과. SQ09는 뒤이은 최신 COMMIT으로 복구됨도 확인했으며 영구 멈춤이나
실기 음향 불일치로 확대하지 않는다. SQ07의 PRO 대조군은 이미 보호되어 정상이다.
제품 수정·전체 스위트·coverage·실기·live·보안 재감사는 수행하지 않았다.
의존성·계약·버전/cache·배포 범위·migration·동결은 그대로다.
[발견·증거·실행 범위](design/beta-sequence-qa-2026-10-03-round-4.md).

**이전 SQ05–SQ06 수정 검증 — 2026-10-03:** 코드
`d4dd4bbb94c58624f50887d12dc5dd017fb95f7a`, Windows·Node 24.20.0.
전체 단위 최초 실행은 503파일·10,457 pass / fail 0 / 도구 조건 skip 1이었다.
기존 설치된 jq 1.8.2를 `MXQR_TEST_JQ_PATH`로 지정해 해당 파일 97개를 모두
통과했다. 같은 파일 결과를 치환한 고유 합계는 **503파일·10,458 pass / fail·skip 0**이다.
테스트 코드·기준은 바꾸지 않았으며 재실행 수치를 중복 합산하지 않는다.
새 모듈 회귀 33개는 독립 검토·재실행도 통과했다. 실제 일반방 host/guest UI와
데이터 채널에서 데모 실패 전·후를 재현하고, Chromium 9파일·50 pass,
fail·skip·flaky 0 (retry 0)을 확인했다. App·테스트·E2E 타입, App/새 E2E lint,
변경 소스 서식·복잡도·권한 경계·Playwright API guard, E2E·프로덕션 빌드 및
산출물 guard 8개가 통과했다. PRO 서버·YouTube native 경계는 모사하며 전체
E2E·WebKit·coverage·실기·live-service 검증을 다시 완료한 것으로 해석하지 않는다.
SQ05–SQ06의 테스트 범위 내 미해결은 **0건**. 새 의존성·migration·secret·binding·
복구 절차는 없고 누적 `target=all`, `apply_developer_api_d1=false`는 그대로다.
기존 보안·승격 gate와 동결은 유지한다.
[수정·증거·한계](design/beta-sequence-qa-2026-10-03-round-3.md#repair-addendum--2026-10-03).

**이전 발견 QA 3차 — 2026-10-03, 수정 전 관측:** checkout
`60eb127322684b1a960a93910962192b7fc334f8`, 제품·테스트 코드
`1c26dc4ea10263790fedd345f9c20950d09dfc13`. Windows·Node 24.20.0에서
SQ05–SQ06 두 원인을 모듈 합성 및 독립 재실행으로 확인했다. 확정 관련 새 프로브
17개는 10 pass/7 fail/0 skip이며 실패 7개가 결함 7개라는 뜻은 아니다.
기존 집중 단위/Worker 509개(데모·세션 204 + PRO/runtime/iframe 301 + 선택 Worker 4),
Chromium 4파일·14개 통과. 실행한 항목의 fail/skip/flaky 0; Worker의 나머지
308개는 이름 필터 제외로 미실행. 별도 원격 오디오 matrix는 정상 대조군 14 pass,
합성 경계 6 fail이며 실제 송신 순서 미입증으로 확정 결함 수에 포함하지 않는다.
E2E 빌드 통과. 제품 수정·전체 스위트·실기·공개 서비스 검증은 하지 않았다.
원격 파일 descriptor 순서 및 준비 중 YouTube native 제어 후보는 실제 사용자
입력 경로를 입증하지 못해 확정 결함에서 제외했다. 당시 미해결 **2건**은 위 SQ05–SQ06 수정으로 해소했다.
[재현·대조군·한계](design/beta-sequence-qa-2026-10-03-round-3.md).

**이전 SQ02–SQ04 수정 검증 — 2026-10-03:** 코드 `1c26dc4ea10263790fedd345f9c20950d09dfc13`,
Windows·Node 24.20.0. 세 원인을 재현한 뒤 수정했다. 전체 단위 최초 실행은
10,418 pass / 기존 버그 전제 assertion 1 fail이었다. 해당 테스트를 실제 새 바이트와
중복 바이트 대조군으로 교정한 뒤 storage/player/network/YouTube 157파일·4,030개,
마지막 보호 조건·fixture 보완 뒤 YouTube 37파일·1,002개를 재검증했다.
같은 파일의 최신 결과로 치환한 고유 합계는 **501파일·10,425 pass / fail·skip 0**이다.
Chromium 12파일·62 pass, fail·skip·flaky 0 (retry 0). App·테스트·E2E 타입, App/변경 E2E lint, 변경 소스 서식,
복잡도·권한 경계·chunk pump·Playwright API guard 통과. E2E·프로덕션 빌드 및 산출물 guard 8개 통과.
전체 E2E·coverage·Worker/live·실기 재검사를 완료한 것으로 해석하지 않는다.
SQ02–SQ04의 테스트 범위 내 미해결은 **0건**; 기존 보안·승격 gate는 유지한다.
[변경·재현·검증 한계](design/beta-sequence-qa-2026-10-03-round-2.md#repair-addendum--2026-10-03).

**이전 발견 QA 2차 — 2026-10-03, 수정 전 관측:** checkout
`c46b5b5ec43da223049ffa0e345271de6d4dc544`, 제품 코드
`53cbf60fd5f475a9beef2cfaa1d7023c9b456eea`. Windows·Node 24.20.0에서
SQ02–SQ04를 새로 확정했으며 제품 코드는 수정하지 않았다.
실제 전송·수신 모듈 6개(3 pass/3 fail), YouTube 모듈 5개(3 pass/2 fail),
오디오 수명·실제 코덱 탐사 16 pass로 고유 모듈 합계 **22 pass/5 fail**.
로컬 Chromium에서 시스템 오디오 공유 반복·중도 입장 4 pass, YouTube UI
준비/seek 2 pass/1 fail로 고유 브라우저 합계 **6 pass/1 fail**이다.
skip·flaky 0, retries 0. 독립 재실행은 합산하지 않는다. E2E 빌드 통과.
실패 6개는 같은 원인의 중복 재현을 포함하며 새 결함은 **3건**이다.
SQ02는 추가 2초 복구 후 정상 재전송됨을 확인했고, SQ03은 늦은 스트림의
실제 수신 gate 거부, SQ04는 실제 브라우저 UI로 70초 탐색 후 약 0.5초로
되돌아감을 확인했다. 외부 iframe/캡처는 모사하며 실기·실운영·전체 스위트
재검증이 아니다. 일반방 경로를 확인했으며 PRO 전체에도 같은 결함이 있다고
확대하지 않는다. [재현·원인·대조군·한계](design/beta-sequence-qa-2026-10-03-round-2.md).

**이전 SQ01 수정 검증 — 2026-10-03:** 수정 코드
`53cbf60fd5f475a9beef2cfaa1d7023c9b456eea`. 기준 checkout `a46b21a5` 위의
동일한 SQ01 수정 작업 트리를 Windows·Node 24.20.0에서 검증하고 커밋했다.
이후 문서에 SHA를 연결했으며 실행 소스·검사는 바꾸지 않았다.
이전 미디어를 멈추되 같은 활성 수신의 유효 prefix만 보존한다.
새 통합 회귀 **100 pass / 0 fail / 0 skip**, 관련 storage/player/network
**117파일·2,896 pass / 0 fail / 0 skip**, Chromium **33 pass / fail·skip·flaky 0**
(retry 0)이다. 새 통합 회귀와 관련 단위의 고유 합계는 **2,996개**다.
원래 84개 실패 탐사도 모두 통과했으며 이 중복 실행은 합산하지 않는다.
App·테스트 타입, App lint, 변경 소스 서식·복잡도, E2E·프로덕션 빌드와
산출물 guard 8개 통과. 전체 스위트·coverage·실기·외부 서비스 검증을 다시
완료했다는 뜻은 아니다. SQ01 현재 미해결 **0건**; 아래 기존 보안·승격 gate 유지.
[수정 범위·명령·한계](design/beta-sequence-qa-2026-10-03.md#repair-addendum--2026-10-03).

**이전 발견 QA — 2026-10-03, 수정 전 관측:** checkout
`edbfebedc12290d767bab79afc858c3046d8696c`, 제품 코드는 직전 전체 감사와 같다.
SQ01 새 확정 1건·미수정. 실제 전송·수신·재생 정지 모듈을 연결한
84개 채널 도착 순서 중 78 pass / 6 fail이며 모두 같은 원인이다. 독립 재실행도
동일했고, 최소 재현과 복구를 beta·main 추출 소스에서 확인했다. 파일 손상·영구
정지는 확인되지 않았으며, 재현에서는 2초 복구 대기 후 처음부터 재전송했다.
오디오 60개·PRO/YouTube 19개·Chromium 검색/데모 22개·기존 전송 회귀 57개는
통과했다. 이 수치를 전체 스위트 재실행이나 실기·실운영 검증으로 해석하지 않는다.
제품 변경 없이 발견·검증과 기록만 수행했다.
[범위·재현·한계](design/beta-sequence-qa-2026-10-03.md)를 함께 읽는다.

**최신 전체 diff 감사:** main `35759e8b` → beta
`c263acce89a67d7f478e9b20a34d53fbb839a70e`를 Windows·Node 24.20.0에서
2026-10-01에 검토했다. 당시 새 확정 런타임 결함 0건으로 기능 변경은
조건부 병합 가능으로 판단했다. 후속 SQ01–SQ15는 위와 같이 수정했지만, 기존 보안·승격 gate 및 대회 동결이 남아 현재 승격은 보류다.
[전체 감사·명령·증거](design/main-beta-merge-audit-2026-10-01.md)를 함께 읽는다.

| 최신 검사 | 결과 / 한계 |
| --- | --- |
| 전체 unit·4종 coverage | 전체 497파일 최초 10,272 pass / 1 기존 jq skip. 검증된 jq 경로로 해당 파일 97개와 tooling 342개 통과하여 고유 10,273개 확인. Critical 1,772 / Worker 1,726 포함 모든 원래 threshold 통과. 중복 profile 합산 없음 |
| Chromium 전체 / WebKit UI | 558 pass·fail/skip/flaky 0 / 66 pass·fail/flaky 0·기존 desktop-only 3 skip. retry 0 |
| Production 빌드 / 산출물 / Worker | 빌드·artifact guard 8개·Worker dry-run 6개·Chromium candidate 9개·WebKit SW 1개 통과. 실제 deploy 없음 |
| Source·style·signature checks | 23개 중 22개 통과. security:audit는 실패: main과 beta 동일 9패키지(high 5/moderate 4). prod-only audit 0 |
| Cache-history gate | 공개 version/cache 동결 상태여서 실패. build:checked 성공으로 주장하지 않음 |
| 독립 모델 검사 | YouTube zero-start 441조합 / logo 36획 geometry 통과. 실기 음향·외부 서비스 장애 증거 아님 |
| 실제 기기·CI 경계 | Windows WebKit에 Web Audio/RTC 없음 확인. 실제 iPhone Safari/PWA·Android 출력, 최종 Linux PR CI·main SHA 후보·실운영 확인 필요 |

이번 결과는 위 beta SHA에 대한 로컬 관측이다. 보안 경고를 수정한 뒤에는 변경된
의존성과 최종 SHA를 재검증한다. 운영 워크플로는 API 조회상
`disabled_manually`를 유지했다. 제품 버전·캐시·배포 범위·스키마/secret/binding
계약은 바꾸지 않았다. 다음 과거 결과는 당시 증거로 보존한다.

**이전 집중 검증:** `79f3a687a7222a69ff865846e0c715aa197d0f10`의 시작 로고 변경을
Windows·Node 24.20.0에서 검증했다. 단위 88개, Chromium E2E 21개, Windows
WebKit E2E 6개, 프로덕션 산출물 Chromium smoke 9개가 모두 통과했다.
자세한 범위·초기 검사 수정·픽셀 판정 한계는 아래 2026-09-29 항목을 따른다.
해당 로고 집중 검증 때는 전체 단위·coverage·전체 E2E를 다시 실행하지 않았으며, 아래 전체 QA
결과를 이 후속 코드 SHA의 전체 검증으로 해석하지 않는다.

**이전 전체 QA 검증:** `d3ef74ab4e196abbc2b2f3ea97988e3a91e379ac` 작업 트리(기준 checkout
`8c78a598`)에서 Windows·Node 24.20.0으로 전체 단위 **496파일·10,264 pass /
0 fail / 0 skip**와 원래 broad coverage gate를 통과했다. Critical
**50파일·1,772 pass**, tooling **13파일·342 pass**, Worker **26파일·1,726 pass**도
원래 global/per-file threshold로 통과했다. 검증한 공식 portable jq를 사용해
Windows의 기존 배포 분류 검사 skip도 해소했다. 서로 겹치는 profile의 수치는
합산하지 않는다.

최종 Chromium 전체 **552 pass / 0 fail / 0 skip / 0 flaky**를 서로 격리한
네 shard에서 확인했다. 공식 Windows WebKit 모바일 lane은
**60 pass / 0 fail / 기존 3 skip / 0 flaky**다. 프로덕션 빌드와 artifact guard
8개, 동일 산출물의 Chromium candidate 9개·WebKit Service Worker 1개도 통과했다.
전체 타입·린트·서식·정적 검사 23개와 Worker bundle dry-run 6개는 통과했다.
공개 버전/cache 증분 전의 `guard:sw-cache-version` 실패는 예상된 승격 gate로
유지하며 통과로 계산하지 않는다. 최신 실행·검사 경계는
[수정 검증 기록](design/beta-full-qa-repair-2026-09-27.md), 수정 전 실패는
[발견 기록](design/beta-full-qa-2026-09-27.md)을 따른다. 아래 과거 검증 숫자는
해당 시점의 기록이며 최신 결과와 합산하지 않는다.

**이전 검증 근거:** 코드 `2347760c5e5b902327a05ca216c8b72409ee72d3`. 동일 제품 소스의
작업 트리를 검증한 뒤 커밋했다. 이번 상세 근거는
[4차 발굴·D01 수정 기록](design/beta-defect-harvest-2026-09-27-round-4.md)에 있다.
후속 HTML 배치 수정 `736f195c`의 집중 검증은 아래 검색 스켈레톤 UI 항목에
별도 기록한다. 기존 전체 검증을 후속 커밋에서 재실행한 것으로 해석하지 않는다.
최신 S01–S02 수정 작업의 전체 493파일·10,118 pass와 최종 YouTube 937 pass는
아래 별도 수정 항목에 기록했다. 검사 중 마지막 경계 보완을 마친 뒤 YouTube
전체를 재실행했으며, 이전/전체/집중 검사 수치는 중복 합산하지 않는다.
이전 C01–C03의 19개 브라우저 회귀·Worker 번들 검증은
[2차 수정 기록](design/beta-defect-repair-2026-09-27-round-2.md)의 해당 코드 관측이다.
이전 51개 브라우저 회귀·짧은 WAV 실오디오 검증은
[이전 수정 기록](design/beta-defect-repair-2026-09-27.md)의 해당 코드 관측값이다.
쿠키의 별도 Chromium 지연 응답 검증은 [이전 수정 기록](design/account-cookie-ownership-2026-09-27.md)의 관측값이다.

아래 표의 전체 QA 수치는 `d3ef74ab` 시점이며, 최신 집중 검증과 별도로 보존하는
과거 관측·실기 한계를 구분한다.

| 확인                  | 결과 / 한계                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 전체 단위·broad coverage | 최신 수정 작업 트리 496파일·10,264 pass / 0 fail / 0 skip. 원래 threshold 통과. statements 86.24% / branches 79.83% / functions 90.88% / lines 89.95% |
| Critical·tooling·Worker coverage | 각각 50파일·1,772개 / 13파일·342개 / 26파일·1,726개 통과, fail·skip 0. 원래 threshold 유지. QA-T02–03의 선택 누락 수정 반영 |
| 타입·린트·정적 검사   | 최종 전체 타입·린트·서식·소스/보안/문법 검사 23개 통과. Worker bundle dry-run 6개 통과. cache-history guard는 공개 증분 전 예상 실패이며 별도 승격 잔여 gate |
| Chromium E2E          | 최종 공식 전체 552 pass / 0 fail / 0 skip / 0 flaky. 격리된 4개 shard, 각 worker 1·retry 0. 수정한 FQA01·QA-T01 집중 2개는 별도 이전 결과 |
| Windows WebKit E2E    | 공식 모바일 lane 60 pass / 0 fail / 기존 3 skip. 세 skip은 데스크톱 전용 전환·화살표·hover 문맥 제외. 실제 iPhone 또는 WebRTC 실기 검증이 아님 |
| 프로덕션 빌드 smoke   | 최종 App production 빌드·artifact guard 8개, 동일 산출물의 Chromium candidate 9개·WebKit Service Worker 1개 통과. fail/skip/flaky 0, 원격 배포 없음 |
| PRO 공유 도중 입장    | 이전 집중 회귀 3파일·18개 통과 근거 보존. 현재 전체 단위 검사에도 기존 입장·복원 경계 포함. 네이티브 API·RTC는 모사 |
| PRO 공유 종료·번역    | 기존 C01–C03 회귀도 최신 전체 단위 스위트에 포함해 통과. 최초 발견·집중 실행 수치는 2차 수정 기록 참조. 운영 D1·실기는 미검증 |
| 하이브리드 오디오     | 이전 QA의 합성 PCM·Chromium·실파일 검증 근거는 엔진 문서와 각 회차에 있음. 현재 코드의 모든 실기·모든 장기 세션을 완료했다는 뜻은 아님 |
| 원격 CI               | 베타 push는 현재 `ci.yml`의 main/PR 조건을 만족하지 않음. 최종 main SHA CI 후보는 아직 없음                                            |
| 공개 배포·라이브 검증 | 실행하지 않음                                                                                                                          |
| 후속 발견 감사 | 3차 D01 발견 당시의 실패는 보존. 4차 새 확정 0건, 고유 집중 회귀 21파일·328개 통과 후 D01 수정·최종 검증 완료 |
| Luna 조합 탐사 | checkout `1439e338`, 동일 제품 코드. 새 로컬 프로브 7파일·1,250 pass·최종 fail/skip 0. ASTRA 주요 1,082개 독립 재실행 통과. 브라우저·실기·전체 스위트 재실행 아님 |

다음 확인은 과거의 녹색 결과를 복사하지 말고, 실제 수행 환경과 SHA를 기록한다.

- [x] 2026-10-07 대회 종료·main 병합·프로덕션 배포·Operations Drift Audit 재활성화 승인 확인. 정상 PR·배포 절차로 진행.
- [x] `8.7.0` / `v631` 버전 mirror·cache-history·`build:checked`, PR CI와 main `e8001e93`의 CI `37583802398` 및 immutable candidate 확인.
- [x] Release `37584399403`: `all`/Developer API D1 false, checkpoint·6개 Worker 배포·모든 live smoke·최종 소유권·PRO readiness·coherent-production marker 확인. 배포 후 drift `37584995408` 31 pass/0 fail/5 manual-only.
- [x] 공개 fresh 확인: 45개 자산 hash가 main candidate와 일치, 10개 HTML 경로 200, en-US/ko-KR native Chromium의 새 main·active SW/cache v631·정상 bootstrap·page error 0. 초기 경로 미기록 fetch timeout과 후속 계측 전체 통과는 [배포 기록](design/release-8.7.0-2026-10-07.md)에 구분.
- [x] 후속 `8.7.1`/`v632`: PR #247·정확한 main `f005a706`의 CI `37589560758`/immutable candidate 및 Release `37590255149` 성공. `app`/D1 false, checkpoint·App 최종 소유권·선택된 smoke·coherent marker 확인. 다른 5개 Worker는 `e8001e93` 유지·호환성 통과.
- [x] 8.7.1 공개 fresh 확인: 45개 자산 hash·ko/ja/ar HTML 3경로 200·en-US/ko-KR Chromium의 변경 문구/BETA·정상 줄바꿈·bootstrap ready·page error 0·v632 cache 확인. 실기·기존 운영 탭/PWA 확인과 구분하며 1절에 범위 기록.
- [x] 후속 `8.7.2`/`v633`: PR #249·정확한 main `94fa5b03`의 CI `37592984640`/immutable candidate 및 Release `37593498828` 성공. `app`/D1 false, checkpoint·App 최종 소유권·선택된 smoke·coherent marker 확인. 다른 5개 Worker는 `e8001e93` 유지·호환성 통과.
- [x] 8.7.2 공개 fresh 확인: 45개 자산 hash·ko/ja/ar HTML 3경로 200·en-US/ko-KR Chromium의 `YouTube` 표기·YouTube BETA 제거·정상 줄바꿈·bootstrap ready·page error 0·v633 cache 확인. 실기·기존 운영 탭/PWA 한계 유지.
- [x] 후속 `8.7.3`/`v634`: PR #263·main `10be9957`의 CI `37722363300`/immutable candidate 및 Release `37722846236` 성공. `app`/D1 false·App 소유권·선택된 smoke·다른 5개 Worker 호환성 확인. 고유 로컬 unit10,781·검색 E2E7·공개 CSS hash/fresh ko bootstrap·v634 확인. 실기·기존 운영 탭/PWA 한계와 R2 조사 종료 유지.
- [x] 후속 `8.7.4`/`v635`: PR #265·main `358b3fc3`의 CI `37729046851`/immutable candidate 및 Release `37729556678` 성공. `app`/D1 false·App 소유권·선택된 smoke·다른 5개 Worker 호환성 확인. 로컬 unit 10,781·production CSS 레이아웃 16조합·정적/build·공개 CSS/SW hash 및 fresh ko bootstrap/v635/위쪽 12px 확인. 전체 E2E·실기·기존 운영 탭/PWA 한계와 R2 조사 종료 유지.
- [x] 8.7.2 완료된 로컬 검증·test-only 보완 `716c37af`: 로컬 unit 10,781·원격 PR CI/4종 coverage, 기준 전체 Chromium 로컬/원격 각각 581, 최종 원격 WebKit 66/기존 3 skip·SW 1·실제 9게스트 R2 로컬/원격 통과. ICE observer 회귀 51·정적/빌드·감사 0·drift 자동 31 통과. 최초 8/9 원인은 미확정이며 인증 Developer API canary·실기·수동 한계를 [전체 검증 기록](design/full-verification-8.7.2-2026-10-07.md)에 보존.
- [x] 최종 Full E2E `37602041553`의 Chromium 581 pass/실패·skip·retry 0와 모든 job 실제 성공 확인. PR #251로 테스트·문서 게시; 검사 SHA `716c37af`와 후속 문서·main SHA는 구분한다. 후속 병합·CI 상태는 PR 연결 기록에서 확인하며 제품을 재배포하지 않음.
- [ ] 운영 R2 원인 미확정(이번 조사 종료) — 앱 없이도 독립 browser·단일 수신에서 지연 재현. 핫스팟/집 Wi-Fi 교차 대조로 접속 경로 연관성 확인, 정확한 하위 원인 미확정. 원격 새 방 3/3·GET 54개와 집 순차 6회는 완료. H2·동일 객체 고정 본 측정 72개에서도 한 연결의 동시 9개가 54초→17초로 달랐다. 후속 Worker/관리 API Node 대조는 기본 수신창에서 차이가 컸지만 16MiB 창에서는 양쪽 모두 빠르게 완료했다. 합성 Worker 주소 대조 본48+준비2와 직후 R2 본36+준비1도 H2/LAX에서 전부 빠르게 완료·정리했다. 최신 두 계정 workers.dev 대조 본96+준비4도 전부 빠르게 완료·양쪽 LAX·임시 Worker 삭제 확인. 계정 변경으로 ICN이 되지 않았으며 S3 직결이나 Chromium 지연 원인 입증은 아니므로 추측에 따른 제품 수정은 보류한다. 과거 실패 해소·물리 다기기 검증·두 실패 앱 진단의 다음 곡 전환도 미검증. [최신 계정 대조](design/full-verification-8.7.2-2026-10-07.md#두-계정의-workersdev-라우팅-대조--2026-10-08).
- [ ] Drift 수동 5항목: zone routes, Access/MFA, WAF·비용 알림, 별도 Git-triggered 배포, 운영 review/check 정책. 자동 감사 통과로 완료 처리하지 않음.
- [x] 2026-10-08 최종 요청 재검사: `0cee146f` 기준 운영 host1/guest9 원래 R2 검사 1회 pass·retry0, PUT2/GET18·다음 곡 전환 통과. 개별 수신 1.161–4.599초. 위 미확정 원인 항목을 해소하지 않으며 제품·배포 변경 없음.
- [x] 2026-10-08 지연 이슈 최종 심층 리뷰: `a221f2a4`, 새 확정 코드 결함0·관련19파일594pass/fail·skip0. 원인 미확정은 유지하되 사용자 요청대로 이번 조사 종료. 추가 운영 실험·반복 검사·수정/배포를 예약하지 않음.
- [x] 2026-10-07 30라운드 후속 — 확정 12건 수정과 로컬 회귀 완료. 최종 unit 10,730개·4종 coverage, 초기 전체 Chromium 580개와 최종 영향 18개/production 17개, WebKit 66개(기존 3 skip), 전체/prod-only 보안 감사 0. 초기 실패·빌드 구분은 [후속 보고서](design/beta-30-round-repair-2026-10-07.md)에 보존.
- [x] R08/R25 별도 보강 — 정상 파일 조각·메타데이터 계약 확인, 번역 초안의 지속 요청 ID와 제출 전 저장 성공 조건. 구형 UUID/선택 MIME 호환성 회귀도 수정. 원래 미확정 2건을 확정 결함 수에 합산하지 않음.
- [ ] R26 후속 legacy 관찰 — 최초 Refresh 승인 뒤 15초 동안 갱신이 관측되지 않은 1회를 미확정으로 유지. 추가 계측 10/10 통과는 원인 입증이 아님. 재현 시 승인→SKIP_WAITING→waiting worker 상태→controllerchange→새 문서를 페이지 밖 기록으로 연결하고, 구형 실제 기기에서도 확인. [관측·진단·한계](design/beta-30-round-repair-2026-10-07.md#3-검증-기록).
- [x] SQ01 — 일반방 직결 수신의 늦은 PREPARE → START가 받은 prefix를 지우던 결함 수정. 실제 stop subscriber를 포함한 100개 통합 회귀·관련 단위 2,896개·Chromium 33개 통과. 다른 세션·메타데이터·취소·이미 중단된 수신·연결 교체 시 보존 거부 확인. [수정 기록](design/beta-sequence-qa-2026-10-03.md#repair-addendum--2026-10-03).
- [x] SQ02 — 늦은 RESUME에도 같은 세션·큐·메타데이터의 실제 RAM prefix와 sparse 청크 유지. 18개 순서·신원 회귀와 프리로드 새 바이트/중복 대조군 통과. [수정 기록](design/beta-sequence-qa-2026-10-03-round-2.md#repair-addendum--2026-10-03).
- [x] SQ03 — 외부 소스 전환 시 파일 복구 예약·응답 권한·호스트 전송 수명 종료, 늦은 START의 placeholder 덮기 차단. 정상 파일 복귀·일시정지 복구 대조군 통과. [수정 기록](design/beta-sequence-qa-2026-10-03-round-2.md#repair-addendum--2026-10-03).
- [x] SQ04 — cue 준비 중 마지막 seek와 PLAY 의도를 유지하고 PAUSE·정지·다른 곡은 이전 시작을 취소. legacy/v2·정지 복원·수동 오프셋 포함 20개 회귀 통과. [수정 기록](design/beta-sequence-qa-2026-10-03-round-2.md#repair-addendum--2026-10-03).
- [x] SQ05 — 데모 진입 실패 시 같은 방에서 새로 적용된 canonical 음향 설정 보존. 정상 종료·sync-OFF·기기 로컬 출력·다른 연결 보호 유지. 실제 host/guest UI 실패 재현 및 모듈 12개 회귀 통과. [수정 근거](design/beta-sequence-qa-2026-10-03-round-3.md#repair-addendum--2026-10-03).
- [x] SQ06 — PRO 현재 적용 revision의 YouTube 오류/ENDED 관측은 heartbeat snapshot 지연 중에도 전달. 더 최신 revision·권한 변경·재입장 시 오래된 관측 거부, 길이 있는 ENDED의 기존 1회 재시도 유지. 실제 runtime/API body/iframe 합성 회귀 21개 통과. [수정 근거](design/beta-sequence-qa-2026-10-03-round-3.md#repair-addendum--2026-10-03).
- [x] SQ07 — 실패 곡 재선택 시 이전 출력·진행 중 로드/수신을 정리하고 실패 곡을 선택하되 재디코딩하지 않음. 이전 bulk 청크·비인가/stale 명령 보호, 반복 요청의 정상 프리로드 보존, R2·PLAY_PRELOADED 포함 합성 21개 회귀 통과. [수정 근거](design/beta-sequence-qa-2026-10-03-round-4.md#repair-addendum--2026-10-03).
- [x] SQ08 — PRO 모든 역할의 일반 채팅에 기존 서버 slowmode를 전송 전에 적용, 거부될 메시지의 초안 보존·허위 말풍선 방지. 기존 일반방 면제·귓말·명령 유지. 단위 8개 및 실제 UI 전/후 재현 통과. [수정 근거](design/beta-sequence-qa-2026-10-03-round-4.md#repair-addendum--2026-10-03).
- [x] SQ09 — PRO 복구 전/중에 시작한 HTTP PREPARE는 현재 동일 transition일 때만 수용. 복구 generation·playlist lease로 오래된 ticket 완료도 차단. 유효 COMMIT·새 명령·중첩 단절·종료/재입장 포함 16개 회귀 통과. 실기 음향 정렬 보장을 뜻하지 않음. [수정 근거](design/beta-sequence-qa-2026-10-03-round-4.md#repair-addendum--2026-10-03).
- [x] SQ10 — 유효 호스트·방·곡·로드·전송 세션에 한해 PREPARE 뒤 최신 PAUSE 위치 보존. paused late join·ICE 대기 중 PAUSE/seek·작은/큰 프리로드 승격·OP 재생 포함 합성 46개 통과. 오래된/비인가 명령·새 PLAY 보호 유지. [수정 근거](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03).
- [x] SQ11 — PRO 취소된 설정과 새로운 조작을 필드·revision별로 구분. 지연 PUT 및 pre-PUT GET 거부, 권한 복구·새 동일값·EQ/리버브 분리·OFF→ON 전체 발행 포함 runtime 22개와 tracker 8개 통과. 공개 Worker 응답 기반 재현도 통과. [수정 근거](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03).
- [x] SQ12 — PRO 알려진 전송 거부는 초안·전송 기록·로컬 상태 보존. 일반 채팅/귓말/명령·BOT·로컬 도움말/포커스 단위 회귀와 Chromium 명시적 재시도 3개 통과. 자동 재전송·서버 ACK 정책 추가 없음. [수정 근거](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03).
- [x] SQ13 — 일반방 YouTube 수동 보정의 유효한 재생 의도로 공유 복원 상태 캡처. 임시정지·명시적 정지·지연/완료·선택/방 변경·취소 포함 18개 통과. PRO canonical 복원 경로 유지. [수정 근거](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03).
- [x] SQ14 — 최초 queue-mode 조회에서도 현재 권한·세션의 명시적 필드 조작 보존. 미조작 필드는 canonical 적용, 반복 0→1→2·취소/권한/재입장 경계 검증. [수정 근거](design/beta-sequence-qa-2026-10-03-round-6.md#repair-addendum--2026-10-03).
- [x] SQ15 — 필수 GET 실패에도 기존 1/3/10초 재시도 적용, 권한·세션 취소 및 새 조작 우선권 유지. 충돌 후 GET 실패 시 옛 필드 의도 정리·새 기준 조회도 독립 검증. SQ14–SQ15 새 회귀 31개 통과. [수정 근거](design/beta-sequence-qa-2026-10-03-round-6.md#repair-addendum--2026-10-03).
- [ ] iPhone Safari/PWA와 Android·Windows 혼합 방: 작은 곡 → 큰 MP3/FLAC/AAC → 작은 곡, 호스트·게스트 엔진이 다른 경우.
- [ ] 시작·연속 seek·이전/다음·곡 끝 반복·중도 참여·프리로드 재정렬·큰 수동 싱크·네트워크 단절/재합류·잠금/복귀·장기 메모리 추이.
- [ ] 2026-10-04 후속 QA의 탐색 후 일시 native PCM 차이(~2.3초, 관측 창에서 자동 복구)를 실제 기기·지연 환경에서 확인. 최종 FIFO3.2초 대조는 실제 hard 보정·수렴을 확인했으나 이전 nominal transient 원인은 미확정. PLAY 수신 시 clock/anchor·실제 음향 시작과 복구 시간을 기록하며, 브라우저의 2.5초 수렴 허용값을 청음 정렬 기준으로 대신하지 않음. [앞선 관측](design/beta-sequence-qa-2026-10-04-round-2.md#native-browser-timing-observation), [최종 지연 대조](design/beta-final-qa-2026-10-04.md#native-timing-observation-and-recovery).
- [x] S01 기본 수정 — 참가자별 시작 지연과 당시 회귀를 `c3eae88c`에 반영. 후속 XS01·XS03에서 긴 대기의 소유권·취소 경계 추가 수정. [기존 수정 범위](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27).
- [x] S02 — 반복 직후 확정 입력을 현재 재생 회차·연결·player·요청값에 한정해 새 snapshot까지 보존. 새 입력/재생 명령/회차 변경 시 취소, 최대 대기 후 종료. 실제 UI·모사 iframe heartbeat 지연 회귀와 23개 입력 회귀 통과. PRO의 같은 결함이 확인됐다는 뜻은 아님.
- [ ] S01–S02 실기 확인: 일반방/PRO, host/guest 양수·음수 보정 후 다음 곡·반복·중도 입장·취소, 실제 YouTube와 iPhone Safari/PWA·Bluetooth 첫 음 비교. 플레이어 시간 자동 검증을 실제 스피커 정렬 보장으로 해석하지 않음.
- [x] XS01 — 일반 heartbeat/부수적인 iframe 상태는 시작 소유권을 침범하지 않으며 snapshot은 갱신. 방장의 barrier가 먼저 종료된 뒤 새 seek/pause가 와도 게스트의 옛 예약을 취소. 실제 연결한 컨트롤러 및 브라우저 회귀 추가.
- [x] XS02 — 시작 위치가 0 미만인 만큼 실제 출력만 대기. 기본·대용량 엔진과 방장/게스트/PRO/데모 공통 경로 검증, 공유 시작·논리 시각 유지. 새 모듈 96개와 실제 PCM Chromium 회귀 통과.
- [x] XS03 — 실제 Media Session PAUSE가 PRO 예약·직접 시작을 취소. 해당 이전 commit만 처리 완료로 소비하여 PRO 제어기가 실패 복구로 다시 재생하지 않음. 명시적 재개·새 명령·종료 후 재진입 회귀 통과.
- [x] XS04 — 예정 호출 시각보다 늦은 만큼 시작 위치 보정. ±9999ms·0ms, 1.5초 지연·60초 후 위치, 다음 시작 학습값 유지·플랫폼 lead·길이 제한 회귀 통과.
- [x] FQA01 — 외부 시작 복구 및 PLAYING 응답 대기까지 공유 소유권을 UI·수동 싱크·랑데부·일반 상태에 적용. 새 pause/seek·종료/재진입·방장 복구 중 seek/신규 참여 경계도 수정. 실제 UI `-9999ms` 회귀와 새 모듈 통합 9개 통과; 복구 완료 후 Sync 사용 가능도 검증.
- [x] QA-T01 — 곡 삭제·중도 입장 E2E의 정확한 생존 queue ID·삭제 revision·DOM 수렴 대기로 수정, 집중 브라우저 회귀 통과. 공통 최소 개수 helper·시간 제한·기존 assertion 유지.
- [x] QA-T02 / QA-T03 — critical profile의 기존 `device-failure-sequence-qa.test.ts`, Worker profile의 기존 `account-cookie-ordering.test.ts` 선택을 추적 설정에 반영. 각각 1,772개·1,726개와 원래 coverage gate 통과, threshold 완화 없음.
- [x] 최종 변경의 공식 Chromium 전체 552개 통과. fail/skip/flaky 0, 네 shard 모두 exit 0. 기존 반복재생 E2E를 변경하지 않고 싱크 창 유지 회귀도 통과.
- [x] 최종 변경의 공식 Windows WebKit 모바일 lane 60개 통과, 기존 데스크톱 문맥 제외 3개 유지. 실제 iPhone Safari/WebRTC·음향 검증과 구분.
- [x] 최종 프로덕션 빌드·artifact guard 8개·Chromium candidate 9개·WebKit Service Worker 1개 통과. 모두 로컬이며 실제 배포는 별도.
- [ ] 기존 로그인 유지, 탭 간 새 로그인과 늦은 로그아웃/탈퇴 응답, 익명/인증된 방 입장·계정 관련 API.
- [ ] 일반방·PRO방과 API의 리버브 10초 경계, 데모 종료 후 설정 표시 및 실제 효과 일치.
- [x] D01: PRO 공유 도중 신규 입장의 초기 복원 취소 수정. RTC 트랙 도착 전 경계와 종료 복귀·서버 명령을 로컬 회귀로 검증. 실제 SFU/실기는 위 잔여 확인에 포함.

실기·전체 E2E의 추가 확인은 자동 배포 gate와 구분한다. 현재 CI의 필수 subset과
coverage 조건을 생략하지 않는다. 미완료 항목은 완료로 바꾸지 말고, 남겨둔 범위와
공개 여부의 결정을 배포 기록에 적는다. 현재 QA21의 알려진 쿠키 결함은 후속 수정으로
해결됐으며, QA21 원문은 당시 상태를 보존한 기록이다.

### 2026-09-27 발견 감사 — 확정 4건 베타 수정 완료

먼저 수정 없이 발굴하고 재검증한 뒤, 사용자의 후속 승인으로 확정 4건을
수정했다. [발굴 감사 기록](design/beta-defect-harvest-2026-09-27.md)은 발견 당시
결과를 보존한다. 현재 해결 근거는 [수정 기록](design/beta-defect-repair-2026-09-27.md)과
코드 `b833e2a62bd7eceaa1c9a074d463a36477b514e4`다. 아래 완료는 베타 상태이며 프로덕션 배포 완료가 아니다.

| ID | 결함 | 현재 상태 |
| --- | --- | --- |
| B01 | PRO에 같은 YouTube 플레이리스트의 서로 다른 저장본을 넣으면 하위 곡 캐시가 충돌해 선택 실패 | 큐 저장본별 불변 목록·제목 캐시. 표시·선택·로드·탐색·종료·캐시 퇴출 회귀 통과 |
| B02 | 채팅 금지 직전 초안을 전송하면 상대는 못 받는데 내 말풍선이 생기고 초안 삭제 | Standard·PRO 권한 상태 투영 및 일반 메시지·귓말·공개 BOT 전송 전 차단. 금지 해제 후 재전송 통과 |
| B03 | 이미 적용한 승인 번역이 누적되면 새 번역 1개도 내보내기 상한으로 차단 | 페이지 순회 후 실제 새 초안에 제한 적용. 기존 1,000개·8MiB·오래된 승인 차단 유지 |
| B04 | 100ms 이하의 정상 로컬 파일이 끝나도 자동 다음 곡·반복이 진행되지 않음 | 유효한 양수 길이 종료, 예약 시작 보호, 짧은 곡 오차 제한. 실제 Chromium 종료·이동·반복 통과 |

이전 감사의 관측 테스트와 이번 수정 검증 수치를 합산하지 않는다.
새 배포 대상은 늘지 않지만 App Worker에 번역 내보내기 runtime 변경이
추가되었다. 의존성·데이터 계약·버전은 유지한다. 당시 미확정이던 PRO 복귀와
프리로드 경계의 후속 판정은 아래 2차 기록을 따른다.

### 2026-09-27 발견 감사 2차 — 추가 확정 3건 베타 수정 완료

[2차 발굴 기록](design/beta-defect-harvest-2026-09-27-round-2.md)은 checkout
`63516859147008282104c5bd52d237fe9273e51b`, 제품 코드 `b833e2a6`의 관측이다.
당시에는 제품 수정 없이 발굴했으며, 이후 사용자 승인으로 C01–C03을
수정했다. 현재 코드는 `3dd9086cdced0fc25426da82239977b6da004074`, 근거는
[2차 수정 기록](design/beta-defect-repair-2026-09-27-round-2.md)이다.

| ID | 결함 | 현재 상태 |
| --- | --- | --- |
| C01 | PRO 공유 종료 후 YouTube가 CUED·0초에 남고 앱은 재생 중으로 표시 | 서버 idle 확인 뒤 현재 체크포인트로 재생·일시정지 복원. 재시도·새 공유·세대 누락·취소 경계 검증 |
| C02 | 일반방 프리로드가 진행 중이어도 조기 END의 10초 타이머로 폐기 | bulk 종료 순서와 실제 수신 진행 감시로 통합. 구버전 END·16초 정상 tail·무진행·중복 처리 검증 |
| C03 | 탈퇴 정리 대기 작성자의 번역 제안에 다른 사용자의 추천·응답 조회 허용 | 작성자 삭제 fence를 사전·원자적 변경·최종 응답 조회에 적용. 카탈로그 대기 중 탈퇴도 차단 |

발굴 당시의 집중 회귀 35파일·913개와 발견 재현 실패는 이전 관측으로
보존한다. 이번 완료는 베타 수정·로컬 자동 검증이며 운영 발생 빈도,
실기 네트워크 검증이나 프로덕션 배포 완료를 뜻하지 않는다. 새 배포 대상은
늘지 않으며 App Worker에는 번역 추천 경계 변경이 추가됐다.

### 2026-09-27 발견 감사 3·4차 — 추가 확정 1건 베타 수정 완료

[3차 발굴 기록](design/beta-defect-harvest-2026-09-27-round-3.md)은 checkout
`ab4220b75ba58cfec1939f8eec4169bb7f86feb7`, 제품 코드 `3dd9086c`의 관측이다.
당시에는 제품과 추적 테스트를 바꾸지 않았다. 이어진 4차에서 새 독립
결함이 확정되지 않아 사용자의 조건부 수정 지시에 따라 D01을 수정했다.
현재 코드와 근거는 `2347760c5e5b902327a05ca216c8b72409ee72d3` 및
[4차 발굴·D01 수정 기록](design/beta-defect-harvest-2026-09-27-round-4.md)이다.

| ID | 결함 | 현재 상태 |
| --- | --- | --- |
| D01 | PRO 공유 중 입장 시 live 수신 준비 이후 첫 시계 보정이 끝나면 이전 YouTube를 다시 재생 | live에서 기존 자동 복원 소유권 폐기, 확정 idle에서 새 복원 허용. 준비/시계 지연·종료 복귀·권위 명령 유지의 새 회귀 18개 통과 |

3차 집중 회귀 46파일·1,700개와 발견 재현의 2실패·1대조군 통과는 당시
관측으로 보존한다. 4차는 고유 21파일·328개 통과, 새 확정 0건이며 이후
D01 수정의 전체 검증은 위 표를 따른다. 실기·실제 SFU·네이티브 YouTube 검증이 아니며,
이미 RTC가 붙은 경우나 일반방까지 같은 결함이라고 확대하지 않는다.
기존 공유 종료 복귀 C01과는 다른 경계다. D01은 App 클라이언트 변경이며
새 Worker/DB 계약은 없다. 누적 배포 대상과 공개 승격의 잔여 확인은 유지한다.

`Full E2E` workflow에는 실제 프로덕션 large-room probe도 들어 있다. 단순 로컬
테스트로 오인해 실행하지 않으며, 해당 job은 non-blocking이므로 workflow의
녹색 표시와 probe 자체의 성공 여부를 구분해 기록한다.

### 2026-09-27 Luna 조합 탐사 — 제품 수정 없이 새 확정 0건

[Luna 조합 탐사와 ASTRA 재검증](design/beta-luna-combination-audit-2026-09-27.md)은
checkout `1439e338aa83ac1065b0a335bdfcba12e63c7012`, 동일 제품 코드 `2347760c`의
추가 검증이다. 새 로컬 프로브 7파일·1,250개가 통과했다. 주요 모듈 조합
1,080개, 비정상 패킷 순서 대조군 2개, 보조 함수 순열 168개를 구분한다.
검색 540개는 서로 다른 순서 20개를 응답 결과 27종으로 확장한 수다.
ASTRA의 주요 1,082개 독립 재실행은 중복 실행이므로 총계에 더하지 않는다.

새 제품 결함은 확정되지 않았고 제품 코드·추적 테스트를 수정하지 않았다.
실제 브라우저·네트워크·코덱·PRO 서버 재생 통합이나 전체 스위트의 새
통과로 해석하지 않는다. 기록만 추가하며 배포 범위·계약·잔여 실기 확인은 유지한다.

### 2026-09-27 YouTube 검색 스켈레톤 UI 검토·배치 수정

checkout `693ded3ae0414919b8c4a569f4a64e279d6e16d9`, 동일 제품 코드 `2347760c`에서
사용자가 상태 안내 문구 위치와 스켈레톤 색상을 검토하도록 요청했다.
[실제 HTML](../index.html)의 `youtube-preview-status`가 검색 결과 컨테이너 뒤에
있어, 검색 중에는 스켈레톤 아래로 내려가고 실패 시 목록이 숨겨지면 입력창
아래로 복귀한다. 로컬 Chromium 390×844 미리보기에서 상태 문구의 상단은
603.27px → 228.80px로 약 374.47px 이동했다. 입력창 하단은 214.80px로 유지됐다.
미리보기는 실제 HTML/CSS와 검색 모듈을 사용하며, API 응답은 로컬에서 모사했다.

최초 검토에서는 수정하지 않았고 이후 사용자 승인으로 `736f195c8e6414ea527b0781cd96154ef36b452e`에서
공통 상태 문구를 입력창 바로 다음으로 이동했다. 같은 문구 노드와 ARIA 연결을
유지하며 검색·미리보기 로직은 바꾸지 않았다.
[스켈레톤 CSS](../css/style.css)는 이 검토 당시 기존 `--surface-3`를 사용했다. 기본 다크
`#404040`, 라이트 `#b7b9bb`로 [공개 디자인 토큰](../public/designsystem/colors_and_type.css)과
일치하며 새 임의 회색은 아니다. 스켈레톤 전용 1.6초 불투명도 애니메이션
0.55–0.9가 적용되고 동작 줄이기에서는 0.7로 고정된다. 배포 계약·버전은 그대로다.

수정 검증: Windows, Node 24.20.0, Vitest 5에서 기존 검색·플레이어 제어·앱 UX
계약 테스트 3파일·282개 통과, fail/skip 0. 로컬 Chromium에서 데스크톱 1280×900,
모바일 390×844, 낮은 모바일 390×480, RTL·라이트 모바일을 확인했다.
각 화면의 로딩·실패·빈 결과·성공 상태 모두 안내 문구가 입력창 하단에서
14px 간격을 유지했다. URL 미리보기 성공 시 안내를 숨기는 기존 동작도 유지한다.
브라우저 검증은 실제 HTML/CSS/검색 모듈을 쓰되 응답을 모사한 로컬 미리보기이며,
실서비스·실기·전체 E2E 검증은 아니다. 새 제품 테스트나 CSS 변경은 없다.
전체 HTML 서식 검사는 기존 생성 문구 등의 서식 차이로 통과하지 않아, 무관한
전체 파일 재서식은 제외하고 노드 이동만 반영했다. `git diff --check`는 통과했다.

이후 사용자 요청으로 `b9ea66d3b91fe35b04a9da6cc9a6b1011861c144`에서 스켈레톤의
썸네일·제목·채널 막대만 `--surface-2`로 낮췄다. 불투명도와 모션은 유지했다.
로컬 Chromium 390×844에서 다크 `#202020`, 라이트 `#eff1f3`가 세 요소 모두에
적용되는 computed style과 화면을 확인했다. 색상만 변경하여 전체 테스트는
재실행하지 않았고 새 테스트도 추가하지 않았다. 배포 범위·버전·캐시는 유지한다.

`bc8e25757abacdd2ee82c368b4617be42be328e4`에서는 사용자 요청에 따라 불투명도만
60–100%로 조정했다. 로컬 Chromium에서 시작/끝 0.6, 중간 1.0, 주기 1.6초를
확인했다. `surface-2`와 동작 줄이기의 애니메이션 없음·불투명도 0.7은 유지한다.
CSS 두 값만 변경했으며 전체 테스트는 재실행하지 않았다.

다음 후속 요청은 `df7b915a9c17465a30dbfae82cec9389c4d2f56d`에 반영했다.
색상은 다시 `surface-3`, 불투명도는 50–80%다. 로컬 Chromium 다크/라이트에서
세 요소의 토큰 색상, 애니메이션 시작 0.5·중간 0.8·주기 1.6초를 확인했다.
동작 줄이기의 0.7 고정은 유지하며 전체 테스트는 재실행하지 않았다.

최신 요청은 `09123ea84081660ad8578b81e98f795386555179`에서 불투명도를
25–50%로 낮춘 것이다. 로컬 Chromium에서 시작 0.25·중간 0.5와 기존
surface-3·1.6초 주기·동작 줄이기 0.7 고정을 확인했다. CSS 두 값만 변경했다.

### 2026-09-27 YouTube 수동 싱크·제로스타트 S01–S02 수정

checkout `35f122a9`에서 수정한 작업 트리를 검증한 뒤 `c3eae88c`로 커밋했다.
이 항목과 제품 변경을 함께 반영했으며, 발견 당시 관측값은 [원본 조사 기록](design/youtube-manual-zero-start-audit-2026-09-27.md)에
보존하고 그 문서의 수정 부록에 현재 근거를 추가했다.

일반방과 PRO의 음수 수동 보정은 미디어 0초에서 버리는 대신 해당 기기만
남은 시간만큼 늦게 시작한다. 방 전체의 시작 시각은 바꾸지 않는다. 방장 자신이
기다리는 동안에도 방의 기준 시각은 전진하며, 늦은 COMMIT·준비·unmute·접속 교체와
취소를 분리했다. 기존 학습값이 수동 보정을 시작 오차로 학습하지 않게 한다.
일반방의 반복 직후 확정 입력은 새 snapshot이 없을 때 현재 재생 회차에 한정해
보존하고, 새 입력·재생 명령·연결/플레이어 교체가 오면 폐기한다. 최대 18.999초는
기존 준비/cooldown과 방장의 최대 음수 보정을 합한 복구 한도이며 매번 기다리는
시간은 아니다. 준비된 snapshot이 있으면 바로 적용한다.

검증 환경은 Windows·Node 24.20.0·Vitest 5·로컬 Chromium이다.

- 전체 단위 테스트: 493파일·10,118 pass·fail 0·기존 skip 1. skip은 Windows에
  `jq`가 없는 기존 배포 분류 검사다. 마지막 경계 보완과 전체 검사가 일부
  겹쳤으므로, 소스 수정 완료 후 YouTube 전체 937개를 별도로 재실행해 모두 통과했다.
- 실제 UI Chromium 회귀: 일반방 host/guest 양수·음수/동시 음수·방장 -5초
  다음 곡 6개 통과. 이 실행 뒤 late COMMIT 및 fallback의 비동기 audio 복원
  한도를 보완했고 최종 모듈 회귀로 검증했다. 소스 확정 뒤 실행한 반복 직후
  입력 1개도 통과. 두 회귀 모두 실제 앱·local PeerJS·모사 iframe이며 전체 E2E
  또는 실제 YouTube/실기 검증은 아니다.
- App·단위 테스트·E2E 타입 검사, 전체 App 린트와 새 E2E 2파일 린트,
  변경 TypeScript 서식, E2E/App 프로덕션 빌드 통과. Worker·tooling 타입 전체를
  이번에 다시 실행한 것으로 해석하지 않는다.

App 클라이언트 수정만 추가된다. 의존성, UI, 메시지/서버 계약, DB, Worker,
secret/binding 변경은 없다. 누적 `all`/Developer API D1 off 판정과 공개 전
버전/cache 증분 요구는 유지한다. 현재 버전/cache `8.6.61`/`v630`, main과
프로덕션 및 Operations Drift Audit의 비활성화 상태는 이 작업으로 바꾸지 않는다.
실기·최종 main 후보·배포는 미완료다.

### 2026-09-27 극단값 동기화 발굴 — 당시 XS01–XS04 미수정

아래는 수정 전 발견 기록이다. 현재 수정 상태와 검증은 바로 다음 항목을 따른다.

검토 checkout은 `fe3fdb10f0ee4ffc4a028640cf198c52b488a810`, 동일 제품 코드는
`c3eae88c`다. 사용자의 발굴 요청에 따라 제품 코드를 고치지 않고 조사했다.
[상세 감사](design/extreme-manual-sync-audit-2026-09-27.md)에 원인·재현·대조군·제한을
기록했다. 앞선 S01–S02 수정 결과는 당시 검사 기록으로 보존한다.

새 모듈 조합 863개를 최종 독립 재실행했다: 일반방 YouTube 266개 중 264 pass/2 fail,
로컬 파일 283개 중 249 pass/34 fail, PRO YouTube 314개 중 310 pass/4 fail.
총 40개 실패는 **서로 다른 버그 40개가 아니라 확정 원인 4개의 재현**이다.
최종 skip은 없다. 기존 로컬 파일 6스위트 352개 통과는 별도 기준 검사다.

로컬 Chromium·실제 UI·local PeerJS에서 YouTube 극단값 다음 곡 8개 중
6개 통과/2개 실패. 별도 타임라인 관측은 게스트가 예정된 약 10초 대신 4.676초에
먼저 시작하고, 10.670초 heartbeat에서 약 5.3초 되감기며 복구되는 것을 확인했다.
실제 60초 PCM WAV의 native 출력 4개 관측은 음수 host/guest 실패와 양수/0 대조군을
확인했다. 관측 스크립트 완료를 올바른 동기화 통과로 계산하지 않는다.
파일 → YouTube 지연 시작 → 파일 복귀 1개는 이전 iframe 부활 없이 통과했고,
파일 +9,999ms와 YouTube -9,999ms 설정도 분리 유지됐다.

PRO는 실제 앱 모듈·Media Session 핸들러·모사 iframe/서버 시간이며 실서비스
PRO 서버 검증은 아니다. 실제 YouTube·iPhone·Bluetooth 스피커 정밀도와 전체
E2E/전체 단위 스위트는 이번 조사에서 다시 검증하지 않았다. XS04의 일반
heartbeat 후속 처리는 소스 추적이며, 숨김→복귀의 별도 복구가 없는 조건이다.

수정 전이므로 제품/Worker/의존성/DB/버전/캐시/배포 범위는 그대로다.
이 발견으로 승격 준비가 완료됐다고 판정할 수 없다. 베타에는 조사·배포 기록만
반영하며 main, 프로덕션, 비활성화된 Operations Drift Audit은 유지한다.

### 2026-09-27 극단값 동기화 XS01–XS04 수정

코드 기준은 `c242bfd17f652f1480a6e79731d5130b5b6f6c19`다. 동일 소스의 작업 트리를
검증한 뒤 커밋했다. [후속 수정 기록](design/extreme-manual-sync-repair-2026-09-27.md)에
원인별 변경과 재현·모사·실기 범위의 차이를 기록했다.

일반방 YouTube의 예약/일반 상태 소유권과 늦은 새 명령의 취소를 정비했다.
로컬 파일의 음수 보정은 실제 기본·대용량 출력 지연으로 유지하되 공유 시각은
그대로다. PRO는 기기 자체 PAUSE를 오래된 commit이 되살리지 못하며, 늦은 시작
타이머는 그만큼 재생 위치를 따라잡는다. UI·서버·DB 계약과 수동 보정 상한은 같다.

- 집중 단위 검사: 로컬 448, 일반방 YouTube 287, PRO 67개 통과. 전체 검사와
  중복되는 부분집합이므로 합산하지 않는다.
- 브라우저: 실제 PCM 출력 4개·모사 YouTube UI 10개, 총 14개 통과. 로컬은
  최종 로컬 엔진 변경 이후, YouTube는 마지막 명시적 명령 취소 보완까지 포함한
  빌드에서 검증했다. 실제 YouTube/iPhone/Bluetooth 음향 측정은 아니다.
- 전체 단위: 495파일·10,250개 중 최초 10,245 pass/4 timeout/기존 1 skip.
  시간 초과 4개는 다른 무거운 검사 종료 후 단독 직렬 재실행에서 모두 통과했다.
  제한/검증을 완화하지 않았고, 전체를 한 번에 all green으로 실행한 것은 아니다.
  따라서 고유 10,249개 통과 확인, Windows `jq` 부재인 기존 1개 skip 유지.
  새 테스트 타입 수정 뒤 영향받은 163개와 마지막 PRO fixture 29개도 다시 통과.
- 전체 타입·린트, 변경 TypeScript 서식, E2E/프로덕션 App 빌드 및 추가 소스/identity
  guard 7개·빌드 guard 8개 통과. 자세한 경계는 후속 수정 기록 참조.
- `guard:sw-cache-version`은 베타 누적 변경에 공개용 cache 증분이 없어 예상대로
  실패했다. 검사를 완화하지 않았으며 최종 main 승격 때 버전/cache를 증분해야 한다.
  이는 수정 회귀 테스트 실패와 구분한다. `guard:release-identity`는 현재 `8.6.61` /
  `v630`의 파일 간 일치를 확인했다.

App 클라이언트만 추가 변경. 누적 배포 범위 `all` / Developer API D1 off 유지.
베타만 커밋·푸시하며 main·프로덕션·Operations Drift Audit 비활성화 상태는 유지한다.

### 2026-09-27 전체 QA 후속 수정 — FQA01·QA-T01–QA-T03

검증 소스는 `d3ef74ab4e196abbc2b2f3ea97988e3a91e379ac`이며 기준 checkout
`8c78a598121e2226f4ecfc4ed176e8e0704bed3d`의 수정 작업 트리를 검사한 뒤 커밋했다.
최종 전체·critical 검사 전후 1,046개 소스·설정·패키지 파일 해시 변화가 없음을 확인했다.
[수정 전 전체 QA](design/beta-full-qa-2026-09-27.md)의
실패 근거를 보존하며, 최신 구현·실행 범위는
[후속 수정 기록](design/beta-full-qa-repair-2026-09-27.md)을 따른다.

FQA01은 일반방 YouTube 제로스타트 프로토콜뿐 아니라 외부 플레이어 복구와
재생 응답 대기가 끝날 때까지 동기화 소유권을 유지하도록 수정했다. UI·수동
값/초기화·랑데부·heartbeat가 같은 경계를 사용한다. 명시적 새 pause/seek는
오래된 복구를 취소하고, 종료/재진입 시 잔여 작업을 정리한다. 방장 복구 중
새 seek와 중도 참여도 같은 소유권으로 처리한다. 일반 화면·정책·수동 보정
상한·Worker 계약은 변경하지 않았다.

첫 전체 E2E에서 readiness 알림이 반복 시작 시 이미 열린 싱크 창을 닫는
추가 UI 회귀를 발견했다. 알림은 버튼 상태만 갱신하도록 복원했고, 복구 중
실제 값 변경은 공통 입력 경계가 거부한다. 기존 반복 E2E는 수정하지 않았으며,
최종 전체 552개 검사에서 열린 창 유지와 반복 후 입력까지 통과했다.

QA-T01은 삭제와 입장이 겹치는 E2E에서 정확한 생존 queue ID, 삭제 revision과
DOM 수렴을 기다리도록 수정했다. 공통 최소 개수 helper·시간 제한·assertion은
유지했다. QA-T02–03은 누락된 기존 회귀 파일을 critical/Worker profile에
포함했으며 원래 coverage threshold는 그대로다. 공식 portable jq 1.8.2의
GitHub asset digest와 배포 checksum을 확인한 뒤 `MXQR_TEST_JQ_PATH`로 사용해
Windows의 기존 배포 분류 검사 skip을 해소했다. 전역 설치나 해당 테스트의
우회·검사 완화는 없다.

- 전체 단위와 broad coverage: **496파일·10,264 pass / 0 fail / 0 skip**.
  Critical **50파일·1,772**, tooling **13파일·342**, Worker **26파일·1,726**도
  fail/skip 없이 원래 global/per-file gate를 통과했다. 겹치는 profile은 합산하지 않는다.
- 집중 모듈 **8파일·744개** 및 실제 UI의 FQA01·QA-T01 브라우저 회귀 **2개** 통과.
  새 소유권 통합 9개는 음수 보정, 재생 응답 지연, heartbeat, 새 명령 우선권,
  종료/재진입을 검증한다. 마지막 fixture 보완 후 전체 단위 실행에서도 해당
  파일을 검사했으며 소스/실행 시점 근거는 후속 수정 기록에 있다.
- 공식 전체 Chromium **552 pass / 0 fail / 0 skip / 0 flaky**. 테스트 선택·worker 1·retry 0을
  유지하고 preview/PeerJS 포트·origin·산출물을 분리한 네 shard를 사용했다.
  공식 Windows WebKit **60 pass / 0 fail / 기존 3 skip**; 데스크톱 전용
  전환·화살표·hover 문맥의 제외를 실제 iPhone 검증으로 계산하지 않는다.
- 전체 타입·린트·서식·정적 검사 **23개**, Worker bundle dry-run **6개** 통과.
  수정 중 먼저 발견한 Promise 처리·서식 문제는 보완 후 전체 명령과 이전에
  단락된 tooling 단계까지 재검사했다.
- 프로덕션 App 빌드·artifact guard **8개**·동일 산출물의 Chromium candidate **9개** 및 WebKit
  Service Worker **1개**도 통과했다. 브라우저 fail/skip/flaky 0이며 원격 배포는 없다.
- `guard:sw-cache-version`은 frozen `8.6.61` / `v630` 이후 베타 runtime 변경으로
  예상대로 exit 1이다. 이를 통과로 표시하지 않으며, 승인된 승격 전 누적 변경을
  포함하는 version/cache 증분 커밋과 exact-main-SHA 검증이 필요하다.

네 Chromium shard·정적 검사와 병렬로 실행한 중간 단위 검사에서는 변경 없는
재생목록 DOM 회귀 한 건이 기존 15초 제한을 초과했다(16.836초). 테스트나 제한을
바꾸지 않고 다른 검사가 모두 끝난 뒤 원래 전체 suite를 재실행하여 **10,264 pass /
0 fail / 0 skip**를 확인했다. 해당 케이스는 6.928초로 통과했고 broad coverage도
원래 기준을 통과했다. 중간 실패는 `final-unit/`, 최종 단독 결과는 `final-idle/`에
보존했다. 이 PC의 전체 coverage와 전체 브라우저 검사는 분리 실행을 권장한다.
Tooling·Worker 전용 coverage는 UI 수정 전 통과 결과를 유지한다. 해당 소스·설정은
변하지 않았고 모든 테스트는 최종 전체 단위 검사에도 포함됐다.

이번 추가 변경은 App 클라이언트·테스트·coverage 설정이다. 새 의존성·D1·binding·secret·
번역 문구·Worker 계약은 없으며 누적 배포 범위 `all` / Developer API D1 off를
유지한다. 실제 YouTube 서비스·iPhone·Bluetooth 음향·운영 SFU 검증은 위 잔여
확인 대상이다. 베타 수정의 로컬 검증만 진행하며 main·프로덕션·Operations Drift
Audit 비활성화 상태는 유지한다.

### 2026-09-29 시작 로고 — 정확한 단일 리빌 마스크

검증 코드: `79f3a687a7222a69ff865846e0c715aa197d0f10`.
기준 checkout `4f49c35d` 위의 동일 소스 작업 트리를 검증한 뒤 커밋했다.
승인받은 로컬 비교안의 정확한 폴리곤 합성 방식을 적용했다. 36개 획은
`defs` 안의 입력 도형으로만 남고, 완성 로고 실루엣에 하나의 nonzero 마스크
경로를 적용한다. 기존 획 순서·지연·easing은 유지하고, 후속 획을 미리
노출하던 오버스캔과 개별 획의 0.3 SVG 단위 덧칠을 제거했다.

- 온보딩이 준비된 때부터 한 시계로 시작한다. 데스크톱 복제본은 고유 mask ID를
  갖고 같은 시점에서 이어지며, 2,540ms 그리기 완료 후 기존 인사말로 전환한다.
  2,900ms에는 마스크와 프레임 작업을 정리한다. 백그라운드 복귀·분리된 노드·
  동작 줄이기·페이지 이탈·스크립트 실패 시 정적 로고와 인사말 fallback을 확인했다.
- 단위 `classic-runtime-assets`, `wordmark-reveal-runtime`,
  `setup-carousel-motion`: **3파일·88 pass / 0 fail / 0 skip**.
- 새 `wordmark-reveal` 브라우저 회귀: Chromium **6 pass**, Windows WebKit
  **6 pass**. 기존 entrance·greeting·carousel Chromium **15 pass**.
  최종 각 실행의 fail·skip·retry는 0이다.
- 초기 브라우저 검사에서 멈춘 테스트 시계와 미디어 이벤트 도착 순서 두 곳을
  실제 DOM 상태 대기 후 시계 진행으로 수정했다. 픽셀 검사의 십자 이웃 판정은
  U자 윤곽 모서리까지 내부로 포함해 WebKit 한 픽셀(alpha 239/255)을 검출했다.
  대각 이웃이 alpha 4인 윤곽 경계임을 확인한 뒤, 참조 이미지의 **3×3 전체가
  불투명한 픽셀**만 내부로 판정했다. alpha 허용치를 완화하지 않았다.
- 두 엔진 각각 22/29px × 렌더 배율 1/2 × 소수점 위치 0/.25/.5/.75의
  **16개 표본에서 내부 접합부 결함 0**. 800ms의 M·X 후속 획 조기 노출도 없다.
  이는 브라우저 SVG rasterizer 검사이며 외곽 안티앨리어싱의 완전 일치나
  실제 FHD 모니터·iPhone 하드웨어 검증을 뜻하지 않는다.
- App/classic-runtime/단위/E2E 타입 검사, 변경 TS의 해당 ESLint 설정,
  변경 CSS·TS의 Prettier, 소스 복잡도·classic-runtime·inline-JS·Playwright
  API guard와 `git diff --check` 통과. HTML은 로고 블록 밖의 기존 서식을 유지했다.
- E2E 빌드와 프로덕션 빌드 통과. 프로덕션 산출물의 legacy TV·초기 전송 용량·
  prod hooks·prod security·SW app shell·font·service worker·UI kit guard
  **8개**, 동일 산출물의 공식 Chromium candidate smoke **9개** 통과.

이번 추가 변경은 App 클라이언트만 해당한다. 누적 `target=all`, D1 입력 off,
새 dependency/schema/secret/binding 없음, 버전 `8.6.61`·cache `v630` 동결은 유지한다.
공개 승격 전 버전·cache 증분과 최종 main SHA 검사는 여전히 필요하다.
되돌릴 때에는 이 변경의 HTML·CSS·classic runtime·setup 완료 이벤트 연결을
함께 되돌린다. 새 서버·데이터 복구 절차는 없다. main·프로덕션과 비활성화된
Operations Drift Audit는 변경하지 않았다.

## 4. 이전 8.7.0에 적용한 승인된 승격 실행 순서

2026-10-07 사용자가 **대회 종료·main 병합·프로덕션 배포·감사 재활성화**를 승인했다.
8.7.0 승격에 적용한 순서는 아래와 같으며 완료 증거는 마지막 8.7.0 실행 기록에 남겼다.
후속 8.7.1·8.7.2의 완료 범위는 1절을, 향후 실제 명령·검증 경계는 [정식 절차](hotfix-procedure.md)를 따른다.

1. **종료·재개 기록:** 지시 일시를 아래 실행 기록에 남긴다. 이전 사용자 지시에
   따라 `Operations Drift Audit`의 `ops-drift-audit.yml`만 재활성화한다.
   과거 일회성 disabled workflow까지 일괄 켜지 않는다. 수정 전 main에서 실행된
   감사는 구 스크립트로 실패할 수 있으므로, 수정 병합 뒤의 결과와 구분한다.
2. **최종 차이 확정:** 원격 refs를 확인하고 main 대비 베타 diff, 미커밋 작업,
   다른 작업의 변경을 확인한다. 대상 SHA와 위 표를 갱신한다. 기존 문서의 SHA를
   다음 주 최신 코드로 간주하지 않는다. 2026-10-07 후속 수정 `4a605791`에서
   확정 12건과 별도 보강 2건을 반영했고 sharp 0.35.5로 전체/prod-only audit 0건,
   서명·새 설치/native 실행 검증을 완료했다. 발견 당시 경고와 미수정 기록은
   과거 증거로 보존한다. 최종 의존성과 SHA에서 보안 gate를 다시 확인하며,
   새 경고가 있으면 선별 갱신한다. R26 최초 갱신 정지 관찰의 원인은 미확정이다.
   main에도 있던 경고라는 이유로 PR 보안 gate를 우회하지 않는다.
3. **버전·캐시 증분:** `8.6.61`/`v630`에서 `8.7.0`/`v631`로 증분한다.
   하이브리드 오디오 기능 추가를 minor에 반영하고, package/lockfile과 두 admin
   버전 mirror를 함께 맞춘다.
   `npm run version:status`와 관련 guard로 확인한다.
4. **최종 베타 검증·푸시·PR:** 변경에 필요한 테스트·타입·린트·guard를 통과시킨다.
   최종 버전/cache 변경을 커밋한 뒤 `npm run build:checked`를 실행한다.
   이전 커밋의 빌드로 최종 cache-history 검사를 대체하지 않는다. 승인된 main 대상
   PR을 만들고 PR CI를 확인해 병합한다. 사용하는 임시 브랜치는 정상 정책을 따른다.
5. **main 후보 확보:** 실제 병합된 **main push SHA**의 CI 전체가 성공하고 그 SHA의
   만료되지 않은 immutable production candidate가 있는지 확인한다. 베타·PR SHA 결과로
   대신하지 않는다. 수정이 더 생기면 새 SHA의 후보를 다시 기다린다.
6. **Production Release:** 최종 diff를 다시 확인해 당시 누적 승격 범위인 `target=all`,
   `apply_developer_api_d1=false`로 실행한다. 워크플로 ref는 `main`이어야 한다.
   실행의 `head_sha`가 승인한 최종 SHA인지 확인한다. checkout·artifact는 해당
   SHA로 고정되며, 시작 전에 main이 전진하면 새 후보로 다시 진행한다.
7. **운영 결과 확인:** 정식 workflow의 checkpoint·배포·live smoke·최종 Worker
   소유권/세대 readiness 확인을 완료한다. 실행 중 dashboard나 로컬 CLI로 별도
   배포하지 않는다. fresh load, 기존 열린 탭/PWA 업데이트, 변경된 미디어·계정
   경로를 확인한다. 베타의 녹색 테스트만으로 이 단계를 완료 처리하지 않는다.
   활동 중인 방의 탭은 새 서비스 워커가 활성화되어도 자연스러운 다음 로드까지
   갱신을 미룰 수 있으므로, 모든 참가자가 즉시 새 클라이언트가 됐다고 간주하지 않는다.
8. **감사·마감:** 수정이 들어간 main에서 Operations Drift Audit을 수동 실행해
   보고서를 확인하고, 활성화 상태도 확인한다. 배포 SHA/버전/결과와 남은 확인을
   아래에 기록한다. 성공 후 임시 PR 브랜치와 병합된 베타 브랜치는 정상 정책으로
   정리하고 `main`으로 돌아온다. 다른 작업의 진행 중인 브랜치·미커밋 변경은 보존한다.

main 병합만으로 Cloudflare가 바뀌지 않는다. 문서·감사 도구만의 향후 변경은
저장소 반영으로 끝난다. **이번 누적 베타는 App·Worker 배포를 완료했다.**

## 5. 실패·복구 시 주의점

- 정식 release/recovery workflow의 checkpoint, 실제 Worker 버전·메시지,
  D1/DO/R2 compatibility floor를 우선한다. 체크포인트는 사용자 데이터 전체의
  백업이 아니며, 이미 존재하는 세대·권한 경계나 tombstone을 지우지 않는다.
- **쿠키 reader 호환:** 새 세션별 쿠키를 발급한 뒤 이전 App Worker로만 되돌리면
  이전 코드는 새 이름을 읽지 못해 해당 사용자가 익명으로 보일 수 있다. 이 경계는
  현재 별도 자동 rollback marker로 보호되지 않는다. 가능하면 새 cookie reader를
  유지한 forward fix/선별 revert를 사용하고, 구 버전 전체 복구가 필요하면 재로그인
  영향과 남은 쿠키의 처리까지 검토한다. 구 App에서 legacy 쿠키로 다시 로그인한 뒤
  새 App을 재배포하면, 남아 있는 유효한 scoped 쿠키가 그 legacy 로그인보다 우선할
  수 있다. 단순히 재로그인하면 완전히 해결된다고 가정하지 않는다. 이는 reader
  코드의 호환성 경계이며 실제 운영 사고를 재현했다는 뜻은 아니다. DB 유실과
  로그인 쿠키 호환 문제를 혼동하지 않는다.
- 리버브 검증기를 App/PRO/API 일부만 복구해 다른 상한이 남지 않도록 한다.
  대상별 복구 순서를 수동으로 새로 만들지 말고 canonical 절차를 따른다.
- 소스 revert에서도 공개 제품 버전과 캐시 번호는 앞으로 증가시킨다. 실패한
  release의 보고서·checkpoint를 남기고 외부의 더 새로운 배포를 덮어쓰지 않는다.

## 6. QA 때 갱신하는 규칙

QA 시작 시 이 문서와 현재 diff를 읽고, 완료 시 다음 중 하나라도 달라졌으면
**같은 변경에 이 문서를 갱신해 커밋·푸시한다.**

- 배포 대상, dependency/asset, 데이터·secret·binding, API/프로토콜/쿠키 호환성
- 버전·캐시 요구, 새 결함·해결 상태, 필수 확인 또는 회귀/실기 검증 결과
- 배포 순서, 복구 조건, 사용자의 승인·보류 결정

위 현재 상태·체크리스트를 먼저 고친 뒤 아래 이력에 날짜, QA/코드 SHA, 배포 영향,
검증 및 남은 일을 한 줄로 추가한다. 문서만 수정한 커밋은 마지막으로 검증한
**코드 SHA**를 바꾸지 않는다. 상세 로그는 QA 보고서로 링크하고 결과를 여러 번
합산하지 않는다. 새 배포 영향이 없다면 반복 행을 만들 필요는 없다. secret 값,
세션 쿠키나 개인정보는 이 문서에 넣지 않는다.

### 누적 변경 이력

2026-10-09 8.7.5/v636 정식 배포 완료: 사용자 명시 승인·최종 소스 검토 후 PR #269 및
PR CI `37839097247` 성공, main `0fc46bad9233db6e7c9f7790d84052afbd53b6d8`의
push CI `37839818477` attempt1·immutable candidate를 정식 Release `37840659848` attempt1로
배포했다. all/Developer API D1 false, main unit522파일10,881pass/기존1skip/fail0·4종coverage·
핵심 browser 통과, 후보782파일 hash 일치. App·PRO·remote-share·signaling·Developer API
facade/backend6종100% 및 exact git provenance 최종 확인, 운영 smoke10·PRO ready·coherent
marker 통과·복구 checkpoint 보존·rollback 불필요. 새 schema/secrets/bindings/deps 변경0,
기존 App·번역 idempotent D1 baseline 적용/검증은 정식 절차로 수행했다. 자동 Codex 리뷰는
사용 한도로 미실행이며 최종 소스/기존 독립 API 검토로 구분 기록한다. Operations Drift Audit은
active 유지·다른 workflow 변경0. 실기 및 기존 미확정 운영 관측은 유지하고 문서만 후속 반영.
[정확한 배포·복구 기록](design/beta-30-round-repair-2026-10-09.md#875-정식-배포-후속-기록--2026-10-09).

2026-10-09 8.7.5 릴리스 준비: 사용자가 완료된 QA 수정분의 배포를 명시 지시했다.
제품 `8c14f0d6`/QA helper `8ff6fd12`, 준비 `8.7.5`/`v636`, 원격 main `e7c5529a`가
QA 기준과 동일함을 확인했다. 최종 변경 소스·기존 독립 API 검토와 회귀 근거 재확인,
release-identity/cache-history 통과·새 코드 변경 없음. App·PRO·Developer API를 함께
반영하기 위해 정식 Production Release `all`/Developer API D1 false를 선택한다.
PR 및 exact-main-SHA CI candidate·운영 배포/검증은 아직 대기이며 기존 운영 상태를 유지한다.

2026-10-09 QA032 추가 제공 근거 재검토: 제공 tested SHA `fa33c660d811ac51e0177a54738d5a814ca3857a`,
검토 HEAD `f271002ca35436837cc81a6aa67536013123ec4d`; 두 SHA의 차이는 앞선 검토 문서2파일이다.
보고된 Windows/Node24.20.0·Vitest5/jsdom·기존 network guard/15초/maxWorkers1/retry0.
기존23+실제 receiver/storage 통합3+보조16/392의 원본 JSON4집계·고유19파일434pass/fail·skip0 확인.
통합 main/preload 완료 Blob 및 역순 조립은 테스트 직접 RAM 쓰기/완료 없이 제품 경로로 검증하며,
보조17파일408은 서로 중복 없음·로그와 보고서 명령 확인. 앞선 세 공백을 해소해 합의한 로컬
QA032 범위 완료로 판정한다. 부모 신규 실행0·검사 수정0·새 확정 제품 결함0·원본 보존.
현재 추적1,964/비Markdown1,819 hash는 기존 독립 manifest와 동일하며 제품/main/운영/배포 변경0.
codec/실제 WebRTC/live·실행 전체 전후hash는 입증 범위 밖이고 exact-main CI·실기 등 release 조건은
유지한다. 아래 첫 검토의 보류는 당시 자료에 대한 이력으로 보존한다. [후속 판정](design/beta-30-round-repair-2026-10-09.md#qa032-추가-통합-근거의-읽기-전용-재검토--2026-10-09).

2026-10-09 QA032 사용자 제공 결과 검토: 기준/current HEAD `fa33c660d811ac51e0177a54738d5a814ca3857a`,
보고된 Windows/Node24.20.0/Vitest5/jsdom·config network guard/15초/maxWorkers1/retry0.
제공 JSON1파일23pass/fail·skip0 확인, 부모 신규 실행0·검사 수정0·새 확정 제품 결함0.
guard/dispatch 단위 근거는 인정하되 직접 ramWrite/ramEnd에 의존한 종합 사례·미호출 preload
receiver·미실행 wire decode 통합 경로 때문에 전체 완료 판정 보류. 보조392/16 및 실행 명령/
전후hash는 제공 폴더에 원본 없어 미검증·중복 포함관계 불명·미합산. 현재Git clean·HEAD와
추적1,964/비Markdown1,819 확인, 제품/main/운영/배포 변경0·원본 보존·문서만 반영.
이제 QA032는 제공된 부분 실행 근거가 있으나 통합 완료가 입증된 상태는 아님.
기존 거절·release 후보·실기 한계 유지. [정확한 판정](design/beta-30-round-repair-2026-10-09.md#qa032-사용자-제공-결과의-읽기-전용-검토--2026-10-09).

2026-10-09 API 키 수명 수정 후 재검증: tested SHA `2a6e481250137fa1e5eeb0a60aabf38317c72b2f`,
새 GPT-6 Luna/high 세션·부모 독립 확인·Windows/pinned Node24.20.0·network guard/15초/maxWorkers1/retry0.
API 원본은 이미 실행한 로컬 검사였고 후속 자체 거절 없이 중단됐으므로 QA032 직접 거절과
함께 실행 불가로 묶은 분류를 정정했다. 새 세션 원본4pass는 pull 자동 호출로 초기 인증 뒤
순서 증거가 부족해 보존만 하고 합산하지 않음. 실제 인증→Request reader→키 변경→본문 완료를
명시한 queue-mode/원래 queue-add 최종 고유8pass/fail·skip0, 정상200/201·회수/만료401·epoch409,
거절된 변경의 PRO room/storage 불변 확인. 최초 fixture/관측 오류 원본 보존·제품 수정0.
추적1,964/dist782 hash 불변, 이번 API 서비스 거절0·새 확정0, main/배포 변경0·문서만 반영.
두 미완료 재현 중 API 위 두 경로 완료·QA032만 미실행; media 동적 조합·기타 심화/전체/coverage/
browser/live/실기/exact-main 조건 유지. [단계·원본·최종 판정](design/beta-30-round-repair-2026-10-09.md#api-키-수명-로컬-재검증-완료--2026-10-09).

2026-10-09 새 세션 마지막 독립 확인: tested SHA `44ef6a789112c23f1c63c843853eca9d86054e45`,
GPT-6.1 Sol/xhigh·Windows/Node24.20.0·기존 network guard/15초/maxWorkers1/retry0.
새 scratch43pass(API11·공개14·번역8·관리자10), 기존17파일966pass, 최종fail·skip0·새 확정0.
최초40pass/1fail은 삭제 fence의401 기대값 차이로 실제200/voted:false·DB 불변을 명시해 확인,
원본과 후속 binding 관측 fixture 보완 전 결과 보존. 추적1,964/dist782 hash 불변.
QA032는 기존 거절/공식 설명 확인만, API 스트리밍 키 수명도 미실행; 별도 Daybreak 요청0.
임시 캐시 삭제는 실행 정책의 blocked by policy로 미실행·이유 추가 제공 없음·재시도 없이 보존.
이번 신규 보안 실험 거절0, 제품/main/배포 변경 없음·문서만 반영. exact-main/실기 등 한계 유지.
[범위별 근거·원본·한계](design/beta-30-round-repair-2026-10-09.md#새-세션의-마지막-독립-검증--2026-10-09).

2026-10-09 일반 모델 작업 진행: 사용자 의미 정정에 따라 Daybreak를 별도 요청하지 않고
현재 GPT-6.1 Sol/xhigh 채팅 도구에서 유지 회귀17파일966pass/fail·skip0 및 방어적 소스 검토.
tested SHA `865bd58800302c6a20c2b1320bef8277b8de6424`; 새 확정 결함0, 제품/검사 코드1,819파일 hash 불변.
이전 전체 unit과 중복이며 새 심화 프로브·전체/coverage/live/실기 검증 아님. 거절된 특정
실험은 재구성·실행하지 않음. 제품/main/배포 변경 없음. [근거](design/beta-30-round-repair-2026-10-09.md).

2026-10-09 사용자 모델 변경 뒤 접근 재확인: 문서 checkout `b24609f4`, `GPT-6.1 Sol / xhigh`.
현재 계정 모델 카탈로그는 해당 모델의 cyber 프로그램을 standard만 표시했다. 도구·보안 실험을
금지한 정식 Daybreak 접근 요청은 403 `Daybreak isn't available for this model`로 거절됐다.
특정 심화 실험은 재작성·실행하지 않았으며 신규 보안 검사0건, 제품/검사 코드/main/배포 변경 없음.
모델·프로그램 거절과 일반 모드 사용 가능성을 구분한 [접근 기록](design/beta-30-round-repair-2026-10-09.md)을 보존한다.

2026-10-09 배포 전 Daybreak 심화 재시도: `8ff6fd1251390a23b37686929a59d174ae0db467`.
접근 옵션 누락 오류를 정식 CLI 옵션으로 해소해 모델 접속은 확인했으나, 실제 심화 단계에서
Advanced Account Security·호환 FIDO2 하드웨어 키 요구로 다시 차단됐다. 신규 보안 검사0건,
다른 심화 세션도 실행 전 중단. 초기 Windows 실행 환경 설정 오류와 계정 gate를 구분해 보존.
제품·검사 코드1,819파일 hash 변경0, 계정 보안 설정/main/배포 변경 없음. 미완료 범위와 다음 조건은
[재시도 기록](design/beta-30-round-repair-2026-10-09.md#daybreak-보안-심화-재시도--2026-10-09)을 따른다.

2026-10-09 2차 QA 후속 수정: 사용자가 두 미확정 항목의 기대 동작을 승인하고 기존 13건까지
총 15건 수정을 요청했다. 14건 새 실행 재현·API 1건 방어적 소스 확인 뒤 수정했다.
App/public docs/admin·API/facade/PRO가 변경되며 `8.7.5`/`v636` 준비, schema/secrets/bindings/deps 유지.
제품 코드 `8c14f0d6da9d351588116e3c7114a213685cd608`의 최종 unit10,882·4종coverage·Chromium67/최종19·WebKit66+기존3skip 통과.
커밋 후 build:checked·Worker6·production Chromium17/WebKit SW1 통과. 첫 candidate 16pass/1fail은
비동기 캐시 출처를 기다리지 않은 QA helper 경합으로 별도 재현·검사만 보완했고 경계4통과.
비Markdown 최종1,819파일 동일성 및 제품 커밋의 산출물782파일 hash 불변 확인. main 병합/원격 CI/배포 미수행.
차단된 보안 재현과 실기/운영 한계 유지.
[후속 수정·원본 실패·검증 기록](design/beta-30-round-repair-2026-10-09.md).

2026-10-09 2차 독립 QA: `e7c5529a3273c7132880dd0ad4572b2463405c87`, 30라운드·122범위 분류와 최종 재판정.
확정 13건(P1 0/P2 9/P3 4) 미수정, 미확정 2·제외 8. 공통 전체 검증 통과와 새 경계 실패를
분리하고 보안 실행 차단·실기/운영·기존 PWA 한계를 보존했다. 제품/배포 변경 없이 QA 문서만 갱신.
[2차 30라운드·독립 재판정](design/beta-30-round-qa-2026-10-09.md) 및 위 현재 검증 체크리스트를 따른다.

2026-10-08 시그널링 오류 진단 보강: `99f9103c`의 `signaling` 단독 배포 완료. 원인 미확정 예외를
추적할 안전한 로그와 배포 gate를 추가하며, 앱/프로토콜/저장소 계약은 유지한다.
최종 코드·검증·배포 근거는 위 전용 절을 따른다.

| 날짜       | 범위 / 코드 근거                                       | 배포 영향·결정                                                                                                  | 검증·남은 일                                                            |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2026-09-27 | 동결 이후 베타 전체, main `35759e8b` → beta `c663f89f` | 최초 통합 기록. 하이브리드 오디오, UI·전송·동기화 QA, 리버브 10초, 감사 수정 포함. `all` / Developer API D1 off | 최종 버전·cache 증분, main CI 후보, 위 실기·운영 확인 필요              |
| 2026-09-27 | QA21 후속 쿠키 수정 `c663f89f`                         | App Worker의 응답별 쿠키 소유권. DB 이전·대기·전체 로그아웃 불필요. 구 App reader로 복구 시 로그인 영향 기록    | 483파일/9,915 pass/1 기존 skip, 새 쿠키 회귀 29개 및 Chromium 재현 통과 |
| 2026-09-27 | 수정 없는 발굴 감사, checkout `7538e9d7`, 제품 코드 `c663f89f` | 독립 결함 B01–B04를 미수정 목록에 추가. 발견·재검증만 수행, 제품·배포 계약 변경 없음 | 집중 회귀 32파일/1,041 pass 및 네 결함 독립 재현. 배포 전 처리 결정 필요 |
| 2026-09-27 | B01–B04 일괄 수정 `b833e2a62bd7eceaa1c9a074d463a36477b514e4` | 클라이언트 3건과 App Worker 번역 내보내기 수정. `all` / Developer API D1 off 유지, 마이그레이션 없음 | 487파일/9,960 pass/1 기존 skip, 타입·린트·빌드·브라우저 회귀는 수정 기록 참조. 최종 main CI·실기·배포 대기 |
| 2026-09-27 | 수정 없는 2차 발굴, checkout `63516859`, 제품 코드 `b833e2a6` | C01–C03 추가 확정·미수정. 제품·배포 계약 변경 없음 | 집중 회귀 35파일/913 pass와 별도 발견 재현. 세 건 처리 결과를 승격 전에 갱신 |
| 2026-09-27 | C01–C03 일괄 수정 `3dd9086cdced0fc25426da82239977b6da004074` | PRO 공유 종료 복귀, 일반방 프리로드, App Worker 번역 추천 수정. 구버전 END 호환, 데이터 이전 없음. `all` / Developer API D1 off 유지 | 488파일/10,004 pass/1 기존 skip, Chromium 19개·타입·린트·빌드·10 guard·6 Worker dry-run 통과. 실기·최종 main CI·배포 대기 |
| 2026-09-27 | 수정 없는 3차 발굴, checkout `ab4220b7`, 제품 코드 `3dd9086c` | D01 추가 확정·미수정: PRO 공유 중 신규 입장의 이전 YouTube 복원. 제품·배포 계약 변경 없음 | 집중 회귀 46파일/1,700 pass. 별도 재현 2실패/1 대조군 통과 및 독립 재실행. 승격 전 처리 필요 |
| 2026-09-27 | 4차 발굴 및 D01 수정 `2347760c5e5b902327a05ca216c8b72409ee72d3` | 새 확정 0건 후 기존 D01 수정. App 클라이언트의 자동 복원 소유권만 변경, 새 데이터/Worker 계약 없음 | 발굴 고유 21파일/328 pass. 최종 491파일/10,022 pass/기존 1 skip, Chromium 8개·전체 타입/린트·App 빌드·9 guard 통과. 확정 미해결 목록 정리, 실기·main CI·배포 대기 |
| 2026-09-27 | Luna 조합 탐사, checkout `1439e338`, 제품 코드 `2347760c` | 제품 수정 없이 새 확정 0건. 배포 범위·버전·계약·기존 해결 상태 유지 | 새 프로브 7파일/1,250 pass/최종 fail·skip 0, ASTRA 주요 1,082개 재실행 통과. 모듈·모사 경계 검사이며 실기·전체 E2E 대체 아님 |
| 2026-09-27 | 검색 스켈레톤 UI 검토, checkout `693ded3a` | 상태 안내 위치 이동 확인·미수정. 회색은 기존 surface-3 토큰으로 확인 | 로컬 Chromium 390×844에서 로딩→실패 시 약 374px 이동. HTML/CSS·검색 모듈 사용, 응답 모사. 제품·배포 변경 없음 |
| 2026-09-27 | 검색 상태 안내 배치 수정 `736f195c8e6414ea527b0781cd96154ef36b452e` | HTML의 안내 노드만 입력창 바로 뒤로 이동. 기존 색상·로직·ARIA·배포 계약 유지 | 기존 3파일/282 pass, 로컬 Chromium 4개 화면에서 로딩·실패·빈 결과·성공 위치 유지 및 URL 미리보기 확인. 제품 버전·캐시와 main·프로덕션은 유지 |
| 2026-09-27 | 스켈레톤 색상 조정 `b9ea66d3b91fe35b04a9da6cc9a6b1011861c144` | 썸네일·제목·채널의 surface-3를 surface-2로 변경. 모션·불투명도 유지 | 로컬 Chromium 다크/라이트 computed style·화면 확인. CSS 색상만 변경, 전체 테스트 재실행 없음 |
| 2026-09-27 | 스켈레톤 불투명도 조정 `bc8e25757abacdd2ee82c368b4617be42be328e4` | 55–90%에서 60–100%로 조정. surface-2·1.6초 주기·동작 줄이기 유지 | 로컬 Chromium 애니메이션 시작/중간 값과 reduced-motion 확인. CSS 두 값만 변경 |
| 2026-09-27 | 스켈레톤 색상·불투명도 재조정 `df7b915a9c17465a30dbfae82cec9389c4d2f56d` | surface-3·50–80%로 변경. 1.6초 주기·동작 줄이기 유지 | 로컬 Chromium 다크/라이트의 색상·애니메이션 범위·reduced-motion 확인. CSS만 변경 |
| 2026-09-27 | 스켈레톤 불투명도 추가 조정 `09123ea84081660ad8578b81e98f795386555179` | 25–50%로 변경. surface-3·1.6초 주기·동작 줄이기 유지 | 로컬 Chromium 애니메이션 범위·reduced-motion 확인. CSS 두 값만 변경, 전체 테스트 재실행 없음 |
| 2026-09-27 | Bluetooth YouTube 시작 조사: main `35759e8b`, beta checkout `10f12cec` | 사용자 보고를 잔여 실기 확인에 추가. 시작 예약·학습은 플레이어 시간과 플랫폼 보정에 의존하며 출력 장치별 지연을 측정하지 않음. 제품 코드·배포 범위 유지 | Windows에서 소스·main/beta diff와 공식 YouTube API 문서 검토만 수행. Bluetooth 실기·새 자동 테스트 미실행. 지연 원인은 가설이며 회귀 테스트 통과로 물리적 첫 음 정렬을 보장하지 않음 |
| 2026-09-27 | 수동 싱크 후 제로스타트 조사: checkout `ae98afc3`, main 비교 `35759e8b` | 사용자가 Bluetooth 가설을 정정. S01–S02 확정·미수정으로 추가. 제품 코드·버전·배포 계약 변경 없이 조사 기록만 갱신 | Standard 592·PRO 17·입력 75 관측, 기존 집중 244 통과. Chromium 2개 context·local PeerJS·모사 iframe에서 실제 UI 재현. 전체 스위트·실기·프로덕션 검증 아님. [상세 근거](design/youtube-manual-zero-start-audit-2026-09-27.md) |
| 2026-09-27 | S01–S02 수정 `c3eae88c` | 일반방/PRO 음수 보정의 참가자별 시작 지연, 일반방 반복 직후 입력 snapshot 대기. App만 추가 변경; 새 서버·DB·UI 계약 없음 | 전체 493파일/10,118 pass/기존 1 skip, 수정 완료 후 YouTube 937 pass, UI Chromium 6+1 pass, App/테스트/E2E 타입·린트·빌드 통과. 검사 시점과 실기 한계는 위 수정 항목 참조. 베타만 반영 |
| 2026-09-27 | 극단값 동기화 감사: checkout `fe3fdb10`, 제품 `c3eae88c` | XS01–XS04 확정·미수정. 제품·계약 변경 없이 현재 미해결 목록과 발견 근거만 갱신 | 새 모듈 863개/823 pass/40 fail/0 skip, 같은 4원인 재현. YouTube UI 6 pass/2 fail, native PCM 4관측 및 소스 전환 1 pass. PRO 모사·실기 제한은 [감사 기록](design/extreme-manual-sync-audit-2026-09-27.md) 참조 |
| 2026-09-27 | XS01–XS04 수정 `c242bfd17f652f1480a6e79731d5130b5b6f6c19` | App 클라이언트 소유권·실제 출력·시작 시각 보정, 늦은 새 명령 취소 포함. 새 UI/서버/DB 계약 없음. 베타만 반영 | 495파일 전체 10,245 pass/4 timeout/기존 1 skip 후 동일 4개 단독 통과, 고유 10,249 pass 확인. Chromium 14개·전체 타입/린트·빌드 통과. cache 증분은 승격 전 필요. [수정 기록](design/extreme-manual-sync-repair-2026-09-27.md) |
| 2026-09-27 | 후속 전체 QA: checkout `dd55d3bc`, 제품 `c242bfd1` | 제품 변경 없이 FQA01 추가 확정·미수정. 별도 E2E 대기 조건 1건·coverage 선택 누락 2건. 배포 범위·계약·버전·동결 유지 | 전체 단위 10,249 pass/기존 1 skip, broad coverage 통과. Chromium 550 pass/1 test-timing fail, WebKit 60 pass/기존 3 skip. 실제 Sync 버튼 새 결함 두 번 재현. 원본 critical/Worker gate 실패와 원인 입증은 [전체 QA](design/beta-full-qa-2026-09-27.md) 참조 |
| 2026-09-27 | FQA01·QA-T01–QA-T03 수정, `d3ef74ab4e196abbc2b2f3ea97988e3a91e379ac` (동일 소스 작업 트리 검증 후 커밋) | 외부 복구·PLAYING 응답 대기까지 동기화 소유권 유지, 새 명령·재진입·중도 입장 보완. E2E 수렴 조건·coverage 파일 선택 수정; UI·정책·Worker 계약·배포 범위 유지 | 전체 단위/broad 496파일·10,264 pass/0 fail/0 skip, critical 1,772·tooling 342·Worker 1,726과 원래 gate 통과. 정적 23개·Worker dry-run 6개·집중 Chromium 2개·WebKit 60개 통과/기존 3 skip. 최종 전체 Chromium 552개·프로덕션 smoke 10개 통과; cache 증분은 승격 전 필요. [수정 기록](design/beta-full-qa-repair-2026-09-27.md) |
| 2026-09-29 | 시작 로고 리빌 `79f3a687a7222a69ff865846e0c715aa197d0f10` | 정확한 단일 nonzero 마스크, 복제본의 같은 타임라인, 완료·fallback 처리. App만 추가 변경, 누적 배포 범위·계약·버전 동결 유지 | 단위 88·Chromium 21·WebKit 6·프로덕션 smoke 9 pass, artifact guard 8개 통과. 두 엔진 각각 16개 내부 접합부 표본 통과. 전체 스위트·실기 재검증 아님 |
| 2026-10-01 | main `35759e8b` → beta `c263acce`, 제품 수정 없는 전체 diff 감사 | 새 확정 런타임 결함 0건, 조건부 병합 가능. 현재 dependency audit 실패(main/beta 동일 high 5/moderate 4)와 version/cache gate·최종 main CI·실기 확인 잔여. 누적 `all` / D1 off 및 freeze 유지 | 고유 unit 10,273·4종 coverage·Chromium 558·WebKit 66(기존 3 skip)·production smoke 10·artifact guard 8·Worker dry-run 6 통과. [상세 감사](design/main-beta-merge-audit-2026-10-01.md) |
| 2026-10-03 | 시퀀스 QA, checkout `edbfebed`, 제품 코드 동일 | SQ01 새 확정 1건·미수정. 늦은 PREPARE/START가 유효 prefix를 버려 전체 재전송; main 추출 소스도 재현. 제품·의존성·버전·계약·동결·배포 범위 유지 | 새 전송 matrix 78 pass/6 fail(한 원인), 최소 복구·대조군 beta/main 확인. 오디오 60·PRO/YouTube 19·Chromium 22·기존 전송 57 pass. 전체 재실행 아님. [상세 QA](design/beta-sequence-qa-2026-10-03.md) |
| 2026-10-03 | SQ01 수정 `53cbf60fd5f475a9beef2cfaa1d7023c9b456eea` | 같은 활성 수신의 prefix만 PREPARE의 실제 미디어 정지 후 보존. START 검증·UI·정책·프로토콜·버전·Worker·D1 입력·동결 유지. 누적 target=all 그대로 | 새 회귀 100·관련 단위 2,896·Chromium 33 pass, fail/skip 0. 타입·lint·서식·복잡도·E2E/production build·artifact guard 8개 통과. 전체/실기 재검사 아님. [수정 근거](design/beta-sequence-qa-2026-10-03.md#repair-addendum--2026-10-03) |
| 2026-10-03 | 2차 시퀀스 QA, checkout `c46b5b5e`, 제품 `53cbf60f` | SQ02–SQ04 새 확정 3건·미수정. 문서만 변경; 제품·의존성·버전·계약·배포 범위·동결 유지 | 고유 모듈 22 pass/5 fail, Chromium 6 pass/1 fail, skip/flaky 0; 실패 6개는 원인 3개. 독립 재실행과 정상 대조군 확인. 전체 스위트·실기 재검사 아님. [상세 QA](design/beta-sequence-qa-2026-10-03-round-2.md) |
| 2026-10-03 | SQ02–SQ04 수정 `1c26dc4ea10263790fedd345f9c20950d09dfc13` | 진행 보존·외부 전환 복구 수명·준비 중 최신 YouTube 의도 보완. UI·정책·의존성·계약·버전/cache·동결 유지. 누적 target=all, D1 입력 false 그대로 | 전체 단위 후 최종 영향 범위 재검증, 고유 501파일·10,425 pass. Chromium 12파일·62 pass, fail·skip·flaky 0 (retry 0). E2E·프로덕션 빌드 및 산출물 guard 8개 통과. 타입·lint·서식·정적 검사 통과. [수정 근거](design/beta-sequence-qa-2026-10-03-round-2.md#repair-addendum--2026-10-03) |
| 2026-10-03 | 3차 시퀀스 QA, checkout `60eb1273`, 제품 `1c26dc4e` | SQ05–SQ06 새 확정 2건·미수정. 문서만 변경; 제품·계약·의존성·버전·배포 범위·동결 유지. 사용자 입력 경로 미입증 후보 2개는 확정 제외 | 확정 프로브 10 pass/7 fail(두 원인), 주 에이전트 독립 재현 일치. 기존 집중 단위/Worker 509개·Chromium 14개 통과. 원격 오디오 정상 대조 14개 통과; 미입증 경계 실패 6개 별도 보존. E2E 빌드 통과; 전체·실기 검증 아님. [상세 QA](design/beta-sequence-qa-2026-10-03-round-3.md) |
| 2026-10-03 | SQ05–SQ06 수정 `d4dd4bbb94c58624f50887d12dc5dd017fb95f7a` | 데모 실패 복원 시 최신 적용 효과 유지, PRO 현재 적용 미디어 관측 전달. UI·정책·서버 계약·의존성·버전/cache·동결 유지. 누적 target=all, D1 입력 false 그대로 | 전체 단위 후 jq 도구 경로 재검증으로 고유 503파일·10,458 pass, fail/skip 0. Chromium 9파일·50 pass, fail·skip·flaky 0 (retry 0). 새 모듈 33개 독립 검토·재실행 통과. App/테스트/E2E 타입·lint·서식·정적 guard, E2E·프로덕션 빌드 및 산출물 guard 8개 통과. 전체 E2E·WebKit·coverage·live·실기는 재실행 아님. [수정 근거](design/beta-sequence-qa-2026-10-03-round-3.md#repair-addendum--2026-10-03) |
| 2026-10-03 | 4차 시퀀스 QA, checkout `ed655280`, 제품 `d4dd4bbb` | SQ07–SQ09 새 확정 3건·미수정. 문서만 변경; 제품·계약·의존성·버전/cache·배포 범위·동결 유지 | 새 실행 모듈 52개=45 pass/7 fail(세 원인), 독립 재검증 일치. 기존 고유 30파일·975 pass, Chromium 45 pass, fail·skip·flaky 0. Worker 추가 312개는 필터 제외. E2E 빌드 통과. 전체·실기·보안 재감사 아님. [상세 QA](design/beta-sequence-qa-2026-10-03-round-4.md) |
| 2026-10-03 | SQ07–SQ09 수정 `a841b2d9315c23b71d78ca6263e3950b0a55cc82` | 실패 곡 재선택의 출력 정리·PRO slowmode 초안 보존·재접속 HTTP PREPARE 수명 검증. App 클라이언트·검사만 추가 변경. UI 구성·서버 정책·의존성·계약·버전/cache·동결 유지. 누적 target=all, D1 입력 false 그대로 | 전체 단위 후 영향 6파일·236개 최종 재검증으로 고유 505파일·10,503 pass, fail/skip 0. 새 모듈 45개 포함. Chromium 12파일·75 pass, fail·skip·flaky 0 (retry 0). 타입/lint/서식/정적 guard, E2E·production 빌드·artifact guard 8개 통과. build:checked cache gate는 공개 증분 전 예상 실패. [수정 근거](design/beta-sequence-qa-2026-10-03-round-4.md#repair-addendum--2026-10-03) |
| 2026-10-03 | 5차 시퀀스 QA, checkout `cf11f8a3`, 제품 `a841b2d9` | SQ10–SQ13 새 확정 4건·미수정. 파일 정지 위치·취소 설정 의도·복구 중 채팅·공유 종료 복원. 문서만 변경; 제품·의존성·계약·버전/cache·배포 범위·동결 유지 | 강한 실행 프로브: 오디오29 pass/4 fail, PRO5 pass/1 fail, YouTube64 pass/3 fail, Chromium3 pass/3 fail. 기존 단위769·추가 Worker313·Chromium24 pass. 독립 재검증·정상 대조 확인; 초기 중복 탐사 별도. E2E 빌드 통과. 전체/실기/보안 재감사 아님. [상세 QA](design/beta-sequence-qa-2026-10-03-round-5.md) |
| 2026-10-03 | SQ10–SQ13 수정 `f617c80325771ef7519878c385fd24f55f90bdb3` | 파일 정지 체크포인트·PRO 필드별 의도 수명·알려진 채팅 전송 거부·YouTube 공유 복원 수정. 지연 pre-PUT GET 거부도 독립 재검증. App 클라이언트·검사만 변경, UI 구성·서버 정책·의존성·계약·버전/cache·동결 유지. 누적 target=all / D1 false | 전체 단위 508파일·10,606 pass, Chromium 15파일·98 pass; fail/skip 0, 브라우저 retry/flaky 0. 타입·lint·서식·소스 guard·E2E/production 로컬 빌드·artifact guard 8개 통과. cache-history gate는 공개 증분 전 잔여. 전체 E2E·WebKit·coverage·live·실기·보안 재감사 아님. [수정 근거](design/beta-sequence-qa-2026-10-03-round-5.md#repair-addendum--2026-10-03) |
| 2026-10-03 | 6차 시퀀스 QA, checkout `1341bafb`, 제품 `f617c803` | SQ14 최초 반복·셔플 의도 손실, SQ15 필수 GET 실패 후 저장 재시도 누락 확정·미수정. 문서만 변경; 제품·계약·의존성·버전/cache·배포 범위·동결 유지 | 새 PRO19 pass/4 fail, 실제 Worker 본문 기반 중복 재검증6 pass/4 fail; 주 에이전트 독립 일치. 파일343·YouTube/데모309·기존 PRO219·UI/계정403·Chromium18 pass. E2E 빌드 통과, 전체/실기/보안 재감사 아님. [상세 QA](design/beta-sequence-qa-2026-10-03-round-6.md) |
| 2026-10-03 | SQ14–SQ15 수정 `45c7ef7a4e0fef5b788efe11cb72d54c9b221929` | PRO 반복·셔플 최초 의도 보존, 필수 조회 재시도, 충돌 거부 의도 정리·새 조작의 최신 기준 복구. App runtime·검사만 추가 변경. UI·서버 정책·계약·의존성·버전/cache·동결 유지. 누적 target=all / D1 false | 전체 단위 510파일·10,637 pass, 새 회귀31 포함. Chromium 3파일·11 pass; fail/skip 0, 브라우저 retry/flaky 0. Worker 본문 재현·독립 충돌 재검증, 타입/lint/서식·소스 guard·E2E/production 로컬 빌드·artifact guard 8개 통과. 기존 보안·cache-history gate 잔여; 전체 E2E·WebKit·coverage·live·실기 재검사 아님. [수정 근거](design/beta-sequence-qa-2026-10-03-round-6.md#repair-addendum--2026-10-03) |
| 2026-10-03 | 7차 시퀀스 QA, checkout `67a4f26b`, 제품 `45c7ef7a` | 새 확정 0건. 파일 decode/Blob read 중 큐 변경, PRO 준비/COMMIT 중 큐 변경, 수동 싱크 이후 제어·UI 수명 검증. 조건부 watchdog 후보 1개는 native 예외 발생 경로 미입증으로 제외. 문서만 변경, 제품·계약·의존성·버전/cache·배포 입력·동결 유지 | 고유 모듈/Worker31파일·1,348 pass, Chromium5파일·10 pass; 최종 fail/skip0, browser retry/flaky0. 별도 주입5pass/3fail은 성공 수치와 분리해 보존. E2E 빌드 통과, 전체/실기/보안 재감사 아님. [상세 QA](design/beta-sequence-qa-2026-10-03-round-7.md) |
| 2026-10-03 | 전체 로컬 검증, checkout `0912b8ae`, 제품 `45c7ef7a` | 추가 탐사 중단, 제품·검사 수정 없이 유지되는 전체 로컬 검증 실행. UI·정책·의존성·계약·버전/cache·동결·배포 입력 유지. 결과 문서만 변경 | 고유 unit 510파일·10,637 pass, broad/critical/tooling/Worker coverage 원래 gate 통과. Chromium 568 pass, WebKit 66 pass/기존 3 skip, production smoke 9+1 pass; fail/retry/flaky 0. 타입/lint/서식·소스 guard·artifact guard 8개·Worker dry-run 6개 통과. 보안 9개 패키지(high5/moderate4), cache-history gate 실패는 별도 잔여. [전체 결과·한계](design/beta-full-local-verification-2026-10-03.md) |
| 2026-10-04 | 대규모 QA, checkout `a4802820`, 제품 `45c7ef7a` 그대로, 검사 작업 트리 검증 | 새 런타임 결함 0건. QA-T04 수집 시계·QA-T05 현재 타임라인 판정만 수정; 원본 실패와 대조군 보존. 제품·의존성·계약·버전/cache·복구·동결·누적 all / D1 false 유지 | 최종 unit510파일·10,637 pass 및 원래4종 coverage gate, Chromium 고유568 pass(동일 Luna25 재검증 치환), WebKit66 pass/기존3 skip, production smoke10 pass. 새 복합41 pass·독립 확인; 정적27명령25 pass/기존2 fail, artifact guard8개·Worker dry-run6개 통과. 보안9패키지·cache-history 및 exact-main/실기/live 확인 잔여. [결과·원본 실패·한계](design/beta-large-qa-2026-10-04.md) |
| 2026-10-04 | 후속 시퀀스 QA, checkout `1dc2d911`, 제품 `45c7ef7a` 그대로 | 새 확정 제품 결함0건. 일시 post-seek native 차이·자동 복구 관측을 실기/latency 확인에 연결. Projection 진단1 fail은 실제 종료 producer 미포함으로 분리·대조 통과. 제품·유지 검사·계약·의존성·버전/cache·복구·동결·누적 all / D1 false 유지; 결과 문서만 변경 | 새 모듈63 pass·독립 확인, 기존 선택18파일·고유1,014 pass, 새 Chromium18계획 pass/자동 retry·skip0. 별도 반복3+연속관측3+FIFO지연3 pass는 고유 수치와 분리. E2E 빌드·production 복원·prod-hooks pass. 전체 스위트·보안·실기/live 재감사 아님. 기존 승격 gate 잔여. [관측·근거·한계](design/beta-sequence-qa-2026-10-04-round-2.md) |
| 2026-10-04 | 마지막 요청 QA, checkout `36deb60d`, 제품 `45c7ef7a` 그대로 | 새 확정 제품 결함0건으로 사용자 조건에 따라 추가 발굴 종료. 실제 FIFO3.2초 지연에서 hard 보정·수렴 관측; 이전 nominal transient 원인·실기 확인은 유지. 제품·유지 검사·의존성·계약·버전/cache·복구·동결·누적 all / D1 false 변경 없음, 문서만 갱신 | 전체 unit510파일·10,637 pass, 새 모듈32 pass·독립 확인, 유지Chromium43+native4·WebKit66(기존3 skip)·production smoke9+1·artifact guard8개 pass. 최종 admitted fail0, browserretry0, PRO 복사baseline323 name-filter 제외. 전체Chromium/coverage/static/security/Worker bundle 재실행 아님. 보안/cache·exact-main·실기/live 잔여. [최종 증거·한계](design/beta-final-qa-2026-10-04.md) |
| 2026-10-06 | main `35759e8b` → beta checkout `1349825f` 비교, 제품 `45c7ef7a` 그대로 | 새 확정 런타임 결함0건. 공통 개발 의존성 경고13패키지(critical1/high7/moderate5)로 현재 상태 갱신, 베타 신규 도입0. 캐시·exact-main·실기/live gate 잔여. 제품·유지 검사·의존성·계약·버전/cache·복구·동결·누적all / D1 false 유지 | unit510파일 최초10,636 pass/도구1 timeout 후 동일 파일 원래 기준18 pass로 고유10,637 pass. 선택Chromium54 pass·retry/skip0, 전체 타입·lint·서식·E2E/production build·artifact guard8개 통과. 추가 bounded21관측은 엄격한 파형 일치 판정 아님. coverage·전체 E2E·WebKit·production smoke·Worker bundle 재실행 아님. [비교·검증·보안 근거](design/main-beta-comparison-2026-10-06.md) |
| 2026-10-06 | 베타 전용 보안 의존성 수정 `b0d55351aa58f4a274076d6f31ae69630d260021`, 동일 작업 트리 검증 뒤 커밋. 제품 runtime `45c7ef7a` 동일 | 개발 하위 패치로 audit13→0 및 구형 brace API 복구. dev11노드만 변경/추가, 운영46노드·직접deps·Wrangler/Miniflare/workerd·schema/secrets/bindings·버전/cache·동결·누적all / D1 false 유지. main/배포/워크플로 변경 없음 | 첫 전체unit510파일·10,637 pass, 선택Chromium17 및 production artifact9 pass·retry/skip/flaky0. 타입/lint/서식·빌드·artifact guard8개·Worker dry-run6개·installed loopback20 pass, signatures486/attestations103 검증. coverage·전체 E2E·WebKit·실기/live·exact-main CI 재검사 아님. 기존 cache/승격 확인 잔여. [수정 근거](design/beta-security-repair-2026-10-06.md) |
| 2026-10-07 | 독립30라운드·사후 재분석, tested SHA `9afc36b4d8bccc575a923b0dfaadd103145ba09f` | Astra Ultra3×10세트 완료. 확정12건 미수정(P1 1/P2 8/P3 3), 미확정2·제외2. sharp 새 공지로high3패키지/단일원인, gate재실패; prod-only0. 제품/검사/설정/의존성/계약/버전/cache/main/배포 변경 없음. QA082의폐기된일일BOT문구만현행제한으로교정 | 기존선택365파일·고유8,716pass, 공유파일쓰기1제외. 전체suite/coverage아님. production/E2E build·artifact guard8·Worker dry-run6통과. QA055실기음향미실행, QA122운영소스/모형만. 새로운 실패·대조·독립검증과자동필터중단한계를 [30라운드·최종 판정](design/beta-30-round-qa-2026-10-07.md)에 보존. 동결/누적all·D1 false/복구절차 유지 |
| 2026-10-07 | 30라운드 후속 수정, `4a605791b7f4680cc85d4718117d8db231c1d772` — 동일 작업 트리 검증 후 커밋 | 확정12수정·별도보강2. 재생/시계/포커스/검색/언어·폰트/PWA/진단·파일수신·번역재시도와sharp0.35.5. 새같은빌드 localeJSON40개를App에포함. 새schema/secrets/bindings없음, 누적all/D1 false·버전/cache·동결유지 | 최종unit517파일10,730pass/4종coverage; 초기전체Chromium580+최종영향18/production17, WebKit66/기존3skip. 자동retry0. 타입/lint/서식·source16/artifact8·Worker6·감사0/서명·새설치native검증. 원본실패보존, legacy승인후갱신관찰1원인미확정(추가10/10pass). 실기/live·cache-history·exact-main/승격잔여. [수정·검증·한계](design/beta-30-round-repair-2026-10-07.md) |
| 2026-10-07 | 공개 승격 준비, 기준 checkout `efce531a690857790509fde5f851a9b72db1ee05`, 최신 검증 코드 `4a605791` | 사용자 대회 종료·main 병합·프로덕션 배포·Operations Drift Audit 재활성화 승인. 하이브리드 오디오 기능을 포함해 `8.7.0`/`v631` 준비, 누적 `target=all`/D1 false. 새 schema/secrets/bindings·복구 계약 추가 변경 없음 | 위 로컬 QA 증거 유지. 최종 버전/cache 커밋의 검증·PR/main CI·실제 배포·감사 결과는 아래에 별도 기록. R26 최초 legacy 승인 후 갱신 정지 1회는 미확정이며 추가 진단 10/10 통과로 해소 처리하지 않음. 실기/live 잔여 유지 |
| 2026-10-07 | 공개 승격·배포, 준비 `fe0b0230` → main `e8001e93c9390ec20b359b015d3dff890f2b5304`, PR #245 | `8.7.0`/`v631`, Release `37584399403`의 `all`/D1 false 성공. 6 Worker 공통 SHA·최종 소유권·PRO ready·coherent marker 확인, 감사 active 및 전후 자동 검사 성공. 문서 후속 커밋은 배포 SHA와 구분 | exact-main CI `37583802398`의 unit 10,729 pass/기존 Windows 전용 1 skip·4종 coverage·Chromium 17+22 통과. 공개 45자산 hash·10 HTML 200·fresh en/ko Chromium 통과. 초기 build/upgrade/fetch 실패의 후속 판정과 R26·수동5·실기 한계는 [배포 기록](design/release-8.7.0-2026-10-07.md)에 보존 |
| 2026-10-07 | YouTube 안내 후속 패치, 제품 `10feecac148291dbb54f4cb436fc6dc64d9e6490` → main `f005a70645fb6b115a3465346b5f22d4d83d4e1a`, PR #247 | `8.7.1`/`v632`, 42언어 링크·검색 안내 축약·줄바꿈 유지·BETA. Release `37590255149`의 `app`/D1 false 성공; App 최종 소유권·checkpoint·coherent marker 확인, 다른 5개 Worker는 `e8001e93` 유지·호환. 새 데이터·서버 계약 없음 | exact-main CI `37589560758`: unit10,729 pass/기존1skip·4종coverage·Chromium17+22. 공개45자산 hash·3HTML200·fresh en/ko 통과. 초기 PR CI 배지 기대값 실패·로컬 검증 범위·원본 배포 근거는 1절에 보존. R26·실기·운영 수동 한계 유지 |
| 2026-10-07 | YouTube 브랜드 후속 패치, 제품 `7ac402139147d91d3f86a12cb6d9e6ab49d639bf` → main `94fa5b03695122d1cf6b39d9e7a5374ec6e11e09`, PR #249 | `8.7.2`/`v633`, YouTube BETA 제거·42언어 브랜드 `YouTube` 통일. Release `37593498828`의 `app`/D1 false 성공; App 최종 소유권·checkpoint·coherent marker 확인, 다른 5개 Worker는 `e8001e93` 유지·호환. 서버·데이터 계약 변경 없음 | exact-main CI `37592984640`: unit10,729 pass/기존1skip·4종coverage·Chromium17+22. 로컬unit153·정적/빌드·production5조합 및 공개45자산 hash·3HTML200·fresh en/ko 통과. 원본 배포 근거는 1절, 기존 실기·운영 한계 유지 |
| 2026-10-07 | 8.7.2 전체 검증·test-only 관측기 보완, 기준 `61cedbc6` → `59eae678` → 최종 `716c37af6f57ae46112e1e6295562e50fdc03ff0`, PR #251 | 최초 운영 R2의 LAN 관찰 8/9는 원인 미확정. assertion을 유지한 진단 재실행은 통과. 이전 observer 반례 4개/정상 대조 1개와 후속 getter 예외 중 객체 교체 3종을 재현·수정해 회귀 51 통과. 제품·의존성·서버/DB·secret/binding·버전/cache·배포 변경 없음 | 최종 로컬 518파일·10,781 pass·broad 하한, 원격 PR CI 10,780 pass/Windows 전용 1 skip·4종 coverage·candidate 17/critical 22, 최종 로컬/원격 9게스트 R2·원격 WebKit 66/기존 3 skip·SW 1 통과. 기준 전체 Chromium 로컬/원격 각각 581, 정적 18·빌드/Worker 6·감사 0·서명 486/attestation 103·live 8명령·drift 31 통과. 최종 원격 Chromium도 581 pass/실패·retry 0, Full E2E `37602041553`의 모든 job 성공. 인증 canary·수동 5·실기·R26 한계 유지. [전체 근거](design/full-verification-8.7.2-2026-10-07.md) |
| 2026-10-07 | 운영 R2 미확정 관찰 후속 재검사, tested SHA `a1543f8baf40cea057fe817d18a064fbec7710da`, Windows/Node24.20.0/Playwright1.63 → App `94fa5b03` | 유지 검사 새 방3회 2pass/1fail, 수동 관찰 진단2회 1pass/1fail. 전부 host1/guest9·자동retry0·원래assertion/timeout 유지. 최초8/9는 소급 원인 미확정; native/prflx 보완 경로의 실제 필요성만 추가 입증. 제품·유지검사·정책·버전/cache·배포 변경 없음 | 진단 실패 방은 9개R2준비/경로·HTTP200 정상이나 guest1본문120초미완료. 마지막방은 18GET전체수신·전환통과, 현재GET2.1–69.6초. 지연은관측했으나 원인/복구결함미확정, 후속운영반복전체올그린아님. 기존정책14·다운로드120pass. [후속증거·한계](design/full-verification-8.7.2-2026-10-07.md#운영-r2-후속-재검사--2026-10-07-저녁) |
| 2026-10-07 | 운영 R2 원인 추적, tested SHA `aba657eda95dc4e572b7c9094074fc787b26edd5` → App `94fa5b03` / share Worker `e8001e93` | 추가 shared 진단의 126.590초 두 GET가 원래 120초 조건을 초과한 직접 원인 확인. 실패 뒤 같은 요청으로 전체 수신, 원래 fail 유지. 앞선 본문 실패 2건·HTTP/2 연관의 하위 원인은 미확정. 새 확정 코드 결함 0건, 문서만 변경·App 릴리스 불필요 | 과거 원격 12 job 중 10 success / 업로드 전 ICE 2 failure. shared tail 18 GET 모두 200·ok, CPU 1–10ms. 독립 프로세스는 입장 20초 조건 fail 뒤 약 8초 늦게 완료, 전송 미검증. 20세션 진단 fail 뒤 38 GET 전체 수신·다음 곡 미검사. 정적 대조 HTTP/2 3회·HTTP/3 1회 약 1초. 전체 suite 재실행 아님. [증거·원본 실패·한계](design/full-verification-8.7.2-2026-10-07.md#운영-r2-원인-추적--2026-10-07) |
| 2026-10-07 | 앱 없는 R2 전송·사용자 네트워크 교차 대조, 준비 SHA `233b478e8590f672aa38cd7986847ce3f291b99b` | 같은 인증 객체 native XHR 37개 중 34개 완료·측정 timeout 3개. 독립 browser 9개·단일 수신도 지연. 동일 객체 핫스팟 9개 모두 약 1.6–3.4초, 원래 Wi-Fi 복귀 후 일부 99–146초·측정 timeout으로 접속 경로와 강한 연관성 확인. 정확한 원인 구간 미확정, 제품·유지 테스트·정책·배포 변경 없음 | 실제 HTTP/2·초기 priority High, 객체 정리 성공. 원격 기존 R2 job만 attempt 2 재실행해 18 GET·다음 곡 통과, PUT→마지막 본문 3.006초. 측정 종료 180초는 원래 120초 검사의 완화가 아니며 driver exit0을 모든 GET 통과로 해석하지 않음. 전체 suite 재실행 아님. [증거·한계](design/full-verification-8.7.2-2026-10-07.md#앱을-제외한-r2-전송-대조--2026-10-07) |
| 2026-10-07 | 원격 운영 R2 새 방 3회, 검사 SHA `716c37af` / 조사 시작 main `76e19a43`, GitHub Ubuntu·Chromium | 미리 정한 3회 전부 pass·자동 retry 0. 각 방 호스트 1/게스트 9, PUT 6개·전체 GET 54개, 다음 곡 재생·추가 GET 없음 통과. 제품·테스트·정책·배포 변경 없음 | R2 job만 attempt 3·4·5 실행. 첫 PUT 응답→마지막 본문 4.122/3.062/3.196초; 개별 GET 시간 아님. 프로토콜·거점 미관측, 물리 다기기·전체 suite 재실행 아님. 기존 집 Wi-Fi 지연·과거 실패와 하위 원인 미확정 유지. [근거](design/full-verification-8.7.2-2026-10-07.md#github-원격-신규-방-3회-대조--2026-10-07) |
| 2026-10-08 | 한 세션 순차 수신, 준비 SHA `aff88adb`, 집 Wi-Fi·Windows·Chromium | 같은 파일·URL·Bearer, browser/context/page 각 1개·동시 GET 최대 1개·미리 정한 6회 모두 완료. 제품·유지 테스트·설정·배포 변경 없음 | 0.764–1.814초, 매회 HTTP 200·2,153,280바이트·SHA-256 일치·캐시 없음·정리 성공. 첫 h2 이후 동일 h3 연결 재사용, 모두 LAX. 이전 객체·시각·프로토콜 조건과 달라 과거 지연 원인 미확정 유지. [근거](design/full-verification-8.7.2-2026-10-07.md#한-세션의-순차-반복-수신--2026-10-08) |
| 2026-10-08 | H2 고정 ABBA 및 context 대조, 준비 SHA `7e025a94`, 집 Wi-Fi·Windows·Chromium | 본 측정 72/72·별도 준비 11/11 완료·동일 파일 hash. 한 세션 순차/동시 비교는 빠르게 완료했으나 후속 같은 연결의 동시 9개는 54초→17초, 분리 9세션은 14/15초. 정확한 원인 미확정·제품/테스트/설정/배포 유지 | 전부 H2/LAX·캐시 없음·정리 성공. 원본 관측기 실행은 10개 완료 후 도착순서 counter 조건 위반으로 중단·exit1 보존, v2는 원천시각 중첩으로 검증. CDP 헤더와 XHR 콜백 시각을 구분하며 이전 120/180초 실패를 해결로 처리하지 않음. [근거](design/full-verification-8.7.2-2026-10-07.md#http2-고정-변인-대조--2026-10-08) |
| 2026-10-08 | Worker·R2 관리 API 경로 대조, 준비 SHA `f05b3779`, 집 Wi-Fi·Windows·Node v24.20.0 H2 | 같은 소유 객체의 경로 대조 2회, 각각 본36+준비2 전체 수신/hash 일치. 기본 창은 Worker51/47초·관리API4.3/4.4초, 명시적16MiB 창은3.3/2.5초·2.2/2.1초. 제품·유지 테스트·운영 설정·배포 유지 | S3 직접 GET 아님. LAX/ICN·실험 간 객체/연결/시간 차이, 관리API 준비8.7초, v1 Origin 누락403 중단·정리를 보존. 이전 Chromium 지연 원인 미확정·추측성 수정 보류. [근거](design/full-verification-8.7.2-2026-10-07.md#동일-객체의-worker관리-api-경로-대조--2026-10-08) |
| 2026-10-08 | 합성 Worker 주소·직후 R2 대조, 준비 SHA `5f857cc4`, 집 Wi-Fi·Windows·Chromium H2 | 동일 Worker의 기존 호스트 임시 Route/workers.dev 본48+준비2 전부 완료. 두 주소 LAX·동시9개 약2.1–2.4초. 별도 R2 본36+준비1도 전부 완료·LAX·동시9개2.594/2.817초 | 검사 Route·Worker·자체 객체 정리; DNS/인증서 생성 없음. 이번 지연 미재현·과거 실패와 원인 미확정 유지. 다른 계정 비교 미실행·제품·기존 운영 Worker/App 배포 변경 없음. [근거](design/full-verification-8.7.2-2026-10-07.md#앱저장소를-제외한-worker-주소-대조--2026-10-08) |
| 2026-10-08 | 두 계정 workers.dev 대조, 준비 SHA `8f30c5b9`, 집 Wi-Fi·Windows·Chromium H2 | 같은 합성 Worker·기본 placement, 새 브라우저2회·순서 반전. 본96+준비4 전부 수신/hash 일치·양쪽 LAX. 동시9개 기존1.832–2.652초·playground2.222–2.401초 | 각 계정/회차 연결1개·과거 지연 원인 미확정. b1/b2 업로드 metadata 오류는 측정 전 실패로 보존, v3 실제 Default 설정 확인. 두 임시 Worker 삭제·운영/App 배포 변경 없음. [근거](design/full-verification-8.7.2-2026-10-07.md#두-계정의-workersdev-라우팅-대조--2026-10-08) |
| 2026-10-08 | 원래 운영 앱 R2 최종 1회, 준비 SHA `0cee146f`, 집 회선·Windows·Chromium | host1/guest9·원래 제한 유지·1pass/retry0. PUT2·GET18 전체 수신, 현재 곡2.757–4.599초·프리로드1.161–3.347초, 다음 곡 재생/추가 GET 없음 통과 | XHR 진행만 추가 관측·본문hash/protocol/colo 별도 미계측. 지연 미재현이며 과거 실패·원인 미확정 유지, 제품/유지 테스트/운영/App 배포 변경 없음. [근거](design/full-verification-8.7.2-2026-10-07.md#원래-운영-앱-검사-최종-1회-재확인--2026-10-08) |
| 2026-10-08 | 지연 이슈 최종 심층 코드 리뷰, 기준 `a221f2a4`, Windows/Node24.20.0 | 브라우저 전송·오케스트레이션·Worker/R2·SW·실험 관측 검토, 새 확정 원인/수정대상0건. 기존 관련19파일594pass/fail·skip0 | 느린 본문은 실제 관측이며 정지감시 정책과 원인은 구분. 과거 실패·하위 원인 미확정 보존, 사용자 요청대로 조사 종료. 새 운영 실험·제품/테스트코드 수정·배포 없음. [근거](design/full-verification-8.7.2-2026-10-07.md#최종-코드-심층-검토-및-조사-종료--2026-10-08) |

| 2026-10-08 | YouTube 검색 제목·채널 간격 수정, 코드 `08ea35d3` → PR #263/main `10be9957` | 제목의 두 줄 최소 높이를 메타데이터 묶음으로 옮겨 빈 줄 제거. 8.7.3/v634 App 배포 완료·다른 5개 Worker 유지 | 로컬 고유 unit10,781·Chromium 검색7·타입/lint/서식/경계/build 통과. PR/main CI 각11job·Release37722846236·공개 CSS hash/fresh ko 검증 성공. jq/로그 경로/공개 CSS 조회기의 초기 한계와 보완은 위 8.7.3 기록에 보존 |
| 2026-10-08 | 데스크톱 채팅 위쪽 여백 조정, 코드 `86ea0e8e` → PR #265/main `358b3fc3` | 1280px 이상에서 16px→12px, 모바일·다른 패딩·메시지 간격·내부 패딩 유지. 8.7.4/v635 App 배포 완료·다른 5개 Worker e8001e93 유지. 정책·migration·secret·binding 변경 없음; 이전 App8.7.3/10be9957이 복구 기준 | 로컬 unit 10,781·정적/build·offline Chromium production CSS 레이아웃 16조합 통과. PR/main CI 각 11job·Release37729556678·공개 CSS/SW hash/fresh ko/v635/위쪽 12px 확인. 전체 E2E·실기·기존 운영 탭/PWA 한계 유지 |

### 이전 8.7.0 실제 승격·배포 기록 — 2026-10-07 완료

| 기록 항목                                        | 값     |
| ------------------------------------------------ | ------ |
| 사용자 종료·승격 지시                            | 2026-10-07 대회 종료·main 병합·프로덕션 배포·Operations Drift Audit 재활성화 명시 승인 |
| 최종 베타 코드 SHA / PR                          | 기준 문서 `efce531a`; 버전/cache 준비 `fe0b0230ec5621a5b892f75e0427c7bfb2569d66` / [PR #245](https://github.com/hiefny/MUSIXQUARE/pull/245) 병합 |
| 최종 main SHA / main CI run / candidate          | `e8001e93c9390ec20b359b015d3dff890f2b5304` / [37583802398](https://github.com/hiefny/MUSIXQUARE/actions/runs/37583802398) / `production-candidate-e8001e93c9390ec20b359b015d3dff890f2b5304-37583802398-1` |
| 제품 버전 / cache epoch                          | `8.7.0` / `v631`, 최종 소스·후보·공개 자산 확인 |
| Release run / target / D1 입력                   | [37584399403](https://github.com/hiefny/MUSIXQUARE/actions/runs/37584399403) 성공 / `all` / `apply_developer_api_d1=false` |
| checkpoint / Worker 버전·메시지 / smoke          | mutation 전 checkpoint 보존, 6개 Worker 100% version·`git:e8001e93...`·모든 live smoke·최종 ownership·PRO ready 확인. [ID·증거](design/release-8.7.0-2026-10-07.md) |
| fresh·기존 탭/PWA / 주요 기능 확인               | 공개 45개 자산 hash·10개 HTML·fresh en/ko Chromium 통과. 로컬 v630→v631 단일/두 탭 동의 경로 통과; 실제 기존 운영 탭·설치 PWA·미디어/인증·실기는 미완료 |
| Operations Drift Audit 재활성화 / main 실행 결과 | `active`; [배포 전](https://github.com/hiefny/MUSIXQUARE/actions/runs/37583844459)·[배포 후](https://github.com/hiefny/MUSIXQUARE/actions/runs/37584995408) 성공, 각각 31 pass/0 fail/5 manual-only |
| 병합 브랜치 정리                                 | 로컬·원격 `mxqr_beta`의 `efce531a`가 main 조상임을 확인한 뒤 삭제. release 임시 브랜치도 정리; 이 문서 후속 PR은 별도 진행 |
| 남긴 제한·복구 조치 / 완료 일시                  | R26 원인 미확정·실기·수동5항목 유지, rollback 없음 / Release 2026-10-07 16:02:35 KST 완료. 문서 후속 커밋은 추가 App 배포 대상 아님 |
