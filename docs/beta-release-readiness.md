# 베타 → main → 프로덕션 배포 준비 기록

| Field              | Value                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Runbook — 지속 갱신, 현재 프로덕션 승격 대기                                                                                                                                                                    |
| Applies to         | `mxqr_beta` 누적 변경의 다음 main 병합·프로덕션 배포                                                                                                                                                            |
| Last source review | 2026-09-29                                                                                                                                                                                                      |
| Executable sources | [CI](../.github/workflows/ci.yml), [Production Release](../.github/workflows/release.yml), [배포 범위·복구 판정](../scripts/release-deployment-state.mts), [D1 계약](../cloudflare/d1-migrations.manifest.json) |
| Related documents  | [작업 지침](../AGENTS.md), [정식 배포·복구 절차](hotfix-procedure.md), [버전 규칙](release-versioning.md), [문서 관리 규칙](documentation-governance.md)                                                        |

다음 배포 담당자는 이 문서부터 읽는다. 각 QA의 상세 보고서를 대체하지 않고,
**배포에 필요한 현재 상태와 남은 작업**을 한곳에 모은다. 아래 관측값은 해당
커밋·확인일의 기록이며, 배포 직전에 실제 Git·CI·Cloudflare 상태와 다시 맞춘다.

## 1. 현재 상태

| 항목                                | 확인된 상태                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| 동결                                | 대회 종료를 사용자가 명시하기 전까지 유지. 베타 커밋·푸시만 허용             |
| 기준 main                           | `35759e8b07f1ee0b272afbd0af03c770a858889e` — 로컬·원격 확인                  |
| 검토한 베타 코드                    | `79f3a687a7222a69ff865846e0c715aa197d0f10` — 시작 로고 단일 리빌 마스크. 동일 소스 작업 트리 집중 검증 후 커밋. 이전 전체 QA의 코드 SHA·검증 범위는 아래 별도 보존 |
| 이전 발견 감사                     | Luna 조합 탐사 1,250개 통과·당시 새 확정 0건. D01 및 S01–S02 기본 수정 반영. 이후 극단값 감사에서 XS01–XS04 확정, 이번에 수정 |
| 후속 수동 싱크 수정                | S01 참가자별 시작 지연·S02 반복 직후 입력 대기를 `c3eae88c`에 반영. 이번 XS01·XS03 수정에서 긴 대기의 소유권·취소 경계 보완. 실기 첫 음 정렬은 별도 확인 대상. [기본 수정](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27) |
| 극단값 수동 싱크 수정              | XS01 시작 예약/일반 상태·새 명령 우선권, XS02 로컬 파일 실제 출력 지연, XS03 PRO 기기 자체 일시정지 유지, XS04 늦은 타이머 위치 보정. [수정·검증 기록](design/extreme-manual-sync-repair-2026-09-27.md) |
| 후속 전체 QA / 수정 상태           | FQA01 외부 시작 복구·PLAYING 응답 대기까지 동기화 소유권 유지. QA-T01 정확한 큐 수렴 대기, QA-T02–03 coverage 파일 선택 수정. 전체 E2E에서 발견한 반복 중 싱크 창 닫힘도 수정. 단위 10,264개·4종 coverage gate·Chromium 552개·WebKit 60개·프로덕션 smoke 10개 통과. [수정·검증 기록](design/beta-full-qa-repair-2026-09-27.md) |
| 후속 UI 수정                       | YouTube 상태 문구를 입력창 바로 뒤로 이동. 스켈레톤은 surface-3·불투명도 25–50%·1.6초 반복. 베타 반영 완료 |
| 시작 로고 후속 수정                | 분리된 획 대신 완성 실루엣·정확한 단일 nonzero 마스크로 리빌. 오버스캔 제거, 기존 순서·타이밍 유지. 단위 88개·Chromium 21개·WebKit 6개·프로덕션 산출물 smoke 9개 통과. 전체 스위트 재실행 아님 |
| 제품 버전 / PWA 캐시                | `8.6.61` / `v630`, main과 동일. 공개 승격용 증분은 아직 하지 않음            |
| 예정 배포 범위                      | 현재 누적 변경 기준 `target=all`                                             |
| Developer API D1 입력               | 현재 변경 기준 `apply_developer_api_d1=false`                                |
| Operations Drift Audit              | `disabled_manually`; 종료·승격 지시 전에는 그대로 유지                       |
| 최종 main SHA / CI 후보 / 배포 실행 | 아직 없음. 베타 검증을 프로덕션 배포 완료로 기록하지 않음                    |

**아직 배포 준비 완료로 판정한 상태가 아니다.** 최종 버전·캐시 증분, 최종 main
SHA의 CI 후보, 실기 확인과 운영 상태 확인이 남아 있다. 현재 main 커밋이
모든 운영 Worker의 실제 배포 SHA라고 추정하지 않는다.
3차 D01과 수동 싱크 S01–S02의 기본 수정·회귀 검증 이후, 극단값 감사에서
XS01–XS04를 추가 확정한 뒤 이번 수정에 반영했다. 아래 실기·승격 확인은
별도로 남아 있으며, 베타 테스트 통과가 프로덕션 배포 준비 완료를 뜻하지 않는다.
후속 전체 QA의 FQA01과 검사 코드·설정 QA-T01–QA-T03은 베타에서 수정했다.
이전 발견 보고서는 당시 실패를 보존하며, 현재 해결 근거는 후속 수정 기록을
따른다. 전체 Chromium·WebKit·프로덕션 빌드 smoke는 통과했으며,
최종 단위·coverage 재검사도 통과했다. 이 로컬 검증과 공개 승격 준비는
별도로 구분한다.

## 2. 이번 베타에서 함께 반영할 범위

| 변경 묶음                              | 배포 시 반영·확인할 것                                                                                                                        | 근거                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 대용량 로컬 오디오 하이브리드 엔진     | 일반 파일은 기존 엔진, 큰 파일만 구간 디코딩. 새 지연 로딩 번들·WASM·라이선스 자산을 App 빌드에 포함. 작은 곡 복귀와 서로 다른 엔진 조합 확인 | [엔진 구현·검증 기록](design/large-local-audio-streaming-proposal.md), [RAM-only 정책](design/browser-media-storage-policy.md), [서드파티 고지](../THIRD-PARTY-NOTICES.md) |
| 파일 전송·프리로드·동기화·세션 수명 QA | 현재 곡 우선 전송, 이전 작업 취소, 신규 참여·재접속·권한 변경, 수동 싱크·곡 끝 경계 등을 최신 App에 반영                                      | [시퀀스 QA](design/sequence-qa-2026-09-23.md), [QA20](design/beta-qa-2026-09-27-round-20.md), [QA21](design/beta-qa-2026-09-27-round-21.md), 나머지 회차는 같은 디렉터리   |
| 데모·설정 UI·YouTube 검색              | 데모 스펙트럼 고정과 앱 설정 분리, 효과 UI 복원, 입력 포커스·검색 스켈레톤·빠른 추가, 마키 변경 포함                                          | [초기 베타 QA](design/beta-qa-2026-09-26.md), 관련 `e2e/` 회귀 테스트                                                                                                      |
| 시작 로고 리빌                        | App HTML·CSS·기존 `/wordmark-anim.js`를 함께 반영. 한 마스크로 획 연결부를 그리며 미진행 획으로 확장하지 않음. 새 의존성·Worker 계약 없음 | [런타임](../browser/classic-runtime/wordmark-anim.ts), [브라우저 회귀](../e2e/wordmark-reveal.test.ts) |
| 리버브 최대 10초                       | App, PRO Worker, Developer API backend/facade, 공개 OpenAPI를 함께 반영. 예전 30초 검증기가 남지 않도록 확인                                  | [공통 효과](../src/core/room-effects.ts), [PRO 효과](../cloudflare/pro-room-effects.ts), [OpenAPI](../public/developers/openapi.yaml)                                      |
| 로그인 쿠키 응답 소유권                | App Worker 배포가 필요. 늦은 로그아웃·탈퇴 응답이 새 로그인을 지우는 문제 수정. 기존 쿠키 읽기 호환 유지                                      | [쿠키 수정·검증](design/account-cookie-ownership-2026-09-27.md), [계정 운영](account-auth-operations.md)                                                                   |
| 일괄 발굴 결함 B01–B04                 | PRO YouTube 저장본 구분, 채팅 금지 후 초안 보존, 번역 내보내기, 짧은 파일 종료. 클라이언트와 App Worker를 함께 반영                           | [수정·회귀 기록](design/beta-defect-repair-2026-09-27.md) |
| 2차 발굴 결함 C01–C03                 | PRO 공유 종료 후 YouTube 복귀, 일반방 프리로드 종료 순서·진행 시간 제한, 탈퇴 작성자 추천 차단. App 클라이언트와 App Worker 반영 | [2차 수정·회귀 기록](design/beta-defect-repair-2026-09-27-round-2.md) |
| 3차 발굴 결함 D01                     | PRO live 공유 중 신규 입장의 오래된 스냅샷 복원 취소. App 클라이언트만 추가 변경 | [4차 발굴·D01 수정](design/beta-defect-harvest-2026-09-27-round-4.md) |
| YouTube 수동 싱크 S01–S02             | 다음 곡·반복 시작에서 음수 보정 유지, 일반방 반복 직후 입력의 새 snapshot 대기. App 클라이언트만 변경; UI·메시지·서버 계약 유지 | [발견·수정·검증](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27) |
| 극단값 수동 싱크 XS01–XS04           | 예약 시작과 일반 동기화/새 명령의 소유권, 로컬 파일 음수 출력 대기, PRO 기기 일시정지·늦은 시작 보정. App 클라이언트만 추가 변경; UI·공유 시각·서버 계약 유지 | [후속 수정 기록](design/extreme-manual-sync-repair-2026-09-27.md) |
| 전체 QA 후속 FQA01·QA-T01–QA-T03      | YouTube 외부 복구·재생 응답 대기의 동기화 소유권, 새 명령·재진입·중도 입장 경계 보완. E2E 큐 수렴 대기와 coverage 파일 선택 수정. App 클라이언트·검사만 추가 변경; 일반 UI·정책·Worker 계약 유지 | [전체 QA 후속 수정 기록](design/beta-full-qa-repair-2026-09-27.md) |
| 운영 감사의 빈 도메인 목록 처리        | 수정된 감사 스크립트가 main에 들어간 뒤 원격 감사 재확인. 이 수정만으로는 App 배포·업데이트 모달이 필요하지 않음                              | `9255269f`, [감사 스크립트](../scripts/audit-ops-drift.mts)                                                                                                                |

현재 서버 코드 차이는 `account-auth.ts`, `translation-community.ts`, `pro-room-effects.ts`,
`developer-api-worker.ts`, `developer-api-facade-worker.ts`다. App만 배포하면
리버브 검증 계약이 일부 서버에 남는다. 현재 워크플로의 단일 실행으로 모두
반영하려면 **`all`**을 사용한다. 변경이 없는 signaling·remote-share도 이 실행에
포함되므로, 최종 대상과 복구 checkpoint는 정식 워크플로가 검증하게 한다.
partial-release gate는 선택하지 않은 Worker에 남는 runtime 차이도 거부한다.
배포 직전 live SHA와 새 QA의 서버 의존성이 달라지면 이 판정을 갱신한다.

### 데이터·호환성 경계

- 위 코드 기준 새 D1 SQL/manifest, DO migration, Wrangler binding, secret,
  계약 버전 marker 변경은 없다. **이번 베타 때문에 새로 실행할 수동 DB
  마이그레이션은 없다.** 정식 release의 기존 baseline·검증 단계는 유지한다.
  `all`은 기존 D1 baseline과 R2 정책 적용·검증, room-code reuse 일시 fence도
  수행하므로 데이터 계층을 전혀 건드리지 않는 배포라는 뜻은 아니다.
  완료된 과거 launch-cleanup SQL을 수동으로 재실행하지 않는다.
- 쿠키 변경은 새 secret·DB 이전·대기 기간·전체 강제 로그아웃을 요구하지 않는다.
  기존 고정 이름 쿠키는 계속 읽고 새 로그인부터 세션별 이름을 발급한다.
- 리버브 과거 값 이전은 사용자가 실제 API 사용자를 확인한 뒤 불필요하다고
  결정해 제거했다(`d84323d3`). 임의 보정·일괄 데이터 변경을 다시 추가하지 않는다.
  이후 새로 보고된 API 사용이 있는지 확인한다. 실제 `>10` 저장값이 있으면
  현재 PRO 재로드 검증은 전체 effects를 기본값으로 돌리는 경계가 있으므로,
  그런 증거가 생길 때 배포 영향과 처리 결정을 다시 기록한다.
- 하이브리드 엔진은 전체 원본 File/Blob 수신 후 PCM 보관량을 줄인다. 미디어
  OPFS/IndexedDB 저장이나 네트워크 부분 수신으로 바뀐 것이 아니다. 원격/PRO의
  기존 파일 용량 제한을 이 배포에서 확대하지 않는다.
- 새 엔진의 큰 Opus/Vorbis 지원은 이번 범위가 아니다. 지원 코덱도 모든 기기에서
  성공한다고 보장하지 않는다. 준비 실패 시 큰 파일 전체 디코딩으로 자동 우회하지 않는다.
- 프리로드의 기존 `PRELOAD_END`가 청크와 같은 bulk 채널을 사용한다. 메시지
  형식 변경은 없으며 control 채널 END를 보내는 구버전도 계속 수신한다.
  PRO 공유 종료 복귀는 현재 서버 체크포인트로 참가자 자신을 복구하며 새
  방 재생 명령·권한 완화·파일 공유 종료 정책 변경은 없다.

## 3. 현재 검증과 남은 확인

**최신 집중 검증:** `79f3a687a7222a69ff865846e0c715aa197d0f10`의 시작 로고 변경을
Windows·Node 24.20.0에서 검증했다. 단위 88개, Chromium E2E 21개, Windows
WebKit E2E 6개, 프로덕션 산출물 Chromium smoke 9개가 모두 통과했다.
자세한 범위·초기 검사 수정·픽셀 판정 한계는 아래 2026-09-29 항목을 따른다.
이번에 전체 단위·coverage·전체 E2E를 다시 실행하지 않았으며, 아래 전체 QA
결과를 이 후속 코드 SHA의 전체 검증으로 해석하지 않는다.

**이전 전체 QA 검증:** `d3ef74ab4e196abbc2b2f3ea97988e3a91e379ac` 작업 트리(기준 checkout
`8c78a598`)에서 Windows·Node 24.20.0으로 전체 단위 **496파일·10,264 pass /
0 fail / 0 skip**와 원래 broad coverage gate를 통과했다. Critical
**50파일·1,772 pass**, tooling **13파일·342 pass**, Worker **26파일·1,726 pass**도
원래 global/per-file threshold로 통과했다. 검증한 공식 portable jq를 사용해
Windows의 기존 배포 분류 검사 skip도 해소했다. 서로 겹치는 profile의 수치는
합산하지 않는다.

최종 Chromium 전체 **552 pass / 0 fail / 0 skip / 0 flaky**를 서로 격리한
네 shard에서 확인했다. 공식 Windows WebKit 모바일 lane은
**60 pass / 0 fail / 기존 3 skip / 0 flaky**다. 프로덕션 빌드와 artifact guard
8개, 동일 산출물의 Chromium candidate 9개·WebKit Service Worker 1개도 통과했다.
전체 타입·린트·서식·정적 검사 23개와 Worker bundle dry-run 6개는 통과했다.
공개 버전/cache 증분 전의 `guard:sw-cache-version` 실패는 예상된 승격 gate로
유지하며 통과로 계산하지 않는다. 최신 실행·검사 경계는
[수정 검증 기록](design/beta-full-qa-repair-2026-09-27.md), 수정 전 실패는
[발견 기록](design/beta-full-qa-2026-09-27.md)을 따른다. 아래 과거 검증 숫자는
해당 시점의 기록이며 최신 결과와 합산하지 않는다.

**이전 검증 근거:** 코드 `2347760c5e5b902327a05ca216c8b72409ee72d3`. 동일 제품 소스의
작업 트리를 검증한 뒤 커밋했다. 이번 상세 근거는
[4차 발굴·D01 수정 기록](design/beta-defect-harvest-2026-09-27-round-4.md)에 있다.
후속 HTML 배치 수정 `736f195c`의 집중 검증은 아래 검색 스켈레톤 UI 항목에
별도 기록한다. 기존 전체 검증을 후속 커밋에서 재실행한 것으로 해석하지 않는다.
최신 S01–S02 수정 작업의 전체 493파일·10,118 pass와 최종 YouTube 937 pass는
아래 별도 수정 항목에 기록했다. 검사 중 마지막 경계 보완을 마친 뒤 YouTube
전체를 재실행했으며, 이전/전체/집중 검사 수치는 중복 합산하지 않는다.
이전 C01–C03의 19개 브라우저 회귀·Worker 번들 검증은
[2차 수정 기록](design/beta-defect-repair-2026-09-27-round-2.md)의 해당 코드 관측이다.
이전 51개 브라우저 회귀·짧은 WAV 실오디오 검증은
[이전 수정 기록](design/beta-defect-repair-2026-09-27.md)의 해당 코드 관측값이다.
쿠키의 별도 Chromium 지연 응답 검증은 [이전 수정 기록](design/account-cookie-ownership-2026-09-27.md)의 관측값이다.

아래 표의 전체 QA 수치는 `d3ef74ab` 시점이며, 최신 집중 검증과 별도로 보존하는
과거 관측·실기 한계를 구분한다.

| 확인                  | 결과 / 한계                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 전체 단위·broad coverage | 최신 수정 작업 트리 496파일·10,264 pass / 0 fail / 0 skip. 원래 threshold 통과. statements 86.24% / branches 79.83% / functions 90.88% / lines 89.95% |
| Critical·tooling·Worker coverage | 각각 50파일·1,772개 / 13파일·342개 / 26파일·1,726개 통과, fail·skip 0. 원래 threshold 유지. QA-T02–03의 선택 누락 수정 반영 |
| 타입·린트·정적 검사   | 최종 전체 타입·린트·서식·소스/보안/문법 검사 23개 통과. Worker bundle dry-run 6개 통과. cache-history guard는 공개 증분 전 예상 실패이며 별도 승격 잔여 gate |
| Chromium E2E          | 최종 공식 전체 552 pass / 0 fail / 0 skip / 0 flaky. 격리된 4개 shard, 각 worker 1·retry 0. 수정한 FQA01·QA-T01 집중 2개는 별도 이전 결과 |
| Windows WebKit E2E    | 공식 모바일 lane 60 pass / 0 fail / 기존 3 skip. 세 skip은 데스크톱 전용 전환·화살표·hover 문맥 제외. 실제 iPhone 또는 WebRTC 실기 검증이 아님 |
| 프로덕션 빌드 smoke   | 최종 App production 빌드·artifact guard 8개, 동일 산출물의 Chromium candidate 9개·WebKit Service Worker 1개 통과. fail/skip/flaky 0, 원격 배포 없음 |
| PRO 공유 도중 입장    | 이전 집중 회귀 3파일·18개 통과 근거 보존. 현재 전체 단위 검사에도 기존 입장·복원 경계 포함. 네이티브 API·RTC는 모사 |
| PRO 공유 종료·번역    | 기존 C01–C03 회귀도 최신 전체 단위 스위트에 포함해 통과. 최초 발견·집중 실행 수치는 2차 수정 기록 참조. 운영 D1·실기는 미검증 |
| 하이브리드 오디오     | 이전 QA의 합성 PCM·Chromium·실파일 검증 근거는 엔진 문서와 각 회차에 있음. 현재 코드의 모든 실기·모든 장기 세션을 완료했다는 뜻은 아님 |
| 원격 CI               | 베타 push는 현재 `ci.yml`의 main/PR 조건을 만족하지 않음. 최종 main SHA CI 후보는 아직 없음                                            |
| 공개 배포·라이브 검증 | 실행하지 않음                                                                                                                          |
| 후속 발견 감사 | 3차 D01 발견 당시의 실패는 보존. 4차 새 확정 0건, 고유 집중 회귀 21파일·328개 통과 후 D01 수정·최종 검증 완료 |
| Luna 조합 탐사 | checkout `1439e338`, 동일 제품 코드. 새 로컬 프로브 7파일·1,250 pass·최종 fail/skip 0. ASTRA 주요 1,082개 독립 재실행 통과. 브라우저·실기·전체 스위트 재실행 아님 |

다음 확인은 과거의 녹색 결과를 복사하지 말고, 실제 수행 환경과 SHA를 기록한다.

- [ ] iPhone Safari/PWA와 Android·Windows 혼합 방: 작은 곡 → 큰 MP3/FLAC/AAC → 작은 곡, 호스트·게스트 엔진이 다른 경우.
- [ ] 시작·연속 seek·이전/다음·곡 끝 반복·중도 참여·프리로드 재정렬·큰 수동 싱크·네트워크 단절/재합류·잠금/복귀·장기 메모리 추이.
- [x] S01 기본 수정 — 참가자별 시작 지연과 당시 회귀를 `c3eae88c`에 반영. 후속 XS01·XS03에서 긴 대기의 소유권·취소 경계 추가 수정. [기존 수정 범위](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27).
- [x] S02 — 반복 직후 확정 입력을 현재 재생 회차·연결·player·요청값에 한정해 새 snapshot까지 보존. 새 입력/재생 명령/회차 변경 시 취소, 최대 대기 후 종료. 실제 UI·모사 iframe heartbeat 지연 회귀와 23개 입력 회귀 통과. PRO의 같은 결함이 확인됐다는 뜻은 아님.
- [ ] S01–S02 실기 확인: 일반방/PRO, host/guest 양수·음수 보정 후 다음 곡·반복·중도 입장·취소, 실제 YouTube와 iPhone Safari/PWA·Bluetooth 첫 음 비교. 플레이어 시간 자동 검증을 실제 스피커 정렬 보장으로 해석하지 않음.
- [x] XS01 — 일반 heartbeat/부수적인 iframe 상태는 시작 소유권을 침범하지 않으며 snapshot은 갱신. 방장의 barrier가 먼저 종료된 뒤 새 seek/pause가 와도 게스트의 옛 예약을 취소. 실제 연결한 컨트롤러 및 브라우저 회귀 추가.
- [x] XS02 — 시작 위치가 0 미만인 만큼 실제 출력만 대기. 기본·대용량 엔진과 방장/게스트/PRO/데모 공통 경로 검증, 공유 시작·논리 시각 유지. 새 모듈 96개와 실제 PCM Chromium 회귀 통과.
- [x] XS03 — 실제 Media Session PAUSE가 PRO 예약·직접 시작을 취소. 해당 이전 commit만 처리 완료로 소비하여 PRO 제어기가 실패 복구로 다시 재생하지 않음. 명시적 재개·새 명령·종료 후 재진입 회귀 통과.
- [x] XS04 — 예정 호출 시각보다 늦은 만큼 시작 위치 보정. ±9999ms·0ms, 1.5초 지연·60초 후 위치, 다음 시작 학습값 유지·플랫폼 lead·길이 제한 회귀 통과.
- [x] FQA01 — 외부 시작 복구 및 PLAYING 응답 대기까지 공유 소유권을 UI·수동 싱크·랑데부·일반 상태에 적용. 새 pause/seek·종료/재진입·방장 복구 중 seek/신규 참여 경계도 수정. 실제 UI `-9999ms` 회귀와 새 모듈 통합 9개 통과; 복구 완료 후 Sync 사용 가능도 검증.
- [x] QA-T01 — 곡 삭제·중도 입장 E2E의 정확한 생존 queue ID·삭제 revision·DOM 수렴 대기로 수정, 집중 브라우저 회귀 통과. 공통 최소 개수 helper·시간 제한·기존 assertion 유지.
- [x] QA-T02 / QA-T03 — critical profile의 기존 `device-failure-sequence-qa.test.ts`, Worker profile의 기존 `account-cookie-ordering.test.ts` 선택을 추적 설정에 반영. 각각 1,772개·1,726개와 원래 coverage gate 통과, threshold 완화 없음.
- [x] 최종 변경의 공식 Chromium 전체 552개 통과. fail/skip/flaky 0, 네 shard 모두 exit 0. 기존 반복재생 E2E를 변경하지 않고 싱크 창 유지 회귀도 통과.
- [x] 최종 변경의 공식 Windows WebKit 모바일 lane 60개 통과, 기존 데스크톱 문맥 제외 3개 유지. 실제 iPhone Safari/WebRTC·음향 검증과 구분.
- [x] 최종 프로덕션 빌드·artifact guard 8개·Chromium candidate 9개·WebKit Service Worker 1개 통과. 모두 로컬이며 실제 배포는 별도.
- [ ] 기존 로그인 유지, 탭 간 새 로그인과 늦은 로그아웃/탈퇴 응답, 익명/인증된 방 입장·계정 관련 API.
- [ ] 일반방·PRO방과 API의 리버브 10초 경계, 데모 종료 후 설정 표시 및 실제 효과 일치.
- [x] D01: PRO 공유 도중 신규 입장의 초기 복원 취소 수정. RTC 트랙 도착 전 경계와 종료 복귀·서버 명령을 로컬 회귀로 검증. 실제 SFU/실기는 위 잔여 확인에 포함.

실기·전체 E2E의 추가 확인은 자동 배포 gate와 구분한다. 현재 CI의 필수 subset과
coverage 조건을 생략하지 않는다. 미완료 항목은 완료로 바꾸지 말고, 남겨둔 범위와
공개 여부의 결정을 배포 기록에 적는다. 현재 QA21의 알려진 쿠키 결함은 후속 수정으로
해결됐으며, QA21 원문은 당시 상태를 보존한 기록이다.

### 2026-09-27 발견 감사 — 확정 4건 베타 수정 완료

먼저 수정 없이 발굴하고 재검증한 뒤, 사용자의 후속 승인으로 확정 4건을
수정했다. [발굴 감사 기록](design/beta-defect-harvest-2026-09-27.md)은 발견 당시
결과를 보존한다. 현재 해결 근거는 [수정 기록](design/beta-defect-repair-2026-09-27.md)과
코드 `b833e2a62bd7eceaa1c9a074d463a36477b514e4`다. 아래 완료는 베타 상태이며 프로덕션 배포 완료가 아니다.

| ID | 결함 | 현재 상태 |
| --- | --- | --- |
| B01 | PRO에 같은 YouTube 플레이리스트의 서로 다른 저장본을 넣으면 하위 곡 캐시가 충돌해 선택 실패 | 큐 저장본별 불변 목록·제목 캐시. 표시·선택·로드·탐색·종료·캐시 퇴출 회귀 통과 |
| B02 | 채팅 금지 직전 초안을 전송하면 상대는 못 받는데 내 말풍선이 생기고 초안 삭제 | Standard·PRO 권한 상태 투영 및 일반 메시지·귓말·공개 BOT 전송 전 차단. 금지 해제 후 재전송 통과 |
| B03 | 이미 적용한 승인 번역이 누적되면 새 번역 1개도 내보내기 상한으로 차단 | 페이지 순회 후 실제 새 초안에 제한 적용. 기존 1,000개·8MiB·오래된 승인 차단 유지 |
| B04 | 100ms 이하의 정상 로컬 파일이 끝나도 자동 다음 곡·반복이 진행되지 않음 | 유효한 양수 길이 종료, 예약 시작 보호, 짧은 곡 오차 제한. 실제 Chromium 종료·이동·반복 통과 |

이전 감사의 관측 테스트와 이번 수정 검증 수치를 합산하지 않는다.
새 배포 대상은 늘지 않지만 App Worker에 번역 내보내기 runtime 변경이
추가되었다. 의존성·데이터 계약·버전은 유지한다. 당시 미확정이던 PRO 복귀와
프리로드 경계의 후속 판정은 아래 2차 기록을 따른다.

### 2026-09-27 발견 감사 2차 — 추가 확정 3건 베타 수정 완료

[2차 발굴 기록](design/beta-defect-harvest-2026-09-27-round-2.md)은 checkout
`63516859147008282104c5bd52d237fe9273e51b`, 제품 코드 `b833e2a6`의 관측이다.
당시에는 제품 수정 없이 발굴했으며, 이후 사용자 승인으로 C01–C03을
수정했다. 현재 코드는 `3dd9086cdced0fc25426da82239977b6da004074`, 근거는
[2차 수정 기록](design/beta-defect-repair-2026-09-27-round-2.md)이다.

| ID | 결함 | 현재 상태 |
| --- | --- | --- |
| C01 | PRO 공유 종료 후 YouTube가 CUED·0초에 남고 앱은 재생 중으로 표시 | 서버 idle 확인 뒤 현재 체크포인트로 재생·일시정지 복원. 재시도·새 공유·세대 누락·취소 경계 검증 |
| C02 | 일반방 프리로드가 진행 중이어도 조기 END의 10초 타이머로 폐기 | bulk 종료 순서와 실제 수신 진행 감시로 통합. 구버전 END·16초 정상 tail·무진행·중복 처리 검증 |
| C03 | 탈퇴 정리 대기 작성자의 번역 제안에 다른 사용자의 추천·응답 조회 허용 | 작성자 삭제 fence를 사전·원자적 변경·최종 응답 조회에 적용. 카탈로그 대기 중 탈퇴도 차단 |

발굴 당시의 집중 회귀 35파일·913개와 발견 재현 실패는 이전 관측으로
보존한다. 이번 완료는 베타 수정·로컬 자동 검증이며 운영 발생 빈도,
실기 네트워크 검증이나 프로덕션 배포 완료를 뜻하지 않는다. 새 배포 대상은
늘지 않으며 App Worker에는 번역 추천 경계 변경이 추가됐다.

### 2026-09-27 발견 감사 3·4차 — 추가 확정 1건 베타 수정 완료

[3차 발굴 기록](design/beta-defect-harvest-2026-09-27-round-3.md)은 checkout
`ab4220b75ba58cfec1939f8eec4169bb7f86feb7`, 제품 코드 `3dd9086c`의 관측이다.
당시에는 제품과 추적 테스트를 바꾸지 않았다. 이어진 4차에서 새 독립
결함이 확정되지 않아 사용자의 조건부 수정 지시에 따라 D01을 수정했다.
현재 코드와 근거는 `2347760c5e5b902327a05ca216c8b72409ee72d3` 및
[4차 발굴·D01 수정 기록](design/beta-defect-harvest-2026-09-27-round-4.md)이다.

| ID | 결함 | 현재 상태 |
| --- | --- | --- |
| D01 | PRO 공유 중 입장 시 live 수신 준비 이후 첫 시계 보정이 끝나면 이전 YouTube를 다시 재생 | live에서 기존 자동 복원 소유권 폐기, 확정 idle에서 새 복원 허용. 준비/시계 지연·종료 복귀·권위 명령 유지의 새 회귀 18개 통과 |

3차 집중 회귀 46파일·1,700개와 발견 재현의 2실패·1대조군 통과는 당시
관측으로 보존한다. 4차는 고유 21파일·328개 통과, 새 확정 0건이며 이후
D01 수정의 전체 검증은 위 표를 따른다. 실기·실제 SFU·네이티브 YouTube 검증이 아니며,
이미 RTC가 붙은 경우나 일반방까지 같은 결함이라고 확대하지 않는다.
기존 공유 종료 복귀 C01과는 다른 경계다. D01은 App 클라이언트 변경이며
새 Worker/DB 계약은 없다. 누적 배포 대상과 공개 승격의 잔여 확인은 유지한다.

`Full E2E` workflow에는 실제 프로덕션 large-room probe도 들어 있다. 단순 로컬
테스트로 오인해 실행하지 않으며, 해당 job은 non-blocking이므로 workflow의
녹색 표시와 probe 자체의 성공 여부를 구분해 기록한다.

### 2026-09-27 Luna 조합 탐사 — 제품 수정 없이 새 확정 0건

[Luna 조합 탐사와 ASTRA 재검증](design/beta-luna-combination-audit-2026-09-27.md)은
checkout `1439e338aa83ac1065b0a335bdfcba12e63c7012`, 동일 제품 코드 `2347760c`의
추가 검증이다. 새 로컬 프로브 7파일·1,250개가 통과했다. 주요 모듈 조합
1,080개, 비정상 패킷 순서 대조군 2개, 보조 함수 순열 168개를 구분한다.
검색 540개는 서로 다른 순서 20개를 응답 결과 27종으로 확장한 수다.
ASTRA의 주요 1,082개 독립 재실행은 중복 실행이므로 총계에 더하지 않는다.

새 제품 결함은 확정되지 않았고 제품 코드·추적 테스트를 수정하지 않았다.
실제 브라우저·네트워크·코덱·PRO 서버 재생 통합이나 전체 스위트의 새
통과로 해석하지 않는다. 기록만 추가하며 배포 범위·계약·잔여 실기 확인은 유지한다.

### 2026-09-27 YouTube 검색 스켈레톤 UI 검토·배치 수정

checkout `693ded3ae0414919b8c4a569f4a64e279d6e16d9`, 동일 제품 코드 `2347760c`에서
사용자가 상태 안내 문구 위치와 스켈레톤 색상을 검토하도록 요청했다.
[실제 HTML](../index.html)의 `youtube-preview-status`가 검색 결과 컨테이너 뒤에
있어, 검색 중에는 스켈레톤 아래로 내려가고 실패 시 목록이 숨겨지면 입력창
아래로 복귀한다. 로컬 Chromium 390×844 미리보기에서 상태 문구의 상단은
603.27px → 228.80px로 약 374.47px 이동했다. 입력창 하단은 214.80px로 유지됐다.
미리보기는 실제 HTML/CSS와 검색 모듈을 사용하며, API 응답은 로컬에서 모사했다.

최초 검토에서는 수정하지 않았고 이후 사용자 승인으로 `736f195c8e6414ea527b0781cd96154ef36b452e`에서
공통 상태 문구를 입력창 바로 다음으로 이동했다. 같은 문구 노드와 ARIA 연결을
유지하며 검색·미리보기 로직은 바꾸지 않았다.
[스켈레톤 CSS](../css/style.css)는 이 검토 당시 기존 `--surface-3`를 사용했다. 기본 다크
`#404040`, 라이트 `#b7b9bb`로 [공개 디자인 토큰](../public/designsystem/colors_and_type.css)과
일치하며 새 임의 회색은 아니다. 스켈레톤 전용 1.6초 불투명도 애니메이션
0.55–0.9가 적용되고 동작 줄이기에서는 0.7로 고정된다. 배포 계약·버전은 그대로다.

수정 검증: Windows, Node 24.20.0, Vitest 5에서 기존 검색·플레이어 제어·앱 UX
계약 테스트 3파일·282개 통과, fail/skip 0. 로컬 Chromium에서 데스크톱 1280×900,
모바일 390×844, 낮은 모바일 390×480, RTL·라이트 모바일을 확인했다.
각 화면의 로딩·실패·빈 결과·성공 상태 모두 안내 문구가 입력창 하단에서
14px 간격을 유지했다. URL 미리보기 성공 시 안내를 숨기는 기존 동작도 유지한다.
브라우저 검증은 실제 HTML/CSS/검색 모듈을 쓰되 응답을 모사한 로컬 미리보기이며,
실서비스·실기·전체 E2E 검증은 아니다. 새 제품 테스트나 CSS 변경은 없다.
전체 HTML 서식 검사는 기존 생성 문구 등의 서식 차이로 통과하지 않아, 무관한
전체 파일 재서식은 제외하고 노드 이동만 반영했다. `git diff --check`는 통과했다.

이후 사용자 요청으로 `b9ea66d3b91fe35b04a9da6cc9a6b1011861c144`에서 스켈레톤의
썸네일·제목·채널 막대만 `--surface-2`로 낮췄다. 불투명도와 모션은 유지했다.
로컬 Chromium 390×844에서 다크 `#202020`, 라이트 `#eff1f3`가 세 요소 모두에
적용되는 computed style과 화면을 확인했다. 색상만 변경하여 전체 테스트는
재실행하지 않았고 새 테스트도 추가하지 않았다. 배포 범위·버전·캐시는 유지한다.

`bc8e25757abacdd2ee82c368b4617be42be328e4`에서는 사용자 요청에 따라 불투명도만
60–100%로 조정했다. 로컬 Chromium에서 시작/끝 0.6, 중간 1.0, 주기 1.6초를
확인했다. `surface-2`와 동작 줄이기의 애니메이션 없음·불투명도 0.7은 유지한다.
CSS 두 값만 변경했으며 전체 테스트는 재실행하지 않았다.

다음 후속 요청은 `df7b915a9c17465a30dbfae82cec9389c4d2f56d`에 반영했다.
색상은 다시 `surface-3`, 불투명도는 50–80%다. 로컬 Chromium 다크/라이트에서
세 요소의 토큰 색상, 애니메이션 시작 0.5·중간 0.8·주기 1.6초를 확인했다.
동작 줄이기의 0.7 고정은 유지하며 전체 테스트는 재실행하지 않았다.

최신 요청은 `09123ea84081660ad8578b81e98f795386555179`에서 불투명도를
25–50%로 낮춘 것이다. 로컬 Chromium에서 시작 0.25·중간 0.5와 기존
surface-3·1.6초 주기·동작 줄이기 0.7 고정을 확인했다. CSS 두 값만 변경했다.

### 2026-09-27 YouTube 수동 싱크·제로스타트 S01–S02 수정

checkout `35f122a9`에서 수정한 작업 트리를 검증한 뒤 `c3eae88c`로 커밋했다.
이 항목과 제품 변경을 함께 반영했으며, 발견 당시 관측값은 [원본 조사 기록](design/youtube-manual-zero-start-audit-2026-09-27.md)에
보존하고 그 문서의 수정 부록에 현재 근거를 추가했다.

일반방과 PRO의 음수 수동 보정은 미디어 0초에서 버리는 대신 해당 기기만
남은 시간만큼 늦게 시작한다. 방 전체의 시작 시각은 바꾸지 않는다. 방장 자신이
기다리는 동안에도 방의 기준 시각은 전진하며, 늦은 COMMIT·준비·unmute·접속 교체와
취소를 분리했다. 기존 학습값이 수동 보정을 시작 오차로 학습하지 않게 한다.
일반방의 반복 직후 확정 입력은 새 snapshot이 없을 때 현재 재생 회차에 한정해
보존하고, 새 입력·재생 명령·연결/플레이어 교체가 오면 폐기한다. 최대 18.999초는
기존 준비/cooldown과 방장의 최대 음수 보정을 합한 복구 한도이며 매번 기다리는
시간은 아니다. 준비된 snapshot이 있으면 바로 적용한다.

검증 환경은 Windows·Node 24.20.0·Vitest 5·로컬 Chromium이다.

- 전체 단위 테스트: 493파일·10,118 pass·fail 0·기존 skip 1. skip은 Windows에
  `jq`가 없는 기존 배포 분류 검사다. 마지막 경계 보완과 전체 검사가 일부
  겹쳤으므로, 소스 수정 완료 후 YouTube 전체 937개를 별도로 재실행해 모두 통과했다.
- 실제 UI Chromium 회귀: 일반방 host/guest 양수·음수/동시 음수·방장 -5초
  다음 곡 6개 통과. 이 실행 뒤 late COMMIT 및 fallback의 비동기 audio 복원
  한도를 보완했고 최종 모듈 회귀로 검증했다. 소스 확정 뒤 실행한 반복 직후
  입력 1개도 통과. 두 회귀 모두 실제 앱·local PeerJS·모사 iframe이며 전체 E2E
  또는 실제 YouTube/실기 검증은 아니다.
- App·단위 테스트·E2E 타입 검사, 전체 App 린트와 새 E2E 2파일 린트,
  변경 TypeScript 서식, E2E/App 프로덕션 빌드 통과. Worker·tooling 타입 전체를
  이번에 다시 실행한 것으로 해석하지 않는다.

App 클라이언트 수정만 추가된다. 의존성, UI, 메시지/서버 계약, DB, Worker,
secret/binding 변경은 없다. 누적 `all`/Developer API D1 off 판정과 공개 전
버전/cache 증분 요구는 유지한다. 현재 버전/cache `8.6.61`/`v630`, main과
프로덕션 및 Operations Drift Audit의 비활성화 상태는 이 작업으로 바꾸지 않는다.
실기·최종 main 후보·배포는 미완료다.

### 2026-09-27 극단값 동기화 발굴 — 당시 XS01–XS04 미수정

아래는 수정 전 발견 기록이다. 현재 수정 상태와 검증은 바로 다음 항목을 따른다.

검토 checkout은 `fe3fdb10f0ee4ffc4a028640cf198c52b488a810`, 동일 제품 코드는
`c3eae88c`다. 사용자의 발굴 요청에 따라 제품 코드를 고치지 않고 조사했다.
[상세 감사](design/extreme-manual-sync-audit-2026-09-27.md)에 원인·재현·대조군·제한을
기록했다. 앞선 S01–S02 수정 결과는 당시 검사 기록으로 보존한다.

새 모듈 조합 863개를 최종 독립 재실행했다: 일반방 YouTube 266개 중 264 pass/2 fail,
로컬 파일 283개 중 249 pass/34 fail, PRO YouTube 314개 중 310 pass/4 fail.
총 40개 실패는 **서로 다른 버그 40개가 아니라 확정 원인 4개의 재현**이다.
최종 skip은 없다. 기존 로컬 파일 6스위트 352개 통과는 별도 기준 검사다.

로컬 Chromium·실제 UI·local PeerJS에서 YouTube 극단값 다음 곡 8개 중
6개 통과/2개 실패. 별도 타임라인 관측은 게스트가 예정된 약 10초 대신 4.676초에
먼저 시작하고, 10.670초 heartbeat에서 약 5.3초 되감기며 복구되는 것을 확인했다.
실제 60초 PCM WAV의 native 출력 4개 관측은 음수 host/guest 실패와 양수/0 대조군을
확인했다. 관측 스크립트 완료를 올바른 동기화 통과로 계산하지 않는다.
파일 → YouTube 지연 시작 → 파일 복귀 1개는 이전 iframe 부활 없이 통과했고,
파일 +9,999ms와 YouTube -9,999ms 설정도 분리 유지됐다.

PRO는 실제 앱 모듈·Media Session 핸들러·모사 iframe/서버 시간이며 실서비스
PRO 서버 검증은 아니다. 실제 YouTube·iPhone·Bluetooth 스피커 정밀도와 전체
E2E/전체 단위 스위트는 이번 조사에서 다시 검증하지 않았다. XS04의 일반
heartbeat 후속 처리는 소스 추적이며, 숨김→복귀의 별도 복구가 없는 조건이다.

수정 전이므로 제품/Worker/의존성/DB/버전/캐시/배포 범위는 그대로다.
이 발견으로 승격 준비가 완료됐다고 판정할 수 없다. 베타에는 조사·배포 기록만
반영하며 main, 프로덕션, 비활성화된 Operations Drift Audit은 유지한다.

### 2026-09-27 극단값 동기화 XS01–XS04 수정

코드 기준은 `c242bfd17f652f1480a6e79731d5130b5b6f6c19`다. 동일 소스의 작업 트리를
검증한 뒤 커밋했다. [후속 수정 기록](design/extreme-manual-sync-repair-2026-09-27.md)에
원인별 변경과 재현·모사·실기 범위의 차이를 기록했다.

일반방 YouTube의 예약/일반 상태 소유권과 늦은 새 명령의 취소를 정비했다.
로컬 파일의 음수 보정은 실제 기본·대용량 출력 지연으로 유지하되 공유 시각은
그대로다. PRO는 기기 자체 PAUSE를 오래된 commit이 되살리지 못하며, 늦은 시작
타이머는 그만큼 재생 위치를 따라잡는다. UI·서버·DB 계약과 수동 보정 상한은 같다.

- 집중 단위 검사: 로컬 448, 일반방 YouTube 287, PRO 67개 통과. 전체 검사와
  중복되는 부분집합이므로 합산하지 않는다.
- 브라우저: 실제 PCM 출력 4개·모사 YouTube UI 10개, 총 14개 통과. 로컬은
  최종 로컬 엔진 변경 이후, YouTube는 마지막 명시적 명령 취소 보완까지 포함한
  빌드에서 검증했다. 실제 YouTube/iPhone/Bluetooth 음향 측정은 아니다.
- 전체 단위: 495파일·10,250개 중 최초 10,245 pass/4 timeout/기존 1 skip.
  시간 초과 4개는 다른 무거운 검사 종료 후 단독 직렬 재실행에서 모두 통과했다.
  제한/검증을 완화하지 않았고, 전체를 한 번에 all green으로 실행한 것은 아니다.
  따라서 고유 10,249개 통과 확인, Windows `jq` 부재인 기존 1개 skip 유지.
  새 테스트 타입 수정 뒤 영향받은 163개와 마지막 PRO fixture 29개도 다시 통과.
- 전체 타입·린트, 변경 TypeScript 서식, E2E/프로덕션 App 빌드 및 추가 소스/identity
  guard 7개·빌드 guard 8개 통과. 자세한 경계는 후속 수정 기록 참조.
- `guard:sw-cache-version`은 베타 누적 변경에 공개용 cache 증분이 없어 예상대로
  실패했다. 검사를 완화하지 않았으며 최종 main 승격 때 버전/cache를 증분해야 한다.
  이는 수정 회귀 테스트 실패와 구분한다. `guard:release-identity`는 현재 `8.6.61` /
  `v630`의 파일 간 일치를 확인했다.

App 클라이언트만 추가 변경. 누적 배포 범위 `all` / Developer API D1 off 유지.
베타만 커밋·푸시하며 main·프로덕션·Operations Drift Audit 비활성화 상태는 유지한다.

### 2026-09-27 전체 QA 후속 수정 — FQA01·QA-T01–QA-T03

검증 소스는 `d3ef74ab4e196abbc2b2f3ea97988e3a91e379ac`이며 기준 checkout
`8c78a598121e2226f4ecfc4ed176e8e0704bed3d`의 수정 작업 트리를 검사한 뒤 커밋했다.
최종 전체·critical 검사 전후 1,046개 소스·설정·패키지 파일 해시 변화가 없음을 확인했다.
[수정 전 전체 QA](design/beta-full-qa-2026-09-27.md)의
실패 근거를 보존하며, 최신 구현·실행 범위는
[후속 수정 기록](design/beta-full-qa-repair-2026-09-27.md)을 따른다.

FQA01은 일반방 YouTube 제로스타트 프로토콜뿐 아니라 외부 플레이어 복구와
재생 응답 대기가 끝날 때까지 동기화 소유권을 유지하도록 수정했다. UI·수동
값/초기화·랑데부·heartbeat가 같은 경계를 사용한다. 명시적 새 pause/seek는
오래된 복구를 취소하고, 종료/재진입 시 잔여 작업을 정리한다. 방장 복구 중
새 seek와 중도 참여도 같은 소유권으로 처리한다. 일반 화면·정책·수동 보정
상한·Worker 계약은 변경하지 않았다.

첫 전체 E2E에서 readiness 알림이 반복 시작 시 이미 열린 싱크 창을 닫는
추가 UI 회귀를 발견했다. 알림은 버튼 상태만 갱신하도록 복원했고, 복구 중
실제 값 변경은 공통 입력 경계가 거부한다. 기존 반복 E2E는 수정하지 않았으며,
최종 전체 552개 검사에서 열린 창 유지와 반복 후 입력까지 통과했다.

QA-T01은 삭제와 입장이 겹치는 E2E에서 정확한 생존 queue ID, 삭제 revision과
DOM 수렴을 기다리도록 수정했다. 공통 최소 개수 helper·시간 제한·assertion은
유지했다. QA-T02–03은 누락된 기존 회귀 파일을 critical/Worker profile에
포함했으며 원래 coverage threshold는 그대로다. 공식 portable jq 1.8.2의
GitHub asset digest와 배포 checksum을 확인한 뒤 `MXQR_TEST_JQ_PATH`로 사용해
Windows의 기존 배포 분류 검사 skip을 해소했다. 전역 설치나 해당 테스트의
우회·검사 완화는 없다.

- 전체 단위와 broad coverage: **496파일·10,264 pass / 0 fail / 0 skip**.
  Critical **50파일·1,772**, tooling **13파일·342**, Worker **26파일·1,726**도
  fail/skip 없이 원래 global/per-file gate를 통과했다. 겹치는 profile은 합산하지 않는다.
- 집중 모듈 **8파일·744개** 및 실제 UI의 FQA01·QA-T01 브라우저 회귀 **2개** 통과.
  새 소유권 통합 9개는 음수 보정, 재생 응답 지연, heartbeat, 새 명령 우선권,
  종료/재진입을 검증한다. 마지막 fixture 보완 후 전체 단위 실행에서도 해당
  파일을 검사했으며 소스/실행 시점 근거는 후속 수정 기록에 있다.
- 공식 전체 Chromium **552 pass / 0 fail / 0 skip / 0 flaky**. 테스트 선택·worker 1·retry 0을
  유지하고 preview/PeerJS 포트·origin·산출물을 분리한 네 shard를 사용했다.
  공식 Windows WebKit **60 pass / 0 fail / 기존 3 skip**; 데스크톱 전용
  전환·화살표·hover 문맥의 제외를 실제 iPhone 검증으로 계산하지 않는다.
- 전체 타입·린트·서식·정적 검사 **23개**, Worker bundle dry-run **6개** 통과.
  수정 중 먼저 발견한 Promise 처리·서식 문제는 보완 후 전체 명령과 이전에
  단락된 tooling 단계까지 재검사했다.
- 프로덕션 App 빌드·artifact guard **8개**·동일 산출물의 Chromium candidate **9개** 및 WebKit
  Service Worker **1개**도 통과했다. 브라우저 fail/skip/flaky 0이며 원격 배포는 없다.
- `guard:sw-cache-version`은 frozen `8.6.61` / `v630` 이후 베타 runtime 변경으로
  예상대로 exit 1이다. 이를 통과로 표시하지 않으며, 승인된 승격 전 누적 변경을
  포함하는 version/cache 증분 커밋과 exact-main-SHA 검증이 필요하다.

네 Chromium shard·정적 검사와 병렬로 실행한 중간 단위 검사에서는 변경 없는
재생목록 DOM 회귀 한 건이 기존 15초 제한을 초과했다(16.836초). 테스트나 제한을
바꾸지 않고 다른 검사가 모두 끝난 뒤 원래 전체 suite를 재실행하여 **10,264 pass /
0 fail / 0 skip**를 확인했다. 해당 케이스는 6.928초로 통과했고 broad coverage도
원래 기준을 통과했다. 중간 실패는 `final-unit/`, 최종 단독 결과는 `final-idle/`에
보존했다. 이 PC의 전체 coverage와 전체 브라우저 검사는 분리 실행을 권장한다.
Tooling·Worker 전용 coverage는 UI 수정 전 통과 결과를 유지한다. 해당 소스·설정은
변하지 않았고 모든 테스트는 최종 전체 단위 검사에도 포함됐다.

이번 추가 변경은 App 클라이언트·테스트·coverage 설정이다. 새 의존성·D1·binding·secret·
번역 문구·Worker 계약은 없으며 누적 배포 범위 `all` / Developer API D1 off를
유지한다. 실제 YouTube 서비스·iPhone·Bluetooth 음향·운영 SFU 검증은 위 잔여
확인 대상이다. 베타 수정의 로컬 검증만 진행하며 main·프로덕션·Operations Drift
Audit 비활성화 상태는 유지한다.

### 2026-09-29 시작 로고 — 정확한 단일 리빌 마스크

검증 코드: `79f3a687a7222a69ff865846e0c715aa197d0f10`.
기준 checkout `4f49c35d` 위의 동일 소스 작업 트리를 검증한 뒤 커밋했다.
승인받은 로컬 비교안의 정확한 폴리곤 합성 방식을 적용했다. 36개 획은
`defs` 안의 입력 도형으로만 남고, 완성 로고 실루엣에 하나의 nonzero 마스크
경로를 적용한다. 기존 획 순서·지연·easing은 유지하고, 후속 획을 미리
노출하던 오버스캔과 개별 획의 0.3 SVG 단위 덧칠을 제거했다.

- 온보딩이 준비된 때부터 한 시계로 시작한다. 데스크톱 복제본은 고유 mask ID를
  갖고 같은 시점에서 이어지며, 2,540ms 그리기 완료 후 기존 인사말로 전환한다.
  2,900ms에는 마스크와 프레임 작업을 정리한다. 백그라운드 복귀·분리된 노드·
  동작 줄이기·페이지 이탈·스크립트 실패 시 정적 로고와 인사말 fallback을 확인했다.
- 단위 `classic-runtime-assets`, `wordmark-reveal-runtime`,
  `setup-carousel-motion`: **3파일·88 pass / 0 fail / 0 skip**.
- 새 `wordmark-reveal` 브라우저 회귀: Chromium **6 pass**, Windows WebKit
  **6 pass**. 기존 entrance·greeting·carousel Chromium **15 pass**.
  최종 각 실행의 fail·skip·retry는 0이다.
- 초기 브라우저 검사에서 멈춘 테스트 시계와 미디어 이벤트 도착 순서 두 곳을
  실제 DOM 상태 대기 후 시계 진행으로 수정했다. 픽셀 검사의 십자 이웃 판정은
  U자 윤곽 모서리까지 내부로 포함해 WebKit 한 픽셀(alpha 239/255)을 검출했다.
  대각 이웃이 alpha 4인 윤곽 경계임을 확인한 뒤, 참조 이미지의 **3×3 전체가
  불투명한 픽셀**만 내부로 판정했다. alpha 허용치를 완화하지 않았다.
- 두 엔진 각각 22/29px × 렌더 배율 1/2 × 소수점 위치 0/.25/.5/.75의
  **16개 표본에서 내부 접합부 결함 0**. 800ms의 M·X 후속 획 조기 노출도 없다.
  이는 브라우저 SVG rasterizer 검사이며 외곽 안티앨리어싱의 완전 일치나
  실제 FHD 모니터·iPhone 하드웨어 검증을 뜻하지 않는다.
- App/classic-runtime/단위/E2E 타입 검사, 변경 TS의 해당 ESLint 설정,
  변경 CSS·TS의 Prettier, 소스 복잡도·classic-runtime·inline-JS·Playwright
  API guard와 `git diff --check` 통과. HTML은 로고 블록 밖의 기존 서식을 유지했다.
- E2E 빌드와 프로덕션 빌드 통과. 프로덕션 산출물의 legacy TV·초기 전송 용량·
  prod hooks·prod security·SW app shell·font·service worker·UI kit guard
  **8개**, 동일 산출물의 공식 Chromium candidate smoke **9개** 통과.

이번 추가 변경은 App 클라이언트만 해당한다. 누적 `target=all`, D1 입력 off,
새 dependency/schema/secret/binding 없음, 버전 `8.6.61`·cache `v630` 동결은 유지한다.
공개 승격 전 버전·cache 증분과 최종 main SHA 검사는 여전히 필요하다.
되돌릴 때에는 이 변경의 HTML·CSS·classic runtime·setup 완료 이벤트 연결을
함께 되돌린다. 새 서버·데이터 복구 절차는 없다. main·프로덕션과 비활성화된
Operations Drift Audit는 변경하지 않았다.

## 4. 대회 종료 후 실행 순서

현재는 아래 절차를 실행하지 않는다. 사용자의 **대회 종료 및 승격 지시**를 확인한
뒤 진행하고, 실제 명령·승인 경계는 [정식 절차](hotfix-procedure.md)를 따른다.

1. **종료·재개 기록:** 지시 일시를 아래 실행 기록에 남긴다. 이전 사용자 지시에
   따라 `Operations Drift Audit`의 `ops-drift-audit.yml`만 재활성화한다.
   과거 일회성 disabled workflow까지 일괄 켜지 않는다. 수정 전 main에서 실행된
   감사는 구 스크립트로 실패할 수 있으므로, 수정 병합 뒤의 결과와 구분한다.
2. **최종 차이 확정:** 원격 refs를 확인하고 main 대비 베타 diff, 미커밋 작업,
   다른 작업의 변경을 확인한다. 대상 SHA와 위 표를 갱신한다. 기존 문서의 SHA를
   다음 주 최신 코드로 간주하지 않는다.
3. **버전·캐시 증분:** 현재 `8.6.61`/`v630`을 그대로 공개하지 않는다. 최종 기능
   범위에 맞는 SemVer와 더 큰 cache epoch를 확정하고, package/lockfile과 두 admin
   버전 mirror를 함께 맞춘다. 새 엔진의 기능 추가도 버전 판단에 포함한다.
   `npm run version:status`와 관련 guard로 확인한다.
4. **최종 베타 검증·푸시·PR:** 변경에 필요한 테스트·타입·린트·guard를 통과시킨다.
   최종 버전/cache 변경을 커밋한 뒤 `npm run build:checked`를 실행한다.
   이전 커밋의 빌드로 최종 cache-history 검사를 대체하지 않는다. 승인된 main 대상
   PR을 만들고 PR CI를 확인해 병합한다. 사용하는 임시 브랜치는 정상 정책을 따른다.
5. **main 후보 확보:** 실제 병합된 **main push SHA**의 CI 전체가 성공하고 그 SHA의
   만료되지 않은 immutable production candidate가 있는지 확인한다. 베타·PR SHA 결과로
   대신하지 않는다. 수정이 더 생기면 새 SHA의 후보를 다시 기다린다.
6. **Production Release:** 최종 diff를 다시 확인해 현재 계획이면 `target=all`,
   `apply_developer_api_d1=false`로 실행한다. 워크플로 ref는 `main`이어야 한다.
   실행의 `head_sha`가 승인한 최종 SHA인지 확인한다. checkout·artifact는 해당
   SHA로 고정되며, 시작 전에 main이 전진하면 새 후보로 다시 진행한다.
7. **운영 결과 확인:** 정식 workflow의 checkpoint·배포·live smoke·최종 Worker
   소유권/세대 readiness 확인을 완료한다. 실행 중 dashboard나 로컬 CLI로 별도
   배포하지 않는다. fresh load, 기존 열린 탭/PWA 업데이트, 변경된 미디어·계정
   경로를 확인한다. 베타의 녹색 테스트만으로 이 단계를 완료 처리하지 않는다.
   활동 중인 방의 탭은 새 서비스 워커가 활성화되어도 자연스러운 다음 로드까지
   갱신을 미룰 수 있으므로, 모든 참가자가 즉시 새 클라이언트가 됐다고 간주하지 않는다.
8. **감사·마감:** 수정이 들어간 main에서 Operations Drift Audit을 수동 실행해
   보고서를 확인하고, 활성화 상태도 확인한다. 배포 SHA/버전/결과와 남은 확인을
   아래에 기록한다. 성공 후 임시 PR 브랜치는 정상 정책으로 정리하되, 베타의
   보관·제거는 동결 종료 후 사용자 지시와 진행 중인 작업을 확인해 결정한다.

main 병합만으로 Cloudflare가 바뀌지 않는다. 문서·감사 도구만의 향후 변경은
저장소 반영으로 끝나지만, **이번 누적 베타는 App·Worker 배포가 필요하다.**

## 5. 실패·복구 시 주의점

- 정식 release/recovery workflow의 checkpoint, 실제 Worker 버전·메시지,
  D1/DO/R2 compatibility floor를 우선한다. 체크포인트는 사용자 데이터 전체의
  백업이 아니며, 이미 존재하는 세대·권한 경계나 tombstone을 지우지 않는다.
- **쿠키 reader 호환:** 새 세션별 쿠키를 발급한 뒤 이전 App Worker로만 되돌리면
  이전 코드는 새 이름을 읽지 못해 해당 사용자가 익명으로 보일 수 있다. 이 경계는
  현재 별도 자동 rollback marker로 보호되지 않는다. 가능하면 새 cookie reader를
  유지한 forward fix/선별 revert를 사용하고, 구 버전 전체 복구가 필요하면 재로그인
  영향과 남은 쿠키의 처리까지 검토한다. 구 App에서 legacy 쿠키로 다시 로그인한 뒤
  새 App을 재배포하면, 남아 있는 유효한 scoped 쿠키가 그 legacy 로그인보다 우선할
  수 있다. 단순히 재로그인하면 완전히 해결된다고 가정하지 않는다. 이는 reader
  코드의 호환성 경계이며 실제 운영 사고를 재현했다는 뜻은 아니다. DB 유실과
  로그인 쿠키 호환 문제를 혼동하지 않는다.
- 리버브 검증기를 App/PRO/API 일부만 복구해 다른 상한이 남지 않도록 한다.
  대상별 복구 순서를 수동으로 새로 만들지 말고 canonical 절차를 따른다.
- 소스 revert에서도 공개 제품 버전과 캐시 번호는 앞으로 증가시킨다. 실패한
  release의 보고서·checkpoint를 남기고 외부의 더 새로운 배포를 덮어쓰지 않는다.

## 6. QA 때 갱신하는 규칙

QA 시작 시 이 문서와 현재 diff를 읽고, 완료 시 다음 중 하나라도 달라졌으면
**같은 변경에 이 문서를 갱신해 커밋·푸시한다.**

- 배포 대상, dependency/asset, 데이터·secret·binding, API/프로토콜/쿠키 호환성
- 버전·캐시 요구, 새 결함·해결 상태, 필수 확인 또는 회귀/실기 검증 결과
- 배포 순서, 복구 조건, 사용자의 승인·보류 결정

위 현재 상태·체크리스트를 먼저 고친 뒤 아래 이력에 날짜, QA/코드 SHA, 배포 영향,
검증 및 남은 일을 한 줄로 추가한다. 문서만 수정한 커밋은 마지막으로 검증한
**코드 SHA**를 바꾸지 않는다. 상세 로그는 QA 보고서로 링크하고 결과를 여러 번
합산하지 않는다. 새 배포 영향이 없다면 반복 행을 만들 필요는 없다. secret 값,
세션 쿠키나 개인정보는 이 문서에 넣지 않는다.

### 누적 변경 이력

| 날짜       | 범위 / 코드 근거                                       | 배포 영향·결정                                                                                                  | 검증·남은 일                                                            |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2026-09-27 | 동결 이후 베타 전체, main `35759e8b` → beta `c663f89f` | 최초 통합 기록. 하이브리드 오디오, UI·전송·동기화 QA, 리버브 10초, 감사 수정 포함. `all` / Developer API D1 off | 최종 버전·cache 증분, main CI 후보, 위 실기·운영 확인 필요              |
| 2026-09-27 | QA21 후속 쿠키 수정 `c663f89f`                         | App Worker의 응답별 쿠키 소유권. DB 이전·대기·전체 로그아웃 불필요. 구 App reader로 복구 시 로그인 영향 기록    | 483파일/9,915 pass/1 기존 skip, 새 쿠키 회귀 29개 및 Chromium 재현 통과 |
| 2026-09-27 | 수정 없는 발굴 감사, checkout `7538e9d7`, 제품 코드 `c663f89f` | 독립 결함 B01–B04를 미수정 목록에 추가. 발견·재검증만 수행, 제품·배포 계약 변경 없음 | 집중 회귀 32파일/1,041 pass 및 네 결함 독립 재현. 배포 전 처리 결정 필요 |
| 2026-09-27 | B01–B04 일괄 수정 `b833e2a62bd7eceaa1c9a074d463a36477b514e4` | 클라이언트 3건과 App Worker 번역 내보내기 수정. `all` / Developer API D1 off 유지, 마이그레이션 없음 | 487파일/9,960 pass/1 기존 skip, 타입·린트·빌드·브라우저 회귀는 수정 기록 참조. 최종 main CI·실기·배포 대기 |
| 2026-09-27 | 수정 없는 2차 발굴, checkout `63516859`, 제품 코드 `b833e2a6` | C01–C03 추가 확정·미수정. 제품·배포 계약 변경 없음 | 집중 회귀 35파일/913 pass와 별도 발견 재현. 세 건 처리 결과를 승격 전에 갱신 |
| 2026-09-27 | C01–C03 일괄 수정 `3dd9086cdced0fc25426da82239977b6da004074` | PRO 공유 종료 복귀, 일반방 프리로드, App Worker 번역 추천 수정. 구버전 END 호환, 데이터 이전 없음. `all` / Developer API D1 off 유지 | 488파일/10,004 pass/1 기존 skip, Chromium 19개·타입·린트·빌드·10 guard·6 Worker dry-run 통과. 실기·최종 main CI·배포 대기 |
| 2026-09-27 | 수정 없는 3차 발굴, checkout `ab4220b7`, 제품 코드 `3dd9086c` | D01 추가 확정·미수정: PRO 공유 중 신규 입장의 이전 YouTube 복원. 제품·배포 계약 변경 없음 | 집중 회귀 46파일/1,700 pass. 별도 재현 2실패/1 대조군 통과 및 독립 재실행. 승격 전 처리 필요 |
| 2026-09-27 | 4차 발굴 및 D01 수정 `2347760c5e5b902327a05ca216c8b72409ee72d3` | 새 확정 0건 후 기존 D01 수정. App 클라이언트의 자동 복원 소유권만 변경, 새 데이터/Worker 계약 없음 | 발굴 고유 21파일/328 pass. 최종 491파일/10,022 pass/기존 1 skip, Chromium 8개·전체 타입/린트·App 빌드·9 guard 통과. 확정 미해결 목록 정리, 실기·main CI·배포 대기 |
| 2026-09-27 | Luna 조합 탐사, checkout `1439e338`, 제품 코드 `2347760c` | 제품 수정 없이 새 확정 0건. 배포 범위·버전·계약·기존 해결 상태 유지 | 새 프로브 7파일/1,250 pass/최종 fail·skip 0, ASTRA 주요 1,082개 재실행 통과. 모듈·모사 경계 검사이며 실기·전체 E2E 대체 아님 |
| 2026-09-27 | 검색 스켈레톤 UI 검토, checkout `693ded3a` | 상태 안내 위치 이동 확인·미수정. 회색은 기존 surface-3 토큰으로 확인 | 로컬 Chromium 390×844에서 로딩→실패 시 약 374px 이동. HTML/CSS·검색 모듈 사용, 응답 모사. 제품·배포 변경 없음 |
| 2026-09-27 | 검색 상태 안내 배치 수정 `736f195c8e6414ea527b0781cd96154ef36b452e` | HTML의 안내 노드만 입력창 바로 뒤로 이동. 기존 색상·로직·ARIA·배포 계약 유지 | 기존 3파일/282 pass, 로컬 Chromium 4개 화면에서 로딩·실패·빈 결과·성공 위치 유지 및 URL 미리보기 확인. 제품 버전·캐시와 main·프로덕션은 유지 |
| 2026-09-27 | 스켈레톤 색상 조정 `b9ea66d3b91fe35b04a9da6cc9a6b1011861c144` | 썸네일·제목·채널의 surface-3를 surface-2로 변경. 모션·불투명도 유지 | 로컬 Chromium 다크/라이트 computed style·화면 확인. CSS 색상만 변경, 전체 테스트 재실행 없음 |
| 2026-09-27 | 스켈레톤 불투명도 조정 `bc8e25757abacdd2ee82c368b4617be42be328e4` | 55–90%에서 60–100%로 조정. surface-2·1.6초 주기·동작 줄이기 유지 | 로컬 Chromium 애니메이션 시작/중간 값과 reduced-motion 확인. CSS 두 값만 변경 |
| 2026-09-27 | 스켈레톤 색상·불투명도 재조정 `df7b915a9c17465a30dbfae82cec9389c4d2f56d` | surface-3·50–80%로 변경. 1.6초 주기·동작 줄이기 유지 | 로컬 Chromium 다크/라이트의 색상·애니메이션 범위·reduced-motion 확인. CSS만 변경 |
| 2026-09-27 | 스켈레톤 불투명도 추가 조정 `09123ea84081660ad8578b81e98f795386555179` | 25–50%로 변경. surface-3·1.6초 주기·동작 줄이기 유지 | 로컬 Chromium 애니메이션 범위·reduced-motion 확인. CSS 두 값만 변경, 전체 테스트 재실행 없음 |
| 2026-09-27 | Bluetooth YouTube 시작 조사: main `35759e8b`, beta checkout `10f12cec` | 사용자 보고를 잔여 실기 확인에 추가. 시작 예약·학습은 플레이어 시간과 플랫폼 보정에 의존하며 출력 장치별 지연을 측정하지 않음. 제품 코드·배포 범위 유지 | Windows에서 소스·main/beta diff와 공식 YouTube API 문서 검토만 수행. Bluetooth 실기·새 자동 테스트 미실행. 지연 원인은 가설이며 회귀 테스트 통과로 물리적 첫 음 정렬을 보장하지 않음 |
| 2026-09-27 | 수동 싱크 후 제로스타트 조사: checkout `ae98afc3`, main 비교 `35759e8b` | 사용자가 Bluetooth 가설을 정정. S01–S02 확정·미수정으로 추가. 제품 코드·버전·배포 계약 변경 없이 조사 기록만 갱신 | Standard 592·PRO 17·입력 75 관측, 기존 집중 244 통과. Chromium 2개 context·local PeerJS·모사 iframe에서 실제 UI 재현. 전체 스위트·실기·프로덕션 검증 아님. [상세 근거](design/youtube-manual-zero-start-audit-2026-09-27.md) |
| 2026-09-27 | S01–S02 수정 `c3eae88c` | 일반방/PRO 음수 보정의 참가자별 시작 지연, 일반방 반복 직후 입력 snapshot 대기. App만 추가 변경; 새 서버·DB·UI 계약 없음 | 전체 493파일/10,118 pass/기존 1 skip, 수정 완료 후 YouTube 937 pass, UI Chromium 6+1 pass, App/테스트/E2E 타입·린트·빌드 통과. 검사 시점과 실기 한계는 위 수정 항목 참조. 베타만 반영 |
| 2026-09-27 | 극단값 동기화 감사: checkout `fe3fdb10`, 제품 `c3eae88c` | XS01–XS04 확정·미수정. 제품·계약 변경 없이 현재 미해결 목록과 발견 근거만 갱신 | 새 모듈 863개/823 pass/40 fail/0 skip, 같은 4원인 재현. YouTube UI 6 pass/2 fail, native PCM 4관측 및 소스 전환 1 pass. PRO 모사·실기 제한은 [감사 기록](design/extreme-manual-sync-audit-2026-09-27.md) 참조 |
| 2026-09-27 | XS01–XS04 수정 `c242bfd17f652f1480a6e79731d5130b5b6f6c19` | App 클라이언트 소유권·실제 출력·시작 시각 보정, 늦은 새 명령 취소 포함. 새 UI/서버/DB 계약 없음. 베타만 반영 | 495파일 전체 10,245 pass/4 timeout/기존 1 skip 후 동일 4개 단독 통과, 고유 10,249 pass 확인. Chromium 14개·전체 타입/린트·빌드 통과. cache 증분은 승격 전 필요. [수정 기록](design/extreme-manual-sync-repair-2026-09-27.md) |
| 2026-09-27 | 후속 전체 QA: checkout `dd55d3bc`, 제품 `c242bfd1` | 제품 변경 없이 FQA01 추가 확정·미수정. 별도 E2E 대기 조건 1건·coverage 선택 누락 2건. 배포 범위·계약·버전·동결 유지 | 전체 단위 10,249 pass/기존 1 skip, broad coverage 통과. Chromium 550 pass/1 test-timing fail, WebKit 60 pass/기존 3 skip. 실제 Sync 버튼 새 결함 두 번 재현. 원본 critical/Worker gate 실패와 원인 입증은 [전체 QA](design/beta-full-qa-2026-09-27.md) 참조 |
| 2026-09-27 | FQA01·QA-T01–QA-T03 수정, `d3ef74ab4e196abbc2b2f3ea97988e3a91e379ac` (동일 소스 작업 트리 검증 후 커밋) | 외부 복구·PLAYING 응답 대기까지 동기화 소유권 유지, 새 명령·재진입·중도 입장 보완. E2E 수렴 조건·coverage 파일 선택 수정; UI·정책·Worker 계약·배포 범위 유지 | 전체 단위/broad 496파일·10,264 pass/0 fail/0 skip, critical 1,772·tooling 342·Worker 1,726과 원래 gate 통과. 정적 23개·Worker dry-run 6개·집중 Chromium 2개·WebKit 60개 통과/기존 3 skip. 최종 전체 Chromium 552개·프로덕션 smoke 10개 통과; cache 증분은 승격 전 필요. [수정 기록](design/beta-full-qa-repair-2026-09-27.md) |
| 2026-09-29 | 시작 로고 리빌 `79f3a687a7222a69ff865846e0c715aa197d0f10` | 정확한 단일 nonzero 마스크, 복제본의 같은 타임라인, 완료·fallback 처리. App만 추가 변경, 누적 배포 범위·계약·버전 동결 유지 | 단위 88·Chromium 21·WebKit 6·프로덕션 smoke 9 pass, artifact guard 8개 통과. 두 엔진 각각 16개 내부 접합부 표본 통과. 전체 스위트·실기 재검증 아님 |

### 실제 승격·배포 기록 — 아직 미실행

| 기록 항목                                        | 값     |
| ------------------------------------------------ | ------ |
| 사용자 종료·승격 지시                            | 미확인 |
| 최종 베타 코드 SHA / PR                          | 미정   |
| 최종 main SHA / main CI run / candidate          | 미정   |
| 제품 버전 / cache epoch                          | 미정   |
| Release run / target / D1 입력                   | 미실행 |
| checkpoint / Worker 버전·메시지 / smoke          | 미실행 |
| fresh·기존 탭/PWA / 주요 기능 확인               | 미실행 |
| Operations Drift Audit 재활성화 / main 실행 결과 | 미실행 |
| 남긴 제한·복구 조치 / 완료 일시                  | 미정   |
