# 릴리스 기록 (현재 상태)

| Field              | Value |
| ------------------ | ----- |
| Status             | Runbook — 현재 릴리스 상태. 프로덕션 배포·롤백마다 §1을 덮어쓰고, 열린 항목이 바뀌면 §2를 고친다 |
| Applies to         | 프로덕션 App·Worker 6종의 현재 배포 상태, 열린 확인 항목, 릴리스·QA 때 지킬 기준 |
| Last source review | 2026-10-11 (main `1748588e`, 배포 SHA `6e59d96c`) |
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
| App 버전 / SW 캐시 | `8.8.0` / `v646` |
| 마지막 프로덕션 변경 | 2026-10-10 19:33 KST, [Release 38045004901](https://github.com/hiefny/MUSIXQUARE/actions/runs/38045004901) attempt 1 성공, `target=all`, Developer API D1 `false` |
| 배포 main SHA | `6e59d96c14ff78de8cff476b074250428007265e` ([PR #281](https://github.com/hiefny/MUSIXQUARE/pull/281), exact-main [CI 38044634408](https://github.com/hiefny/MUSIXQUARE/actions/runs/38044634408) attempt 1) |
| Worker | 6종(app, pro-room, signaling, remote-share, developer-api, developer-api-facade) 모두 `6e59d96c`, version 100%. 운영 smoke 10개, 최종 소유권, PRO ready, coherent marker 확인 |
| 복구 | 필요 없음. Release 38045004901의 recovery job(`Preserve failed-release recovery boundary`)은 skip됐다. recovery는 별도 workflow 실행이 아니라 Production Release 실행 안의 job으로 돈다 |
| 활성 복구 floor | PRO/App 선택형 입장 암호. `cloudflare/pro-room-entry-policy-contract-version.txt` = `pro-room-optional-entry-password-v1`. 이 계약 이전의 PRO/App 기준선으로는 복구하지 않는다. forward repair나 검증된 같은 시점 코드·데이터 복구를 쓰고, 계약을 아는 기준선으로의 일반 rollback은 가능하다 (§4) |
| 검증 범위 | 로컬 unit 531파일 11,075 pass(전체 실행 뒤 영향 파일 결과를 치환한 집계). exact-main CI 11,074 pass / 기존 1 skip, coverage 4종, candidate 17, critical 22. 로컬 Chromium 26, iPhone WebKit 19. 브라우저 검증은 합성 API fixture로만 했고, 운영 보호방 `000001` bootstrap은 읽기 전용으로만 대조했다. 실제 고객방 변경과 실기는 §2에 남아 있다. [상세](design/pro-optional-entry-password-2026-10-10.md) |
| Operations Drift Audit | active, 매일 03:37 UTC. 최근 [38043680696](https://github.com/hiefny/MUSIXQUARE/actions/runs/38043680696) (2026-10-10, 8.8.0 배포 전 `6ec501c1`) 31 pass / 0 fail / 5 manual |
| Full E2E | 매주 월 18:17 UTC. main ref 마지막 실행 [37595231001](https://github.com/hiefny/MUSIXQUARE/actions/runs/37595231001) (`61cedbc6`, 2026-10-07 수동). 그 뒤의 37602041553은 `agent/full-verification-8.7.2` 브랜치 실행(`716c37af`, PR #251로 main 병합)이다. 8.7.3 이후 배포 SHA로 돈 Full E2E는 없다 |
| 의존성 | 2026-10-10 기준 `npm audit` 0건, Dependabot alert 0건, sharp 0.35.5. Dependabot [PR #201](https://github.com/hiefny/MUSIXQUARE/pull/201)이 2026-09-13부터 열려 있다 (TypeScript 7, @types/node 26, vite 8.3, wrangler 4.131). TypeScript 7.0.2가 typescript-eslint 8.70.0의 peer 범위(`<6.1.0`) 밖이라 `npm ci`가 ERESOLVE로 실패하고, 그래서 필수 체크가 전부 실패한다. rebase로는 해결되지 않는다 |

## 2. 열린 확인 항목

해결하면 근거(커밋, 실행 ID, 문서)를 PR 설명에 적고 이 목록에서 지운다. 근거
없이 완료로 표시하지 않는다.

### 실기기 확인

사용자의 실제 기기가 필요하다. 브라우저 자동화 결과로 대신하지 않는다.

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

- [ ] Drift Audit 수동 5항목: Worker zone routes, `/admin` Access+MFA, WAF rate
  limit과 Worker/R2/D1 비용 알림, 두 번째 Git 배포 경로가 없음, main review·필수
  체크 정책. 자동 감사가 통과해도 이 항목은 완료가 아니다.
- [ ] Daybreak 심층 보안 재실행 5건: R17-C01(QA073·QA075), QA094, QA109, QA086,
  QA032. 계정 보안(FIDO2) 요구로 실행하지 못했다. 대신 있는 로컬 근거: 일반 모드
  `44ef6a78` (43 pass), API key 수명 `2a6e4812` (8 pass, queue-mode·queue-add만;
  media reserve/finish 동적 조합은 미실행), QA032 로컬 수신 경로 `fa33c660`
  (434 pass; binary codec, 실제 WebRTC, live는 범위 밖).
  [상세](design/beta-30-round-repair-2026-10-09.md#daybreak-보안-심화-재시도--2026-10-09)
- [ ] 8.8.0 배포 뒤 첫 Drift Audit 결과 확인.
- [ ] Dependabot PR #201 검토. 메이저 업그레이드이고 typescript-eslint 호환이
  막혀 있으므로 별도 작업으로 한다.

### 후속 작업과 유지 결정

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
