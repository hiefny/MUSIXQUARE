# App 8.7.2 전체 검증 및 운영 검사 관측기 보완 — 2026-10-07

| 항목 | 상태 |
| --- | --- |
| 현재 판정 | 최초 전체 검증의 최종 실행은 통과. 이후 운영 R2 재검사에서 다운로드 본문 미완료가 다시 관측돼 현재 전체 올그린으로 확대 해석하지 않음. 아래 후속 진단·한계를 함께 확인 |
| 기준 검사 SHA | `61cedbc6dd40ae801233036d9ae5f9a26361fbdf` |
| 첫 검사 보완 SHA | `59eae678e6f1f1e50a62a77ea5460c2ac0e235d4` — 테스트 관련 3파일만 변경 |
| 최종 검사 보완 SHA | `716c37af6f57ae46112e1e6295562e50fdc03ff0` — native getter 예외에서도 SCTP/DTLS/ICE 객체 식별을 유지하는 최소 수정 |
| 배포된 App | `8.7.2` / `v633`, 제품 SHA `94fa5b03695122d1cf6b39d9e7a5374ec6e11e09` |
| 관련 기록 | [배포 준비 기록](../beta-release-readiness.md), [8.7.0 승격 기록](release-8.7.0-2026-10-07.md) |

최종 `716c37af`의 로컬 전체 unit 10,781개와 PR CI가 통과했다. 기준 제품 입력의 로컬·원격 전체 Chromium은 각각 581개 통과했고, 최종 보완 커밋의 원격 Chromium 재실행도 581개 모두 통과했다. 운영 R2 최초 실행의 `8/9` 실패는 원인 미확정으로 보존한다. 별도로 재현한 관측기 결함은 **테스트만 수정**했으며, 이후 실제 9게스트 R2 검사는 로컬·원격 모두 통과했다.

## 코드와 환경

- 기준 `61cedbc6`는 배포된 제품 `94fa5b03`와 `docs/beta-release-readiness.md`만 다르며 제품 입력은 같다.
- 보완 `59eae678`은 `e2e/helpers/production-ice-observation.ts`, `e2e/production-live/large-room-r2.test.ts`, `src/core/__tests__/production-ice-observation.test.ts`만 바꾼다. 제품 코드·의존성·서버 계약·DB·secret·binding·버전·캐시·빌드 설정 변경은 없다. 이 검증 작업에서 제품을 다시 배포하지 않았다.
- `716c37af`는 같은 helper의 예외 경로에서 transport 객체 식별을 보존하고 회귀 3개를 추가한다. 기준과의 최종 코드 diff도 위 테스트 관련 3파일뿐이며, 9게스트·30초·R2 assertion은 그대로다. 이 보고서와 준비 기록은 별도 문서 변경이다.
- Windows, Node 24.20.0/npm 12.0.2, Vitest 5, Playwright 1.63, jq 1.8.2. 원격은 GitHub Actions Ubuntu다. 기존 timeout·네트워크 격리·coverage 하한·브라우저 자동 retry 0을 유지했다.
- 기준 테스트 파일 604개는 unit 517개, E2E 86개, 의도적 dead-export fixture 1개로 모두 분류됐다. 전체 Chromium은 E2E 83파일이며, 제외된 3파일은 WebKit·production candidate·production-live 프로필이 각각 검사한다. 보완은 unit 1파일을 추가한다. 프로필 간 중복을 고유 검사 수에 더하지 않는다.

## 로컬 검사 결과와 SHA 구분

| 검사 | 실제 검사 기준 | 결과 |
| --- | --- | --- |
| 기준 전체 unit + broad coverage | `61cedbc6` | 517파일·10,730 pass, fail/skip/todo 0 |
| 최종 전체 unit + broad coverage | `716c37af` | 518파일·10,781 pass, fail/skip/todo 0, exit 0. 528.95초. 실행 전후 SHA와 변경된 3파일 SHA-256 일치 |
| Critical runtime coverage | `61cedbc6`; 이후 이 프로필의 입력 변경 없음 | 55파일·1,869 pass, 원래 하한 통과 |
| Worker runtime coverage | 같은 기준 | 26파일·1,728 pass, 원래 하한 통과 |
| Release tooling coverage | 같은 기준 | 13파일·342 pass, 원래 하한 통과 |
| 전체 Chromium | `61cedbc6`; 이후 해당 83파일·제품·빌드 입력 변경 없음 | 83파일·고유 581 pass; 두 격리 shard 298+283, fail/skip/retry/flaky/runner error 0 |
| 공식 iPhone WebKit | `61cedbc6`; 이후 해당 입력 변경 없음 | 12파일·66 pass/기존 3 skip, fail/retry/flaky 0 |
| Production candidate | 기준 production 산출물 | 17 pass, fail/skip/retry/flaky 0 |
| Production WebKit Service Worker | 같은 기준 production 산출물 | 1 pass, fail/skip/retry/flaky 0 |
| `build:checked` 및 산출물 guard | 기준 및 첫 보완 `59eae678` 후 각각; 최종 제품·빌드 입력 같음 | 통과. 기록 `build/production-build-final.log` |
| 6개 production Worker dry-run | 기준 SHA; 이후 Worker·의존성 입력 변경 없음 | 6개 모두 통과, 배포하지 않음 |
| 전체 정적·보안 검사 | `59eae678` | 18/18명령 exit 0. 전체 타입·lint·서식·독립 source guard·Worker syntax·dependency tree 통과 |
| 의존성 감사·서명 | `59eae678`, 09:30 UTC | 전체/prod-only 취약점 각각 0. registry 서명 486개·attestation 103개 검증 |
| 신규 ICE observer 회귀, 첫 보완 | 보완 작업 트리 → `59eae678` | 48/48 pass, fail/skip 0; test TypeScript 검사 통과 |
| 예외 경로 추가 회귀, 최종 보완 | 최종 작업 트리 → `716c37af` | 51/51 pass, fail/skip 0. E2E 타입·helper lint·서식 검사 exit 0; 최종 broad에서도 모두 통과 |
| 최종 실제 9게스트 R2 | `716c37af` 검사 도구 → 운영 App `94fa5b03` | 1 pass, 130.95초, fail/skip/retry/flaky 0. native host/host 9개, PUT 2개·완료 GET 18개·전환 후 추가 GET 없음 |

Chromium·WebKit·candidate의 기준 실행을 최종 커밋에서 모두 다시 실행했다고 표현하지 않는다. 각 SHA에서 다시 검사한 항목과, 변경되지 않은 입력에 대한 기준 증거를 위 표처럼 분리한다. 정적 18명령은 `59eae678` 증거이며 `716c37af`의 변경은 위 focused/type/lint/format으로 추가 검사했다. WebKit의 3개 skip은 데스크톱 진입 애니메이션, 모바일에서 숨겨진 캐러셀 화살표, hover 동작이며 Chromium이 해당 데스크톱 경로를 검사한다.

| Coverage 프로필 | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Broad, `61cedbc6` | 86.54% | 80.28% | 91.08% | 90.20% |
| Broad, `716c37af` | 86.54% | 80.28% | 91.08% | 90.20% |
| Critical runtime | 81.61% | 76.13% | 87.64% | 85.77% |
| Worker runtime | 84.26% | 80.79% | 92.63% | 88.93% |
| Release tooling | 78.27% | 73.87% | 87.09% | 80.14% |

네 기준 프로필과 최종 broad의 원래 전체·파일별 하한이 통과했다. focused 세 프로필은 입력이 바뀌지 않았고 원격 최종 PR CI에서도 다시 통과했다. `59eae678`의 로컬 broad 재실행은 후속 회귀 발견으로 중단했으며 완료 결과로 합산하지 않는다.

## 운영 R2 최초 실패와 검사 보완

최초 실행은 9명이 입장한 뒤 `host/host`로 관측된 연결 수가 30초 안에 9가 되지 않아 `Expected 9 / Received 8`로 종료됐다. 파일 업로드·R2 전송 검사에 도달하지 않았다. 당시 연결별 후보 자료가 없어 제품·환경·관측기 중 원인을 특정할 수 없다. 실패 시 topology 첨부만 추가한 재실행은 기존 알고리즘과 모든 assertion을 유지한 채 native `host/host` 9개·PUT 2개·현재 곡/프리로드 GET 18개·다음 곡에서 추가 GET 없음 조건을 통과했다.

이 발생과 별도로 아래 관측기 계약 오류를 대조 검사로 확인했다. 이전 callback은 `61cedbc6`에서 AST 그대로 추출해 export/type wrapper만 추가했다.

| 대조 | 수정 전 결과 | 의미 |
| --- | --- | --- |
| 기존 native `host/host` 정상 경로 | 1 pass | 정상 경로를 유지하는 대조 |
| native `host/prflx`가 canonical `host/host` stats를 가림 / native 없는 fallback이 `selectedCandidatePairId`를 무시 | 2 fail | 기존 observer의 false negative |
| canonical transport 선택 없이 임의 selected 또는 nominated pair를 채택 | 2 fail | 기존 observer의 false positive |
| 첫 helper에서 native getter가 예외를 던지는 동안 SCTP·DTLS·ICE 객체 각각 교체 | 3 fail, 객체 유지 대조 1 pass | catch가 식별 객체를 버려 stale stats를 받아들이던 결함 |

helper는 유일한 transport가 명시적으로 선택한 succeeded graph와 역할·backlink를 요구한다. native `host/prflx`를 보완할 때 유효 port/protocol이 같고, 양쪽에서 확인 가능한 address·local foundation·ICE generation도 일치해야 한다. stats를 기다리는 동안 registry·연결·SCTP/DTLS/ICE·후보 정보가 바뀌면 거부한다. native getter 예외에서도 읽은 객체를 보존하며, 진단에는 IP·SDP·토큰·ICE 자격 정보를 넣지 않는다.

첫 보완 `59eae678`에서 회귀 48개, 최종 `716c37af`에서 추가 예외 경로를 포함한 51개가 모두 통과했다. 최종 로컬 broad도 51개를 포함한다. 최종 운영 R2는 로컬·원격 각각 1 pass였고 두 실행 모두 native `host/host` 9개/refined 0이었다. 실제 운영에서 refined 경로를 발생시켰다고 해석하지 않는다.

초기 41 pass/1 fail, 이전 callback 대조의 include 설정 오류로 중단한 scratch 실행, 중단한 `59eae678` broad 원본도 보존한다. 정확한 이전 callback 비교의 43개 이름 필터 제외는 당시 5개 대조에만 적용됐고, 이후 유지 회귀 전체에서는 제외하지 않았다.

**확정한 것은 관측기 계약 불일치의 수정이다. 최초 운영 `8/9` 발생의 원인을 이 수정으로 확정하지 않는다.**

## 추가 live 검사

| 대상 | 결과와 범위 |
| --- | --- |
| App generation | 최신 공개 entry/초기 자산 graph 25개와 연속 3회 generation 일치 확인 |
| 실제 App host/guest session | 운영 Cloudflare transport로 입장, ordered bootstrap, 양방향 첫 채팅 통과 |
| 추가 6개 live 명령 | signaling, PRO room, PRO media CORS, remote share, Standard HTTPS signaling, App public boundary 모두 exit 0 |
| 첫 보완 9게스트 R2 | `59eae678`에서 1 pass. 최초 실패·진단 pass와 중복 합산하지 않음 |
| 최종 9게스트 R2 | `716c37af` 로컬 1 pass, 원격 1 pass; 모두 native host/host 9개, 원래 R2 전송·프리로드·전환 조건 통과 |

live 검사는 배포된 App/Worker에 대한 해당 시점의 결과다. 테스트 커밋 `59eae678`·`716c37af`가 운영에 배포되었다는 뜻은 아니다. 각 smoke가 관측하지 않은 실제 계정·모든 API·기기 경로로 결과를 확대하지 않는다.

## 원격 검사 결과

| 실행 | 검사 SHA / 확인 결과 | 상태 |
| --- | --- | --- |
| [main CI 37594837712](https://github.com/hiefny/MUSIXQUARE/actions/runs/37594837712) | `61cedbc6`; unit 10,729 pass/Windows 전용 1 skip, 4종 coverage gate, candidate 17·critical browser 22 pass | 성공 |
| [Operations Drift Audit 37595270795](https://github.com/hiefny/MUSIXQUARE/actions/runs/37595270795) | 기준 계약과 운영 비교, 자동 31 pass/0 fail, 수동 전용 5항목 | 자동 감사 성공 |
| [기준 Full E2E 37595231001](https://github.com/hiefny/MUSIXQUARE/actions/runs/37595231001) | `61cedbc6`; Chromium 581 pass/0 fail·skip·retry, WebKit 66 pass/3 skip, WebKit SW 1 pass, 실제 9게스트 R2 1 pass | 성공 |
| [첫 보완 Full E2E 37600603336](https://github.com/hiefny/MUSIXQUARE/actions/runs/37600603336) | `59eae678`; WebKit/SW 성공, 실제 9게스트 R2 1 pass, native 9/refined 0, retry 0 | 후속 helper 수정 검증으로 대체해 취소. 완료한 세부 결과는 보존하며 중단된 Chromium을 완료 증거로 사용하지 않음 |
| [첫 보완 PR #251 CI 37600971871](https://github.com/hiefny/MUSIXQUARE/actions/runs/37600971871) | 보완 커밋 `59eae678` | 성공. 최종 `716c37af` 또는 main push CI 성공으로 바꿔 기록하지 않음 |
| [최종 Full E2E 37602041553](https://github.com/hiefny/MUSIXQUARE/actions/runs/37602041553) | `716c37af`; Chromium 581 pass/0 fail·skip·retry, WebKit 66 pass/기존 3 skip, WebKit SW 1 pass, 실제 9게스트 R2 1 pass(native 9/refined 0), retry 0 | 모든 job 실제 성공. Chromium 52.5분, 완료 2026-10-07 10:32:13 UTC |
| [최종 PR #251 CI 37601999398](https://github.com/hiefny/MUSIXQUARE/actions/runs/37601999398) | `716c37af`; unit 518파일·10,780 pass/Windows 전용 1 skip, 4종 coverage gate, candidate 17·critical browser 22 pass | 성공. main push CI 증거와 구분 |

R2 job에는 `continue-on-error`가 있으므로 workflow의 종합 색상 대신 해당 job의 실제 성공을 확인했다. Linux에서 건너뛴 Windows 전용 unit는 최종 로컬 전체 검사에서 통과했다. 최종 원격 전체 Chromium의 종료 상태와 원본 로그에서 581개 통과를 확인했다.

## 실행 한계와 남은 확인

- 인증된 Developer API canary는 필요한 키가 GitHub production environment secret에만 있어 이번 독립 검사에서 실행하지 못했다. 다른 API smoke나 unit로 인증된 canary 성공을 대신하지 않으며, 검사를 위해 제품을 다시 배포하지 않았다.
- Operations Drift Audit의 수동 전용 5항목은 자동 31개 통과와 별도다.
- 로컬 Windows Playwright WebKit의 Web Audio/WebRTC 제약 때문에 위 결과를 실제 iPhone Safari/PWA 미디어·다기기 음향 동기화 증거로 해석하지 않는다. Bluetooth, 혼합 물리 기기, 모바일 네트워크 변경, 기존 설치 PWA·장기 운영 탭은 실기 확인 영역이다.
- 이전 R26의 legacy Refresh 승인 후 갱신 정지 1회는 원인 미확정 상태를 유지한다. 후속 진단 10회나 이번 SW 검사의 성공으로 해결된 것으로 처리하지 않는다.
- 이번 최초 `8/9` 운영 관찰도 원인 미확정으로 보존한다. 최종 테스트 보완의 효과는 독립 반례와 유지 회귀로 설명한다.
- 게시 경로는 [PR #251](https://github.com/hiefny/MUSIXQUARE/pull/251)이다. 이 기록은 최종 검사 코드 `716c37af`의 증거이며, 후속 문서 커밋과 main 병합 SHA는 별개다. 해당 PR의 최종 검사·병합 기록 및 [main CI](https://github.com/hiefny/MUSIXQUARE/actions/workflows/ci.yml?query=branch%3Amain)에서 후속 실행을 확인한다. 테스트·문서만 게시하며 Production Release는 실행하지 않는다.

## 운영 R2 후속 재검사 — 2026-10-07 저녁

사용자의 최초 미확정 관찰 재검사 요청에 따라 main `a1543f8baf40cea057fe817d18a064fbec7710da`의
검사로 같은 운영 App `94fa5b03`을 확인했다. Windows·Node 24.20.0·Playwright 1.63,
호스트 1개와 분리된 게스트 context 9개, 자동 retry 0이다. 유지 테스트의 인원·30초
ICE 조건·120초 다운로드 조건을 완화하지 않았다. 제품 및 유지 테스트 코드는 변경하지 않았다.

- **유지 테스트의 새 방 3회:** 2 pass / 1 fail. 첫 방에서는 연결 9개와 PUT 2개를
  확인했지만 게스트 4·7·8의 완료 GET가 0개였다. 다른 6개는 각각 현재 곡과
  프리로드 GET 2개가 완료됐다. 실패는 게스트 4의 다운로드 조건에서 보고됐다.
  나머지 두 방은 GET 18개·다음 곡 재생 진행·추가 GET 없음까지 통과했다.
- 첫 방의 연결 하나에서 native `host/prflx`와 안정적인 canonical `host/host`
  stats가 실제로 함께 관측됐다. 그 native snapshot에 기존 판정 규칙을 적용하면
  8개가 되며, 보완 observer의 실제 관측은 endpoint 일치 근거로 9개였다. 이로써 실제 브라우저에서
  보완 경로가 필요한 상황은 확인했지만, **과거 최초 8/9 실패가 같은 이유로
  30초 지속됐다는 증거는 아니다.**
- **별도 새 방 1회, 수동 관찰 추가:** 원래 입장·업로드 순서와 assertion을
  유지하며 기존 observer → 보완 observer → 기존 observer를 35초 동안 35회
  비교했다. 모두 9/9/9였다. 그러나 게스트 1의 다운로드 조건은 실패했다.
  해당 기기는 GET 1개 시작·HTTP 200 응답 후 본문 완료 0개, 로딩 중·미디어 길이 0이었다.
  다른 8개는 각각 GET 2개 완료·디코딩 준비 상태였다. 이 방은 다음 곡 검증에 도달하지 않았다.
- 이 진단 방은 9개의 R2 capability 모두가 최초 FILE_PREPARE 전에 도착했고,
  실제 FILE_PREPARE도 전부 `delivery:r2`였다. 직접 전송의 FILE_START/PRELOAD_START나
  bulk 바이트는 없었다. 따라서 **이 방의 실패는 정상 P2P 전송을 검사에서 빠뜨린
  경우가 아니다.** 앞선 첫 방은 같은 상세 자료가 없으므로 원인을 소급 확정하지 않는다.
- 코드의 정상 혼합 P2P/R2 정책은 기존 14개 테스트로 재확인했다. 하지만 그 정책이
  이번 진단 방의 실패 원인이라는 가설은 위 운영 증거로 제외했다.
- 다운로드 보호 처리는 이미 존재한다. 새 바이트가 90초 동안 없을 때 중단하고,
  transient 실패는 한 번 재시도한다. 계속 진행하는 느린 전송에는 전체 시간 제한을
  적용하지 않는다. 관련 기존 4파일·120개 검사가 모두 통과했다. 테스트의 120초
  절대 제한은 이 90초 비활동 조건과 다르므로, HTTP 200과 본문 미완료만으로
  무한 대기나 재시도 누락을 확정하지 않는다.
- **XHR 바이트 관찰을 추가한 마지막 새 방 1회:** 1 pass, 약 140초. 원래 assertion과
  timeout을 유지했고 GET 18개가 각각 2,153,280바이트 전체를 수신했다. 현재 곡의
  XHR은 기기별 약 2.1–69.6초, 뒤따른 프리로드는 약 1.2–4.6초 걸렸다.
  느린 요청도 실제 바이트 증가 이벤트를 반복해서 내며 완료했고, 다음 곡 재생 진행과
  추가 GET 없음까지 통과했다. 이 성공한 방의 진행 자료로 이전 실패한 방의 바이트
  진행 여부를 소급 증명할 수는 없다.

합계는 **서로 다른 새 방 5회 중 3 pass / 2 fail**이다. 유지 검사 3회와 scratch
관찰 진단 2회를 구분하며, 재시도 성공으로 이전 실패를 지우지 않는다. 최초 8/9
연결 관찰의 원인은 여전히 소급 확정 불가다. 이번에는 별도로 운영 HTTP 본문 수신의
기기별 큰 지연과 120초 미완료를 관측했지만, 서비스·네트워크·단일 PC의 여러 browser
context 부하 중 원인이나 앱 복구 결함을 특정하지 못했다. 새 확정 제품 코드 결함은
없으며 증거 없이 복구 정책·테스트 제한 시간을 바꾸지 않았다. 이 후속 결과를
포함한 운영 반복 검증은 올그린이 아니다. 전체 로컬·원격 스위트를 다시 실행한 것도 아니다.

현재 원본은 `scratch/r2-followup-2026-10-07/{baseline,report,summary}.json`,
`scratch/r2-paired-comparison-2026-10-07/{result,evidence,provenance}.json`,
각 폴더의 `run.log`, `policy-check/` 및 `watchdog-tests/`에 보존했다.
마지막 바이트 진단은 `scratch/r2-progress-diagnostic-2026-10-07/`의
`result.json`, `xhr-evidence.json`, `evidence.json`, `provenance.json`에 보존했다.
진단은 토큰·주소·원본 메시지 본문을 보관하지 않고 경로 종류·상태·바이트·시각만 남긴다.

## 운영 R2 원인 추적 — 2026-10-07

기준 검사 SHA는 `aba657eda95dc4e572b7c9094074fc787b26edd5`, 환경은 Windows·Node
24.20.0·Playwright 1.63이다. 운영 App `94fa5b03` / 8.7.2 / v633과 share Worker
`e8001e93`을 관찰했다. 아래 scratch 진단은 기존 실패 뒤 관찰 시간을 추가했으며,
원래 단계별 assertion·timeout·실패 판정은 유지했다. 20기기 진단만 추가 입장에 필요한
전체 test body 한도를 300초에서 600초로 늘렸고, ICE 30초·다운로드 120초·곡 제목
90초·다음 곡 재생 진행 60초는 그대로다. 자동 retry는 0이다. 모두 한 Windows PC의 브라우저 세션이며 물리 기기
20대·서로 다른 네트워크의 검증은 아니다.

| 범위 | 결과와 확인 가능한 결론 |
| --- | --- |
| 과거 유지 R2 job 12개 | 10 success / 2 failure. 성공은 모두 PUT 2개·완료 GET 18개. 두 실패는 업로드 전 ICE 8/9 판정이며 HTTP 본문 실패가 아님 |
| shared Chromium, 호스트 1·게스트 context 9 | 원래 검사는 fail. 게스트 8의 두 GET가 합계 126.590초 걸려 120초 조건을 넘었지만, 실패 뒤 같은 요청으로 모두 완료 |
| 기기별 독립 Chromium 진단 | 입장 완료를 기다리는 20초 조건에서 fail. 해당 입장은 약 8초 뒤 완료됐으나 업로드에 도달하지 않아 R2 처리량 비교 결과가 아님 |
| 호스트 1·게스트 context 19 확장 진단 | fail. 19명 입장·토폴로지·PUT 2개는 통과. 게스트 2·9의 수신이 120초를 넘겼으나 실패 후 각각 약 8.1·27.8초에 프리로드까지 완료. 최종 GET 38개 전체 수신 |
| R2를 거치지 않는 정적 파일 대조 | 2,057,688바이트 파일을 HTTP/2 3회·HTTP/3 1회 모두 약 0.78–1.04초에 수신. R2 동시 전송과 동일한 실험 조건은 아님 |

**이번 shared 진단의 직접적인 실패 원인은 진행 중인 전송이 검사 시간 한도를 넘은 것이다.**
게스트 8은 현재 곡을 52.551초에 받고, 6ms 뒤 시작한 프리로드를 74.033초에 받았다.
첫 요청부터 두 번째 완료까지 126.590초였다. 실패 snapshot에서도 프리로드는
1,957,076 / 2,153,280바이트를 받았고, 약 102ms 전까지 바이트가 증가했다.
이후 약 6.8초 만에 같은 요청이 끝났다. 중단·재시도 없이 GET 18개 모두 전체 본문을
수신했으므로 이 실행에서 무한 대기나 복구 누락은 관측되지 않았다.

실패 판정을 pass로 바꾸지는 않는다. 실패 뒤에는 다음 곡 assertion을 실행하지 않았으므로
이 진단을 곡 전환 통과로도 합산하지 않는다. **앞 절의 두 HTTP 본문 미완료 실패에는
동일한 진행 자료가 없으므로, 이번 원인을 소급 적용할 수 없다.** 독립 프로세스 진단의
입장 지연도 전송 실패와 별개이며, 모든 기기의 독립 프로세스 전송 비교는 미완료다.

20기기 진단의 실패 순간 게스트 2는 현재 곡 2,104,534 / 2,153,280바이트,
게스트 9는 1,884,106 / 2,153,280바이트를 받았다. 각각 약 911ms·200ms 전까지
XHR 바이트가 증가했다. 같은 현재 곡 요청은 실패 후 4.040초·25.734초에 끝났고,
프리로드까지는 8.118초·27.755초였다. 19명 모두 정확히 2개씩 재시도 없이 완료했다.
두 페이지의 heartbeat 최대 지연은 14ms·16ms였다. 다음 곡 전환 assertion은 실패로
실행되지 않았으므로, 최종 준비 완료를 전환 성공으로 바꾸어 기록하지 않는다.
이 실행의 tail은 GET 3개만 수집했고 느린 현재 곡 HTTP/2 요청은 포함하지 못했다.
따라서 아래 9게스트 실행의 전체 tail 근거를 20기기 실행으로 확대하지 않는다.

XHR와 CDP의 수신 바이트는 일치했고, 페이지별 이벤트 루프 지연의 관측 최댓값은
16ms 이하였다. 현재 곡 GET 9개는 모두 HTTP/2로 약 1.9–62.4초 걸렸다. 대부분의
프리로드는 HTTP/3로 약 1.2–3.3초였으나, HTTP/2 프리로드에도 1.1초 완료와 74.0초
완료가 모두 있었다. 프로토콜뿐 아니라 요청 순서·대상 객체·동시 전송량·연결 재사용이
함께 달라졌으므로 **HTTP/2가 지연의 원인이라는 인과관계는 입증하지 못했다.**

추가 정적 대조는 앱을 실행하지 않은 fresh context에서 같은 공개 폰트 파일을
각각 두 번씩 받아 전체 본문을 확인했다. QUIC를 끈 세션의 HTTP/2는 0.918·0.783초,
기본 세션의 HTTP/2·HTTP/3는 1.043·0.923초였다. 모두 200이며 브라우저 disk cache·
Service Worker 응답은 아니었다. 이는 HTTP/2 자체나 해당 PC의 모든 다운로드가
항상 느리다는 설명의 반례다. 그러나 정적 배포 자산과 인증된 R2 객체의 경로·edge
캐싱·동시성이 다르므로 R2 원인 확정/배제 근거로 쓰지 않는다. 최초 대조는 잘못 지정한
폰트 경로의 404·0바이트였으며 이를 처리량 측정에서 제외하고 원본을 보존했다.

9게스트 shared 진단의 Cloudflare tail GET 18개는 모두 HTTP 200·outcome `ok`, 예외 없음이었다.
Worker CPU는 1–10ms, wall time은 183–422ms였고 관측 edge는 LAX였다. 429나
CPU 제한 오류의 증거는 없다. 다만 이 wall time을 브라우저의 본문 수신 완료 시간으로
해석하지 않으며, 짧은 handler 시간만으로 R2·edge 이후의 전송 지연을 제외하지 않는다.

Cloudflare 공식 제한도 이번 현상과 구분했다. Worker의 동시 outgoing 연결 6개는
각 요청 실행의 제한이지 서비스 전체의 수신 사용자 6명 제한이 아니다. HTTP 요청에는
클라이언트가 연결된 동안 일률적인 실행 시간 제한이 없고, 네트워크 대기는 CPU 시간과
다르다. [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/).
R2의 `r2.dev` 가변 제한과 동일 객체 쓰기 1회/초 제한은 각각 공개 개발 endpoint와
쓰기에 관한 것이다. 이 서비스의 custom Worker·R2 binding GET에 그대로 적용되는
읽기 제한으로 설명할 수 없다. [R2 제한](https://developers.cloudflare.com/r2/platform/limits/).

과거 원격 실패는 [9월 17일 UTC job](https://github.com/hiefny/MUSIXQUARE/actions/runs/35276834150/job/105389384103)과
[9월 28일 UTC job](https://github.com/hiefny/MUSIXQUARE/actions/runs/36497282792/job/109179683667)이다
(한국 시간 9월 18일·29일). 모두 30초 ICE 사전 조건에서 8/9로 종료됐다. 원본에
실패 연결의 후보 자료가 없어 새 observer 반례를 과거 원인으로 확정하지 않는다.
R2 job은 처음부터 `continue-on-error`였으므로 전체 workflow의 초록불은 해당 job의
성공을 보장하지 않는다. 12개 중 성공한 10개는 개별 job과 완료 본문 로그로 확인했다.

9월 18일 배포 소스 `70edc9e9`와 현재 `e8001e93`을 비교하면 share Worker·두 import·
Wrangler 설정·R2 CORS/lifecycle, 브라우저 `r2-client.ts`·`remote-download.ts`는
바이트 단위로 동일하다. frozen main에서 현재 App까지 `remote-share.ts`의 관련
오케스트레이션 변경은 있으나 지연을 시작시킨 커밋이라는 증거는 없다. 소스 동일성을
배포 bundle·secret·외부 서비스·네트워크까지 동일하다는 의미로 확대하지 않는다.
Worker는 요청별 R2 body를 그대로 응답하고, 브라우저는 native XHR 본문을 다 받은 뒤
파일·디코딩 처리를 시작한다. 기존 90초 바이트 비활동 감지와 1회 재시도 관련
120개 검사는 앞 절의 통과 근거를 유지하며 이번 진단 때문에 재실행하지 않았다.

**새 확정 런타임 결함 0건; 느린 전송의 하위 원인은 미확정이다.** 제품의 timeout·
재시도·전송 정책이나 유지 테스트를 추측으로 바꾸지 않았다. 후속 인과 검증이 필요하면
동일한 불변 객체·동시성·연결 초기 조건을 맞춘 HTTP/2 대 HTTP/3 비교에서 헤더 도착,
본문 바이트 간격과 완료를 수집해야 한다. 그래야 클라이언트/TCP·QUIC 경로와
Worker/R2 경로를 더 좁힐 수 있다. 이번 기록은 그 통제 실험을 완료했다는 뜻이 아니다.

이번 9게스트·19게스트 전송 진단과 독립 프로세스 입장 진단은 각각 fail로 보존한다.
이 절은 앞선 5개 방의 3 pass / 2 fail을 덮어쓰거나 전체 로컬·원격 suite를 다시
통과했다고 선언하지 않는다. 제한된 표본으로 참가자 수에 따른 실패 확률을 계산하지 않는다.
지연 자체는 관측한 품질 문제이며, 코드 원인 미확정을 문제 없음으로 해석하지 않는다. 문서만 변경하며
새 App/Worker 릴리스·버전/cache·schema·secret/binding 변경은 없다.

원본은 `scratch/r2-root-cause-2026-10-07/`의 `history/findings.md`와 원격 job 로그,
`probe/{run.log,result.json,summary.jsonl}`, `probe-independent/`·`probe20/`의 같은 파일,
`tail-safe.jsonl`, `tail-share20.jsonl`, `static-control-results.json`,
`static-control-invalid-path-results.json`, `runtime/`의 소스 비교·진행 분석에 보존했다. 추적 문서에는
room ID·토큰·IP·원본 인증 URL을 넣지 않는다.

## 앱을 제외한 R2 전송 대조 — 2026-10-07

검사 준비 소스는 `233b478e8590f672aa38cd7986847ce3f291b99b`이며 Windows·Node
24.20.0·Playwright 1.63에서 실행했다. 운영 App `94fa5b03`과 share Worker
`e8001e93`은 그대로다. Node provisioning은 유지 중인 `live-remote-share-smoke.ts`의
선언·인증/업로드 helper를 수정 없이 가져와 정상 절차로 테스트 객체를 만들었다.
제품의 인증·권한·전송 정책을 바꾸거나 별도 공개 다운로드 경로를 만들지 않았다.

수신 페이지는 `musixquare.com`의 favicon 문서이고 Service Worker를 차단했다.
앱·미디어 재생·방 참여·동기화 코드는 실행하지 않는다. 같은 불변 객체 하나를 같은
Bearer 권한과 native XHR `arraybuffer`로 받았다. 예상 본문은 2,153,280바이트이며
응답 상태·전체 바이트·CDP 프로토콜/우선순위·진행 시각을 관찰했다.
각 요청의 **180초 제한은 이 측정만의 종료 한도**다. 운영의 90초 비활동 감지나
유지 R2 검사의 120초 조건은 변경하지 않았다.

| 전송 조건 | 전체 본문 완료 / 요청 | 완료한 요청의 시간 | 180초 측정 timeout |
| --- | --- | --- | --- |
| QUIC 비활성, 새 browser, 1 context | 1 / 1 | 1.968초 | 0 |
| QUIC 비활성, 새 browser, 동시 9 contexts | 8 / 9 | 2.386–33.402초 | 1 |
| 같은 9 contexts에서 재요청 | 8 / 9 | 1.474–72.531초 | 1 |
| 기본 browser 옵션, 새 browser, 동시 9 contexts | 9 / 9 | 2.602–92.751초 | 0 |
| 같은 기본 옵션의 9 contexts에서 재요청 | 8 / 9 | 1.705–23.089초 | 1 |

총 **37 GET 중 34개 전체 완료·3개 측정 timeout**이다. timeout 3개도 HTTP 200
헤더를 받은 뒤 각각 1,747,355·326,543·985,589바이트까지 진행했다. 마지막 바이트
증가는 종료 약 1.6·4.5·4.4초 전이었고 heartbeat 최대 지연은 각각 약 15·15·14ms였다.
180초가 되자 측정 XHR이 중단했고 CDP에는 `ERR_ABORTED`가 기록됐다. 이를 서버
거절이나 앱 watchdog의 작동으로 해석하지 않는다. 스크립트 exit 0은 측정·정리의
정상 종료이며 **37개 전송 올그린이라는 뜻이 아니다.** 생성 객체 정리는 성공했다.

**앱의 동기화·디코딩·프리로드·UI 처리는 이 느린 수신을 재현하는 데 필요하지 않았다.**
따라서 앱 상태 경합만으로 이번 지연을 설명할 수 없다. 그렇다고 이 대조가 이전
모든 실패의 원인을 확정하거나 Worker/R2·Cloudflare·인터넷 경로·브라우저 중 특정
구성요소를 원인으로 골라낸 것은 아니다. 해당 Windows 환경의 큰 편차는 남아 있다.

37개 모두 실제 관측 프로토콜은 HTTP/2, 초기 요청 우선순위는 `High`였다. 기본
옵션에서도 HTTP/3가 협상되지 않았으므로 이번 대조는 HTTP/2 대 HTTP/3 비교가 아니다.
`cold`는 새 browser/context라는 의미이며 R2 객체나 저장소가 cold라는 뜻은 아니다.
`warm`은 같은 contexts의 재요청이지 같은 TCP 연결을 보장하는 이름도 아니다.
실행 순서가 고정되어 있고 같은 PC·경로를 공유하므로 일반적인 6명 제한, HTTP/2 자체
결함, 참가자 수에 따른 실패 확률이나 급격한 위험 증가를 이 표본으로 단정하지 않는다.

원격에서는 기존 [운영 R2 job만 attempt 2로 재실행](https://github.com/hiefny/MUSIXQUARE/actions/runs/37602041553/job/112829138632)하여
1 pass·브라우저 retry 0, PUT 2개·완료 GET 18개·다음 곡 검사를 통과했다. 검사 코드는
기존 `716c37af`, 운영 App/Worker는 위와 동일하다. 첫 성공 PUT 응답부터 마지막 GET
본문 완료까지 3.006초였다. 이는 여러 요청을 포함한 로그 사건 간격이며 GET 각각의
소요 시간은 아니다. attempt 2의 다른 job 표시는 이전 결과가 이월된 것이므로 전체
스위트를 다시 실행했다고 기록하지 않는다. 이 성공으로 로컬 실패를 지우지 않는다.

별도 객체로 진행한 **독립 browser 대조도 지연을 재현했다.** 단일 context 기준은
1개 완료·131.188초였고, 각각 다른 browser 프로세스의 동시 9 GET는 모두 완료했지만
7개는 2.251–3.215초, 나머지 2개는 73.705·94.764초였다. 실제 프로토콜은 모두
HTTP/2였다. 단일 수신에서도 지연됐으므로 동시 참가자가 많아야 발생하는 현상은
아니며, 한 browser 프로세스의 여러 contexts 공유도 필수 조건이 아니다.
이 10개는 위 37개와 별도 실행이며 생성 객체 정리는 성공했다.

새 확정 제품 코드 결함과 App/Worker 배포는 없다. 전송 지연은 해결 완료가 아니며
정책·timeout을 추측으로 바꾸지 않는다. 이어서 아래와 같이 같은 PC에서 인터넷
경로를 바꿔 대조했다. 물리 다기기·혼합 네트워크 검증은 별개다.

원본은 `scratch/r2-root-cause-2026-10-07/transport-isolation.{mjs,jsonl,log}`와
`transport-isolation-exit.txt`, `provision-provenance.json`,
`remote-isolation-followup/summary.json`·원격 원본 로그에 보존했다. 완료한 별도
대조는 `transport-isolation-independent.{mjs,jsonl,log}`로 분리한다. 추적 문서에는
원본 인증 URL·토큰·room ID·IP를 기록하지 않는다.

### 같은 객체의 모바일 핫스팟 → 원래 Wi-Fi 대조

사용자가 이 PC를 모바일 데이터 핫스팟에 연결했다고 확인한 뒤 새 불변 객체 하나를
정상 인증·업로드 절차로 만들었다. 그 객체를 지우지 않은 채 사용자가 원래 Wi-Fi로
복귀했다고 확인한 뒤 다시 받았다. PC·Chromium·2,153,280바이트 객체·Bearer·native
XHR·동시 수신 수는 같고, 9개 수신기는 각각 새 독립 browser 프로세스다. 앱 코드는
실행하지 않았으며 양쪽 모두 실제 HTTP/2·초기 priority `High`였다. 따라서 이번
빠르기 차이를 HTTP/2와 HTTP/3의 차이로 설명할 수 없다.

| 사용자 확인 네트워크 | 조건 | 전체 완료 | 수신 시간 | 관측 Cloudflare 거점 |
| --- | --- | --- | --- | --- |
| 모바일 핫스팟 | 단일 수신 기준 | 1 / 1 | 2.318초 | HKG |
| 모바일 핫스팟 | 독립 browser 9개 동시 수신 | 9 / 9 | 1.609–3.436초 | HKG 8개·NRT 1개 |
| 원래 Wi-Fi 복귀 | 같은 객체, 독립 browser 9개 동시 수신 | 8 / 9 | 5개 2.093–2.351초, 3개 99.139·105.248·146.495초, 1개 180초 측정 timeout | 모두 LAX |

Wi-Fi의 미완료 요청도 HTTP 200 후 1,908,682 / 2,153,280바이트까지 진행했고,
마지막 바이트 증가는 측정 중단 약 31ms 전이었다. 180초에 측정 XHR이 중단했으므로
서버가 거절하거나 앱의 비활동 watchdog이 발동한 사례가 아니다. Wi-Fi의 헤더 도착은
약 0.9–3.6초, heartbeat 최대 지연은 15ms 이하였다. 큰 차이는 본문 수신 구간에서
관측했다. 측정·인증된 객체 정리는 정상 종료했지만 19 GET 전체 통과로 기록하지 않는다.

**현재 PC의 원래 인터넷 경로와 지연의 강한 연관성을 확인했다.** 앱·동기화·디코딩·
한 browser 프로세스의 부하는 이 지연의 필수 조건이 아니다. 같은 객체를 먼저 받은
핫스팟은 빨랐고 원래 Wi-Fi로 돌아오자 다시 느려졌지만, 이 한 차례의 교차 대조만으로
공유기·통신사·인터넷 라우팅·Cloudflare 거점/R2 구간 중 하나를 원인으로 확정할 수는
없다. IP·거점·실행 시각도 함께 달라졌고 물리 20기기의 동기화 검증은 아니다.

당장 앱의 전송·동기화 정책을 수정할 근거는 없으며 제품·배포는 유지한다. 같은
환경에서의 빠른 임시 경로는 이번에 확인한 모바일 핫스팟이지만, 모든 사용자나 장기
세션의 해결을 보장하지 않는다. 다음 원인 규명은 다른 기기의 원래 Wi-Fi 대조와
해당 전송 시각·CF-ray를 통한 네트워크/Cloudflare 측 조사다. 외부에 문의를 전송하거나
Cloudflare 설정을 변경하지 않았다. 기존 실패와 아직 확정하지 못한 원인은 유지한다.

원본: `scratch/r2-root-cause-2026-10-07/transport-network-crossover.{mjs,jsonl,log}`.
최초 10 GET는 사용자 확인 핫스팟, 뒤 9 GET는 사용자 확인 원래 Wi-Fi이며 같은
객체 식별 URL의 hash를 유지했다. 다운로드 권한은 메모리에만 보관했고 객체 정리는 성공했다.

## GitHub 원격 신규 방 3회 대조 — 2026-10-07

사용자 요청에 따라 집 PC의 인터넷 경로를 거치지 않는 GitHub-hosted Ubuntu
runner에서 기존 `Production large-room R2 smoke` job만 **미리 정한 3회** 실행했다.
각각 다른 새 방이며 성공할 때까지 반복하지 않았다. 기존 run `37602041553`의
attempt 3·4·5이고, 앞선 attempt 2 성공은 이번 3회에 합산하지 않는다.
job 실행 시각은 2026-10-07 23:42–23:48 KST다.

검사 소스는 `716c37af6f57ae46112e1e6295562e50fdc03ff0`이다. 조사 시작 main
`76e19a43`까지의 차이는 이 보고서와 배포 기록 2개뿐이므로 검사·workflow·제품
소스는 동일하다. 운영 App `94fa5b03` / share Worker `e8001e93`에 대해 검사했고
제품·정책·제한 시간·배포는 변경하지 않았다.

| 새 방 | attempt / R2 job | 실제 테스트 결과·시간 | PUT 200 / 전체 GET 200 | 첫 성공 PUT 응답 → 마지막 GET 본문 완료 |
| --- | --- | --- | --- | --- |
| 1 | [3 / 112852681033](https://github.com/hiefny/MUSIXQUARE/actions/runs/37602041553/job/112852681033) | pass · 31.7초 | 2 / 18 | 4.122초 |
| 2 | [4 / 112854040802](https://github.com/hiefny/MUSIXQUARE/actions/runs/37602041553/job/112854040802) | pass · 30.3초 | 2 / 18 | 3.062초 |
| 3 | [5 / 112855036964](https://github.com/hiefny/MUSIXQUARE/actions/runs/37602041553/job/112855036964) | pass · 28.2초 | 2 / 18 | 3.196초 |

각 방은 호스트 1·게스트 9이고, 선택된 ICE host/host 연결 9개와 대규모 방의 실제
R2 동의·전송 정책을 확인한다. 총 **3 pass / 0 fail, 자동 테스트 retry 0, PUT 6개·
전체 본문 GET 54개 완료**다. 세 방 모두 다음 곡의 준비 완료·재생 시간 진행과
프리로드 승격 뒤 추가 GET 없음까지 기존 assertion을 통과했다. 마지막 열은 여러
요청을 포함한 로그 사건 간격이며 개별 GET 시간이나 방 입장부터의 전체 시간은 아니다.

원격에서는 이번 집 Wi-Fi의 수십–수백 초 지연이 재현되지 않았다. 하지만 각 실행은
원격 runner 한 대의 Chromium browser contexts이므로 물리 기기 10대·여러 가정·
모바일 회선·iPhone 실기·실제 음향 정렬을 검증한 것은 아니다. 이 observer는 HTTP
프로토콜·Cloudflare 거점을 기록하지 않으므로 이전 HTTP/2 또는 LAX 경로와 같다고
주장하지 않는다. 과거 실패는 그대로 남기며 이번 성공으로 정확한 장애 구간이나
전역적인 무결함을 확정하지 않는다.

비차단 job의 실제 결과가 success임을 각각 확인했다. 같은 attempt에 보이는 전체
Chromium·WebKit job은 과거 실행 시각의 결과이며 전체 suite를 다시 돌린 것이 아니다.
기존 finally의 host/guest context 종료와 별도로 인증된 R2 객체 삭제를 확인했다고
기록하지 않는다. 원본 로그·상태·각 회차 요약과 합계는 추적 제외
`scratch/r2-remote-comparison-2026-10-07/attempt-{3,4,5}/` 및
`combined-summary.json`에 보존한다. 추적 문서에는 인증 URL·토큰·방 식별자를 넣지 않는다.

## 한 세션의 순차 반복 수신 — 2026-10-08

사용자가 확인을 요청한 조건은 동시 여러 browser/context가 아니라 같은 세션에서
파일을 차례로 다시 받는 것이다. 준비 SHA `aff88adbdb91c69e33d4965400334eb427532711`,
Windows·Chromium `153.0.8010.12`, 기존 집 Wi-Fi에서 **browser 1개·context 1개·
page 1개**를 유지하고, 새로 만든 동일한 2,153,280바이트 객체를 같은 URL·Bearer로
미리 정한 6회 수신했다. 2026-10-08 01:24 KST 실행이며 앞선 대조와 동일 객체는 아니다.

앱 대신 정적 favicon 문서에서 native XHR을 실행했다. 경로는 브라우저 →
`share.musixquare.com` 다운로드 Worker → R2이며 R2 직접 GET가 아니다. 각 요청의
종료 및 CDP terminal을 확인한 후 다음 요청을 시작해 최대 동시 GET는 1개였다.
브라우저 기본 프로토콜 협상을 사용했고 캐시를 끄고 service worker를 차단했다.
재시도는 없고 요청별 180초 진단 상한은 기존 테스트·제품의 timeout 변경이 아니다.

| 회차 | 전체 본문 수신 시간 | 실제 프로토콜 | 관측 거점 | 결과 |
| --- | --- | --- | --- | --- |
| 1 | 1.814초 | HTTP/2 | LAX | HTTP 200·전체 본문·SHA-256 일치 |
| 2 | 1.357초 | HTTP/3 | LAX | HTTP 200·전체 본문·SHA-256 일치 |
| 3 | 0.789초 | HTTP/3 | LAX | HTTP 200·전체 본문·SHA-256 일치 |
| 4 | 0.863초 | HTTP/3 | LAX | HTTP 200·전체 본문·SHA-256 일치 |
| 5 | 0.829초 | HTTP/3 | LAX | HTTP 200·전체 본문·SHA-256 일치 |
| 6 | 0.764초 | HTTP/3 | LAX | HTTP 200·전체 본문·SHA-256 일치 |

**6/6 완료·실패/timeout 0·driver exit 0·인증된 객체 정리 성공.** 매회 XHR과 CDP
양쪽에서 전체 바이트를 확인했고, disk/service-worker/cache 응답이 아닌 실제 수신이다.
응답은 `Cache-Control: no-store`였으며 완료 시각을 먼저 잡은 뒤 payload hash를 검사했다.
2–6회는 같은 HTTP/3 connection ID를 재사용했다. 첫 GET의 connectionReused도 true라
첫 GET를 TLS 연결 수립까지 포함한 완전한 cold-start 측정이라고 부르지 않는다.

이번 한 세션의 6회 순차 요청은 계속 빨랐다. 하지만 이전에는 단일 수신에서도
131초 지연이 있었고, 이번에는 객체·시각·협상된 프로토콜도 달라졌다. 따라서
동시 요청이 유일한 원인이라거나 HTTP/2 자체의 결함이라고 확정할 수 없다.
LAX에서도 빠른 전송이 관측됐으므로 거점 이름만으로 지연을 판정할 수도 없다.
기존 지연·정확한 원인 구간 미확정은 유지한다. 제품·유지 테스트·설정·배포 변경은 없다.

원본: `scratch/r2-root-cause-2026-10-07/transport-serial-2026-10-08.{mjs,jsonl,log}`와
`transport-serial-2026-10-08-exit.txt`. 계획·소스/스크립트/fixture hash, 요청별 CF-ray·
프로토콜·connection ID·cache/바이트/시간·동시성·정리 결과를 보존했다. 원본 인증 URL·
토큰·room ID·IP는 저장하지 않았다. 다른 에이전트가 harness와 6개 결과를 독립 확인했다.

## HTTP/2 고정 변인 대조 — 2026-10-08

사용자 요청에 따라 이전 순차 검사의 프로토콜 변화·객체 차이를 한 비교 안에서
제거했다. 준비 SHA `7e025a94f19c074d39e2c77b671512e19771337b`, Windows·Chromium
`153.0.8010.12`, 기존 집 Wi-Fi에서 불변 객체·URL·Bearer·browser/context/page를
유지하고 QUIC를 비활성화했다. 실제 응답 프로토콜·연결·거점도 별도 관측했다.
앱 대신 native XHR으로 다운로드 Worker를 거쳐 R2 본문을 받으며, 캐시와 SW는
차단했다. 요청당 60초는 이번 진단의 측정 상한이며 유지 테스트·제품 설정 변경이 아니다.

### 1차: 한 세션에서 순차와 동시 수신

계획은 warmup 1회 후 A1(9개 순차) → B1(9개 동시) → B2(9개 동시) → A2(9개 순차),
각 블록 사이 모든 요청 종료를 확인하고 3초 간격을 두는 것이다. 매 블록의 총 본문은
19,379,520바이트로 동일하다. 실제 전체 ABBA 실행은 2026-10-08 01:50 KST다.

| 블록 | 요청 수·동시성 | 전체 본문 완료 | 9개 전체 수신 구간 | 개별 GET 범위 |
| --- | --- | --- | --- | --- |
| A1 | 9개·순차 1 | 9/9 | 6.412초 | 0.622–0.958초 |
| B1 | 9개·동시 9 | 9/9 | 2.573초 | 0.896–2.572초 |
| B2 | 9개·동시 9 | 9/9 | 2.535초 | 0.946–2.535초 |
| A2 | 9개·순차 1 | 9/9 | 6.156초 | 0.613–0.746초 |

본 측정 **36/36 완료·오류/timeout 0**, 별도 warmup도 1.771초에 완료했다.
전부 HTTP 200·2,153,280바이트·원본 SHA-256 일치·실제 HTTP/2·동일 connection ID·
LAX였고 캐시 응답이 아니었다. CDP와 renderer 시작/종료 시간축 양쪽에서 A는
최대 1개, B는 최대 9개 중첩을 확인했다. 객체 정리 성공·exit 0이다.
표의 전체 수신 구간은 블록 시작→마지막 XHR 종료이며 A에서는 중간 요청의 해시
계산 간격이 포함된다. 개별 GET 시간은 모두 해시 계산 전 종료 시각으로 잡았다.

같은 세션·같은 H2 연결 조건에서는 동시 9개도 지연 없이 완료했고 총 수신 시간은
순차보다 짧았다. 이전 장시간 지연의 필수 원인을 HTTP/2 또는 동시 요청 자체로
단정할 근거는 없다. 한 세션의 하나의 연결이라는 조건에 한정되며 서로 분리된
세션·물리 기기·장기 실행 전체로 확대하지 않는다.

### 2차: 동시 9개를 한 세션과 9개 세션에 분배

1차에서 지연이 없었으므로 다음 가설인 context별 연결 분리를 비교했다. 같은 준비
SHA·PC·Wi-Fi·Chromium·H2 조건이며 2026-10-08 01:55–01:59 KST 실행했다.
browser 1개 안에 S용 context/page 1개와 M용 context/page 9개를 먼저 만들고 모두
유지했다. 2차 전용 새 불변 객체 하나를 각 context에서 1회씩 순차 수신해 준비한 뒤,
S(한 context에서 9개 동시) → M(9개 context에서 각 1개 동시) → M → S로 측정했다.
2차 내부의 파일·URL·Bearer는 모두 동일하며, 1차의 객체와는 다르다.

| 블록 | 동시 요청 구성 | 전체 완료 | 최초 CDP 요청 시작 → 마지막 본문 완료 | 개별 XHR 범위 |
| --- | --- | --- | --- | --- |
| S1 | 한 context의 9개 | 9/9 | 53.991초 | 13.880–53.992초 |
| M1 | 9개 context의 각 1개 | 9/9 | 13.912초 | 1.591–13.913초 |
| M2 | 동일한 9개 context의 각 1개 | 9/9 | 15.146초 | 1.333–15.147초 |
| S2 | 처음 S context의 9개 | 9/9 | 16.916초 | 4.572–16.917초 |

측정 36/36·준비 10/10 완료, HTTP 200·원본 바이트와 SHA-256 모두 일치,
오류/timeout 0·캐시 없음·인증된 객체 정리 성공·exit 0이다. 전부 H2/LAX이며
S는 준비와 S1/S2에서 connection ID 172를 계속 재사용했다. M의 9개도 각각 준비
때의 연결을 두 측정에서 그대로 재사용했다. 시작 시각 분산은 최대 0.793ms,
CDP 요청 구간의 최대 중첩은 각 블록 9이며 블록 종료 후 active 0이다.
이 중첩은 관측된 요청 수명 구간이지 wire의 H2 stream 송신 동시성을 직접 측정한
것은 아니다. 1차 표는 renderer 구간, 2차 표는 공통 CDP monotonic 구간으로 산출했다.

S1/S2는 동일한 객체와 연결에서도 약 54초→17초로 달랐다. 이번에 9개 context
조건이 더 느리지는 않았고, 모든 조건이 항상 빠르지도 않았다. 따라서 프로토콜
전환·파일 객체 변경·context 수만으로 이전 차이를 설명할 수 없다. 각 연결에서
반복되는 속도 차이도 있지만 이 4블록으로 연결·브라우저·회선 중 하나의 결함을
확정하지 않는다. 공유기 설정·Wi-Fi 전파/다른 이용자 부하·서버 내부 상태까지
고정한 실험은 아니며, 물리 기기 여러 대나 장기 세션 대조도 아니다.

CDP에서 S1의 응답 헤더는 모두 1.066–1.756초, S2는 0.719–1.234초에 관측됐다.
본문 바이트 관측 간격은 최대 46.615/13.261초였고 heartbeat 최대 지연은 14ms였다.
반면 페이지의 XHR readyState=2 콜백은 최대 46.615/13.261초 뒤에 관측됐다.
두 계측 시점을 혼동해 서버가 헤더를 46초 뒤에 보냈다고 해석하지 않는다.
각 블록의 CF-Ray도 9개씩 서로 달라 하나의 응답을 복제한 증거는 없다.
현재 근거는 **빠른 네트워크 헤더 관측 뒤 늦은 본문 전달/노출**이며, 브라우저 내부
처리·연결 흐름 제어·전송망·Cloudflare/R2 중 지연 구간을 더 나누려면 추가 계측이
필요하다. 이전 120/180초 중단 자체가 이번에 재현되거나 해결된 것은 아니다.

원본은 `scratch/r2-root-cause-2026-10-07/transport-context-controlled-2026-10-08`
이름의 `.mjs/.jsonl/.log/-exit.txt`에 보존한다. 준비 요청 10개를 측정 36개와 구분하며
총 46개의 완전 수신은 99,050,880바이트다. 두 완전한 실험의 본 측정은 합계 72개,
별도 준비는 11개다. 최초 관측기 중단의 10개를 여기에 합산하지 않는다.
두 실험 모두 스크립트·결과·provenance를 다른 에이전트가 독립 검토했다.

### 최초 관측기 중단 보존

최초 `transport-controlled-2026-10-08.mjs` 실행은 warmup과 A1의 총 10개 GET를
모두 완전 수신했으나, 이벤트 도착 순서로 집계한 CDP active 최대치가 2가 되어
A1 뒤 중단됐다. renderer 기록에서는 다음 요청이 직전 종료보다 2.0–2.5ms 뒤에
시작했다. 원본에는 CDP 절대 시작 시각을 남기지 않아 당시 CDP 구간의 사후 중첩
계산은 할 수 없다. 이 실행은 ABBA 성공도 제품 다운로드 실패도 아닌 **관측기
제약 위반으로 중단된 실행**이며 exit 1·객체 정리 성공을 보존한다.

v2는 CDP의 원천 시작·종료 timestamp를 정렬해 실제 구간 중첩을 계산하고 renderer
시간축도 독립 대조한다. 상대 시각을 보존해 재계산할 수 있고 도착 순서 counter는
별도로 남긴다. 실제 중첩 최대치를 계획과 같도록 요구하므로 기준 완화가 아니다.
새 객체에서 전체 ABBA를 한 번 실행했으며 요청 수·상한·간격·성공 조건은 유지했다.
원본 및 v2의 `.mjs/.jsonl/.log/-exit.txt`는 추적 제외
`scratch/r2-root-cause-2026-10-07/`에 보존한다. 제품·유지 테스트·배포 변경은 없다.

## 최초 전체 검증 원본 증거

추적 제외 폴더 `scratch/full-verification-8.7.2-2026-10-07/`에 원본을 보존한다.

- `baseline.json`, `unit/summary.json`, `unit/*`: 기준 SHA·4종 coverage·원래 명령/JSON/LCOV.
- `unit-final-716c/summary.json`, `broad.json`, `coverage-broad/*`: 최종 518파일·10,781개, coverage 하한·원래 입력 hash 확인.
- `unit-final/*`: 추가 회귀 발견 후 중단한 `59eae678` broad 원본. 완료 결과로 사용하지 않는다.
- `browser-summary.json`, `browser/chromium-{1,2}.json`, `browser/webkit.json`: 전체 581개 고유성·모바일 skip 근거. 최초 R2 실패는 그대로 보존하며 후속 실행은 아래 개별 reporter로 구분한다.
- `browser/candidate.json`, `browser/webkit-sw.json`, `build/results.json`: 기준 production·SW·빌드·Worker 검증. `build/results.json`의 최초 R2 exit 1을 보존한다.
- `browser/production-live.json`, `browser/production-live-diagnostic.json`, `browser/production-live-final.json`: 최초 실패 → 기존 조건 진단 pass → 첫 helper `59eae678` pass의 서로 다른 실행.
- `browser/production-live-716c.json`, `build/production-large-room-716c.log`: 최종 `716c37af` 로컬 운영 1 pass, native host/host 9개.
- `observer-regression/report.md`, `old-proof-provenance.json`, `old-proof-final.json`, `new-final.json`: 정확한 이전 callback 대조와 첫 보완 48개 회귀, 초기 실패·중단 로그.
- `observer-regression/throwing-native-before.json`, `new-final-51.json`, `throwing-native-checks.json`: native getter 예외 중 객체 교체 3개 red·정상 대조 1개 pass, 후속 보완 51개 pass, E2E 타입·helper lint·서식 검사.
- `static/manifest.json`, `static-final/manifest.json`: 기준 및 `59eae678` 18개 명령, audit JSON·서명 로그. 후자는 09:26:54–09:30:42 UTC.
- `build/production-build-final.log`, `build/production-large-room-final.log`, `remote/direct-live-results.json`, `build/live-app-*.log`: `59eae678` production build와 운영 smoke. 파일명의 final을 현재 최신 SHA의 결과로 해석하지 않는다.
- `remote/*`, `remote-final/*`, `remote-complete/*`: 기준·첫 보완·최종 보완 실행의 상태 snapshot과 원격 원본 로그. `remote-complete/pr-ci.log`, `chromium.log`, `webkit.log`, `production-r2-summary.json`, `full-e2e-status.json`이 최종 완료 근거다.
