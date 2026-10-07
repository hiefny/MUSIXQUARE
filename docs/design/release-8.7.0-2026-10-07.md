# MUSIXQUARE 8.7.0 / v631 production release — 2026-10-07

`mxqr_beta` 누적 변경을 [PR #245](https://github.com/hiefny/MUSIXQUARE/pull/245)로
병합하고, 정확한 main SHA `e8001e93c9390ec20b359b015d3dff890f2b5304`를
프로덕션 6개 Worker에 배포했다. [Production Release 37584399403](https://github.com/hiefny/MUSIXQUARE/actions/runs/37584399403)은
2026-10-07 07:02:35 UTC(16:02:35 KST)에 성공했다. 입력은 `target=all`,
`apply_developer_api_d1=false`다. 이 후속 기록의 문서 커밋은 배포 SHA가 아니며,
문서 전용 변경으로 추가 App 배포를 요구하지 않는다.

로컬·원격 `mxqr_beta`는 양쪽 `efce531a`가 main의 조상임을 확인한 뒤 삭제했고,
release 임시 브랜치도 정리했다. 이 문서 전용 후속 PR의 커밋은 배포와 구분한다.

## 소스·후보와 검증

- 승격 전 App/main: `35759e8b07f1ee0b272afbd0af03c770a858889e`.
- 종합 베타 QA 코드: `4a605791b7f4680cc85d4718117d8db231c1d772`;
  QA 근거 보완 문서: `efce531a690857790509fde5f851a9b72db1ee05`.
- 버전/cache 준비: `fe0b0230ec5621a5b892f75e0427c7bfb2569d66`,
  main 병합 SHA와 동일 파일 트리. 하이브리드 오디오 기능을 포함한 minor
  `8.7.0`, 서비스 워커 cache `v631`, index bootstrap cache query를 반영했다.
- 로컬 `build:checked`, 버전/cache 48개, production Chromium 17개·WebKit SW
  1개 통과. 첫 build에서 index의 `cache=v630` 누락을 발견해 푸시 전에 수정·amend한
  뒤 통과했다. 초기 실패는 별도 준비 이력으로 보존한다.
- [PR CI 37583265963](https://github.com/hiefny/MUSIXQUARE/actions/runs/37583265963)와
  [정확한 main CI 37583802398](https://github.com/hiefny/MUSIXQUARE/actions/runs/37583802398)는
  각각 11개 job을 모두 통과했다. 아래 수치는 main CI의 실제 로그다.

| main CI 검증 | 결과 |
| --- | --- |
| 전체 unit, 두 shard 병합 | 517파일·10,729 pass·기존 Windows 전용 1 skip·fail 0 |
| Critical runtime coverage | 55파일·1,869 pass |
| Worker runtime coverage | 26파일·1,728 pass |
| Release tooling coverage | 13파일·342 pass |
| production artifact Chromium/SW | 17 pass |
| 필수 Chromium 경로 | 22 pass |
| 정적·빌드 | 타입·lint·서식·source/artifact guard·6개 Worker bundle 통과 |
| 의존성 보안·서명 | 감사 0건, registry 서명 487·attestation 104 검증 |

Linux의 1 skip은 `pro-grant-campaign-cli.test.ts`의 기존 Windows 전용
다른 드라이브 경로 검사다. 베타 Windows의 10,730 pass와 환경을 구분한다.
coverage profile은 전체 unit과 겹치므로 고유 검사 수에 더하지 않는다.
원래 4종 coverage gate는 모두 통과했다.

| Coverage | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Broad, shard 보고서 병합 | 86.54% | 80.27% | 91.08% | 90.20% |
| Critical runtime | 81.61% | 76.13% | 87.64% | 85.77% |
| Worker runtime | 84.26% | 80.79% | 92.63% | 88.93% |
| Release tooling | 78.27% | 73.87% | 87.09% | 80.14% |

Immutable artifact는
`production-candidate-e8001e93c9390ec20b359b015d3dff890f2b5304-37583802398-1`
(GitHub artifact `11465921497`)이다. `main-ci` manifest는 782파일,
`8.7.0`/epoch 631과 정확한 SHA를 기록한다. manifest SHA-256은
`726c967045fda523b4f72eb63dcbf5ec4a285d8f734a3cb06e5527c31e338851`이다.
CI 환경은 Ubuntu·Node v24.20.0이며, 설치는 packageManager에 따라
`corepack npm ci`로 npm 12.0.2를 사용한다. 후보 manifest의 실제 도구 기록은
Node `v24.20.0` / npm `11.19.0` / Wrangler `4.130.0`이다.
일반 npm 실행의 버전을 설치 단계와 같다고 바꿔 기록하지 않는다.
Release는 후보의 SHA·hash를 다시 검증하고 같은 App artifact를 재사용했다.

## checkpoint·배포·live smoke

mutation 전에 Worker/R2 checkpoint를 캡처·업로드하고 그 증거로 변경을 승인했다.
`production-recovery-checkpoint-e8001e93c9390ec20b359b015d3dff890f2b5304-37584399403-1`
artifact에 6개 Worker의 이전 deployment/100% version/message, R2의
remote-share CORS·lifecycle/PRO media CORS, signaling Custom Domain과 호환성
floor가 보존됐다. 이전 App은 `35759e8b`, 다른 5개 Worker는
`70edc9e912ab41e0bfbc01f61d7aecf510157c59`였다. 이전 모든 Worker를 당시 main과
동일 SHA라고 추정하지 않는다.

정식 순서 PRO → remote-share → signaling → Developer API facade/API → App으로
배포했다. 최종 보고서는 07:02:24.350 UTC에 6개 Worker 모두 `verified`였고,
각 `*-final-current.json`의 단일 version 100%, 배포 ID, 메시지와
`*-state.json`의 `ownedByRelease=true`가 일치했다. 공통 메시지는
`git:e8001e93c9390ec20b359b015d3dff890f2b5304`다.

| Worker | 최종 deployment ID | 최종 100% version ID |
| --- | --- | --- |
| PRO room | `308ee53d-f4d5-4eef-a6ee-db33e1b9b468` | `5b4fbf2e-5592-4bd9-b95c-9a0cefdac8da` |
| Remote share | `509e3681-ccf1-42ee-aba7-076ab50ecb65` | `6321ecb6-a13a-49ba-8fd0-55faba7126c6` |
| Signaling | `002cfc79-4377-49c1-8ee8-1ad0cda9f031` | `440b001f-986d-44ae-8ebd-ee2d3fb00cc9` |
| Developer API facade | `56dc03ee-6469-4ad3-9403-099104c2069a` | `338d8775-5e22-4cae-a8f1-536e8b1d4fcb` |
| Developer API | `2b4cf821-2917-4673-a9c5-a68399d39dd7` | `1f83bf61-d71e-46d3-9e0e-a1e3d8dc32ef` |
| App | `719596b7-2ee4-4c81-9183-7a70a948120c` | `6b0fe9bc-4382-4944-9c92-e9afe109668a` |

PRO room·PRO media CORS·remote-share·signaling·Remote Share host assertion·
Developer API·App generation·익명 계정 경계·App 배포 후 PRO public 경계·
Standard HTTPS signaling fallback의 모든 workflow smoke가 성공했다.
private facade는 public API와 한 쌍으로 검증했다. Developer API D1 선택 입력은
false였으며, App의 일반 idempotent baseline·번역 테이블과 기존 authority
계약 등의 적용·검증은 워크플로 계약에 따라 성공했다.

PRO cutover는 rollout 동안 fenced 상태를 거쳐 최종 `ready`,
`release_sha=e8001e93...`, `ever_enabled=1`, `generation_floor=1`을 확인했다.
영구 floor `4c5612d5fc4c5548781eb7d5b26d6904969c051c`는 유지됐다.
signaling Custom Domain 최종 검증 후 `production-committed.json`은 정확한
SHA와 `target=all`을 기록했다. 실패 복구 job은 skipped였고 rollback은 수행하지
않았다. 이 증거는 같은 run의 `production-deployments-...`와
`production-commit-...` artifact에 남아 있다. 향후 복구는 캡처된 호환성·소유권
경계를 따라야 하며 이 배포 성공이 이전 forward floor를 제거하지 않는다.

## 감사와 브라우저 확인

Operations Drift Audit는 `active`로 재활성화했다.
[배포 전 37583844459](https://github.com/hiefny/MUSIXQUARE/actions/runs/37583844459)와
[배포 후 37584995408](https://github.com/hiefny/MUSIXQUARE/actions/runs/37584995408)이
같은 main SHA에서 성공했다. 각각 31 pass / 0 fail / 5 manual-only이며,
배포 후 보고서는 07:03:39.330 UTC에 `automated-checks-passed`를 기록했다.
zone-route 조회 권한 미설정, Access/MFA, WAF·비용 알림, 별도 Git-triggered
배포 경로, 운영자가 원하는 review/check 정책은 수동 확인 범위로 남아 있다.

실제 공개 사이트에서 locale JSON 40개와 index/main JS/main CSS/bootstrap/SW를
합한 45개 자산이 exact-main candidate의 SHA-256과 일치했다. 공개 HTML 10개
경로가 200이었고 fresh native Chromium의 en-US/ko-KR 두 context에서 새 main
모듈, active SW와 v631 cache, bootstrap ready/0 failure/0 fallback,
page error 0을 확인했다. 첫 비계측 fetch 시도는 timeout이었고 경로가 기록되지
않아 원인은 미확정이다. 경로를 기록한 후속 전체 실행은 통과했고 원본 로그를
보존했다. 뒤이은 curl root도 200이었다. 첫 시도부터 오류가 없었다고 쓰지 않는다.
운영자 근거는 `scratch/release-8.7.0-2026-10-07/public-verification.json`과
해당 실행 로그다. fresh 공개 확인은 실제 기존 운영 탭/PWA·미디어·인증 경로
검사를 대신하지 않는다.

로컬에서는 보존된 8.6.61/v630 App(725파일 manifest 확인)에서 준비 SHA의
8.7.0/v631(782파일 복사본 동일성 확인)로 native Chromium SW를 갱신했다.
첫 실행은 단일 탭 pass, 미승인 두 번째 탭의 자동 reload 기대가 fail,
Web Locks 없는 경우는 first-failure cap으로 미실행이었다. 구형 소스와 native
이벤트 기록으로 각 prompting 문서가 자신의 승인을 기다리는 정책을 확인했다.
실제 정책을 반영한 별도 후속 실행은 native 두 탭·Web Locks 없는 두 탭
2 pass/0 fail/0 skip, retry 0이었다. 각 탭 자신의 Refresh 승인 뒤 정확한 새
모듈·1회 reload·정상 bootstrap을 확인했다. 최초 실패·후속 성공을 합쳐 첫
실행 전체가 성공한 것으로 쓰지 않는다. 이는 최종 main candidate나 운영 edge의
기존 탭·설치형 PWA·활성 방 검증이 아니다.

## 남은 한계

R26 최초 legacy Refresh 승인 뒤 15초 갱신 미관측 1회는 원인 미확정이다.
당시 추가 진단 10/10 pass와 이번 업그레이드 통과는 그 원인을 설명하지 못한다.
구형 prompt는 새 R26 중복 창 수정 검증을 대신하지 않는다. 실제 iPhone/Android/TV,
Bluetooth 첫 음, 혼합 방·잠금 복귀·장기 메모리·이전 transient PCM 차이는
기존 실기 체크리스트에 남긴다. 활동 중인 방의 탭은 자연스러운 다음 로드까지
갱신을 미룰 수 있으므로 전 사용자 즉시 갱신을 주장하지 않는다.
