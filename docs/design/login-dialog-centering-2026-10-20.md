# 짧은 화면에서 로그인 창 가운데 정렬 (2026-10-20)

- Status: 8.11.27 UI 수정·검증·배포 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 오너 지적(2026-10-20). 휴대폰 가로 화면에서 화면 높이가 일정 이하가 되면 로그인 창이 작아지면서
  화면 가운데가 아니라 위쪽에 붙어 보였다.
- 커밋: `33aec563`(수정)와 릴리스 식별자 `ec8e1ea5`(8.11.27 / v736).

## 원인

`css/style.css`의 `@media (max-height: 480px)`가 계정 창(`.account-dialog-overlay`)과 관리자 권한 창
(`.administrator-permissions-overlay`)에 `align-items: flex-start`를 줘서, 높이 480px 이하에서는 창이 위에서
12px 자리에 붙었다. 이 규칙은 계정 기능을 처음 넣을 때(2026-07-20, `c8aa1139`) 함께 들어왔고 이유는 남아 있지
않다. 다른 대화상자(공통 `.dialog-overlay`, 단계형 대화상자)는 같은 높이에서도 가운데다. 오너가 말한 "작아지는"
변화는 350px 이하의 여백 압축 규칙이고, 이번에 바꾸지 않았다.

## 변경

두 창의 짧은 화면 규칙에서 `align-items: flex-start`만 뺐다. 두 오버레이는 공통 `.dialog-overlay` 클래스를
함께 쓰므로 그 가운데 정렬(`align-items: center`)을 따른다. 짧은 화면의 여백(`padding-block: 12px`)과 창
최대 높이(화면 높이 − 24px)는 그대로다. 창 내용은 창 안에서 스크롤되므로 가운데로 두어도 창 위쪽이 화면 밖으로
밀리지 않는다. 로그인 창에는 입력칸이 없어 키보드가 올라오는 경우도 없다. 관리자 권한 창은 오너가 지적하지
않았지만 같은 규칙을 공유하고 같은 구조(최대 높이 + 내부 스크롤)라 함께 맞췄다.

## 검증

- e2e 빌드에서 임시 Playwright 측정(커밋하지 않음, 근거는 `scratch/login-dialog-centering-2026-10-20/`)으로
  ko-KR 로그인 전 창과 로그인한 계정 창을 10가지 화면 크기에서 쟀다. 로그인 전 창의 위/아래 여백(px):

  | 화면 | 수정 전 | 수정 후 |
  | --- | --- | --- |
  | 568×320 | 12 / 48.6 | 30.3 / 30.3 |
  | 640×360 | 12 / 38.6 | 25.3 / 25.3 |
  | 667×375 | 12 / 53.6 | 32.8 / 32.8 |
  | 740×360 | 12 / 38.6 | 25.3 / 25.3 |
  | 844×390 | 12 / 68.6 | 40.3 / 40.3 |
  | 915×412 | 12 / 90.6 | 51.3 / 51.3 |
  | 932×430 | 12 / 108.6 | 60.3 / 60.3 |
  | 1280×470 | 12 / 148.6 | 80.3 / 80.3 |

  창 높이는 모든 경우 전후가 같다. 로그인한 계정 창은 짧은 화면에서 이미 최대 높이(위아래 12px)라 그대로이고,
  1280×470만 12 / 46에서 29 / 29가 됐다. 1024×600과 세로 390×844는 원래 가운데라 변화가 없다.
- 단위: `account.test.ts`에 짧은 화면 규칙이 정렬을 바꾸지 않고 두 오버레이가 공통 `.dialog-overlay`의 가운데
  정렬을 쓰는지 확인하는 검사를 더했다. 수정 전 CSS에서는 실패하고 수정 후 통과한다(계정 테스트 80개 통과).
- 로컬 Windows, Node 24.20.0, 릴리스 식별자 커밋 `ec8e1ea5`: `npm run typecheck`·린트·포맷·committed
  `build:checked` 통과, unit 597 files / 13,439 pass / 0 fail / 0 skip(새 계약 테스트 1개 추가), 소스 가드
  bus-pairing·dead-exports·import-graph·sw-cache-version·brand-capitalization 통과. 로컬 결과는 exact-main CI
  후보를 대신하지 않는다.

## Release and recovery

- PR [#418](https://github.com/hiefny/MUSIXQUARE/pull/418) squash merge → main `eaf8734e`. PR head `c4e58547`의 CI 39321172162
  11 jobs 통과, Codex 리뷰 지적 없음. main 트리는 PR head와 같다.
- Exact-main push CI [39322160701](https://github.com/hiefny/MUSIXQUARE/actions/runs/39322160701) 11 jobs 통과: unit 597 files /
  13,438 pass / 0 fail / 1 Windows-only skip, candidate browser 17 + critical browser 55 pass. 후보 artifact
  12221465363.
- [Production Release 39322968235](https://github.com/hiefny/MUSIXQUARE/actions/runs/39322968235) attempt 1 성공, target=app,
  Developer API D1=false. 2026-10-20 05:55:20 KST deploy job 완료. App version
  `87ff6e7e-d3db-4f2f-92ce-9517f98ca036` / deployment `c77b5867-8587-4acf-b927-cecdaad61d82`, 최종 소유권
  05:55:13.137 KST verified, 부분 릴리스 recheck compatible, smoke 4/4, 기존 App D1 계약 7단계 apply/verify
  성공.
- 05:55 KST 공개 8 GET 모두 HTTP 200, exact-main 후보와 크기·SHA 일치(서비스 워커 v736, main CSS는 빠진
  선언만큼 23 B 감소). 05:56 KST 595×320 창의 운영 페이지가 `cache=v736`을 싣고, 짧은 화면 규칙이 적용된 채
  계정·관리자 권한 오버레이가 `align-items: center`, 여백 12px임을 확인했다. 배포 직후 Drift Audit 39323382831:
  31 pass / 0 fail / 5 manual-only.
- 복구: 05:53:59.099 KST checkpoint 12220362286이 App 8.11.26/v735(`4f79e356`, version `d96321c5` /
  deployment `e764cc90`)를 보존한다. provenance는 verified-release-ancestor다. 롤백은 미실행이다. 롤백하면
  새로고침한 클라이언트는 짧은 화면에서 두 창이 다시 위쪽에 붙고, 저장 데이터 마이그레이션은 없다.

## 한계

관리자 권한 창은 화면에서 재지 않았다(같은 규칙·구조라 코드로만 확인). 실기 휴대폰, 특히 iOS Safari에서
주소창이 접히고 펴질 때의 높이 변화는 확인하지 않았다.
