# 컴포넌트 pill·CSS 우선순위 정리 — 2026-10-13

## 범위와 배포 경계

사용자는 컴포넌트 자체가 pill 형태를 갖도록 바꾸고, 장기 가독성을 위해
불필요한 `!important`를 정리한 뒤 배포하도록 승인했다. 기준 코드는
`02ed24f3bfb2f0981bba78bcef7136674c9d5f65`다. 이 문서는 구현·검증이 진행되는
동안 갱신하며, 완료된 검사와 아직 실행하지 않은 검사를 구분한다.

- 예정 App `8.10.9` / SW `v671`, 배포 대상 `app`, Developer API D1 `false`.
- 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 변경 없음.
- Sync/Media 버튼을 공유 중지 버튼으로 합치는 제안은 이번 범위에 없다.
- 기존 실기기 확인 항목은 유지한다. 브라우저 자동화는 실제 iPhone/PWA,
  TV, 스크린리더와 물리적인 음향 동기화 검증을 대신하지 않는다.

## 구조

`--radius-pill: 999px`를 실제 앱과 디자인 시스템의 공통 형태 이름으로 쓴다.
전체 button에 예외 목록을 붙여 강제로 반경을 덮던 규칙을 없애고, 해당
컴포넌트가 자신의 pill 반경을 정의한다. 선택 카드의 20px, 채팅의 20/4px
모서리, 정사각형 QR·YouTube 제어와 반응형 탐색 버튼은 각각의 형태를 유지한다.
UI kit와 공개 디자인 시스템에도 같은 토큰·설명을 반영한다.

앱의 cascade 순서는 `safety, base, desktop, components, responsive, states`다.
일반 선언은 기본 컴포넌트→데스크톱 변형→보조 컴포넌트/RTL→반응형 배치→활성
상태 순서로 우선권을 가진다. important 선언의 layer 순서는 반대이므로
접근성·입력·복구 보호를 담당하는 safety는 첫 번째다. OS forced-colors 블록은
normal 아이콘 색상까지 컴포넌트를 덮어야 하므로 마지막 unlayered 블록에 둔다.

Vite 검사는 desktop/components/responsive/states에서 새 `!important`를
거부한다. base/safety의 숨김·inert·부팅 실패 복구·축소 모션·드래그·입력
보호와 forced-colors는 이유를 기록하고 남긴다. JS가 인라인 스타일을 쓰는
경우도 살펴보며, 단순히 선언 개수만 줄이는 것을 완료 조건으로 삼지 않는다.

PostCSS 선언 기준으로 추적하는 프로덕션 CSS와 HTML style 블록의 important는
769개에서 207개로 줄었다(562개 제거, 약 73%). 앱은 607→148, 나머지 공개
페이지는 162→59다. UI kit의 4개와 E2E 보고서 뷰어 2개, 생성 산출물·주석은
이 집계에서 제외했다. 블로그 JS의 별도 inline important 쓰기 1곳도 없앴다.
남은 앱 148개는 base 65 / safety 7 / OS forced-colors 76이며 일반 presentation
layer 네 개에는 0개다.

공개 블로그·관리자·About·디자인 페이지도 컴포넌트가 스타일을 소유하도록
정리한다. 관리자 기본 요소 selector는 `:where()`로 낮춰 컴포넌트가 자연스럽게
우선하도록 하고, 블로그 페이지 이동은 `hidden` 속성으로 표시를 제어한다.

## 전후 비교에서 확인한 사항

- 축소 모션과 부팅 entrance가 동시에 적용될 때 기존 important 우선순위가
  0.6/0.8초 transition을 남기던 문제를 수정했다. 축소 모션에서 0초가 된다.
- forced-colors의 sidebar 선택색도 기존 base important가 OS Highlight 규칙을
  막던 우선순위를 바로잡아, 작성돼 있던 OS 색상 계약이 실제 적용되게 했다.
- 관리자의 동적 입력 지우기 버튼이 일반 파란 작업 버튼 스타일에 덮이던
  문제를 수정했다. 본래 투명 배경·무채색 아이콘을 쓰고 44×44 클릭 영역은 유지한다.
- 재배치 과정에서 발견한 인사말 8px 여백, 법률 설명 글자 크기, 짧은 화면의
  채팅 높이, fake fullscreen의 스크롤 차이는 기존 결과와 같게 바로잡았다.
- 데스크톱 welcome 슬라이더의 인라인 `display:block`과 CSS flex 배치 충돌도
  별도 리뷰에서 확인했다. visibility와 layout의 소유권을 분리해 회귀 검증한다.

## 검증 기록

로컬 실행 환경은 Windows / Node 24.13.1 / npm 11.8.0 / Playwright
Chromium·WebKit이다. 원격은 저장소 고정 Node 24.20.0 / npm 12.0.2를 사용하므로
환경을 동일하다고 주장하지 않는다. 제품·회귀 source는
`03df60f790a61c9cf3dec50254e0815001d01416`, build guard 후속은
`ad66e0c94e604d3bfe38eafde847e56f19f2bf68`다. CI·배포 결과는 실행 완료 후 추가한다.

후속 회귀 수정까지 포함한 최종 제품·테스트 source는
`749f0a6ab53e130255bfac474397f77dabb30c20`이다. 최종 로컬 결과는 이 커밋을
분리한 작업 폴더 또는 동일한 제품 파일의 원래 checkout에서 확인했다.

| 최종 검사                             | 결과                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows full unit, maxWorkers=4       | 558파일 / 12,581 pass / 0 fail / 0 skip, 469.47초                                                                                                     |
| PR CI 38405389405                     | 11개 job 성공. broad unit 12,580 pass / 기존 Windows 전용 1 skip. 4종 coverage, 타입·린트·포맷·정책·production candidate 통과                         |
| 로컬 committed build:checked          | 성공. 모든 기존 한도 유지, eager raw 1979.8 KiB / gzip 528.4 KiB, 최소 여유 5%                                                                        |
| 로컬 production candidate / WebKit SW | 17 pass / 1 pass                                                                                                                                      |
| 로컬 WebKit UI                        | 79 pass / 0 fail / 기존 플랫폼 3 skip, 3.5분                                                                                                          |
| 로컬 Chromium 전체                    | 639 pass / 1 fail / 0 skip, 57.7분. seed 470021 재입장 뒤 host playing / guest paused 수렴 실패 조사 중                                               |
| 원격 Full E2E 38405378201             | 전체 성공. Chromium 640 pass / 0 fail / 0 skip(1.0시간), WebKit 79 pass / 기존 3 skip, SW 1 pass, production R2 1 pass. 실제 배포 후보 CI와 별개      |
| 로컬 실패 순서 진단 반복              | 제품·검사 조건 미변경, 상세 로그만 추가한 단독 20회 통과. 매회 새 브라우저라 전체 실행의 재사용 조건과 구분하며 최초 실패 원인 확정으로 간주하지 않음 |
| 로컬 브라우저 재사용 진단 반복        | 기존 24순서×3회와 host-loss 1회, 총 73 pass / 0 fail / 0 skip(12.1분). 최초 실패 원인은 여전히 미확정                                                 |

첫 로컬 full 실패는 퇴장·재입장 직후의 `seed 470021`에서 host가 PLAYING_AUDIO,
guest가 PAUSED인 채 15초 수렴하지 않은 경우다. 입장·WebRTC·파일 수신은 끝났고
권한/seek 단계 전이었다. `decodeFailureQueueItemId`는 count 0과 함께 정상 전송
초기화에서도 설정되므로 디코딩 실패 근거가 아니다. 정상 guest도 lifecycle READY를
유지한 채 재생할 수 있다. 앱 재생·전송 코드는 기준 main과 같고, CSS와의 직접
인과는 확인하지 못했다. Media Session의 로컬 pause가 같은 모양을 만들 수 있지만
최초 실행에 그 호출 기록이 없어 원인으로 단정하지 않는다. 사용자의 미디어 키
조작 기억도 불확실하므로 근거로 삼지 않는다.

검사 조건·시간 제한·테스트 수를 유지하며 기존 시나리오 검사에 페이지당 256개
한도의 test-only 관측을 추가했다. 실제 Media Session callback, 재생 activity,
공유 시계의 동기화 판단 사유를 실패 artifact에 남기고, bus.emit나 제품 상태를
바꾸지 않는다. 이 최소 관측을 포함한 로컬 전체 640개를 다시 실행한다. 반복
통과는 최초 실패 해결이나 실서비스 결함 확정으로 간주하지 않는다.

최종 CSS로 확장한 360조건(337,320요소×70속성)은 276조건 완전 동일,
84조건은 의도한 모션 속성 변경만 있었다. 비모션 스타일·기하 차이는 0이다.
짧은 portrait 경계가 포함된 15개 viewport 회귀는 두 엔진에서 각각 3/3 통과했다.
최종 추가 54상태와 데모 종료 9조건도 다시 비교해 위 허용된 숨김 nav 변화와
정상 복귀를 확인했다. 정적 버튼 130개·동적 버튼 21종의 네 모서리 반경도
두 엔진×3폭×2방향, 12조건에서 baseline과 일치했다.

프로덕션 8.10.8의 공개 CSS `main-14Oy2XJP.css`와 최종 로컬 production CSS
`main-DuLzNRbT.css`의 원문/gzip(level 9)은 247,976/40,869 B→314,673/43,053 B다.
명시적인 계층을 Chromium 79용 specificity로 낮추는 비용이며 전송 증가는
2,184 B다. 한도를 늘리지 않았고 이를 성능 개선이라고 주장하지 않는다.

- 첫 full unit: 558파일, 12,575 pass / 5 fail / 0 skip. 세 건은 이동한 CSS를
  주석 경계로 자르던 검사와 누락된 bootstrap cache mirror를 수정했다. 나머지
  두 건은 Git 임시 저장소를 만드는 release/cache guard 테스트의 시간 초과였다.
  제한을 늘리지 않고 worker 수를 제한한 관련 5파일 재실행은 197 pass였다.
  전체를 `--maxWorkers=4`로 다시 실행해 558파일 / 12,580 pass / 0 fail / 0 skip,
  430.44초를 확인했다. 이후 carousel 변경 관련 71개 및 legacy guard 8개도 통과했다.
- 타입·린트·포맷·Worker 정책 검사 통과. focused contracts 114 pass. 최종 carousel
  소스와 E2E 타입·린트·포맷도 재확인했다.
- 공개 보조 페이지 전후 계산 스타일 비교: 96조건에서 차이 0. Chromium/WebKit,
  390/720/900/1440px, admin/blog/about/design, normal/active/reduced 조합이다.
  동적 관리자 clear 버튼의 의도적인 색상 수정은 별도 동작 검사로 확인했다.
  이 96조건은 공유 디자인 CSS를 baseline으로 고정한 보조 페이지 격리 비교이며
  events 페이지나 이번 공유 디자인 토큰 변경 전체의 동등성 증거는 아니다.
- 앱 비교기는 기준 index/CSS를 사용한 정적 상태 비교다. 전환이 끝나기 전의
  일시적인 프레임을 제품 변화로 세지 않도록 baseline 자기 비교와 transition
  종료를 확인한다. 실제 네트워크·native fullscreen·미디어 출력을 검증하는
  것으로 해석하지 않는다. 확장 전 비교 300조건×937요소, 70속성에서 형태·색·글꼴·
  가시성·기하 차이는 0이다. 220조건 완전 동일, 나머지 80조건은 의도된 모션
  속성 변경만 있다. 별도 54상태에서는 데모 중 숨김 nav의 transform/rect 변화
  3조건을 허용했다(opacity 0 / pointer-events none 유지). 데모 종료 9조건에서
  기존 visible 배치·opacity 1·pointer-events auto로 회복했다. baseline 자기 비교는
  90/90 동일했다. 교정 전 초기 comparator 결과는 증거에서 제외한다.
- 지속 회귀는 component-cascade와 auxiliary-component-cascade E2E로 남긴다.
  모달 이미지 캡처는 native ViewTransition 종료 후 수행하며 제품 transition을
  생략하지 않는다. 새 검사는 Chromium 전체 및 WebKit 대상 목록에 포함한다.
- 새 carousel 실제 앱 핀 Chromium/WebKit 2/2 및 최종 component WebKit 7/7 통과.
  Chromium 모달 검사는 실제 로컬 PeerJS 방 입장, WebKit 모달 검사는 기존
  WebKit smoke와 같은 bootstrap/host-state hook으로 준비한다. WebKit에서 일반방
  네트워크 입장까지 검증했다고 주장하지 않는다. 강제 색상 E2E는 Chromium 한정이다.
- 첫 committed production build는 legacy guard의 문자열 검색이 layer lowering의
  `:not(#\\#)` padding을 인식하지 못해 중단됐다. 생성된 그 토큰만 제거한 selector로
  검사하도록 고쳤다. 실제 `:has()`·누락 animation·물리 overlay edge 거부는 유지하고,
  변환된 CSS에 대한 양성/음성 회귀를 추가했다. `ad66e0c9`의 committed build는
  모든 guard와 기존 번들 한도를 통과했다(초기 raw 1979.7 KiB / gzip 528.4 KiB,
  최소 여유 5% 유지). production candidate도 17 pass였다.
- 첫 WebKit 전체 82건은 76 pass / 3 fail / 기존 플랫폼 3 skip이었다. auxiliary
  두 건은 fixture의 viewport meta 누락으로 iPhone의 layout viewport가 980px가 된
  검사 설정 문제였다. 실제 공개 페이지와 같은 meta를 추가해 세 브라우저 구성의
  auxiliary 15/15를 확인했다. 나머지 한 건은 실제 CSS 회귀였다: 짧은 portrait의
  artist 숨김 규칙이 base에 남아 `:not(:empty)`의 specificity를 이기지 못했다.
  숨김 규칙을 responsive로 이동했다. baseline과 수정본의 두 엔진·20개 관측에서
  700×400→390×700→390×720→390×721의 표시→숨김→숨김→표시가 일치했다.
  초기 300조건은 portrait 최소 높이가 800px여서 이 경계를 놓쳤다. 경계 검사를
  추가해 360조건으로 확장하고 최종 전체 lane을 다시 실행했다. 첫 로컬 Chromium은 126/640에서 중단,
  첫 remote Full E2E `38404445180`도 취소했으며 통과로 세지 않는다. 후속 CSS
  커밋을 포함하기 위해 아직 미배포인 cache v670을 v671로 올렸다.

## 배포·복구

아직 배포하지 않았다. 로컬·PR 결과와 exact-main CI 후보를 구분하고, 최종
main SHA CI가 성공한 다음 정식 Production Release로 App만 배포한다. 복구가
필요하면 배포 workflow가 보존한 호환 기준선을 사용한다. 이 변경에 데이터
마이그레이션은 없으며 이전 App으로 복구하면 이전 cascade와 알려진 UI 문제가
돌아온다. 배포 후 버전·캐시·smoke·소유권 및 릴리스 기록을 갱신한다.
