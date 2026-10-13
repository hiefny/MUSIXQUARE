# 프로덕션 릴리스 이력

| Field              | Value |
| ------------------ | ----- |
| Status             | Runbook — append-only 릴리스 로그 |
| Applies to         | 프로덕션 배포와 롤백 (`Production Release` 실행, 로컬 emergency deploy, CLI rollback) |
| Last source review | 2026-10-14 |
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
| 2026-10-11 10:33 | 8.9.0 / v651  | all       | `d76b1432` | [#291](https://github.com/hiefny/MUSIXQUARE/pull/291) (+[#287](https://github.com/hiefny/MUSIXQUARE/pull/287)–[#290](https://github.com/hiefny/MUSIXQUARE/pull/290)) | [38101940058](https://github.com/hiefny/MUSIXQUARE/actions/runs/38101940058) | 성공 | PRO 입장 보호(방장 자리, 입장·나가기 기록 분리, 입장 한도), 암호 설정·변경 때 참여자 선택과 퇴장 사유 안내, 입장 거절 문구 42개 언어, 의존성 업데이트, persisted-resource lane 리팩터링. 8.8.1은 따로 배포하지 않음 | [입장 보호](design/pro-room-admission-protection-2026-10-11.md), [참여자 선택](design/pro-pin-member-choice-2026-10-11.md), [입장 문구](design/pro-join-error-copy-2026-10-11.md), [의존성](design/dependency-update-2026-10-11.md), [lane](design/persisted-resource-lane-2026-10-11.md) |
| 2026-10-12 00:37 | 8.9.4 / v655 | all | `a440e184` | [#295](https://github.com/hiefny/MUSIXQUARE/pull/295) (+[#293](https://github.com/hiefny/MUSIXQUARE/pull/293)) | [38151658686](https://github.com/hiefny/MUSIXQUARE/actions/runs/38151658686) | 성공 (attempt 1) | PRO 시계 응답 대기 예산, 동시 입장 티켓 검증, 실패 후 같은 화면 재시도, 이전 연결 안내 42개 언어, 암호 두 단계 UI 묶음. 8.9.1–8.9.3은 따로 배포하지 않음 | [검증·배포](design/pro-pwa-force-close-audit-2026-10-12.md) |
| 2026-10-12 01:53 | 8.9.5 / v656 | all | `972555c3` | [#298](https://github.com/hiefny/MUSIXQUARE/pull/298) | [38156993930](https://github.com/hiefny/MUSIXQUARE/actions/runs/38156993930) | 성공 (attempt 1) | PRO 서버 자연 종료·연속 전환, 제한된 파일 길이 분석·인증된 YouTube 메타데이터, 권한 기기 절전·퇴장 대응. 새 비밀·D1 스키마·복구 floor 없음 | [검증·배포](design/pro-autonomous-playback-2026-10-12.md) |
| 2026-10-12 02:58 | 8.9.6 / v657 | all | `8307f12b` | [#300](https://github.com/hiefny/MUSIXQUARE/pull/300) | [38161550040](https://github.com/hiefny/MUSIXQUARE/actions/runs/38161550040) | 성공 (attempt 1) | PRO 파일 등록 시 길이 확보·asset별 저장, 기존 파일 점진적 보완·권한 기기의 준비 완료 보고. 재업로드·큐 초기화·새 비밀·바인딩·D1 스키마·복구 floor 없음 | [검증·배포](design/pro-file-duration-registration-2026-10-12.md) |
| 2026-10-12 03:50 | 8.10.0 / v659 | all | `95e9092c` | [#294](https://github.com/hiefny/MUSIXQUARE/pull/294) | [38165114764](https://github.com/hiefny/MUSIXQUARE/actions/runs/38165114764) | 성공 (attempt 1, exact-main CI attempt 2) | 일반방 방장 암호 직접 설정과 두 단계 참여자 선택, 두 방 종류 암호 가림, 일반방 오답 제한(fail open), 옛 암호 재연결 수정, 강제 색상 수정, 방·데모 중 업데이트 대화상자 대신 채팅 안내, 기능 복구 대화상자 문구, 탭 인계 문구 수정. signaling·app만 런타임 변경, 새 비밀·바인딩·D1 스키마·복구 floor 없음 | [일반방 암호](design/standard-room-owner-pin-2026-10-11.md), [업데이트 안내](design/in-room-update-prompt-2026-10-11.md), [병합·리뷰·배포](design/release-8-10-0-merge-review-2026-10-12.md) |
| 2026-10-12 10:42 | 8.10.1 / v660 | all | `9c924ee1` | [#303](https://github.com/hiefny/MUSIXQUARE/pull/303) | [38192571743](https://github.com/hiefny/MUSIXQUARE/actions/runs/38192571743) | 성공 (attempt 1) | PRO 자연 종료 길이 판독 강화(이어 붙인 MP3·뒤쪽 태그·조각난 MP4), 이전 판독기 길이 재측정·업로드 길이 미저장, 컨트롤러 길이 0.9배 하한, 알람·메타데이터 반복 방지와 YouTube 조회 간격, 삭제·비공개 영상 두 번 확인 후 건너뛰기, 불안정 스피너 테스트 수정. 새 비밀·바인딩·D1 스키마·복구 floor 없음 | [검증·배포](design/pro-duration-hardening-2026-10-12.md) |
| 2026-10-13 00:05 | 8.10.2 / v661 | app | `72a6e780` | [#305](https://github.com/hiefny/MUSIXQUARE/pull/305) | [38267400052](https://github.com/hiefny/MUSIXQUARE/actions/runs/38267400052) | 성공 (attempt 1) | PRO 작업별 시계·미보정 시작 차단, 일반방 타이머 지연 학습 분리, Android 기기별 YouTube 250ms 보정·방장 공통 기준, held-start 수동 싱크·시크와 곡 끝 처리, 진단 로딩 경계. 기존 점검 모드 00:01:12–00:02:07 적용 뒤 해제, 강제 버전 admission 없음. 새 의존성·비밀·바인딩·스키마·복구 floor 없음 | [검증·점검·배포](design/sync-maintenance-release-preparation-2026-10-12.md) |
| 2026-10-13 00:55 | 8.10.3 / v662 | app | `8d0d310c` | [#307](https://github.com/hiefny/MUSIXQUARE/pull/307) | [38273449653](https://github.com/hiefny/MUSIXQUARE/actions/runs/38273449653) | 성공 (attempt 1) | 새 일반방 방장·참여자 페이지의 공지 모듈 초기화 누락 수정, 실제 setup을 지나는 필수 브라우저 회귀 검사. exact-main CI·운영 smoke 4종 통과와 운영 브라우저 공지 표시 증거로 공지 수정 배포 대기 항목 해소. 점검 OFF 유지, 새 의존성·비밀·바인딩·스키마·복구 floor 없음 | [검증·배포](design/standard-announcement-bootstrap-2026-10-13.md) |
| 2026-10-13 03:54 | 8.10.4 / v665 | all | `332600a9` | [#309](https://github.com/hiefny/MUSIXQUARE/pull/309) | [38293505122](https://github.com/hiefny/MUSIXQUARE/actions/runs/38293505122) | 성공 (attempt 1) | 공지 철회와 일시 조회 실패 구분, 공개 revision 캐시 역행 차단, 관리자 초안·만료 검증·저장 경계, 전체보기 다이얼로그. exact-main CI 11 jobs·운영 smoke 10종·6 Worker 100% 소유권·generation ready·coherent marker 검증. 점검 OFF·공지 비활성 유지, 신규 의존성·스키마·비밀·바인딩·복구 floor 없음 | [수정·검증·배포](design/announcement-repair-2026-10-13.md) |
| 2026-10-13 06:57 | 8.10.5 / v666 | all | `08df0606` | [#311](https://github.com/hiefny/MUSIXQUARE/pull/311) | [38313333407](https://github.com/hiefny/MUSIXQUARE/actions/runs/38313333407) | 성공 (attempt 1) | PRO 활성 Peer 번호·정원 TTL 경계·공유 registry 조회 수명 세 결함 수정, 공통 점검·공지 조회의 context·응답 순서·만료 보호와 제한된 서버 진단. exact-main CI 11 jobs·운영 smoke 10종·6 Worker 100% 소유권·generation ready·coherent marker 검증, Drift Audit 31 pass / 0 fail / 5 manual. 점검 OFF·공지 비활성 유지, 신규 의존성·스키마·비밀·바인딩·복구 floor 없음. 행사 원인과 진단 보존 한계는 미확정 항목으로 유지 | [수정·검증·배포](design/pro-admission-repair-2026-10-13.md) |
| 2026-10-13 08:03 | 8.10.6 / v667 | app | `f0ea308b` | [#314](https://github.com/hiefny/MUSIXQUARE/pull/314) | [38319913652](https://github.com/hiefny/MUSIXQUARE/actions/runs/38319913652) | 성공 (attempt 1) | 공지 `/clear` 소유권·닫기 hit-area·관리자 초안 갱신·legacy 정규화 및 레코더 빌드 식별 수정. exact-main CI 11 jobs, 운영 smoke 4종, App 100% 소유권·미선택 5 Worker 호환성·coherent marker 확인. Drift Audit 31 pass / 0 fail / 5 manual. 점검 OFF·공지 비활성 유지, 신규 의존성·스키마·비밀·바인딩·복구 floor 없음 | [재검증·배포 근거](design/announcement-review-followup-2026-10-13.md) |
| 2026-10-13 11:29 | 8.10.7 / v668 | app | `6b159667` | [#316](https://github.com/hiefny/MUSIXQUARE/pull/316) | [38336912131](https://github.com/hiefny/MUSIXQUARE/actions/runs/38336912131) | 성공 (attempt 1) | 42개 언어 YouTube 내부 URL 힌트·아래 링크/검색어 안내 및 입력 삭제 뒤 안내 복원. exact-main CI 11 jobs, 운영 smoke 4종 pass / 범위 밖 6종 skip, App 100% 소유권·미선택 5 Worker 호환성·coherent marker 확인. Drift Audit 31 pass / 0 fail / 5 manual. 점검 OFF·공지 비활성 유지, 신규 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 없음. 변경 전 Full E2E 최초 focus 실패는 미확정 관찰 유지 | [검증·배포·관찰](design/youtube-input-guidance-2026-10-13.md) |
| 2026-10-13 16:51 | 8.10.8 / v669 | app | `dc69bda0` | [#319](https://github.com/hiefny/MUSIXQUARE/pull/319) | [38365146388](https://github.com/hiefny/MUSIXQUARE/actions/runs/38365146388) | 성공 (attempt 1) | YouTube 지연 초기 focus의 사용자 Tab 이동 덮어쓰기 수정과 E2E 진입 순서 보완. 자연 실패 인과·단위 RED→GREEN·로컬/원격 Chromium 각 627 pass·WebKit 및 exact-main CI 11 jobs 확인. 운영 smoke 4 pass / 범위 밖 6 skip, App 100% 소유권·5 Worker 호환성·coherent marker 검증. Drift Audit 31 pass / 0 fail / 5 manual. 점검 OFF·공지 비활성 유지, 신규 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 없음 | [원인·검증·배포](design/youtube-popup-focus-repair-2026-10-13.md) |
| 2026-10-14 01:02 | 8.10.9 / v671 → 8.10.8 / v669 복구 | app | `16c6b219` | [#321](https://github.com/hiefny/MUSIXQUARE/pull/321) | [38426762796](https://github.com/hiefny/MUSIXQUARE/actions/runs/38426762796) | 실패·자동 복구 확인 (attempt 1) | 새 App 배포 생성 뒤 최초 status가 이전 배포를 반환하여 record 안전 검사에서 중단. 후보 운영 smoke·coherent marker 미실행. 기존 App version으로 rollback하고 독립 recovery의 Worker/R2·호환 floor 재검증 및 공개 SW v669 확인. 조회 세부 원인은 미정이며 앱 결함으로 단정하지 않음 | [조회 경계·복구 증거](design/component-cascade-refactor-2026-10-13.md#배포복구) |
| 2026-10-14 01:07 | 8.10.9 / v671 | app | `16c6b219` | [#321](https://github.com/hiefny/MUSIXQUARE/pull/321) | [38427573214](https://github.com/hiefny/MUSIXQUARE/actions/runs/38427573214) | 성공 (attempt 1, 별도 실행으로 재시도) | 동일 exact-main CI 후보로 컴포넌트 pill 소유권·CSS cascade·접근성 우선순위·관리자 clear 버튼·welcome 슬라이더 정리 배포. 운영 smoke 4 pass / 범위 밖 6 skip, App 100% 최종 소유권·미선택 5 Worker 호환성·coherent marker·공개 CSS/SW v671 확인. 선행 실패 및 미확정 로컬 seed 470021 이력 유지. 신규 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 없음 | [검증·실패·배포·복구](design/component-cascade-refactor-2026-10-13.md#배포복구) |
| 2026-10-14 03:18 | 8.10.10 / v673 | app | `414ce19d` | [#323](https://github.com/hiefny/MUSIXQUARE/pull/323) | [38445343194](https://github.com/hiefny/MUSIXQUARE/actions/runs/38445343194) | 성공 (attempt 1) | 일반방 YouTube 완결 목록·부분 캐시 복구, PRO 재입장 manifest 보존, 관리자 iframe 재개·직접 탐색·프로그램 seek 소유권 수정. exact-main CI 11 jobs, 운영 smoke 4 pass / 범위 밖 6 skip, App 100% 최종 소유권·미선택 5 Worker 호환성·coherent marker 확인. Drift Audit 31 pass / 0 fail / 5 manual-only. 같은 IAB 프로필의 기존 탭 갱신·새 탭과 공개 SW v673 확인. 새 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 없음. 자연 반복 원인·실기/공급자 한계와 이전 seed 470021 이력 유지; 전체 640-case E2E는 재실행하지 않음 | [수정·검증·배포·복구](design/youtube-playlist-native-control-repair-2026-10-14.md#release-and-recovery) |

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
