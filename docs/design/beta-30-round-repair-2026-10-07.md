# 베타 30라운드 후속 수정·검증 — 2026-10-07

| Field | Value |
| --- | --- |
| Status | Evidence — 수정·로컬 검증 완료, 미확정 관찰 1건 유지 |
| Applies to | `mxqr_beta`의 확정 12건 수정과 별도 안정성 보강 2건 |
| Last source review | 2026-10-07 |
| Baseline | `f98892cd1218defb80cc2ec99cd87024523da684` |
| Tested code | `4a605791b7f4680cc85d4718117d8db231c1d772` — 동일 작업 트리 검증 후 커밋 — 아래 소스 digest와 불변 빌드 기록 참조 |
| Related documents | [발견·재판정 원본](beta-30-round-qa-2026-10-07.md), [배포 준비 기록](../beta-release-readiness-archive-2026-10-10.md) |

사용자의 전체 진행 승인으로 이전 읽기 전용 QA에서 수집한 항목을 수정했다.
당시 판정 **확정 12건·미확정 2건·제외 2건**은 역사적 결과로 보존한다.
두 미확정 관찰은 새 품질 정책에 따른 보강이며, 확정 결함 수에 소급 합산하지 않는다.
R06-C01과 R11-C02는 제외 판정을 유지하고 그 가정에 맞춘 제품 수정을 하지 않았다.

`main` 기준은 `35759e8b07f1ee0b272afbd0af03c770a858889e`다. 대회 동결을 유지하며
베타에서만 편집·검사한다. 공개 배포, main 병합, 원격 PR 생성, Operations Drift Audit
재활성화는 하지 않는다. 버전 `8.6.61`과 PWA 캐시 `v630`의 공개 승격용 증분도 아직 남아 있다.

## 1. 확정 항목의 수정

| ID | 수정한 동작 | 주요 회귀 근거 |
| --- | --- | --- |
| R01-C01 | 연속 큐 렌더 전에 포커스 소유자를 보존한다. 사용자가 다른 곳으로 이동했으면 복원하지 않는다. | 유지 단위 행렬, 5,000개 하위 곡의 마지막 행에 포커스를 둔 상태에서 운영자의 실제 2파일 업로드 |
| R02-C01 | 준비·resume 대기 중인 호스트 파일 PLAY도 뒤의 MediaSession PAUSE가 취소한다. | 실제 transport 회귀, 등록된 콜백·native AudioContext의 PAUSE/STOP/정상 PLAY/취소 후 재시작 |
| R05-C01 | 디코딩을 가로지르는 파일 시작 시점에 monotonic 기준을 함께 보존한다. | 디코딩 중 벽시계 0/−5/+5초 변경 후 native 시작 위치·pending 상태 확인 |
| R05-C02 | 로컬 벽시계와 monotonic 시계의 불연속을 새 호스트 표본으로 확인해 기존 표본을 보정한다. | ±1초 변경, 지연·비대칭 RTT, monotonic 정지 sleep, 모호한 in-flight 응답과 새 PING 복구 |
| R11-C01 | YouTube ID의 11자리 뒤에 식별자 문자가 더 있으면 접두 ID로 잘라 받아들이지 않는다. | URL 형식별 단위 대조군, 잘못된 URL 거부 뒤 정상 URL의 실제 큐 추가 |
| R22-C01 | Miniflare 아래 sharp를 0.35.5로 패치했다. | 전체 감사 0, registry 서명, 분리된 새 설치와 native Sharp/esbuild/Miniflare 실행 |
| R23-C01 | 싱크 값 Enter 커밋 후 Done으로 포커스를 옮겨 Escape와 원래 Sync 버튼 복원을 유지한다. | Enter/beforeinput 단위 회귀와 실제 브라우저 키보드 조작 |
| R24-C01 | 실패한 JS import의 후속 복구는 같은 빌드의 불변 JSON 사전·복수형 자료를 사용한다. | 실패 module map을 유지한 단위 경로와 실제 온라인·언어 재선택 복구 |
| R24-C02 | 실패한 폰트 CSS를 원래 불변 URL의 새 native link로 재시도하고 load를 확인한다. | 실제 CSS 장애 후 Noto Sans Arabic font face 로딩, 정상 fallback 대조 |
| R24-C03 | 채팅의 동기 dummy→editor 포커스 순서에 `preventScroll`을 적용한다. | 기존 IME 순서 유지 회귀, Hebrew/English 실제 채팅 영역·입력 포커스 확인 |
| R26-C01 | 같은 업데이트 세대의 안내창 수명 동안 Web Locks를 보유한다. 저장소 기반 fallback에서는 소유권을 잃은 안내를 철회한다. | 잠금·소유권·취소 통합 단위, 실제 SW 교체와 두 탭 안내·재로드 검사. 추가 legacy 진단 10/10 통과; 최초 갱신 실패 1회는 원인 미확정으로 유지 |
| R29-C01 | Standard 방의 실제 수명·역할 정보를 사용해 진단에 방 종류를 기록한다. | host/guest/PRO/standalone 단위 대조, 일반방 양쪽의 공개 `/debug sync` 내보내기 |

시계 수정은 기존 2초+RTT 불확실성 보호를 낮추지 않는다. 시계 변경과 sleep을 구분할
수 없는 진행 중 PONG은 버리고 다음 새 교환을 기다린다. 네트워크 지연만으로 정렬된
오디오를 잘못 옮기는 회귀를 막는 조건도 함께 유지한다.

## 2. 안정성 보강 두 항목

**R25-C01 — 번역 제출의 지속적인 재시도 식별.** 같은 저장 초안 버전을 같은 계정으로
재시도하면 새로고침·다중 탭·재로그인 뒤에도 서버 기록 하나로 연결한다. 초안에 선택적
`revisionId`를 저장하고 전체 내용과 함께 결정적인 UUIDv8 요청 ID를 만든다. 서버의
기존 `(account_id, request_id)` 고유 키가 계정을 구분한다. 세션마다 바뀌는 `statsScope`는
요청 ID에 포함하지 않으며 기존 인증 헤더와 늦은 응답 차단에 계속 사용한다.

POST 전에 정확한 초안의 저장 성공을 확인한다. 저장 공간 부족·접근 거부·다른 탭과의
충돌이면 제출을 멈추고 입력을 보존한다. 응답 유실이나 성공 후 초안 삭제 저장의 실패도
같은 서버 영수증으로 복구된다. 새로운 제안은 같은 문구라도 새 ID를 받는다. 구 버전-1
초안은 읽을 수 있고 편집 전에는 기존 timestamp가 버전을 구분한다. 새 DB·migration·
secret·binding·서버 보관 자료는 추가하지 않는다. 이전 캐시/롤백 편집기의 재시도 동작까지
바뀌는 것은 아니다. [운영 계약](../account-auth-operations.md#translation-community-tables).

독립 번역 페이지는 App의 구형 브라우저 bootstrap을 로드하지 않는다. `randomUUID`가
없는 환경에서도 초안 입력·자동 저장을 유지하도록 페이지 전용 `getRandomValues` 기반
UUIDv4 대체 생성을 추가했다. 입력·사유 편집·저장·참조 재검토·제출의 단위 경로와
실제 브라우저의 입력·저장·reload·제출을 검증했다.

**R08-C01 — 정상 파일 전송 계약을 수신 전에 확인.** 고정 크기 Blob slice와 마지막 조각의
정확한 길이, 순번, 활성 세션의 파일 정보가 맞는지 저장·진행 수 증가 전에 확인한다.
거부된 프레임이 정상 prefix·카운터·watchdog를 갱신하지 않도록 한다. 기존 제한된 복구와
실패 UI, 뒤의 정상 전송은 유지한다. 정상 sender/receiver·이어받기·복구 회귀를 검증한다.
원래 자동 보안 필터가 중단한 인증 호스트의 비정상 입력 재현을 우회하거나 다시 실행하지
않았다. 해당 검증 한계와 **운영 취약점으로 확정하지 않은 상태**를 보존한다.

최종 교차 검토에서 START/RESUME의 생략된 MIME이 `''`로 정규화되는 기존 계약을 확인했다.
이후 정상 청크가 MIME을 제공할 때 이를 충돌로 처리하던 새 검사 조건을 수정했다.
정상 Blob 기반 두 회귀가 수정 전 실패했고, 수정 후 관련 4파일 210개가 통과했다.
비어 있지 않은 MIME이 양쪽에 명시되면 여전히 일치해야 한다.

## 3. 검증 기록

Windows, Node 24.20.0/npm 12.0.2, 저장소의 Vitest/Playwright 버전과 기존 timeout·
network guard·coverage 하한을 사용했다. 브라우저 자동 retry는 0이다. 개별 집중 검사의
겹치는 수를 전체 고유 검사 수에 더하지 않는다.

- 최종 E2E build 05:55:58 UTC와 production build 05:57:53 UTC 완료. 초기/최종 빌드를
  별도의 불변 디렉터리에 보존하고 브라우저별 포트로 제공했다.
- 최종 전체 타입·lint·서식 검사와 소스 guard 16개·Worker syntax 통과.
- 최종 production 산출물 guard 8개와 Worker dry-run 6개 통과.
- 초기 빌드 WebKit 66 pass / 기존 3 skip. 최종 production candidate 17 pass,
  최종 E2E 영향 범위 5파일 18 pass(번역 6·파일 전송·재접속·큐 포커스·진단).
- UI 실제 브라우저 고유 6개와 R02/R05-C01 native 브라우저 7개 통과. 후자는
  `Date.now`를 제어하면서 실제 AudioContext의 예약·시작·출력 위치를 관측한 검사다.
  R05-C02는 제어된 시계의 유지 protocol/clock/transport 회귀로 검증했으며,
  native 다기기나 실제 OS 시계 변경을 관측했다는 뜻은 아니다.
- critical 55파일 1,869개, tooling 13파일 342개, Workers 26파일 1,728개 및 각각의
  coverage 하한 통과. 마지막 호환성 보완은 이 세 coverage 대상의 제품 코드를 바꾸지 않았다.
- 최종 전체 unit는 517파일 **10,730 pass**, fail/skip/todo 0이다. 초기 빌드 전체
  Chromium은 83파일 **580 pass**, fail/skip/flaky/runner error/자동 retry 0이다.
- `build:checked`는 기존 cache-history gate에서 실패했다. 일반 production build와 그 뒤
  산출물 검사는 따로 실행했다. 공개 승격 전 버전/캐시 증분을 완료해야 한다.
- 전체/prod-only audit 0건, registry 서명 486개·attestation 103개 검증. 새 설치 486개
  패키지와 native Sharp(SVG→PNG 2×3, rsvg 2.63.2)·esbuild·Miniflare/workerd 요청 검증 통과.
- 최종 초기 전송 예산: entry 423.3 KiB raw/125.3 KiB gzip, eager JS 444.0 KiB gzip,
  eager total 1,876.9 KiB raw/514.6 KiB gzip, eager fonts 0. 모든 예산의 5% 여유 유지.

| Coverage profile | 파일 / 통과 검사 | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- | --- |
| Broad, 최종 전체 unit | 517 / 10,730 | 86.54% | 80.28% | 91.08% | 90.20% |
| Critical runtime | 55 / 1,869 | 81.61% | 76.13% | 87.64% | 85.77% |
| Release tooling | 13 / 342 | 78.27% | 73.87% | 87.09% | 80.14% |
| Workers | 26 / 1,728 | 84.26% | 80.79% | 92.63% | 88.93% |

네 profile 모두 기존 전체·파일별 하한을 통과했다. profile 간 중복을 합산하지 않는다.

초기 실패와 수정을 숨기지 않는다. 새 locale plugin의 tsc project 등록 누락·서식 오류를
수정했다. 전체 단위 첫 실행은 10,726 pass/1 fail이며, 신규 tooling 등록에 맞춘 계약 검사의
기대 목록 한 줄 누락이었다. 정확한 목록 비교를 유지하며 수정했고 원래 파일 5개 검사가
통과했다. YouTube 정상 URL 대조는 metadata 준비와 실제 큐 내용을 기다리도록 강화했다.
native 오디오 관측은 WebAudio `start(0)`을 호출 즉시 시작으로 계산하도록 바로잡았다.
폰트 복구 검사는 bootstrap 재시도 횟수를 고정하지 않고 사용자 재선택 전까지 장애를 유지해
복구 전·후를 비교한다. 기존 시간 테스트 두 곳은 벽시계만 움직이던 대기 표현을 실제 경과에
맞춰 monotonic 시계와 함께 움직이도록 바꿨고 예상 RTT·offset은 유지했다.

**미해명 관찰 1건을 남긴다.** 초기 legacy SW 경쟁 실험에서는 실제 Refresh 클릭 뒤 안내가
닫혔지만 15초 동안 새 문서 요청·reset overlay·두 탭의 재로드가 관측되지 않았다.
후속 성공이 이 최초 실패를 무효화하지 않는다. 당시 trace에는 승인 뒤 SKIP_WAITING과
worker activation/controllerchange 경계를 특정할 자료가 부족했다. 별도 담당자의 독립
trace·소스 검토에서도 승자의 소유권 취소나 다른 구체적 원인은 입증하지 못했다.

같은 불변 production 빌드로 추가 진단을 최대 10회, 첫 실패에서 종료하도록 실행했다.
10/10 통과했고 이 중 9회는 실제 두 소유자의 저장소 경쟁이었다. native SKIP_WAITING
10회/전송 예외 0, 승인 뒤 controllerchange 20회와 각 탭의 새 문서·v631 ready를 확인했다.
안내창 소유권 취소 9회는 모두 승인 전·비승인 탭에서 발생했고 승인 뒤 안내 취소와
페이지 오류는 0회였다. 관측은 페이지 밖 JSONL에 보존해 navigation 중 진단 평가 오류를
피했다. 계측이 타이밍을 바꿀 가능성까지 남기며, 추정에 근거한 제품 수정은 하지 않았다.
따라서 R26의 중복 안내 수정 근거와 **갱신 승인 뒤 진행 정지의 미확정 관찰**을 구분한다.

복구 담당 브라우저 실행은 합계 33회(28 pass/5 fail)다. 실패 5회는 수정한 CSS 실험 조건 1회,
예상 navigation 도중 진단 평가가 중단된 무효 실험 3회, 위 미해명 관찰 1회다. 고유 시나리오
14개에는 성공 근거가 있지만 반복 통과를 새로운 고유 사례로 합산하지 않는다.

원본 30라운드 자료는 수정하지 않았다. 후속 명령·reporter JSON·trace·사진·빌드 SHA256은
로컬 `scratch/beta-14-repair-2026-10-07/`에 보관한다. 담당 상세 보고서는 `ui/report.md`,
`timing/report.md`, `recovery/report.md`, `p2p/report.md`다.

`snapshot-final-code.json`은 최종 소스와 초기/최종 빌드 3,126파일의 SHA256을 기록한다.
문서·회귀 테스트를 제외한 코드 목록의 digest는
`fd6d2f56c77d3815a6f0c74cbb9abbd0d5f3b099ed4f4b1289c2254f28e4bf52`다.
최종 통합 검사 중 제품 소스는 고정했다. 기존 580개와 마지막 호환성 보완 뒤의 영향 범위
재검증을 구분하며, 같은 시험의 반복 통과를 더해 전체 고유 수를 부풀리지 않는다.
`source-freeze-*.json`은 테스트·설정을 포함한 비 Markdown 1,809파일의 내용 일치를
별도로 확인한다. 새 UUID 브라우저 회귀는 최초 580개 수집 뒤에 추가되어 최종 18개와
production 17개 실행에 포함됐다. 브라우저 결과 합계에 중복으로 더하지 않는다.

## 4. 남은 확인과 공개 승격

물리 기기의 첫 음 정렬, 실제 OS 미디어 버튼 전달, 실기 iOS IME·TV·절전 복귀,
실제 YouTube/OAuth/CDN와 운영 Cloudflare 상태를 자동 로컬 검사로 완료했다고 보지 않는다.
Web Locks와 공유 저장소를 모두 쓸 수 없는 환경에서는 다른 탭의 존재를 알 수 없어
업데이트 안내의 단일 표시를 보장하지 않는다. 저장소만 있는 legacy 경로는 수렴 방식이며,
아주 늦은 경쟁 쓰기 사이에는 일시적으로 두 안내가 보였다가 소유권을 잃은 쪽이 닫힐 수 있다.

같은 빌드의 사전·CSS·폰트 원본까지 계속 접근할 수 없으면 English/system-font fallback을
유지한다. 임의의 새 빌드 자료나 강제 페이지 재로드로 활성 방을 바꾸지 않는다.
승격 시 App 산출물의 새 JSON 파일도 함께 배포해야 한다. 기존 누적 서버 변경의
`target=all`과 다른 공개 승격 조건은 [준비 기록](../beta-release-readiness-archive-2026-10-10.md)을 따른다.
베타 통과는 최종 main SHA의 CI·릴리스 후보·운영 배포 성공을 대신하지 않는다.

## 5. 현재 판정

확정 12건의 수정과 별도 안정성 보강 2건을 베타에 반영하고 로컬 회귀 검증을 완료했다.
원래 미확정 두 건을 확정 결함으로 바꾸어 세지 않는다. 수정 과정에서 확인한 구형 UUID·
선택 MIME 호환성 회귀도 보완하고 대조 검사로 확인했다. 남은 것은 원인을 입증하지 못한
legacy 승인 후 갱신 관찰 1건과 위 실기/live·공개 승격 항목이다.

현재 CI는 main push/main 대상 PR에서 실행되므로 beta push를 exact-main CI 성공으로
기록하지 않는다. main 병합·PR·배포·운영 감사 재활성화 없이 베타에만 커밋·푸시한다.

검증 명령은 기준 HEAD `f98892cd` 위의 수정 작업 트리에서 실행했고, 비 Markdown
1,809파일이 그대로인 상태를 확인해 코드 커밋 `4a605791b7f4680cc85d4718117d8db231c1d772`로 저장했다.
이 SHA를 적는 후속 커밋은 문서만 변경한다. main의 정확한 후보 SHA로 실행한 CI는 아니다.
