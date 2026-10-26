# 구버전 호환 코드 제거 열차 2 릴리스 W: Worker 쪽 옛 앱 요청 모양 (2026-10-26)

| 항목      | 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기준      | 브랜치 `agent/old-version-removal-2w`는 origin/main `dd9c9d4d`(운영 9.0.14 / v787의 배포 SHA, PR #498, [Release 40283632968](https://github.com/hiefny/MUSIXQUARE/actions/runs/40283632968), target `all`)에서 시작했다. 그 릴리스로 여섯 Worker 모두 이 SHA의 버전이 운영에 있으므로 Worker마다 배포된 기준은 `dd9c9d4d` 하나다. 그 뒤 origin/main은 `9e02d2df`(9.0.14와 첫 최소 앱 빌드의 기록 #499, 문서만)로 움직였고 이 갈래는 아직 합치지 않았다(아래 남은 것).                                                                                         |
| 열차 묶음 | Worker 증분 넷(W-1~W-4). 증분마다 테스트 먼저 커밋 뒤 코드 커밋이다. 리뷰 반영: W-2의 `074c0f70`(테스트 고정값), `4e86ab7d`(문서와 주석 한 줄), `f9c4f804`(테스트 고정값 둘), W-3의 `4b0a8e14`(테스트 고정값), `9754402a` → `7a683476`(floor 도구 문장과 주석). 열차 끝 리뷰 반영: 테스트 `d5385500` → PRO 코드 `a0b858fc`(PIN이 든 만료 대기 이전 레코드를 남기고 PIN만 버림), `b3f9c69d`(9.0.14 App Worker와의 혼합 버전 saga 행, 고정값 주석, RO-09). 마지막 런타임 커밋은 `a0b858fc`이고, 그 뒤는 테스트·registry 커밋과 이 보고서·기록 커밋(문서만)이다. |
| 상태      | 배포 전. 열차 끝 레인 검사(`110ac9dd`, 2026-10-27 00:38~01:04 KST)와 테스트 먼저 다시 확인(2026-10-27)이 통과했고, 열차 끝 리뷰(`4f6be4c8`)의 safety·quality-docs 지적을 반영해 다시 검사했다(QA 라운드 4). 남은 것: origin/main 합침과 다시 검사, PR CI, Codex, exact-main CI, 배포 직전 floor `status`, Release, 배포 직후 같은 값 floor `set`(W-verify), 기록 PR. 오너 결정(2026-10-25 약 01:50 KST)대로 자동 게이트가 통과하면 따로 묻지 않고 배포한다.                                                                                                   |
| 범위      | 구버전 제거 열차 2 계획(작업 노트, 2026-10-26)의 릴리스 W. OV-W04(Remote Share), OV-W01과 OV-F07의 PRO 쪽, PRO presence/close 세 필드 선택 받기, OV-W03(Signaling)과 release smoke·floor 도구의 옛 Signaling Worker 재시도 갈래, OV-W02(SK-11 빼고 SK-12·13·15·16), OV-F07의 App facade 쪽, W-1이 남긴 App Worker 지표 이름표. App 쪽 항목(릴리스 A)과 Phase 5 5B의 시스템 오디오 파일은 건드리지 않았다.                                                                                                                                                     |
| 제품 식별 | 바꾸지 않는다. `guard:release-identity` 9.0.14 / v787, `guard:sw-cache-version` PASS(`v787`(`dd9c9d4d`)이 커밋된 PWA 런타임 변경을 모두 덮음). Worker만 바뀐 변경은 SemVer와 SW 캐시 epoch를 올리지 않아도 된다([버전 규칙](../release-versioning.md), [hotfix 절차](../hotfix-procedure.md)의 SW 캐시 문단). 업데이트 창이 뜨지 않는 배포다. 배포 때 main이 다른 열차의 bump를 먼저 실었으면 그 식별 그대로 나간다.                                                                                                                                          |
| 배포 대상 | target `all`, Developer API D1 `false`, `raise_app_build_floor` `false`. 운영 `dd9c9d4d`와 견준 `TARGET_RUNTIME_PATHS`의 바뀐 경로는 remote-share 1, signaling 3, PRO room 2, App 3, Developer API facade 0, Developer API 0이다. App의 셋은 `cloudflare/app-worker.ts`와 App 경로에도 든 `cloudflare/signaling-protocol.ts`, `cloudflare/standard-room-pin-membership.ts`라서 부분 릴리스는 compatibility gate에서 거절된다. 계약 표지 파일, D1 스키마, 비밀, 바인딩, Wrangler 설정, App 정적 자산은 바뀌지 않는다.                                          |
| 환경      | Windows 11 로컬, Node 24.20.0 / npm 12.0.2. 단위는 jsdom과 Node, Worker 프로필(`vitest.workers.config.ts`: 실제 Worker 모듈과 Durable Object 저장소 대역, PRO room은 `node:sqlite`). W-3은 로컬 `wrangler dev`(C5-0 랩 래퍼와 로컬 PIN pepper)로 smoke의 프레임과 도우미를 돌렸다. 브라우저는 헤드리스 Chromium Playwright다.                                                                                                                                                                                                                                 |
| 운영      | 배포 전이라 운영 Worker는 9.0.14 그대로다. 이 열차가 운영에 한 것은 W-2 구현 전에 고정 smoke 방 `000001`의 공개 bootstrap을 opt-in 머리글과 함께 한 번 읽은 것뿐이다(읽기만, `pin_required`와 `passwordRequired: true`).                                                                                                                                                                                                                                                                                                                                      |

이 문서는 옛 앱 버전을 위한 호환 코드를 지우는 두 번째 열차 가운데 Worker만 바꾸는 릴리스 W의 증분과 QA를 기록한다.
근거는 공개하지 않는 작업 노트(`docs/private/`)의 옛 버전 호환 조사(2026-10-25)와 열차 2 계획(2026-10-26)이고, 이
문서의 OV·SK 번호는 그 조사의 번호다. 계획의 줄 번호는 `2077ef60` 기준이라 증분마다 위치를 다시 찾았다. 증분마다 테스트를
먼저 커밋하고 부모 코드에서 새 행만 실패함을 확인했다. 운영에 닿는 smoke와 최소 빌드 도구가 깨지면 릴리스가 자동 복구되거나
바닥 올리기가 실패하므로, 그 둘은 같은 증분에서 고쳤다. 같은 열차의 App 쪽(릴리스 A)은 따로 보고한다.

## 오너 정책과 최소 앱 빌드 787

- **2026-10-25 약 16:40 KST, 옛 버전 정책:** 옛 앱 버전은 더 이상 설계 제약이 아니다. 옛 클라이언트만 섬기던 우회 코드는
  지운다.
- **2026-10-25 약 18:30 KST, 강제 업데이트:** Signaling·PRO Worker가 입장 때 최소 앱 빌드를 검사한다. 첫 최소 빌드는 강제
  업데이트 열차 자신의 빌드이고, 뒤의 올리기는 그것이 필요한 릴리스에서 따로 묻지 않는다.
- **2026-10-26 약 00:10 KST, 작은 통신 필드:** 받는 쪽, 바닥, 보내는 쪽 순으로 지운다. PRO 스냅샷 v1 키, PRO 699 ms 표지,
  LAN-direct `liveExpiresAt`은 남긴다. 이 릴리스에서는 PRO presence/close의 세 필드를 받는 쪽(PRO Worker)만 넓혔다.
- **2026-10-26 약 14:10 KST, 병렬:** 열차 2와 Phase 5 5B는 병렬이다. 머지와 배포는 한 줄로 세운다(아래 배포·회복).
- **배포 정책(2026-10-25 약 01:50 KST):** 자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과하면
  따로 묻지 않고 배포한다. 기기 근거는 게이트가 아니다.

**최소 앱 빌드.** 9.0.14 / v787이 2026-10-26 16:10 KST에 나갔고, 첫 최소 빌드 787은 16:15 KST에 App Build Floor workflow
[set 40284593490](https://github.com/hiefny/MUSIXQUARE/actions/runs/40284593490)으로 켜졌다(저장 787, 유효 787, revision
1). 그 뒤로 787 아래 앱은 Standard 방의 새 입장과 재접속(Signaling `app-update-required`, close 1008)과 PRO 입장(426)에서
거절된다. 이 릴리스가 지우는 요청 모양을 보내는 앱은 모두 그 아래다. 가장 새 것은 OV-F07의 9.0.0~9.0.3이고, 나머지는
8.10.9 이하, 8.4.16 이하, 2026-08 전의 앱이다. 787보다 높은 바닥이 필요한 항목은 없다. OV-F07 밖의 항목은 계획상 클라이언트
바닥이 필요 없다. 대상 송신자가 이미 있던 바닥(PRO 하트비트 9.0.0 등) 아래이거나, 운영 설정이 그 모양을 이미 막았거나(Remote
Share `required`), 거절 자체가 그 옛 앱의 강제 업데이트다. OV-F07만 787에 기댄다.

**바닥이 거르지 못하는 곳.** 바닥 읽기는 실패하면 마지막 값이나 0이고(fail-open), App의 매분 보고가 5분 넘게 멈추면 유효
바닥이 0이 된다. 그 창에서 787 아래 탭이 들어오면 아래 표의 '잃는 것'이 그 탭에 일어난다. 오너 정책이 수용한다. 이
릴리스의 Signaling 배포가 Durable Object를 다시 시작해 Standard 신호 소켓이 다시 붙으면, 바닥 전에 들어와 아직 다시 붙지
않은 787 아래 방장은 그때 바닥에서 거절된다(맺어진 P2P는 산다. Cloudflare 문서상 동작이고 확인하지 않았다). 그래서 계획은
이 릴리스를 App 릴리스 A보다 먼저 둔다.

## 제품·런타임 증분

각 절의 '줄'은 증분 범위의 `git diff --numstat`으로 센 값이다. Worker는 `cloudflare/*.ts`, 도구는 `scripts/`, 테스트는
`__tests__`와 `e2e/`, 문서는 `*.md`다.

### W-1 Remote Share는 v3 세션 본문만 받고 'optional' 확인서 모드를 없앰 (OV-W04)

테스트 `a121040c`, 코드 `cc83cfa7`. 검증한 SHA `cc83cfa7`.

- `/session`은 v3 본문(메타데이터 여섯 필드와 비공개 `rs3_` 요청 nonce, `rsa_` actor ID)만 받는다. 캐시된 여섯 필드 본문과 v2
  본문(`rs_` 요청 ID, actor 없음)은 모든 모드에서 확인서, R2, 할당량, rate 작업 전에 400 `invalid upload session request`다.
  App은 2026-08부터 v3 본문을 보내고, 787 이상은 모두 확인서와 함께 보낸다. 운영은 `required`라 그 본문은 이미 403이었다.
- `ROOM_UPLOAD_ASSERTION_MODE`는 `disabled`와 `required`만 받는다. `optional`은 이제 무효 설정이라 `/security-config`와 모양이
  맞는 `/session`이 503 `ROOM_UPLOAD_ASSERTION_MODE_INVALID`로 닫혀 실패한다. 운영 값은 `required`다
  (`cloudflare/wrangler.remote-share.toml`, `scripts/production-security-rollout.mts`가 강제).
- 함께 지운 것: `legacy:<uuid>` 작업 식별, 지표 `remote_share_upload_assertion_legacy`, v3 밖의 replay만 묶던 capability
  token 가명. capability는 이제 접근만 거르고 replay 권한은 비공개 v3 actor에 있다. v3 작업·영수증 식별은 바이트가 같아
  저장된 영수증이 그대로 replay된다.
- 남긴 것: `workerContractVersion` 3과 계약 표지(클라이언트가 3만 받으므로 올리면 지금 클라이언트가 깨진다),
  `/security-config`의 확인서 두 필드, Durable Object 상태의 null 저장 `clientRequestId` 허용.
- live Remote Share smoke는 `optional` 준비 답을 더 해석하지 않는다. 그 갈래는 Worker를 준비됨으로 만든 적이 없고(준비는
  `required`를 요구), `optional` 답은 여전히 smoke를 기다리게 한다(기존 준비 행이 양쪽에서 보임).
- 문서: `cloudflare/remote-share-ops.md`(확인서 모드, 지표, v3 계약, 전환 기록의 되돌리기와 감시 항목, v4 bump를 계획하던
  문단), `cloudflare/admin-dashboard-ops.md`의 지표 행.

| 항목        | 값                                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저 | `a121040c`를 `dd9c9d4d` 코드에서 돌리면 3행 FAIL, 93행 PASS(여섯 필드·v2 본문이 두 모드에서 400, `optional` 설정의 `/security-config` 503, 확인서 없는 `/session`의 503). 계약 버전 3 고정 행은 양쪽 PASS. 다른 행의 고정값은 지금 클라이언트의 v3 본문과 `required` 모드로 옮겼다. |
| 줄          | Worker +78 / −118(순 −40), 도구 +1 / −5, 테스트 +113 / −68, 문서 +40 / −36.                                                                                                                                                                                                         |
| 잃는 것     | 운영 없음(이미 `required`라 옛 본문은 403). 개발·테스트의 `disabled` 모드에서 옛 본문으로 올리던 구성, `optional`로 설정한 개발 Remote Share Worker(이제 닫힌 실패). 바닥 fail-open 창의 2026-08 전 앱은 원격 공유 업로드가 400이다.                                                |
| smoke·도구  | live Remote Share smoke는 지금도 `required`를 요구하므로 자동 복구 위험이 없다.                                                                                                                                                                                                     |
| 되돌리기    | 부모 Remote Share는 v3 본문도 받으므로 지금 클라이언트에 영향이 없다. 저장 모양이 같다.                                                                                                                                                                                             |

### W-2 PRO Worker가 바닥 아래 앱의 요청 모양을 그만 받고 presence/close 세 필드를 선택으로 받음 (OV-W01, OV-F07 PRO 쪽)

테스트 `6b03ed43`(고정값 정정 `074c0f70`), 코드 `6812c8b1`, 리뷰 반영 `4e86ab7d`(문서·주석), `f9c4f804`(테스트 고정값).
검증한 SHA `6812c8b1`. 리뷰 반영 셋은 테스트 고정값과 문서·주석이고, W-3 이후 라운드의 전체 실행에 함께 들어 있다. 열차 끝
리뷰 반영: 테스트 `d5385500`, 코드 `a0b858fc`(대기 이전 레코드의 PIN, 아래), `b3f9c69d`(혼합 버전 saga 행, 고정값 주석,
RO-09). 검증한 SHA는 QA 라운드 4.

- **opt-in 머리글을 읽지 않음:** bootstrap은 `open` 또는 `pin_required`와 함께 방의 `passwordRequired`를 늘 싣는다. 모든
  스냅샷 답(활성화, 세션, 이전 commit)이 `passwordRequired`와 `playlistSlots`를 싣고, `POST /pin`은 머리글과 관계없이
  `{pin: null}`과 `existingParticipants`를 받고 `passwordRequired`를 답한다. `withEntryPolicyResponse` 감싸개는 남아 두 필드를
  늘 붙인다. CORS 허용 목록에서는 `x-mxqr-pro-effects-version`만 뺐다(App은 입장 정책·재생목록 칸 머리글을 계속 보낸다).
- **거절(400):** 임시 PIN 활성화 본문(8.8.0 전), `requestId` 없는 한 필드 `{pin}` 세션 본문(2026-08 전), 이전 PREPARE의
  `newPin`(9.0.4 전, OV-F07), 참가자 id로 내보내기 본문과 브라우저 제어 버전을 실은 신호 ticket 본문(둘 다 2026-07-20 전).
- **없어짐(404):** `GET`/`PUT /effects`(App 호출자 없음. `pro-room-effects.ts`에서 `effectsContractVersion`만 지우고
  Developer API 효과 읽기가 쓰는 `publicEffects`는 남김), 개발자 명령 ACK 경로, `DELETE /sessions/current`(App은 울타리 있는
  close로 떠난다).
- 참가자와 명령의 `developerControlVersion`, 명령의 `acknowledgedAtMs`를 지웠다. 큐 추가 힌트는 버전 1을 자기 상수로 둔다.
  그 필드가 남은 저장 레코드는 그대로 읽는다(정확한 키 검사 없음).
- **presence/close:** `baseRevision`, `currentQueueItemId`, `playback`을 선택으로 받고, 있으면 지금처럼 검사한다. fingerprint
  입력은 같은 객체이고 `JSON.stringify`가 없는 키를 빼므로, 지금 App 본문의 fingerprint는 바이트가 같고 배포 전에 저장된
  영수증도 replay된다. App의 보내기 중단은 열차 3이다.
- **`coordinatorParticipantId`:** `publicSnapshot`은 null 상수를 내고 십여 곳의 null 재할당을 지웠다. 저장 키는 남겼다(타입
  null). 부모로 되돌렸을 때 키가 없다고 모든 방의 코디네이터 울타리를 올리지 않게 하려는 것이다. 로드 정규화는 2026-07-20 전
  Worker가 저장한 값을 계속 지운다.
- **저장 상태 이주를 지움(기록이 끝난 날짜와 함께):** 공유 원장의 presence-close·세션 생성 영수증(8.9.0 전 PRO Worker만 썼고
  8.9.0은 2026-10-11 10:33 KST 배포. TTL 24시간과 10분이라 2026-10-12까지 모두 만료), 공유 맵의 Developer 영수증과 BOT 계수
  (2026-07-27부터 전용 원장. TTL 24시간, 창은 길어야 하루), `kind` 없는 재생 영수증의 짧은 TTL(2026-08-02부터 `kind` 표지.
  TTL 24시간). 만료된 공유 원장 기록은 보통의 prune이 푼다. 재생 영수증의 `kind` 표지는 이 Worker가 읽지 않지만 남긴다.
  되돌린 이전 PRO Worker가 10분 영수증을 곧바로 만료시키지 않게 하려는 것이다(`4e86ab7d` 주석).
- **대기 이전 레코드의 PIN은 받고 읽지 않음(열차 끝 리뷰 반영 `a0b858fc`):** 9.0.4(2026-10-24 01:56 KST 배포) 전 PRO Worker만
  대기 이전 레코드에 새 소유자가 고른 PIN을 적었다. `6812c8b1`은 대기 레코드가 claim보다 오래 살지 않아 길어야 15분이라고 보고
  그 레코드를 null로 정규화했는데, 그 전제가 틀렸다. 만료된 대기 레코드를 지우는 곳은 없다. commit과 reconcile은 410을 답하고
  레코드를 그대로 두며, 새 PREPARE가 바꾸거나 commit이 끝낼 때까지 방은 `ownership_transfer_pending`으로 멈춰 있고
  `ownerAccountId`는 null이다. claim 발급은 그 레코드가 있을 때만 epoch를 올리고, 다음 PREPARE는 그 레코드의 이전 소유자 연결을
  이어받는다. 레코드를 버리면 다음 이전의 `previousOwnerAccountId`가 null이 되어 App Worker saga가 옛 소유자의 계정·방 연결을
  은퇴시키지 않고(그 계정의 방 수에 계속 셈), claim 때의 epoch 올리기를 건너뛰며, `/internal/admin/status`의
  `ownerTransferReconciliation`이 null이 되어 멈춘 이전이 운영자와 saga cron에서 가려진다. 그래서 로드 정규화가 선택 저장 키
  `pin`을 다시 받고 유효한 레코드에서 읽지 않고 지운다(PIN 모양이 잘못돼도 레코드는 남김). PREPARE는 그 키를 쓰지 않고, commit
  증명은 그 키를 덮지 않으며, commit은 원래 무시했으므로 요청 표면은 돌아오지 않는다. 부모 PRO Worker는 키가 있든 없든 그
  레코드를 읽는다. 운영에 그런 방이 있는지는 열어 보지 않았다(레코드를 남기므로 결과가 같다).
- **smoke와 floor 도구(같은 증분):** live PRO smoke와 `app-build-floor.mts`의 PRO 증명이 `X-MXQR-Pro-Entry-Policy: optional-v1`을
  보낸다(그러면 부모와 이 Worker의 답이 같다). 방 `000001`은 `pin_required` + `passwordRequired: true` 또는 `open` + `false`의
  일관된 쌍이면 받는다. 운영 `000001`을 머리글과 함께 한 번 읽은 값은 `pin_required` + `true`였다. smoke 출력에
  `pinRoomPasswordRequired`를 더했다.
- 하트비트 벤치마크는 지금 Worker를 App의 활성화 본문으로 채우고, 임시 PIN 본문은 2026-07-19 기준 Worker에만 쓴다. 혼합 버전
  saga 테스트는 옛 App Worker 빌드의 cron 행을 남기고 요청 행을 지웠다(그 빌드들의 요청은 PRO가 거절하는 `newPin`을 싣는다).
  열차 끝 리뷰 반영 `b3f9c69d`가 이 릴리스와 실제로 겹치는 9.0.14 빌드(`dd9c9d4d`)를 양방향으로 더했다(아래 혼합 버전).
  registry RO-09 근거 줄이 그것을 적는다.
- 문서: `pro-room-architecture-and-operations.md`(bootstrap, 이전 링크, 활성화 본문, PIN 답, 스냅샷 필드와 입장 본문, 공유
  원장 영수증, pagehide 본문, 효과 끝점, 출시 카나리아 표의 '파생 bootstrap 값' 열, Rollback 문단). registry RO-07(재시도 없는
  레인의 `broadcastServerEvent` 대기 자리 열둘 → 열하나, `handleUpdateEffects`가 `/effects`와 함께 사라짐)과 RO-09.
  release-record §2 PRO 소유권 이전 항목.

| 항목        | 값                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저 | `6b03ed43`에 `074c0f70`의 고정값 정정(공유 `joinPublicRoom`에 입장 정책 머리글)을 얹어 `cc83cfa7` 코드에서 돌리면 35행 FAIL, 661행 PASS. Worker 묶음 26행(`pro-room-worker.test.ts` 21, `app-build-floor-script.test.ts` 3, `owner-transfer-entry-password-sqlite.test.ts` 2)과 `live-pro-room-smoke-readiness.test.ts` 9행이고 모두 새 기대다. 지금 클라이언트 모양의 presence/close 행과 Developer API 효과 읽기 schema 2 행은 양쪽 PASS. bisect 주의: `6b03ed43`만으로는 공유 입장 도우미가 부모에서 거절되어 parity 행까지 준비에서 FAIL했다(27행). `074c0f70`이 그것을 고치고 테스트 먼저 기록을 정정했다. |
| 줄          | Worker +339 / −694(순 −355, `pro-room-worker.ts` +339 / −689), 도구 +52 / −16, 테스트 +886 / −1,067(지운 이주·옛 모양 행과 지금 모양으로 옮긴 고정값, 새 공유 도우미 `pro-room-entry-pin.ts`), 문서 +68 / −46.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 잃는 것     | 운영의 787 이상 클라이언트 없음. 바닥 아래 탭: opt-in 머리글 없는 옛 앱이 보던 'legacy `pin_required`' 모양, 8.8.0 전 임시 PIN 활성화, 2026-08 전 `{pin}` 입장, 2026-07-20 전 참가자 id 내보내기와 제어 버전 ticket, 9.0.0~9.0.3 탭의 이전 링크(400, OV-F07, 바닥 787에 기댐). 9.0.0 전 탭은 이미 하트비트에서 끊긴다. 지운 저장 이주 셋은 기록이 모두 만료된 뒤라 잃는 데이터가 없다(운영 저장소를 직접 열어 보지는 않음). PIN이 든 대기 이전 레코드는 PIN만 버리고 남긴다(`a0b858fc`).                                                                                                                        |
| smoke·도구  | PRO smoke, floor 도구의 PRO 증명, Developer API live smoke(`000001`의 효과 읽기와 명령 생성·상태)가 이 코드를 지난다. 단위와 readiness 행으로 확인했다(아래 레인 검사의 smoke·floor 묶음).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 되돌리기    | 부모 PRO Worker로 되돌려도 새 바닥이 필요 없다. 9.0.14 이상 App은 opt-in 머리글과 close 세 필드를 보내므로 부모가 같은 답을 하고, 부모의 로드 정규화가 `developerControlVersion`을 다시 채우며, 저장 `coordinatorParticipantId`는 늘 쓰던 null이고, 재생 영수증의 `kind` 표지가 남아 있다. 이 경계는 App이 close 세 필드를 그만 보낼 때(열차 3) 움직이고, 그 열차가 적는다.                                                                                                                                                                                                                                     |

### W-3 Signaling Worker가 PIN 필드를 요구하고, smoke와 floor 탐침은 첫 프레임 무효에 즉시 실패 (OV-W03)

테스트 `430da8c6`, 코드 `6f5b4aea`, 리뷰 반영 `4b0a8e14`(테스트 고정값), `9754402a` → `7a683476`(floor 도구 문장과 주석). 검증한
SHA `6f5b4aea`, `7a683476`.

- `host-auth`는 `desiredRoomPassword`(`''` 또는 여덟 자리)와 `pinMutationId`를 요구한다. 없으면 첫 프레임 무효(close 1008
  `HOST_AUTH_FIRST_FRAME_INVALID`, 최소 빌드 검사 전)다. `room-password-set`은 `pinMutationId`를 요구하고, 없으면 입장한 방장의
  그 프레임을 무시한다. 8.4.17부터 모든 App이 두 필드를 보내므로, 거절은 8.0.8~8.4.16 방장에게만 닿고 그것이 그들의 강제
  업데이트다(바닥 787보다 훨씬 아래).
- 함께 지운 것: 모든 `legacy-<uuid>` PIN 변경 울타리(host-auth commit, 실패한 변경, 받은 순서 claim, room-password-set claim)와
  PIN 결정 없이 방을 commit하던 host-auth 갈래. 이제 모든 입장이 원하는 PIN을 commit하고 peer-open에
  `roomPasswordMutationId`와 `roomPasswordApplied`를 답하며, 모든 PIN 실패와 거절이 `room-password-result`를 보낸다.
- 남긴 것: 멤버 선택 없는 같은 PIN 재전송(방장 자신의 재접속 재전송), open 뒤 PIN 확인 울타리, 멤버 광고(열차 3의 OV-F08).
- **smoke와 floor 도구(같은 증분):** 모든 `host-auth`가 PIN 두 필드를 싣는다. Remote Share smoke의 방장과 floor 탐침은 `''`와
  새 변경 ID를 보낸다. 신호 smoke의 빌드 없는 방장(`runLegacyCompatibilityAttempt`, 출력
  `legacyCompatibility.refusedBelowAppBuildFloor`는 그대로)도 싣는다. 바닥 아래에서는 정확한 거절을 그대로 증명하고, 바닥이 꺼져
  있으면 입장만 증명한다(그 뒤의 결과 프레임 없는 room-password-set과 게스트 셋의 옛 PIN 흐름은 지웠다).
- **옛 Signaling Worker 재시도 갈래를 지움:** `HOST_AUTH_FIRST_FRAME_INVALID` 답은 'invalid-frame' 결과이고 모든 smoke와 floor
  게이트에서 그 이유와 함께 즉시 실패한다. 이 Worker는 PIN 필드 없는 프레임에, 9.0.14 전 Worker는 `appBuild`에 같은 이유를
  내므로 옛 Worker로 읽던 해석을 지웠다: `LegacySignalingHostAuthError`, `PreFloorSignalingWorkerError`,
  `createHostAuthBuildSelector`와 그 빌드 없는 모양 재시도 한 번, candidate/unknown 신호 모드, floor 도구의 'deploy signaling
  first'. 9.0.14 이상 App이 live인 동안 Signaling을 9.0.14 아래로 되돌리는 것은 이미 절차 밖이다. 리뷰 반영 `7a683476`은 floor
  도구의 실패 문장이 두 원인(탐침이 Worker가 요구하는 `host-auth` 모양을 보내지 않음, 또는 Signaling Worker가 9.0.14보다 오래되어
  `appBuild`를 거절함)을 함께 적게 했다. 동작은 같고 재시도는 없다.
- 신호 smoke와 HTTP 신호 smoke는 `appBuild.signalingMode`와 `appBuild.hostAuthShape`를 더 출력하지 않는다(이제 늘 `appBuild`).
  [hotfix 절차](../hotfix-procedure.md#app-build-floor)의 첫 바닥 증명 문장에서 `hostAuthShape`를 뺐고 `appBuild.build`와
  `legacyCompatibility.refusedBelowAppBuildFloor`는 그대로다.
- 리뷰 반영 `4b0a8e14`: W-3 뒤 `pinMutationId` 없는 room-password-set이 무시되어 준비가 아무것도 하지 않던 Worker 행 셋(메타데이터가
  사라져도 보호된 방을 암호 없는 방으로 다시 만들지 않음, 암호 대기 핸드셰이크와 입장 게스트 용량, 99명 상한 다시 검사)이 모든
  App이 보내는 변경 ID로 PIN을 걸고 그 적용을 단언한다. 셋 다 부모와 이 커밋에서 PASS이고, 보호 장치를 지우는 변이로 FAIL함을
  확인했다(커밋 메시지).

| 항목        | 값                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저 | `430da8c6`을 `f9c4f804` 코드에서 돌리면 바뀐 9 files에서 19행 FAIL, 544행 PASS. Worker 묶음 12행(`live-smoke-app-build` 5, `app-build-floor-script` 3, `standard-room-pin-membership` 2, `cloudflare-signaling-worker` 2)과 smoke 파일 7행(Remote Share 3, 신호 2, HTTP 신호 2)이고 모두 새 기대다. 리뷰 반영 `9754402a`를 `6f5b4aea` 코드(`4b0a8e14` 테스트 포함)에서 돌리면 1행 FAIL(floor 게이트 문장이 두 원인을 적음), 59행 PASS. bisect 주의: `430da8c6`에서 `typecheck:tests`가 한 오류를 낸다(floor 행의 탐침 결과 'invalid-frame'을 부모 타입이 아직 모름).  |
| 줄          | Worker +76 / −105(순 −29), 도구 +152 / −296(순 −144, `live-signaling-smoke.mts` −90, `live-smoke-app-build.mts` −53), 테스트 +398 / −265, 문서 +2 / −2(`hotfix-procedure.md`).                                                                                                                                                                                                                                                                                                                                                                                        |
| 잃는 것     | 운영의 787 이상 클라이언트 없음. 8.0.8~8.4.16 방장(바닥 아래)은 첫 프레임 무효로 닫힌다. 9.0.14 아래로 Signaling을 되돌린 운영자(절차 밖)는 smoke와 floor 도구가 옛 모양으로 다시 해 보지 않고 두 원인을 적은 채 즉시 실패한다.                                                                                                                                                                                                                                                                                                                                       |
| smoke·도구  | 로컬 `wrangler dev`에서 smoke의 프레임과 도우미로 확인했다(`6f5b4aea` 메시지): 암호 없는 방과 보호된 방이 빌드와 PIN 필드로 입장·확인되고, 틀린 PIN 거절, 게스트 입장, offer 중계. 빌드 없는 방장은 바닥이 꺼지면 입장, 바닥 788에서 정확한 거절(close 1008 `APP_UPDATE_REQUIRED`). floor 탐침은 바닥 꺼짐에서 787 입장, 788에서 바닥 아래. PIN 필드 없는 `host-auth`(빌드가 있든 없든)는 1008 `HOST_AUTH_FIRST_FRAME_INVALID`로 닫히고 'invalid-frame'으로 분류되어 smoke 도우미가 즉시 실패. 변경 ID 없는 room-password-set은 결과가 없고 방은 암호 없는 채로 남음. |
| 되돌리기    | 부모 Signaling Worker는 같은 프레임을 받으므로 지금 클라이언트에 영향이 없다. App HTTP 다리는 프레임을 그대로 넘긴다.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### W-4 App Worker가 바닥 아래 앱의 요청 모양을 그만 받음 (OV-W02의 SK-12·13·15·16, OV-F07 facade, 지표 이름표)

테스트 `e2cb7dd9`, 코드 `110ac9dd`. 검증한 SHA `110ac9dd`.

- **SK-12:** `/api/youtube-playlist-entry`와 그 처리기, 항목 정규화를 지웠다. 8.10.9 이하가 썼고 8.10.10부터
  `/api/youtube-playlist-manifest`다. 그 경로는 이제 정적 자산 404로 떨어지고 YouTube를 부르지 않는다. Vite 개발 프록시의 같은
  줄은 릴리스 A의 bump와 함께 간다(`vite.config.ts`는 SW 캐시 가드의 입력). 그 프록시 목록을 적은
  `docs/configuration-reference.md`와 `CONTRIBUTING.md`도 그때 고친다.
- **SK-13:** 관리자 공지 POST는 8.3.20부터 모든 관리자 페이지가 보내는 울타리 있는 다섯 필드 본문(`message`, `enabled`,
  `expiresAt`, `expectedRevision`, `requestId`)만 받는다. 세 필드 본문은 400 `INVALID_REQUEST`이고, 정확한 옛 재시도의 되읽기,
  그 본문만 필요하던 facade 쪽 지난 만료 검사(Durable Object는 자기 검사를 유지), 합성한 `legacy-<uuid>` 요청 ID를 지웠다. KV
  상태에서 저장 공지로의 이주는 남겼다.
- **SK-15:** 8.3.23 이하의 `requestId` 없는 `{pin}` 세션 입장은 더 facade의 제한된 서비스 호출을 건너뛰지 않는다. 모든 입장처럼
  5초 응답 기한을 받고, PRO는 W-2부터 그 본문을 400으로 거절한다.
- **SK-16:** facade는 브라우저의 `X-MXQR-Pro-Entry-Policy`와 `X-MXQR-Pro-Playlist-Slots`를 내부 소유권 이전 commit에 더 넘기지
  않는다. W-2부터 PRO가 모든 스냅샷 답에 두 필드를 붙인다. `callProRoomAdminObject`는 opt-in 매개변수를 잃었다(부르는 곳 하나).
- **OV-F07:** 이전 본문은 정확히 `{claimToken, requestId}`다. 9.0.0~9.0.3의 `newPin`을 실은 본문은 의도나 의도 입장을 기록하거나
  PREPARE를 보내기 전에 400 `INVALID_REQUEST`다(감사 `denied_invalid_request`).
- 관리자 지표 목록에서 W-1이 쓰기를 멈춘 `remote_share_upload_assertion_legacy`를 뺐다. 요약은 그 옛 행을
  `host_legacy_url_auth`처럼 무시한다.
- 문서: `admin-dashboard-ops.md`(은퇴한 이벤트를 표에서 문장으로), `pro-room-architecture-and-operations.md`(권한 문단과
  Rollback), release-record §2 PRO 소유권 이전 항목.

| 항목        | 값                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저 | `e2cb7dd9`를 `7a683476` 코드에서 돌리면 8행 FAIL, 878행 PASS(바뀐 두 테스트 파일과 바뀐 saga 도우미를 쓰는 파일 여섯을 함께 돌림): `/api/youtube-playlist-entry` GET·OPTIONS가 정적 404, 관리자 공지 세 필드 본문 400과 지표 요약, `{pin}` 입장의 5초 기한, 이전 commit이 opt-in 머리글 없이도 두 필드를 받음(실제 PRO room, `node:sqlite`), `newPin` 본문 400(모의와 실제 PRO room). 지운 경로의 행 셋과 e2e 모의(`e2e/youtube.test.ts`)는 경로와 함께 지웠다.                         |
| 줄          | Worker +26 / −214(순 −188), 테스트 +349 / −306(e2e 모의 −17 포함), 문서 +22 / −8.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 잃는 것     | 운영의 787 이상 클라이언트와 관리자 페이지 없음. 바닥 아래: 8.10.9 이하의 재생목록 첫 영상 경로(404), 8.3.20 전 관리자 탭의 공지 저장(400), 8.3.23 이하의 PRO 세션 생성(PRO 400), 9.0.0~9.0.3의 이전 링크(400).                                                                                                                                                                                                                                                                         |
| smoke·도구  | 이 경로들을 읽는 release smoke는 없다. App generation과 익명 계정 경계 smoke는 바뀌지 않는다.                                                                                                                                                                                                                                                                                                                                                                                           |
| 되돌리기    | W-4 앞 App Worker로 되돌려도 W-2 PRO와 함께라면 안전하다(opt-in 머리글은 PRO가 무시하고, `newPin` 본문은 PRO가 거절한다). 반대로 PRO만 W-2 앞으로 되돌리고 App Worker를 W-4로 두면 이전 링크의 답에 `passwordRequired`와 `playlistSlots`가 빠진다. App 파서는 둘을 선택으로 받고 방 암호는 commit한 대로 꺼져 있지만, 새 소유자 설정은 다음 스냅샷 revision까지 암호를 켜짐으로 보일 수 있다. 둘을 함께 되돌리거나 앞으로 고친다(`pro-room-architecture-and-operations.md`의 Rollback). |

## QA 라운드

### 1. 증분별 (2026-10-26 16:25 ~ 2026-10-27 00:18 KST)

환경은 위 표와 같다. 각 증분의 구현이 그 증분 끝에서 돌렸다(커밋 메시지).

| 증분     | 검증 SHA   | 단위 전체(`--maxWorkers=6`) | Worker 단위     | 정적·가드                                                                                                                                                                                                                                                                                       |
| -------- | ---------- | --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-1      | `cc83cfa7` | 680 files / 16,062 PASS     | 67 / 3,176 PASS | tsc, typecheck:tests·node-scripts, `tsconfig.tooling.json`, `check:workers`, lint, format, dead-exports, import-graph, bus-pairing, lifecycle-writes, room-authority-boundaries(직접 읽기 82 그대로), transport-health, navigation-sinks, `check-resource-ownership`(부모와 바이트가 같음) PASS |
| W-2      | `6812c8b1` | 680 / 16,065 PASS           | 67 / 3,174 PASS | 위와 같음과 typecheck:browser-classic PASS                                                                                                                                                                                                                                                      |
| W-3      | `6f5b4aea` | 680 / 16,065 PASS           | 67 / 3,176 PASS | 위와 같음, Worker·도구 커버리지 프로필, source-complexity, standard-room-hot-path PASS. 로컬 `wrangler dev` 신호 흐름(W-3 표)                                                                                                                                                                   |
| W-3 리뷰 | `7a683476` | 680 / 16,065 PASS           | 67 / 3,176 PASS | 위와 같음과 ops-drift-contract PASS. `check-resource-ownership`과 dead-exports 출력이 부모와 바이트가 같음                                                                                                                                                                                      |
| W-4      | `110ac9dd` | 680 / 16,065 PASS           | 67 / 3,176 PASS | `npm run typecheck`(모든 tsc 프로젝트), `check:workers`, lint, format, 위 가드, source-complexity(`app-worker.ts` 16,900줄), `check-resource-ownership`(부모와 바이트가 같음) PASS. 가드 기준치 변화 없음                                                                                       |

SKIP(모든 증분): 실제 기기, WebKit, 운영 Cloudflare, `build:checked`와 브라우저 검사(라운드 2에서 돌림).

### 2. 열차 끝 레인 검사 (`110ac9dd`, 2026-10-27 00:38 ~ 01:04 KST)

검증 대상은 마지막 런타임 커밋 `110ac9dd`다.

| 검사             | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 정적             | `npm run typecheck`(모든 tsc 프로젝트와 그 가드, Worker 타입 생성물 최신), `typecheck:tests`, `check:workers`(declaration-ownership, D1 마이그레이션, ops-drift-contract 포함), `lint`, `format:check` PASS.                                                                                                                                                                                                                                                             |
| 단위 전체        | `vitest run --maxWorkers=6` 680 files / 16,065 tests PASS, FAIL 0(371초). main `dd9c9d4d`의 9.0.14 최종 16,062보다 3행 많다.                                                                                                                                                                                                                                                                                                                                             |
| Worker 단위      | `vitest run --config vitest.workers.config.ts --maxWorkers=6` 67 files / 3,176 tests PASS.                                                                                                                                                                                                                                                                                                                                                                               |
| smoke·floor 묶음 | live smoke와 floor 도구, 릴리스 상태·증거·복구 판정 단위 22 files / 585 tests PASS(App generation, App 공개 경계, PRO readiness, Remote Share 수명, 신호 readiness, smoke 빌드 도우미, rate-limit 재시도, HTTP 신호, Developer API smoke, floor 스크립트·계약·ops·App Worker·관리자 UI, release worker floor 상태 등).                                                                                                                                                   |
| `build:checked`  | 전체 PASS. 빌드 앞 가드(release-identity 9.0.14·v787, `guard:sw-cache-version` bump 없이 PASS, room-authority-boundaries 직접 읽기 82·구독 22·쓰기 13, source-complexity: `pro-room-worker.ts` 17,848줄, `app-worker.ts` 16,900줄, `signaling-worker.ts` 8,421줄, `signaling-protocol.ts` 989 / 1,000줄)와 빌드 뒤 가드(legacy TV Chromium 79 `main-CaKT24Ie.js`, SW 빌드 v787 바이트 일치, 초기 전송 예산, prod hooks·보안, 글꼴, SW 앱 셸 97 자산(주입 진입 자산 42)). |
| 가드             | navigation-sinks, dead-exports(테스트 전용 20/20, 자기만 76/76, 내보낸 binding 2,103), bus-pairing 202/202, import-graph(398 files, 순환 0), lifecycle-writes, release-identity, sw-cache-version, `check-resource-ownership`(48 records / 442 files) PASS. 2026-10-27 같은 트리에서 transport-health(12 files, 은퇴 이름 24), standard-room-hot-path, ops-drift-contract도 PASS.                                                                                        |
| 커버리지         | `test:coverage:critical` 87 files / 3,406 tests, Worker 커버리지 프로필 67 files / 3,176, 도구 커버리지 14 files / 419 PASS(파일별 하한 유지).                                                                                                                                                                                                                                                                                                                           |
| Chromium         | `test:e2e:critical` 61/61 PASS(4.1분). W-4가 모의를 지운 `e2e/youtube.test.ts` 9/9 PASS(1.0분).                                                                                                                                                                                                                                                                                                                                                                          |
| Worker 번들      | `check:worker-bundles`가 여섯 운영 설정을 배포 없이 묶음(Wrangler 4.148.0, Durable Object 마이그레이션 7). 크기는 아래 초기 JS와 Worker 번들.                                                                                                                                                                                                                                                                                                                            |
| SKIP             | 실제 기기, WebKit, C5-0 랩과 강제 업데이트 랩(신호 Worker를 `wrangler dev`로 띄우는 랩. W-3의 신호 흐름은 증분 중 로컬 `wrangler dev` 확인뿐), production 후보 Playwright, PRO 로컬 Playwright, 운영 Cloudflare, PR CI·Codex·exact-main CI·릴리스 smoke(이 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다).                                                                                                                                                           |

### 3. 테스트 먼저 다시 확인 (2026-10-27)

각 테스트 먼저 커밋은 부모의 제품 코드 위에 테스트만 바꾼 것이다. 그 커밋을 `git archive`로 스크래치 폴더에 풀고
(`node_modules`는 작업 폴더의 것을 junction으로 연결) 바뀐 테스트 파일과 바뀐 도우미를 쓰는 테스트 파일을 돌리면 "새 테스트,
옛 코드"가 된다. W-2는 `074c0f70`의 고정값 정정(세 줄)을 `6b03ed43` 위에 얹었다. FAIL은 모두 그 커밋이 더하거나 바꾼 행이고
시간 초과는 없었다. 코드 커밋 뒤에는 라운드 1·2에서 모두 PASS다. 고정값만 바꾼 두 커밋은 부모에서도 PASS여야 하고 그랬다.

| 증분       | 테스트 커밋             | 부모 코드  | 돌린 파일 | 결과                        |
| ---------- | ----------------------- | ---------- | --------- | --------------------------- |
| W-1        | `a121040c`              | `dd9c9d4d` | 1         | 3 FAIL / 93 PASS            |
| W-2        | `6b03ed43` + `074c0f70` | `cc83cfa7` | 10        | 35 FAIL / 661 PASS(16 skip) |
| W-2 고정값 | `f9c4f804`              | `4e86ab7d` | 1         | 0 FAIL / 281 PASS           |
| W-3        | `430da8c6`              | `f9c4f804` | 9         | 19 FAIL / 544 PASS          |
| W-3 고정값 | `4b0a8e14`              | `6f5b4aea` | 1         | 0 FAIL / 327 PASS           |
| W-3 리뷰   | `9754402a`              | `6f5b4aea` | 1         | 1 FAIL / 59 PASS            |
| W-4        | `e2cb7dd9`              | `7a683476` | 8         | 8 FAIL / 878 PASS(10 skip)  |

W-2의 35행은 `074c0f70`이 정정한 기록(Worker 묶음 26 FAIL, `live-pro-room-smoke-readiness` 9 FAIL)과 같고, W-3의 19행은
`430da8c6` 메시지(Worker 묶음 12, smoke 파일 7)와 같다.

### 4. 열차 끝 리뷰 반영 (`a0b858fc` 런타임, 2026-10-27 01:55 ~ 02:15 KST)

열차 끝 리뷰의 safety 렌즈와 quality-docs 렌즈가 `4f6be4c8`을 봤다. 반영한 것과 반영하지 않은 것:

- **safety medium(반영):** W-2가 PIN이 든 대기 이전 레코드를 버린 근거('길어야 15분')가 틀렸다. 테스트 `d5385500`, 코드
  `a0b858fc`(W-2 절의 대기 이전 레코드 항목). 이 보고서와 release-record §2의 '15분' 문장을 고쳤다.
- **safety low·quality-docs low(반영):** 혼합 버전 saga가 옛 요청 방향을 잃은 것. `b3f9c69d`가 9.0.14 빌드 `dd9c9d4d`를
  양방향으로 더했고(RO-09), 아래 표와 혼합 버전 절에 적었다.
- **safety low(반영):** 기록 PR이 §1에 배포 전 SHA를 적을 수 있던 문장. release-record W 항목과 이 보고서의
  기록·레지스트리가 §1은 이 릴리스의 머지된 main SHA, `dd9c9d4d`는 배포 전 checkpoint이자 되돌리기 대상이라고 적는다.
- **quality-docs low(반영):** release-record §2 소유권 이전 항목의 '이 변경' 지시어(이제 '소유권 이전 입장 암호 끄기')와 W
  문장의 시제(배포되면), 두 공유 PRO 고정값의 opt-in 머리글 주석(`b3f9c69d`, App이 계속 보내고 PRO가 읽지 않음), 기록의 테스트
  먼저 문장(W-2는 `074c0f70`을 얹음).
- 반영하지 않은 것은 없다. 운영 저장소 확인(safety medium의 다른 선택지)은 레코드를 남기는 쪽을 골라 하지 않았다.

| 검사           | 결과와 범위                                                                                                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저    | `d5385500`의 `pro-room-worker.test.ts`를 `4f6be4c8`의 PRO 코드에서 돌리면 2 FAIL / 478 PASS. FAIL은 새 두 행(올바른 모양의 PIN, 잘못된 모양의 PIN)이고 `ownerTransferReconciliation`이 null이다. `a0b858fc` 뒤 PASS.                                                                                              |
| 혼합 버전 saga | `owner-transfer-saga-mixed-version-sqlite.test.ts` 14/14 PASS(Phase 0d·Phase 1 빌드 각 5행, 9.0.14 빌드 4행. 9.0.14 빌드는 `git show`로 그 SHA를 묶어 실제로 돌았고 skip 없음). 새 행은 런타임 변경이 없어 테스트 먼저 대상이 아니다.                                                                             |
| 단위 전체      | `vitest run --maxWorkers=6` 680 files / 16,069 tests PASS(라운드 2의 16,065에서 새 혼합 버전 4행).                                                                                                                                                                                                                |
| Worker 단위    | `vitest run --config vitest.workers.config.ts --maxWorkers=6` 67 files / 3,180 tests PASS(라운드 2의 3,176에서 같은 4행).                                                                                                                                                                                         |
| 정적           | `tsc --noEmit`, `typecheck:tests`, `check:workers`(Worker 타입, declaration-ownership, D1 마이그레이션, ops-drift-contract), lint, `format:check` PASS.                                                                                                                                                           |
| 가드           | dead-exports(테스트 전용 20/20, 자기만 76/76, 내보낸 binding 2,103), import-graph, bus-pairing 202/202, lifecycle-writes, room-authority-boundaries(직접 읽기 82·구독 22·쓰기 13), transport-health PASS. `check-resource-ownership` 출력은 `dd9c9d4d`와 바이트가 같다(48 records / 442 files). 기준치 변화 없음. |
| SKIP           | `build:checked`와 브라우저 검사(App 런타임 입력이 바뀌지 않음. 라운드 2 결과 그대로), Worker 번들 크기 다시 재기(PRO 정규화 몇 줄), 실제 기기, 운영 Cloudflare.                                                                                                                                                   |

## 혼합 버전

이 릴리스는 Worker만 바꾸고 App 정적 자산은 운영 9.0.14와 같다(진입 청크 `main-CaKT24Ie.js`가 9.0.14 릴리스 smoke의
generation과 이름이 같다). 아래 '지금 클라이언트'는 바닥 787 이상이다.

| 조합                                           | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.0.14 App, 릴리스 W Worker                    | 요청과 답이 그대로다. App은 이미 PRO opt-in 머리글 둘, presence/close의 세 필드, PIN 두 필드를 실은 `host-auth`와 `pinMutationId`를 실은 room-password-set, 확인서를 실은 v3 Remote Share 본문, `{claimToken, requestId}` 이전 본문을 보내고, 관리자 페이지는 다섯 필드 공지 본문을 보낸다. 지운 끝점(`/effects`, ACK, `DELETE /sessions/current`, `/api/youtube-playlist-entry`)을 부르는 곳이 없다. App 파서는 `passwordRequired`와 `playlistSlots`를 계속 선택으로 받는다(OV-A22는 열차 3 후보).        |
| 다음 App 릴리스(5B, 릴리스 A), 릴리스 W Worker | 같다. 릴리스 A가 r2-client의 `optional` 받기를 지우는데, 운영 Remote Share는 `required`이고 W-1 뒤로 `optional`은 무효 설정이다.                                                                                                                                                                                                                                                                                                                                                                           |
| 787 아래 탭                                    | 새 입장과 재접속은 바닥이 먼저 거절한다. fail-open 창(위 바닥이 거르지 못하는 곳)에서는 각 증분의 '잃는 것'이 그 탭에 일어난다.                                                                                                                                                                                                                                                                                                                                                                            |
| 9.0.14 App, W 앞으로 되돌린 Worker             | 그대로다(각 증분의 되돌리기). 예외는 PRO만 W-2 앞으로 되돌리고 App Worker를 W-4에 둔 조합의 이전 링크 답(W-4 표).                                                                                                                                                                                                                                                                                                                                                                                          |
| 9.0.14 App Worker와 W-4 App Worker의 saga 행   | 배포와 자동 복구 동안 두 App Worker가 같은 이전 saga 행을 나눈다. W-4는 facade만 바꿨고(opt-in 머리글을 commit에 넘기지 않음, `newPin` 본문은 의도 전에 거절) saga 꼬리와 행 모양은 같다. `b3f9c69d`의 혼합 버전 행이 9.0.14(`dd9c9d4d`) 빌드의 요청과 지금 cron, 지금 요청과 9.0.14 cron을 한 행에서 돌린다: commit 뒤와 성공 감사 뒤의 겹침은 성공 행 하나(D3)이고, 대상 계정 삭제로 끝나는 요청도 한 버전과 같다. Phase 0d·Phase 1 빌드는 cron 쪽만 남는다(그 요청은 PRO가 거절하는 `newPin`을 싣는다). |
| 운영자의 smoke와 floor 도구                    | W 뒤 Worker와 W 앞 Worker(9.0.14) 모두에서 같은 답을 받는다. PRO 카나리아는 머리글을 보내 두 Worker가 같은 답을 하고, 9.0.14 Signaling은 PIN 두 필드를 선택 키로 받는다. Signaling을 9.0.14 아래로 되돌리면(절차 밖) 두 원인을 적고 즉시 실패한다.                                                                                                                                                                                                                                                         |

## 건너뛴 것과 맡을 열차

| id 또는 항목               | 무엇                                                                                                                                                | 이유                                                                                                                                               | 맡을 열차                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| SK-11                      | 범위 없는 계정 쿠키 읽기(`cloudflare/account-auth.ts`)                                                                                              | 날짜 조건(2026-11-07 KST 이후)                                                                                                                     | 그 날짜 뒤의 열차 3 또는 따로 App Worker 릴리스 |
| SK-12 짝                   | Vite 개발 프록시의 `/api/youtube-playlist-entry`와 그것을 적은 `docs/configuration-reference.md`, `CONTRIBUTING.md`                                 | `vite.config.ts`가 SW 캐시 가드 입력이라 이 릴리스에 넣으면 bump와 업데이트 창이 생긴다                                                            | 릴리스 A(A-6 bump)                              |
| OV-F08                     | 신호 Worker의 생존·확인서·PIN 멤버 광고 중단(`workerVersionId`는 남김)                                                                              | 클라이언트가 광고 없이도 동작하는 릴리스 A(OV-A19)와 그 바닥이 먼저다. `live-remote-share-smoke.ts`가 확인서 표지를 요구해 같은 PR에서 고쳐야 한다 | 열차 3                                          |
| presence/close 보내기      | App의 `baseRevision`, `currentQueueItemId`, `playback` 보내기 중단                                                                                  | 받는 쪽(W-2)이 운영에 있고 기록된 뒤. PRO를 W 아래로 되돌리면 close가 400이 되므로 그 롤백 경계 문장을 같은 PR에서 적는다                          | 열차 3                                          |
| presence/close Worker 검사 | PRO의 세 필드 검사 자체                                                                                                                             | 보내는 클라이언트가 바닥 아래로 사라진 뒤                                                                                                          | 열차 4 이후 또는 남김                           |
| PRO opt-in 머리글          | 클라이언트의 머리글 보내기 중단                                                                                                                     | 비용 0이고, 그만 보내려면 PRO 롤백 표지 낱말이 필요하다                                                                                            | 열차 4 이후 또는 남김                           |
| OV-A22                     | 클라이언트가 `passwordRequired`·`playlistSlots`를 필수로 받기                                                                                       | 모든 스냅샷 운반 경로가 두 필드를 싣는다는 특성화가 먼저다(W-2 뒤 가능)                                                                            | 열차 3 후보                                     |
| `publicEffects`            | PRO 효과 공개 투영                                                                                                                                  | Developer API 효과 읽기가 쓴다(옛 버전 호환이 아님)                                                                                                | 남김                                            |
| Remote Share 남김          | `workerContractVersion` 3과 표지, `/security-config` 두 필드, null `clientRequestId` 허용                                                           | 지금 클라이언트의 계약이거나 저장 상태 호환이다                                                                                                    | 남김                                            |
| PRO 남김                   | 저장 `coordinatorParticipantId` 키(null), 재생 영수증 `kind` 표지, KV 공지 이주                                                                     | 부모 Worker로 되돌릴 때의 안전과 저장 상태 호환이다                                                                                                | 남김                                            |
| Signaling 남김             | 같은 PIN 재전송, open 뒤 PIN 확인 울타리, restart offer의 `iceRestartVersion` 요구                                                                  | 지금 클라이언트의 재접속 동작이고, `restartOf`와 함께 표지를 요구하는 것은 Worker와 방장의 계약이다(OV-F04 2단계도 남김)                           | 남김                                            |
| App 쪽 항목                | OV-F01~F06(F04는 1단계, F06은 `FILE_R2_CAPABILITY`), A12 나머지, A18~A20, A23, B09(말만), SK-05, Q4 받는 쪽, 받기 허용 정리, known-accepted #12·#15 | App 파일과 업데이트 창이 필요하다                                                                                                                  | 릴리스 A                                        |
| 5B 몫                      | OV-A04, B05, B06, SA-9, 시스템 오디오 OV-A08, OV-A03 코디네이터 잔재                                                                                | Phase 5 5B 파일                                                                                                                                    | 5B                                              |

## 계획과 달라진 것

- 브랜치 이름은 계획의 `agent/ovr-2-workers`가 아니라 `agent/old-version-removal-2w`다.
- 계획은 W-4에 `docs/configuration-reference.md`와 `CONTRIBUTING.md`를 넣었지만 두 문서는 Vite 개발 프록시 목록을 적으므로
  그 줄을 지우는 릴리스 A로 옮겼다(`110ac9dd` 메시지).
- 계획이 다루지 않았던 PIN이 든 대기 이전 레코드(9.0.4 전 PRO Worker만 씀)를 W-2는 처음에 claim 수명(길어야 15분)을 근거로
  지웠다. 열차 끝 리뷰가 그 근거가 틀렸음을 찾았다(만료된 대기 레코드는 지우는 곳이 없고 이전 소유자 연결을 들고 있다).
  `a0b858fc`가 레코드를 남기고 PIN만 읽지 않고 버린다(W-2 절).
- 계획이 이름 대지 않은 registry 두 기록을 고쳤다: RO-07(재시도 없는 레인의 대기 자리 수, `/effects`와 함께 하나가 사라짐)과
  RO-09(혼합 버전 saga 근거 줄). RO-50은 계획대로 고칠 문장이 없었다.
- 계획은 `benchmark-pro-room-heartbeats.mts`를 '고치거나 은퇴'로 두었고 고쳤다(2026-07-19 기준 Worker에만 옛 활성화 본문).
- W-3의 floor 도구는 계획대로 'deploy signaling first'를 지웠고, 리뷰 반영으로 실패 문장이 두 원인을 함께 적는다.
- 신호 smoke 출력의 `appBuild.hostAuthShape`가 사라져 hotfix 절차의 첫 바닥 증명 문장을 고쳤다. 계획의 기본값대로 함수 이름과
  `legacyCompatibility.refusedBelowAppBuildFloor`는 그대로이고 `LEGACY_SHAPE_FUNCTIONS`도 맞다.

## 기록·레지스트리

- **registry:** RO-07과 RO-09를 W-2 커밋(`6812c8b1`, `4e86ab7d`)에서 고쳤고, RO-09 혼합 버전 줄을 열차 끝 리뷰 반영
  `b3f9c69d`에서 다시 고쳤다(9.0.14 빌드 양방향). 새 기록은 없다(이 릴리스는 새 복구·재시도·타이머 흐름을 넣지 않는다).
  `check-resource-ownership` 출력은 증분마다, 그리고 리뷰 반영 뒤에도 부모와 바이트가 같다(48 records / 442 files).
- **기준치:** room-authority-boundaries(직접 읽기 82, 구독 22, 쓰기 13), dead-exports(20/20·76/76), bus-pairing(202/202),
  `check-resource-ownership`, transport-health 모두 바뀌지 않았다. 올리거나 내린 것이 없다.
- **known-accepted:** 바꾸지 않았다. 계획이 이 열차에서 고치는 #12('Older Worker' 다시 쓰기, 'Older App copy' 지움)와 #15(은퇴)는
  App 쪽 문장이라 릴리스 A(A-3, A-5)가 맡는다. 이 릴리스는 그 문장들이 말하는 App 동작이나 9.0.4 아래 PRO 롤백 경계를 바꾸지
  않는다. #5는 일반방 P2P 문장이라 해당이 없다.
- **release-record:** §2에 이 릴리스의 배포 전 항목을 더했다(이 보고서 커밋). §2 PRO 소유권 이전 항목은 W-2·W-4 커밋이 고쳤고 이
  보고서를 가리킨다. §1과 `Last source review`, `release-history.md` 행은 배포 기록 PR이 쓴다. §1의 Worker마다 배포된 기준은 이
  릴리스의 머지된 main SHA이고, `dd9c9d4d`는 배포 전 checkpoint이자 되돌리기 대상으로만 적는다. 그 PR은 §4에 이 릴리스의 되돌리기
  경계(PRO만 W-2 앞으로 되돌릴 때의 이전 링크 답, Signaling을 9.0.14 아래로 되돌리면 smoke와 floor 도구가 즉시 실패)를 더하고,
  §4 'PRO 공개방 입장 보호' 문단의 '다시 앞으로 배포하면 공유 원장의 presence-close 영수증은 로드할 때 해제' 문장을 W-2 뒤 동작(보통의
  prune이 푼다)으로 고친다.
- **문서:** `pro-room-architecture-and-operations.md`, `cloudflare/remote-share-ops.md`, `cloudflare/admin-dashboard-ops.md`,
  `docs/hotfix-procedure.md`(첫 바닥 증명 문장)를 증분 커밋에서 고쳤다. 날짜 보고서는 고치지 않았다(강제 업데이트 보고서의
  `hostAuthShape`와 옛 Worker 재시도 문장은 그 열차의 근거로 남긴다).

## 초기 JS와 Worker 번들

**App.** App 런타임 입력(테스트 밖의 `src/`, `browser/`, `public/`, `css`, `index.html`, `vite.config.ts`, 자산 스크립트)은 바뀌지
않았다. 레인 검사의 production 빌드에서 초기 전송 예산은 진입 842.2 KiB raw / 247.8 KiB gzip, 초기 JS 455.9 KiB gzip, 초기 전체
2,002.4 KiB raw / 532.6 KiB gzip이고 5% 예비선을 지켰다. 진입 청크 `main-CaKT24Ie.js`는 운영 9.0.14 릴리스 smoke의 generation과
이름(내용 해시)이 같고, 9.0.14 보고서의 bump `2077ef60` 값(초기 JS 466,874 B, 진입 253,786 B gzip)과 KiB 반올림 안에서 같다. 초기
JS 변화는 0이다.

**Worker 번들.** `wrangler deploy --dry-run`의 Total Upload를 같은 기계에서 부모 `dd9c9d4d`와 `110ac9dd`의 `git archive`로 쟀다(App
Worker는 빈 `dist`로 묶음. 레인 검사의 실제 `dist` 실행과 같은 값).

| Worker               | `dd9c9d4d`                   | `110ac9dd`                   | 차이                        |
| -------------------- | ---------------------------- | ---------------------------- | --------------------------- |
| PRO room             | 827.11 KiB / gzip 159.62 KiB | 814.28 KiB / gzip 157.75 KiB | −12.83 KiB / gzip −1.87 KiB |
| remote-share         | 152.03 KiB / gzip 33.82 KiB  | 150.40 KiB / gzip 33.39 KiB  | −1.63 KiB / gzip −0.43 KiB  |
| signaling            | 392.42 KiB / gzip 81.37 KiB  | 391.51 KiB / gzip 81.13 KiB  | −0.91 KiB / gzip −0.24 KiB  |
| App                  | 990.27 KiB / gzip 201.64 KiB | 984.42 KiB / gzip 200.76 KiB | −5.85 KiB / gzip −0.88 KiB  |
| Developer API facade | 94.26 KiB / gzip 21.08 KiB   | 94.26 KiB / gzip 21.08 KiB   | 0                           |
| Developer API        | 135.35 KiB / gzip 30.43 KiB  | 135.35 KiB / gzip 30.43 KiB  | 0                           |

## 배포·회복

**배포 조건.** 계획의 순서 규칙을 따른다. 강제 업데이트 열차의 첫 최소 빌드 기록(#499)이 머지됐고 바닥 787이 켜져 있다(OV-F07이
기댐). main에 배포 안 된 App 소스가 없을 때만 낸다(target `all`은 main의 App도 함께 배포한다). 이 PR은 배포 직전에만 머지하고, 그
머지부터 배포와 기록 PR 머지까지 5B와 릴리스 A는 머지하지도 릴리스하지도 않는다. 반대로 이 PR이 main에 있고 배포되지 않았으면
두 App 열차(target `app`)가 부분 릴리스 게이트에서 거절된다. 먼저 나간 열차가 배포·기록되면 다른 열차는 origin/main을 합치고 전체
단위, 가드(room-authority 총합을 다시 잼), 빌드와 예산을 다시 돈 뒤 머지한다. 이 갈래는 머지 전에 origin/main `9e02d2df`(#499,
문서만)를 합친다. 이 릴리스를 App 릴리스 A보다 먼저 낸다(위 바닥이 거르지 못하는 곳). 5B와의 앞뒤는 어느 쪽이든 된다.

**배포 직전.** 릴리스와 같은 동시성 그룹에 아무것도 돌거나 기다리지 않을 때 `app-build-floor.yml` `status`를 돌려 저장값과 유효값이
787 이상이고 live App 보고가 새것인지 보고, 그 요약 줄을 기록 PR에 적는다.

**배포.** Production Release target `all`, Developer API D1 `false`, `raise_app_build_floor` `false`. Worker 순서는 PRO room, remote-share,
signaling, Developer API facade, Developer API, App이고 각 Worker 뒤에 그 smoke가 돈다([hotfix 절차](../hotfix-procedure.md)의 Worker
scope and order). smoke는 이 체크아웃의 빌드 787을 실으므로 바닥 787 아래로 거절되지 않는다. 부분 배포 동안의 조합도 지금
클라이언트에 영향이 없다: remote-share smoke는 아직 9.0.14인 Signaling에 PIN 필드와 `appBuild`를 실어 입장하고, 새 PRO 뒤의 옛 App
facade는 opt-in 머리글을 넘기거나(PRO가 무시) `newPin` 본문을 넘기며(PRO가 거절, 9.0.0~9.0.3만 보냄), App HTTP 다리는 새 Signaling에
프레임을 그대로 넘긴다. 업데이트 창은 없다. signaling smoke 503으로 실패·자동 복구되면 코드를 의심하기 전에 같은 SHA로 다시
dispatch한다(앞선 `all` 릴리스의 경험).

**덤으로 생기는 근거.** 이 릴리스의 신호 smoke는 바닥 787이 켜진 운영에서 빌드 787 방장·게스트 입장과 빌드 없는 방장의 정확한
거절(`legacyCompatibility.refusedBelowAppBuildFloor` 787)을 처음 본다(9.0.14 릴리스 smoke는 바닥 0일 때였다). W-3 Signaling Worker
위의 결과이므로, 기록 PR은 그것을 release-record §2 강제 업데이트 항목의 'Signaling의 787 입장' 근거로 인용할 수 있다.

**배포 직후 floor 도구 운영 확인(W-verify).** `check`는 증명을 돌리지 않고 `set`은 먼저 바꾸고 나중에 검증하므로, W-2·W-3에서 고친
증명을 열차 3의 바닥 올리기에서 처음 돌리면 증명이 틀릴 때 올린 바닥이 검증 없이 남는다. 그래서 Release run과 smoke가 끝난 뒤(같은
동시성 그룹, 기록 PR 전) `app-build-floor.yml` `set min_app_build=787`을 같은 값으로 돌린다. 저장값이 같으므로 'the stored floor is
already 787; verifying it'만 남기고 `verifyFloor`(머리글을 보낸 PRO 카나리아 쌍, PIN 필드를 실은 Signaling 탐침의 786 거절, cron
보고, 클라이언트 읽기)만 돈다. 상태를 바꾸지 않는 검증이라 묻지 않는다. run ID와 요약 줄을 기록 PR에 적는다. 실패하면 바닥은 787
그대로이고, floor 도구를 앞으로 고친 뒤 같은 실행을 다시 한다. 열차 3의 올리기는 이것이 통과할 때까지 하지 않는다.

**되돌리기.** 코드 되돌리기가 기본이다. Worker만 바뀐 revert는 SemVer와 SW 캐시를 올리지 않아도 된다. 급할 때의 Cloudflare 되돌리기는
checkpoint(9.0.14 `dd9c9d4d`의 여섯 Worker)로 할 수 있고, 증분마다의 경계는 각 표의 '되돌리기' 행과 같다. 한 Worker만 되돌릴 때의
예외는 PRO만 W-2 앞으로 되돌리고 App Worker를 W-4로 두는 조합이다(둘을 함께 되돌리거나 앞으로 고침). 이 릴리스는 계약 표지, 새 바닥,
D1, 비밀, 바인딩을 바꾸지 않는다. 지운 저장 이주의 대상 기록은 모두 만료됐고, 부모로 되돌리면 그 이주가 돌아올 뿐이다. 기존 경계는
그대로다: App을 저장 바닥 아래로 되돌리기 전에 `lower`, 9.0.14 이상 App이 live인 동안 Signaling을 9.0.14 아래로 되돌리지 않음, PRO를
9.0.14 아래로 되돌리면 모든 Worker의 바닥이 꺼짐, PRO 입장 정책 표지가 PRO·App의 9.0.4 아래 자동 복구를 막음.

**실패한 이 릴리스의 자동 복구.** 자동 복구는 App을 먼저, PRO를 마지막에 되돌린다. 그 사이 옛 App Worker와 새 PRO, 또는 새 Signaling과
옛 App Worker가 섞이는 창은 위 배포 문단과 같아 지금 클라이언트에 영향이 없다. smoke와 floor 도구는 되돌린 Worker에서도 같은 답을 받는다.

## 확인하지 않은 것

- 운영 배포, 운영 release smoke, 배포 직전 floor `status`와 배포 직후 같은 값 `set`(위 배포·회복). 이 보고서의 결과는 모두 로컬이고
  exact-main-SHA 후보를 대신하지 않는다.
- 실제 기기, iOS·WebKit, 브라우저의 PRO 방과 Standard 방을 이 Worker 코드로 돌리지 않았다. 운영 방장 암호 흐름(설정, 모두 재입장)과
  PRO 탭을 닫은 뒤 참가자 목록에서 바로 빠지는지(presence/close)는 배포 뒤 확인 후보다.
- 실제 787 아래 탭이 지운 모양에서 받는 답(각 표의 '잃는 것'은 코드와 단위 테스트에서 끌어냄)과 바닥 fail-open 창.
- 지운 PRO 저장 이주 셋의 대상 기록이 운영 저장소에 남아 있지 않다는 것은 배포 날짜와 TTL에서 끌어냈고 저장소를 열어 보지
  않았다. PIN이 든 만료 대기 이전 레코드가 운영에 있는지도 보지 않았다(`a0b858fc`가 그 레코드를 남기므로 결과가 같다).
- Signaling 배포가 Durable Object를 다시 시작해 Standard 신호 소켓이 다시 붙는지(Cloudflare 문서상 동작).
- C5-0 랩과 강제 업데이트 랩을 이 Worker 코드로 돌리지 않았다. W-3의 신호 흐름은 로컬 `wrangler dev`에서 smoke 프레임으로만 봤다.
- PRO Worker와 Remote Share Worker를 로컬 `wrangler dev`로 띄워 보지 않았다(Worker 단위와 `node:sqlite` 실제 PRO room 행뿐).
- Developer API live smoke의 명령 상태 조회가 W-2 뒤에 받는 실제 상태는 운영에서 보지 않았다(smoke는 200만 요구하고, 단위와 PRO
  Worker 행이 서버 혼자 끝나는 명령을 고정한다).
- 업데이트 창이 없는 target `all` 릴리스(App 식별 그대로)는 절차상 허용이고 dry run하지 않았다.
- 열차 끝 리뷰는 `4f6be4c8`을 봤고, 그 지적은 QA 라운드 4에서 반영했다. 반영 커밋을 다시 리뷰하지는 않았다. W-1과 W-4에는
  구현 중 리뷰 반영 커밋이 없다.

운영 데이터나 서비스에 장애를 주입하는 검사는 하지 않았다.

관련 계약: [PRO 방 구조와 운영](pro-room-architecture-and-operations.md), [자원 소유권](resource-ownership-registry.md)(RO-07,
RO-09, RO-50), [Remote Share 운영](../../cloudflare/remote-share-ops.md), [관리자 대시보드 운영](../../cloudflare/admin-dashboard-ops.md),
[최소 앱 빌드 운영](../hotfix-procedure.md#app-build-floor), [강제 업데이트 보고서](forced-update-9-0-14-2026-10-25.md),
[구버전 제거 열차 1 보고서](old-version-removal-1-2026-10-25.md), [현재 릴리스 기록](../release-record.md).
