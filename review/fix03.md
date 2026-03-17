# Phase 3c — LOW 수정 (세션 3)

> 수정 일시: 2026-03-11
> 이전 세션: fix01.md (CRITICAL/HIGH), fix02.md (전체 리뷰 목록)
> 이번 세션: MEDIUM 잔여 + LOW 전체

---

## MEDIUM 수정 (이전 세션 이어서)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| #105 | ui/settings.ts | Reverb preset 전환 시 lowcut/highcut 슬라이더 0으로 리셋 |
| #077/#053 | ui/playlist-view.ts, youtube/player.ts | `hc.send()` → `safeSend()` |
| #011 | core/blob-manager.ts | `force` 플래그가 `_pendingRevocations.has()` 우회 |
| #032 | player/playback.ts | pending play drop 시 경고 로그 |
| #037 | player/video.ts | early return 제거 — 인라인 스타일 갱신 보장 |
| #010 | core/platform.ts | iOS viewport probe 캐싱 |
| #042 | storage/transfer.ts | backpressure per-peer concurrent (Promise.all) |
| #092 | audio/effects.ts, ui/settings.ts | EQ DOM 조작 → bus 이벤트로 분리 |

### MEDIUM Skip (아키텍처 리팩터링):
- #005: setState 참조 동등성
- #019/#085: State 직접 변이 25+ 사이트
- #006: resetState() bus 이벤트 (테스트 전용)

---

## LOW 수정 — Dead Code 제거

| # | 파일 | 수정 내용 |
|---|------|-----------|
| #089 | core/constants.ts | 4개 dead MSG 상수 제거 (STATUS_SYNC, FORCE_SYNC_PLAY, REQUEST_REVERB_RESET, SYS_TOAST) |
| #090 | core/constants.ts | 6개 unused DELAY 멤버 제거 |
| #091 | core/constants.ts, youtube/sync.ts | MSG.SESSION_START + dead 핸들러 제거 |
| #108 | types/index.ts | 4개 dead ProtocolMap 엔트리 제거 (force-sync-play, status-sync, sys-toast, request-reverb-reset) |
| #110 | audio/channel.ts, player/playlist.ts, types/index.ts | 4개 dead EventMap 리스너 제거 (audio:toggle-surround, audio:set-surround-channel, playlist:set-repeat-mode, playlist:set-shuffle) |
| #111 | core/state.ts | dead state path `sync.usePingCompensation` 제거 |
| #107 | types/index.ts | unused `ChannelMode` 타입 제거 |

## LOW 수정 — 타입 개선

| # | 파일 | 수정 내용 |
|---|------|-----------|
| #063 | types/index.ts | play/pause `state?: string` → `state?: AppStateValue` |
| #106 | types/index.ts | `oneWayLatencyMs` → `oneWayLatencySeconds` |
| #064 | types/index.ts, youtube/player.ts | `isSync` → `autoplay` (실제 의미 반영) |

## LOW 수정 — 동작 버그

| # | 파일 | 수정 내용 |
|---|------|-----------|
| #087 | app.ts | 키보드 단축키에 Ctrl/Meta/Alt 가드 추가 |
| #035 | player/playlist.ts | 이전 트랙: repeat-all 시 첫→마지막 순환 |
| #039 | player/media-session.ts | IDLE → `'none'`, PAUSED → `'paused'` 구분 |
| #059 | youtube/sync.ts | duration ≤ 0이면 drift 보정 skip |
| #095 | network/sync.ts | 세션 종료 시 latency state 초기화 |
| #030 | network/relay.ts | relay recovery에 index < 0 가드 |
| #043 | storage/transfer.ts | 세션 종료 시 fileReorderBuffer 정리 |
| #096 | network/sync.ts | setTimeout 콜백에 세션 존재 여부 체크 |
| #097 | network/relay.ts | OPFS catchup/recovery read-error 시 FILE_WAIT 전송 |
| #100 | youtube/player.ts | 플레이어 재사용 시 `_ytLoadInProgress = false` |

---

## 빌드 검증

- `npx tsc --noEmit` — 통과
- Vite dev server — 에러 없이 정상 렌더링

---

## 미적용 항목 (Info/Note — 수정 불필요)

#008, #009, #012~#016, #018, #020~#021, #024, #026~#029, #033~#034, #036, #038, #040, #044~#046, #055, #060, #065~#066, #069, #072, #076, #079~#081, #088, #093~#094, #101, #109, #112

사유: 런타임 영향 없는 코드 구조/설계 관찰사항, 또는 의도적 설계
