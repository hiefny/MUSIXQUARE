# PRO 방 영수증 보관 시간 줄이기 (2026-10-27)

| Field              | Value                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 브랜치 `agent/pro-receipt-ttl`의 로컬 커밋. PR, 병합, 배포 모두 아직 없음                                                                                             |
| Base               | `origin/main` `53a66d65`(운영 9.0.17 / v790, PR #503 뒤, 최소 앱 빌드 787)                                                                                            |
| Version            | 올리지 않음. 이 열차는 UI 묶음 다음에 나가며, 앱 SemVer와 SW 캐시는 그 릴리스 준비 때 올린다                                                                          |
| Scope              | PRO 방 브라우저 영수증 원장의 보관 시간(PRO 방 Worker), 원장이 찼을 때의 재생목록 안내(App, 42개 언어), 재생 명령 시도 상수와 BOT 임대 시간을 영수증 시간 집으로 옮김 |
| Target             | `all`. App과 PRO 방 Worker 둘 다 런타임 경로가 바뀌어 부분 릴리스는 막힌다. 앱 번들이 바뀌므로 배포 때 업데이트 창이 뜬다                                             |
| Resource ownership | [RO-53](resource-ownership-registry.md#ro-53-pro-browser-receipt-ledger) 신설(`owner-in-place`), RO-52의 허용 요청자 문구에 완료 영수증 수명 연결                     |

## 문제

PRO 방 Durable Object에는 브라우저 요청의 영수증 원장(`activeRoom.idempotency`)이 하나 있고, 방의
모든 참가자가 함께 쓴다. 영수증은 같은 idempotency key로 다시 온 요청에 첫 응답을 그대로 돌려주는
기록이다. 원장은 256개로 묶여 있고, 살아 있는 영수증은 절대 밀어내지 않는다. 가득 차면 새 변경은
`ROOM_STATE_CAPACITY_EXCEEDED`(409)로 거절된다.

9.0.17까지의 보관 시간은 다음과 같았다.

- 재생목록 편집(트랙 추가·삭제·순서·정보, 파일 추가, YouTube 목록 갱신), 재생목록 전환, 트랙
  이동·복사, 업로드 완료, 파일 삭제, BOT 컨텍스트·실행: 24시간
- 예약: 예약 만료(운영 15분)
- 재생 명령: 10분(2026-10-26의 앞선 수정, 하루 종일 재생이 원장을 채우던 문제)

그래서 바쁜 방은 하루 안에 256개를 채운다. 업로드 하나가 24시간짜리 영수증 둘(완료, 재생목록
추가)을 남기므로 하루 약 128개 업로드에서, 편집만 하면 하루 256번에서 원장이 찬다. 트랙 수와
상관없다. 찬 뒤에는 트랙 삭제도 영수증이 필요해 거절되고, 대부분의 영수증이 하루 가까이 남아 있어
방이 하루 동안 편집을 받지 못할 수 있다. 앱은 이때 재생목록 작업에 "재생목록이 변경됐어요 / 다시
시도해주세요"(`playlist.mutation_retry`)를 보여 줬는데, 재생목록은 바뀌지 않았으므로 맞지 않는
안내다.

## 오너 결정

2026-10-27 오너는 256이 너무 적다고 보고 "보관 시간 줄이기"를 골랐다.

- 영수증은 앱이 같은 요청을 다시 보낼 수 있는 동안만 둔다. 영수증의 목적이 다시 온 요청을 한 번만
  적용하는 것이기 때문이다.
- 업로드 완료는 한 문서 안에서 재시도가 더 오래 이어질 수 있으므로 따로 판단한다.
- 원장이 찼을 때 보이는 문구를 고친다.

## 바뀐 것

1. **시간 집.** `cloudflare/pro-room-receipt-timing.ts`가 RO-53의 시간 값을 모두 가진다.
   요청 창 `PRO_ROOM_REQUEST_RECEIPT_TTL_MS`(2분), BOT 컨텍스트 임대
   `PRO_ROOM_BOT_REQUEST_LEASE_MS`(45초, Worker에서 옮김), 재생 명령 시도 시간
   `PRO_ROOM_PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS`(6초)와 시도 횟수
   `PRO_ROOM_PLAYBACK_COMMAND_ATTEMPTS`(2, `src/pro-room/playback-controller.ts`에서 옮겼고 그
   파일이 가져다 쓴다), 그리고 여기서 계산하는 `proRoomPlaybackReceiptTtlMs`,
   `proRoomCompletionReceiptTtlMs`. 값을 다시 적지 않으며, 순서 테스트가 클라이언트 마감과 함께
   묶는다.
2. **새 영수증의 보관 시간.** 브라우저 원장의 영수증은 범위마다 정한 수명을 넘지 못한다(아래 표).
   호출자가 더 긴 만료를 요청해도(예약 만료) 범위 수명에서 자른다. Developer, 세션 생성, 연결
   종료 원장은 그대로다. 주인은 Worker 원장 메서드이며 `browserReceiptLifetimeMs`,
   `receiptExpiresAtMs`가 새로 생겼다.
3. **완료 영수증의 이른 해제.** 재생목록이 asset을 가리키거나 asset이 더 이상 준비된 asset이
   아니면 그 완료 영수증을 지운다(`releaseSettledCompletionReceipts`). 시간이 아니라 상태로
   판단하며, 저장된 응답 본문의 `asset.assetId`를 읽으므로 영수증 모양은 바뀌지 않는다. asset GC
   조정(`reconcileAssetGarbageCollection`)이 재생목록 변경 커밋과 모든 prune마다 요청한다. 해제는
   유한한 만료(완료 시각 + GC 유예) 위에 얹은 최적화이며 만료를 대신하지 않는다.
4. **이미 있는 긴 영수증 자르기.** prune(모든 방 요청 앞, 모든 alarm)이 범위 수명보다 오래 남은
   영수증을 지금부터 범위 수명까지로 자르고 저장한다(`capBrowserReceiptLifetime`). 9.0.17이 남긴
   24시간 영수증과 롤백 동안 다시 쓰인 영수증이 첫 prune에서 줄어든다. 진행 중 삭제 영수증
   (`asset-delete-pending`)은 삭제 표시가 소유하므로 건드리지 않는다. alarm은 자른 만료를 따른다.
5. **원장이 찼을 때의 안내.** 새 토스트 키 `pro.room_state_limit`을 42개 언어에 넣었다.
   - en: "This PRO room cannot accept more changes right now / Please try again in a little while"
   - ko: "지금은 PRO 방에 변경 사항을 더 반영할 수 없어요 / 잠시 후 다시 시도해 주세요"
   - 나머지 40개 언어는 각 언어의 `pro.upload.room_state_limit` 첫 문장과
     `pro.upload.pending_limit` 둘째 문장을 마침표 없이 한 줄씩 썼다(같은 PRO 업로드 문구의 용어와
     말투). 토스트 규칙(문장 끝 마침표 없음, 문장마다 줄바꿈)을 지키고 `SHARED_TOAST_KEYS`에
     넣었다.
   - 트랙 추가(YouTube), 트랙 정보 수정, 삭제, 재생목록 전환, 이동·복사는
     `reportPlaylistError`에서, 끌어서 순서 바꾸기는 그 실패 경로에서 이 코드에만 새 문구를 쓴다.
     다른 코드의 안내는 그대로다.

## 범위별 보관 시간

같은 키 재전송 창은 앱이 같은 key를 다시 보낼 수 있는 시간이다(활성 페이지 시간 기준). 창이 지난
뒤의 재전송은 영수증이 아니라 펜스(비교 후 교체 revision, 재생 revision, asset 상태, presence)가
막으며, 두 번 적용되지 않는다.

| 범위                                                        | 이전 보관 | 새 보관                                                                                  | 같은 키 재전송 창                                                                                       | 창이 지난 뒤 같은 키 재전송                                                              |
| ----------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 재생목록 편집 `participant:<id>:snapshot`                   | 24시간    | 2분                                                                                      | 요청 하나, 15초 마감. 재생목록 관리자는 시도마다 새 key를 만들고 재사용을 거부                          | `REVISION_CONFLICT`, 아무것도 적용 안 됨                                                 |
| 재생목록 전환 `:playlist-switch`                            | 24시간    | 2분                                                                                      | 15초, 시도마다 새 key                                                                                   | `REVISION_CONFLICT`. 이미 활성인 슬롯이면 영수증 없이 스냅숏                             |
| 트랙 이동·복사 `:playlist-transfer`                         | 24시간    | 2분                                                                                      | 15초, 시도마다 새 key                                                                                   | `REVISION_CONFLICT`, 복사가 두 번 되지 않음                                              |
| 예약 `:reserve`                                             | 예약 만료 | 예약 만료와 2분 중 이른 쪽                                                               | 15초, 업로드 시도마다 새 key                                                                            | 두 번째 예약(쓰이지 않고 만료되어 정리됨). 이렇게 보내는 곳은 없음                       |
| 업로드 완료 `:complete`                                     | 24시간    | 재생목록이 asset을 가리키거나 asset이 없어지면 해제, 최대 완료 시각 + GC 유예(운영 15분) | 실패 대화상자의 다시 시도가 업로드의 RAM continuation이 살아 있는 동안 같은 key와 본문을 재사용         | `ASSET_NOT_FOUND`(404), 두 번째 복사·커밋 없음. 앱은 다시 선택 안내(`retry_unavailable`) |
| 파일 삭제 최종 영수증 `:delete`                             | 24시간    | 2분. 진행 중 영수증은 삭제 표시가 소유(그대로)                                           | 15초, 삭제마다 새 key                                                                                   | `ASSET_NOT_FOUND`, 호출자는 무시                                                         |
| 재생 명령 `:playback-authority`                             | 10분      | 2분. presence가 길게 설정되면 2 × (presence + 6초)                                       | key 하나로 최대 2회 × 6초. 멈춘 페이지는 타이머가 다시 돌 때 둘째 시도를 보내며, presence가 끝나면 거절 | `PLAYBACK_REVISION_CONFLICT` 또는 `unchanged`. presence가 끝났으면 `PRESENCE_EXPIRED`    |
| BOT 컨텍스트 `bot-context:<tokenHash>`                      | 24시간    | 2분                                                                                      | `/bot` 요청마다 한 번 보냄. execute는 45초 임대 안에 와야 함                                            | 새 BOT 실행(요청 한도 적용). BOT 추가는 BOT 자신의 24시간 Developer 영수증이 다시 재생   |
| BOT 실행 `bot-execute:<tokenHash>`(파괴적 종료 영수증 포함) | 24시간    | 2분                                                                                      | execute 한 번. 결과 중계는 요청자의 15초 마감 안에 보냄                                                 | `BOT_CONTEXT_REQUIRED`. 늦은 결과 중계는 거절(받는 쪽도 60초 뒤 버림)                    |

다른 원장은 바꾸지 않았다. Developer 변경 영수증(발급 key와 BOT 내부 key) 24시간, Developer 명령
영수증 10분, 세션 생성 영수증 10분, 연결 종료 영수증 24시간(세션과 함께 해제).

요청 창 2분은 한 요청 범위의 가장 긴 같은 key 창(BOT 임대 45초)의 두 배 이상이다. 재생은 운영
presence 45초에서 2 × (45 + 6) = 102초라 2분이 정한다. 완료는 운영 GC 유예 15분이 정한다.

용량은 다음과 같이 바뀐다.

- 편집만 하는 방: 256개가 하루가 아니라 2분 단위로 묶인다. 꾸준히 초당 2번 정도까지 받는다.
  테스트에서 10분 동안 1초마다 600번 편집해도 거절이 없었고 원장은 121개를 넘지 않았다.
- 업로드: 완료 영수증은 추가 직후 해제되므로 파일 하나는 예약 2분, 추가 2분, 완료 몇 초를 남긴다.
  순차 업로드 큐가 낼 수 있는 속도로는 원장이 차지 않는다.

## 검토에서 고친 점

설계안을 두 관점(재시도 창, 중복 적용 안전)에서 반박해 보았고, 실제 틈은 안전한 쪽으로 정했다.

- **재생의 같은 key 창은 12초가 아니다(재시도 창 검토).** 둘째 시도는 타이머가 시작하므로 멈춘
  페이지는 몇 분 뒤에도 같은 key로 보낼 수 있고, Worker는 그 기기의 presence가 끝나야 거절한다.
  presence 설정 범위(15~300초) 끝에서는 2분을 넘는다. 상태는 재생 revision 펜스로 안전했지만
  범위가 틀렸으므로, 재생 영수증 수명을 presence에서 계산하도록 했다(2분과
  2 × (presence + 6초) 중 긴 쪽). Worker가 같은 6초를 쓰도록 재생 시도 상수를 시간 집으로 옮겼다.
  순서 테스트는 presence 범위 전체와 wrangler 값을, Worker 테스트는 presence 300초에서 612초를,
  멈춘 페이지의 늦은 둘째 시도가 `PLAYBACK_REVISION_CONFLICT`로 막히는 것을 확인한다.
- **조사 문서의 틀린 문장(재시도 창 검토).** "같은 key 재전송은 15초 안의 브라우저 네트워크
  계층뿐"과 "어떤 key도 새로고침을 넘지 않는다"는 틀렸다. 앱 자체가 같은 key를 다시 보내는 곳이
  둘 있다(재생 둘째 시도는 presence까지, 업로드 완료의 다시 시도는 asset 수명까지). 세션 생성
  `requestId`는 `sessionStorage`에 남아 새로고침을 넘지만 별도 원장이라 이 열차와 무관하다.
  RO-53과 이 보고서는 이 둘을 실제 범위로 적었다.
- **BOT의 Developer 영수증은 24시간 그대로(중복 안전 검토).** 설계안은 BOT 내부 key의 Developer
  영수증도 2분으로 줄이자고 했다. 그러면 창이 지난 뒤 같은 `requestId`가 오면 새 BOT 실행이
  시작되고, revision 펜스가 없는 YouTube 일괄 추가가 두 번 들어갈 수 있다. 지금은 같은
  `requestId`를 두 번 보내는 곳이 없지만, 안전한 쪽을 골라 BOT의 Developer 영수증은 24시간으로
  두었다. 테스트가 창이 지난 뒤 같은 요청의 두 번째 실행이 아무것도 더 추가하지 않음을 확인한다.
- **완료 영수증 해제는 상태로 판단(중복 안전 검토).** 설계안은 GC 조정이 `gcAfterMs`를 지울 때
  해제하자고 했는데, 9.0.17이 이미 이름 붙은 asset에 남긴 영수증은 그 변화가 없어 15분을 기다린다.
  그래서 재생목록이 asset을 가리키는지, asset이 준비 상태인지로 판단하게 했고, 첫 prune에서
  해제된다.
- **롤백에도 끝나는 만료(중복 안전 검토).** 9.0.17은 진행 중 삭제 영수증만 특별히 다룬다.
  "이름이 붙을 때까지"를 만료 없음으로 저장했다면 롤백 뒤 영수증이 영원히 남는다. 새 영수증은 모두
  범위 최대치 이하의 유한한 절대 만료를 가지며, 테스트가 확인한다.
- **창은 활성 페이지 시간 기준(중복 안전 검토).** 늦은 재전송이 안전한 이유는 창이 아니라 펜스다.
  RO-53, 시간 집 주석, 테스트 이름에 그렇게 적었다.

## 두 번째 리뷰 반영

서버 안전과 클라이언트·문구 두 관점 모두 승인했고, 낮음 6건을 냈다.

- 되돌리기 근거가 현재 Worker의 다시 불러오기뿐: 실제 9.0.17 코드로 한 번 확인했다(아래
  "9.0.17 Worker 코드로 한 번 확인"). 옛 Worker 사본을 fixture로 커밋하지는 않았다.
- BOT 테스트의 테스트 먼저 실패를 옛 결함처럼 셈: 테스트 먼저 근거 절과 `docs/README.md`의
  문장을 고쳤다.
- 순서 테스트가 Worker의 설정값 범위와 기본값을 다시 적음: 테스트의 범위 사본이 Worker가 실제로
  받는 범위와 같은지 Worker 자신의 읽기로 확인하는 동치 테스트를 넣고, 기본값은 Worker에서 읽게
  했다(`ea220066`). 60초 예약 하한 때문에 창이 정한다는 틀린 주석도 고쳤다. Worker 테스트의 GC
  유예와 예약 시간도 Worker의 기본값에서 읽는다.
- 재생 조작에 안내가 없음: 바꾸지 않았다. 오너가 정할 일로 "바꾸지 않은 것과 이유"에 적었다.
- 같은 코드가 영구적인 원인에도 나옴: 이 열차에서는 바꾸지 않았다. "새 문구의 한계"에 재생목록
  3 MiB 예산과 나중의 구분 방법을 적었다.
- README의 BOT 24시간 문장이 앞 문장과 어긋나 보임: BOT의 브라우저 영수증(2분)과 Developer
  원장의 영수증(24시간)을 나눠 적었다(`docs/README.md`, `docs/release-record.md`).

## 되돌리기

- 새 영수증은 9.0.17이 아는 모양만 쓴다. 새 `kind`가 없고, 스냅숏 영수증은 본문이 없으며, 재생
  영수증의 `playback-authority` 표지는 그대로이고, 만료는 유한한 절대값이며, 원장은 256개를 넘지
  않는다(9.0.17은 불러올 때 256개를 넘는 방을 거절하므로 한도는 올리지 않았다).
- 9.0.17은 릴리스 W(#500) 이후 읽을 때 만료를 다시 계산하지 않으므로 짧은 만료를 그대로 지킨다.
  일찍 해제한 완료 영수증은 만료된 것과 같고, 앱은 이름이 붙은 뒤 완료를 다시 보내지 않는다.
- PRO 방 Worker를 9.0.17로 되돌리면 그동안 다시 24시간 영수증이 쌓여 예전처럼 찰 수 있다. 다시
  앞으로 배포하면 첫 prune이 그것들을 자른다.
- App만 되돌리면 옛 앱이 이 코드에 옛 토스트를 보여 줄 뿐이다. App과 Worker 사이의 통신 모양은
  바뀌지 않았다.
- 릴리스 W 이전(9.0.15 전) Worker로의 롤백은 대상이 아니다. 그래도 재생 표지는 남겨 두었다.

### 9.0.17 Worker 코드로 한 번 확인

리뷰에서 위 주장이 코드 읽기와 현재 Worker의 다시 불러오기로만 뒷받침된다는 지적이 있어,
2026-10-27 `94cb1a0b`(런타임은 `3805601a`와 같음)에서 실제 9.0.17 Worker 코드로 한 번 돌려 보았다.

- 방법: `git show 53a66d65:cloudflare/pro-room-worker.ts`를 현재 Worker 옆의 추적하지 않는 임시
  파일로 두었다. `53a66d65`와 이 브랜치 사이에 `cloudflare/`에서 바뀐 파일은 그 Worker와 새 시간
  집뿐이므로 나머지 모듈은 9.0.17과 같다. 임시 테스트 두 개를 Worker 테스트 파일의 "PRO browser
  receipt retention" 안에 넣고, 새 Worker가 쓰고 저장한 저장소 위에 9.0.17 클래스를 새로 만들었다.
  임시 클래스가 새 메서드(`browserReceiptLifetimeMs`)를 갖지 않는 것도 확인했다.
- 새 Worker가 쓴 영수증: 편집, 재생 명령, 이동·복사, 예약 3개, 이름 없는 완료(15분), 삭제 최종,
  BOT 컨텍스트·실행(모두 2분). 이름 붙은 완료와 지운 asset의 완료는 이미 해제되었다.
- 9.0.17이 불러오기: 스냅숏 200, 원장이 쓴 그대로.
- 창 안(2분 - 5초): 같은 key의 편집, 복사, 재생 명령, 삭제, 이름 없는 완료, BOT 컨텍스트가 모두
  첫 응답을 다시 돌려줬다(BOT은 `{replay}`). revision, 재생목록 revision, 재생 revision, R2 복사
  횟수는 그대로였다.
- 창이 지난 뒤: 9.0.17의 prune이 이름 없는 완료만 남기고 모두 지웠고, 늦은 편집과 복사는
  `REVISION_CONFLICT`를 받았다. 이름 없는 완료는 alarm으로 완료 시각 + GC 유예에 지워졌다.
- 새 Worker가 쓴 256개 원장: 9.0.17이 불러왔고(스냅숏 200), 편집을
  `ROOM_STATE_CAPACITY_EXCEEDED`로 거절했다가 한 창 뒤에는 받았다.
- 두 테스트 모두 통과했다. 임시 파일과 테스트는 지웠고 커밋하지 않았다. 9.0.17 Worker 사본(약
  18,000줄)을 fixture로 커밋하면 옛 코드가 lint, 타입 검사, 커버리지 대상이 되고, 옆 모듈이 바뀔
  때마다 낡으므로 회귀 테스트로 두지 않았다.

## 바꾸지 않은 것과 이유

- **원장 한도 256.** 위의 롤백 이유. 늘려야 하면 두 릴리스(먼저 불러오기, 그다음 쓰기)나 별도
  원장 필드로 한다.
- **Developer API 영수증.** 공개 계약(`public/developers/openapi.yaml`)이 변경 영수증 24시간을
  약속한다. BOT 내부 key도 위 이유로 24시간이다. BOT 사용이 많으면 BOT 영수증이 공개 API와 같은
  Developer 원장을 채울 수 있다는 관찰은 그대로 남는다(시간당 100회 한도).
- **openapi의 `IdempotencyKey` 설명.** `/commands` 영수증은 10분인데 설명은 24시간이라고 한다. 이
  열차 전부터의 불일치이며 문서만 고치는 변경으로 미룬다.
- **업로드 실패 대화상자.** 이 코드는 다시 시도 없이 "잠시 후 파일을 다시 선택해 주세요"를
  유지한다. 같은 코드가 방 코어 1.2 MiB 예산이나 revision 넘침도 뜻하므로 바로 다시 시도가 돕지
  않을 수 있다. 주석만 고쳤다.
- **재생 조작과 BOT.** 재생 명령(재생, 일시정지, 이동, 트랙 고르기, 추가 직후의 첫 트랙 자동
  선택)도 같은 원장에 `:playback-authority` 영수증을 쓴다. 원장이 차면 재생 버튼은 지금처럼
  아이콘만 되돌아가고 안내가 없으며, 첫 트랙 자동 선택은 기록만 남긴다. `/bot`은
  `chat.bot_failed`를 보여 준다. 회귀는 아니고(이전에는 몇 시간 동안 조용히 실패했다) 이제 찬
  원장은 2분 안에 풀린다. 원장에서 아무 안내도 보이지 않는 경로는 재생뿐이다. 재생 명령 실패에서
  이 코드에 `pro.room_state_limit`을 보여 줄지(순서 바꾸기와 같은 키, 같은 최신 하나 규칙)는
  오너가 정할 일로 남긴다.
- **파일 삭제 최종 영수증.** 2분짜리로 남겼다. 파일 트랙 수백 개를 한 번에 지우면 삭제마다
  영수증이 하나씩 생겨(초당 2~3개) 2분 동안 256개를 넘으면 최대 2분 동안 원장이 찰 수 있다. 실패한
  삭제는 기록만 남고 그 파일은 고아 정리가 15분 뒤 지운다. 그동안 다른 사람의 편집은 새 안내를
  본다. 최종 영수증을 없애거나 일괄 삭제를 만드는 것은 오너가 정할 일로 남긴다.
- **새 문구의 한계.** `ROOM_STATE_CAPACITY_EXCEEDED`는 방 코어 1.2 MiB 예산, 재생목록 3 MiB
  예산, revision 넘침에서도 나온다(`assertBoundedRoomState`). 원장 넘침과 같은 오류 코드로 오고
  서버의 진단 이유도 둘 다 `core`라 앱은 둘을 구분하지 못한다. 시간이 지나도 풀리지 않는 이
  경우들에서 "잠시 후 다시 시도"는 낙관적이고 다시 시도해도 계속 실패한다(#503 대화상자와 같은
  한계). 원장 넘침이 2분 안에 풀리게 되었으므로 사용자가 실제로 보는 경우에서 이 영구적인 원인의
  비중은 커질 수 있다. 예전 "재생목록이 변경됐어요"보다는 낫다. 나중에 원장 넘침에 별도 진단
  이유(필요하면 앱이 읽는 헤더)를 주면 바이트 예산 경우에는 `playlist.queue_full`이나 전용 문구를
  보여 줄 수 있다. 이 열차에서는 바꾸지 않는다.
- **곁 관찰(범위 밖).** 클라이언트는 `/bot`을 15초에 포기하지만 App BOT 파이프라인은 35초까지
  돌 수 있어, 느린 BOT 실행이 적용되는 동안 요청자는 `chat.bot_failed`를 볼 수 있다.

## 테스트 먼저 근거

테스트 커밋 `bf2f8ecc`(테스트와 아직 쓰지 않는 시간 집만)를 `53a66d65`의 런타임에 돌렸다.

- Worker 12개 실패: 영수증 보관 10개(편집 영수증 24시간, presence 300초에서 재생 영수증 600초,
  창이 지난 뒤 편집·복사·재생 명령 재전송이 409 대신 첫 응답을 다시 받음, 찬 원장이 2분 뒤에도
  409, "edit 256: expected 409 to be 200", 완료 영수증 24시간, 이름 붙은 완료 영수증이 남음,
  자르기 테스트의 완료 영수증 24시간), 고친 alarm 테스트 1개(첫 alarm이 2분이 아니라 1시간), BOT
  테스트 1개.
- BOT 테스트("keeps BOT Developer receipts for 24 hours ...")의 실패는 옛 결함의 근거가 아니다.
  `53a66d65`는 창이 지난 뒤에도 24시간 컨텍스트 영수증을 갖고 있어 같은 요청에 `{replay}`를
  돌려주고(그 자체로 한 번만 적용), 테스트 도우미 `runBot`이 그 답을 다루지 못해 임대 토큰 없이
  execute를 보내 400을 받았다. 이 테스트는 새 동작, 즉 창이 지난 뒤 시작된 새 BOT 실행의 추가를
  BOT의 24시간 Developer 영수증이 다시 재생해 아무것도 더 추가하지 않는 것을 고정한다.
- 클라이언트 9개 실패: 여섯 경로가 "The playlist changed / Please try again", 순서 바꾸기가
  "Couldn't move the track"을 보여 줌(7개), 토스트 문구 규칙의 두 테스트가 사전에 없는 새 키에서
  실패(2개).
- 통과: 순서 테스트 5개(시간 집만 고정), 다른 코드의 안내 3개. 네 파일 합계 21개 실패, 523개 통과.

런타임 커밋 뒤 모두 통과했다.

## QA 라운드 1(로컬)

- 시험한 코드: 런타임 커밋 `3805601a`(이 보고서 커밋의 부모), 로컬 Windows, Node 24.20.0.
- 통과: `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`, `format:check`, Worker 묶음
  커버리지 포함 68 files / 3,236(기준치 통과, `cloudflare/pro-room-worker.ts` 문장 87.65 · 분기
  83.87 · 함수 96.2 · 줄 91.71), `src/pro-room`과 `src/i18n` 133 files / 3,104(토스트 문구 규칙
  포함), 가드(dead-exports, import-graph 398 files·순환 0, bus-pairing 202/202, room-authority
  직접 읽기 80·구독 22·쓰기 13, resource-ownership 49 records / 444 files, lifecycle-writes).
- 전체 단위 실행(`--maxWorkers=6`): 683 files / 16,248 통과.
- 한계: 로컬 결과는 exact-main 후보가 아니다. 빌드, 초기 전송 예산, E2E는 돌리지 않았다.

## QA 라운드 2(로컬, 두 번째 리뷰 반영)

- 시험한 코드: 테스트 커밋 `ea220066`(런타임은 `3805601a`와 같고 테스트와 RO-53 문구만 바뀜),
  로컬 Windows, Node 24.20.0. 되돌리기 일회 확인은 위 절에 따로 적었다(`94cb1a0b`).
- 통과: `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`, `format:check`, Worker 묶음
  커버리지 포함 68 files / 3,237(새 동치 테스트 1개, 기준치 통과, `cloudflare/pro-room-worker.ts`
  분기 83.87 · 함수 96.2 · 줄 91.71로 라운드 1과 같음), 가드(dead-exports, import-graph,
  bus-pairing, room-authority 직접 읽기 80·구독 22·쓰기 13, resource-ownership 49 records / 444
  files, lifecycle-writes).
- 전체 단위 실행(`--maxWorkers=6`): 683 files / 16,249 통과.
- 동치 테스트가 실제로 어긋남을 잡는지: presence 범위 사본을 300초에서 600초로 바꾸면 "highest
  accepted: expected 45 to be 600"으로 실패하는 것을 확인하고 되돌렸다.
- 한계: 라운드 1과 같다(exact-main 후보 아님, 빌드·초기 전송 예산·E2E 안 돌림).

## QA 라운드 3(로컬, 빌드와 E2E 포함)

- 시험한 코드: 문서 커밋 `01341215`(런타임은 `3805601a`, 테스트는 `ea220066`과 같음), 로컬 Windows,
  Node 24.20.0 / npm 12.0.2. 비교 기준은 같은 의존성으로 빌드한 `53a66d65`(운영 9.0.17)다.
- 통과: `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`, `format:check`, 전체 단위
  실행(`--maxWorkers=6`) 683 files / 16,249, Worker 묶음 68 files / 3,237(커버리지 포함 기준치
  통과, `cloudflare/pro-room-worker.ts` 문장 87.65 · 분기 83.87 · 함수 96.2 · 줄 91.71로 라운드
  1·2와 같음), `test:coverage:critical` 88 files / 3,462(기준치 통과), `check:worker-bundles`(Worker
  6개 dry-run, PRO 방 827.25 KiB / gzip 161.89 KiB), 가드(navigation-sinks, dead-exports, bus-pairing,
  import-graph 398 files·순환 0, lifecycle-writes, release-identity, resource-ownership 49 records /
  444 files).
- `build:checked`: `guard:sw-cache-version` 한 단계만 실패했다. v790(`53a66d65`) 뒤 PWA 런타임 파일
  46개(언어 파일 42개, `src/pro-room` 4개)가 바뀌었는데 SW 캐시를 올리지 않았다는 이유뿐이며, 버전은
  릴리스 준비 때 올리므로 예상한 실패다. 이 단계만 뺀 나머지 24단계(빌드와 빌드 뒤 가드 포함)는 모두
  통과했다.
- 초기 전송: 예산 통과(entry 841.5 KiB raw / 247.6 KiB gzip, eager JS 455.9 KiB gzip, eager 전체
  2,001.5 KiB raw / 532.5 KiB gzip). main과 견주면 eager JS gzip 466,797 B에서 466,825 B(+28 B,
  유지 상한 491,568 B까지 24,743 B 남음), eager 전체 gzip +29 B이고 entry raw는 861,703 B 그대로다.
  늘어난 것은 새 영어 문구와 키(`en.js` +111 B raw, i18n 키 목록 +129 B raw)뿐이다.
- E2E(Chromium, 기본 설정): `test:e2e:critical` 65개 통과(`pro-upload-recovery` 4개와
  `critical-browser`의 PRO 입장·복구 경로 포함). PRO 묶음 30개 통과(`pro-upload-recovery` 4,
  `pro-entry-retry` 2, `pro-entry-password` 10, `pro-entry-app-update` 2, `pro-activation-account`
  12). PRO 재생목록 변경을 서버 응답으로 돌리는 E2E는 `pro-upload-recovery`의 추가 경로뿐이고, 원장이
  찬 경우의 토스트는 단위 테스트(`runtime-playlist-capacity-copy`)만 확인한다.
- 후보 E2E: 위 가드만 뺀 `build:checked`의 운영 빌드에서 `test:e2e:candidate` 19개 통과.
- Target: 운영 `53a66d65`와 견준 런타임 경로 변경(`scripts/release-deployment-state.mts`의 경로
  목록)은 App 47개, PRO 방 2개, 나머지 네 Worker 0개이고 의존성 변경은 없어 `all`이다.
- 관찰: `guard:sw-cache-version`은 `cloudflare/` 파일을 PWA 런타임으로 세지 않아, 앱이 가져다 쓰는
  `cloudflare/pro-room-receipt-timing.ts`만 바뀐 변경은 캐시 올리기를 요구받지 않는다.
  `cloudflare/pro-room-media-timing.ts`에도 있던 틈이고, 이 열차는 `src` 파일도 바꾸므로 릴리스
  준비의 올리기에는 영향이 없다. 이 열차에서는 가드를 바꾸지 않았다.
- 한계: 로컬 결과는 exact-main 후보가 아니다. SW 캐시를 올린 뒤의 `build:checked` 전체, 전체
  Playwright와 WebKit E2E, PR CI, exact-main CI, 릴리스 smoke는 돌리지 않았다.

## 확인하지 않은 것

- 운영 방의 실제 원장 상태와 배포 뒤 첫 prune이 기존 24시간 영수증을 자르는 모습.
- 9.0.17 Worker 되돌리기의 커밋된 회귀 테스트. 위 "9.0.17 Worker 코드로 한 번 확인"의 일회
  확인만 있고, 커밋된 테스트는 모양 검사와 현재 Worker의 다시 불러오기다. 운영 PRO 방 Worker를
  실제로 되돌려 보지는 않았다.
- 실제 기기에서 멈춘 페이지의 늦은 재생 재전송(가짜 시계와 presence 유지로만 확인).
- 42개 언어 문구의 원어민 검토.
- SW 캐시를 올린 뒤의 `build:checked` 전체, 전체 Playwright와 WebKit E2E, PR CI, exact-main CI,
  릴리스 smoke. 라운드 3은 SW 캐시 가드만 뺀 빌드, 초기 전송 예산, E2E 일부를 로컬에서 돌렸다.
