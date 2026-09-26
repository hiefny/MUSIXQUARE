# 베타 결함 일괄 발굴 2차 — 2026-09-27

| Field | Value |
| --- | --- |
| Status | Dated evidence — 발견·재검증만 수행, 제품 수정 없음 |
| Applies to | B01–B04 수정 이후 `mxqr_beta`의 추가 결함 수집 |
| Tested checkout | `63516859147008282104c5bd52d237fe9273e51b` |
| Runtime source baseline | `b833e2a62bd7eceaa1c9a074d463a36477b514e4` — 이후 차이는 문서 |
| Environment | Windows, Node 24.20.0, Vitest 5, jsdom·SQLite·가상 타이머 |
| Related documents | [배포 준비 기록](../beta-release-readiness.md), [1차 발굴](beta-defect-harvest-2026-09-27.md), [B01–B04 수정](beta-defect-repair-2026-09-27.md) |

재생·전송, 방·권한·YouTube, 데모·UI·설정, 계정·번역·서비스 워커를
병렬 조사했다. 제품 코드와 추적 테스트는 바꾸지 않았으며, 독립 검토와
재현을 거친 **새 확정 결함은 3건**이다. B01–B04를 다시 세지 않았다.
이전 감사에서 미확정이었던 PRO 공유 종료 복귀를 추가 입증했으며,
프리로드는 이전 버퍼 정리 가설과 다른 타이머 결함을 확인했다.

## 확정 목록

아래 세 건은 이 기록 시점에 모두 미수정이다. 우선순위는 발생 조건과
영향을 고려한 작업 순서이며, 운영 발생 빈도를 측정한 값이 아니다.

| ID | 영역 | 조건과 영향 | 우선순위 |
| --- | --- | --- | --- |
| C01 | PRO 시스템 오디오 → YouTube 복귀 | 공유를 종료해도 이전 영상이 재개되지 않으며 앱 재생 상태와 실제 플레이어 상태가 어긋남 | P2 |
| C02 | 일반방 직결 프리로드 | END가 청크보다 먼저 도착하고 잔여 수신이 10초를 넘으면, 계속 진행 중인 수신도 폐기하고 필요 시 전체 재다운로드 | P2·느린 수신 조건 |
| C03 | 번역 기여·계정 탈퇴 | 탈퇴가 확정되고 후속 정리만 대기 중인 작성자의 제안에, 로그인한 다른 사용자의 추천을 수락하고 제안 내용을 반환 | P2·탈퇴 정리 대기 조건 |

### C01 — 공유 종료 후 PRO의 YouTube 재생 재개가 빠짐

**실행 순서와 관측**

1. YouTube를 37.5초에서 재생한다.
2. 시스템 오디오 공유를 시작하고 명시적으로 종료한다.
3. 실제 `system-capture.ts`, `youtube/player.ts`, `youtube/iframe.ts`와
   네이티브 `YT.Player` 대역의 onReady/CUED 콜백을 연결한다.
4. 일반방 대조군은 `seekTo(37.5)` → `playVideo()`로 복귀한다.
5. PRO는 15초 동안 seek/play 호출 없이 실제 플레이어 대역이
   `CUED(5)`, 0초에 남는다. 앱의 activity는 `playing`으로 표시된다.

별도 실제 PRO Worker 처리기에서 큐 선택 → 공유 acquire/commit/release를
실행하면, 공유 이전의 `playing` checkpoint와 revision은 그대로 유지된다.
이미 그 checkpoint를 적용한 실제 클라이언트 runtime에 동일 revision의
후속 heartbeat를 세 차례 전달해도 추가 media prepare/commit이 없다.
따라서 단순히 다음 상태 조회를 기다리면 정상 재개된다는 대조 가설은
이 경로에서 성립하지 않았다.
새 사용자 조작이나 화면 복귀에 따른 별도 복구까지 불가능하다는 뜻은 아니다.

**원인 경로**

- [system-capture.ts](../../src/audio/system-capture.ts)의
  `restorePreSystemAudioPlaybackState`가 PRO에서도 기존
  `youtube:restore-room-playback` 이벤트를 보낸다.
- [player.ts](../../src/youtube/player.ts)의 해당 처리기는
  `autoplay:false`로 영상을 cue한 뒤 기존 자동 싱크를 예약한다.
- 같은 파일의 `scheduleYtAutoSync`는 PRO 권한을 보호하기 위해 즉시
  반환한다. 이 보호 자체가 문제라기보다, 복귀 동작이 PRO 재생 경로로
  연결되지 않은 것이 문제다.
- [iframe.ts](../../src/youtube/iframe.ts)의 PRO 분기는 기존 일반방
  heartbeat도 실행하지 않는다. [PRO runtime](../../src/pro-room/runtime.ts)과
  [재생 controller](../../src/pro-room/playback-controller.ts)의 동일 checkpoint
  중복 적용 방지도 이 로컬 중단을 자동 복구하지 않는다.

공유 종료의 재생 의도를 PRO의 권한·timeline과 일치시키는 수정이 필요하다.
PRO에서 기존 일반방 자동 싱크를 무조건 허용하는 수정은 적절하지 않다.
로컬 파일을 paused로 복원하는 기존 정책은 이 결함에 포함하지 않는다.

**검증 한계:** 실제 capture/restore/iframe 어댑터·Worker·runtime을 층별로
검증했으나, 네이티브 화면 캡처·YouTube iframe·네트워크는 대역이다.
두 실기와 실제 SFU를 연결한 전체 E2E나 운영 발생 빈도를 검증한 것은 아니다.

### C02 — 프리로드가 진행 중이어도 END 기준 10초에 폐기됨

실제 `schedulePreload` → `pumpChunksToPeers` 방송 경로와
`unicastPreload` 늦은 입장자 경로에서 각각 wire trace를 생성했다.
실제 CloudflareDataConnection의 인코딩·채널 선택, protocol 처리기,
RAM 저장소를 사용하고 네이티브 RTC 전달 시점만 조절했다.

| 시간 | 관측 |
| --- | --- |
| 0초 | control 채널의 PRELOAD_START와 PRELOAD_END 도착 |
| 4초·8초 | bulk 청크가 차례로 도착하여 2/4까지 정상 진행 |
| 10초 | deferred END watchdog이 세션을 skipped로 만들고 저장 버퍼 폐기 |
| 12초·16초 | 뒤의 유효 청크 도착, 이미 skipped여서 무시 |
| 18초 | 해당 곡을 이미 선택한 경우 실제 재생 대기기가 `REQUEST_DATA_RECOVERY`, `nextChunk:0` 요청 |

송신 경계가 허용하는 잔여 256KiB, 즉 64KiB 청크 네 개를 사용했다.
청크당 4초는 약 16KiB/s 수신에 해당한다. 채널 내부 순서를 뒤집거나
패킷 손실·잘못된 데이터를 주입하지 않았다. 서로 다른 RTC 채널 사이의
순서가 보장되지 않는 상황을 구현한 재현이다.

**대조군:** 두 송신 경로 모두 청크당 2초이면 완료한다. 청크당 4초여도
END가 bulk 뒤에 도착하면 완료한다. 두 조기 END 사례만 정상 완료 기대치에
실패한다. 이미 현재 곡으로 선택한 사례는 전체 재다운로드 관측을 별도로 확인했다.

**원인 경로**

- [cloudflare-signaling.ts](../../src/network/transport/cloudflare-signaling.ts)의
  `isBulkPayload`는 파일 종료 메시지 두 종류를 bulk로 보내지만
  `PRELOAD_END`는 control로 보낸다.
- [preload.ts](../../src/storage/preload.ts)의 `handlePreloadEnd`는 미완료
  수신에 고정 10초 타이머를 걸고, `drainPreloadReorderBuffer`는 진행 시
  별도 15초 progress watchdog만 갱신한다. END 타이머는 계속 살아 있다.
- 세션 폐기 뒤에는 [playback.ts](../../src/player/playback.ts)의
  AWAITING_PRELOAD 복구가 실제 정지로 판단해 처음부터 파일을 요청한다.

종료 메시지의 순서와 수신 진행을 함께 다룰 필요가 있다. 송신 채널만
바꾸면 구버전 송신자의 control END를 받는 경우가 남고, 타임아웃을
없애기만 하면 끊긴 세션 정리가 사라진다. 실제 무진행 시간에 근거한
제한과 구버전 호환을 함께 검증해야 한다.

**검증 한계:** 합성 파일 청크의 조립·저장을 검사했다. MP3 디코딩·소리,
실제 느린 Wi-Fi나 iPhone을 검증한 것은 아니다. PRO의 전용 객체 다운로드는
이 청크 수신 경로를 사용하지 않으므로 같은 문제라고 확대하지 않는다.

### C03 — 탈퇴 처리 중인 작성자의 번역 제안에 추천 허용

실제 DB 스키마와 SQLite, 서명된 테스트 세션, CSRF·계정 scope 검증,
실제 탈퇴 및 번역 API 처리기를 사용했다. PRO 후속 정리 함수가 실패하는
경계만 대역으로 만들어 실제 탈퇴 API의 `202 pending` 경로에 진입했다.
이는 탈퇴 의도가 아직 미확정인 상태가 아니다. 계정은 disabled이고,
세션은 폐기됐으며 삭제 fence가 이미 저장된 상태다.

| 작성자 상태 | 새 목록의 제안 수 | 기존 카드를 본 다른 사용자의 추천 |
| --- | --- | --- |
| 활성 | 1 | 200, 정상 |
| 탈퇴 정리까지 완료 | 0 | 404, 정상 |
| 탈퇴 확정·정리 대기 | 0 | **200, 추천 저장 및 작성자 닉네임·제안 본문 반환** |

[translation-community.ts](../../cloudflare/translation-community.ts)의
`list`, `review`, `exportApproved`는 작성자 활성 상태와 삭제 fence를
확인하지만, `vote`는 추천하는 계정의 상태와 제안의 pending/approved
상태만 확인한다. `find`도 작성자 탈퇴 여부를 제한하지 않는다.
[account-auth.ts](../../cloudflare/account-auth.ts)의 durable deletion과
[탈퇴 운영 계약](../account-auth-operations.md)에 맞추려면 추천의 원자적
변경 조건과 응답 조회 모두 같은 작성자 경계를 따라야 한다.

**영향 한계:** 이전에 공개되어 있던 제안의 추천·조회가 남는 문제다.
이메일·세션 등 비공개 정보 노출을 확인한 것이 아니다. UI는 추천 후
목록을 새로 불러오므로 공개 게시판에 제안이 다시 나타난다고 주장하지 않는다.

## 검토했지만 확정하지 않은 것

- PIN 변경·관리자 해제·파일 드롭 확인창의 방 identity 고정 여부:
  후속 권한 검사는 있지만 원래 방을 고정하지 않는 경계가 있다.
  다만 확인창이 열린 채 실제로 다른 방에 들어가는 동일 문서 사용자
  경로를 입증하지 못했다. 일반 종료의 재로드를 생략한 helper 조작은
  재현 근거로 삼지 않았다.
- 이전 프리로드 버퍼 정리 가설: 다음 START가 이전 버퍼를 지우는 단순
  배열만으로는 실제 송신 순서를 설명하지 못한다. 앞선 control END와
  현재 곡 우선순위의 방어가 있어 C02와 별개의 확정 결함으로 세지 않았다.
- 늦은 검색 응답·데모 오버레이·효과 조작 중 권한 회수·채팅 금지·번역
  초안의 작업 소유권: 검토 경로와 기존 집중 테스트에서는 새 결함 미확정.
- PRO 시스템 오디오 도중 늦은 참여와 이전 재생 복구의 순서, iframe crash
  이후 복구: 추가 의심 경로이나 전체 사용자 순서의 재현이 부족해 제외했다.
- 계정 쿠키 수명, 서비스 워커, 요청 timeout·순차 commit·session cleanup:
  코드 검토와 아래 집중 검증에서 새 결함 미확정. 모든 실기·오프라인
  저장소 퇴거·장기 세션이 안전하다는 전면 보증은 아니다.

## 재현 자료와 검증 해석

로컬 재현은 Git에서 제외되는 `scratch/qa-harvest2-2026-09-27/`에 있다.
새 checkout에 포함되는 정식 회귀 테스트가 아니며, 수정 단계에서 위
조건과 관측값을 추적 테스트로 옮겨야 한다.

- C01: `rooms/system-audio-return.test.ts`, `system-audio-real-iframe.test.ts`,
  `system-audio-worker.test.ts`, `system-audio-heartbeat.test.ts` — 4파일·6관측 통과.
  이 녹색은 **잘못된 현재 동작을 관측했다는 뜻**이지 수정 완료가 아니다.
- C02: `media/preload-wire-end.test.ts` — 정상 완료 기대치 2개 실패,
  정상 대조군 3개 통과, 재다운로드 관측 1개 통과.
- C03: `root/translation-deletion.test.ts` — 탈퇴 대기 기대치 1개 실패,
  활성·탈퇴 완료 대조군 2개 통과.
- 주 검토자는 위 재현을 독립 실행하고 원인 코드를 확인했다. 번역 경계와
  PRO 복귀 경로는 추가 검토자가 별도로 검토했다.

위 신규 재현과 기존 회귀 통과 수는 합산하지 않는다. 전체 9,960개 회귀,
전체 브라우저 E2E, 원격 CI, 프로덕션 테스트를 이번에 다시 돌리지 않았다.
제품 코드가 그대로인 상태에서 선택한 기존 집중 회귀 결과를 별도로 기록한다.

| 영역 | 기존 집중 회귀 | 근거 |
| --- | --- | --- |
| 미디어·전송 | 7파일·167개 통과 | `media/focused-result.txt` |
| 방 입장·권한·YouTube 조작 | 8파일·69개 통과 | `rooms/controls.log` |
| 데모·검색·설정·채팅·번역 UI | 10파일·392개 통과 | `surface/focused-controls.log` |
| 계정·번역 API·SW·작업 수명 | 10파일·285개 통과 | `root/focused-controls.log` |

Node 24.20.0을 PATH에 두고 재현하는 명령 예시:

```powershell
node node_modules/vitest/vitest.mjs run --config scratch/qa-harvest2-2026-09-27/rooms/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scratch/qa-harvest2-2026-09-27/media/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scratch/qa-harvest2-2026-09-27/root/vitest.config.ts
```

문서만 beta에 기록하며 main·프로덕션·버전·캐시·스키마·워크플로 상태는
변경하지 않는다. 다음 수정 또는 승격 전에 C01–C03의 처리 결과를
[배포 준비 기록](../beta-release-readiness.md)에 갱신한다.
