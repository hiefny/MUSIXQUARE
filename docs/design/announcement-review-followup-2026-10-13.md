# 공지 외부 리뷰 후속 수정 — 2026-10-13

## 범위와 판단

- 기준 main: `78629d0d76acf9287d9c1bfb0f74050f8968a41d`.
- 수정 코드: `8d93f26986fa906c2e7aa310cf9832a887fb2dfc`.
- 릴리스: App `8.10.6`, SW cache `v667`. 배포 대상은 App Worker만이며,
  Developer API D1 application은 false다. PRO/Signaling/Remote Share/Developer API
  런타임·새 의존성·스키마·바인딩·비밀·프로토콜 변경은 없다.
- 소유자가 외부 리뷰 재검증 후 필요한 수정과 배포를 승인했다. 배포 후 이 작업과
  기록 PR이 모두 완료되면 main과 진행 중인 의존성 봇 브랜치를 제외하고 정리한다.

외부 리뷰를 그대로 결함 목록으로 채택하지 않고 현재 소스와 재현을 확인했다.
과거 `a0ec448c`/`89db0184`의 40ms seek 허용치, consumed ENDED 억제, hold 중
seek/skip, lazy recorder/send port 변경은 유지한다. 이미 seek하는 경우 작은 출력
부족분을 함께 보정하자는 제안은 이번 공지 수정에 포함하지 않는다.

## 수정 및 재현

1. **방장의 `/clear`가 서비스 공지를 지움.** 수정 전 회귀에서 서비스 배너가 숨겨졌다.
   `clearRoomPinnedNotice`로 방 공지만 삭제한다. 서비스 ID 소유권을 기준으로 하므로
   닉네임이 MUSIXQUARE인 사람의 공지는 여전히 지워진다. 열려 있는 서비스 전체보기는
   유지하고, 사용자의 닫기·해당 서비스 ID의 철회는 기존대로 동작한다. seen ID를
   초기화해 중복 알림·효과음을 만드는 우회는 하지 않는다.
2. **닫기 hit-area와 본문 첫 줄 겹침.** 수정 전 390px Chromium에서 본문 오른쪽
   374px, 닫기 영역 시작 354px로 20px가 겹쳤다. 페이지 방향을 따르는 부모 버튼의
   끝 여백을 확보한다. 본문은 `dir=auto`이므로 본문 자체의 논리 여백을 바꾸지 않는다.
   페이지 LTR/RTL × 영어/아랍어 네 조합에서 영역 분리, 전체보기, 닫기를 검사한다.
3. **관리자 초안의 자동 유실.** pageshow, 점검 해제, 점검 정상화 확인 후 자동 조회가
   dirty 초안을 덮는 세 경우를 수정 전 재현했다. 자동 조회는 초안과 원래 revision을
   유지한다. 수동 Refresh는 폐기를 확인하고, 승인한 당시 초안만 교체한다. 확인 후
   상태 조회/공지 GET 중 새로 입력한 내용은 유지한다. null revision 초안을 보존하는
   것이 저장 가능한 복구를 뜻하지는 않는다. 서버 기준 revision을 모르면 저장은
   계속 막으며, 확인 후 서버 원본을 다시 읽어야 한다. CAS·409 충돌 정책은 유지한다.
4. **legacy 동일 공지 재요청의 비멱등성.** `a × 279 + 공백 + b`를 세 번 보내면
   Worker 절단 후 공백과 DO 재trim 값이 달라 revision/history가 1→2→3으로 증가했다.
   Worker도 절단 후 trim하여 실제 저장값과 비교한다. 같은 요청 세 번에 revision,
   공지 ID, history가 유지되는 회귀를 추가했다. 기존 280자 절단 정책은 유지한다.
5. **플라이트 레코더 빌드 식별.** canonical package version과 SW cache epoch를
   Vite 상수로 주입하고 내보내기 헤더에 기록한다. 현재 실행 중인 JS의 식별자이며
   활성/대기 서비스 워커를 조회한 값이 아님을 명시한다. 추가 요청·저장·개인정보
   수집은 없다. 빌드 상수가 없는 테스트 환경은 unknown으로 표시한다.

DST gap 시각 거부는 존재하지 않는 시각의 묵시적 보정을 막는 정상 검증이다.
스크롤바 inset, `.catch`, inline position은 현재 사용자 기능 결함의 근거가 없어
변경하지 않았다. 별도 에이전트 2개의 교차 리뷰에서 추가 런타임 결함은 없었다.
한 리뷰가 지적한 브라우저 회귀의 조기 통과 가능성은 게스트의 채팅 sentinel 삭제를
기다린 뒤 서비스 배너를 검사하도록 보강했다.

## 검증

Windows, Node `24.13.1`에서 검사했다. CI는 저장소 고정 Node 버전을 사용한다.
테스트는 운영 공지나 점검 값을 변경하지 않으며 실제 휴대폰/스크린리더 검사와 다르다.

- 수정 전 실패: `/clear` 1건, hit-area 1건, 관리자 자동 갱신 3건 및 수동 갱신
  경계 4건, legacy trim 재시도 1건.
- 관리자 집중 검사 4파일 94 pass; App Worker 278 pass; recorder/config 58 pass.
- Chromium `critical-browser.test.ts` 9 pass. 게스트 수신 대기를 보강한 최종
  `/clear` 시나리오도 별도 1 pass로 확인했다.
- 전체 unit: 558파일, **12,576 pass / 0 fail / 0 skip**. 로컬 jq를 명시해 관련
  검사도 실행했다. 수정 이후 검증 중 발견한 관리자 옵션의 exact-optional 타입
  오류를 고쳤으며 최종 타입 검사를 다시 통과했다(실행 로직 변경 없음).
- 전체 `typecheck`, `lint`, `format:check`, App Worker 구문 및 Developer API/D1/
  운영 계약 guard 통과. committed `8d93f269`의 `build:checked` 통과.
- production recorder chunk에서 `Client build: app=8.10.6 | cacheEpoch=v667`을
  확인했다. E2E hook 없음, 초기 전송 예산과 5% 여유 유지, SW app-shell 94개 검증.

로컬/PR 검사는 exact-main CI 후보를 대신하지 않는다. main 병합 후 그 SHA의
성공 후보로 `Production Release(target=app, apply_developer_api_d1=false)`를 실행한다.
부분 배포의 미선택 Worker 호환성·불변 복구 checkpoint·운영 smoke·배포 소유권을
검증한다. 배포 중 점검 OFF를 유지하고 새 공지를 게시하지 않는다.

## 실기기 및 복구 한계

- 운영 일반방/PRO에서 호스트 `/clear` 후 서비스 공지 유지, 5분/foreground 철회,
  iPhone/Android 읽기·닫기·스크린리더는 release-record §2에 계속 남긴다.
- 레코더 식별자가 추가되어도 구 클라이언트는 새 코드 적용 전 헤더가 없다. 혼합
  버전이 사라졌거나 음향 동기화가 실기기에서 입증됐다는 뜻이 아니다.
- 기존 App `08df0606`으로 검증된 절차에 따라 복구할 수 있으나 이 문서의 공지·초안
  결함과 헤더 식별 공백이 돌아온다. 신규 migration/rollback SQL은 필요 없다.

## 완료 기록

- PR [#314](https://github.com/hiefny/MUSIXQUARE/pull/314), head `88dfbaaa`,
  [PR CI 38318757632](https://github.com/hiefny/MUSIXQUARE/actions/runs/38318757632)
  11 jobs 성공. 독립 리뷰와 GitHub Codex 자동 리뷰에서 추가 런타임 지적 없음.
- main `f0ea308b06cfe76953ca96a2d604a3c826ab50c5`,
  [exact-main CI 38319346829](https://github.com/hiefny/MUSIXQUARE/actions/runs/38319346829)
  attempt 1의 11 jobs 성공. PR/main 각각 unit 558파일, 12,575 pass / 0 fail /
  1 skip(Windows 전용 CLI 경로는 로컬 통과), production browser 17 + critical
  browser 24 pass, broad/critical/Worker/release-tooling coverage 4종 통과.
- [Release 38319913652](https://github.com/hiefny/MUSIXQUARE/actions/runs/38319913652),
  attempt 1, target app, Developer API D1 false. 2026-10-13 **08:03:44 KST 성공**.
  dispatch 직전 원격 main SHA와 성공 후보를 다시 대조했다.
- App version `2b4d2b20-bf09-46b3-a60a-8aafb4765da8`, deployment
  `d0754fbd-b17d-4658-9f3c-83612374aee3`, 단일 version **100%**.
  final-verification-report는 08:03:37.362 KST verified이고 production-committed
  marker는 동일 SHA/target=app이다.
- App generation, anonymous account boundary, PRO public boundary,
  Standard HTTPS signaling fallback 운영 smoke **4종 성공**. 다른 6종 smoke는
  미선택 Worker scope로 실행하지 않았다. App/admin/auth 기존 기준선은 멱등 적용.
- 공개 `/`와 `/service-worker.js` HTTP 200 및 v667 확인. 공지 HTTP 200,
  `enabled:false, revision:8` 유지. 점검 OFF. 운영 공지·점검 값을 변경하지 않았다.
- [Drift Audit 38320203496](https://github.com/hiefny/MUSIXQUARE/actions/runs/38320203496),
  source f0ea308b, 08:05:11 KST 성공. report.json(08:04:55.999)의 자동검사
  **31 pass / 0 fail / 5 manual-only**. 수동 항목은 완료로 처리하지 않았다.
- 실패 복구는 필요 없어 skip. 불변 checkpoint의 App before version은
  `9fbfe1e2-4179-4981-961a-622dbbc66ff3`, deployment
  `2748e487-a6d7-491c-9d55-667f04f52cca`, git `08df0606`.
  배포 전 artifact와 최종 artifact의 app-before.json SHA-256은 모두
  `83ec0b036ef7db4344351119bcf7971f1ab4858d2fac85370e42923215d5a58c`로 일치했다.

미선택 Worker 5종은 모두 git `08df0606`이며 배포 전 사전검사 및 App mutation 직전
재검증에서 compatible이었다. 수정 범위에 맞춰 App만 배포했다.

| Worker | 유지한 version | 유지한 deployment |
| --- | --- | --- |
| PRO | `a3f34507-2e66-445d-b9d5-847ab68ba979` | `ef1cd595-f9a1-4ab7-b084-56e441afaaf1` |
| Remote Share | `33007f96-4fa4-4e85-8e77-866a433bc6ba` | `7963ec0d-b3ac-46f2-8906-e8138c2b6e26` |
| Signaling | `abfebf5b-27a6-416e-bf29-abb54b03431e` | `d205704e-f1f5-42d2-8621-45ad4053cfe7` |
| Developer API facade | `4ac20f8b-0806-4f97-8bdd-0cbe02dc8b6a` | `deb8f91c-3aea-4ff0-b473-d3b27edcaf7a` |
| Developer API | `6ea4cd0f-9cf2-4fa2-959e-a7b6f5d82d1b` | `81e30396-f1c8-4709-acdc-3f6c749df12e` |

배포 후 문서 PR은 §1/Last source review를 덮어쓰고 history에 이 실행의 행을
정확히 하나 추가한다. 기록 PR만으로 추가 production release를 실행하지 않는다.
