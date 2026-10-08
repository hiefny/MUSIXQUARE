# 2차 30라운드 QA 후속 수정 — 2026-10-09

| Field | Value |
| --- | --- |
| Status | Dated repair evidence — 15건 수정·로컬 검증 완료, 미배포 |
| Applies to | 2차 QA 확정 13건과 사용자가 기대 동작을 선택한 미확정 2건 |
| Baseline | main `e7c5529a3273c7132880dd0ad4572b2463405c87` |
| Repair branch | `agent/qa2-repairs-2026-10-09` |
| Tested code | `8c14f0d6da9d351588116e3c7114a213685cd608` — 같은 작업 트리의 회귀 통과 후 커밋, production build는 이 커밋에서 실행 |
| Tested tree | 비Markdown 1,818파일 SHA-256 `8b293841da5681d70817153a1f24fa0141ecf78736cac49c72edb8a8eb5270ec`; 전체 unit·최종 browser 중 변경 0 |
| QA-only follow-up | 아래 캐시 관측 helper·회귀 검사 2파일만 추가 변경. 최종 비Markdown 1,819파일 SHA-256 `eab49a13052b8febd71cd106344862f1d70dde425fc4c6875b405983e0a8578a`; 제품 입력·production artifact 변경 0 |
| Product / cache | 준비 버전 `8.7.5` / `v636`; 운영은 `8.7.4` / `v635` 유지 |
| Related documents | [발견 보고서](beta-30-round-qa-2026-10-09.md), [현재 배포 기록](../beta-release-readiness.md), [권한 계약](account-identity-and-room-authority.md), [릴리스 절차](../hotfix-procedure.md) |

사용자는 미확정 두 건에 대해 제안한 동작을 채택하고, 나머지 확정 항목까지 모두 수정하되
수정 필요성을 항목별 한 번씩 더 확인하도록 승인했다. 14건은 수정 전 새 실행에서 현상을
재현했다. R17-C01은 기존 Daybreak 제한 때문에 차단된 보안 재현을 반복하지 않고 새로운
방어적 소스 검토로 변경 경계의 개별 키 검사 부재를 확인했다. 이 차이를 실행 재현으로
합산하지 않는다. 제외했던 8개 관측은 제품 수정 대상으로 다시 세지 않는다.

## 항목별 수정

| ID | 수정 전 확인 | 최종 변경 |
| --- | --- | --- |
| R02-C01 | 실제 playlist/decode/transport에서 PAUSE 실패, 정상·STOP 대조 통과 | 디코딩 시작 때의 transport 취소 세대를 자동 시작 의도와 연결. PAUSE 뒤에는 버퍼만 준비하고 명시적 새 PLAY를 기다림 |
| R05-C01 | 작은 양의 시계 변경 두 변형 실패, 큰 변경 대조 통과 | 호스트 공유 타임라인 재기준화와 물리 오디오 재기준화의 시계 변경 경계를 일치시킴 |
| R06-C01 | native 포인터를 누른 채 권한 회수/재부여 후 이전 드래그 부활 | 권한 회수 때 제스처·pointer capture를 즉시 취소, 취소 드래그의 change 발행 억제 |
| R07-C01 | 일반 파일·프리로드의 동일 연결 direct→remote 재분류 뒤 수신 실패 | 정확히 같은 호스트 연결·큐·전송 세대의 direct 할당을 수신·복구 동안 유지 |
| R07-C02 | 정상 송신자의 bulk-first 프리로드에서 START 누락 | 초기 프리로드 청크에 수신 버퍼와 같은 64개 제한의 별도 버킷을 적용해 제어 메시지 용량 보존. 기존 활성 세션·호스트·큐 검증 유지 |
| R10-C01 | 대소문자 혼합 watch/short/live 호스트 변형 실패 | 주소의 authority만 소문자로 정규화하고 경로·파라미터·영상 ID의 대소문자 구분 유지 |
| R13-C01 | 늦은 티켓의 갱신·재구성 두 경로가 옛 닉네임 전달 | 티켓 완료 및 fallback 재구성 때 최신 수락 snapshot으로 채널 신원 구성 |
| R16-C01 | 인증된 방 신원 반영 전 집계 기기 확정 | 신원 확인 전에는 집계를 보류하고 같은 계정의 기기 순서를 확인한 후 결정 |
| R16-C02 | 실제 계정 UI·수집기 조합에서 미전송 A→B 전환 후 통계 빈칸 | 통계 조회 직전 이미 공개된 계정 상태를 수집기와 맞춰 B가 A의 flush에 묶이지 않게 함 |
| R17-C01 | 새 소스 검토: 최초 인증 뒤 실제 변경 경계에 개별 키 재검사 없음 | PRO 직렬 변경 경계에서 현재 D1 키의 상태·만료·방 세대·권한 세대·scope를 검사. 미디어 준비·복사·공개 경계도 검사하고 401/403/503을 facade/public API에 전달 |
| R20-C01 | 자연 만료 후 탭만 꺼지고 본문 Active 유지 | 기존 만료 타이머가 본문도 Expired로 갱신. 미저장 초안·교체 공지·저장 중/실패 피드백 보존 |
| R22-C01 | native Tab/Shift+Tab에서 YouTube contenteditable 제외 | 입력창에 명시적 tabindex=0을 부여하고 양방향 순환·Escape 복귀 검증 |
| R22-C02 | reduced-motion에서 첫 포커스·Escape 실패 | Sync overlay 하위 요소까지 visibility transition을 제거해 즉시 포커스 가능하게 함 |
| R23-C01 | AudioContext.resume 대기 후 OFF여도 미리듣기 예약 | 비동기 미리듣기를 설정 선택 세대에 묶고 새 선택 때 이전 작업 무효화 |
| R30-C01 | 새 이벤트·snapshot만 조회하는 두 경로에서 30분 초과 기록 유지 | 기록 추가와 조회 양쪽에 같은 시간·개수 제한을 적용하고 오래된 저장 기록도 정리 |

## 새로 확정한 요구와 한계

키의 회수·자동 만료는 요청 최초 접수만이 아니라 **실제 변경을 시작하기 직전의 최종 인증**에도
적용한다. 본문·내부 대기·미디어 준비를 끝내고 개별 키가 유효해야 변경을 시작한다. 이 검사를
이미 통과해 진행 중인 변경이나 수락된 재생 전환을 분산 트랜잭션으로 되돌리는 기능은 아니다.
회수와 최종 검사가 동시에 진행될 때의 순서를 실제 물리 저장 완료 시각으로 보장하지 않는다.
복사 후 최종 검사에서 거부된 미디어는 큐에 공개되지 않고 기존 예약·정상 만료 정리에 남는다.
API 공개 문서/OpenAPI와 권한 설계에 이 경계를 명시했다.

PRO에는 기존 `DEVELOPER_API_DB` binding과 키 테이블을 사용한다. schema·migration·secret·binding·
공개 요청 envelope 변경은 없다. 추가 조회는 일반 변경 1회, 예약 2회, 완료 최대 4회다.
내부 BOT 예외는 로컬 호출 인자로만 선택되며 사용자 JSON으로 선택할 수 없다. 기존 멤버 권한
검사는 유지한다. 검증 시도 전 기존 키 회수/만료 심화 재현의 실행 제한을 유지했고, 새 helper의
정책 단위검사와 기존 정상 API/PRO 검사를 실행했다. 이것을 차단된 end-to-end 보안 재현 통과로
표현하지 않는다.

공지의 상태 문구는 현재 시각의 유효 상태로 정했다. 만료 갱신은 서버에 새 쓰기를 하지 않으며
관리자가 입력 중인 초안을 덮어쓰지 않는다. 공지 공개 전달 실패가 있었다고 소급 주장하지 않는다.

## 검증

최종 공통 검증은 Windows, 고정 Node `24.20.0` / npm `12.0.2`, 로컬 Vitest·Playwright 환경이다.
에이전트 초기 기능 재현 일부는 PATH Node `24.13.1`에서 실행했으며 각 원본에 도구 버전을 보존했다.

| 검사 | 결과 | 근거·범위 |
| --- | --- | --- |
| 항목별 필요성 확인 | 14건 새 실행 재현, API 1건 새 소스 검토 | 각 보고서의 최초 실패와 정상 대조 보존 |
| 재생·전송 선택 유지 검사 | 15파일, 고유 543 pass | [상세 JSON](../../scratch/qa2-repair-2026-10-09/audio-transfer/report.json) |
| 계정·세션·진단 선택 유지 검사 | 7파일, 고유 214 pass | [상세 보고서](../../scratch/qa2-repair-2026-10-09/account-session/report.md) |
| UI·관리자 선택 유지 검사 | 고유 395 pass | [상세 보고서](../../scratch/qa2-repair-2026-10-09/ui-admin/report.md); 최종 영향 검사로 치환한 고유 수치 |
| API·PRO 선택 유지 검사 | 4파일, 454 pass / fail·skip 0 | [최종 JSON](../../scratch/qa2-repair-2026-10-09/api/focused-final.json) |
| 독립 coverage 프로필 | critical 1,894 / workers 1,773 / tooling 342 pass, fail·skip 0 | 각각 기존 coverage 하한 통과; 서로 중복되는 검사 수 |
| 최초 영향 Chromium | 13파일, 67 pass / fail·skip·retry 0 | 8.7.5/v636 E2E 산출물. 이후 HTML bootstrap cache query를 v636으로 맞춰 최종 산출물 재검증 |
| 최종 영향 Chromium | 3파일, 19 pass / fail·skip·retry 0 | 최종 E2E 산출물의 핵심 브라우저·YouTube 입력·Sync reduced-motion·UI 소리 검사. 최초 67건과 중복 |
| 최종 WebKit | 66 pass / 기존 3 skip / fail·retry 0 | cache query를 보완한 최종 E2E 산출물, iPhone 13 WebKit 자동화. 실물 iPhone 검사 아님 |
| 정적 검사 | 전체 typecheck·lint·format 및 선택 source guards 통과 | 새 leaf project 등록 뒤 전체 typecheck, 최종 matcher 뒤 test typecheck·lint·format, chunk-pump·lifecycle·import graph·hot-path·developer/D1/ops 계약 |
| 최종 전체 unit + broad coverage | 522파일, 10,882 pass / fail·skip·retry 0 | statements 86.58% / branches 80.31% / functions 91.16% / lines 90.24%; 기존 하한 통과 |
| Production build / bundles | build:checked 및 Worker 6종 dry-run 통과 | 커밋된 HEAD에서 cache-history·보안 설정·산출물 guards 포함. App artifact 782파일의 SHA-256을 [manifest](../../scratch/qa2-repair-2026-10-09/common/production-manifest.json)에 기록 |
| Production candidate browser | 최종 Chromium 17 pass / fail·skip·retry 0, WebKit SW 1 pass | 같은 782파일 산출물에서 실행 전후 manifest 일치. 로컬 산출물 검증이며 exact-main CI candidate 아님 |
| QA helper 경계 검사 | 수정 전 1 fail / 대조 3 pass → 수정 후 4 pass | 늦은 캐시 출처 응답, 응답 없음, 추가 bootstrap 실패, aborted 구분. E2E typecheck·정규 tooling ESLint·format 통과 |

선택 검사끼리와 전체·coverage 프로필의 통과 수는 합산하지 않는다. API·전송 변경은 다른
담당자가 읽기 전용으로 검토했다. API 검토에서 미디어 후처리의 재검사 지점 두 곳을 추가했고
보완 후 추가 발견 없음. [API 독립 소스 검토](../../scratch/qa2-repair-2026-10-09/account-session/api-readonly-review.md).

| Coverage profile | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| broad | 86.58% | 80.31% | 91.16% | 90.24% |
| critical | 81.62% | 76.14% | 87.65% | 85.78% |
| workers | 84.31% | 80.83% | 92.77% | 88.98% |
| tooling | 78.27% | 73.87% | 87.09% | 80.14% |

## 최초 실패·검사 준비 보정

- 계정 UI 프로브 첫 모듈 로딩 오류는 변환된 import.meta URL을 파일 URL로 가정한 검사 준비 오류였다.
  실행 가능한 최초 실패와 정상 대조를 별도로 보존했다.
- 관리자 신규 검사에는 Announcements 탭 열기·revision·service-status 응답이 빠져 있었다.
  원본 실패를 남기고 정상 UI 흐름으로 보정했다. 저장 중 만료 피드백 보존 검사도 추가했다.
- 첫 UI 후검증의 reduced-motion 입력 포커스 실패는 실제 추가 수정으로 해결했다. 하위 요소의
  상속된 visibility transition까지 제거한 뒤 영향 검사 4개가 통과했다.
- 보조 media-picker 역방향 Tab 대조는 수정 전 1회 실패하고 해당 기능 수정 없이 후검증에서
  통과했다. 원인은 확정하지 않았으며 새 제품 결함으로 세지 않는다.
- 새 키 검사 적용 뒤 소유권 이전 유지 검사는 예전 키에 요청 epoch만 바꾸고 있었다.
  새 소유자 epoch의 정상 발급 키를 제공하도록 fixture를 고쳤다. 기존 키 거부 기준을 완화하지 않았다.
- 통합 typecheck 첫 시도에서 새 TypeScript leaf의 명시적 project 등록 누락을 찾아 보완했다.
- 첫 전체 unit은 10,874 pass / 7 fail / 1 skip이었다. 새 Worker leaf의 배포 호환성 목록 등록
  누락 1건과 HTML bootstrap query의 이전 cache 번호 1건을 보완했다. jq 경로 미설정으로
  건너뛴 Windows 배포 도구 검사도 최종 실행에는 저장소의 기존 jq를 명시했다.
- 나머지 5건은 대용량 전송 결과의 Uint8Array 재귀 비교가 23.559초를 소모해 15초 제한을
  초과했다. 모든 바이트·길이를 비교하는 Buffer.equals로 검사만 바꿨고, 같은 제한·coverage에서
  해당 10개가 통과했다. 제품 로직·검사 범위·timeout을 완화하지 않았으며 원본 실패를 보존했다.
- 첫 Worker bundle 검사는 E2E 빌드가 dist를 재생성하는 동안 실행돼 디렉터리를 찾지 못했다.
  최종 production 빌드 완료 후 6종 dry-run이 통과했다. 이 최초 실패를 Worker 코드 실패로 분류하지 않는다.
- 첫 production candidate는 16 pass / 1 fail이었다. 기존 캐시 복구 helper가 첫 ready를
  최종 관측으로 간주해 비동기 Worker 출처 응답보다 먼저 실패할 수 있었다. 관측을 추가한
  1회 통과만으로 최초 실패를 해소 처리하지 않았다. 관측 진단에서는 DOMContentLoaded 66.3ms에
  ready, Worker 응답 83.6ms, degraded/CachedNavigation 84.1ms의 정상 비동기 순서를 기록했다.
  별도 native helper 경계 검사에서 이 순서의 실패 1건·거부 대조 3건을 확인한 뒤, fallback
  전용 helper만 degraded 또는 aborted를 기다리도록 고쳤다. 원래 15초 한도와 정확한
  53 steps / 0 failures / 1 CachedNavigation 판정은 유지했다. 이후 경계 4건·정식 candidate
  17건·WebKit SW 1건 통과. 최초 실패의 모든 메시지 순서는 캡처되지 않았으며, 확인한
  helper 경합과 새 진단의 정상 수렴을 근거로 검사만 수정했다. 과거 legacy reload 이슈와는 별개다.
- helper 후속 lint 최초 명령은 App ESLint 설정을 선택해 E2E project를 찾지 못했다.
  저장소의 정규 tooling 설정으로 검사해 통과했다. lint 규칙이나 프로젝트 범위를 완화하지 않았다.

공통 원본은 [실행 기록 디렉터리](../../scratch/qa2-repair-2026-10-09/common/)에 보존했다.
`candidate.json`과 `helper-before.json`은 최초 실패, `candidate-observe.json`은 추가 관측,
`candidate-final.json`과 `webkit-candidate.json`은 최종 산출물 검증이다.
`source-helper-delta.json`은 제품 커밋 이후 변경이 위 QA 2파일뿐임을 기록하고,
`source-final-check.json`은 그 최종 소스의 재검증 중 변경 0을 확인한다.

## 배포·회복

현재 변경은 임시 브랜치의 로컬 커밋이며 PR/main 병합·원격 CI·프로덕션 배포는 수행하지 않았다.
App/public docs·admin runtime·Developer API·facade·PRO가 변경 대상이다. App `8.7.5`/`v636`으로
준비했고 의존성 버전은 유지했다. 운영 반영 때에는 변경 Worker만 포함하는 저장소 release scope,
성공한 **정확한 main SHA** CI candidate 및 기존 릴리스 절차를 적용해야 한다.
기존 Developer API D1 baseline 적용은 필요하지 않다. 본 로컬 검증을 release candidate로 대체하지 않는다.

실물 오디오·모바일 소프트 키보드·물리 다중 기기·운영 서비스 실패는 검증하지 않았다.
과거 legacy PWA 승인 뒤 reload 미관측과 운영 R2 지연 미확정 기록은 이번 15건과 별도로 유지한다.
이번 변경이 그 원인을 해결했다고 주장하지 않는다.

## Daybreak 보안 심화 재시도 — 2026-10-09

사용자가 배포 전 건너뛴 보안 검증의 재시도를 요청했다. 대상 소스는
`8ff6fd1251390a23b37686929a59d174ae0db467`이며 제품 입력은 위 `8c14f0d6`과 같다.
결과는 **계정 보안 등록 조건으로 실행 미완료**다. 신규 보안 검사 실행은 0건이며,
새 결함을 확인하지 못했다는 사실을 보안 통과로 해석하지 않는다.

첫 서브에이전트 요청은 `access_programs.cyber=daybreak_blue` 누락으로 400을 반환했다.
설치된 Codex CLI의 정식 `--cyber-access-program daybreak_blue` 옵션을 사용한 임시 세션에서는
Daybreak 모델 접속 자체가 성공했다. 이후 `--approve-for-me`와 기존 승인 검토를 적용한
보안 심화 세션에서 서비스가 실제로 다시 차단했다. 응답은 Daybreak Blue 승인과 별개로
**Advanced Account Security 등록 및 호환 FIDO2 하드웨어 보안 키**가 필요하고,
소프트웨어·동기화 패스키는 해당 하드웨어 요건을 충족하지 않는다고 명시했다.
이는 저장소 테스트의 assertion 실패나 결함 재현 결과가 아니다.

| 범위 | 이번 재시도 결과 |
| --- | --- |
| R17-C01 / QA073·075 API 키 수명 | 현재 코드·fixture 검토까지만 수행. 공유 계정 gate 재확인 후 프로브 실행 전에 중단 |
| QA094 공개 요청 경계 | 초기 Windows 실행 환경 설정 오류 뒤 정상 검토 경로의 읽기는 성공. 신규 보안 실행 전 중단 |
| QA109 번역 권한 | 신규 보안 실행 전 중단. 이전 정상 기능 99 pass를 새 보안 근거로 세지 않음 |
| QA086 관리자 인증 | 신규 보안 실행 전 중단 |
| QA032 비정상 전송 프레임 | 구체적 로컬 실험의 승인 사전 확인 뒤 Daybreak 서비스가 차단. 테스트 파일이 없는 사전 확인만 실행됐으며 비정상 프레임 실험은 작성·실행하지 않음 |

원본 응답과 명령 기록은 [재시도 결과 JSON](../../scratch/qa2-security-retry-2026-10-09/result.json),
[모델 접근 확인](../../scratch/qa2-security-retry-2026-10-09/access-check.json), 각 하위 폴더의
`events.jsonl`에 보존했다. 초기 웹 세션의 Windows `setup refresh had errors`와
최종 Daybreak 계정 등록 거절을 구분한다. 실행 중이던 다른 심화 세션도 정상 중단했고,
비Markdown 1,819파일 hash 변경 0을 확인했다. 제품·검사 코드·계정 보안 설정·main·배포 변경은 없다.

다음 진행 조건은 서비스가 안내한 [보안 등록 페이지](https://chatgpt.com/cyber)의
Your eligibility에서 계정 등록을 완료한 뒤 같은 정상 검토 경로로 다시 확인하는 것이다.
모델 선택이나 요청 옵션만으로 접근 권한이 부여되지는 않는다.
([공식 Daybreak 요청·접근 설명](https://developers.openai.com/api/docs/guides/daybreak))
이번 로컬 회귀 통과와 별도로 이 심화 검증은 배포 전 미완료 항목으로 유지한다.
