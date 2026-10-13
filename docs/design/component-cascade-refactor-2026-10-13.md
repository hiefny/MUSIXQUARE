# 컴포넌트 pill·CSS 우선순위 정리 — 2026-10-13

## 범위와 배포 경계

사용자는 컴포넌트 자체가 pill 형태를 갖도록 바꾸고, 장기 가독성을 위해
불필요한 `!important`를 정리한 뒤 배포하도록 승인했다. 기준 코드는
`02ed24f3bfb2f0981bba78bcef7136674c9d5f65`다. 이 문서는 구현·검증이 진행되는
동안 갱신하며, 완료된 검사와 아직 실행하지 않은 검사를 구분한다.

- 예정 App `8.10.9` / SW `v670`, 배포 대상 `app`, Developer API D1 `false`.
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

실행 환경은 Windows, 저장소 고정 Node/npm, Playwright Chromium/WebKit이다.
아래 결과는 기준 SHA 이후 작업 트리에 대한 중간 결과이며 최종 source SHA와
CI·배포 결과는 실행 완료 후 추가한다.

- 첫 full unit: 558파일, 12,575 pass / 5 fail / 0 skip. 세 건은 이동한 CSS를
  주석 경계로 자르던 검사와 누락된 bootstrap cache mirror를 수정했다. 나머지
  두 건은 Git 임시 저장소를 만드는 release/cache guard 테스트의 시간 초과였다.
  제한을 늘리지 않고 worker 수를 제한한 관련 5파일 재실행은 197 pass였다.
  전체 재실행으로 최종 결과를 확인한다.
- 타입 검사 통과. focused contracts 114 pass. lint·format·full unit 최종 확인 중.
- 공개 보조 페이지 전후 계산 스타일 비교: 96조건에서 차이 0. Chromium/WebKit,
  390/720/900/1440px, admin/blog/about/design, normal/active/reduced 조합이다.
  동적 관리자 clear 버튼의 의도적인 색상 수정은 별도 동작 검사로 확인했다.
- 앱 비교기는 기준 index/CSS를 사용한 정적 상태 비교다. 전환이 끝나기 전의
  일시적인 프레임을 제품 변화로 세지 않도록 baseline 자기 비교와 transition
  종료를 확인한다. 실제 네트워크·native fullscreen·미디어 출력을 검증하는
  것으로 해석하지 않는다.
- 지속 회귀는 component-cascade와 auxiliary-component-cascade E2E로 남긴다.
  모달 이미지 캡처는 native ViewTransition 종료 후 수행하며 제품 transition을
  생략하지 않는다. 새 검사는 Chromium 전체 및 WebKit 대상 목록에 포함한다.

## 배포·복구

아직 배포하지 않았다. 로컬·PR 결과와 exact-main CI 후보를 구분하고, 최종
main SHA CI가 성공한 다음 정식 Production Release로 App만 배포한다. 복구가
필요하면 배포 workflow가 보존한 호환 기준선을 사용한다. 이 변경에 데이터
마이그레이션은 없으며 이전 App으로 복구하면 이전 cascade와 알려진 UI 문제가
돌아온다. 배포 후 버전·캐시·smoke·소유권 및 릴리스 기록을 갱신한다.
