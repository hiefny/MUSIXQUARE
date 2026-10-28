# PRO 영수증 후속 열차 A: 끝난 삭제와 끝난 예약의 영수증 놓기 (2026-10-28)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 배포됨. [PR #512](https://github.com/hiefny/MUSIXQUARE/pull/512) head `b0530a8f`를 2026-10-28 21:53 KST에 squash `7824d301`로 머지했고, exact-main CI 40691518768 뒤 [Release 40692809244](https://github.com/hiefny/MUSIXQUARE/actions/runs/40692809244)로 22:03 KST에 PRO 방 Worker만 배포했다(QA 라운드 3). 남은 것은 게이트가 아닌 배포 뒤 확인이다(release-record §2)                                                                                                                           |
| Base               | `origin/main` `2bed0a50`(9.0.19 / v792 배포 기록 #511, 문서만). 그 아래 `1a99fe49`가 UI 묶음 9.0.19 / v792이고 2026-10-28 19:19 KST(deploy job 완료, Release 40670881163)에 App만 배포됐다. 열차 A 배포 전 운영 PRO 방 Worker는 9.0.18의 `61e60919`(message `git:53a4f397`)였다. 처음에는 `6a23c46e`(9.0.18 기록) 위에서 만들었고 라운드 2 전에 `1a99fe49`로, 라운드 2 뒤 `2bed0a50`으로 리베이스했다('증분과 시험한 SHA'). squash `7824d301`의 트리는 PR head `b0530a8f`와 같고 부모는 `2bed0a50`다 |
| Version            | App은 9.0.19 / v792 그대로다(배포 뒤 공개 `/`와 SW도 v792). 앱 SemVer, SW 캐시, 최소 앱 빌드(787)를 바꾸지 않았으므로 업데이트 창이 뜨지 않는다                                                                                                                                                                                                                                                                                                                                                      |
| Scope              | PRO 방 Worker의 브라우저 영수증 원장(RO-53): 끝난 명시적 삭제는 영수증을 남기지 않고, 예약 영수증은 asset이 예약 상태를 벗어나면 놓는다. 오너 결정 4번(BOT 재생의 24시간 울타리를 두지 않음)과 BOT Developer 변경 영수증 24시간 유지의 근거를 RO-53에 적었다(문서만)                                                                                                                                                                                                                                 |
| Deploy target      | target `pro-room`, Developer API D1 `false`, `raise_app_build_floor` `false`. 운영과 견준 런타임 경로 변경은 PRO 방 `cloudflare/pro-room-worker.ts` 하나이고 나머지 다섯 Worker는 0개다(QA 라운드 2). 릴리스 안의 부분 릴리스 판정과 PRO 방 배포 직전 다시 확인도 다섯 Worker 모두 compatible(바뀐 경로 0)이었고, PRO 방 Worker만 이 SHA의 새 버전 `a04acac1`로 배포됐다(QA 라운드 3)                                                                                                                |
| Operations         | 배포 뒤 운영에서 한 것: Release 40692809244(PRO room `a04acac1`), PRO media CORS와 PRO room smoke, 공개 GET과 최소 빌드 읽기, Operations Drift Audit 40693134645(QA 라운드 3). 운영 방의 원장 상태(일괄 삭제가 원장을 채우지 않는 모습), 실기기, 운영 PRO Worker를 9.0.18로 되돌린 상태는 확인하지 않았다(아래 '확인하지 않은 것')                                                                                                                                                                   |
| Resource ownership | [RO-53](resource-ownership-registry.md#ro-53-pro-browser-receipt-ledger)의 같은 주인(원장 메서드)을 넓혔다. 새 기계는 없고 상태는 `owner-in-place` 그대로다. `node scripts/check-resource-ownership.mts`의 개수는 바뀌지 않는다                                                                                                                                                                                                                                                                      |

## 문제

9.0.18 / v791(2026-10-27, [보고서](pro-receipt-retention-2026-10-27.md))은 PRO 방의 브라우저 영수증 원장(256개, 방의 모든
참가자가 함께 씀)에 영수증을 앱이 같은 요청을 다시 보낼 수 있는 동안만, 대부분 2분 둔다. 그래도 두 흐름은 2분 창 안에서
원장을 채울 수 있었다. 9.0.18 보고서의 '바꾸지 않은 것과 이유'와 release-record §2의 영수증 원장 항목 (3)이 이것을 오너
결정으로 남겼다.

- 파일 삭제: 파일 하나를 지우면 R2를 지우는 동안의 진행 중 영수증이 끝난 뒤 2분짜리 최종 영수증으로 바뀐다. 앱은 파일
  트랙 여러 개를 지우면 쓰이지 않게 된 asset마다 `DELETE /media/<assetId>`를 새 key로 하나씩 보낸다. 그래서 2분 안에 256개
  가까이 지우면 원장이 찬다.
- 업로드: 파일 하나가 예약 영수증(2분)과 재생목록 추가 영수증(2분)을 남긴다. 그래서 2분 안에 약 128개를 올리면 원장이
  찬다. 아주 작은 파일을 빠른 회선에서 연달아 올릴 때 닿을 수 있다.

원장이 차면 최대 2분 동안 다른 참가자의 편집, 업로드, 재생 조작이 `ROOM_STATE_CAPACITY_EXCEEDED`(409)로 거절된다. 잃는
데이터는 없다(실패한 삭제의 파일은 asset GC가 15분 뒤 지운다).

## 오너 결정

2026-10-28 아침 오너가 9.0.18이 남긴 네 결정에 모두 답했다.

- 3번: 삭제 최종 영수증을 없애고 예약 영수증을 일찍 놓는다(B+C). PRO 방 Worker만 바꾸는 이 열차 A로 낸다(target
  `pro-room`, 업데이트 창 없음).
- 4번과 BOT의 24시간 Developer 변경 영수증: 추천대로 그대로 두고 근거만 적는다. 근거는 RO-53의 BOT 문단에 있다(아래
  '4번의 근거').
- 1번(원장이 찼을 때 재생 조작 실패 안내)과 2번(재생목록 크기 한도만 기존 `PLAYLIST_CAPACITY_EXCEEDED`로 구분, 나머지는
  '잠시 후' 그대로, 원인별 진단 이유 분리): 9.0.20 UI 후속 열차(target `all`, 업데이트 창 한 번)에 싣는다. 이 열차에는
  없다.
- 순서: 9.0.19 배포 뒤, 9.0.20 앞이다. 바로 배포 원칙(2026-10-25)에 따라 자동 게이트가 통과하면 따로 묻지 않고 낸다.
  그대로 2026-10-28 22:03 KST(Release 40692809244, QA 라운드 3)에 나갔다.

## 바뀐 것

런타임 파일은 `cloudflare/pro-room-worker.ts` 하나다(런타임 커밋 `1c88cbb1`, 라운드 2에서 시험한 리베이스 전 `7530c698`).

1. **원장 메서드 `releaseIdempotencyRecord(scope, key)`.** 그 key의 영수증을 원장에서 지우고 지웠는지를 돌려준다. RO-53은
   원장 메서드를 유일한 주인으로 두므로 삭제 흐름이 원장 레코드를 직접 지우지 않고 이 메서드를 부른다.
2. **삭제를 마치는 커밋은 최종 영수증을 쓰지 않는다.** `continueAssetDeletion`의 마무리 커밋(할당량 반환, staging
   tombstone, asset 행 삭제, revision 올림)이 `storeIdempotency` 대신 `releaseIdempotencyRecord`로 진행 중 영수증을 놓는다.
   응답 본문은 그대로 만들어 돌려준다. asset ID는 다시 쓰이지 않고 asset 행과 할당량이 같은 커밋에서 사라지므로, 영수증
   없이도 삭제는 한 번만 적용된다. 이 커밋은 원장 자리를 잡지 않으므로 원장이 차 있어도 실패하지 않는다. 커밋이 실패하면
   지금처럼 `restoreInMemoryState`가 진행 중 영수증까지 메모리에 되돌린다.
3. **예약 영수증의 이른 해제 `releaseSettledReserveReceipts()`.** `participant:<id>:reserve:<key>` 영수증 가운데 저장된
   응답의 `reservation.assetId`가 가리키는 asset이 없거나, `reserved`가 아니거나, 삭제 표지가 있으면 지운다. `kind`가 있는
   영수증과 응답에서 assetId를 읽을 수 없는 영수증은 건드리지 않고 만료를 기다린다(완료 해제와 같은 규칙). Developer
   예약은 `developer:` 원장에 있어 대상이 아니다. 완료 해제 메서드를 넓히지 않은 이유: 그 판정은 이름 없는 `ready` asset만
   남기므로 예약 영수증에 쓰면 `reserved`인 동안의 같은 key 재생까지 사라진다.
4. **부르는 곳.** `reconcileAssetGarbageCollection`이 완료 해제와 예약 해제를 모두 부르고, 둘 중 하나라도 지웠으면 `true`를
   돌려준다(prune은 이 값으로 저장을 정한다). 부르는 곳은 그대로다: 브라우저 재생목록 커밋, 전환, 옮기기·복사, 업로드 완료,
   모든 요청 앞의 prune과 alarm, Developer 경로. 업로드 완료는 asset을 `ready`로 바꾼 뒤 조정을 부르고 그다음 완료
   영수증을 쓰므로, 예약 영수증은 완료 커밋 안에서 풀리고 완료 영수증이 그 자리를 쓴다. 업로드 실패 정리로 지운 예약과
   만료된 예약의 영수증은 다음 요청의 prune에서 풀린다.
5. **주석.** 진행 중 영수증 설명, 마무리 커밋, `browserReceiptLifetimeMs`, 원장 한도(9.0.17과 9.0.18 Worker가 256을 넘는
   방을 불러오지 못함)를 고쳤다.

바꾸지 않은 것: `beginAssetDeletion`은 진행 중 영수증 자리를 지금처럼 잡는다. 그래서 다른 영수증으로 원장이 차 있으면
삭제는 지금처럼 409다. `storeIdempotency`, 영수증 모양과 `kind`, 응답 모양, 원장 한도 256, 불러오기 정규화
(`normalizeLoadedAssetDeletions`), 시간 집 `cloudflare/pro-room-receipt-timing.ts`(App 런타임 경로이기도 해서 바꾸면
target이 `all`이 된다)도 그대로다.

결과: R2 삭제가 성공하면 삭제는 원장을 채우지 않는다(R2를 지우는 동안의 진행 중 영수증 하나뿐이다). 업로드는 파일
하나에 2분짜리 영수증 하나(재생목록 추가)만 남기므로 2분에 약 256개까지 받는다.

## 바뀌는 답

앱이 보내지 않는 같은 key 재전송의 답만 바뀐다.

| 요청                                                                                          | 9.0.18                                                        | 열차 A 뒤                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 삭제가 커밋된 뒤 같은 key, 같은 asset                                                         | 2분 동안 200 재생, 그 뒤 404                                  | 바로 404 `ASSET_NOT_FOUND`. 할당량과 revision은 그대로                                          |
| 삭제가 커밋된 뒤 같은 key, 다른 asset                                                         | 2분 동안 409 `IDEMPOTENCY_CONFLICT`                           | 그 asset의 보통 삭제(권한과 참조 검사는 그대로)                                                 |
| 마무리 커밋이 실패한 뒤 같은 isolate의 같은 key 재시도(되돌린 표지의 재시도 시각이 이미 지남) | 재시도 앞의 prune이 삭제를 마치고 최종 영수증을 써서 200 재생 | 그 prune이 삭제를 마치고 영수증을 놓아 404 `ASSET_NOT_FOUND`. asset, 영수증, 할당량은 같은 결과 |
| asset이 `reserved`를 벗어난 뒤 같은 key 예약                                                  | 2분 동안 첫 응답 재생, 본문이 다르면 409                      | 새 예약. 쓰이지 않으면 예약 만료(15분) 뒤 정리                                                  |
| 삭제 진행 중(R2 삭제 전후) 같은 key                                                           | 표지와 진행 중 영수증이 막음                                  | 그대로                                                                                          |

앱이 보내는 것: 예약과 삭제마다 새 key를 만들고(`src/pro-room/media-transfer.ts`, `src/pro-room/playlist-state-manager.ts`의
`#bestEffortDelete`), 요청을 한 번만 보내며(`src/pro-room/api.ts`), 삭제 실패는 기록만 남긴다. 2026-10-28에 운영 최소 빌드
787의 릴리스 커밋 `dd9c9d4d`(9.0.14)와 이 브랜치에서 다시 읽었고 그 사이 바뀐 것은 이 전제를 건드리지 않는다(9.0.17의
업로드 완료 재시도는 완료 key만 다시 쓴다). App Worker의 PRO API 전달도 요청 하나를 한 번 보낸다. 그래서 운영에 있을 수
있는 App(9.0.14 이상)은 위 표의 바뀐 답을 받지 않는다.

## 4번의 근거

오너 결정 4번(BOT 재생 명령에 24시간 울타리를 두지 않음)과 BOT의 24시간 Developer 변경 영수증 유지의 근거는 RO-53의 BOT
문단(커밋 `e7a4f572`, 리베이스 전 `5c65dacf`)에 있다. 같은 `requestId`를 다시 보내는 곳이 없다. 채팅은 메시지마다
새 `requestId`를 만들고 (`src/ui/chat.ts`의 `createProRoomIdempotencyKey()`, 1220~1223행), App Worker는 컨텍스트와 실행을 한 번씩만 부른다
(`cloudflare/pro-bot.ts` 2212~2221행, 2284~2293행). 일부러 다시 보내도 새 `requestId`와 같은 권한 검사와 같은 BOT 한도
(멤버마다 분당 3회, 방마다 시간당 100회)를 받으므로 울타리가 더 막는 것이 없다. 울타리를 두면 BOT 추가와 공개 API가 함께
쓰는 Developer 변경 원장을 쓴다. 이 근거로 release-record §2 영수증 원장 항목의 (4)를 닫았다.

## 테스트 먼저 근거

테스트 커밋은 셋이다. `89fc0b74`(기존 테스트 다섯을 바꾸고 새 테스트 넷과 자르기 테스트의 기대를 더함), `7d57a01b`(같은
isolate 재시도 테스트를 표지 경로로 마치게 바꿈, 구현 점검이 찾음), `f8f2b453`(그 형제 테스트: 되돌린 표지를 그대로 두면 다음
요청의 prune이 삭제를 마치고 재시도는 404, 리뷰가 선택으로 제안함). 라운드 2에서 시험한 이 SHA는 `2bed0a50` 위로 리베이스한
뒤 차례로 `cd20c6a5`, `6f80edb1`, `03dd5568`이다(내용 같음, '증분과 시험한 SHA').

2026-10-28 라운드 2에서 머리의 테스트 파일을 부모 런타임(`1a99fe49`, PRO 방 Worker 파일은 `53a4f397`과 같음)에 돌렸다(추적하지
않는 임시 worktree, 끝난 뒤 지움). 제목 열둘, 경우 열셋이 실패하고 517개가 통과했다.

| 테스트                                                                                                 | 부모 런타임의 실패                                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| keeps deletion pending, blocks reuse, and retries after only one R2 key was deleted                    | alarm이 마친 뒤 원장에 최종 영수증이 있음("expected { …(4) } to be undefined")          |
| recovers an explicit deletion after R2 succeeds but the final DO commit fails                          | 복구된 커밋 뒤 저장소 원장에 최종 영수증이 있음(같은 메시지)                            |
| retries delete finalization in the same isolate after its DO commit fails                              | 재시도 뒤 메모리 원장에 최종 영수증이 있음(같은 메시지)                                 |
| lets the next prune finish a same-isolate delete retry, so the retry answers ASSET_NOT_FOUND           | 재시도가 최종 영수증의 재생 200을 받음("expected 200 to be 404")                        |
| finishes a pending delete on a full ledger and gives its slot back (가) 진행 중 영수증이 256칸 중 하나 | 마무리 뒤 원장이 255개가 아니라 256개("expected [ …(256) ] to deeply equal [ …(255) ]") |
| finishes a pending delete on a full ledger and gives its slot back (나) 불러오기 수리가 영수증을 못 둠 | 마무리 커밋이 `RoomStateCapacityError`를 던짐                                           |
| cancels a staged reservation only after its R2 object is safely deleted                                | 같은 key 재전송이 200("expected 200 to be 404")                                         |
| keeps each browser receipt only as long as its request can be sent again                               | 완료한 업로드의 예약 영수증이 남음("expected { …(4) } to be undefined")                 |
| deletes 300 files inside one window without filling the ledger                                         | 257번째 삭제가 409("delete 256: expected 409 to be 200")                                |
| uploads 200 small files inside one window without filling the ledger                                   | 129번째 파일의 예약이 409(원장 256개에서, "expected 409 to be 200")                     |
| replays a reservation while it is reserved and releases its receipt once the asset leaves reserved     | 완료 직후 예약 영수증이 남음("expected { …(4) } to be undefined")                       |
| leaves no receipt once a delete commits, so a same-key resend answers ASSET_NOT_FOUND                  | 삭제 뒤 원장에 그 key가 있음(같은 메시지)                                               |
| cuts receipts an earlier Worker kept for 24 hours to their window and persists the cut                 | 앞선 Worker가 쓴 끝난 asset의 예약 영수증이 첫 prune 뒤 남음(같은 메시지)               |

런타임 커밋 `7530c698` 위에서는 Worker 테스트 파일 530개가 모두 통과한다(라운드 2).

## 증분과 시험한 SHA

리베이스로 SHA가 두 번 바뀌었다. 라운드 2 전에 `6a23c46e`에서 `1a99fe49`로 옮겼고(내용은 같고, 형제 테스트와 이 보고서
커밋만 라운드 2에서 더함), 라운드 2 뒤 main이 9.0.19 배포 기록 `2bed0a50`(#511, 문서만)으로 나아가 그 위로 다시 옮겼다.
두 번째 리베이스에서 `git diff 91633253 13625e0a -- cloudflare src`는 비어 있고, `git range-diff`에서 코드·테스트 커밋
넷, RO-53 기록, 라운드 2 결과를 적은 문서 커밋은 같은 패치다. 그래서 런타임과 테스트는 라운드 2에서 시험한 커밋과 같고,
부분 릴리스 판정이 보는 런타임 경로도 같다. 손으로 푼 것은 문서 충돌뿐이다(`docs/release-record.md` §2 맨 위 항목 자리와
9.0.18 항목의 순서 문장). 지금 커밋은 `2bed0a50` 열이고, 시험한 커밋은 `1a99fe49` 열이다.

| 증분                         | 커밋(`2bed0a50` 위, 지금)                          | 시험한 커밋(`1a99fe49` 위) | 리베이스 전(`6a23c46e` 위) | 바꾼 파일                                             | 시험                                       |
| ---------------------------- | -------------------------------------------------- | -------------------------- | -------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| 테스트 먼저                  | `cd20c6a5`                                         | `89fc0b74`                 | `8e714781`                 | `src/pro-room/__tests__/pro-room-worker.test.ts`      | 부모 런타임에서 실패(위 표)                |
| 런타임                       | `1c88cbb1`                                         | `7530c698`                 | `16b5a2ee`                 | `cloudflare/pro-room-worker.ts`                       | 라운드 1(`16b5a2ee`), 라운드 2             |
| RO-53 기록                   | `e7a4f572`                                         | `5c65dacf`                 | `cff05dc1`                 | `docs/design/resource-ownership-registry.md`          | resource-ownership 가드(라운드 1, 2)       |
| 같은 isolate 재시도 테스트   | `6f80edb1`                                         | `7d57a01b`                 | `c3f51f2c`                 | 테스트 파일                                           | 라운드 1(`c3f51f2c`), 라운드 2             |
| prune이 마치는 재시도 테스트 | `03dd5568`                                         | `f8f2b453`                 | 없음                       | 테스트 파일                                           | 라운드 2                                   |
| 보고서와 기록                | `7539bc65`, `13625e0a`, 이 리베이스를 적은 뒤 커밋 | `4be3dfa0`, `91633253`     | 없음                       | 이 보고서, `docs/README.md`, `docs/release-record.md` | 라운드 2(문서만, 코드는 `f8f2b453`과 같음) |

## QA 라운드 1(구현 세션, 리베이스 전)

- 시험한 코드: `c3f51f2c`(런타임 `16b5a2ee`), 기반 `6a23c46e`(운영 9.0.18 기록), 로컬 Windows, Node 24.20.0.
- 통과: Worker 테스트 파일 529/529, `tsc --noEmit`, `lint`, `format:check`, `check:workers`, `check:worker-bundles`,
  `build:checked`, `node scripts/check-resource-ownership.mts`(개수 그대로). 독립 리뷰는 승인했고 선택 테스트 하나(위 형제
  테스트)를 제안했다.
- 한계: 구현 세션의 결과를 넘겨받아 적었고 수치는 옮기지 않았다. 9.0.19가 main에 들어가기 전의 기반이다. 전체 단위 실행과
  커버리지, 되돌리기 확인은 라운드 2에서 했다.

## QA 라운드 2(9.0.19 main 위, 로컬)

- 시험한 코드: 문서 커밋 `4be3dfa0`(코드와 테스트는 `f8f2b453`과 같고, 그 뒤 이 결과를 적은 문서 커밋만 뒤따름), 기반
  `1a99fe49`, 로컬 Windows, Node 24.20.0 / npm 12.0.2.
- 시작 전 확인: `git diff 6a23c46e 1a99fe49`에서 `cloudflare/pro-room-worker.ts`, Worker 테스트 파일, 등록부,
  `src/pro-room/media-transfer.ts`, `src/pro-room/playlist-state-manager.ts`, `src/pro-room/api.ts`는 바뀌지 않았다
  (`cloudflare/`에서는 App Worker의 `ADMIN_ASSET_VERSION` 한 줄뿐). 그래서 계획의 줄 번호, 새 key 전제, 되돌리기 대상이
  그대로다. 리베이스는 충돌 없이 끝났고 Worker 테스트 파일은 리베이스 직후 529/529, 형제 테스트를 더한 뒤 530/530이다.
- 통과: `tsc --noEmit`, `typecheck:tests`, `check:workers`(Worker 타입 검사 여섯, PRO 방 모듈, Developer API 경계, 선언
  소유, D1 계약, 운영 drift 계약), `lint`, `format:check`, 바꾼 문서 셋의 `prettier --check`.
- 전체 단위 실행(`--maxWorkers=4`): 688 files / 16,378 통과. main의 16,372에 이 열차의 테스트 여섯(새 테스트 넷, 형제 테스트,
  `it.each`로 둘이 된 가득 찬 원장 테스트의 한 경우)을 더한 수다.
- Worker 묶음 커버리지(`test:coverage:workers`): 68 files / 3,243 통과, 기준치 통과(전체 문장 86.64 · 분기 83.45 · 함수
  94.31 · 줄 90.91). `cloudflare/pro-room-worker.ts`는 문장 87.74 · 분기 84.07 · 함수 96.21 · 줄 91.8로, 9.0.18 라운드(문장
  87.65 · 분기 83.87 · 함수 96.2 · 줄 91.71, 68 files / 3,237)보다 넷 모두 조금 높다.
- `test:coverage:critical`: 88 files / 3,462 통과, 기준치 통과(문장 80.82 · 분기 75.56 · 함수 86.75 · 줄 84.68). 9.0.18
  라운드와 같은 파일과 테스트 수다(이 열차는 `src/` 런타임을 바꾸지 않음).
- `build:checked`: 25단계 모두 통과했다. `guard:sw-cache-version`은 'v792 (1a99fe49) covers all committed PWA runtime
  changes'로 bump 없이 통과했다. 바뀐 런타임 파일이 `cloudflare/pro-room-worker.ts`뿐이고 App 런타임 경로가 바뀌지 않았기
  때문이다. `guard:release-identity`는 9.0.19 / v792, room-authority는 직접 읽기 80 · 구독 22 · 쓰기 13, source-complexity의
  `cloudflare/pro-room-worker.ts`는 18,265 / 20,000줄이다. 초기 전송 예산 통과(entry 843.1 KiB raw / 248.1 KiB gzip, eager JS
  456.5 KiB gzip, eager 전체 2,010.4 KiB raw / 533.4 KiB gzip), SW 앱 셸 95 자산. 빌드의 진입 파일 이름(`main-661mTt5C.js`,
  `main-nTYuVNeU.css`, `bootstrap.js?cache=v792`)이 운영 9.0.19의 공개 `/`(2026-10-28 라운드 2 중 GET)와 같다.
- `check:worker-bundles`(`build:checked` 뒤): Worker 6개 dry-run 통과. PRO 방 829.23 KiB / gzip 162.29 KiB(9.0.18 배포
  827.25 / 161.89 KiB에서 +1.98 / +0.40 KiB), App 986.17 / gzip 201.36 KiB.
- 가드: dead-exports, import-graph(399 files · 2,076 edges · 순환 0), bus-pairing(202/202), lifecycle-writes,
  navigation-sinks(399 files), `node scripts/check-resource-ownership.mts`(49 records / 445 files). resource-ownership,
  import-graph, bus-pairing, room-authority의 수는 `1a99fe49`에서 같은 날 잰 값과 같다.
- Target: `scripts/release-deployment-state.mts`의 부분 릴리스 판정(`verifyPartialReleaseCompatibility`)을 target
  `pro-room`, 후보 `4be3dfa0`으로 로컬에서 돌렸다. 운영 조회 대신 기록된 운영 버전과 release message를 넣었다: App은 9.0.19
  Release 40670881163이 배포한 `5a4284d6`(`git:1a99fe49`), 나머지 다섯은 release-record §1의 9.0.18 버전(`git:53a4f397`).
  고르지 않은 다섯 Worker(remote-share, signaling, Developer API facade, Developer API, App)가 모두 `compatible`(바뀐 경로
  0개, App 의존성 변화 없음)이고, 고른 PRO 방의 `53a4f397` 대비 바뀐 런타임 경로는 `cloudflare/pro-room-worker.ts` 하나다.
  계약 표지, D1 manifest, Wrangler 설정, `package.json`과 `package-lock.json`은 main과 같다. 그래서 target `pro-room`이
  통과하고 `all`이 필요 없다.
- 되돌리기 일회 확인: 위 '9.0.18 Worker 코드로 한 번 확인'(임시 테스트 둘 통과, 임시 worktree는 지움).
- 실행하지 않은 것: 로컬 E2E(App이 그대로), 실기기, 운영 Cloudflare 조회.
- 한계: 로컬 결과는 exact-main 후보가 아니다. PR CI, 자동 코드 리뷰, exact-main CI, 릴리스 smoke는 돌리지 않았다.

## QA 라운드 3(PR CI, 자동 리뷰, exact-main CI, 배포와 공개 확인)

검증 대상은 PR head `b0530a8f`(런타임 커밋 `1c88cbb1` 뒤 테스트 커밋 둘과 문서 커밋 셋)와 그 squash 머지 `7824d301`(트리가
`b0530a8f`와 같고 부모는 `2bed0a50`)이다. 환경은 GitHub Actions(Node 24.20.0)와 운영 Cloudflare다. 시각은 KST다.

| 검사                | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #512 CI          | PR은 2026-10-28 21:44:08에 최종 head `b0530a8f`로 열렸다. 그 `pull_request` 실행 [40690273621](https://github.com/hiefny/MUSIXQUARE/actions/runs/40690273621)은 21:44:12에 생겨 attempt 1에서 11/11 success였다(21:52:43 완료). 이 PR 브랜치의 PR CI 실행은 이것 하나다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 자동 리뷰           | 요약 댓글([PR #512 자동 리뷰 요약](https://github.com/hiefny/MUSIXQUARE/pull/512#issuecomment-6469303724))은 PR을 열 때('PR opened') head `b0530a8f` 코드 리뷰가 21:45:29에 completed, `has_any_findings`와 `has_unresolved_findings`는 false, 보안 리뷰는 돌지 않음이라고 적고, 21:45:33에 지적 없음 표시(👍) 반응이 남았다. 요약 댓글은 21:44:19에 생겨 21:45:30에 마지막으로 바뀌었다. PR이 최종 head로 열렸으므로 앞선 head의 결과는 없고, 리뷰와 리뷰 댓글(줄 댓글 포함)도 없다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 머지                | 21:53:01 squash `7824d301`(트리가 `b0530a8f`와 같고 부모는 `2bed0a50`), PR CI 완료(21:52:43) 뒤다. 런타임 커밋은 `1c88cbb1` 하나이고, 그 뒤는 테스트 `6f80edb1`, `03dd5568`과 문서 `7539bc65`, `13625e0a`, `b0530a8f`뿐이다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| exact-main CI       | [40691518768](https://github.com/hiefny/MUSIXQUARE/actions/runs/40691518768) push, attempt 1, 11 jobs 모두 success(21:53:06~22:01:51). 단위 688 files / 16,377과 기존 1 skip(9.0.19의 16,371에 이 열차의 테스트 여섯), Worker 커버리지 68 files / 3,243, 핵심 커버리지 88 files / 3,462, 릴리스 도구 커버리지 14 files / 419, Critical browser gate 후보 19·critical 94(Linux Chromium), `guard:release-identity` 9.0.19 / v792, `guard:sw-cache-version` 'v792 (1a99fe49) covers all committed PWA runtime changes' PASS(bump 없이), eager JS 456.5 KiB gzip, SW 앱 셸 95 자산. 후보는 artifact 12816663860(digest sha256 `2f9ee188340091e0eef2fd5c85ac0e198eb8d33688e9f75e1ed640fda2957a04`)이고, 릴리스가 내려받아 이 digest와 릴리스 파일 808개를 확인했다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Release             | [40692809244](https://github.com/hiefny/MUSIXQUARE/actions/runs/40692809244) attempt 1 성공(22:02:10 dispatch, validate 22:02:13~22:02:22, deploy job 22:02:29~22:03:56), target `pro-room`, Developer API D1 `false`, `raise_app_build_floor` false(올리기 단계 skip). 릴리스 커밋이 아직 main 머리인지 확인(22:02:38) 통과, 계약 cutover 검사 다섯 통과, 운영 보안 설정 가드와 Worker 6개 묶음의 배포 없는 다시 확인 통과. 부분 릴리스 판정(22:03:02~22:03:08) compatible: App `5a4284d6`(`git:1a99fe49`), remote-share `1056e44d`, signaling `60343a64`, Developer API facade `f54a224b`, Developer API `51ca7da5`(넷은 `git:53a4f397`), 바뀐 경로 모두 0. 라운드 2가 기록된 값으로 로컬에서 돌린 판정과 같은 결과다. checkpoint(artifact 12817777570, 22:03:08~22:03:09)는 PRO room `61e60919`(deployment `1d5b5cab`, `git:53a4f397`)와 PRO media CORS 정책을 보존하고, Worker 호환 floor checkpoint(22:03:12)는 PRO generation·entitlement floor(`ready`, release `53a4f397`, floor release `4c5612d5`, PRO room `verified-release-ancestor`)를 담는다. PRO generation readiness 막기와 복원 단계는 target `pro-room`이라 skip. D1 계약 단계는 generic PRO grant 하나가 돌아 success(35 queries, 0 rows written), 나머지는 skip. PRO media CORS는 저장소의 같은 파일로 다시 적용했다(checkpoint의 기준과 후보가 같음). PRO 방 배포 직전 다시 확인(22:03:23~22:03:31) compatible, 운영 PRO room이 checkpoint와 같음을 확인. 배포: PRO room `61e60919` → `a04acac1`(deployment `b947d10e`, 22:03:41, 829.23 / gzip 162.29 KiB, startup 1 ms). 최종 소유권 확인 22:03:50 verified, commit 표지 artifact 12816629860, 배포 기록 artifact 12817268626. 실패 자동 복구 단계와 recovery job은 skip. |
| 릴리스 smoke        | PRO media Range CORS(22:03:21) active. PRO room(22:03:47~22:03:49, 12번 가운데 첫 시도에 새 버전 `a04acac1`을 읽음, `000000` `activation_required`, `000001` `pin_required`와 `passwordRequired` true, 익명 스냅샷 거절) success. 실패한 smoke와 재시도는 없었다. target `pro-room`이라 App, 계정 경계, Standard HTTPS signaling, remote-share, signaling, Developer API smoke는 돌지 않았다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 공개 자산·독립 확인 | 공개 GET(22:10) `/` 200 144,496 B(`bootstrap.js?cache=v792`, 진입 `main-661mTt5C.js`), `/service-worker.js` 200 38,160 B(`CACHE_VERSION = "v792"`), 둘 다 9.0.19 배포 뒤와 같은 크기다. `/api/app-build-floor`: `minAppBuild` 787, `effectiveMinAppBuild` 787, revision 1(updated 2026-10-26T07:15:03.890Z), `liveAppBuild` 792, `reportedLiveAppBuild` 792(22:09:47 보고), state `valid`. `/api/app-build-floor/effective` `{"effectiveMinAppBuild":787}`. 배포 직전 floor `status`는 돌리지 않았다(이 릴리스는 App과 바닥을 건드리지 않음).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Drift Audit         | [40693134645](https://github.com/hiefny/MUSIXQUARE/actions/runs/40693134645) attempt 1(`7824d301`, 22:04:24 dispatch, 22:04:58 완료) automated-checks-passed: 32 pass / 0 fail / 5 manual-only. App build floor 행 PASS('Stored floor 787 (enforced 787) is within the live App build 792 reported 7 s ago.'), PRO room의 비밀 이름 9개·바인딩·subdomain·custom domain 행과 PRO media R2 CORS 행 PASS. 배포 전 마지막 실행 40686792254(9.0.19 배포 뒤 dispatch, `1a99fe49`)도 32 / 0 / 5였다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SKIP                | 운영 방의 원장 상태(일괄 삭제가 원장을 채우지 않는 모습, 작은 파일 일괄 업로드, 첫 prune이 9.0.18이 남긴 끝난 asset의 예약 영수증을 놓는 모습. 운영 원장 상태는 바깥에서 읽을 수 없음), R2 장애 중의 일괄 삭제, 운영 PRO Worker를 9.0.18로 되돌린 상태, 실기기, 로컬 E2E와 열차 A 런타임의 전체 직렬 E2E(App이 그대로, 최신 정기 Full E2E [40414428421](https://github.com/hiefny/MUSIXQUARE/actions/runs/40414428421)은 `1ff7fdf2`, 곧 9.0.15 런타임에서 success), 배포 직전 floor `status`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

로컬 결과는 exact-main-SHA CI 후보를 대신하지 않았다. 배포 뒤 확인은 release-record §2의 열차 A 항목과 '운영·보안'의 영수증
원장 항목에 열려 있다.

## 되돌리기

- 대상: 열차 A 실행의 checkpoint가 잡는 직전 운영 PRO 방 Worker다. 9.0.19 Release 40670881163은 App만 배포했고(PRO 방
  기록·배포·smoke 단계 skip) 9.0.19는 PRO 방 런타임 경로를 바꾸지 않았다(`53a4f397`과 `1a99fe49`의
  `cloudflare/pro-room-worker.ts`가 같음). 그래서 직전 Worker는 9.0.18의 `61e60919-4ed5-4c36-93e6-97bd15979227`(message
  `git:53a4f39793a54fa96c2688da64bef5bbb0fcec56`, release-record §1)이다.
- 실패 자동 복구: `pro-room` 실행이 PRO 방 배포 뒤 단계(PRO 방 smoke 등)에서 실패하면 'Restore release-owned Workers after a
  failed release'가 checkpoint의 PRO 방 Worker로 되돌린다. 열차 A는 계약 표지와 forward floor를 더하지 않으므로 이 되돌림을
  막지 않는다.
- 수동 CLI 되돌리기(`docs/hotfix-procedure.md`의 CLI rollback): 직전 PRO 방 버전을 `versions deploy`로 100% 되돌린다
  (`--config cloudflare/wrangler.pro-room.toml`, message는 되돌린 이유). App은 그대로라 최소 빌드 `lower`가 필요 없다. 뒤에
  §1을 덮어쓰고 이력에 CLI rollback 한 줄을 더한다.
- 코드 되돌리기: 런타임 커밋을 되돌려 `pro-room`으로 다시 낸다. SemVer와 캐시를 올리지 않았으므로 새로 올릴 것이 없다.
  9.0.20이 이미 main에 있으면 그 위에서 고치는 앞으로 수정이 낫다.
- 9.0.18 Worker가 보는 것: 새 `kind`와 새 필드가 없고 영수증이 줄기만 하므로 그대로 불러온다(원장 256개 이하). 열차 A가
  남긴 진행 중 삭제(같은 표지와 영수증 모양)는 9.0.18의 alarm이 마치고 2분짜리 최종 영수증을 쓴다. 끝난 삭제의 같은 key
  재전송은 9.0.18에서도 404다(영수증도 asset도 없음). 일찍 놓은 예약 영수증은 9.0.18이 2분 뒤에 하던 것과 같다(같은 key
  예약이 새 예약).
- 되돌린 동안: 9.0.18의 용량으로 돌아가 일괄 삭제와 작은 파일 일괄 업로드가 다시 최대 2분 원장을 채울 수 있다. 잃는
  데이터는 없다.
- 다시 앞으로: 9.0.18이 쓴 최종 삭제 영수증은 2분 안에 만료되고(더 길면 첫 prune이 자름), 끝난 asset의 예약 영수증은 첫
  prune에서 풀린다(자르기 테스트가 고정).
- 결과(2026-10-28): 이 릴리스(Release 40692809244, 22:03 KST)는 성공해 실패 자동 복구는 돌지 않았다(recovery job
  skipped). checkpoint(artifact 12817777570)는 계획대로 9.0.18의 PRO room `61e60919`(deployment `1d5b5cab`, message
  `git:53a4f397…`)를 잡았다. 운영 PRO room은 이제 `a04acac1`이다. 이 경계들은 배포 기록 PR이 release-record §4 'PRO
  영수증 후속 열차 A'에 옮겨 적었다.

### 9.0.18 Worker 코드로 한 번 확인

2026-10-28 라운드 2에서 9.0.18 보고서의 방식대로 실제 9.0.18 PRO 방 Worker 코드로 한 번 돌렸다.

- 방법: `f8f2b453`을 꺼낸 임시 worktree에 `git show 53a4f397:cloudflare/pro-room-worker.ts`를 추적하지 않는 파일로 두고,
  임시 테스트 둘을 Worker 테스트 파일의 "PRO browser receipt retention" 안에 넣었다. `53a4f397`과 이 브랜치 사이에
  `cloudflare/`에서 바뀐 파일은 PRO 방 Worker와 App Worker의 버전 한 줄뿐이라 옆 모듈은 9.0.18과 같다. 새 Worker가 쓰고
  저장한 저장소와 버킷 위에 9.0.18 클래스를 새로 만들었고, 그 클래스에 `releaseSettledReserveReceipts`와
  `releaseIdempotencyRecord`가 없는 것(옛 코드임)을 확인했다.
- 새 Worker가 쓴 상태: 끝난 삭제 하나(최종 영수증 없음), 완료 커밋이 예약 영수증을 놓은 이름 없는 완료 asset 하나, 아직
  예약 상태인 예약 하나(영수증 있음), 업로드 실패 정리처럼 지운 예약 하나(다음 prune이 예약 영수증을 놓음), R2 실패로
  열려 있는 삭제 하나(표지와 진행 중 영수증).
- 9.0.18이 불러오기: 스냅숏 200. 원장은 새 Worker가 저장한 그대로이고, 다만 9.0.18의 첫 prune이 삭제 중인 asset의 완료
  영수증을 놓았다(9.0.18에도 있는 완료 해제이며 새 Worker도 다음 prune에서 같은 일을 한다).
- 끝난 삭제의 같은 key 재전송: 404 `ASSET_NOT_FOUND`, revision과 할당량 그대로.
- 예약 상태 asset의 같은 key 예약: 첫 응답을 다시 줌(같은 assetId), asset 수와 할당량 그대로.
- 영수증이 풀린 지운 예약의 같은 key 예약: 새 assetId의 새 예약(9.0.18이 2분 뒤에 하던 것과 같음).
- 예약 영수증 없이 완료된 asset: 9.0.18에서 재생목록 추가가 200.
- R2 실패로 열린 삭제: 9.0.18의 alarm이 마쳤다(asset, R2 객체, 저장소에서 사라짐). 9.0.18은 2분짜리 최종 영수증(200)을
  썼다. 끝의 할당량은 남은 asset대로 사용 4,096 B, 예약 8,192 B였다.
- 새 Worker가 채운 256개 원장(먼저 업로드 8개를 추가까지 하고 삭제 4개를 끝내 예약, 완료, 삭제 영수증이 모두 풀린 뒤, 편집
  248번으로 채움, 저장소에도 256개): 9.0.18이 불러왔고(스냅숏 200, 원장 256개), 편집을 `ROOM_STATE_CAPACITY_EXCEEDED`로
  거절했다가 한 창(2분) 뒤에는 받았다.
- 두 임시 테스트 모두 통과했다. 임시 파일, 테스트, worktree는 지웠고 커밋하지 않았다. 9.0.18 Worker 사본을 fixture로 커밋하지
  않은 이유는 9.0.18 보고서와 같다(옛 코드가 lint, 타입 검사, 커버리지 대상이 되고 옆 모듈이 바뀔 때마다 낡음).

## 혼합 버전

- App: 바뀌지 않는다. 운영의 App은 9.0.19이고 최소 빌드 787이라 9.0.14 이상 App이 새 PRO 방 Worker와 섞인다. 이 App들은
  모두 예약과 삭제를 새 key로 한 번만 보내므로(위 '앱이 보내는 것') 바뀐 답을 받지 않는다. 요청과 응답 모양은 그대로다.
- Worker 사이: PRO 방 Worker만 바뀐다. App Worker의 PRO API 전달, BOT 내부 경로(`/internal/bot/*`), Developer API 경로의
  모양은 그대로이고 Developer 원장은 건드리지 않는다.
- 9.0.20: 열차 B도 `cloudflare/pro-room-worker.ts`와 Worker 테스트 파일을 고치므로 열차 A가 들어간 main에서 만들거나 그
  main을 합친다. 9.0.20의 되돌리기 문장은 열차 A의 PRO 방 Worker를 직전 버전으로 본다.

## 한계

- **R2 장애 중의 일괄 삭제.** '삭제는 원장을 채우지 않는다'는 R2 삭제가 성공할 때만 맞다. R2 삭제가 실패하면 진행 중 영수증이
  표지 소유로 시간 만료 없이 남고 alarm이 60초마다 다시 시도한다. 그래서 R2 장애 중의 일괄 삭제는 지금처럼 원장을 채울 수
  있다. 런타임은 바꾸지 않았다.
- **앱이 보내지 않는 재전송의 답.** 위 '바뀌는 답' 표. 손본 클라이언트가 같은 key를 다시 보내도 asset 상태, 할당량, 예약
  개수가 막으므로 두 번 적용되지 않는다.
- **손상된 표지를 되돌리는 불러오기 경로에서 예약이 영수증 없이 남을 수 있다.** `normalizeLoadedAssetDeletions`는 표지 없는
  `deleting` 행, 형식이 틀린 표지, 같은 key를 가리키는 표지 둘을 지우고 asset을 예약 상태로 되돌릴 수 있다(완료 시각이
  없거나 원래 상태가 `reserved`일 때). 그 asset의 예약 영수증은 삭제가 시작된 뒤의 조정에서 이미 풀렸을 수 있으므로, 되돌린
  예약은 영수증 없이 남는다. 그 key의 예약이 다시 오면 두 번째 예약이 생기고 쓰이지 않으면 예약 만료(15분) 뒤 정리된다. 앱은
  그런 재전송을 보내지 않고, 이 경로는 저장 상태가 손상됐을 때만 탄다. 테스트로 고정하지 않았다.
- **운영 원장 상태는 바깥에서 읽을 수 없다.** 배포 뒤 운영 방에서 일괄 삭제가 원장을 채우지 않는 모습은 직접 볼 수 없다.
  2026-10-28 22:03 KST 배포 뒤에도 보지 않았고, 배포 기록 PR이 release-record §2에 배포 뒤 확인으로 남겼다.
- **같은 기기의 재생목록 대기열(곁 관찰).** 삭제들은 같은 기기의 재생목록 작업 대기열 안에서 차례로 끝나므로 수백 개를 지우면
  그 기기의 다음 재생목록 작업이 기다린다. 이번에 바꾸지 않았다.
- **실기기.** 실제 기기와 운영 Worker에서는 아무것도 돌리지 않았다. 용량 수치(삭제 300개, 업로드 200개)는 가짜 시계와
  가짜 버킷의 단위 테스트다.
- **E2E.** App이 그대로라 로컬 E2E는 돌리지 않았다. exact-main CI의 후보와 critical 브라우저 검사가 돈다.
- **로컬 결과는 exact-main 후보를 대신하지 않는다.**

## 확인하지 않은 것

- 운영 방의 원장 상태: 일괄 삭제가 원장을 채우지 않는 모습, 작은 파일 일괄 업로드가 2분에 약 256개까지 받는 모습, 배포
  뒤 첫 prune이 9.0.18이 남긴 끝난 asset의 예약 영수증을 놓는 모습(2026-10-28 22:03 KST 배포 뒤에도 보지 않았다).
- 운영 PRO 방 Worker를 실제로 9.0.18로 되돌린 상태. 위 일회 확인만 있다.
- 실기기, R2 장애 중의 일괄 삭제, 열차 A 런타임의 전체 직렬 E2E.
- PR CI, 자동 코드 리뷰, exact-main CI, Production Release, PRO 방 smoke, 공개 확인, Drift Audit은 QA 라운드 3에서
  통과했다. 부분 릴리스 판정의 실제 Cloudflare 조회도 릴리스 안에서 compatible이었다(라운드 2는 기록된 운영 버전으로
  로컬에서 돌림).
