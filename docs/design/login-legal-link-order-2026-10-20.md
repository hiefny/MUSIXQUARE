# 로그인 창의 개인정보처리방침·약관 순서 (2026-10-20)

- Status: 8.11.26 UI 수정·검증·배포 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 오너 지적(2026-10-20). Google OAuth 브랜딩에 개인정보처리방침·서비스 약관 링크를 넣은 뒤, 구글
  계정 선택 화면은 "개인정보처리방침 및 서비스 약관"과 아래 "개인정보처리방침 · 약관" 순서인데 MUSIXQUARE
  로그인 창은 "이용약관 · 개인정보 처리방침"으로 반대였다.
- 커밋: `6073826f`(수정)와 릴리스 식별자 `4ce9fb5b`(8.11.26 / v735).

## 변경

`index.html`의 로그인 창 `#account-legal-links`에서 두 링크의 순서만 바꿨다. 이제 개인정보처리방침, 약관
순서다. 링크 주소·문구(`account.privacy`, `account.terms`)·스타일은 그대로다. 표시 순서는 마크업 순서를
따른다(CSS는 일반 가로 flex로, `order`나 역방향 배치가 없다). RTL 언어에서는 평소처럼 좌우가 뒤집혀 보인다.
앱 도움말 안내 문구와 개발자·번역·FAQ 페이지의 링크 묶음은 이미 개인정보처리방침이 먼저였다.

## 검증

- 마크업 계약 테스트(`app-ux-contract`)에 로그인 링크 순서가 `/privacy`, `/terms`인지 확인하는 검사를
  더했다. 수정 전 마크업에서는 실패하고 수정 후 통과한다.
- 로그인 창의 포커스 순환 테스트(`account`)는 마지막 링크가 약관이 된 순서에 맞췄다. 검사 의도(첫 컨트롤과
  마지막 컨트롤 사이에서 Tab/Shift+Tab이 돌아감)는 같다.

- 로컬 Windows, Node 24.20.0, 릴리스 식별자 커밋 `4ce9fb5b`: `npm run typecheck`·린트·포맷·committed
  `build:checked` 통과, unit 597 files / 13,438 pass / 0 fail / 0 skip(새 계약 테스트 1개 추가), 소스 가드
  bus-pairing·dead-exports·import-graph 통과. 로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## Release and recovery

- PR [#416](https://github.com/hiefny/MUSIXQUARE/pull/416) squash merge → main `4f79e356`. PR head `7b666a69`의 CI
  39314367407 11 jobs 통과, Codex 리뷰 지적 없음. main 트리와 PR head의 차이는 먼저 머지된 #415의 기록 문서뿐이다.
- Exact-main push CI [39315401908](https://github.com/hiefny/MUSIXQUARE/actions/runs/39315401908) 11 jobs 통과: unit 597 files /
  13,437 pass / 0 fail / 1 Windows-only skip, candidate browser 17 + critical browser 55 pass. 후보 artifact
  12218445374.
- [Production Release 39316497230](https://github.com/hiefny/MUSIXQUARE/actions/runs/39316497230) attempt 1 성공, target=app,
  Developer API D1=false. 2026-10-20 05:08:28 KST deploy job 완료. App version
  `d96321c5-8289-40ed-b369-3fe8d0f80e4a` / deployment `e764cc90-dee6-4b1d-82de-ea1b49ecc8d3`, 최종 소유권
  05:08:23.851 KST verified, 부분 릴리스 recheck compatible, smoke 4/4, 기존 App D1 계약 7단계 apply/verify
  성공.
- 05:08 KST 공개 8 GET 모두 HTTP 200, exact-main 후보와 크기·SHA 일치(서비스 워커 v735). 05:10 KST 운영
  페이지가 `cache=v735`를 싣고 로그인 창 링크가 `/privacy`, `/terms` 순서임을 페이지와 네트워크 응답 양쪽에서
  확인했다. 배포 직후 Drift Audit 39316842275: 31 pass / 0 fail / 5 manual-only, App secret 이름 18개 일치.
- 복구: 05:07:12.154 KST checkpoint 12219075250이 배포 직전 App(04:12 KST 대시보드 배포, version
  `b68188c9` / deployment `e47a4c9e`)을 보존한다. 오너 보고로는 8.11.25에서 `YOUTUBE_API_KEY`만 교체한
  version이지만, script ETag가 달라 코드 바이트를 8.11.25 후보와 대조하지 못했다. 그 배포 메시지에 `git:` SHA가
  없어 provenance가 `unverified`라, 실패했다면 자동 복구는 후보를 유지(forward repair)했을 것이다. 롤백은
  미실행이다. 그 version으로 수동 복구했을 때 링크 순서 말고 무엇이 달라지는지는 검증하지 않았다. 이번 릴리스에
  저장 데이터 마이그레이션은 없다.

## 한계

화면 캡처는 하지 않았다. 순서는 마크업 테스트로 고정했고, 배포 뒤 운영 페이지의 DOM과 네트워크 응답으로
확인했다(위 Release and recovery).
