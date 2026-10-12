# 릴리스 기록 (현재 상태)

| Field              | Value |
| ------------------ | ----- |
| Status             | Runbook — 현재 릴리스 상태. 프로덕션 배포·롤백마다 §1을 덮어쓰고, 열린 항목이 바뀌면 §2를 고친다 |
| Applies to         | 프로덕션 App·Worker 6종의 현재 배포 상태, 열린 확인 항목, 릴리스·QA 때 지킬 기준 |
| Last source review | 2026-10-13 (배포 SHA `332600a9`, Release `38293505122`) |
| Executable sources | [CI](../.github/workflows/ci.yml), [Production Release](../.github/workflows/release.yml), [배포 범위·복구 판정](../scripts/release-deployment-state.mts), [D1 계약](../cloudflare/d1-migrations.manifest.json) |
| Related documents  | [릴리스 이력](release-history.md), [정식 배포·복구 절차](hotfix-procedure.md), [버전 규칙](release-versioning.md), [QA 범위 설계](qa-domains.md), [허용한 위험](known-accepted.md), [작업 지침](../AGENTS.md) |

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

Drift Audit, Full E2E, 의존성 행은 기록 시점의 값이다. 매일·매주 바뀌므로 위
명령으로 다시 조회하고, 이 표의 값을 그대로 믿지 않는다.

| 항목 | 값 |
| ---- | -- |
| App 버전 / SW 캐시 | `8.10.4` / `v665` |
| 마지막 프로덕션 변경 | 2026-10-13 03:54:42 KST, [Release 38293505122](https://github.com/hiefny/MUSIXQUARE/actions/runs/38293505122) attempt 1 성공, `target=all`, Developer API D1 `false`. 공지 철회·조회 계약·관리자 편집·전체보기 수정. 점검 OFF 및 공개 공지 비활성 상태 유지 |
| 배포 main SHA | `332600a9a00fcaafccae884558b5fcf29f816f25` (PR [#309](https://github.com/hiefny/MUSIXQUARE/pull/309)). exact-main [CI 38292941681](https://github.com/hiefny/MUSIXQUARE/actions/runs/38292941681) attempt 1 성공 후보 재사용 |
| Worker | 6종 모두 `332600a9` 단일 version 100%. App version `b6f7da30-6125-459d-8e59-8fee62308938`, deployment `a26c6db2-28c7-4ff4-94fa-6f7c89ff0c30`. PRO version `00f2387c-029d-48af-9e6d-e845d4dcb524`, deployment `00c5c594-e115-4edf-bc6c-b43645ff039b`. 나머지 식별자는 [배포 증거 표](design/announcement-repair-2026-10-13.md#프로덕션-배포--2026-10-13)에 기록했다. 03:54:33 KST 최종 배포 소유권, 03:54:35 generation ready, 03:54:38 coherent marker 영속화 확인. 운영 smoke 10종 성공. 새 의존성·비밀·바인딩·D1 스키마 없음. 기존 App/admin/auth 기준선은 멱등 적용·검증 |
| 복구 | 필요 없음. Release 38293505122 recovery job은 skip됐다. 불변 checkpoint에 변경 전 App `8d0d310c` version `9ba8ecc6-af3e-4009-b6d0-d4857b0c3294`, deployment `15f11373-6155-4a5b-8563-664696d6f588` 및 나머지 5종 `9c924ee1` 식별자가 보존됐고 기존 floor를 지원하는 ancestor임을 확인했다. 이전 App 복구 시 공지 결함도 돌아오며, revision 없는 응답을 거부하는 새 클라이언트 탭은 새로고침해야 한다. checkpoint는 사용자 데이터 백업이 아니다 |
| 활성 복구 floor | 기존 generation·entitlement·Developer API authority·service-control·Soro·PRO 선택형 입장 암호 계약 유지, 신규 floor 없음. PRO/App 암호 marker `pro-room-optional-entry-password-v1`, generation floor SHA `4c5612d5fc4c5548781eb7d5b26d6904969c051c` 유지. 계약을 모르는 이전 기준선으로 복구하지 않으며 검증된 호환 기준선으로 rollback 가능. 기존 PRO 파일 길이·쿠키 경계는 §4와 정식 절차를 따른다 |
| 검증 범위 | 최종 PR [CI 38292044186](https://github.com/hiefny/MUSIXQUARE/actions/runs/38292044186)와 exact-main CI 각각 11개 job 성공. 각각 unit 552파일 / 12,446 pass / 0 fail / 1 skip(Windows 전용 경로 검사, 로컬 Windows에서 통과), 후보 browser 17 + critical 23 pass, coverage 4종 통과. 버전 bump 전 로컬 전체 unit 12,446 pass / 0 fail / 0 skip 및 리뷰 보완 후 관리자 47 pass. 최종 런타임 SHA `3240fc97`의 committed build:checked 성공; main tree는 해당 PR 최종 tree와 동일하다. 타입·린트·포맷·Worker guard 통과. 공개 `/`·SW HTTP 200/v665, 공지 HTTP 200 `enabled:false, revision:8` 확인. 운영 공지를 다시 게시하지 않아 실제 5분 철회·실기기 확인은 §2에 남는다. [수정·검증·배포](design/announcement-repair-2026-10-13.md) |
| Operations Drift Audit | active, 매일 03:37 UTC. 이번 배포 뒤 [38294123500](https://github.com/hiefny/MUSIXQUARE/actions/runs/38294123500) (2026-10-13 03:55:21 KST, source `332600a9`) 31 pass / 0 fail / 5 manual. Worker 바인딩·도메인·비밀 이름·R2 정책 자동 검사 통과. 수동 항목은 §2에 남으며 통과로 간주하지 않는다 |
| Full E2E | 매주 월 18:17 UTC. 2026-10-13 재조회한 main ref 마지막 실행은 [37595231001](https://github.com/hiefny/MUSIXQUARE/actions/runs/37595231001) (`61cedbc6`, 2026-10-07 수동). 이번 exact-main 후보·critical browser 검사와 별개로 `332600a9` 전체 Full E2E 실행은 없음 |
| 의존성 | 8.10.4 의존성 변경 없음, 기존 그룹 업데이트 [#288](https://github.com/hiefny/MUSIXQUARE/pull/288) 유지. 그룹 PR [#297](https://github.com/hiefny/MUSIXQUARE/pull/297)은 열려 있으며 이번 배포 제외. Release 38293505122 설치 취약점 0건. sharp 0.35.5 override와 TypeScript 6.1 이상·@types/node 25 이상 Dependabot ignore 유지. [상세](design/dependency-update-2026-10-11.md) |

## 2. 열린 확인 항목

해결하면 근거(커밋, 실행 ID, 문서)를 PR 설명에 적고 이 목록에서 지운다. 근거
없이 완료로 표시하지 않는다.

### 확인된 후속 결함

공지의 네 배포 대기 항목은 PR #309의 재현·회귀, exact-main CI, App·PRO를 포함한
Release 38293505122 성공으로 닫았다. 관리자 초기 초안의 미관측 revision 채택과
첫 조회 실패 후 초안 유실도 리뷰에서 재현·수정했다.
[해결 근거](design/announcement-repair-2026-10-13.md#프로덕션-배포--2026-10-13).
PRO 방장 공지의 중도 참여 복원은 별도 정책이며 이번 서비스 공지 수정에 포함하지 않았다.

### 실기기 확인

사용자의 실제 기기가 필요하다. 브라우저 자동화 결과로 대신하지 않는다.

- [ ] 8.10.4 공지: 새 클라이언트가 적용된 운영 일반방·PRO에서 게시 후 철회와 5분/
  foreground 반영, 실제 iPhone Safari/PWA·VoiceOver 및 Android/TalkBack의 전체보기/
  짧은 화면 스크롤·닫기. 이번에는 운영 공지를 재게시하지 않았고 기존 설치 PWA는
  새로고침 전 구 코드가 남을 수 있다. [증거·한계](design/announcement-repair-2026-10-13.md)

- [ ] 8.7.9 헤더 크로스페이드: iPhone Safari/PWA에서 로딩 시작·종료, 시크 직후
  탭 왕복. [상세](design/header-crossfade-2026-10-09.md)
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
- [ ] 방·데모 중 업데이트 안내(8.10.0 배포 뒤; 기기가 `v659` 코드를 실행한 뒤 다음
  캐시 업데이트가 와야 볼 수 있다):
  iPhone Safari 탭, iPhone 홈 화면 PWA, Android Chrome(탭과 설치 앱), Windows·macOS
  데스크톱에서 방장·참여자·PRO 방·데모 중 새 버전이 대기하면 대화상자 없이 채팅에
  안내가 한 번만 뜨는지, 탭은 "페이지를 새로고침하면", 설치 앱은 "앱을 다시 열면"
  문구인지, 다른 기기 채팅에는 뜨지 않는지, 다른 탭이 업데이트를 수락해도 방 탭이
  새로고침되지 않고 같은 안내를 다시 띄우지 않는지, PRO 방에서 휴대폰을 45초 넘게
  잠갔다가 깨워도(재입장) 대화상자가 뜨거나 새로고침되지 않는지, 방을 나와 설정
  화면으로 돌아오면 업데이트 대화상자가 한 번 뜨는지("나중에" 뒤에는 다시 뜨지 않음)
  확인한다. 대화상자는 Host·Join을 누르기 전 첫 설정 화면에서만 그대로다. 만들기·참여
  화면(초대 링크 참여 포함)은 이미 방으로 보아 토스트가 뜨고, 방이 시작되면 채팅에
  안내가 한 번 더 뜨는지 본다(오너 결정 2026-10-11). 우르두어 채팅 안내가 오른쪽
  정렬로 보이는지도 본다.
  [상세](design/in-room-update-prompt-2026-10-11.md)

### 원인을 모르는 관찰

재현되면 원인과 함께 기록한다. 지금 예정된 조사는 없다.

- [ ] 운영 R2 전송이 느리거나 끝나지 않음: 오너의 집 Wi-Fi(LAX 경로)에서만 보였고
  앱 없이 native XHR로도 재현됐다. 핫스팟과 GitHub 원격 실행에서는 통과했다.
  8.7.2 전체 검증의 첫 R2 8/9 실패도 같은 묶음이다. 2026-10-08 오너 요청으로
  조사를 종료했다. 추측에 따른 제품 수정은 하지 않고, 이 관찰 때문에 120초
  다운로드 검사나 90초 stall 정책을 완화하지 않는다.
  [조사 종료 근거](design/full-verification-8.7.2-2026-10-07.md#최종-코드-심층-검토-및-조사-종료--2026-10-08)
- [ ] legacy SW(R26): 첫 Refresh 승인 뒤 15초 동안 갱신이 안 된 1회. 재현되면
  승인 → `SKIP_WAITING` → waiting worker → `controllerchange` → 새 문서 순서를
  페이지 밖에서 로그로 남기고, 오래된 실기에서도 시도한다.
  [상세](design/beta-30-round-repair-2026-10-07.md)
- [ ] "claim 미보유" 안내 1회: 2026-10-09 계정 확인·닉네임 후속(`c3a313c9`)의 첫
  dev Chromium 12케이스 실행에서 나왔고, 이후 dev 12·운영 12 실행에서는 나오지
  않았다. HMR이나 환경 탓으로 단정하지 않는다.
  [기록](beta-release-readiness-archive-2026-10-10.md#1-현재-상태)
- [ ] 2026-10-08 이전 시그널링 Worker 예외(24시간 3건, 7일 10건)의 원인과 사용자
  영향. `99f9103c`로 진단 로그를 배포했다.
  [조사 runbook](../cloudflare/config-drift-ops.md#signaling-exception-investigation)

### 운영·보안

- [ ] 일반방 방장 암호 운영 감시와 전환기 한계(8.10.0 배포 뒤): 관리자 대시보드
  Operations 화면 Signals 패널의 Password lockouts(`guest_auth_rate_limited`, 최근
  24시간)가 평소 0에 가까운지 본다. 주 신호는 Password failures(`guest_auth_failed`)나
  Operations의 Password issues 카드 급증, 또는 신고다. 오답 제한은 방마다
  네트워크(IPv4 주소, IPv6 /64) 256개까지 버킷을 두고, 표가 차 있으면 새 네트워크는
  제한하지도 기록하지도 않는다(fail open). 주소를 많이 바꾸는 추측(IPv6로는 쉽다)은
  제한되지 않으며 오너가 2026-10-11 결정 B로 이를 허용했다. 추측 공격이 보이면 게스트
  암호 시도 앞에 봇 확인(예: Cloudflare Turnstile)이나 작업 증명을 검토한다. 전환기
  한계: 캐시된 8.9.x 방장은 계속 무작위 암호를 만들고, 그 암호를 새로 만들었으면 남아
  있던 참여자가 재연결 때 옛 암호를 보내 실패가 같은 주소 버킷에 쌓일 수 있다. 이전
  App 참여자는 "모두 재입장"으로 내보내지면 "강제퇴장"을 보고, 새 오류 두 가지는 일반
  입장 오류로 보인다(영구 인증 오류라 재연결 폭주는 없다). 이 첫 배포 때 이전
  코드(`v657` 이하)를 실행 중이던 기기는 방 안에서도 예전 업데이트 대화상자를 한 번
  본다. 다음 배포부터는 새 업데이트 안내 정책을 따른다. 되돌리기는 §4.
  [상세](design/standard-room-owner-pin-2026-10-11.md),
  [업데이트 안내](design/in-room-update-prompt-2026-10-11.md),
  [운영](../cloudflare/standard-room-pin-ops.md),
  [허용 위험](known-accepted.md#12-standard-room-owner-pins-kicks-and-guessing)
- [ ] Drift Audit 수동 5항목: Worker zone routes, `/admin` Access+MFA, WAF rate
  limit과 Worker/R2/D1 비용 알림, 두 번째 Git 배포 경로가 없음, main review·필수
  체크 정책. 자동 감사가 통과해도 이 항목은 완료가 아니다.
- [ ] Daybreak 심층 보안 재실행 5건: R17-C01(QA073·QA075), QA094, QA109, QA086,
  QA032. 계정 보안(FIDO2) 요구로 실행하지 못했다. 대신 있는 로컬 근거: 일반 모드
  `44ef6a78` (43 pass), API key 수명 `2a6e4812` (8 pass, queue-mode·queue-add만;
  media reserve/finish 동적 조합은 미실행), QA032 로컬 수신 경로 `fa33c660`
  (434 pass; binary codec, 실제 WebRTC, live는 범위 밖).
  [상세](design/beta-30-round-repair-2026-10-09.md#daybreak-보안-심화-재시도--2026-10-09)
- [ ] 전환기 한계(8.9.0 배포 뒤): 아직 갱신되지 않은 이전 App(8.8.0)은 퇴장
  사유를 읽지 않는다. 강퇴되면 일반 "세션을
  새로고침하고 있어요..."를 보여 주고, 공개방이면 시작 버튼 한 번으로 다시 들어올
  수 있다. 그 App이 갱신될 때까지 남는다.
  [상세](design/pro-pin-member-choice-2026-10-11.md)
- [ ] 호환·복구(8.9.0 배포 뒤): PRO Worker만 이전으로 되돌리면
  기본값 "그대로 두기"가 400으로 거절되어 App이 "암호를 바꾸지 못했어요"를
  보여 주고, "모두 재입장"(8.9.0은 "모두 다시 입장하게 하기")은 계속 동작한다.
  새 floor는 없다(§4).
  [상세](design/pro-pin-member-choice-2026-10-11.md)
- [ ] PRO 공개방 입장 보호(8.9.0 배포 뒤): 실제 공개방에서
  일반 입장·재입장·탭 닫기 후 복귀가 `RATE_LIMITED`나 `ROOM_FULL` 없이 되는지,
  PRO Worker 로그에서 두 응답이 평소보다 늘지 않는지 확인한다. 입장 throttle
  카운터는 Durable Object 메모리에만 있어 운영에서 직접 볼 수 없고, 주소별 키
  파생(IPv4, IPv6 /64)은 front door 단위 테스트로만 검증했다.
  [상세](design/pro-room-admission-protection-2026-10-11.md)

### 후속 작업과 유지 결정

- [ ] 일반방 YouTube zero-start 직후 Sync 준비 공백(2026-10-12 로컬 관측):
  초기 프로토콜의 소유권은 풀렸지만 첫 일반 playback snapshot이 오기 전에
  Sync를 누르면 "방장 재생 정보가 없음" 안내가 나오고 자동 재시도하지 않는다.
  실제 Chromium에서 재현했으며 자연 heartbeat 수신 뒤 재클릭 포함 총 8회는
  정상 진행됐다. C11 학습 게이트 거절이나 heartbeat 영구 중단은 아니다.
  오너 결정(2026-10-12): 원하지 않는 시점에 재생을 흔들지 않도록 자동 재시도는
  추가하지 않는다. 준비 안내 후 사용자가 다시 누르는 정책을 유지한다. 이번은
  조사만 했고 런타임을 수정하지 않았다.
  [브라우저 실험·초기 timeout과 재시도 근거](design/standard-clock-browser-simulation-2026-10-12.md)
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
      [수용한 전환기 한계](known-accepted.md#13-maintenance-cutover-without-client-version-admission)
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
- [ ] 접근성: 숨겨진 비활성 YouTube 패널의 전체화면 버튼이 역방향 키보드
  포커스를 받는다. 8.7.8 이전부터 있던 문제다.
- 조건부 감시(리버브): 지금은 모든 검증기가 decay를 10초로 제한한다. 8.7.0 이전
  30초 상한 때 Developer API로 저장된 10초 초과 값이 PRO 저장소에 남아 있으면,
  재로드 검증이 effects 전체를 기본값으로 돌린다. 오너가 실제 API 사용자를 확인한
  뒤 과거 값 이전 코드를 제거했다(`d84323d3`). 임의 보정이나 일괄 데이터 변경을
  다시 넣지 않는다. 새 API 사용 보고가 있는지 보고, 그런 저장값이 확인되면 영향과
  처리 결정을 여기에 기록한다.
- 유지 결정(한국어 문체): 2026-10-09 문체 감사(`f05af624`) 후보 중 오너는 8.7.6에
  넣은 PRO 안내 2개와 YouTube 오류 1개만 고쳤다. "환영합니다", 외부 페이지,
  접근성 설명, 나머지 후보는 그대로 두기로 했다. 새 오너 요청 없이 다시 제안하지
  않는다. [기록](beta-release-readiness-archive-2026-10-10.md#누적-변경-이력)

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

## 4. 복구 시 주의

기본 절차는 [hotfix-procedure.md](hotfix-procedure.md)다. checkpoint는 사용자
데이터 백업이 아니고, 더 새로운 외부 배포를 덮어쓰지 않으며, 소스를 revert해도
버전과 캐시 번호는 앞으로만 올린다. 아래는 지금 유효한 복구 경계다. PRO 선택형
입장 암호 floor의 정본은 hotfix-procedure의 "Optional PRO entry passwords"
문단이고, 아래는 요약이다.

- **PRO 파일 길이 저장(8.9.6):** App·PRO 함께 `all`로 배포한다. 새 비밀·바인딩·D1
  마이그레이션·복구 floor는 없다. 기존 파일의 private asset metadata를 점진적으로
  보완하고 업로드나 재생목록을 초기화하지 않는다. 이전 PRO에 대한 업로드 완료의
  선택적 길이 필드는 400 `INVALID_REQUEST`에서만 한 번 제외해 재시도한다.
  추가 길이 보고는 실패해도 재생을 막지 않으며, 구 서버의 404 `NOT_FOUND`는 해당
  클라이언트 수명 동안 생략한다. 8.9.5로 복구하면 새 필드는 사용하지 않고 기존
  큐 캐시·서버 조회·READY 경로로 돌아간다.
  [상세](design/pro-file-duration-registration-2026-10-12.md)

- **PRO 자율 재생(8.9.5):** App과 PRO를 함께 배포(`all`)한다. 새
  `PRO_YOUTUBE_METADATA` 서비스 바인딩은 기존 App의 YouTube 키와 기존 공유
  assertion secret을 쓰며, 새 비밀·D1 마이그레이션·호환 floor는 없다. PRO를 먼저
  배포했을 때 이전 App의 내부 경로 404는 미확정으로 처리하고 재시도한다.
  PRO 롤백 시 파일 READY의 선택적 길이 필드는 400 `INVALID_REQUEST`에만 한 번
  제외하고 재시도한다. 구 Worker는 새 길이 캐시를 사용하지 않으므로 자율 곡 전환은
  다시 권한 기기의 종료 보고에 의존한다. App만 롤백해도 기존 파일 근거는 유지되지만
  새 YouTube 길이 조회는 복구 전까지 미확정이 된다.
  [상세](design/pro-autonomous-playback-2026-10-12.md)

- **PRO 선택형 입장 암호:** `passwordRequired: false` / `pin: null`이 저장될 수
  있는 배포 이후에는 이 계약을 모르는 구 PRO/App 조합으로 자동 복구하지 않는다.
  구 Worker는 공개방 입장을 막거나, PIN 변경 뒤에도 모르는 false 플래그를 남겨
  재업그레이드 때 방을 다시 공개할 수 있다. forward repair나 검증된 같은 시점
  코드·데이터 복구를 쓰고, 계약을 아는 이후 기준선(예: 8.8.x에서 8.8.0으로)으로는
  일반 rollback이 가능하다. 임의 PIN 주입이나 플래그 삭제로 우회하지 않는다.
  [계약](design/pro-optional-entry-password-2026-10-10.md)
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
- **PRO 암호 참여자 선택·퇴장 사유(배포되면 적용):** 이 변경 이전 PRO Worker로
  되돌리면 `existingParticipants`가 든 `POST /pin`은 400 `INVALID_REQUEST`로
  거절된다. App은 이를 "그대로 두기를 지금 쓸 수 없음"으로 보여 주고 모두를
  내보내는 쪽으로 대신 시도하지 않는다. "모두 재입장"(8.9.0은 "모두 다시 입장하게
  하기")은 예전 `{pin}` 요청이라 그대로 동작한다. core의
  `sessionRevocationNotices`(최대 256개, 약 36 KiB)는 이전 Worker가 그대로
  보존하지만 읽거나 정리하지 않으며, 그동안
  퇴장 사유는 붙지 않는다(코드는 계속 `SESSION_REQUIRED`). 다시 앞으로 배포하면
  인증 epoch·room generation이 맞지 않거나 만료된 항목은 첫 prune에서 정리된다.
  App만 이전으로 되돌리면 사유를 무시하고 예전처럼 동작한다. 계약 marker는 없고
  rollback floor도 바뀌지 않는다.
  [상세](design/pro-pin-member-choice-2026-10-11.md)
- **일반방 방장 암호(8.10.0 배포 뒤):** 시그널링만 8.10.0 이전 Worker로 되돌려도
  floor는 없다. 이전 Worker는 `standard-room-pin-membership-v1`과
  `standard-room-pin-failures-v1`을 읽지 않고 기능 플래그도 알리지 않아, App이
  암호만 보낸다. 그동안 "그대로 두기"는 8.10.0 이전처럼 동작해 재연결 때 옛 암호를
  다시 보내는 결함이 돌아오고, "모두 재입장"은 방장의 강퇴뿐이라 수정된
  클라이언트는 시그널링에 남을 수 있다. 오답 제한도 꺼지는데 방장이 고른 약한
  암호는 계속 허용된다. 그래서 forward fix를 우선하고, 되돌려야 하면 App도 함께
  되돌린다(8.9.x의 무작위 암호로 돌아간다). 되돌린 동안 같은 방에서 암호를
  X→Y→X로 바꾸면, 다시 앞으로 배포했을 때 X 때의 유지 목록이 되살아난다(그 기기도
  자기 재연결 비밀이 있어야 한다). App만 되돌리면 무작위 암호로 돌아가고 새
  Worker는 예전 프레임을 그대로 받는다. 되돌리기 전에 저장된 유지 목록은 방
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
   덮어쓴다. 이전 값은 남기지 않는다.
2. [release-history.md](release-history.md) 표 맨 아래에 한 줄을 추가한다.
3. 릴리스 상세 근거는 `docs/design/<주제>-<날짜>.md`에 쓰고 §1과 이력 행에서
   링크한다.
4. 이번 배포로 해결된 §2 항목은 근거와 함께 지우고, 새로 생긴 한계는 추가한다.

**QA 라운드나 제품·런타임 변경을 마친 뒤** (문서·감사 도구만 바꾼 변경은 2번만
해당):

1. 실행한 코드 SHA, 환경, pass/fail/skip과 한계는 `docs/design/<주제>-<날짜>.md`
   보고서에 쓴다. 그 보고서를 [문서 허브](README.md)의 "Maintained evidence and
   completed records" 목록 맨 위에 추가한다.
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
